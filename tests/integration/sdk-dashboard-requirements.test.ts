import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { buildDocx, wp } from '../fixtures/office-builder.js';

/**
 * LES EXIGENCES DANS LE DASHBOARD, DANS CHROMIUM, avec le vrai serveur : un vrai .docx (fictif) choisi
 * dans le champ fichier est lu par le serveur ; les candidats sont décidés puis publiés ; un lien de
 * test est ajouté à la main ; la matrice, son export CSV, les indicateurs et les tendances en tiennent
 * compte. Une page Confluence dont la variable du jeton manque échoue, dite telle quelle.
 */
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;

const SPEC = buildDocx(
  [
    wp('Gestion des demandes', { style: 'Heading1' }),
    wp('Exigences', { style: 'Heading2' }),
    wp('REQ-501 Le système doit enregistrer une demande avec son titre.'),
    wp('Critères d’acceptation', { style: 'Heading2' }),
    wp('CA-51 Étant donné un titre vide, quand on enregistre, alors la demande est refusée.'),
  ].join(''),
  { title: 'Spécification fictive', modified: '2026-10-20T08:30:00Z' },
);

const dashboard = (): Locator => page.locator('qa-crawler-dashboard');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-req-'));
  server = await startSdkServer({ workspace, language: 'fr', env: {} });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
}, 60_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — requirements, in Chromium', () => {
  it('imports a Word file chosen in the page, decides the candidates, then publishes them', async () => {
    await page.goto(`${server.url}/dashboard`);
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('.drawer [data-action="nav"][data-view="sources"]').click();
    await dashboard().locator('.conn').first().waitFor();
    expect(await dashboard().locator('.conn').count()).toBe(4);
    await dashboard().locator('[data-action="import"]').click();
    expect(await dashboard().locator('.req-form [role="alert"]').textContent()).toBe(
      'Choisissez un fichier.',
    );
    await dashboard().locator('input[data-req="file"]').setInputFiles({
      name: 'spec.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: SPEC,
    });
    await dashboard().locator('[data-action="import"]').click();
    await dashboard().locator('h1', { hasText: 'Valider un import' }).waitFor({ timeout: 30_000 });
    expect(await dashboard().locator('.cand').count()).toBe(2);
    expect(await dashboard().locator('.hd').textContent()).toContain('0 décidé(s) sur 2');
    for (const id of ['REQ-501', 'CA-51']) {
      const card = dashboard().locator('.cand', {
        has: page.locator('.cand-h code', { hasText: new RegExp(`^${id}$`) }),
      });
      await card.locator('[data-decision="ACCEPT"]').click();
      await card.locator('p', { hasText: 'Décision : acceptée' }).waitFor();
    }
    expect((await client.requirements.get(project.id)).entities).toHaveLength(0);
    await dashboard().locator('[data-action="publish"]').click();
    await dashboard()
      .locator('.notice', { hasText: 'Publié : 2 créé(s), 0 mis à jour, 0 fusionné(s).' })
      .waitFor();
    const repository = await client.requirements.get(project.id);
    expect(repository.entities.map((entity) => entity.externalId)).toEqual(['REQ-501', 'CA-51']);
  }, 90_000);

  it('the repository: an item opened, a test link added by hand with its justification', async () => {
    await dashboard().locator('.drawer [data-action="nav"][data-view="requirements"]').click();
    await dashboard().locator('.ent', { hasText: 'REQ-501' }).click();
    await dashboard().locator('[data-action="link-open"]').click();
    await dashboard().locator('input[data-link-field="targetId"]').fill('create-request');
    await dashboard().locator('[data-action="link-add"]').click();
    expect(await dashboard().locator('.link-form [role="alert"]').textContent()).toContain('justification');
    await dashboard()
      .locator('textarea[data-link-field="justification"]')
      .fill('Le scénario enregistre une demande.');
    await dashboard().locator('[data-action="link-add"]').click();
    await dashboard().locator('.notice', { hasText: 'Lien ajouté et confirmé.' }).waitFor();
    expect(await dashboard().locator('.lk', { hasText: 'TEST:create-request' }).textContent()).toContain(
      'confirmé',
    );
  }, 60_000);

  it('the matrix shows the link and exports a CSV; the indicators and trends count it', async () => {
    await dashboard().locator('.drawer [data-action="nav"][data-view="traceability"]').click();
    const row = dashboard().locator('.mtx tbody tr', {
      has: page.locator('th code', { hasText: /^REQ-501$/ }),
    });
    await row.waitFor();
    expect(await row.locator('.mx.on').textContent()).toBe('create-request');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dashboard().locator('[data-action="export-csv"]').click(),
    ]);
    const csv = await readFile(await download.path(), 'utf8');
    expect(csv).toContain('"REQ-501"');
    expect(csv).toContain('TEST:create-request (CONFIRMED)');

    await dashboard().locator('.drawer [data-action="nav"][data-view="indicators"]').click();
    const coverage = dashboard().locator('.ind', { hasText: 'Couverture par un test' });
    await coverage.waitFor();
    expect(await coverage.locator('.ind-v').textContent()).toBe('50 %1 / 2');
    expect(await dashboard().locator('.ind', { hasText: 'preuve récente' }).textContent()).toContain(
      'Non disponible',
    );

    await dashboard().locator('.drawer [data-action="nav"][data-view="trends"]').click();
    const card = dashboard().locator('.card', { hasText: 'Couverture des exigences par un test' });
    await card.locator('.bar').last().waitFor();
    expect(await card.locator('.bar').last().getAttribute('aria-label')).toContain('50 % (1 / 2)');
  }, 60_000);

  it('a Confluence page whose token variable is missing fails, and says why', async () => {
    await dashboard().locator('.drawer [data-action="nav"][data-view="sources"]').click();
    await dashboard().locator('select[data-req="source"]').selectOption('CONFLUENCE');
    await dashboard().locator('input[data-req="baseUrl"]').fill('https://wiki.example.org');
    await dashboard().locator('input[data-req="page"]').fill('123');
    await dashboard().locator('select[data-req="variant"]').selectOption('datacenter');
    await dashboard().locator('input[data-req="tokenEnv"]').fill('QA_ABSENT_TOKEN');
    await dashboard().locator('[data-action="import"]').click();
    await dashboard().locator('h1', { hasText: 'Valider un import' }).waitFor({ timeout: 30_000 });
    expect(await dashboard().locator('.hd .pill').textContent()).toBe('Échoué');
    expect(await dashboard().locator('.issue').textContent()).toContain(
      'QA_ABSENT_TOKEN is not defined on the server',
    );
    expect(await dashboard().locator('[data-action="publish"]').count()).toBe(0);
  }, 60_000);

  it('on a phone: the matrix scrolls in its frame, the page never sideways', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('.kpis').waitFor();
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('h1', { hasText: 'Demandes' }).waitFor();
    for (const view of ['traceability', 'requirements', 'sources', 'indicators']) {
      await element.locator('[data-action="menu"]').click();
      await element.locator(`.drawer [data-action="nav"][data-view="${view}"]`).click();
      await element.locator('.hd h1').waitFor();
      await element.locator('.spin').waitFor({ state: 'detached' });
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, view).toBeLessThanOrEqual(0);
    }
    await phone.close();
  }, 60_000);
});
