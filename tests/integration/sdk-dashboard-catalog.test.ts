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
import { keepTraceValues } from '../fixtures/trace-values.js';
import { traceJourney, writeTraceBlocks } from '../fixtures/traceability-blocks.js';

/**
 * LE CATALOGUE DE BLOCS ET LA FICHE DÉTAILLÉE, DANS CHROMIUM, sur une vraie bibliothèque et de vraies
 * exécutions : recherche, critères, tri, pagination, grille et liste ; la fiche à côté du catalogue (recherche
 * et page gardées), ses onglets, ses actions réelles (prévisualiser, éditer, dupliquer, ajouter au parcours) ;
 * la traçabilité d'une donnée citée (une entrée, jamais « générée »), d'une valeur fixe du jeu (non générée)
 * et d'une sortie réellement capturée, observée après une exécution de simulation réelle.
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

async function openCatalog(): Promise<void> {
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="library"]').click();
  await dashboard().locator('h1', { hasText: 'Bibliothèque de scénarios' }).waitFor({ timeout: 15_000 });
  await dashboard().locator('[data-action="jn-tab"][data-tab="catalog"]').click();
  await dashboard().locator('.lib-catalog .lib-card').first().waitFor({ timeout: 15_000 });
}

const cards = (): Locator => dashboard().locator('.lib-catalog .lib-card');
const names = async (): Promise<string[]> =>
  (await cards().locator('.lib-title').allInnerTexts()).map((text) => text.trim());
const sheet = (): Locator => dashboard().locator('.lib-fiche');

beforeAll(async () => {
  app = await startLoopApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-catalog-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'other' },
  });
  // La valeur capturée est comparée à celle de l'application : le projet garde les valeurs de la trace.
  await keepTraceValues(path.join(workspace, project.id));
  await writeTraceBlocks(await flowsDirOf(path.join(workspace, project.id)));
  environment = await client.environments.create(project.id, {
    name: 'Test',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 20 },
  });
  // La bibliothèque lit les blocs du dossier des flows (un premier appel les enregistre).
  expect((await client.library.list(project.id)).length).toBe(5);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
}, 120_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — block catalogue and detailed sheet in Chromium', () => {
  it('searches, narrows, sorts, switches grid and list, on the real blocks', async () => {
    await openCatalog();
    expect(await cards().count()).toBe(5);
    await dashboard().locator('.lib-found', { hasText: '5 blocs trouvés' }).waitFor();
    // La carte : nombres réels du contrat (Create request : 6 étapes, 2 entrées, 1 sortie).
    const request = cards().filter({ hasText: 'Create request' });
    expect((await request.locator('.lib-counts').innerText()).replace(/\s+/g, ' ')).toBe(
      '6 étapes 2 entrées 1 sortie',
    );
    await request.locator('.lib-state', { hasText: 'Contrat valide' }).waitFor();
    await shot('catalog-1-grid');
    // La recherche.
    await dashboard().locator('input[data-lib="query"]').fill('request');
    await expect.poll(names).toEqual(['Check request status', 'Create request']);
    await dashboard().locator('input[data-lib="query"]').fill('');
    await expect.poll(() => cards().count()).toBe(5);
    // Le tri par nombre d'étapes.
    await dashboard().locator('select[data-lib="sort"]').selectOption('steps');
    await expect.poll(async () => (await names())[0]).toBe('Create company');
    await dashboard().locator('select[data-lib="sort"]').selectOption('name');
    // La liste, puis la grille.
    await dashboard().locator('[data-action="lib-layout"][data-layout="list"]').click();
    await dashboard().locator('.lib-catalog ul.lib-cards.list').waitFor();
    await dashboard().locator('[data-action="lib-layout"][data-layout="grid"]').click();
    await dashboard().locator('.lib-catalog ul.lib-cards.grid').waitFor();
    // Aucun résultat : le dire, et proposer d'effacer.
    await dashboard().locator('input[data-lib="query"]').fill('zzz-nothing');
    await dashboard().locator('.lib-blank', { hasText: 'Aucun bloc ne correspond' }).waitFor();
    await dashboard().locator('[data-action="lib-clear"]').click();
    await expect.poll(() => cards().count()).toBe(5);
  }, 120_000);

  it('opens the sheet beside the catalogue, keeps the search, shows its tabs, closes back to the card', async () => {
    await openCatalog();
    await dashboard().locator('input[data-lib="query"]').fill('create');
    await expect.poll(() => cards().count()).toBe(2);
    await cards().filter({ hasText: 'Create request' }).locator('.lib-openb').click();
    const docked = dashboard().locator('.lib-fiche.docked');
    await docked.locator('h2', { hasText: 'Create request' }).waitFor({ timeout: 15_000 });
    // Le catalogue reste là, avec sa recherche ; la carte ouverte est marquée.
    expect(await dashboard().locator('input[data-lib="query"]').inputValue()).toBe('create');
    expect(await dashboard().locator('.lib-split-list .lib-card').count()).toBe(2);
    await dashboard().locator('.lib-split-list .lib-card.open', { hasText: 'Create request' }).waitFor();
    // La vue d'ensemble : entrées et sorties du contrat, et aucune exécution réelle encore.
    await docked
      .locator('.lib-ocard', { hasText: 'Entrées (2)' })
      .locator('code', { hasText: 'company.name' })
      .waitFor();
    await docked
      .locator('.lib-ocard', { hasText: 'Sorties (1)' })
      .locator('code', { hasText: 'request.id' })
      .waitFor();
    await docked
      .locator('.lib-ocard', { hasText: 'Dernière exécution' })
      .locator('p', { hasText: 'Aucune exécution réelle n’a encore rejoué ce bloc.' })
      .waitFor({ timeout: 15_000 });
    await shot('catalog-2-sheet-overview');
    // Chaque onglet se charge avec ses données réelles (ou dit qu'il n'y en a pas).
    for (const [tab, text] of [
      ['steps', 'Create request'],
      ['inputs', 'company.id'],
      ['outputs', 'request.id'],
      ['contract', 'Préconditions'],
      ['data', 'Paramètres'],
      ['dependencies', 'Create company'],
      ['traceability', 'Provenance'],
      ['versions', 'v1'],
      ['provenance', 'Fichier'],
    ] as const) {
      await docked.locator(`#lib-tab-${tab}`).click();
      await expect.poll(() => docked.locator('#lib-tab-' + tab).getAttribute('aria-selected')).toBe('true');
      if (tab !== 'data' && tab !== 'steps')
        await docked.locator('.lib-fbody', { hasText: text }).waitFor({ timeout: 15_000 });
    }
    // Les étapes : toutes les actions enregistrées, dans l'ordre (6).
    await docked.locator('#lib-tab-steps').click();
    await expect.poll(() => docked.locator('.lib-fsteps .pub-step').count()).toBe(6);
    // Le compositeur, puis retour au catalogue : la fiche, la recherche et la sélection sont gardées.
    await dashboard().locator('[data-action="jn-tab"][data-tab="composer"]').click();
    await expect.poll(() => sheet().count()).toBe(0);
    await dashboard().locator('[data-action="jn-tab"][data-tab="catalog"]').click();
    await docked.locator('h2', { hasText: 'Create request' }).waitFor();
    expect(await dashboard().locator('input[data-lib="query"]').inputValue()).toBe('create');
    // Fermer : le catalogue reprend toute la largeur, la recherche est gardée.
    await docked.locator('[data-action="lib-sheet-close"]').first().click();
    await expect.poll(() => sheet().count()).toBe(0);
    expect(await dashboard().locator('input[data-lib="query"]').inputValue()).toBe('create');
    await dashboard().locator('.lib-catalog ul.lib-cards.grid').waitFor();
  }, 120_000);

  it('traceability: a cited input is never “generated”, a fixed data value is not generated, a capture is observed after a real run', async () => {
    await openCatalog();
    // Une donnée citée par ${testData:…} sans être produite par le bloc : une entrée fournie par l'amont.
    await cards().filter({ hasText: 'Create request' }).locator('.lib-openb').click();
    const docked = dashboard().locator('.lib-fiche.docked');
    await docked.locator('#lib-tab-traceability').click();
    await docked.locator('[data-action="lib-trace-pick"][data-key="input:company.name"]').first().click();
    const detail = docked.locator('.lib-tdetail');
    await detail
      .locator('dd', { hasText: 'Entrée fournie par l’amont (jamais générée par ce bloc)' })
      .waitFor();
    expect(await detail.innerText()).not.toMatch(/Générée par le bloc/);
    await detail.locator('.lib-tlinks button', { hasText: 'Create company' }).first().waitFor();
    // La sortie capturée dans la réponse HTTP : capturée, confirmée par l'étape ; rien d'observé sans exécution.
    await docked.locator('[data-action="lib-trace-pick"][data-key="output:request.id"]').first().click();
    await detail.locator('dd', { hasText: 'Capturée pendant le rejeu' }).waitFor();
    await detail.locator('.lib-det', { hasText: 'Confirmée' }).waitFor();
    await detail
      .locator('.lib-layer', { hasText: 'Observée' })
      .locator('p', { hasText: 'Rien d’observé : aucune exécution réelle n’a rejoué ce bloc.' })
      .waitFor();
    // Une valeur fixe du jeu de données : une sortie, non générée.
    await dashboard().locator('.lib-split-list .lib-title', { hasText: 'Name another company' }).click();
    await docked.locator('h2', { hasText: 'Name another company' }).waitFor();
    await docked.locator('#lib-tab-traceability').click();
    await docked
      .locator('.lib-tdetail dd', { hasText: 'Valeur fixe du jeu de données du bloc (non générée)' })
      .waitFor();
    // La valeur générée de Create company, elle, est générée (son générateur).
    await dashboard().locator('.lib-split-list .lib-title', { hasText: 'Create company' }).click();
    await docked.locator('h2', { hasText: 'Create company' }).waitFor();
    await docked.locator('[data-action="lib-trace-pick"][data-key="output:company.name"]').first().click();
    await docked
      .locator('.lib-tdetail dd', { hasText: 'Générée par le bloc au rejeu · générateur « company »' })
      .waitFor();

    // Une exécution de simulation RÉELLE du parcours de référence, puis la fiche relit l'activité.
    const blocks = await client.library.list(project.id);
    const started = await client.journeys.simulate(project.id, traceJourney(blocks), {
      environmentId: environment.id,
    });
    await finished(started);
    const captured = app.requests()[0]?.id;
    expect(captured).toBeTruthy();
    await openCatalog();
    await cards().filter({ hasText: 'Create request' }).locator('.lib-openb').click();
    await docked
      .locator('.lib-ocard', { hasText: 'Dernière exécution' })
      .locator('.lib-state', { hasText: 'Succès' })
      .waitFor({ timeout: 15_000 });
    await docked
      .locator('.lib-ocard', { hasText: 'Exécution de simulation du parcours « Request traceability »' })
      .waitFor();
    await docked.locator('[data-action="lib-trace-pick"][data-key="output:request.id"]').first().click();
    const observed = docked.locator('.lib-layer', { hasText: 'Observée' });
    await observed
      .locator('.lib-obs li', { hasText: 'Capture' })
      .locator('.lib-val', { hasText: captured ?? '?' })
      .waitFor({ timeout: 15_000 });
    await shot('catalog-3-traceability');
    // « Voir le rapport » mène à la vraie exécution qui a rejoué le bloc.
    await docked.locator('#lib-tab-overview').click();
    const report = docked
      .locator('.lib-ocard', { hasText: 'Dernière exécution' })
      .locator('[data-action="open-run"]');
    expect(await report.getAttribute('data-run')).toBe(started.run);
    await report.click();
    await dashboard().locator('main', { hasText: started.run }).first().waitFor({ timeout: 15_000 });
  }, 300_000);

  it('previews statically, edits the contract, duplicates (persisted), reports an HTTP error', async () => {
    await openCatalog();
    await cards().filter({ hasText: 'Create request' }).locator('.lib-openb').click();
    const docked = dashboard().locator('.lib-fiche.docked');
    await docked.locator('h2', { hasText: 'Create request' }).waitFor();
    // Prévisualiser : l'analyse statique réelle du bloc seul (ses entrées manquent sans amont).
    await docked.locator('[data-action="lib-preview"]').click();
    const preview = docked.locator('.lib-prev');
    await preview.locator('li', { hasText: 'company.id' }).first().waitFor({ timeout: 15_000 });
    await preview.locator('p', { hasText: 'Un bloc ne s’exécute pas seul' }).waitFor();
    await docked.locator('[data-action="lib-preview-close"]').click();
    // Éditer : le formulaire du contrat, sur l'onglet Contrat.
    await docked.locator('[data-action="lib-edit"]').click();
    await docked.locator('form.lib-contract').waitFor();
    expect(await docked.locator('#lib-tab-contract').getAttribute('aria-selected')).toBe('true');
    await docked.locator('[data-action="lib-contract-cancel"]').click();
    // Dupliquer : une vraie copie (version 1), sa fiche s'ouvre ; elle survit au rechargement.
    await docked.locator('[data-action="lib-dup-open"]').click();
    await docked.locator('input[data-lib="dup.name"]').fill('Create request copy');
    await docked.locator('form.lib-dup button[type="submit"]').click();
    await docked.locator('h2', { hasText: 'Create request copy' }).waitFor({ timeout: 15_000 });
    await docked.locator('#lib-tab-versions').click();
    await docked.locator('.lib-history', { hasText: 'copie du bloc « Create request » (v1)' }).waitFor();
    expect((await client.library.list(project.id)).map((block) => block.name)).toContain(
      'Create request copy',
    );
    await openCatalog();
    expect(await names()).toContain('Create request copy');
    // Une erreur HTTP de l'activité : dite dans la carte, rien n'est inventé.
    await page.route('**/library/*/activity', (route) =>
      route.fulfill({
        status: 500,
        body: '{"error":{"code":"BOOM","message":"activity unavailable"}}',
        contentType: 'application/json',
      }),
    );
    await cards().filter({ hasText: 'Create company' }).locator('.lib-openb').click();
    await docked
      .locator('.lib-ocard', { hasText: 'Dernière exécution' })
      .locator('.err')
      .waitFor({ timeout: 15_000 });
    await page.unroute('**/library/*/activity');
  }, 120_000);

  it('paginates a large catalogue and keeps the page when a sheet opens', async () => {
    // Des noms sans chiffres : deux noms qui ne diffèrent que par un nombre partagent un dossier (refusé, 409).
    for (const suffix of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'])
      await client.library.duplicate(project.id, 'Add person', { name: `Add person ${suffix}` });
    await openCatalog();
    await dashboard().locator('select[data-lib="pageSize"]').selectOption('12');
    await expect.poll(() => cards().count()).toBe(12);
    await dashboard().locator('.lib-found', { hasText: '1–12 sur 15 blocs' }).waitFor();
    await dashboard().locator('.lib-pager [data-action="lib-page"][data-page="2"]').first().click();
    await expect.poll(() => cards().count()).toBe(3);
    const first = (await names())[0] ?? '';
    await cards().first().locator('.lib-openb').click();
    await dashboard().locator('.lib-fiche.docked h2', { hasText: first }).waitFor();
    await dashboard().locator('.lib-split-list .lib-pager [aria-current="page"]', { hasText: '2' }).waitFor();
    await dashboard().locator('.lib-fiche.docked [data-action="lib-sheet-close"]').first().click();
    await expect.poll(() => cards().count()).toBe(3);
  }, 120_000);

  it('adds to the journey: a compatible block, then one whose input is missing, with the check messages', async () => {
    await openCatalog();
    // Le nombre de blocs par page choisi avant est gardé par le navigateur : tout le catalogue sur une page.
    await dashboard().locator('select[data-lib="pageSize"]').selectOption('48');
    // Le parcours ouvert est vide : Create request annonce ses entrées manquantes avant l'ajout.
    await cards().filter({ hasText: 'Create request' }).first().locator('.lib-openb').click();
    const docked = dashboard().locator('.lib-fiche.docked');
    const compat = docked.locator('.lib-compat-box');
    await compat.locator('li.ko', { hasText: 'company.id' }).waitFor();
    // Create company ajouté : le parcours fournit maintenant company.id et company.name.
    await dashboard().locator('.lib-split-list .lib-title', { hasText: 'Create company' }).click();
    await docked.locator('h2', { hasText: 'Create company' }).waitFor();
    await docked.locator('.lib-acts [data-action="lib-part-add"]').click();
    await dashboard()
      .locator('.jn [data-jn-node]', { hasText: 'Create company' })
      .first()
      .waitFor({ timeout: 15_000 });
    await dashboard().locator('[data-action="jn-tab"][data-tab="catalog"]').click();
    await cards().filter({ hasText: 'Create request' }).first().locator('.lib-openb').click();
    await compat
      .locator('li.ok', { hasText: 'company.id' })
      .locator('span', { hasText: 'fournie par Create company' })
      .waitFor();
    await docked.locator('.lib-acts [data-action="lib-part-add"]').click();
    await dashboard().locator('.jn [data-jn-node]', { hasText: 'Create request' }).first().waitFor();
    // Un bloc dont une entrée manque : Check request status lit request.id, que personne ne produit avant lui
    // s'il est seul — ici Create request le produit ; on ajoute plutôt « Add person », dont les entrées manquent.
    await dashboard().locator('[data-action="jn-tab"][data-tab="catalog"]').click();
    await cards().filter({ hasText: 'Add person' }).first().locator('.lib-openb').click();
    await compat.locator('li.ko', { hasText: 'person.firstName' }).waitFor();
    await docked.locator('.lib-acts [data-action="lib-part-add"]').click();
    await dashboard().locator('[data-action="jn-check"]').first().click();
    await dashboard().locator('.jn', { hasText: 'person.firstName' }).first().waitFor({ timeout: 15_000 });
    await shot('catalog-4-journey');
  }, 180_000);
});
