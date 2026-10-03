import type { FlowStepReport } from '../model/flow-run.js';
import {
  holds,
  resolvePreconditions,
  type ConditionContext,
  type GoalGraph,
  type GoalNode,
} from './goal-graph.js';
import type { Hypothesis } from './hypothesis-engine.js';
import type { SemanticCheckpoint } from './planning.js';

// ------------------------------------------------------------------ goal progress

export interface GoalProgress {
  goal: string;
  /** 0..1 : préconditions et checkpoints satisfaits, pondérés (jamais l'URL ni le DOM seuls). */
  progress: number;
  satisfied: string[];
  missing: string[];
  /** Conditions qu'on ne sait pas juger sur l'écran courant. */
  unknown: string[];
  checkpointsConfirmed: string[];
}

/** Un checkpoint compte plus qu'un champ : un état métier atteint vaut plusieurs signaux. */
const WEIGHT: Record<GoalNode['kind'], number> = { MISSION: 2, GOAL: 2, SUBGOAL: 1.5, PRECONDITION: 1 };

/**
 * GOAL PROGRESS EVALUATOR : à quel point l'objectif est-il atteint ?
 *
 *   préconditions satisfaites · checkpoints sémantiques confirmés · état métier
 *
 * Une condition vraie couvre tout ce dont elle dépend (un formulaire prêt à l'envoi n'a plus de
 * champ manquant) ; un checkpoint CONFIRMÉ reste acquis même quand l'écran a changé. L'objectif
 * lui-même non atteint plafonne l'avancement sous 1.
 */
export function evaluateGoalProgress(
  graph: GoalGraph,
  goalId: string,
  context: ConditionContext,
  checkpoints: ReadonlyMap<string, SemanticCheckpoint> = new Map(),
): GoalProgress {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const satisfied = new Set<string>();
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const covered = (id: string, seen: Set<string>): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    satisfied.add(id);
    for (const child of node.requires) covered(child, seen);
  };
  const visit = (id: string, path: string[]): void => {
    const node = byId.get(id);
    if (!node || path.includes(id)) return;
    const confirmed = checkpoints.get(id)?.status === 'CONFIRMED';
    const value = confirmed ? true : holds(node, context);
    if (value === true) {
      covered(id, new Set());
      return;
    }
    if (value === false) missing.add(id);
    else unknown.add(id);
    for (const child of node.requires) visit(child, [...path, id]);
  };
  visit(goalId, []);
  const weight = (ids: Iterable<string>): number =>
    [...ids].reduce((sum, id) => sum + WEIGHT[byId.get(id)?.kind ?? 'PRECONDITION'], 0);
  const total = weight(satisfied) + weight(missing) + weight(unknown);
  const reached = satisfied.has(goalId);
  const progress = reached ? 1 : total === 0 ? 0 : Math.min(0.95, weight(satisfied) / total);
  return {
    goal: goalId,
    progress: Math.round(progress * 100) / 100,
    satisfied: [...satisfied],
    missing: [...missing],
    unknown: [...unknown],
    checkpointsConfirmed: [...checkpoints.values()]
      .filter((checkpoint) => checkpoint.status === 'CONFIRMED')
      .map((checkpoint) => checkpoint.id),
  };
}

/** Les checkpoints dans l'ordre du parcours (dépendances d'abord) : le dernier atteint, le suivant attendu. */
export function checkpointPosition(
  graph: GoalGraph,
  checkpoints: ReadonlyMap<string, SemanticCheckpoint>,
): { lastConfirmed?: string; nextExpected?: string } {
  const ordered = graph.nodes
    .filter((node) => node.kind === 'GOAL' || node.kind === 'MISSION')
    .map((node) => node.id)
    .filter((id) => checkpoints.has(id));
  const confirmed = ordered.filter((id) => checkpoints.get(id)?.status === 'CONFIRMED');
  const lastConfirmed = confirmed.at(-1);
  const nextExpected = ordered.find((id) => checkpoints.get(id)?.status !== 'CONFIRMED');
  return {
    ...(lastConfirmed ? { lastConfirmed } : {}),
    ...(nextExpected ? { nextExpected } : {}),
  };
}

// ------------------------------------------------------------------ first functional divergence

export interface FunctionalDivergence {
  /** L'étape où le parcours a cessé de produire l'effet fonctionnel attendu. */
  step: number;
  description: string;
  kind: 'EFFECT_MISSING' | 'WRONG_EFFECT' | 'TARGET_MISMATCH' | 'RECOVERY_REQUIRED' | 'STEP_FAILED';
  expected: string[];
  observed: string[];
  reason: string;
  /** L'étape où l'échec a été RAPPORTÉ (souvent plus loin : le symptôme). */
  lastFailedStep?: number;
  /** La dernière étape dont l'effet a été confirmé (point de reprise fiable). */
  lastConfirmedStep?: number;
  /** La divergence est en amont de l'échec rapporté : la dernière erreur n'est pas la cause. */
  rootBeforeSymptom: boolean;
}

/**
 * FIRST FUNCTIONAL DIVERGENCE : la dernière erreur n'est pas forcément la cause.
 *
 *   étape 40 échoue — mais l'étape 34 attendait COMPANY_SECTION_AVAILABLE et rien n'est venu :
 *   la divergence est à l'étape 34.
 *
 * La première étape (obligatoire) dont l'effet attendu manque, est faux, a demandé une
 * récupération, ou a échoué — dans l'ordre du parcours.
 */
export function firstFunctionalDivergence(
  steps: readonly FlowStepReport[],
): FunctionalDivergence | undefined {
  const failed = steps.find((step) => step.status === 'FAILED' || step.status === 'BLOCKED');
  const lastConfirmed = (before: number): number | undefined =>
    steps.filter((step) => step.index < before && step.effect?.status === 'CONFIRMED').at(-1)?.index;
  for (const step of steps) {
    if (step.optional) continue;
    const effect = step.effect;
    const kind: FunctionalDivergence['kind'] | undefined =
      effect?.status === 'NO_EFFECT'
        ? 'EFFECT_MISSING'
        : effect?.status === 'WRONG_EFFECT' || effect?.deferred === true
          ? 'WRONG_EFFECT'
          : effect?.status === 'TARGET_MISMATCH'
            ? 'TARGET_MISMATCH'
            : step.recovery
              ? 'RECOVERY_REQUIRED'
              : step.status === 'FAILED' || step.status === 'BLOCKED'
                ? 'STEP_FAILED'
                : undefined;
    if (!kind) continue;
    // Une récupération qui a atteint son objectif n'est pas une divergence du parcours fonctionnel.
    if (
      kind === 'RECOVERY_REQUIRED' &&
      step.recovery?.outcome.status === 'GOAL_REACHED' &&
      step.status === 'PASSED'
    )
      continue;
    const confirmed = lastConfirmed(step.index);
    return {
      step: step.index,
      description: step.description,
      kind,
      expected: effect?.expected.slice(0, 6) ?? [],
      observed: effect?.observed.slice(0, 6) ?? [],
      reason: (effect?.reasons[0] ?? step.reason ?? kind).slice(0, 200),
      ...(failed ? { lastFailedStep: failed.index } : {}),
      ...(confirmed !== undefined ? { lastConfirmedStep: confirmed } : {}),
      rootBeforeSymptom: failed !== undefined && step.index < failed.index,
    };
  }
  return undefined;
}

// ------------------------------------------------------------------ blocked goal

/** Une tentative d'envoi observée (l'action finale du parcours, ou une écriture). */
export interface SubmitAttempt {
  step: string;
  label: string;
  outcome: 'CONFIRMED' | 'UNCONFIRMED' | 'FAILED';
  detail: string;
}

export interface BlockedGoalAnalysis {
  /** La mission (CREER_NOUVELLE_DEMANDE…). */
  goal: string;
  /** Le nœud racine du graphe d'objectifs (…_DONE). */
  node: string;
  state: 'BLOCKED' | 'SATISFIED' | 'UNKNOWN';
  satisfiedPreconditions: string[];
  /** Les préconditions manquantes ; « UNKNOWN » quand le moteur ne sait pas ce qui manque. */
  missingPreconditions: string[];
  unknownPrecondition: boolean;
  blockingReasons: string[];
  candidateActions: string[];
  candidateHypotheses: string[];
  lastConfirmedCheckpoint?: string;
  nextExpectedCheckpoint?: string;
  progress: number;
  /** Confiance de l'analyse elle-même (basse quand la cause est inconnue). */
  confidence: number;
}

/**
 * BLOCKED GOAL ANALYSIS : un objectif bloqué ne répond pas « blocked », il répond POURQUOI —
 * ou dit honnêtement qu'il ne sait pas (UNKNOWN), ce qui justifie de demander de l'aide
 * (UNKNOWN_BLOCKING_PRECONDITION).
 *
 *   mission CREER_NOUVELLE_DEMANDE · submission READY · objectif toujours bloqué
 *     → l'envoi n'a jamais été confirmé ; ou l'envoi a eu lieu sans effet observé (cause inconnue)
 */
export function analyzeBlockedGoal(input: {
  graph: GoalGraph;
  context: ConditionContext;
  checkpoints: ReadonlyMap<string, SemanticCheckpoint>;
  hypotheses: readonly Hypothesis[];
  submits: readonly SubmitAttempt[];
  failures: readonly { step: string; class: string }[];
  maxDepth?: number;
}): BlockedGoalAnalysis | undefined {
  const { graph } = input;
  if (!graph.root || !graph.mission) return undefined;
  const resolution = resolvePreconditions(graph, graph.root, input.context, input.maxDepth);
  const progress = evaluateGoalProgress(graph, graph.root, input.context, input.checkpoints);
  const position = checkpointPosition(graph, input.checkpoints);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const reasons: string[] = [];
  const missing: string[] = [];
  let unknown = false;
  const lastSubmit = input.submits.at(-1);
  for (const node of resolution.missingPreconditions) {
    if (node.condition.kind === 'MISSION_DONE') {
      const ready = node.requires.every((id) => {
        const child = byId.get(id);
        return child ? holds(child, input.context) === true || progress.satisfied.includes(id) : true;
      });
      if (!ready) {
        // Les préconditions de la mission ne se jugent pas sur cet écran : le moteur ne sait pas.
        unknown = true;
        missing.push('UNKNOWN');
        reasons.push(
          `the readiness of ${graph.mission} cannot be judged on the current screen (${node.requires.join(', ')})`,
        );
        continue;
      }
      const submit = node.achievedBy[0];
      if (!submit) {
        // Une raison CONNUE : le parcours démontré s'arrête avant l'envoi (rien à deviner).
        missing.push(`${graph.mission}_SUBMIT_NOT_DEMONSTRATED`);
        reasons.push(
          `${graph.mission} is ready for submission, but the demonstrated journey ends before any submit action`,
        );
      } else if (!lastSubmit) {
        missing.push(`${graph.mission}_SUBMITTED`);
        reasons.push(
          `ready for submission; the submit action "${submit.label}" has not been executed and confirmed yet`,
        );
      } else if (lastSubmit.outcome === 'FAILED') {
        const failure = input.failures.find((candidate) => candidate.step === lastSubmit.step);
        missing.push(`${graph.mission}_SUBMITTED`);
        reasons.push(
          `submit "${lastSubmit.label}" at ${lastSubmit.step} failed${failure ? ` (${failure.class})` : ''}: ${lastSubmit.detail}`,
        );
      } else {
        // L'envoi a été fait, sans effet confirmé : le moteur ne sait pas ce qui manque.
        unknown = true;
        missing.push('UNKNOWN');
        reasons.push(
          `submission READY and "${lastSubmit.label}" executed at ${lastSubmit.step}, but no accepted write or confirmed effect followed: ${lastSubmit.detail}`,
        );
      }
      continue;
    }
    missing.push(node.id);
    if (node.achievedBy.length === 0) {
      unknown = true;
      reasons.push(`${node.id} is missing and no known action achieves it`);
    } else
      reasons.push(
        `${node.id} is missing — achieved by ${node.achievedBy
          .slice(0, 3)
          .map((action) => `${action.kind} "${action.label}" (${action.source})`)
          .join(', ')}`,
      );
  }
  if (resolution.status === 'UNKNOWN') {
    unknown = true;
    if (!missing.includes('UNKNOWN')) missing.push('UNKNOWN');
    reasons.push('the current screen does not tell which precondition is missing');
  }
  const terms = new Set(
    [graph.mission, ...missing]
      .flatMap((id) => id.toLowerCase().split(/[^a-z0-9]+/))
      .filter((word) => word.length > 3),
  );
  const candidateHypotheses = input.hypotheses
    .filter((hypothesis) => hypothesis.status !== 'REJECTED')
    .filter(
      (hypothesis) =>
        hypothesis.proposition.subject === 'ai-advisor' ||
        hypothesis.proposition.kind === 'PRECONDITION' ||
        `${hypothesis.proposition.subject} ${hypothesis.proposition.object}`
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .some((word) => terms.has(word)),
    )
    .slice(0, 8)
    .map((hypothesis) => hypothesis.id);
  const state = resolution.status;
  const confidence =
    state === 'SATISFIED' ? 1 : unknown ? 0.3 + 0.2 * progress.progress : 0.6 + 0.3 * progress.progress;
  return {
    goal: graph.mission,
    node: graph.root,
    state,
    satisfiedPreconditions: progress.satisfied.filter((id) => id !== graph.root),
    missingPreconditions: [...new Set(missing)],
    unknownPrecondition: unknown,
    blockingReasons: reasons,
    candidateActions: resolution.candidateActions
      .slice(0, 6)
      .map((action) => `${action.kind} "${action.label}" (${action.source})`),
    candidateHypotheses,
    ...(position.lastConfirmed ? { lastConfirmedCheckpoint: position.lastConfirmed } : {}),
    ...(position.nextExpected ? { nextExpectedCheckpoint: position.nextExpected } : {}),
    progress: progress.progress,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ------------------------------------------------------------------ failure context

/** FAILURE CONTEXT : un échec classé, relié à l'objectif qu'il empêche. */
export interface FailureContext {
  affectedGoal?: string;
  checkpoint?: string;
  expected?: string;
  observed: string;
  firstDivergence?: string;
}
