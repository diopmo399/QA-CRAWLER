/**
 * Ways of getting the exploration back on its feet after a failure, in the
 * order they are tried by default (cheapest and least intrusive first).
 *
 * - retry: the same action once more, only for a transient Playwright error
 *   (element detached, not stable…) and never for an action that sends data;
 * - dismiss-dialog: close what is in front of the screen (Escape, else its
 *   "Close" button);
 * - escape: press Escape even when nothing was seen in front;
 * - back: browser history, when the action navigated;
 * - known-url: reload the URL of the state the action started from;
 * - replay-path: replay the recorded transitions from the start state;
 * - reauthenticate: log in again when the session expired;
 * - abandon-branch: give up this state and go on elsewhere.
 */
export const RECOVERY_STRATEGIES = [
  'retry',
  'dismiss-dialog',
  'escape',
  'back',
  'known-url',
  'replay-path',
  'reauthenticate',
  'abandon-branch',
] as const;
export type RecoveryStrategyName = (typeof RECOVERY_STRATEGIES)[number];

export type FailureKind =
  'action-failed' | 'page-crash' | 'left-allowed-hosts' | 'session-expired' | 'circuit-open' | 'stuck';

/** One recovery attempt, for the report. Never a value typed nor a secret. */
export interface RecoveryEvent {
  at: string;
  /** State the exploration tried to get back to (or leave). */
  stateId: string;
  actionId?: string;
  failure: FailureKind;
  /** First line of the error, as Playwright gave it. */
  message?: string;
  strategy: RecoveryStrategyName;
  success: boolean;
  /** State reached when the strategy worked. */
  reachedStateId?: string;
}

/** A branch the exploration left because it made no progress. */
export interface StuckEvent {
  at: string;
  stateId: string;
  kind: 'oscillation' | 'no-op' | 'busy';
  message: string;
}

/** A failure seen often enough to stop trying. */
export interface OpenCircuit {
  stateId: string;
  /** Absent: the whole state is abandoned. */
  actionId?: string;
  failure: string;
  occurrences: number;
}

export interface RecoverySummary {
  events: RecoveryEvent[];
  stuck: StuckEvent[];
  circuits: OpenCircuit[];
  reauthentications: number;
}
