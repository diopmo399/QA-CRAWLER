import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunAnalysis } from '../../src/analysis/run-analysis.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * RUN ANALYSIS de bout en bout : le même flow, une fois contre une application saine (PROVEN), une
 * fois contre une application qui refuse la création (DIVERGED, première divergence à « Save »,
 * suite du parcours, recommandations), avec `run-analysis.json` et la section du rapport.
 */
describe('Run analysis — end to end', () => {
  let app: CompanyRecordingApp;
  let dir = '';
  const results: Record<string, ExplorationResult> = {};

  const run = async (name: string): Promise<ExplorationResult> => {
    const { config } = parseConfig(
      `mission: { name: analysis }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 4000, settleTimeMs: 200 }
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
    results[name] = result;
    return result;
  };

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-run-analysis-e2e-'));
    await writeFile(
      path.join(dir, 'test-data.yaml'),
      `values:\n  company:\n    name: { strategy: generated, generator: company }\n    address: { strategy: generated, generator: address }\n`,
    );
    await run('healthy');
    app.refuseCreate = true;
    await run('refused');
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  it('healthy application: PROVEN, the chain explains intent → observed → no divergence → verdict', async () => {
    const analysis = results.healthy?.runAnalysis;
    expect(analysis?.status).toBe('PROVEN');
    expect(analysis?.summary).toMatchObject({ flows: { total: 1, passed: 1 }, businessProof: { proven: 1 } });
    expect(analysis?.explainability.chain.map((link) => link.stage)).toEqual(
      expect.arrayContaining(['INTENT', 'OBSERVED', 'DIVERGENCE', 'VERDICT']),
    );
    expect(analysis?.executionTimeline.entries).toHaveLength(10);
    const file = JSON.parse(
      await readFile(path.join(dir, 'healthy', 'run-analysis.json'), 'utf8'),
    ) as RunAnalysis;
    expect(file.status).toBe('PROVEN');
    expect(results.healthy?.artifacts.runAnalysis).toBe(path.join(dir, 'healthy', 'run-analysis.json'));
  });

  it('application refusing the creation: DIVERGED at Save, the symptom and the continuation are explained', () => {
    const analysis = results.refused?.runAnalysis;
    expect(analysis?.status).toBe('DIVERGED');
    expect(analysis?.summary.flows.failed).toBe(1);
    // L'application navigue vers /tasks malgré le 422 : le symptôme est l'ouverture du résultat (étape 9) ;
    // le refus d'écriture de l'étape 4 est relevé comme signal antérieur et cause probable.
    expect(analysis?.firstDivergence?.step).toBe(9);
    expect(analysis?.firstDivergence?.earlierNetworkErrors.join('\n')).toMatch(
      /POST \/api\/companies → 422 at step 4/,
    );
    // La cause vient des moteurs (divergence analysée à l'étape 9) ; le 422 y figure comme preuve réseau.
    expect(
      analysis?.rootCause?.evidence.some(
        (entry) => entry.source === 'NETWORK' && entry.detail.includes('422'),
      ),
    ).toBe(true);
    expect(
      analysis?.networkAnalysis?.failures.some(
        (failure) => failure.path === '/api/companies' && failure.status === 422,
      ),
    ).toBe(true);
    expect(analysis?.explainability.chain.find((link) => link.stage === 'CONTINUATION')?.text).toMatch(
      /skipped/,
    );
    expect(analysis?.explainability.verdictReasons[0]).toContain('flow(s) failed');
    expect(analysis?.failures.length).toBeGreaterThan(0);
  });

  it('the report opens the detailed analysis with the run analysis section', async () => {
    const healthy = await readFile(path.join(dir, 'healthy', 'index.html'), 'utf8');
    expect(healthy).toContain('Analyse du run');
    expect(healthy).toContain('Objectif prouvé');
    expect(healthy).toContain('Chaîne causale');
    expect(healthy.indexOf('Analyse du run')).toBeLessThan(healthy.indexOf('Moteur de décision'));
    const refused = await readFile(path.join(dir, 'refused', 'index.html'), 'utf8');
    expect(refused).toContain('Divergé');
    expect(refused).toContain('Première divergence');
  });
});
