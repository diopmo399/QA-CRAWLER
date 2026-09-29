import { describeConfidence, type ConfidenceResult } from '../intelligence/confidence-engine.js';
import type { FlakinessResult } from '../intelligence/flakiness.js';
import { confidenceOf, type VerdictCategory } from '../oracles/confidence.js';
import type {
  ApiKnowledge,
  HistoricalExpectation,
  PerformanceKnowledge,
  TransitionKnowledge,
} from './knowledge-model.js';
import { median, percentile } from './statistics.js';

export interface ObservedTransition {
  fromStateSignature: string;
  actionSignature: string;
  toStateSignature: string;
}

export interface TransitionAnomaly {
  kind: 'UNEXPECTED_TRANSITION';
  /** Ce que l'historique attendait : une ATTENTE HISTORIQUE, jamais une attente métier. */
  expectation: HistoricalExpectation;
  observed: string;
  confidence: number;
  category: VerdictCategory;
  message: string;
  /** ConfidenceEngine (intelligence.confidence) : le détail de la confiance. */
  confidenceResult?: ConfidenceResult;
  /** Flaky detection (intelligence.flakyDetection) : le classement de l'historique. */
  flakiness?: FlakinessResult;
}

export interface TransitionAnomalyDetector {
  evaluate(observed: ObservedTransition, knowledge: TransitionKnowledge): TransitionAnomaly | null;
}

/** Écrans vers lesquels un écart ressemble à une régression (erreur, connexion perdue). */
const SUSPICIOUS_TARGET =
  /(error|erreur|not-found|introuvable|forbidden|interdit|login|connexion|sign-in|#{3})/;

/**
 * « Users --Créer--> Formulaire » 18 fois sur 19, et cette fois « Users --Créer--> Login » :
 * UNEXPECTED_TRANSITION. La cible dominante n'est qu'une attente HISTORIQUE — elle ne
 * devient jamais une règle métier. Vers un écran d'erreur ou de connexion, l'écart est
 * une POTENTIAL_REGRESSION ; sinon un UNEXPECTED_BEHAVIOR.
 */
export class HistoricalTransitionAnomalyDetector implements TransitionAnomalyDetector {
  constructor(
    private readonly options: {
      minObservations: number;
      dominance: number;
      /** ConfidenceEngine : confiance progressive et expliquée au lieu du barème fixe. */
      confidence?: (knowledge: TransitionKnowledge) => ConfidenceResult;
      /** Flaky detection : une transition historiquement instable qui change n'est pas une régression. */
      flakiness?: (knowledge: TransitionKnowledge) => FlakinessResult;
    },
  ) {}

  evaluate(observed: ObservedTransition, knowledge: TransitionKnowledge): TransitionAnomaly | null {
    const total = Object.values(knowledge.targets).reduce((sum, count) => sum + count, 0);
    if (total < this.options.minObservations) return null;
    const [target, count] = Object.entries(knowledge.targets).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!target || count === undefined) return null;
    const share = count / total;
    if (share < this.options.dominance || target === observed.toStateSignature) return null;
    // Une cible déjà vue plusieurs fois n'est pas inattendue, juste rare.
    if ((knowledge.targets[observed.toStateSignature] ?? 0) >= 2) return null;
    const engine = this.options.confidence?.(knowledge);
    const confidence = engine
      ? engine.score
      : Math.round(confidenceOf('repeated-history', total) * share * 100) / 100;
    // Une confiance faible ne suffit jamais à parler de régression potentielle.
    const suspicious =
      SUSPICIOUS_TARGET.test(observed.toStateSignature) &&
      (!engine || (engine.level !== 'VERY_LOW' && engine.level !== 'LOW'));
    // Historiquement instable : le changement est dans l'ordre des choses (WARNING), ou
    // indéchiffrable (UNKNOWN) — jamais une régression potentielle.
    const flaky = this.options.flakiness?.(knowledge);
    const category: VerdictCategory =
      flaky?.class === 'HIGHLY_UNSTABLE'
        ? 'UNKNOWN'
        : flaky?.class === 'UNSTABLE'
          ? 'UNEXPECTED_BEHAVIOR'
          : suspicious
            ? 'POTENTIAL_REGRESSION'
            : 'UNEXPECTED_BEHAVIOR';
    return {
      kind: 'UNEXPECTED_TRANSITION',
      expectation: { target, share: Math.round(share * 100) / 100, observations: total, confidence },
      observed: observed.toStateSignature,
      confidence,
      category,
      message: `historically "${observed.actionSignature}" led to "${target}" (${count}/${total}), this time to "${observed.toStateSignature}"${engine ? `; confidence ${describeConfidence(engine)}` : ''}${flaky && flaky.class !== 'UNKNOWN' ? `; history ${flaky.class} (${flaky.reason})` : ''}`,
      ...(engine ? { confidenceResult: engine } : {}),
      ...(flaky ? { flakiness: flaky } : {}),
    };
  }
}

/**
 * Statut d'API inhabituel : une famille de statuts (5xx, 4xx) jamais vue pour cette
 * opération alors qu'elle répond presque toujours 2xx. Un signal, pas un échec.
 */
export function apiStatusAnomaly(
  status: number,
  knowledge: ApiKnowledge | undefined,
  minObservations: number,
): { message: string; confidence: number } | undefined {
  if (!knowledge) return undefined;
  const total = Object.values(knowledge.statuses).reduce((sum, count) => sum + count, 0);
  if (total < minObservations) return undefined;
  const family = Math.floor(status / 100);
  const sameFamily = Object.entries(knowledge.statuses)
    .filter(([code]) => Math.floor(Number(code) / 100) === family)
    .reduce((sum, [, count]) => sum + count, 0);
  if (sameFamily > 0) return undefined;
  const usual = Object.entries(knowledge.statuses)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code} → ${count}`)
    .join(', ');
  return {
    message: `${knowledge.operation} answered ${status}; historically ${usual}`,
    confidence: confidenceOf('repeated-history', total),
  };
}

/**
 * PERFORMANCE_WARNING : une durée plus de `slowFactor` fois la médiane historique et
 * au-dessus du p95 (au moins 5 mesures). Jamais un échec à elle seule.
 */
export function performanceAnomaly(
  durationMs: number,
  knowledge: PerformanceKnowledge | undefined,
  slowFactor: number,
): { message: string; median: number; p95: number } | undefined {
  if (!knowledge || knowledge.durations.length < 5) return undefined;
  const typical = median(knowledge.durations);
  const high = percentile(knowledge.durations, 95);
  if (typical === undefined || high === undefined) return undefined;
  if (durationMs <= Math.max(typical * slowFactor, high) || durationMs < 200) return undefined;
  return {
    message: `${knowledge.kind} "${knowledge.key}" took ${Math.round(durationMs)} ms (median ${typical} ms, p95 ${high} ms)`,
    median: typical,
    p95: high,
  };
}
