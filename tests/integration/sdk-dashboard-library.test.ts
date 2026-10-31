import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LA BIBLIOTHÈQUE DANS CHROMIUM, sur un vrai serveur SDK : ajouter un bloc depuis le panneau (aperçu de la
 * source, nom vérifié), chercher dans le catalogue, ouvrir les détails ; composer un parcours dont la
 * vérification du serveur montre la dépendance manquante, puis satisfaite une fois l'ordre corrigé ;
 * créer le scénario une seule fois même en cliquant deux fois ; une erreur de l'API garde la saisie ; sur
 * téléphone, rien ne déborde et le compositeur passe sous le catalogue.
 */
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-library-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Bibliothèque', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  const flows = await flowsDirOf(path.join(workspace, project.id));
  await mkdir(path.join(flows, 'create'), { recursive: true });
  await mkdir(path.join(flows, 'search'), { recursive: true });
  await writeFile(
    path.join(flows, 'create', 'create.flow.yaml'),
    `name: Créer un élément\nstartAt: /items\ntestData: test-data.yaml\nsteps:\n  - click: { role: button, name: Nouveau }\n  - fill: { label: Titre, value: { testData: item.title } }\n  - click: { role: button, name: Enregistrer }\n`,
  );
  await writeFile(
    path.join(flows, 'create', 'test-data.yaml'),
    'values:\n  item:\n    title: { strategy: generated, generator: words }\n',
  );
  await writeFile(
    path.join(flows, 'search', 'search.flow.yaml'),
    `name: Chercher un élément\nstartAt: /items\nsteps:\n  - fill: { label: Recherche, value: "\${testData:item.title}" }\n  - expect: { text: "\${testData:item.title}" }\n`,
  );
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="library"]').click();
  await dashboard().locator('h1', { hasText: 'Bibliothèque de scénarios' }).waitFor({ timeout: 15_000 });
}, 60_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — scenario library in Chromium', () => {
  it('adds blocks from the side panel, after a preview of the source and a check of the name', async () => {
    await dashboard().locator('.lib-blank', { hasText: 'Aucun bloc pour l’instant' }).waitFor();
    await dashboard().locator('.hd [data-action="lib-panel-open"]').click();
    const sheet = dashboard().locator('.lib-sheet');
    await sheet
      .locator('.lib-preview', { hasText: '3 étape(s) · départ /items' })
      .waitFor({ timeout: 15_000 });
    expect(await sheet.locator('.lib-preview').textContent()).toContain('item.title');
    // Le nom est vérifié avant l'envoi : déjà pris, le bouton reste inactif.
    await sheet.locator('input[data-lib="panel.name"]').fill('Chercher un élément');
    await sheet.locator('#lib-name-hint.err', { hasText: 'déjà pris' }).waitFor();
    expect(await sheet.locator('button[type="submit"]').isDisabled()).toBe(true);
    await sheet.locator('input[data-lib="panel.name"]').fill('Bloc création');
    await sheet.locator('textarea[data-lib="panel.description"]').fill('Crée un élément au titre généré');
    await sheet.locator('button[type="submit"]').click();
    await dashboard()
      .locator('.notice', { hasText: 'Le bloc « Bloc création » est dans la bibliothèque.' })
      .waitFor({
        timeout: 15_000,
      });
    expect(await dashboard().locator('.lib-sheet').count()).toBe(0);
    // Le second, avec Échap pour fermer d'abord, puis rouvert sur l'autre scénario.
    await dashboard().locator('.hd [data-action="lib-panel-open"]').click();
    await page.keyboard.press('Escape');
    expect(await dashboard().locator('.lib-sheet').count()).toBe(0);
    await dashboard().locator('.hd [data-action="lib-panel-open"]').click();
    await dashboard().locator('select[data-lib="panel.scenario"]').selectOption('Chercher un élément');
    await dashboard().locator('.lib-preview', { hasText: '2 étape(s)' }).waitFor({ timeout: 15_000 });
    await dashboard().locator('input[data-lib="panel.name"]').fill('Bloc recherche');
    await dashboard().locator('.lib-sheet button[type="submit"]').click();
    await dashboard().locator('.lib-card', { hasText: 'Bloc recherche' }).waitFor({ timeout: 15_000 });
    const card = dashboard().locator('.lib-card', { hasText: 'Bloc création' });
    expect(await card.locator('.lib-ver').textContent()).toBe('v1');
    // Un contrat valide : une coche discrète, son nom au survol.
    expect(await card.locator('.lib-ok').getAttribute('title')).toBe('Contrat valide');
    // L'origine, courte ; le détail au survol.
    expect(await card.locator('.lib-origin').textContent()).toBe('Scénario Créer un élément');
    expect(await card.locator('.lib-origin').getAttribute('title')).toBe('Scénario « Créer un élément »');
  });

  it('searches the catalog and opens the details of a block (provenance, history)', async () => {
    const search = dashboard().locator('input[data-lib="query"]');
    await search.fill('');
    await search.pressSequentially('recher');
    // La saisie n'est jamais perdue pendant que le catalogue se met à jour.
    expect(await search.inputValue()).toBe('recher');
    await expect.poll(() => dashboard().locator('.lib-card').count()).toBe(1);
    await search.fill('');
    await dashboard().locator('input[data-lib="query"]').dispatchEvent('input');
    await expect.poll(() => dashboard().locator('.lib-card').count()).toBe(2);
    await dashboard().locator('.lib-title[data-block="Bloc création"]').click();
    // La fiche à onglets : le détail vient du serveur (étapes), la provenance et l'historique.
    const sheet = dashboard().locator('.lib-fiche');
    await sheet.waitFor();
    await dashboard().locator('[data-action="lib-sheet-tab"][data-tab="steps"]').click();
    await sheet.locator('.lib-fsteps').waitFor({ timeout: 15_000 });
    await dashboard().locator('[data-action="lib-sheet-tab"][data-tab="versions"]').click();
    expect(await sheet.textContent()).toContain('créé à partir du scénario « Créer un élément »');
    // Au clavier : la flèche passe à l'onglet suivant.
    await page.keyboard.press('ArrowRight');
    expect(
      await dashboard()
        .locator('[data-action="lib-sheet-tab"][data-tab="provenance"]')
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(await sheet.textContent()).toContain('bloc-creation');
    // Échap ferme la fiche ; le bloc reste dans les récents.
    await page.keyboard.press('Escape');
    await expect.poll(() => dashboard().locator('.lib-fiche').count()).toBe(0);
    expect(await dashboard().locator('.lib-recent').textContent()).toContain('Bloc création');
  });

  it('composes: the server check shows a missing input, then the dependency once the order is right', async () => {
    await dashboard().locator('input[data-lib="compose.name"]').fill('Créer puis chercher');
    await dashboard().locator('[data-action="lib-part-add"][data-block="Bloc recherche"]').click();
    await dashboard().locator('.lib-check.ko').waitFor({ timeout: 15_000 });
    expect(await dashboard().locator('.lib-miss').first().textContent()).toBe('item.title : non disponible');
    await dashboard().locator('[data-action="lib-part-add"][data-block="Bloc création"]').click();
    // Créée seulement plus tard : toujours refusé, l'ordre est en cause.
    await dashboard()
      .locator('.lib-check.ko', { hasText: 'produced only later by #2' })
      .waitFor({ timeout: 15_000 });
    expect(
      await dashboard().locator('form[data-action="lib-compose"] button[type="submit"]').isDisabled(),
    ).toBe(true);
    // Monter « Bloc création » en tête (au clavier : le bouton garde le focus).
    const up = dashboard().locator('[data-action="lib-part-move"][data-index="1"][data-direction="up"]');
    await up.focus();
    await page.keyboard.press('Enter');
    await dashboard().locator('.lib-check.ok', { hasText: 'Parcours vérifié' }).waitFor({ timeout: 15_000 });
    expect(await dashboard().locator('.lib-steps > li').first().textContent()).toContain('Bloc création');
    expect(await dashboard().locator('.lib-src').textContent()).toBe('item.title ← produite par #1');
    expect(await dashboard().locator('.lib-check').textContent()).toContain(
      'item.title : produite par #1, utilisée par #2',
    );
    // Retirer un bloc du parcours ne le retire pas de la bibliothèque.
    await dashboard().locator('[data-action="lib-part-add"][data-block="Bloc création"]').click();
    await expect.poll(() => dashboard().locator('.lib-steps > li').count()).toBe(3);
    await dashboard().locator('[data-action="lib-part-remove"][data-index="2"]').click();
    await expect.poll(() => dashboard().locator('.lib-steps > li').count()).toBe(2);
    expect(await dashboard().locator('.lib-card').count()).toBe(2);
  });

  it('creates the scenario once, even on a double click', async () => {
    await dashboard().locator('.lib-check.ok').waitFor({ timeout: 15_000 });
    await dashboard().locator('form[data-action="lib-compose"] button[type="submit"]').dblclick();
    await dashboard()
      .locator('.notice', { hasText: 'Le parcours « Créer puis chercher » est créé' })
      .waitFor({
        timeout: 15_000,
      });
    const scenarios = await client.scenarios.list(project.id);
    expect(scenarios.filter((scenario) => scenario.name === 'Créer puis chercher')).toHaveLength(1);
    expect(await dashboard().locator('.lib-error, .err[role="alert"]').count()).toBe(0);
    await dashboard().locator('.lib-card', { hasText: 'Utilisé dans 1 scénario(s)' }).first().waitFor();
    expect(await dashboard().locator('.lib-steps').count()).toBe(0);
  });

  it('an API error keeps what was typed and says why', async () => {
    await dashboard().locator('[data-action="lib-part-add"][data-block="Bloc création"]').click();
    await dashboard().locator('.lib-check').waitFor({ timeout: 15_000 });
    // Le serveur refuse un nom déjà pris ; la vérification l'avait dit, le compositeur le garde.
    await dashboard().locator('input[data-lib="compose.name"]').fill('Créer un élément');
    await dashboard().locator('[data-action="lib-check"]').click();
    await dashboard().locator('.lib-check.ko', { hasText: 'already named' }).waitFor({ timeout: 15_000 });
    expect(await dashboard().locator('input[data-lib="compose.name"]').inputValue()).toBe('Créer un élément');
    expect(await dashboard().locator('.lib-steps > li').count()).toBe(1);
  });

  it('on a phone: nothing scrolls sideways; the composer comes under the catalog, reachable in one tap', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="library"]').click();
    await element.locator('.lib-card').first().waitFor({ timeout: 15_000 });
    await element.locator('[data-action="lib-part-add"][data-block="Bloc création"]').click();
    const jump = element.locator('[data-action="lib-jump"]');
    await jump.waitFor();
    await jump.click();
    const catalog = await element.locator('.lib-catalog').boundingBox();
    const composer = await element.locator('.lib-composer').boundingBox();
    expect((composer?.y ?? 0) >= (catalog?.y ?? 0) + (catalog?.height ?? 0)).toBe(true);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await element.locator('.hd [data-action="lib-panel-open"]').click();
    // Le panneau tient dans l'écran (il se redessine quand l'aperçu de la source arrive).
    await expect
      .poll(async () => (await element.locator('.lib-sheet').boundingBox())?.width ?? -1, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect((await element.locator('.lib-sheet').boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
    await phone.close();
  });
});
