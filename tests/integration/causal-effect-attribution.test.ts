import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import type { RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { startFilterApp, type FilterApp } from '../fixtures/filter-app.js';

/**
 * LE CAS RÉEL : Filter → Field → Operator → valeur → Apply (GET /api/search → résultats), puis,
 * AVANT que l'enregistreur n'observe l'écran, « Process request » (navigation vers /process).
 * L'ancien enregistreur donnait à « Apply » la route et les contrôles de l'écran suivant ; au rejeu,
 * WRONG_EFFECT → récupération → budget épuisé. THE NEXT HUMAN ACTION CREATES A STRONG CAUSAL BOUNDARY.
 */
describe('Causal effect attribution (record + replay, real browser)', () => {
  let app: FilterApp;
  let dir: string;
  let outcome: RecordOutcome;
  const events: RecordingEvent[] = [];

  beforeAll(async () => {
    app = await startFilterApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-causal-'));
    outcome = await runRecording({
      name: 'filter then process',
      url: `${app.url}/?variant=navigate`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      onEvent: (event) => events.push(event),
      drive: async ({ page }) => {
        await page.getByRole('button', { name: 'Filter' }).click();
        await page.waitForTimeout(700);
        await page.getByLabel('Field').selectOption('Company name');
        await page.waitForTimeout(700);
        await page.getByLabel('Operator').selectOption('Like');
        await page.waitForTimeout(700);
        await page.locator('#valueInput').fill('alpha');
        await page.waitForTimeout(700);
        const searched = page.waitForResponse((response) => response.url().includes('/api/search'));
        await page.getByRole('button', { name: 'Apply' }).click();
        // Le résultat arrive (GET /api/search), et l'humain clique AUSSITÔT l'action suivante.
        await searched;
        await page.getByRole('button', { name: 'Process request' }).click();
        await page.getByRole('heading', { name: 'Process' }).waitFor();
        await page.waitForTimeout(1500);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const kept = () => outcome.result.normalized.kept;
  const apply = () => kept().find((action) => action.target?.label === 'Apply');
  const processClick = () => kept().find((action) => action.target?.label === 'Process request');

  it('§23 recording: "Apply" owns its request and its results — never the navigation of the NEXT action', () => {
    const effects = apply()?.expectedEffects;
    expect(effects?.route).toBeUndefined();
    expect(JSON.stringify(effects ?? {})).not.toMatch(/heading:Process|button:Back|\/process/);
    expect(effects?.provenance?.actionId).toBe(apply()?.id);
    // L'action suivante reçoit SA navigation (corrélée) et son nouvel écran.
    expect(processClick()?.expectedEffects?.route).toBe('/process');
    expect(
      processClick()?.expectedEffects?.provenance?.effects.find((entry) => entry.effect === 'route /process')
        ?.causality,
    ).toBe('DIRECT');
  });

  it('§7 / §20 / §21 the next human action closes the window; recording-validation.json explains every effect, with the timeline', async () => {
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'RECORDING_ACTION_WINDOW_OPENED',
        'RECORDING_ACTION_WINDOW_CLOSED',
        'EFFECT_ASSIGNED_TO_ACTION',
        'RECORDING_CONSISTENCY_VALIDATED',
      ]),
    );
    const validation = JSON.parse(
      await readFile(path.join(outcome.directory, 'recording-validation.json'), 'utf8'),
    ) as {
      status: string;
      actions: { action: string; status: string; required: string[] }[];
      timelineText: string[];
    };
    const applyEntry = validation.actions.find((entry) => entry.action === 'CLICK Apply');
    expect(applyEntry?.status).toBe('CLEAN');
    expect(applyEntry?.required.join(' ')).not.toMatch(/route \/process/);
    expect(validation.timelineText.some((line) => /HUMAN CLICK Apply/.test(line))).toBe(true);
    expect(validation.timelineText.some((line) => /HUMAN CLICK Process request/.test(line))).toBe(true);
  });

  /** Rejoue un flow ; renvoie le rapport et les événements de récupération. */
  const replay = async (
    variant: string,
    flowYaml: string,
  ): Promise<{ report: FlowRunReport; log: string }> => {
    const reportsDir = await mkdtemp(path.join(dir, 'replay-'));
    const { config } = parseConfig(
      `mission: { name: causal-replay }
target: { baseUrl: ${app.url}, startAt: "/?variant=${variant}" }
exploration: { autonomous: false, actionTimeoutMs: 5000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 1500 }
logging: { level: DEBUG }
output: { reportsDir: ${reportsDir} }
${flowYaml}`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    return { report, log: await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8') };
  };
  const describeFlow = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [step.description, step.status, step.reason, step.effect?.status]),
    );

  it('§23 replay of the generated flow: "Apply" → ACTION_CONFIRMED, it never waits for the next action\'s navigation; no recovery', async () => {
    const generated = parseYaml(
      await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    if (typeof generated.testData === 'string')
      generated.testData = path.join(outcome.directory, generated.testData);
    const { report, log } = await replay('navigate', `flows:\n  - ${JSON.stringify(generated)}`);
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const applyStep = report.steps.find((step) => step.description.includes('Apply'));
    expect(applyStep?.effect?.status).toBe('CONFIRMED');
    expect(applyStep?.recovery).toBeUndefined();
    expect(log).not.toContain('"GOAL_RECOVERY_STARTED"');
  }, 120_000);

  /** Un ANCIEN enregistrement contaminé : « Apply » attend l'écran /process de l'action suivante. */
  const CONTAMINATED = `flows:
  - name: Old filter recording
    steps:
      - click: { role: button, name: Filter }
      - select: { label: Field, option: Company name }
      - select: { label: Operator, option: Like }
      - fill: { css: "#valueInput", value: alpha }
      - click: { role: button, name: Apply }
        allow: [MUTATION]
        effects: { appears: ["heading:Process", "button:Back"], route: /process }
      - click: { role: button, name: Process request }
      - click: { role: button, name: Back }
`;

  it('§15 / §16 / §17 an old contaminated expectation: RECORDED_EXPECTATION_CONTAMINATED — no recovery experiments, the journey continues, the recording-model divergence is kept in the report', async () => {
    const { report, log } = await replay('navigate', CONTAMINATED);
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const applyStep = report.steps.find((step) => step.description.includes('Apply'));
    expect(applyStep?.effect?.status).toBe('EXPECTATION_SUSPECT');
    expect(applyStep?.reason).toMatch(
      /^REPLAY_INCONCLUSIVE_EXPECTATION_DRIFT: RECORDED_EXPECTATION_CONTAMINATED/,
    );
    expect(applyStep?.recordingModelDivergence?.suspectEffects).toEqual(
      expect.arrayContaining(['+ heading:Process', '+ button:Back', 'route /process']),
    );
    expect(applyStep?.recovery).toBeUndefined();
    expect(report.divergence).toBeUndefined();
    for (const event of [
      'WRONG_EFFECT_ANALYZED',
      'REPLAY_EXPECTATION_SUSPECTED',
      'REPLAY_RECORDING_MODEL_DIVERGENCE',
    ])
      expect(log, event).toContain(`"${event}"`);
    expect(log).not.toContain('"GOAL_RECOVERY_STARTED"');
  }, 120_000);

  it('never masks a real regression: the search fails (500), the next target never comes — the step still fails', async () => {
    const { report } = await replay('navigateBroken', CONTAMINATED);
    const applyStep = report.steps.find((step) => step.description.includes('Apply'));
    expect(applyStep?.status, describeFlow(report)).toBe('FAILED');
    expect(applyStep?.effect?.status).not.toBe('EXPECTATION_SUSPECT');
    expect(applyStep?.recordingModelDivergence).toBeUndefined();
  }, 120_000);
});
