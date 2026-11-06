import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** Change d'onglet dans la Bibliothèque (Catalogue de blocs, Compositeur de parcours, Diagnostics). */
async function tab(name: 'catalog' | 'composer' | 'diagnostics'): Promise<void> {
  const button = dashboard().locator(`[data-action="jn-tab"][data-tab="${name}"]`);
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
}

describe('Dashboard — scenario library in Chromium', () => {
  it('adds blocks through the « Ajouter un bloc » window: four steps, the name checked, a real check before creation', async () => {
    await dashboard().locator('.lib-blank', { hasText: 'Aucun bloc pour l’instant' }).waitFor();
    await dashboard().locator('.hd [data-action="lib-panel-open"]').click();
    const wizard = dashboard().locator('.wz[role="dialog"]');
    // La source réelle est lue : ses étapes exécutables et sa page de départ.
    await wizard.locator('.wz-status.ok', { hasText: '3 étape(s) exécutable(s) · départ /items' }).waitFor({
      timeout: 15_000,
    });
    // Le focus est dans la fenêtre ; le nom est vérifié avant d'aller plus loin.
    expect(
      await wizard
        .locator('[data-wz="name"]')
        .evaluate((input) => input === (input.getRootNode() as ShadowRoot).activeElement),
    ).toBe(true);
    await wizard.locator('[data-wz="name"]').fill('Chercher un élément');
    await wizard.locator('#wz-name-hint.err', { hasText: 'déjà pris' }).waitFor();
    expect(await wizard.locator('[data-action="wz-next"]').isDisabled()).toBe(true);
    await wizard.locator('[data-wz="name"]').fill('Bloc création');
    await wizard.locator('[data-wz="description"]').fill('Crée un élément au titre généré');
    // Étapes 2 et 3 : le contrat déduit, puis les paramètres (ses entrées).
    await wizard.locator('[data-action="wz-next"]').click();
    await wizard.locator('.wz-h', { hasText: 'Entrées et sorties' }).waitFor();
    await wizard.locator('[data-action="wz-next"]').click();
    await wizard.locator('.wz-h', { hasText: 'Paramètres configurables' }).waitFor();
    // Étape 4 : récapitulatif et vérification réelle ; Précédent garde la saisie.
    await wizard.locator('[data-action="wz-next"]').click();
    await wizard
      .locator('.wz-status.ok', { hasText: 'Le bloc peut être créé.' })
      .waitFor({ timeout: 15_000 });
    await wizard.locator('[data-action="wz-prev"]').click();
    await wizard.locator('[data-action="wz-goto"][data-step="1"]').click();
    expect(await wizard.locator('[data-wz="name"]').inputValue()).toBe('Bloc création');
    await wizard.locator('[data-action="wz-goto"][data-step="4"]').click();
    await wizard
      .locator('.wz-status.ok', { hasText: 'Le bloc peut être créé.' })
      .waitFor({ timeout: 15_000 });
    await wizard.locator('[data-action="wz-create"]').dblclick();
    await dashboard()
      .locator('.notice', { hasText: 'Bloc créé avec succès : « Bloc création ».' })
      .waitFor({ timeout: 15_000 });
    expect(await dashboard().locator('.wz').count()).toBe(0);
    expect((await client.library.list(project.id)).map((block) => block.name)).toEqual(['Bloc création']);
    // Fermer après une saisie demande confirmation (Échap), jamais une perte silencieuse.
    await dashboard().locator('.hd [data-action="lib-panel-open"]').click();
    await wizard.locator('[data-wz="name"]').fill('Brouillon');
    await page.keyboard.press('Escape');
    await wizard.locator('.wz-discard', { hasText: 'Abandonner la création du bloc ?' }).waitFor();
    await wizard.locator('[data-action="wz-discard-no"]').click();
    expect(await wizard.locator('[data-wz="name"]').inputValue()).toBe('Brouillon');
    await wizard.locator('[data-action="wz-cancel"]').first().click();
    await wizard.locator('[data-action="wz-discard-yes"]').click();
    expect(await dashboard().locator('.wz').count()).toBe(0);
    // Le second bloc, depuis l'autre scénario.
    await dashboard().locator('.hd [data-action="lib-panel-open"]').click();
    await wizard.locator('select[data-wz="scenario"]').selectOption('Chercher un élément');
    await wizard.locator('.wz-status.ok', { hasText: '2 étape(s)' }).waitFor({ timeout: 15_000 });
    await wizard.locator('[data-wz="name"]').fill('Bloc recherche');
    for (let step = 0; step < 3; step += 1) await wizard.locator('[data-action="wz-next"]').click();
    await wizard
      .locator('.wz-status.ok', { hasText: 'Le bloc peut être créé.' })
      .waitFor({ timeout: 15_000 });
    await wizard.locator('[data-action="wz-create"]').click();
    await dashboard().locator('.notice', { hasText: 'Bloc créé avec succès : « Bloc recherche ».' }).waitFor({
      timeout: 15_000,
    });
    // Les onglets de la page : le catalogue complet est dans « Catalogue de blocs ».
    await tab('catalog');
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
    await tab('composer');
    await composer.locator('input[data-jn="name"]').fill('Créer puis chercher');
    // Glisser-déposer réel depuis la palette vers la suite vide.
    await composer
      .locator('.jn-pal-item[data-jn-block="Bloc recherche"]')
      .dragTo(composer.locator('.jn-gap[data-jn-gap="0"]'));
    await composer
      .locator('.jn-card.ko', { hasText: 'entrée item.title manquante' })
      .waitFor({ timeout: 15_000 });
    // « Au parcours » sur une carte du catalogue ajoute aussi (à la fin) et ramène au compositeur ; le bloc
    // ajouté est choisi, ses propriétés s'ouvrent, une confirmation discrète le dit.
    await tab('catalog');
    await dashboard()
      .locator('.lib-tabpanel .lib-card [data-action="lib-part-add"][data-block="Bloc création"]')
      .click();
    await expect.poll(() => composer.locator('.jn-card').count()).toBe(2);
    await composer.locator('.jn-toast', { hasText: 'Bloc « Bloc création » ajouté au parcours' }).waitFor();
    await composer.locator('.jn-card.sel', { hasText: 'Bloc création' }).waitFor();
    await composer.locator('.jn-props h3', { hasText: 'Bloc création' }).waitFor();
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
    expect(await client.library.list(project.id)).toHaveLength(2);
    await composer.locator('.jn-chip.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    // La validation du parcours suit la vraie vérification.
    await composer.locator('.jn-val-state.ok', { hasText: 'Parcours valide' }).waitFor();
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
    await reopened
      .locator('.jn-tools-v [data-jn-shape="CONDITION"]')
      .dragTo(reopened.locator('[data-jn-canvas]'), {
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
    await tab('catalog');
    await dashboard()
      .locator('.lib-tabpanel .lib-card', { hasText: 'Utilisé dans 1 scénario(s)' })
      .first()
      .waitFor();
    await tab('composer');
    // Rien n'est écrasé : la même création est refusée, la raison est dite, le parcours reste.
    await composer.locator('[data-action="jn-publish"]').click();
    await composer.locator('.err[role="alert"]', { hasText: 'already named' }).waitFor({ timeout: 15_000 });
    expect(await composer.locator('.jn-card').count()).toBe(2);

    // Ses sorties, puis le parcours devient un bloc du catalogue (contrat déclaré).
    if (await composer.locator('.jn-props [data-action="jn-deselect"]').count())
      await composer.locator('.jn-props [data-action="jn-deselect"]').click();
    await composer.locator('.jn-outputs', { hasText: 'Sorties du parcours' }).waitFor();
    await composer.locator('[data-action="jn-to-block"]').click();
    await composer.locator('input[data-jn="blockName"]').fill('Créer et chercher (bloc)');
    await composer.locator('[data-action="jn-to-block-confirm"]').click();
    await composer
      .locator('.notice', { hasText: 'Le bloc « Créer et chercher (bloc) » est dans la bibliothèque' })
      .waitFor({ timeout: 15_000 });
    await tab('catalog');
    await dashboard()
      .locator('.lib-tabpanel .lib-card', { hasText: 'Créer et chercher (bloc)' })
      .first()
      .waitFor();
    await tab('composer');
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
      .locator('.jn-tools-v [data-jn-shape="CONDITION"]')
      .dragTo(canvas, { targetPosition: await spot(canvas, 0.45, 0.2) });
    await composer.locator('input[data-jn="label"]').fill('Urgent ?');
    await composer.locator('input[data-jn="label"]').press('Tab');
    const palette = composer.locator('.jn-pal-item[data-jn-block="Bloc création"]');
    // Hors de la barre d'outils (à gauche) : un bloc déposé loin de toute connexion n'est relié à rien.
    await palette.dragTo(canvas, { targetPosition: await spot(canvas, 0.32, 0.78) });
    await palette.dragTo(canvas, { targetPosition: await spot(canvas, 0.8, 0.78) });
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

  it('adds a block like the mockup: picked, dropped on a connection and inserted after confirmation, selected with its actions; connect tool, save and reload', async () => {
    const composer = dashboard().locator('#lib-composer');
    await tab('composer');
    await composer.locator('[data-action="jn-new"]').click();
    if (await composer.locator('[data-action="jn-discard-yes"]').count())
      await composer.locator('[data-action="jn-discard-yes"]').click();
    await composer.locator('input[data-jn="name"]').fill('Ajout au diagramme');
    await composer.locator('#jn-mode-DIAGRAM').click();
    const canvas = composer.locator('[data-jn-canvas]');
    // La relecture de la bibliothèque lancée par la création précédente peut redessiner le compositeur pendant
    // le défilement : le canevas redessiné est repris (jamais l'ancien, détaché).
    for (let attempt = 1; ; attempt += 1) {
      try {
        await canvas.scrollIntoViewIfNeeded({ timeout: 5_000 });
        break;
      } catch (error) {
        if (attempt >= 5 || !String(error).includes('not attached')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // Choisir dans le catalogue : la carte est surlignée.
    await composer.locator('[data-action="jn-pick"][data-block="Bloc création"]').click();
    await composer.locator('.jn-pal-item.picked[data-jn-block="Bloc création"]').waitFor();
    // Déposé sur la connexion Début → Fin : l'insertion est proposée, rien n'est relié d'office.
    // Le canevas redessine ses connexions après le choix : la mesure attend qu'elles aient une boîte.
    const { edge, box } = await vi.waitFor(
      async () => {
        const edge = await composer.locator('.jn-edge .jn-e').first().boundingBox();
        const box = await canvas.boundingBox();
        if (!edge || !box) throw new Error('no edge');
        return { edge, box };
      },
      { timeout: 5000, interval: 50 },
    );
    await composer.locator('.jn-pal-item[data-jn-block="Bloc création"]').dragTo(canvas, {
      targetPosition: { x: edge.x + edge.width / 2 - box.x, y: edge.y + edge.height / 2 - box.y },
    });
    await composer
      .locator('.jn-insert', { hasText: 'Insérer « Bloc création » entre Début et Fin ?' })
      .waitFor();
    expect(await composer.locator('.jn-edge').count()).toBe(1);
    await composer.locator('[data-action="jn-insert-yes"]').click();
    await expect.poll(() => composer.locator('.jn-edge').count()).toBe(2);
    // Le bloc ajouté est choisi : bordure, barre d'actions, propriétés tirées de son contrat, confirmation.
    const added = composer.locator('.jn-node.block.sel');
    await added.waitFor();
    await added.locator('.jn-float [data-action="jn-edit"]').waitFor();
    await composer.locator('.jn-toast', { hasText: 'Bloc « Bloc création » ajouté au parcours' }).waitFor();
    await composer.locator('.jn-props h3', { hasText: 'Bloc création' }).waitFor();
    await composer.locator('[data-action="jn-props-tab"][data-tab="io"]').click();
    await composer.locator('#jn-pp-io').waitFor();
    // Dupliquer puis supprimer depuis la barre d'actions du nœud.
    await added.locator('.jn-float [data-action="jn-duplicate"]').click();
    await expect.poll(() => composer.locator('.jn-node.block').count()).toBe(2);
    await composer.locator('.jn-node.block.sel .jn-float [data-action="jn-remove"]').click();
    await expect.poll(() => composer.locator('.jn-node.block').count()).toBe(1);
    // L'outil « bloc » ajoute le bloc choisi au centre ; l'outil « relier » relie par deux clics.
    await composer.locator('[data-action="jn-pick"][data-block="Bloc recherche"]').click();
    await composer.locator('[data-action="jn-tool-block"]').click();
    await expect.poll(() => composer.locator('.jn-node.block').count()).toBe(2);
    await composer.locator('[data-action="jn-tool"][data-tool="connect"]').click();
    await composer.locator('.jn-node.block', { hasText: 'Bloc création' }).click();
    await composer.locator('.jn-node.block', { hasText: 'Bloc recherche' }).click();
    await composer.locator('.jn-node.block', { hasText: 'Bloc recherche' }).click();
    await composer.locator('.jn-node.end').click();
    await composer.locator('[data-action="jn-tool"][data-tool="select"]').click();
    await expect.poll(() => composer.locator('.jn-edge').count()).toBe(3);
    await composer.locator('.jn-val-state.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    // Enregistré puis rouvert : nœuds, positions et connexions restaurés.
    const positions = async (): Promise<string[]> =>
      composer
        .locator('.jn-node')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.cssText));
    const before = await positions();
    await composer.locator('[data-action="jn-save"]').click();
    await composer.locator('.jn-chip.ok', { hasText: 'Enregistré' }).waitFor({ timeout: 15_000 });
    await composer.locator('[data-action="jn-new"]').click();
    await composer.locator('select[data-jn="open"]').selectOption('Ajout au diagramme');
    await expect.poll(() => composer.locator('.jn-edge').count(), { timeout: 15_000 }).toBe(3);
    expect(await positions()).toEqual(before);
    // Les panneaux se replient et reviennent.
    await composer.locator('.jn-side [data-action="jn-panel"][data-panel="props"]').click();
    await composer.locator('.lib-rail.props').waitFor();
    await composer.locator('.lib-rail.props [data-action="jn-panel"]').click();
    await composer.locator('.jn-side').waitFor();
  });

  it('waits: added from the catalog, configured with only what the engine runs, citing a data item produced before; the data panel reads the real check; data links in the diagram', async () => {
    const composer = dashboard().locator('#lib-composer');
    await tab('composer');
    await composer.locator('[data-action="jn-new"]').click();
    if (await composer.locator('[data-action="jn-discard-yes"]').count())
      await composer.locator('[data-action="jn-discard-yes"]').click();
    await composer.locator('input[data-jn="name"]').fill('Créer puis attendre');
    await composer.locator('#jn-mode-LINEAR').click();
    // Ce que le moteur ne sait pas faire est montré indisponible, sans bouton ; la boucle, exécutée, n'en est plus.
    const off = composer.locator('.jn-pal-off');
    await off.locator('summary').click();
    expect(await off.locator('.jn-pal-item.off[aria-disabled="true"]').allTextContents()).toEqual([
      expect.stringContaining('Document'),
      expect.stringContaining('API'),
    ]);
    await composer.locator('.jn-pal-flow [data-action="jn-add-loop"]').waitFor();
    expect(await off.locator('button').count()).toBe(0);
    await composer.locator('.jn-pal-item[data-jn-block="Bloc création"] [data-action="jn-add"]').click();
    await composer.locator('.jn-pal-flow [data-action="jn-add-wait"]').click();
    await composer.locator('.jn-toast', { hasText: 'Attente ajoutée au parcours' }).waitFor();
    const wait = composer.locator('.jn-card.wait');
    await wait.waitFor();
    await composer.locator('.jn-props h3', { hasText: 'Attente' }).waitFor();
    // Les attentes non prises en charge sont dans la liste, désactivées.
    expect(await composer.locator('select[data-jn="wait.type"] option[disabled]').allTextContents()).toEqual([
      'Attendre qu’un élément soit cliquable',
      'Durée fixe',
    ]);
    // Incomplète : la validation de l'attente le dit, la vérification aussi.
    await composer.locator('.jn-val-list li.ko', { hasText: 'Cible à renseigner' }).waitFor();
    await composer.locator('select[data-jn="wait.type"]').selectOption('TEXT');
    // Citer une donnée produite avant l'attente (proposée par la vérification réelle).
    await composer.locator('[data-action="jn-wait-cite"][data-key="item.title"]').click({ timeout: 15_000 });
    expect(await composer.locator('input[data-jn="wait.text"]').inputValue()).toBe('${testData:item.title}');
    await composer.locator('input[data-jn="wait.timeoutS"]').fill('12');
    await composer.locator('input[data-jn="wait.timeoutS"]').press('Tab');
    await composer.locator('input[data-jn="wait.onTimeout"][value="WARN"]').check();
    await composer
      .locator('.jn-props', { hasText: 'L’étape reste notée en échec dans le rapport' })
      .waitFor();
    await composer.locator('.jn-val-state.ok', { hasText: 'Parcours valide' }).waitFor({ timeout: 15_000 });
    await composer.locator('.jn-val-list li.ok', { hasText: 'Données citées disponibles' }).waitFor();
    await wait.locator('.jn-compat.wait', { hasText: '12 s · avertissement au délai' }).waitFor();
    // Le panneau des données : correspondances, variables, erreurs.
    const dock = composer.locator('.jn-dock');
    await dock.locator('[data-action="jn-dock"][data-tab="map"]').click();
    await dock
      .locator('tr', { hasText: 'Connecté (même nom)' })
      .filter({ hasText: 'Bloc création' })
      .waitFor();
    await dock.locator('[data-action="jn-dock"][data-tab="vars"]').click();
    await dock
      .locator('tr', { hasText: 'item.title' })
      .filter({ hasText: 'Générée au rejeu par Bloc création' })
      .waitFor();
    // Placée avant le bloc qui la produit : l'erreur est dite, sur l'attente et dans le panneau.
    await wait.locator('[data-action="jn-move"][data-to="0"]').click();
    await dock.locator('[data-action="jn-dock"][data-tab="issues"]').click();
    await dock
      .locator('li.ko', { hasText: 'la donnée item.title n’est produite par aucun bloc avant cette attente' })
      .waitFor({ timeout: 15_000 });
    await composer.locator('[data-action="jn-undo"]').click();
    await dock
      .locator('.ok-t', { hasText: 'Aucune erreur ni aucun avertissement.' })
      .waitFor({ timeout: 15_000 });
    // En diagramme : l'attente en orange, le lien de données en pointillés vers elle, la légende.
    await composer.locator('#jn-mode-DIAGRAM').click();
    const node = composer.locator('.jn-node.wait');
    await node.waitFor();
    await node.click();
    await composer.locator('.jn-dlink', { hasText: 'item.title' }).waitFor({ timeout: 15_000 });
    await composer.locator('.jn-legend summary').click();
    await composer.locator('.jn-legend[open]', { hasText: 'Lien de données' }).waitFor();
    // Enregistré puis rouvert : l'attente et ses réglages sont gardés.
    await composer.locator('[data-action="jn-save"]').click();
    await composer.locator('.jn-chip.ok', { hasText: 'Enregistré' }).waitFor({ timeout: 15_000 });
    const saved = await client.journeys.open(project.id, 'Créer puis attendre');
    expect(saved.graph.nodes.find((entry) => entry.kind === 'WAIT')?.wait).toEqual({
      type: 'TEXT',
      text: '${testData:item.title}',
      timeoutS: 12,
      onTimeout: 'WARN',
    });
  });

  it('inserts a wait into a block from its sheet: the block becomes changed, its next version only once validated', async () => {
    await tab('catalog');
    await dashboard().locator('.lib-tabpanel .lib-title[data-block="Bloc création"]').click();
    const sheet = dashboard().locator('.lib-fiche');
    await sheet.waitFor();
    await dashboard().locator('[data-action="lib-sheet-tab"][data-tab="steps"]').click();
    await sheet.locator('[data-action="lib-wait-open"]').click({ timeout: 15_000 });
    await sheet.locator('select[data-lib="wait.after"]').selectOption('3');
    await sheet.locator('select[data-lib="wait.type"]').selectOption('URL');
    await sheet.locator('input[data-lib="wait.url"]').fill('/items/');
    await sheet.locator('[data-action="lib-wait-insert"]').click();
    await sheet
      .locator('.notice', {
        hasText: 'Attente insérée. Le bloc est modifié : validez-le pour créer la version 2.',
      })
      .waitFor({ timeout: 15_000 });
    await sheet.locator('.pub-step.is-check', { hasText: '/items/' }).waitFor({ timeout: 15_000 });
    expect(
      (await client.library.list(project.id)).find((block) => block.name === 'Bloc création'),
    ).toMatchObject({
      state: 'CHANGED',
      version: 1,
    });
    await page.keyboard.press('Escape');
  });

  it('on a phone: nothing scrolls sideways; one column, the composer reached from « Au parcours »', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="library"]').click();
    // Sur un téléphone : les onglets restent atteignables ; « Au parcours » mène au compositeur.
    await element.locator('[data-action="jn-tab"][data-tab="catalog"]').click();
    await element.locator('.lib-card').first().waitFor({ timeout: 15_000 });
    await element
      .locator('.lib-tabpanel .lib-card [data-action="lib-part-add"][data-block="Bloc création"]')
      .click();
    await element.locator('.jn-toast').waitFor();
    const palette = await element.locator('.jn-palette').boundingBox();
    const stage = await element.locator('.jn-stage').boundingBox();
    // Une seule colonne : le catalogue compact puis la scène, sans rien à faire défiler de côté.
    expect((stage?.y ?? 0) >= (palette?.y ?? 0) + (palette?.height ?? 0) - 1).toBe(true);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await element.locator('.hd [data-action="lib-panel-open"]').click();
    // Le panneau tient dans l'écran (il se redessine quand l'aperçu de la source arrive).
    await expect
      .poll(async () => (await element.locator('.wz').boundingBox())?.width ?? -1, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // La fenêtre « Ajouter un bloc » tient dans l'écran, en une colonne.
    expect((await element.locator('.wz').boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await phone.close();
  });
});
