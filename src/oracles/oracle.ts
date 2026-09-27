import type { ActionCategory, ActionClassification, ActionType } from '../model/discovered-action.js';
import type { Issue } from '../model/issue.js';
import type { NetworkExchange } from '../model/network.js';
import type { PageContext } from '../model/page-context.js';
import type { UiSignals } from '../model/ui-snapshot.js';

/**
 * PASS: the checks this oracle knows how to make hold.
 * FAIL: a confirmed failure (HTTP 5xx, crash, action impossible…).
 * WARNING: something looks wrong but may be expected (baseline difference, error banner…).
 * UNKNOWN: not enough information. Never turned into PASS.
 */
export const ORACLE_STATUSES = ['PASS', 'FAIL', 'WARNING', 'UNKNOWN'] as const;
export type OracleStatus = (typeof ORACLE_STATUSES)[number];

export interface OracleReason {
  /** Stable code (http-5xx, page-crash, baseline-differs…). */
  code: string;
  message: string;
}

export interface OracleResult {
  oracle: string;
  status: OracleStatus;
  /**
   * 0..1: how sure the oracle is. A way to rank observations, not a
   * scientific measure.
   */
  confidence: number;
  reasons: OracleReason[];
}

/** The action as executed (no value typed, no secret). */
export interface ExecutedAction {
  id: string;
  type: ActionType;
  category: ActionCategory;
  classification: ActionClassification;
  text?: string;
  href?: string;
  /** Sends a form (submit, "Save"… in a form). */
  submitsForm?: boolean;
  result: 'SUCCESS' | 'FAILED';
  error?: string;
  durationMs?: number;
}

/** What the observers saw while the action ran. */
export interface ActionObservations {
  /** Anomalies raised during the action (HTTP, JS errors, console…). */
  issues: Issue[];
  /** HTTP exchanges of the action's network window. */
  network: NetworkExchange[];
  pageCrashed: boolean;
  /** UI hints before and after (alerts, spinner, empty screen, invalid fields). */
  before?: UiSignals;
  after?: UiSignals;
  /** The form of this screen was just filled with valid data. */
  formFilledWithValidData?: boolean;
}

/**
 * "Does the result look correct?" An oracle judges one executed action from
 * plain data. It must answer UNKNOWN when it cannot tell — never invent a PASS.
 */
export interface TestOracle {
  readonly name: string;
  evaluate(
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
  ): Promise<OracleResult>;
}

/**
 * Extension point for business meaning ("the invoice was created with the
 * right total"). No implementation ships: without an explicit business
 * expectation, the business result is UNKNOWN. A future implementation
 * (rules, contracts, or a model) plugs in here without touching the explorer.
 */
export type SemanticOracle = TestOracle;

export function result(
  oracle: string,
  status: OracleStatus,
  confidence: number,
  reasons: OracleReason[],
): OracleResult {
  return { oracle, status, confidence: Math.round(confidence * 100) / 100, reasons };
}
