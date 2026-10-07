import { decisionConfidenceOf, describeConfidence, proposedActionOf } from './decision-confidence.js';
import type { ConsultResult } from './gateway.js';

/**
 * RECOVERY CANDIDATE (source COPILOT) : la proposition validée et retenue par l'arbitre, convertie en
 * candidat de récupération EXÉCUTABLE — jamais une exécution directe :
 *
 *   proposition → validation (schéma, actions, preuves) → arbitre (mode, SafetyPolicy, confiance de
 *   l'action) → CANDIDAT → exécuteur déterministe → vérification de l'objectif / de l'effet
 *
 * L'action est TOUJOURS un identifiant présent dans le contexte envoyé (selectedActionId, ou la première
 * étape du plan) ; aucun localisateur n'est jamais inventé ou accepté du fournisseur.
 */
export interface RecoveryCandidate {
  id: string;
  source: 'DETERMINISTIC' | 'COPILOT';
  /** L'identifiant de la requête (A3…) : la clé locale se retrouve par le contexte construit. */
  actionId: string;
  goal: string;
  hypothesis?: string;
  expectedEffects: string[];
  evidenceIds: string[];
  /** La confiance DANS L'ACTION (pas l'abstention, pas la confiance globale). */
  confidence: number;
  /** 0 = SAFE (SafetyPolicy) ; 1 sinon. */
  risk: number;
  explainability: string[];
}

export type CandidateBuild =
  | { candidate: RecoveryCandidate }
  | { rejected: 'NOT_ACCEPTED' | 'NO_ACTION' | 'UNKNOWN_ACTION_ID'; reason: string };

export function buildCopilotRecoveryCandidate(
  result: ConsultResult,
  context: { goal: string; isKnownAction: (actionId: string) => boolean },
): CandidateBuild {
  const validation = result.validation;
  if (!validation?.valid || !result.decision.accepted)
    return { rejected: 'NOT_ACCEPTED', reason: result.decision.reasons.join('; ') || 'not accepted' };
  const proposal = validation.proposal;
  const actionId = result.decision.actionId ?? proposedActionOf(proposal);
  if (!actionId) return { rejected: 'NO_ACTION', reason: 'proposal without action' };
  // Défense en profondeur : l'action DOIT être une de celles du contexte (jamais un localisateur inventé).
  if (!context.isKnownAction(actionId))
    return { rejected: 'UNKNOWN_ACTION_ID', reason: `${actionId} is not an available action` };
  const scores = decisionConfidenceOf(proposal);
  const safe = result.decision.safety?.classification === 'SAFE';
  return {
    candidate: {
      id: `${result.record.id}:${actionId}`,
      source: 'COPILOT',
      actionId,
      goal: proposal.proposedGoal?.id ?? context.goal,
      ...(proposal.hypothesis ? { hypothesis: proposal.hypothesis.statement } : {}),
      expectedEffects: (proposal.expectedEffects ?? []).map((effect) => `${effect.kind}:${effect.value}`),
      evidenceIds: [...proposal.supportingEvidenceIds],
      confidence: scores.action,
      risk: safe ? 0 : 1,
      explainability: [
        ...(proposal.intent ? [`intent: ${proposal.intent}`] : []),
        ...(proposal.hypothesis ? [`hypothesis: ${proposal.hypothesis.statement}`] : []),
        `confidence: ${describeConfidence(scores)}`,
        `safety: ${result.decision.safety?.classification ?? 'UNKNOWN'}`,
        ...result.decision.reasons,
      ],
    },
  };
}
