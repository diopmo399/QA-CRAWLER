import { describe, expect, it } from 'vitest';
import { IntelligenceContextBuilder, type ContextSources } from '../../src/ai/context-builder.js';
import { QA_ADVISOR_SYSTEM_PROMPT, buildUserPrompt } from '../../src/ai/copilot/prompt-builder.js';
import type {
  AnthropicSdkModule,
  AnthropicClientOptionsLike,
  AnthropicMessageLike,
  AnthropicMessageRequest,
  AnthropicRequestOptionsLike,
} from '../../src/ai/anthropic/sdk.js';
import { createConfiguredProvider, createAnthropicProvider } from '../../src/ai/factory.js';
import { INTELLIGENCE_PROPOSAL_JSON_SCHEMA, type ProviderCallOptions } from '../../src/ai/model.js';
import { validateIntelligenceProposal } from '../../src/ai/proposal-validator.js';
import {
  AnthropicIntelligenceProvider,
  structuredOutputSchema,
  type AnthropicProviderOptions,
} from '../../src/ai/providers/anthropic-provider.js';
import { parseCliArgs } from '../../src/cli/args.js';
import { parseConfig } from '../../src/config/config-loader.js';

const SOURCES: ContextSources = {
  goal: { id: 'OPEN_REPORTS', conditions: ['screen Reports'] },
  candidates: [
    { key: 'link:Requests', kind: 'click', role: 'link', name: 'Requests', safety: 'SAFE', allowed: true },
    { key: 'link:Reports', kind: 'click', role: 'link', name: 'Reports', safety: 'SAFE', allowed: true },
  ],
  evidence: [
    { id: 'E1', type: 'RUNTIME', source: 'navigation', confidence: 0.7, details: { menu: 'Reports' } },
  ],
  hypotheses: [],
  contradictions: [],
};
const built = new IntelligenceContextBuilder({
  maxActions: 10,
  maxEvidence: 5,
  maxHypotheses: 5,
  maxPlanSteps: 5,
}).build('LOW_DECISION_CONFIDENCE', SOURCES);

const PROPOSAL = {
  status: 'PROPOSAL',
  selectedActionId: 'A2',
  intent: 'OPEN_REPORTS',
  supportingEvidenceIds: ['E1'],
  uncertainties: [],
  confidence: 0.82,
};

/** Un faux SDK : il enregistre chaque client et chaque requête, et rend la réponse donnée. */
function fakeAnthropic(answer: (body: AnthropicMessageRequest) => AnthropicMessageLike) {
  const state = {
    loads: 0,
    clients: [] as AnthropicClientOptionsLike[],
    calls: [] as { body: AnthropicMessageRequest; options: AnthropicRequestOptionsLike | undefined }[],
  };
  const sdk: AnthropicSdkModule = {
    default: class {
      constructor(options?: AnthropicClientOptionsLike) {
        state.clients.push(options ?? {});
      }
      beta = {
        messages: {
          create: (body: AnthropicMessageRequest, options?: AnthropicRequestOptionsLike) => {
            state.calls.push({ body, options });
            return Promise.resolve(answer(body));
          },
        },
      };
    },
  };
  const loadSdk = () => {
    state.loads += 1;
    return Promise.resolve(sdk);
  };
  return { state, loadSdk };
}

const text = (body: AnthropicMessageRequest, value: unknown, extra: Partial<AnthropicMessageLike> = {}) => ({
  model: body.model,
  content: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify(value) }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1200, output_tokens: 90 },
  ...extra,
});

const provider = (options: Partial<AnthropicProviderOptions> & Pick<AnthropicProviderOptions, 'loadSdk'>) =>
  new AnthropicIntelligenceProvider({
    model: 'model-primary',
    effort: 'high',
    maxTokens: 16_000,
    timeoutMs: 60_000,
    serverSideFallback: true,
    env: { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' },
    ...options,
  });

const call = (): ProviderCallOptions & { events: string[] } => {
  const events: string[] = [];
  return {
    signal: new AbortController().signal,
    maxToolCalls: 0,
    emit: (event, message) => events.push(`${event} ${message}`),
    events,
  };
};

describe('Anthropic intelligence provider (official SDK, fake transport)', () => {
  it('sends the advisor system prompt (cached), the structured request, adaptive thinking, effort and the proposal schema', async () => {
    const { state, loadSdk } = fakeAnthropic((body) => text(body, PROPOSAL));
    const advisor = provider({ loadSdk });
    const options = call();
    const result = await advisor.analyze(built.request, options);

    const [first] = state.calls;
    expect(first?.body).toMatchObject({
      model: 'model-primary',
      max_tokens: 16_000,
      system: [{ type: 'text', text: QA_ADVISOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserPrompt(built.request) }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      // Un refus est rejoué côté serveur sur le modèle recommandé.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // Une seule tentative et l'annulation de la passerelle : c'est elle qui gère délais et reprises.
    expect(first?.options).toMatchObject({ signal: options.signal, timeout: 60_000, maxRetries: 0 });
    expect(state.clients[0]).toMatchObject({ maxRetries: 0, timeout: 60_000 });

    expect(result).toMatchObject({
      raw: PROPOSAL,
      model: 'model-primary',
      toolCalls: 0,
      usage: { inputTokens: 1200, outputTokens: 90 },
    });
    expect(validateIntelligenceProposal(result.raw, built.request, () => true).valid).toBe(true);
    expect(options.events).toEqual([]);
  });

  it('the proposal schema sent to the API keeps its structure but drops the constraints structured outputs reject', () => {
    const schema = structuredOutputSchema(INTELLIGENCE_PROPOSAL_JSON_SCHEMA);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
    };
    walk(schema);
    for (const rejected of [
      'maxLength',
      'minLength',
      'pattern',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
    ])
      expect(keys.has(rejected), rejected).toBe(false);
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'supportingEvidenceIds', 'uncertainties', 'confidence'],
      properties: { status: { enum: ['PROPOSAL', 'INCONCLUSIVE', 'NEED_MORE_EVIDENCE'] } },
    });
    // Le validateur de QA-Crawler, lui, garde toutes les contraintes : une réponse hors bornes est refusée.
    const tooLong = { ...PROPOSAL, intent: 'X'.repeat(500) };
    expect(validateIntelligenceProposal(tooLong, built.request, () => true).valid).toBe(false);
  });

  it('without server-side fallback, no fallback parameter; a fallback that ran is reported', async () => {
    const plain = fakeAnthropic((body) => text(body, PROPOSAL));
    await provider({ loadSdk: plain.loadSdk, serverSideFallback: false }).analyze(built.request, call());
    expect(plain.state.calls[0]?.body).not.toHaveProperty('fallbacks');
    expect(plain.state.calls[0]?.body).not.toHaveProperty('betas');

    const rescued = fakeAnthropic((body) => text(body, PROPOSAL, { model: 'model-secondary' }));
    const options = call();
    const result = await provider({ loadSdk: rescued.loadSdk }).analyze(built.request, options);
    expect(result.model).toBe('model-secondary');
    expect(options.events).toEqual([
      'AI_MODEL_FALLBACK server-side fallback: model-primary → model-secondary',
    ]);
  });

  it('a refusal is an abstention (INCONCLUSIVE), never a proposal; a truncated answer is invalid', async () => {
    const refused = fakeAnthropic((body) => ({
      model: body.model,
      content: [],
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
    }));
    const declined = await provider({ loadSdk: refused.loadSdk }).analyze(built.request, call());
    expect(declined.raw).toMatchObject({ status: 'INCONCLUSIVE', confidence: 0 });
    expect(JSON.stringify(declined.raw)).toContain('refusal: cyber');
    expect(validateIntelligenceProposal(declined.raw, built.request, () => true).valid).toBe(true);

    const cut = fakeAnthropic((body) => text(body, PROPOSAL, { stop_reason: 'max_tokens' }));
    const truncated = await provider({ loadSdk: cut.loadSdk }).analyze(built.request, call());
    expect(truncated.raw).toEqual({ invalid: 'max_tokens: the answer was cut off' });
    expect(validateIntelligenceProposal(truncated.raw, built.request, () => true).valid).toBe(false);
  });

  it('availability: SDK installed and a key configured — checked without any API call, never throws', async () => {
    const { state, loadSdk } = fakeAnthropic((body) => text(body, PROPOSAL));
    const noKey = provider({ loadSdk, env: {} });
    expect(await noKey.isAvailable()).toBe(false);
    expect(noKey.unavailableReason()).toMatch(/ANTHROPIC_API_KEY is not set/);

    const noModel = provider({ loadSdk, model: undefined });
    expect(await noModel.isAvailable()).toBe(false);
    expect(noModel.unavailableReason()).toBe('no model: set ai.anthropic.model (or --ai-model)');

    const named = provider({
      loadSdk,
      env: { QA_ANTHROPIC_KEY: 'sk-test-named' },
      apiKeyEnv: 'QA_ANTHROPIC_KEY',
    });
    expect(await named.isAvailable()).toBe(true);
    expect(state.clients.at(-1)).toMatchObject({ apiKey: 'sk-test-named' });

    const missingNamed = provider({
      loadSdk,
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      apiKeyEnv: 'QA_ANTHROPIC_KEY',
    });
    expect(await missingNamed.isAvailable()).toBe(false);
    expect(missingNamed.unavailableReason()).toMatch(/QA_ANTHROPIC_KEY is not set/);

    const notInstalled = provider({ loadSdk: () => Promise.reject(new Error('Cannot find module')) });
    expect(await notInstalled.isAvailable()).toBe(false);
    expect(notInstalled.unavailableReason()).toBe('@anthropic-ai/sdk is not installed');

    expect(state.calls).toHaveLength(0);
    // Aucune clé n'apparaît dans la raison d'indisponibilité.
    expect(missingNamed.unavailableReason()).not.toContain('sk-x');
  });

  it('configuration: provider anthropic, no model fixed in the code; --ai-provider anthropic and --ai-model choose it', async () => {
    const { config } = parseConfig(
      'target: { baseUrl: "http://localhost" }\nai: { enabled: true, mode: HYBRID, provider: anthropic }',
      {},
      {},
    );
    expect(config.ai.anthropic).toMatchObject({
      effort: 'high',
      maxTokens: 16_000,
      timeoutMs: 120_000,
      serverSideFallback: false,
    });
    expect(config.ai.anthropic.model).toBeUndefined();
    expect(createConfiguredProvider(config.ai, { env: {}, sanitize: (value) => value })).toBeInstanceOf(
      AnthropicIntelligenceProvider,
    );

    expect(parseCliArgs(['--intelligence', 'hybrid', '--ai-provider', 'anthropic', 'm.yaml'])).toMatchObject({
      aiProvider: 'anthropic',
    });
    const fromCli = parseConfig(
      'target: { baseUrl: "http://localhost" }',
      { intelligence: 'hybrid', aiProvider: 'anthropic', aiModel: 'model-chosen' },
      {},
    ).config.ai;
    expect(fromCli).toMatchObject({ provider: 'anthropic', anthropic: { model: 'model-chosen' } });

    const { state, loadSdk } = fakeAnthropic((body) => text(body, PROPOSAL));
    await createAnthropicProvider(fromCli, { env: { ANTHROPIC_API_KEY: 'sk-test' }, loadSdk }).analyze(
      built.request,
      call(),
    );
    expect(state.calls[0]?.body.model).toBe('model-chosen');
    expect(state.calls[0]?.body).not.toHaveProperty('fallbacks');
  });
});
