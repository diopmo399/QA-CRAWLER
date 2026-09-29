import { percentile } from '../knowledge/statistics.js';
import { sampleConfidence } from './confidence-engine.js';

export const STABILITY_LEVELS = ['STABLE', 'VARIABLE', 'UNSTABLE', 'UNCERTAIN'] as const;
export type StabilityLevel = (typeof STABILITY_LEVELS)[number];

export interface StabilityInput {
  /** Exécutions observées (succès + échecs). */
  successes: number;
  failures: number;
  /** Destinations observées → nombre d'observations. */
  targets?: Record<string, number>;
  /** Durées RÉELLES observées (ms). Jamais une moyenne : sans échantillons, pas de p50/p95. */
  durations?: readonly number[];
}

export interface StabilityFactor {
  factor: 'outcome' | 'destination' | 'timing';
  /** 0..1 ; absent quand les données ne suffisent pas (le facteur n'est alors pas utilisé). */
  value?: number;
  detail: string;
}

export interface StabilityResult {
  /** 0..1 : produit des facteurs disponibles. */
  score: number;
  level: StabilityLevel;
  /** Confiance dans ce score : n / (n + k). */
  confidence: number;
  observations: number;
  p50?: number;
  p95?: number;
  factors: StabilityFactor[];
}

export interface StabilityOptions {
  sampleHalfPoint: number;
  /** Durées nécessaires avant de parler de p50 / p95. */
  minDurationSamples: number;
  /** p95 / p50 au-delà duquel la durée est dite variable. */
  variabilityRatio: number;
  /** En dessous de cette confiance, le niveau reste UNCERTAIN : jamais « instable » sur 2 essais. */
  minConfidence: number;
}

export const DEFAULT_STABILITY: StabilityOptions = {
  sampleHalfPoint: 5,
  minDurationSamples: 5,
  variabilityRatio: 3,
  minConfidence: 0.4,
};

/**
 * STABILITY SCORE, déterministe : une action donne-t-elle toujours le même résultat ?
 *
 *   stabilité = résultat (taux de succès) × destination (part dominante) × durée (p95 / p50)
 *
 * p50 et p95 viennent uniquement d'échantillons réels ; sans assez d'échantillons, la
 * durée n'entre pas dans le score (et c'est dit). Peu d'observations → UNCERTAIN.
 */
export function stabilityScore(
  input: StabilityInput,
  options: StabilityOptions = DEFAULT_STABILITY,
): StabilityResult {
  const observations = input.successes + input.failures;
  const factors: StabilityFactor[] = [];
  if (observations > 0) {
    const rate = input.successes / observations;
    factors.push({
      factor: 'outcome',
      value: round(rate),
      detail: `${input.successes}/${observations} succeeded`,
    });
  } else factors.push({ factor: 'outcome', detail: 'never executed' });

  const counts = Object.values(input.targets ?? {});
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    const dominant = Math.max(...counts);
    factors.push({
      factor: 'destination',
      value: round(dominant / total),
      detail: `${dominant}/${total} to the same destination (${counts.length} destination(s))`,
    });
  } else factors.push({ factor: 'destination', detail: 'no destination observed' });

  const durations = input.durations ?? [];
  let p50: number | undefined;
  let p95: number | undefined;
  if (durations.length >= options.minDurationSamples) {
    p50 = percentile(durations, 50);
    p95 = percentile(durations, 95);
    const ratio = p50 && p50 > 0 && p95 !== undefined ? p95 / p50 : 1;
    factors.push({
      factor: 'timing',
      value: round(ratio <= options.variabilityRatio ? 1 : options.variabilityRatio / ratio),
      detail: `p50 ${p50 ?? 0} ms, p95 ${p95 ?? 0} ms over ${durations.length} sample(s)`,
    });
  } else
    factors.push({
      factor: 'timing',
      detail: `${durations.length} duration sample(s) < ${options.minDurationSamples}: timing not scored`,
    });

  const available = factors.flatMap((factor) => (factor.value === undefined ? [] : [factor.value]));
  const score = available.length > 0 ? round(available.reduce((product, value) => product * value, 1)) : 0;
  const confidence = round(sampleConfidence(Math.max(observations, total), options.sampleHalfPoint));
  const level: StabilityLevel =
    available.length === 0 || confidence < options.minConfidence
      ? 'UNCERTAIN'
      : score >= 0.9
        ? 'STABLE'
        : score >= 0.6
          ? 'VARIABLE'
          : 'UNSTABLE';
  return {
    score,
    level,
    confidence,
    observations: Math.max(observations, total),
    ...(p50 !== undefined ? { p50 } : {}),
    ...(p95 !== undefined ? { p95 } : {}),
    factors,
  };
}

/** « 0.45 UNSTABLE (confidence 0.8; outcome 0.5: 10/20 succeeded; …) ». */
export function describeStability(result: StabilityResult): string {
  return `${result.score} ${result.level} (confidence ${result.confidence}; ${result.factors
    .map((factor) =>
      factor.value === undefined ? factor.detail : `${factor.factor} ${factor.value}: ${factor.detail}`,
    )
    .join('; ')})`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
