import { describe, expect, it } from 'vitest';
import { IntelligenceContextBuilder, type ContextSources } from '../../src/ai/context-builder.js';
import { createIntelligenceGateway, effectiveMode } from '../../src/ai/factory.js';
import { IntelligenceGateway, type AiEventRecord, type GatewayOptions } from '../../src/ai/gateway.js';
import { arbitrate } from '../../src/ai/hybrid-arbiter.js';
import type { IntelligenceRequest } from '../../src/ai/model.js';
import { validateIntelligenceProposal } from '../../src/ai/proposal-validator.js';
import type { IntelligenceProvider } from '../../src/ai/provider.js';
import { DeterministicIntelligenceProvider } from '../../src/ai/providers/deterministic-provider.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import { IntelligenceTriggerPolicy, type TriggerSettings } from '../../src/ai/trigger-policy.js';
import { parseCliArgs, UsageError } from '../../src/cli/args.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { Evidence } from '../../src/cognitive/evidence.js';
import { FakeIntelligenceProvider, proposeByName } from '../fixtures/fake-intelligence-provider.js';

const ALL_TRIGGERS: TriggerSettings = {
  ambiguousTarget: true,
  unknownScreen: true,
  flowDivergence: true,
  recoveryFailed: true,
  multiplePlans: true,
  unresolvedHypothesis: true,
  unknownBusinessError: true,
  lowConfidence: true,
  knowledgeContradiction: true,
};

const evidence = (id: string, source: string, details: Evidence['details'] = {}): Evidence => ({
  id,
  type: 'STATIC_SOURCE',
  source,
  confidence: 0.6,
  details,
});

/** L'écran de l'exemple §119 : un onglet, un lien, une mutation. */
function sources(extra: Partial<ContextSources> = {}): ContextSources {
  return {
    mission: 'CREATE_REQUEST',
    goal: {
      id: 'COMPANY_INFORMATION_AVAILABLE',
      conditions: ['field Company name', 'field Business number'],
    },
    workflow: {
      previous: ['click Tasks', 'check EUR'],
      next: ['fill Company name', 'fill Business number'],
      requiredFields: ['Company name', 'Business number'],
      intent: 'OPEN_COMPANY_INFORMATION',
    },
    candidates: [
      {
        key: 'tab:Enterprise',
        kind: 'click',
        role: 'tab',
        name: 'Enterprise',
        safety: 'SAFE',
        allowed: true,
        score: 0.48,
      },
      {
        key: 'link:Company profile',
        kind: 'click',
        role: 'link',
        name: 'Company profile',
        safety: 'SAFE',
        allowed: true,
        score: 0.45,
      },
      {
        key: 'button:Create company',
        kind: 'click',
        role: 'button',
        name: 'Create company',
        safety: 'MUTATION',
        allowed: false,
      },
    ],
    evidence: [
      evidence('E31', 'CompanyForm.ts', { fields: ['companyName', 'businessNumber'], label: 'Company name' }),
      evidence('E42', 'routes.ts', { tab: 'Enterprise', component: 'CompanyComponent' }),
      evidence('E50', 'unrelated.ts', { feature: 'invoices' }),
    ],
    hypotheses: [],
    contradictions: [],
    ...extra,
  };
}

function gateway(
  mode: GatewayOptions['mode'],
  provider: IntelligenceProvider,
  overrides: Partial<GatewayOptions> = {},
): { gateway: IntelligenceGateway; events: AiEventRecord[]; created: () => number } {
  const events: AiEventRecord[] = [];
  let created = 0;
  return {
    gateway: new IntelligenceGateway({
      mode,
      providerId: provider.id,
      createProvider: () => {
        created += 1;
        return provider;
      },
      triggers: ALL_TRIGGERS,
      thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
      budgets: {
        maxCallsPerRun: 10,
        maxCallsPerAction: 1,
        maxCallsPerDivergence: 1,
        maxToolCallsPerRequest: 4,
        maxReasoningDurationMs: 60_000,
      },
      timeoutMs: 5_000,
      maxRetries: 0,
      failOnUnavailable: false,
      sanitizer: new IntelligenceContextSanitizer(),
      emit: (record) => events.push(record),
      ...overrides,
    }),
    events,
    created: () => created,
  };
}

const builder = () =>
  new IntelligenceContextBuilder({ maxActions: 25, maxEvidence: 10, maxHypotheses: 5, maxPlanSteps: 10 });

/** Une consultation sur l'écran de l'exemple, la SafetyPolicy jugeant comme le crawler (SAFE seulement). */
async function consult(
  target: IntelligenceGateway,
  deterministic: { name?: string; confidence: number },
  scope: { action?: string; divergence?: string } = { action: 'S1' },
) {
  const built = builder().build('AMBIGUOUS_TARGET', sources());
  const known = new Set(['E31', 'E42', 'E50']);
  const actionId = deterministic.name
    ? built.request.availableActions.find((action) => action.name === deterministic.name)?.id
    : undefined;
  const result = await target.consult({
    context: 'EXPLORATION',
    request: built.request,
    scope,
    deterministic: { ...(actionId ? { actionId } : {}), confidence: deterministic.confidence },
    safety: (id) => {
      const candidate = built.candidateOf(id);
      return {
        allowed: candidate?.safety === 'SAFE' && candidate.allowed,
        classification: candidate?.safety ?? 'UNKNOWN',
        reason: 'SafetyPolicy',
      };
    },
    knownEvidence: (id) => known.has(id),
  });
  return { ...result, built };
}

describe('AI reasoning advisor: modes, gateway, validation, arbitration', () => {
  it('§83 OFF: no gateway, no provider, no call — the crawler behaves as before', () => {
    const { config } = parseConfig('target: { baseUrl: "http://localhost" }', {}, {});
    expect(config.ai.enabled).toBe(false);
    expect(effectiveMode(config.ai)).toBe('OFF');
    let created = 0;
    const provider = new FakeIntelligenceProvider(() => ({}));
    expect(
      createIntelligenceGateway(config.ai, {
        env: {},
        provider: new Proxy(provider, {
          get(target, key) {
            created += 1;
            return Reflect.get(target, key) as unknown;
          },
        }),
      }),
    ).toBeUndefined();
    expect(created).toBe(0);
    // `mode: HYBRID` sans `enabled` reste OFF.
    const { config: halfOn } = parseConfig(
      'target: { baseUrl: "http://localhost" }\nai: { mode: HYBRID }',
      {},
      {},
    );
    expect(effectiveMode(halfOn.ai)).toBe('OFF');
    // Une passerelle explicitement OFF ne crée jamais son fournisseur.
    const off = gateway('OFF', provider);
    expect(off.gateway.evaluate({ deterministicConfidence: 0 }).skippedBecause).toBe('MODE_OFF');
    expect(off.created()).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('§84 ASSIST: the deterministic decision is executed; the proposal is only audited (shadow disagreement)', async () => {
    const provider = new FakeIntelligenceProvider(proposeByName('Company profile', 0.95));
    const { gateway: assist, events } = gateway('ASSIST', provider);
    const result = await consult(assist, { name: 'Enterprise', confidence: 0.5 });
    expect(result.decision.source).toBe('DETERMINISTIC');
    expect(result.decision.actionId).toBe(result.built.idOf('tab:Enterprise'));
    expect(result.decision.accepted).toBe(false);
    expect(result.record.outcome).toBe('SHADOW');
    expect(result.record.shadowAgreement).toBe(false);
    expect(result.record.proposal?.action).toBe('LINK "Company profile"');
    expect(events.map((event) => event.event)).toContain('AI_SHADOW_DISAGREEMENT');
    expect(assist.summary().shadow).toEqual({ compared: 1, agreements: 0, disagreements: 1 });
  });

  it('§85 / §19 HYBRID, high deterministic confidence: FAST PATH — the provider is not called', () => {
    const provider = new FakeIntelligenceProvider(proposeByName('Company profile', 0.9));
    const { gateway: hybrid, created } = gateway('HYBRID', provider);
    const decision = hybrid.evaluate({
      deterministicConfidence: 0.97,
      knownState: true,
      expectedEffectKnown: true,
    });
    expect(decision).toMatchObject({ shouldInvoke: false, skippedBecause: 'FAST_PATH' });
    expect(created()).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(hybrid.summary().fastPath).toBe(1);
  });

  it('§86 / §43 HYBRID, weak deterministic decision: a validated, SAFE, confident proposal may be selected', async () => {
    const provider = new FakeIntelligenceProvider(
      proposeByName('Company profile', 0.89, {
        supportingEvidenceIds: ['E31', 'E42'],
        intent: 'OPEN_COMPANY_INFORMATION',
      }),
    );
    const { gateway: hybrid, events } = gateway('HYBRID', provider);
    const result = await consult(hybrid, { name: 'Enterprise', confidence: 0.43 });
    expect(result.decision).toMatchObject({ source: 'AI_PROPOSAL', accepted: true });
    expect(result.decision.actionId).toBe(result.built.idOf('link:Company profile'));
    expect(result.record.validation.status).toBe('VALID');
    expect(result.record.safety).toBe('SAFE');
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'AI_REQUEST_CREATED',
        'AI_REQUEST_SANITIZED',
        'AI_PROPOSAL_RECEIVED',
        'AI_PROPOSAL_VALIDATED',
        'AI_PROPOSAL_ACCEPTED',
      ]),
    );
  });

  it('§42 HYBRID, strong deterministic decision: kept even if the proposal differs', () => {
    const decision = arbitrate({
      mode: 'HYBRID',
      deterministic: { actionId: 'A1', confidence: 0.96 },
      validation: {
        valid: true,
        proposal: {
          status: 'PROPOSAL',
          selectedActionId: 'A3',
          supportingEvidenceIds: [],
          uncertainties: [],
          confidence: 0.62,
        },
        checks: [],
      },
      safety: () => ({ allowed: true, classification: 'SAFE', reason: '' }),
      thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    });
    expect(decision).toMatchObject({ actionId: 'A1', source: 'DETERMINISTIC', accepted: false });
  });

  it('§87 an invented action (A999) is rejected — nothing to execute', async () => {
    const provider = new FakeIntelligenceProvider(() => ({
      status: 'PROPOSAL',
      selectedActionId: 'A999',
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0.99,
    }));
    const result = await consult(gateway('HYBRID', provider).gateway, { confidence: 0.2 });
    expect(result.record.validation).toMatchObject({
      status: 'REJECTED',
      rejection: 'AI_PROPOSAL_UNKNOWN_ACTION',
    });
    expect(result.decision.accepted).toBe(false);
    expect(result.decision.actionId).toBeUndefined();
  });

  it('§88 / §40 an unsafe (MUTATION) proposal is blocked by the SafetyPolicy, whatever its confidence', async () => {
    const provider = new FakeIntelligenceProvider(proposeByName('Create company', 0.99));
    const result = await consult(gateway('HYBRID', provider).gateway, { confidence: 0.1 });
    expect(result.record.validation.status).toBe('VALID');
    expect(result.decision.accepted).toBe(false);
    expect(result.decision.reasons.join(' ')).toContain('SafetyPolicy refuses');
    expect(result.record.safety).toBe('MUTATION');
  });

  it('§89 / §37 fabricated evidence (E999) makes the proposal invalid — never considered valid', async () => {
    const provider = new FakeIntelligenceProvider(
      proposeByName('Enterprise', 0.9, { supportingEvidenceIds: ['E31', 'E999'] }),
    );
    const result = await consult(gateway('HYBRID', provider).gateway, { confidence: 0.2 });
    expect(result.record.validation).toMatchObject({
      status: 'REJECTED',
      rejection: 'AI_PROPOSAL_INVALID_EVIDENCE',
      reasons: ['evidence E999 does not exist'],
    });
    expect(result.decision.accepted).toBe(false);
  });

  it('§44 a proposal contradicted by the runtime (disabled target) is rejected', () => {
    const request = builder().build(
      'AMBIGUOUS_TARGET',
      sources({
        candidates: [
          {
            key: 'tab:Enterprise',
            kind: 'click',
            role: 'tab',
            name: 'Enterprise',
            safety: 'SAFE',
            allowed: true,
            disabled: true,
          },
        ],
      }),
    ).request;
    const validation = validateIntelligenceProposal(
      {
        status: 'PROPOSAL',
        selectedActionId: 'A1',
        supportingEvidenceIds: [],
        uncertainties: [],
        confidence: 0.9,
      },
      request,
      () => true,
    );
    // Désactivée : ni proposable (contraintes), ni exécutable.
    expect(validation.valid).toBe(false);
    if (!validation.valid)
      expect(['AI_PROPOSAL_INCOMPATIBLE', 'AI_PROPOSAL_CONTRADICTS_RUNTIME']).toContain(validation.rejection);
  });

  it('§35 / §45 schema violations are rejected; INCONCLUSIVE never forces a decision', async () => {
    expect(
      validateIntelligenceProposal(
        { status: 'PROPOSAL', selectedActionId: 'A1', confidence: 2, click: '#submit' },
        builder().build('AMBIGUOUS_TARGET', sources()).request,
        () => true,
      ),
    ).toMatchObject({ valid: false, rejection: 'AI_PROPOSAL_INVALID_SCHEMA' });
    const provider = new FakeIntelligenceProvider(() => ({
      status: 'INCONCLUSIVE',
      supportingEvidenceIds: [],
      uncertainties: ['two tabs'],
      confidence: 0,
    }));
    const result = await consult(gateway('HYBRID', provider).gateway, {
      name: 'Enterprise',
      confidence: 0.4,
    });
    expect(result.record.outcome).toBe('INCONCLUSIVE');
    expect(result.decision).toMatchObject({ source: 'DETERMINISTIC', accepted: false });
  });

  it('§90 / §16 provider unavailable: AI_UNAVAILABLE, deterministic fallback, no crash (and failOnUnavailable stops)', async () => {
    const provider = new FakeIntelligenceProvider(() => ({}), { available: false, reason: 'not signed in' });
    const { gateway: hybrid, events } = gateway('HYBRID', provider);
    const result = await consult(hybrid, { name: 'Enterprise', confidence: 0.4 });
    expect(result.record.outcome).toBe('AI_UNAVAILABLE');
    expect(result.decision).toMatchObject({
      source: 'DETERMINISTIC',
      actionId: result.built.idOf('tab:Enterprise'),
    });
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['AI_UNAVAILABLE', 'AI_FALLBACK_ACTIVATED']),
    );
    expect(provider.requests).toHaveLength(0);
    // L'indisponibilité est vérifiée une fois par run.
    await consult(hybrid, { confidence: 0.4 }, { action: 'S2' });
    expect(provider.availabilityChecks).toBe(1);
    expect(hybrid.summary()).toMatchObject({
      available: false,
      unavailableReason: 'not signed in',
      unavailable: 2,
    });
    const strict = gateway('HYBRID', provider, { failOnUnavailable: true }).gateway;
    await expect(consult(strict, { confidence: 0.4 })).rejects.toThrow(/unavailable/);
  });

  it('§91 timeout: AI_TIMEOUT, fallback, no infinite wait', async () => {
    const provider = new FakeIntelligenceProvider(proposeByName('Enterprise', 0.9), { delayMs: 2_000 });
    const { gateway: hybrid, events } = gateway('HYBRID', provider, { timeoutMs: 50 });
    const started = Date.now();
    const result = await consult(hybrid, { confidence: 0.3 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.record.outcome).toBe('AI_TIMEOUT');
    expect(result.decision.accepted).toBe(false);
    expect(events.map((event) => event.event)).toContain('AI_TIMEOUT');
    expect(hybrid.summary().timeouts).toBe(1);
  });

  it('§92 / §60 budget: maxCallsPerRun reached → no new call, AI_BUDGET_EXHAUSTED, fallback', async () => {
    const provider = new FakeIntelligenceProvider(proposeByName('Enterprise', 0.9));
    const { gateway: hybrid, events } = gateway('HYBRID', provider, {
      budgets: {
        maxCallsPerRun: 1,
        maxCallsPerAction: 1,
        maxCallsPerDivergence: 1,
        maxToolCallsPerRequest: 2,
        maxReasoningDurationMs: 60_000,
      },
    });
    await consult(hybrid, { confidence: 0.3 }, { action: 'S1' });
    const second = await consult(hybrid, { confidence: 0.3 }, { action: 'S2' });
    expect(provider.requests).toHaveLength(1);
    expect(second.record.outcome).toBe('AI_BUDGET_EXHAUSTED');
    expect(events.map((event) => event.event)).toContain('AI_BUDGET_EXHAUSTED');
    // Par action aussi : un deuxième appel pour le même écran est refusé.
    const perAction = gateway(
      'HYBRID',
      new FakeIntelligenceProvider(proposeByName('Enterprise', 0.9)),
    ).gateway;
    await consult(perAction, { confidence: 0.3 }, { action: 'S1' });
    expect((await consult(perAction, { confidence: 0.3 }, { action: 'S1' })).record.outcome).toBe(
      'AI_BUDGET_EXHAUSTED',
    );
  });

  it('§93 / §31 sanitization: no Authorization header, password, cookie, token, email or secret test data reaches the provider', async () => {
    const provider = new FakeIntelligenceProvider(() => ({
      status: 'INCONCLUSIVE',
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0,
    }));
    const secret = 'S3cr3t-Value-42';
    const { gateway: target, events } = gateway('ASSIST', provider, {
      sanitizer: new IntelligenceContextSanitizer({
        secretValues: [secret],
        sensitiveFields: ['Business number'],
      }),
    });
    const built = builder().build(
      'UNKNOWN_BUSINESS_ERROR',
      sources({
        failure: {
          step: 'step 7',
          symptom: `Business number: 123456789 rejected for ${secret}`,
          observed: [],
        },
      }),
    );
    const leaks = [
      'POST /api/company 500 Authorization: Bearer abcdef1234567890',
      'login password=hunter22',
      'cookie: sid=abcdef',
      'owner alice@example.org',
      'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      `company name ${secret}`,
    ];
    leaks.forEach((summary, index) =>
      built.request.relevantEvidence.push({ id: `E${String(index + 1)}`, type: 'NETWORK', summary }),
    );
    await target.consult({
      context: 'FAILURE',
      request: built.request,
      scope: { divergence: 'x' },
      deterministic: { confidence: 1 },
      safety: () => ({ allowed: false, classification: 'ADVISORY', reason: '' }),
      knownEvidence: () => true,
    });
    const sent = JSON.stringify(provider.requests[0]);
    for (const leak of [
      'abcdef1234567890',
      'hunter22',
      'sid=abcdef',
      'alice@example.org',
      'ghp_ABCDEF',
      secret,
      '123456789',
    ])
      expect(sent).not.toContain(leak);
    expect(sent).toContain('<EMAIL_TEST_DATA>');
    expect(sent).toContain('<PASSWORD_SECRET>');
    expect(events.find((event) => event.event === 'AI_REQUEST_SANITIZED')?.message).toMatch(
      /[1-9]\d* value\(s\) redacted/,
    );
  });

  it('§94 / §95 / §69–§71 runtime decides: confirmed → knowledge candidate (origin AI_PROPOSAL); contradicted → never learned', async () => {
    const provider = new FakeIntelligenceProvider(
      proposeByName('Enterprise', 0.91, { supportingEvidenceIds: ['E31', 'E42'] }),
    );
    const { gateway: hybrid, events } = gateway('HYBRID', provider);
    const confirmed = await consult(hybrid, { confidence: 0.3 }, { action: 'S1' });
    const contradicted = await consult(hybrid, { confidence: 0.3 }, { action: 'S2' });
    hybrid.recordRuntime(
      confirmed.record.id,
      true,
      'field Company name visible, field Business number visible',
    );
    hybrid.recordRuntime(contradicted.record.id, false, 'goal not reached');
    expect(hybrid.audit.byId(confirmed.record.id)).toMatchObject({
      runtimeResult: 'GOAL_CONFIRMED',
      knowledgeCandidate: { origin: 'AI_PROPOSAL', runtimeConfirmed: true },
    });
    expect(hybrid.audit.byId(contradicted.record.id)).toMatchObject({
      runtimeResult: 'RUNTIME_CONTRADICTED',
      knowledgeCandidate: { origin: 'AI_PROPOSAL', runtimeConfirmed: false },
    });
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['AI_RUNTIME_CONFIRMED', 'AI_RUNTIME_CONTRADICTED']),
    );
    expect(hybrid.summary()).toMatchObject({ accepted: 2, runtimeConfirmed: 1, runtimeContradicted: 1 });
  });

  it('§98 / §29 the context is semantic and minimal: no DOM, no locators, only relevant evidence, stable action IDs', () => {
    const built = builder().build('AMBIGUOUS_TARGET', sources());
    const text = JSON.stringify(built.request);
    expect(text).not.toMatch(/<\/?(div|html|body|button|input|span)\b/i);
    const { constraints, ...content } = built.request;
    expect(constraints.forbidden.length).toBeGreaterThan(0);
    expect(JSON.stringify(content)).not.toMatch(/xpath|css=|locator\(|querySelector|\/\/\w+\[/i);
    expect(
      built.request.availableActions.map(
        (action) => `${action.id} ${action.type} ${action.name} ${action.safety}`,
      ),
    ).toEqual([
      'A1 TAB Enterprise SAFE',
      'A2 LINK Company profile SAFE',
      'A3 BUTTON Create company MUTATION',
    ]);
    // E50 (factures) n'a rien à voir avec le but : non envoyée.
    expect(built.request.relevantEvidence.map((item) => item.id).sort()).toEqual(['E31', 'E42']);
    expect(built.keyOf('A1')).toBe('tab:Enterprise');
    expect(built.request.constraints.forbidden.join(' ')).toMatch(/click, fill, submit, goto/);
  });

  it('§18–§22 trigger policy: fast path by default, hard triggers first, disabled triggers respected', () => {
    const policy = new IntelligenceTriggerPolicy(ALL_TRIGGERS, 0.85);
    expect(policy.evaluate({ deterministicConfidence: 0.9 }).shouldInvoke).toBe(false);
    expect(policy.evaluate({ deterministicConfidence: 0.9, recoveryExhausted: true }).reason).toBe(
      'RECOVERY_EXHAUSTED',
    );
    expect(policy.evaluate({ deterministicConfidence: 0.5, topScores: [0.48, 0.45] }).reason).toBe(
      'AMBIGUOUS_TARGET',
    );
    expect(policy.evaluate({ deterministicConfidence: 0.3 }).reason).toBe('LOW_DECISION_CONFIDENCE');
    expect(policy.evaluate({ deterministicConfidence: 0, unknownBusinessError: true }).reason).toBe(
      'UNKNOWN_BUSINESS_ERROR',
    );
    const quiet = new IntelligenceTriggerPolicy(
      { ...ALL_TRIGGERS, recoveryFailed: false, lowConfidence: false, ambiguousTarget: false },
      0.85,
    );
    expect(quiet.evaluate({ deterministicConfidence: 0.2, recoveryExhausted: true })).toMatchObject({
      shouldInvoke: false,
      skippedBecause: 'TRIGGER_DISABLED RECOVERY_EXHAUSTED',
    });
    expect(quiet.evaluate({ deterministicConfidence: 0.2 }).shouldInvoke).toBe(false);
  });

  it('the deterministic provider exercises the whole chain without any network', async () => {
    const provider = new DeterministicIntelligenceProvider();
    const { gateway: hybrid } = gateway('HYBRID', provider);
    const result = await consult(hybrid, { confidence: 0.2 });
    // « Company profile » partage « company » avec le but et les champs : une proposition lexicale, faible.
    expect(result.record.proposal?.action).toBe('LINK "Company profile"');
    expect(result.decision.accepted).toBe(false);
    expect(result.decision.reasons.join(' ')).toMatch(/confidence 0.50 < 0.60/);
  });

  it('§10–§12 configuration: CLI and environment select the mode; OFF stays the default', () => {
    expect(
      parseCliArgs([
        '--intelligence',
        'hybrid',
        '--ai-provider',
        'deterministic',
        '--ai-model',
        'm1',
        'm.yaml',
      ]),
    ).toMatchObject({
      intelligence: 'hybrid',
      aiProvider: 'deterministic',
      aiModel: 'm1',
    });
    expect(() => parseCliArgs(['--intelligence', 'full-ai'])).toThrow(UsageError);
    const fromEnv = parseConfig(
      'target: { baseUrl: "http://localhost" }',
      {},
      {
        QA_INTELLIGENCE_MODE: 'assist',
        QA_COPILOT_MODEL: 'some-model',
        QA_COPILOT_REASONING_EFFORT: 'HIGH',
      },
    ).config.ai;
    expect(fromEnv).toMatchObject({
      enabled: true,
      mode: 'ASSIST',
      copilot: {
        modelSelection: { mode: 'EXPLICIT', model: 'some-model' },
        reasoning: { mode: 'FIXED', default: 'HIGH' },
      },
    });
    const cliWins = parseConfig(
      'target: { baseUrl: "http://localhost" }\nai: { enabled: true, mode: HYBRID }',
      { intelligence: 'off' },
      { QA_INTELLIGENCE_MODE: 'hybrid' },
    ).config.ai;
    expect(effectiveMode(cliWins)).toBe('OFF');
    expect(() =>
      parseConfig('target: { baseUrl: "http://localhost" }', {}, { QA_INTELLIGENCE_MODE: 'auto' }),
    ).toThrow(/intelligence mode/);
    // Jamais un jeton dans la configuration : seulement le NOM de la variable.
    expect(() =>
      parseConfig('target: { baseUrl: "http://localhost" }\nai: { copilot: { token: "x" } }', {}, {}),
    ).toThrow();
  });

  it('§21 / §34 request and proposal are structured: the request type has a trigger, constraints and stable IDs', () => {
    const request: IntelligenceRequest = builder().build('FLOW_DIVERGENCE', sources()).request;
    expect(request).toMatchObject({
      trigger: 'FLOW_DIVERGENCE',
      mission: 'CREATE_REQUEST',
      goal: { id: 'COMPANY_INFORMATION_AVAILABLE' },
      workflowContext: { requiredFields: ['Company name', 'Business number'] },
      constraints: { allowedActionIds: ['A1', 'A2', 'A3'] },
    });
  });
});
