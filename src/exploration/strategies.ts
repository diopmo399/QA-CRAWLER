import type {
  ExplorationCandidate,
  ExplorationContext,
  ExplorationFrontier,
  ExplorationStrategy,
} from './frontier.js';

/** Score effectif : score + ancienneté − coût du déplacement. */
export function effectiveScore(candidate: ExplorationCandidate, context: ExplorationContext): number {
  const travel =
    candidate.stateId === context.currentStateId ? 0 : (context.travelCost?.(candidate.stateId) ?? 0);
  return candidate.score + context.agingBonus * candidate.waited - travel;
}

/**
 * BEST-FIRST : le meilleur candidat de toute la frontière, pas seulement de l'écran
 * courant. Pour ne pas faire des allers-retours pour quelques points, un candidat
 * ailleurs doit battre le meilleur de l'écran courant d'au moins `switchMargin` (et
 * payer son coût de déplacement). Anti-starvation : chaque décision attendue ajoute
 * `agingBonus` points, une branche faible finit toujours par passer.
 *
 * Déterministe : à score égal, l'ordre de découverte ; avec `seed`, un départage
 * pseudo-aléatoire reproductible.
 */
export class BestFirstExplorationStrategy implements ExplorationStrategy {
  readonly name = 'best-first';

  next(frontier: ExplorationFrontier, context: ExplorationContext): ExplorationCandidate | null {
    const allowed = frontier.candidates().filter((candidate) => context.isAllowed?.(candidate) ?? true);
    if (allowed.length === 0) return null;
    const random = context.seed !== undefined ? seededRandom(context.seed + frontier.size) : undefined;
    const tieBreak = new Map(allowed.map((candidate) => [candidate, random ? random() : candidate.sequence]));
    const ranked = [...allowed].sort(
      (a, b) =>
        effectiveScore(b, context) - effectiveScore(a, context) ||
        (tieBreak.get(a) ?? 0) - (tieBreak.get(b) ?? 0),
    );
    const best = ranked[0] ?? null;
    const local = ranked.find((candidate) => candidate.stateId === context.currentStateId);
    if (!best || !local || best.stateId === context.currentStateId) return best;
    // Quitter l'écran courant seulement pour nettement mieux.
    return effectiveScore(best, context) >= effectiveScore(local, context) + context.switchMargin
      ? best
      : local;
  }
}

/**
 * DEPTH-FIRST (comportement historique) : l'écran courant d'abord, puis le candidat
 * découvert le plus récemment (retour arrière le plus proche).
 */
export class DepthFirstExplorationStrategy implements ExplorationStrategy {
  readonly name = 'depth-first';

  next(frontier: ExplorationFrontier, context: ExplorationContext): ExplorationCandidate | null {
    const allowed = frontier.candidates().filter((candidate) => context.isAllowed?.(candidate) ?? true);
    const local = allowed
      .filter((candidate) => candidate.stateId === context.currentStateId)
      .sort((a, b) => b.score - a.score || a.sequence - b.sequence)[0];
    if (local) return local;
    return allowed.sort((a, b) => b.sequence - a.sequence || b.score - a.score)[0] ?? null;
  }
}

/** Générateur pseudo-aléatoire (mulberry32) : même graine, même suite. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
