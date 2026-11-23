import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * L'ÉCRAN « QUALITÉ → RISQUES D'ANOMALIES » DANS CHROMIUM, avec le vrai serveur et le vrai scanner sur la
 * fixture des risques (front Angular + backend Spring) : entrée du menu, indicateurs, critères, détail en
 * sections, graphe d'impact, simulation, test déclaré, suppression justifiée et désactivation d'une règle.
 */
const FIXTURE = path.resolve('tests/fixtures/risk');
const SHOTS = process.env.QA_SHOTS;
let server: RunningSdkServer;
let workspace: string;
let sourcesRoot: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const risks = (): Locator => dashboard().locator('[data-risks]');
const row = (text: string): Locator => risks().locator('tr.rk-row', { hasText: text });

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-risks-'));
  sourcesRoot = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-risks-sources-'));
  await cp(FIXTURE, sourcesRoot, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [sourcesRoot] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Risques', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
  });
  await client.cartography.saveConfig(project.id, {
    sources: (
      [
        ['front', 'FRONTEND'],
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
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
}, 60_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(sourcesRoot, { recursive: true, force: true });
});

describe('Dashboard — Qualité → Risques d’anomalies, in Chromium', () => {
  it('opens from the Quality menu entry and shows the counts, distributions and list', async () => {
    const entry = dashboard().locator('.drawer [data-action="nav"][data-view="risks"]');
    await expect(entry.textContent()).resolves.toContain('Risques d’anomalies');
    await entry.click();
    await risks().locator('.rk-kpis').waitFor();
    await expect(entry.getAttribute('aria-current')).resolves.toBe('page');
    await expect(
      dashboard().locator('.map-tabs [data-tab="risks"]').getAttribute('aria-selected'),
    ).resolves.toBe('true');
    const total = Number(await risks().locator('[data-kpi="total"] b').textContent());
    expect(total).toBeGreaterThanOrEqual(15);
    await expect(risks().locator('.rk-dist').count()).resolves.toBe(2);
    await expect(risks().locator('.rk-table thead th').allTextContents()).resolves.toEqual([
      'Risque',
      'Catégorie',
      'Sévérité',
      'Confiance',
      'Statut',
      'Source',
      'Fonctionnalités impactées',
      'Dernière détection',
    ]);
    await expect(row('ClientStore.selected peut garder').count()).resolves.toBe(1);
    // A (remis à zéro) et C (souscription libérée) ne sont pas signalés.
    await expect(row('OrderStore.current').count()).resolves.toBe(0);
    await expect(row('SafeComponent').count()).resolves.toBe(0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'risks-list.png'), fullPage: true });
  });

  it('filters by category, status and text on the server', async () => {
    await risks().locator('select[data-map="r-category"]').selectOption('CLEANUP');
    await expect
      .poll(async () =>
        (await risks().locator('tr.rk-row').allTextContents()).every((t) => t.includes('Ressources')),
      )
      .toBe(true);
    await expect(risks().locator('tr.rk-row').count()).resolves.toBeGreaterThanOrEqual(3);
    await risks().locator('select[data-map="r-category"]').selectOption('');
    await risks().locator('select[data-map="r-status"]').selectOption('INCONCLUSIVE');
    await expect.poll(() => risks().locator('tr.rk-row').count()).toBe(1);
    await expect(risks().locator('tr.rk-row').textContent()).resolves.toContain('SessionStore.user');
    await risks().locator('select[data-map="r-status"]').selectOption('');
    await risks().locator('input[data-map="r-q"]').fill('lastClient');
    await expect.poll(() => risks().locator('tr.rk-row').count()).toBe(1);
    await risks().locator('input[data-map="r-q"]').fill('');
    await expect.poll(() => risks().locator('tr.rk-row').count()).toBeGreaterThanOrEqual(15);
  });

  it('opens a risk with its sections, evidence and impact graph', async () => {
    await row('ClientStore.selected peut garder').locator('[data-action="map-r-open"]').click();
    const detail = risks().locator('.rk-detail');
    await detail.locator('[data-sec="evidence"]').waitFor();
    const sections = await detail
      .locator('.rk-sec')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-sec')));
    for (const key of [
      'description',
      'cause',
      'conditions',
      'code',
      'evidence',
      'data',
      'features',
      'propagation',
      'impact',
      'verifications',
      'results',
      'suggestion',
      'limits',
      'confidence',
    ])
      expect(sections).toContain(key);
    await expect(detail.locator('.rk-dh').textContent()).resolves.toContain('Corroboré');
    await expect(detail.locator('[data-sec="features"]').textContent()).resolves.toContain('Contrat');
    const graph = detail.locator('[data-rk-graph] svg');
    await expect(graph.locator('.rk-n.r-feature').count()).resolves.toBeGreaterThanOrEqual(1);
    await expect(graph.locator('.rk-n.r-consumer').count()).resolves.toBeGreaterThanOrEqual(1);
    await expect(graph.locator('[data-link]').count()).resolves.toBeGreaterThanOrEqual(2);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'risks-detail.png'), fullPage: true });
    if (SHOTS)
      await detail.locator('[data-sec="impact"]').screenshot({ path: path.join(SHOTS, 'risks-impact.png') });
  });

  it('runs a simulation, then records a declared external test that reproduces the risk', async () => {
    const detail = risks().locator('.rk-detail');
    await detail.locator('[data-action="map-r-verify"]').click();
    await expect.poll(() => detail.locator('.rk-ver').count()).toBe(1);
    // Sans attendu métier, la simulation de l'état conservé reste inconclusive.
    await expect(detail.locator('.rk-ver').first().textContent()).resolves.toContain('Inconclusif');
    await detail.locator('[data-action="map-r-form"][data-form="test"]').click();
    const form = detail.locator('form[data-action="map-r-test"]');
    await form.locator('select[name="outcome"]').selectOption('REPRODUCED');
    await form.locator('textarea[name="observed"]').fill('Le contrat du client précédent reste affiché.');
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => detail.locator('.rk-ver').count()).toBe(2);
    await expect(detail.locator('.rk-dh').textContent()).resolves.toContain('Reproduit');
    await expect(row('ClientStore.selected peut garder').textContent()).resolves.toContain('Reproduit');
    const reproduced = Number(await risks().locator('[data-kpi="reproduced"] b').textContent());
    expect(reproduced).toBe(1);
  });

  it('suppresses a risk with a reason and hides it from the default list', async () => {
    await row('ContractService.read ignore').locator('[data-action="map-r-open"]').click();
    const detail = risks().locator('.rk-detail');
    await detail.locator('[data-action="map-r-form"][data-form="suppress"]').waitFor();
    await detail.locator('[data-action="map-r-form"][data-form="suppress"]').click();
    await detail.locator('textarea[name="reason"]').fill('Comportement voulu : la lecture tolère l’absence.');
    await detail.locator('form[data-action="map-r-suppress"] button[type="submit"]').click();
    await expect.poll(() => detail.locator('[role="note"]').count()).toBe(1);
    await expect.poll(() => row('ContractService.read ignore').count()).toBe(0);
    await risks().locator('input[data-map="r-suppressed"]').check();
    await expect.poll(() => row('ContractService.read ignore').count()).toBe(1);
    await expect(row('ContractService.read ignore').getAttribute('class')).resolves.toContain('sup');
    await risks().locator('input[data-map="r-suppressed"]').uncheck();
  });

  it('disables a rule: its risks disappear on the next computation', async () => {
    await risks().locator('.rk-rules summary').click();
    const rule = risks().locator('input[data-map="r-rule"][value="RISK-CLEAN-002"]');
    await rule.uncheck();
    await expect.poll(() => row('setInterval').count()).toBe(0);
    await expect(
      risks().locator('input[data-map="r-rule"][value="RISK-CLEAN-002"]').isChecked(),
    ).resolves.toBe(false);
    await risks().locator('input[data-map="r-rule"][value="RISK-CLEAN-002"]').check();
    await expect.poll(() => row('setInterval').count()).toBe(1);
  });

  it('returns to the cartography from the menu and leaves the risks tab', async () => {
    await dashboard().locator('.drawer [data-action="nav"][data-view="cartography"]').click();
    await expect
      .poll(() => dashboard().locator('.map-tabs [data-tab="overview"]').getAttribute('aria-selected'))
      .toBe('true');
    await expect(
      dashboard().locator('.drawer [data-view="cartography"]').getAttribute('aria-current'),
    ).resolves.toBe('page');
  });
});
