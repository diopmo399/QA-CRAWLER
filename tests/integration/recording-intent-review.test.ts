import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HumanReviewLedger } from '../../src/recording/application/human-review.js';
import type { ApplicationInteractionModel } from '../../src/recording/application/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * LA CORRECTION HUMAINE D'UNE INTENTION, dans la vraie fenêtre (onglet Analyse) : modifier, annuler,
 * confirmer, réinitialiser. L'action enregistrée, sa cible et le flow rejoué ne changent jamais ;
 * l'interprétation automatique, la décision et l'historique sont tous gardés.
 */
interface Session {
  directory: string;
  ui: Record<string, string>;
  flowBefore: string;
}

describe('Recording — human correction of action intents (analysis window)', () => {
  let app: CompanyRecordingApp;
  let dir: string;
  const sessions: Record<string, Session> = {};

  const row = (panel: Page, text: string): Locator => panel.locator('.irow', { hasText: text }).first();
  const sourceIs = (target: Locator, text: string): Promise<void> =>
    target.locator('.isrc', { hasText: new RegExp(`^${text}$`) }).waitFor();

  const record = async (name: string, knowledge: boolean): Promise<Session> => {
    app.reset();
    const ui: Record<string, string> = {};
    let flowBefore = '';
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: intent-${name} }\ntarget: { baseUrl: ${app.url}, startAt: / }\nsafety:\n  mutations: { enabled: true, maxPerRun: 20 }\nrecording: { knowledge: ${String(knowledge)} }\n`,
    );
    const reportsDir = path.join(dir, name, 'reports');
    const outcome = await runRecording({
      name: `intent-${name}`,
      missionFile,
      overrides: { headless: true, reportsDir },
      env: {},
      language: 'fr',
      drive: async ({ page }) => {
        const pause = (ms = 500): Promise<void> => page.waitForTimeout(ms);
        await page.getByRole('button', { name: 'New company' }).click();
        await pause();
        await page.getByLabel('Company name').fill('Company Test QA');
        await page.getByLabel('Address').fill('123 Main Street');
        await pause();
        await page.getByRole('button', { name: 'Save' }).click();
        await pause(900);
        await page.getByRole('button', { name: 'Tasks' }).click();
        await pause();
        await page.getByLabel('Search companies').fill('Company Test QA');
        await pause();
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await pause(900);
        await page.getByRole('button', { name: 'Company Test QA' }).click();
        await pause(900);
      },
      reviewDriver: async ({ panel }) => {
        await panel.getByText('Enregistrement terminé ✓').waitFor({ timeout: 60_000 });
        // Le flow physique AVANT toute revue : il doit rester identique.
        const recordings = path.join(reportsDir, 'recordings');
        const [folder] = await readdir(recordings);
        flowBefore = await readFile(path.join(recordings, folder ?? '', 'generated.flow.yaml'), 'utf8');
        await panel.getByRole('tab', { name: 'Analyse' }).click();
        await panel.getByText('Actions et intentions').waitFor({ timeout: 60_000 });
        const search = (): Locator => row(panel, 'Cliquer sur "Search"');
        ui.initial = await search().innerText();
        // Modifier puis ANNULER : rien ne change.
        await search().getByRole('button', { name: 'Modifier l’intention' }).click();
        ui.editor = await search().locator('.iedit').innerText();
        await search().getByRole('button', { name: 'Annuler' }).click();
        ui.cancelled = await search().innerText();
        // Modifier → SEARCH (l'analyse disait RETRIEVE), avec une justification → Confirmer.
        await search().getByRole('button', { name: 'Modifier l’intention' }).click();
        await search().locator('.iedit').getByText('SEARCH', { exact: true }).click();
        await search().locator('textarea').fill('Le bouton lance la recherche sur les critères saisis.');
        await search().locator('.iedit').getByRole('button', { name: 'Confirmer' }).click();
        await sourceIs(search(), '👤 HUMAN');
        ui.corrected = await search().innerText();
        // Réinitialiser : l'interprétation automatique revient, l'historique reste.
        await search().getByRole('button', { name: 'Réinitialiser l’interprétation' }).click();
        await sourceIs(search(), 'SYSTEM');
        await search().locator('summary').click();
        ui.reset = await search().innerText();
        // Confirmer une autre action telle quelle ; corriger encore celle-ci (→ FILTER).
        const save = row(panel, 'Cliquer sur "Save"');
        await save.getByRole('button', { name: 'Confirmer' }).click();
        await sourceIs(save, '👤 HUMAN CONFIRMED');
        ui.confirmed = await save.innerText();
        await search().getByRole('button', { name: 'Modifier l’intention' }).click();
        await search().locator('.iedit').getByText('FILTER', { exact: true }).click();
        await search().locator('.iedit').getByRole('button', { name: 'Confirmer' }).click();
        await sourceIs(search(), '👤 HUMAN');
        ui.final = await search().innerText();
      },
    });
    return { directory: outcome.directory, ui, flowBefore };
  };

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-intent-'));
    sessions.remembered = await record('remembered', true);
    sessions.forgotten = await record('forgotten', false);
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const read = async <T>(session: Session | undefined, file: string): Promise<T> =>
    JSON.parse(await readFile(path.join(session?.directory ?? '', file), 'utf8')) as T;

  it('each action shows its intent, source and confidence; the editor offers the model intents; cancel changes nothing', () => {
    const ui = sessions.remembered?.ui ?? {};
    expect(ui.initial).toMatch(
      /Cliquer sur "Search"[\s\S]*Intention[\s\S]*RETRIEVE[\s\S]*Source : SYSTEM · Confiance : \d+ %/,
    );
    for (const intent of [
      'CREATE',
      'SEARCH',
      'FILTER',
      'OPEN',
      'UPDATE',
      'DELETE',
      'SAVE',
      'SUBMIT',
      'NAVIGATE',
      'UNKNOWN',
    ])
      expect(ui.editor).toContain(intent);
    expect(ui.editor).toContain('Justification (facultative)');
    expect(ui.cancelled).toBe(ui.initial);
  });

  it('SEARCH chosen by the human: source HUMAN, original kept, justification shown; reset brings SYSTEM back with the history', () => {
    const ui = sessions.remembered?.ui ?? {};
    expect(ui.corrected).toMatch(
      /SEARCH[\s\S]*Source : 👤 HUMAN[\s\S]*Original : RETRIEVE · Confiance initiale : \d+ %[\s\S]*Correction : « Le bouton lance la recherche sur les critères saisis. »/,
    );
    expect(ui.reset).toMatch(/RETRIEVE[\s\S]*Source : SYSTEM/);
    expect(ui.reset).toMatch(
      /Historique \(3\)[\s\S]*SYSTEM → RETRIEVE[\s\S]*HUMAN → SEARCH « Le bouton lance la recherche sur les critères saisis. »[\s\S]*RESET → RETRIEVE/,
    );
    expect(ui.confirmed).toMatch(/Source : 👤 HUMAN CONFIRMED/);
    expect(ui.final).toMatch(/FILTER[\s\S]*Original : RETRIEVE/);
  });

  it('the files: append-only ledger, reviewed model (automatic interpretation intact), human evidence, report section', async () => {
    const ledger = await read<HumanReviewLedger>(sessions.remembered, 'human-review.json');
    expect(ledger.decisions.map((decision) => `${decision.type}:${decision.newIntent.join('+')}`)).toEqual([
      'CORRECT:SEARCH',
      'RESET:RETRIEVE',
      'CONFIRM:SWITCH_CONTEXT+CREATE',
      'CORRECT:FILTER',
    ]);
    expect(ledger.decisions[0]).toMatchObject({
      reason: 'Le bouton lance la recherche sur les critères saisis.',
      context: { page: '/tasks', role: 'button' },
    });
    const model = await read<ApplicationInteractionModel>(sessions.remembered, 'application-model.json');
    const view = model.actions.find((action) => action.actionId === ledger.decisions[0]?.subject.actionId);
    expect(view?.interpretation).toEqual(['RETRIEVE']);
    expect(view?.review).toMatchObject({
      status: 'HUMAN_CORRECTED',
      source: 'HUMAN',
      finalIntent: 'FILTER',
      originalIntent: ['RETRIEVE'],
    });
    expect(view?.review?.history).toHaveLength(4);
    expect(
      model.evidence
        .filter((entry) => entry.source === 'HUMAN')
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['INTENT_CONFIRMATION', 'INTENT_CORRECTION', 'INTENT_CORRECTION', 'INTENT_RESET']);
    expect(model.summary.actions).toMatchObject({ humanCorrected: 1, humanConfirmed: 1 });
    const html = await readFile(path.join(sessions.remembered?.directory ?? '', 'index.html'), 'utf8');
    expect(html).toContain('Interpretation review (human)');
  });

  it('the replay is unchanged: same generated flow, same physical click on the same target', async () => {
    const after = await readFile(
      path.join(sessions.remembered?.directory ?? '', 'generated.flow.yaml'),
      'utf8',
    );
    expect(after).toBe(sessions.remembered?.flowBefore);
    expect(after).toMatch(/Search/);
    // Le flow rejoué ne porte aucune intention choisie par l'humain.
    expect(after).not.toMatch(/FILTER/);
  });

  it('knowledge: the decisions are kept WITH their context when recording.knowledge is on, never when off', async () => {
    const knowledgeOf = async (name: string): Promise<string> => {
      const folder = path.join(dir, name, 'knowledge', 'functional');
      const files = await readdir(folder).catch(() => [] as string[]);
      return (await Promise.all(files.map((file) => readFile(path.join(folder, file), 'utf8')))).join('\n');
    };
    const remembered = JSON.parse((await knowledgeOf('remembered')) || '{}') as {
      intentDecisions?: { intent: string; scope: string; context: { page?: string; element?: string } }[];
    };
    expect(remembered.intentDecisions?.map((entry) => entry.scope)).toEqual(['CONTEXTUAL', 'CONTEXTUAL']);
    expect(remembered.intentDecisions?.find((entry) => entry.intent === 'FILTER')?.context).toMatchObject({
      page: '/tasks',
      element: 'button "Search"',
    });
    const forgotten = JSON.parse((await knowledgeOf('forgotten')) || '{}') as { intentDecisions?: unknown[] };
    expect(forgotten.intentDecisions ?? []).toEqual([]);
  });
});
