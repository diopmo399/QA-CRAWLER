import type { DiscoveredAction, DiscoveredForm } from '../model/discovered-action.js';

/**
 * Everything a decision engine may look at to choose the next in-page action.
 * Serializable on purpose: a future LLM-based engine can receive it as-is.
 */
export interface PageContext {
  url: string;
  route: string;
  depth: number;
  title?: string;
  actions: readonly DiscoveredAction[];
  forms: readonly DiscoveredForm[];
  /** Keys (see actionKey) of actions already executed on this page. */
  executedActions: ReadonlySet<string>;
  /** Actions the engine may still execute on this page. */
  remainingBudget: number;
}

export type Decision =
  { kind: 'click'; action: DiscoveredAction; rationale: string } | { kind: 'stop'; rationale: string };

/**
 * Chooses what to do next on a page. The crawl engine still enforces the
 * SafetyPolicy on every decision, whatever the engine: an engine can only
 * pick among actions the policy allows.
 *
 * Implementations: RuleBasedDecisionEngine (deterministic, this version).
 * Planned: LocalLLMDecisionEngine, CloudLLMDecisionEngine.
 */
export interface DecisionEngine {
  readonly name: string;
  nextAction(context: PageContext): Promise<Decision>;
}

/** Stable identity of an action within a page. */
export function actionKey(action: DiscoveredAction): string {
  return `${action.index}|${action.type}|${action.text}`;
}
