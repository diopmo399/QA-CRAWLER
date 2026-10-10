import { round } from '../business/signals.js';
import {
  BUSINESS_ACTION_KINDS,
  type ActionIntent,
  type ActionReview,
  type ApplicationInteractionModel,
} from './model.js';

/**
 * LA REVUE HUMAINE DES INTERPRÉTATIONS — une extension du modèle de l'application, jamais un second
 * système d'intentions :
 *
 *   interprétation automatique (ActionView.interpretation, jamais modifiée)
 *     → revue humaine (une DÉCISION : corriger, confirmer, réinitialiser)
 *     → interprétation finale (ActionView.review.finalIntent, avec sa provenance)
 *
 * Les décisions forment un REGISTRE en ajout seul (human-review.json) : rien n'est effacé, une
 * réinitialisation est une décision de plus. La décision porte uniquement sur le SENS : l'action
 * enregistrée, sa cible, ses sélecteurs, le DOM, le réseau et le flow rejoué restent ceux du crawler.
 * Une décision humaine en vigueur l'emporte sur toute nouvelle analyse (règles ou IA), qui ne peut
 * plus être qu'une PROPOSITION.
 *
 * Générique : le sujet d'une décision a un genre (`ACTION_INTENT` aujourd'hui) ; corriger plus tard une
 * entité, un attribut, une identité ou une relation ajoutera un genre, pas un autre registre.
 */
export const HUMAN_REVIEW_FILE = 'human-review.json';

/** L'ordre d'autorité des interprétations : une décision humaine n'est jamais écrasée par l'analyse. */
export const INTERPRETATION_AUTHORITY = [
  'HUMAN_CONFIRMED',
  'HUMAN_CORRECTED',
  'DETERMINISTIC_INFERENCE',
  'AI_INFERENCE',
  'UNKNOWN',
] as const;

/** Les intentions qu'une revue peut choisir : la liste du modèle, plus UNKNOWN. */
export const REVIEWABLE_INTENTS: readonly ActionIntent[] = [...BUSINESS_ACTION_KINDS, 'UNKNOWN'];

export type HumanDecisionType = 'CORRECT' | 'CONFIRM' | 'RESET';

/**
 * Ce qu'une décision peut viser. Seule l'INTENTION d'action est corrigeable aujourd'hui ; les autres
 * genres sont réservés (entité, attribut, identité, correspondance, relation, classification) : ils
 * passeront par le même registre.
 */
export type ReviewSubjectKind =
  | 'ACTION_INTENT'
  | 'BUSINESS_ENTITY'
  | 'BUSINESS_ATTRIBUTE'
  | 'IDENTITY_CANDIDATE'
  | 'SEMANTIC_MAPPING'
  | 'RELATIONSHIP'
  | 'ACTION_CLASSIFICATION';

/** Où la décision a été prise : de quoi la retrouver, jamais une règle globale. */
export interface DecisionContext {
  page?: string;
  element?: string;
  role?: string;
  label?: string;
  selector?: string;
  /** L'étape métier où l'action a été regroupée (Créer, Rechercher…), si elle existe. */
  businessStep?: string;
}

export interface HumanDecision {
  id: string;
  subject: { kind: ReviewSubjectKind; actionId: string; stepIds: string[] };
  type: HumanDecisionType;
  /** L'intention FINALE juste avant la décision. */
  previousIntent: ActionIntent[];
  /** L'intention après la décision (RESET : l'interprétation automatique rétablie). */
  newIntent: ActionIntent[];
  /** L'interprétation automatique au moment de la décision, et sa confiance. */
  systemIntent: ActionIntent[];
  systemConfidence?: number;
  reason?: string;
  at: string;
  context: DecisionContext;
}

export interface HumanReviewLedger {
  version: 1;
  recordingSessionId?: string;
  decisions: HumanDecision[];
}

export function emptyLedger(recordingSessionId?: string): HumanReviewLedger {
  return { version: 1, ...(recordingSessionId ? { recordingSessionId } : {}), decisions: [] };
}

/**
 * Ajoute une décision au registre (jamais une réécriture). Refusée sans effet si l'action est
 * inconnue, l'intention hors de la liste, ou une réinitialisation sans décision à réinitialiser.
 */
export function recordIntentDecision(
  ledger: HumanReviewLedger,
  model: ApplicationInteractionModel,
  input: {
    actionId: string;
    type: HumanDecisionType;
    intent?: string;
    reason?: string;
    at?: string;
    context?: DecisionContext;
  },
): { decision: HumanDecision } | { error: string } {
  const view = model.actions.find((action) => action.actionId === input.actionId);
  if (!view) return { error: `unknown action ${input.actionId}` };
  const current = finalOf(view.interpretation, ledger, input.actionId);
  let newIntent: ActionIntent[];
  if (input.type === 'CORRECT') {
    const intent = REVIEWABLE_INTENTS.find((candidate) => candidate === input.intent);
    if (!intent)
      return {
        error: `unknown intent ${String(input.intent)}: choose one of ${REVIEWABLE_INTENTS.join(', ')}`,
      };
    newIntent = [intent];
  } else if (input.type === 'CONFIRM') newIntent = current;
  else {
    if (!activeDecision(ledger, input.actionId))
      return { error: 'nothing to reset: no human decision in force' };
    newIntent = view.interpretation;
  }
  const reason = input.reason?.trim().slice(0, 500);
  const decision: HumanDecision = {
    id: `hd${String(ledger.decisions.length + 1)}`,
    subject: { kind: 'ACTION_INTENT', actionId: input.actionId, stepIds: view.stepIds },
    type: input.type,
    previousIntent: current,
    newIntent,
    systemIntent: [...view.interpretation],
    ...(view.confidence !== undefined ? { systemConfidence: view.confidence } : {}),
    ...(reason ? { reason } : {}),
    at: input.at ?? new Date().toISOString(),
    context: input.context ?? {},
  };
  ledger.decisions.push(decision);
  return { decision };
}

/**
 * Applique le registre au modèle (à chaque écriture, même après une nouvelle analyse) : chaque action
 * reçoit son interprétation revue, chaque décision devient une PREUVE humaine. L'interprétation
 * automatique (interpretation, confidence) n'est jamais touchée.
 */
export function applyHumanReview(
  model: ApplicationInteractionModel,
  ledger: HumanReviewLedger | undefined,
  options: { aiAnalysis?: boolean } = {},
): ApplicationInteractionModel {
  model.evidence = model.evidence.filter((entry) => entry.source !== 'HUMAN');
  for (const view of model.actions) {
    delete view.review;
    const decisions = (ledger?.decisions ?? []).filter(
      (decision) => decision.subject.kind === 'ACTION_INTENT' && decision.subject.actionId === view.actionId,
    );
    if (decisions.length === 0) continue;
    const first = decisions[0];
    const active = activeDecision(ledger, view.actionId);
    const original = first?.systemIntent ?? view.interpretation;
    const finalIntent = active ? active.newIntent : view.interpretation;
    const review: ActionReview = {
      status: !active ? 'INFERRED' : active.type === 'CONFIRM' ? 'HUMAN_CONFIRMED' : 'HUMAN_CORRECTED',
      source: active ? 'HUMAN' : 'SYSTEM',
      finalIntent: finalIntent[0] ?? 'UNKNOWN',
      originalIntent: [...original],
      ...(first?.systemConfidence !== undefined ? { originalConfidence: round(first.systemConfidence) } : {}),
      ...(active
        ? {
            correction: {
              decisionId: active.id,
              intent: active.newIntent[0] ?? 'UNKNOWN',
              ...(active.reason ? { reason: active.reason } : {}),
              at: active.at,
            },
          }
        : {}),
      history: [
        { at: first?.at ?? '', source: 'SYSTEM', intent: [...original] },
        ...decisions.map((decision) => ({
          at: decision.at,
          source: decision.type === 'RESET' ? ('RESET' as const) : ('HUMAN' as const),
          intent: [...decision.newIntent],
          ...(decision.reason ? { reason: decision.reason } : {}),
        })),
      ],
    };
    // Une NOUVELLE analyse dit autre chose qu'une décision en vigueur : une proposition, jamais un écrasement.
    if (active && !same(view.interpretation, active.newIntent) && !same(view.interpretation, original))
      review.proposal = {
        intent: [...view.interpretation],
        source: options.aiAnalysis ? 'AI_PROPOSAL' : 'SYSTEM',
      };
    view.review = review;
    for (const decision of decisions)
      model.evidence.push({
        id: `human:${decision.id}`,
        source: 'HUMAN',
        kind:
          decision.type === 'CORRECT'
            ? 'INTENT_CORRECTION'
            : decision.type === 'CONFIRM'
              ? 'INTENT_CONFIRMATION'
              : 'INTENT_RESET',
        description: `${decision.type} ${decision.previousIntent.join('+')} → ${decision.newIntent.join('+')}${decision.reason ? ` (${decision.reason})` : ''}`,
        actionIds: [view.actionId],
        rawEventIds: [],
        stateIds: [],
      });
  }
  model.summary.actions.humanCorrected = model.actions.filter(
    (view) => view.review?.status === 'HUMAN_CORRECTED',
  ).length;
  model.summary.actions.humanConfirmed = model.actions.filter(
    (view) => view.review?.status === 'HUMAN_CONFIRMED',
  ).length;
  return model;
}

/** L'intention finale d'une action : la décision humaine en vigueur, sinon l'interprétation automatique. */
export function finalIntentOf(
  model: ApplicationInteractionModel,
  actionId: string,
): { intent: ActionIntent[]; source: 'SYSTEM' | 'HUMAN'; status: ActionReview['status'] } | undefined {
  const view = model.actions.find((action) => action.actionId === actionId);
  if (!view) return undefined;
  return view.review && view.review.source === 'HUMAN'
    ? { intent: [view.review.finalIntent], source: 'HUMAN', status: view.review.status }
    : { intent: view.interpretation, source: 'SYSTEM', status: 'INFERRED' };
}

/** La décision en vigueur (la dernière, sauf si c'est une réinitialisation). */
function activeDecision(ledger: HumanReviewLedger | undefined, actionId: string): HumanDecision | undefined {
  const last = (ledger?.decisions ?? [])
    .filter((decision) => decision.subject.kind === 'ACTION_INTENT' && decision.subject.actionId === actionId)
    .at(-1);
  return last && last.type !== 'RESET' ? last : undefined;
}

function finalOf(
  interpretation: ActionIntent[],
  ledger: HumanReviewLedger,
  actionId: string,
): ActionIntent[] {
  return activeDecision(ledger, actionId)?.newIntent ?? interpretation;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}
