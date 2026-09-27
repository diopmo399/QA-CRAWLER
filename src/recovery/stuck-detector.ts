import type { StuckEvent } from './recovery-model.js';

export interface StuckDetectorOptions {
  /** A→B→A→B… repeated this many times (A→B→A = one cycle). */
  oscillationCycles: number;
  /** Consecutive actions that change nothing (same state, no network call). */
  maxNoOpActions: number;
  /** Consecutive observations with a spinner still turning. */
  maxBusyObservations: number;
}

export interface ObservedTransition {
  from: string;
  to: string;
  /** HTTP exchanges the action caused. */
  requests: number;
  /** A spinner or aria-busy after the action. */
  busy: boolean;
}

/**
 * Notices when the exploration turns in circles: two states visited in
 * alternation, a series of actions that change nothing, or a screen that
 * keeps loading. The explorer then abandons the branch and goes elsewhere.
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

  /** The exploration moved on elsewhere (backtrack, jump): patterns start over. */
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
