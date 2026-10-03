import { CopilotClientManager, type CopilotClientManagerOptions } from '../copilot/client-manager.js';
import { buildUserPrompt, extractJson } from '../copilot/prompt-builder.js';
import type { CopilotSessionLike } from '../copilot/sdk.js';
import { createAdvisorSessionConfig } from '../copilot/session-factory.js';
import { CopilotToolRegistry } from '../copilot/tool-registry.js';
import {
  INTELLIGENCE_PROPOSAL_JSON_SCHEMA,
  type IntelligenceRequest,
  type IntelligenceToolContext,
  type ProviderCallOptions,
  type ProviderResult,
} from '../model.js';
import { AvailableModelRegistry, type ModelDiscoverySnapshot } from '../models/available-model-registry.js';
import type { ComplexityAssessment } from '../models/complexity-analyzer.js';
import { ModelFallbackPolicy, type FallbackSettings } from '../models/model-fallback-policy.js';
import { ModelSelectionPolicy, type ProfileSettings } from '../models/model-selection-policy.js';
import {
  ModelUnavailableError,
  type ModelExecutionContext,
  type ModelProfile,
  type ModelSelectionDecision,
  type ModelSelectionMode,
  type ReasoningEffortLevel,
  type RequiredCapabilities,
} from '../models/model-types.js';
import { ReasoningEffortPolicy, type ReasoningSettings } from '../models/reasoning-effort-policy.js';
import type { IntelligenceProvider, ProviderModelSummary } from '../provider.js';

export interface CopilotModelSettings {
  selection: {
    mode: ModelSelectionMode;
    model?: string;
    defaultProfile: ModelProfile;
    profiles: Record<ModelProfile, ProfileSettings>;
  };
  reasoning: ReasoningSettings;
  fallback: FallbackSettings;
  discovery: { cache: boolean; ttlMs: number; refreshOnUnavailableModel: boolean };
}

export interface CopilotProviderOptions extends CopilotClientManagerOptions {
  models: CopilotModelSettings;
  sessionReuse: boolean;
  /** Outils de lecture exposés au modèle (désactivables). */
  tools: boolean;
  timeoutMs: number;
  /** Nettoyage des résultats d'outils (le même que pour les requêtes). */
  sanitize: (value: unknown) => unknown;
  /** Un client déjà construit (tests). */
  manager?: CopilotClientManager;
}

/** Jetons estimés pour une requête (≈ 4 caractères par jeton, + instructions, outils et réponse). */
const estimateTokens = (request: IntelligenceRequest): number =>
  Math.ceil(JSON.stringify(request).length / 4) + 4_000;

/**
 * COPILOT INTELLIGENCE PROVIDER : GitHub Copilot comme CONSEILLER de raisonnement, par le SDK
 * officiel (`@github/copilot-sdk`). Il reçoit une requête structurée et nettoyée, peut lire
 * l'état au travers d'outils de lecture, et rend une proposition structurée (sortie au schéma
 * JSON). Il n'a aucun moyen d'agir : ni Playwright, ni shell, ni fichiers.
 *
 * Le MODÈLE est choisi pour chaque raisonnement (ModelSelectionPolicy) parmi ceux que le SDK
 * DÉCOUVRE (AvailableModelRegistry), avec un effort que le modèle DÉCLARE
 * (ReasoningEffortPolicy), et un repli visible (ModelFallbackPolicy). Le modèle réellement
 * utilisé n'est rapporté que s'il est observé (événement `assistant.usage`).
 */
export class CopilotIntelligenceProvider implements IntelligenceProvider {
  readonly id = 'copilot';
  private readonly manager: CopilotClientManager;
  private readonly registry: CopilotToolRegistry | undefined;
  readonly models: AvailableModelRegistry;
  private current: IntelligenceToolContext | undefined;
  private emitter: ProviderCallOptions['emit'];
  private toolCalls = 0;
  private toolLimit = 0;
  /** Ce que porte la session réutilisée (modèle, préférence, effort) : la changer si besoin. */
  private sessionState: { model: string; autoTier?: string; effort?: string } | undefined;
  private structuredOutput = true;
  model: string | undefined;

  constructor(private readonly options: CopilotProviderOptions) {
    this.manager = options.manager ?? new CopilotClientManager(options);
    this.registry = options.tools
      ? new CopilotToolRegistry({
          current: () => this.current,
          sanitize: options.sanitize,
          allow: () => {
            if (this.toolCalls >= this.toolLimit) return false;
            this.toolCalls += 1;
            return true;
          },
        })
      : undefined;
    this.models = new AvailableModelRegistry({
      discover: () => this.manager.listModels(),
      cache: options.models.discovery.cache,
      ttlMs: options.models.discovery.ttlMs,
      emit: (event, message) => this.emitter?.(event, message),
    });
  }

  /** Combien de clients ont été créés (0 tant qu'aucune requête n'a eu lieu). */
  get clientsCreated(): number {
    return this.manager.clientsCreated;
  }

  unavailableReason(): string | undefined {
    return this.manager.unavailableReason;
  }

  /** Le client démarre et le compte est authentifié. Le modèle se choisit à chaque requête. */
  isAvailable(): Promise<boolean> {
    return this.manager.isAvailable();
  }

  modelSummary(): ProviderModelSummary {
    const settings = this.options.models;
    const last = this.models.last();
    return {
      selectionMode: settings.selection.mode,
      ...(settings.selection.model ? { requestedModel: settings.selection.model } : {}),
      defaultProfile: settings.selection.defaultProfile,
      reasoningMode: settings.reasoning.mode,
      ...(last
        ? {
            discovery: {
              status: last.status,
              available: last.models.filter((model) => model.available).length,
              listed: last.models.length,
              ...(last.at ? { at: last.at } : {}),
              ...(last.error ? { error: last.error } : {}),
            },
          }
        : {}),
    };
  }

  async analyze(request: IntelligenceRequest, options: ProviderCallOptions): Promise<ProviderResult> {
    this.emitter = options.emit;
    this.current = options.tools;
    this.toolCalls = 0;
    this.toolLimit = options.tools ? options.maxToolCalls : 0;
    const complexity: ComplexityAssessment = options.complexity ?? {
      level: 'MEDIUM',
      score: 0,
      reasons: ['no complexity assessment'],
    };
    const required: RequiredCapabilities = {
      ...(this.registry ? { tools: true } : {}),
      structuredOutput: true,
      minContextTokens: estimateTokens(request),
    };
    let decision = await this.decide(complexity, required, request.trigger);
    const context = (extra: Partial<ModelExecutionContext> = {}): ModelExecutionContext =>
      executionContext(decision, complexity, extra);
    if (decision.status !== 'SELECTED' || !decision.selectedModel)
      throw new ModelUnavailableError(decision.fallback?.reason ?? 'MODEL_NOT_AVAILABLE', context());

    let session: CopilotSessionLike;
    try {
      session = await this.openSession(decision);
    } catch (error) {
      // MODEL_SESSION_CREATION_FAILED : un modèle précis refusé par le runtime → repli de la politique.
      const failed = decision.selectedModel;
      const detail = error instanceof Error ? error.message.slice(0, 160) : String(error);
      const autoTierRefused = failed === 'auto' && decision.autoTier !== undefined;
      if (failed === 'auto' && !autoTierRefused) throw error;
      const resolution = autoTierRefused
        ? ({ action: 'AUTO', reasons: ['auto tier refused by the runtime: plain auto routing'] } as const)
        : ModelFallbackPolicy.resolve('MODEL_SESSION_CREATION_FAILED', this.options.models.fallback, {
            models: this.models.last()?.models ?? [],
            exclude: [failed],
            required,
          });
      this.emitter?.('AI_MODEL_FALLBACK', `MODEL_SESSION_CREATION_FAILED ${failed}: ${detail}`);
      const fallback = { reason: 'MODEL_SESSION_CREATION_FAILED' as const, from: failed };
      if (resolution.action === 'NONE') {
        decision = {
          ...decision,
          status: 'NO_MODEL',
          fallback,
          reasons: [...decision.reasons, ...resolution.reasons],
        };
        throw new ModelUnavailableError('MODEL_SESSION_CREATION_FAILED', context());
      }
      const next = resolution.action === 'MODEL' ? resolution.model : undefined;
      const effort = ReasoningEffortPolicy.resolve(decision.requestedReasoningEffort, next);
      const rest = { ...decision };
      delete rest.autoTier;
      delete rest.reasoningEffort;
      decision = {
        ...rest,
        selectedModel: next?.id ?? 'auto',
        ...(!autoTierRefused && decision.autoTier && !next ? { autoTier: decision.autoTier } : {}),
        ...(effort.effort ? { reasoningEffort: effort.effort } : {}),
        fallback: { ...fallback, to: next?.id ?? 'auto' },
        reasons: [
          ...decision.reasons,
          ...resolution.reasons,
          ...(effort.adjusted ? [`REASONING_EFFORT_ADJUSTED: ${effort.adjusted}`] : []),
        ],
      };
      this.emitSelection(decision, request.trigger);
      session = await this.openSession(decision);
    }

    const usage = { inputTokens: 0, outputTokens: 0 };
    let effectiveModel: string | undefined;
    let effectiveEffort: ReasoningEffortLevel | undefined;
    const unsubscribe = session.on?.('assistant.usage', (event) => {
      const data = event.data ?? {};
      if (typeof data.inputTokens === 'number') usage.inputTokens += data.inputTokens;
      if (typeof data.outputTokens === 'number') usage.outputTokens += data.outputTokens;
      // Le modèle et l'effort RÉELLEMENT utilisés : rapportés par le runtime, jamais supposés.
      if (typeof data.model === 'string' && data.model.length > 0) effectiveModel = data.model;
      if (typeof data.reasoningEffort === 'string') {
        const level = data.reasoningEffort.toUpperCase();
        if (level === 'LOW' || level === 'MEDIUM' || level === 'HIGH') effectiveEffort = level;
      }
    });
    const onAbort = () => {
      void session.abort?.().catch(() => undefined);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const content = await this.send(session, request);
      if (effectiveModel) {
        this.model = effectiveModel;
        this.emitter?.(
          'AI_EFFECTIVE_MODEL_OBSERVED',
          `${effectiveModel}${decision.selectedModel !== effectiveModel ? ` (selected ${decision.selectedModel})` : ''}`,
        );
      }
      return {
        raw: extractJson(content),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        toolCalls: this.toolCalls,
        ...(usage.inputTokens + usage.outputTokens > 0 ? { usage } : {}),
        modelContext: context({
          ...(effectiveModel ? { effectiveModel } : {}),
          ...(effectiveEffort ? { effectiveReasoningEffort: effectiveEffort } : {}),
        }),
      };
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
      this.current = undefined;
      if (!this.options.sessionReuse) {
        await this.manager.release(session);
        this.sessionState = undefined;
      }
    }
  }

  async close(): Promise<void> {
    this.sessionState = undefined;
    await this.manager.close();
  }

  /**
   * La décision de modèle : découverte (en cache) seulement quand elle est utile — un modèle
   * EXPLICIT à vérifier, des candidats de profil ADAPTIVE. Un modèle demandé introuvable dans
   * un cache ancien déclenche UNE redécouverte avant le repli.
   */
  private async decide(
    complexity: ComplexityAssessment,
    required: RequiredCapabilities,
    trigger: string,
  ): Promise<ModelSelectionDecision> {
    const settings = this.options.models;
    const profiles = settings.selection.profiles;
    const needsDiscovery =
      (settings.selection.mode === 'EXPLICIT' && settings.selection.model !== undefined) ||
      (settings.selection.mode === 'ADAPTIVE' &&
        Object.values(profiles).some((profile) => profile.models.length > 0));
    const select = (discovery: ModelDiscoverySnapshot | undefined) =>
      ModelSelectionPolicy.select({
        mode: settings.selection.mode,
        ...(settings.selection.model ? { requestedModel: settings.selection.model } : {}),
        complexity,
        required,
        ...(discovery ? { discovery } : {}),
        profiles,
        defaultProfile: settings.selection.defaultProfile,
        reasoning: settings.reasoning,
        fallback: settings.fallback,
      });
    const discovery =
      needsDiscovery && complexity.level !== 'TRIVIAL' ? await this.models.models() : undefined;
    let decision = select(discovery);
    if (
      settings.discovery.refreshOnUnavailableModel &&
      discovery?.status === 'OK' &&
      (decision.fallback?.reason === 'MODEL_NOT_AVAILABLE' ||
        decision.fallback?.reason === 'MODEL_NOT_AUTHORIZED')
    )
      decision = select(await this.models.refreshModels());
    this.emitSelection(decision, trigger);
    return decision;
  }

  private emitSelection(decision: ModelSelectionDecision, trigger: string): void {
    const emit = this.emitter;
    if (!emit) return;
    if (decision.fallback) {
      const reason = decision.fallback.reason;
      if (reason === 'MODEL_NOT_AVAILABLE' || reason === 'MODEL_NOT_AUTHORIZED')
        emit('AI_MODEL_UNAVAILABLE', `${reason}: ${decision.fallback.from ?? '?'}`);
      if (reason === 'MODEL_CAPABILITY_MISMATCH')
        emit(
          'AI_MODEL_CAPABILITY_MISMATCH',
          decision.reasons.find((text) => text.includes('lacks')) ?? reason,
        );
      emit(
        'AI_MODEL_FALLBACK',
        `${reason}: requested ${decision.requestedModel ?? decision.fallback.from ?? '-'} → ${decision.fallback.to ?? 'no model (deterministic)'}`,
      );
    }
    if (decision.status !== 'SELECTED') return;
    emit(
      'AI_MODEL_SELECTED',
      `[AI] trigger=${trigger} complexity=${decision.complexity} mode=${decision.mode} profile=${decision.profile ?? '-'} model=${decision.selectedModel ?? '-'}${decision.autoTier ? ` autoTier=${decision.autoTier}` : ''} reasoning=${decision.reasoningEffort ?? 'not sent'}`,
    );
    const adjusted = decision.reasons.find((reason) => reason.startsWith('REASONING_EFFORT_ADJUSTED'));
    if (adjusted) emit('AI_REASONING_EFFORT_ADJUSTED', adjusted.replace('REASONING_EFFORT_ADJUSTED: ', ''));
    if (decision.reasoningEffort) emit('AI_REASONING_EFFORT_SELECTED', decision.reasoningEffort);
  }

  /** Une session au modèle choisi : réutilisée (et changée par setModel au besoin), ou neuve. */
  private async openSession(decision: ModelSelectionDecision): Promise<CopilotSessionLike> {
    const model = decision.selectedModel ?? 'auto';
    const effort = decision.reasoningEffort
      ? ReasoningEffortPolicy.toSdk(decision.reasoningEffort)
      : undefined;
    const wanted = {
      model,
      ...(decision.autoTier ? { autoTier: decision.autoTier } : {}),
      ...(effort ? { effort } : {}),
    };
    const config = createAdvisorSessionConfig({
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(decision.autoTier ? { autoTier: decision.autoTier } : {}),
      ...(this.registry ? { registry: this.registry } : {}),
      toolBudgetLeft: () => this.toolCalls < this.toolLimit,
    });
    const { session, created } = await this.manager.sessionFor(config, this.options.sessionReuse);
    const previous = this.sessionState;
    if (
      !created &&
      previous &&
      (previous.model !== wanted.model ||
        previous.autoTier !== wanted.autoTier ||
        previous.effort !== wanted.effort)
    ) {
      try {
        if (!session.setModel) throw new Error('setModel unavailable');
        await session.setModel(model, {
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(model === 'auto' ? { autoTier: decision.autoTier ?? null } : {}),
        });
      } catch {
        // Le runtime refuse le changement à chaud : une session neuve au bon modèle.
        await this.manager.resetSession();
        const fresh = await this.manager.sessionFor(config, this.options.sessionReuse);
        this.sessionState = wanted;
        return fresh.session;
      }
    }
    this.sessionState = wanted;
    return session;
  }

  /** La sortie structurée (schéma JSON) si le runtime la permet ; sinon le schéma dans le message. */
  private async send(session: CopilotSessionLike, request: IntelligenceRequest): Promise<string> {
    const prompt = buildUserPrompt(request);
    if (this.structuredOutput)
      try {
        const message = await session.sendAndWait(
          { prompt, responseSchema: INTELLIGENCE_PROPOSAL_JSON_SCHEMA },
          this.options.timeoutMs,
        );
        return message?.data.content ?? '';
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!/response.?(format|schema)|structured/i.test(text)) throw error;
        this.structuredOutput = false;
      }
    const message = await session.sendAndWait(
      {
        prompt: `${prompt}\nJSON schema of the answer: ${JSON.stringify(INTELLIGENCE_PROPOSAL_JSON_SCHEMA)}`,
      },
      this.options.timeoutMs,
    );
    return message?.data.content ?? '';
  }
}

function executionContext(
  decision: ModelSelectionDecision,
  complexity: ComplexityAssessment,
  extra: Partial<ModelExecutionContext>,
): ModelExecutionContext {
  return {
    selectionMode: decision.mode,
    complexity: complexity.level,
    complexityReasons: complexity.reasons.slice(0, 8),
    ...(decision.profile ? { profile: decision.profile } : {}),
    ...(decision.requestedModel ? { requestedModel: decision.requestedModel } : {}),
    ...(decision.selectedModel ? { selectedModel: decision.selectedModel } : {}),
    ...(decision.autoTier ? { autoTier: decision.autoTier } : {}),
    ...(decision.requestedReasoningEffort
      ? { requestedReasoningEffort: decision.requestedReasoningEffort }
      : {}),
    ...(decision.reasoningEffort ? { sentReasoningEffort: decision.reasoningEffort } : {}),
    fallbackApplied: decision.fallback !== undefined,
    ...(decision.fallback ? { fallbackReason: decision.fallback.reason } : {}),
    reasons: decision.reasons.slice(0, 10),
    ...extra,
  };
}
