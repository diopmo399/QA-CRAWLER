import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Environment,
  type ExplorationSnapshot,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startLoopApp, type LoopApp } from '../fixtures/loop-app.js';
import { traceJourney, writeTraceBlocks } from '../fixtures/traceability-blocks.js';
import { keepTraceValues } from '../fixtures/trace-values.js';

/**
 * LA VUE « DONNÉES & TRAÇABILITÉ » DANS CHROMIUM, sur les traces d'une exécution RÉELLE : sans exécution, la
 * vue le dit et ne confirme rien ; après une exécution de simulation, le nom de société généré se retrouve
 * avec sa génération et toutes ses utilisations (même valeur, bons blocs et étapes) ; la fiche, la recherche dans les
 * données, les correspondances, le graphe, et la navigation de la chronologie vers les étapes du bloc.
 */
let app: LoopApp;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;
let browser: Browser;
let page: Page;
const SHOTS = process.env.QA_SHOTS_DIR;
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const shot = async (name: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function finished(started: ExplorationSnapshot): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the run did not finish in time'));
    }, 150_000);
    const subscription = client.explorations.subscribe(started.id, (event) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timer);
        subscription.close();
        resolve();
      }
    });
  });
}

beforeAll(async () => {
  app = await startLoopApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-trace-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'other' },
  });
  // La vue montre les valeurs : le projet les garde (testData.traceValues: true).
  await keepTraceValues(path.join(workspace, project.id));
  await writeTraceBlocks(await flowsDirOf(path.join(workspace, project.id)));
  environment = await client.environments.create(project.id, {
    name: 'Test',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 20 },
  });
  const blocks = await client.library.list(project.id);
  await client.journeys.save(project.id, traceJourney(blocks));
  await client.journeys.save(project.id, traceJourney(blocks, 'Never run'));
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="library"]').click();
  await dashboard().locator('h1', { hasText: 'Bibliothèque de scénarios' }).waitFor({ timeout: 15_000 });
}, 120_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

async function openJourney(name: string): Promise<Locator> {
  const composer = dashboard().locator('#lib-composer');
  const button = dashboard().locator('[data-action="jn-tab"][data-tab="composer"]');
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
  await composer.locator('select[data-jn="open"]').selectOption(name);
  await composer.locator('input[data-jn="name"]').waitFor();
  await expect.poll(() => composer.locator('input[data-jn="name"]').inputValue()).toBe(name);
  return composer;
}

describe('Dashboard — Data & Traceability view in Chromium', () => {
  it('without any run: says so, shows definitions, confirms nothing', async () => {
    const composer = await openJourney('Never run');
    await composer.locator('#jn-mode-TRACE').click();
    const view = composer.locator('.tc');
    await view
      .locator('.notice', { hasText: 'Aucune exécution réelle de ce parcours' })
      .waitFor({ timeout: 15_000 });
    await view.locator('.tc-var', { hasText: 'company.name' }).waitFor();
    expect(await view.locator('.tc-var .jn-chip', { hasText: 'Confirmée' }).count()).toBe(0);
    await view.locator('.tc-center', { hasText: 'Aucun événement observé' }).waitFor();
    // Le flux en haut : contrôle et données distingués.
    await view.locator('.tc-strip .tc-node', { hasText: 'Create company' }).waitFor();
    await view.locator('.tc-links li', { hasText: 'company.name' }).first().waitFor();
    await shot('trace-1-no-run');
  }, 60_000);

  it('after a real run: company.name generated once, every use with the same value, blocks and steps', async () => {
    const blocks = await client.library.list(project.id);
    const started = await client.journeys.simulate(project.id, traceJourney(blocks), {
      environmentId: environment.id,
    });
    await finished(started);
    const [company] = app.companies();
    const composer = await openJourney('Request traceability');
    await composer.locator('#jn-mode-TRACE').click();
    const view = composer.locator('.tc');
    await view.locator('.tc-var', { hasText: 'company.name' }).click({ timeout: 15_000 });
    await view.locator('.tc-c-h', { hasText: 'Traçabilité : company.name' }).waitFor();
    const events = view.locator('.tc-timeline .tc-ev');
    expect(await events.count()).toBe(4);
    expect((await events.nth(0).innerText()).replace(/\s+/g, ' ')).toMatch(
      new RegExp(`Génération.*Create company.*${company?.name ?? '?'}`),
    );
    const uses = await events.allInnerTexts();
    expect(uses.slice(1).map((text) => text.replace(/\s+/g, ' '))).toEqual([
      expect.stringMatching(
        new RegExp(`Utilisation · saisie.*Create company.*Étape \\d+.*${company?.name ?? '?'}`),
      ),
      expect.stringMatching(
        new RegExp(`Utilisation · saisie.*Create request.*Étape \\d+.*${company?.name ?? '?'}`),
      ),
      expect.stringMatching(
        new RegExp(`Utilisation · vérification.*Check request status.*Étape \\d+.*${company?.name ?? '?'}`),
      ),
    ]);
    // La fiche de la donnée : dans le panneau de droite, comme sur la maquette.
    const detail = dashboard().locator('.jn-side .tc-detail');
    await detail.locator('.tc-val', { hasText: company?.name ?? '?' }).waitFor();
    await detail.locator('summary', { hasText: 'Où est-elle utilisée ? (2)' }).waitFor();
    await detail.locator('.jn-chip.ok', { hasText: 'Confirmée' }).waitFor();
    await detail.locator('.tc-why', { hasText: 'même occurrence de valeur' }).waitFor();
    await shot('trace-2-timeline');

    // La recherche dans les données.
    await view.locator('input[data-jn="trace.query"]').fill('person');
    await expect.poll(() => view.locator('.tc-var').count()).toBe(4);
    await view.locator('input[data-jn="trace.query"]').fill('');
    // La vue graphe de la donnée, puis les onglets.
    await view.locator('.tc-var', { hasText: 'company.name' }).click();
    await view.locator('[data-action="jn-trace-center"][data-center="graph"]').click();
    await view.locator('.tc-vgraph .tc-col-in', { hasText: 'Check request status' }).waitFor();
    await view.locator('[data-action="jn-trace-tab"][data-tab="map"]').click();
    await view.locator('tr', { hasText: 'company.id' }).first().waitFor();
    await view.locator('.jn-chip', { hasText: 'Variable d’itération' }).first().waitFor();
    await view.locator('[data-action="jn-trace-tab"][data-tab="graph"]').click();
    await view.locator('svg.tc-svg .tc-arc').first().waitFor();
    await shot('trace-3-graph');
    await view.locator('[data-action="jn-trace-tab"][data-tab="vars"]').click();
    await view.locator('tr', { hasText: 'request.id' }).waitFor();
    // De la chronologie vers les étapes du bloc.
    await view.locator('[data-action="jn-trace-tab"][data-tab="trace"]').click();
    await view.locator('[data-action="jn-trace-center"][data-center="timeline"]').click();
    await view.locator('.tc-timeline .tc-ev').nth(2).locator('[data-action="lib-open"]').click();
    const sheet = dashboard().locator('.lib-fiche');
    await sheet.locator('h2, h3', { hasText: 'Create request' }).first().waitFor({ timeout: 15_000 });
    expect(await dashboard().locator('#lib-tab-steps').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Escape');
  }, 240_000);
});
