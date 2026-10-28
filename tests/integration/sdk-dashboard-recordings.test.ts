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

/**
 * La personne joue le parcours ; le test, côté Dashboard, pose une pause, une vérification et annule un
 * geste pendant ce temps. Les deux se donnent la main par ces signaux.
 */
const signal = (): { wait: Promise<void>; go: () => void } => {
  let go: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    go = resolve;
  });
  return { wait, go };
};
const firstClickDone = signal();
const dashboardChecked = signal();
const lastClickDone = signal();
const undoDone = signal();

const human: NonNullable<RecordRequest['drive']> = async ({ page: app }) => {
  const pause = (): Promise<void> => app.waitForTimeout(700);
  await app.waitForTimeout(2500);
  await app.getByRole('link', { name: 'Utilisateurs' }).click();
  await app.waitForURL('**/users');
  await pause();
  firstClickDone.go();
  await dashboardChecked.wait;
  await app.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await app.waitForURL('**/users/1');
  await pause();
  await app.getByRole('link', { name: 'Accueil' }).click();
  await app.waitForURL((url) => url.pathname === '/');
  await pause();
  lastClickDone.go();
  await undoDone.wait;
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
    // La correction de cible : sans fenêtre ; « l'humain » désigne le lien dans la page tenue, à la souris.
    correction: {
      headless: true,
      drive: async (held) => {
        await held.waitForFunction(
          () => document.documentElement.getAttribute('data-qa-crawler-overlay-picking') === 'true',
          undefined,
          { timeout: 15_000 },
        );
        const box = await held.getByRole('link', { name: 'Utilisateurs' }).boundingBox();
        if (!box) throw new Error('no box for the link');
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await held.mouse.move(x - 20, y - 5);
        await held.mouse.move(x, y, { steps: 4 });
        await held.waitForTimeout(150);
        await held.mouse.click(x, y);
      },
    },
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
  it('starts a recording, drives it from the recording bar, then lists it with its validation replay', async () => {
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
    await firstClickDone.wait;
    // Les gestes en phrases, jamais les messages bruts du recorder (repliés dans le journal technique).
    const steps = live.locator('.live-step');
    await expect.poll(() => steps.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await steps.last().locator('b').textContent()).toContain('Utilisateurs');
    expect(await live.locator('details.tech').getAttribute('open')).toBeNull();
    // Pause puis reprise, depuis le Dashboard.
    await live.locator('[data-control="pause"]').click();
    await live.locator('.pill', { hasText: 'En pause' }).waitFor({ timeout: 15_000 });
    await live.locator('[data-control="resume"]').click();
    await live.locator('[data-control="pause"]').waitFor({ timeout: 15_000 });
    // Une vérification posée sur l'écran courant.
    await live.locator('input[data-rec="checkpoint"]').fill('La liste des utilisateurs est affichée');
    await live.locator('form.rec-check button[type="submit"]').click();
    await live
      .locator('.rec-checks li', { hasText: 'La liste des utilisateurs est affichée' })
      .waitFor({ timeout: 15_000 });
    dashboardChecked.go();
    await lastClickDone.wait;
    await expect.poll(() => steps.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    const before = await steps.count();
    expect(await steps.last().locator('b').textContent()).toContain('Accueil');
    // Le dernier geste (Accueil) retiré de l'enregistrement.
    await live.locator('[data-control="undo"]').click();
    await expect.poll(() => steps.count(), { timeout: 15_000 }).toBe(before - 1);
    expect(await steps.last().locator('b').textContent()).not.toContain('Accueil');
    undoDone.go();
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
    // Le geste annulé n'est pas dans le flow ; la vérification posée y est (une attente sur l'écran).
    const flow = await client.recordings.flow(project.id, 'consulter-un-utilisateur');
    expect(flow.yaml).not.toContain('name: Accueil');
    expect(flow.yaml).toContain('# MANUAL_CHECKPOINT');
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

  it('reviews it in the Dashboard: group, rename, decide, generate, replay for real, remove a step', async () => {
    const name = 'consulter-un-utilisateur';
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${server.url}/dashboard`);
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    await dashboard().locator('.drawer [data-action="nav"][data-view="recordings"]').click();
    await dashboard().locator(`[data-action="open-review"][data-recording="${name}"]`).click();
    await dashboard().locator('h1', { hasText: 'Revue de l’enregistrement' }).waitFor({ timeout: 30_000 });
    const tab = (key: string): Locator =>
      dashboard().locator(`[data-action="review-tab"][data-tab="${key}"]`);
    await expect
      .poll(async () => tab('flow').textContent())
      .toMatch(/^1\. Parcours · 2 étapes · 0 groupe\(s\)$/);

    // Les deux gestes cochés deviennent un groupe, renommé ensuite.
    const picks = dashboard().locator('[data-review-pick]');
    expect(await picks.count()).toBe(2);
    await picks.nth(0).check();
    await picks.nth(1).check();
    await dashboard().locator('input[data-review="newGroup"]').fill('Consultation');
    await dashboard().locator('form[data-action="review-create-group"] button[type="submit"]').click();
    await dashboard().locator('.rv-group-h b', { hasText: 'Consultation' }).waitFor({ timeout: 15_000 });
    const [group] = await client.groups.list(project.id, name);
    expect(group?.name).toBe('Consultation');
    await dashboard()
      .locator(`[data-action="review-rename-open"][data-group="${group?.id ?? ''}"]`)
      .click();
    await dashboard().locator('input[data-review="rename"]').fill('Consulter la fiche');
    await dashboard().locator('form[data-action="review-rename"] button[type="submit"]').click();
    await dashboard()
      .locator('.rv-group-h b', { hasText: 'Consulter la fiche' })
      .waitFor({ timeout: 15_000 });
    expect((await client.groups.list(project.id, name))[0]?.name).toBe('Consulter la fiche');

    // Une assertion proposée, acceptée.
    const before = await client.assertions.list(project.id, name);
    const pending = before.filter((proposal) => proposal.status === 'PROPOSED');
    expect(pending.length).toBeGreaterThan(0);
    await tab('assertions').click();
    const first = pending[0]?.id ?? '';
    await dashboard()
      .locator(`[data-action="review-decide"][data-decision="ACCEPT"][data-assertion="${first}"]`)
      .click();
    await expect
      .poll(
        async () =>
          (await client.assertions.list(project.id, name)).find((entry) => entry.id === first)?.status,
      )
      .toBe('APPROVED');

    // Aucune saisie dans ce parcours.
    await tab('data').click();
    await dashboard().locator('p', { hasText: 'Aucune saisie dans ce parcours.' }).waitFor();

    // Les tests générés : YAML, Gherkin et Playwright, avec ce qu'ils sont.
    await tab('tests').click();
    await dashboard().locator('[data-review-format="playwright"]').check();
    await dashboard().locator('form[data-action="review-generate"] button[type="submit"]').click();
    const files = dashboard().locator('.rv-files > li');
    await expect.poll(() => files.count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    const listed = (await dashboard().locator('.rv-files').textContent()) ?? '';
    for (const format of ['Flow YAML', 'Gherkin (.feature)', 'Playwright TypeScript'])
      expect(listed).toContain(format);

    // Le rejeu de validation, pour de vrai (sans fenêtre), depuis le Dashboard.
    await dashboard().locator('[data-action="review-replay"]').click();
    const replayPill = dashboard().locator('.replay-card .pill').first();
    await expect
      .poll(async () => replayPill.textContent(), { timeout: 180_000, interval: 1000 })
      .toMatch(/^(Confirmé|Échoué)$/);
    const replay = await client.recordings.replayStatus(project.id, name);
    expect(replay).toMatchObject({ status: 'REPLAY_CONFIRMED', dryRunStatus: 'FULLY_MATCHED' });
    expect(replay.last).toMatchObject({ status: 'FULLY_MATCHED', stale: false });

    // Retirer une étape : la page demande d'abord.
    await tab('flow').click();
    const steps = dashboard().locator('.rv-step');
    const count = await steps.count();
    const removable = dashboard().locator('[data-action="review-remove"]').last();
    const stepId = (await removable.getAttribute('data-step')) ?? '';
    await removable.click();
    await dashboard().locator(`[data-action="review-remove-yes"][data-step="${stepId}"]`).click();
    await expect.poll(() => steps.count(), { timeout: 15_000 }).toBeLessThan(count);
    const flow = await client.recordings.flow(project.id, name);
    expect(flow.steps.some((step) => step.id === stepId)).toBe(false);
    expect(flow.yaml).not.toContain('name: Utilisateur 1');
  }, 300_000);

  it('corrects a target in the browser the server opens, resumes the replay, restores; reviews the intents', async () => {
    const name = 'consulter-un-utilisateur';
    const studio = await client.recordings.studio(project.id, name);
    const target = studio.steps.find((step) => step.targeted && step.description.includes('Utilisateurs'));
    expect(target).toBeDefined();
    const stepId = target?.id ?? '';
    await dashboard().locator(`[data-action="review-correct"][data-step="${stepId}"]`).click();
    const card = dashboard().locator('.correction-card');
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-action="review-correction-apply"]').waitFor({ timeout: 90_000 });
    expect(await card.textContent()).toContain('Nouvelle cible');
    expect((await client.corrections.get(project.id, name)).proposal?.next).toContain('Utilisateurs');
    await card.locator('[data-action="review-correction-apply"]').click();
    await card.locator('[data-action="review-correction-resume"]').waitFor({ timeout: 30_000 });
    expect(await card.textContent()).toContain('Cible remplacée');
    await card.locator('[data-action="review-correction-resume"]').click();
    await expect
      .poll(async () => (await client.corrections.get(project.id, name)).status, {
        timeout: 90_000,
        interval: 1000,
      })
      .toBe('RESUMED');
    expect((await client.corrections.get(project.id, name)).resume?.status).toBe('PASSED');
    await card.locator('.pill', { hasText: 'Reprise réussie' }).waitFor({ timeout: 15_000 });
    await card.locator('[data-action="review-correction-close"]').click();
    await card.waitFor({ state: 'detached', timeout: 15_000 });
    await expect(client.corrections.get(project.id, name)).rejects.toMatchObject({ status: 404 });

    // La cible corrigée se restaure.
    const restore = dashboard().locator(`[data-action="review-restore"][data-step="${stepId}"]`);
    await restore.waitFor({ timeout: 15_000 });
    expect(
      (await client.recordings.studio(project.id, name)).steps.find((step) => step.id === stepId)?.corrected,
    ).toBe(true);
    await restore.click();
    await restore.waitFor({ state: 'detached', timeout: 15_000 });
    expect(
      (await client.recordings.studio(project.id, name)).steps.find((step) => step.id === stepId)?.corrected,
    ).toBeUndefined();

    // Les intentions : confirmer la première, corriger la suivante avec une raison.
    await dashboard().locator('[data-action="review-tab"][data-tab="intents"]').click();
    const before = await client.recordings.intents(project.id, name);
    expect(before.rows.length).toBeGreaterThan(0);
    const first = before.rows[0]?.actionId ?? '';
    await dashboard()
      .locator(`[data-action="review-intent"][data-type="CONFIRM"][data-intent-action="${first}"]`)
      .click();
    await expect
      .poll(async () => (await client.recordings.intents(project.id, name)).rows[0]?.status)
      .toBe('HUMAN_CONFIRMED');
    await dashboard().locator(`[data-action="review-intent-open"][data-intent-action="${first}"]`).click();
    await dashboard().locator('select[data-intent-field="intent"]').selectOption('NAVIGATE');
    await dashboard().locator('input[data-intent-field="reason"]').fill('ouvre la liste');
    await dashboard().locator('form[data-action="review-intent-save"] button[type="submit"]').click();
    await expect
      .poll(async () => (await client.recordings.intents(project.id, name)).rows[0])
      .toMatchObject({ intent: 'NAVIGATE', status: 'HUMAN_CORRECTED', reason: 'ouvre la liste' });
  }, 300_000);

  it('on a phone: the review never scrolls sideways', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('.kpis').waitFor();
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('h1', { hasText: 'Site de démo' }).waitFor();
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="recordings"]').click();
    await element.locator('[data-action="open-review"]').first().click();
    await element.locator('.rv-flow').waitFor({ timeout: 30_000 });
    for (const key of ['flow', 'assertions', 'tests']) {
      await element.locator(`[data-action="review-tab"][data-tab="${key}"]`).click();
      expect(
        await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    }
    await phone.close();
  }, 60_000);
});
