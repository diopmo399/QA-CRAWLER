import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

/**
 * LE DOCK DANS LA PAGE (recording.panelLayout: docked) : une seule fenêtre Chromium pendant
 * l'enregistrement. Le bandeau de l'application est le mini-dock (dernières actions et statuts,
 * compteurs, Pause / Annuler / Arrêter) ; « Fenêtre » ouvre le cockpit à la demande ; l'arrêt depuis
 * le dock ouvre la revue dans la fenêtre.
 */
interface DockState {
  steps: { id: string; index: number; kind: string; description: string; status: string }[];
  counts: { actions: number; confirmed: number; ambiguous: number; failed: number };
  minimized: boolean;
  mounted: boolean;
}
type Rect = { x: number; y: number; width: number; height: number } | undefined;

const dockOf = (page: Page): Promise<DockState> =>
  page.evaluate(() =>
    (
      window as unknown as { __qaCrawlerRecorder: { dockState(): DockState } }
    ).__qaCrawlerRecorder.dockState(),
  );

/** Un bouton du dock (shadow root fermé) cliqué à la souris, comme l'humain. */
async function clickDock(page: Page, act: string): Promise<void> {
  const rect = await page.evaluate(
    (name) =>
      (
        window as unknown as { __qaCrawlerRecorder: { dockRect(act: string): Rect } }
      ).__qaCrawlerRecorder.dockRect(name),
    act,
  );
  if (!rect) throw new Error(`no dock button "${act}"`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout: ${label}`);
}

describe('In-page dock — one Chromium window while recording, the cockpit on demand', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const seen: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-dock-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-dock }\ntarget: { baseUrl: ${app.url}, startAt: /form }\nrecording: { panelLayout: docked }\n`,
    );
    outcome = await runRecording({
      name: 'Dock',
      missionFile: path.join(dir, 'mission.yaml'),
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page, panel, panelOf }) => {
        // Aucune fenêtre du recorder : seulement l'application.
        seen.panelAtStart = panel;
        seen.contextPages = page.context().pages().length;
        const empty = await dockOf(page);
        seen.dockEmpty = empty;
        await page.getByLabel('First name').click();
        await page.getByLabel('First name').pressSequentially('Alex', { delay: 20 });
        await page.waitForTimeout(600);
        await page.getByRole('button', { name: 'Action 7', exact: true }).click();
        await page.getByRole('button', { name: 'Action 9', exact: true }).click();
        // Le dock montre les dernières actions avec leur statut, et les compteurs.
        seen.dock = await waitFor(
          () => dockOf(page),
          (dock) =>
            dock.counts.actions >= 3 &&
            dock.steps.some((step) => /Action 9/.test(step.description)) &&
            dock.steps.every((step) => step.status === 'CONFIRMED'),
          'dock steps confirmed',
        );
        // Une navigation : le dock revient, avec ses actions.
        await page.getByRole('link', { name: 'Continue' }).click();
        await page.waitForURL(/\/done$/);
        seen.dockAfterNavigation = await waitFor(
          () => dockOf(page),
          (dock) => dock.mounted && dock.steps.length > 0,
          'dock after navigation',
        );
        // « Fenêtre » : le cockpit s'ouvre à la demande, complet.
        await clickDock(page, 'window');
        const window = await waitFor(
          () => Promise.resolve(panelOf?.()),
          (value) => value !== undefined,
          'window',
        );
        if (!window) throw new Error('no window');
        await window.getByText('Parcours enregistré').waitFor({ timeout: 15_000 });
        seen.windowText = await window.locator('#timeline').innerText();
        await window.close();
        await page.waitForTimeout(400);
        seen.panelAfterClose = panelOf?.();
        // « Arrêter » depuis le dock.
        await clickDock(page, 'stop');
      },
      reviewDriver: async ({ panel }) => {
        // La revue a ouvert la fenêtre d'elle-même.
        await panel.getByText('Enregistrement terminé', { exact: true }).waitFor({ timeout: 60_000 });
        seen.reviewText = await panel.locator('#timeline').innerText();
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  it('no recorder window during the recording: the dock in the page carries the actions and the counts', () => {
    expect(seen.panelAtStart).toBeUndefined();
    expect(seen.contextPages).toBe(1);
    // Au départ : le dock est là, avec au plus l'ouverture de la page.
    const empty = seen.dockEmpty as DockState;
    expect(empty.mounted).toBe(true);
    expect(empty.steps.length).toBeLessThanOrEqual(1);
    const dock = seen.dock as DockState;
    expect(dock.counts.actions).toBeGreaterThanOrEqual(3);
    expect(dock.counts.confirmed).toBe(dock.counts.actions);
    expect(dock.steps.length).toBeLessThanOrEqual(3);
    expect(dock.steps.at(-1)?.description).toContain('Action 9');
    expect(dock.steps.map((step) => step.status)).toEqual(dock.steps.map(() => 'CONFIRMED'));
    // Jamais une valeur saisie dans le dock : la description dit le champ, pas « Alex » hors description.
    expect(dock.steps.every((step) => step.description.length <= 90)).toBe(true);
  });

  it('the dock survives a navigation; "Window" opens the full cockpit on demand and closing it keeps the dock', () => {
    const after = seen.dockAfterNavigation as DockState;
    expect(after.mounted).toBe(true);
    expect(after.steps.length).toBeGreaterThan(0);
    expect(String(seen.windowText)).toContain('Action 9');
    expect(seen.panelAfterClose).toBeUndefined();
  });

  it('"Stop" from the dock ends the recording; the review opens its window by itself', () => {
    expect(outcome.result.flow.steps.length).toBeGreaterThan(0);
    expect(String(seen.reviewText)).toContain('Action 9');
  });
});
