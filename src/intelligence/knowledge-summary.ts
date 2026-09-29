import type { TransitionKnowledge } from '../knowledge/knowledge-model.js';
import {
  CONFIDENCE_LEVELS,
  type ConfidenceEngine,
  type ConfidenceLevel,
  type ConfidenceResult,
} from './confidence-engine.js';
import type { FlakinessClass } from './flakiness.js';
import type { KnowledgeContext } from './knowledge-context.js';

/** Une connaissance de transition évaluée : ce qu'on sait, et à quel point on peut s'y fier. */
export interface EvaluatedKnowledge {
  fromStateSignature: string;
  actionSignature: string;
  /** Destination dominante et sa part (une probabilité historique, pas une certitude). */
  dominantTarget?: string;
  dominantShare: number;
  lastSeenAt: string;
  confidence: ConfidenceResult;
}

/** Ce que le rapport montre de la connaissance historique. */
export interface HistoricalKnowledgeSummary {
  /** Le contexte courant auquel chaque connaissance a été comparée. */
  context: KnowledgeContext;
  transitions: number;
  levels: Record<ConfidenceLevel, number>;
  /** Connaissances dont le poids de récence est tombé sous 0,5 (vieillies, jamais supprimées). */
  aged: number;
  /** Connaissances vues dans un contexte différent du contexte courant. */
  otherContext: number;
  /** Les plus observées, avec le détail de leur confiance. */
  entries: EvaluatedKnowledge[];
  /** Flaky detection : la répartition STABLE … HIGHLY_UNSTABLE, UNKNOWN. */
  flakiness?: Record<FlakinessClass, number>;
}

/**
 * Évalue toute la connaissance de transitions de la mémoire de travail. Aucune requête
 * au stockage : la mémoire de travail est déjà en RAM.
 */
export function summarizeKnowledge(
  transitions: readonly TransitionKnowledge[],
  engine: ConfidenceEngine,
  context: KnowledgeContext,
  limit = 15,
): HistoricalKnowledgeSummary {
  const levels = Object.fromEntries(CONFIDENCE_LEVELS.map((level) => [level, 0])) as Record<
    ConfidenceLevel,
    number
  >;
  let aged = 0;
  let otherContext = 0;
  const evaluated = transitions.map((knowledge): EvaluatedKnowledge => {
    const confidence = engine.evaluate(knowledge, context);
    levels[confidence.level] += 1;
    if ((confidence.reasons.find((reason) => reason.factor === 'recency')?.value ?? 1) < 0.5) aged += 1;
    if ((confidence.reasons.find((reason) => reason.factor === 'context')?.value ?? 1) < 1) otherContext += 1;
    const [dominantTarget, count] = Object.entries(knowledge.targets).sort((a, b) => b[1] - a[1])[0] ?? [];
    return {
      fromStateSignature: knowledge.fromStateSignature,
      actionSignature: knowledge.actionSignature,
      ...(dominantTarget ? { dominantTarget } : {}),
      dominantShare:
        confidence.observations > 0 ? Math.round(((count ?? 0) / confidence.observations) * 1000) / 1000 : 0,
      lastSeenAt: knowledge.lastSeenAt,
      confidence,
    };
  });
  return {
    context,
    transitions: transitions.length,
    levels,
    aged,
    otherContext,
    entries: evaluated
      .sort(
        (a, b) =>
          b.confidence.observations - a.confidence.observations ||
          `${a.fromStateSignature}${a.actionSignature}`.localeCompare(
            `${b.fromStateSignature}${b.actionSignature}`,
          ),
      )
      .slice(0, limit),
  };
}
