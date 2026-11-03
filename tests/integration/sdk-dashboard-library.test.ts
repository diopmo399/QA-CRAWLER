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
 * source, nom vérifié), chercher dans le catalogue, ouvrir les détails ; composer au glisser-déposer en
 * mode linéaire (entrée manquante sur la carte, corrigée en réordonnant), enregistrer, recharger, passer
 * au diagramme et revenir sans perte (une condition garde le diagramme) ; créer le scénario une seule fois
 * même en cliquant deux fois ; brancher une condition par ses ports, refuser une boucle, créer un scénario
 * par chemin après confirmation ; sur téléphone, rien ne déborde et le compositeur passe sous le catalogue.
 */
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
/** Un point du diagramme, en fraction de sa largeur et de sa hauteur (la scène varie avec l'écran). */
const spot = async (canvas: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> => {
  const box = await canvas.boundingBox();
  return { x: Math.round((box?.width ?? 400) * fx), y: Math.round((box?.height ?? 400) * fy) };
};

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

  it('composes in linear mode: dragged from the palette, the missing input shown on the card, fixed by reordering', async () => {
    const composer = dashboard().locator('#lib-composer');
    await composer.locator('input[data-jn="name"]').fill('Créer puis chercher');
    // Glisser-déposer réel depuis la palette vers la suite vide.
    await composer
      .locator('.jn-pal-item[data-jn-block="Bloc recherche"]')
      .dragTo(composer.locator('.jn-gap[data-jn-gap="0"]'));
    await composer
      .locator('.jn-card.ko', { hasText: 'entrée item.title manquante' })
      .waitFor({ timeout: 15_000 });
    // Le bouton d'une carte du catalogue ajoute aussi au parcours (à la fin) : créée plus tard, toujours en défaut.
    await dashboard().locator('.lib-card [data-action="lib-part-add"][data-block="Bloc création"]').click();
    await expect.poll(() => composer.locator('.jn-card').count()).toBe(2);
    await composer.locator('.jn-chip.ko', { hasText: 'Parcours invalide' }).waitFor({ timeout: 15_000 });
    expect(await composer.locator('[data-action="jn-publish"]').isDisabled()).toBe(true);
    // Réordonner par glisser-déposer : « Bloc création » en tête, le parcours tient.
    await composer.locator('.jn-card').nth(1).dragTo(composer.locator('.jn-gap[data-jn-gap="0"]'));
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    expect(await composer.locator('.jn-card').first().textContent()).toContain('Bloc création');
    // Les propriétés de l'instance : d'où vient son entrée.
    await composer.locator('.jn-card').nth(1).locator('[data-action="jn-select"]').click();
    await composer.locator('.jn-props', { hasText: 'item.title ← Bloc création' }).waitFor();
    // Dupliquer, retirer, annuler, rétablir : la bibliothèque n'est jamais touchée.
    await composer.locator('.jn-card').first().locator('[data-action="jn-duplicate"]').click();
    await expect.poll(() => composer.locator('.jn-card').count()).toBe(3);
    await composer.locator('.jn-card').nth(1).locator('[data-action="jn-remove"]').click();
    await expect.poll(() => composer.locator('.jn-card').count()).toBe(2);
    await composer.locator('[data-action="jn-undo"]').click();
    await expect.poll(() => composer.locator('.jn-card').count()).toBe(3);
    await composer.locator('[data-action="jn-redo"]').click();
    await expect.poll(() => composer.locator('.jn-card').count()).toBe(2);
    expect(await dashboard().locator('.lib-card').count()).toBe(2);
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
  });

  it('saves, reloads, switches to the diagram and back without loss; a condition keeps the diagram', async () => {
    const composer = dashboard().locator('#lib-composer');
    await composer.locator('[data-action="jn-save"]').click();
    await composer.locator('.jn-chip.ok', { hasText: 'Enregistré' }).waitFor({ timeout: 15_000 });
    // Recharger la page : le parcours se rouvre tel quel.
    await page.reload();
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('.drawer [data-action="nav"][data-view="library"]').click();
    await dashboard().locator('h1', { hasText: 'Bibliothèque de scénarios' }).waitFor({ timeout: 15_000 });
    const reopened = dashboard().locator('#lib-composer');
    await reopened.locator('select[data-jn="open"]').selectOption('Créer puis chercher');
    await expect.poll(() => reopened.locator('.jn-card').count(), { timeout: 15_000 }).toBe(2);
    expect(await reopened.locator('.jn-card').first().textContent()).toContain('Bloc création');
    // Le diagramme : les mêmes nœuds, reliés.
    await reopened.locator('#jn-mode-DIAGRAM').click();
    await expect.poll(() => reopened.locator('.jn-node').count()).toBe(4);
    expect(await reopened.locator('.jn-edge').count()).toBe(3);
    // Déplacer un nœud à la souris : sa position change et se garde.
    const block = reopened.locator('.jn-node.block').first();
    // Les gestes à la souris se font sur la partie visible de la page.
    await reopened.locator('[data-jn-canvas]').scrollIntoViewIfNeeded();
    const before = await block.boundingBox();
    if (!before) throw new Error('no node');
    await page.mouse.move(before.x + 40, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 140, before.y + 60, { steps: 6 });
    await page.mouse.up();
    const after = await reopened.locator('.jn-node.block').first().boundingBox();
    expect(Math.round((after?.x ?? 0) - before.x)).toBeGreaterThan(60);
    // Une condition déposée sur le diagramme : le mode linéaire est refusé, avec la raison.
    await reopened.locator('[data-jn-shape="CONDITION"]').dragTo(reopened.locator('[data-jn-canvas]'), {
      targetPosition: await spot(reopened.locator('[data-jn-canvas]'), 0.15, 0.3),
    });
    await expect.poll(() => reopened.locator('.jn-node.condition').count()).toBe(1);
    await reopened.locator('#jn-mode-LINEAR').click();
    await reopened.locator('.jn-msg.warn', { hasText: 'n’est pas possible sans perte' }).waitFor();
    expect(await reopened.locator('#jn-mode-DIAGRAM').getAttribute('aria-checked')).toBe('true');
    // La condition retirée (Suppr), le mode linéaire revient sans perte.
    await reopened.locator('.jn-node.condition').click();
    await page.keyboard.press('Delete');
    await expect.poll(() => reopened.locator('.jn-node.condition').count()).toBe(0);
    await reopened.locator('#jn-mode-LINEAR').click();
    await expect.poll(() => reopened.locator('.jn-card').count()).toBe(2);
    expect(await reopened.locator('.jn-card').first().textContent()).toContain('Bloc création');
    await reopened.locator('[data-action="jn-save"]').click();
    await reopened.locator('.jn-chip.ok', { hasText: 'Enregistré' }).waitFor({ timeout: 15_000 });
    const saved = await client.journeys.open(project.id, 'Créer puis chercher');
    expect(saved.mode).toBe('LINEAR');
    expect(saved.graph.nodes.filter((node) => node.kind === 'BLOCK').map((node) => node.block)).toEqual([
      'Bloc création',
      'Bloc recherche',
    ]);
  });

  it('creates the scenario once, even on a double click; a second creation is refused and said', async () => {
    const composer = dashboard().locator('#lib-composer');
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    await composer.locator('[data-action="jn-publish"]').dblclick();
    await composer
      .locator('.notice', { hasText: 'Créé : Créer puis chercher.' })
      .waitFor({ timeout: 15_000 });
    const scenarios = await client.scenarios.list(project.id);
    expect(scenarios.filter((scenario) => scenario.name === 'Créer puis chercher')).toHaveLength(1);
    expect(scenarios.find((scenario) => scenario.name === 'Créer puis chercher')?.uses).toEqual([
      'Bloc création',
      'Bloc recherche',
    ]);
    await dashboard().locator('.lib-card', { hasText: 'Utilisé dans 1 scénario(s)' }).first().waitFor();
    // Rien n'est écrasé : la même création est refusée, la raison est dite, le parcours reste.
    await composer.locator('[data-action="jn-publish"]').click();
    await composer.locator('.err[role="alert"]', { hasText: 'already named' }).waitFor({ timeout: 15_000 });
    expect(await composer.locator('.jn-card').count()).toBe(2);

    // Ses sorties, puis le parcours devient un bloc du catalogue (contrat déclaré).
    if (await composer.locator('[data-action="jn-deselect"]').count())
      await composer.locator('[data-action="jn-deselect"]').click();
    await composer.locator('.jn-outputs', { hasText: 'Sorties du parcours' }).waitFor();
    await composer.locator('[data-action="jn-to-block"]').click();
    await composer.locator('input[data-jn="blockName"]').fill('Créer et chercher (bloc)');
    await composer.locator('[data-action="jn-to-block-confirm"]').click();
    await composer
      .locator('.notice', { hasText: 'Le bloc « Créer et chercher (bloc) » est dans la bibliothèque' })
      .waitFor({ timeout: 15_000 });
    await dashboard().locator('.lib-card', { hasText: 'Créer et chercher (bloc)' }).first().waitFor();
    const created = (await client.library.list(project.id)).find(
      (block) => block.name === 'Créer et chercher (bloc)',
    );
    expect(created).toMatchObject({
      origin: { journey: 'Créer puis chercher' },
      contract: { source: 'DECLARED' },
    });
  });

  it('branches in the diagram: ports connect Oui/Non, a loop is refused on its connection, one scenario per path after confirmation', async () => {
    const composer = dashboard().locator('#lib-composer');
    await composer.locator('[data-action="jn-new"]').click();
    // Des modifications non enregistrées : la page demande d'abord (jamais une boîte du navigateur).
    if (await composer.locator('[data-action="jn-discard-yes"]').count())
      await composer.locator('[data-action="jn-discard-yes"]').click();
    await composer.locator('input[data-jn="name"]').fill('Créer selon le cas');
    await composer.locator('#jn-mode-DIAGRAM').click();
    const canvas = composer.locator('[data-jn-canvas]');
    await composer
      .locator('[data-jn-shape="CONDITION"]')
      .dragTo(canvas, { targetPosition: await spot(canvas, 0.22, 0.2) });
    await composer.locator('input[data-jn="label"]').fill('Urgent ?');
    await composer.locator('input[data-jn="label"]').press('Tab');
    const palette = composer.locator('.jn-pal-item[data-jn-block="Bloc création"]');
    await palette.dragTo(canvas, { targetPosition: await spot(canvas, 0.2, 0.84) });
    await palette.dragTo(canvas, { targetPosition: await spot(canvas, 0.8, 0.84) });
    await expect.poll(() => composer.locator('.jn-node.block').count()).toBe(2);
    await canvas.scrollIntoViewIfNeeded();
    const linkFrom = async (port: Locator, to: Locator): Promise<void> => {
      const a = await port.boundingBox();
      const b = await to.boundingBox();
      if (!a || !b) throw new Error('no box');
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    const start = composer.locator('.jn-node.start');
    const end = composer.locator('.jn-node.end');
    const condition = composer.locator('.jn-node.condition');
    const [left, right] = [
      composer.locator('.jn-node.block').nth(0),
      composer.locator('.jn-node.block').nth(1),
    ];
    await linkFrom(start.locator('.jn-port'), condition);
    await linkFrom(condition.locator('.jn-port.yes'), left);
    await linkFrom(condition.locator('.jn-port.no'), right);
    await linkFrom(left.locator('.jn-port'), end);
    await linkFrom(right.locator('.jn-port'), end);
    await expect.poll(() => composer.locator('.jn-edge').count()).toBe(5);
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    expect(await composer.locator('.jn-edge.yes').count()).toBe(1);
    expect(await composer.locator('.jn-edge.no').count()).toBe(1);
    // Une connexion vers le début est refusée tout de suite.
    await linkFrom(right.locator('.jn-port'), start);
    await composer.locator('.err[role="alert"]', { hasText: 'rien ne mène au début' }).waitFor();
    // Une boucle (bloc → condition) : la connexion est marquée, le parcours ne tient plus.
    await linkFrom(right.locator('.jn-port'), condition);
    await composer.locator('.jn-edge.ko').first().waitFor({ timeout: 15_000 });
    await composer.locator('.jn-chip.ko', { hasText: 'Parcours invalide' }).waitFor({ timeout: 15_000 });
    await composer.locator('[data-action="jn-undo"]').click();
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    // Enregistrer puis créer : un scénario par chemin, seulement après confirmation explicite.
    await composer.locator('[data-action="jn-save"]').click();
    await composer.locator('.jn-chip.ok', { hasText: 'Enregistré' }).waitFor({ timeout: 15_000 });
    await composer
      .locator('[data-action="jn-publish"]', { hasText: 'Créer 2 scénarios (un par chemin)' })
      .click();
    await composer.locator('.jn-confirm.warn', { hasText: 'n’évalue pas les conditions' }).waitFor();
    await composer.locator('[data-action="jn-publish-paths"]').click();
    await composer
      .locator('.notice', { hasText: 'Créé : Créer selon le cas · chemin A, Créer selon le cas · chemin B.' })
      .waitFor({ timeout: 15_000 });
    const names = (await client.scenarios.list(project.id)).map((scenario) => scenario.name);
    expect(names).toEqual(
      expect.arrayContaining(['Créer selon le cas · chemin A', 'Créer selon le cas · chemin B']),
    );
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
    const composer = await element.locator('#lib-composer').boundingBox();
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
