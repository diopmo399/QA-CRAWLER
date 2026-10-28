import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  type FlowStudioView,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LE FLOW STUDIO AVEC LE VRAI MOTEUR : un parcours enregistré par le vrai recorder puis rejoué
 * (`validate`), ouvert dans <qa-crawler-flow-studio> sur la page du serveur. Les gestes (zoom,
 * déplacement, recherche, sélection, création de groupe, dépôt d'une étape sur un groupe, repli,
 * renommage) passent par des commandes que le moteur vérifie ; l'état est relu par l'API pour
 * prouver que c'est bien le moteur qui a changé, et non l'écran.
 */
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const NAME = 'consulter-un-utilisateur';

const SEARCH = 'chercher-sur-le-site';
const humans = new Map<string, NonNullable<RecordRequest['drive']>>();

// La clé est le nom donné à l'enregistrement (le dossier, lui, est son slug).
humans.set('Chercher sur le site', async ({ page: app }) => {
  const pause = (): Promise<void> => app.waitForTimeout(500);
  await pause();
  await app.getByRole('link', { name: 'Formulaires' }).click();
  await app.waitForURL('**/forms');
  await pause();
  await app.getByRole('searchbox').fill('Ada Lovelace');
  await pause();
  await app.getByRole('button', { name: 'Rechercher' }).click();
  await app.waitForURL('**/search?**');
  await pause();
});

const human: NonNullable<RecordRequest['drive']> = async ({ page: app }) => {
  const pause = (): Promise<void> => app.waitForTimeout(500);
  await pause();
  await app.getByRole('link', { name: 'Utilisateurs' }).click();
  await app.waitForURL('**/users');
  await pause();
  await app.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await app.waitForURL('**/users/1');
  await pause();
  await app.getByRole('link', { name: 'Modifier' }).click();
  await app.waitForURL('**/users/1/edit');
  await pause();
  await app.getByRole('link', { name: 'Accueil' }).click();
  await app.waitForURL((url) => url.pathname === '/');
  await pause();
};

const studio = (): Locator => page.locator('qa-crawler-flow-studio');
const inStudio = (selector: string): Locator => studio().locator(selector);
const zoomLabel = async (): Promise<number> => Number((await inStudio('.zv').innerText()).replace(/\D/g, ''));
const transform = (): Promise<string | null> => inStudio('.vp').getAttribute('transform');
const view = (): Promise<FlowStudioView> => client.recordings.studio(project.id, NAME);

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragTo(from: Locator, to: { x: number; y: number }): Promise<void> {
  const start = await center(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-studio-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({
        ...request,
        overrides: { ...request.overrides, headless: true },
        drive: humans.get(request.name) ?? human,
      }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Site de démo', targetUrl: `${site.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
  await client.recordings.start(project.id, { name: 'Consulter un utilisateur', validate: true });
  await client.recordings.subscribe(project.id, NAME, () => undefined).done;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${server.url}/studio?project=${project.id}&recording=${NAME}`);
}, 240_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Flow Studio — real recording, real replay, real engine commands', () => {
  it('draws every step of the recorded flow and the path of the replay', async () => {
    const current = await view();
    expect(current.steps.length).toBeGreaterThanOrEqual(4);
    await expect.poll(() => inStudio('[data-node]').count()).toBe(current.steps.length);
    // Le rejeu a eu lieu : chaque carte porte le résultat que le moteur a écrit pour son étape.
    expect(current.replay).toBeDefined();
    const played = current.steps.filter((step) => step.replay?.outcome === 'MATCHED').length;
    expect(played).toBeGreaterThan(0);
    expect(await inStudio('[data-node].r-ok').count()).toBe(played);
    await expect.poll(() => inStudio('.side').innerText()).toContain('Dernier rejeu');
    // Aucun groupe au départ : un ancien enregistrement sans groupe s'affiche tel quel.
    expect(await inStudio('[data-frame]').count()).toBe(0);
  });

  it('zooms with the buttons, fits the view, and pans by dragging the background', async () => {
    await inStudio('[data-cmd="fit"]').click();
    const fitted = await zoomLabel();
    expect(fitted).toBeLessThanOrEqual(100);
    await inStudio('[data-cmd="zoom-in"]').click();
    expect(await zoomLabel()).toBe(Math.round(fitted * 1.2));
    await inStudio('[data-cmd="zoom-out"]').click();
    expect(Math.abs((await zoomLabel()) - fitted)).toBeLessThanOrEqual(1);
    const before = await transform();
    const canvas = await inStudio('.canvas').boundingBox();
    if (!canvas) throw new Error('no canvas');
    await page.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height - 30);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width - 130, canvas.y + canvas.height - 80, { steps: 6 });
    await page.mouse.up();
    expect(await transform()).not.toBe(before);
    await inStudio('[data-cmd="fit"]').click();
  });

  it('searches the journey: matches are counted, the others are dimmed', async () => {
    await inStudio('#qa-search').fill('Modifier');
    await expect.poll(() => inStudio('.search output').innerText()).toMatch(/^1 \/ \d+$/);
    expect(await inStudio('[data-node].dim').count()).toBeGreaterThan(0);
    await inStudio('#qa-search').press('Enter');
    await expect.poll(() => inStudio('[data-node].sel').count()).toBe(1);
    await inStudio('#qa-search').fill('');
    expect(await inStudio('[data-node].dim').count()).toBe(0);
  });

  it('creates a business group from two selected steps — the engine writes it', async () => {
    const [first, second] = (await view()).steps;
    if (!first || !second) throw new Error('steps missing');
    await inStudio(`[data-node="${first.id}"]`).click();
    await inStudio(`[data-node="${second.id}"]`).click({ modifiers: ['Shift'] });
    await expect.poll(() => inStudio('.side h2').textContent()).toContain('2 étapes sélectionnées');
    await inStudio('#qa-new-group').fill('Ouvrir la fiche');
    await inStudio('form[data-form="create"] button').click();
    await expect
      .poll(async () => (await view()).groups.map((group) => group.name))
      .toEqual(['Ouvrir la fiche']);
    const group = (await view()).groups[0];
    expect(group?.stepIds).toEqual(expect.arrayContaining([first.id, second.id]));
    await expect.poll(() => inStudio('[data-frame]').count()).toBe(1);
    await expect.poll(() => inStudio('.notice').innerText()).toContain('Modifié par le moteur');
  });

  it('dropping a step on the group asks the engine to put it there', async () => {
    const current = await view();
    const group = current.groups[0];
    const outside = current.steps.find((step) => step.groupId === undefined && step.kind !== 'expect');
    if (!group || !outside) throw new Error('fixture');
    const frame = inStudio(`[data-frame="${group.id}"] > rect`).first();
    const box = await frame.boundingBox();
    if (!box) throw new Error('no frame');
    await dragTo(inStudio(`[data-node="${outside.id}"]`), { x: box.x + box.width / 2, y: box.y + 20 });
    await expect.poll(async () => (await view()).groups[0]?.stepIds.includes(outside.id)).toBe(true);
  });

  it('moving a card by hand changes the display only, never the order', async () => {
    const before = (await view()).steps.map((step) => step.id);
    const last = before.at(-1);
    if (!last) throw new Error('fixture');
    const card = inStudio(`[data-node="${last}"]`);
    const start = await center(card);
    await dragTo(card, { x: start.x, y: start.y + 160 });
    await expect.poll(() => inStudio('[data-cmd="reset-positions"]').count()).toBe(1);
    expect((await view()).steps.map((step) => step.id)).toEqual(before);
    await inStudio('[data-cmd="reset-positions"]').click();
    expect(await inStudio('[data-cmd="reset-positions"]').count()).toBe(0);
  });

  it('collapses and expands the group (kept by the engine), renames it from its panel', async () => {
    const group = (await view()).groups[0];
    if (!group) throw new Error('fixture');
    await inStudio(`[data-collapse="${group.id}"]`).first().click();
    await expect.poll(() => inStudio('[data-summary]').count()).toBe(1);
    expect((await view()).groups[0]?.collapsed).toBe(true);
    await inStudio(`[data-collapse="${group.id}"]`).first().click();
    await expect.poll(() => inStudio('[data-summary]').count()).toBe(0);

    await inStudio(`[data-frame="${group.id}"] .fh`).click();
    await expect.poll(() => inStudio('.side h2').first().textContent()).toBe('Groupe');
    await inStudio('#qa-group-name').fill('Consulter la fiche');
    await inStudio('form[data-form="rename"] button').click();
    await expect.poll(async () => (await view()).groups[0]?.name).toBe('Consulter la fiche');
    expect(await inStudio(`[data-frame="${group.id}"] .fn`).textContent()).toContain('Consulter la fiche');
  });

  it('shows a refusal of the engine in words, and nothing changes', async () => {
    const before = await view();
    const first = before.steps[0];
    if (!first) throw new Error('fixture');
    await inStudio(`[data-node="${first.id}"]`).click();
    await inStudio('[data-cmd="move-step-up"]').click();
    await expect
      .poll(() => inStudio('.notice').innerText())
      .toContain('Le moteur a refusé : rien n’a été modifié.');
    expect(await inStudio('.notice').getAttribute('role')).toBe('alert');
    expect((await view()).steps.map((step) => step.id)).toEqual(before.steps.map((step) => step.id));
  });

  it('is usable with the keyboard: arrows go from step to step, Enter selects, Escape clears', async () => {
    const steps = (await view()).steps;
    const [first, second] = steps;
    if (!first || !second) throw new Error('fixture');
    await inStudio(`[data-node="${first.id}"]`).focus();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() =>
        studio().evaluate((element) => element.shadowRoot?.activeElement?.getAttribute('data-node')),
      )
      .toBe(second.id);
    await page.keyboard.press('Enter');
    await expect.poll(() => inStudio(`[data-node="${second.id}"]`).getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.press('Escape');
    await expect.poll(() => inStudio('[data-node].sel').count()).toBe(0);
  });
});

describe('Flow Studio — data and assertions of a journey with a typed value', () => {
  beforeAll(async () => {
    await client.recordings.start(project.id, { name: 'Chercher sur le site', validate: true });
    await client.recordings.subscribe(project.id, SEARCH, () => undefined).done;
    await page.goto(`${server.url}/studio?project=${project.id}&recording=${SEARCH}`);
    await inStudio('[data-node]').first().waitFor();
  }, 240_000);

  it('binds the typed value to a generated one: the engine rewrites the flow and keeps the human decision', async () => {
    const data = await client.data.get(project.id, SEARCH);
    const input = data.inputs.find((entry) => entry.source !== 'SENSITIVE');
    if (!input) throw new Error('the recording has no input');
    await inStudio(`[data-node="${input.stepId}"]`).click();
    await expect.poll(() => inStudio('.side').innerText()).toContain('Source de la valeur');
    await inStudio('form[data-form="bind"] input[value="GENERATED"]').check();
    await inStudio('#qa-bind-generator').selectOption('text');
    await inStudio('form[data-form="bind"] button').click();
    await expect
      .poll(async () =>
        (await client.data.get(project.id, SEARCH)).inputs.find((entry) => entry.stepId === input.stepId),
      )
      .toMatchObject({ source: 'GENERATED', generator: 'text', manual: true });
    await expect.poll(() => inStudio('.notice').innerText()).toContain('Modifié par le moteur');
    // Le flow a changé depuis le rejeu de validation : le Studio le dit.
    expect((await client.recordings.studio(project.id, SEARCH)).replay?.stale).toBe(true);
  });

  it('the data tab shows the lineage of the bound value, and links back to its step', async () => {
    await inStudio('[data-tab="data"]').click();
    const data = await client.data.get(project.id, SEARCH);
    const variable = data.variables[0];
    if (!variable) throw new Error('no variable');
    await expect.poll(() => inStudio('.side').innerText()).toContain(variable.key);
    await inStudio(`[data-variable="${variable.key}"] [data-select-step]`).first().click();
    await expect.poll(() => inStudio('[data-tab="flow"]').getAttribute('aria-selected')).toBe('true');
    await expect.poll(() => inStudio('[data-node].sel').count()).toBe(1);
  });

  it('the assertions tab shows each proposal with a verdict from a run, and a human decision goes to the engine', async () => {
    const proposals = await client.assertions.list(project.id, SEARCH);
    expect(proposals.length).toBeGreaterThan(0);
    await inStudio('[data-tab="assertions"]').click();
    await expect.poll(() => inStudio('[data-verdict]').count()).toBe(proposals.length);
    // Une proposition dans le parcours, dont l'étape de vérification a été rejouée, porte le verdict
    // du rejeu (et le signale périmé : le flow a changé depuis) ; hors du parcours, rien n'est vérifié.
    for (const entry of proposals) {
      if (!entry.inFlow) expect(entry.verdict.status).toBe('NOT_EXECUTED');
      else if (entry.stepId) expect(entry.verdict).toMatchObject({ source: 'REPLAY_STEP', stale: true });
    }
    expect(proposals.some((entry) => entry.inFlow && entry.verdict.status === 'VERIFIED_PASS')).toBe(true);
    const target = proposals[0];
    if (!target) throw new Error('no proposal');
    await inStudio(`[data-decide="REJECT"][data-assertion="${target.id}"]`).click();
    await expect
      .poll(
        async () =>
          (await client.assertions.list(project.id, SEARCH)).find((entry) => entry.id === target.id)?.status,
      )
      .toBe('REJECTED');
    // Rejetée : hors du parcours, donc jamais vérifiée.
    expect(
      (await client.assertions.list(project.id, SEARCH)).find((entry) => entry.id === target.id)?.verdict
        .status,
    ).toBe('NOT_EXECUTED');
  });

  it('the tests tab generates the tests with the engine and says what each file is', async () => {
    await inStudio('[data-tab="tests"]').click();
    await inStudio('input[name="format"][value="playwright"]').check();
    await inStudio('form[data-form="generate"] button').click();
    const files = inStudio('.files > li');
    await expect.poll(() => files.count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    const text = (await inStudio('.files').textContent()) ?? '';
    for (const label of ['Flow YAML', 'Gherkin (.feature)', 'Playwright TypeScript'])
      expect(text).toContain(label);
    expect(text).toContain('validé (analyse statique)');
    expect(text).not.toMatch(/réussi/);
  }, 90_000);
});
