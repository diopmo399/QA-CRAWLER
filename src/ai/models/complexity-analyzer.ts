import type { IntelligenceRequest } from '../model.js';
import type { ComplexityLevel } from './model-types.js';

/** Des signaux du moteur cognitif qui ne sont pas (tous) dans la requête envoyée. */
export interface ComplexitySignals {
  /** Tentatives de récupération déjà faites (GoalBasedRecovery). */
  recoveryAttempts?: number;
  /** Plans ou candidats de récupération plausibles (PlanEngine, RecoveryPlanner). */
  plausiblePlans?: number;
  /** Catégorie de divergence (DivergenceAnalyzer). */
  divergence?: string;
}

export interface ComplexityAssessment {
  level: ComplexityLevel;
  score: number;
  reasons: string[];
}

const HARD = new Set(['FLOW_DIVERGENCE', 'RECOVERY_EXHAUSTED']);

/**
 * REASONING COMPLEXITY ANALYZER : la difficulté du raisonnement demandé, à partir de ce que
 * QA-Crawler sait DÉJÀ (confiance déterministe, actions plausibles, hypothèses concurrentes,
 * contradictions, divergence, plans, tentatives, état métier, but, échec, preuves). Il
 * n'appelle jamais un LLM ; chaque point de difficulté est une raison lisible.
 *
 *   TRIVIAL (aucun LLM) < LOW < MEDIUM < HIGH < VERY_HIGH
 */
export class ReasoningComplexityAnalyzer {
  analyze(request: IntelligenceRequest, signals: ComplexitySignals = {}): ComplexityAssessment {
    const reasons: string[] = [];
    let score = 0;
    const add = (points: number, reason: string) => {
      score += points;
      reasons.push(reason);
    };
    const confidence = request.deterministic?.confidence ?? 0;
    const plausible = request.availableActions.filter(
      (action) => action.allowed && action.safety === 'SAFE' && !action.disabled,
    );
    const open = request.hypotheses.filter(
      (hypothesis) => hypothesis.status === 'HYPOTHESIS' || hypothesis.status === 'SUPPORTED',
    );
    const divergence = HARD.has(request.trigger) || signals.divergence !== undefined;

    // TRIVIAL : but connu, une seule action plausible, confiance très haute, rien qui diverge.
    if (
      confidence >= 0.9 &&
      plausible.length <= 1 &&
      request.goal &&
      !divergence &&
      request.contradictions.length === 0 &&
      request.trigger !== 'UNKNOWN_BUSINESS_ERROR'
    )
      return {
        level: 'TRIVIAL',
        score: 0,
        reasons: [`deterministic confidence ${confidence.toFixed(2)}, one plausible action, known goal`],
      };

    add(2 * (1 - confidence), `deterministic confidence ${confidence.toFixed(2)}`);
    if (plausible.length >= 3) add(1.5, `${String(plausible.length)} plausible actions`);
    else if (plausible.length === 2) add(0.75, '2 plausible actions');
    if (open.length >= 2) {
      add(0.5, `${String(open.length)} open hypotheses`);
      const sorted = [...open].sort((a, b) => b.confidence - a.confidence);
      if (sorted[0] && sorted[1] && sorted[0].confidence - sorted[1].confidence < 0.1)
        add(
          0.5,
          `competing hypotheses (${sorted[0].confidence.toFixed(2)} vs ${sorted[1].confidence.toFixed(2)})`,
        );
    }
    if (request.contradictions.length > 0)
      add(1.5, `${String(request.contradictions.length)} knowledge contradiction(s)`);
    if (divergence) add(1.5, `workflow divergence${signals.divergence ? ` (${signals.divergence})` : ''}`);
    if ((signals.plausiblePlans ?? 0) >= 3) add(1.5, `${String(signals.plausiblePlans)} plausible plans`);
    else if ((signals.plausiblePlans ?? 0) === 2) add(1, '2 plausible plans');
    if ((signals.recoveryAttempts ?? 0) >= 3) add(1, `${String(signals.recoveryAttempts)} recovery attempts`);
    else if ((signals.recoveryAttempts ?? 0) >= 1)
      add(0.5, `${String(signals.recoveryAttempts)} recovery attempt(s)`);
    if (!request.businessState?.phase) add(0.5, 'unknown business state');
    if (!request.goal) add(0.5, 'ambiguous goal');
    else if (request.goal.conditions.length >= 2)
      add(0.5, `${String(request.goal.conditions.length)} unmet preconditions`);
    if (request.trigger === 'UNKNOWN_BUSINESS_ERROR' || request.failure) add(1, 'unclassified failure');
    if (request.relevantEvidence.length === 0) add(0.5, 'no relevant evidence');

    const rounded = Math.round(score * 100) / 100;
    const level: ComplexityLevel =
      rounded < 1.5 ? 'LOW' : rounded < 3.5 ? 'MEDIUM' : rounded < 5.5 ? 'HIGH' : 'VERY_HIGH';
    return { level, score: rounded, reasons };
  }
}
