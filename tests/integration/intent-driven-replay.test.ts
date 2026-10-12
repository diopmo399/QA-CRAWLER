import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { startWorkflowApp, type WorkflowApp } from '../fixtures/workflow-app.js';

/** Le parcours tel qu'enregistré sur la version 1 (effets appris et intentions compris). */
const FLOW = `      - click: { role: button, name: Tasks }
        effects: { appears: ["button:Enterprise interview"] }
        functionalIntent: { name: OPEN_SECTION, status: CONFIRMED, confidence: 0.9, ui: OPEN_SECTION }
      - click: { role: button, name: Enterprise interview }
        effects: { appears: ["checkbox:EUR"] }
      - check: { label: EUR }
        effects: { appears: ["button:Company information"] }
      - click: { role: button, name: Company information }
        effects: { appears: ["textbox:Company name", "textbox:Business number"] }
        functionalIntent: { name: OPEN_DIALOG, status: CONFIRMED, confidence: 0.9, ui: OPEN_DIALOG }
      - fill: { label: Company name, value: Alpha }
      - fill: { label: Business number, value: "1234567890" }
      - click: { role: button, name: Submit }
        allow: MUTATION
        effects: { request: "POST /api/company" }
        functionalIntent: { name: SUBMIT_COMPANY, status: CONFIRMED, confidence: 0.9, ui: SUBMIT, operation: SUBMIT, entity: company }`;

/**
 * INTENT-DRIVEN REPLAY de bout en bout : la position fonctionnelle et les checkpoints d'un rejeu réel,
 * l'apprentissage d'une résolution confirmée par une récupération puis sa proposition directe au rejeu
 * suivant (HISTORICAL, confirmée par l'effet), la divergence localisée sur un vrai bogue, et une
 * précondition non satisfaite expliquée avant d'agir.
 */
describe('Intent-driven replay (real browser)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-intent-replay-'));
  });
  afterAll(async () => {
    await app.close();
  });

  /** Un run ; `name` isole la base de connaissances (deux runs du même nom la partagent). */
  const replay = async (
    name: string,
    query: string,
    extra = '',
    flow = FLOW,
  ): Promise<{ report: FlowRunReport; log: string; html: string }> => {
    const base = path.join(dir, name);
    await mkdir(base, { recursive: true });
    const reportsDir = path.join(base, `reports-${String(Date.now())}`);
    const missionFile = path.join(base, 'mission.yaml');
    await writeFile(
      missionFile,
      `mission: { name: intent-replay-${name} }
target: { baseUrl: ${app.url}, startAt: "/${query}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
safety:
  mutations: { enabled: true, maxPerRun: 5 }
report: { failOnSeverity: NONE }
replay:
  effectTimeoutMs: 1200
  intentDriven: { ${extra} }
output: { reportsDir: ${reportsDir} }
flows:
  - name: company
    steps:
${flow}
`,
      'utf8',
    );
    const { config } = parseConfig(await readFile(missionFile, 'utf8'), {}, {});
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    return { report, log, html };
  };
  const show = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [
        step.index,
        step.status,
        step.reason,
        step.replay?.verdict,
        step.replay?.confidence.overall,
      ]),
    );

  it('V1: every step is committed with its checkpoints confirmed, the position reaches the end, confidence is high', async () => {
    const { report, html } = await replay('v1', '?v=1');
    expect(report.status, show(report)).toBe('PASSED');
    const replayReport = report.replay;
    expect(replayReport).toBeDefined();
    expect(replayReport?.finalPosition.stepIndex).toBe(7);
    expect(replayReport?.finalPosition.lastConfirmedAction).toBe(7);
    expect(replayReport?.divergence).toBeUndefined();
    // Les checkpoints forts (effets enregistrés) sont confirmés par l'écran et le réseau.
    const confirmed =
      replayReport?.checkpoints.filter((checkpoint) => checkpoint.result?.status === 'CONFIRMED') ?? [];
    expect(confirmed.map((checkpoint) => checkpoint.id)).toEqual(
      expect.arrayContaining(['CP1_OPEN_SECTION', 'CP4_OPEN_DIALOG', 'CP7_SUBMIT_COMPANY']),
    );
    expect(replayReport?.checkpoints.some((checkpoint) => checkpoint.result?.status === 'FAILED')).toBe(
      false,
    );
    for (const step of report.steps) {
      expect(step.replay?.verdict.outcome, show(report)).toBe('COMMITTED');
      expect(step.replay?.verdict.execution).toBe('SUCCESS');
    }
    expect(report.steps[6]?.replay?.verdict).toMatchObject({
      target: 'CORRECT',
      effect: 'SUCCESS',
      functionalState: 'SUCCESS',
    });
    expect(replayReport?.overallConfidence ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(replayReport?.lowConfidenceSteps).toEqual([]);
    // Les dépendances : l'envoi soumet les deux champs ; l'ouverture révèle les champs.
    expect(replayReport?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: 7, requires: 5, kind: 'FILLS_FIELD' }),
        expect.objectContaining({ step: 7, requires: 6, kind: 'FILLS_FIELD' }),
        expect.objectContaining({ step: 5, requires: 4, kind: 'REVEALS_TARGET' }),
      ]),
    );
    expect(html).toContain('Intent-driven replay');
  }, 90_000);

  it('V2 twice: a resolution confirmed by goal recovery is learned, then proposed directly (HISTORICAL) and confirmed by the effect', async () => {
    const first = await replay('learn', '?v=2');
    expect(first.report.status, show(first.report)).toBe('PASSED');
    // Run 1 : la récupération par objectif a remplacé « Tasks » par « Work items » ; la suite l'a confirmée.
    expect(first.report.steps[0]?.recovery?.outcome.status).toBe('GOAL_REACHED');
    expect(first.report.replay?.learned.join('\n')).toMatch(
      /SUCCESS: "Tasks" → button:Work items \(GOAL_RECOVERY/,
    );
    expect(first.log).toContain('"RESOLUTION_LEARNED"');
    // Run 2 : la résolution apprise est proposée AVANT toute récupération, et confirmée par l'effet.
    const second = await replay('learn', '?v=2');
    expect(second.report.status, show(second.report)).toBe('PASSED');
    const tasks = second.report.steps[0];
    expect(tasks?.recovery).toBeUndefined();
    expect(tasks?.replay?.plan).toMatchObject({
      choice: 'HISTORICAL',
      selected: { role: 'button', name: 'Work items' },
    });
    expect(tasks?.effect?.targetMatch?.verdict).toBe('PLANNED');
    expect(tasks?.effect?.status).toBe('CONFIRMED');
    expect(tasks?.replay?.verdict).toMatchObject({
      target: 'PLANNED',
      effect: 'SUCCESS',
      outcome: 'COMMITTED',
    });
    expect(second.log).toContain('"RESOLUTION_PROPOSED"');
    expect(second.report.replay?.learned.join('\n')).toMatch(
      /SUCCESS: "Tasks" → button:Work items \(HISTORICAL/,
    );
    expect(second.html).toContain('plan: HISTORICAL');
  }, 180_000);

  it('a real bug (POST answers 500): the step is rolled back, the divergence is localized after the last confirmed checkpoint, nothing silent', async () => {
    const { report } = await replay('bug', '?v=1&fail=1');
    expect(report.status, show(report)).toBe('FAILED');
    const submit = report.steps[6];
    expect(submit?.status).toBe('FAILED');
    expect(submit?.replay?.verdict).toMatchObject({
      execution: 'SUCCESS',
      effect: 'FAILED',
      outcome: 'ROLLED_BACK',
    });
    expect(submit?.replay?.confidence.continueSilently).toBe(false);
    expect(report.replay?.divergence).toMatchObject({ stepIndex: 7, window: { to: 'CP7_SUBMIT_COMPANY' } });
    expect(report.replay?.finalPosition.lastConfirmedAction).toBe(6);
    expect(report.replay?.lowConfidenceSteps).toContain(7);
  }, 90_000);

  it('a precondition that does not hold (the send button is disabled because a required field was never filled) is read and explained before acting', async () => {
    const flow = FLOW.split('\n')
      .filter((line) => !line.includes('Business number'))
      .join('\n');
    const { report, log } = await replay('precondition', '?v=1&strict=1', '', flow);
    const submit = report.steps.find((step) => step.description.includes('Submit'));
    expect(submit?.status, show(report)).toBe('FAILED');
    const enabled = submit?.replay?.preconditions.find(
      (check) => check.precondition.kind === 'TARGET_ENABLED',
    );
    expect(enabled?.satisfied).toBe(false);
    expect(submit?.replay?.verdict.preconditions).toBe('UNMET');
    expect(log).toContain('"PRECONDITION_NOT_MET"');
  }, 90_000);
});
