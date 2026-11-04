import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startLoopApp, type LoopApp } from '../fixtures/loop-app.js';

/**
 * LES BOUCLES, LA SIMULATION ET LES SORTIES DANS LE DASHBOARD (Chromium, moteur réel, application de test) :
 *   1. la fiche d'un bloc : « Ajouter une sortie » (texte d'un élément) insère une étape, le bloc devient
 *      modifié, sa nouvelle version est validée ;
 *   2. le compositeur : blocs, puis un nœud Boucle configuré (pour chaque personne, trois éléments) qui
 *      contient un bloc ; le parcours est vérifié ;
 *   3. l'onglet Simulation : l'aperçu statique (rien n'exécuté), puis l'exécution réelle dans
 *      l'environnement de test ; les itérations et la trace des données affichées viennent du moteur.
 */
let app: LoopApp;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const SHOTS = process.env.QA_SHOTS_DIR;
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const shot = async (name: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};

const BLOCKS: Record<string, { flow: string; data?: string }> = {
  'create-company': {
    flow: `name: Create company\nstartAt: /\nreusable: true\ntestData: test-data.yaml\nsteps:\n  - goto: /\n  - click: { role: button, name: New company }\n    allow: MUTATION\n  - fill: { label: Company name, value: { testData: company.name } }\n  - click: { role: button, name: Create company }\n    allow: MUTATION\n  - expect: { text: Company created }\n    timeoutMs: 5000\n`,
    data: 'values:\n  company:\n    name: { strategy: generated, generator: company }\n',
  },
  'create-request': {
    flow: `name: Create request\nreusable: true\nsteps:\n  - click: { role: button, name: New request }\n    allow: MUTATION\n  - fill: { label: Request title, value: "Onboarding \${testData:company.id}" }\n  - fill: { label: Company, value: "\${testData:company.name}" }\n  - click: { role: button, name: Create request }\n    allow: MUTATION\n  - expect: { text: Status DRAFT }\n`,
  },
  'add-person': {
    flow: `name: Add person\nreusable: true\nsteps:\n  - fill: { label: First name, value: "\${testData:person.firstName}" }\n  - fill: { label: Last name, value: "\${testData:person.lastName}" }\n  - fill: { label: Email, value: "\${testData:person.email}" }\n  - click: { role: button, name: Add person }\n    allow: MUTATION\n  - expect: { text: "\${testData:person.firstName} \${testData:person.lastName}" }\n    timeoutMs: 5000\n`,
  },
  'check-status': {
    flow: `name: Check request status\nreusable: true\nsteps:\n  - expect: { text: Status COMPLETE }\n`,
  },
};

beforeAll(async () => {
  app = await startLoopApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-loops-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'other' },
  });
  const flows = await flowsDirOf(path.join(workspace, project.id));
  for (const [folder, block] of Object.entries(BLOCKS)) {
    await mkdir(path.join(flows, folder), { recursive: true });
    await writeFile(path.join(flows, folder, `${folder}.flow.yaml`), block.flow);
    if (block.data) await writeFile(path.join(flows, folder, 'test-data.yaml'), block.data);
  }
  await client.environments.create(project.id, {
    name: 'Test',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 20 },
  });
  await client.environments.create(project.id, {
    name: 'Preproduction',
    kind: 'PREPRODUCTION',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
  });
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

async function tab(name: 'catalog' | 'composer' | 'diagnostics'): Promise<void> {
  const button = dashboard().locator(`[data-action="jn-tab"][data-tab="${name}"]`);
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
}

describe('Dashboard — outputs, loops and simulation in Chromium', () => {
  it('adds an output from the block sheet: a capture step, the block changed, its new version validated', async () => {
    await tab('catalog');
    await dashboard()
      .locator('.lib-tabpanel .lib-title[data-block="Create company"]')
      .click({ timeout: 15_000 });
    const sheet = dashboard().locator('.lib-fiche');
    await sheet.waitFor();
    await dashboard().locator('[data-action="lib-sheet-tab"][data-tab="outputs"]').click();
    await sheet.locator('[data-action="lib-output-open"]').click({ timeout: 15_000 });
    await sheet.locator('input[data-lib="output.key"]').fill('company.id');
    await sheet.locator('input[data-lib="output.label"]').fill('Company id');
    await sheet.locator('select[data-lib="output.source"]').selectOption('DOM_TEXT');
    await sheet.locator('input[data-lib="output.selector"]').fill('#company-id');
    await sheet.locator('select[data-lib="output.type"]').selectOption('identifier');
    await shot('loops-1-add-output');
    await sheet.locator('[data-action="lib-output-add"]').click();
    await sheet
      .locator('.notice', {
        hasText: 'Sortie company.id ajoutée par une étape du bloc : validez la version 2',
      })
      .waitFor({ timeout: 15_000 });
    expect(
      (await client.library.list(project.id)).find((block) => block.name === 'Create company')?.state,
    ).toBe('CHANGED');
    await dashboard().locator('[data-action="lib-sheet-tab"][data-tab="overview"]').click();
    await sheet.locator('[data-action="lib-validate-version"]').first().click({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (await client.library.list(project.id)).find((block) => block.name === 'Create company')?.version,
        { timeout: 15_000 },
      )
      .toBe(2);
    await dashboard().locator('[data-action="lib-sheet-tab"][data-tab="outputs"]').click();
    await sheet.locator('tr', { hasText: 'company.id' }).waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
  }, 120_000);

  it('composes with a loop node: FOR_EACH three persons around « Add person », checked valid', async () => {
    const composer = dashboard().locator('#lib-composer');
    await tab('composer');
    await composer.locator('input[data-jn="name"]').fill('Request with persons');
    for (const block of ['Create company', 'Create request']) {
      await composer.locator(`.jn-pal-item[data-jn-block="${block}"] [data-action="jn-add"]`).click();
      await composer.locator('.jn-card', { hasText: block }).waitFor({ timeout: 15_000 });
    }
    await composer.locator('.jn-pal-flow [data-action="jn-add-loop"]').click();
    await composer.locator('.jn-card.loop').waitFor();
    const props = composer.locator('.jn-props');
    await props.locator('h3', { hasText: 'Boucle' }).waitFor();
    await props.locator('select[data-jn="loop.type"]').selectOption('FOR_EACH');
    await props
      .locator('textarea[data-jn="loop.items"]')
      .fill(
        'firstName=Ada; lastName=Byron; email=ada@example.test\nfirstName=Alan; lastName=Turing; email=alan@example.test\nfirstName=Grace; lastName=Hopper; email=grace@example.test',
      );
    await props.locator('textarea[data-jn="loop.items"]').press('Tab');
    await props.locator('input[data-jn="loop.as"]').fill('person');
    await props.locator('input[data-jn="loop.as"]').press('Tab');
    await props.locator('input[data-jn="loop.maxIterations"]').fill('3');
    await props.locator('input[data-jn="loop.maxIterations"]').press('Tab');
    await props.locator('select[data-jn="loop.pick"]').selectOption('Add person');
    await props.locator('[data-action="jn-loop-add-block"]').click();
    await composer
      .locator('.jn-card.loop .jn-loop-i', { hasText: 'Add person' })
      .waitFor({ timeout: 15_000 });
    await props.locator('.jn-loop-vars', { hasText: 'person.lastName' }).waitFor();
    await composer
      .locator('.jn-pal-item[data-jn-block="Check request status"] [data-action="jn-add"]')
      .click();
    await composer.locator('.jn-card', { hasText: 'Check request status' }).waitFor({ timeout: 15_000 });
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 20_000 });
    expect(await composer.locator('.jn-card').allTextContents()).toHaveLength(4);
    await shot('loops-2-composer');
  }, 120_000);

  it('previews statically, then runs a real simulation in the test environment with iterations and data trace', async () => {
    const composer = dashboard().locator('#lib-composer');
    await composer.locator('[data-action="jn-dock"][data-tab="sim"]').click();
    const dock = composer.locator('.jn-dock');
    await dock.locator('[data-action="jn-preview"]').click();
    const preview = dock.locator('.sim-box.static');
    await preview.locator('.ok-t', { hasText: 'Le parcours est valide.' }).waitFor({ timeout: 15_000 });
    await preview.locator('tr.sim-loop', { hasText: '3 itération(s)' }).waitFor();
    await preview.locator('tr', { hasText: 'company.name' }).first().waitFor();
    await preview.locator('.jn-chip', { hasText: 'connue à l’exécution' }).first().waitFor();
    // Un environnement non isolé est proposé mais refusé (non sélectionnable).
    const select = dock.locator('select[data-jn="sim.env"]');
    expect(await select.locator('option[disabled]').allTextContents()).toEqual([
      'Preproduction · PREPRODUCTION : refusé (non isolé)',
    ]);
    await select.selectOption({ label: 'Test · TEST' });
    await preview.locator('tr.sim-loop').scrollIntoViewIfNeeded();
    await shot('loops-3-preview');
    await dock.locator('[data-action="jn-simulate"]').click();
    const result = dock.locator('.sim-result');
    await result.waitFor({ timeout: 150_000 });
    await result.locator('.pill', { hasText: 'Réussie' }).first().waitFor();
    await result.locator('.tr-loop', { hasText: '3 itération(s) sur 3 prévue(s)' }).waitFor();
    await result.locator('.tr-tbl tr', { hasText: 'company.name' }).first().waitFor();
    const [company] = app.companies();
    await result
      .locator('.tr-tbl tr', { hasText: company?.name ?? '?' })
      .first()
      .waitFor();
    await result.locator('.tr-flow li', { hasText: 'company.id' }).waitFor();
    expect(app.requests()[0]?.status).toBe('COMPLETE');
    expect(app.requests()[0]?.persons).toHaveLength(3);
    await result.locator('.tr-loop').scrollIntoViewIfNeeded();
    await shot('loops-4-simulation');
    // L'exécution ouverte dans l'écran Exécution : nommée « simulation », ses itérations et sa trace.
    await result.locator('[data-action="open-run"]').click();
    await dashboard().locator('.kpi', { hasText: 'Exécution de simulation' }).waitFor({ timeout: 15_000 });
    await dashboard().locator('.tr-loop').first().waitFor();
    await dashboard().locator('h3', { hasText: 'Traçabilité des données' }).waitFor();
    await dashboard().locator('.tr-loop').first().scrollIntoViewIfNeeded();
    await shot('loops-5-execution');
  }, 240_000);
});
