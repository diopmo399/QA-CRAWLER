import type { ActionClassification } from './discovered-action.js';

/**
 * - PASSED: done (an `expect` held).
 * - FAILED: element not found, action error, expectation not met.
 * - BLOCKED: refused by the SafetyPolicy (DANGEROUS, MUTATION without `allow`…).
 * - SKIPPED: not run because an earlier step stopped the flow, or a limit was reached.
 */
export const FLOW_STATUSES = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** Outcome of one step of an imposed flow. */
export interface FlowStepReport {
  /** 1-based position in the flow. */
  index: number;
  kind: string;
  description: string;
  status: FlowStatus;
  optional: boolean;
  /** Failure or block reason. */
  reason?: string;
  /** SafetyPolicy classification of the targeted element. */
  classification?: ActionClassification;
  /** State reached after the step. */
  stateId?: string;
  url?: string;
  durationMs: number;
  screenshot?: string;
}

/** Outcome of one imposed flow. */
export interface FlowRunReport {
  name: string;
  description?: string;
  status: FlowStatus;
  startedAt: string;
  durationMs: number;
  steps: FlowStepReport[];
  /** States visited, in order (for the flow graph). */
  states: string[];
  /** Issues raised by the flow (failed/blocked steps) and while it ran. */
  issueIds: string[];
  /** The explorer explored autonomously from the last screen (thenExplore). */
  explored: boolean;
}
