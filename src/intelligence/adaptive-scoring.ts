import type { AdvancedActionScorer, ScoredActionV2 } from '../decision/advanced-action-scorer.js';
import type { ActionScorer, ScoringMission } from '../decision/action-scorer.js';
import { breakdownOf, type ScoreReason } from '../decision/score-breakdown.js';
import type { CoverageTracker } from '../coverage/coverage-map.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { KnowledgeBase } from '../knowledge/knowledge-model.js';
import { actionSignature, stateSignature } from '../knowledge/signatures.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { sampleConfidence } from './confidence-engine.js';
import type { AgingOptions } from './knowledge-aging.js';
import { noveltyScore, type NoveltyResult } from './novelty-score.js';
import { stabilityScore, type StabilityOptions, type StabilityResult } from './stability-score.js';

export interface AdaptiveWeights {
  /** Poids de l'ajustement « succès historique × confiance ». */
  confidenceWeight: number;
  noveltyWeight: number;
  stabilityWeight: number;
}

export interface AdaptiveScoringOptions {
  /**
   * Un historique d'anciens runs est-il disponible ? false (memory.enabled: false, ou
   * aucune base de connaissances) : l'impact historique est NUL, le score est celui d'avant.
   */
  historyAvailable: boolean;
  weights: AdaptiveWeights;
  sampleHalfPoint: number;
  novelty: { enabled: boolean; aging?: AgingOptions };
  stability: { enabled: boolean } & StabilityOptions;
  knowledge: KnowledgeBase;
  coverage?: CoverageTracker;
  now?: () => string;
}

/** Bornes de l'ajustement adaptatif : il nuance le score, il ne le renverse jamais. */
export const ADAPTIVE_BOUNDS = { min: -60, max: 30 } as const;

/** Les signaux calculés pour une action (pour le rapport et les tests). */
export interface AdaptiveSignals {
  novelty?: NoveltyResult;
  stability?: StabilityResult;
  confidence: number;
  observations: number;
}

/**
 * ADAPTIVE SCORING : l'ActionScorer V2, nuancé par la qualité de l'historique.
 *
 * - le succès historique ne compte qu'à hauteur de la confiance de l'échantillon
 *   (2 succès ne valent pas 200) ;
 * - une action peu explorée dans les runs précédents (NoveltyScore) gagne un peu ;
 * - une action instable (StabilityScore : échecs, destinations changeantes, durées très
 *   variables), avec une confiance suffisante, perd un peu.
 *
 * Toujours un facteur « adaptive » expliqué, borné, et jamais d'effet sur les exclusions :
 * une action exclue (SafetyPolicy, déjà essayée, motif BLOCK) le reste. Sans historique,
 * aucune modification.
 */
export class AdaptiveActionScorer implements ActionScorer {
  constructor(
    private readonly inner: AdvancedActionScorer,
    private readonly options: AdaptiveScoringOptions,
  ) {}

  score(
    action: DiscoveredAction,
    context: PageContext,
    graph: FlowGraph,
    mission: ScoringMission,
  ): ScoredActionV2 {
    const scored = this.inner.score(action, context, graph, mission);
    if (scored.excluded !== undefined || !this.options.historyAvailable) return scored;
    const adaptive = this.adjustments(action, context, scored);
    if (adaptive.length === 0) return scored;
    const breakdown = breakdownOf([...scored.breakdown.details, ...adaptive]);
    return { ...scored, score: breakdown.total, reasons: breakdown.reasons, breakdown };
  }

  /** Les signaux d'une action : nouveauté, stabilité, confiance de son historique. */
  signalsOf(action: DiscoveredAction, context: PageContext): AdaptiveSignals {
    const { knowledge, coverage } = this.options;
    const signature = actionSignature(action);
    const history = knowledge.getActionKnowledge(signature);
    const transition = knowledge.getTransitionKnowledge(stateSignature(context.stateLabel), signature);
    const executions = history?.executionCount ?? transition?.executionCount ?? 0;
    const usedThisRun = coverage?.timesExecuted(signature) ?? 0;
    const novelty = this.options.novelty.enabled
      ? noveltyScore(
          {
            executions,
            usedThisRun,
            ...(history?.lastExecutedAt ? { lastExecutedAt: history.lastExecutedAt } : {}),
          },
          {
            sampleHalfPoint: this.options.sampleHalfPoint,
            ...(this.options.novelty.aging ? { aging: this.options.novelty.aging } : {}),
            ...(this.options.now ? { now: this.options.now } : {}),
          },
        )
      : undefined;
    const outcome =
      transition && transition.executionCount > 0
        ? { successes: transition.successCount, failures: transition.failureCount }
        : { successes: history?.successCount ?? 0, failures: history?.failureCount ?? 0 };
    const durations = knowledge.getPerformance('action', signature)?.durations;
    const stability = this.options.stability.enabled
      ? stabilityScore(
          {
            ...outcome,
            ...(transition ? { targets: transition.targets } : {}),
            ...(durations ? { durations } : {}),
          },
          this.options.stability,
        )
      : undefined;
    return {
      ...(novelty ? { novelty } : {}),
      ...(stability ? { stability } : {}),
      confidence: round(sampleConfidence(executions, this.options.sampleHalfPoint)),
      observations: executions,
    };
  }

  private adjustments(action: DiscoveredAction, context: PageContext, scored: ScoredActionV2): ScoreReason[] {
    const { weights } = this.options;
    const signals = this.signalsOf(action, context);
    const reasons: ScoreReason[] = [];
    const add = (reason: ScoreReason): void => {
      const points = Math.round(reason.points);
      if (points !== 0) reasons.push({ ...reason, points });
    };

    // Succès historique pondéré par la confiance de l'échantillon.
    const historical = scored.breakdown.details
      .filter((reason) => reason.code === 'historical-success')
      .reduce((sum, reason) => sum + reason.points, 0);
    if (historical > 0 && signals.confidence < 1)
      add({
        factor: 'adaptive',
        points: -historical * (1 - signals.confidence) * weights.confidenceWeight,
        code: 'history-confidence',
        params: { confidence: signals.confidence, observations: signals.observations },
      });

    // Peu explorée dans les runs précédents (les jamais explorées ont déjà leur bonus).
    const novelty = signals.novelty;
    if (novelty && novelty.level === 'RARE')
      add({
        factor: 'adaptive',
        points: weights.noveltyWeight * 25 * novelty.score,
        code: 'rarely-explored',
        params: { novelty: novelty.score, detail: novelty.reasons.join(', ') },
      });

    // Instable, avec assez d'observations pour le dire.
    const stability = signals.stability;
    if (stability && stability.level === 'UNSTABLE')
      add({
        factor: 'adaptive',
        points: -weights.stabilityWeight * 40 * (1 - stability.score) * stability.confidence,
        code: 'unstable-history',
        params: {
          stability: stability.score,
          confidence: stability.confidence,
          detail: stability.factors
            .filter((factor) => factor.value !== undefined && factor.value < 1)
            .map((factor) => `${factor.factor} ${factor.detail}`)
            .join(', '),
        },
      });

    return bounded(reasons);
  }
}

/** Ramène la somme des ajustements dans ADAPTIVE_BOUNDS, proportionnellement. */
function bounded(reasons: ScoreReason[]): ScoreReason[] {
  const total = reasons.reduce((sum, reason) => sum + reason.points, 0);
  const limit =
    total < ADAPTIVE_BOUNDS.min
      ? ADAPTIVE_BOUNDS.min
      : total > ADAPTIVE_BOUNDS.max
        ? ADAPTIVE_BOUNDS.max
        : total;
  if (limit === total || total === 0) return reasons;
  const ratio = limit / total;
  return reasons
    .map((reason) => ({ ...reason, points: Math.round(reason.points * ratio) }))
    .filter((reason) => reason.points !== 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
