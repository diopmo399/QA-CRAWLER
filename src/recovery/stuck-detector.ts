import type { StuckEvent } from './recovery-model.js';

export interface StuckDetectorOptions {
  /** A→B→A→B… répété ce nombre de fois (A→B→A = un cycle). */
  oscillationCycles: number;
  /** Actions consécutives qui ne changent rien (même état, aucun appel réseau). */
  maxNoOpActions: number;
  /** Observations consécutives avec une roue de chargement qui tourne encore. */
  maxBusyObservations: number;
}

export interface ObservedTransition {
  from: string;
  to: string;
  /** L'action exécutée (pour pénaliser les actions d'une boucle). */
  actionId?: string;
  /** Échanges HTTP causés par l'action. */
  requests: number;
  /** Une roue de chargement ou aria-busy après l'action. */
  busy: boolean;
}

/**
 * Remarque quand l'exploration tourne en rond : deux états visités en alternance,
 * une série d'actions qui ne changent rien, ou un écran qui charge sans fin.
 * L'explorateur abandonne alors la branche et va ailleurs.
 */
export class StuckDetector {
  private readonly visits: string[] = [];
  /** Derniers pas (état de départ + action), pour les boucles A → B → C → A. */
  private readonly steps: { from: string; to: string; actionId?: string }[] = [];
  /** Boucles déjà pénalisées : la même boucle une deuxième fois fait quitter la branche. */
  private readonly penalized = new Set<string>();
  private noOps = 0;
  private busy = 0;
  private readonly events: StuckEvent[] = [];

  constructor(private readonly options: StuckDetectorOptions) {}

  observe(transition: ObservedTransition): StuckEvent | undefined {
    const event = this.check(transition);
    if (event) this.events.push(event);
    return event;
  }

  /** L'exploration est passée ailleurs (retour arrière, saut) : les motifs repartent de zéro. */
  reset(): void {
    this.visits.length = 0;
    this.steps.length = 0;
    this.noOps = 0;
    this.busy = 0;
  }

  all(): StuckEvent[] {
    return [...this.events];
  }

  private check(transition: ObservedTransition): StuckEvent | undefined {
    const at = new Date().toISOString();
    this.busy = transition.busy ? this.busy + 1 : 0;
    if (this.busy >= this.options.maxBusyObservations) {
      const count = this.busy;
      this.reset();
      return {
        at,
        stateId: transition.to,
        kind: 'busy',
        message: `still loading after ${count} consecutive actions`,
        response: 'backtrack',
      };
    }

    const noOp = transition.from === transition.to && transition.requests === 0;
    this.noOps = noOp ? this.noOps + 1 : 0;
    if (this.noOps >= this.options.maxNoOpActions) {
      const count = this.noOps;
      this.reset();
      return {
        at,
        stateId: transition.to,
        kind: 'no-op',
        message: `${count} consecutive actions changed nothing`,
        response: 'backtrack',
      };
    }

    const cycle = this.cycle(transition, at);
    if (cycle) return cycle;

    if (this.visits.length === 0) this.visits.push(transition.from);
    if (transition.to !== this.visits[this.visits.length - 1]) this.visits.push(transition.to);
    const window = 2 * this.options.oscillationCycles;
    if (this.visits.length > window) this.visits.splice(0, this.visits.length - window);
    const [a, b] = this.visits;
    if (
      this.visits.length === window &&
      a !== undefined &&
      b !== undefined &&
      a !== b &&
      this.visits.every((state, index) => state === (index % 2 === 0 ? a : b))
    ) {
      this.reset();
      return {
        at,
        stateId: transition.to,
        kind: 'oscillation',
        message: `oscillation between two states (${a} ↔ ${b}), ${this.options.oscillationCycles} times`,
        response: 'backtrack',
      };
    }
    return undefined;
  }

  /**
   * Boucle de 3 ou 4 écrans (A → B → C → A…) répétée `oscillationCycles` fois, sur une
   * fenêtre des derniers pas. La première fois : `penalize` (les actions de la boucle
   * perdent des points, l'exploration continue) ; si la même boucle revient : `backtrack`.
   */
  private cycle(transition: ObservedTransition, at: string): StuckEvent | undefined {
    if (transition.from === transition.to) return undefined;
    this.steps.push({
      from: transition.from,
      to: transition.to,
      ...(transition.actionId ? { actionId: transition.actionId } : {}),
    });
    const cycles = this.options.oscillationCycles;
    const window = 4 * cycles;
    if (this.steps.length > window) this.steps.splice(0, this.steps.length - window);
    for (const length of [3, 4]) {
      const needed = length * cycles;
      if (this.steps.length < needed) continue;
      const tail = this.steps.slice(-needed);
      const loop = tail.slice(0, length);
      if (new Set(loop.map((step) => step.from)).size !== length) continue;
      if (!tail.every((step, index) => step.from === loop[index % length]?.from)) continue;
      const path = [...loop.map((step) => step.from), loop[0]?.from ?? ''].join(' → ');
      const key = [...loop.map((step) => step.from)].sort().join('|');
      const again = this.penalized.has(key);
      this.penalized.add(key);
      // La boucle est traitée : les motifs repartent de zéro (sinon l'oscillation la verrait aussi).
      this.steps.length = 0;
      this.visits.length = 0;
      return {
        at,
        stateId: transition.to,
        kind: 'cycle',
        message: `cycle ${path}, ${cycles} times`,
        response: again ? 'backtrack' : 'penalize',
        actions: loop
          .filter((step) => step.actionId !== undefined)
          .map((step) => ({ stateId: step.from, actionId: step.actionId ?? '' })),
      };
    }
    return undefined;
  }
}
