import type { ScenarioConfig } from '../config/config.js';
import type { StopReason } from '../model/exploration-result.js';

/** Le budget central du run : toutes les stratégies le respectent. */
export interface ExplorationBudget {
  maxStates: number;
  maxActions: number;
  maxMutations: number;
  maxValidationCases: number;
  maxPropertyCases: number;
  maxDurationMs: number;
}

export type BudgetKind = 'states' | 'actions' | 'mutations' | 'validationCases' | 'propertyCases';

/**
 * Tient les compteurs du budget. `exhausted()` dit si l'exploration doit s'arrêter
 * (états, actions, durée) ; `allows(kind)` si un travail secondaire (cas de
 * validation, cas de propriété, mutations) peut encore être fait.
 */
export class BudgetTracker {
  private readonly used: Record<BudgetKind, number> = {
    states: 0,
    actions: 0,
    mutations: 0,
    validationCases: 0,
    propertyCases: 0,
  };

  constructor(
    readonly budget: ExplorationBudget,
    private readonly startedAt = Date.now(),
    private readonly now: () => number = Date.now,
  ) {}

  consume(kind: BudgetKind, count = 1): void {
    this.used[kind] += count;
  }

  /** Fixe un compteur à une valeur observée (nombre d'états du graphe…). */
  set(kind: BudgetKind, value: number): void {
    this.used[kind] = value;
  }

  remaining(kind: BudgetKind): number {
    return Math.max(0, this.limitOf(kind) - this.used[kind]);
  }

  allows(kind: BudgetKind, count = 1): boolean {
    return this.remaining(kind) >= count;
  }

  exhausted(): StopReason | undefined {
    if (this.used.states >= this.budget.maxStates) return 'max-states';
    if (this.used.actions >= this.budget.maxActions) return 'max-actions';
    if (this.now() - this.startedAt >= this.budget.maxDurationMs) return 'max-duration';
    return undefined;
  }

  usage(): Record<BudgetKind, { used: number; max: number }> {
    return Object.fromEntries(
      (Object.keys(this.used) as BudgetKind[]).map((kind) => [
        kind,
        { used: this.used[kind], max: this.limitOf(kind) },
      ]),
    ) as Record<BudgetKind, { used: number; max: number }>;
  }

  private limitOf(kind: BudgetKind): number {
    switch (kind) {
      case 'states':
        return this.budget.maxStates;
      case 'actions':
        return this.budget.maxActions;
      case 'mutations':
        return this.budget.maxMutations;
      case 'validationCases':
        return this.budget.maxValidationCases;
      case 'propertyCases':
        return this.budget.maxPropertyCases;
    }
  }
}

/** Le budget de la mission, depuis sa configuration. */
export function budgetOf(config: ScenarioConfig): ExplorationBudget {
  return {
    maxStates: config.exploration.maxStates,
    maxActions: config.exploration.maxActions,
    maxMutations: config.safety.mutations.enabled ? config.safety.mutations.maxPerRun : 0,
    maxValidationCases: config.forms.validationTesting ? config.forms.maxValidationCasesPerRun : 0,
    maxPropertyCases: config.propertyTesting.enabled ? config.propertyTesting.maxCasesPerRun : 0,
    maxDurationMs: config.exploration.maxDurationMinutes * 60_000,
  };
}
