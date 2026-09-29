import type { ConfidenceEngine } from '../../intelligence/confidence-engine.js';
import { ageInDays } from '../../intelligence/knowledge-aging.js';
import type { KnowledgeContext } from '../../intelligence/knowledge-context.js';
import type { KnowledgeBase, TransitionKnowledge } from '../../knowledge/knowledge-model.js';
import type { HistoricalSignal, SemanticHistory } from './semantic-history.js';

/**
 * LA MÉMOIRE DES RÉSOLUTIONS, sans nouvelle table ni nouveau stockage : une résolution
 * est une transition de connaissance
 *
 *   écran (signature) —intent:fill:courriel→ cible (signature sémantique)
 *
 * enregistrée dans la KnowledgeBase en mémoire (fichier de connaissance, ou
 * transition_knowledge via le KnowledgeService et la persistance). Un échec est noté
 * vers « !cible ». Le préfixe « intent: » ne correspond à aucune action réelle : ces
 * entrées ne se mélangent jamais aux transitions de l'exploration.
 */
export const SEMANTIC_ACTION_PREFIX = 'intent:';
const FAILED_PREFIX = '!';

/** Les issues d'une résolution, telles que l'ExplorationListener les transmet. */
export const SEMANTIC_OUTCOMES = ['SUCCEEDED', 'FAILED', 'AMBIGUOUS', 'NOT_FOUND', 'BLOCKED'] as const;
export type SemanticOutcome = (typeof SEMANTIC_OUTCOMES)[number];

/**
 * SEMANTIC_RESOLUTION_SUCCEEDED / FAILED / AMBIGUOUS : ce qui est su d'une résolution.
 * Jamais une valeur saisie : l'intention, les libellés de l'écran, les scores.
 */
export interface SemanticResolutionEvent {
  at: string;
  flow: string;
  stateId: string;
  stateSignature: string;
  intentKey: string;
  intent: string;
  outcome: SemanticOutcome;
  /** La cible (signature sémantique), quand elle a été résolue. */
  targetSignature?: string;
  selected?: string;
  score: number;
  confidence: string;
  candidates: { label: string; score: number }[];
  reason?: string;
}

export function isSemanticSignature(actionSignature: string): boolean {
  return actionSignature.startsWith(SEMANTIC_ACTION_PREFIX);
}

/** Ce qu'un événement apprend à la KnowledgeBase (en mémoire) : réussites et échecs par cible. */
export function learnFrom(knowledge: KnowledgeBase, event: SemanticResolutionEvent): void {
  if (!event.targetSignature) return;
  if (event.outcome !== 'SUCCEEDED' && event.outcome !== 'FAILED') return;
  knowledge.recordTransition({
    fromStateSignature: event.stateSignature,
    actionSignature: `${SEMANTIC_ACTION_PREFIX}${event.intentKey}`,
    toStateSignature:
      event.outcome === 'SUCCEEDED' ? event.targetSignature : `${FAILED_PREFIX}${event.targetSignature}`,
    success: event.outcome === 'SUCCEEDED',
    at: event.at,
  });
}

/**
 * La transition de connaissance d'un événement, pour le KnowledgeService et la
 * persistance (transition_knowledge). Réussite ou échec, c'est une OBSERVATION vers une
 * destination — « cible » ou « !cible » — : le préchargement retrouve ainsi les deux
 * comptes par cible (une ligne par destination), sans nouvelle colonne.
 */
export function observationOf(event: SemanticResolutionEvent):
  | {
      fromStateSignature: string;
      actionSignature: string;
      toStateSignature: string;
      result: 'SUCCESS';
      at: string;
    }
  | undefined {
  if (!event.targetSignature || (event.outcome !== 'SUCCEEDED' && event.outcome !== 'FAILED'))
    return undefined;
  return {
    fromStateSignature: event.stateSignature,
    actionSignature: `${SEMANTIC_ACTION_PREFIX}${event.intentKey}`,
    toStateSignature:
      event.outcome === 'SUCCEEDED' ? event.targetSignature : `${FAILED_PREFIX}${event.targetSignature}`,
    result: 'SUCCESS',
    at: event.at,
  };
}

/**
 * L'HISTORIQUE vu par le resolver, calculé par le ConfidenceEngine (le même que pour les
 * transitions : échantillon × stabilité × récence × contexte) :
 *
 *   147 réussites / 148  → confiance ≈ 0,96   (signal fort, mais borné à +15 points)
 *   1 réussite / 1       → confiance ≈ 0,17   (signal faible)
 *
 * Une cible disparue du DOM n'a plus de candidat : l'historique ne fige rien.
 */
export class KnowledgeSemanticHistory implements SemanticHistory {
  constructor(
    private readonly knowledge: KnowledgeBase,
    private readonly stateSignature: string,
    private readonly engine: ConfidenceEngine,
    private readonly context: KnowledgeContext,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  signalFor(intentKey: string, targetSignature: string): HistoricalSignal | undefined {
    const entry = this.knowledge.getTransitionKnowledge(
      this.stateSignature,
      `${SEMANTIC_ACTION_PREFIX}${intentKey}`,
    );
    if (!entry) return undefined;
    const successes = entry.targets[targetSignature] ?? 0;
    const failures = entry.targets[`${FAILED_PREFIX}${targetSignature}`] ?? 0;
    if (successes + failures === 0) return undefined;
    const view: TransitionKnowledge = {
      ...entry,
      targets: successes > 0 ? { [targetSignature]: successes } : {},
      executionCount: successes + failures,
      successCount: successes,
      failureCount: failures,
    };
    const confidence = this.engine.evaluate(view, this.context);
    const age = Math.floor(ageInDays(entry.lastSeenAt, this.now()));
    return {
      confidence: confidence.score,
      successes,
      failures,
      detail: `${successes}/${successes + failures} successful, ${age < 1 ? 'seen today' : `last seen ${age} day(s) ago`}, confidence ${confidence.score} ${confidence.level}`,
    };
  }
}
