import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { matchFingerprint } from '../../src/flows/action-effect-verifier.js';
import { analyzeExpectedTarget, type TargetProbe } from '../../src/workflow-healing/expected-target.js';
import type { RecoveryDriver } from '../../src/workflow-healing/goal-recovery-engine.js';
import type { FunctionalGoal, RecoveryAction, ScreenControl } from '../../src/workflow-healing/model.js';
import type { SafetyJudgement } from '../../src/workflow-healing/recovery-planner.js';
import {
  healWorkflow,
  type AdviceInput,
  type HealingPorts,
} from '../../src/workflow-healing/workflow-healer.js';
import {
  goalProgressOf,
  inferFunctionalGoal,
  resolveWorkflowContext,
} from '../../src/workflow-healing/workflow-context.js';

const click = (role: string, name: string, extra: Partial<FlowStep> = {}): FlowStep =>
  ({
    kind: 'click',
    target: { strategy: 'role', role, name },
    optional: false,
    allow: [],
    ...extra,
  }) as FlowStep;
const check = (label: string, extra: Partial<FlowStep> = {}): FlowStep =>
  ({
    kind: 'check',
    target: { strategy: 'role', role: 'checkbox', name: label },
    optional: false,
    allow: [],
    ...extra,
  }) as FlowStep;
const fill = (target: FlowStep extends never ? never : Record<string, unknown>): FlowStep =>
  ({ kind: 'fill', target, value: 'x', optional: false, allow: [] }) as unknown as FlowStep;
const control = (role: string, name: string, extra: Partial<ScreenControl> = {}): ScreenControl => ({
  role,
  name,
  visible: true,
  disabled: false,
  ...extra,
});

/** Une application jouet : chaque contrôle peut révéler des contrôles et des champs. */
function app(
  initial: ScreenControl[],
  rules: Record<string, { controls?: ScreenControl[]; fields?: string[] }>,
): { driver: RecoveryDriver; executed: string[]; controls: () => ScreenControl[] } {
  let screen = [...initial];
  let fields = new Set<string>();
  const executed: string[] = [];
  const driver: RecoveryDriver = {
    screen: () => Promise.resolve([...screen]),
    stateKey: () =>
      Promise.resolve(
        [
          ...screen.map(
            (entry) => `${entry.role}:${entry.name}:${String(entry.expanded)}:${String(entry.checked)}`,
          ),
          ...fields,
        ]
          .sort()
          .join(','),
      ),
    progress: (goal: FunctionalGoal) =>
      Promise.resolve(
        goalProgressOf(
          goal,
          goal.predicates.map(
            (predicate) =>
              fields.has(predicate.value) ||
              (predicate.kind !== 'VISIBLE_FIELD' && screen.some((entry) => entry.name === predicate.value)),
          ),
        ),
      ),
    execute: (action: RecoveryAction) => {
      const key = `${action.role}:${action.name}`;
      if (!screen.some((entry) => `${entry.role}:${entry.name}` === key))
        return Promise.resolve({ status: 'NOT_FOUND' as const, appeared: [] });
      executed.push(key);
      const before = [...screen];
      const beforeFields = new Set(fields);
      const rule = rules[key] ?? {};
      screen = [
        ...screen.map((entry) =>
          `${entry.role}:${entry.name}` === key
            ? {
                ...entry,
                ...(entry.expanded === false ? { expanded: true } : {}),
                ...(entry.role === 'checkbox' ? { checked: true } : {}),
              }
            : entry,
        ),
        ...(rule.controls ?? []),
      ];
      for (const field of rule.fields ?? []) fields.add(field);
      return Promise.resolve({
        status: 'DONE' as const,
        appeared: [
          ...(rule.controls ?? []).map((entry) => `${entry.role}:${entry.name}`),
          ...(rule.fields ?? []).map((field) => `textbox:${field}`),
        ],
        undo: () => {
          screen = before;
          fields = beforeFields;
          return Promise.resolve(true);
        },
      });
    },
  };
  return { driver, executed, controls: () => screen };
}

const SAFE: SafetyJudgement = { risk: 'SAFE', allowed: true, reason: 'safe' };

function ports(
  toy: ReturnType<typeof app>,
  options: {
    probe?: TargetProbe;
    judge?: (control: ScreenControl) => SafetyJudgement;
    advise?: (input: AdviceInput) => void;
  } = {},
): HealingPorts {
  return {
    driver: toy.driver,
    screen: () =>
      Promise.resolve({ controls: toy.controls(), route: '/request', text: '', loginFormVisible: false }),
    network: () => [],
    judge: (entry) => options.judge?.(entry) ?? SAFE,
    emit: () => undefined,
    now: () => '2026-10-03T00:00:00Z',
    probeTarget: () => Promise.resolve(options.probe ?? { attached: false, visible: false, readable: false }),
    ...(options.advise
      ? {
          advise: (input: AdviceInput) => {
            options.advise?.(input);
            return Promise.resolve(undefined);
          },
        }
      : {}),
  };
}

const OPTIONS = {
  analyzeDivergence: true,
  useWorkflowContext: true,
  inferFunctionalGoals: true,
  goalBasedRecovery: true,
  useStaticKnowledge: false,
  useHistoricalRecovery: false,
  onAmbiguity: 'experiment' as const,
  budgets: {
    maxRecoveryActions: 5,
    maxRecoveryDepth: 3,
    maxCandidates: 10,
    maxRecoveryDurationMs: 10_000,
    maxSafeExperiments: 6,
  },
};
/** Des boutons SÛRS sans aucun rapport avec la cible : ils ne doivent jamais manger le budget. */
const NOISE = [
  control('button', 'Language'),
  control('button', 'Help'),
  control('button', 'Export list'),
  control('button', 'Start date'),
];

describe('Functional goal recovery: recover the functional state, not the selector', () => {
  it('§35 MISSING PARENT SECTION: the field lives in a collapsed section — diagnosed, the SAFE section control is opened, the field appears', async () => {
    const steps = [
      click('button', 'Company', { effects: { appears: ['textbox:Business number'] } }),
      fill({ strategy: 'label', value: 'Business number' }),
      click('button', 'Apply'),
    ];
    const toy = app(
      [...NOISE, control('button', 'Company details', { expanded: false }), control('button', 'Apply')],
      {
        'button:Company details': { fields: ['Business number'] },
      },
    );
    const { report } = await healWorkflow(
      { steps, position: 1, actionId: 'f#2', symptom: 'TARGET_NOT_FOUND', identifiable: true },
      ports(toy),
      OPTIONS,
    );
    const target = report.divergence.expectedTarget;
    expect(target).toMatchObject({ presence: 'ABSENT', functionalRecovery: true });
    expect(target?.parentSection).toMatchObject({ label: 'button:Company details', state: 'CLOSED' });
    expect(target?.preconditionChain[0]).toBe('FILL Business number');
    expect(['PARENT_SECTION_CLOSED', 'PREREQUISITE_MISSING']).toContain(
      report.divergence.functionalRootCause?.category,
    );
    // Un localisateur ne peut pas être périmé vers une cible qui n'existe pas.
    const stale = report.divergence.possibleCauses.find((cause) => cause.category === 'LOCATOR_STALE');
    expect(stale?.confidence ?? 0).toBeLessThanOrEqual(0.2);
    expect(report.outcome.status).toBe('GOAL_REACHED');
    expect(toy.executed).toEqual(['button:Company details']);
    expect(report.outcome.path).toEqual([
      { kind: 'click', role: 'button', name: 'Company details', part: 'INSERTED_PREREQUISITE' },
    ]);
  });

  it('§36 REAL LOCATOR STALE: the same functional control under a close name → LOCATOR_STALE, no functional recovery', () => {
    const steps = [click('button', 'Company'), fill({ strategy: 'label', value: 'Business number' })];
    const analysis = analyzeExpectedTarget({
      current: resolveWorkflowContext(steps, 0).currentAction,
      identifiable: true,
      probe: { attached: false, visible: false, readable: false },
      controls: [control('button', 'Company profile'), ...NOISE],
      previous: [],
    });
    expect(analysis.presence).toBe('PRESENT_SIMILAR');
    expect(analysis.functionalRecovery).toBe(false);
    expect(analysis.rootCauses[0]).toMatchObject({ category: 'LOCATOR_STALE', confidence: 0.85 });
  });

  it('§37 TARGET NOT RENDERED: a css field without a name, revealed by the previous recorded choice → PREREQUISITE_MISSING → the choice is re-established (HUMAN_JOURNEY), no locator retries', async () => {
    const steps = [
      click('button', 'Filter'),
      check('Show value'),
      fill({ strategy: 'css', value: '#valueInput' }),
      click('button', 'Apply'),
    ];
    const toy = app(
      [...NOISE, control('checkbox', 'Show value', { checked: false }), control('button', 'Apply')],
      {
        'checkbox:Show value': { fields: ['#valueInput'] },
      },
    );
    const { report } = await healWorkflow(
      { steps, position: 2, actionId: 'f#3', symptom: 'TARGET_NOT_FOUND', identifiable: false },
      ports(toy),
      OPTIONS,
    );
    expect(report.divergence.expectedTarget).toMatchObject({ presence: 'ABSENT', functionalRecovery: true });
    expect(report.divergence.functionalRootCause?.category).toBe('PREREQUISITE_MISSING');
    // Le runtime a confirmé la cause FONCTIONNELLE (pas un renommage, pas un localisateur).
    expect(report.divergence.category).toBe('PREREQUISITE_MISSING');
    expect(report.divergence.possibleCauses.map((cause) => cause.category)).toContain('TARGET_NOT_RENDERED');
    expect(report.divergence.expectedTarget?.revealers[0]).toMatchObject({
      label: 'Show value',
      source: 'PREVIOUS_CHOICE',
      hypothetical: true,
    });
    expect(report.outcome.status).toBe('GOAL_REACHED');
    expect(toy.executed).toEqual(['checkbox:Show value']);
    expect(report.plan.candidates[0]).toMatchObject({
      signature: 'check checkbox:show value',
      source: 'HUMAN_JOURNEY',
    });
  });

  it('§38 SAFETY: the only control able to reach the goal is a MUTATION → NO_SAFE_RECOVERY, nothing executed', async () => {
    const steps = [
      click('button', 'Company', { effects: { appears: ['textbox:Business number'] } }),
      fill({ strategy: 'label', value: 'Business number' }),
    ];
    const toy = app([control('button', 'Submit application')], {
      'button:Submit application': { fields: ['Business number'] },
    });
    const { report } = await healWorkflow(
      { steps, position: 1, actionId: 'f#2', symptom: 'TARGET_NOT_FOUND', identifiable: true },
      ports(toy, {
        judge: () => ({ risk: 'MUTATION', allowed: false, reason: 'matches mutation keyword "submit"' }),
      }),
      OPTIONS,
    );
    expect(report.outcome.status).toBe('NO_SAFE_RECOVERY');
    expect(toy.executed).toEqual([]);
    expect(report.plan.rejected[0]).toMatchObject({
      signature: 'click button:submit application',
      risk: 'MUTATION',
    });
  });

  it('§39 COPILOT: no deterministic way → the advisor receives the expected target, the precondition chain and the rebalanced hypotheses', async () => {
    const steps = [
      check('Show value'),
      fill({ strategy: 'css', value: '#valueInput' }),
      click('button', 'Apply'),
    ];
    // Le seul révélateur est une icône (UNKNOWN) : jamais exécutée automatiquement.
    const toy = app([control('button', 'Options', { expanded: false })], {});
    let received: AdviceInput | undefined;
    await healWorkflow(
      { steps, position: 1, actionId: 'f#2', symptom: 'TARGET_NOT_FOUND', identifiable: false },
      ports(toy, {
        judge: () => ({ risk: 'UNKNOWN', allowed: false, reason: 'no readable label' }),
        advise: (input) => {
          received = input;
        },
      }),
      OPTIONS,
    );
    expect(received?.expectedTarget).toMatchObject({ presence: 'ABSENT', functionalRecovery: true });
    expect(received?.expectedTarget?.missingPreconditions.length).toBeGreaterThan(0);
    const categories = received?.hypotheses.map((entry) => entry.category) ?? [];
    expect(categories.slice(0, 3)).toEqual(
      expect.arrayContaining(['TARGET_NOT_RENDERED', 'PARENT_SECTION_CLOSED']),
    );
    expect(
      received?.hypotheses.find((entry) => entry.category === 'LOCATOR_STALE')?.confidence ?? 0,
    ).toBeLessThanOrEqual(0.2);
  });

  it('§40 BUDGET: unrelated candidates do not consume the budget when the target is functionally absent', async () => {
    const steps = [
      click('button', 'Company', { effects: { appears: ['textbox:Business number'] } }),
      fill({ strategy: 'label', value: 'Business number' }),
    ];
    // Les contrôles sans lien d'abord (ordre d'écran), la section ensuite.
    const toy = app([...NOISE, control('button', 'Company details', { expanded: false })], {
      'button:Company details': { fields: ['Business number'] },
    });
    const { report } = await healWorkflow(
      { steps, position: 1, actionId: 'f#2', symptom: 'TARGET_NOT_FOUND', identifiable: true },
      ports(toy),
      { ...OPTIONS, budgets: { ...OPTIONS.budgets, maxSafeExperiments: 1, maxRecoveryActions: 1 } },
    );
    expect(report.outcome.status).toBe('GOAL_REACHED');
    expect(report.plan.candidates.map((candidate) => candidate.signature)).toEqual([
      'click button:company details',
    ]);
  });

  it('a field without a name is verified by its recorded locator (never by a selector used as a label)', () => {
    const steps = [check('Show value'), fill({ strategy: 'css', value: '#valueInput' })];
    const goal = inferFunctionalGoal(resolveWorkflowContext(steps, 1), undefined);
    expect(goal.predicates[0]).toMatchObject({
      kind: 'VISIBLE_FIELD',
      value: '#valueInput',
      target: { strategy: 'css', value: '#valueInput' },
    });
  });

  it('an unreadable element is never reported as "another element" without a reason', () => {
    const match = matchFingerprint({ role: 'textbox', tag: 'input' }, {});
    expect(match.verdict).toBe('MISMATCH');
    expect(match.reasons).toEqual(['the located element could not be read (detached or re-rendered)']);
  });
});
