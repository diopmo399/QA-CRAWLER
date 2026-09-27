/** Statistiques simples, sans dépendance : médiane et p95 d'une série de durées. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function median(values: readonly number[]): number | undefined {
  return percentile(values, 50);
}

/**
 * Décroissance d'une observation : 1 pour aujourd'hui, 0,5 après une demi-vie, 0,25
 * après deux… Les vieilles observations comptent moins, sans jamais être supprimées.
 */
export function decayFactor(from: string | undefined, to: string, halfLifeDays: number): number {
  if (!from) return 1;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return 1;
  return 0.5 ** (days / halfLifeDays);
}
