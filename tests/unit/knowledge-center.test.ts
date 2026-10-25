import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { testDataSetDocument } from '../../src/data/test-data-set.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import { functionalKnowledgeFile } from '../../src/knowledge/functional-knowledge-store.js';
import { ruleKnowledgeFile } from '../../src/knowledge/rule-knowledge-store.js';
import { openKnowledgeCenter, type KnowledgeCenterContext } from '../../src/knowledge-center/context.js';
import {
  DEFAULT_IMPORT_POLICY,
  ImportValidationError,
  KnowledgeExchange,
  parseKnowledgeExport,
} from '../../src/knowledge-center/exchange.js';
import { KNOWLEDGE_EXPORT_FORMAT } from '../../src/knowledge-center/model.js';
import { assessReliability } from '../../src/knowledge-center/reliability.js';
import { ReviewConflictError, ReviewLedger } from '../../src/knowledge-center/review-ledger.js';
import { startKnowledgeCenterServer } from '../../src/knowledge-center/server.js';
import {
  KnowledgeCenterService,
  KnowledgeNotFoundError,
  ReadOnlyError,
} from '../../src/knowledge-center/service.js';
import { itemId } from '../../src/knowledge-center/sources.js';
import { InMemoryPersistenceProvider } from '../../src/persistence/memory/in-memory-provider.js';
import { JsonPersistenceProvider } from '../../src/persistence/file/json-provider.js';
import type { CrawlRunRecord, TransitionObservation } from '../../src/persistence/model.js';
import type { PersistenceProvider } from '../../src/persistence/persistence-provider.js';

/**
 * KNOWLEDGE CENTER : la fiabilité calculée (formules), le registre de revue (ajout seul, conflits),
 * le service (lecture réelle des quatre lieux, recherche paginée, détail, provenance, flows, variables,
 * qualité, historique, décisions), l'échange (export / import / sauvegarde / restauration), le serveur
 * (sécurité des écritures), et le respect des configurations `memory` / `persistence`.
 */
const NOW = new Date('2026-06-01T12:00:00.000Z');
const OPTIONS = { minObservations: 3, staleAfterDays: 90, now: NOW };
const APP = 'demo-app';
const ENV = 'test';
const APP_ID = `${APP}@${ENV}`;

describe('reliability: computed from evidence, documented rules', () => {
  const recent = '2026-05-30T00:00:00.000Z';
  it('CONFIRMED needs minObservations executions with at most 10 % failures', () => {
    expect(assessReliability({ successes: 3, failures: 0 }, recent, OPTIONS).status).toBe('CONFIRMED');
    expect(assessReliability({ successes: 9, failures: 1 }, recent, OPTIONS).status).toBe('CONFIRMED');
    expect(assessReliability({ successes: 2, failures: 0 }, recent, OPTIONS)).toMatchObject({
      status: 'OBSERVED',
      reasons: ['2 execution(s), fewer than 3'],
    });
  });
  it('failures make it FRAGILE, a majority of failures CONTRADICTED', () => {
    expect(assessReliability({ successes: 4, failures: 1 }, recent, OPTIONS).status).toBe('FRAGILE');
    expect(assessReliability({ successes: 1, failures: 1 }, recent, OPTIONS).status).toBe('CONTRADICTED');
    expect(
      assessReliability({ successes: 0, failures: 0, blocked: 2, seen: 2 }, recent, OPTIONS).status,
    ).toBe('FRAGILE');
  });
  it('contradictions, staleness, hypotheses and the absence of evidence', () => {
    expect(assessReliability({ confirmations: 2, contradictions: 2 }, recent, OPTIONS).status).toBe(
      'CONTRADICTED',
    );
    expect(assessReliability({ confirmations: 3 }, recent, OPTIONS).status).toBe('CONFIRMED');
    expect(assessReliability({ successes: 5 }, '2026-01-01T00:00:00.000Z', OPTIONS)).toMatchObject({
      status: 'STALE',
      reasons: [expect.stringContaining('day(s) ago (> 90)')],
    });
    expect(assessReliability({ confirmations: 1 }, recent, OPTIONS, true).status).toBe('HYPOTHESIS');
    expect(assessReliability({ seen: 1 }, recent, OPTIONS).status).toBe('OBSERVED');
    expect(assessReliability({}, undefined, OPTIONS).status).toBe('UNVERIFIED');
  });
});

describe('review ledger: append-only, versioned decisions', () => {
  it('validate, conflict on a stale version, reset, and the file keeps every entry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kc-ledger-'));
    let tick = 0;
    const ledger = ReviewLedger.inDirectory(dir, () => `2026-06-01T12:00:0${String(tick++)}.000Z`);
    await ledger.load();
    const first = await ledger.decide({
      itemId: 'k1',
      itemTitle: 'one',
      operation: 'VALIDATE',
      expectedVersion: 0,
      note: 'ok',
    });
    expect(first.current).toMatchObject({ status: 'VALIDATED', note: 'ok', version: 1 });
    await expect(
      ledger.decide({ itemId: 'k1', itemTitle: 'one', operation: 'INVALIDATE', expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ReviewConflictError);
    const second = await ledger.decide({
      itemId: 'k1',
      itemTitle: 'one',
      operation: 'INVALIDATE',
      expectedVersion: 1,
      reason: 'changed',
    });
    expect(second.entry).toMatchObject({
      before: { status: 'VALIDATED' },
      after: { status: 'INVALIDATED', version: 2 },
      reason: 'changed',
    });
    const reset = await ledger.decide({
      itemId: 'k1',
      itemTitle: 'one',
      operation: 'RESET',
      expectedVersion: 2,
    });
    expect(reset.current).toBeUndefined();
    expect((await ledger.decisions()).has('k1')).toBe(false);
    expect(await ledger.versionOf('k1')).toBe(3);
    await ledger.record('EXPORT', { rows: 3 }, { application: APP_ID });
    const reloaded = ReviewLedger.inDirectory(dir);
    expect((await reloaded.entries()).map((entry) => entry.operation)).toEqual([
      'EXPORT',
      'RESET',
      'INVALIDATE',
      'VALIDATE',
    ]);
    expect(
      (
        JSON.parse(await readFile(path.join(dir, 'knowledge-center', 'review-ledger.json'), 'utf8')) as {
          entries: unknown[];
        }
      ).entries,
    ).toHaveLength(4);
  });

  it('two simultaneous decisions are applied one after the other: the second sees the first', async () => {
    const ledger = new ReviewLedger(undefined);
    const results = await Promise.allSettled([
      ledger.decide({ itemId: 'k', itemTitle: 'k', operation: 'VALIDATE', expectedVersion: 0 }),
      ledger.decide({ itemId: 'k', itemTitle: 'k', operation: 'INVALIDATE', expectedVersion: 0 }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });
});

/* ───────────────────────── un contexte réel, en mémoire et en fichiers ───────────────────────── */

interface Fixture {
  root: string;
  provider: InMemoryPersistenceProvider;
  context: KnowledgeCenterContext;
  service: KnowledgeCenterService;
  runIds: string[];
}

async function fixture(options: { readOnly?: boolean; withProvider?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'kc-service-'));
  const reports = path.join(root, 'reports');
  const knowledgeFile = path.join(root, 'knowledge', 'knowledge-base.json');
  const { config } = parseConfig(
    `
mission: { name: kc-mission }
target: { baseUrl: http://localhost:4200 }
knowledge: { file: ${knowledgeFile}, application: ${APP}, environment: ${ENV} }
output: { reportsDir: ${reports} }
`,
    {},
    {},
  );
  // 1. La persistance : deux runs, des états, des transitions, la connaissance historique, la mémoire des flows.
  const provider = new InMemoryPersistenceProvider();
  await provider.initialize();
  const runIds = ['run-aaaa', 'run-bbbb'];
  const run = (id: string, status: CrawlRunRecord['status'], at: string): CrawlRunRecord => ({
    id,
    applicationId: APP_ID,
    missionName: 'kc-mission',
    environment: ENV,
    commitSha: 'c0ffee',
    mode: 'explore',
    startedAt: at,
    finishedAt: at,
    status,
    statesCount: 2,
    actionsCount: 2,
    transitionsCount: 2,
    anomaliesCount: 0,
  });
  await provider.runs.create(run(runIds[0] ?? '', 'COMPLETED', '2026-05-20T10:00:00.000Z'));
  await provider.runs.create(run(runIds[1] ?? '', 'FAILED', '2026-05-28T10:00:00.000Z'));
  for (const [index, runId] of runIds.entries()) {
    const day = index === 0 ? '20' : '28';
    await provider.states.save([
      {
        id: `${runId}-s1`,
        runId,
        stateSignature: 'home',
        stateId: 'st-home',
        routePattern: '/',
        urlNormalized: 'http://localhost:4200/',
        depth: 0,
        firstSeenAt: '2026-05-20T10:00:00.000Z',
        lastSeenAt: '2026-05-20T10:00:00.000Z',
        context: {},
      },
      {
        id: `${runId}-s2`,
        runId,
        stateSignature: 'items',
        stateId: 'st-items',
        routePattern: '/items',
        urlNormalized: 'http://localhost:4200/items',
        depth: 1,
        firstSeenAt: '2026-05-20T10:00:00.000Z',
        lastSeenAt: '2026-05-20T10:00:00.000Z',
        context: {},
      },
    ]);
    await provider.transitions.add([
      {
        id: `${runId}-t1`,
        runId,
        fromStateId: 'st-home',
        toStateId: 'st-items',
        actionId: 'a1',
        actionSignature: 'navigate:items',
        actionType: 'NAVIGATE',
        actionLabel: 'Items',
        status: 'SUCCESS',
        safetyClass: 'SAFE',
        safetyDecision: 'ALLOW',
        durationMs: 120,
        startedAt: `2026-05-${day}T10:00:01.000Z`,
        finishedAt: `2026-05-${day}T10:00:02.000Z`,
      },
      {
        id: `${runId}-t2`,
        runId,
        fromStateId: 'st-items',
        toStateId: null,
        actionId: 'a2',
        actionSignature: 'click:delete',
        actionType: 'CLICK',
        actionLabel: 'Delete',
        status: 'BLOCKED',
        safetyClass: 'DANGEROUS',
        safetyDecision: 'BLOCK',
        startedAt: `2026-05-${day}T10:00:03.000Z`,
        finishedAt: `2026-05-${day}T10:00:03.000Z`,
      },
    ]);
  }
  const observation = (overrides: Partial<TransitionObservation>): TransitionObservation => ({
    applicationId: APP_ID,
    fromStateSignature: 'home',
    actionSignature: 'navigate:items',
    toStateSignature: 'items',
    seen: 1,
    success: 1,
    failure: 0,
    blocked: 0,
    durationTotalMs: 120,
    durationCount: 1,
    firstSeenAt: '2026-05-20T10:00:02.000Z',
    lastSeenAt: '2026-05-28T10:00:02.000Z',
    ...overrides,
  });
  await provider.knowledge.record([
    observation({ seen: 4, success: 4, durationTotalMs: 480, durationCount: 4 }),
    observation({
      fromStateSignature: 'items',
      actionSignature: 'click:delete',
      toStateSignature: '(none)',
      seen: 2,
      success: 0,
      blocked: 2,
      durationTotalMs: 0,
      durationCount: 0,
    }),
    observation({
      fromStateSignature: 'items',
      actionSignature: 'click:save',
      toStateSignature: 'items',
      seen: 2,
      success: 1,
      failure: 1,
      durationTotalMs: 200,
      durationCount: 2,
    }),
    observation({
      fromStateSignature: 'archive',
      actionSignature: 'navigate:old',
      toStateSignature: 'old',
      seen: 5,
      success: 5,
      durationTotalMs: 500,
      durationCount: 5,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-05T00:00:00.000Z',
    }),
  ]);
  await provider.anomalies.save([
    {
      applicationId: APP_ID,
      key: 'A-1|items|console',
      status: 'NEW',
      firstSeenAt: '2026-05-28T10:00:00.000Z',
      lastSeenAt: '2026-05-28T10:00:00.000Z',
      data: { history: [{ runId: runIds[1], status: 'NEW' }] },
    },
  ]);
  await provider.memory.save([
    {
      applicationId: APP_ID,
      kind: 'run',
      key: runIds[1] ?? '',
      status: 'FAIL',
      firstSeenAt: '2026-05-28T10:00:00.000Z',
      lastSeenAt: '2026-05-28T10:00:00.000Z',
      data: { runId: runIds[1], mission: 'kc-mission' },
    },
  ]);
  // 2. La base de connaissances fichier (mode legacy), écrite par le vrai JsonKnowledgeBase.
  const base = new JsonKnowledgeBase(
    knowledgeFile,
    { application: APP, environment: ENV, schemaVersion: 1 },
    { halfLifeDays: 30, minObservations: 3, dominance: 0.8, now: () => NOW },
  );
  await base.load();
  base.startRun();
  for (let index = 0; index < 3; index += 1)
    base.recordActionResult({
      actionSignature: 'click:save',
      result: 'SUCCESS',
      durationMs: 50,
      at: '2026-05-25T10:00:00.000Z',
    });
  base.recordActionResult({
    actionSignature: 'click:broken',
    result: 'FAILED',
    at: '2026-05-25T10:00:00.000Z',
  });
  base.recordActionResult({
    actionSignature: 'click:broken',
    result: 'FAILED',
    at: '2026-05-25T10:00:00.000Z',
  });
  base.recordTransition({
    fromStateSignature: 'home',
    actionSignature: 'navigate:items',
    toStateSignature: 'items',
    success: true,
    at: '2026-05-25T10:00:00.000Z',
  });
  base.recordApiCall('GET /api/items', 200, 30, '2026-05-25T10:00:00.000Z');
  base.recordApiCall('POST /api/items', 500, 30, '2026-05-25T10:00:00.000Z');
  base.recordOutcomePatterns('delete', ['confirm-dialog']);
  base.recordRecovery({
    key: 'click:save|goal',
    actionSignature: 'click:save',
    goal: 'SAVE',
    originalTarget: 'Save',
    actions: [{ kind: 'click', role: 'button', name: 'Confirm' }],
    result: 'FAILURE',
    at: '2026-05-25T10:00:00.000Z',
  });
  base.recordTargetResolution({
    key: 'Search',
    original: 'Search',
    kind: 'click',
    resolved: { role: 'button', name: 'Run search' },
    how: 'HEALED',
    result: 'SUCCESS',
    at: '2026-05-25T10:00:00.000Z',
  });
  base.saveCognitiveKnowledge({
    hypotheses: [
      {
        id: 'H-1',
        proposition: { kind: 'CAUSAL', subject: 'Save', relation: 'creates', object: 'item' },
        evidenceFor: [],
        evidenceAgainst: [],
        confidence: 0.4,
        status: 'HYPOTHESIS',
        testability: { testable: true },
        createdAt: '2026-05-25T10:00:00.000Z',
        updatedAt: '2026-05-25T10:00:00.000Z',
      } as never,
    ],
    evidence: [],
  });
  await base.save();
  // 3. La connaissance fonctionnelle et les règles (les fichiers que les stores écrivent).
  const functionalDir = path.join(root, 'knowledge', 'functional');
  const rulesDir = path.join(root, 'knowledge', 'rules');
  await mkdir(functionalDir, { recursive: true });
  await mkdir(rulesDir, { recursive: true });
  await writeFile(
    functionalKnowledgeFile(functionalDir, { application: 'kc-mission', environment: ENV }),
    JSON.stringify({
      entries: [
        {
          id: 'WORKFLOW:CREATE:ITEM',
          kind: 'WORKFLOW',
          status: 'RUNTIME_CONFIRMED',
          confirmations: 3,
          failures: 0,
          lastSeenAt: '2026-05-25T10:00:00.000Z',
        },
      ],
      learned: {
        workflows: [
          { id: 'CREATE:ITEM', api: 'POST /api/items', entityType: 'ITEM', provenance: 'HUMAN_RECORDED' },
        ],
        states: [],
        transitions: [],
      },
      fieldMappings: [
        {
          key: 'm1',
          uiLabel: 'Title',
          property: 'title',
          jsonPath: '$.title',
          screen: '/items/new',
          api: 'POST /api/items',
          operation: 'CREATE',
          transformation: 'EXACT',
          recordingSessionId: 's1',
          confirmations: 2,
          lastSeenAt: '2026-05-25T10:00:00.000Z',
        },
        {
          key: 'm2',
          uiLabel: 'Title',
          property: 'label',
          jsonPath: '$.label',
          screen: '/items/edit',
          api: 'PUT /api/items',
          operation: 'UPDATE',
          transformation: 'EXACT',
          recordingSessionId: 's2',
          confirmations: 1,
          lastSeenAt: '2026-05-25T10:00:00.000Z',
        },
      ],
      intentDecisions: [
        {
          key: '/items|button|Run search',
          context: { page: '/items', element: 'button Run search' },
          intent: 'SEARCH',
          status: 'HUMAN_CONFIRMED',
          systemIntent: ['SEARCH'],
          source: 'HUMAN',
          scope: 'CONTEXTUAL',
          recordingSessionId: 's1',
          confirmations: 1,
          lastSeenAt: '2026-05-25T10:00:00.000Z',
        },
      ],
      intentPatterns: [],
    }),
  );
  await writeFile(
    ruleKnowledgeFile(rulesDir, { application: 'kc-mission', environment: ENV }),
    JSON.stringify({
      rules: [
        {
          signature: 'r1',
          name: 'TITLE_REQUIRED',
          category: 'VALIDATION',
          status: 'RUNTIME_CONTRADICTED',
          coverage: 'VERIFIED',
          confirmations: 1,
          contradictions: 2,
          lastVerifiedAt: '2026-05-25T10:00:00.000Z',
        },
      ],
    }),
  );
  // 4. Un enregistrement : flow, jeu de données, liaison humaine.
  const recording = path.join(reports, 'recordings', 'create-item');
  await mkdir(recording, { recursive: true });
  const step = (
    id: string,
    kind: string,
    label: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    id,
    step: { kind, ...extra },
    label,
    actionIds: [],
    rawEventIds: [],
    provenance: 'HUMAN_RECORDED',
    confidence: 1,
  });
  await writeFile(
    path.join(recording, 'recorded-flow.json'),
    JSON.stringify({
      name: 'create-item',
      recordingSessionId: 's1',
      startAt: '/items/new',
      steps: [
        step('s1', 'fill', 'Type the title', {
          target: { strategy: 'label', value: 'Title' },
          value: { testData: 'item.title' },
        }),
        step('s2', 'fill', 'Type the contact email', {
          target: { strategy: 'label', value: 'Contact email' },
          value: { testData: 'item.contactEmail' },
        }),
        step('s3', 'click', 'Click Save', { target: { strategy: 'role', value: 'button', name: 'Save' } }),
        step('s4', 'fill', 'Search the title', {
          target: { strategy: 'label', value: 'Search' },
          value: { testData: 'item.title' },
        }),
        step('s5', 'select', 'Pick the missing variable', {
          target: { strategy: 'label', value: 'Category' },
          option: '${testData:item.missing}',
        }),
      ],
      assertions: [],
      intent: { transitions: [], confidence: 0, evidence: [] },
      negative: false,
      quality: {
        steps: 5,
        locators: {},
        ambiguousTargets: 0,
        fragileLocators: 0,
        values: {},
        assertions: { stable: 0, selected: 0, fragile: 0 },
        removedNoise: 0,
        mergedInputs: 0,
        collapsedCorrections: 0,
        removedDetours: 0,
        sensitiveRedacted: 0,
      },
    }),
  );
  await writeFile(
    path.join(recording, 'test-data.yaml'),
    stringifyYaml(
      testDataSetDocument({
        id: 'd',
        name: 'create-item',
        source: 'HUMAN_RECORDING',
        values: {
          'item.title': {
            key: 'item.title',
            strategy: 'RECORDED_LITERAL',
            value: 'Office printer',
            sensitive: false,
          },
          'item.contactEmail': {
            key: 'item.contactEmail',
            strategy: 'GENERATE_AT_REPLAY',
            generator: 'email',
            sensitive: false,
          },
          'item.secret': {
            key: 'item.secret',
            strategy: 'CREDENTIAL_REFERENCE',
            env: 'QA_SECRET',
            sensitive: true,
          },
        },
      }),
    ),
  );
  await writeFile(
    path.join(recording, 'human-review.json'),
    JSON.stringify({
      version: 1,
      decisions: [],
      bindings: [
        {
          id: 'b1',
          stepId: 's2',
          actionIds: [],
          source: 'GENERATED',
          variable: 'item.contactEmail',
          generator: 'email',
          at: '2026-05-25T10:00:00.000Z',
        },
      ],
    }),
  );

  const context = await openKnowledgeCenter(
    config,
    { readOnly: options.readOnly ?? false, language: 'fr' },
    {},
    () => NOW,
  );
  const withProvider = options.withProvider ?? true;
  const persistence = withProvider
    ? {
        provider: provider as PersistenceProvider,
        status: {
          enabled: true,
          status: 'CONNECTED' as const,
          configured: { provider: 'memory' as const },
          actual: { provider: 'memory' as const },
          schemaVersion: 5,
          writeErrors: [],
        },
      }
    : context.persistence;
  const patched: KnowledgeCenterContext = {
    ...context,
    persistence,
    memoryMode: withProvider ? 'historical' : context.memoryMode,
  };
  return { root, provider, context: patched, service: new KnowledgeCenterService(patched), runIds };
}

describe('knowledge center service: the four real sources, unified', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(async () => {
    await f.context.close();
  });

  it('lists the current application and the overview computes every metric from real rows', async () => {
    const applications = await f.service.applications();
    expect(applications[0]).toMatchObject({ id: APP_ID, application: APP, environment: ENV, current: true });
    expect(applications[0]?.sources.sort()).toEqual(['KNOWLEDGE_FILE', 'PERSISTENCE']);
    const overview = await f.service.overview(APP_ID);
    const value = (key: string): unknown => {
      const metric = overview.metrics[key];
      return metric && 'value' in metric ? metric.value : 'N/A';
    };
    expect(value('transitions')).toBe(5); // 4 persisted + 1 in the knowledge file
    expect(value('states')).toBe(4); // (none) is not a screen
    expect(value('flows')).toBe(1);
    expect(value('runs')).toBe(2);
    expect(value('stale')).toBe(1);
    expect(value('reuseRate')).toBe(80);
    expect(value('runsUsingKnowledge')).toBe('N/A');
    expect(overview.metrics.runsUsingKnowledge).toMatchObject({ unavailable: true });
    expect(JSON.stringify(overview.metrics.runsUsingKnowledge)).toContain('result.json');
    expect(overview.byType).toMatchObject({
      TRANSITION: 5,
      ACTION: 2,
      API: 2,
      RECOVERY: 1,
      TARGET_RESOLUTION: 1,
      HYPOTHESIS: 1,
      FUNCTIONAL: 1,
      LEARNED_WORKFLOW: 1,
      FIELD_MAPPING: 2,
      INTENT_DECISION: 1,
      RULE: 1,
      ANOMALY: 1,
      FLOW_MEMORY: 1,
    });
    expect(overview.byStatus).toMatchObject({ CONTRADICTED: 3, STALE: 1, HYPOTHESIS: 1, CONFIRMED: 3 });
    expect(overview.byStatus.FRAGILE).toBeGreaterThanOrEqual(2);
    // Contredites (action, transition, règle) et l'anomalie NEW ; l'API en échec unique n'est que fragile.
    expect(overview.activity.attention.map((entry) => entry.type).sort()).toEqual([
      'ACTION',
      'ANOMALY',
      'RULE',
      'TRANSITION',
    ]);
    expect(overview.activity.resolutionFailures).toHaveLength(1);
    expect(overview.activity.runs).toHaveLength(2);
    expect(overview.warnings).toEqual([]);
    expect(overview.memory).toMatchObject({ mode: 'historical', persistence: { status: 'CONNECTED' } });
  });

  it('search: text, type, status, origin, source, sort and server-side pages', async () => {
    const all = await f.service.search(APP_ID, { pageSize: 10 });
    expect(all.total).toBe(22);
    expect(all.pages).toBe(3);
    expect(all.items).toHaveLength(10);
    const page3 = await f.service.search(APP_ID, { pageSize: 10, page: 3 });
    expect(page3.items).toHaveLength(2);
    expect(page3.page).toBe(3);
    const contradicted = await f.service.search(APP_ID, {
      status: 'CONTRADICTED',
      sort: 'title',
      direction: 'asc',
    });
    expect(contradicted.items.map((item) => item.type)).toEqual(['ACTION', 'TRANSITION', 'RULE']);
    expect(
      [
        ...new Set((await f.service.search(APP_ID, { text: 'delete' })).items.map((item) => item.type)),
      ].sort(),
    ).toEqual(['HINT', 'TRANSITION']);
    expect((await f.service.search(APP_ID, { origin: 'HUMAN' })).items.map((item) => item.type)).toEqual([
      'INTENT_DECISION',
    ]);
    expect((await f.service.search(APP_ID, { source: 'RULES_FILE' })).total).toBe(1);
    expect((await f.service.search(APP_ID, { type: 'TRANSITION', source: 'PERSISTENCE' })).total).toBe(4);
    expect((await f.service.search(APP_ID, { text: 'nothing-matches-this' })).total).toBe(0);
  });

  it('a knowledge row has a stable id, real data, evidence, reasons, and its executions in the persisted runs', async () => {
    const [transition] = (await f.service.search(APP_ID, { text: 'navigate:items', source: 'PERSISTENCE' }))
      .items;
    expect(transition?.id).toBe(
      itemId('PERSISTENCE', 'TRANSITION', APP, ENV, ['home', 'navigate:items', 'items'].join('␟')),
    );
    expect(transition).toMatchObject({
      type: 'TRANSITION',
      origin: 'EXPLORATION',
      reliability: { status: 'CONFIRMED', reasons: ['4 success(es) out of 4 execution(s) (≥ 3)'] },
      evidence: { seen: 4, successes: 4, failures: 0, blocked: 0 },
      location: 'transition_knowledge',
      data: { averageDurationMs: 120 },
    });
    const detail = await f.service.item(APP_ID, transition?.id ?? '');
    expect(
      detail.executions.map((execution) => [execution.runId, execution.status, execution.runStatus]),
    ).toEqual([
      ['run-bbbb', 'SUCCESS', 'FAILED'],
      ['run-aaaa', 'SUCCESS', 'COMPLETED'],
    ]);
    expect(detail.executions[0]).toMatchObject({ durationMs: 120, version: 'c0ffee' });
    await expect(f.service.item(APP_ID, 'transition-0000000000000000')).rejects.toBeInstanceOf(
      KnowledgeNotFoundError,
    );
    const [rule] = (await f.service.search(APP_ID, { type: 'RULE' })).items;
    expect(rule).toMatchObject({
      origin: 'STATIC_ANALYSIS',
      reliability: { status: 'CONTRADICTED' },
      evidence: { confirmations: 1, contradictions: 2 },
    });
    expect((await f.service.item(APP_ID, rule?.id ?? '')).executionsNote).toContain(
      'only transitions and actions',
    );
  });

  it('a human decision is written to the ledger, shown with the row, versioned, and never changes the counters', async () => {
    const [item] = (await f.service.search(APP_ID, { type: 'HYPOTHESIS' })).items;
    const validated = await f.service.decide(APP_ID, {
      itemId: item?.id ?? '',
      operation: 'VALIDATE',
      expectedVersion: 0,
      note: 'seen on the screen',
    });
    expect(validated.item.review).toMatchObject({
      status: 'VALIDATED',
      note: 'seen on the screen',
      version: 1,
    });
    expect(validated.item.reliability.status).toBe('HYPOTHESIS');
    expect(validated.item.evidence).toEqual(item?.evidence);
    const again = await f.service.item(APP_ID, item?.id ?? '');
    expect(again.item.review?.status).toBe('VALIDATED');
    expect(again.history.map((entry) => entry.operation)).toEqual(['VALIDATE']);
    await expect(
      f.service.decide(APP_ID, { itemId: item?.id ?? '', operation: 'INVALIDATE', expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ReviewConflictError);
    expect((await f.service.search(APP_ID, { review: 'VALIDATED' })).total).toBe(1);
    expect((await f.service.search(APP_ID, { review: 'NONE' })).total).toBe(21);
    const overview = await f.service.overview(APP_ID);
    expect(overview.metrics.validated).toMatchObject({ value: 1 });
    const toVerify = (
      await Promise.all(
        (['FRAGILE', 'CONTRADICTED', 'HYPOTHESIS', 'UNVERIFIED'] as const).map(
          async (status) => (await f.service.search(APP_ID, { status, review: 'NONE' })).total,
        ),
      )
    ).reduce((sum, count) => sum + count, 0);
    expect(overview.metrics.toVerify).toMatchObject({ value: toVerify });
    expect(toVerify).toBeGreaterThanOrEqual(5);
  });

  it('flows, states, transitions and the graph come from the recordings, the flow memory and the transition knowledge', async () => {
    const flows = await f.service.flows(APP_ID);
    expect(flows.flows).toEqual([
      expect.objectContaining({
        name: 'create-item',
        source: 'RECORDING',
        steps: 5,
        produces: ['item.title', 'item.contactEmail'],
        consumes: ['item.title', 'item.missing'],
      }),
    ]);
    expect(flows.runs.map((run) => run.status)).toEqual(['FAILED', 'COMPLETED']);
    expect(flows.states.map((state) => state.signature)).toEqual(
      expect.arrayContaining(['home', 'items', '(none)', 'archive', 'old']),
    );
    expect(flows.transitions[0]).toMatchObject({
      from: 'archive',
      action: 'navigate:old',
      seen: 5,
      status: 'STALE',
    });
    const graph = await f.service.graph(APP_ID);
    expect(graph.nodes.find((node) => node.id === '(none)')?.kind).toBe('none');
    expect(graph.edges.map((edge) => edge.status).sort()).toEqual([
      'CONFIRMED',
      'CONTRADICTED',
      'FRAGILE',
      'OBSERVED',
      'STALE',
    ]);
    expect(graph.truncated).toBe(false);
  });

  it('business variables: producers, consumers, UI ↔ API mappings, the human binding, and the signals', async () => {
    const variables = await f.service.variables(APP_ID);
    expect(variables.unavailable).toBeUndefined();
    const title = variables.variables.find((variable) => variable.key === 'item.title');
    expect(title).toMatchObject({
      flow: 'create-item',
      strategy: 'RECORDED_LITERAL',
      value: 'Office printer',
      producedBy: { stepIndex: 1 },
      usedBy: [{ stepIndex: 4, how: 'INPUT' }],
      issues: [{ kind: 'STATIC_REUSED' }, { kind: 'AMBIGUOUS_MAPPING' }],
    });
    expect(title?.mappings.map((mapping) => mapping.property).sort()).toEqual(['label', 'title']);
    const email = variables.variables.find((variable) => variable.key === 'item.contactEmail');
    expect(email).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
      generator: 'email',
      humanBinding: { source: 'GENERATED' },
      issues: [{ kind: 'NEVER_CONSUMED' }],
    });
    const missingIssues =
      variables.variables.find((variable) => variable.key === 'item.missing')?.issues ?? [];
    expect(missingIssues.map((issue) => issue.kind)).toEqual(['BROKEN_DEPENDENCY']);
    expect(missingIssues[0]?.message).toContain('no entry');
    expect(variables.variables.some((variable) => variable.key === 'item.secret')).toBe(false);
    expect(variables.issues).toEqual({
      STATIC_REUSED: 1,
      AMBIGUOUS_MAPPING: 1,
      NEVER_CONSUMED: 1,
      BROKEN_DEPENDENCY: 1,
    });
  });

  it('quality: categories and signals with their definitions, computed from the same rows', async () => {
    const quality = await f.service.quality(APP_ID);
    const totals = Object.fromEntries(quality.signals.map((signal) => [signal.kind, signal.total]));
    expect(totals).toEqual({
      FAILING_SELECTORS: 1,
      BROKEN_TRANSITIONS: 2,
      CONTRADICTORY_MAPPINGS: 2,
      STALE: 1,
      CHANGED_RULES: 1,
      FROM_FAILED_RUNS: 2,
      INCONSISTENT_WITH_OBSERVATIONS: 2,
    });
    expect(quality.categories.find((category) => category.status === 'CONTRADICTED')?.total).toBe(3);
    expect(quality.categories.every((category) => category.definition.length > 0)).toBe(true);
  });

  it('history: the ledger operations and the learning timeline (runs and first sightings)', async () => {
    const history = await f.service.history(APP_ID);
    expect(history.entries.map((entry) => entry.operation)).toEqual(['VALIDATE']);
    expect(history.learning[0]).toMatchObject({ type: 'RUN', status: 'FAILED' });
    expect(history.learning.some((entry) => entry.type === 'TRANSITION')).toBe(true);
  });

  it('persistence state: health checked now, counts from the inventory, providers really implemented', async () => {
    const state = await f.service.persistence(APP_ID);
    expect(state).toMatchObject({
      status: 'CONNECTED',
      health: { status: 'CONNECTED' },
      counts: { runs: 2, states: 4, transitions: 4, knowledge: 4, anomalies: 1, memory: 1 },
      readOnly: false,
    });
    expect(state.providers.filter((provider) => provider.available).map((provider) => provider.kind)).toEqual(
      ['memory', 'file', 'sqlite', 'postgres', 'sqlserver'],
    );
    expect(state.providers.find((provider) => provider.kind === 'mysql')?.available).toBe(false);
  });
});

describe('knowledge center: configurations where memory or persistence are disabled', () => {
  it('persistence disabled: no provider is opened, the knowledge file is still read, decisions still work', async () => {
    const f = await fixture({ withProvider: false });
    try {
      expect(f.context.persistence.provider).toBeUndefined();
      const overview = await f.service.overview(APP_ID);
      expect(overview.memory).toMatchObject({
        mode: 'legacy',
        knowledgeFileEnabled: true,
        persistence: { enabled: false, status: 'DISABLED' },
      });
      expect(overview.metrics.runs).toMatchObject({ unavailable: true, reason: 'persistence is disabled' });
      expect(overview.metrics.lastSave).toMatchObject({ unavailable: true });
      expect(overview.byType).toMatchObject({ ACTION: 2, API: 2, TRANSITION: 1 });
      expect(overview.byType.FLOW_MEMORY).toBeUndefined();
      const [item] = (await f.service.search(APP_ID, { type: 'ACTION' })).items;
      const decided = await f.service.decide(APP_ID, {
        itemId: item?.id ?? '',
        operation: 'INVALIDATE',
        expectedVersion: 0,
      });
      expect(decided.item.review?.status).toBe('INVALIDATED');
      expect((await f.service.item(APP_ID, item?.id ?? '')).executionsNote).toContain(
        'persistence is disabled',
      );
      const state = await f.service.persistence(APP_ID);
      expect(state).toMatchObject({ enabled: false, status: 'DISABLED' });
      expect(state.health).toBeUndefined();
    } finally {
      await f.context.close();
    }
  });

  it('memory.enabled: false is read as "isolated" and shown; the Knowledge Center never changes it', async () => {
    const { config } = parseConfig(
      `
mission: { name: m }
target: { baseUrl: http://localhost:4200 }
memory: { enabled: false }
persistence: { enabled: true, provider: memory }
`,
      {},
      {},
    );
    const context = await openKnowledgeCenter(config, {}, {}, () => NOW);
    try {
      const service = new KnowledgeCenterService(context);
      expect(service.memoryState()).toMatchObject({
        mode: 'isolated',
        memoryEnabled: false,
        persistence: { enabled: true, status: 'CONNECTED' },
      });
      expect(config.memory.enabled).toBe(false);
      const overview = await service.overview(context.current.applicationId);
      expect(overview.metrics.total).toMatchObject({ value: 0 });
    } finally {
      await context.close();
    }
  });

  it('read-only: every write is refused before touching anything', async () => {
    const f = await fixture({ readOnly: true });
    try {
      const [item] = (await f.service.search(APP_ID, { type: 'ACTION' })).items;
      await expect(
        f.service.decide(APP_ID, { itemId: item?.id ?? '', operation: 'VALIDATE', expectedVersion: 0 }),
      ).rejects.toBeInstanceOf(ReadOnlyError);
      const exchange = new KnowledgeExchange(f.context);
      await expect(exchange.backup(APP_ID)).rejects.toBeInstanceOf(ReadOnlyError);
      await expect(
        exchange.apply(await exchange.exportApplication(APP_ID), DEFAULT_IMPORT_POLICY),
      ).rejects.toBeInstanceOf(ReadOnlyError);
      expect((await f.context.ledger.entries()).map((entry) => entry.operation)).toEqual(['EXPORT']);
    } finally {
      await f.context.close();
    }
  });
});

describe('export, import, backup, restore: only what the repositories really support', () => {
  it('export carries every table and file; preview and apply never recount transition knowledge', async () => {
    const f = await fixture();
    try {
      const exchange = new KnowledgeExchange(f.context);
      const document = await exchange.exportApplication(APP_ID);
      expect(document).toMatchObject({
        format: KNOWLEDGE_EXPORT_FORMAT,
        version: 1,
        application: { id: APP_ID, functionalApplication: 'kc-mission' },
      });
      expect(document.persistence).toMatchObject({ provider: 'in-memory' });
      expect(document.persistence?.knowledge).toHaveLength(4);
      expect(document.persistence?.runs).toHaveLength(2);
      expect(document.persistence?.states).toHaveLength(4);
      expect(document.knowledgeFile?.key).toBe(`${APP}@${ENV}`);
      expect(document.functional).toBeDefined();
      expect(document.rules).toBeDefined();
      expect(parseKnowledgeExport(JSON.parse(JSON.stringify(document))).application.id).toBe(APP_ID);

      // Importé dans un stockage vide : tout est ajouté.
      const empty = new InMemoryPersistenceProvider();
      await empty.initialize();
      const target: KnowledgeCenterContext = {
        ...f.context,
        persistence: { ...f.context.persistence, provider: empty },
        knowledgeFile: path.join(f.root, 'elsewhere', 'knowledge-base.json'),
        functionalDir: path.join(f.root, 'elsewhere', 'functional'),
        rulesDir: path.join(f.root, 'elsewhere', 'rules'),
      };
      const into = new KnowledgeExchange(target);
      const preview = await into.preview(document, DEFAULT_IMPORT_POLICY);
      expect(Object.fromEntries(preview.sections.map((section) => [section.section, section.added]))).toEqual(
        {
          runs: 2,
          states: 4,
          transitions: 4,
          knowledge: 4,
          evolution: 0,
          anomalies: 1,
          memory: 1,
          knowledgeFile: 1,
          functional: 1,
          rules: 1,
        },
      );
      const result = await into.apply(document, { ...DEFAULT_IMPORT_POLICY, backupFirst: false });
      expect(result.errors).toEqual([]);
      expect(Object.fromEntries(result.sections.map((section) => [section.section, section.added]))).toEqual({
        runs: 2,
        states: 4,
        transitions: 4,
        knowledge: 4,
        evolution: 0,
        anomalies: 1,
        memory: 1,
        knowledgeFile: 1,
        functional: 1,
        rules: 1,
      });
      expect(
        (await empty.knowledge.load(APP_ID, 100)).find((row) => row.actionSignature === 'navigate:items'),
      ).toMatchObject({ seenCount: 4, successCount: 4, averageDurationMs: 120 });
      const imported = new KnowledgeCenterService(target);
      expect((await imported.overview(APP_ID)).byType).toEqual((await f.service.overview(APP_ID)).byType);

      // Importé une seconde fois : rien n'est recompté, les conflits sont dits.
      const again = await into.preview(document, DEFAULT_IMPORT_POLICY);
      expect(again.sections.find((section) => section.section === 'knowledge')).toMatchObject({
        added: 0,
        identical: 4,
        conflicts: 0,
        onConflict: 'never-replaced',
      });
      const changed = structuredClone(document);
      const row = changed.persistence?.knowledge.find(
        (candidate) => candidate.actionSignature === 'navigate:items',
      );
      if (row) row.seenCount = 99;
      const memoryRow = changed.persistence?.memory[0];
      if (memoryRow) memoryRow.status = 'PASS';
      const conflict = await into.preview(changed, DEFAULT_IMPORT_POLICY);
      expect(conflict.sections.find((section) => section.section === 'knowledge')).toMatchObject({
        conflicts: 1,
        skipped: 4,
        samples: [expect.stringContaining('navigate:items')],
      });
      expect(conflict.sections.find((section) => section.section === 'memory')).toMatchObject({
        conflicts: 1,
        skipped: 1,
        onConflict: 'skip',
      });
      const skipped = await into.apply(changed, { replaceable: 'skip', files: 'skip', backupFirst: false });
      expect(skipped.sections.find((section) => section.section === 'memory')).toMatchObject({
        replaced: 0,
        skipped: 1,
      });
      const replaced = await into.apply(changed, {
        replaceable: 'replace',
        files: 'skip',
        backupFirst: false,
      });
      expect(replaced.sections.find((section) => section.section === 'memory')).toMatchObject({
        replaced: 1,
      });
      expect((await empty.memory.search({ applicationId: APP_ID, limit: 10 }))[0]?.status).toBe('PASS');
      expect(
        (await empty.knowledge.load(APP_ID, 100)).find(
          (candidate) => candidate.actionSignature === 'navigate:items',
        )?.seenCount,
      ).toBe(4);
      expect((await target.ledger.entries()).filter((entry) => entry.operation === 'IMPORT')).toHaveLength(3);
    } finally {
      await f.context.close();
    }
  });

  it('refuses what is not an export, and an export newer than this crawler', () => {
    expect(() => parseKnowledgeExport({ format: 'something-else' })).toThrow(ImportValidationError);
    expect(() => parseKnowledgeExport({ format: KNOWLEDGE_EXPORT_FORMAT, version: 1 })).toThrow(
      ImportValidationError,
    );
    expect(() =>
      parseKnowledgeExport({
        format: KNOWLEDGE_EXPORT_FORMAT,
        version: 1,
        exportedAt: '2026-06-01T00:00:00.000Z',
        crawlerVersion: '9',
        application: { id: 'a', application: 'a', functionalApplication: 'a' },
        persistence: {
          provider: 'x',
          schemaVersion: 99,
          runs: [],
          states: [],
          transitions: [],
          knowledge: [],
          evolution: [],
          anomalies: [],
          memory: [],
        },
        review: [],
      }),
    ).toThrow(/persistence schema 99 is newer than this crawler/);
  });

  it('backup before restore, and a restore that says exactly what was restored', async () => {
    const f = await fixture();
    try {
      const exchange = new KnowledgeExchange(f.context);
      const backup = await exchange.backup(APP_ID, 'manual');
      expect(backup.id).toMatch(/demo-app_test\.json$/);
      expect((await exchange.backups()).map((entry) => entry.id)).toEqual([backup.id]);
      await f.provider.memory.save([
        {
          applicationId: APP_ID,
          kind: 'run',
          key: f.runIds[1] ?? '',
          status: 'PASS',
          firstSeenAt: '2026-05-29T00:00:00.000Z',
          lastSeenAt: '2026-05-29T00:00:00.000Z',
          data: { runId: f.runIds[1] },
        },
      ]);
      const restored = await exchange.restore(backup.id, 'undo the edit');
      expect(restored.restoredFrom).toBe(backup.id);
      expect(restored.errors).toEqual([]);
      expect(restored.backup?.id).not.toBe(backup.id);
      expect(restored.sections.find((section) => section.section === 'memory')).toMatchObject({
        replaced: 1,
      });
      expect(restored.sections.find((section) => section.section === 'knowledge')).toMatchObject({
        added: 0,
        skipped: 4,
      });
      expect((await f.provider.memory.search({ applicationId: APP_ID, limit: 10 }))[0]?.status).toBe('FAIL');
      const operations = (await f.context.ledger.entries()).map((entry) => entry.operation);
      expect(operations.slice(0, 4)).toEqual(['RESTORE', 'IMPORT', 'BACKUP', 'BACKUP']);
      await expect(exchange.readBackup('../etc/passwd.json')).rejects.toBeInstanceOf(ImportValidationError);
      await expect(exchange.restore('missing.json')).rejects.toThrow(/cannot read backup/);
    } finally {
      await f.context.close();
    }
  });
});

describe('knowledge center server: the page, the JSON API, and the protection of writes', () => {
  let f: Fixture;
  let url: string;
  let token: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    f = await fixture();
    const running = await startKnowledgeCenterServer(f.service, { host: '127.0.0.1', port: 0 });
    url = running.url;
    token = running.token;
    close = () => running.close();
  });
  afterAll(async () => {
    await close();
    await f.context.close();
  });
  const get = async (route: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${url}${route}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const post = async (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const writeHeaders = (): Record<string, string> => ({
    'x-qa-knowledge-center': '1',
    authorization: `Bearer ${token}`,
  });

  it('serves the page with a strict CSP, the token embedded, and the navigation', async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('Knowledge Center');
    expect(html).toContain(JSON.stringify(token));
    for (const view of ['overview', 'explorer', 'flows', 'variables', 'quality', 'history', 'persistence'])
      expect(html).toContain(`href="#/${view}"`);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it('reads: meta, overview, paged search with parsed parameters, detail, flows, graph, variables, quality, history, persistence, export', async () => {
    const meta = await get('/api/meta');
    expect(meta.body).toMatchObject({ mission: 'kc-mission', options: { readOnly: false, language: 'fr' } });
    expect((meta.body.applications as { id: string }[])[0]?.id).toBe(APP_ID);
    const app = encodeURIComponent(APP_ID);
    expect((await get(`/api/apps/${app}/overview`)).status).toBe(200);
    const page = await get(
      `/api/apps/${app}/items?type=TRANSITION&pageSize=2&page=2&sort=title&direction=asc&status=bogus`,
    );
    expect(page.body).toMatchObject({ total: 5, page: 2, pageSize: 2, pages: 3 });
    const items = page.body.items as { id: string; type: string }[];
    expect(items.every((item) => item.type === 'TRANSITION')).toBe(true);
    expect((await get(`/api/apps/${app}/items/${items[0]?.id ?? ''}`)).body).toHaveProperty('executions');
    expect((await get(`/api/apps/${app}/items/transition-0000000000000000`)).status).toBe(404);
    for (const route of ['flows', 'graph', 'variables', 'quality', 'history', 'persistence'])
      expect((await get(`/api/apps/${app}/${route}`)).status).toBe(200);
    const exported = await fetch(`${url}/api/apps/${app}/export`);
    expect(exported.headers.get('content-disposition')).toMatch(
      /^attachment; filename="knowledge-demo-app_test-/,
    );
    expect(((await exported.json()) as { format: string }).format).toBe(KNOWLEDGE_EXPORT_FORMAT);
    expect((await get('/api/apps/unknown-app/overview')).status).toBe(200);
  });

  it('writes: refused without the custom header, with a wrong token, from another origin; accepted from the page', async () => {
    const app = encodeURIComponent(APP_ID);
    const [item] = (await f.service.search(APP_ID, { type: 'API' })).items;
    const route = `/api/apps/${app}/items/${item?.id ?? ''}/decision`;
    const body = { operation: 'VALIDATE', expectedVersion: 0 };
    expect((await post(route, body)).status).toBe(403);
    expect((await post(route, body, { 'x-qa-knowledge-center': '1' })).status).toBe(401);
    expect(
      (await post(route, body, { 'x-qa-knowledge-center': '1', authorization: 'Bearer nope' })).status,
    ).toBe(401);
    expect((await post(route, body, { ...writeHeaders(), origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(route, { operation: 'DELETE', expectedVersion: 0 }, writeHeaders())).status).toBe(400);
    expect((await post(route, { operation: 'VALIDATE', expectedVersion: 'x' }, writeHeaders())).status).toBe(
      400,
    );
    const accepted = await post(route, body, { ...writeHeaders(), origin: new URL(url).origin });
    expect(accepted.status).toBe(200);
    expect((accepted.body.item as { review: { status: string } }).review.status).toBe('VALIDATED');
    expect((await post(route, body, writeHeaders())).status).toBe(409);
    const response = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { ...writeHeaders(), 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(response.status).toBe(415);
  });

  it('import preview and apply through the API, with the policy, and backups', async () => {
    const app = encodeURIComponent(APP_ID);
    const document = (await (await fetch(`${url}/api/apps/${app}/export`)).json()) as Record<string, unknown>;
    const preview = await post(
      `/api/apps/${app}/import/preview`,
      { document, policy: { replaceable: 'replace' } },
      writeHeaders(),
    );
    expect(preview.status).toBe(200);
    expect((preview.body.sections as { section: string }[]).map((section) => section.section)).toContain(
      'knowledge',
    );
    const wrong = await post(
      `/api/apps/${app}/import/preview`,
      { document: { ...document, application: { ...(document.application as object), id: 'other' } } },
      writeHeaders(),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('not "demo-app@test"');
    const invalid = await post(
      `/api/apps/${app}/import/preview`,
      { document: { format: 'x' } },
      writeHeaders(),
    );
    expect(invalid.status).toBe(400);
    const applied = await post(
      `/api/apps/${app}/import/apply`,
      { document, policy: { backupFirst: true } },
      writeHeaders(),
    );
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.body.backup).toBeDefined();
    const backups = await get('/api/backups');
    expect((backups.body.backups as unknown[]).length).toBeGreaterThanOrEqual(1);
    const created = await post(`/api/apps/${app}/backups`, { reason: 'test' }, writeHeaders());
    expect(created.status).toBe(200);
    const restored = await post(
      `/api/backups/${encodeURIComponent(String(created.body.id))}/restore`,
      {},
      writeHeaders(),
    );
    expect(restored.status).toBe(200);
    expect(restored.body.restoredFrom).toBe(created.body.id);
    expect((await post('/api/backups/nope.json/restore', {}, writeHeaders())).status).toBe(400);
    expect((await post('/api/refresh', {}, writeHeaders())).body).toEqual({ refreshed: true });
  });
});

describe('knowledge center: the inventory of the providers and the engine files left untouched', () => {
  it('in-memory and file providers count their rows per application; a decision changes no engine file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kc-inventory-'));
    const provider = new JsonPersistenceProvider(dir);
    await provider.initialize();
    await provider.runs.create({
      id: 'r1',
      applicationId: 'app-a',
      missionName: 'm',
      mode: 'explore',
      startedAt: '2026-05-01T00:00:00.000Z',
      status: 'COMPLETED',
      statesCount: 0,
      actionsCount: 0,
      transitionsCount: 0,
      anomaliesCount: 0,
    });
    await provider.states.save([
      {
        id: 's',
        runId: 'r1',
        stateSignature: 'home',
        stateId: 'home',
        routePattern: '/',
        urlNormalized: '/',
        depth: 0,
        firstSeenAt: '2026-05-01T00:00:00.000Z',
        lastSeenAt: '2026-05-01T00:00:00.000Z',
        context: {},
      },
    ]);
    await provider.knowledge.record([
      {
        applicationId: 'app-a',
        fromStateSignature: 'home',
        actionSignature: 'a',
        toStateSignature: 'b',
        seen: 1,
        success: 1,
        failure: 0,
        blocked: 0,
        durationTotalMs: 0,
        durationCount: 0,
        firstSeenAt: '2026-05-02T00:00:00.000Z',
        lastSeenAt: '2026-05-02T00:00:00.000Z',
      },
      {
        applicationId: 'app-b',
        fromStateSignature: 'home',
        actionSignature: 'a',
        toStateSignature: 'b',
        seen: 1,
        success: 1,
        failure: 0,
        blocked: 0,
        durationTotalMs: 0,
        durationCount: 0,
        firstSeenAt: '2026-05-03T00:00:00.000Z',
        lastSeenAt: '2026-05-03T00:00:00.000Z',
      },
    ]);
    const inventory = await provider.inventory.applications();
    expect(inventory).toEqual([
      {
        applicationId: 'app-a',
        counts: { runs: 1, states: 1, transitions: 0, knowledge: 1, evolution: 0, anomalies: 0, memory: 0 },
        lastSeenAt: '2026-05-02T00:00:00.000Z',
      },
      {
        applicationId: 'app-b',
        counts: { runs: 0, states: 0, transitions: 0, knowledge: 1, evolution: 0, anomalies: 0, memory: 0 },
        lastSeenAt: '2026-05-03T00:00:00.000Z',
      },
    ]);
    const before = await readFile(path.join(dir, 'transition-knowledge.json'), 'utf8');
    const { config } = parseConfig(
      `
mission: { name: m }
target: { baseUrl: http://localhost:4200 }
knowledge: { file: ${path.join(dir, 'kb.json')}, application: app-a }
persistence: { enabled: true, provider: file, file: { directory: ${dir} } }
memory: { enabled: true }
`,
      {},
      {},
    );
    const context = await openKnowledgeCenter(config, {}, {}, () => NOW);
    try {
      const service = new KnowledgeCenterService(context);
      expect((await service.applications()).map((application) => application.id)).toEqual(['app-a', 'app-b']);
      const [item] = (await service.search('app-a', { type: 'TRANSITION' })).items;
      await service.decide('app-a', {
        itemId: item?.id ?? '',
        operation: 'INVALIDATE',
        expectedVersion: 0,
        reason: 'wrong screen',
      });
      expect(await readFile(path.join(dir, 'transition-knowledge.json'), 'utf8')).toBe(before);
      expect(
        (
          JSON.parse(await readFile(path.join(dir, 'knowledge-center', 'review-ledger.json'), 'utf8')) as {
            entries: unknown[];
          }
        ).entries,
      ).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
