import type { PageContext } from '../model/page-context.js';
import type {
  ActionObservations,
  ExecutedAction,
  OracleReason,
  OracleResult,
  OracleStatus,
  TestOracle,
} from './oracle.js';

/** The verdict on one executed action: every oracle's opinion, and a summary. */
export interface OracleVerdict {
  /**
   * FAIL if an oracle failed, else WARNING if one warned, else PASS if at least
   * one oracle passed; UNKNOWN when no oracle could tell. UNKNOWN opinions
   * (business result, baseline without this transition…) never count as PASS.
   */
  status: OracleStatus;
  confidence: number;
  reasons: string[];
  results: OracleResult[];
  /** Observed assertions: "✓ no HTTP 5xx", "✗ POST /api/users returned HTTP 500", "? business result unknown". */
  assertions: string[];
}

/**
 * Aggregates several oracles (technical, UI, baseline, contract, and any
 * SemanticOracle added later). The business result stays UNKNOWN unless an
 * oracle knows the business expectation.
 */
export class CompositeTestOracle {
  constructor(private readonly oracles: readonly TestOracle[]) {}

  async evaluate(
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
  ): Promise<OracleVerdict> {
    const results: OracleResult[] = [];
    for (const oracle of this.oracles) {
      try {
        results.push(await oracle.evaluate(before, action, after, observations));
      } catch (error) {
        results.push({
          oracle: oracle.name,
          status: 'UNKNOWN',
          confidence: 0,
          reasons: [
            { code: 'oracle-error', message: error instanceof Error ? error.message : String(error) },
          ],
        });
      }
    }
    const pick = (status: OracleStatus): OracleResult[] => results.filter((entry) => entry.status === status);
    const failing = pick('FAIL');
    const warning = pick('WARNING');
    const passing = pick('PASS');
    const decisive = failing.length > 0 ? failing : warning.length > 0 ? warning : passing;
    const status: OracleStatus =
      failing.length > 0 ? 'FAIL' : warning.length > 0 ? 'WARNING' : passing.length > 0 ? 'PASS' : 'UNKNOWN';
    const confidence = decisive.length > 0 ? Math.max(...decisive.map((entry) => entry.confidence)) : 0;
    const reasons = decisive.flatMap((entry) =>
      entry.reasons.map((reason) => `${entry.oracle}: ${reason.message}`),
    );
    const mark = (entry: OracleResult, reason: OracleReason): string =>
      `${entry.status === 'PASS' ? '✓' : entry.status === 'UNKNOWN' ? '?' : '✗'} ${reason.message}`;
    const assertions = [
      ...results.flatMap((entry) => entry.reasons.map((reason) => mark(entry, reason))),
      // No business expectation is known without a SemanticOracle: say so.
      ...(results.some((entry) => entry.oracle === 'semantic') ? [] : ['? business result unknown']),
    ];
    return { status, confidence, reasons, results, assertions };
  }
}
