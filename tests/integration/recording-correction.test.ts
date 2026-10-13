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
 * CORRECTION MANAGER de bout en bout : l'humain corrige la cible d'une action DANS LE NAVIGATEUR —
 * pendant l'enregistrement (la page de l'application, encore ouverte), puis en revue après un rejeu
 * en échec (la page est rouverte en mode sélection seul). Dans les deux cas : survol encadré, clic
 * jamais transmis à l'application, Échap annule, la nouvelle cible se construit avec le résolveur de
 * l'enregistrement, l'original reste dans l'historique.
 */
const row = (panel: Page, text: string | RegExp) => panel.locator('#timeline .item', { hasText: text });
const PICKING = 'data-qa-crawler-overlay-picking';

/** Le mode sélection est actif dans la page (attribut posé par le script de capture, hors shadow root). */
const pickingIn = (page: Page, on: boolean): Promise<void> =>
  page
    .waitForFunction(
      ({ attribute, expected }) => (document.documentElement.getAttribute(attribute) === 'true') === expected,
      { attribute: PICKING, expected: on },
      { timeout: 15_000 },
    )
    .then(() => undefined);

/** Survoler puis cliquer un élément de la page comme le ferait une souris (le script lit elementFromPoint). */
async function pickWithMouse(page: Page, name: string): Promise<void> {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  if (!box) throw new Error(`no box for "${name}"`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 20, y - 5);
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
}

/** La page rouverte pour la revue : attendue tant que l'orchestrateur ne l'a pas ouverte. */
async function correctionPageOf(recorder: HumanFlowRecorder): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = recorder.correctionPage;
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the correction page did not open');
}

describe('Correction manager — the target of an action is corrected in the browser', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const seen: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-correction-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-correction }\ntarget: { baseUrl: ${app.url}, startAt: /form }\ndryRun: { maxActions: 6, maxDepth: 2, maxDurationMs: 60000, continueAfterMismatch: false }\n`,
    );
    outcome = await runRecording({
      name: 'Correction manager',
      missionFile: path.join(dir, 'mission.yaml'),
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page, panel }) => {
        if (!panel) throw new Error('the recorder window did not open');
        // Une action enregistrée : « Cliquer sur "Action 7" ».
        await page.getByRole('button', { name: 'Action 7', exact: true }).click();
        await row(panel, /Cliquer sur "Action 7"/).waitFor({ timeout: 5000 });
        await page.waitForTimeout(400);
        // Ses détails : le bouton « Corriger dans le navigateur ».
        await row(panel, /Cliquer sur "Action 7"/).click();
        await panel.getByText(/Correction de l'étape \d+/).waitFor();
        await panel.getByRole('button', { name: 'Corriger dans le navigateur' }).click();
        // La page passe en mode sélection ; la fenêtre le dit.
        await pickingIn(page, true);
        await panel.getByText('Mode sélection actif · Échap pour quitter').first().waitFor();
        seen.pickBadgeInPreview = await panel.locator('#preview-card .pickbadge').count();
        // ÉCHAP annule : rien ne change.
        await page.keyboard.press('Escape');
        await pickingIn(page, false);
        await panel.getByText('Sélection annulée : la cible ne change pas.').waitFor();
        // De nouveau : survoler « Action 8 » puis cliquer. Le clic n'atteint pas l'application.
        await panel.getByRole('button', { name: 'Corriger dans le navigateur' }).click();
        await pickingIn(page, true);
        await pickWithMouse(page, 'Action 8');
        await pickingIn(page, false);
        seen.appReceivedClick = await page.locator('#last').textContent();
        seen.lastRect = await page.evaluate(
          () => (window as unknown as { __qaCrawlerLastRect?: { width: number } }).__qaCrawlerLastRect,
        );
        // La proposition : ancienne cible → nouvelle cible, ordre de résolution, Valider.
        await panel.getByText('NOUVELLE CIBLE').waitFor();
        seen.proposalText = await panel.locator('#details .correction').innerText();
        await panel.getByRole('button', { name: 'Valider la correction' }).click();
        await row(panel, /Cible corrigée par l'utilisateur/).waitFor();
        seen.rowText = await row(panel, /Action 7/).innerText();
        seen.afterApply = await panel.locator('#details .correction').innerText();
        // RESTAURER puis corriger de nouveau : l'historique vit, la décision finale est la correction.
        await panel.getByRole('button', { name: "Restaurer l'original" }).click();
        await row(panel, /Cible originale restaurée/).waitFor();
        await panel.getByRole('button', { name: 'Corriger dans le navigateur' }).click();
        await pickingIn(page, true);
        await pickWithMouse(page, 'Action 8');
        await panel.getByText('NOUVELLE CIBLE').waitFor();
        await panel.getByRole('button', { name: 'Valider la correction' }).click();
        await row(panel, /Cible corrigée par l'utilisateur/).waitFor();
        await page.waitForTimeout(400);
      },
      reviewDriver: async ({ panel, recorder }) => {
        await panel.getByText('Enregistrement terminé ✓').waitFor({ timeout: 60_000 });
        seen.reviewRow = await row(panel, /Action 7|Action 8/).innerText();
        // L'application change : « Action 8 » devient « Renamed 8 » → le rejeu échoue sur l'étape corrigée.
        app.renamed = 8;
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel.getByText('✕ Replay interrompu').waitFor({ timeout: 180_000 });
        seen.failureText = await panel.locator('#review').innerText();
        // Depuis la carte d'échec : corriger dans le navigateur → l'application est rouverte en mode sélection.
        await panel.locator('#review').getByRole('button', { name: 'Corriger dans le navigateur' }).click();
        const page = await correctionPageOf(recorder);
        await pickingIn(page, true);
        seen.reviewPageUrl = page.url();
        seen.reviewPageHasBar = await page.evaluate(
          () => document.querySelector('qa-crawler-recorder') !== null,
        );
        await pickWithMouse(page, 'Renamed 8');
        await pickingIn(page, false);
        await panel.getByText('NOUVELLE CIBLE').waitFor();
        seen.reviewProposal = await panel.locator('#details .correction').innerText();
        await panel.getByRole('button', { name: "Tester l'étape" }).click();
        await panel.getByRole('button', { name: 'Valider la correction' }).click();
        await panel.locator('#details .correction').getByText('Historique des corrections').waitFor();
        seen.reviewHistory = await panel.locator('#details .correction').innerText();
        // Le flow corrigé se rejoue : vert.
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel.getByText(/✓ Replay réussi|✕ Replay interrompu/).waitFor({ timeout: 180_000 });
        seen.secondReplay = await panel.locator('#review').innerText();
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 480_000);

  afterAll(async () => {
    await app.close();
  });

  const steps = async (): Promise<RecordedFlowStep[]> =>
    (
      JSON.parse(await readFile(path.join(outcome.directory, 'recorded-flow.json'), 'utf8')) as {
        steps: RecordedFlowStep[];
      }
    ).steps;

  it('the window shows the selection mode, Escape cancels it, the click never reaches the application', () => {
    expect(seen.pickBadgeInPreview).toBe(1);
    expect(seen.appReceivedClick).not.toContain('Action 8 done');
    expect(seen.lastRect).toMatchObject({ width: expect.any(Number) as number });
  });

  it('the proposal shows the old target, the new one (role + name), the traits and the resolution order', () => {
    const text = String(seen.proposalText);
    expect(text).toContain('ANCIENNE CIBLE');
    expect(text).toContain('NOUVELLE CIBLE');
    expect(text).toContain('button "Action 8"');
    expect(text).toContain('Ordre de résolution au rejeu');
    expect(text).toContain('rôle + nom accessible');
    expect(text).toContain('Valider la correction');
  });

  it('during the recording, the corrected action becomes ✓ and the generated flow targets the new element', async () => {
    expect(String(seen.rowText)).toContain('Cible corrigée par l\'utilisateur : button "Action 8"');
    expect(String(seen.afterApply)).toContain('CORRIGÉE');
    expect(String(seen.afterApply)).toContain("Restaurer l'original");
    const flow = await steps();
    const click = flow.find((step) => step.step.kind === 'click');
    expect(click?.step.kind === 'click' && click.step.target).toMatchObject({
      strategy: 'role',
      name: 'Renamed 8',
    });
    expect(click?.userDecision).toBe('TARGET_CORRECTED_BY_USER');
    // L'historique : la correction pendant l'enregistrement (Action 7 → Action 8), puis celle de la revue.
    expect(click?.corrections?.[0]).toMatchObject({
      previous: { strategy: 'role', name: 'Action 7' },
      next: { strategy: 'role', name: 'Action 8' },
      by: 'USER',
    });
    expect(click?.corrections?.at(-1)).toMatchObject({ next: { strategy: 'role', name: 'Renamed 8' } });
    expect(outcome.result.files.yaml).toContain('Renamed 8');
    expect(outcome.result.files.yaml).not.toContain('Action 7');
  });

  it('in the review, the failed step is corrected in a reopened page, then the replay passes', () => {
    expect(String(seen.reviewRow)).toContain("Cible corrigée par l'utilisateur");
    expect(String(seen.failureText)).toContain('✕ Replay interrompu');
    expect(String(seen.reviewPageUrl)).toContain('/form');
    expect(seen.reviewPageHasBar).toBe(true);
    expect(String(seen.reviewProposal)).toContain('button "Renamed 8"');
    expect(String(seen.reviewHistory)).toContain('Historique des corrections');
    expect(String(seen.secondReplay)).toContain('✓ Replay réussi');
  });

  it('the events journal says what was corrected, never a typed value', async () => {
    const events = await readFile(path.join(outcome.directory, 'recording-events.jsonl'), 'utf8');
    expect(events).toContain('"TARGET_CORRECTED"');
    expect(events).toContain('"RECORDING_TARGET_CORRECTED"');
    expect(events).toContain('target corrected by the user');
  });
});
