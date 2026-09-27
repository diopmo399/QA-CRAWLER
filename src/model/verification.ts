import type { NetworkExchange } from './network.js';

/**
 * - PASSED: the known transition still leads to the same state.
 * - CHANGED: it now leads to another state.
 * - FAILED: the action fails now.
 * - ACTION_MISSING: its start state is there, the action is not.
 * - UNREACHABLE: its start state cannot be reached any more.
 * - BLOCKED: the current safety policy refuses the action (not a regression).
 * - SKIPPED: not verified (mission limit reached).
 */
export const VERIFICATION_STATUSES = [
  'PASSED',
  'CHANGED',
  'FAILED',
  'ACTION_MISSING',
  'UNREACHABLE',
  'BLOCKED',
  'SKIPPED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Statuses that mean the application no longer behaves like the baseline. */
export const REGRESSION_STATUSES: readonly VerificationStatus[] = [
  'CHANGED',
  'FAILED',
  'ACTION_MISSING',
  'UNREACHABLE',
];

/** One known transition of the baseline, replayed. */
export interface VerifiedTransition {
  from: string;
  fromLabel: string;
  actionId: string;
  action: { type: string; text?: string; href?: string };
  expectedTo: string;
  expectedToLabel: string;
  actualTo?: string;
  actualToLabel?: string;
  status: VerificationStatus;
  reason?: string;
  network?: NetworkExchange[];
}

export interface VerificationReport {
  /** Baseline run that was verified. */
  baselineRunId?: string;
  transitions: VerifiedTransition[];
  summary: Record<VerificationStatus, number>;
  /** Number of transitions in a regression status. */
  regressions: number;
}
