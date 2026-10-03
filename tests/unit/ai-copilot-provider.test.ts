import { describe, expect, it } from 'vitest';
import {
  IntelligenceContextBuilder,
  toolContextOf,
  type ContextSources,
} from '../../src/ai/context-builder.js';
import { createIntelligenceGateway } from '../../src/ai/factory.js';
import { QA_ADVISOR_SYSTEM_PROMPT, buildUserPrompt } from '../../src/ai/copilot/prompt-builder.js';
import type { CopilotSdkModule } from '../../src/ai/copilot/sdk.js';
import { fakeSdk } from '../fixtures/fake-copilot-sdk.js';
import { CopilotToolRegistry, READ_ONLY_TOOLS } from '../../src/ai/copilot/tool-registry.js';
import type { ProviderCallOptions } from '../../src/ai/model.js';
import {
  CopilotIntelligenceProvider,
  type CopilotProviderOptions,
} from '../../src/ai/providers/copilot-provider.js';
import { validateIntelligenceProposal } from '../../src/ai/proposal-validator.js';
import { parseConfig } from '../../src/config/config-loader.js';

const SOURCES: ContextSources = {
  goal: { id: 'COMPANY_INFORMATION_AVAILABLE', conditions: ['field Company name'] },
  candidates: [
    {
      key: 'tab:Enterprise Details',
      kind: 'click',
      role: 'tab',
      name: 'Enterprise Details',
      safety: 'SAFE',
      allowed: true,
    },
    {
      key: 'link:Company Profile',
      kind: 'click',
      role: 'link',
      name: 'Company Profile',
      safety: 'SAFE',
      allowed: true,
    },
  ],
  evidence: [
    {
      id: 'E31',
      type: 'STATIC_SOURCE',
      source: 'CompanyForm.ts',
      confidence: 0.6,
      details: { field: 'Company name' },
    },
  ],
  hypotheses: [],
  contradictions: [],
};
const built = new IntelligenceContextBuilder({
  maxActions: 10,
  maxEvidence: 5,
  maxHypotheses: 5,
  maxPlanSteps: 5,
}).build('AMBIGUOUS_TARGET', SOURCES);
const PROPOSAL = JSON.stringify({
  status: 'PROPOSAL',
  selectedActionId: 'A1',
  intent: 'OPEN_COMPANY_INFORMATION',
  supportingEvidenceIds: ['E31'],
  uncertainties: [],
  confidence: 0.91,
});

const PROFILES = {
  FAST: { models: [], autoTier: 'efficiency' as const },
  BALANCED: { models: [], autoTier: 'balance' as const },
  INTELLIGENCE: { models: [], autoTier: 'intelligence' as const },
};
const MODEL_SETTINGS: CopilotProviderOptions['models'] = {
  selection: { mode: 'EXPLICIT', model: 'model-a', defaultProfile: 'BALANCED', profiles: PROFILES },
  reasoning: {
    mode: 'ADAPTIVE',
    default: 'MEDIUM',
    lowComplexity: 'LOW',
    mediumComplexity: 'MEDIUM',
    highComplexity: 'HIGH',
    veryHighComplexity: 'HIGH',
  },
  fallback: { enabled: true, strategy: 'AUTO' },
  discovery: { cache: true, ttlMs: 600_000, refreshOnUnavailableModel: true },
};
const HIGH = { level: 'HIGH' as const, score: 4, reasons: ['workflow divergence'] };

function provider(load: () => Promise<CopilotSdkModule>, extra: Partial<CopilotProviderOptions> = {}) {
  return new CopilotIntelligenceProvider({
    models: MODEL_SETTINGS,
    sessionReuse: true,
    tools: true,
    timeoutMs: 5_000,
    startTimeoutMs: 5_000,
    baseDirectory: '/tmp/qa-copilot-test',
    env: {},
    loadSdk: load,
    sanitize: (value) => value,
    ...extra,
  });
}

const call = (options: Partial<ProviderCallOptions> = {}): ProviderCallOptions => ({
  signal: new AbortController().signal,
  maxToolCalls: 2,
  tools: toolContextOf(built, SOURCES),
  ...options,
});

describe('GitHub Copilot provider (official SDK, faked): isolation, safety in depth, structured output', () => {
  it('§15 / §83 lazy: nothing is loaded or started before the first request — and never in OFF', async () => {
    const { state, load } = fakeSdk(() => PROPOSAL);
    const copilot = provider(load);
    expect(state.loads).toBe(0);
    expect(copilot.clientsCreated).toBe(0);
    // En OFF, la fabrique ne crée même pas le fournisseur.
    const { config } = parseConfig('target: { baseUrl: "http://localhost" }\nai: { mode: OFF }', {}, {});
    expect(createIntelligenceGateway(config.ai, { env: {} })).toBeUndefined();
    // HYBRID : la passerelle existe, mais le SDK n'est chargé qu'au premier besoin.
    const { config: hybrid } = parseConfig(
      'target: { baseUrl: "http://localhost" }',
      { intelligence: 'hybrid' },
      {},
    );
    const gateway = createIntelligenceGateway(hybrid.ai, { env: {}, provider: copilot });
    expect(gateway?.providerCreated).toBe(false);
    expect(state.loads).toBe(0);
    await copilot.isAvailable();
    expect(state.loads).toBe(1);
    expect(state.clients[0]?.options).toMatchObject({
      mode: 'empty',
      useLoggedInUser: true,
      logLevel: 'error',
    });
  });

  it('§2 / §34 the official SDK session: replace-mode system prompt, structured output schema, usage collected', async () => {
    const { state, load } = fakeSdk(() => PROPOSAL);
    const copilot = provider(load);
    expect(await copilot.isAvailable()).toBe(true);
    const result = await copilot.analyze(built.request, call({ complexity: HIGH }));
    const session = state.sessions[0];
    expect(session?.config.systemMessage).toEqual({ mode: 'replace', content: QA_ADVISOR_SYSTEM_PROMPT });
    expect(session?.config.reasoningEffort).toBe('high');
    expect(session?.config.model).toBe('model-a');
    expect(session?.schemas[0]).toMatchObject({
      required: ['status', 'supportingEvidenceIds', 'uncertainties', 'confidence'],
    });
    expect(result).toMatchObject({ model: 'fake-model-1', usage: { inputTokens: 120, outputTokens: 30 } });
    expect(validateIntelligenceProposal(result.raw, built.request, () => true).valid).toBe(true);
    // Un niveau d'effort non déclaré par le modèle n'est jamais envoyé.
    const { state: other, load: otherLoad } = fakeSdk(() => PROPOSAL, { models: [{ id: 'model-a' }] });
    const plain = provider(otherLoad);
    await plain.isAvailable();
    await plain.analyze(built.request, call({ complexity: HIGH }));
    expect(other.sessions[0]?.config.reasoningEffort).toBeUndefined();
  });

  it('§49 / §82 defense in depth: only read-only custom tools exist; built-ins, shell, writes are rejected', async () => {
    const { state, load } = fakeSdk(() => PROPOSAL);
    const copilot = provider(load);
    await copilot.isAvailable();
    await copilot.analyze(built.request, call());
    const config = state.sessions[0]?.config;
    expect(config?.availableTools).toEqual(READ_ONLY_TOOLS.map((tool) => `custom:${tool.name}`));
    expect(config?.excludedTools).toEqual(['builtin:*', 'mcp:*']);
    expect(config?.enableConfigDiscovery).toBe(false);
    for (const kind of ['shell', 'write', 'read', 'url', 'mcp', 'memory'])
      expect(config?.onPermissionRequest?.({ kind }, {})).toMatchObject({ kind: 'reject' });
    expect(
      config?.onPermissionRequest?.({ kind: 'custom-tool', toolName: 'click_button' }, {}),
    ).toMatchObject({ kind: 'reject' });
    expect(config?.onPermissionRequest?.({ kind: 'custom-tool', toolName: 'get_current_goal' }, {})).toEqual({
      kind: 'approve-once',
    });
    expect(await config?.hooks?.onPreToolUse?.({ toolName: 'bash' }, {})).toMatchObject({
      permissionDecision: 'deny',
    });
    // Un outil d'exécution ne peut même pas être enregistré.
    expect(
      () =>
        new CopilotToolRegistry({
          current: () => undefined,
          sanitize: (value) => value,
          allow: () => true,
          tools: [{ name: 'click_action', description: '', parameters: {}, read: () => 'x' }],
        }),
    ).toThrow(/read-only/);
  });

  it('§51 tool budget per request: reads are answered from the request, then refused once the budget is spent', async () => {
    const answers: unknown[] = [];
    const { load } = fakeSdk(async (_prompt, session) => {
      answers.push(await session.callTool('get_current_goal'));
      answers.push(await session.callTool('get_action_details', { actionId: 'A1' }));
      answers.push(await session.callTool('get_available_actions'));
      return PROPOSAL;
    });
    const copilot = provider(load);
    await copilot.isAvailable();
    const result = await copilot.analyze(built.request, call({ maxToolCalls: 2 }));
    expect(answers[0]).toMatchObject({ id: 'COMPANY_INFORMATION_AVAILABLE' });
    expect(answers[1]).toMatchObject({ id: 'A1', name: 'Enterprise Details' });
    expect(answers[2]).toBe('denied');
    expect(result.toolCalls).toBe(2);
  });

  it('§97 / §53 session memory never wins: a stale action from an earlier turn is rejected against the current request', async () => {
    // Le modèle « se souvient » d'un ancien écran (A7) qui n'existe plus.
    const { state, load } = fakeSdk((prompt) =>
      prompt.includes('Enterprise Details')
        ? JSON.stringify({
            status: 'PROPOSAL',
            selectedActionId: 'A7',
            supportingEvidenceIds: [],
            uncertainties: ['as before'],
            confidence: 0.9,
          })
        : PROPOSAL,
    );
    const copilot = provider(load);
    await copilot.isAvailable();
    const result = await copilot.analyze(built.request, call());
    expect(validateIntelligenceProposal(result.raw, built.request, () => true)).toMatchObject({
      valid: false,
      rejection: 'AI_PROPOSAL_UNKNOWN_ACTION',
    });
    // Le message dit au modèle que la requête courante fait foi ; la session est réutilisée.
    expect(buildUserPrompt(built.request)).toMatch(/supersedes anything said earlier/);
    await copilot.analyze(built.request, call());
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.prompts).toHaveLength(2);
  });

  it('§90 / §13 unavailable: SDK missing, not authenticated, unknown model — a reason, never a token, never a crash', async () => {
    const missing = provider(() => Promise.reject(new Error("Cannot find package '@github/copilot-sdk'")));
    expect(await missing.isAvailable()).toBe(false);
    expect(missing.unavailableReason()).toMatch(/not installed/);

    const { load: anonymous } = fakeSdk(() => PROPOSAL, { authenticated: false });
    const signedOut = provider(anonymous);
    expect(await signedOut.isAvailable()).toBe(false);
    expect(signedOut.unavailableReason()).toMatch(/not authenticated/);

    const { load: limited } = fakeSdk(() => PROPOSAL, { models: [{ id: 'model-b' }] });
    const wrongModel = provider(limited);
    // Le compte reste disponible : le modèle se choisit à chaque requête (repli visible, voir ai-model-selection).
    expect(await wrongModel.isAvailable()).toBe(true);
    const fallback = await wrongModel.analyze(built.request, call());
    expect(fallback.modelContext).toMatchObject({
      requestedModel: 'model-a',
      selectedModel: 'auto',
      fallbackApplied: true,
      fallbackReason: 'MODEL_NOT_AVAILABLE',
    });

    // Un jeton passe par la variable NOMMÉE dans la configuration, jusqu'au SDK — nulle part ailleurs.
    const token = 'ghp_SECRETSECRETSECRETSECRETSECRET1234';
    const failing = provider(() => Promise.reject(new Error(`runtime refused credentials ${token}`)), {
      tokenEnv: 'QA_COPILOT_TOKEN',
      env: { QA_COPILOT_TOKEN: token },
    });
    expect(await failing.isAvailable()).toBe(false);
    expect(failing.unavailableReason()).not.toContain(token);
    const { state, load } = fakeSdk(() => PROPOSAL);
    const withToken = provider(load, { tokenEnv: 'QA_COPILOT_TOKEN', env: { QA_COPILOT_TOKEN: token } });
    await withToken.isAvailable();
    expect(state.clients[0]?.options).toMatchObject({ gitHubToken: token, useLoggedInUser: false });
    await withToken.analyze(built.request, call());
    expect(state.sessions[0]?.prompts.join('\n')).not.toContain(token);
  });

  it('structured output not supported by the runtime: the schema moves into the message (still revalidated)', async () => {
    let calls = 0;
    const { state, load } = fakeSdk((prompt) => {
      calls += 1;
      if (calls === 1) throw new Error('responseFormat is not supported by this runtime');
      expect(prompt).toContain('JSON schema of the answer');
      return `Here it is: ${PROPOSAL}`;
    });
    const copilot = provider(load);
    await copilot.isAvailable();
    const result = await copilot.analyze(built.request, call());
    expect(validateIntelligenceProposal(result.raw, built.request, () => true).valid).toBe(true);
    expect(state.sessions[0]?.schemas).toEqual([expect.any(Object), undefined]);
  });

  it('close(): the session is disconnected and the client stopped', async () => {
    const { state, load } = fakeSdk(() => PROPOSAL);
    const copilot = provider(load);
    await copilot.isAvailable();
    await copilot.analyze(built.request, call());
    await copilot.close();
    expect(state.sessions[0]?.disconnected).toBe(true);
    expect(state.clients[0]?.stopped).toBe(true);
  });
});
