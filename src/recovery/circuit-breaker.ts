import type { OpenCircuit } from './recovery-model.js';

export interface CircuitBreakerOptions {
  /** Same state, same action, same failure this many times: the action is not tried again. */
  threshold: number;
  /** Failures of any action on one state before the whole state is abandoned. */
  maxFailuresPerState: number;
}

export type CircuitState = 'closed' | 'action-open' | 'state-open';

/**
 * Stops the exploration from hitting the same wall: a failure that repeats
 * (same state, same action, same kind of error) opens the circuit of that
 * action; a state where too many actions fail is abandoned.
 */
export class CircuitBreaker {
  private readonly failures = new Map<
    string,
    { stateId: string; actionId: string; failure: string; count: number }
  >();
  private readonly perState = new Map<string, number>();
  private readonly openActions = new Set<string>();
  private readonly openStates = new Set<string>();

  constructor(private readonly options: CircuitBreakerOptions) {}

  record(stateId: string, actionId: string, error: string): CircuitState {
    const failure = failureKind(error);
    const key = `${stateId}|${actionId}|${failure}`;
    const entry = this.failures.get(key) ?? { stateId, actionId, failure, count: 0 };
    entry.count += 1;
    this.failures.set(key, entry);
    const onState = (this.perState.get(stateId) ?? 0) + 1;
    this.perState.set(stateId, onState);
    if (onState >= this.options.maxFailuresPerState) {
      this.openStates.add(stateId);
      return 'state-open';
    }
    if (entry.count >= this.options.threshold) {
      this.openActions.add(`${stateId}|${actionId}`);
      return 'action-open';
    }
    return 'closed';
  }

  isOpen(stateId: string, actionId?: string): boolean {
    return (
      this.openStates.has(stateId) ||
      (actionId !== undefined && this.openActions.has(`${stateId}|${actionId}`))
    );
  }

  circuits(): OpenCircuit[] {
    const circuits: OpenCircuit[] = [];
    for (const entry of this.failures.values()) {
      if (this.openActions.has(`${entry.stateId}|${entry.actionId}`) && entry.count >= this.options.threshold)
        circuits.push({
          stateId: entry.stateId,
          actionId: entry.actionId,
          failure: entry.failure,
          occurrences: entry.count,
        });
    }
    for (const stateId of this.openStates)
      circuits.push({
        stateId,
        failure: 'too many failures on this state',
        occurrences: this.perState.get(stateId) ?? 0,
      });
    return circuits;
  }
}

/** The kind of an error, without what changes from one occurrence to the next (timings, ids, selectors). */
export function failureKind(error: string): string {
  const line = (error.split('\n')[0] ?? error).trim();
  return line
    .replace(/\d+(\.\d+)?\s*ms/g, 'Nms')
    .replace(/\d+/g, 'N')
    .replace(/(["'`]).*?\1/g, '"…"')
    .slice(0, 120);
}
