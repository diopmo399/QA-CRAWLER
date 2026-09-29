import type { TransitionKnowledge } from '../knowledge/knowledge-model.js';
import { stabilityScore, type StabilityOptions } from './stability-score.js';

export const FLAKINESS_CLASSES = [
  'STABLE',
  'MOSTLY_STABLE',
  'UNSTABLE',
  'HIGHLY_UNSTABLE',
  'UNKNOWN',
] as const;
export type FlakinessClass = (typeof FLAKINESS_CLASSES)[number];

export interface FlakinessResult {
  class: FlakinessClass;
  /** 0..1 : le StabilityScore (résultat × destination). */
  stability: number;
  /** Part des exécutions réussies. */
  passRate: number;
  observations: number;
  /** Confiance dans ce classement : n / (n + k). */
  confidence: number;
  reason: string;
}

export interface FlakinessOptions extends StabilityOptions {
  /** STABLE à partir de ce score. */
  stableAt: number;
  /** MOSTLY_STABLE à partir de ce score. */
  mostlyStableAt: number;
  /** UNSTABLE à partir de ce score ; en dessous : HIGHLY_UNSTABLE. */
  unstableAt: number;
}

export const DEFAULT_FLAKINESS: FlakinessOptions = {
  sampleHalfPoint: 5,
  minDurationSamples: 5,
  variabilityRatio: 3,
  minConfidence: 0.4,
  stableAt: 0.95,
  mostlyStableAt: 0.8,
  unstableAt: 0.5,
};

/**
 * FLAKY DETECTION : une transition historiquement instable (« Search → Results : 100
 * observations, 72 réussites, 28 échecs » → UNSTABLE). Le classement vient du
 * StabilityScore (taux de réussite × part de la destination dominante) :
 *
 *   ≥ 0,95 STABLE · ≥ 0,80 MOSTLY_STABLE · ≥ 0,50 UNSTABLE · sinon HIGHLY_UNSTABLE
 *
 * Trop peu d'observations : UNKNOWN, jamais un classement fort. Une transition instable
 * n'est jamais un bug en soi : c'est le contexte d'un verdict.
 */
export function classifyFlakiness(
  knowledge: TransitionKnowledge,
  options: FlakinessOptions = DEFAULT_FLAKINESS,
): FlakinessResult {
  const stability = stabilityScore(
    { successes: knowledge.successCount, failures: knowledge.failureCount, targets: knowledge.targets },
    options,
  );
  const executed = knowledge.successCount + knowledge.failureCount;
  const passRate = executed > 0 ? Math.round((knowledge.successCount / executed) * 1000) / 1000 : 0;
  const base = {
    stability: stability.score,
    passRate,
    observations: stability.observations,
    confidence: stability.confidence,
  };
  const detail = `${knowledge.successCount}/${executed} passed, stability ${stability.score}, confidence ${stability.confidence}`;
  if (stability.level === 'UNCERTAIN')
    return { ...base, class: 'UNKNOWN', reason: `too few observations (${detail})` };
  const kind: FlakinessClass =
    stability.score >= options.stableAt
      ? 'STABLE'
      : stability.score >= options.mostlyStableAt
        ? 'MOSTLY_STABLE'
        : stability.score >= options.unstableAt
          ? 'UNSTABLE'
          : 'HIGHLY_UNSTABLE';
  return { ...base, class: kind, reason: detail };
}

/** Répartition d'un ensemble de transitions, pour le rapport. */
export function flakinessDistribution(
  transitions: readonly TransitionKnowledge[],
  options: FlakinessOptions = DEFAULT_FLAKINESS,
): Record<FlakinessClass, number> {
  const counts = Object.fromEntries(FLAKINESS_CLASSES.map((kind) => [kind, 0])) as Record<
    FlakinessClass,
    number
  >;
  for (const transition of transitions) counts[classifyFlakiness(transition, options).class] += 1;
  return counts;
}
