import type { FlowStep } from '../config/flow-schema.js';
import type { ActionCategory, ActionClassification, ActionType } from '../model/discovered-action.js';
import type { FlowIntent, FlowIntentType } from './flow-intent-graph.js';

/**
 * EXPECTED / OBSERVED / SUGGESTED : trois modèles toujours séparés.
 * - EXPECTED : le FlowIntentGraph du développeur (jamais modifié).
 * - OBSERVED : ce que l'application a réellement montré pendant le Dry Run.
 * - SUGGESTED : la proposition, construite à la fin, avec la provenance de chaque étape.
 */

export const RECONCILIATION_STATUSES = [
  'MATCHED',
  'INSERTED',
  'MISSING',
  'REORDERED',
  'ALTERNATIVE',
  'AMBIGUOUS',
  'UNREACHABLE',
  'POSSIBLY_OBSOLETE',
  'ASSERTION_MISMATCH',
  'BLOCKED_BY_POLICY',
  'NOT_VERIFIED',
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const DRY_RUN_STATUSES = [
  'FULLY_MATCHED',
  'PARTIALLY_MATCHED',
  'DIVERGED',
  'BLOCKED',
  'INCONCLUSIVE',
] as const;
export type DryRunStatus = (typeof DRY_RUN_STATUSES)[number];

/** D'où vient une étape du flow suggéré. */
export type Provenance = 'ORIGINAL' | 'OBSERVED' | 'HISTORICAL_CONFIRMED';

/** Pourquoi l'analyse s'est arrêtée. */
export type DryRunStopReason = 'COMPLETED' | 'EXPLORATION_BUDGET_EXHAUSTED' | 'START_FAILED';

// ------------------------------------------------------------------ OBSERVED

export interface ObservedState {
  id: string;
  /** Signature stable d'un run à l'autre (knowledge/signatures). */
  signature: string;
  label: string;
  url: string;
}

/** Une action de l'écran, telle que le Dry Run la voit (déjà passée par la SafetyPolicy). */
export interface ObservedActionRef {
  id: string;
  signature: string;
  label: string;
  type: ActionType;
  category: ActionCategory;
  classification: ActionClassification;
  role?: string;
  href?: string;
}

export interface ObservedStep {
  id: string;
  /** INTENT : une étape du scénario exécutée ; GUIDED : une action trouvée par l'exploration guidée. */
  origin: 'INTENT' | 'GUIDED';
  /** L'intention attendue que cette étape a satisfaite (étapes INTENT). */
  intentId?: string;
  type: FlowIntentType;
  label: string;
  semanticTarget: string;
  action?: ObservedActionRef;
  /** Champs remplis (données de test) avant un clic dans un formulaire ; libellés seulement. */
  formFields?: string[];
  from: string;
  to: string;
  status: 'PASSED' | 'FAILED';
  provenance: 'OBSERVED' | 'HISTORICAL_CONFIRMED';
  /** Chemins de remplacement vus pour le même passage (autres premiers pas). */
  alternatives?: string[][];
  reasons: string[];
  /** L'étape exécutable (celle d'origine, ou dérivée de l'action observée). */
  step?: FlowStep;
}

export interface ObservedFlowGraph {
  flow: string;
  states: ObservedState[];
  steps: ObservedStep[];
  stopReason: DryRunStopReason;
  budget: DryRunBudgetUsage;
}

export interface DryRunBudgetUsage {
  actions: number;
  maxActions: number;
  durationMs: number;
  maxDurationMs: number;
  exhausted?: 'maxActions' | 'maxDurationMs';
}

// ------------------------------------------------------------------ constats du moteur

/** Ce que le Dry Run a constaté pour une intention attendue (avant l'alignement). */
export interface IntentFinding {
  intentId: string;
  outcome:
    'MATCHED' | 'ASSERTION_MISMATCH' | 'AMBIGUOUS' | 'BLOCKED_BY_POLICY' | 'NOT_FOUND' | 'NOT_VERIFIED';
  observedStepId?: string;
  /** Trouvée après une intention qui la suit dans le scénario. */
  late?: boolean;
  /** La cible a été vue quelque part pendant le run (pas au bon endroit). */
  seenElsewhere?: boolean;
  /** Tout l'espace accessible (dans la profondeur permise) a été parcouru sans la trouver. */
  searchExhausted?: boolean;
  /** Vue lors de runs précédents (mémoire), combien de fois. */
  historicalObservations?: number;
  confidence: number;
  reasons: string[];
  evidence: string[];
}

// ------------------------------------------------------------------ RECONCILIATION

export interface ReconciliationEntry {
  status: ReconciliationStatus;
  expectedIntent?: Pick<FlowIntent, 'id' | 'index' | 'type' | 'label' | 'semanticTarget'> & {
    text: string;
    line?: number;
  };
  observedTarget?: { stepId: string; label: string; state: string; action?: string };
  confidence: number;
  reasons: string[];
  evidence: string[];
}

export interface ReconciliationSummary {
  originalIntents: number;
  matched: number;
  inserted: number;
  missing: number;
  reordered: number;
  alternative: number;
  ambiguous: number;
  unreachable: number;
  possiblyObsolete: number;
  assertionMismatch: number;
  blocked: number;
  notVerified: number;
}

export interface Reconciliation {
  flow: string;
  status: DryRunStatus;
  entries: ReconciliationEntry[];
  summary: ReconciliationSummary;
  stopReason: DryRunStopReason;
}

// ------------------------------------------------------------------ SUGGESTED

export interface SuggestedStep {
  provenance: Provenance;
  status: ReconciliationStatus;
  /** Étape exécutable ; absente pour une étape à revoir qui n'est gardée qu'en commentaire. */
  step?: FlowStep;
  /** Le texte d'origine (phrase Gherkin, étape YAML) pour une étape du scénario. */
  originalText?: string;
  label: string;
  /** Étape gardée pour revue, jamais supprimée automatiquement (POSSIBLY_OBSOLETE…). */
  review?: string;
  /** Champs à remplir avec des données de test avant cette étape. */
  fillFormBefore?: boolean;
}

export interface SuggestedFlowGraph {
  name: string;
  source: { type: 'GHERKIN' | 'YAML'; file?: string };
  startAt?: string;
  status: DryRunStatus;
  steps: SuggestedStep[];
}
