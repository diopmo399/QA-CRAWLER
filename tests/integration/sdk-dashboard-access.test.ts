import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LES ACCÈS DANS LE DASHBOARD, DANS CHROMIUM, en mode nominatif : la page ne porte aucun jeton ; un
 * jeton inconnu est refusé ; un lecteur ne se voit proposer aucune action ; un administrateur crée un
 * membre (jeton montré une fois), lui donne un rôle propre au projet, le révoque après confirmation,
 * et lit le journal.
 */
let server: RunningSdkServer;
let workspace: string;
let service: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
let readerToken = '';

const dashboard = (): Locator => page.locator('qa-crawler-dashboard');

async function signIn(token: string): Promise<void> {
  await dashboard().locator('input[data-bind="token"]').fill(token);
  await dashboard().locator('form[data-action="sign-in"] button[type="submit"]').click();
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-access-'));
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  service = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await service.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  readerToken = (await service.access.createMember({ name: 'Noa P.', role: 'READER' })).token;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
}, 60_000);

afterAll(async () => {
  await browser.close();
  service.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — named access, in Chromium', () => {
  it('asks for a personal token, refuses an unknown one, signs a reader in with view rights only', async () => {
    await page.goto(`${server.url}/dashboard`);
    expect(await page.content()).not.toContain(server.token);
    await signIn('qa_not-a-real-token');
    await dashboard().locator('[role="alert"]', { hasText: 'Jeton refusé' }).waitFor();
    await signIn(readerToken);
    await dashboard().locator('.kpis').waitFor();
    expect(await dashboard().locator('.foot .who').textContent()).toBe('Connecté : Noa P. · Lecteur');
    expect(await dashboard().locator('[data-action="launch-shortcut"]').count()).toBe(0);
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('[role="tabpanel"]', { hasText: 'pas de lancer une exécution' }).waitFor();
    expect(await dashboard().locator('form.launch').count()).toBe(0);
    await dashboard().locator('.drawer [data-action="nav"][data-view="access"]').click();
    await dashboard().locator('.card', { hasText: 'réservés à l’administration' }).waitFor();
  }, 60_000);

  it('signing out forgets the token of the tab', async () => {
    await dashboard().locator('[data-action="sign-out"]').click();
    await dashboard().locator('input[data-bind="token"]').waitFor();
    expect(await page.evaluate(() => sessionStorage.getItem('qa-crawler-token'))).toBeNull();
    await page.reload();
    await dashboard().locator('input[data-bind="token"]').waitFor();
  }, 30_000);

  it('the administrator creates a member, sees the token once, sets a project role, revokes, reads the journal', async () => {
    await signIn(server.token);
    await dashboard().locator('.kpis').waitFor();
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('.drawer [data-action="nav"][data-view="access"]').click();
    await dashboard().locator('.member-form').waitFor();
    await dashboard().locator('input[data-member-field="name"]').fill('CI nocturne');
    await dashboard().locator('select[data-member-field="role"]').selectOption('ANALYST');
    await dashboard().locator('[data-action="create-member"]').click();
    const token = (await dashboard().locator('.tok').textContent()) ?? '';
    expect(token).toMatch(/^qa_/);
    const ci = (await service.access.members()).find((member) => member.name === 'CI nocturne');
    expect(ci?.role).toBe('ANALYST');
    await dashboard().locator('[data-action="hide-token"]').click();
    expect(await dashboard().locator('.tok').count()).toBe(0);

    await dashboard()
      .locator(`select[data-member-project-role="${ci?.id ?? ''}"]`)
      .selectOption('PILOT');
    await expect
      .poll(async () => (await service.access.members()).find((member) => member.id === ci?.id)?.projects)
      .toEqual({ [project.id]: 'PILOT' });

    await dashboard()
      .locator(`[data-action="revoke"][data-member="${ci?.id ?? ''}"]`)
      .click();
    await dashboard()
      .locator(`[data-action="revoke-confirm"][data-member="${ci?.id ?? ''}"]`)
      .click();
    await expect
      .poll(async () => (await service.access.members()).find((member) => member.id === ci?.id)?.revokedAt)
      .toBeDefined();
    expect(
      await createQaCrawler({ endpoint: `${server.url}/api`, token })
        .projects.list()
        .catch(() => 'refused'),
    ).toBe('refused');

    await dashboard().locator('[data-action="journal-kind"][data-kind="ACCESS"]').click();
    const journal = dashboard().locator('.card:has(.chips)');
    await journal.locator('tbody tr').first().waitFor();
    const text = (await journal.textContent()) ?? '';
    expect(text).toContain('access.members.revoke');
    expect(text).not.toContain(token);
  }, 60_000);

  it('on a phone: the access screen never scrolls sideways', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await dashboard().locator('.rights').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }, 30_000);
});
