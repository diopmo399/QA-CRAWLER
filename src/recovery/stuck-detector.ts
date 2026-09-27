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
      };
    }

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
      };
    }
    return undefined;
  }
}
