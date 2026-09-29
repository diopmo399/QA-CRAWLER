import { routeKey } from '../crawler/route-normalizer.js';
import {
  apiStatusAnomaly,
  HistoricalTransitionAnomalyDetector,
  performanceAnomaly,
  type TransitionAnomalyDetector,
} from '../knowledge/historical-detectors.js';
import type { KnowledgeBase, TransitionKnowledge } from '../knowledge/knowledge-model.js';
import type { ConfidenceResult } from '../intelligence/confidence-engine.js';
import { actionSignature, stateSignature } from '../knowledge/signatures.js';
import type { PageContext } from '../model/page-context.js';
import {
  result,
  type ActionObservations,
  type ExecutedAction,
  type OracleReason,
  type OracleResult,
  type TestOracle,
} from './oracle.js';

export interface HistoricalOracleOptions {
  minObservations: number;
  dominance: number;
  slowFactor: number;
  /** ConfidenceEngine (intelligence.confidence) ; absent : le barème d'avant. */
  confidence?: (knowledge: TransitionKnowledge) => ConfidenceResult;
}

/**
 * Compare l'action à ce que la KnowledgeBase a appris des runs précédents :
 * transition inattendue, statut d'API jamais vu pour cette opération, lenteur
 * inhabituelle (PERFORMANCE_WARNING). Ne répond jamais FAIL : l'historique n'est pas
 * une règle métier. WARNING (catégorie UNEXPECTED_BEHAVIOR ou POTENTIAL_REGRESSION),
 * sinon PASS quand l'historique confirme, UNKNOWN quand il n'y a pas d'historique.
 * Doit être appelé AVANT que l'action soit enregistrée dans la KnowledgeBase.
 */
export class HistoricalOracle implements TestOracle {
  readonly name = 'historical';
  private readonly transitions: TransitionAnomalyDetector;

  constructor(
    private readonly knowledge: KnowledgeBase,
    private readonly options: HistoricalOracleOptions,
    private readonly queryParamMode: 'pattern' | 'ignore' | 'keep' = 'pattern',
  ) {
    this.transitions = new HistoricalTransitionAnomalyDetector(options);
  }

  evaluate(
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
  ): Promise<OracleResult> {
    const warnings: OracleReason[] = [];
    const confirmations: OracleReason[] = [];
    let confidence = 0;
    let category: OracleResult['category'];
    const signature = actionSignature({ ...action, elementType: '' });
    const from = stateSignature(before.stateLabel);
    if (after && action.result === 'SUCCESS') {
      const history = this.knowledge.getTransitionKnowledge(from, signature);
      const anomaly = history
        ? this.transitions.evaluate(
            {
              fromStateSignature: from,
              actionSignature: signature,
              toStateSignature: stateSignature(after.stateLabel),
            },
            history,
          )
        : null;
      if (anomaly) {
        warnings.push({
          code: 'unexpected-transition',
          message: `UNEXPECTED_TRANSITION: ${anomaly.message}`,
        });
        confidence = Math.max(confidence, anomaly.confidence);
        category = anomaly.category;
      } else {
        const expected = this.knowledge.expectationFor(from, signature);
        if (expected && expected.target === stateSignature(after.stateLabel))
          confirmations.push({
            code: 'historical-expectation',
            message: `historical expectation met: "${expected.target}" (${Math.round(expected.share * 100)} % of ${expected.observations})`,
          });
      }
    }
    for (const exchange of observations.network) {
      if (exchange.status === undefined || exchange.resourceType === 'document') continue;
      const operation = apiOperation(exchange.method, exchange.url, this.queryParamMode);
      const unusual = apiStatusAnomaly(
        exchange.status,
        this.knowledge.getApiKnowledge(operation),
        this.options.minObservations,
      );
      if (unusual) {
        warnings.push({ code: 'unusual-status', message: `unusual API status: ${unusual.message}` });
        confidence = Math.max(confidence, unusual.confidence);
        category ??= exchange.status >= 500 ? 'POTENTIAL_REGRESSION' : 'UNEXPECTED_BEHAVIOR';
      }
      if (exchange.durationMs !== undefined) {
        const slow = performanceAnomaly(
          exchange.durationMs,
          this.knowledge.getPerformance('request', operation),
          this.options.slowFactor,
        );
        if (slow)
          warnings.push({ code: 'performance-warning', message: `PERFORMANCE_WARNING: ${slow.message}` });
      }
    }
    if (action.durationMs !== undefined) {
      const slow = performanceAnomaly(
        action.durationMs,
        this.knowledge.getPerformance('action', signature),
        this.options.slowFactor,
      );
      if (slow)
        warnings.push({ code: 'performance-warning', message: `PERFORMANCE_WARNING: ${slow.message}` });
    }
    if (warnings.length > 0) {
      const judged = result(this.name, 'WARNING', confidence || 0.4, warnings);
      return Promise.resolve({
        ...judged,
        confidenceSource: 'repeated-history',
        category: category ?? 'UNEXPECTED_BEHAVIOR',
      });
    }
    if (confirmations.length > 0)
      return Promise.resolve({
        ...result(this.name, 'PASS', 0.6, confirmations),
        confidenceSource: 'repeated-history',
      });
    return Promise.resolve(result(this.name, 'UNKNOWN', 0, []));
  }
}

/** « POST /api/users/:id » : méthode + modèle de chemin, jamais la requête elle-même. */
export function apiOperation(
  method: string,
  url: string,
  mode: 'pattern' | 'ignore' | 'keep' = 'pattern',
): string {
  try {
    return `${method.toUpperCase()} ${routeKey(url, mode).replace(/\?.*$/, '')}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}
