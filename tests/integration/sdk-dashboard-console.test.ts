import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
 * LA CONSOLE D'EXÉCUTION DE L'ÉDITEUR, DANS CHROMIUM : de vraies exécutions lancées depuis l'éditeur (le
 * moteur pour le flow YAML, Playwright Test pour le test TypeScript), suivies en direct ; l'étape en
 * cours ; les onglets Étapes, Erreurs, Réseau et Résumé ; les critères d'affichage et la recherche ; le détail d'une
 * ligne, la copie et le téléchargement ; la pause du suivi ; l'arrêt ; une relance qui ne mélange pas
 * deux journaux ; un run fini relu après un rechargement ; le téléphone.
 */
const NAME = 'ouvrir-une-fiche';
const SPEC = `playwright/${NAME}.spec.ts`;
let site: TestSite;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const editor = (): Locator => dashboard().locator('.ed');
const consoleTab = (tab: string): Locator =>
  editor().locator(`[data-action="ed-con-tab"][data-tab="${tab}"]`);
const lines = (text?: string): Locator =>
  text ? editor().locator('.ed-log-wrap .ev', { hasText: text }) : editor().locator('.ed-log-wrap .ev');

const human: NonNullable<RecordRequest['drive']> = async ({ page: recorded }) => {
  await recorded.waitForTimeout(500);
  await recorded.getByRole('link', { name: 'Utilisateurs' }).click();
  await recorded.waitForURL('**/users');
  await recorded.waitForTimeout(500);
  await recorded.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await recorded.waitForURL('**/users/1');
  await recorded.waitForTimeout(500);
};

async function openEditor(target: Page): Promise<void> {
  await target.goto(`${server.url}/dashboard`);
  const element = target.locator('qa-crawler-dashboard');
  await element.locator('select[data-action="project-context"]').selectOption(project.id);
  await element.locator('.drawer [data-action="nav"][data-view="editor"]').click();
  await element.locator('.ed-visual .ed-step').first().waitFor({ timeout: 30_000 });
}

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-console-'));
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
  await client.generation.run(project.id, NAME, { formats: ['yaml', 'playwright'] });
  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await openEditor(page);
}, 600_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — execution console in Chromium', () => {
  it('before any run, the console says how to start one; a replay shows the real events live, the current step, then the end', async () => {
    expect(await editor().locator('.ed-con').textContent()).toContain('« Rejouer » en lance une');
    await editor().locator('.ed-top [data-action="ed-run"]').click();
    await lines('STEP_STARTED').first().waitFor({ timeout: 60_000 });
    // En direct : la ligne de début d'étape est là pendant que le moteur joue encore.
    const runs = (await client.generation.view(project.id, NAME)).runs;
    const live = runs[0];
    expect(live?.status).toBe('RUNNING');
    expect(await lines('RUN_FINISHED').count()).toBe(0);
    await lines('RUN_FINISHED').waitFor({ timeout: 120_000 });
    await editor().locator('.ed-con-conn', { hasText: 'Flux terminé' }).waitFor();
    const all = await lines().allTextContents();
    expect(all[0]).toContain('RUN_CREATED');
    expect(all.filter((text) => text.includes('STEP_FINISHED')).length).toBe(3);
    // La vue visuelle garde l'état de chaque étape dit par le moteur.
    expect(await editor().locator('.ed-visual .ed-st.ok').count()).toBe(3);
    await editor().locator('.ed-con-state', { hasText: 'Journal conservé' }).waitFor({ timeout: 10_000 });
    expect(errors).toEqual([]);
  }, 180_000);

  it('the steps tab: each step with its line and status; a click leads to the step in the visual view', async () => {
    await consoleTab('steps').click();
    const rows = editor().locator('.ed-con-table tbody tr');
    expect(await rows.count()).toBe(3);
    expect(await rows.nth(1).textContent()).toContain('Confirmée');
    await rows.nth(1).locator('.ev-at').click();
    await editor().locator('.ed-inspector h3', { hasText: 'Étape 2' }).waitFor();
    // Depuis l'étape : ses seuls événements.
    await editor().locator('.ed-inspector [data-action="ed-con-step-events"]').click();
    await lines().first().waitFor();
    const texts = await lines().allTextContents();
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((text) => text.includes('étape 2'))).toBe(true);
    await editor().locator('[data-action="ed-con-reset"]').click();
  });

  it('network and summary tabs: the requests seen by the engine per step; the run status and the cases', async () => {
    await consoleTab('network').click();
    expect(await editor().locator('.ed-con-table').textContent()).toContain('GET /users');
    await consoleTab('summary').click();
    const summary = await editor().locator('.ed-con-stats').textContent();
    expect(summary).toContain('Réussi');
    await consoleTab('console').click();
  });

  it('filters by level and text, then shows everything again; a line opens its detail', async () => {
    await lines().first().waitFor();
    const total = await lines().count();
    await editor().locator('[data-ed="con-level"][value="INFO"]').uncheck();
    await expect.poll(() => lines().count()).toBeLessThan(total);
    expect((await lines().allTextContents()).every((text) => !/\bINFO\b/.test(text))).toBe(true);
    await editor().locator('[data-ed="con-level"][value="INFO"]').check();
    await editor().locator('[data-ed="con-text"]').fill('STEP_FINISHED');
    await expect.poll(() => lines().count()).toBe(3);
    await lines().nth(1).locator('.ev-main').click();
    const detail = editor().locator('.ev-detail');
    await detail.waitFor();
    expect(await detail.textContent()).toContain('Durée');
    expect(await detail.locator('[data-action="ed-goto"]').count()).toBe(1);
    // La ligne choisie se copie.
    await editor().locator('[data-action="ed-con-copy"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('STEP_FINISHED');
    await editor().locator('[data-action="ed-con-reset"]').click();
    await expect.poll(() => lines().count()).toBe(total);
  });

  it('downloads the log in JSON and text, as kept by the server', async () => {
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      editor().locator('[data-action="ed-con-download"][data-format="json"]').click(),
    ]);
    const parsed = JSON.parse(await readFile(await json.path(), 'utf8')) as {
      run: { id: string };
      events: { type: string }[];
    };
    expect(json.suggestedFilename()).toMatch(/^qa-crawler-tr-.*\.json$/);
    expect(parsed.events.at(-1)?.type).toBe('RUN_FINISHED');
    const [text] = await Promise.all([
      page.waitForEvent('download'),
      editor().locator('[data-action="ed-con-download"][data-format="text"]').click(),
    ]);
    expect(await readFile(await text.path(), 'utf8')).toContain(`# QA-CRAWLER run ${parsed.run.id}`);
  });

  it('pause holds the new lines (counted), resume shows them; a new run never mixes with the previous one', async () => {
    const before = await editor().locator('select[data-ed="con-run"]').inputValue();
    await editor().locator('[data-action="ed-con-pause"]').click();
    await editor().locator('.ed-top [data-action="ed-run"]').click();
    await editor().locator('[data-log-unseen]:not([hidden])').waitFor({ timeout: 60_000 });
    expect(await lines().count()).toBe(0);
    await editor().locator('[data-action="ed-con-pause"]').click();
    await lines('RUN_CREATED').first().waitFor();
    await lines('RUN_FINISHED').waitFor({ timeout: 120_000 });
    expect(await lines('RUN_CREATED').count()).toBe(1);
    expect(await lines('RUN_FINISHED').count()).toBe(1);
    expect(await editor().locator('select[data-ed="con-run"]').inputValue()).not.toBe(before);
  }, 180_000);

  it('stop: requested, then confirmed by the engine; the run is cancelled, the rest not run', async () => {
    await editor().locator('.ed-top [data-action="ed-run"]').click();
    await lines('STEP_STARTED').first().waitFor({ timeout: 60_000 });
    await editor().locator('[data-action="ed-con-stop"]').click();
    await lines('CANCEL_REQUESTED').waitFor({ timeout: 30_000 });
    await lines('CANCEL_CONFIRMED').waitFor({ timeout: 60_000 });
    await lines('RUN_FINISHED').waitFor({ timeout: 60_000 });
    expect(await lines('RUN_FINISHED').textContent()).toContain('CANCELLED');
    expect(await lines('Non exécutée').count()).toBeGreaterThan(0);
  }, 180_000);

  it('a failing Playwright test: the error with its family, then a click leads to its line in the source', async () => {
    const view = await client.generation.view(project.id, NAME);
    const spec = view.files.find((file) => file.path === SPEC);
    if (!spec?.content || !spec.revision) throw new Error('no spec');
    const broken = spec.content.replace(
      'toHaveURL(new RegExp("/users/[^/]+"))',
      'toHaveURL(new RegExp("/nulle-part"))',
    );
    const line = broken.split('\n').findIndex((text) => text.includes('/nulle-part')) + 1;
    await client.generation.editFile(project.id, NAME, {
      path: SPEC,
      content: broken,
      revision: spec.revision,
    });
    await openEditor(page);
    await editor().locator(`.ed-tree [data-action="ed-open"][data-path="${SPEC}"]`).click();
    await editor().locator('.cm-editor').waitFor({ timeout: 30_000 });
    await editor().locator('.ed-top [data-action="ed-run"]').click();
    await lines('RUN_FINISHED').waitFor({ timeout: 120_000 });
    await consoleTab('errors').click();
    const list = editor().locator('.ed-con-errors');
    await list.waitFor();
    expect(await list.textContent()).toContain('Vérification échouée');
    await list
      .locator('.ev-at', { hasText: `ligne ${String(line)}` })
      .first()
      .click();
    await expect
      .poll(() => editor().locator('.cm-lineNumbers .cm-activeLineGutter').textContent())
      .toBe(String(line));
    // Le reporter de Playwright Test ne voit ni le réseau ni le navigateur : pas d'onglet pour eux.
    expect(await consoleTab('network').count()).toBe(0);
  }, 180_000);

  it('the console spans the editor: its handle sets its height (mouse and keyboard), it maximizes and comes back', async () => {
    await consoleTab('console').click();
    const panel = editor().locator('[data-con-panel]');
    const body = editor().locator('.ed-body');
    const explorer = editor().locator('.ed-explorer');
    // Sous les trois colonnes, sur toute leur largeur.
    const [panelBox, bodyBox] = [await panel.boundingBox(), await body.boundingBox()];
    expect(Math.abs((panelBox?.width ?? 0) - (bodyBox?.width ?? 0))).toBeLessThanOrEqual(1);
    const handle = editor().locator('[data-con-split]');
    const box = await handle.boundingBox();
    if (!box || !panelBox) throw new Error('no handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 });
    await page.mouse.up();
    const taller = (await panel.boundingBox())?.height ?? 0;
    expect(taller).toBeGreaterThan(panelBox.height + 100);
    // La hauteur choisie survit au rendu suivant (un autre onglet, puis retour).
    await consoleTab('summary').click();
    await consoleTab('console').click();
    expect(Math.abs(((await panel.boundingBox())?.height ?? 0) - taller)).toBeLessThanOrEqual(2);
    await handle.focus();
    await page.keyboard.press('ArrowDown');
    expect((await panel.boundingBox())?.height ?? 0).toBeLessThan(taller - 30);
    // Agrandie : les colonnes s'effacent, le journal reste ; réduite : elles reviennent.
    await editor().locator('[data-action="ed-con-max"]').click();
    await expect.poll(() => explorer.isVisible()).toBe(false);
    expect((await panel.boundingBox())?.height ?? 0).toBeGreaterThan(500);
    expect(await lines().count()).toBeGreaterThan(0);
    await editor().locator('[data-action="ed-con-max"]').click();
    await expect.poll(() => explorer.isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('a finished run is read back after a reload, without running anything', async () => {
    const runs = (await client.generation.view(project.id, NAME)).runs.length;
    await openEditor(page);
    await lines('RUN_FINISHED').waitFor({ timeout: 30_000 });
    expect(await editor().locator('.ed-con-state').textContent()).toContain('Journal conservé');
    expect((await client.generation.view(project.id, NAME)).runs.length).toBe(runs);
  });

  it('on a phone: the console fits, nothing overflows the page', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="editor"]').click();
    await element.locator('.ed-log-wrap .ev').first().waitFor({ timeout: 30_000 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await phone.close();
    expect(errors).toEqual([]);
  });
});
