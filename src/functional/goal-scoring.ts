import type { TestGoal, TestGoalCategory } from './model.js';

/**
 * GOAL SCORING — le SEUL endroit où se calculent la priorité d'un objectif de test et
 * les points qu'un objectif donne à une action (signal `functional` du moteur de
 * décision). La SafetyPolicy reste HORS du score : un objectif bloqué n'a pas de points,
 * il n'est pas « moins prioritaire ».
 *
 *   priorité = gain de couverture × importance × confiance ÷ coût, moins le risque
 */

/** Importance d'une catégorie : une transition ou un workflow métier valent plus qu'un contrat. */
const IMPORTANCE: Record<TestGoalCategory, number> = {
  STATE_TRANSITION: 1,
  WORKFLOW: 0.95,
  INVARIANT: 0.9,
  ERROR_PATH: 0.8,
  SIDE_EFFECT: 0.75,
  PERMISSION: 0.85,
  RULE: 0.7,
  CONTRACT: 0.6,
};

export interface GoalScoreInput {
  category: TestGoalCategory;
  /** Attentes fonctionnelles que l'objectif vérifierait (≥ 1). */
  coverageGain: number;
  /** Interactions estimées pour l'atteindre (0 : l'écran courant y est déjà). */
  estimatedCost: number;
  /** 0 … 1 (classification de la SafetyPolicy : SAFE 0, MUTATION 0.5, DANGEROUS 1). */
  risk: number;
  /** Confiance dans la connaissance d'où vient l'objectif (0 … 1). */
  confidence: number;
}

/** Priorité 0 … 100 : faible coût et fort gain l'emportent. */
export function goalPriority(input: GoalScoreInput): number {
  const gain = Math.min(1, Math.max(1, input.coverageGain) / 4);
  const cost = 1 / (1 + Math.max(0, input.estimatedCost) / 2);
  const raw =
    100 *
    IMPORTANCE[input.category] *
    (0.45 * gain + 0.55 * cost) *
    (0.5 + input.confidence / 2) *
    (1 - 0.3 * input.risk);
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/** Le risque d'un objectif d'après la classification de son action déclencheuse. */
export function riskOf(classification: string | undefined): number {
  if (classification === 'DANGEROUS' || classification === 'UNKNOWN') return 1;
  if (classification === 'MUTATION') return 0.5;
  return 0;
}

/** Une contribution d'objectif au score d'une action, expliquée. */
export interface GoalSignal {
  goalId: string;
  kind: 'progress' | 'coverage';
  points: number;
  reason: string;
}

/**
 * Les points qu'une action reçoit d'un objectif :
 * - TEST_GOAL_PROGRESS : l'action EST le déclencheur et la précondition tient à l'écran
 *   (le plus fort), ou elle mène à l'écran de l'objectif ;
 * - couverture : une transition, un invariant ou un workflow encore non vérifiés.
 * Un objectif BLOCKED, VERIFIED, FAILED ou INCONCLUSIVE ne donne rien.
 */
export function goalSignal(
  goal: TestGoal,
  relation: 'TRIGGER_READY' | 'TRIGGER_PRECONDITION_UNKNOWN' | 'LEADS_TO_TARGET',
): GoalSignal | undefined {
  if (goal.status !== 'CANDIDATE' && goal.status !== 'PLANNED' && goal.status !== 'RUNNING') return undefined;
  const scale = goal.priority / 100;
  if (relation === 'TRIGGER_READY')
    return {
      goalId: goal.id,
      kind: 'progress',
      points: Math.round(60 + 60 * scale),
      reason: `TEST_GOAL_PROGRESS: ${goal.intent} (precondition met)`,
    };
  if (relation === 'TRIGGER_PRECONDITION_UNKNOWN')
    return {
      goalId: goal.id,
      kind: 'coverage',
      points: Math.round(20 + 30 * scale),
      reason: `${coverageName(goal.category)}: ${goal.intent}`,
    };
  return {
    goalId: goal.id,
    kind: 'progress',
    points: Math.round(10 + 25 * scale),
    reason: `TEST_GOAL_PROGRESS: towards ${goal.target?.route ?? 'the goal screen'} (${goal.intent})`,
  };
}

function coverageName(category: TestGoalCategory): string {
  switch (category) {
    case 'STATE_TRANSITION':
      return 'stateTransitionCoverage';
    case 'INVARIANT':
      return 'invariantCoverage';
    case 'WORKFLOW':
      return 'workflowCoverage';
    default:
      return 'functionalCoverage';
  }
}
