import type { FlowGraph } from '../graph/flow-graph.js';
import type { PageContext } from '../model/page-context.js';

/**
 * - EXECUTE : essayer `actionId` (elle passe quand même par la SafetyPolicy).
 * - BACKTRACK : plus rien d'intéressant ici ; revenir à un état précédent.
 * - STOP : terminer l'exploration.
 */
export interface ActionDecision {
  decision: 'EXECUTE' | 'BACKTRACK' | 'STOP';
  actionId?: string;
  reason: string;
}

/**
 * « Que dois-je essayer ensuite ? »
 *
 * Ne reçoit que des données simples (le PageContext et le FlowGraph construit
 * jusqu'ici) et renvoie une décision. Il ne touche jamais Playwright et ne peut
 * pas contourner la SafetyPolicy, que le FlowExplorer applique à chaque action choisie.
 *
 * Implémentations : RuleBasedDecisionEngine (déterministe, cette version).
 * D'autres moteurs peuvent implémenter la même interface sans rien changer à
 * l'explorateur, à l'exécuteur ni à la politique de sécurité.
 */
export interface DecisionEngine {
  readonly name: string;
  decide(context: PageContext, graph: FlowGraph): Promise<ActionDecision>;
}
