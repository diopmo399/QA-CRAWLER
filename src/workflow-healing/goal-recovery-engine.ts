import type {
  DivergenceCategory,
  FunctionalGoal,
  GoalProgress,
  RecoveryAction,
  RecoveryAttempt,
  RecoveryBudgets,
  RecoveryCandidate,
  RecoveryOutcome,
  RecoveryPlan,
  RecoveryRole,
  ScreenControl,
} from './model.js';
import { actionSignature, pathSignature } from './recovery-planner.js';
import { labelSimilarity } from './similarity.js';

/** Ce qu'une action de récupération a produit. `undo` remet l'écran comme avant (si possible). */
export interface DriverExecution {
  status: 'DONE' | 'NOT_FOUND' | 'FAILED';
  detail?: string;
  /** Contrôles apparus (rôle:nom) : l'action a débloqué quelque chose. */
  appeared: string[];
  undo?: () => Promise<boolean>;
}

/** Le navigateur, vu par le moteur : il n'en sait pas plus (testable sans Playwright). */
export interface RecoveryDriver {
  screen(): Promise<ScreenControl[]>;
  execute(action: RecoveryAction): Promise<DriverExecution>;
  progress(goal: FunctionalGoal): Promise<GoalProgress>;
  stateKey(): Promise<string>;
}

export interface GoalRecoveryInput {
  goal: FunctionalGoal;
  original: { label: string; role?: string };
  /** Le plan initial (écran courant + historique), puis un plan par niveau de profondeur. */
  plan: RecoveryPlan;
  replan: (controls: ScreenControl[], exclude: ReadonlySet<string>) => RecoveryPlan;
  budgets: RecoveryBudgets;
  /** Une expérience SAFE et réversible peut départager deux candidats ambigus. */
  onAmbiguity: 'stop' | 'experiment';
  onProgress?: (
    event: 'GOAL_PROGRESS_UPDATED' | 'PREREQUISITE_DISCOVERED' | 'RECOVERY_CANDIDATE_EVALUATED',
    message: string,
  ) => void;
  now?: () => number;
}

/**
 * GOAL-BASED RECOVERY : atteindre l'objectif fonctionnel quand l'action d'origine n'est
 * plus rejouable telle quelle. Recherche BORNÉE (profondeur, actions, durée, expériences)
 * sur les états, avec des actions SAFE seulement :
 *
 *   état courant → candidat A / B / C → état observé → progression de l'objectif
 *        └ l'action a débloqué de nouveaux contrôles : un niveau de plus (prérequis inséré)
 *        └ rien de mieux : l'expérience est annulée (case décochée, retour arrière)
 *
 * visited(état, objectif, candidat) empêche les boucles. Un budget atteint n'est jamais
 * « inaccessible » : RECOVERY_BUDGET_EXHAUSTED (inconclusif).
 */
export async function recoverGoal(
  driver: RecoveryDriver,
  input: GoalRecoveryInput,
): Promise<RecoveryOutcome> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const attempts: RecoveryAttempt[] = [];
  const visited = new Set<string>();
  let experiments = 0;
  let actionsExecuted = 0;
  const budgetState = { exhausted: false };
  const reasons: string[] = [];
  const budget = input.budgets;

  const initial = await driver.progress(input.goal);
  if (initial.status === 'REACHED')
    return {
      status: 'GOAL_ALREADY_REACHED',
      path: [],
      attempts,
      progress: initial,
      experiments: 0,
      actionsExecuted: 0,
      durationMs: now() - started,
      confirmedCategory: 'RECORDED_FLOW_OBSOLETE',
      reasons: ['the goal is already reached without the recorded action: the step may be obsolete'],
    };
  if (input.plan.status === 'AMBIGUOUS' && input.onAmbiguity === 'stop')
    return finish('AMBIGUOUS_RECOVERY', [], initial, [
      'two candidates are equally plausible; none is chosen arbitrarily',
    ]);
  if (input.plan.status === 'NO_SAFE_RECOVERY')
    return finish('NO_SAFE_RECOVERY', [], initial, input.plan.reasons);

  const outOfBudget = (): boolean => {
    if (
      experiments >= budget.maxSafeExperiments ||
      actionsExecuted >= budget.maxRecoveryActions ||
      now() - started >= budget.maxRecoveryDurationMs
    ) {
      budgetState.exhausted = true;
      return true;
    }
    return false;
  };

  /** Exécute un chemin ; rend la progression atteinte et ce qu'il faut annuler. */
  const run = async (
    candidate: RecoveryCandidate,
  ): Promise<{
    progress?: GoalProgress;
    appeared: string[];
    undo: (() => Promise<boolean>)[];
    failure?: string;
    notFound?: boolean;
  }> => {
    const undo: (() => Promise<boolean>)[] = [];
    const appeared: string[] = [];
    for (const action of candidate.actions) {
      if (actionsExecuted >= budget.maxRecoveryActions) {
        budgetState.exhausted = true;
        return { appeared, undo, failure: 'budget' };
      }
      const execution = await driver.execute(action);
      actionsExecuted += execution.status === 'DONE' ? 1 : 0;
      if (execution.undo) undo.unshift(execution.undo);
      if (execution.status !== 'DONE')
        return {
          appeared,
          undo,
          failure: execution.detail ?? execution.status,
          notFound: execution.status === 'NOT_FOUND',
        };
      appeared.push(...execution.appeared);
    }
    return { progress: await driver.progress(input.goal), appeared, undo };
  };

  const restore = async (undo: (() => Promise<boolean>)[]): Promise<boolean> => {
    let ok = true;
    for (const step of undo) ok = (await step().catch(() => false)) && ok;
    return ok;
  };

  const search = async (
    plan: RecoveryPlan,
    depth: number,
    prefix: RecoveryAction[],
    best: number,
    exclude: Set<string>,
  ): Promise<
    { path: RecoveryAction[]; progress: GoalProgress; source: RecoveryCandidate['source'] } | undefined
  > => {
    for (const candidate of plan.candidates) {
      if (outOfBudget()) return undefined;
      const state = await driver.stateKey();
      const key = `${state}|${input.goal.id}|${candidate.signature}`;
      const label = pathSignature([...prefix, ...candidate.actions]);
      if (visited.has(key)) {
        attempts.push({ path: label, source: candidate.source, result: 'SKIPPED_VISITED', progress: best });
        continue;
      }
      visited.add(key);
      experiments += 1;
      const outcome = await run(candidate);
      if (!outcome.progress) {
        const restored = await restore(outcome.undo);
        attempts.push({
          path: label,
          source: candidate.source,
          result: outcome.notFound ? 'NOT_FOUND' : 'FAILED',
          progress: best,
          restored,
          ...(outcome.failure ? { detail: outcome.failure } : {}),
        });
        input.onProgress?.(
          'RECOVERY_CANDIDATE_EVALUATED',
          `${label}: ${outcome.notFound ? 'not found' : (outcome.failure ?? 'failed')}`,
        );
        continue;
      }
      const progress = outcome.progress;
      input.onProgress?.('GOAL_PROGRESS_UPDATED', `${label}: ${input.goal.id} ${String(progress.progress)}`);
      if (progress.status === 'REACHED') {
        attempts.push({
          path: label,
          source: candidate.source,
          result: 'GOAL_REACHED',
          progress: progress.progress,
        });
        return { path: [...prefix, ...candidate.actions], progress, source: candidate.source };
      }
      const unlocked = outcome.appeared.length > 0;
      const improved = progress.progress > best;
      attempts.push({
        path: label,
        source: candidate.source,
        result: improved ? 'PARTIAL' : unlocked ? 'UNLOCKED' : 'NO_EFFECT',
        progress: progress.progress,
      });
      // Un niveau de plus : l'action a débloqué l'écran (prérequis), ou rapproché de l'objectif.
      if ((unlocked || improved) && depth + 1 < budget.maxRecoveryDepth) {
        if (unlocked)
          input.onProgress?.(
            'PREREQUISITE_DISCOVERED',
            `${label} made ${outcome.appeared.slice(0, 3).join(', ')} available`,
          );
        const controls = await driver.screen();
        const deeper = input.replan(
          controls,
          new Set([...exclude, ...candidate.actions.map(actionSignature)]),
        );
        const found = await search(
          { ...deeper, candidates: deeper.candidates.filter((next) => next.source !== 'HISTORY') },
          depth + 1,
          [...prefix, ...candidate.actions],
          Math.max(best, progress.progress),
          new Set([...exclude, ...candidate.actions.map(actionSignature)]),
        );
        if (found) return found;
      }
      const restored = await restore(outcome.undo);
      const last = attempts.at(-1);
      if (last && last.path === label) last.restored = restored;
    }
    return undefined;
  };

  const found = await search(input.plan, 0, [], initial.progress, new Set());
  if (found) {
    const path = found.path.map((action, at) => {
      const part: RecoveryRole = at === found.path.length - 1 ? 'REPLACEMENT' : 'INSERTED_PREREQUISITE';
      return { ...action, part };
    });
    const category = categoryOf(path, input.original);
    return {
      status: 'GOAL_REACHED',
      path,
      pathSource: found.source,
      attempts,
      progress: found.progress,
      experiments,
      actionsExecuted,
      durationMs: now() - started,
      confirmedCategory: category,
      reasons: [`goal ${input.goal.id} reached: ${found.progress.satisfied.join(', ')}`],
    };
  }
  if (budgetState.exhausted || input.plan.truncated > 0)
    return finish('RECOVERY_BUDGET_EXHAUSTED', attempts, initial, [
      'the recovery budget was reached before every safe candidate was tried: inconclusive, not unreachable',
    ]);
  reasons.push(`no safe candidate reached ${input.goal.id} (${String(experiments)} experiment(s))`);
  return finish('NO_SAFE_RECOVERY', attempts, initial, reasons);

  function finish(
    status: RecoveryOutcome['status'],
    tried: RecoveryAttempt[],
    progress: GoalProgress,
    why: string[],
  ): RecoveryOutcome {
    return {
      status,
      path: [],
      attempts: tried,
      progress,
      experiments,
      actionsExecuted,
      durationMs: now() - started,
      reasons: why,
    };
  }
}

/** La cause confirmée par le chemin qui a atteint l'objectif. */
export function categoryOf(
  path: readonly (RecoveryAction & { part: RecoveryRole })[],
  original: { label: string; role?: string },
): DivergenceCategory {
  if (path.some((action) => action.part === 'INSERTED_PREREQUISITE')) return 'PREREQUISITE_MISSING';
  const last = path.at(-1);
  if (!last) return 'UNKNOWN_DIVERGENCE';
  const similarity = labelSimilarity(last.name, original.label);
  if (similarity >= 0.99)
    return original.role && original.role !== last.role ? 'TARGET_REPLACED' : 'TARGET_MOVED';
  if (original.role && original.role !== last.role) return 'TARGET_REPLACED';
  return 'TARGET_RENAMED';
}
