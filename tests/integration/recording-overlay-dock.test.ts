import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordedFlowStep } from '../../src/recording/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Le bandeau (shadow DOM fermé) : sa boîte, lue sur l'hôte. */
async function barBox(page: Page): Promise<Box> {
  const box = await page.locator('qa-crawler-recorder').boundingBox();
  if (!box) throw new Error('the recording bar is not displayed');
  return box;
}

/**
 * LE BANDEAU NE CACHE PAS L'APPLICATION : l'humain le glisse dans un autre coin ou le réduit ; le
 * choix suit les pages ; ni le glisser ni la réduction ne sont des actions enregistrées.
 */
describe('Recording bar — move and minimize', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  const seen: { afterDrag?: Box; minimized?: Box; afterNavigation?: Box; viewport?: Box } = {};
  let steps: RecordedFlowStep[] = [];

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-dock-'));
    const missionFile = path.join(dir, 'dock.mission.yaml');
    await writeFile(
      missionFile,
      `mission: { name: dock }\ntarget: { baseUrl: ${app.url}, startAt: /form }\n`,
    );
    const outcome = await runRecording({
      name: 'dock',
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'en',
      drive: async ({ page }) => {
        await page.locator('qa-crawler-recorder').waitFor();
        // Le bandeau monté et rendu (minuteur, boutons) avant de le saisir.
        await page.waitForTimeout(500);
        const size = page.viewportSize() ?? { width: 1280, height: 720 };
        seen.viewport = { x: 0, y: 0, ...size };
        const start = await barBox(page);
        // La poignée est au début du bandeau : glissée vers le coin en haut à gauche.
        await page.mouse.move(start.x + 16, start.y + 18);
        await page.mouse.down();
        await page.mouse.move(120, 60, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        seen.afterDrag = await barBox(page);
        // Réduire : le dernier bouton du bandeau.
        await page.mouse.click(seen.afterDrag.x + seen.afterDrag.width - 20, seen.afterDrag.y + 18);
        await page.waitForTimeout(200);
        seen.minimized = await barBox(page);
        await page.getByRole('button', { name: 'Action 7', exact: true }).click();
        await page.waitForTimeout(300);
        await page.getByRole('link', { name: 'Continue' }).click();
        await page.waitForURL('**/done');
        await page.waitForTimeout(800);
        seen.afterNavigation = await barBox(page);
      },
    });
    const recorded = JSON.parse(
      await readFile(path.join(outcome.directory, 'recorded-flow.json'), 'utf8'),
    ) as { steps: RecordedFlowStep[] };
    steps = recorded.steps;
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  it('dragged, the bar settles in the nearest corner (top left)', () => {
    expect(seen.afterDrag?.x).toBeLessThanOrEqual(16);
    expect(seen.afterDrag?.y).toBeLessThanOrEqual(16);
  });

  it('minimized, the bar is a small pill that stays in its corner', () => {
    expect(seen.minimized?.width).toBeLessThan((seen.afterDrag?.width ?? 0) / 2);
    expect(seen.minimized?.x).toBeLessThanOrEqual(16);
  });

  it('the place and the size follow the human to the next page', () => {
    expect(seen.afterNavigation?.x).toBeLessThanOrEqual(16);
    expect(seen.afterNavigation?.y).toBeLessThanOrEqual(16);
    expect(seen.afterNavigation?.width).toBeLessThan((seen.afterDrag?.width ?? 0) / 2);
  });

  it('moving or minimizing the bar is never a recorded action', () => {
    const clicks = steps.filter((item) => item.step.kind === 'click');
    expect(clicks).toHaveLength(2);
    expect(JSON.stringify(steps)).not.toMatch(/qa-crawler|Minimize|Drag to move/);
  });
});
