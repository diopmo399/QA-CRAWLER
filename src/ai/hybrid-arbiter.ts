import type { IntelligenceMode } from './model.js';
import type { ProposalValidation } from './proposal-validator.js';

export interface ArbiterThresholds {
  /** Au-dessus : la décision déterministe est gardée, quoi que propose le fournisseur. */
  deterministicConfidence: number;
  /** En dessous : une proposition n'est jamais retenue. */
  minProposalConfidence: number;
  /** Écart de confiance exigé pour préférer la proposition à une décision déterministe existante. */
  overrideMargin: number;
}

export interface DeterministicChoice {
  actionId?: string;
  confidence: number;
}

/** Le jugement de la SafetyPolicy EXISTANTE pour une action (jamais celui du fournisseur). */
export interface SafetyVerdict {
  allowed: boolean;
  classification: string;
  reason: string;
}

export type ArbiterSource = 'DETERMINISTIC' | 'AI_PROPOSAL' | 'NONE';

/** La règle de l'arbitre qui a tranché (pour classer l'issue sans relire les phrases). */
export type ArbiterCode =
  | 'OFF'
  | 'NO_PROPOSAL'
  | 'INVALID'
  | 'NOT_ACTIONABLE'
  | 'ASSIST'
  | 'SAFETY'
  | 'DETERMINISTIC_CONFIDENT'
  | 'LOW_CONFIDENCE'
  | 'MARGIN'
  | 'ACCEPTED';

export interface ArbiterDecision {
  /** L'action retenue (à exécuter par l'exécuteur existant, après la SafetyPolicy). */
  actionId?: string;
  source: ArbiterSource;
  /** La proposition a été retenue. */
  accepted: boolean;
  /** ASSIST : la proposition diffère de la décision déterministe (shadow). */
  disagreement: boolean;
  safety?: SafetyVerdict;
  reasons: string[];
  code: ArbiterCode;
}

/**
 * HYBRID DECISION ARBITER (§41) : la décision déterministe d'un côté, la proposition validée
 * de l'autre.
 *
 *   OFF / ASSIST      la décision déterministe, toujours (ASSIST mesure le désaccord)
 *   HYBRID, fort      déterministe ≥ seuil → déterministe
 *   HYBRID, faible    proposition valide + SafetyPolicy d'accord + confiance suffisante → proposition
 *   proposition non sûre, invalide, contredite ou INCONCLUSIVE → déterministe (ou rien)
 */
export function arbitrate(input: {
  mode: IntelligenceMode;
  deterministic: DeterministicChoice;
  validation?: ProposalValidation;
  safety: (actionId: string) => SafetyVerdict;
  thresholds: ArbiterThresholds;
}): ArbiterDecision {
  const { deterministic, validation, thresholds } = input;
  const keep = (
    code: ArbiterCode,
    reasons: string[],
    extra: Partial<ArbiterDecision> = {},
  ): ArbiterDecision => ({
    ...(deterministic.actionId ? { actionId: deterministic.actionId } : {}),
    source: deterministic.actionId ? 'DETERMINISTIC' : 'NONE',
    accepted: false,
    disagreement: false,
    reasons,
    code,
    ...extra,
  });
  const proposed = validation?.valid ? validation.proposal.selectedActionId : undefined;
  const disagreement = proposed !== undefined && proposed !== deterministic.actionId;
  if (input.mode === 'OFF') return keep('OFF', ['intelligence OFF']);
  if (!validation) return keep('NO_PROPOSAL', ['no proposal']);
  if (!validation.valid) return keep('INVALID', [`proposal rejected: ${validation.rejection}`]);
  if (validation.proposal.status !== 'PROPOSAL' || !proposed)
    return keep('NOT_ACTIONABLE', [
      `proposal ${validation.proposal.status}${proposed ? '' : ' without action'}`,
    ]);
  const safety = input.safety(proposed);
  if (input.mode === 'ASSIST')
    return keep('ASSIST', ['ASSIST: the deterministic decision is executed; the proposal is recorded only'], {
      disagreement,
      safety,
    });
  if (!safety.allowed)
    return keep('SAFETY', [`SafetyPolicy refuses ${proposed}: ${safety.classification} — ${safety.reason}`], {
      disagreement,
      safety,
    });
  if (deterministic.actionId && deterministic.confidence >= thresholds.deterministicConfidence)
    return keep(
      'DETERMINISTIC_CONFIDENT',
      [
        `deterministic confidence ${deterministic.confidence.toFixed(2)} ≥ ${thresholds.deterministicConfidence.toFixed(2)}`,
      ],
      { disagreement, safety },
    );
  const confidence = validation.proposal.confidence;
  if (confidence < thresholds.minProposalConfidence)
    return keep(
      'LOW_CONFIDENCE',
      [`proposal confidence ${confidence.toFixed(2)} < ${thresholds.minProposalConfidence.toFixed(2)}`],
      {
        disagreement,
        safety,
      },
    );
  if (
    deterministic.actionId &&
    deterministic.actionId !== proposed &&
    confidence < deterministic.confidence + thresholds.overrideMargin
  )
    return keep(
      'MARGIN',
      [
        `proposal confidence ${confidence.toFixed(2)} does not exceed deterministic ${deterministic.confidence.toFixed(2)} by ${thresholds.overrideMargin.toFixed(2)}`,
      ],
      { disagreement, safety },
    );
  return {
    actionId: proposed,
    source: 'AI_PROPOSAL',
    accepted: true,
    code: 'ACCEPTED',
    disagreement,
    safety,
    reasons: [
      ...validation.checks,
      `SafetyPolicy: ${safety.classification}`,
      deterministic.actionId
        ? `deterministic ${deterministic.actionId} at ${deterministic.confidence.toFixed(2)} was weak`
        : 'no deterministic decision',
      `proposal confidence ${confidence.toFixed(2)}`,
    ],
  };
}
