import type { FlowStep } from '../config/flow-schema.js';
import type { RecoveryInput, RecoveryKnowledge } from '../knowledge/knowledge-model.js';
import { analyzeDivergence, confirmCause, type DivergenceInput } from './divergence-analyzer.js';
import { recoverGoal, type RecoveryDriver } from './goal-recovery-engine.js';
import type {
  DivergenceSymptom,
  Evidence,
  FunctionalGoal,
  HealingEvent,
  RecoveryBudgets,
  RecoveryOutcome,
  ScreenControl,
  StepRecoveryReport,
} from './model.js';
import { historicalRecoveries, recoveryKeyOf } from './recovery-memory.js';
import { controlKey, planRecovery, reasonsOf, type SafetyJudgement } from './recovery-planner.js';
import { inferFunctionalGoal, predicateText, resolveWorkflowContext } from './workflow-context.js';

export interface HealingOptions {
  analyzeDivergence: boolean;
  useWorkflowContext: boolean;
  inferFunctionalGoals: boolean;
  goalBasedRecovery: boolean;
  useStaticKnowledge: boolean;
  useHistoricalRecovery: boolean;
  onAmbiguity: 'stop' | 'experiment';
  budgets: RecoveryBudgets;
}

/** Ce que le guérisseur demande au navigateur et aux connaissances : rien de plus. */
export interface HealingPorts {
  driver: RecoveryDriver;
  screen(): Promise<{
    controls: ScreenControl[];
    route: string;
    text: string;
    overlay?: string;
    loginFormVisible: boolean;
  }>;
  network(): { request: string; status?: number }[];
  judge(control: ScreenControl, kind: 'click' | 'check'): SafetyJudgement;
  history?(key: string): RecoveryKnowledge | undefined;
  staticEvidence?(control: ScreenControl, goal: FunctionalGoal): Evidence | undefined;
  dependencyEvidence?(control: ScreenControl, goal: FunctionalGoal): Evidence | undefined;
  synonyms?(term: string): readonly string[];
  learn?(input: RecoveryInput): void;
  emit(event: HealingEvent, message: string): void;
  now(): string;
  version?: string;
}

export interface HealRequest {
  steps: readonly FlowStep[];
  /** Position (0..n-1) de l'étape qui diverge. */
  position: number;
  actionId: string;
  symptom: DivergenceSymptom;
  /** L'étape précédente : son effet a-t-il été seulement accepté provisoirement ? */
  previous?: { index: number; deferredEffect: boolean; description: string; observed: readonly string[] };
}

export interface HealResult {
  report: StepRecoveryReport;
  /** À apprendre quand l'étape suivante aura confirmé (ou infirmé) la récupération. */
  learning?: RecoveryInput;
}

/**
 * WORKFLOW HEALER : le cerveau du self-healing, hors de Playwright.
 *
 *   DivergenceAnalyzer → WorkflowContextResolver → WorkflowIntentResolver (objectif)
 *   → RecoveryPlanner (SafetyPolicy) → GoalBasedRecoveryEngine → cause confirmée
 *
 * Ne s'exécute qu'après une divergence. L'explorateur fournit les accès (HealingPorts) ;
 * il n'y a pas de logique de récupération dans l'exécuteur.
 */
export async function healWorkflow(
  request: HealRequest,
  ports: HealingPorts,
  options: HealingOptions,
): Promise<HealResult> {
  const step = request.steps[request.position];
  if (!step) throw new Error('no step to heal');
  const index = request.position + 1;
  ports.emit('DIVERGENCE_ANALYSIS_STARTED', `step ${String(index)}: ${request.symptom}`);
  const screen = await ports.screen();
  const fullContext = resolveWorkflowContext(request.steps, request.position);
  const context = options.useWorkflowContext
    ? fullContext
    : { ...fullContext, nextActions: [], requiredFutureFields: [], requiredFutureControls: [] };
  ports.emit(
    'WORKFLOW_CONTEXT_RESOLVED',
    `previous: ${context.previousActions.map((action) => action.label).join(', ') || '—'}; next: ${
      context.nextActions.map((action) => `${action.kind} ${action.label}`).join(', ') || '—'
    }`,
  );
  const effects = 'effects' in step ? step.effects : undefined;
  const goal: FunctionalGoal = options.inferFunctionalGoals
    ? inferFunctionalGoal(context, effects)
    : { id: 'UNRESOLVED', predicates: [], confidence: 0, level: 'UNRESOLVED', source: [] };
  ports.emit(
    'FUNCTIONAL_GOAL_INFERRED',
    `${goal.id} (${goal.level}): ${goal.predicates.map(predicateText).join(', ') || 'no predicate'}`,
  );
  const initial = goal.predicates.length > 0 ? await ports.driver.progress(goal) : undefined;
  const original = {
    label: context.currentAction.label,
    ...(context.currentAction.role ? { role: context.currentAction.role } : {}),
    kind: context.currentAction.kind,
  };
  const divergenceInput: DivergenceInput = {
    actionId: request.actionId,
    stepIndex: index,
    symptom: request.symptom,
    expected: original,
    ...(effects ? { effects } : {}),
    screen,
    network: ports.network(),
    ...(request.previous ? { previous: request.previous } : {}),
    ...(initial ? { goal: initial } : {}),
    ...(effects?.route ? { expectedRoute: effects.route } : {}),
  };
  let analysis = analyzeDivergence(divergenceInput);
  if (!options.analyzeDivergence)
    analysis = {
      ...analysis,
      category: 'UNKNOWN_DIVERGENCE',
      confidence: 0.2,
      possibleCauses: analysis.possibleCauses.slice(0, 0),
    };
  ports.emit(
    'DIVERGENCE_CLASSIFIED',
    `step ${String(index)}: ${analysis.category} (${String(analysis.confidence)})`,
  );
  for (const cause of analysis.possibleCauses.filter((candidate) => candidate.confidence >= 0.3))
    ports.emit('ROOT_CAUSE_CANDIDATE_IDENTIFIED', `${cause.category} ${String(cause.confidence)}`);

  const { key, actionSignature } = recoveryKeyOf(original, goal.id);
  const history =
    options.useHistoricalRecovery && ports.history
      ? historicalRecoveries(ports.history(key), {
          now: ports.now(),
          ...(ports.version ? { version: ports.version } : {}),
        })
      : { candidates: [], avoid: [] };
  // Les cibles des étapes précédentes ne sont jamais rejouées comme « récupération ».
  const exclude = new Set<string>(history.avoid);
  for (const previous of request.steps.slice(0, request.position)) {
    if (!('target' in previous)) continue;
    const name = previous.target.name ?? previous.target.value;
    if (previous.target.role && name) exclude.add(controlKey({ role: previous.target.role, name }));
  }
  const recentlyAppeared = new Set(
    (request.previous?.observed ?? [])
      .filter((entry) => entry.startsWith('+ '))
      .map((entry) => entry.slice(2).toLowerCase()),
  );
  const planFor = (controls: ScreenControl[], extra: ReadonlySet<string> = new Set()) =>
    planRecovery({
      analysis,
      context,
      goal,
      original,
      controls,
      recentlyAppeared,
      history: history.candidates,
      ...(options.useStaticKnowledge && ports.staticEvidence
        ? { staticEvidence: (control: ScreenControl) => ports.staticEvidence?.(control, goal) }
        : {}),
      ...(ports.dependencyEvidence
        ? { dependencyEvidence: (control: ScreenControl) => ports.dependencyEvidence?.(control, goal) }
        : {}),
      judge: (control, kind) => ports.judge(control, kind),
      budgets: options.budgets,
      onAmbiguity: options.onAmbiguity,
      exclude: new Set([...exclude, ...extra]),
      synonyms: (term: string) => ports.synonyms?.(term) ?? [],
    });
  const plan = planFor(screen.controls);
  ports.emit(
    'RECOVERY_PLAN_CREATED',
    `${plan.status}: ${
      plan.candidates
        .slice(0, 3)
        .map((candidate) => `${candidate.signature} (${String(candidate.score)})`)
        .join(', ') || 'no candidate'
    }`,
  );
  for (const rejected of plan.rejected)
    ports.emit('RECOVERY_CANDIDATE_REJECTED', `${rejected.signature}: ${rejected.risk} — ${rejected.reason}`);

  let outcome: RecoveryOutcome;
  if (!options.goalBasedRecovery || !analysis.recoverable || goal.predicates.length === 0) {
    outcome = {
      status: analysis.recoverable && goal.predicates.length > 0 ? 'NOT_ATTEMPTED' : 'NO_SAFE_RECOVERY',
      path: [],
      attempts: [],
      ...(initial ? { progress: initial } : {}),
      experiments: 0,
      actionsExecuted: 0,
      durationMs: 0,
      reasons: plan.reasons.length > 0 ? plan.reasons : ['goal-based recovery disabled'],
    };
  } else {
    ports.emit('GOAL_RECOVERY_STARTED', `${goal.id}: ${String(plan.candidates.length)} candidate(s)`);
    outcome = await recoverGoal(ports.driver, {
      goal,
      original,
      plan,
      replan: (controls, extra) => planFor(controls, extra),
      budgets: options.budgets,
      onAmbiguity: options.onAmbiguity,
      onProgress: (event, message) => {
        ports.emit(event, message);
      },
    });
    ports.emit(
      outcome.status === 'GOAL_REACHED' || outcome.status === 'GOAL_ALREADY_REACHED'
        ? 'GOAL_REACHED'
        : 'GOAL_RECOVERY_FAILED',
      `${goal.id}: ${outcome.status}${outcome.path.length > 0 ? ` by ${outcome.path.map((action) => `${action.kind} ${action.role}:${action.name}`).join(' → ')}` : ''}`,
    );
    // Un chemin historique qui n'a pas marché perd du poids (jamais supprimé).
    for (const attempt of outcome.attempts)
      if (
        attempt.source === 'HISTORY' &&
        attempt.result !== 'GOAL_REACHED' &&
        attempt.result !== 'SKIPPED_VISITED'
      ) {
        const failed = history.candidates.find((candidate) =>
          attempt.path.endsWith(
            candidate.actions
              .map((action) => `${action.kind} ${action.role}:${action.name.toLowerCase()}`)
              .join(' → '),
          ),
        );
        if (failed)
          ports.learn?.({
            key,
            actionSignature,
            goal: goal.id,
            originalTarget: original.label,
            actions: failed.actions,
            result: 'FAILURE',
            ...(ports.version ? { version: ports.version } : {}),
            at: ports.now(),
          });
      }
  }
  // Un champ : le chemin trouvé ne fait que le rendre disponible, l'étape d'origine le remplit ensuite.
  if (context.currentAction.field && context.currentAction.kind !== 'check')
    outcome = {
      ...outcome,
      path: outcome.path.map((action) => ({ ...action, part: 'INSERTED_PREREQUISITE' as const })),
    };
  if (outcome.status === 'GOAL_REACHED' && outcome.confirmedCategory) {
    analysis = confirmCause(analysis, outcome.confirmedCategory, [
      {
        source: 'RUNTIME',
        detail: `goal ${goal.id} reached: ${outcome.progress?.satisfied.join(', ') ?? ''}`,
      },
    ]);
    for (const action of outcome.path.filter((candidate) => candidate.part === 'INSERTED_PREREQUISITE'))
      ports.emit(
        'PREREQUISITE_DISCOVERED',
        `${action.kind} ${action.role} "${action.name}" before "${original.label}"`,
      );
  } else if (outcome.status === 'NO_SAFE_RECOVERY' && outcome.experiments > 0 && analysis.recoverable) {
    analysis = confirmCause(
      analysis,
      'RECORDED_FLOW_OBSOLETE',
      [
        {
          source: 'RUNTIME',
          detail: `no safe path reaches ${goal.id} (${String(outcome.experiments)} experiment(s))`,
        },
      ],
      0.6,
    );
  } else if (outcome.status === 'AMBIGUOUS_RECOVERY') {
    analysis = confirmCause(
      analysis,
      'AMBIGUOUS_UI',
      [{ source: 'RUNTIME', detail: plan.reasons[0] ?? 'two candidates' }],
      0.6,
    );
  }
  const selected = plan.candidates.find(
    (candidate) =>
      outcome.path.length > 0 &&
      outcome.attempts.some(
        (attempt) => attempt.result === 'GOAL_REACHED' && attempt.path.includes(candidate.signature),
      ),
  );
  const report: StepRecoveryReport = {
    originalActionId: request.actionId,
    originalTarget: original.label,
    ...(original.role ? { originalRole: original.role } : {}),
    divergence: analysis,
    context: {
      previous: context.previousActions.map((action) => `${action.kind} ${action.label}`),
      next: context.nextActions.map((action) => `${action.kind} ${action.label}`),
      requiredFields: context.requiredFutureFields.map((action) => action.label),
      ...(context.businessIntent ? { intent: context.businessIntent } : {}),
    },
    goal,
    plan: {
      status: outcome.status === 'GOAL_REACHED' ? 'CONFIRMED' : plan.status,
      candidates: plan.candidates.slice(0, 5).map((candidate) => ({
        signature: candidate.signature,
        source: candidate.source,
        score: candidate.score,
        risk: candidate.risk,
        reasons: reasonsOf(candidate),
      })),
      rejected: plan.rejected.slice(0, 5),
      truncated: plan.truncated,
    },
    outcome,
    ...(selected
      ? {
          selected: {
            signature: selected.signature,
            source: selected.source,
            reasons: reasonsOf(selected),
            risk: selected.risk,
          },
        }
      : outcome.path.length > 0
        ? {
            selected: {
              signature: outcome.path
                .map((action) => `${action.kind} ${action.role}:${action.name.toLowerCase()}`)
                .join(' → '),
              source: outcome.pathSource ?? 'CURRENT_UI',
              reasons: ['+ reached the goal at runtime (multi-step path)', '+ every action classified SAFE'],
              risk: 'SAFE' as const,
            },
          }
        : {}),
    ...(outcome.progress ? { goalVerification: outcome.progress } : {}),
    ...(ports.version ? { applicationVersion: ports.version } : {}),
  };
  const learning: RecoveryInput | undefined =
    outcome.status === 'GOAL_REACHED'
      ? {
          key,
          actionSignature,
          goal: goal.id,
          route: screen.route,
          originalTarget: original.label,
          actions: outcome.path.map((action) => ({
            kind: action.kind,
            role: action.role,
            name: action.name,
          })),
          result: 'SUCCESS',
          ...(ports.version ? { version: ports.version } : {}),
          at: ports.now(),
        }
      : undefined;
  return { report, ...(learning ? { learning } : {}) };
}
