import { sanitizeValue } from '../persistence/sanitize.js';
import type { AiDecisionRecord, AiSummary } from './audit-trail.js';

/** Une ligne de reports/intelligence-decisions.json : le cycle de vie complet d'une décision. */
export interface IntelligenceDecisionEntry {
  decisionId: string;
  timestamp: string;
  context: string;
  trigger: string;
  mode: string;
  model?: string;
  functionalContextSummary?: AiDecisionRecord['functionalContext'];
  goal?: string;
  blockingReason?: string;
  requestSummary: AiDecisionRecord['input'] & { deterministic: AiDecisionRecord['deterministic'] };
  response: string;
  terminal: string;
  proposal?: AiDecisionRecord['proposal'];
  validation: AiDecisionRecord['validation'] & { proposalValid?: boolean };
  shadowResult?: string;
  fallbackReason?: string;
  executionResult: {
    acceptedForExecution: boolean;
    execution: string;
    notExecutedReason?: string;
    safety?: string;
  };
  runtimeVerification: {
    result: string;
    detail?: string;
    goalProgress?: AiDecisionRecord['lifecycle']['goalProgress'];
  };
  knowledgeImpact: AiDecisionRecord['lifecycle']['knowledge'];
  latencyMs: number;
  reasons: string[];
}

/**
 * reports/intelligence-decisions.json (§46) : chaque appel, de son déclencheur à ce que
 * QA-Crawler en a appris. Des résumés structurés, NETTOYÉS (aucun secret, jeton, mot de passe,
 * en-tête Authorization ni cookie), jamais une « chaîne de pensée ».
 */
export function intelligenceDecisionsArtifact(summary: AiSummary): {
  mode: string;
  provider: string;
  model?: string;
  lifecycle: AiSummary['lifecycle'];
  decisions: IntelligenceDecisionEntry[];
} {
  const decisions = summary.decisions.map((record): IntelligenceDecisionEntry => {
    const lifecycle = record.lifecycle;
    const model = record.modelContext?.effectiveModel ?? record.modelContext?.selectedModel ?? record.model;
    return {
      decisionId: record.id,
      timestamp: record.at,
      context: record.context,
      trigger: record.trigger,
      mode: record.mode,
      ...(model ? { model } : {}),
      ...(record.functionalContext ? { functionalContextSummary: record.functionalContext } : {}),
      ...((record.functionalContext?.goal ?? record.goal)
        ? { goal: record.functionalContext?.goal ?? record.goal }
        : {}),
      ...(record.functionalContext?.blockingReason
        ? { blockingReason: record.functionalContext.blockingReason }
        : {}),
      requestSummary: { ...record.input, deterministic: record.deterministic },
      response: lifecycle.response,
      terminal: lifecycle.terminal,
      ...(record.proposal ? { proposal: record.proposal } : {}),
      validation: {
        ...record.validation,
        ...(lifecycle.proposalValid !== undefined ? { proposalValid: lifecycle.proposalValid } : {}),
      },
      ...(lifecycle.shadowResult ? { shadowResult: lifecycle.shadowResult } : {}),
      ...(lifecycle.fallbackReason ? { fallbackReason: lifecycle.fallbackReason } : {}),
      executionResult: {
        acceptedForExecution: lifecycle.acceptedForExecution,
        execution: lifecycle.execution,
        ...(lifecycle.notExecutedReason ? { notExecutedReason: lifecycle.notExecutedReason } : {}),
        ...(record.safety ? { safety: record.safety } : {}),
      },
      runtimeVerification: {
        result:
          lifecycle.runtime === 'NOT_APPLICABLE' && record.mode === 'ASSIST'
            ? 'NOT_APPLICABLE (mode=ASSIST: shadow only)'
            : lifecycle.runtime,
        ...(record.runtimeDetail ? { detail: record.runtimeDetail } : {}),
        ...(lifecycle.goalProgress ? { goalProgress: lifecycle.goalProgress } : {}),
      },
      knowledgeImpact: lifecycle.knowledge,
      latencyMs: record.latencyMs,
      reasons: record.reasons,
    };
  });
  return sanitizeValue({
    mode: summary.mode,
    provider: summary.provider,
    ...(summary.model ? { model: summary.model } : {}),
    lifecycle: summary.lifecycle,
    decisions,
  }) as ReturnType<typeof intelligenceDecisionsArtifact>;
}
