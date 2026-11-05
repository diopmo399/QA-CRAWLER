import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LE GRAPHE ENRICHI D'UNE API DANS CHROMIUM (API & Services › Traçabilité), avec le vrai serveur et le vrai
 * scanner, sur le mini-projet de test du graphe (cinq composants Angular, BFF, backend, partenaire externe,
 * table) : couloirs, faisceaux comptés et inspectables, dépliage, survol, sélection gardée d'un mode à
 * l'autre, vue Données, critères d'affichage, zoom, recentrage et plein écran ; le graphe complet du projet n'est jamais
 * téléchargé.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-graph');
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
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-lanes-'));
  sourcesRoot = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-lanes-sources-'));
  await cp(FIXTURE, sourcesRoot, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [sourcesRoot] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Companies', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
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

describe('Dashboard — enriched API graph in lanes, in Chromium', () => {
  const graph = (): Locator => dashboard().locator('[data-lanes]');
  const zoom = async (): Promise<string | null> => dashboard().locator('.map-gzoom').textContent();

  it('opens readable: lanes, grouped cards, counted bundles, a counted legend', async () => {
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="apis"]').click();
    await dashboard().locator('.map-acat .map-aitem', { hasText: 'Partner' }).click();
    await dashboard().locator('.map-acenter h2', { hasText: 'Partner Verification' }).waitFor();
    await dashboard().locator('[data-action="map-api-tab"][data-tab="trace"]').click();
    await graph().waitFor();
    // Le graphe complet est le mode d'ouverture, ajusté à la zone sans descendre sous un zoom lisible.
    expect(
      await dashboard()
        .locator('[data-action="map-ln-mode"][data-mode="full"]')
        .getAttribute('aria-selected'),
    ).toBe('true');
    await expect.poll(async () => Number((await zoom())?.replace(/\D/g, ''))).toBeGreaterThanOrEqual(70);
    expect(await graph().locator('.ln-lane header b').allTextContents()).toEqual([
      'Frontend',
      'BFF',
      'Backend',
      'API externe',
      'Base de données',
    ]);
    expect(await graph().locator('.ln-card.k-component').count()).toBe(5);
    expect(await graph().locator('.ln-card.k-external.own').count()).toBe(2);
    expect(await graph().locator('.ln-card.k-table').textContent()).toContain('VERIFICATION_DATE');
    const badges = await graph().locator('.ln-badge').allTextContents();
    expect(badges.map((b) => b.replace(/\s+/g, '')).sort()).toEqual([
      '2liens2',
      '4liens',
      '4liens',
      '4liens4',
    ]);
    const legend = dashboard().locator('.ln-legend');
    expect(await legend.textContent()).toContain('Probable (6)');
    // 46 relations, plus 10 lues depuis l'analyse des appels entre classes : chaque écran appelle sa méthode
    // (gabarit ou cycle de vie), qui appelle le service en souscrivant son résultat.
    expect(await legend.locator('.ln-total').textContent()).toBe('Total : 56 relations');
    expect(await dashboard().locator('.map-rel summary').textContent()).toContain('Toutes les relations');
  });

  it('a bundle lists its relations with their evidence, then unfolds; the code opens', async () => {
    const before = await graph().locator('.ln-e').count();
    await graph().locator('.ln-badge.n-external').click();
    const selection = dashboard().locator('.ln-sel');
    await selection.waitFor();
    expect(await selection.locator('.map-gsel-e').count()).toBe(2);
    expect(await selection.textContent()).toContain('PartnerVerificationClient.callPartnerApi()');
    expect(await dashboard().locator('.map-rel summary').textContent()).toContain('Relations détectées (2)');
    await graph().locator('.ln-badge.n-external').click();
    await expect.poll(() => graph().locator('.ln-e').count()).toBe(before + 1);
    expect(await selection.locator('[data-action="map-ln-expand"]').textContent()).toContain('Regrouper');
    await selection.locator('[data-action="map-evidence"]').first().click();
    await dashboard().locator('.map-code').waitFor();
    expect(await dashboard().locator('.map-code').textContent()).toContain('callPartnerApi');
    await dashboard().locator('[data-action="map-evidence-close"]').click();
  });

  it('hovering a card brings out its neighbourhood; a card selection survives the mode switch', async () => {
    await dashboard().locator('[data-action="map-g-clear"]').first().click();
    await graph().locator('.ln-card', { hasText: 'PartnerVerificationClient' }).hover();
    await expect.poll(() => graph().getAttribute('class')).toContain('hov');
    expect(await graph().locator('.ln-card.on').count()).toBeGreaterThanOrEqual(3);
    await page.mouse.move(2, 2);
    await graph().locator('.ln-card', { hasText: 'PartnerVerificationClient' }).click();
    const card = dashboard().locator('.ln-sel');
    await card.waitFor();
    expect(await card.textContent()).toContain('PartnerVerificationClient.java');
    await dashboard().locator('[data-action="map-ln-mode"][data-mode="path"]').click();
    await dashboard().locator('.map-path').waitFor();
    await dashboard().locator('[data-action="map-ln-mode"][data-mode="full"]').click();
    await dashboard().locator('.ln-card.sel', { hasText: 'PartnerVerificationClient' }).waitFor();
    await dashboard().locator('[data-action="map-g-clear"]').first().click();
  });

  it('the data view shows field flows and the fields exchanged; filters hide without losing relations', async () => {
    await dashboard().locator('[data-action="map-ln-view"][data-view="data"]').click();
    await graph().locator('.ln-card', { hasText: 'POST /v2/partners/company/verify' }).waitFor();
    expect(
      await graph().locator('.ln-card', { hasText: 'POST /v2/partners/company/verify' }).textContent(),
    ).toContain('→ companyName');
    expect(await dashboard().locator('.ln-note', { hasText: 'sans flux de données' }).count()).toBe(1);
    await dashboard().locator('[data-action="map-ln-view"][data-view="architecture"]').click();
    await dashboard().locator('[data-action="map-ln-filters"]').click();
    const all = await dashboard().locator('.map-rel summary').textContent();
    await dashboard().locator('input[data-map="ln-filter"][data-group="lanes"][value="BFF"]').uncheck();
    await expect.poll(() => graph().locator('.ln-lane.l-bff').count()).toBe(0);
    expect(await dashboard().locator('.ln-note', { hasText: 'masqué' }).count()).toBe(1);
    // La liste exhaustive ne perd rien : masquer n'est pas supprimer.
    expect(await dashboard().locator('.map-rel summary').textContent()).toBe(all);
    await dashboard().locator('[data-action="map-ln-reset"]').click();
    await expect.poll(() => graph().locator('.ln-lane.l-bff').count()).toBe(1);
  });

  it('zooms, recentres and goes full screen; the whole project graph is never fetched', async () => {
    const start = await zoom();
    await dashboard().locator('[data-action="map-g-zoom"][data-dir="1"]').click();
    await expect.poll(zoom).not.toBe(start);
    await dashboard().locator('[data-action="map-g-fit"]').click();
    await expect.poll(zoom).toBe(start);
    await dashboard().locator('[data-action="map-g-full"]').click();
    await dashboard().locator('.map-trace.full').waitFor();
    // En plein écran, la molette (réelle) zoome autour du pointeur.
    await page.waitForTimeout(200);
    const fitted = await zoom();
    await dashboard().locator('.ln-card', { hasText: 'CompanyBffService' }).hover();
    await page.mouse.wheel(0, -240);
    await expect.poll(zoom).not.toBe(fitted);
    await page.keyboard.press('Escape');
    await expect.poll(() => dashboard().locator('.map-trace.full').count()).toBe(0);
    // Hors plein écran : Ctrl + molette zoome ; la molette seule laisse défiler la page.
    const before = await zoom();
    await dashboard().locator('.ln-card', { hasText: 'CompanyBffService' }).hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await expect.poll(zoom).not.toBe(before);
    const zoomed = await zoom();
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    expect(await zoom()).toBe(zoomed);
    expect(calls.some((call) => call.startsWith('GET /cartography/api?'))).toBe(true);
    expect(calls.filter((call) => /^GET \/cartography(\?|$)/.test(call))).toEqual([]);
  });
});
