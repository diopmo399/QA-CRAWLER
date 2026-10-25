import type { KnowledgeEvidence, Reliability, ReliabilityStatus } from './model.js';

/**
 * LA FIABILITÉ D'UNE CONNAISSANCE, CALCULÉE : aucune valeur stockée, aucune pondération cachée. Les
 * règles, dans l'ordre (la première qui s'applique l'emporte) :
 *
 *   1. hypothesis = true                                   → HYPOTHESIS (produite par une analyse)
 *   2. contradictions > 0 et contradictions ≥ confirmations → CONTRADICTED
 *   3. executions ≥ 2 et failures / executions ≥ 0.5        → CONTRADICTED
 *   4. lastSeenAt plus vieux que staleAfterDays             → STALE
 *   5. executions ≥ minObservations et failures / executions ≤ 0.1, ou confirmations ≥ minObservations
 *      sans contradiction                                    → CONFIRMED
 *   6. executions ≥ 1 et failures > 0 (0.1 < taux < 0.5), ou blocked > executions → FRAGILE
 *   7. seen ≥ 1 ou executions ≥ 1 ou confirmations ≥ 1      → OBSERVED
 *   8. sinon                                                → UNVERIFIED
 *
 * executions = successes + failures. Les seuils sont ceux de la mission (knowledge.minObservations)
 * et de la commande (--stale-days). Une décision humaine ne change pas ce calcul : elle est montrée
 * à côté (review).
 */
export interface ReliabilityOptions {
  minObservations: number;
  staleAfterDays: number;
  now: Date;
}

export const DEFAULT_RELIABILITY: ReliabilityOptions = {
  minObservations: 3,
  staleAfterDays: 90,
  now: new Date(),
};

export function assessReliability(
  evidence: KnowledgeEvidence,
  lastSeenAt: string | undefined,
  options: ReliabilityOptions,
  hypothesis = false,
): Reliability {
  const successes = evidence.successes ?? 0;
  const failures = evidence.failures ?? 0;
  const blocked = evidence.blocked ?? 0;
  const confirmations = evidence.confirmations ?? 0;
  const contradictions = evidence.contradictions ?? 0;
  const seen = evidence.seen ?? 0;
  const executions = successes + failures;
  const rate = executions > 0 ? failures / executions : 0;
  const reasons: string[] = [];
  const done = (status: ReliabilityStatus, reason: string): Reliability => ({
    status,
    reasons: [...reasons, reason],
  });

  if (hypothesis) return done('HYPOTHESIS', 'produced by an analysis, never confirmed by an execution');
  if (contradictions > 0 && contradictions >= confirmations)
    return done(
      'CONTRADICTED',
      `${String(contradictions)} contradiction(s) for ${String(confirmations)} confirmation(s)`,
    );
  if (executions >= 2 && rate >= 0.5)
    return done('CONTRADICTED', `${String(failures)} failure(s) out of ${String(executions)} execution(s)`);
  const age = ageInDays(lastSeenAt, options.now);
  if (age !== undefined && age > options.staleAfterDays)
    return done(
      'STALE',
      `last seen ${String(Math.round(age))} day(s) ago (> ${String(options.staleAfterDays)})`,
    );
  if (executions >= options.minObservations && rate <= 0.1)
    return done(
      'CONFIRMED',
      `${String(successes)} success(es) out of ${String(executions)} execution(s) (≥ ${String(options.minObservations)})`,
    );
  if (confirmations >= options.minObservations && contradictions === 0)
    return done('CONFIRMED', `${String(confirmations)} confirmation(s), no contradiction`);
  if (executions >= 1 && failures > 0)
    return done('FRAGILE', `${String(failures)} failure(s) out of ${String(executions)} execution(s)`);
  if (blocked > executions && blocked > 0)
    return done('FRAGILE', `blocked ${String(blocked)} time(s), executed ${String(executions)}`);
  if (seen >= 1 || executions >= 1 || confirmations >= 1)
    return done(
      'OBSERVED',
      executions > 0
        ? `${String(executions)} execution(s), fewer than ${String(options.minObservations)}`
        : `seen ${String(Math.max(seen, confirmations))} time(s), never executed`,
    );
  return done('UNVERIFIED', 'no usable evidence');
}

export function ageInDays(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  return (now.getTime() - time) / 86_400_000;
}
