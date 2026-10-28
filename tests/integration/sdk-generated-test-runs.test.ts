import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
  type TestRunView,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LES TESTS GÉNÉRÉS, JOUÉS DEPUIS LE SDK : un parcours enregistré par le vrai recorder, généré dans
 * les quatre formats, puis exécuté par la route `test-runs` — le rejeu du moteur pour le YAML et le
 * .feature, Playwright Test pour le test TypeScript, `mvn test` pour Java (quand Java et Maven sont
 * là). Le verdict vient des cas rapportés par l'outil, jamais de la génération.
 */
const NAME = 'ouvrir-une-fiche';
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;

const javaAvailable =
  spawnSync('java', ['-version']).status === 0 && spawnSync('mvn', ['-v'], { shell: false }).status === 0;

const human: NonNullable<RecordRequest['drive']> = async ({ page }) => {
  const pause = (): Promise<void> => page.waitForTimeout(500);
  await pause();
  await page.getByRole('link', { name: 'Utilisateurs' }).click();
  await page.waitForURL('**/users');
  await pause();
  await page.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await page.waitForURL('**/users/1');
  await pause();
};

async function finished(run: TestRunView): Promise<TestRunView> {
  let current = run;
  const deadline = Date.now() + 240_000;
  while (current.status === 'QUEUED' || current.status === 'RUNNING') {
    if (Date.now() > deadline) throw new Error(`run ${run.id} still ${current.status}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    current = await client.generation.runOf(project.id, NAME, run.id);
  }
  return current;
}

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-test-runs-'));
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
}, 240_000);

afterAll(async () => {
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('generated tests, run from the SDK', () => {
  it('lists nothing to run before a generation, and refuses to run a format never generated', async () => {
    const view = await client.generation.view(project.id, NAME);
    expect(view.files).toEqual([]);
    expect(view.runs).toEqual([]);
    expect(view.runners.find((runner) => runner.format === 'yaml')).toMatchObject({
      kind: 'ENGINE',
      available: true,
    });
    await expect(client.generation.execute(project.id, NAME, { format: 'yaml' })).rejects.toMatchObject({
      status: 409,
      code: 'NOT_GENERATED',
    });
  });

  it('keeps every generated format in the view, one generation after another', async () => {
    await client.generation.run(project.id, NAME, { formats: ['yaml', 'gherkin'] });
    await client.generation.run(project.id, NAME, { formats: ['playwright'] });
    const view = await client.generation.view(project.id, NAME);
    const formats = new Set(view.files.map((file) => file.format));
    expect([...formats].sort()).toEqual(['gherkin', 'playwright', 'yaml']);
    expect(view.files.find((file) => file.path === `${NAME}.flow.yaml`)?.content).toContain('steps:');
    // La génération ne prétend jamais avoir exécuté.
    expect(view.files.every((file) => !['PASSED', 'FAILED', 'EXECUTED'].includes(file.status))).toBe(true);
  });

  it('replays the generated flow YAML with the engine and the project mission: PASSED, with its report', async () => {
    const started = await client.generation.execute(project.id, NAME, { format: 'yaml' });
    expect(['QUEUED', 'RUNNING']).toContain(started.status);
    expect(started.kind).toBe('ENGINE');
    const run = await finished(started);
    expect(run.status, run.output).toBe('PASSED');
    expect(run.cases.length).toBe(1);
    expect(run.cases[0]?.status).toBe('PASSED');
    expect(run.counts).toMatchObject({ passed: 1, failed: 0, total: 1 });
    expect(run.report).toBeDefined();
    const link = await client.generation.reportLink(project.id, NAME, run.id);
    const page = await fetch(link.url);
    expect(page.status).toBe(200);
  }, 240_000);

  it('plays the generated .feature with the engine: PASSED', async () => {
    const run = await finished(await client.generation.execute(project.id, NAME, { format: 'gherkin' }));
    expect(run.status, run.output).toBe('PASSED');
    expect(run.cases.length).toBeGreaterThan(0);
    expect(run.cases.every((entry) => entry.status === 'PASSED')).toBe(true);
  }, 240_000);

  it('runs the generated Playwright test with Playwright Test and reads its JUnit XML: PASSED', async () => {
    const run = await finished(await client.generation.execute(project.id, NAME, { format: 'playwright' }));
    expect(run.kind).toBe('EXTERNAL');
    expect(run.tool).toMatch(/^Playwright Test \d/);
    expect(run.target).toContain(new URL(site.url).host);
    expect(run.status, run.output).toBe('PASSED');
    expect(run.counts).toMatchObject({ passed: 1, failed: 0, total: 1 });
    // Exécutée sur une copie : le dossier generated/ reste celui de la génération.
    const recording = path.join(workspace, project.id, 'qa-reports', 'recordings', NAME);
    await expect(
      readFile(path.join(recording, 'generated', 'playwright', 'test-results', 'junit.xml')),
    ).rejects.toThrow();
    const persisted = JSON.parse(
      await readFile(path.join(recording, 'test-runs', run.id, 'run.json'), 'utf8'),
    ) as TestRunView;
    expect(persisted.status).toBe('PASSED');
  }, 240_000);

  it('edits the Playwright test by hand through the SDK: checked, run as edited (FAILED), protected, restored', async () => {
    const specPath = `playwright/${NAME}.spec.ts`;
    const file = (await client.generation.view(project.id, NAME)).files.find(
      (entry) => entry.path === specPath,
    );
    if (!file?.revision) throw new Error('no editable spec');
    expect(file.content).toContain('Utilisateur 1');
    // Une modification qui ne compile pas : refusée avec les raisons, rien n'est écrit.
    await expect(
      client.generation.editFile(project.id, NAME, {
        path: specPath,
        content: `${file.content}\nconst = ;\n`,
        revision: file.revision,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'REFUSED' });
    // Le test vise un lien qui n'existe pas : vérifié, enregistré, marqué.
    const edited = await client.generation.editFile(project.id, NAME, {
      path: specPath,
      content: file.content.replaceAll('Utilisateur 1', 'Utilisateur 999'),
      revision: file.revision,
    });
    expect(edited.status).toBe('STATICALLY_VALIDATED');
    expect(edited.editedAt).toBeDefined();
    // Partie d'une version dépassée : refusée.
    await expect(
      client.generation.editFile(project.id, NAME, {
        path: specPath,
        content: file.content,
        revision: file.revision,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'FILE_CHANGED' });
    // Playwright Test le joue tel que modifié, et le SDK le dit.
    const run = await finished(await client.generation.execute(project.id, NAME, { format: 'playwright' }));
    expect(run.status, run.output).toBe('FAILED');
    expect(run.edited).toEqual([specPath]);
    expect(run.counts).toMatchObject({ failed: 1, total: 1 });
    expect(run.cases[0]?.message).toMatch(/Error/);
    // Régénérer ne remplace pas une modification à la main sans le dire.
    await expect(client.generation.run(project.id, NAME, { formats: ['playwright'] })).rejects.toMatchObject({
      status: 409,
      code: 'MANUAL_EDITS',
      details: [specPath],
    });
    // Retour à la version générée : le test passe de nouveau.
    const restored = await client.generation.restoreFile(project.id, NAME, {
      path: specPath,
      revision: edited.revision ?? '',
    });
    expect(restored.editedAt).toBeUndefined();
    expect(restored.content).toBe(file.content);
    const again = await finished(await client.generation.execute(project.id, NAME, { format: 'playwright' }));
    expect(again.status, again.output).toBe('PASSED');
    expect(again.edited).toBeUndefined();
  }, 480_000);

  it('regenerates over a hand edit only when asked to, and the mark goes away', async () => {
    const yaml = `${NAME}.flow.yaml`;
    const file = (await client.generation.view(project.id, NAME)).files.find((entry) => entry.path === yaml);
    if (!file?.revision) throw new Error('no editable flow');
    await client.generation.editFile(project.id, NAME, {
      path: yaml,
      content: `${file.content}# relu à la main\n`,
      revision: file.revision,
    });
    const result = await client.generation.run(project.id, NAME, {
      formats: ['yaml'],
      overwriteManual: true,
    });
    expect(result.files.find((entry) => entry.path === yaml)?.content).not.toContain('# relu à la main');
    const after = (await client.generation.view(project.id, NAME)).files.find((entry) => entry.path === yaml);
    expect(after?.editedAt).toBeUndefined();
  });

  it('lists the runs, most recent first, and refuses to cancel a finished run', async () => {
    const view = await client.generation.view(project.id, NAME);
    expect(view.runs.length).toBeGreaterThanOrEqual(3);
    expect(view.runs.map((run) => run.queuedAt)).toEqual(
      [...view.runs.map((run) => run.queuedAt)].sort().reverse(),
    );
    const last = view.runs[0];
    if (!last) throw new Error('no run');
    const refused = await client.generation
      .cancel(project.id, NAME, last.id)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QaCrawlerError);
    expect((refused as QaCrawlerError).status).toBe(409);
  });

  it('cancels a running replay: CANCELLED, never PASSED', async () => {
    const started = await client.generation.execute(project.id, NAME, { format: 'yaml' });
    await client.generation.cancel(project.id, NAME, started.id);
    const run = await finished(started);
    expect(run.status).toBe('CANCELLED');
  }, 240_000);

  it('refuses an environment for a Playwright run (it targets the URL it was generated for)', async () => {
    await expect(
      client.generation.execute(project.id, NAME, { format: 'playwright', environmentId: 'env_x' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  describe.skipIf(!javaAvailable)('Java (JUnit 5 + Playwright Java) with Maven', () => {
    it('runs mvn test on the generated project and reads the Surefire reports', async () => {
      await client.generation.run(project.id, NAME, { formats: ['java'] });
      const run = await finished(await client.generation.execute(project.id, NAME, { format: 'java' }));
      expect(run.kind).toBe('EXTERNAL');
      expect(run.tool).toMatch(/^Apache Maven/);
      // Sans accès au dépôt Maven, `mvn` ne peut pas résoudre ses dépendances : ERROR, jamais PASSED.
      expect(['PASSED', 'ERROR'], run.output).toContain(run.status);
      if (run.status === 'PASSED') expect(run.counts.total).toBeGreaterThan(0);
    }, 600_000);
  });
});
