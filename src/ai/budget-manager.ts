export interface IntelligenceBudgets {
  maxCallsPerRun: number;
  maxCallsPerAction: number;
  maxCallsPerDivergence: number;
  maxToolCallsPerRequest: number;
  maxReasoningDurationMs: number;
}

/** Où un appel est compté : une action (écran + action), une divergence (étape d'un flow). */
export interface CallScope {
  action?: string;
  divergence?: string;
}

export interface BudgetUsage {
  calls: number;
  toolCalls: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  timeouts: number;
  inputTokens: number;
  outputTokens: number;
  exhausted: number;
}

/**
 * INTELLIGENCE BUDGET MANAGER (§58) : chaque appel est compté (par run, par action, par
 * divergence) et mesuré (latence, outils, jetons si le fournisseur les donne). Budget épuisé ≠
 * impossible : la décision revient au déterministe.
 */
export class IntelligenceBudgetManager {
  private readonly perAction = new Map<string, number>();
  private readonly perDivergence = new Map<string, number>();
  readonly usage: BudgetUsage = {
    calls: 0,
    toolCalls: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    timeouts: 0,
    inputTokens: 0,
    outputTokens: 0,
    exhausted: 0,
  };

  constructor(readonly budgets: IntelligenceBudgets) {}

  /** undefined : l'appel est permis ; sinon la limite atteinte. */
  check(scope: CallScope): string | undefined {
    let reason: string | undefined;
    if (this.usage.calls >= this.budgets.maxCallsPerRun)
      reason = `maxCallsPerRun ${String(this.budgets.maxCallsPerRun)}`;
    else if (scope.action && (this.perAction.get(scope.action) ?? 0) >= this.budgets.maxCallsPerAction)
      reason = `maxCallsPerAction ${String(this.budgets.maxCallsPerAction)}`;
    else if (
      scope.divergence &&
      (this.perDivergence.get(scope.divergence) ?? 0) >= this.budgets.maxCallsPerDivergence
    )
      reason = `maxCallsPerDivergence ${String(this.budgets.maxCallsPerDivergence)}`;
    if (reason) this.usage.exhausted += 1;
    return reason;
  }

  begin(scope: CallScope): void {
    this.usage.calls += 1;
    if (scope.action) this.perAction.set(scope.action, (this.perAction.get(scope.action) ?? 0) + 1);
    if (scope.divergence)
      this.perDivergence.set(scope.divergence, (this.perDivergence.get(scope.divergence) ?? 0) + 1);
  }

  end(input: {
    latencyMs: number;
    toolCalls?: number;
    timeout?: boolean;
    usage?: { inputTokens?: number; outputTokens?: number };
  }): void {
    this.usage.totalLatencyMs += input.latencyMs;
    this.usage.maxLatencyMs = Math.max(this.usage.maxLatencyMs, input.latencyMs);
    this.usage.toolCalls += input.toolCalls ?? 0;
    if (input.timeout) this.usage.timeouts += 1;
    this.usage.inputTokens += input.usage?.inputTokens ?? 0;
    this.usage.outputTokens += input.usage?.outputTokens ?? 0;
  }

  averageLatencyMs(): number {
    return this.usage.calls === 0 ? 0 : Math.round(this.usage.totalLatencyMs / this.usage.calls);
  }
}
