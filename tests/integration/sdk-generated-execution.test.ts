import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  type GenerationResult,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LES TESTS GÉNÉRÉS SONT EXÉCUTÉS, PAS SEULEMENT ÉCRITS : un parcours enregistré par le vrai recorder,
 * généré par le SDK, puis
 *   - le .feature joué par la mission générée à côté de lui (les définitions de steps : le moteur) ;
 *   - le test Playwright lancé par Playwright Test avec la configuration générée, qui écrit un
 *     rapport JUnit XML.
 * Java JUnit 5 + Playwright Java est exécuté par `mvn test` dans java-generated-tests.test.ts.
 */
const REPO = path.resolve('.');
const NAME = 'ouvrir-une-fiche';
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let generation: GenerationResult;
let generatedDir: string;

const human: NonNullable<RecordRequest['drive']> = async ({ page }) => {
  const pause = (): Promise<void> => page.waitForTimeout(500);
  await pause();
  await page.getByRole('link', { name: 'Utilisateurs' }).click();
  await page.waitForURL('**/users');
  await pause();
  await page.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await page.waitForURL('**/users/1');
  await pause();
  await page.getByRole('link', { name: 'Modifier' }).click();
  await page.waitForURL('**/users/1/edit');
  await pause();
};

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: '1' } });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, output });
    });
    child.on('error', (error) => {
      resolve({ code: null, output: error.message });
    });
  });
}

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-generated-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Site de démo', targetUrl: `${site.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
  await client.recordings.start(project.id, { name: 'Ouvrir une fiche' });
  await client.recordings.subscribe(project.id, NAME, () => undefined).done;
  generation = await client.generation.run(project.id, NAME, { formats: ['gherkin', 'playwright'] });
  generatedDir = path.join(workspace, project.id, 'qa-reports', 'recordings', NAME, 'generated');
}, 240_000);

afterAll(async () => {
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('generated tests, executed', () => {
  it('generates the .feature with the mission that plays it, and the Playwright test with its configuration', () => {
    const paths = generation.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `${NAME}.feature`,
        `${NAME}.gherkin.mission.yaml`,
        `playwright/${NAME}.spec.ts`,
        'playwright/playwright.config.ts',
      ]),
    );
    // Validée par le chargeur du moteur : la mission, son .feature et chaque phrase.
    expect(generation.files.find((file) => file.path.endsWith('.mission.yaml'))).toMatchObject({
      status: 'STATICALLY_VALIDATED',
    });
    // La génération ne prétend jamais avoir exécuté.
    expect(generation.files.every((file) => file.status !== 'PASSED' && file.status !== 'EXECUTED')).toBe(
      true,
    );
  });

  it('the .feature runs with the generated mission: every scenario passes on the application', async () => {
    const reports = await mkdtemp(path.join(tmpdir(), 'qa-gherkin-run-'));
    try {
      const { config } = await loadConfigFile(path.join(generatedDir, `${NAME}.gherkin.mission.yaml`), {
        reportsDir: reports,
        headless: true,
      });
      const { result } = await runMission(config, { env: {} });
      expect(result.flows.length).toBeGreaterThan(0);
      for (const flow of result.flows) {
        expect(flow.status).toBe('PASSED');
        expect(flow.steps.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(reports, { recursive: true, force: true });
    }
  }, 180_000);

  it('the Playwright test runs with Playwright Test and its generated configuration, and writes JUnit XML', async () => {
    const playwrightDir = path.join(generatedDir, 'playwright');
    // Comme dans un projet de l'équipe : @playwright/test installé à côté des tests.
    await symlink(path.join(REPO, 'node_modules'), path.join(playwrightDir, 'node_modules'), 'dir');
    const outcome = await run(
      process.execPath,
      [
        path.join(REPO, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--config',
        'playwright.config.ts',
      ],
      playwrightDir,
    );
    expect(outcome.output).toMatch(/1 passed/);
    expect(outcome.code).toBe(0);
    const junit = await readFile(path.join(playwrightDir, 'test-results', 'junit.xml'), 'utf8');
    expect(junit).toMatch(/<testsuites[^>]*tests="1"[^>]*failures="0"/);
  }, 180_000);
});
