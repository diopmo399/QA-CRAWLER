import type { PageContext } from '../model/page-context.js';
import { categoryOf, type VerdictCategory } from './confidence.js';
import type {
  ActionObservations,
  ExecutedAction,
  OracleReason,
  OracleResult,
  OracleStatus,
  TestOracle,
} from './oracle.js';

/** Le verdict sur une action exécutée : l'avis de chaque oracle, et un résumé. */
export interface OracleVerdict {
  /**
   * FAIL si un oracle a échoué, sinon WARNING si l'un a averti, sinon PASS si au
   * moins un oracle a réussi ; UNKNOWN quand aucun oracle n'a pu dire. Les avis UNKNOWN
   * (résultat métier, baseline sans cette transition…) ne comptent jamais comme PASS.
   */
  status: OracleStatus;
  confidence: number;
  reasons: string[];
  results: OracleResult[];
  /** Assertions observées : "✓ no HTTP 5xx", "✗ POST /api/users returned HTTP 500", "? business result unknown". */
  assertions: string[];
  /**
   * Catégories des avis décisifs (CONFIRMED_FAILURE, CONTRACT_VIOLATION,
   * INVARIANT_VIOLATION, POTENTIAL_REGRESSION, UNEXPECTED_BEHAVIOR, UNKNOWN), la plus grave d'abord.
   */
  categories: VerdictCategory[];
}

/**
 * Agrège plusieurs oracles (technique, écran, baseline, contrat, et tout
 * SemanticOracle ajouté plus tard). Le résultat métier reste UNKNOWN sauf si un
 * oracle connaît l'attente métier.
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
        const judged = await oracle.evaluate(before, action, after, observations);
        const category = judged.category ?? categoryOf(judged.oracle, judged.status);
        results.push(category ? { ...judged, category } : judged);
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
      // Aucune attente métier n'est connue sans SemanticOracle : on le dit.
      ...(results.some((entry) => entry.oracle === 'semantic') ? [] : ['? business result unknown']),
    ];
    const order: readonly VerdictCategory[] = [
      'CONFIRMED_FAILURE',
      'INVARIANT_VIOLATION',
      'CONTRACT_VIOLATION',
      'POTENTIAL_REGRESSION',
      'UNEXPECTED_BEHAVIOR',
      'UNKNOWN',
    ];
    const categories = [
      ...new Set(
        decisive.map((entry) => entry.category).filter((entry): entry is VerdictCategory => !!entry),
      ),
    ].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return { status, confidence, reasons, results, assertions, categories };
  }
}
