import type { ScoreBreakdown } from '../decision/score-breakdown.js';

/** Une action encore à essayer quelque part dans l'application. */
export interface ExplorationCandidate {
  stateId: string;
  actionId: string;
  score: number;
  depth: number;
  /** Tentatives déjà faites (une tentative ratée garde le candidat, avec un compteur). */
  attempts: number;
  discoveredAt: string;
  /** Libellé lisible (rapports, traces). */
  label?: string;
  breakdown?: ScoreBreakdown;
  /** Ordre de découverte : départage déterministe à score égal. */
  sequence: number;
  /** Décisions prises pendant que ce candidat attendait (bonus d'ancienneté). */
  waited: number;
}

/** Ce que la stratégie sait au moment de choisir. */
export interface ExplorationContext {
  /** L'état où se trouve le navigateur. */
  currentStateId: string;
  /** Points ajoutés par décision attendue (anti-starvation). */
  agingBonus: number;
  /** Écart exigé pour quitter l'écran courant au profit d'un candidat ailleurs. */
  switchMargin: number;
  /** Coût d'aller sur un autre état (navigation, rejeu). 0 pour l'état courant. */
  travelCost?(stateId: string): number;
  /** Un candidat encore possible (état joignable, dans le périmètre, budget…). */
  isAllowed?(candidate: ExplorationCandidate): boolean;
  /** Graine d'un départage pseudo-aléatoire (reproductible) ; absente : ordre de découverte. */
  seed?: number;
}

export interface ExplorationStrategy {
  readonly name: string;
  next(frontier: ExplorationFrontier, context: ExplorationContext): ExplorationCandidate | null;
}

/**
 * La frontière d'exploration : tous les candidats connus (état + action), sans
 * doublon. add met à jour un candidat existant (nouveau score) sans perdre son
 * ancienneté ni ses tentatives.
 */
export class ExplorationFrontier {
  private readonly entries = new Map<string, ExplorationCandidate>();
  private sequence = 0;

  add(
    candidate: Omit<ExplorationCandidate, 'sequence' | 'waited' | 'attempts'> &
      Partial<Pick<ExplorationCandidate, 'attempts'>>,
  ): ExplorationCandidate {
    const key = keyOf(candidate.stateId, candidate.actionId);
    const existing = this.entries.get(key);
    if (existing) {
      existing.score = candidate.score;
      existing.depth = Math.min(existing.depth, candidate.depth);
      if (candidate.label !== undefined) existing.label = candidate.label;
      if (candidate.breakdown !== undefined) existing.breakdown = candidate.breakdown;
      return existing;
    }
    const entry: ExplorationCandidate = { attempts: 0, ...candidate, sequence: this.sequence++, waited: 0 };
    this.entries.set(key, entry);
    return entry;
  }

  remove(stateId: string, actionId: string): void {
    this.entries.delete(keyOf(stateId, actionId));
  }

  /** Retire tous les candidats d'un état (épuisé, injoignable). */
  removeState(stateId: string): void {
    for (const [key, entry] of this.entries) if (entry.stateId === stateId) this.entries.delete(key);
  }

  update(
    stateId: string,
    actionId: string,
    patch: Partial<Pick<ExplorationCandidate, 'score' | 'attempts' | 'breakdown'>>,
  ): void {
    const entry = this.entries.get(keyOf(stateId, actionId));
    if (entry) Object.assign(entry, patch);
  }

  get(stateId: string, actionId: string): ExplorationCandidate | undefined {
    return this.entries.get(keyOf(stateId, actionId));
  }

  /** Le candidat que choisirait cette stratégie (sans le retirer). */
  next(strategy: ExplorationStrategy, context: ExplorationContext): ExplorationCandidate | null {
    return strategy.next(this, context);
  }

  hasCandidates(): boolean {
    return this.entries.size > 0;
  }

  candidates(): ExplorationCandidate[] {
    return [...this.entries.values()];
  }

  /** Une décision de plus : chaque candidat qui attend prend de l'ancienneté. */
  tick(chosen?: ExplorationCandidate): void {
    for (const entry of this.entries.values()) if (entry !== chosen) entry.waited += 1;
  }

  get size(): number {
    return this.entries.size;
  }
}

function keyOf(stateId: string, actionId: string): string {
  return `${stateId}::${actionId}`;
}
