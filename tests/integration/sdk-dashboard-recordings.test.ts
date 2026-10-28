import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LES ENREGISTREMENTS DANS LE DASHBOARD, DANS CHROMIUM, avec le vrai recorder : le Dashboard démarre
 * l'enregistrement d'un parcours ; une personne (simulée par le test, navigateur sans fenêtre) le joue ;
 * le Dashboard suit les gestes en direct, puis liste l'enregistrement (étapes, rejeu de validation),
 * donne le lien vers le Flow Studio et le promeut en scénario.
 */
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;

const human: NonNullable<RecordRequest['drive']> = async ({ page: app }) => {
  const pause = (): Promise<void> => app.waitForTimeout(700);
  await app.waitForTimeout(2500);
  await app.getByRole('link', { name: 'Utilisateurs' }).click();
  await app.waitForURL('**/users');
  await pause();
  await app.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await app.waitForURL('**/users/1');
  await pause();
  await app.getByRole('link', { name: 'Accueil' }).click();
  await app.waitForURL((url) => url.pathname === '/');
  await pause();
};

const dashboard = (): Locator => page.locator('qa-crawler-dashboard');

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-rec-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Site de démo', targetUrl: `${site.url}/`, framework: 'other' },
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
}, 120_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — recordings, in Chromium', () => {
  it('starts a recording, follows the gestures live, then lists it with its validation replay', async () => {
    await page.goto(`${server.url}/dashboard`);
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('.drawer [data-action="nav"][data-view="recordings"]').click();
    await dashboard().locator('[data-action="start-recording"]').click();
    expect(await dashboard().locator('.rec-form [role="alert"]').textContent()).toBe(
      'Donnez un nom au parcours.',
    );
    await dashboard().locator('input[data-rec="name"]').fill('Consulter un utilisateur');
    await dashboard().locator('[data-action="start-recording"]').click();
    const live = dashboard().locator('.live-rec');
    await live.waitFor({ timeout: 30_000 });
    expect(await live.textContent()).toContain('consulter-un-utilisateur');
    await live.locator('[data-action="stop-recording"]').waitFor();
    await live.locator('.rec-events li').first().waitFor({ timeout: 60_000 });
    await live.waitFor({ state: 'detached', timeout: 180_000 });
    const row = dashboard().locator('.tbl tbody tr', { hasText: 'consulter-un-utilisateur' });
    await row.waitFor();
    expect(await row.locator('.pill').first().textContent()).toBe('Terminé');
    const [listed] = await client.recordings.list(project.id);
    expect(listed?.summary?.steps).toBeGreaterThan(0);
    expect(Number(await row.locator('td').nth(1).textContent())).toBe(listed?.summary?.steps);
    expect(await row.locator('a', { hasText: 'Ouvrir dans le Flow Studio' }).getAttribute('href')).toBe(
      `/studio?project=${project.id}&recording=consulter-un-utilisateur`,
    );
  }, 300_000);

  it('promotes it to a scenario', async () => {
    await dashboard().locator('[data-action="promote"][data-recording="consulter-un-utilisateur"]').click();
    await dashboard().locator('h1', { hasText: 'Scénarios' }).waitFor({ timeout: 30_000 });
    expect((await client.scenarios.list(project.id)).map((scenario) => scenario.fromRecording)).toContain(
      'consulter-un-utilisateur',
    );
  }, 60_000);

  it('on a phone: the recordings screen never scrolls sideways', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('.kpis').waitFor();
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('h1', { hasText: 'Site de démo' }).waitFor();
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="recordings"]').click();
    await element.locator('.tbl').waitFor();
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await phone.close();
  }, 60_000);
});
