import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
  type RunLogEvent,
  type TestRunInput,
  type TestRunView,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LE NAVIGATEUR VISIBLE : un Dry Run ou un rejeu lancé depuis le Dashboard peut se jouer dans un
 * navigateur visible, sur la machine du serveur. Sans écran, la demande est refusée (409 NO_DISPLAY) ;
 * avec un écran (ici Xvfb, un écran X virtuel), le vrai moteur, Playwright Test et Maven ouvrent un
 * Chromium SANS `--headless` : les programmes en cours sur la machine (`ps`) le montrent pendant l'exécution.
 */
const NAME = 'ouvrir-une-fiche';
const exec = promisify(execFile);
const XVFB = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'].find((file) => existsSync(file));
const javaAvailable = spawnSync('java', ['-version']).status === 0 && spawnSync('mvn', ['-v']).status === 0;

let site: TestSite;
let workspace: string;
let blind: RunningSdkServer;
let screen: RunningSdkServer | undefined;
let xvfb: ChildProcess | undefined;
let previousDisplay: string | undefined;
let project: Project;

const human: NonNullable<RecordRequest['drive']> = async ({ page }) => {
  await page.waitForTimeout(400);
  await page.getByRole('link', { name: 'Utilisateurs' }).click();
  await page.waitForURL('**/users');
  await page.waitForTimeout(400);
  await page.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await page.waitForURL('**/users/1');
  await page.waitForTimeout(400);
};

const clientOf = (server: RunningSdkServer): QaCrawlerClient =>
  createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });

/** Les Chromium lancés sur la machine (le programme principal, sans ses auxiliaires), à cet instant. */
async function chromiumProcesses(): Promise<string[]> {
  const { stdout } = await exec('ps', ['-eo', 'args=']);
  return stdout
    .split('\n')
    .filter(
      (line) => /chrom/i.test(line) && line.includes('--remote-debugging-pipe') && !line.includes('--type='),
    );
}

/** Joue une exécution en relevant les Chromium lancés pendant qu'elle tourne. */
async function playWatching(
  client: QaCrawlerClient,
  input: TestRunInput,
): Promise<{ run: TestRunView; events: RunLogEvent[]; browsers: string[] }> {
  const browsers = new Set<string>();
  const stop = new AbortController();
  const sampler = (async () => {
    while (!stop.signal.aborted) {
      for (const line of await chromiumProcesses().catch(() => [])) browsers.add(line);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();
  const started = await client.generation.execute(project.id, NAME, input);
  const events: RunLogEvent[] = [];
  await client.generation.runEvents(project.id, NAME, started.id, (event) => events.push(event)).done;
  stop.abort();
  await sampler;
  const run = await client.generation.runOf(project.id, NAME, started.id);
  return { run, events, browsers: [...browsers] };
}

const refusal = async (promise: Promise<unknown>): Promise<{ status?: number; code?: string }> => {
  try {
    await promise;
    return {};
  } catch (error) {
    if (error instanceof QaCrawlerError) return { status: error.status, code: error.code };
    throw error;
  }
};

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-visible-'));
  // Un serveur sans écran : ni DISPLAY ni WAYLAND_DISPLAY.
  blind = await startSdkServer({
    workspace,
    language: 'fr',
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  const client = clientOf(blind);
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Fiches', targetUrl: `${site.url}/`, framework: 'other' },
  });
  await client.recordings.start(project.id, { name: 'Ouvrir une fiche' });
  await client.recordings.subscribe(project.id, NAME, () => undefined).done;
  await client.generation.run(project.id, NAME, {
    formats: ['yaml', 'playwright', ...(javaAvailable ? (['java'] as const) : [])],
  });
  client.dispose();
  if (!XVFB) return;
  // Un écran X virtuel, puis un serveur qui le voit (le moteur, qui tourne ici, et ses outils).
  const display = `:${String(90 + (process.pid % 9))}`;
  xvfb = spawn(XVFB, [display, '-screen', '0', '1366x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = display;
  screen = await startSdkServer({ workspace, language: 'fr' });
}, 300_000);

afterAll(async () => {
  await screen?.close();
  await blind.close();
  xvfb?.kill();
  if (previousDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = previousDisplay;
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('a visible browser for the runs started from the Dashboard', () => {
  it('without a screen: the capability says so, every visible run is refused (409 NO_DISPLAY), nothing starts', async () => {
    const client = clientOf(blind);
    expect((await client.capabilities()).visibleBrowser).toBe(process.platform !== 'linux');
    if (process.platform !== 'linux') return;
    const before = (await client.generation.view(project.id, NAME)).runs.length;
    const view = await client.generation.view(project.id, NAME);
    const yaml = view.files.find((file) => file.path.endsWith('.flow.yaml'));
    for (const input of [
      { format: 'yaml', headed: true },
      { format: 'yaml', mode: 'DRY_RUN', path: yaml?.path ?? '', headed: true },
      { format: 'playwright', headed: true, slowMoMs: 250 },
    ] as TestRunInput[])
      expect(await refusal(client.generation.execute(project.id, NAME, input))).toEqual({
        status: 409,
        code: 'NO_DISPLAY',
      });
    expect(await refusal(client.explorations.start(project.id, { headed: true }))).toEqual({
      status: 409,
      code: 'NO_DISPLAY',
    });
    expect(await refusal(client.executions.start(project.id, { headed: true }))).toEqual({
      status: 409,
      code: 'NO_DISPLAY',
    });
    // Un ralenti hors bornes : refusé avant tout.
    expect(
      await refusal(
        client.generation.execute(project.id, NAME, { format: 'yaml', headed: true, slowMoMs: 5000 }),
      ),
    ).toEqual({ status: 400, code: 'BAD_REQUEST' });
    expect((await client.generation.view(project.id, NAME)).runs.length).toBe(before);
    client.dispose();
  });

  it.skipIf(!XVFB)(
    'with a screen: the engine replays the flow YAML in a Chromium without --headless, slowed down',
    async () => {
      const client = clientOf(screen as RunningSdkServer);
      expect((await client.capabilities()).visibleBrowser).toBe(true);
      const { run, events, browsers } = await playWatching(client, {
        format: 'yaml',
        headed: true,
        slowMoMs: 250,
      });
      expect(run.status).toBe('PASSED');
      expect(run).toMatchObject({ headed: true, slowMoMs: 250 });
      expect(events.find((event) => event.type === 'RUN_CREATED')?.message).toContain('visible browser');
      expect(browsers.length).toBeGreaterThan(0);
      expect(browsers.some((line) => !line.includes('--headless'))).toBe(true);
      client.dispose();
    },
    240_000,
  );

  it.skipIf(!XVFB)(
    'with a screen: the Dry Run too',
    async () => {
      const client = clientOf(screen as RunningSdkServer);
      const yaml = (await client.generation.view(project.id, NAME)).files.find((file) =>
        file.path.endsWith('.flow.yaml'),
      );
      const { run, browsers } = await playWatching(client, {
        format: 'yaml',
        mode: 'DRY_RUN',
        path: yaml?.path ?? '',
        headed: true,
      });
      expect(run.status).toBe('PASSED');
      expect(run.headed).toBe(true);
      expect(browsers.some((line) => !line.includes('--headless'))).toBe(true);
      client.dispose();
    },
    240_000,
  );

  it.skipIf(!XVFB)(
    'with a screen: Playwright Test runs --headed; without the option, the browser stays hidden',
    async () => {
      const client = clientOf(screen as RunningSdkServer);
      const shown = await playWatching(client, { format: 'playwright', headed: true, slowMoMs: 250 });
      expect(shown.run.status).toBe('PASSED');
      expect(shown.browsers.some((line) => !line.includes('--headless'))).toBe(true);
      const hidden = await playWatching(client, { format: 'playwright' });
      expect(hidden.run.status).toBe('PASSED');
      expect(hidden.run.headed).toBeUndefined();
      expect(hidden.browsers.length).toBeGreaterThan(0);
      expect(hidden.browsers.every((line) => line.includes('--headless'))).toBe(true);
      client.dispose();
    },
    300_000,
  );

  it.skipIf(!XVFB)(
    'from the Dashboard editor: tick « Navigateur visible », choose the slow motion, Rejouer',
    async () => {
      const server = screen as RunningSdkServer;
      const client = clientOf(server);
      const before = (await client.generation.view(project.id, NAME)).runs.length;
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        const dash = page.locator('qa-crawler-dashboard');
        await page.goto(`${server.url}/dashboard`);
        await dash.locator('select[data-action="project-context"]').selectOption(project.id);
        await dash.locator('.drawer [data-action="nav"][data-view="editor"]').click();
        await dash.locator('.ed-tree').waitFor({ timeout: 30_000 });
        await dash.locator('[data-ed="headed"]').check();
        await dash.locator('[data-ed="slow-mo"]').selectOption('250');
        const seen = new Set<string>();
        const stop = new AbortController();
        const sampler = (async () => {
          while (!stop.signal.aborted) {
            for (const line of await chromiumProcesses().catch(() => [])) seen.add(line);
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        })();
        await dash.locator('.ed-top [data-action="ed-run"]').click();
        await dash.locator('.ed-note', { hasText: 'Terminé' }).waitFor({ timeout: 180_000 });
        stop.abort();
        await sampler;
        const runs = (await client.generation.view(project.id, NAME)).runs;
        expect(runs.length).toBe(before + 1);
        expect(runs[0]).toMatchObject({ status: 'PASSED', headed: true, slowMoMs: 250 });
        // Le Chromium de ce test est sans fenêtre ; celui du rejeu, lui, est visible.
        expect([...seen].some((line) => !line.includes('--headless'))).toBe(true);
        expect(await dash.locator('select[data-ed="con-run"]').textContent()).toContain('navigateur visible');
      } finally {
        await browser.close();
        client.dispose();
      }
    },
    240_000,
  );

  it.skipIf(!XVFB)(
    'a journey composed in the library: Rejouer with « Navigateur visible », from the library and from Scénarios',
    async () => {
      const server = screen as RunningSdkServer;
      const client = clientOf(server);
      // Un bloc tiré de l'enregistrement (toutes ses actions), publié dans la bibliothèque.
      const steps = (await client.recordings.studio(project.id, NAME)).steps;
      await client.groups.edit(project.id, NAME, {
        op: 'create',
        name: 'Ouvrir la fiche',
        stepIds: steps.filter((step) => step.kind !== 'expect').map((step) => step.id),
      });
      const groupId =
        (await client.groups.list(project.id, NAME)).find((group) => group.name === 'Ouvrir la fiche')?.id ??
        '';
      await client.library.publishExtraction(project.id, NAME, {
        selection: [{ groupId }],
        mode: 'separate',
        navigate: true,
      });
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        const dash = page.locator('qa-crawler-dashboard');
        await page.goto(`${server.url}/dashboard`);
        await dash.locator('select[data-action="project-context"]').selectOption(project.id);
        await dash.locator('.drawer [data-action="nav"][data-view="library"]').click();
        // Composer le parcours dans la bibliothèque, puis le rejouer d'ici, navigateur visible et ralenti.
        await dash.locator('[data-action="lib-part-add"][data-block="Ouvrir la fiche"]').first().click();
        await dash.locator('input[data-lib="compose.name"]').fill('Fiche visible');
        await dash.locator('[data-action="lib-check"]').click();
        await dash.locator('.lib-check.ok').waitFor({ timeout: 30_000 });
        await dash.locator('form[data-action="lib-compose"] button[type="submit"]').click();
        const replay = dash.locator('.lib-replay');
        await replay.waitFor({ timeout: 30_000 });
        await replay.locator('[data-bind="headed"]').check();
        await replay.locator('[data-bind="slow-mo"]').selectOption('250');
        const watch = async (start: () => Promise<void>): Promise<string[]> => {
          const before = (await client.executions.list(project.id)).length;
          const seen = new Set<string>();
          const stop = new AbortController();
          const sampler = (async () => {
            while (!stop.signal.aborted) {
              for (const line of await chromiumProcesses().catch(() => [])) seen.add(line);
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
          })();
          await start();
          // Jusqu'à la fin du rejeu : l'exécution est listée dès son départ, ses flows à sa fin.
          await expect
            .poll(
              async () => {
                const runs = await client.executions.list(project.id);
                return runs.length > before ? (runs[0]?.flows.total ?? 0) : 0;
              },
              { timeout: 180_000, interval: 1000 },
            )
            .toBe(1);
          stop.abort();
          await sampler;
          return [...seen];
        };
        const fromLibrary = await watch(() => replay.locator('[data-action="replay-scenario"]').click());
        // Le Chromium de ce test est sans fenêtre ; celui du rejeu, lui, est visible.
        expect(fromLibrary.some((line) => !line.includes('--headless'))).toBe(true);
        const [last] = await client.executions.list(project.id);
        expect(last?.scenarios).toEqual(['Fiche visible']);
        expect(last?.flows).toMatchObject({ total: 1, passed: 1, failed: 0 });
        // Depuis Scénarios, le même choix est à côté de « Rejouer ».
        await dash.locator('.drawer [data-action="nav"][data-view="scenarios"]').click();
        await dash.locator('[data-action="pick-scenario"][data-name="Fiche visible"]').first().click();
        const box = dash.locator('aside [data-bind="headed"]');
        await box.waitFor({ timeout: 15_000 });
        expect(await box.isChecked()).toBe(true);
        const fromScenarios = await watch(() =>
          dash.locator('[data-action="replay-scenario"][data-name="Fiche visible"]').click(),
        );
        expect(fromScenarios.some((line) => !line.includes('--headless'))).toBe(true);
      } finally {
        await browser.close();
        client.dispose();
      }
    },
    420_000,
  );

  it.skipIf(!XVFB || !javaAvailable)(
    'with a screen: the Java test (Maven) gets QA_HEADLESS=false',
    async () => {
      const client = clientOf(screen as RunningSdkServer);
      const { run, browsers } = await playWatching(client, { format: 'java', headed: true });
      expect(run.status).toBe('PASSED');
      expect(browsers.some((line) => !line.includes('--headless'))).toBe(true);
      client.dispose();
    },
    600_000,
  );
});
