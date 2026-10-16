import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordedFlowStep } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

/**
 * LA LIGNE PAR SES COLONNES, SANS NAVIGATEUR. L'enregistrement garde toutes les cellules de la ligne
 * cliquée (N°, Name, Created). En revue, « Modifier la ligne » les montre : la clé du serveur (N°, propre
 * au run) est décochée, « Name » est liée à la donnée du run (la valeur générée au rejeu) et « Created »
 * à une NOUVELLE donnée de test (ajoutée à test-data.yaml). Le rejeu suivant crée une autre ligne et la
 * retrouve par ces colonnes.
 */
const row = (panel: Page, text: string | RegExp) => panel.locator('#timeline .item', { hasText: text });
const column = (panel: Page, name: string, field: string) =>
  panel.locator(`#details [data-rowcol="${field}"][data-column="${name}"]`);

describe('Row columns — the row is redefined column by column in the review, without the browser', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const seen: Record<string, string> = {};

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    app.table = true;
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-row-columns-'));
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: recording-row-columns }\ntarget: { baseUrl: ${app.url}, startAt: /form }\ndryRun: { maxActions: 8, maxDepth: 2, maxDurationMs: 90000, continueAfterMismatch: false }\n`,
    );
    outcome = await runRecording({
      name: 'Row columns',
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
      reviewDriver: async ({ panel }) => {
        await panel.getByText('Enregistrement terminé', { exact: true }).waitFor({ timeout: 60_000 });
        await row(panel, /Cliquer sur "Open"/).click();
        await panel.locator('#details').getByRole('button', { name: 'Modifier la ligne' }).click();
        await column(panel, 'Name', 'on').waitFor();
        seen.editor = await panel.locator('#details .roweditor').innerText();
        // La clé du serveur ne sert plus ; le nom vient de la donnée du run ; la date devient une donnée.
        await column(panel, 'N°', 'on').uncheck();
        await column(panel, 'Name', 'on').check();
        await column(panel, 'Name', 'source').selectOption('variable');
        await column(panel, 'Created', 'on').check();
        await column(panel, 'Created', 'source').selectOption('new-variable');
        await column(panel, 'Created', 'newKey').fill('row.created');
        // Aucune page de l'application ouverte : l'aperçu le dit, rien n'est deviné.
        await panel.locator('#details').getByRole('button', { name: 'Aperçu dans la page' }).click();
        await panel.locator('#details .rpreview').waitFor();
        seen.preview = await panel.locator('#details .rpreview').innerText();
        await panel.locator('#details').getByRole('button', { name: 'Valider la ligne' }).click();
        await panel.locator('#details').getByRole('button', { name: 'Modifier la ligne' }).waitFor();
        seen.after = await panel.locator('#details .correction').innerText();
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel
          .locator('#review')
          .getByText(/Rejeu réussi|Rejeu interrompu/)
          .waitFor({ timeout: 180_000 });
        seen.replay = await panel.locator('#review').innerText();
        await panel.getByRole('button', { name: 'Fermer' }).click();
      },
    });
  }, 600_000);

  afterAll(async () => {
    await app.close();
  });

  const open = async (): Promise<RecordedFlowStep | undefined> =>
    (
      JSON.parse(await readFile(path.join(outcome.directory, 'recorded-flow.json'), 'utf8')) as {
        steps: RecordedFlowStep[];
      }
    ).steps.find(
      (step) => step.step.kind === 'click' && 'target' in step.step && step.step.target.name === 'Open',
    );

  it('the recording kept every cell of the clicked row, and the editor shows them', () => {
    expect(seen.editor).toContain('N°');
    expect(seen.editor).toContain('Name');
    expect(seen.editor).toContain('Created');
    expect(seen.editor).toContain('2026-01-02');
    expect(seen.preview).toContain('Aperçu indisponible');
  });

  it('the step targets the row by the chosen columns: a run value and a new test data, no server key', async () => {
    const step = await open();
    const target = step?.step.kind === 'click' ? step.step.target : undefined;
    expect(Object.keys(target?.row ?? {})).toEqual(['Name', 'Created']);
    expect(target?.row?.Name).toMatch(/^\$\{testData:.+\}$/);
    expect(target?.row?.Created).toBe('${testData:row.created}');
    expect(step?.corrections?.[0]?.previous).toMatchObject({ row: { 'N°': '3024' } });
    expect(outcome.result.files.yaml).not.toContain('3024');
    const testData = await readFile(path.join(outcome.directory, 'test-data.yaml'), 'utf8');
    expect(testData).toMatch(/created:[\s\S]*value: ["']?2026-01-02/);
  });

  it('the next replay creates another row and finds it by these columns', () => {
    expect(seen.replay).toContain('Rejeu réussi');
  });
});
