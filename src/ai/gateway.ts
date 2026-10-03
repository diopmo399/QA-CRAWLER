import { sanitizeText } from '../persistence/sanitize.js';
import {
  ADVISORY_CONTEXTS,
  IntelligenceAuditTrail,
  type AiContext,
  type AiDecisionRecord,
  type AiFunctionalContextSummary,
  type AiOutcome,
  type AiSummary,
} from './audit-trail.js';
import {
  classifyDecision,
  type AiCallFailure,
  type AiGoalProgress,
  type AiKnowledgeImpact,
} from './decision-lifecycle.js';
import { IntelligenceBudgetManager, type CallScope, type IntelligenceBudgets } from './budget-manager.js';
import {
  arbitrate,
  type ArbiterDecision,
  type ArbiterThresholds,
  type DeterministicChoice,
  type SafetyVerdict,
} from './hybrid-arbiter.js';
import { ReasoningComplexityAnalyzer, type ComplexitySignals } from './models/complexity-analyzer.js';
import { ModelUnavailableError, type ModelExecutionContext } from './models/model-types.js';
import {
  IntelligenceUnavailableError,
  type IntelligenceMode,
  type IntelligenceRequest,
  type IntelligenceToolContext,
  type ProviderResult,
} from './model.js';
import { validateIntelligenceProposal, type ProposalValidation } from './proposal-validator.js';
import type { IntelligenceProvider } from './provider.js';
import type { IntelligenceContextSanitizer } from './sanitizer.js';
import {
  IntelligenceTriggerPolicy,
  type IntelligenceTriggerDecision,
  type TriggerSettings,
  type TriggerSituation,
} from './trigger-policy.js';

export const AI_EVENTS = [
  'AI_TRIGGER_EVALUATED',
  'AI_REQUEST_CREATED',
  'AI_REQUEST_SANITIZED',
  'AI_SESSION_CREATED',
  'AI_PROPOSAL_RECEIVED',
  'AI_PROPOSAL_VALIDATED',
  'AI_PROPOSAL_REJECTED',
  'AI_PROPOSAL_ACCEPTED',
  'AI_SHADOW_DISAGREEMENT',
  'AI_FALLBACK_ACTIVATED',
  'AI_TIMEOUT',
  'AI_UNAVAILABLE',
  'AI_BUDGET_EXHAUSTED',
  'AI_RUNTIME_CONFIRMED',
  'AI_RUNTIME_CONTRADICTED',
  'AI_NO_LLM_REQUIRED',
  'AI_MODEL_DISCOVERY_STARTED',
  'AI_MODEL_DISCOVERY_COMPLETED',
  'AI_MODEL_DISCOVERY_FAILED',
  'AI_MODEL_SELECTED',
  'AI_MODEL_UNAVAILABLE',
  'AI_MODEL_FALLBACK',
  'AI_MODEL_CAPABILITY_MISMATCH',
  'AI_REASONING_EFFORT_SELECTED',
  'AI_REASONING_EFFORT_ADJUSTED',
  'AI_EFFECTIVE_MODEL_OBSERVED',
  'AI_SHADOW_RECORDED',
  'AI_DECISION_CLASSIFIED',
] as const;
export type AiEvent = (typeof AI_EVENTS)[number];
export interface AiEventRecord {
  event: AiEvent;
  message: string;
}

export interface GatewayOptions {
  mode: IntelligenceMode;
  providerId: string;
  /** Créé au PREMIER besoin seulement (jamais en mode OFF). */
  createProvider: () => IntelligenceProvider;
  triggers: TriggerSettings;
  thresholds: ArbiterThresholds;
  budgets: IntelligenceBudgets;
  timeoutMs: number;
  maxRetries: number;
  /** Un fournisseur indisponible arrête le run (par défaut : repli déterministe). */
  failOnUnavailable: boolean;
  sanitizer: IntelligenceContextSanitizer;
  emit?: (record: AiEventRecord) => void;
  now?: () => number;
  clock?: () => string;
}

export interface ConsultInput {
  context: AiContext;
  /** La requête construite par l'IntelligenceContextBuilder (nettoyée ici, avant tout envoi). */
  request: IntelligenceRequest;
  scope: CallScope;
  deterministic: DeterministicChoice;
  /** La SafetyPolicy existante, pour une action de la requête. */
  safety: (actionId: string) => SafetyVerdict;
  /** L'EvidenceStore de QA-Crawler : une preuve citée doit y exister. */
  knownEvidence: (id: string) => boolean;
  tools?: IntelligenceToolContext;
  /** Signaux du moteur cognitif pour mesurer la difficulté (tentatives, plans, divergence). */
  signals?: ComplexitySignals;
  /** Une analyse (aucune exécution attendue) ; par défaut selon le contexte (FAILURE, BLOCKED_GOAL…). */
  advisory?: boolean;
}

export interface ConsultResult {
  record: AiDecisionRecord;
  decision: ArbiterDecision;
  validation?: ProposalValidation;
}

class TimeoutError extends Error {}

/**
 * INTELLIGENCE GATEWAY : l'unique point d'entrée vers un fournisseur d'intelligence.
 *
 *   déclencheur → budget → requête nettoyée → fournisseur (paresseux, borné, isolé)
 *   → validation (schéma, actions, preuves) → arbitrage (mode, confiance, SafetyPolicy)
 *   → audit → (plus tard) vérification au runtime
 *
 * Le fournisseur indisponible, lent ou faux ne fait jamais planter le crawler : la décision
 * revient au déterministe (AI_FALLBACK_ACTIVATED). Aucun composant d'exécution ne l'appelle.
 */
export class IntelligenceGateway {
  readonly audit = new IntelligenceAuditTrail();
  readonly budget: IntelligenceBudgetManager;
  private readonly complexity = new ReasoningComplexityAnalyzer();
  private readonly policy: IntelligenceTriggerPolicy;
  private provider: IntelligenceProvider | undefined;
  private availability: Promise<boolean> | undefined;

  constructor(private readonly options: GatewayOptions) {
    this.policy = new IntelligenceTriggerPolicy(options.triggers, options.thresholds.deterministicConfidence);
    this.budget = new IntelligenceBudgetManager(options.budgets);
  }

  get mode(): IntelligenceMode {
    return this.options.mode;
  }

  /** Le fournisseur a-t-il été créé (jamais en OFF, et seulement au premier besoin) ? */
  get providerCreated(): boolean {
    return this.provider !== undefined;
  }

  /** Faut-il demander de l'aide ? Le FAST PATH déterministe est la règle. */
  evaluate(situation: TriggerSituation): IntelligenceTriggerDecision {
    if (this.options.mode === 'OFF')
      return { shouldInvoke: false, skippedBecause: 'MODE_OFF', evidence: situation.evidence ?? [] };
    const decision = this.policy.evaluate(situation);
    this.audit.triggersEvaluated += 1;
    if (decision.skippedBecause === 'FAST_PATH') this.audit.fastPath += 1;
    if (decision.shouldInvoke && decision.reason)
      this.emit('AI_TRIGGER_EVALUATED', `${decision.reason}: deep reasoning requested`);
    return decision;
  }

  async consult(input: ConsultInput): Promise<ConsultResult> {
    const started = this.now();
    const { request } = input;
    const functional = functionalSummaryOf(request);
    const base = {
      at: this.clock(),
      context: input.context,
      trigger: request.trigger,
      mode: this.options.mode,
      provider: this.options.providerId,
      ...(request.goal ? { goal: request.goal.id } : {}),
      deterministic: {
        ...(input.deterministic.actionId
          ? {
              actionId: input.deterministic.actionId,
              action: labelOf(request, input.deterministic.actionId),
            }
          : {}),
        confidence: round(input.deterministic.confidence),
      },
      toolCalls: 0,
      ...(functional ? { functionalContext: functional } : {}),
    };
    const advisory = input.advisory ?? ADVISORY_CONTEXTS.includes(input.context);
    const fallback = (
      outcome: AiOutcome,
      reasons: string[],
      redactions = 0,
      extra: Partial<AiDecisionRecord> = {},
    ): ConsultResult => {
      const decision = arbitrate({
        mode: this.options.mode,
        deterministic: input.deterministic,
        safety: input.safety,
        thresholds: this.options.thresholds,
      });
      const record = this.audit.create({
        ...base,
        ...(this.provider?.model ? { model: this.provider.model } : {}),
        input: inputSummary(request, redactions),
        validation: { status: 'NOT_RECEIVED', reasons },
        accepted: false,
        source: decision.source,
        outcome,
        latencyMs: this.now() - started,
        reasons,
        lifecycle: classifyDecision({
          mode: this.options.mode,
          advisory,
          ...(input.deterministic.actionId ? { deterministicActionId: input.deterministic.actionId } : {}),
          failure: FAILURE_OF[outcome] ?? 'ERROR',
        }),
        ...extra,
      });
      this.classified(record);
      return { record, decision };
    };
    if (this.options.mode === 'OFF') return fallback('AI_UNAVAILABLE', ['intelligence OFF']);

    // La difficulté du raisonnement (sans LLM) : TRIVIAL → aucun appel, aucun choix de modèle.
    const complexity = this.complexity.analyze(request, input.signals);
    if (complexity.level === 'TRIVIAL') {
      this.emit('AI_NO_LLM_REQUIRED', `${request.trigger}: ${complexity.reasons.join('; ')}`);
      return fallback('NO_LLM_REQUIRED', complexity.reasons, 0, {
        complexity: { level: complexity.level, score: complexity.score, reasons: complexity.reasons },
      });
    }

    const exhausted = this.budget.check(input.scope);
    if (exhausted) {
      this.emit('AI_BUDGET_EXHAUSTED', `${request.trigger}: ${exhausted}`);
      return fallback('AI_BUDGET_EXHAUSTED', [`budget exhausted: ${exhausted}`]);
    }
    this.emit(
      'AI_REQUEST_CREATED',
      `${request.requestId} ${request.trigger}: ${String(request.availableActions.length)} action(s), ${String(request.relevantEvidence.length)} evidence`,
    );
    const { request: sanitized, redactions } = this.options.sanitizer.sanitize(request);
    this.emit('AI_REQUEST_SANITIZED', `${request.requestId}: ${String(redactions)} value(s) redacted`);

    const provider = this.ensureProvider();
    const available = await this.isAvailable();
    if (!available) {
      const reason = provider.unavailableReason?.() ?? 'provider unavailable';
      this.emit('AI_UNAVAILABLE', `${this.options.providerId}: ${reason}`);
      if (this.options.failOnUnavailable) throw new IntelligenceUnavailableError(reason);
      return fallback('AI_UNAVAILABLE', [reason], redactions);
    }

    this.budget.begin(input.scope);
    const timeoutMs = Math.min(this.options.timeoutMs, this.options.budgets.maxReasoningDurationMs);
    let result: ProviderResult | undefined;
    let failure: { outcome: AiOutcome; reason: string; modelContext?: ModelExecutionContext } | undefined;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        result = await this.withTimeout(timeoutMs, (signal) =>
          provider.analyze(sanitized, {
            signal,
            complexity,
            emit: (event, message) => {
              if ((AI_EVENTS as readonly string[]).includes(event)) this.emit(event as AiEvent, message);
            },
            ...(input.tools ? { tools: input.tools } : {}),
            maxToolCalls: this.options.budgets.maxToolCallsPerRequest,
          }),
        );
        failure = undefined;
        break;
      } catch (error) {
        if (error instanceof ModelUnavailableError) {
          // Aucun modèle utilisable et aucun repli permis : pas d'appel, décision déterministe.
          failure = { outcome: 'AI_MODEL_UNAVAILABLE', reason: error.message, modelContext: error.context };
          break;
        }
        if (error instanceof TimeoutError) {
          failure = { outcome: 'AI_TIMEOUT', reason: `no answer within ${String(timeoutMs)} ms` };
          break;
        }
        failure = {
          outcome: 'AI_ERROR',
          reason: sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 200),
        };
      }
    }
    this.budget.end({
      latencyMs: this.now() - started,
      ...(result?.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
      timeout: failure?.outcome === 'AI_TIMEOUT',
      ...(result?.usage ? { usage: result.usage } : {}),
    });
    if (failure || !result) {
      const reason = failure?.reason ?? 'no answer';
      if (failure?.outcome === 'AI_TIMEOUT') this.emit('AI_TIMEOUT', `${request.requestId}: ${reason}`);
      return fallback(failure?.outcome ?? 'AI_ERROR', [reason], redactions, {
        complexity: { level: complexity.level, score: complexity.score, reasons: complexity.reasons },
        ...(failure?.modelContext ? { modelContext: failure.modelContext } : {}),
      });
    }

    this.emit('AI_PROPOSAL_RECEIVED', `${request.requestId} from ${result.model ?? this.options.providerId}`);
    const validation = validateIntelligenceProposal(result.raw, sanitized, input.knownEvidence);
    const decision = arbitrate({
      mode: this.options.mode,
      deterministic: input.deterministic,
      validation,
      safety: input.safety,
      thresholds: this.options.thresholds,
    });
    const proposal = validation.proposal;
    const outcome: AiOutcome = !validation.valid
      ? 'PROPOSAL_REJECTED'
      : validation.proposal.status === 'INCONCLUSIVE'
        ? 'INCONCLUSIVE'
        : validation.proposal.status === 'NEED_MORE_EVIDENCE'
          ? 'NEED_MORE_EVIDENCE'
          : decision.accepted
            ? 'PROPOSAL_ACCEPTED'
            : this.options.mode === 'ASSIST'
              ? 'SHADOW'
              : 'PROPOSAL_NOT_SELECTED';
    const lifecycle = classifyDecision({
      mode: this.options.mode,
      advisory,
      ...(input.deterministic.actionId ? { deterministicActionId: input.deterministic.actionId } : {}),
      validation,
      decision,
    });
    // Compatibilité : vrai / faux seulement quand les deux côtés ont choisi une action.
    const shadow =
      lifecycle.shadowResult === 'AGREEMENT'
        ? true
        : lifecycle.shadowResult === 'DISAGREEMENT'
          ? false
          : undefined;
    const record = this.audit.create({
      ...base,
      ...((result.modelContext?.effectiveModel ?? result.model ?? result.modelContext?.selectedModel)
        ? { model: result.modelContext?.effectiveModel ?? result.model ?? result.modelContext?.selectedModel }
        : {}),
      input: inputSummary(request, redactions),
      complexity: { level: complexity.level, score: complexity.score, reasons: complexity.reasons },
      ...(result.modelContext ? { modelContext: result.modelContext } : {}),
      ...(proposal
        ? {
            proposal: {
              status: proposal.status,
              ...(proposal.selectedActionId
                ? {
                    selectedActionId: proposal.selectedActionId,
                    action: labelOf(request, proposal.selectedActionId),
                  }
                : {}),
              ...(proposal.intent ? { intent: proposal.intent } : {}),
              confidence: round(proposal.confidence),
              evidenceIds: proposal.supportingEvidenceIds,
              uncertainties: proposal.uncertainties,
              ...(proposal.hypothesis ? { hypothesis: proposal.hypothesis.statement } : {}),
              ...(proposal.hypothesis?.type ? { hypothesisType: proposal.hypothesis.type } : {}),
              ...(proposal.missingPrecondition ? { missingPrecondition: proposal.missingPrecondition } : {}),
              ...(proposal.expectedEffects && proposal.expectedEffects.length > 0
                ? {
                    expectedEffects: proposal.expectedEffects.map(
                      (effect) => `${effect.kind}:${effect.value}`,
                    ),
                  }
                : {}),
              ...(proposal.failureCategory ? { failureCategory: proposal.failureCategory } : {}),
              ...(proposal.nextInvestigation ? { nextInvestigation: proposal.nextInvestigation } : {}),
              ...(proposal.summary ? { summary: proposal.summary } : {}),
            },
          }
        : {}),
      validation: validation.valid
        ? { status: 'VALID', reasons: validation.checks }
        : { status: 'REJECTED', rejection: validation.rejection, reasons: validation.reasons },
      ...(decision.safety ? { safety: decision.safety.classification } : {}),
      accepted: decision.accepted,
      source: decision.source,
      outcome,
      ...(shadow !== undefined ? { shadowAgreement: shadow } : {}),
      ...(decision.accepted ? {} : { runtimeResult: 'NOT_EXECUTED' as const }),
      latencyMs: this.now() - started,
      toolCalls: result.toolCalls ?? 0,
      reasons: decision.reasons,
      lifecycle,
    });
    if (validation.valid) this.emit('AI_PROPOSAL_VALIDATED', `${record.id}: ${validation.checks.join(', ')}`);
    else
      this.emit(
        'AI_PROPOSAL_REJECTED',
        `${record.id} ${validation.rejection}: ${validation.reasons.join('; ')}`,
      );
    if (decision.accepted)
      this.emit(
        'AI_PROPOSAL_ACCEPTED',
        `${record.id}: ${record.proposal?.selectedActionId ?? ''} ${record.proposal?.action ?? ''} (${decision.reasons.join('; ')})`,
      );
    else if (validation.valid && validation.proposal.status === 'PROPOSAL' && this.options.mode === 'HYBRID')
      this.emit('AI_PROPOSAL_REJECTED', `${record.id}: not selected — ${decision.reasons.join('; ')}`);
    if (shadow === false)
      this.emit(
        'AI_SHADOW_DISAGREEMENT',
        `${record.id}: deterministic ${input.deterministic.actionId ?? 'none'} vs proposed ${record.proposal?.selectedActionId ?? ''}`,
      );
    this.classified(record);
    return { record, decision, validation };
  }

  /**
   * L'issue d'une décision, en une trace lisible (§45) : déclencheur, contexte fonctionnel,
   * modèle, proposition, validation, shadow, exécution. Un repli n'est annoncé QUE s'il en est un.
   */
  private classified(record: AiDecisionRecord): void {
    const { lifecycle } = record;
    const functional = record.functionalContext;
    if (lifecycle.shadowResult)
      this.emit(
        'AI_SHADOW_RECORDED',
        `${record.id} ${lifecycle.shadowResult}: deterministic ${record.deterministic.actionId ?? 'none'} vs proposed ${record.proposal?.selectedActionId ?? 'none'}`,
      );
    if (lifecycle.fallbackReason)
      this.emit(
        'AI_FALLBACK_ACTIVATED',
        `${record.id} ${lifecycle.fallbackReason}: deterministic decision kept (${record.reasons[0] ?? record.outcome})`,
      );
    const fields: [string, string | number | undefined][] = [
      ['trigger', record.trigger],
      ['context', record.context],
      ['mission', functional?.mission],
      ['goal', functional?.goal ?? record.goal],
      ['checkpoint', functional?.lastConfirmedCheckpoint],
      ['missing', functional?.missingPreconditions.join('|') || undefined],
      ['deterministicConfidence', record.deterministic.confidence],
      ['model', record.modelContext?.effectiveModel ?? record.modelContext?.selectedModel ?? record.model],
      ['mode', record.mode],
      ['response', lifecycle.response],
      ['proposal.action', record.proposal?.selectedActionId],
      [
        'proposal.hypothesis',
        record.proposal?.hypothesisType ?? (record.proposal?.hypothesis ? 'PROPOSED' : undefined),
      ],
      ['proposal.precondition', record.proposal?.missingPrecondition],
      ['proposal.confidence', record.proposal?.confidence],
      [
        'validation',
        lifecycle.proposalValid === undefined
          ? 'NOT_RECEIVED'
          : lifecycle.proposalValid
            ? 'VALID'
            : 'INVALID',
      ],
      ['shadow', lifecycle.shadowResult],
      ['terminal', lifecycle.terminal],
      [
        'execution',
        lifecycle.acceptedForExecution
          ? 'ACCEPTED_FOR_EXECUTION'
          : `NOT_EXECUTED_${lifecycle.notExecutedReason ?? 'NO_RESPONSE'}`,
      ],
      ['fallback', lifecycle.fallbackReason],
    ];
    this.emit(
      'AI_DECISION_CLASSIFIED',
      `[AI ${record.id}] ${fields
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')}`,
    );
  }

  /**
   * Le RUNTIME dit la vérité : la proposition exécutée a-t-elle produit l'effet attendu ?
   * Confirmée, elle peut devenir un candidat de connaissance (origine AI_PROPOSAL gardée) ;
   * contredite, elle n'est jamais apprise.
   */
  recordRuntime(id: string, confirmed: boolean, detail: string, progress?: AiGoalProgress): void {
    const record = this.audit.byId(id);
    if (!record) return;
    record.runtimeResult = confirmed ? 'GOAL_CONFIRMED' : 'RUNTIME_CONTRADICTED';
    record.runtimeDetail = detail.slice(0, 200);
    record.knowledgeCandidate = { origin: 'AI_PROPOSAL', runtimeConfirmed: confirmed };
    record.lifecycle.execution = 'EXECUTED';
    record.lifecycle.runtime = confirmed ? 'CONFIRMED' : 'CONTRADICTED';
    if (progress) record.lifecycle.goalProgress = progress;
    this.emit(confirmed ? 'AI_RUNTIME_CONFIRMED' : 'AI_RUNTIME_CONTRADICTED', `${id}: ${detail}`);
  }

  /** Retenue, mais le moteur de décision a finalement exécuté autre chose (ou le run s'est arrêté). */
  markNotExecuted(id: string): void {
    const record = this.audit.byId(id);
    if (!record || record.runtimeResult !== undefined) return;
    record.runtimeResult = 'NOT_EXECUTED';
    if (record.lifecycle.execution === 'PENDING') {
      record.lifecycle.execution = 'NOT_EXECUTED';
      record.lifecycle.runtime = 'NOT_APPLICABLE';
      record.lifecycle.notExecutedReason = 'EXECUTOR_CHOSE_OTHER';
    }
  }

  /** Ce que la décision a apporté à la connaissance (une hypothèse proposée, soutenue ou contredite). */
  recordKnowledge(id: string, impact: AiKnowledgeImpact): void {
    const record = this.audit.byId(id);
    if (record) record.lifecycle.knowledge = impact;
  }

  summary(): AiSummary {
    const reason = this.provider?.unavailableReason?.();
    const models = this.provider?.modelSummary?.();
    return this.audit.summarize({
      ...(models ? { modelSelection: models } : {}),
      mode: this.options.mode,
      provider: this.options.providerId,
      ...(this.provider?.model ? { model: this.provider.model } : {}),
      ...(this.availabilityResult !== undefined ? { available: this.availabilityResult } : {}),
      ...(reason ? { unavailableReason: reason } : {}),
      averageLatencyMs: this.budget.averageLatencyMs(),
      toolCalls: this.budget.usage.toolCalls,
      ...(this.budget.usage.inputTokens + this.budget.usage.outputTokens > 0
        ? { tokens: { input: this.budget.usage.inputTokens, output: this.budget.usage.outputTokens } }
        : {}),
    });
  }

  async close(): Promise<void> {
    await this.provider?.close?.().catch(() => undefined);
  }

  private availabilityResult: boolean | undefined;

  private ensureProvider(): IntelligenceProvider {
    this.provider ??= this.options.createProvider();
    return this.provider;
  }

  private isAvailable(): Promise<boolean> {
    this.availability ??= this.ensureProvider()
      .isAvailable()
      .catch(() => false)
      .then((available) => {
        this.availabilityResult = available;
        if (available) this.emit('AI_SESSION_CREATED', `${this.options.providerId} ready`);
        return available;
      });
    return this.availability;
  }

  private async withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError());
      }, ms);
    });
    try {
      return await Promise.race([run(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private emit(event: AiEvent, message: string): void {
    this.options.emit?.({ event, message: sanitizeText(message) });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private clock(): string {
    return this.options.clock?.() ?? new Date().toISOString();
  }
}

/** Une issue « sans réponse » de la passerelle → la cause du cycle de vie. */
const FAILURE_OF: Partial<Record<AiOutcome, AiCallFailure>> = {
  AI_UNAVAILABLE: 'UNAVAILABLE',
  AI_TIMEOUT: 'TIMEOUT',
  AI_BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  AI_MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  NO_LLM_REQUIRED: 'NO_LLM_REQUIRED',
  AI_ERROR: 'ERROR',
};

/** Le contexte fonctionnel d'une requête, résumé pour l'audit et la trace. */
function functionalSummaryOf(request: IntelligenceRequest): AiFunctionalContextSummary | undefined {
  const functional = request.functionalContext;
  if (!functional && !request.mission && !request.goal) return undefined;
  const divergence = functional?.firstDivergence;
  return {
    ...(request.mission ? { mission: request.mission } : {}),
    ...((functional?.currentGoal ?? request.goal?.id)
      ? { goal: functional?.currentGoal ?? request.goal?.id }
      : {}),
    ...(functional?.parentGoal ? { parentGoal: functional.parentGoal } : {}),
    ...(functional?.goalProgress !== undefined ? { goalProgress: functional.goalProgress } : {}),
    ...(functional?.lastConfirmedCheckpoint
      ? { lastConfirmedCheckpoint: functional.lastConfirmedCheckpoint }
      : {}),
    ...(functional?.nextExpectedCheckpoint
      ? { nextExpectedCheckpoint: functional.nextExpectedCheckpoint }
      : {}),
    missingPreconditions: (functional?.missingPreconditions ?? request.goal?.conditions ?? []).slice(0, 8),
    ...(functional?.unknownPrecondition ? { unknownPrecondition: true } : {}),
    ...(functional?.blockingReasons[0]
      ? { blockingReason: functional.blockingReasons[0].slice(0, 200) }
      : {}),
    ...(divergence
      ? { firstDivergence: `step ${String(divergence.step)} ${divergence.description}`.slice(0, 200) }
      : {}),
    ...(functional?.question ? { question: functional.question.slice(0, 200) } : {}),
  };
}

function labelOf(request: IntelligenceRequest, id: string): string | undefined {
  const action = request.availableActions.find((candidate) => candidate.id === id);
  return action ? `${action.type} "${action.name}"` : undefined;
}

function inputSummary(request: IntelligenceRequest, redactions: number): AiDecisionRecord['input'] {
  return {
    actions: request.availableActions.length,
    evidence: request.relevantEvidence.length,
    hypotheses: request.hypotheses.length,
    contradictions: request.contradictions.length,
    redactions,
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;
