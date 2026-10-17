import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import type { QualityVerificationReport } from '../../src/quality/quality-verification.js';
import { startQualityApp, type QualityApp, type QualityAppBugs } from '../fixtures/quality-app.js';

/**
 * VÉRIFICATION MÉTIER DE BOUT EN BOUT (`runMission`) : un flow de création → détail → recherche sur
 * une application à API en mémoire, ses assertions déclarées, la cohérence des données et la
 * traçabilité des exigences. Les défauts de l'application sont activés un par un : un clic réussi
 * n'est jamais pris pour un résultat métier.
 */
describe('Business verification — assertions, data consistency and traceability on a real run', () => {
  let app: QualityApp;
  let dir = '';

  const mission = (name: string, extraAssertions = ''): string => `mission: { name: business-verification }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
report: { failOnSeverity: NONE, language: fr }
output: { reportsDir: ${path.join(dir, name)}, screenshotsDir: ${path.join(dir, `${name}-shots`)} }
knowledge: { file: ${path.join(dir, 'knowledge', 'knowledge.json')} }
requirements:
  - { id: REQ-REQUEST-CREATE, description: A request is created with the title typed, criticality: CRITICAL, source: TICKET-101 }
  - { id: REQ-REQUEST-SEARCH, description: A created request can be found, dependsOn: [REQ-REQUEST-CREATE] }
  - { id: REQ-REQUEST-EXPORT, description: Requests can be exported }
businessRules:
  - id: BR-REQUEST-OWNER
    description: A new request belongs to the default owner
    requirementIds: [REQ-REQUEST-CREATE]
    assertions: [request-owner]
flows:
  - name: create-request
    startAt: /
    testData: ${path.join(dir, 'test-data.yaml')}
    requirements: [REQ-REQUEST-CREATE, REQ-REQUEST-SEARCH]
    steps:
      - click: { role: button, name: New request }
        allow: MUTATION
      - fill: { label: Title, value: { testData: request.title } }
      - click: { role: button, name: Save }
        allow: MUTATION
      - expect: { url: /requests/ }
      - click: { role: button, name: Search requests }
      - fill: { label: Search, value: { testData: request.title } }
      - click: { role: button, name: Search, exact: true }
    assertions:
      - id: request-created
        description: The creation is accepted and returns the identifier of the request
        criticality: CRITICAL
        after: 3
        check: { kind: request, method: POST, path: /api/requests, status: 201, requireIdentifier: true, extract: { name: requestId, field: id } }
      - id: title-saved
        description: The server returns the title typed in this run
        criticality: HIGH
        check: { kind: value, source: response, method: POST, path: /api/requests, field: title, expected: { testData: request.title } }
      - id: title-read-back
        description: An authorized read of the request returns the title of this run
        criticality: HIGH
        requires: [request-created]
        evidence: [API]
        check: { kind: value, source: api, api: { url: '/api/requests/\${extracted:requestId}' }, field: title, expected: { testData: request.title } }
      - id: request-owner
        description: The request belongs to the default owner
        requires: [request-created]
        check: { kind: relation, source: api, api: { url: '/api/requests/\${extracted:requestId}' }, entity: { field: id, value: { extracted: requestId } }, field: ownerId, expected: { value: USR-2001 } }
      - id: single-request
        description: Exactly one request carries the title of this run
        check: { kind: cardinality, source: api, api: { url: '/api/requests?q=\${testData:request.title}', select: items }, matching: { field: title, value: { testData: request.title } }, equals: 1 }
      - id: request-open
        description: The request reaches the OPEN state (asynchronous processing)
        requires: [request-created]
        after: 4
        timeoutMs: 8000
        pollMs: 500
        check: { kind: state, source: api, api: { url: '/api/requests/\${extracted:requestId}' }, field: status, expected: OPEN, pending: [PENDING] }
${extraAssertions}    consistency:
      displayed: [request.title]
      sideEffects: { allowedWrites: [{ method: POST, path: /api/requests }], maxCreated: 1 }
`;

  const run = async (
    name: string,
    bugs: QualityAppBugs = {},
    extra = '',
  ): Promise<{ result: ExplorationResult; quality: QualityVerificationReport; dir: string }> => {
    app.reset();
    Object.assign(app.bugs, bugs);
    const { config } = parseConfig(mission(name, extra), {}, {});
    const { result } = await runMission(config, { env: {} });
    const reportsDir = path.join(dir, name);
    const quality = JSON.parse(
      await readFile(path.join(reportsDir, 'quality-verification.json'), 'utf8'),
    ) as QualityVerificationReport;
    return { result, quality, dir: reportsDir };
  };

  let clean: Awaited<ReturnType<typeof run>>;
  let broken: Awaited<ReturnType<typeof run>>;
  let pending: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    app = await startQualityApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-business-verification-'));
    await writeFile(
      path.join(dir, 'test-data.yaml'),
      `values:\n  request:\n    title: { strategy: generated, generator: text }\n`,
    );
    clean = await run('clean');
    broken = await run('broken', { wrongTitle: true, duplicate: true, wrongOwner: true });
    pending = await run(
      'pending',
      { asyncStatusMs: 2500 },
      `      - id: private-read
        description: A read through a private API (refused) cannot verify anything
        mandatory: true
        check: { kind: value, source: api, api: { url: '/api/private/requests/\${extracted:requestId}' }, field: title, expected: { testData: request.title } }
`,
    );
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const byId = (report: QualityVerificationReport): Record<string, string> =>
    Object.fromEntries(report.flows[0]?.assertions.map((entry) => [entry.id, entry.status]) ?? []);

  it('a correct creation passes every assertion with run values, and the requirements are verified', () => {
    const flow = clean.result.flows[0];
    expect(flow?.status).toBe('PASSED');
    expect(byId(clean.quality)).toEqual({
      'request-created': 'PASS',
      'title-saved': 'PASS',
      'title-read-back': 'PASS',
      'request-owner': 'PASS',
      'single-request': 'PASS',
      'request-open': 'PASS',
    });
    expect(clean.quality.verdict).toBe('PASS');
    const requirements = Object.fromEntries(
      clean.quality.traceability.requirements.map((entry) => [entry.id, entry.status]),
    );
    expect(requirements).toEqual({
      'REQ-REQUEST-CREATE': 'VERIFIED_PASS',
      'REQ-REQUEST-SEARCH': 'VERIFIED_PASS',
      'REQ-REQUEST-EXPORT': 'NOT_COVERED',
    });
    // L'identifiant de la création est relié à la lecture d'API (preuve API, run et assertion corrélés).
    const readBack = clean.quality.flows[0]?.assertions.find((entry) => entry.id === 'title-read-back');
    expect(readBack?.source).toBe('API');
    const evidence = clean.quality.evidence.find((entry) => entry.id === readBack?.evidence[0]);
    expect(evidence).toMatchObject({
      sourceType: 'API',
      assertionId: 'title-read-back',
      flow: 'create-request',
    });
    expect(clean.result.workflowAnalysis?.overallStatus).not.toBe('FAIL');
    expect(clean.result.workflowAnalysis?.overallStatus).not.toBe('INCONCLUSIVE');
  });

  it('data consistency follows the run value from the input to the request, the response and the screen', () => {
    const rules = Object.fromEntries(
      (clean.quality.flows[0]?.consistency ?? []).map((entry) => [entry.rule, entry.status]),
    );
    expect(rules).toMatchObject({
      UI_TO_REQUEST: 'CONSISTENT',
      REQUEST_TO_RESPONSE: 'CONSISTENT',
      RESPONSE_TO_UI: 'CONSISTENT',
      SIDE_EFFECT: 'CONSISTENT',
    });
    expect(clean.quality.metrics).toMatchObject({
      assertionsDeclared: 6,
      assertionsExecuted: 6,
      missingEvidence: 0,
    });
  });

  it('a 201 with the wrong title, a duplicate and a wrong owner fail the business assertions (a click is not a result)', () => {
    const statuses = byId(broken.quality);
    expect(statuses['request-created']).toBe('PASS');
    expect(statuses['title-saved']).toBe('FAIL');
    expect(statuses['title-read-back']).toBe('FAIL');
    expect(statuses['request-owner']).toBe('FAIL');
    expect(statuses['single-request']).toBe('FAIL');
    expect(broken.result.flows[0]?.status).toBe('FAILED');
    expect(broken.quality.verdict).toBe('FAIL');
    expect(broken.result.workflowAnalysis?.overallStatus).toBe('FAIL');
    expect(
      broken.result.issues.filter((issue) => issue.type === 'BUSINESS_ASSERTION').length,
    ).toBeGreaterThanOrEqual(4);
    const response = broken.quality.flows[0]?.consistency.find(
      (entry) => entry.rule === 'REQUEST_TO_RESPONSE',
    );
    expect(response).toMatchObject({ status: 'INCONSISTENT', declared: true });
    const side = broken.quality.flows[0]?.consistency.find((entry) => entry.rule === 'SIDE_EFFECT');
    expect(side?.status).toBe('CONSISTENT'); // une seule écriture côté navigateur : le doublon est côté serveur
    const create = broken.quality.traceability.requirements.find(
      (entry) => entry.id === 'REQ-REQUEST-CREATE',
    );
    expect(create?.status).toBe('VERIFIED_FAIL');
    expect(broken.quality.traceability.summary.criticalFailures).toEqual(['REQ-REQUEST-CREATE']);
  });

  it('an asynchronous state is polled until OPEN, and a refused read stays UNVERIFIABLE (the run is INCONCLUSIVE, never PASS)', () => {
    const open = pending.quality.flows[0]?.assertions.find((entry) => entry.id === 'request-open');
    expect(open?.status).toBe('PASS');
    expect(open?.attempts).toBeGreaterThan(1);
    expect(byId(pending.quality)['private-read']).toBe('UNVERIFIABLE');
    expect(pending.quality.verdict).toBe('UNVERIFIABLE');
    expect(pending.result.workflowAnalysis?.overallStatus).toBe('INCONCLUSIVE');
    expect(pending.result.workflowAnalysis?.statusReasons.join(' ')).toContain('could not be verified');
  });

  it('reports: JSON and HTML, history of the traceability, no run value in clear by default', async () => {
    const html = await readFile(path.join(clean.dir, 'index.html'), 'utf8');
    expect(html).toContain('Vérification métier');
    expect(html).toContain('REQ-REQUEST-CREATE');
    const title = clean.result.flows[0]?.testDataReport?.entries.find(
      (entry) => entry.key === 'request.title',
    )?.value;
    expect(title).toBeTruthy();
    const json = await readFile(path.join(clean.dir, 'quality-verification.json'), 'utf8');
    expect(json).not.toContain(title as string);
    const history = JSON.parse(
      await readFile(path.join(dir, 'knowledge', 'traceability-history.json'), 'utf8'),
    ) as { requirements: Record<string, { status: string }> };
    expect(Object.keys(history.requirements).sort()).toEqual(['REQ-REQUEST-CREATE', 'REQ-REQUEST-SEARCH']);
    const log = await readFile(path.join(clean.dir, 'engine-log.jsonl'), 'utf8').catch(() => '');
    if (log) expect(log).toContain('BUSINESS_ASSERTION_PASSED');
  });
});
