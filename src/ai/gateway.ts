import { sanitizeText } from '../persistence/sanitize.js';
import {
  IntelligenceAuditTrail,
  type AiContext,
  type AiDecisionRecord,
  type AiOutcome,
  type AiSummary,
} from './audit-trail.js';
import { IntelligenceBudgetManager, type CallScope, type IntelligenceBudgets } from './budget-manager.js';
import {
  arbitrate,
  type ArbiterDecision,
  type ArbiterThresholds,
  type DeterministicChoice,
  type SafetyVerdict,
} from './hybrid-arbiter.js';
import {
  COMPLEX_TRIGGERS,
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
  reasoningEffort: string;
  adaptiveReasoning: boolean;
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
    };
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
        ...extra,
      });
      this.emit('AI_FALLBACK_ACTIVATED', `${record.id} ${outcome}: deterministic decision kept`);
      return { record, decision };
    };
    if (this.options.mode === 'OFF') return fallback('AI_UNAVAILABLE', ['intelligence OFF']);

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
    const effort = this.effortFor(request.trigger);
    let result: ProviderResult | undefined;
    let failure: { outcome: AiOutcome; reason: string } | undefined;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        result = await this.withTimeout(timeoutMs, (signal) =>
          provider.analyze(sanitized, {
            signal,
            ...(effort ? { reasoningEffort: effort } : {}),
            ...(input.tools ? { tools: input.tools } : {}),
            maxToolCalls: this.options.budgets.maxToolCallsPerRequest,
          }),
        );
        failure = undefined;
        break;
      } catch (error) {
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
      return fallback(failure?.outcome ?? 'AI_ERROR', [reason], redactions);
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
    const shadow =
      this.options.mode === 'ASSIST' && validation.valid && validation.proposal.selectedActionId
        ? validation.proposal.selectedActionId === input.deterministic.actionId
        : undefined;
    const record = this.audit.create({
      ...base,
      ...((result.model ?? provider.model) ? { model: result.model ?? provider.model } : {}),
      input: inputSummary(request, redactions),
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
              ...(proposal.failureCategory ? { failureCategory: proposal.failureCategory } : {}),
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
    if (!decision.accepted) this.emit('AI_FALLBACK_ACTIVATED', `${record.id}: deterministic decision kept`);
    return { record, decision, validation };
  }

  /**
   * Le RUNTIME dit la vérité : la proposition exécutée a-t-elle produit l'effet attendu ?
   * Confirmée, elle peut devenir un candidat de connaissance (origine AI_PROPOSAL gardée) ;
   * contredite, elle n'est jamais apprise.
   */
  recordRuntime(id: string, confirmed: boolean, detail: string): void {
    const record = this.audit.byId(id);
    if (!record) return;
    record.runtimeResult = confirmed ? 'GOAL_CONFIRMED' : 'RUNTIME_CONTRADICTED';
    record.runtimeDetail = detail.slice(0, 200);
    record.knowledgeCandidate = { origin: 'AI_PROPOSAL', runtimeConfirmed: confirmed };
    this.emit(confirmed ? 'AI_RUNTIME_CONFIRMED' : 'AI_RUNTIME_CONTRADICTED', `${id}: ${detail}`);
  }

  /** Retenue, mais le moteur de décision a finalement exécuté autre chose (ou le run s'est arrêté). */
  markNotExecuted(id: string): void {
    const record = this.audit.byId(id);
    if (record && record.runtimeResult === undefined) record.runtimeResult = 'NOT_EXECUTED';
  }

  summary(): AiSummary {
    const reason = this.provider?.unavailableReason?.();
    return this.audit.summarize({
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

  private effortFor(trigger: IntelligenceRequest['trigger']): string | undefined {
    const configured = this.options.reasoningEffort;
    if (configured !== 'auto') return configured;
    if (!this.options.adaptiveReasoning) return undefined;
    return COMPLEX_TRIGGERS.includes(trigger) ? 'high' : 'medium';
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
