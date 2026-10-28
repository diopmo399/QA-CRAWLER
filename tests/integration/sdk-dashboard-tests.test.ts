import { spawnSync } from 'node:child_process';
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
 * L'ÉCRAN TESTS GÉNÉRÉS DANS CHROMIUM, sur un vrai serveur SDK, avec un parcours enregistré par le vrai
 * recorder : générer depuis l'écran, lire les fichiers, puis exécuter pour de vrai — le flow YAML rejoué
 * par le moteur (son rapport s'ouvre), le test Playwright lancé par Playwright Test — et voir les cas
 * rapportés par l'outil. Java : exécuté par Maven quand il est sur la machine, sinon le bouton reste
 * inactif avec la raison. Sur téléphone, rien ne déborde.
 */
const NAME = 'ouvrir-une-fiche';
let site: TestSite;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const card = (format: string): Locator => dashboard().locator(`.tst-fmt[data-format="${format}"]`);
const firstRun = (): Locator => dashboard().locator('.tst-run').first();

const mavenAvailable = spawnSync('mvn', ['-v']).status === 0 && spawnSync('java', ['-version']).status === 0;

const human: NonNullable<RecordRequest['drive']> = async ({ page: recorded }) => {
  const pause = (): Promise<void> => recorded.waitForTimeout(500);
  await pause();
  await recorded.getByRole('link', { name: 'Utilisateurs' }).click();
  await recorded.waitForURL('**/users');
  await pause();
  await recorded.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await recorded.waitForURL('**/users/1');
  await pause();
};

/** Attend que la dernière exécution soit terminée, et rend son statut affiché. */
async function settled(): Promise<string> {
  await expect
    .poll(async () => firstRun().getAttribute('data-status'), { timeout: 240_000, interval: 500 })
    .not.toMatch(/^(QUEUED|RUNNING)$/);
  return (await firstRun().getAttribute('data-status')) ?? '';
}

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-tests-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Fiches', targetUrl: `${site.url}/`, framework: 'other' },
  });
  await client.recordings.start(project.id, { name: 'Ouvrir une fiche' });
  await client.recordings.subscribe(project.id, NAME, () => undefined).done;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="tests"]').click();
  await dashboard().locator('h1', { hasText: 'Tests générés' }).waitFor({ timeout: 15_000 });
}, 240_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — generated tests in Chromium', () => {
  it('shows the recording; before any generation, nothing can be run and the screen says why', async () => {
    expect(await dashboard().locator('select[data-tst="recording"]').inputValue()).toBe(NAME);
    await card('yaml').waitFor();
    expect(await card('yaml').locator('[data-action="tst-run"]').isDisabled()).toBe(true);
    expect(await card('yaml').textContent()).toContain('Pas encore généré');
    expect(await card('yaml').textContent()).toContain('SafetyPolicy');
    expect(await dashboard().locator('.card', { hasText: 'Exécutions' }).textContent()).toContain(
      'Aucune exécution',
    );
  });

  it('generates the chosen formats from the screen; the files keep their generation status', async () => {
    await dashboard().locator('input[data-tst="format"][value="gherkin"]').check();
    expect(await dashboard().locator('input[data-tst="format"]:checked').count()).toBe(3);
    await dashboard().locator('form[data-action="tst-generate"] button[type="submit"]').click();
    await dashboard().locator('p.ok', { hasText: 'fichier(s) générés' }).waitFor({ timeout: 60_000 });
    const files = dashboard().locator('.tst-file');
    const paths = await files.locator('code').allTextContents();
    expect(paths).toEqual(
      expect.arrayContaining([
        `${NAME}.flow.yaml`,
        `${NAME}.feature`,
        `playwright/${NAME}.spec.ts`,
        'playwright/playwright.config.ts',
      ]),
    );
    expect(await dashboard().locator('.tst-files').textContent()).not.toMatch(/Réussi|Échoué/);
    await dashboard().locator(`[data-action="tst-file"][data-path="playwright/${NAME}.spec.ts"]`).click();
    await dashboard().locator('.tst-file-b .tst-code').waitFor();
    expect(await dashboard().locator('.tst-file-b .tst-code').textContent()).toContain('@playwright/test');
    expect(await card('yaml').locator('[data-action="tst-run"]').isDisabled()).toBe(false);
  });

  it('runs the flow YAML with the engine: followed live, PASSED with its case, and its report opens', async () => {
    await card('yaml').locator('[data-action="tst-run"]').click();
    await dashboard().locator('p.ok', { hasText: 'Exécution Flow YAML lancée' }).waitFor({ timeout: 15_000 });
    expect(await settled()).toBe('PASSED');
    const run = firstRun();
    expect(await run.locator('.tst-run-h').textContent()).toContain(
      '1 réussi(s), 0 échoué(s), 0 ignoré(s) sur 1',
    );
    // L'exécution lancée s'ouvre : l'outil, la cible, le cas joué.
    await run.locator('.tst-run-b').waitFor();
    expect(await run.locator('.tst-run-b').textContent()).toContain('QA-CRAWLER');
    expect(await run.locator('.tst-cases li').count()).toBe(1);
    expect(await card('yaml').textContent()).toContain('Dernière exécution');
    const [report] = await Promise.all([
      page.context().waitForEvent('page'),
      run.locator('[data-action="tst-report"]').click(),
    ]);
    await report.waitForLoadState();
    expect(report.url()).toContain('/reports/');
    expect(await report.title()).not.toBe('');
    await report.close();
  });

  it('runs the Playwright test with Playwright Test: PASSED, read from its JUnit XML', async () => {
    await card('playwright').locator('[data-action="tst-run"]').click();
    await dashboard()
      .locator('p.ok', { hasText: 'Exécution Playwright TypeScript lancée' })
      .waitFor({ timeout: 15_000 });
    expect(await settled()).toBe('PASSED');
    const run = firstRun();
    expect(await run.locator('.tst-run-h').textContent()).toContain('Playwright TypeScript');
    expect(await run.locator('.tst-run-b').textContent()).toContain('Playwright Test');
    expect(await run.locator('[data-action="tst-report"]').count()).toBe(0);
    expect(await dashboard().locator('.tst-run').count()).toBe(2);
  });

  it('Java: run by Maven when it is on the machine, otherwise refused with the reason', async () => {
    if (!mavenAvailable) {
      expect(await card('java').locator('[data-action="tst-run"]').isDisabled()).toBe(true);
      expect(await card('java').textContent()).toContain('Maven (mvn) is not available');
      return;
    }
    await dashboard().locator('input[data-tst="format"][value="java"]').check();
    await dashboard().locator('form[data-action="tst-generate"] button[type="submit"]').click();
    await dashboard().locator('p.ok', { hasText: 'fichier(s) générés' }).waitFor({ timeout: 300_000 });
    await card('java').locator('[data-action="tst-run"]').click();
    await dashboard()
      .locator('p.ok', { hasText: 'Exécution Java JUnit 5 + Playwright lancée' })
      .waitFor({ timeout: 15_000 });
    // Sans accès au dépôt Maven, les dépendances manquent : ERROR, jamais PASSED.
    expect(['PASSED', 'ERROR']).toContain(await settled());
    expect(await firstRun().locator('.tst-run-h').textContent()).toContain('Java JUnit 5');
  }, 600_000);

  it('on a phone, nothing overflows and the format cards stack', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="tests"]').click();
    await element.locator('.tst-fmt[data-format="gherkin"]').waitFor({ timeout: 15_000 });
    const yaml = await element.locator('.tst-fmt[data-format="yaml"]').boundingBox();
    const gherkin = await element.locator('.tst-fmt[data-format="gherkin"]').boundingBox();
    expect((gherkin?.y ?? 0) >= (yaml?.y ?? 0) + (yaml?.height ?? 0)).toBe(true);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await phone.close();
  });
});
