import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HumanFlowRecorder } from '../../src/recording/human-flow-recorder.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

/**
 * RESTAURATION DU CONTEXTE à la reprise d'un rejeu corrigé. L'enregistrement crée un élément (le
 * serveur le numérote) puis ouvre sa ligne ; le rejeu échoue sur la ligne (numéro propre au run). La
 * correction dans le navigateur garde la page DEVANT l'étape corrigée ; « Reprendre ici » compare la
 * page au checkpoint de contexte :
 *   - la page a quitté le contexte et la reconstruire répéterait la création → MANUAL_RECOVERY, rien
 *     n'est répété ;
 *   - la page est revenue dans le contexte → REVALIDATE, l'étape corrigée et la suite sont rejouées
 *     avec LES MÊMES données du run (le même élément, aucune seconde création) → rejeu réussi.
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

describe('Context recovery — resume a corrected replay where it stopped, with the same run data', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const seen: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    app.table = true;
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-context-recovery-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-context-recovery }\ntarget: { baseUrl: ${app.url}, startAt: /form }\ndryRun: { maxActions: 8, maxDepth: 2, maxDurationMs: 90000, continueAfterMismatch: false }\n`,
    );
    outcome = await runRecording({
      name: 'Context recovery',
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
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel.getByText(/✓ Replay réussi|✕ Replay interrompu/).waitFor({ timeout: 180_000 });
        seen.firstReplay = await panel.locator('#review').innerText();
        if (!String(seen.firstReplay).includes('✕ Replay interrompu')) {
          await panel.getByRole('button', { name: 'Fermer' }).click();
          return;
        }
        // La correction : la session suit le même chemin (création comprise) et garde la page devant « Open ».
        await panel.locator('#review').getByRole('button', { name: 'Corriger dans le navigateur' }).click();
        const page = await correctionPageOf(recorder);
        await pickingIn(page, true);
        seen.rowInSession = await page.locator('#items tbody tr').innerText();
        await pickLinkWithMouse(page, 'Open');
        await pickingIn(page, false);
        await panel.getByText('NOUVELLE CIBLE').waitFor();
        await panel.getByRole('button', { name: 'Valider la correction' }).click();
        await panel.getByRole('button', { name: 'Reprendre ici' }).waitFor({ timeout: 15_000 });
        seen.resumeCard = await panel.locator('#review').innerText();
        seen.createdBeforeResume = app.created;
        // 1. La page quitte le contexte : la reconstruire répéterait la création → reprise manuelle, rien de répété.
        await page.goto(`${app.url}/done`);
        await panel.getByRole('button', { name: 'Reprendre ici' }).click();
        await panel.getByText('✕ Replay interrompu').waitFor({ timeout: 60_000 });
        seen.manual = await panel.locator('#review').innerText();
        seen.createdAfterManual = app.created;
        // 2. La page revient dans le contexte : la reprise vérifie, puis rejoue l'étape corrigée et la suite.
        await page.goBack();
        await page.getByRole('link', { name: 'Open', exact: true }).waitFor({ timeout: 10_000 });
        await panel.getByRole('button', { name: 'Reprendre ici' }).click();
        await panel.getByText(/✓ Replay réussi|✕ Replay interrompu/).waitFor({ timeout: 120_000 });
        seen.resumed = await panel.locator('#review').innerText();
        // Le rejeu a réussi : la session s'est fermée ; l'élément ouvert est lu côté serveur.
        seen.itemName = app.lastItem?.name;
        seen.createdAfterResume = app.created;
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 600_000);

  afterAll(async () => {
    await app.close();
  });

  it('after the correction, the window offers to resume where the context was kept', () => {
    expect(String(seen.firstReplay)).toContain('✕ Replay interrompu');
    expect(String(seen.resumeCard)).toContain('Contexte gardé devant l’étape');
    expect(String(seen.resumeCard)).toContain('Reprendre ici');
  });

  it('10 · a page that left the context is never rebuilt by repeating a creation: MANUAL_RECOVERY, nothing created', () => {
    expect(String(seen.manual)).toContain('reprise impossible sans vous');
    expect(String(seen.manual)).toContain('reprise manuelle requise');
    expect(seen.createdAfterManual).toBe(seen.createdBeforeResume);
  });

  it('9 · 14 · back in the context: the corrected step and the rest are replayed with the same run data, no second creation', () => {
    expect(String(seen.resumed)).toContain('✓ Replay réussi');
    expect(String(seen.resumed)).toMatch(/Repris à l’étape \d+ · contexte vérifié/);
    expect(seen.createdAfterResume).toBe(seen.createdBeforeResume);
    // L'élément est celui créé par la session (son nom généré, montré dans sa ligne), pas un autre.
    const name = typeof seen.itemName === 'string' ? seen.itemName : '';
    expect(name.length).toBeGreaterThan(1);
    expect(String(seen.rowInSession)).toContain(name);
  });

  it('the journal explains each decision; the written checkpoints hold digests, never the run values', async () => {
    const events = await readFile(path.join(outcome.directory, 'recording-events.jsonl'), 'utf8');
    expect(events).toContain('"REPLAY_CONTEXT_RECOVERY"');
    expect(events).toContain('MANUAL_RECOVERY');
    expect(events).toContain('"REPLAY_RESUME_BLOCKED"');
    expect(events).toContain('"REPLAY_RESUMED"');
    const checkpoints = await readFile(path.join(outcome.directory, 'replay-checkpoints.json'), 'utf8');
    expect(checkpoints).toContain('"digest"');
    expect(checkpoints).not.toContain(typeof seen.itemName === 'string' ? seen.itemName : 'unreachable');
  });
});
