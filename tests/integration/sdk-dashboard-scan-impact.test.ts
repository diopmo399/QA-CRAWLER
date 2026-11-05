import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * SCAN & DÉCOUVERTE ET ANALYSE D'IMPACT DANS CHROMIUM, avec le vrai serveur et le vrai scanner : deux sources
 * locales, deux scans séparés par une modification réelle du code. Cartes de source dépliables, ajout
 * refusé tant que les champs obligatoires manquent (aucune requête envoyée), retrait, résumé qui ramène à
 * la source, comparaison lancée depuis les scans récents, permutation, scans identiques refusés, puces de
 * type, recherche, critères, et preuve ouverte depuis une ligne.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-graph');
let server: RunningSdkServer;
let workspace: string;
let roots: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const calls: string[] = [];
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const settle = async (): Promise<void> => {
  for (let i = 0; i < 600; i += 1) {
    if ((await client.cartography.currentScan(project.id)).state !== 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-scan-impact-'));
  roots = await mkdtemp(path.join(tmpdir(), 'sdk-scan-impact-src-'));
  await cp(FIXTURE, roots, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [roots] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Scan impact', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
  });
  await client.cartography.saveConfig(project.id, {
    sources: [
      {
        id: 'front',
        name: 'Application Angular',
        layer: 'FRONTEND',
        path: path.join(roots, 'front'),
        include: [],
        enabled: true,
      },
      {
        id: 'bff',
        name: 'API Gateway',
        layer: 'BFF',
        path: path.join(roots, 'bff'),
        include: [],
        enabled: true,
      },
    ],
  });
  await client.cartography.scan(project.id, { incremental: false });
  await settle();
  // Une modification réelle : les routes de l'écran disparaissent du frontal.
  await writeFile(path.join(roots, 'front/src/app/app.routes.ts'), 'export const routes = [];\n');
  await client.cartography.scan(project.id, { incremental: false });
  await settle();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('request', (request) => {
    const url = new URL(request.url());
    const at = url.pathname.indexOf('/cartography');
    if (at >= 0) calls.push(`${request.method()} ${url.pathname.slice(at)}`);
  });
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="cartography"]').click();
  await dashboard().locator('.map-kpis').waitFor();
}, 90_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(roots, { recursive: true, force: true });
});

describe('Scan & Discovery, in Chromium', () => {
  it('two columns: source cards, last scan steps, summary, discovered elements, recent scans, coverage', async () => {
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="scan"]').click();
    await dashboard().locator('.sd-src-l').waitFor();
    expect(await dashboard().locator('.sd-src').count()).toBe(2);
    expect(await dashboard().locator('.sd-last .sd-steps li.st-done').count()).toBe(3);
    expect(await dashboard().locator('.sd-sum .sd-row').count()).toBe(2);
    expect(await dashboard().locator('.sd-found .sd-row').count()).toBeGreaterThan(3);
    expect(await dashboard().locator('.sd-recent .sd-scanrow').count()).toBe(2);
    expect(await dashboard().locator('.sd-cov .sd-big').textContent()).toBe('0 %');
    // Le serveur n'autorise aucun dépôt distant : le choix est désactivé et dit pourquoi.
    await dashboard().locator('.sd-add > summary').click();
    expect(await dashboard().locator('[data-action="map-src-add"][data-kind="GIT"]').isDisabled()).toBe(true);
  });

  it('a card collapses and expands from its header', async () => {
    const toggle = dashboard().locator('#sd-src-0 .sd-tg');
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    expect(await dashboard().locator('#sd-src-b-0').count()).toBe(0);
    await dashboard().locator('#sd-src-0 .sd-tg').click();
    expect(await dashboard().locator('#sd-src-0 .sd-tg').getAttribute('aria-expanded')).toBe('true');
  });

  it('a new source with missing required fields is not sent; errors are shown and focused; it can be removed', async () => {
    const before = calls.filter((c) => c === 'POST /cartography/config').length;
    await dashboard().locator('.sd-add > summary').click();
    await dashboard().locator('[data-action="map-src-add"][data-kind="LOCAL"]').click();
    expect(await dashboard().locator('.sd-src').count()).toBe(3);
    await dashboard().locator('[data-action="map-src-save"]').click();
    await dashboard().locator('.sd-sources .err[role="alert"]').waitFor();
    expect(await dashboard().locator('#sd-2-name').getAttribute('aria-invalid')).toBe('true');
    expect(await dashboard().locator('#sd-2-path').getAttribute('aria-invalid')).toBe('true');
    expect(await dashboard().locator('#sd-2-name-err').textContent()).toContain('Nom obligatoire');
    expect(
      await page.evaluate(
        () => document.querySelector('qa-crawler-dashboard')?.shadowRoot?.activeElement?.id,
      ),
    ).toBe('sd-2-name');
    expect(calls.filter((c) => c === 'POST /cartography/config').length).toBe(before);
    await dashboard().locator('#sd-src-2 .sd-menu > summary').click();
    await dashboard().locator('#sd-src-2 [data-action="map-src-remove"]').click();
    expect(await dashboard().locator('.sd-src').count()).toBe(2);
  });

  it('the summary brings back to the source card', async () => {
    await dashboard().locator('#sd-src-1 .sd-tg').click();
    await dashboard().locator('.sd-sum [data-action="map-src-focus"][data-id="bff"]').click();
    expect(await dashboard().locator('#sd-src-1 .sd-tg').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Impact analysis, in Chromium', () => {
  it('compares from the recent scans: sources, counted changes, features, a filterable table', async () => {
    await dashboard().locator('.sd-recent [data-action="map-scan-compare"]').click();
    await dashboard().locator('.sd-detail').waitFor();
    expect(await dashboard().locator('.sd-imp-r .sd-rows li').count()).toBe(2);
    const removed = await dashboard()
      .locator('[data-action="map-impact-kind"][data-kind="REMOVED"]')
      .textContent();
    const count = Number(/\((\d+)\)/.exec(removed ?? '')?.[1]);
    expect(count).toBeGreaterThan(0);
    expect(await dashboard().locator('.sd-ring .sd-ring-n').textContent()).toBe(String(count));
    await dashboard().locator('[data-action="map-impact-kind"][data-kind="REMOVED"]').click();
    expect(await dashboard().locator('.sd-tbl tbody tr').count()).toBe(count);
    expect(
      await dashboard()
        .locator('[data-action="map-impact-kind"][data-kind="REMOVED"]')
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await dashboard().locator('[data-action="map-impact-kind"][data-kind="ALL"]').click();
    // La source inchangée (BFF) est une ligne à part, jamais confondue avec une source non lue.
    expect(
      await dashboard()
        .locator('.sd-tbl tbody tr', { hasText: 'API Gateway' })
        .locator('.t-unchanged')
        .count(),
    ).toBe(1);
  });

  it('search and layer criteria narrow the table; a row menu opens the code evidence', async () => {
    await dashboard().locator('input[data-map="imp-q"]').fill('/companies/new');
    await expect.poll(async () => dashboard().locator('.sd-tbl tbody tr').count()).toBe(1);
    await dashboard().locator('input[data-map="imp-q"]').fill('');
    await expect.poll(async () => dashboard().locator('.sd-tbl tbody tr').count()).toBeGreaterThan(1);
    await dashboard().locator('[data-action="map-impact-filters"]').click();
    await dashboard().locator('select[data-map="imp-layer"]').selectOption('BFF');
    expect(await dashboard().locator('.sd-tbl tbody tr').count()).toBe(1);
    await dashboard().locator('select[data-map="imp-layer"]').selectOption('');
    await dashboard().locator('.sd-tbl tbody tr').first().locator('.sd-menu > summary').click();
    await dashboard().locator('.sd-tbl tbody tr').first().locator('[data-action="map-evidence"]').click();
    await dashboard().locator('.map-ev pre.map-code').waitFor();
    await dashboard().locator('[data-action="map-evidence-close"]').click();
  });

  it('swapping the scans, and refusing to compare a scan with itself', async () => {
    const from = dashboard().locator('select[data-map="impact-from"]');
    const to = dashboard().locator('select[data-map="impact-to"]');
    const [a, b] = [await from.inputValue(), await to.inputValue()];
    await dashboard().locator('[data-action="map-impact-swap"]').click();
    expect([await from.inputValue(), await to.inputValue()]).toEqual([b, a]);
    // Le scan comparé est maintenant « a » : le choisir aussi comme référence est refusé.
    await from.selectOption(a);
    expect(await dashboard().locator('[data-action="map-impact"]').isDisabled()).toBe(true);
    expect(await dashboard().locator('.sd-cmp [role="alert"]').textContent()).toContain(
      'deux scans différents',
    );
    await from.selectOption(b);
    await dashboard().locator('[data-action="map-impact"]').click();
    await dashboard().locator('.sd-detail').waitFor();
  });
});
