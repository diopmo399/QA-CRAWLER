import { proposedActionOf } from './decision-confidence.js';
import type { ArbiterDecision } from './hybrid-arbiter.js';
import type { IntelligenceMode } from './model.js';
import type { ProposalValidation } from './proposal-validator.js';

/**
 * AI DECISION LIFECYCLE — chaque intervention de l'intelligence a UNE issue, et une seule.
 *
 *   TRIGGER → CONTEXT → CALL → RAW RESULT → PARSED PROPOSAL → VALIDATION → ARBITRATION
 *   → DECISION → (EXECUTION) → RUNTIME VERIFICATION → KNOWLEDGE UPDATE
 *
 * Les dimensions sont SÉPARÉES et ne se mélangent jamais :
 * - `response` : ce que le fournisseur a rendu (ou pourquoi il n'a pas été appelé) — une
 *   partition des enregistrements ; sur les appels réels, la somme vaut le nombre d'appels ;
 * - `terminal` : l'issue principale de la décision (ACCEPTED, SHADOW_ONLY, SAFETY_REJECTED…) ;
 * - `shadowResult` (ASSIST) : la proposition comparée à la décision déterministe ;
 * - `fallbackReason` : un chemin IA ATTENDU n'a pas pu servir (jamais « parce qu'ASSIST ») ;
 * - `notExecutedReason` : pourquoi la proposition n'a pas été exécutée (ASSIST_MODE en fait partie) ;
 * - `runtime` : ce que le runtime a dit de la proposition exécutée.
 */

export const AI_RESPONSE_STATUSES = [
  'PROPOSAL',
  'INCONCLUSIVE',
  'NEED_MORE_EVIDENCE',
  'INVALID_RESPONSE',
  'TIMEOUT',
  'ERROR',
  'UNAVAILABLE',
  'BUDGET_EXHAUSTED',
  'NO_LLM_REQUIRED',
] as const;
export type AiResponseStatus = (typeof AI_RESPONSE_STATUSES)[number];

/** Les réponses qui supposent un appel réel au fournisseur. */
export const CALL_RESPONSES: readonly AiResponseStatus[] = [
  'PROPOSAL',
  'INCONCLUSIVE',
  'NEED_MORE_EVIDENCE',
  'INVALID_RESPONSE',
  'TIMEOUT',
  'ERROR',
];

export const AI_TERMINAL_RESULTS = [
  'PROPOSAL',
  'INCONCLUSIVE',
  'NEED_MORE_EVIDENCE',
  'INVALID_RESPONSE',
  'VALIDATION_REJECTED',
  'SAFETY_REJECTED',
  'SHADOW_ONLY',
  'ACCEPTED',
  'TIMEOUT',
  'UNAVAILABLE',
  'BUDGET_EXHAUSTED',
  'ERROR',
  'NO_LLM_REQUIRED',
] as const;
export type AiTerminalResult = (typeof AI_TERMINAL_RESULTS)[number];

/** SHADOW DECISION RESULT (ASSIST) : la proposition face à la décision déterministe. */
export const SHADOW_RESULTS = [
  'AGREEMENT',
  'DISAGREEMENT',
  'AI_INCONCLUSIVE',
  'DETERMINISTIC_ONLY',
  'AI_ONLY_CANDIDATE',
] as const;
export type ShadowDecisionResult = (typeof SHADOW_RESULTS)[number];

/** AI FALLBACK REASON : pourquoi le chemin IA attendu n'a pas servi. ASSIST n'en est jamais une. */
export const AI_FALLBACK_REASONS = [
  'AI_INCONCLUSIVE',
  'AI_NEED_MORE_EVIDENCE',
  'AI_TIMEOUT',
  'AI_UNAVAILABLE',
  'AI_ERROR',
  'INVALID_PROPOSAL',
  'UNKNOWN_ACTION',
  'INVALID_EVIDENCE',
  'SAFETY_BLOCKED',
  'BUDGET_EXHAUSTED',
  'MODEL_UNAVAILABLE',
  'LOW_AI_CONFIDENCE',
  'DETERMINISTIC_PRIORITY',
  'NO_USEFUL_PROPOSAL',
] as const;
export type AiFallbackReason = (typeof AI_FALLBACK_REASONS)[number];

/** Pourquoi une proposition n'a pas été exécutée (une raison d'exécution, pas forcément un repli). */
export const NOT_EXECUTED_REASONS = [
  'ASSIST_MODE',
  'ADVISORY_ONLY',
  'NO_ACTION_PROPOSED',
  'PROPOSAL_INVALID',
  'SAFETY_BLOCKED',
  'DETERMINISTIC_PRIORITY',
  'LOW_AI_CONFIDENCE',
  'NO_RESPONSE',
  'EXECUTOR_CHOSE_OTHER',
] as const;
export type NotExecutedReason = (typeof NOT_EXECUTED_REASONS)[number];

/** Une intervention sans réponse exploitable : la cause, telle que la passerelle l'a vue. */
export type AiCallFailure =
  'TIMEOUT' | 'ERROR' | 'UNAVAILABLE' | 'MODEL_UNAVAILABLE' | 'BUDGET_EXHAUSTED' | 'NO_LLM_REQUIRED';

export type AiExecution = 'EXECUTED' | 'NOT_EXECUTED' | 'PENDING';
export type AiRuntimeVerification = 'CONFIRMED' | 'CONTRADICTED' | 'NOT_APPLICABLE' | 'PENDING';

/** Ce que la décision a apporté à la connaissance (toujours une hypothèse, jamais une vérité). */
export interface AiKnowledgeImpact {
  impact: 'NONE' | 'AI_PROPOSED_HYPOTHESIS' | 'RUNTIME_SUPPORTED' | 'RUNTIME_CONTRADICTED';
  hypothesisId?: string;
  hypothesisStatus?: string;
}

/** L'objectif avant / après l'action proposée (GoalProgressEvaluator). */
export interface AiGoalProgress {
  goal: string;
  before: number;
  after?: number;
  impact?: 'ADVANCED' | 'NO_CHANGE' | 'REGRESSED';
}

export interface AiDecisionLifecycle {
  /** Le fournisseur a-t-il réellement été interrogé ? */
  call: boolean;
  response: AiResponseStatus;
  terminal: AiTerminalResult;
  /** La réponse a passé la validation (schéma, actions découvertes, preuves existantes). */
  proposalValid?: boolean;
  /** La proposition a été retenue POUR EXÉCUTION (jamais en ASSIST). */
  acceptedForExecution: boolean;
  notExecutedReason?: NotExecutedReason;
  shadowResult?: ShadowDecisionResult;
  fallbackReason?: AiFallbackReason;
  execution: AiExecution;
  runtime: AiRuntimeVerification;
  knowledge: AiKnowledgeImpact;
  goalProgress?: AiGoalProgress;
}

export interface ClassifyInput {
  mode: IntelligenceMode;
  /** Une analyse (échec, blocage, enregistrement) : aucune exécution n'est attendue. */
  advisory: boolean;
  deterministicActionId?: string;
  failure?: AiCallFailure;
  validation?: ProposalValidation;
  decision?: ArbiterDecision;
}

const FAILURE_RESPONSE: Record<AiCallFailure, AiResponseStatus> = {
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
  UNAVAILABLE: 'UNAVAILABLE',
  MODEL_UNAVAILABLE: 'UNAVAILABLE',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  NO_LLM_REQUIRED: 'NO_LLM_REQUIRED',
};

const FAILURE_FALLBACK: Record<AiCallFailure, AiFallbackReason | undefined> = {
  TIMEOUT: 'AI_TIMEOUT',
  ERROR: 'AI_ERROR',
  UNAVAILABLE: 'AI_UNAVAILABLE',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  // Raisonnement trivial : aucun chemin IA n'était attendu.
  NO_LLM_REQUIRED: undefined,
};

/**
 * La classification d'une intervention : UNE réponse, UNE issue, et les dimensions secondaires
 * (validation, shadow, repli, exécution). Fonction pure : la même entrée donne la même issue.
 */
export function classifyDecision(input: ClassifyInput): AiDecisionLifecycle {
  const assist = input.mode === 'ASSIST';
  const deterministic = input.deterministicActionId;
  const base = (
    fields: Omit<AiDecisionLifecycle, 'acceptedForExecution' | 'execution' | 'runtime' | 'knowledge'> &
      Partial<Pick<AiDecisionLifecycle, 'acceptedForExecution' | 'execution' | 'runtime'>>,
  ): AiDecisionLifecycle => ({
    acceptedForExecution: false,
    execution: 'NOT_EXECUTED',
    runtime: 'NOT_APPLICABLE',
    knowledge: { impact: 'NONE' },
    ...fields,
  });
  // Pas de réponse exploitable : la décision déterministe seule a pu servir.
  const noAiShadow = (call: boolean): ShadowDecisionResult | undefined =>
    assist && call && !input.advisory
      ? deterministic
        ? 'DETERMINISTIC_ONLY'
        : 'AI_INCONCLUSIVE'
      : undefined;

  if (input.failure) {
    const response = FAILURE_RESPONSE[input.failure];
    const call = CALL_RESPONSES.includes(response);
    const fallback = FAILURE_FALLBACK[input.failure];
    const shadow = noAiShadow(call);
    return base({
      call,
      response,
      terminal: response,
      notExecutedReason: 'NO_RESPONSE',
      ...(shadow ? { shadowResult: shadow } : {}),
      ...(fallback ? { fallbackReason: fallback } : {}),
    });
  }

  const validation = input.validation;
  if (!validation)
    return base({ call: true, response: 'ERROR', terminal: 'ERROR', fallbackReason: 'AI_ERROR' });
  if (!validation.valid) {
    const schema = validation.rejection === 'AI_PROPOSAL_INVALID_SCHEMA';
    const response: AiResponseStatus = schema
      ? 'INVALID_RESPONSE'
      : (validation.proposal?.status ?? 'PROPOSAL');
    const fallback: AiFallbackReason =
      validation.rejection === 'AI_PROPOSAL_UNKNOWN_ACTION' ||
      validation.rejection === 'AI_PROPOSAL_INCOMPATIBLE'
        ? 'UNKNOWN_ACTION'
        : validation.rejection === 'AI_PROPOSAL_INVALID_EVIDENCE'
          ? 'INVALID_EVIDENCE'
          : 'INVALID_PROPOSAL';
    const shadow = noAiShadow(true);
    return base({
      call: true,
      response,
      terminal: schema ? 'INVALID_RESPONSE' : 'VALIDATION_REJECTED',
      proposalValid: false,
      notExecutedReason: 'PROPOSAL_INVALID',
      fallbackReason: fallback,
      ...(shadow ? { shadowResult: shadow } : {}),
    });
  }

  const proposal = validation.proposal;
  if (proposal.status !== 'PROPOSAL') {
    const inconclusive = proposal.status === 'INCONCLUSIVE';
    return base({
      call: true,
      response: proposal.status,
      terminal: proposal.status,
      proposalValid: true,
      notExecutedReason: 'NO_ACTION_PROPOSED',
      fallbackReason: inconclusive ? 'AI_INCONCLUSIVE' : 'AI_NEED_MORE_EVIDENCE',
      ...(assist && !input.advisory ? { shadowResult: 'AI_INCONCLUSIVE' as const } : {}),
    });
  }

  const proposed = proposedActionOf(proposal);
  const compared: ShadowDecisionResult | undefined = proposed
    ? deterministic
      ? proposed === deterministic
        ? 'AGREEMENT'
        : 'DISAGREEMENT'
      : 'AI_ONLY_CANDIDATE'
    : undefined;

  // Une ANALYSE (échec, objectif bloqué, enregistrement) : elle informe, elle n'exécute rien.
  if (input.advisory)
    return base({
      call: true,
      response: 'PROPOSAL',
      terminal: assist ? 'SHADOW_ONLY' : 'PROPOSAL',
      proposalValid: true,
      notExecutedReason: assist ? 'ASSIST_MODE' : 'ADVISORY_ONLY',
      ...(assist && compared ? { shadowResult: compared } : {}),
    });

  // Une proposition sans action, là où une action était attendue : rien d'utilisable.
  if (!proposed)
    return base({
      call: true,
      response: 'PROPOSAL',
      terminal: 'PROPOSAL',
      proposalValid: true,
      notExecutedReason: 'NO_ACTION_PROPOSED',
      fallbackReason: 'NO_USEFUL_PROPOSAL',
      ...(assist
        ? { shadowResult: deterministic ? ('DETERMINISTIC_ONLY' as const) : ('AI_INCONCLUSIVE' as const) }
        : {}),
    });

  if (assist)
    return base({
      call: true,
      response: 'PROPOSAL',
      terminal: 'SHADOW_ONLY',
      proposalValid: true,
      notExecutedReason: 'ASSIST_MODE',
      ...(compared ? { shadowResult: compared } : {}),
    });

  const decision = input.decision;
  if (decision?.accepted)
    return base({
      call: true,
      response: 'PROPOSAL',
      terminal: 'ACCEPTED',
      proposalValid: true,
      acceptedForExecution: true,
      execution: 'PENDING',
      runtime: 'PENDING',
    });
  // HYBRID, non retenue : la raison de l'arbitre.
  const code = decision?.code;
  if (code === 'SAFETY')
    return base({
      call: true,
      response: 'PROPOSAL',
      terminal: 'SAFETY_REJECTED',
      proposalValid: true,
      notExecutedReason: 'SAFETY_BLOCKED',
      fallbackReason: 'SAFETY_BLOCKED',
    });
  const low = code === 'LOW_CONFIDENCE';
  // La même action que le déterministe, gardée par lui : la proposition n'a rien perdu.
  const same = proposed === deterministic;
  return base({
    call: true,
    response: 'PROPOSAL',
    terminal: 'PROPOSAL',
    proposalValid: true,
    notExecutedReason: low ? 'LOW_AI_CONFIDENCE' : 'DETERMINISTIC_PRIORITY',
    ...(same
      ? {}
      : { fallbackReason: low ? ('LOW_AI_CONFIDENCE' as const) : ('DETERMINISTIC_PRIORITY' as const) }),
  });
}
