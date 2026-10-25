import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startFlowApp, type FlowApp } from '../fixtures/flow-app.js';

/**
 * JUNIT XML de bout en bout (`runMission`) : activé, le fichier reflète les flows et les anomalies
 * du run, à côté des rapports habituels ; désactivé (le défaut), rien ne change ; une erreur
 * d'écriture n'interrompt pas le run, sauf `required`.
 */
describe('JUnit XML report — end to end', () => {
  let app: FlowApp;
  let outputDir: string;

  beforeAll(async () => {
    app = await startFlowApp();
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-junit-'));
  });

  afterAll(async () => {
    await app.close();
  });

  const FLOWS = `
flows:
  - name: open the wizard
    startAt: /dossiers
    steps:
      - click: { role: link, name: Nouveau dossier }
      - expect: { text: Titre }
  - name: a step that fails
    startAt: /dossiers
    steps:
      - click: { role: link, name: Nouveau dossier }
      - expect: { text: Ce texte n'existe pas }
`;

  async function run(
    name: string,
    report: string,
  ): Promise<{ result: ExplorationResult; reportsDir: string; warnings: string[] }> {
    const reportsDir = path.join(outputDir, name, 'reports');
    const { config } = parseConfig(
      `
mission: { name: ${name} }
target: { baseUrl: ${app.url} }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
output: { reportsDir: ${reportsDir}, screenshotsDir: ${path.join(outputDir, name, 'shots')} }
${report}
${FLOWS}`,
      {},
      {},
    );
    const warnings: string[] = [];
    const { result } = await runMission(config, { env: {}, onWarning: (message) => warnings.push(message) });
    return { result, reportsDir, warnings };
  }

  it('writes junit.xml with a suite per flow and a failure for the failed step, next to the usual reports', async () => {
    const { result, reportsDir } = await run('enabled', 'report: { junit: { enabled: true } }');
    expect(result.flows.map((flow) => flow.status)).toEqual(['PASSED', 'FAILED']);
    const file = path.join(reportsDir, 'junit.xml');
    expect(result.artifacts.junit).toBe(file);
    const xml = await readFile(file, 'utf8');
    expect(xml).toContain('<testsuite name="open the wizard" tests="2" failures="0" errors="0" skipped="0"');
    expect(xml).toContain('<testsuite name="a step that fails" tests="2" failures="1"');
    expect(xml).toMatch(/<failure message="[^"]*" type="FAILED">/);
    // Les rapports QA-CRAWLER sont toujours là.
    await access(path.join(reportsDir, 'result.json'));
    await access(path.join(reportsDir, 'index.html'));
    // result.json est écrit AVANT junit.xml (les rapports QA-CRAWLER d'abord, inchangés) : son contenu
    // est celui d'avant ; le chemin du JUnit est porté par le résultat renvoyé et la sortie de la CLI.
    const json = JSON.parse(
      await readFile(path.join(reportsDir, 'result.json'), 'utf8'),
    ) as ExplorationResult;
    expect(json.flows.map((flow) => flow.status)).toEqual(['PASSED', 'FAILED']);
    expect(json.artifacts.junit).toBeUndefined();
  });

  it('without report.junit nothing changes: no file, no artifact', async () => {
    const { result, reportsDir } = await run('disabled', '');
    expect(result.artifacts.junit).toBeUndefined();
    await expect(access(path.join(reportsDir, 'junit.xml'))).rejects.toThrow();
    await access(path.join(reportsDir, 'result.json'));
  });

  it('a write error is a warning, the run and its reports complete; required makes it fail', async () => {
    // Le parent du fichier demandé est un fichier, pas un dossier : l'écriture échoue.
    await writeFile(path.join(outputDir, 'occupied.txt'), 'x');
    const target = path.join(outputDir, 'occupied.txt', 'junit.xml');
    const occupied = await run('occupied', `report: { junit: { enabled: true, file: ${target} } }`);
    expect(occupied.result.artifacts.junit).toBeUndefined();
    expect(occupied.warnings.some((message) => message.startsWith('JUnit report not written:'))).toBe(true);
    await access(path.join(occupied.reportsDir, 'index.html'));
    await access(path.join(occupied.reportsDir, 'result.json'));
    await expect(
      run('required', `report: { junit: { enabled: true, required: true, file: ${target} } }`),
    ).rejects.toThrow(/JUnit report not written \(report.junit.required\)/);
  });

  it('a failure of the test generators (Playwright specs, Java project) is a warning: the run and its reports complete', async () => {
    // Les dossiers de sortie des générateurs sont occupés par des fichiers : leur écriture échoue.
    const reportsDir = path.join(outputDir, 'generators', 'reports');
    await mkdir(reportsDir, { recursive: true });
    await writeFile(path.join(reportsDir, 'generated-tests'), 'occupied');
    await writeFile(path.join(reportsDir, 'generated-tests-java'), 'occupied');
    const { result, warnings } = await run(
      'generators',
      'platform: { generatedTests: { enabled: true, java: { enabled: true } } }',
    );
    expect(result.flows.map((flow) => flow.status)).toEqual(['PASSED', 'FAILED']);
    expect(warnings.some((message) => message.startsWith('Playwright tests not generated:'))).toBe(true);
    expect(warnings.some((message) => message.startsWith('Java tests not generated:'))).toBe(true);
    await access(path.join(reportsDir, 'result.json'));
    await access(path.join(reportsDir, 'index.html'));
  });

  it('with the generators enabled and writable, both products exist next to the reports; by default neither', async () => {
    const generated = await run(
      'generated',
      'platform: { generatedTests: { enabled: true, java: { enabled: true } } }',
    );
    await access(path.join(generated.reportsDir, 'generated-tests', 'open-the-wizard.spec.ts'));
    await access(path.join(generated.reportsDir, 'generated-tests-java', 'pom.xml'));
    await access(
      path.join(
        generated.reportsDir,
        'generated-tests-java',
        'src',
        'test',
        'java',
        'qa',
        'generated',
        'OpenTheWizardTest.java',
      ),
    );
    const summary = JSON.parse(
      await readFile(path.join(generated.reportsDir, 'generated-java-tests.json'), 'utf8'),
    ) as {
      tests: { className: string; steps: number }[];
    };
    expect(summary.tests.map((test) => test.className)).toEqual(['OpenTheWizardTest', 'AStepThatFailsTest']);
    expect(generated.warnings).toEqual([]);
    const plain = await run('plain', '');
    await expect(access(path.join(plain.reportsDir, 'generated-tests'))).rejects.toThrow();
    await expect(access(path.join(plain.reportsDir, 'generated-tests-java'))).rejects.toThrow();
  });
});
