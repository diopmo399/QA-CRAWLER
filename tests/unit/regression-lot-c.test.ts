import { describe, expect, it } from 'vitest';
import { classifyFlakiness, flakinessDistribution } from '../../src/intelligence/flakiness.js';
import { flakinessOf } from '../../src/intelligence/intelligence.js';
import { HistoricalTransitionAnomalyDetector } from '../../src/knowledge/historical-detectors.js';
import type { TransitionKnowledge } from '../../src/knowledge/knowledge-model.js';
import type { FlowEdge, FlowGraphData, FlowNode } from '../../src/model/flow.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import type { Issue } from '../../src/model/issue.js';
import { sanitizeRecord } from '../../src/persistence/sanitize.js';
import { anomalyKeyOf, updateLifecycle, type AnomalyRecord } from '../../src/regression/anomaly-lifecycle.js';
import { evolveFlows, type ElementEvolution } from '../../src/regression/flow-evolution.js';
import { testConfig } from '../helpers.js';

const knowledge = (
  successes: number,
  failures: number,
  targets: Record<string, number>,
): TransitionKnowledge => ({
  fromStateSignature: 'search',
  actionSignature: 'click:rechercher',
  targets,
  executionCount: successes + failures,
  successCount: successes,
  failureCount: failures,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-06-01T00:00:00.000Z',
});

describe('flaky detection', () => {
  it('Search → Results: 100 observations, 72 passed, 28 failed → UNSTABLE', () => {
    const result = classifyFlakiness(knowledge(72, 28, { results: 72 }));
    expect(result).toMatchObject({ class: 'UNSTABLE', passRate: 0.72, observations: 100 });
  });
  it('stable, mostly stable, highly unstable, and UNKNOWN with too few observations', () => {
    expect(classifyFlakiness(knowledge(100, 0, { results: 100 })).class).toBe('STABLE');
    expect(classifyFlakiness(knowledge(90, 10, { results: 90 })).class).toBe('MOSTLY_STABLE');
    expect(classifyFlakiness(knowledge(30, 70, { results: 30 })).class).toBe('HIGHLY_UNSTABLE');
    // Destinations changeantes : instable même sans échec.
    expect(classifyFlakiness(knowledge(20, 0, { results: 12, empty: 8 })).class).toBe('UNSTABLE');
    expect(classifyFlakiness(knowledge(1, 1, { results: 1 })).class).toBe('UNKNOWN');
  });
  it('distribution for the report', () => {
    expect(
      flakinessDistribution([
        knowledge(100, 0, { a: 100 }),
        knowledge(72, 28, { a: 72 }),
        knowledge(1, 0, { a: 1 }),
      ]),
    ).toEqual({ STABLE: 1, MOSTLY_STABLE: 0, UNSTABLE: 1, HIGHLY_UNSTABLE: 0, UNKNOWN: 1 });
  });
  it('flag: nothing unless intelligence and flakyDetection are enabled', () => {
    expect(flakinessOf(testConfig())).toBeUndefined();
    expect(
      flakinessOf(testConfig('intelligence: { enabled: true, flakyDetection: { enabled: false } }')),
    ).toBeUndefined();
    expect(flakinessOf(testConfig('intelligence: { enabled: true }'))).toBeDefined();
  });
});

describe('the historical oracle with flaky detection', () => {
  const detector = new HistoricalTransitionAnomalyDetector({
    minObservations: 3,
    dominance: 0.8,
    flakiness: (entry) => classifyFlakiness(entry),
  });
  const toError = {
    fromStateSignature: 'search',
    actionSignature: 'click:rechercher',
    toStateSignature: 'error',
  };

  it('a historically stable transition that changes (towards an error): POTENTIAL_REGRESSION', () => {
    const anomaly = detector.evaluate(toError, knowledge(100, 0, { results: 100 }));
    expect(anomaly?.category).toBe('POTENTIAL_REGRESSION');
    expect(anomaly?.flakiness?.class).toBe('STABLE');
  });
  it('a historically flaky transition that changes: a WARNING (UNEXPECTED_BEHAVIOR), never a regression', () => {
    const anomaly = detector.evaluate(toError, knowledge(60, 25, { results: 60 }));
    expect(anomaly?.flakiness?.class).toBe('UNSTABLE');
    expect(anomaly?.category).toBe('UNEXPECTED_BEHAVIOR');
    expect(anomaly?.message).toContain('history UNSTABLE');
  });
  it('very unstable: UNKNOWN', () => {
    expect(detector.evaluate(toError, knowledge(40, 60, { results: 40 }))?.category).toBe('UNKNOWN');
  });
  it('without flaky detection: the previous behaviour', () => {
    const plain = new HistoricalTransitionAnomalyDetector({ minObservations: 3, dominance: 0.8 });
    const anomaly = plain.evaluate(toError, knowledge(60, 25, { results: 60 }));
    expect(anomaly?.category).toBe('POTENTIAL_REGRESSION');
    expect(anomaly?.flakiness).toBeUndefined();
  });
});

// ---- graphes de test
const node = (
  id: string,
  label: string,
  actions: Record<string, { type: 'click' | 'navigate'; text: string }> = {},
): FlowNode => ({
  id,
  label,
  url: `http://app/${id}`,
  route: `/${id}`,
  headings: [],
  depth: 0,
  discoveredActions: Object.keys(actions),
  actions: Object.fromEntries(
    Object.entries(actions).map(([actionId, action]) => [
      actionId,
      { ...action, category: 'navigation' as const, classification: 'SAFE' as const },
    ]),
  ),
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  visits: 1,
  issueIds: [],
});
const edge = (
  from: string,
  to: string,
  actionId: string,
  text: string,
  result: FlowEdge['result'] = 'SUCCESS',
): FlowEdge => ({
  from,
  to,
  actionId,
  action: { type: 'click', category: 'navigation', text, classification: 'SAFE' },
  result,
  timestamp: '2026-01-01T00:00:00.000Z',
  issueIds: [],
});
const graph = (nodes: FlowNode[], edges: FlowEdge[]): FlowGraphData => ({ version: 1, nodes, edges });
const run = (n: number, complete = false) => ({
  at: `2026-0${n}-01T00:00:00.000Z`,
  run: `run-${n}`,
  version: `v${n}`,
  complete,
});
const flowRun = (name: string, states: string[]): FlowRunReport => ({
  name,
  status: 'PASSED',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1,
  steps: [],
  states,
  issueIds: [],
  explored: false,
});

describe('flow evolution: v1 → v2 → v3, from one row per element', () => {
  const step = (
    records: ElementEvolution[],
    g: FlowGraphData,
    n: number,
    flows: FlowRunReport[] = [],
    complete = false,
  ) => {
    const result = evolveFlows(records, g, flows, run(n, complete), { historyLimit: 20 });
    const all = new Map(records.map((record) => [record.key, record]));
    for (const record of result.records) all.set(record.key, record);
    return { all: [...all.values()], changes: result.changes };
  };
  const home = (actions: Record<string, { type: 'click'; text: string }>) => node('home', 'Accueil', actions);

  it('when a state appeared, when an action disappeared, since when a transition leads elsewhere', () => {
    // v1 : Accueil → « Utilisateurs » → Utilisateurs ; « Ancien » → Ancien
    const v1 = step(
      [],
      graph(
        [
          home({ a1: { type: 'click', text: 'Utilisateurs' }, a2: { type: 'click', text: 'Ancien' } }),
          node('users', 'Utilisateurs'),
          node('old', 'Ancien'),
        ],
        [edge('home', 'users', 'a1', 'Utilisateurs'), edge('home', 'old', 'a2', 'Ancien')],
      ),
      1,
    );
    expect(v1.changes.filter((change) => change.change === 'APPEARED')).toHaveLength(5);
    // v2 : « Ancien » a disparu de l'Accueil ; une page Rapports apparaît
    const v2 = step(
      v1.all,
      graph(
        [
          home({ a1: { type: 'click', text: 'Utilisateurs' }, a3: { type: 'click', text: 'Rapports' } }),
          node('users', 'Utilisateurs'),
          node('reports', 'Rapports'),
        ],
        [edge('home', 'users', 'a1', 'Utilisateurs'), edge('home', 'reports', 'a3', 'Rapports')],
      ),
      2,
    );
    expect(v2.changes.map((change) => `${change.kind} ${change.change} ${change.label}`)).toEqual(
      expect.arrayContaining([
        'STATE APPEARED Rapports',
        'TRANSITION APPEARED Accueil → "Rapports"',
        'TRANSITION DISAPPEARED Accueil → "Ancien"',
      ]),
    );
    // Exploration partielle : l'état Ancien n'est PAS déclaré disparu.
    expect(v2.all.find((record) => record.label === 'Ancien')?.status).toBe('PRESENT');
    const reports = v2.all.find((record) => record.label === 'Rapports');
    expect(reports?.firstSeen).toMatchObject({ run: 'run-2', version: 'v2' });
    // v3 : « Utilisateurs » mène maintenant à Connexion
    const v3 = step(
      v2.all,
      graph(
        [home({ a1: { type: 'click', text: 'Utilisateurs' } }), node('login', 'Connexion')],
        [edge('home', 'login', 'a1', 'Utilisateurs')],
      ),
      3,
      [],
      true,
    );
    const users = v3.all.find((record) => record.label === 'Accueil → "Utilisateurs"');
    expect(users?.targetSince).toMatchObject({ version: 'v3' });
    expect(users?.targetLabel).toBe('Connexion');
    expect(v3.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ change: 'TARGET_CHANGED', detail: 'Utilisateurs → Connexion' }),
      ]),
    );
    // Exploration complète : les états non atteints ont disparu.
    expect(v3.all.find((record) => record.label === 'Ancien')?.status).toBe('DISAPPEARED');
    expect(users?.versionCount).toBe(3);
    // v4 : Rapports revient
    const v4 = step(v3.all, graph([home({}), node('reports', 'Rapports')], []), 4);
    expect(v4.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Rapports', change: 'REAPPEARED' })]),
    );
  });

  it('an action still offered but not executed this time is not gone', () => {
    const v1 = step(
      [],
      graph(
        [home({ a1: { type: 'click', text: 'Utilisateurs' } }), node('users', 'Utilisateurs')],
        [edge('home', 'users', 'a1', 'Utilisateurs')],
      ),
      1,
    );
    const v2 = step(v1.all, graph([home({ a1: { type: 'click', text: 'Utilisateurs' } })], []), 2);
    expect(v2.changes.some((change) => change.change === 'DISAPPEARED')).toBe(false);
  });

  it('how many versions an imposed flow went through, and when its path changed', () => {
    let records: ElementEvolution[] = [];
    for (const [n, path] of [
      [1, ['home', 'users']],
      [2, ['home', 'users']],
      [3, ['home', 'login', 'users']],
    ] as const) {
      const g = graph(
        path.map((id) => node(id, id)),
        [],
      );
      const next = step(records, g, n, [flowRun('Créer un utilisateur', [...path])]);
      records = next.all;
      if (n === 3)
        expect(next.changes.find((change) => change.change === 'PATH_CHANGED')?.detail).toBe(
          'home → users ⇒ home → login → users',
        );
    }
    const flow = records.find((record) => record.kind === 'FLOW');
    expect(flow).toMatchObject({ versionCount: 3, runs: 3 });
  });

  it('the stored rows survive the sanitizer (no field name looks like a secret)', () => {
    const v1 = step(
      [],
      graph(
        [home({ a1: { type: 'click', text: 'Utilisateurs' } }), node('users', 'Utilisateurs')],
        [edge('home', 'users', 'a1', 'Utilisateurs')],
      ),
      1,
      [flowRun('f', ['home', 'users'])],
    );
    for (const record of v1.all) expect(sanitizeRecord({ data: record }).data).toEqual(record);
  });
});

describe('anomaly lifecycle: NEW → KNOWN → RESOLVED → REOPENED (→ FLAKY)', () => {
  const issue = (overrides: Partial<Issue> = {}): Issue => ({
    id: 'ISSUE-0001',
    type: 'CONSOLE',
    severity: 'ERROR',
    message: 'TypeError: x is undefined at line 42',
    pageUrl: 'http://app/users',
    pages: ['http://app/users'],
    stateId: 'users',
    flow: ['home', 'users'],
    states: ['users'],
    timestamp: '2026-01-01T00:00:00.000Z',
    occurrences: 3,
    ...overrides,
  });
  const visited = graph([node('home', 'Accueil'), node('users', 'Utilisateurs')], []);
  const elsewhere = graph([node('home', 'Accueil')], []);
  const options = { resolveAfterChecks: 2, flakyAfterFlips: 2, historyLimit: 20 };
  const life = (records: AnomalyRecord[], issues: Issue[], g: FlowGraphData, n: number, extra = {}) => {
    const result = updateLifecycle(
      records,
      issues,
      g,
      { ...run(n), environment: 'qa', actor: 'admin', ...extra },
      options,
    );
    const all = new Map(records.map((record) => [record.key, record]));
    for (const record of result.records) all.set(record.key, record);
    return { all: [...all.values()], result };
  };

  it('the whole lifecycle, with an explicit resolution rule', () => {
    const r1 = life([], [issue()], visited, 1);
    expect(r1.all[0]).toMatchObject({
      status: 'NEW',
      occurrenceCount: 3,
      environments: ['qa'],
      actors: ['admin'],
    });
    expect(r1.all[0]?.reproductionPath).toEqual(['Accueil', 'Utilisateurs']);
    expect(r1.result.events.map((event) => event.kind)).toEqual(['ANOMALY_CREATED']);
    expect(r1.result.byIssue['ISSUE-0001']?.status).toBe('NEW');
    // Même anomalie (autre ligne, même message aux nombres près) : KNOWN
    const r2 = life(
      r1.all,
      [issue({ message: 'TypeError: x is undefined at line 43', occurrences: 1 })],
      visited,
      2,
      { environment: 'staging' },
    );
    expect(r2.all[0]).toMatchObject({
      status: 'KNOWN',
      occurrenceCount: 4,
      runsSeen: 2,
      environments: ['qa', 'staging'],
    });
    // Pas repassé par l'écran : rien n'est prouvé, toujours KNOWN
    const r3 = life(r2.all, [], elsewhere, 3);
    expect(r3.all[0]).toMatchObject({ status: 'KNOWN', cleanChecks: 0 });
    // Écran revu sans l'anomalie : 1, puis 2 vérifications → RESOLVED
    const r4 = life(r3.all, [], visited, 4);
    expect(r4.all[0]).toMatchObject({ status: 'KNOWN', cleanChecks: 1 });
    const r5 = life(r4.all, [], visited, 5);
    expect(r5.all[0]?.status).toBe('RESOLVED');
    expect(r5.result.events.map((event) => event.kind)).toEqual(['ANOMALY_RESOLVED']);
    // Elle revient : REOPENED
    const r6 = life(r5.all, [issue()], visited, 6);
    expect(r6.all[0]).toMatchObject({ status: 'REOPENED', reopenedCount: 1 });
    expect(r6.result.events.map((event) => event.kind)).toEqual(['ANOMALY_REOPENED']);
    // Absente à une vérification, puis revenue : un deuxième aller-retour → FLAKY
    const r7 = life(r6.all, [], visited, 7);
    const r8 = life(r7.all, [issue()], visited, 8);
    expect(r8.all[0]?.status).toBe('FLAKY');
    expect(r8.result.events.map((event) => event.kind)).toEqual(['ANOMALY_FLAKY']);
  });

  it('the key is the grouping of the IssueCollector (numbers masked), stable across runs', () => {
    expect(anomalyKeyOf(issue({ message: 'error 404 at /users/12' }))).toBe(
      anomalyKeyOf(issue({ id: 'ISSUE-0099', message: 'error 404 at /users/57' })),
    );
    expect(anomalyKeyOf(issue({ type: 'HTTP' }))).not.toBe(anomalyKeyOf(issue()));
  });

  it('an anomaly tied to an action needs that action replayed to count as checked', () => {
    const withAction = life([], [issue({ actionId: 'act-1' })], visited, 1);
    const notReplayed = life(withAction.all, [], visited, 2);
    expect(notReplayed.all[0]?.cleanChecks).toBe(0);
    const replayed = life(
      withAction.all,
      [],
      graph(visited.nodes, [edge('home', 'users', 'act-1', 'Utilisateurs')]),
      2,
    );
    expect(replayed.all[0]?.cleanChecks).toBe(1);
  });

  it('the stored rows survive the sanitizer', () => {
    const r1 = life([], [issue()], visited, 1);
    for (const record of r1.all) expect(sanitizeRecord({ data: record }).data).toEqual(record);
  });
});
