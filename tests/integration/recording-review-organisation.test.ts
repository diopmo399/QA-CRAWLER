import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * LA REVUE ORGANISÉE, dans la vraie fenêtre du recorder : création → recherche → ouverture.
 *   - les groupes PROPOSÉS d'après les étapes métier (un clic les crée ; l'ordre ne bouge pas) ;
 *   - chaque groupe est une carte qui CONTIENT ses étapes ; le fil des trois étapes de la revue ;
 *   - une vérification de groupe (la recherche retrouve la donnée créée) écrite comme une étape `expect`
 *     qui CITE la donnée, et qui PASSE au rejeu réel avec la valeur générée pour ce run ;
 *   - la barre de sélection n'apparaît que lorsque des étapes sont cochées, et garde le nom saisi ;
 *   - la génération repliée sur une ligne ; l'en-tête ne déborde pas dans une fenêtre étroite.
 */
describe('Recording review — organised journey (recorder window + replay)', () => {
  let app: CompanyRecordingApp;
  let recorded = '';
  const ui: Record<string, string | number | boolean> = {};

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-review-organisation-'));
    const missionFile = path.join(dir, 'organisation.mission.yaml');
    await writeFile(
      missionFile,
      `mission: { name: organisation }\ntarget: { baseUrl: ${app.url}, startAt: / }\nsafety:\n  mutations: { enabled: true, maxPerRun: 20 }\n`,
    );
    const outcome = await runRecording({
      name: 'create-and-find',
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page }) => {
        const pause = (ms = 500): Promise<void> => page.waitForTimeout(ms);
        await page.getByRole('button', { name: 'New company' }).click();
        await pause();
        await page.getByLabel('Company name').fill('Company ABC');
        await page.getByLabel('Address').fill('123 Main Street');
        await pause();
        await page.getByRole('button', { name: 'Save' }).click();
        await pause(900);
        await page.getByLabel('Search companies').fill('Company ABC');
        await pause();
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await pause(900);
        await page.getByRole('button', { name: 'Company ABC' }).click();
        await pause(900);
      },
      reviewDriver: async ({ panel }) => {
        await panel.setViewportSize({ width: 1440, height: 1000 });
        await panel.getByText('Enregistrement terminé', { exact: true }).waitFor({ timeout: 60_000 });
        // 1. Le fil de la revue, puis les groupes proposés.
        ui.stepsBefore = await panel.locator('.rsteps').innerText();
        const propose = panel.locator('li.gpropose');
        await propose.waitFor({ timeout: 30_000 });
        ui.proposal = await propose.innerText();
        await propose.locator('[data-cmd="grp-accept-proposals"]').click();
        await panel.locator('li.bgroup').first().waitFor({ timeout: 15_000 });
        await panel.locator('li.gpropose').waitFor({ state: 'detached' });
        ui.groups = await panel.locator('li.bgroup').count();
        ui.nestedSteps = await panel.locator('li.bgroup .gsteps > li[data-step]').count();
        ui.firstGroup = await panel.locator('li.bgroup .ghead').first().innerText();
        ui.stepsAfter = await panel.locator('.rsteps').innerText();
        // 2. La vérification de groupe suggérée : la recherche retrouve la donnée créée.
        const check = panel.locator('#pz-checks [data-cmd="grp-add-check"]').first();
        await check.waitFor({ timeout: 15_000 });
        ui.checkRow = await panel.locator('#pz-checks .prow').first().innerText();
        await check.click();
        await panel
          .locator('#pz-inFlow')
          .getByText(/is displayed at the end of/)
          .waitFor({ timeout: 15_000 });
        ui.inFlow = await panel.locator('#pz-inFlow').innerText();
        // 3. La génération, repliée sur une ligne.
        ui.genLine = await panel.locator('#sec-generation.gline').count();
        // 3 bis. Le bloc des propositions faibles (absent de cette application) : une proposition faible
        // ajoutée à l'état AFFICHÉ seulement — repliée, une ligne et sa raison, « Tout refuser ».
        await panel.evaluate(() => {
          const w = window as unknown as {
            __qaPanelRender: (state: unknown) => void;
            __qaLast?: { proposals?: Record<string, unknown>[] };
          };
          const render = w.__qaPanelRender;
          w.__qaPanelRender = (state) => {
            w.__qaLast = state as typeof w.__qaLast;
            render(state);
          };
        });
        // Choisir une étape renvoie l'état depuis Node : la fenêtre le garde alors (__qaLast).
        await panel.locator('li[data-step] button.item').first().click();
        await panel.waitForFunction(
          () => (window as unknown as { __qaLast?: unknown }).__qaLast !== undefined,
        );
        await panel.evaluate(() => {
          const w = window as unknown as {
            __qaPanelRender: (state: unknown) => void;
            __qaLast: { proposals?: Record<string, unknown>[] };
          };
          const base = w.__qaLast.proposals?.[0] ?? {};
          const weak = { ...base, id: 'p900', status: 'PROPOSED', inFlow: false, method: 'REPORT_ONLY' };
          w.__qaPanelRender({ ...w.__qaLast, proposals: [...(w.__qaLast.proposals ?? []), weak] });
        });
        ui.weak = await panel.locator('#pz-weak').innerText();
        // 4. Mode Modifier : pas de barre sans étape cochée ; elle garde le nom saisi d'une coche à l'autre.
        await panel.getByRole('button', { name: 'Modifier', exact: true }).click();
        ui.barBefore = await panel.locator('li.selbar').count();
        const picks = panel.locator('input.epick');
        await picks.nth(0).check();
        await panel.locator('li.selbar').waitFor();
        await panel.locator('#grp-new-name').fill('Mon groupe');
        await picks.nth(1).check();
        ui.keptName = await panel.locator('#grp-new-name').inputValue();
        ui.picked = await panel.locator('li.selbar .n').innerText();
        await panel.locator('[data-cmd="grp-unpick"]').click();
        await panel.locator('li.selbar').waitFor({ state: 'detached' });
        await panel.getByRole('button', { name: 'Terminer les modifications', exact: true }).click();
        // 5. Fenêtre étroite : l'en-tête passe sur deux lignes, rien ne déborde.
        await panel.setViewportSize({ width: 1000, height: 900 });
        await panel.waitForTimeout(200);
        ui.overflow = await panel.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        await panel.setViewportSize({ width: 1440, height: 1000 });
        // 6. Le rejeu réel : la vérification cite la valeur générée pour CE run, et passe.
        await panel.getByRole('button', { name: 'Rejouer le parcours' }).click();
        await panel
          .locator('#review')
          .getByText(/Rejeu réussi|Rejeu interrompu/)
          .waitFor({ timeout: 120_000 });
        ui.replay = await panel.locator('#review').innerText();
      },
    });
    recorded = outcome.directory;
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  it('proposes groups from the business steps, creates them in one click, and nests their steps', () => {
    expect(ui.stepsBefore).toMatch(
      /Organiser le parcours[\s\S]*Décider des assertions[\s\S]*Générer les tests/,
    );
    expect(ui.proposal).toMatch(/Groupes proposés d'après les étapes métier reconnues/);
    expect(ui.proposal).toMatch(/étapes? \d/);
    expect(Number(ui.groups)).toBeGreaterThanOrEqual(2);
    expect(Number(ui.nestedSteps)).toBeGreaterThan(0);
    expect(ui.firstGroup).toMatch(/\d+ étapes?/);
    expect(ui.stepsAfter).toMatch(/\d+ groupes? · \d+ étapes?/);
  });

  it('adds the suggested group check, which cites the data and passes at replay with the run value', async () => {
    expect(ui.checkRow).toMatch(/Ajouter une vérification au groupe « .+ »[\s\S]*\$\{testData:\S+\}/);
    expect(ui.inFlow).toMatch(/is displayed at the end of/);
    expect(ui.replay).toContain('Rejeu réussi');
    const flow = parseYaml(await readFile(path.join(recorded, 'generated.flow.yaml'), 'utf8')) as {
      steps: Record<string, unknown>[];
      groups?: { name: string; steps: number[] }[];
    };
    const checks = flow.steps.filter((step) => {
      const text = (step.expect as { text?: unknown } | undefined)?.text;
      return typeof text === 'string' && text.startsWith('${testData:');
    });
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(flow.groups?.length).toBeGreaterThanOrEqual(2);
    // La valeur saisie à l'enregistrement n'est pas la vérification : la donnée est citée.
    expect(JSON.stringify(checks)).not.toContain('Company ABC');
  });

  it('shows the selection bar only with checked steps, keeps the typed name, folds the generation, never overflows', () => {
    expect(ui.barBefore).toBe(0);
    expect(ui.keptName).toBe('Mon groupe');
    expect(ui.picked).toBe('2');
    expect(ui.genLine).toBe(1);
    expect(ui.weak).toMatch(
      /Faibles ou non exécutables · 1[\s\S]*Tout refuser[\s\S]*rapport seulement, pas exécutable/,
    );
    expect(ui.overflow).toBeLessThanOrEqual(0);
  });
});
