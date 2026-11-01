import type {
  AiContradiction,
  AiStopReason,
  GeneratedExperiment,
  InvestigationStrategy,
} from '../../../sdk/core/incident-ai-contracts.js';

/**
 * LA POLITIQUE D'ARRÊT DE L'INVESTIGATION APPROFONDIE.
 *
 * On continue tant que (une stratégie DISPONIBLE promet un gain d'information au-dessus du seuil OU une
 * contradiction ouverte dispose d'une vérification décisive encore exécutable) ET qu'il reste du budget ET que
 * personne n'a annulé ni mis en pause. On ne s'arrête JAMAIS parce qu'un score est élevé ou qu'un agent « a
 * trouvé » : seul le validateur déterministe confirme, et après une confirmation la boucle poursuit sur les
 * causes contributives et les contradictions tant que le budget le permet. Fonction pure : l'orchestrateur lui
 * donne l'état, elle rend la décision et sa raison.
 */
export type DeepStopReason = AiStopReason | 'STRATEGIES_EXHAUSTED' | 'DETERMINISTIC_CONFIRMED' | 'PAUSED';

/** Le gain d'information minimal (0 à 1) pour qu'une stratégie vaille encore un passage. */
export const DEFAULT_GAIN_THRESHOLD = 0.15;

export interface StoppingState {
  strategies: readonly InvestigationStrategy[];
  contradictions: readonly AiContradiction[];
  experiments: readonly GeneratedExperiment[];
  /** Les hypothèses que le validateur DÉTERMINISTE a confirmées (`Hypothesis.status === 'CONFIRMED'`), jamais l'avis d'un agent. */
  confirmedHypothesisIds: readonly string[];
  /** Ce que le suivi de budget rend (`exceeded()`) : TIMEOUT, BUDGET_EXHAUSTED, ou rien. */
  budgetExceeded: AiStopReason | undefined;
  cancelled: boolean;
  paused: boolean;
  /** Le seuil de gain ; `DEFAULT_GAIN_THRESHOLD` à défaut. */
  gainThreshold?: number;
  /** Une vérification générée est-elle encore exécutable ? Par défaut : statut PROPOSED. */
  isRunnable?: (experiment: GeneratedExperiment) => boolean;
}

export interface StoppingDecision {
  continue: boolean;
  reason?: DeepStopReason;
  /** Pourquoi, lisible (limites du run, mémoire). */
  detail: string;
  /** Les stratégies qui justifient de continuer (ids), triées comme reçues. */
  usefulStrategyIds: string[];
  /** Les contradictions ouvertes dont la vérification décisive est exécutable (ids). */
  decisiveContradictionIds: string[];
}

/** Le seuil effectif : un nombre entre 0 et 1, sinon le défaut. */
export function gainThreshold(state: Pick<StoppingState, 'gainThreshold'>): number {
  const value = state.gainThreshold;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_GAIN_THRESHOLD;
}

/**
 * Après une confirmation déterministe, seules continuent les stratégies qui cherchent une cause contributive
 * (une autre hypothèse que celles confirmées), une explication alternative, ou qui contestent (chasse aux
 * contradictions).
 */
export function postConfirmationStrategy(
  strategy: InvestigationStrategy,
  confirmedHypothesisIds: readonly string[],
): boolean {
  if (strategy.category === 'ALTERNATIVE') return true;
  if (strategy.via.agent === 'CONTRADICTION_HUNTER') return true;
  return strategy.hypothesisIds.some((id) => !confirmedHypothesisIds.includes(id));
}

const defaultRunnable = (experiment: GeneratedExperiment): boolean => experiment.status === 'PROPOSED';

/** Les stratégies disponibles qui valent encore un passage (gain au-dessus du seuil ; contributives seulement après confirmation). */
export function usefulStrategies(state: StoppingState): InvestigationStrategy[] {
  const threshold = gainThreshold(state);
  const confirmed = state.confirmedHypothesisIds.length > 0;
  return state.strategies.filter(
    (strategy) =>
      strategy.status === 'AVAILABLE' &&
      strategy.expectedInformationGain > threshold &&
      (!confirmed || postConfirmationStrategy(strategy, state.confirmedHypothesisIds)),
  );
}

/** Les contradictions ouvertes dont la vérification décisive existe et est encore exécutable. */
export function decisiveContradictions(state: StoppingState): AiContradiction[] {
  const runnable = state.isRunnable ?? defaultRunnable;
  return state.contradictions.filter((contradiction) => {
    if (contradiction.status !== 'OPEN' || contradiction.proposalId === undefined) return false;
    const experiment = state.experiments.find((candidate) => candidate.id === contradiction.proposalId);
    return experiment !== undefined && runnable(experiment);
  });
}

export function shouldContinue(state: StoppingState): StoppingDecision {
  const stop = (reason: DeepStopReason, detail: string): StoppingDecision => ({
    continue: false,
    reason,
    detail,
    usefulStrategyIds: [],
    decisiveContradictionIds: [],
  });
  if (state.cancelled)
    return stop('CANCELLED', 'Investigation annulée : les résultats acquis sont conservés.');
  if (state.paused)
    return stop('PAUSED', 'Investigation mise en pause : reprise possible depuis le point de reprise.');
  if (state.budgetExceeded !== undefined)
    return stop(
      state.budgetExceeded,
      state.budgetExceeded === 'TIMEOUT' ? 'Durée maximale atteinte.' : 'Budget épuisé.',
    );

  const useful = usefulStrategies(state);
  const decisive = decisiveContradictions(state);
  if (useful.length > 0 || decisive.length > 0) {
    const parts: string[] = [];
    if (useful.length > 0) parts.push(`${String(useful.length)} stratégie(s) au-dessus du seuil de gain`);
    if (decisive.length > 0)
      parts.push(`${String(decisive.length)} contradiction(s) ouverte(s) avec vérification décisive`);
    return {
      continue: true,
      detail: parts.join(' ; '),
      usefulStrategyIds: useful.map((strategy) => strategy.id),
      decisiveContradictionIds: decisive.map((contradiction) => contradiction.id),
    };
  }

  const confirmed = state.confirmedHypothesisIds.length > 0;
  if (confirmed)
    return stop(
      'DETERMINISTIC_CONFIRMED',
      `Cause confirmée par le validateur déterministe (${state.confirmedHypothesisIds.join(', ')}) ; aucune stratégie contributive ni contradiction à poursuivre.`,
    );
  const available = state.strategies.filter((strategy) => strategy.status === 'AVAILABLE');
  if (available.length > 0)
    return stop(
      'NO_USEFUL_VERIFICATION',
      `${String(available.length)} stratégie(s) encore disponible(s) mais sous le seuil de gain (${String(gainThreshold(state))}).`,
    );
  const open = state.contradictions.filter((contradiction) => contradiction.status === 'OPEN').length;
  return stop(
    'STRATEGIES_EXHAUSTED',
    open > 0
      ? `Aucune stratégie disponible ; ${String(open)} contradiction(s) restent ouvertes sans vérification exécutable.`
      : 'Aucune stratégie disponible ni contradiction ouverte.',
  );
}
