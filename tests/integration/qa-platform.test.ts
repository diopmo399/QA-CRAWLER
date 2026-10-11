import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import type { ApiAnalysis } from '../../src/platform/api-testing.js';
import { runExplorationJobs } from '../../src/platform/exploration-jobs.js';
import type { RegressionAnalysis } from '../../src/platform/regression-analysis.js';
import type { ReproductionAnalysis } from '../../src/platform/reproduction-planner.js';
import type { VisualAnalysis } from '../../src/platform/visual-analysis.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';
import { startFlowApp, type FlowApp } from '../fixtures/flow-app.js';

/**
 * QA PLATFORM de bout en bout : le même flow contre une application saine (deux fois : baseline
 * visuelle puis comparaison, historique de performance, mémoire des flows), puis contre une
 * application qui refuse la création (FAIL, anomalie catégorisée, régression historique,
 * reproduction minimale, régression visuelle sur l'étape fautive). Tests d'API tirés d'un contrat
 * OpenAPI dans la session du run, tests Playwright générés, jobs parallèles isolés, session
 * réutilisée d'un run à l'autre.
 */
const CONTRACT = {
  openapi: '3.0.0',
  paths: {
    '/api/companies': { post: { responses: { default: { description: 'any' } } } },
    '/api/companies/search': { post: { responses: { '200': { description: 'ok' } } } },
    '/api/companies/{id}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'companyName'],
                  properties: { id: { type: 'string' }, companyName: { type: 'string' } },
                },
              },
            },
          },
          '404': { description: 'missing' },
        },
      },
    },
    '/api/notifications/count': { get: { responses: { '200': { description: 'ok' } } } },
  },
};

const ext = (result: ExplorationResult | undefined, key: string): unknown =>
  result?.workflowAnalysis?.extensionFiles?.[key]?.data;

describe('QA platform — end to end', () => {
  let app: CompanyRecordingApp;
  let dir = '';
  const results: Record<string, ExplorationResult> = {};

  const mission = (name: string): string => `mission: { name: platform }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 4000, settleTimeMs: 200 }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
report: { failOnSeverity: NONE, language: fr }
output: { reportsDir: ${path.join(dir, name)}, screenshotsDir: ${path.join(dir, `${name}-shots`)} }
knowledge: { file: ${path.join(dir, 'knowledge.json')} }
baseline: { dir: ${path.join(dir, 'baseline')} }
persistence: { enabled: true, provider: file, file: { directory: ${path.join(dir, 'memory')} } }
openapi: { enabled: true, source: ${path.join(dir, 'contract.json')} }
apiTesting: { enabled: true }
visual: { enabled: true }
platform: { generatedTests: { enabled: true } }
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
`;

  const run = async (name: string): Promise<ExplorationResult> => {
    const { config } = parseConfig(mission(name), {}, {});
    const { result } = await runMission(config, { env: {} });
    results[name] = result;
    return result;
  };

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-platform-e2e-'));
    await writeFile(
      path.join(dir, 'test-data.yaml'),
      `values:\n  company:\n    name: { strategy: generated, generator: company }\n    address: { strategy: generated, generator: address }\n`,
    );
    await writeFile(path.join(dir, 'contract.json'), JSON.stringify(CONTRACT));
    await run('first');
    await run('second');
    app.refuseCreate = true;
    await run('refused');
  }, 600_000);

  afterAll(async () => {
    await app.close();
  });

  it('a healthy run: PASS, every artifact written, API tests from the contract in the run session, visual baseline recorded', async () => {
    const result = results.first;
    const analysis = result?.workflowAnalysis;
    expect(['PASS', 'PASS_WITH_WARNINGS']).toContain(analysis?.overallStatus);
    expect(analysis?.verdict).toBe('PROVEN');
    for (const file of [
      'run.json',
      'anomalies.json',
      'workflow-graph.json',
      'functional-coverage.json',
      'api-analysis.json',
      'performance-analysis.json',
      'regression-analysis.json',
      'reproductions.json',
      'visual-analysis.json',
      'generated-tests.json',
      'advisor.json',
    ])
      expect((await stat(path.join(dir, 'first', file))).size, file).toBeGreaterThan(0);
    expect(result?.artifacts.workflowAnalysis?.run).toBe(path.join(dir, 'first', 'run.json'));
    const api = ext(result, 'apiAnalysis') as ApiAnalysis | undefined;
    expect(api?.contract?.model.tests.map((test) => test.operation)).toEqual(
      expect.arrayContaining(['GET /api/companies/{id}', 'GET /api/notifications/count']),
    );
    const detail = api?.contract?.results.find((entry) => entry.test.operation === 'GET /api/companies/{id}');
    expect(detail).toMatchObject({ verdict: 'PASS', status: 200, test: { source: 'OBSERVED_PATH' } });
    expect(api?.contract?.model.untested.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining(['POST /api/companies', 'POST /api/companies/search']),
    );
    expect(api?.correlation.summary.CONSISTENT).toBeGreaterThan(0);
    const visual = ext(result, 'visualAnalysis') as VisualAnalysis | undefined;
    expect(visual?.summary.NEW_BASELINE).toBeGreaterThan(0);
    expect(visual?.summary.VISUAL_REGRESSION).toBe(0);
    const generated = await readdir(path.join(dir, 'first', 'generated-tests'));
    expect(generated).toEqual(['create-and-find.spec.ts']);
    const spec = await readFile(
      path.join(dir, 'first', 'generated-tests', 'create-and-find.spec.ts'),
      'utf8',
    );
    expect(spec).toContain(`getByRole("button", { name: "New company" })`);
    expect(spec).toContain(`getByLabel("Company name").fill(testData["company.name"])`);
    expect(analysis?.artifacts.flowMemory).toMatch(/record\(s\) in/);
    const html = await readFile(path.join(dir, 'first', 'index.html'), 'utf8');
    expect(html).toContain('Analyse du run de workflow');
    expect(html).toContain('Couverture fonctionnelle');
  });

  it('the second healthy run compares with the visual baseline and the performance history (no regression)', () => {
    const result = results.second;
    expect(['PASS', 'PASS_WITH_WARNINGS']).toContain(result?.workflowAnalysis?.overallStatus);
    const visual = ext(result, 'visualAnalysis') as VisualAnalysis | undefined;
    expect(visual?.summary.NEW_BASELINE).toBe(0);
    expect(visual?.summary.VISUAL_REGRESSION).toBe(0);
    expect(visual?.summary.VISUAL_MATCH).toBeGreaterThan(0);
    const performance = ext(result, 'performanceAnalysis') as { summary: Record<string, number> } | undefined;
    expect(performance?.summary.PERFORMANCE_REGRESSION).toBe(0);
    expect(performance?.summary.INSUFFICIENT_DATA).toBeGreaterThan(0);
  });

  it('the refused run: FAIL, categorised anomaly, historical regression, minimal reproduction, visual regression where the step failed', () => {
    const result = results.refused;
    const analysis = result?.workflowAnalysis;
    expect(analysis?.overallStatus).toBe('FAIL');
    expect(analysis?.path).toBe('DEEP');
    const defect = analysis?.anomalies.find(
      (anomaly) => anomaly.location.flow === 'create-and-find' && anomaly.severity === 'ERROR',
    );
    expect(defect).toBeDefined();
    expect(['UI_FAILURE', 'FUNCTIONAL_FAILURE', 'DATA_FAILURE']).toContain(defect?.category);
    expect(defect?.location.step).toBe(9);
    expect(defect?.evidence.join('\n')).toMatch(/422/);
    const regression = ext(result, 'regressionAnalysis') as RegressionAnalysis | undefined;
    expect(regression?.entries.find((entry) => entry.anomalyId === defect?.id)).toMatchObject({
      status: 'NEW_REGRESSION',
      source: 'HISTORICAL',
    });
    expect(analysis?.statusReasons.join(' ')).toMatch(/blocking defect|new regression/);
    const reproductions = ext(result, 'reproductions') as ReproductionAnalysis | undefined;
    const artifact = reproductions?.artifacts.find((entry) => entry.anomalyId === defect?.id);
    expect(artifact?.status).toBe('NOT_VERIFIED');
    expect(artifact?.path?.steps).toContain(9);
    expect(artifact?.path?.steps.length).toBeLessThan(10);
    expect(artifact?.flowYaml).toContain('name: repro-anomaly-');
    expect(artifact?.flowYaml).toContain('testData: company.name');
    expect(artifact?.testDataKeys).toEqual(expect.arrayContaining(['company.name']));
    const visual = ext(result, 'visualAnalysis') as VisualAnalysis | undefined;
    const failing = visual?.checkpoints.find((checkpoint) => checkpoint.step === 9);
    expect(failing?.verdict).toBe('VISUAL_REGRESSION');
    expect(failing?.anomalies).toContain(defect?.id);
    expect(failing?.baselineUpdated).toBe(false);
  });

  it('parallel exploration jobs run the same mission in isolated outputs', async () => {
    const { config } = parseConfig(mission('jobs'), {}, {});
    app.refuseCreate = false;
    const report = await runExplorationJobs(
      config,
      [
        { id: 'one', flows: ['create-and-find'] },
        { id: 'two', flows: ['create-and-find'] },
      ],
      { concurrency: 2, run: { env: {} } },
    );
    expect(report.jobs.map((job) => `${job.status}${job.error ? `: ${job.error}` : ''}`)).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);
    expect(report.jobs.map((job) => job.reportsDir)).toEqual([
      path.join(dir, 'jobs', 'one'),
      path.join(dir, 'jobs', 'two'),
    ]);
    for (const job of report.jobs)
      expect((await stat(path.join(job.reportsDir, 'run.json'))).size).toBeGreaterThan(0);
    expect(['PASS', 'PASS_WITH_WARNINGS']).toContain(report.overallStatus);
  }, 300_000);
});

describe('QA platform — reusable session across runs', () => {
  let app: FlowApp;
  let dir = '';

  beforeAll(async () => {
    app = await startFlowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-platform-session-'));
  });
  afterAll(async () => {
    await app.close();
  });

  it('the first run records the session, the second reuses it without logging in again', async () => {
    const sessionFile = path.join(dir, 'sessions', 'primary.json');
    const config = (name: string) =>
      parseConfig(
        `mission: { name: session }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, name)}, screenshotsDir: ${path.join(dir, `${name}-shots`)} }
auth:
  type: form
  loginUrl: /login
  usernameSelector: '#identifiant'
  passwordSelector: '#mdp'
  submitSelector: '#connexion'
  successSelector: '#message'
  usernameEnv: QA_FLOW_USER
  passwordEnv: QA_FLOW_PASSWORD
  session: { reuse: true, file: ${sessionFile}, maxAgeMinutes: 60 }
flows:
  - name: home
    steps:
      - expect: { url: / }
`,
        {},
        {},
      ).config;
    const env = { QA_FLOW_USER: 'qa', QA_FLOW_PASSWORD: 'S3cret-Flow!' };
    const first = await runMission(config('first'), { env });
    expect(first.result.authentication?.session?.status).toBe('SESSION_RECORD');
    expect((await stat(sessionFile)).size).toBeGreaterThan(0);
    const second = await runMission(config('second'), { env });
    expect(second.result.authentication?.session?.status).toBe('SESSION_REUSE');
    expect(second.result.flows[0]?.status).toBe('PASSED');
    const json = await readFile(path.join(dir, 'second', 'result.json'), 'utf8');
    expect(json).not.toContain('S3cret-Flow!');
    expect(json).toContain('SESSION_REUSE');
  }, 180_000);
});
