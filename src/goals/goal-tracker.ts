import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { DetectedPattern } from '../patterns/ui-pattern.js';
import type { GoalMatcher } from './goal-matcher.js';
import type { ExplorationPlan, GoalState } from './goal-model.js';

/** Ce qu'un objectif apporte au score d'une action. */
export interface GoalRelevance {
  goalId: string;
  description: string;
  /** 0..1, pondéré par la priorité de l'objectif. */
  weight: number;
}

const FINAL = new Set<GoalState['status']>(['REACHED', 'UNREACHABLE', 'BLOCKED']);

/**
 * Suit le plan pendant le run : à chaque écran observé, le GoalMatcher cherche des
 * preuves ; un objectif passe REACHED seulement avec une preuve observable, et
 * l'objectif de mission quand tous ses sous-objectifs le sont. L'objectif ACTIF est
 * le plus prioritaire dont les prérequis sont atteints.
 */
export class GoalTracker {
  constructor(
    readonly plan: ExplorationPlan,
    private readonly matcher: GoalMatcher,
  ) {
    this.refreshActive();
  }

  get goals(): readonly GoalState[] {
    return this.plan.goals;
  }

  /** Les objectifs atteints sur cet écran (nouvellement). */
  observe(context: PageContext, patterns: readonly DetectedPattern[]): GoalState[] {
    const reached: GoalState[] = [];
    for (const goal of this.plan.goals) {
      if (FINAL.has(goal.status) || goal.kind === 'mission') continue;
      const match = this.matcher.evaluate(goal, context, patterns);
      if (!match.reached) continue;
      goal.status = 'REACHED';
      goal.reachedAt = context.metadata.timestamp;
      goal.evidence = match.evidence;
      reached.push(goal);
    }
    for (const mission of this.plan.goals.filter(
      (goal) => goal.kind === 'mission' && !FINAL.has(goal.status),
    )) {
      const children = this.children(mission.id);
      if (children.length > 0 && children.every((child) => child.status === 'REACHED')) {
        mission.status = 'REACHED';
        mission.reachedAt = context.metadata.timestamp;
        mission.evidence = children.flatMap((child) => child.evidence).slice(0, 6);
        reached.push(mission);
      }
    }
    if (reached.length > 0) this.refreshActive();
    return reached;
  }

  /** L'objectif actif (le plus prioritaire dont les prérequis sont atteints). */
  active(): GoalState | undefined {
    return this.plan.goals.find((goal) => goal.status === 'ACTIVE');
  }

  /** Objectifs encore ouverts (ni atteints, ni bloqués). */
  open(): GoalState[] {
    return this.plan.goals.filter((goal) => !FINAL.has(goal.status) && goal.kind !== 'mission');
  }

  /**
   * L'objectif le plus servi par cette action : pertinence × priorité, bonus pour
   * l'objectif actif. undefined quand aucun objectif ouvert n'est concerné.
   */
  relevance(action: DiscoveredAction, context: PageContext): GoalRelevance | undefined {
    let best: GoalRelevance | undefined;
    for (const goal of this.open()) {
      const relevance = this.matcher.relevance(goal, action, context);
      if (relevance <= 0) continue;
      const weight = relevance * (goal.priority / 10) * (goal.status === 'ACTIVE' ? 1.25 : 1);
      if (!best || weight > best.weight) best = { goalId: goal.id, description: goal.description, weight };
    }
    return best;
  }

  /**
   * Fin du run : ce qui n'a pas été atteint devient UNREACHABLE (ou reste BLOCKED avec
   * sa raison). `reason` explique pourquoi l'exploration s'est arrêtée.
   */
  finalize(reason: string): void {
    for (const goal of this.plan.goals) {
      if (FINAL.has(goal.status)) continue;
      const blockedChild = this.children(goal.id).find((child) => child.status === 'BLOCKED');
      if (blockedChild) {
        goal.status = 'BLOCKED';
        goal.reason = blockedChild.reason ?? 'a sub-goal is blocked';
      } else {
        goal.status = 'UNREACHABLE';
        goal.reason = `not observed before the end of the exploration (${reason})`;
      }
    }
  }

  private children(id: string): GoalState[] {
    return this.plan.goals.filter((goal) => goal.parentId === id);
  }

  private refreshActive(): void {
    const reached = new Set(
      this.plan.goals.filter((goal) => goal.status === 'REACHED').map((goal) => goal.id),
    );
    for (const goal of this.plan.goals) if (goal.status === 'ACTIVE') goal.status = 'PENDING';
    const next = this.plan.goals
      .filter(
        (goal) =>
          goal.status === 'PENDING' &&
          goal.kind !== 'mission' &&
          goal.dependsOn.every((id) => reached.has(id)),
      )
      .sort((a, b) => b.priority - a.priority)[0];
    if (next) next.status = 'ACTIVE';
  }
}
