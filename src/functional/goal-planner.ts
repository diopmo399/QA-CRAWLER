import type { RuleCondition } from '../static-analysis/rules/rule-model.js';
import { sameLabel, type ScreenFacts, type TestGoal } from './model.js';

export type PlanStrategy =
  'CURRENT_STATE' | 'KNOWN_PATH' | 'HISTORICAL_PATH' | 'STATIC_CANDIDATE' | 'BOUNDED_EXPLORATION';

export interface GoalPlan {
  goalId: string;
  strategy: PlanStrategy;
  /** Interactions estimées. */
  cost: number;
  /** Le déclencheur est à l'écran et la précondition tient : l'action suivante réalise l'objectif. */
  ready: boolean;
  explanation: string;
}

/** Ce que le planificateur sait de l'application, sans la parcourir lui-même. */
export interface PlanningContext {
  screen?: ScreenFacts;
  /** Les états métier d'une entité affichés à l'écran courant. */
  statesShown(entityType: string): string[];
  /** FlowGraph : étapes vers un écran CONFIRMÉ de cette route (undefined : aucun chemin connu). */
  knownPath(route: string): number | undefined;
  /** KnowledgeBase : un run précédent a atteint cette route (étapes), jamais une preuve. */
  historicalPath(route: string): number | undefined;
}

/** La route d'un écran (/registrations/12) correspond-elle au modèle (registrations/:id) ? */
export function routeMatches(template: string, route: string | undefined): boolean {
  if (!route) return false;
  const wanted = template.replace(/^\//, '').split('/').filter(Boolean);
  const actual = route.replace(/^\//, '').split('?')[0]?.split('/').filter(Boolean) ?? [];
  return (
    wanted.length === actual.length &&
    wanted.every((segment, index) => /^[:{]/.test(segment) || segment === actual[index])
  );
}

/**
 * TEST GOAL PLANNER — léger : il ne parcourt rien, il choisit COMMENT atteindre un
 * objectif à partir de ce que le crawler sait déjà, dans cet ordre :
 *
 *   1. l'écran courant satisfait déjà la précondition (jamais défaire puis refaire une
 *      valeur déjà en place : BUSINESS reste BUSINESS) ;
 *   2. un chemin CONFIRMÉ du FlowGraph ;
 *   3. un chemin historique (un indice, jamais une preuve) ;
 *   4. une route candidate du code (RuleGraph, analyse statique) ;
 *   5. une exploration bornée.
 *
 * L'exécution reste celle du moteur de décision et de l'explorateur, sous la SafetyPolicy.
 */
export class TestGoalPlanner {
  plan(goal: TestGoal, context: PlanningContext): GoalPlan {
    const screen = context.screen;
    const route = goal.target?.route;
    const onTarget = route ? routeMatches(route, screen?.route) : true;
    const precondition = this.preconditionHolds(goal, context);
    const trigger = goal.target?.actionLabel;
    const offered =
      trigger !== undefined &&
      (screen?.buttons.some((button) => button.enabled && sameLabel(button.label, trigger)) ?? false);
    if (onTarget && precondition === true && (offered || trigger === undefined))
      return {
        goalId: goal.id,
        strategy: 'CURRENT_STATE',
        cost: trigger ? 1 : 0,
        ready: offered,
        explanation: `current screen already satisfies: ${goal.preconditions.map((entry) => entry.description).join('; ') || 'no precondition'}${offered && trigger ? `; "${trigger}" offered` : ''}`,
      };
    if (route) {
      const known = context.knownPath(route);
      if (known !== undefined)
        return {
          goalId: goal.id,
          strategy: 'KNOWN_PATH',
          cost: known + 1,
          ready: false,
          explanation: `confirmed FlowGraph path to ${route} (${String(known)} step(s))`,
        };
      const historical = context.historicalPath(route);
      if (historical !== undefined)
        return {
          goalId: goal.id,
          strategy: 'HISTORICAL_PATH',
          cost: historical + 2,
          ready: false,
          explanation: `a previous run reached ${route} (${String(historical)} step(s)) — guidance only, not proof`,
        };
      return {
        goalId: goal.id,
        strategy: 'STATIC_CANDIDATE',
        cost: 4,
        ready: false,
        explanation: `route ${route} found in the code`,
      };
    }
    return {
      goalId: goal.id,
      strategy: 'BOUNDED_EXPLORATION',
      cost: 6,
      ready: false,
      explanation: 'no known path: bounded exploration',
    };
  }

  /**
   * La précondition tient-elle à l'écran courant ? true / false, ou undefined quand
   * l'écran ne permet pas d'en juger.
   */
  preconditionHolds(goal: TestGoal, context: PlanningContext): boolean | undefined {
    if (goal.preconditions.length === 0) return true;
    let unknown = false;
    for (const precondition of goal.preconditions) {
      const verdict = this.holds(precondition.condition, goal, context);
      if (verdict === false) return false;
      if (verdict === undefined) unknown = true;
    }
    return unknown ? undefined : true;
  }

  private holds(
    condition: RuleCondition | undefined,
    goal: TestGoal,
    context: PlanningContext,
  ): boolean | undefined {
    if (!condition || condition.kind !== 'COMPARE') return undefined;
    const name = condition.subject.control ?? condition.subject.name;
    if (condition.subject.kind === 'STATE' && goal.target?.entityType) {
      const shown = context.statesShown(goal.target.entityType);
      if (shown.length !== 1) return undefined;
      const equal = shown[0] === String(condition.value);
      return condition.operator === '==' ? equal : condition.operator === '!=' ? !equal : undefined;
    }
    const selected = context.screen?.selections[name];
    if (selected === undefined) return undefined;
    const equal = selected.toLowerCase() === String(condition.value).toLowerCase();
    return condition.operator === '==' ? equal : condition.operator === '!=' ? !equal : undefined;
  }
}
