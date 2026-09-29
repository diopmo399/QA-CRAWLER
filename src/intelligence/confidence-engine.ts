import type { TransitionKnowledge } from '../knowledge/knowledge-model.js';
import { ageInDays, DEFAULT_AGING, recencyWeight, type AgingOptions } from './knowledge-aging.js';
import { contextSimilarity, type KnowledgeContext } from './knowledge-context.js';

export const CONFIDENCE_LEVELS = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Une composante de la confiance, avec sa valeur et ce qui l'explique. */
export interface ConfidenceReason {
  factor: 'sample' | 'stability' | 'recency' | 'context';
  /** 0..1 */
  value: number;
  /** Texte court en anglais (« 17 observations », « actor admin ≠ user »). */
  detail: string;
}

export interface ConfidenceResult {
  /** 0 : aucune confiance ; 1 : confiance maximale (jamais atteinte : c'est de l'historique). */
  score: number;
  level: ConfidenceLevel;
  observations: number;
  reasons: ConfidenceReason[];
}

export interface ConfidenceEngine {
  evaluate(knowledge: TransitionKnowledge, context: KnowledgeContext): ConfidenceResult;
}

export interface ConfidenceOptions {
  /**
   * Nombre d'observations pour une confiance d'échantillon de 0,5 : n / (n + k).
   * k = 5 → 1 obs. 0,17 · 5 → 0,5 · 20 → 0,8 · 100 → 0,95 · 1000 → 0,995. Aucun seuil brutal.
   */
  sampleHalfPoint: number;
  /** Absent : vieillissement désactivé (intelligence.aging.enabled: false), récence = 1. */
  aging?: AgingOptions;
  /** false : contexte non comparé (intelligence.context.enabled: false), similarité = 1. */
  compareContext?: boolean;
  /** Date courante (ISO) : fixée par les tests pour des résultats reproductibles. */
  now?: () => string;
}

export const DEFAULT_CONFIDENCE: ConfidenceOptions = { sampleHalfPoint: 5, aging: DEFAULT_AGING };

/** Confiance d'échantillon : croît progressivement avec le nombre d'observations. */
export function sampleConfidence(
  observations: number,
  halfPoint = DEFAULT_CONFIDENCE.sampleHalfPoint,
): number {
  if (observations <= 0) return 0;
  return observations / (observations + halfPoint);
}

/** VERY_LOW < 0,2 ≤ LOW < 0,4 ≤ MEDIUM < 0,6 ≤ HIGH < 0,8 ≤ VERY_HIGH. */
export function confidenceLevel(score: number): ConfidenceLevel {
  if (score < 0.2) return 'VERY_LOW';
  if (score < 0.4) return 'LOW';
  if (score < 0.6) return 'MEDIUM';
  if (score < 0.8) return 'HIGH';
  return 'VERY_HIGH';
}

/**
 * CONFIDENCE ENGINE, déterministe et explicable :
 *
 *   confiance = échantillon × stabilité × récence × similarité du contexte
 *
 * - échantillon : n / (n + k) — 2 observations identiques ne valent pas 500 ;
 * - stabilité : part de la destination dominante parmi les observations ;
 * - récence : le poids de vieillissement de la dernière observation (KnowledgeAging) ;
 * - contexte : la similarité entre le contexte de la dernière observation et le contexte courant.
 *
 * Une probabilité historique n'est jamais une certitude fonctionnelle : le score reste
 * sous 1, et le nombre d'observations accompagne toujours le résultat.
 */
export class DeterministicConfidenceEngine implements ConfidenceEngine {
  constructor(private readonly options: ConfidenceOptions = DEFAULT_CONFIDENCE) {}

  evaluate(knowledge: TransitionKnowledge, context: KnowledgeContext): ConfidenceResult {
    const now = this.options.now?.() ?? new Date().toISOString();
    const counts = Object.values(knowledge.targets);
    const observations = counts.reduce((sum, count) => sum + count, 0) + knowledge.failureCount;
    const dominant = counts.length > 0 ? Math.max(...counts) : 0;
    const sample = sampleConfidence(observations, this.options.sampleHalfPoint);
    const stability = observations > 0 ? dominant / observations : 0;
    const aging = this.options.aging;
    const recency = aging ? recencyWeight(knowledge.lastSeenAt, now, aging) : 1;
    const compared = this.options.compareContext !== false;
    const similarity = compared
      ? contextSimilarity(knowledge.lastContext, context)
      : { score: 1, differences: [], unknown: [] };
    const score = round(sample * stability * recency * similarity.score);
    const age = ageInDays(knowledge.lastSeenAt, now);
    return {
      score,
      level: confidenceLevel(score),
      observations,
      reasons: [
        { factor: 'sample', value: round(sample), detail: `${observations} observation(s)` },
        {
          factor: 'stability',
          value: round(stability),
          detail: `${dominant}/${observations} to the same destination`,
        },
        {
          factor: 'recency',
          value: round(recency),
          detail: !aging
            ? 'aging disabled'
            : age < 1
              ? 'seen today'
              : `last seen ${Math.floor(age)} day(s) ago`,
        },
        {
          factor: 'context',
          value: similarity.score,
          detail: !compared
            ? 'context not compared'
            : similarity.differences.length > 0
              ? similarity.differences
                  .map((diff) => `${diff.dimension} ${diff.observed} ≠ ${diff.current}`)
                  .join(', ')
              : similarity.unknown.length > 0
                ? `same known context (unknown: ${similarity.unknown.join(', ')})`
                : 'same context',
        },
      ],
    };
  }
}

/** « 0.78 HIGH (17 observation(s); stability 0.94; recency 0.9; context 1) ». */
export function describeConfidence(result: ConfidenceResult): string {
  return `${result.score} ${result.level} (${result.reasons
    .map((reason) => (reason.factor === 'sample' ? reason.detail : `${reason.factor} ${reason.value}`))
    .join('; ')})`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
