import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport, FlowStepReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { startWorkflowApp, type WorkflowApp } from '../fixtures/workflow-app.js';

/** Le parcours tel qu'enregistré sur la version 1 (effets appris compris). */
const FLOW = `      - click: { role: button, name: Tasks }
        effects: { appears: ["button:Enterprise interview"] }
      - click: { role: button, name: Enterprise interview }
        effects: { appears: ["checkbox:EUR"] }
      - check: { label: EUR }
        effects: { appears: ["button:Company information"] }
      - click: { role: button, name: Company information }
        effects: { appears: ["textbox:Company name", "textbox:Business number"] }
      - fill: { label: Company name, value: Alpha }
      - fill: { label: Business number, value: "1234567890" }
      - click: { role: button, name: Submit }
        allow: MUTATION
        effects: { request: "POST /api/company" }`;

/**
 * WORKFLOW SELF-HEALING de bout en bout : la même intention fonctionnelle sur plusieurs
 * versions de l'interface. Le crawler doit distinguer la dérive d'interface, la dérive du
 * parcours, la vraie régression et l'ambiguïté — sans jamais masquer un bogue ni contourner
 * une autorisation, et sans jamais réécrire le flow d'origine.
 */
describe('Workflow self-healing (intent-aware recovery)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-healing-'));
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
  ): Promise<{ report: FlowRunReport; missionFile: string; reportsDir: string }> => {
    const base = path.join(dir, name);
    await mkdir(base, { recursive: true });
    const reportsDir = path.join(base, `reports-${String(Date.now())}`);
    const missionFile = path.join(base, 'mission.yaml');
    await writeFile(
      missionFile,
      `mission: { name: healing-${name} }
target: { baseUrl: ${app.url}, startAt: "/${query}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
safety:
  mutations: { enabled: true, maxPerRun: 5 }
report: { failOnSeverity: NONE }
replay:
  effectTimeoutMs: 1200
  intelligentRecovery: { ${extra} }
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
    return { report, missionFile, reportsDir };
  };
  const show = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [
        step.index,
        step.status,
        step.reason,
        step.recovery?.divergence.category,
        step.recovery?.outcome.status,
        step.recovery?.outcome.attempts,
      ]),
    );
  const recovered = (report: FlowRunReport): FlowStepReport[] =>
    report.steps.filter((step) => step.recovery?.outcome.status === 'GOAL_REACHED');

  it('V1: the original interface replays exactly (PASS_EXACT, no drift, nothing suggested)', async () => {
    const { report } = await replay('v1', '?v=1');
    expect(report.status, show(report)).toBe('PASSED');
    expect(report.drift).toMatchObject({ result: 'PASS_EXACT', classification: 'NO_DRIFT', detected: false });
    expect(report.steps.some((step) => step.recovery)).toBe(false);
  }, 90_000);

  it('§72 V2: renamed controls are TARGET_RENAMED, recovered by their goal (PASS_WITH_GOAL_RECOVERY)', async () => {
    const { report } = await replay('v2', '?v=2');
    expect(report.status, show(report)).toBe('PASSED');
    const [tasks, company] = recovered(report);
    expect(tasks?.recovery?.outcome.path.map((action) => action.name)).toEqual(['Work items']);
    expect(company?.recovery?.divergence.category).toBe('TARGET_RENAMED');
    expect(company?.recovery?.outcome.path).toMatchObject([
      { kind: 'click', role: 'button', name: 'Company details' },
    ]);
    expect(report.drift).toMatchObject({
      result: 'PASS_WITH_GOAL_RECOVERY',
      classification: 'MINOR_UI_DRIFT',
    });
  }, 90_000);

  it('§73 / §84 / §82 V3: a button that became a tab is TARGET_REPLACED; the higher-scored MUTATION is never tried; every choice is explained', async () => {
    const { report } = await replay('v3', '?v=3');
    expect(report.status, show(report)).toBe('PASSED');
    const step = report.steps[3];
    const recovery = step?.recovery;
    expect(recovery?.divergence.category).toBe('TARGET_REPLACED');
    expect(recovery?.outcome.path).toMatchObject([{ kind: 'click', role: 'tab', name: 'Company' }]);
    // SAFETY : « Remove company information » ressemble plus, mais écrit : écarté, jamais cliqué.
    expect(recovery?.plan.rejected.map((rejected) => rejected.signature)).toContain(
      'click button:remove company information',
    );
    expect(app.counts.removed).toBe(0);
    // EXPLAINABILITY : action d'origine, divergence, objectif, candidats, choix et raisons, sécurité, preuve, suite.
    expect(recovery).toMatchObject({
      originalTarget: 'Company information',
      goal: { id: 'COMPANY_INFORMATION_AVAILABLE' },
      goalVerification: { status: 'REACHED' },
      nextActionVerified: true,
      selected: { risk: 'SAFE' },
    });
    expect(recovery?.goal.predicates.map((predicate) => predicate.value)).toEqual(
      expect.arrayContaining(['Company name', 'Business number']),
    );
    expect(recovery?.plan.candidates.length).toBeGreaterThan(0);
    expect(recovery?.selected?.reasons.join(' ')).toMatch(/classified SAFE/);
    expect(recovery?.context.next.slice(0, 2)).toEqual(['fill Company name', 'fill Business number']);
    expect(report.steps[4]?.status).toBe('PASSED');
    expect(report.drift).toMatchObject({
      result: 'PASS_WITH_GOAL_RECOVERY',
      classification: 'STRUCTURAL_UI_DRIFT',
    });
  }, 90_000);

  it('§74 / §81 V4: renamed + tab + a new SAFE prerequisite: recovered, workflow drift, suggested flow, original unchanged', async () => {
    const { report, missionFile, reportsDir } = await replay('v4', '?v=4');
    const original = await readFile(missionFile, 'utf8');
    expect(report.status, show(report)).toBe('PASSED');
    const company = report.steps[3]?.recovery;
    expect(company?.outcome.path).toMatchObject([
      { kind: 'check', role: 'checkbox', name: 'The applicant is registered', part: 'INSERTED_PREREQUISITE' },
      { kind: 'click', role: 'tab', name: 'Company', part: 'REPLACEMENT' },
    ]);
    expect(company?.divergence.category).toBe('PREREQUISITE_MISSING');
    expect(report.steps[6]?.effect?.status).toBe('CONFIRMED');
    expect(report.drift).toMatchObject({
      result: 'PASS_WITH_WORKFLOW_DRIFT',
      classification: 'WORKFLOW_DRIFT',
      flowUpdateSuggested: true,
      facts: { goalRecoveredActions: 2, insertedRuntimeActions: 1 },
    });
    const [yamlFile, featureFile] = report.drift?.suggestedFiles ?? [];
    const suggested = await readFile(yamlFile ?? '', 'utf8');
    expect(suggested).toContain('The applicant is registered');
    expect(suggested).toMatch(/role: tab\s+name: Company/);
    expect(await readFile(featureFile ?? '', 'utf8')).toContain('Company');
    // Rapport : l'explication de chaque récupération, les faits de la dérive, les événements.
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('Workflow recovery: GOAL_REACHED');
    expect(html).toContain('Flow drift');
    expect(html).toMatch(/Workflow self-healing: 2 recovery attempt/);
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    for (const event of [
      'DIVERGENCE_CLASSIFIED',
      'FUNCTIONAL_GOAL_INFERRED',
      'RECOVERY_PLAN_CREATED',
      'PREREQUISITE_DISCOVERED',
      'GOAL_REACHED',
      'RECOVERY_KNOWLEDGE_LEARNED',
      'FLOW_DRIFT_DETECTED',
      'SUGGESTED_FLOW_UPDATE_CREATED',
    ])
      expect(log, event).toContain(event);
    // Le flow d'origine n'est jamais réécrit.
    expect(await readFile(missionFile, 'utf8')).toBe(original);
    expect(original).toContain('name: Company information');
  }, 120_000);

  it('§76 / §65: the next run reuses the learned recovery first — still verified at runtime, with fewer experiments', async () => {
    const first = await replay('history', '?v=4');
    const second = await replay('history', '?v=4');
    expect(second.report.status, show(second.report)).toBe('PASSED');
    const before = first.report.steps[3]?.recovery?.outcome;
    const after = second.report.steps[3]?.recovery?.outcome;
    expect(after?.attempts[0]).toMatchObject({ source: 'HISTORY', result: 'GOAL_REACHED' });
    expect(after?.experiments).toBeLessThan(before?.experiments ?? 0);
    expect(second.report.steps[3]?.recovery?.goalVerification?.status).toBe('REACHED');
  }, 180_000);

  it('§77: a stale historical recovery loses weight and other candidates are searched', async () => {
    await replay('stale', '?v=3');
    const { report } = await replay('stale', '?v=2');
    expect(report.status, show(report)).toBe('PASSED');
    const outcome = report.steps[3]?.recovery?.outcome;
    expect(outcome?.attempts.find((attempt) => attempt.source === 'HISTORY')).toMatchObject({
      result: 'NOT_FOUND',
    });
    expect(outcome?.path).toMatchObject([{ name: 'Company details' }]);
  }, 180_000);

  it('§75: a missing control the role may no longer see is ROLE_PERMISSION_CHANGED — no recovery attempted', async () => {
    const { report } = await replay('viewer', '?v=1&role=viewer');
    expect(report.status).toBe('FAILED');
    const failing = report.steps.find((step) => step.status === 'FAILED');
    expect(failing?.recovery?.divergence.category, show(report)).toBe('ROLE_PERMISSION_CHANGED');
    expect(failing?.recovery?.outcome).toMatchObject({ status: 'NO_SAFE_RECOVERY', experiments: 0 });
    expect(report.drift?.result).toBe('FAIL_NO_SAFE_RECOVERY');
  }, 90_000);

  it('§78: two equally plausible candidates are AMBIGUOUS — nothing chosen arbitrarily (or a SAFE experiment when configured)', async () => {
    const { report } = await replay('ambiguous', '?v=amb');
    expect(report.status).toBe('FAILED');
    const failing = report.steps.find((step) => step.status === 'FAILED');
    expect(failing?.recovery?.outcome.status, show(report)).toBe('AMBIGUOUS_RECOVERY');
    expect(failing?.recovery?.divergence.category).toBe('AMBIGUOUS_UI');
    expect(report.drift).toMatchObject({ result: 'INCONCLUSIVE', classification: 'INCONCLUSIVE' });
    const experiment = await replay('ambiguous-experiment', '?v=amb', 'onAmbiguity: experiment');
    expect(experiment.report.status, show(experiment.report)).toBe('PASSED');
  }, 120_000);

  it('§79 V5: no safe path reaches the goal: never a PASS — RECORDED_FLOW_OBSOLETE / POSSIBLE_REGRESSION', async () => {
    const { report } = await replay('v5', '?v=5');
    expect(report.status).toBe('FAILED');
    const failing = report.steps.find((step) => step.status === 'FAILED');
    expect(failing?.recovery?.outcome.status, show(report)).toBe('NO_SAFE_RECOVERY');
    expect(failing?.recovery?.divergence.category).toBe('RECORDED_FLOW_OBSOLETE');
    expect(report.drift).toMatchObject({
      result: 'FAIL_NO_SAFE_RECOVERY',
      classification: 'POSSIBLE_REGRESSION',
    });
  }, 120_000);

  it('§80: the original action exists but its write fails (500): a possible regression, never bypassed, never resent', async () => {
    const before = app.counts.submit;
    const { report } = await replay('bug', '?v=1&fail=1');
    expect(report.status).toBe('FAILED');
    const submit = report.steps[6];
    expect(submit?.recovery?.divergence.category, show(report)).toBe('APPLICATION_BEHAVIOR_CHANGED');
    expect(submit?.recovery?.outcome.experiments).toBe(0);
    expect(submit?.reason).toMatch(/MUTATION_EFFECT_AMBIGUOUS/);
    expect(report.drift).toMatchObject({
      result: 'FAIL_BUSINESS_DIVERGENCE',
      classification: 'POSSIBLE_REGRESSION',
    });
    expect(app.counts.submit).toBe(before + 1);
  }, 90_000);

  it('§83: when the budget is reached the result is RECOVERY_BUDGET_EXHAUSTED (inconclusive), never "unreachable"', async () => {
    const { report } = await replay('budget', '?v=4', 'budgets: { maxSafeExperiments: 1 }');
    expect(report.status).toBe('FAILED');
    const failing = report.steps.find((step) => step.status === 'FAILED');
    expect(failing?.recovery?.outcome.status, show(report)).toBe('RECOVERY_BUDGET_EXHAUSTED');
    expect(report.drift?.result).toBe('INCONCLUSIVE');
  }, 90_000);

  it('a goal already reached without the recorded step: the step is kept for review as possibly obsolete (workflow drift)', async () => {
    const { report } = await replay('inline', '?v=inline');
    expect(report.status, show(report)).toBe('PASSED');
    expect(report.steps[3]?.recovery?.outcome.status).toBe('GOAL_ALREADY_REACHED');
    expect(report.drift).toMatchObject({
      classification: 'WORKFLOW_DRIFT',
      facts: { obsoleteCandidates: 1 },
    });
    const suggested = await readFile(report.drift?.suggestedFiles?.[0] ?? '', 'utf8');
    expect(suggested).toMatch(/POSSIBLY_OBSOLETE/);
  }, 90_000);

  it('§71: intelligentRecovery.enabled: false keeps the previous behavior (no analysis, no drift)', async () => {
    const { report } = await replay('disabled', '?v=2', 'enabled: false');
    expect(report.status).toBe('FAILED');
    expect(report.steps.some((step) => step.recovery)).toBe(false);
    expect(report.drift).toBeUndefined();
    expect(report.steps[0]?.reason).toMatch(/element not found/);
  }, 90_000);
});
