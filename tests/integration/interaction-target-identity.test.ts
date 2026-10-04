import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { readGeneratedFlow } from '../helpers.js';
import { startContextApp, type ContextApp } from '../fixtures/context-app.js';

/**
 * InteractionTargetIdentity, de bout en bout : un onglet, un accordéon, une case, deux dialogues
 * ouverts avec chacun SON « Apply ». La capture enregistre le propriétaire et le contexte ; le rejeu
 * choisit le bon « Apply », vérifie l'état de la case, diagnostique un accordéon fermé et remonte à la
 * première divergence fonctionnelle. FOUND ELEMENT ≠ CORRECT ELEMENT.
 */
describe('Interaction target identity (record → replay, real browser)', () => {
  let app: ContextApp;
  let dir: string;
  let outcome: RecordOutcome;

  beforeAll(async () => {
    app = await startContextApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-interaction-identity-'));
    outcome = await runRecording({
      name: 'client follow-up',
      url: `${app.url}/client`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      drive: async ({ page }) => {
        await page.getByRole('tab', { name: 'Company' }).click();
        await page.waitForTimeout(300);
        await page.getByLabel('Business number').fill('12345');
        await page.waitForTimeout(500);
        await page.getByLabel('Interview done').check();
        // Le clic suivant arrive vite : son dialogue s'ouvre AVANT que l'écran de la case soit observé.
        await page.waitForTimeout(300);
        await page.getByRole('button', { name: 'Filter' }).click();
        await page.waitForTimeout(300);
        await page.getByRole('button', { name: 'Edit request' }).click();
        await page.waitForTimeout(300);
        // Deux « Apply » à l'écran : l'humain utilise celui du dialogue « Filter ».
        await page.locator('#dlg-filter .apply').click();
        await page.getByText('Filter applied').waitFor();
        await page.waitForTimeout(1000);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const step = (steps: FlowStep[], kind: string, name: string) =>
    steps.find(
      (candidate) =>
        candidate.kind === kind &&
        'target' in candidate &&
        (candidate.target.name === name || candidate.target.value === name),
    ) as Extract<FlowStep, { target: unknown }> | undefined;

  it('recording: every interaction carries its owner and context (tab, accordion + expected state, dialog)', async () => {
    const flow = await readGeneratedFlow(outcome.directory);
    expect(step(flow.steps, 'fill', 'Business number')?.fingerprint).toMatchObject({
      owner: 'tab:Company',
      tab: 'Company',
    });
    expect(step(flow.steps, 'check', 'Interview done')?.fingerprint).toMatchObject({
      accordion: 'Interview',
      expectedState: 'checked',
    });
    expect(step(flow.steps, 'click', 'Apply')?.fingerprint).toMatchObject({
      owner: 'dialog:Filter',
      dialog: 'Filter',
    });
  });

  it('§18 / §19 recording: the dialog opened by the NEXT click is never an effect of the checkbox; it is reassigned to "Filter"', async () => {
    const flow = await readGeneratedFlow(outcome.directory);
    expect(JSON.stringify(step(flow.steps, 'check', 'Interview done')?.effects ?? {})).not.toMatch(
      /Keyword|button:Apply/,
    );
    expect(step(flow.steps, 'click', 'Filter')?.effects?.appears).toEqual(
      expect.arrayContaining(['textbox:Keyword', 'button:Apply']),
    );
  });

  const replay = async (
    variant: string,
    edit: (steps: FlowStep[]) => unknown[] = (steps) => steps,
  ): Promise<{ report: FlowRunReport; log: string }> => {
    const raw = parseYaml(await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8')) as {
      steps: FlowStep[];
    } & Record<string, unknown>;
    const startAt = `/client${variant === 'default' ? '' : `?variant=${variant}`}`;
    const reportsDir = await mkdtemp(path.join(dir, `replay-${variant}-`));
    const { config } = parseConfig(
      `mission: { name: interaction-${variant} }
target: { baseUrl: ${app.url}, startAt: "${startAt}" }
exploration: { autonomous: false, actionTimeoutMs: 5000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
logging: { level: DEBUG }
output: { reportsDir: ${reportsDir} }
flows:
  - ${JSON.stringify({ ...raw, startAt, steps: edit(raw.steps), testData: path.join(outcome.directory, 'test-data.yaml') })}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    return {
      report: result.flows[0] as FlowRunReport,
      log: await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8'),
    };
  };
  const describeRun = (report: FlowRunReport): string =>
    JSON.stringify(report.steps.map((entry) => [entry.description, entry.status, entry.reason]));

  it('A / D / N replay: the right "Apply" (two dialogs open), the checkbox state verified, every step confirmed', async () => {
    const before = app.applied.length;
    const { report, log } = await replay('default');
    expect(report.status, describeRun(report)).toBe('PASSED');
    expect(app.applied.slice(before)).toEqual(['Filter']);
    expect(log).toContain('"CHECKED_STATE_CHANGED"');
  }, 120_000);

  it('F the accordion is closed at replay: TARGET_NOT_RENDERED_BECAUSE_PARENT_CLOSED, the section is opened (SAFE) and the box is REALLY checked', async () => {
    const { report, log } = await replay('collapsed');
    expect(log).toMatch(
      /"TARGET_CONTEXT_MISMATCH".*PARENT_SECTION_CLOSED.*TARGET_NOT_RENDERED_BECAUSE_PARENT_CLOSED/,
    );
    const check = report.steps.find((entry) => entry.description.includes('Interview done'));
    expect(check?.status, describeRun(report)).toBe('PASSED');
    // Jamais « réussie » sans avoir coché : l'objectif rétabli n'était que la précondition.
    expect(check?.reason ?? '').not.toMatch(/GOAL_ALREADY_REACHED/);
    expect(log).toContain('"CHECKED_STATE_CHANGED"');
  }, 120_000);

  it('O an old recording (tab click without learned effect) on a regression where "Company" opens the wrong panel: the next step fails, FIRST_FUNCTIONAL_DIVERGENCE = the tab click', async () => {
    // L'ordre « étape 8 mauvais onglet / étape 9 réussie / étape 10 cible absente » : le clic d'onglet
    // (sans effet appris), puis la case (visible quel que soit l'onglet : réussit), puis la saisie.
    const { report, log } = await replay('swap', (steps) => {
      const [tab, fill, check, ...rest] = steps;
      const { effects: _effects, ...tabWithoutEffects } = tab as FlowStep & { effects?: unknown };
      return [tabWithoutEffects, check, fill, ...rest];
    });
    expect(report.steps[0]?.status, describeRun(report)).toBe('PASSED');
    // La case est bien cochée (CHECKED_STATE_CHANGED), mais son point de contrôle — la cible suivante
    // « Business number » disponible — échoue déjà : la divergence est vue à l'étape 2, sa CAUSE à l'étape 1.
    expect(log).toContain('"CHECKED_STATE_CHANGED"');
    expect(report.steps[1]?.status, describeRun(report)).toBe('FAILED');
    expect(log).toMatch(
      /"FIRST_FUNCTIONAL_DIVERGENCE_LOCATED".*FIRST_FUNCTIONAL_DIVERGENCE=1 \(failed at 2\).*should have established tab \\"Company\\"/,
    );
    expect(report.steps[1]?.recovery?.divergence.rootStepIndex).toBe(1);
  }, 120_000);
});
