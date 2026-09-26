import type { SafetyPolicy } from '../policies/safety-policy.js';
import { actionKey, type Decision, type DecisionEngine, type PageContext } from './decision-engine.js';

/**
 * Deterministic engine: when `exploration.clickSafeActions` is enabled, it
 * clicks visible, enabled buttons/routerLink elements the SafetyPolicy
 * allows (SAFE by default), in document order, once each. Links are not
 * clicked: they are followed through the crawl queue.
 */
export class RuleBasedDecisionEngine implements DecisionEngine {
  readonly name = 'rule-based';

  constructor(
    private readonly safetyPolicy: SafetyPolicy,
    private readonly clickSafeActions: boolean,
  ) {}

  nextAction(context: PageContext): Promise<Decision> {
    if (!this.clickSafeActions) {
      return Promise.resolve({ kind: 'stop', rationale: 'clickSafeActions disabled' });
    }
    if (context.remainingBudget <= 0) {
      return Promise.resolve({ kind: 'stop', rationale: 'maxActionsPerPage reached' });
    }
    const candidate = context.actions.find(
      (action) =>
        (action.type === 'button' || action.type === 'router-link') &&
        action.visible &&
        !action.disabled &&
        this.safetyPolicy.isExecutionAllowed(action.classification) &&
        !context.executedActions.has(actionKey(action)),
    );
    return Promise.resolve(
      candidate
        ? { kind: 'click', action: candidate, rationale: `${candidate.classification}: ${candidate.reason}` }
        : { kind: 'stop', rationale: 'no remaining executable action' },
    );
  }
}
