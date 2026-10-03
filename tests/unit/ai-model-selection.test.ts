import { describe, expect, it } from 'vitest';
import { IntelligenceContextBuilder, type ContextSources } from '../../src/ai/context-builder.js';
import { createIntelligenceGateway } from '../../src/ai/factory.js';
import { IntelligenceGateway, type AiEventRecord } from '../../src/ai/gateway.js';
import type { IntelligenceRequest, ProviderCallOptions } from '../../src/ai/model.js';
import { AvailableModelRegistry } from '../../src/ai/models/available-model-registry.js';
import { ModelCapabilityResolver, type SdkModelInfo } from '../../src/ai/models/capability-resolver.js';
import { ReasoningComplexityAnalyzer } from '../../src/ai/models/complexity-analyzer.js';
import { ModelSelectionPolicy, type SelectionInput } from '../../src/ai/models/model-selection-policy.js';
import {
  ReasoningEffortPolicy,
  type ReasoningSettings,
} from '../../src/ai/models/reasoning-effort-policy.js';
import {
  CopilotIntelligenceProvider,
  type CopilotModelSettings,
} from '../../src/ai/providers/copilot-provider.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import { parseCliArgs } from '../../src/cli/args.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';
import { answerByName, fakeSdk, type FakeSdkOptions } from '../fixtures/fake-copilot-sdk.js';

/** Les ModelInfo tels que le SDK les rend (ids neutres : aucun nom de modèle réel). */
const MODEL_FAST: SdkModelInfo = {
  id: 'model-fast',
  name: 'Fast model',
  capabilities: {
    supports: { vision: false, reasoningEffort: false },
    limits: { max_context_window_tokens: 64_000 },
  },
  policy: { state: 'enabled' },
  billing: { multiplier: 0.33 },
};
const MODEL_DEEP: SdkModelInfo = {
  id: 'model-deep',
  name: 'Deep model',
  capabilities: {
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000 },
  },
  policy: { state: 'enabled' },
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
};
const MODEL_MEDIUM_ONLY: SdkModelInfo = {
  id: 'model-medium',
  capabilities: {
    supports: { vision: false, reasoningEffort: true },
    limits: { max_context_window_tokens: 128_000 },
  },
  supportedReasoningEfforts: ['low', 'medium'],
};
const MODEL_LOCKED: SdkModelInfo = {
  id: 'model-locked',
  capabilities: {
    supports: { vision: false, reasoningEffort: false },
    limits: { max_context_window_tokens: 128_000 },
  },
  policy: { state: 'disabled' },
};
const MODEL_TINY: SdkModelInfo = {
  id: 'model-tiny',
  capabilities: {
    supports: { vision: false, reasoningEffort: false },
    limits: { max_context_window_tokens: 2_000 },
  },
};
const ALL = [MODEL_FAST, MODEL_DEEP, MODEL_MEDIUM_ONLY, MODEL_LOCKED, MODEL_TINY];

const REASONING: ReasoningSettings = {
  mode: 'ADAPTIVE',
  default: 'MEDIUM',
  lowComplexity: 'LOW',
  mediumComplexity: 'MEDIUM',
  highComplexity: 'HIGH',
  veryHighComplexity: 'HIGH',
};
const PROFILES = {
  FAST: { models: [] as string[], autoTier: 'efficiency' as const },
  BALANCED: { models: [] as string[], autoTier: 'balance' as const },
  INTELLIGENCE: { models: [] as string[], autoTier: 'intelligence' as const },
};
const discovered = (models: SdkModelInfo[] = ALL) => ({
  status: 'OK' as const,
  models: models.map((model) => ModelCapabilityResolver.fromSdk(model)),
});
const complexity = (level: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' | 'TRIVIAL') => ({
  level,
  score: 3,
  reasons: [`${level} test`],
});
const select = (input: Partial<SelectionInput>) =>
  ModelSelectionPolicy.select({
    mode: 'ADAPTIVE',
    complexity: complexity('MEDIUM'),
    required: { structuredOutput: true, minContextTokens: 6_000 },
    profiles: PROFILES,
    defaultProfile: 'BALANCED',
    reasoning: REASONING,
    fallback: { enabled: true, strategy: 'AUTO' },
    ...input,
  });

const builder = () =>
  new IntelligenceContextBuilder({ maxActions: 25, maxEvidence: 10, maxHypotheses: 8, maxPlanSteps: 10 });
const hypothesis = (id: string, confidence: number) => ({
  id,
  proposition: {
    kind: 'CAUSAL' as const,
    subject: 'click enterprise',
    relation: 'REVEALS',
    object: 'textbox:company name',
  },
  evidenceFor: [],
  evidenceAgainst: [],
  confidence,
  status: 'SUPPORTED' as const,
  testability: { testable: true, reason: '' },
  createdAt: '',
  updatedAt: '',
});
function request(
  extra: Partial<ContextSources> = {},
  trigger: IntelligenceRequest['trigger'] = 'AMBIGUOUS_TARGET',
) {
  return builder().build(trigger, {
    goal: { id: 'COMPANY_INFORMATION_AVAILABLE', conditions: ['field Company name'] },
    situation: {
      phase: 'EUR_SELECTED',
      facts: [],
      phases: [],
      submission: 'BLOCKED',
      missing: [],
      evidence: [],
    },
    candidates: [
      {
        key: 'a17',
        kind: 'click',
        role: 'tab',
        name: 'Enterprise',
        safety: 'SAFE',
        allowed: true,
        score: 0.51,
      },
      {
        key: 'a18',
        kind: 'click',
        role: 'link',
        name: 'Company profile',
        safety: 'SAFE',
        allowed: true,
        score: 0.49,
      },
    ],
    evidence: [
      {
        id: 'E31',
        type: 'STATIC_SOURCE',
        source: 'CompanyForm',
        confidence: 0.6,
        details: { field: 'Company name' },
      },
    ],
    hypotheses: [],
    contradictions: [],
    deterministic: { key: 'a17', confidence: 0.51, status: 'DECIDED' },
    ...extra,
  }).request;
}

function provider(
  settings: Partial<CopilotModelSettings>,
  sdk: FakeSdkOptions = {},
  answer = answerByName('Enterprise'),
) {
  const { state, load } = fakeSdk(answer, { models: ALL, ...sdk });
  const copilot = new CopilotIntelligenceProvider({
    models: {
      selection: { mode: 'ADAPTIVE', defaultProfile: 'BALANCED', profiles: PROFILES },
      reasoning: REASONING,
      fallback: { enabled: true, strategy: 'AUTO' },
      discovery: { cache: true, ttlMs: 600_000, refreshOnUnavailableModel: true },
      ...settings,
    },
    sessionReuse: true,
    tools: false,
    timeoutMs: 5_000,
    startTimeoutMs: 5_000,
    baseDirectory: '/tmp/qa-copilot-models',
    env: {},
    loadSdk: load,
    sanitize: (value) => value,
  });
  const events: { event: string; message: string }[] = [];
  const call = (level: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' = 'MEDIUM'): ProviderCallOptions => ({
    signal: new AbortController().signal,
    maxToolCalls: 0,
    complexity: complexity(level),
    emit: (event, message) => events.push({ event, message }),
  });
  return { copilot, state, events, call };
}

describe('Copilot model management: discovery, capabilities, complexity, selection, effort, fallback', () => {
  it('§3–§7 the registry lists what the SDK reports, never invents a capability, and caches with a TTL', async () => {
    let now = 0;
    let calls = 0;
    const events: string[] = [];
    const registry = new AvailableModelRegistry({
      discover: () => {
        calls += 1;
        return Promise.resolve(ALL);
      },
      cache: true,
      ttlMs: 1_000,
      now: () => now,
      emit: (event) => events.push(event),
    });
    const first = await registry.models();
    await registry.models();
    expect(calls).toBe(1);
    expect(first.models.find((model) => model.id === 'model-deep')).toEqual({
      id: 'model-deep',
      name: 'Deep model',
      available: true,
      capabilities: {
        reasoning: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
        vision: true,
        maxContextTokens: 200_000,
        maxOutputTokens: 32_000,
      },
    });
    // tools / structuredOutput : le SDK ne les décrit pas → inconnues, jamais supposées.
    expect(first.models.every((model) => model.capabilities.tools === undefined)).toBe(true);
    expect(first.models.find((model) => model.id === 'model-locked')).toMatchObject({
      available: false,
      unavailableReason: 'MODEL_NOT_AUTHORIZED',
    });
    now = 2_000;
    await registry.models();
    expect(calls).toBe(2);
    await registry.refreshModels();
    expect(calls).toBe(3);
    expect(events).toEqual(
      expect.arrayContaining(['AI_MODEL_DISCOVERY_STARTED', 'AI_MODEL_DISCOVERY_COMPLETED']),
    );
  });

  it('§67 a failed discovery is reported (AI_MODEL_DISCOVERY_FAILED), never thrown', async () => {
    const events: string[] = [];
    const registry = new AvailableModelRegistry({
      discover: () => Promise.reject(new Error('503')),
      cache: true,
      ttlMs: 1_000,
      emit: (event) => events.push(event),
    });
    expect(await registry.models()).toMatchObject({ status: 'FAILED', error: '503' });
    expect(events).toContain('AI_MODEL_DISCOVERY_FAILED');
  });

  it('§68 / §48 TRIVIAL: high confidence, one action, known goal → no LLM', () => {
    const trivial = builder().build('LOW_DECISION_CONFIDENCE', {
      goal: { id: 'COMPANY_INFORMATION_AVAILABLE', conditions: [] },
      candidates: [
        { key: 'a', kind: 'click', role: 'tab', name: 'Enterprise', safety: 'SAFE', allowed: true },
      ],
      evidence: [],
      hypotheses: [],
      contradictions: [],
      deterministic: { key: 'a', confidence: 0.96, status: 'DECIDED' },
    }).request;
    expect(new ReasoningComplexityAnalyzer().analyze(trivial).level).toBe('TRIVIAL');
    expect(select({ complexity: complexity('TRIVIAL') })).toMatchObject({ status: 'NO_LLM_REQUIRED' });
  });

  it('§69 / §49 ambiguity: two plausible actions, close hypotheses, known goal → MEDIUM → BALANCED', () => {
    const assessment = new ReasoningComplexityAnalyzer().analyze(
      request({ hypotheses: [hypothesis('H17', 0.58), hypothesis('H18', 0.55)] }),
    );
    expect(assessment.level).toBe('MEDIUM');
    expect(assessment.reasons).toEqual(
      expect.arrayContaining(['2 plausible actions', 'competing hypotheses (0.58 vs 0.55)']),
    );
    expect(select({ complexity: assessment })).toMatchObject({
      profile: 'BALANCED',
      selectedModel: 'auto',
      autoTier: 'balance',
      requestedReasoningEffort: 'MEDIUM',
    });
  });

  it('§70 / §50 deep reasoning: divergence + contradictions + unknown prerequisite + plans → VERY_HIGH → INTELLIGENCE', () => {
    const deep = request(
      {
        situation: undefined,
        goal: {
          id: 'COMPANY_INFORMATION_AVAILABLE',
          conditions: ['REGISTERED_SELECTED', 'COMPANY_TAB_AVAILABLE'],
        },
        candidates: [
          { key: 'a', kind: 'click', role: 'tab', name: 'Enterprise', safety: 'SAFE', allowed: true },
          { key: 'b', kind: 'click', role: 'link', name: 'Profile', safety: 'SAFE', allowed: true },
          { key: 'c', kind: 'check', role: 'checkbox', name: 'Registered', safety: 'SAFE', allowed: true },
        ],
        hypotheses: [hypothesis('H1', 0.5), hypothesis('H2', 0.45)],
        contradictions: [
          {
            id: 'C1',
            property: 'company.required',
            types: ['SOURCE_RUNTIME_MISMATCH'],
            claims: [],
            status: 'OPEN',
            confidencePenalty: 0.2,
            investigation: 'observe',
          },
        ],
        deterministic: { confidence: 0.41, status: 'RECOVERY_EXHAUSTED' },
      },
      'RECOVERY_EXHAUSTED',
    );
    const assessment = new ReasoningComplexityAnalyzer().analyze(deep, {
      recoveryAttempts: 3,
      plausiblePlans: 3,
      divergence: 'PREREQUISITE_MISSING',
    });
    expect(assessment.level).toBe('VERY_HIGH');
    const decision = select({ complexity: assessment });
    expect(decision).toMatchObject({
      profile: 'INTELLIGENCE',
      autoTier: 'intelligence',
      requestedReasoningEffort: 'HIGH',
    });
    // Le routage `auto` ne dit pas d'avance quel modèle répondra : aucun effort envoyé à l'aveugle.
    expect(decision.reasoningEffort).toBeUndefined();
    expect(decision.reasons.join(' ')).toMatch(/REASONING_EFFORT_ADJUSTED: HIGH not sent/);
  });

  it('§9 / §10 EXPLICIT: the requested model is checked BEFORE any session', () => {
    expect(
      select({
        mode: 'EXPLICIT',
        requestedModel: 'model-deep',
        discovery: discovered(),
        complexity: complexity('HIGH'),
      }),
    ).toMatchObject({
      status: 'SELECTED',
      requestedModel: 'model-deep',
      selectedModel: 'model-deep',
      reasoningEffort: 'HIGH',
      confidence: 1,
    });
  });

  it('§65 / §71 / §38 / §39 EXPLICIT unavailable: visible fallback (requested ≠ selected) — or no model when disabled', () => {
    const fallback = select({
      mode: 'EXPLICIT',
      requestedModel: 'NON_EXISTENT_MODEL',
      discovery: discovered(),
    });
    expect(fallback).toMatchObject({
      requestedModel: 'NON_EXISTENT_MODEL',
      selectedModel: 'auto',
      fallback: { reason: 'MODEL_NOT_AVAILABLE', from: 'NON_EXISTENT_MODEL', to: 'auto' },
    });
    const alternative = select({
      mode: 'EXPLICIT',
      requestedModel: 'model-locked',
      discovery: discovered(),
      fallback: { enabled: true, strategy: 'ALTERNATIVE' },
    });
    expect(alternative).toMatchObject({
      requestedModel: 'model-locked',
      selectedModel: 'model-fast',
      fallback: { reason: 'MODEL_NOT_AUTHORIZED', to: 'model-fast' },
    });
    expect(
      select({
        mode: 'EXPLICIT',
        requestedModel: 'NON_EXISTENT_MODEL',
        discovery: discovered(),
        fallback: { enabled: false, strategy: 'AUTO' },
      }),
    ).toMatchObject({ status: 'NO_MODEL', fallback: { reason: 'MODEL_NOT_AVAILABLE' } });
  });

  it('§25 required capabilities: a model known to be too small is never chosen', () => {
    expect(select({ mode: 'EXPLICIT', requestedModel: 'model-tiny', discovery: discovered() })).toMatchObject(
      {
        selectedModel: 'auto',
        fallback: { reason: 'MODEL_CAPABILITY_MISMATCH', from: 'model-tiny' },
      },
    );
  });

  it('§12 / §21 ADAPTIVE with configured profile candidates: the first usable one supporting the effort', () => {
    const profiles = {
      ...PROFILES,
      FAST: { models: ['model-fast'], autoTier: 'efficiency' as const },
      INTELLIGENCE: {
        models: ['model-locked', 'model-medium', 'model-deep'],
        autoTier: 'intelligence' as const,
      },
    };
    const deep = select({ profiles, discovery: discovered(), complexity: complexity('HIGH') });
    expect(deep).toMatchObject({
      profile: 'INTELLIGENCE',
      selectedModel: 'model-deep',
      reasoningEffort: 'HIGH',
    });
    expect(deep.reasons.join(' ')).toMatch(/skipped model-locked is listed but not enabled/);
    expect(select({ profiles, discovery: discovered(), complexity: complexity('LOW') })).toMatchObject({
      profile: 'FAST',
      selectedModel: 'model-fast',
    });
    // Candidats invérifiables (découverte en échec) : repli visible vers le routage officiel.
    expect(
      select({ profiles, discovery: { status: 'FAILED', models: [] }, complexity: complexity('HIGH') }),
    ).toMatchObject({
      selectedModel: 'auto',
      autoTier: 'intelligence',
      fallback: { reason: 'MODEL_DISCOVERY_FAILED' },
    });
  });

  it('§11 AUTO: the official routing, nothing reinvented', () => {
    expect(select({ mode: 'AUTO' })).toMatchObject({ mode: 'AUTO', selectedModel: 'auto', confidence: 0.6 });
    expect(select({ mode: 'AUTO' }).autoTier).toBeUndefined();
  });

  it('§26–§28 / §66 reasoning effort: only levels the model declares — adjusted, or not sent', () => {
    const medium = ModelCapabilityResolver.fromSdk(MODEL_MEDIUM_ONLY);
    expect(ReasoningEffortPolicy.resolve('HIGH', medium)).toEqual({
      effort: 'MEDIUM',
      adjusted: 'HIGH unsupported by model-medium: MEDIUM used',
    });
    expect(ReasoningEffortPolicy.resolve('HIGH', ModelCapabilityResolver.fromSdk(MODEL_FAST))).toEqual({
      adjusted: 'HIGH not sent: model-fast declares no reasoning effort',
    });
    expect(ReasoningEffortPolicy.requested('VERY_HIGH', REASONING)).toBe('HIGH');
    expect(ReasoningEffortPolicy.requested('LOW', { ...REASONING, mode: 'FIXED', default: 'MEDIUM' })).toBe(
      'MEDIUM',
    );
    expect(ReasoningEffortPolicy.requested('HIGH', { ...REASONING, mode: 'AUTO' })).toBeUndefined();
  });

  it('§45 / §66 the provider opens the session with the decision: model, declared effort, official auto tier', async () => {
    const adaptive = provider({});
    await adaptive.copilot.isAvailable();
    await adaptive.copilot.analyze(request(), adaptive.call('HIGH'));
    expect(adaptive.state.sessionRequests[0]).toMatchObject({
      model: 'auto',
      capi: { autoTier: 'intelligence' },
    });
    expect(adaptive.state.sessionRequests[0]?.reasoningEffort).toBeUndefined();
    expect(adaptive.state.discoveries).toBe(0); // rien à vérifier : pas de découverte inutile
    expect(adaptive.events.find((event) => event.event === 'AI_MODEL_SELECTED')?.message).toBe(
      '[AI] trigger=AMBIGUOUS_TARGET complexity=HIGH mode=ADAPTIVE profile=INTELLIGENCE model=auto autoTier=intelligence reasoning=not sent',
    );

    const explicit = provider({
      selection: { mode: 'EXPLICIT', model: 'model-medium', defaultProfile: 'BALANCED', profiles: PROFILES },
    });
    await explicit.copilot.isAvailable();
    const result = await explicit.copilot.analyze(request(), explicit.call('HIGH'));
    // HIGH demandé, MEDIUM déclaré : MEDIUM envoyé, ajustement tracé ; jamais une requête invalide.
    expect(explicit.state.sessionRequests[0]).toMatchObject({
      model: 'model-medium',
      reasoningEffort: 'medium',
    });
    expect(explicit.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'AI_MODEL_DISCOVERY_COMPLETED',
        'AI_REASONING_EFFORT_ADJUSTED',
        'AI_REASONING_EFFORT_SELECTED',
      ]),
    );
    expect(result.modelContext).toMatchObject({
      selectionMode: 'EXPLICIT',
      requestedModel: 'model-medium',
      selectedModel: 'model-medium',
      requestedReasoningEffort: 'HIGH',
      sentReasoningEffort: 'MEDIUM',
      fallbackApplied: false,
    });
  });

  it('§65 / §71 an unavailable explicit model never reaches createSession: fallback to auto, requested vs selected recorded', async () => {
    const missing = provider({
      selection: {
        mode: 'EXPLICIT',
        model: 'NON_EXISTENT_MODEL',
        defaultProfile: 'BALANCED',
        profiles: PROFILES,
      },
    });
    await missing.copilot.isAvailable();
    const result = await missing.copilot.analyze(request(), missing.call());
    expect(missing.state.sessionRequests.map((config) => config.model)).toEqual(['auto']);
    expect(result.modelContext).toMatchObject({
      requestedModel: 'NON_EXISTENT_MODEL',
      selectedModel: 'auto',
      fallbackApplied: true,
      fallbackReason: 'MODEL_NOT_AVAILABLE',
    });
    // Un cache est rafraîchi une fois avant de conclure (refreshOnUnavailableModel).
    expect(missing.state.discoveries).toBe(2);
    expect(missing.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['AI_MODEL_UNAVAILABLE', 'AI_MODEL_FALLBACK']),
    );
  });

  it('§37 MODEL_SESSION_CREATION_FAILED: the runtime refuses the model → fallback per policy', async () => {
    const refused = provider(
      {
        selection: { mode: 'EXPLICIT', model: 'model-deep', defaultProfile: 'BALANCED', profiles: PROFILES },
      },
      { rejectSessionModels: ['model-deep'] },
    );
    await refused.copilot.isAvailable();
    const result = await refused.copilot.analyze(request(), refused.call('HIGH'));
    expect(refused.state.sessionRequests.map((config) => config.model)).toEqual(['model-deep', 'auto']);
    expect(result.modelContext).toMatchObject({
      requestedModel: 'model-deep',
      selectedModel: 'auto',
      fallbackReason: 'MODEL_SESSION_CREATION_FAILED',
    });
  });

  it('§67 discovery fails: AUTO fallback when allowed; deterministic fallback otherwise — no crash', async () => {
    const tolerant = provider(
      {
        selection: { mode: 'EXPLICIT', model: 'model-deep', defaultProfile: 'BALANCED', profiles: PROFILES },
      },
      { discoveryFails: true },
    );
    await tolerant.copilot.isAvailable();
    const result = await tolerant.copilot.analyze(request(), tolerant.call());
    expect(result.modelContext).toMatchObject({
      selectedModel: 'auto',
      fallbackReason: 'MODEL_DISCOVERY_FAILED',
    });
    expect(tolerant.events.map((event) => event.event)).toContain('AI_MODEL_DISCOVERY_FAILED');

    // Repli DETERMINISTIC : la passerelle rend la décision déterministe (AI_MODEL_UNAVAILABLE).
    const strict = provider(
      {
        selection: { mode: 'EXPLICIT', model: 'model-deep', defaultProfile: 'BALANCED', profiles: PROFILES },
        fallback: { enabled: true, strategy: 'DETERMINISTIC' },
      },
      { discoveryFails: true },
    );
    const events: AiEventRecord[] = [];
    const gateway = gatewayFor(strict.copilot, events);
    const consult = await gateway.consult(consultInput(request()));
    expect(consult.record.outcome).toBe('AI_MODEL_UNAVAILABLE');
    expect(consult.record.modelContext).toMatchObject({
      requestedModel: 'model-deep',
      fallbackReason: 'MODEL_DISCOVERY_FAILED',
    });
    // Aucun modèle, aucune action proposée : la décision déterministe (ici, aucune action) est gardée.
    expect(consult.decision).toMatchObject({ source: 'NONE', accepted: false });
    expect(strict.state.sessionRequests).toHaveLength(0);
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['AI_MODEL_FALLBACK', 'AI_FALLBACK_ACTIVATED']),
    );
  });

  it('§43 / §72 effective model: only when the runtime reports it — never inferred', async () => {
    const observed = provider({}, { usageModel: () => 'routed-model-7' });
    await observed.copilot.isAvailable();
    const seen = await observed.copilot.analyze(request(), observed.call());
    expect(seen.modelContext).toMatchObject({ selectedModel: 'auto', effectiveModel: 'routed-model-7' });
    expect(observed.events.map((event) => event.event)).toContain('AI_EFFECTIVE_MODEL_OBSERVED');

    const silent = provider({}, { usageModel: () => null });
    await silent.copilot.isAvailable();
    const unseen = await silent.copilot.analyze(request(), silent.call());
    expect(unseen.modelContext?.selectedModel).toBe('auto');
    expect(unseen.modelContext?.effectiveModel).toBeUndefined();
  });

  it('§52 a reused session follows the decision: setModel when the profile changes', async () => {
    const reused = provider({});
    await reused.copilot.isAvailable();
    await reused.copilot.analyze(request(), reused.call('LOW'));
    await reused.copilot.analyze(request(), reused.call('VERY_HIGH'));
    expect(reused.state.sessions).toHaveLength(1);
    expect(reused.state.sessions[0]?.modelChanges).toEqual([{ model: 'auto', autoTier: 'intelligence' }]);
  });

  it('§62 / §83 OFF: no client, no discovery, no selection, no effort, no session', () => {
    const { config } = parseConfig(
      'target: { baseUrl: "http://localhost" }\nai: { mode: OFF, copilot: { modelSelection: { mode: EXPLICIT, model: m1 } } }',
      {},
      {},
    );
    const off = provider({});
    expect(createIntelligenceGateway(config.ai, { env: {}, provider: off.copilot })).toBeUndefined();
    expect(off.state.loads).toBe(0);
    expect(off.state.discoveries).toBe(0);
    expect(off.state.sessionRequests).toHaveLength(0);
    expect(off.events).toHaveLength(0);
  });

  it('§15 / §68 the gateway skips TRIVIAL reasoning: no provider call, no model selection', async () => {
    const fake = new FakeIntelligenceProvider(() => ({}));
    const events: AiEventRecord[] = [];
    const gateway = gatewayFor(fake, events);
    const trivial = builder().build('LOW_DECISION_CONFIDENCE', {
      goal: { id: 'G', conditions: [] },
      candidates: [
        { key: 'a', kind: 'click', role: 'tab', name: 'Enterprise', safety: 'SAFE', allowed: true },
      ],
      evidence: [],
      hypotheses: [],
      contradictions: [],
      deterministic: { key: 'a', confidence: 0.97, status: 'DECIDED' },
    }).request;
    const result = await gateway.consult(consultInput(trivial, 0.97));
    expect(result.record.outcome).toBe('NO_LLM_REQUIRED');
    expect(fake.requests).toHaveLength(0);
    expect(fake.availabilityChecks).toBe(0);
    expect(gateway.summary()).toMatchObject({ noLlmRequired: 1, calls: 0 });
    expect(events.map((event) => event.event)).toContain('AI_NO_LLM_REQUIRED');
  });

  it('§52–§57 / §73 per-model performance: a contradicted proposal is not a success; no rate on few samples', async () => {
    const answered = provider(
      {
        selection: { mode: 'EXPLICIT', model: 'model-deep', defaultProfile: 'BALANCED', profiles: PROFILES },
      },
      { usageModel: (config) => config.model ?? 'unknown' },
    );
    const gateway = gatewayFor(answered.copilot, [], 'HYBRID');
    const first = await gateway.consult(consultInput(request(), 0.3, 'S1'));
    const second = await gateway.consult(consultInput(request(), 0.3, 'S2'));
    expect(first.decision.accepted).toBe(true);
    gateway.recordRuntime(first.record.id, true, 'fields visible');
    gateway.recordRuntime(second.record.id, false, 'goal not reached');
    const summary = gateway.summary();
    expect(summary.models).toEqual([
      expect.objectContaining({
        model: 'model-deep',
        calls: 2,
        accepted: 2,
        runtimeConfirmed: 1,
        runtimeContradicted: 1,
      }),
    ]);
    expect(summary.effectiveness[0]).toMatchObject({
      model: 'model-deep',
      samples: 2,
      confirmationRate: null,
    });
    expect(summary.modelSelection).toMatchObject({
      selectionMode: 'EXPLICIT',
      requestedModel: 'model-deep',
      discovery: { status: 'OK' },
    });
    expect(summary.reasoning).toEqual({ MEDIUM: 2 });
  });

  it('§29–§35 configuration: ADAPTIVE by default; CLI > env > YAML; --ai-model implies EXPLICIT; legacy keys migrated', () => {
    const base = 'target: { baseUrl: "http://localhost" }\n';
    const defaults = parseConfig(base, {}, {}).config.ai.copilot;
    expect(defaults.modelSelection).toMatchObject({ mode: 'ADAPTIVE', defaultProfile: 'BALANCED' });
    expect(defaults.reasoning).toMatchObject({ mode: 'ADAPTIVE', veryHighComplexity: 'HIGH' });
    expect(defaults.fallback).toEqual({ enabled: true, strategy: 'AUTO' });
    expect(() =>
      parseConfig(`${base}ai: { copilot: { modelSelection: { mode: EXPLICIT } } }`, {}, {}),
    ).toThrow(/EXPLICIT needs modelSelection.model/);
    const args = parseCliArgs(['--ai-model', 'm-cli', '--ai-reasoning', 'high', 'mission.yaml']);
    const fromCli = parseConfig(
      base,
      {
        ...(args.aiModel ? { aiModel: args.aiModel } : {}),
        ...(args.aiReasoning ? { aiReasoning: args.aiReasoning } : {}),
      },
      { QA_COPILOT_MODEL: 'm-env', QA_COPILOT_REASONING_EFFORT: 'low' },
    ).config.ai.copilot;
    expect(fromCli.modelSelection).toMatchObject({ mode: 'EXPLICIT', model: 'm-cli' });
    expect(fromCli.reasoning).toMatchObject({ mode: 'FIXED', default: 'HIGH' });
    expect(
      parseConfig(base, { aiModelSelection: 'adaptive' }, { QA_COPILOT_MODEL: 'm-env' }).config.ai.copilot
        .modelSelection,
    ).toMatchObject({ mode: 'ADAPTIVE', model: 'm-env' });
    expect(() => parseCliArgs(['--ai-model-selection', 'best'])).toThrow();
    const legacy = parseConfig(
      `${base}ai: { copilot: { model: old-model, reasoningEffort: high, adaptiveReasoning: false } }`,
      {},
      {},
    );
    expect(legacy.config.ai.copilot.modelSelection).toMatchObject({ mode: 'EXPLICIT', model: 'old-model' });
    expect(legacy.config.ai.copilot.reasoning).toMatchObject({ mode: 'FIXED', default: 'HIGH' });
    expect(legacy.warnings.join(' ')).toMatch(/ai.copilot.model is deprecated/);
  });
});

function gatewayFor(
  provider: CopilotIntelligenceProvider | FakeIntelligenceProvider,
  events: AiEventRecord[],
  mode: 'ASSIST' | 'HYBRID' = 'HYBRID',
): IntelligenceGateway {
  return new IntelligenceGateway({
    mode,
    providerId: provider.id,
    createProvider: () => provider,
    triggers: {
      ambiguousTarget: true,
      unknownScreen: true,
      flowDivergence: true,
      recoveryFailed: true,
      multiplePlans: true,
      unresolvedHypothesis: true,
      unknownBusinessError: true,
      lowConfidence: true,
      knowledgeContradiction: true,
      unknownBlockingPrecondition: true,
      hypothesisAnalysis: true,
      recordingEnrichment: true,
    },
    thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    budgets: {
      maxCallsPerRun: 10,
      maxCallsPerAction: 1,
      maxCallsPerDivergence: 1,
      maxToolCallsPerRequest: 0,
      maxReasoningDurationMs: 60_000,
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    failOnUnavailable: false,
    sanitizer: new IntelligenceContextSanitizer(),
    emit: (record) => events.push(record),
  });
}

function consultInput(request: IntelligenceRequest, confidence = 0.4, action = 'S1') {
  return {
    context: 'EXPLORATION' as const,
    request,
    scope: { action },
    deterministic: { confidence },
    safety: () => ({ allowed: true, classification: 'SAFE', reason: 'test' }),
    knownEvidence: () => true,
  };
}
