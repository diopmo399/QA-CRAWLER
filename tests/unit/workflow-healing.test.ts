import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { FlowStepReport } from '../../src/model/flow-run.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import { analyzeDivergence } from '../../src/workflow-healing/divergence-analyzer.js';
import { detectFlowDrift } from '../../src/workflow-healing/flow-drift.js';
import { recoverGoal, type RecoveryDriver } from '../../src/workflow-healing/goal-recovery-engine.js';
import type {
  FunctionalGoal,
  RecoveryAction,
  ScreenControl,
  StepRecoveryReport,
} from '../../src/workflow-healing/model.js';
import { historicalRecoveries, recoveryKeyOf } from '../../src/workflow-healing/recovery-memory.js';
import {
  planRecovery,
  scoreRecoveryCandidate,
  type PlannerInput,
} from '../../src/workflow-healing/recovery-planner.js';
import { labelSimilarity } from '../../src/workflow-healing/similarity.js';
import { staticLinkEvidence } from '../../src/workflow-healing/static-hints.js';
import {
  goalProgressOf,
  inferFunctionalGoal,
  resolveWorkflowContext,
} from '../../src/workflow-healing/workflow-context.js';

const target = (role: string, name: string) => ({ strategy: 'role' as const, role, name });
const click = (role: string, name: string, extra: Partial<FlowStep> = {}): FlowStep =>
  ({ kind: 'click', target: target(role, name), optional: false, allow: [], ...extra }) as FlowStep;
const fill = (label: string): FlowStep => ({
  kind: 'fill',
  target: { strategy: 'label', value: label },
  value: 'x',
  optional: false,
  allow: [],
});
const check = (label: string): FlowStep => ({
  kind: 'check',
  target: { strategy: 'label', value: label },
  optional: false,
  allow: [],
});
const control = (role: string, name: string, extra: Partial<ScreenControl> = {}): ScreenControl => ({
  role,
  name,
  visible: true,
  disabled: false,
  ...extra,
});

const STEPS: FlowStep[] = [
  check('EUR'),
  click('button', 'Company information', {
    effects: { appears: ['textbox:Company name', 'textbox:Business number'] },
  }),
  fill('Company name'),
  fill('Business number'),
  click('button', 'Submit'),
];

const safeJudge: PlannerInput['judge'] = (candidate) =>
  /remove|delete/i.test(candidate.name)
    ? { risk: 'DANGEROUS', allowed: false, reason: 'destructive keyword' }
    : { risk: 'SAFE', allowed: true, reason: 'safe navigation' };

describe('WorkflowContextResolver + WorkflowIntentResolver (§8–§16)', () => {
  it('uses previous, current and next actions; the next fields are the goal', () => {
    const context = resolveWorkflowContext(STEPS, 1);
    expect(context.previousActions.map((action) => action.label)).toEqual(['EUR']);
    expect(context.requiredFutureFields.map((action) => action.label)).toEqual([
      'Company name',
      'Business number',
    ]);
    expect(context.businessIntent).toMatchObject({ name: 'OPEN_COMPANY_INFORMATION', confidence: 'HIGH' });
    const goal = inferFunctionalGoal(context, {
      appears: ['textbox:Company name', 'textbox:Business number'],
    });
    expect(goal.id).toBe('COMPANY_INFORMATION_AVAILABLE');
    expect(goal.level).toBe('HIGH');
    expect(goal.predicates.map((predicate) => `${predicate.kind} ${predicate.value}`)).toEqual([
      'VISIBLE_CONTROL Company name',
      'VISIBLE_CONTROL Business number',
      'VISIBLE_FIELD Company name',
      'VISIBLE_FIELD Business number',
    ]);
  });

  it('never invents a goal: no effect and no next step → UNRESOLVED', () => {
    const goal = inferFunctionalGoal(resolveWorkflowContext([click('button', 'Close')], 0), undefined);
    expect(goal).toMatchObject({ level: 'UNRESOLVED', predicates: [] });
  });

  it('goal progress is 0..1, not only reached / not reached (§30)', () => {
    const goal = inferFunctionalGoal(resolveWorkflowContext(STEPS, 1), undefined);
    expect(goalProgressOf(goal, [true, false])).toMatchObject({ progress: 0.5, status: 'PARTIAL' });
    expect(goalProgressOf(goal, [true, true])).toMatchObject({ progress: 1, status: 'REACHED' });
  });
});

describe('DivergenceAnalyzer (§3–§7)', () => {
  const base = {
    actionId: 'flow#2',
    stepIndex: 2,
    expected: { label: 'Company information', role: 'button', kind: 'click' },
    network: [],
  };
  const screen = (
    controls: ScreenControl[],
    text = '',
  ): Parameters<typeof analyzeDivergence>[0]['screen'] => ({
    route: '/case',
    controls,
    text,
    loginFormVisible: false,
  });

  it('several hypotheses, ranked; a weak one is never presented as certain', () => {
    const analysis = analyzeDivergence({
      ...base,
      symptom: 'TARGET_NOT_FOUND',
      screen: screen([
        control('tab', 'Company', { selected: false }),
        control('tab', 'Applicant', { selected: true }),
      ]),
    });
    expect(analysis.category).toBe('TARGET_REPLACED');
    expect(analysis.possibleCauses.map((cause) => cause.category)).toEqual(
      expect.arrayContaining(['TARGET_REPLACED', 'WRONG_TAB_SELECTED', 'TARGET_NOT_RENDERED']),
    );
    expect(analysis.possibleCauses.at(-1)?.confidence).toBeLessThan(0.5);
    expect(analysis.recoverable).toBe(true);
  });

  it('a disabled target is TARGET_DISABLED with a missing prerequisite', () => {
    const analysis = analyzeDivergence({
      ...base,
      symptom: 'TARGET_DISABLED',
      screen: screen([control('button', 'Company information', { disabled: true })]),
    });
    expect(analysis.category).toBe('TARGET_DISABLED');
    expect(analysis.missingPrerequisites?.[0]?.kind).toBe('CONTROL');
  });

  it('permissions, session and a failing backend forbid any recovery (§62 / §80)', () => {
    expect(
      analyzeDivergence({
        ...base,
        symptom: 'TARGET_NOT_FOUND',
        screen: screen([], 'You do not have permission to view company information.'),
      }),
    ).toMatchObject({ category: 'ROLE_PERMISSION_CHANGED', recoverable: false });
    expect(
      analyzeDivergence({
        ...base,
        symptom: 'TARGET_NOT_FOUND',
        screen: { ...screen([]), loginFormVisible: true },
        network: [{ request: 'GET /api/me', status: 401 }],
      }),
    ).toMatchObject({ category: 'AUTH_STATE_CHANGED', recoverable: false });
    expect(
      analyzeDivergence({
        ...base,
        symptom: 'MUTATION_AMBIGUOUS',
        screen: screen([]),
        network: [{ request: 'POST /api/company', status: 500 }],
      }),
    ).toMatchObject({ category: 'APPLICATION_BEHAVIOR_CHANGED', recoverable: false });
  });

  it('symptom ≠ cause: a previous step whose effect changed is the first divergence (§6)', () => {
    const analysis = analyzeDivergence({
      ...base,
      stepIndex: 12,
      symptom: 'TARGET_NOT_FOUND',
      screen: screen([]),
      previous: { index: 7, deferredEffect: true, description: 'click "Tasks"' },
    });
    expect(analysis.rootStepIndex).toBe(7);
    expect(analysis.possibleCauses.map((cause) => cause.category)).toContain('WRONG_WORKFLOW_STATE');
  });
});

describe('RecoveryPlanner (§18–§23, §63, §66, §84)', () => {
  const context = resolveWorkflowContext(STEPS, 1);
  const goal = inferFunctionalGoal(context, undefined);
  const analysis = analyzeDivergence({
    actionId: 'a',
    stepIndex: 2,
    symptom: 'TARGET_NOT_FOUND',
    expected: { label: 'Company information', role: 'button', kind: 'click' },
    screen: { route: '/', controls: [], text: '', loginFormVisible: false },
    network: [],
  });
  const plan = (controls: ScreenControl[], extra: Partial<PlannerInput> = {}) =>
    planRecovery({
      analysis,
      context,
      goal,
      original: { label: 'Company information', role: 'button' },
      controls,
      judge: safeJudge,
      budgets: { maxCandidates: 10 },
      onAmbiguity: 'stop',
      ...extra,
    });

  it('the SafetyPolicy always wins, whatever the score', () => {
    const result = plan([
      control('button', 'Remove company information'),
      control('tab', 'Company', { selected: false }),
    ]);
    expect(result.candidates.map((candidate) => candidate.signature)).toEqual(['click tab:company']);
    expect(result.rejected).toMatchObject([
      { signature: 'click button:remove company information', risk: 'DANGEROUS' },
    ]);
  });

  it('two equally plausible candidates: AMBIGUOUS, never an arbitrary choice', () => {
    const result = plan([control('button', 'Company profile'), control('button', 'Company details')]);
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.selectedCandidate).toBeUndefined();
    expect(
      plan([control('button', 'Company profile'), control('button', 'Company details')], {
        onAmbiguity: 'experiment',
      }).status,
    ).toBe('PLANNED');
  });

  it('static evidence and history break the tie (they suggest, the runtime confirms)', () => {
    const result = plan([control('button', 'Company profile'), control('button', 'Company details')], {
      staticEvidence: (candidate) =>
        staticLinkEvidence(
          [{ component: 'CompanyDetailsComponent', controls: ['companyName', 'businessNumber'] }],
          candidate,
          goal,
        ),
    });
    expect(result.status).toBe('PLANNED');
    expect(result.selectedCandidate?.signature).toBe('click button:company details');
    expect(result.selectedCandidate?.source).toBe('STATIC_ANALYSIS');
  });

  it('centralized scoring: cheaper, safer, better supported first', () => {
    const base = {
      semanticSimilarity: 0.8,
      goalProgress: 0.6,
      expectedEffectMatch: 0,
      workflowContextMatch: 0.3,
      staticEvidence: 0,
      historicalSuccess: 0,
      runtimeEvidence: 0,
      safetyRisk: 0,
      ambiguityPenalty: 0,
      instabilityPenalty: 0,
      actionCost: 1,
    };
    expect(scoreRecoveryCandidate(base)).toBeGreaterThan(scoreRecoveryCandidate({ ...base, actionCost: 5 }));
    expect(scoreRecoveryCandidate({ ...base, safetyRisk: 1 })).toBe(0);
    expect(scoreRecoveryCandidate({ ...base, historicalSuccess: 0.8 })).toBeGreaterThan(
      scoreRecoveryCandidate(base),
    );
  });

  it('a non-recoverable divergence plans nothing', () => {
    expect(
      plan([control('tab', 'Company')], {
        analysis: { ...analysis, recoverable: false, category: 'ROLE_PERMISSION_CHANGED' },
      }).status,
    ).toBe('NO_SAFE_RECOVERY');
  });
});

/** Une application jouet : des contrôles qui en révèlent d'autres. */
function fakeDriver(rules: Record<string, { reveals?: string[]; reveal?: string[] }>, initial: string[]) {
  let screen = new Set(initial);
  let fields = new Set<string>();
  const executed: string[] = [];
  const undone: string[] = [];
  const driver: RecoveryDriver = {
    screen: () =>
      Promise.resolve(
        [...screen].map((key) => {
          const [role = '', name = ''] = key.split(':');
          return control(role, name);
        }),
      ),
    stateKey: () => Promise.resolve([...screen, ...fields].sort().join(',')),
    progress: (goal: FunctionalGoal) =>
      Promise.resolve(
        goalProgressOf(
          goal,
          goal.predicates.map((predicate) => fields.has(predicate.value)),
        ),
      ),
    execute: (action: RecoveryAction) => {
      const key = `${action.role}:${action.name}`;
      if (!screen.has(key)) return Promise.resolve({ status: 'NOT_FOUND' as const, appeared: [] });
      executed.push(key);
      const rule = rules[key] ?? {};
      const before = new Set(screen);
      const beforeFields = new Set(fields);
      for (const reveal of rule.reveals ?? []) screen.add(reveal);
      for (const field of rule.reveal ?? []) fields.add(field);
      return Promise.resolve({
        status: 'DONE' as const,
        appeared: [...screen].filter((entry) => !before.has(entry)),
        undo: () => {
          undone.push(key);
          screen = before;
          fields = beforeFields;
          return Promise.resolve(true);
        },
      });
    },
  };
  return { driver, executed, undone };
}

describe('GoalBasedRecoveryEngine (§24–§33, §83)', () => {
  const context = resolveWorkflowContext(STEPS, 1);
  const goal = inferFunctionalGoal(context, undefined);
  const analysis = analyzeDivergence({
    actionId: 'a',
    stepIndex: 2,
    symptom: 'TARGET_NOT_FOUND',
    expected: { label: 'Company information', role: 'button', kind: 'click' },
    screen: { route: '/', controls: [], text: '', loginFormVisible: false },
    network: [],
  });
  const budgets = {
    maxRecoveryActions: 5,
    maxRecoveryDepth: 3,
    maxCandidates: 10,
    maxRecoveryDurationMs: 10_000,
    maxSafeExperiments: 8,
  };
  const run = async (driver: RecoveryDriver, override: Partial<typeof budgets> = {}) => {
    const controls = await driver.screen();
    const planFor = (screen: ScreenControl[], exclude: ReadonlySet<string> = new Set()) =>
      planRecovery({
        analysis,
        context,
        goal,
        original: { label: 'Company information', role: 'button' },
        controls: screen,
        judge: safeJudge,
        budgets: { ...budgets, ...override },
        onAmbiguity: 'stop',
        exclude,
      });
    return recoverGoal(driver, {
      goal,
      original: { label: 'Company information', role: 'button' },
      plan: planFor(controls),
      replan: planFor,
      budgets: { ...budgets, ...override },
      onAmbiguity: 'stop',
    });
  };

  it('discovers an inserted SAFE prerequisite (depth 2), undoing the experiment that led nowhere', async () => {
    const app = fakeDriver(
      {
        'button:Help': {},
        'checkbox:The applicant is registered': { reveals: ['tab:Company'] },
        'tab:Company': { reveal: ['Company name', 'Business number'] },
      },
      ['button:Help', 'checkbox:The applicant is registered'],
    );
    const outcome = await run(app.driver);
    expect(outcome.status).toBe('GOAL_REACHED');
    expect(outcome.path).toMatchObject([
      { name: 'The applicant is registered', part: 'INSERTED_PREREQUISITE' },
      { name: 'Company', part: 'REPLACEMENT' },
    ]);
    expect(outcome.confirmedCategory).toBe('PREREQUISITE_MISSING');
  });

  it('a goal already reached is not "recovered": the step may be obsolete', async () => {
    const app = fakeDriver({}, []);
    const reached = await recoverGoal(
      {
        ...app.driver,
        progress: (g) =>
          Promise.resolve(
            goalProgressOf(
              g,
              g.predicates.map(() => true),
            ),
          ),
      },
      {
        goal,
        original: { label: 'x' },
        plan: { goal, candidates: [], rejected: [], status: 'PLANNED', truncated: 0, reasons: [] },
        replan: () => ({ goal, candidates: [], rejected: [], status: 'PLANNED', truncated: 0, reasons: [] }),
        budgets,
        onAmbiguity: 'stop',
      },
    );
    expect(reached.status).toBe('GOAL_ALREADY_REACHED');
    expect(app.executed).toEqual([]);
  });

  it('exhaustive search without the goal is NO_SAFE_RECOVERY; experiments are undone', async () => {
    const app = fakeDriver({ 'button:Help': {}, 'button:Settings': {} }, ['button:Help', 'button:Settings']);
    const outcome = await run(app.driver);
    expect(outcome.status).toBe('NO_SAFE_RECOVERY');
    expect(outcome.experiments).toBe(2);
    expect(app.undone).toEqual(['button:Help', 'button:Settings']);
  });

  it('a reached budget is RECOVERY_BUDGET_EXHAUSTED, never "unreachable" (§83)', async () => {
    const app = fakeDriver(
      { 'button:Help': {}, 'tab:Company': { reveal: ['Company name', 'Business number'] } },
      ['button:Help', 'tab:Company'],
    );
    const outcome = await run(app.driver, { maxSafeExperiments: 1, maxCandidates: 1 });
    // Le meilleur candidat (onglet) d'abord… ici un seul essai permis, sur un seul candidat gardé.
    expect(['GOAL_REACHED', 'RECOVERY_BUDGET_EXHAUSTED']).toContain(outcome.status);
    const starved = fakeDriver({ 'button:Help': { reveals: ['button:More'] }, 'button:More': {} }, [
      'button:Help',
    ]);
    expect((await run(starved.driver, { maxSafeExperiments: 1 })).status).toBe('RECOVERY_BUDGET_EXHAUSTED');
  });

  it('loop prevention: the same candidate in the same state is never tried twice', async () => {
    const app = fakeDriver({ 'button:Toggle': { reveals: ['button:Other'] }, 'button:Other': {} }, [
      'button:Toggle',
    ]);
    const outcome = await run(app.driver);
    expect(outcome.status).toBe('NO_SAFE_RECOVERY');
    const tried = app.executed.filter((key) => key === 'button:Toggle');
    expect(tried).toHaveLength(1);
  });
});

describe('RecoveryMemory (§34–§39)', () => {
  it('history is weighted by success, age and version — a stale path is avoided, never deleted', () => {
    const kb = JsonKnowledgeBase.inMemory();
    const { key, actionSignature } = recoveryKeyOf(
      { kind: 'click', role: 'button', label: 'Company information' },
      'COMPANY_INFORMATION_AVAILABLE',
    );
    const base = {
      key,
      actionSignature,
      goal: 'COMPANY_INFORMATION_AVAILABLE',
      originalTarget: 'Company information',
    };
    const tab = [{ kind: 'click' as const, role: 'tab', name: 'Company' }];
    const old = [{ kind: 'click' as const, role: 'button', name: 'Profile' }];
    for (let i = 0; i < 4; i += 1)
      kb.recordRecovery({
        ...base,
        actions: tab,
        result: 'SUCCESS',
        version: 'v42',
        at: '2026-09-30T00:00:00Z',
      });
    kb.recordRecovery({ ...base, actions: old, result: 'FAILURE', at: '2026-09-01T00:00:00Z' });
    kb.recordRecovery({ ...base, actions: old, result: 'FAILURE', at: '2026-09-02T00:00:00Z' });
    const same = historicalRecoveries(kb.recoveryKnowledge(key), {
      now: '2026-10-01T00:00:00Z',
      version: 'v42',
    });
    const other = historicalRecoveries(kb.recoveryKnowledge(key), {
      now: '2026-10-01T00:00:00Z',
      version: 'v43',
    });
    const aged = historicalRecoveries(kb.recoveryKnowledge(key), {
      now: '2027-06-01T00:00:00Z',
      version: 'v42',
    });
    expect(same.candidates).toHaveLength(1);
    expect(same.avoid).toEqual(['click button:Profile']);
    expect(other.candidates[0]?.weight).toBeLessThan(same.candidates[0]?.weight ?? 0);
    expect(aged.candidates[0]?.weight).toBeLessThan(same.candidates[0]?.weight ?? 0);
    expect(kb.recoveryKnowledge(key)?.paths['click button:Profile']?.failures).toBe(2);
  });
});

describe('FlowDriftDetector (§40–§49, §68)', () => {
  const step = (index: number, extra: Partial<FlowStepReport> = {}): FlowStepReport => ({
    index,
    kind: 'click',
    description: `click ${String(index)}`,
    status: 'PASSED',
    optional: false,
    durationMs: 1,
    ...extra,
  });
  const recovered = (part: 'INSERTED_PREREQUISITE' | 'REPLACEMENT'): StepRecoveryReport => ({
    originalActionId: 'a',
    originalTarget: 'Company information',
    originalRole: 'button',
    divergence: { category: 'TARGET_REPLACED', confidence: 0.9 } as StepRecoveryReport['divergence'],
    context: { previous: [], next: [], requiredFields: [] },
    goal: { id: 'G', predicates: [], confidence: 1, level: 'HIGH', source: [] },
    plan: { status: 'CONFIRMED', candidates: [], rejected: [], truncated: 0 },
    outcome: {
      status: 'GOAL_REACHED',
      path: [
        ...(part === 'INSERTED_PREREQUISITE'
          ? [{ kind: 'check' as const, role: 'checkbox', name: 'Q', part }]
          : []),
        { kind: 'click' as const, role: 'tab', name: 'Company', part: 'REPLACEMENT' as const },
      ],
      attempts: [],
      experiments: 1,
      actionsExecuted: 1,
      durationMs: 1,
      reasons: [],
    },
  });

  it('facts first, then a careful classification', () => {
    expect(detectFlowDrift('PASSED', [step(1), step(2)])).toMatchObject({
      result: 'PASS_EXACT',
      classification: 'NO_DRIFT',
    });
    expect(
      detectFlowDrift('PASSED', [
        step(1, {
          effect: {
            execution: 'EXECUTED',
            status: 'CONFIRMED',
            expected: [],
            observed: [],
            reasons: [],
            recovery: [],
            healed: { from: 'css', to: 'role' },
          },
        }),
      ]),
    ).toMatchObject({ result: 'PASS_WITH_LOCATOR_HEALING', classification: 'MINOR_UI_DRIFT' });
    expect(
      detectFlowDrift('PASSED', [step(1), step(2, { recovery: recovered('REPLACEMENT') })]),
    ).toMatchObject({
      result: 'PASS_WITH_GOAL_RECOVERY',
      classification: 'STRUCTURAL_UI_DRIFT',
      facts: { replacedTargets: 1 },
    });
    expect(
      detectFlowDrift('PASSED', [step(1), step(2, { recovery: recovered('INSERTED_PREREQUISITE') })]),
    ).toMatchObject({
      result: 'PASS_WITH_WORKFLOW_DRIFT',
      classification: 'WORKFLOW_DRIFT',
      facts: { insertedRuntimeActions: 1 },
    });
  });
});

describe('label similarity (deterministic, no model)', () => {
  it('renamed labels stay close, unrelated labels do not', () => {
    expect(labelSimilarity('Company information', 'Company details')).toBeGreaterThanOrEqual(0.5);
    expect(labelSimilarity('Company information', 'Settings')).toBe(0);
    expect(labelSimilarity('Informations sur la société', 'Informations société')).toBeGreaterThan(0.3);
  });
});
