import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Environment,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * LE DASHBOARD DANS CHROMIUM, AVEC LE VRAI MOTEUR. La page /dashboard du serveur SDK : la vue
 * d'ensemble lit les rejeux écrits sur disque ; un rejeu lancé depuis le Dashboard est suivi en direct
 * puis lu (verdict, étapes, assertion) ; un autre est annulé après confirmation (le moteur s'arrête
 * avant l'écriture) ; l'archivage se confirme et ferme le lancement, la restauration le rouvre.
 */
let app: QualityApp;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let recette: Environment;
let browser: Browser;
let page: Page;

const FLOW = `name: create-request
startAt: /
steps:
  - expect: { url: / }
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: Title from the Dashboard }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { url: /requests/ }
assertions:
  - id: title-saved
    description: The server returns the title typed
    check: { kind: value, source: response, method: POST, path: /api/requests, field: title, expected: { value: Title from the Dashboard } }
`;

const dashboard = (): Locator => page.locator('qa-crawler-dashboard');

async function replayed(): Promise<void> {
  const started = await client.executions.start(project.id, { environmentId: recette.id });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = (await client.explorations.status(started.id)).status;
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the replay did not finish');
}

beforeAll(async () => {
  app = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: `${app.url}/`, framework: 'other' },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'create-request.flow.yaml'), FLOW);
  recette = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 5 },
  });
  await replayed();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
}, 150_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — real engine, in Chromium', () => {
  it('the overview reads the replay written on disk, with its rate explained', async () => {
    await page.goto(`${server.url}/dashboard`);
    const rate = dashboard().locator('.kpi.accent');
    await expect.poll(() => rate.textContent()).toContain('100 %');
    expect(await rate.textContent()).toContain('1 réussi sur 1 rejeu terminé');
    expect(await rate.textContent()).toContain('Dénominateur : rejeux terminés avec un verdict');
    expect(await dashboard().locator('.tbl tbody tr').count()).toBe(1);
  }, 60_000);

  it('starts a replay in an environment, follows it live, then reads its verdict', async () => {
    await dashboard().locator('[data-view="projects"]').click();
    await dashboard().locator('.pcard', { hasText: 'Demandes' }).click();
    await dashboard().locator('select[data-bind="environment"]').selectOption(recette.id);
    await dashboard().locator('form.launch button[type="submit"]').click();
    await dashboard().locator('.live .steps li').first().waitFor({ timeout: 60_000 });
    await dashboard().locator('.kpi.accent', { hasText: 'Réussi' }).waitFor({ timeout: 90_000 });
    const text = (await dashboard().locator('.main').textContent()) ?? '';
    expect(text).toContain('1/1 flow(s) réussi(s)');
    expect(text).toContain('Recette');
    expect(text).toContain('title-saved');
    expect(text).toContain('Vérifiée');
    expect(app.records()).toHaveLength(2);
  }, 150_000);

  it('cancels a running replay after a confirmation in the page: no write, verdict Annulé', async () => {
    const before = app.records().length;
    await dashboard().locator('[data-action="back"]').click();
    await dashboard().locator('select[data-bind="environment"]').selectOption(recette.id);
    await dashboard().locator('form.launch button[type="submit"]').click();
    await dashboard().locator('.live .steps li').first().waitFor({ timeout: 60_000 });
    await dashboard().locator('[data-action="cancel"]').click();
    await dashboard().locator('[data-action="cancel-confirm"]').click();
    await dashboard().locator('.kpi.accent', { hasText: 'Annulé' }).waitFor({ timeout: 90_000 });
    expect(app.records()).toHaveLength(before);
    const executions = await client.executions.list(project.id);
    expect(executions[0]?.verdict).toBe('CANCELLED');
  }, 150_000);

  it('the menu: the project picked in the context opens it, the executions entry lists its runs', async () => {
    await page.goto(`${server.url}/dashboard`);
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('h1', { hasText: 'Demandes' }).waitFor();
    await dashboard().locator('[data-action="nav"][data-view="executions"]').click();
    await dashboard().locator('.tbl tbody tr').first().waitFor();
    expect(await dashboard().locator('[data-view="executions"]').getAttribute('aria-current')).toBe('page');
    expect(await dashboard().locator('.tbl tbody tr').count()).toBe(3);
  }, 60_000);

  it('checks an environment with its URL from the launch tab: ready, secret names only', async () => {
    await dashboard().locator('[data-action="nav"][data-view="projects"]').click();
    await dashboard().locator('.pcard', { hasText: 'Demandes' }).click();
    const card = dashboard().locator('.env', { hasText: 'Recette' });
    await card.locator('[data-action="check-env"]').click();
    await card.locator('.checks li', { hasText: 'l’URL répond' }).waitFor({ timeout: 30_000 });
    expect(await card.locator('.pill').textContent()).toBe('Prêt');
    await dashboard().locator('[data-action="tab"][data-tab="security"]').click();
    const policy = (await dashboard().locator('[role="tabpanel"]').textContent()) ?? '';
    expect(policy).toContain('Politique de sécurité · Recette');
    expect(policy).toContain('suppression');
    expect(policy).toContain('création et modification (5 par exécution)');
  }, 60_000);

  it('on a phone: the menu folds behind a button, the page never scrolls sideways', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('.kpi.accent').waitFor();
    const menu = element.locator('[data-action="menu"]');
    expect(await menu.isVisible()).toBe(true);
    expect(await element.locator('.drawer').isVisible()).toBe(false);
    await menu.click();
    expect(await menu.getAttribute('aria-expanded')).toBe('true');
    await element.locator('[data-action="nav"][data-view="projects"]').click();
    await element.locator('.pcard').first().waitFor();
    expect(await element.locator('.drawer').isVisible()).toBe(false);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await phone.close();
  }, 60_000);

  it('archives after a confirmation (launch closed), then restores', async () => {
    await dashboard().locator('[data-action="tab"][data-tab="launch"]').click();
    await dashboard().locator('[data-action="archive"]').click();
    expect(await dashboard().locator('.confirm').textContent()).toContain('Rien n’est supprimé');
    await dashboard().locator('[data-action="archive-confirm"]').click();
    await dashboard().locator('.note', { hasText: 'Projet archivé' }).waitFor();
    expect(await dashboard().locator('form.launch').count()).toBe(0);
    expect((await client.projects.detail(project.id)).state).toBe('ARCHIVED');
    await dashboard().locator('[data-action="restore"]').click();
    await dashboard().locator('form.launch').waitFor();
    expect((await client.projects.detail(project.id)).state).toBe('ACTIVE');
  }, 60_000);
});
