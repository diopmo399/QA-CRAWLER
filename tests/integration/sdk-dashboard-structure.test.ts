import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Project,
  type QaCrawlerClient,
  type QaCrawlerError,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * STRUCTURE & CONDITIONS, avec le vrai serveur et le vrai scanner, sur le mini-projet de test conditionnel
 * (un écran de demande Angular, un BFF, un backend, une API partenaire, une table) : les routes, puis le
 * parcours de démonstration dans Chromium — choisir la fonctionnalité, ouvrir le conteneur conditionnel,
 * voir le booléen et la méthode Backend, choisir le bouton enfant, voir son gestionnaire, l'endpoint
 * interne, l'API externe, les preuves et les scénarios — et une erreur réseau dite, puis surmontée.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-conditions');
let server: RunningSdkServer;
let workspace: string;
let sourcesRoot: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const calls: string[] = [];
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-structure-'));
  sourcesRoot = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-structure-sources-'));
  await cp(FIXTURE, sourcesRoot, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [sourcesRoot] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
  });
  await client.cartography.saveConfig(project.id, {
    sources: (
      [
        ['front', 'FRONTEND'],
        ['bff', 'BFF'],
        ['backend', 'BACKEND'],
      ] as const
    ).map(([id, layer]) => ({
      id,
      name: id,
      layer,
      path: path.join(sourcesRoot, id),
      include: [],
      enabled: true,
    })),
  });
  await client.cartography.scan(project.id);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await client.cartography.currentScan(project.id)).state !== 'RUNNING') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('request', (request) => {
    const url = new URL(request.url());
    const at = url.pathname.indexOf('/cartography');
    if (at >= 0) calls.push(`${request.method()} ${url.pathname.slice(at)}${url.search}`);
  });
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="cartography"]').click();
  await dashboard().locator('.map-kpis').waitFor();
}, 60_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(sourcesRoot, { recursive: true, force: true });
});

describe('cartography structure routes', () => {
  it('structure, element sheet, conditions and actions come from the scan; unknown ids are 404', async () => {
    const structure = await client.cartography.structure(project.id);
    expect(structure.kpis).toEqual({
      pages: 1,
      containers: 4,
      fields: 9,
      buttons: 3,
      internalApis: 8,
      externalApis: 1,
      conditions: 4,
    });
    const conditions = await client.cartography.conditions(project.id, { q: 'canValidate' });
    expect(conditions.items.map((r) => [r.element.name, r.aspect, r.whenTrue, r.decision])).toEqual([
      ['Validate', 'ENABLED', false, 'ValidationEligibilityService.canValidate'],
    ]);
    const button = conditions.items[0]?.element.id ?? '';
    const sheet = await client.cartography.element(project.id, button);
    expect(sheet.element.kind).toBe('BUTTON');
    expect(sheet.outbound.map((o) => o.path)).toEqual(['/partner/verify']);
    const actions = await client.cartography.actions(project.id, { size: 1, page: 2 });
    expect([actions.total, actions.items.length, actions.page]).toEqual([3, 1, 2]);
    const missing = await client.cartography
      .element(project.id, 'BUTTON:front:nope')
      .catch((e: unknown) => e);
    expect((missing as QaCrawlerError).status).toBe(404);
  });

  it('the trace of an element: downstream, upstream, bounded, with its breaks; bad criteria are refused', async () => {
    const conditions = await client.cartography.conditions(project.id, { q: 'canValidate' });
    const button = conditions.items[0]?.element.id ?? '';
    const down = await client.cartography.trace(project.id, button, { direction: 'DOWN' });
    expect(down.start).toBe(button);
    expect(down.levels[button]).toBe(0);
    expect(Object.values(down.levels).every((l) => l >= 0)).toBe(true);
    expect(down.nodes.some((n) => n.kind === 'API')).toBe(true);
    expect(down.outbound.map((o) => o.path)).toContain('/partner/verify');
    const up = await client.cartography.trace(project.id, button, { direction: 'UP' });
    expect(Object.values(up.levels).every((l) => l <= 0)).toBe(true);
    expect(up.nodes.some((n) => n.kind === 'COMPONENT')).toBe(true);
    const small = await client.cartography.trace(project.id, button, { direction: 'DOWN', limit: 2 });
    expect([small.nodes.length, small.truncated]).toEqual([2, true]);
    const front = await client.cartography.trace(project.id, button, { layers: ['FRONTEND'] });
    expect(front.nodes.every((n) => n.layer === 'FRONTEND')).toBe(true);
    for (const bad of [`direction=SIDEWAYS`, `layers=NOWHERE`, `kinds=TELEPORTS`]) {
      const response = await fetch(
        `${server.url}/api/projects/${project.id}/cartography/trace?id=${encodeURIComponent(button)}&${bad}`,
        { headers: { authorization: `Bearer ${server.token}` } },
      );
      expect(response.status).toBe(400);
    }
    const missing = await client.cartography.trace(project.id, 'BUTTON:front:nope').catch((e: unknown) => e);
    expect((missing as QaCrawlerError).status).toBe(404);
  });

  it('investigations: run, list, read, resume a branch, refuse bad input, go stale after a new scan, run again', async () => {
    const conditions = await client.cartography.conditions(project.id, { q: 'canValidate' });
    const button = conditions.items[0]?.element.id ?? '';
    const inv = await client.cartography.investigate(project.id, {
      start: button,
      direction: 'DOWN',
      budget: { nodes: 3 },
    });
    expect(inv.request).toMatchObject({ start: button, goal: 'JOURNEY', direction: 'DOWN', mode: 'FOCUSED' });
    expect(inv.state).toBe('PARTIAL');
    expect(inv.metrics.visited).toBe(4);
    const list = await client.cartography.investigations(project.id);
    expect(list.map((x) => x.id)).toContain(inv.id);
    expect((await client.cartography.investigation(project.id, inv.id)).paths).toEqual(inv.paths);
    const cut = inv.frontier.find((f) => f.reason === 'BUDGET');
    const resumed = await client.cartography.expandInvestigation(project.id, inv.id, cut?.node ?? '', {
      nodes: 200,
    });
    expect(resumed.id).toBe(inv.id);
    expect(resumed.metrics.visited).toBeGreaterThan(inv.metrics.visited);
    expect(resumed.expansions).toEqual([cut?.node]);
    const status = async (call: Promise<unknown>): Promise<number | undefined> =>
      ((await call.catch((e: unknown) => e)) as QaCrawlerError).status;
    expect(
      await status(client.cartography.investigate(project.id, { start: button, goal: 'NOPE' as never })),
    ).toBe(400);
    expect(
      await status(
        client.cartography.investigate(project.id, { start: button, budget: { hops: 1 } as never }),
      ),
    ).toBe(400);
    expect(await status(client.cartography.investigate(project.id, { start: 'BUTTON:front:nope' }))).toBe(
      404,
    );
    expect(await status(client.cartography.investigation(project.id, 'inv-unknown'))).toBe(404);
    expect(
      await status(client.cartography.expandInvestigation(project.id, inv.id, 'BUTTON:front:nope')),
    ).toBe(404);
    // Un nouveau scan : l'investigation est périmée, sa reprise refusée ; la relance repart du dernier scan.
    await client.cartography.scan(project.id);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if ((await client.cartography.currentScan(project.id)).state !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await client.cartography.investigation(project.id, inv.id)).state).toBe('STALE');
    const other = resumed.frontier[0]?.node;
    if (other)
      expect(await status(client.cartography.expandInvestigation(project.id, inv.id, other))).toBe(409);
    const again = await client.cartography.rerunInvestigation(project.id, inv.id);
    expect(again.previous).toBe(inv.id);
    expect(again.scanId).not.toBe(inv.scanId);
  });
});

describe('Dashboard — Structure & Conditions, in Chromium', () => {
  const sheet = (): Locator => dashboard().locator('.st-sheet');

  it('demonstration path: feature → conditional container → Backend boolean → child button → handler, endpoint, external API, evidence', async () => {
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="structure"]').click();
    await dashboard().locator('.st-tree').waitFor();
    // Les indicateurs de l'écran viennent du scan.
    await expect
      .poll(async () => dashboard().locator('.st-kpis b').allTextContents())
      .toEqual(['1', '4', '9', '3', '8', '1', '4']);
    // La fonctionnalité choisie : l'arbre est relu pour elle seule.
    const feature = dashboard().locator('select[data-map="struct-feature"]');
    const value = await feature.locator('option', { hasText: 'Request create' }).getAttribute('value');
    await feature.selectOption(value ?? '');
    await expect
      .poll(() => calls.some((c) => c.startsWith('GET /cartography/structure?feature=')))
      .toBe(true);
    await dashboard().locator('.st-row', { hasText: 'Company name' }).waitFor();

    // Le conteneur conditionnel : sa condition, le booléen, la méthode Backend qui le calcule.
    await dashboard().locator('.st-row', { hasText: 'Validation' }).click();
    await sheet().locator('h2', { hasText: 'Conteneur : Validation' }).waitFor();
    const display = sheet().locator('.st-sec', { hasText: 'Conditions d’affichage' });
    await expect.poll(() => display.locator('.st-expr').textContent()).toBe('state.showValidationSection');
    await expect
      .poll(() => display.textContent())
      .toContain('ValidationEligibilityService.isEligibleForValidation');
    await dashboard().locator('[data-lanes]').waitFor();

    // Le bouton enfant : activation (boucle), gestionnaire, endpoint interne, API externe.
    await dashboard().locator('.st-row', { hasText: 'Validate' }).click();
    await sheet().locator('h2', { hasText: 'Bouton : Validate' }).waitFor();
    const enable = sheet().locator('.st-sec', { hasText: 'Conditions d’activation' });
    await expect.poll(() => enable.locator('.st-expr').textContent()).toBe('state.canValidate');
    await expect.poll(() => enable.textContent()).toContain('1 boucle');
    const text = (await sheet().textContent()) ?? '';
    expect(text).toContain('validateRequest()');
    expect(text).toContain('POST /api/requests/validate');
    expect(text).toContain('POST /partner/verify');
    expect(text).toContain('hérité du conteneur « Validation »');
    // Le graphe de l'élément : sa carte, le service, l'API externe ; les couloirs nommés.
    const graph = dashboard().locator('[data-lanes]');
    await expect.poll(async () => graph.locator('.ln-card').count()).toBeGreaterThan(4);
    expect(await graph.textContent()).toContain('/partner/verify');
    // Une preuve s'ouvre (extrait du code lu par le serveur).
    await sheet()
      .locator('.st-sec', { hasText: 'Preuves de code' })
      .locator('[data-action="map-evidence"]')
      .first()
      .click();
    await dashboard().locator('.map-ev pre.map-code').waitFor();
    await dashboard().locator('[data-action="map-evidence-close"]').first().click();
    // Les scénarios : aucun associé dans ce projet, dit tel quel.
    expect(await sheet().locator('.st-sec', { hasText: 'Scénarios associés' }).textContent()).toContain(
      '(0)',
    );
    // Les onglets sous le graphe : conditions de l'élément.
    await dashboard().locator('[data-action="map-st-bottom"][data-tab="conditions"]').click();
    await expect.poll(async () => dashboard().locator('.st-bottom tbody tr').count()).toBe(2);
    // Le graphe complet du projet n'est jamais téléchargé.
    expect(calls.some((c) => c.startsWith('GET /cartography/graph'))).toBe(false);
  });

  it('Conditions & Rules lists the project conditions; an undetermined one says why', async () => {
    await dashboard().locator('[data-action="map-st-tab"][data-tab="conditions"]').click();
    await expect.poll(async () => dashboard().locator('.st-center tbody tr').count()).toBe(4);
    await dashboard().locator('.st-center .lnk', { hasText: 'Attachments' }).click();
    await sheet().locator('h2', { hasText: 'Conteneur : Attachments' }).waitFor();
    const display = sheet().locator('.st-sec', { hasText: 'Conditions d’affichage' });
    await expect.poll(() => display.textContent()).toContain('non déterminé');
    expect(await display.textContent()).toContain('hasPermission');
    expect(await display.locator('.st-expr').textContent()).toBe('hasPermission');
  });

  it('Actions & APIs lists the buttons with their chain', async () => {
    await dashboard().locator('[data-action="map-st-tab"][data-tab="actions"]').click();
    await expect.poll(async () => dashboard().locator('.st-center tbody tr').count()).toBe(3);
    const row = dashboard().locator('.st-center tbody tr', { hasText: 'Validate' });
    expect(await row.textContent()).toContain('/partner/verify');
  });

  it('upstream, downstream and complete views; a details window that keeps the zoom and position', async () => {
    await dashboard().locator('[data-action="map-st-tab"][data-tab="graph"]').click();
    await dashboard().locator('.st-row', { hasText: 'Validate' }).click();
    await sheet().locator('h2', { hasText: 'Bouton : Validate' }).waitFor();
    await dashboard().locator('[data-action="map-st-dir"][data-dir="DOWN"]').click();
    const stats = dashboard().locator('[data-trace-stats]');
    await stats.waitFor();
    expect(calls.some((c) => c.startsWith('GET /cartography/trace?') && c.includes('direction=DOWN'))).toBe(
      true,
    );
    expect(await stats.textContent()).toMatch(/\d+ éléments · \d+ liens/);
    expect(await dashboard().locator('[data-lanes]').textContent()).toContain('/partner/verify');
    // Les critères : une seule couche ; le parcours est relu et le dit.
    await dashboard().locator('[data-action="map-st-tl"][data-layer="FRONTEND"]').click();
    await expect
      .poll(() => calls.some((c) => c.includes('/cartography/trace?') && c.includes('layers=FRONTEND')))
      .toBe(true);
    await dashboard().locator('[data-action="map-st-tclear"]').click();
    await stats.waitFor();
    // Une carte choisie ouvre la fenêtre de détail ; le zoom et la position ne bougent pas.
    await dashboard().locator('[data-action="map-g-zoom"][data-dir="1"]').click();
    const inner = dashboard().locator('.map-canvas-in');
    const before = await inner.getAttribute('style');
    await dashboard().locator('[data-lanes] .ln-card').first().click();
    await dashboard().locator('[data-action="map-st-detail"]').first().click();
    const modal = dashboard().locator('[data-st-detail]');
    await modal.waitFor();
    for (const key of [
      'description',
      'conditions',
      'apis',
      'data',
      'evidence',
      'code',
      'diagnostics',
      'path',
    ])
      expect(await modal.locator(`[data-detail="${key}"]`).count()).toBe(1);
    expect(await inner.getAttribute('style')).toBe(before);
    await page.keyboard.press('Escape');
    await expect.poll(() => modal.count()).toBe(0);
    expect(await inner.getAttribute('style')).toBe(before);
    // L'amont puis le complet, et retour à la fiche.
    await dashboard().locator('[data-action="map-st-dir"][data-dir="UP"]').click();
    await expect.poll(() => calls.some((c) => c.includes('direction=UP'))).toBe(true);
    await stats.waitFor();
    await dashboard().locator('[data-action="map-st-dir"][data-dir="BOTH"]').click();
    await expect.poll(() => calls.some((c) => c.includes('direction=BOTH'))).toBe(true);
    await stats.waitFor();
    await dashboard().locator('[data-action="map-st-dir"][data-dir="SHEET"]').click();
    await expect.poll(() => stats.count()).toBe(0);
    expect(calls.some((c) => c.startsWith('GET /cartography/graph'))).toBe(false);
  });

  it('the investigation window: run from the element, read a path and its breaks, close with Escape', async () => {
    await dashboard().locator('[data-action="map-st-tab"][data-tab="graph"]').click();
    await dashboard().locator('.st-row', { hasText: 'Validate' }).click();
    await sheet().locator('h2', { hasText: 'Bouton : Validate' }).waitFor();
    const open = dashboard().locator('[data-action="map-inv-open"]');
    await open.click();
    const modal = dashboard().locator('[data-inv-modal]');
    await modal.waitFor();
    await modal.locator('[data-action="map-inv-run"]').click();
    await modal.locator('[data-inv-metrics]').waitFor();
    expect(calls.some((c) => c === 'POST /cartography/investigations')).toBe(true);
    // Les chemins sont regroupés par issue ; le premier est montré, étape par étape, avec ses preuves.
    expect(await modal.locator('[data-action="map-inv-path"]').count()).toBeGreaterThan(0);
    const steps = modal.locator('[data-inv-steps] li');
    expect(await steps.count()).toBeGreaterThan(2);
    expect(await steps.first().textContent()).toContain('Validate');
    const second = modal.locator('[data-action="map-inv-path"]').nth(1);
    if ((await second.count()) > 0) {
      await second.click();
      await expect.poll(() => second.getAttribute('aria-pressed')).toBe('true');
    }
    // Les onglets du bas : limites dites.
    await modal.locator('[data-action="map-inv-tab"][data-tab="limits"]').click();
    expect(await modal.locator('.inv-bottom').textContent()).toContain('analyse statique');
    // La recherche ne garde que les chemins qui passent par l'élément cherché.
    const search = modal.locator('input[data-map="inv-q"]');
    await search.fill('validateRequest');
    await search.press('Enter');
    await expect.poll(async () => modal.locator('[data-action="map-inv-path"]').count()).toBeGreaterThan(0);
    await search.fill('zzz-absent');
    await search.press('Enter');
    await expect.poll(async () => modal.locator('[data-action="map-inv-path"]').count()).toBe(0);
    expect(await modal.textContent()).toContain('Aucun chemin ne correspond');
    await page.keyboard.press('Escape');
    await expect.poll(() => modal.count()).toBe(0);
    await expect
      .poll(() => open.evaluate((el) => el === (el.getRootNode() as Document | ShadowRoot).activeElement))
      .toBe(true);
  });

  it('a network error on an element sheet is shown, and a new selection recovers', async () => {
    await page.route('**/cartography/element**', (route) => route.abort('failed'));
    await dashboard().locator('.st-row', { hasText: 'Refuse' }).click();
    await dashboard().locator('.st-center .err[role="alert"]').waitFor();
    await page.unroute('**/cartography/element**');
    await dashboard().locator('.st-row', { hasText: 'Save' }).click();
    await sheet().locator('h2', { hasText: 'Bouton : Save' }).waitFor();
    expect(await dashboard().locator('.st-center .err[role="alert"]').count()).toBe(0);
  });
});
