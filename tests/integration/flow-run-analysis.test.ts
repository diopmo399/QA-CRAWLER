import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * ANALYSE D'UN FLOW EXÉCUTÉ (`qa-crawler run`, flow imposé) : les données de test du run, la preuve
 * métier CREATE → SEARCH → OPEN, les données créées attribuées au flow, le réseau, le temps et la
 * résolution des cibles par étape, puis l'écart avec le run précédent au deuxième run.
 */
describe('Run report — analysis of an executed flow', () => {
  let app: CompanyRecordingApp;
  let dir = '';
  const results: ExplorationResult[] = [];

  const run = async (name: string): Promise<ExplorationResult> => {
    const { config } = parseConfig(
      `mission: { name: analysis }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
report: { failOnSeverity: NONE, language: fr }
output: { reportsDir: ${path.join(dir, name)}, screenshotsDir: ${path.join(dir, `${name}-shots`)} }
knowledge: { file: ${path.join(dir, 'knowledge.json')} }
flows:
  - name: create-and-find
    startAt: /
    testData: ${path.join(dir, 'test-data.yaml')}
    steps:
      - click: { role: button, name: New company }
        allow: MUTATION
      - fill: { label: Company name, value: { testData: company.name } }
      - fill: { label: Address, value: { testData: company.address } }
      - click: { role: button, name: Save }
        allow: MUTATION
      - expect: { url: /tasks }
      - click: { role: button, name: Tasks }
      - fill: { label: Search companies, value: { testData: company.name } }
      - click: { role: button, name: Search, exact: true }
        allow: MUTATION
      - click: { role: button, name: '\${testData:company.name}' }
      - expect: { url: /companies/ }
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    results.push(result);
    return result;
  };

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    app.rejectDuplicates = true;
    dir = await mkdtemp(path.join(tmpdir(), 'qa-run-analysis-'));
    await writeFile(
      path.join(dir, 'test-data.yaml'),
      `values:\n  company:\n    name: { strategy: generated, generator: company }\n    address: { strategy: generated, generator: address }\n`,
    );
    await run('first');
    await run('second');
  }, 240_000);

  afterAll(async () => {
    await app.close();
  });

  const first = (): ExplorationResult => results[0] as ExplorationResult;
  const flow = (result: ExplorationResult) => result.flows[0];

  it('1 — test data of the run: one generated value per key, produced at the creation, reused by the search and the OPEN click', () => {
    const report = flow(first());
    expect(report?.status).toBe('PASSED');
    const name = report?.testDataReport?.entries.find((entry) => entry.key === 'company.name');
    expect(name).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
      generator: 'company',
      sensitive: false,
      producedAt: 2,
    });
    expect(name?.value).toMatch(/QA-CRAWLER-/);
    expect(name?.usedBy).toEqual([
      { step: 2, how: 'INPUT' },
      { step: 7, how: 'INPUT' },
      { step: 9, how: 'CITATION' },
    ]);
    // La valeur créée dans l'application est bien celle du rapport.
    expect(app.names()).toContain(name?.value);
  });

  it('2 — business proof: CREATE (POST accepted) → SEARCH (same value sent) → OPEN (the result read) is PROVEN', () => {
    const proof = flow(first())?.businessProof;
    expect(proof).toMatchObject({ status: 'PROVEN', key: 'company.name' });
    expect(proof?.creation).toMatchObject({ step: 4, request: 'POST /api/companies → 204' });
    expect(proof?.search).toMatchObject({ step: 7 });
    expect(proof?.search?.request).toMatch(/^POST \/api\/companies\/search → 200/);
    expect(proof?.open).toMatchObject({ step: 9 });
    expect(proof?.open?.request).toMatch(/^GET \/api\/companies\/\d+ → 200/);
  });

  it('3 — data created: the flow’s mutations are counted (not on the autonomous budget) and its write attributed to its step', () => {
    const result = first();
    expect(result.mutations).toMatchObject({
      enabled: true,
      executed: 2,
      autonomous: 0,
      flows: 2,
      maxPerRun: 20,
    });
    expect(result.createdData).toHaveLength(1);
    expect(result.createdData?.[0]).toMatchObject({
      flow: 'create-and-find',
      step: 4,
      requests: [{ method: 'POST', status: 204 }],
    });
  });

  it('4 / 5 / 6 / 7 — per step: the network, how the target was found, the effects and where the time went', () => {
    const steps = flow(first())?.steps ?? [];
    const save = steps.find((step) => step.index === 4);
    expect(
      save?.network?.requests.map((request) => `${request.method} ${request.path} ${String(request.status)}`),
    ).toContain('POST /api/companies 204');
    expect(save?.network?.writes).toBe(1);
    const open = steps.find((step) => step.index === 9);
    expect(
      open?.network?.requests.some(
        (request) => request.method === 'GET' && /^\/api\/companies\/\d+$/.test(request.path),
      ),
    ).toBe(true);
    for (const step of steps.filter((candidate) => candidate.kind === 'click' || candidate.kind === 'fill')) {
      expect(step.timing?.totalMs).toBe(step.durationMs);
      expect(step.timing?.actionMs).toBeGreaterThanOrEqual(0);
    }
    // Chaque clic rapporte le localisateur réellement utilisé (la résolution des cibles).
    for (const step of steps.filter((candidate) => candidate.kind === 'click'))
      expect(step.effect?.locator, step.description).toBeDefined();
  });

  it('8 — the second run is compared with the first: SAME flow, and the knowledge base keeps the last run', async () => {
    expect(flow(first())?.comparison).toBeUndefined();
    const comparison = flow(results[1] as ExplorationResult)?.comparison;
    expect(comparison).toMatchObject({ verdict: 'SAME', changes: [] });
    expect(comparison?.previous).toMatchObject({ runId: first().runId, status: 'PASSED' });
    const knowledge = JSON.parse(await readFile(path.join(dir, 'knowledge.json'), 'utf8')) as {
      applications: Record<string, { flowRuns?: Record<string, { runId: string }> }>;
    };
    const memory = Object.values(knowledge.applications)[0]?.flowRuns?.['create-and-find'];
    expect(memory?.runId).toBe(results[1]?.runId);
  });

  it('the HTML report shows the seven analyses under the flow, with the generated value and the proof', async () => {
    const html = await readFile(path.join(dir, 'first', 'index.html'), 'utf8');
    for (const title of [
      'Données de test de ce run',
      'Preuve métier',
      'Réseau par étape',
      'Résolution des cibles',
      'Effets attendus / observés',
      'Temps par étape',
    ])
      expect(html).toContain(title);
    expect(html).toContain('PROVEN');
    expect(html).toContain('2 par les flows imposés');
    expect(html).toContain('create-and-find · 4');
    const second = await readFile(path.join(dir, 'second', 'index.html'), 'utf8');
    expect(second).toContain('Écart avec le run précédent');
    expect(second).toContain('Aucun changement notable depuis le run précédent.');
  });
});
