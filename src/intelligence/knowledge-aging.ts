import { decayFactor } from '../knowledge/statistics.js';

/**
 * VIEILLISSEMENT DE LA CONNAISSANCE : une observation ancienne compte moins dans la
 * décision, sans jamais être supprimée. Le STOCKAGE garde tout ; seul le POIDS utilisé
 * pour décider décroît (demi-vie, la même fonction que la KnowledgeBase : decayFactor).
 *
 *   aujourd'hui → 1   ·   une demi-vie → 0,5   ·   très ancien → proche de minWeight
 */
export interface AgingOptions {
  halfLifeDays: number;
  /** Poids plancher : une connaissance très ancienne garde une influence faible, jamais nulle. */
  minWeight: number;
}

export const DEFAULT_AGING: AgingOptions = { halfLifeDays: 30, minWeight: 0.05 };

/** Poids de récence d'une connaissance vue pour la dernière fois à `lastSeenAt`. */
export function recencyWeight(
  lastSeenAt: string | undefined,
  now: string,
  options: AgingOptions = DEFAULT_AGING,
): number {
  if (!lastSeenAt) return 1;
  const weight = decayFactor(lastSeenAt, now, options.halfLifeDays);
  return Math.max(options.minWeight, weight);
}

/** Âge en jours (0 pour une date future ou illisible). */
export function ageInDays(lastSeenAt: string | undefined, now: string): number {
  if (!lastSeenAt) return 0;
  const days = (Date.parse(now) - Date.parse(lastSeenAt)) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * Observations « effectives » : le nombre d'observations pondéré par la récence.
 * 500 observations vues il y a 10 mois (demi-vie 30 j) ≈ 0,5 observation effective ;
 * 80 observations vues hier ≈ 78 : les récentes l'emportent.
 */
export function effectiveObservations(
  observations: number,
  lastSeenAt: string | undefined,
  now: string,
  options: AgingOptions = DEFAULT_AGING,
): number {
  if (observations <= 0) return 0;
  const weight = lastSeenAt ? decayFactor(lastSeenAt, now, options.halfLifeDays) : 1;
  return observations * weight;
}
