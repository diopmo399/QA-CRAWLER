import type { AiBudget, AiStopReason, AiUsage } from '../../sdk/core/incident-ai-contracts.js';

/**
 * LE SUIVI DU BUDGET D'UN RUN IA : chaque unité consommée (tour, appel de modèle, appel d'outil, jeton, coût,
 * fichier, commande, vérification) est portée au compte ; la durée se mesure depuis la création. Rien n'est
 * décidé ici : la boucle et l'orchestrateur demandent `allows()` avant d'engager une dépense et `exceeded()`
 * pour savoir s'il reste quelque chose à dépenser. Un plafond de coût à 0 signifie « pas de plafond ».
 */

/** Ce qui se compte, au singulier : `charge('modelCall')`. */
export type BudgetChargeKind =
  | 'iteration'
  | 'modelCall'
  | 'toolCall'
  | 'inputTokens'
  | 'outputTokens'
  | 'cost'
  | 'file'
  | 'command'
  | 'experiment';

const USAGE_FIELD: Record<BudgetChargeKind, Exclude<keyof AiUsage, 'durationMs'>> = {
  iteration: 'iterations',
  modelCall: 'modelCalls',
  toolCall: 'toolCalls',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  cost: 'estimatedCost',
  file: 'files',
  command: 'commands',
  experiment: 'experiments',
};

const BUDGET_FIELD: Record<BudgetChargeKind, keyof AiBudget> = {
  iteration: 'maxIterations',
  modelCall: 'maxModelCalls',
  toolCall: 'maxToolCalls',
  inputTokens: 'maxInputTokens',
  outputTokens: 'maxOutputTokens',
  cost: 'maxCost',
  file: 'maxFiles',
  command: 'maxCommands',
  experiment: 'maxExperiments',
};

/** L'ordre dans lequel les épuisements sont rapportés (le plus structurant d'abord). */
const CHECK_ORDER: readonly BudgetChargeKind[] = [
  'modelCall',
  'toolCall',
  'inputTokens',
  'outputTokens',
  'cost',
  'iteration',
  'file',
  'command',
  'experiment',
];

export interface BudgetTracker {
  readonly budget: AiBudget;
  /** La consommation à cet instant (une copie ; `durationMs` est recalculée). */
  readonly usage: AiUsage;
  /** Porte `n` unités au compte (sans refuser : la vérification se fait avant, avec `allows`). */
  charge(kind: BudgetChargeKind, n?: number): void;
  /** Peut-on encore dépenser `n` unités de ce genre sans dépasser le plafond ? */
  allows(kind: BudgetChargeKind, n?: number): boolean;
  /** Ce qu'il reste à dépenser ; `Infinity` pour un coût sans plafond. */
  remaining(kind: BudgetChargeKind): number;
  /** Le temps restant avant `maxDurationMs` (0 quand il est écoulé). */
  remainingMs(): number;
  elapsedMs(): number;
  /**
   * La raison d'arrêt quand plus rien ne peut être dépensé : TIMEOUT si la durée est écoulée, BUDGET_EXHAUSTED
   * si un compteur est à son plafond ; `undefined` tant qu'il reste de la marge partout.
   */
  exceeded(): AiStopReason | undefined;
  /** Le genre épuisé (lisible dans les limites du run). */
  exhausted(): BudgetChargeKind | 'duration' | undefined;
}

export function emptyUsage(): AiUsage {
  return {
    iterations: 0,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    durationMs: 0,
    files: 0,
    commands: 0,
    experiments: 0,
  };
}

/** La somme de deux consommations (la durée est la plus grande des deux : des durées ne s'additionnent pas). */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    iterations: a.iterations + b.iterations,
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimatedCost: round(a.estimatedCost + b.estimatedCost),
    durationMs: Math.max(a.durationMs, b.durationMs),
    files: a.files + b.files,
    commands: a.commands + b.commands,
    experiments: a.experiments + b.experiments,
  };
}

/** Un budget borné et sain : entiers positifs ou nuls, durée d'au moins 1 ms. */
export function normalizeBudget(budget: AiBudget): AiBudget {
  const whole = (value: number, fallback: number): number =>
    Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  return {
    maxIterations: whole(budget.maxIterations, 1),
    maxModelCalls: whole(budget.maxModelCalls, 0),
    maxToolCalls: whole(budget.maxToolCalls, 0),
    maxInputTokens: whole(budget.maxInputTokens, 0),
    maxOutputTokens: whole(budget.maxOutputTokens, 0),
    maxCost: Number.isFinite(budget.maxCost) && budget.maxCost > 0 ? budget.maxCost : 0,
    maxDurationMs: Math.max(1, whole(budget.maxDurationMs, 1)),
    maxFiles: whole(budget.maxFiles, 0),
    maxCommands: whole(budget.maxCommands, 0),
    maxExperiments: whole(budget.maxExperiments, 0),
  };
}

export function createBudgetTracker(budget: AiBudget, options: { now?: () => number } = {}): BudgetTracker {
  const limits = normalizeBudget(budget);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const counters = emptyUsage();
  const elapsedMs = (): number => Math.max(0, now() - startedAt);
  const limitOf = (kind: BudgetChargeKind): number => {
    const value = limits[BUDGET_FIELD[kind]];
    return kind === 'cost' && value === 0 ? Number.POSITIVE_INFINITY : value;
  };
  const remaining = (kind: BudgetChargeKind): number =>
    Math.max(0, limitOf(kind) - counters[USAGE_FIELD[kind]]);
  const exhausted = (): BudgetChargeKind | 'duration' | undefined => {
    if (elapsedMs() >= limits.maxDurationMs) return 'duration';
    // Une limite à zéro interdit (allows() rend faux) sans être « épuisée » : rien n'a été consommé.
    return CHECK_ORDER.find((kind) => limitOf(kind) > 0 && remaining(kind) <= 0);
  };
  return {
    budget: limits,
    get usage(): AiUsage {
      return { ...counters, durationMs: elapsedMs() };
    },
    charge(kind, n = 1) {
      if (!Number.isFinite(n) || n <= 0) return;
      const field = USAGE_FIELD[kind];
      counters[field] = kind === 'cost' ? round(counters[field] + n) : counters[field] + n;
    },
    allows(kind, n = 1) {
      if (elapsedMs() >= limits.maxDurationMs) return false;
      return remaining(kind) >= n;
    },
    remaining,
    remainingMs: () => Math.max(0, limits.maxDurationMs - elapsedMs()),
    elapsedMs,
    exceeded() {
      const kind = exhausted();
      if (kind === undefined) return undefined;
      return kind === 'duration' ? 'TIMEOUT' : 'BUDGET_EXHAUSTED';
    },
    exhausted,
  };
}

/** Un coût arrondi à la millième d'unité : jamais de bruit flottant dans le fichier d'incident. */
function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
