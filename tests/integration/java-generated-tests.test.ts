import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import {
  defaultPlaywrightJavaVersion,
  generateJavaJUnitPlaywrightProject,
  writeJavaProject,
} from '../../src/platform/java-junit-playwright-generator.js';
import { startFlowApp, type FlowApp } from '../fixtures/flow-app.js';

/**
 * LE PROJET JAVA GÉNÉRÉ, POUR DE VRAI : généré des flows de l'application de test, compilé et
 * exécuté par Maven (JUnit 5 + Playwright Java) contre cette application. Le flow qui passe passe,
 * celui dont l'attente est fausse échoue avec ses preuves, celui qu'un test Java ne peut pas
 * rejouer est ignoré (jamais réussi). Ignoré quand Java ou Maven manquent : ils ne sont jamais
 * nécessaires à QA-CRAWLER lui-même.
 */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    try {
      const child = spawn(command, args, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('error', (error) => {
        resolve({ code: null, output: `${output}\n${error.message}` });
      });
      child.on('close', (code) => {
        resolve({ code, output });
      });
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
    }
  });
}

const toolchain = await Promise.all([run('java', ['-version'], {}), run('mvn', ['-v'], {})]);
const javaAvailable = toolchain.every((tool) => tool.code === 0);

const FLOWS = `
flows:
  - name: create a request
    description: the wizard opens and accepts a generated title
    startAt: /dossiers
    steps:
      - click: { role: link, name: Nouveau dossier }
      - expect: { text: Titre }
      - fill: { label: Titre, value: { testData: request.title } }
      - click: { role: button, name: Suivant }
      - screenshot: after-first-step
      - manual: check the layout of the second step
  - name: a step that fails
    startAt: /dossiers
    steps:
      - click: { role: link, name: Nouveau dossier }
      - expect: { text: Ce texte n'existe pas }
  - name: an interpreted sentence
    startAt: /dossiers
    steps:
      - auto: { sentence: ouvrir le premier dossier }
`;

describe.skipIf(!javaAvailable)(
  'Generated Java JUnit 5 + Playwright project — compiled and run by Maven',
  () => {
    let app: FlowApp;
    let directory: string;

    beforeAll(async () => {
      app = await startFlowApp();
      directory = await mkdtemp(path.join(tmpdir(), 'qa-java-'));
    });

    afterAll(async () => {
      await app.close();
    });

    it('generates without touching the application, then mvn test reports pass / failure / skipped as JUnit XML', async () => {
      const { config } = parseConfig(
        `
mission: { name: java generated tests }
target: { baseUrl: ${app.url} }
${FLOWS}`,
        {},
        {},
      );
      const requestsBefore = app.requests.length;
      const project = generateJavaJUnitPlaywrightProject(config.flows, [], {
        baseUrl: config.target.baseUrl,
        versions: { playwright: defaultPlaywrightJavaVersion() },
      });
      await writeJavaProject(project, directory);
      // Générer n'agit pas sur l'application : aucune requête de plus.
      expect(app.requests.length).toBe(requestsBefore);
      expect(project.tests.map((test) => [test.className, test.unsupported.length])).toEqual([
        ['CreateARequestTest', 0],
        ['AStepThatFailsTest', 0],
        ['AnInterpretedSentenceTest', 1],
      ]);

      const maven = await run('mvn', ['-q', '-B', 'test'], {
        cwd: directory,
        env: { ...process.env, QA_BASE_URL: app.url },
      });
      const tail = maven.output.split('\n').slice(-40).join('\n');
      // Un flow échoue : Maven sort en erreur, mais chaque classe a tourné et a son rapport Surefire.
      expect(maven.code, tail).toBe(1);
      const reports = path.join(directory, 'target', 'surefire-reports');
      const passed = await readFile(path.join(reports, 'TEST-qa.generated.CreateARequestTest.xml'), 'utf8');
      expect(passed, tail).toMatch(/<testsuite [^>]*tests="1" errors="0" skipped="0" failures="0"/);
      expect(passed).toContain('MANUAL: check the layout of the second step');
      const failed = await readFile(path.join(reports, 'TEST-qa.generated.AStepThatFailsTest.xml'), 'utf8');
      expect(failed, tail).toMatch(/<testsuite [^>]*tests="1" errors="0" skipped="0" failures="1"/);
      expect(failed).toContain('Locator expected to be visible');
      const skipped = await readFile(
        path.join(reports, 'TEST-qa.generated.AnInterpretedSentenceTest.xml'),
        'utf8',
      );
      expect(skipped, tail).toMatch(/<testsuite [^>]*tests="1" errors="0" skipped="1" failures="0"/);
      expect(skipped).toContain('unsupported by the generated Java test');
      // Les preuves : capture et contexte de l'échec, capture demandée par le flow.
      const evidence = path.join(directory, 'target', 'qa-evidence');
      await access(path.join(evidence, 'AStepThatFailsTest', 'aStepThatFails-failure.png'));
      const context = await readFile(
        path.join(evidence, 'AStepThatFailsTest', 'aStepThatFails-failure.txt'),
        'utf8',
      );
      expect(context).toContain('url: ');
      expect(context).toContain('Locator expected to be visible');
      await access(path.join(evidence, 'CreateARequestTest', 'after-first-step.png'));
      // C'est bien l'application de test que les tests Java ont pilotée (le lien du wizard a été suivi).
      expect(app.requests.filter((request) => request.includes('/dossiers/create')).length).toBeGreaterThan(
        0,
      );
      // Les dépendances déclarées sont celles vérifiées.
      const pom = await readFile(path.join(directory, 'pom.xml'), 'utf8');
      expect(pom).toContain(`<playwright.version>${defaultPlaywrightJavaVersion()}</playwright.version>`);
    }, 600_000);
  },
);

describe.skipIf(javaAvailable)('Generated Java project — toolchain absent', () => {
  it('is skipped here: Java and Maven are only needed to run the generated project, never by QA-CRAWLER', () => {
    expect(javaAvailable).toBe(false);
  });
});
