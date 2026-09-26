import type { FlowGraph } from '../graph/flow-graph.js';
import type { PageContext } from '../model/page-context.js';

/**
 * - EXECUTE: try `actionId` (it still goes through the SafetyPolicy).
 * - BACKTRACK: nothing more worth doing here; go back to a previous state.
 * - STOP: end the exploration.
 */
export interface ActionDecision {
  decision: 'EXECUTE' | 'BACKTRACK' | 'STOP';
  actionId?: string;
  reason: string;
}

/**
 * "What should I try next?"
 *
 * Receives only plain data (the PageContext and the FlowGraph built so far)
 * and returns a decision. It never touches Playwright and cannot bypass the
 * SafetyPolicy, which the FlowExplorer applies to every chosen action.
 *
 * Implementations: RuleBasedDecisionEngine (deterministic, this version).
 * Planned: LocalLLMDecisionEngine, CloudLLMDecisionEngine — same interface,
 * no change needed in the explorer, the executor or the safety policy.
 */
export interface DecisionEngine {
  readonly name: string;
  decide(context: PageContext, graph: FlowGraph): Promise<ActionDecision>;
}
