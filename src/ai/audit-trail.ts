import {
  AI_FALLBACK_REASONS,
  CALL_RESPONSES,
  type AiDecisionLifecycle,
  type AiFallbackReason,
  type AiResponseStatus,
  type AiTerminalResult,
  type NotExecutedReason,
  type ShadowDecisionResult,
} from './decision-lifecycle.js';
import type { ArbiterSource } from './hybrid-arbiter.js';
import type { IntelligenceMode, IntelligenceTriggerReason } from './model.js';
import type { ComplexityLevel, ModelExecutionContext } from './models/model-types.js';
import type { ProviderModelSummary } from './provider.js';

export type AiOutcome =
  | 'PROPOSAL_ACCEPTED'
  | 'PROPOSAL_NOT_SELECTED'
  | 'PROPOSAL_REJECTED'
  | 'SHADOW'
  | 'INCONCLUSIVE'
  | 'NEED_MORE_EVIDENCE'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_BUDGET_EXHAUSTED'
  | 'AI_MODEL_UNAVAILABLE'
  | 'NO_LLM_REQUIRED'
  | 'AI_ERROR';

/**
 * Où l'intelligence intervient. EXPLORATION et RECOVERY attendent une ACTION ; les autres sont
 * des analyses (échec, objectif bloqué, hypothèse contredite, enregistrement) : rien n'y est exécuté.
 */
export type AiContext = 'EXPLORATION' | 'RECOVERY' | 'FAILURE' | 'BLOCKED_GOAL' | 'HYPOTHESIS' | 'RECORDING';

export const ADVISORY_CONTEXTS: readonly AiContext[] = ['FAILURE', 'BLOCKED_GOAL', 'HYPOTHESIS', 'RECORDING'];

/** Le contexte fonctionnel d'une décision, résumé pour l'audit (jamais une valeur saisie). */
export interface AiFunctionalContextSummary {
  mission?: string;
  goal?: string;
  parentGoal?: string;
  goalProgress?: number;
  lastConfirmedCheckpoint?: string;
  nextExpectedCheckpoint?: string;
  missingPreconditions: string[];
  unknownPrecondition?: boolean;
  blockingReason?: string;
  firstDivergence?: string;
  question?: string;
}

/**
 * Une intervention de l'intelligence, telle qu'elle reste dans l'audit (§62) : le résumé de
 * l'entrée, la proposition STRUCTURÉE, les références de preuve, la validation, la décision,
 * le résultat au runtime. Jamais de « chaîne de pensée », jamais de secret.
 */
export interface AiDecisionRecord {
  id: string;
  at: string;
  context: AiContext;
  trigger: IntelligenceTriggerReason;
  mode: IntelligenceMode;
  provider: string;
  model?: string;
  goal?: string;
  input: {
    actions: number;
    evidence: number;
    hypotheses: number;
    contradictions: number;
    redactions: number;
  };
  deterministic: { actionId?: string; action?: string; confidence: number };
  proposal?: {
    status: string;
    selectedActionId?: string;
    action?: string;
    intent?: string;
    confidence: number;
    evidenceIds: string[];
    uncertainties: string[];
    hypothesis?: string;
    hypothesisType?: string;
    missingPrecondition?: string;
    expectedEffects?: string[];
    failureCategory?: string;
    nextInvestigation?: string;
    summary?: string;
  };
  validation: { status: 'VALID' | 'REJECTED' | 'NOT_RECEIVED'; rejection?: string; reasons: string[] };
  safety?: string;
  accepted: boolean;
  source: ArbiterSource;
  outcome: AiOutcome;
  /** ASSIST : la proposition rejoint-elle la décision exécutée ? */
  shadowAgreement?: boolean;
  runtimeResult?: 'GOAL_CONFIRMED' | 'RUNTIME_CONTRADICTED' | 'NOT_EXECUTED';
  runtimeDetail?: string;
  /** Une proposition confirmée au runtime peut devenir un candidat de connaissance (origine gardée). */
  knowledgeCandidate?: { origin: 'AI_PROPOSAL'; runtimeConfirmed: boolean };
  latencyMs: number;
  toolCalls: number;
  reasons: string[];
  /** La difficulté mesurée sans LLM (ReasoningComplexityAnalyzer). */
  complexity?: { level: ComplexityLevel; score: number; reasons: string[] };
  /** Modèle demandé / choisi / réellement utilisé, effort, repli. */
  modelContext?: ModelExecutionContext;
  /** Le cycle de vie : une réponse, une issue, et les dimensions séparées (shadow, repli, runtime). */
  lifecycle: AiDecisionLifecycle;
  /** Ce que la décision savait du parcours fonctionnel (objectif, checkpoint, préconditions). */
  functionalContext?: AiFunctionalContextSummary;
}

/**
 * Les compteurs du cycle de vie, en dimensions SÉPARÉES. Sur les appels réels, la somme de
 * `byResponse` vaut `calls` ; chaque repli cite les décisions qui l'ont produit.
 */
export interface AiLifecycleSummary {
  records: number;
  calls: number;
  notCalled: number;
  byResponse: Partial<Record<AiResponseStatus, number>>;
  byTerminal: Partial<Record<AiTerminalResult, number>>;
  validation: { valid: number; invalid: number; notReceived: number };
  shadow: Partial<Record<ShadowDecisionResult, number>>;
  execution: {
    executedFromAi: number;
    pending: number;
    notExecuted: Partial<Record<NotExecutedReason, number>>;
  };
  runtime: { confirmed: number; contradicted: number; notApplicable: number; pending: number };
  fallbacks: {
    total: number;
    byReason: Partial<Record<AiFallbackReason, number>>;
    decisionIds: Partial<Record<AiFallbackReason, string[]>>;
  };
  knowledge: { hypothesesProposed: number; runtimeSupported: number; runtimeContradicted: number };
  /** Contrôle : chaque appel a exactement une réponse classée. */
  consistent: boolean;
  consistency: string;
}

/** Des mesures OBSERVÉES par modèle (aucun classement : seulement ce qui s'est passé). */
export interface ModelStats {
  model: string;
  calls: number;
  accepted: number;
  rejected: number;
  inconclusive: number;
  runtimeConfirmed: number;
  runtimeContradicted: number;
  timeouts: number;
  fallbacks: number;
  averageLatencyMs: number;
  recoverySolved: number;
}

export interface ModelEffectiveness {
  model: string;
  trigger: IntelligenceTriggerReason;
  complexity: ComplexityLevel;
  samples: number;
  runtimeConfirmed: number;
  runtimeContradicted: number;
  /** Seulement à partir de MIN_EFFECTIVENESS_SAMPLES vérifications au runtime ; sinon null (trop peu pour conclure). */
  confirmationRate: number | null;
}

/** En dessous : aucun taux n'est calculé (jamais de conclusion sur deux appels). */
export const MIN_EFFECTIVENESS_SAMPLES = 5;

export interface AiSummary {
  mode: IntelligenceMode;
  provider: string;
  model?: string;
  available?: boolean;
  unavailableReason?: string;
  triggersEvaluated: number;
  fastPath: number;
  calls: number;
  proposals: number;
  accepted: number;
  rejected: number;
  inconclusive: number;
  runtimeConfirmed: number;
  runtimeContradicted: number;
  aiAssistedRecoveries: number;
  shadow: { compared: number; agreements: number; disagreements: number };
  timeouts: number;
  unavailable: number;
  budgetExhausted: number;
  fallbacks: number;
  averageLatencyMs: number;
  toolCalls: number;
  tokens?: { input: number; output: number };
  byTrigger: Partial<Record<IntelligenceTriggerReason, number>>;
  /** Raisonnements jugés TRIVIAL : aucun appel, aucun choix de modèle. */
  noLlmRequired: number;
  /** Gestion des modèles : mode de sélection, profil par défaut, découverte. */
  modelSelection?: ProviderModelSummary;
  models: ModelStats[];
  effectiveness: ModelEffectiveness[];
  reasoning: Partial<Record<'LOW' | 'MEDIUM' | 'HIGH' | 'NOT_SENT', number>>;
  complexity: Partial<Record<ComplexityLevel, number>>;
  modelFallbacks: number;
  lifecycle: AiLifecycleSummary;
  decisions: AiDecisionRecord[];
}

/** INTELLIGENCE AUDIT TRAIL (§61) : une trace par intervention, et les mesures de son utilité (§67). */
export class IntelligenceAuditTrail {
  private next = 1;
  readonly records: AiDecisionRecord[] = [];
  triggersEvaluated = 0;
  fastPath = 0;

  constructor(private readonly limit = 500) {}

  create(record: Omit<AiDecisionRecord, 'id'>): AiDecisionRecord {
    const entry: AiDecisionRecord = { id: `AI-${String(this.next).padStart(5, '0')}`, ...record };
    this.next += 1;
    this.records.push(entry);
    if (this.records.length > this.limit) this.records.shift();
    return entry;
  }

  byId(id: string): AiDecisionRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  summarize(base: {
    mode: IntelligenceMode;
    provider: string;
    model?: string;
    available?: boolean;
    unavailableReason?: string;
    averageLatencyMs: number;
    toolCalls: number;
    tokens?: { input: number; output: number };
    modelSelection?: ProviderModelSummary;
  }): AiSummary {
    const count = (predicate: (record: AiDecisionRecord) => boolean) => this.records.filter(predicate).length;
    const byTrigger: Partial<Record<IntelligenceTriggerReason, number>> = {};
    for (const record of this.records) byTrigger[record.trigger] = (byTrigger[record.trigger] ?? 0) + 1;
    const compared = this.records.filter((record) => record.lifecycle.shadowResult !== undefined);
    return {
      ...base,
      triggersEvaluated: this.triggersEvaluated,
      fastPath: this.fastPath,
      calls: count((record) => isCall(record)),
      proposals: count(
        (record) => record.lifecycle.response === 'PROPOSAL' && record.lifecycle.proposalValid === true,
      ),
      accepted: count((record) => record.lifecycle.acceptedForExecution),
      rejected: count((record) => record.lifecycle.proposalValid === false),
      inconclusive: count(
        (record) => record.outcome === 'INCONCLUSIVE' || record.outcome === 'NEED_MORE_EVIDENCE',
      ),
      runtimeConfirmed: count((record) => record.runtimeResult === 'GOAL_CONFIRMED'),
      runtimeContradicted: count((record) => record.runtimeResult === 'RUNTIME_CONTRADICTED'),
      aiAssistedRecoveries: count(
        (record) =>
          record.context === 'RECOVERY' && record.accepted && record.runtimeResult === 'GOAL_CONFIRMED',
      ),
      shadow: {
        compared: compared.length,
        agreements: count((record) => record.lifecycle.shadowResult === 'AGREEMENT'),
        disagreements: count((record) => record.lifecycle.shadowResult === 'DISAGREEMENT'),
      },
      timeouts: count((record) => record.outcome === 'AI_TIMEOUT'),
      unavailable: count((record) => record.outcome === 'AI_UNAVAILABLE'),
      budgetExhausted: count((record) => record.outcome === 'AI_BUDGET_EXHAUSTED'),
      // Un repli : un chemin IA attendu n'a pas servi (raison classée). ASSIST n'en est jamais un.
      fallbacks: count((record) => record.lifecycle.fallbackReason !== undefined),
      byTrigger,
      noLlmRequired: count((record) => record.outcome === 'NO_LLM_REQUIRED'),
      models: this.modelStats(),
      effectiveness: this.effectiveness(),
      reasoning: tally(
        this.records.filter((record) => record.modelContext && isCall(record)),
        (record) => record.modelContext?.sentReasoningEffort ?? 'NOT_SENT',
      ),
      complexity: tally(
        this.records.filter((record) => record.complexity),
        (record) => record.complexity?.level ?? 'MEDIUM',
      ),
      modelFallbacks: count((record) => record.modelContext?.fallbackApplied === true),
      lifecycle: this.lifecycleSummary(),
      decisions: this.records.slice(-100),
    };
  }

  /** Les compteurs du cycle de vie (dimensions séparées, sommes contrôlées). */
  private lifecycleSummary(): AiLifecycleSummary {
    const records = this.records;
    const calls = records.filter((record) => record.lifecycle.call);
    const byResponse = tally(records, (record) => record.lifecycle.response);
    const fallbacks = records.filter((record) => record.lifecycle.fallbackReason !== undefined);
    const decisionIds: Partial<Record<AiFallbackReason, string[]>> = {};
    for (const record of fallbacks) {
      const reason = record.lifecycle.fallbackReason;
      if (reason) decisionIds[reason] = [...(decisionIds[reason] ?? []), record.id];
    }
    const callResponses = calls.filter((record) => CALL_RESPONSES.includes(record.lifecycle.response)).length;
    const unknownReasons = fallbacks.filter(
      (record) => !AI_FALLBACK_REASONS.includes(record.lifecycle.fallbackReason as AiFallbackReason),
    ).length;
    const consistent = callResponses === calls.length && unknownReasons === 0;
    return {
      records: records.length,
      calls: calls.length,
      notCalled: records.length - calls.length,
      byResponse,
      byTerminal: tally(records, (record) => record.lifecycle.terminal),
      validation: {
        valid: records.filter((record) => record.lifecycle.proposalValid === true).length,
        invalid: records.filter((record) => record.lifecycle.proposalValid === false).length,
        notReceived: records.filter((record) => record.lifecycle.proposalValid === undefined).length,
      },
      shadow: tally(
        records.filter((record) => record.lifecycle.shadowResult !== undefined),
        (record) => record.lifecycle.shadowResult ?? 'AI_INCONCLUSIVE',
      ),
      execution: {
        executedFromAi: records.filter((record) => record.lifecycle.execution === 'EXECUTED').length,
        pending: records.filter((record) => record.lifecycle.execution === 'PENDING').length,
        notExecuted: tally(
          records.filter((record) => record.lifecycle.notExecutedReason !== undefined),
          (record) => record.lifecycle.notExecutedReason ?? 'NO_RESPONSE',
        ),
      },
      runtime: {
        confirmed: records.filter((record) => record.lifecycle.runtime === 'CONFIRMED').length,
        contradicted: records.filter((record) => record.lifecycle.runtime === 'CONTRADICTED').length,
        notApplicable: records.filter((record) => record.lifecycle.runtime === 'NOT_APPLICABLE').length,
        pending: records.filter((record) => record.lifecycle.runtime === 'PENDING').length,
      },
      fallbacks: {
        total: fallbacks.length,
        byReason: tally(fallbacks, (record) => record.lifecycle.fallbackReason ?? 'AI_ERROR'),
        decisionIds,
      },
      knowledge: {
        hypothesesProposed: records.filter((record) => record.lifecycle.knowledge.impact !== 'NONE').length,
        runtimeSupported: records.filter(
          (record) => record.lifecycle.knowledge.impact === 'RUNTIME_SUPPORTED',
        ).length,
        runtimeContradicted: records.filter(
          (record) => record.lifecycle.knowledge.impact === 'RUNTIME_CONTRADICTED',
        ).length,
      },
      consistent,
      consistency: consistent
        ? `${String(calls.length)} call(s) = ${String(callResponses)} classified response(s); ${String(records.length - calls.length)} decision(s) without a call`
        : `${String(calls.length)} call(s) but ${String(callResponses)} classified response(s)${unknownReasons > 0 ? `, ${String(unknownReasons)} unclassified fallback(s)` : ''}`,
    };
  }

  /** Par modèle (le modèle réellement utilisé s'il est connu, sinon le modèle choisi). */
  private modelStats(): ModelStats[] {
    const groups = new Map<string, AiDecisionRecord[]>();
    for (const record of this.records) {
      if (!record.modelContext) continue;
      const key = modelKey(record);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    return [...groups].map(([model, records]) => {
      const calls = records.filter((record) => isCall(record));
      return {
        model,
        calls: calls.length,
        accepted: records.filter((record) => record.lifecycle.acceptedForExecution).length,
        rejected: records.filter((record) => record.lifecycle.proposalValid === false).length,
        inconclusive: records.filter(
          (record) => record.outcome === 'INCONCLUSIVE' || record.outcome === 'NEED_MORE_EVIDENCE',
        ).length,
        runtimeConfirmed: records.filter((record) => record.runtimeResult === 'GOAL_CONFIRMED').length,
        runtimeContradicted: records.filter((record) => record.runtimeResult === 'RUNTIME_CONTRADICTED')
          .length,
        timeouts: records.filter((record) => record.outcome === 'AI_TIMEOUT').length,
        fallbacks: records.filter((record) => record.modelContext?.fallbackApplied).length,
        averageLatencyMs:
          calls.length === 0
            ? 0
            : Math.round(calls.reduce((sum, record) => sum + record.latencyMs, 0) / calls.length),
        recoverySolved: records.filter(
          (record) =>
            record.context === 'RECOVERY' && record.accepted && record.runtimeResult === 'GOAL_CONFIRMED',
        ).length,
      };
    });
  }

  /** Par (modèle, déclencheur, complexité) : un taux seulement avec assez d'échantillons. */
  private effectiveness(): ModelEffectiveness[] {
    const groups = new Map<string, AiDecisionRecord[]>();
    for (const record of this.records) {
      if (!record.modelContext || !isCall(record)) continue;
      const key = `${modelKey(record)}|${record.trigger}|${record.modelContext.complexity}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    return [...groups].map(([key, records]) => {
      const [model = '?', trigger, complexity] = key.split('|');
      const confirmed = records.filter((record) => record.runtimeResult === 'GOAL_CONFIRMED').length;
      const contradicted = records.filter((record) => record.runtimeResult === 'RUNTIME_CONTRADICTED').length;
      const verified = confirmed + contradicted;
      return {
        model,
        trigger: trigger as IntelligenceTriggerReason,
        complexity: complexity as ComplexityLevel,
        samples: records.length,
        runtimeConfirmed: confirmed,
        runtimeContradicted: contradicted,
        confirmationRate:
          verified >= MIN_EFFECTIVENESS_SAMPLES ? Math.round((confirmed / verified) * 100) / 100 : null,
      };
    });
  }
}

/** Un vrai appel au fournisseur (ni budget épuisé, ni indisponible, ni raisonnement trivial). */
function isCall(record: AiDecisionRecord): boolean {
  return record.lifecycle.call;
}

function modelKey(record: AiDecisionRecord): string {
  return (
    record.modelContext?.effectiveModel ?? record.modelContext?.selectedModel ?? record.model ?? 'unknown'
  );
}

function tally<K extends string>(
  records: AiDecisionRecord[],
  key: (record: AiDecisionRecord) => K,
): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const record of records) result[key(record)] = (result[key(record)] ?? 0) + 1;
  return result;
}
