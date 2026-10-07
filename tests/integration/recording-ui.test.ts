import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RawRecordedEvent, RecordedFlowStep } from '../../src/recording/model.js';
import type { HumanFlowRecorder } from '../../src/recording/human-flow-recorder.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import type { RecordingTargetValidation } from '../../src/recording/target-validator.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

/**
 * L'INTERFACE D'ENREGISTREMENT de bout en bout : Playwright joue l'humain dans l'application ET dans la
 * fenêtre « QA-CRAWLER Recorder » (un contexte séparé du navigateur, jamais enregistré).
 */
const timeline = (panel: Page) => panel.locator('#timeline');
const row = (panel: Page, text: string | RegExp) => timeline(panel).locator('.item', { hasText: text });

/** Une validation AMBIGUOUS (deux éléments correspondent ; l'humain a touché le second). */
function ambiguous(rawEventId: string): RecordingTargetValidation {
  return {
    rawEventId,
    status: 'AMBIGUOUS',
    validationBefore: {
      status: 'AMBIGUOUS',
      confidence: 0.4,
      reason: 'two elements match',
      candidateCount: 2,
      differences: [],
      candidates: [
        { index: 0, original: false, name: 'Value', section: 'Primary' },
        { index: 1, original: true, name: 'Value', section: 'Secondary' },
      ],
    },
  } as unknown as RecordingTargetValidation;
}

describe('Recording UI (recorder window)', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const seen: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-ui-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-ui }\ntarget: { baseUrl: ${app.url}, startAt: /form }\nsafety:\n  mutations: { enabled: true, maxPerRun: 20 }\n`,
    );
    outcome = await runRecording({
      name: 'Recording UI',
      missionFile: path.join(dir, 'mission.yaml'),
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page, panel, recorder }) => {
        if (!panel) throw new Error('the recorder window did not open');
        // CLICK → la ligne apparaît tout de suite.
        await page.getByRole('button', { name: 'Action 7', exact: true }).click();
        await row(panel, /Cliquer sur "Action 7"/).waitFor({ timeout: 3000 });
        // FILL → « Saisir … dans … » ; un mot de passe n'est jamais affiché.
        await page.getByLabel('First name').click();
        await page.getByLabel('First name').pressSequentially('Alex', { delay: 20 });
        await page.getByLabel('Password').fill('top-secret-9');
        await row(panel, /Saisir "Alex" dans "First name"/).waitFor();
        await row(panel, /Saisir "••••" dans "Password"/).waitFor();
        seen.panelText = await panel.locator('body').innerText();
        // CHECK → « Cocher … ».
        await page.getByLabel('Accept terms').check();
        await row(panel, /Cocher "Accept terms"/).waitFor();
        // AMBIGUÏTÉ : signalée, résolue par l'humain (seul l'élément touché peut être confirmé).
        const second = page.locator('section[aria-label="Secondary"] #valueInput');
        await second.click();
        await second.pressSequentially('42', { delay: 20 });
        await row(panel, /Saisir "42" dans "Value"/).waitFor();
        await injectAmbiguity(recorder, 'Value');
        await panel.getByText('⚠ Action ambiguë').waitFor();
        seen.ambiguousShown = true;
        await panel.getByRole('button', { name: 'Résoudre' }).click();
        await panel.getByLabel(/Primary/).check();
        await panel.getByRole('button', { name: 'Confirmer' }).click();
        await panel
          .getByRole('alert')
          .getByText(/pas l'élément que vous avez touché/)
          .waitFor();
        seen.refusedOtherElement = true;
        await panel.getByRole('button', { name: 'Résoudre' }).click();
        await panel.getByLabel(/élément touché/).check();
        await panel.getByRole('button', { name: 'Confirmer' }).click();
        await panel.getByText(/Ambiguïté résolue/).waitFor();
        // DÉTAILS + MISE EN ÉVIDENCE dans la page.
        await row(panel, /First name/).click();
        await panel.getByText("Détails de l'action").waitFor();
        await panel.getByText(/Élément mis en évidence dans la page/).waitFor();
        // PAUSE : aucune action enregistrée.
        await panel.getByRole('button', { name: "Mettre l'enregistrement en pause" }).click();
        await panel.getByText('⏸ Enregistrement en pause').waitFor();
        const before = await timeline(panel).locator(':scope > li').count();
        await page.getByRole('button', { name: 'Action 9', exact: true }).click();
        await page.waitForTimeout(500);
        seen.duringPause = (await timeline(panel).locator(':scope > li').count()) - before;
        // REPRENDRE : l'enregistrement reprend.
        await panel.getByRole('button', { name: "Reprendre l'enregistrement" }).click();
        await page.getByRole('button', { name: 'Action 3', exact: true }).click();
        await row(panel, /Cliquer sur "Action 3"/).waitFor();
        // ANNULER : la dernière action quitte la timeline ET l'enregistrement.
        await panel.getByRole('button', { name: 'Retirer la dernière action du recording' }).click();
        await row(panel, /Cliquer sur "Action 3"/).waitFor({ state: 'detached' });
        // Une écriture (POST /api/items) : un intent métier, qui ne doit apparaître QUE dans l'analyse.
        await page.getByRole('button', { name: 'Create item' }).click();
        await page.getByText('Item created').waitFor();
        await page.waitForTimeout(600);
        await page.getByRole('link', { name: 'Continue' }).click();
        await page.waitForURL('**/done');
        await page.waitForTimeout(600);
      },
      reviewDriver: async ({ panel }) => {
        // STOP → l'écran de revue.
        await panel.getByText('Enregistrement terminé ✓').waitFor({ timeout: 60_000 });
        seen.reviewText = await panel.locator('body').innerText();
        // MODIFIER : retirer une étape la retire du flow (fichiers régénérés).
        await panel.getByRole('button', { name: '✎ Modifier' }).click();
        await panel.getByRole('button', { name: /Retirer l'étape « Cliquer sur "Action 7" »/ }).click();
        await row(panel, /Cliquer sur "Action 7"/).waitFor({ state: 'detached' });
        // Un mot de passe ne se rejoue qu'avec sa variable d'environnement (et si la SafetyPolicy le permet).
        await panel
          .getByRole('button', { name: /Retirer l'étape « Saisir "••••" dans "Password" »/ })
          .click();
        await row(panel, /Password/).waitFor({ state: 'detached' });
        await panel.getByRole('button', { name: '✓ Terminer les modifications' }).click();
        // REJOUER → progression puis résultat.
        await panel.getByRole('button', { name: '▶ Rejouer' }).click();
        await panel
          .locator('#progress')
          .getByText(/Rejeu en cours/)
          .waitFor({ timeout: 30_000 });
        seen.replayProgress = true;
        await panel.getByText(/✓ Replay réussi|✕ Replay interrompu/).waitFor({ timeout: 180_000 });
        seen.replayText = await panel.locator('#review').innerText();
        // SAUVEGARDER.
        await panel.getByRole('button', { name: /Sauvegarder/ }).click();
        await panel.getByText('✓ Flow sauvegardé').waitFor();
        // ANALYSE : l'intent n'apparaît QUE là.
        await panel.getByRole('tab', { name: 'Analyse' }).click();
        seen.analysisText = await panel.locator('#panel-analysis').innerText();
        await panel.getByRole('tab', { name: 'Enregistrement' }).click();
        seen.recordingTabText = await panel.locator('#panel-recording').innerText();
        // MODE DÉVELOPPEUR : les détails techniques.
        await panel.getByRole('button', { name: 'Mode développeur' }).click();
        seen.devText = await timeline(panel).innerText();
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 360_000);

  afterAll(async () => {
    await app.close();
  });

  const file = (name: string): Promise<string> => readFile(path.join(outcome.directory, name), 'utf8');
  const steps = async (): Promise<RecordedFlowStep[]> =>
    (JSON.parse(await file('recorded-flow.json')) as { steps: RecordedFlowStep[] }).steps;

  it('click / fill / check appear in plain words; a password is never shown', () => {
    expect(seen.panelText).toContain('Cliquer sur "Action 7"');
    expect(seen.panelText).toContain('Saisir "Alex" dans "First name"');
    expect(seen.panelText).not.toContain('top-secret-9');
  });

  it('an ambiguous action is shown, the touched element is the only one that can be confirmed', async () => {
    expect(seen.ambiguousShown).toBe(true);
    expect(seen.refusedOtherElement).toBe(true);
    const fill = (await steps()).find((item) => item.label === 'Value');
    expect(fill?.userDecision).toBe('AMBIGUITY_CONFIRMED_BY_USER');
    expect(await file('generated.flow.yaml')).toContain('AMBIGUITY_CONFIRMED_BY_USER');
  });

  it('pause records nothing; resume records again', async () => {
    expect(seen.duringPause).toBe(0);
    const raw = (JSON.parse(await file('raw-recording.json')) as { rawEvents: RawRecordedEvent[] }).rawEvents;
    expect(raw.some((event) => event.element?.name === 'Action 9')).toBe(false);
  });

  it('undo removes the last step from the recording itself (kept as `undone` in the raw trace)', async () => {
    const raw = (JSON.parse(await file('raw-recording.json')) as { rawEvents: RawRecordedEvent[] }).rawEvents;
    expect(raw.find((event) => event.element?.name === 'Action 3')?.undone).toBe(true);
    expect((await steps()).some((item) => item.label === 'Action 3')).toBe(false);
    expect(await file('generated.flow.yaml')).not.toContain('Action 3');
  });

  it('stop shows the review; edit removes a step from the flow files', async () => {
    expect(seen.reviewText).toContain('Rejouer');
    expect(seen.reviewText).toContain('Sauvegarder');
    expect((await steps()).some((item) => item.label === 'Action 7')).toBe(false);
    expect(await file('generated.flow.yaml')).not.toContain('Action 7');
  });

  it('replay shows its progress then its result', () => {
    expect(seen.replayProgress).toBe(true);
    expect(seen.replayText).toMatch(/✓ Replay réussi/);
    expect(seen.replayText).toMatch(/\d+ \/ \d+ actions exécutées/);
    expect(outcome.replay.status).toBe('REPLAY_CONFIRMED');
  });

  it('save copies the flow to flows/<name>/ and marks the recording SAVED', async () => {
    expect(outcome.saved?.files).toContain('recording-ui.flow.yaml');
    await access(path.join(outcome.saved?.directory ?? '', 'recording-ui.flow.yaml'));
    expect(JSON.parse(await file('recording-status.json'))).toMatchObject({ status: 'SAVED' });
  });

  it('the intent appears ONLY in the Analysis tab, never in the recording', async () => {
    expect(outcome.result.flow.intent.workflow).toBeDefined();
    const intent = outcome.result.flow.intent.workflow ?? '';
    expect(seen.analysisText).toContain(intent);
    expect(seen.recordingTabText).not.toContain(intent);
    expect((await steps()).every((item) => item.step.kind !== 'intent')).toBe(true);
  });

  it('developer mode shows the technical details', () => {
    expect(seen.devText).toMatch(/selector=|target=/);
  });
});

describe('Recording UI — a replay that fails', () => {
  let app: DeterministicRecordingApp;
  const seen: Record<string, string> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-record-ui-fail-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-ui-fail }\ntarget: { baseUrl: ${app.url}, startAt: /form }\ndryRun: { maxActions: 3, maxDepth: 2, maxDurationMs: 20000, continueAfterMismatch: false }\n`,
    );
    await runRecording({
      name: 'Replay failure',
      missionFile: path.join(dir, 'mission.yaml'),
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page }) => {
        await page.getByRole('button', { name: 'Action 7', exact: true }).click();
        await page.waitForTimeout(500);
      },
      reviewDriver: async ({ panel }) => {
        await panel.getByText('Enregistrement terminé ✓').waitFor({ timeout: 60_000 });
        // L'application change entre l'enregistrement et le rejeu : « Action 7 » n'existe plus.
        app.broken = true;
        await panel.getByRole('button', { name: '▶ Rejouer' }).click();
        await panel.getByText('✕ Replay interrompu').waitFor({ timeout: 180_000 });
        seen.failure = await panel.locator('#review').innerText();
        await panel.getByRole('button', { name: "Modifier l'étape" }).waitFor();
        await panel.getByRole('button', { name: '↻ Recommencer' }).waitFor();
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  it('says which step failed and why in plain words; the technical details come second', () => {
    expect(seen.failure).toContain('Étape 1 sur');
    expect(seen.failure).toContain('Cliquer sur "Action 7"');
    expect(seen.failure).toMatch(/Cause : (élément introuvable|étape non atteinte)/);
    expect(seen.failure).toContain('Voir les détails');
  });
});

/** Simule une validation AMBIGUOUS de la dernière action sur `label` (le validateur réel la produit sur une page ambiguë). */
async function injectAmbiguity(recorder: HumanFlowRecorder, label: string): Promise<void> {
  const action = [...recorder.timeline.actions].reverse().find((entry) => entry.technical.field === label);
  const rawEventId = action?.rawEventIds.at(-1);
  if (!rawEventId) throw new Error(`no live action on ${label}`);
  // Attendre que la validation réelle soit passée, puis la remplacer (ordre déterministe).
  await new Promise((resolve) => setTimeout(resolve, 400));
  const updated = recorder.timeline.onValidation(rawEventId, ambiguous(rawEventId));
  if (!updated) throw new Error('the ambiguity could not be applied');
  (recorder as unknown as { changed(change: unknown): void }).changed({ reason: 'UPDATED', action: updated });
}
