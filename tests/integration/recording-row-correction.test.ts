import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordedFlowStep } from '../../src/recording/model.js';
import type { HumanFlowRecorder } from '../../src/recording/human-flow-recorder.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

/**
 * CORRECTION MANAGER — LA LIGNE D'UN TABLEAU. L'enregistrement crée un élément (numéro renvoyé par le
 * serveur : 3024) puis clique « Open » dans sa ligne : la clé enregistrée est ce numéro. Au rejeu, la
 * création renvoie un autre numéro → la ligne 3024 n'existe plus → échec. La correction dans le navigateur
 * (après le rejeu des étapes précédentes) propose de LIER LA LIGNE À LA DONNÉE DU RUN (le nom saisi, cité
 * `${testData:…}`) plutôt qu'à la nouvelle clé, propre à ce run ; le rejeu suivant passe.
 */
const row = (panel: Page, text: string | RegExp) => panel.locator('#timeline .item', { hasText: text });
const PICKING = 'data-qa-crawler-overlay-picking';

const pickingIn = (page: Page, on: boolean): Promise<void> =>
  page
    .waitForFunction(
      ({ attribute, expected }) => (document.documentElement.getAttribute(attribute) === 'true') === expected,
      { attribute: PICKING, expected: on },
      { timeout: 15_000 },
    )
    .then(() => undefined);

async function pickLinkWithMouse(page: Page, name: string): Promise<void> {
  const box = await page.getByRole('link', { name, exact: true }).boundingBox();
  if (!box) throw new Error(`no box for "${name}"`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 20, y - 5);
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
}

async function correctionPageOf(recorder: HumanFlowRecorder): Promise<Page> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const page = recorder.correctionPage;
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the correction page did not open');
}

describe('Correction manager — a table row is bound to the run data, never to a run-specific key', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const seen: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    app.table = true;
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-row-correction-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-row-correction }\ntarget: { baseUrl: ${app.url}, startAt: /form }\ndryRun: { maxActions: 8, maxDepth: 2, maxDurationMs: 90000, continueAfterMismatch: false }\n`,
    );
    outcome = await runRecording({
      name: 'Row correction',
      missionFile: path.join(dir, 'mission.yaml'),
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page, panel }) => {
        if (!panel) throw new Error('the recorder window did not open');
        await page.getByLabel('First name').click();
        await page.getByLabel('First name').pressSequentially('Alex', { delay: 20 });
        await row(panel, /Saisir "Alex" dans "First name"/).waitFor({ timeout: 5000 });
        await page.waitForTimeout(600);
        // La création : le serveur numérote la ligne (3024) et la page se recharge avec le tableau.
        await page.getByRole('button', { name: 'Create item', exact: true }).click();
        await page.getByRole('cell', { name: 'Alex' }).waitFor({ timeout: 10_000 });
        await row(panel, /Cliquer sur "Create item"/).waitFor({ timeout: 5000 });
        await page.waitForTimeout(600);
        await page.getByRole('link', { name: 'Open', exact: true }).click();
        await page.locator('#name').waitFor({ timeout: 10_000 });
        await row(panel, /Cliquer sur "Open"/).waitFor({ timeout: 5000 });
        await page.waitForTimeout(600);
      },
      reviewDriver: async ({ panel, recorder }) => {
        await panel.getByText('Enregistrement terminé ✓').waitFor({ timeout: 60_000 });
        // Le rejeu crée la ligne 3025 : la clé enregistrée (3024) n'identifie plus rien → échec sur « Open ».
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel.getByText(/✓ Replay réussi|✕ Replay interrompu/).waitFor({ timeout: 180_000 });
        seen.firstReplay = await panel.locator('#review').innerText();
        if (!String(seen.firstReplay).includes('✕ Replay interrompu')) {
          await panel.getByRole('button', { name: 'Fermer' }).click();
          return;
        }
        await panel.locator('#review').getByRole('button', { name: 'Corriger dans le navigateur' }).click();
        const page = await correctionPageOf(recorder);
        await pickingIn(page, true);
        // La page rouverte montre la ligne créée PAR CE REJEU (une autre clé, le nom généré du run).
        seen.rowAtPick = await page.locator('#items tbody tr').innerText();
        await pickLinkWithMouse(page, 'Open');
        await pickingIn(page, false);
        await panel.getByText('NOUVELLE CIBLE').waitFor();
        seen.proposal = await panel.locator('#details .correction').innerText();
        // La clé lue dans le tableau reste offerte, avec l'avertissement « propre à ce run ».
        await panel.getByLabel(/La clé lue dans le tableau/).check();
        await panel.getByText(/Clé propre à ce run/).waitFor();
        seen.keyOption = await panel.locator('#details .correction').innerText();
        await panel.getByLabel(/La donnée du run/).check();
        await panel.getByText(/Clé propre à ce run/).waitFor({ state: 'hidden' });
        await panel.getByRole('button', { name: 'Valider la correction' }).click();
        await panel.locator('#details .correction').getByText('Historique des corrections').waitFor();
        seen.history = await panel.locator('#details .correction').innerText();
        // Le rejeu suivant crée encore une autre ligne : liée à la donnée du run, elle se retrouve.
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel.getByText(/✓ Replay réussi|✕ Replay interrompu/).waitFor({ timeout: 180_000 });
        seen.secondReplay = await panel.locator('#review').innerText();
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 600_000);

  afterAll(async () => {
    await app.close();
  });

  const steps = async (): Promise<RecordedFlowStep[]> =>
    (
      JSON.parse(await readFile(path.join(outcome.directory, 'recorded-flow.json'), 'utf8')) as {
        steps: RecordedFlowStep[];
      }
    ).steps;

  it('the recording identified the row by the number the server returned (the identifying column)', async () => {
    const open = (await steps()).find(
      (step) => step.step.kind === 'click' && 'target' in step.step && step.step.target.name === 'Open',
    );
    expect(open?.corrections?.[0]?.previous).toMatchObject({ row: { 'N°': '3024' } });
  });

  it('the replay fails on that row, and the correction page shows the row created by the replay itself', () => {
    expect(String(seen.firstReplay)).toContain('✕ Replay interrompu');
    expect(String(seen.rowAtPick)).not.toContain('3024');
    expect(String(seen.rowAtPick)).toMatch(/Open/);
  });

  it('the proposal binds the row to the run data first, and warns when the table key is chosen', () => {
    const text = String(seen.proposal);
    expect(text).toContain('Identifier la ligne par');
    expect(text).toContain('La donnée du run');
    expect(text).toContain('La clé lue dans le tableau');
    expect(text).toContain('${testData:');
    expect(text).not.toContain('Clé propre à ce run');
    expect(String(seen.keyOption)).toContain('Clé propre à ce run');
  });

  it('the corrected step cites the run data in its row; the next replay passes with a new number', async () => {
    const open = (await steps()).find(
      (step) => step.step.kind === 'click' && 'target' in step.step && step.step.target.name === 'Open',
    );
    const target = open?.step.kind === 'click' ? open.step.target : undefined;
    expect(target?.row).toBeDefined();
    expect(Object.values(target?.row ?? {})[0]).toMatch(/^\$\{testData:.+\}$/);
    // L'historique montre la correction lisible : la ligne cite la donnée du run, plus la clé lue.
    expect(String(seen.history)).toMatch(/Correction\s[\s\S]*Ligne\s+(contient\s+)?[\w.-]+/);
    expect(String(seen.history).split('Correction').pop()).not.toContain('3024');
    expect(outcome.result.files.yaml).toContain('${testData:');
    expect(outcome.result.files.yaml).not.toContain('3024');
    expect(String(seen.secondReplay)).toContain('✓ Replay réussi');
  });
});
