import { describe, expect, it } from 'vitest';
import { IntelligenceContextBuilder, type ContextSources } from '../../src/ai/context-builder.js';
import { classifyDecision } from '../../src/ai/decision-lifecycle.js';
import { intelligenceDecisionsArtifact } from '../../src/ai/decision-report.js';
import { IntelligenceGateway, type AiEventRecord, type GatewayOptions } from '../../src/ai/gateway.js';
import type { IntelligenceRequest, ProviderResult } from '../../src/ai/model.js';
import { validateIntelligenceProposal } from '../../src/ai/proposal-validator.js';
import type { IntelligenceProvider } from '../../src/ai/provider.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type { Evidence } from '../../src/cognitive/evidence.js';

const evidence = (id: string, source: string, details: Evidence['details'] = {}): Evidence => ({
  id,
  type: 'STATIC_SOURCE',
  source,
  confidence: 0.6,
  details,
});

/** Un écran à trois actions (deux sûres, une mutation) et un contexte fonctionnel. */
const SOURCES: ContextSources = {
  mission: 'CREATE_REQUEST',
  goal: { id: 'CREATE_REQUEST_DONE', conditions: ['UNKNOWN'] },
  workflow: {
    previous: ['check EUR'],
    next: ['fill Company name', 'fill Business number'],
    requiredFields: ['Company name', 'Business number'],
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
      key: 'button:Apply',
      kind: 'click',
      role: 'button',
      name: 'Apply',
      safety: 'SAFE',
      allowed: true,
      score: 0.45,
    },
    {
      key: 'button:Create',
      kind: 'click',
      role: 'button',
      name: 'Create',
      safety: 'MUTATION',
      allowed: false,
    },
  ],
  evidence: [
    evidence('E31', 'CompanyForm.ts', { label: 'Company name' }),
    evidence('E42', 'routes.ts', { tab: 'Enterprise' }),
  ],
  hypotheses: [],
  contradictions: [],
  functional: {
    currentGoal: 'CREATE_REQUEST_DONE',
    goalProgress: 0.7,
    satisfiedPreconditions: ['CREATE_REQUEST_READY'],
    missingPreconditions: ['UNKNOWN'],
    unknownPrecondition: true,
    blockingReasons: ['submission READY and "Create" executed at step 9, but no accepted write followed'],
    lastConfirmedCheckpoint: 'CREATE_REQUEST_READY',
    nextExpectedCheckpoint: 'CREATE_REQUEST_DONE',
    causalRelations: [],
    previousConfirmedActions: [],
    nextExpectedActions: [],
    nextActionTargets: ['Company name'],
    functionalCoverage: [],
    question: 'Identify the most plausible missing precondition.',
  },
};

/** Un fournisseur scripté : une réponse (ou une panne) par appel, dans l'ordre. */
class ScriptedProvider implements IntelligenceProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-model';
  calls = 0;
  constructor(private readonly script: ((request: IntelligenceRequest) => unknown)[]) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async analyze(request: IntelligenceRequest, options: { signal: AbortSignal }): Promise<ProviderResult> {
    const step = this.script[this.calls % this.script.length];
    this.calls += 1;
    const raw = step?.(request);
    if (raw === 'THROW') throw new Error('provider exploded');
    if (raw === 'HANG')
      await new Promise((resolve) => {
        options.signal.addEventListener('abort', resolve);
      });
    return { raw, model: this.model, toolCalls: 0 };
  }
}

const idOf = (request: IntelligenceRequest, name: string): string =>
  request.availableActions.find((action) => action.name === name)?.id ?? 'A0';
const propose =
  (name: string, confidence = 0.9, extra: Record<string, unknown> = {}) =>
  (request: IntelligenceRequest) => ({
    status: 'PROPOSAL',
    selectedActionId: idOf(request, name),
    supportingEvidenceIds: [],
    uncertainties: [],
    confidence,
    ...extra,
  });
const status = (value: 'INCONCLUSIVE' | 'NEED_MORE_EVIDENCE') => () => ({
  status: value,
  supportingEvidenceIds: [],
  uncertainties: ['not enough evidence'],
  confidence: 0.2,
});

function setup(
  mode: GatewayOptions['mode'],
  provider: IntelligenceProvider,
  overrides: Partial<GatewayOptions> = {},
): { gateway: IntelligenceGateway; events: AiEventRecord[] } {
  const events: AiEventRecord[] = [];
  return {
    gateway: new IntelligenceGateway({
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
  };
}

const builder = () =>
  new IntelligenceContextBuilder({ maxActions: 25, maxEvidence: 10, maxHypotheses: 5, maxPlanSteps: 10 });

/** Une consultation où le déterministe a choisi `deterministic` (ou rien). */
async function consult(
  gateway: IntelligenceGateway,
  scope: string,
  deterministic?: string,
  confidence = 0.4,
) {
  const built = builder().build('AMBIGUOUS_TARGET', SOURCES);
  const actionId = deterministic ? idOf(built.request, deterministic) : undefined;
  return gateway.consult({
    context: 'EXPLORATION',
    request: built.request,
    scope: { action: scope },
    deterministic: { ...(actionId ? { actionId } : {}), confidence },
    safety: (id) => {
      const candidate = built.candidateOf(id);
      return {
        allowed: candidate?.safety === 'SAFE' && candidate.allowed,
        classification: candidate?.safety ?? 'UNKNOWN',
        reason: 'SafetyPolicy',
      };
    },
    knownEvidence: (id) => ['E31', 'E42'].includes(id),
  });
}

describe('AI decision lifecycle: one outcome per call, separate dimensions', () => {
  it('§53 AUDIT: 10 ASSIST calls + 1 budget-exhausted decision — before: 11 "fallbacks"; now: 10 SHADOW_ONLY, 1 fallback (BUDGET_EXHAUSTED)', async () => {
    const provider = new ScriptedProvider([propose('Apply')]);
    const { gateway } = setup('ASSIST', provider);
    for (let index = 0; index < 11; index++) await consult(gateway, `S${String(index)}`, 'Enterprise');
    const summary = gateway.summary();
    expect(provider.calls).toBe(10);
    expect(summary.calls).toBe(10);
    expect(summary.accepted).toBe(0);
    expect(summary.rejected).toBe(0);
    // La cause de « 11 fallbacks » : chaque proposition shadow comptait comme repli, plus la décision sans appel.
    expect(summary.fallbacks).toBe(1);
    expect(summary.lifecycle.fallbacks.byReason).toEqual({ BUDGET_EXHAUSTED: 1 });
    expect(summary.lifecycle.fallbacks.decisionIds.BUDGET_EXHAUSTED).toEqual(['AI-00011']);
    expect(summary.lifecycle.byResponse).toEqual({ PROPOSAL: 10, BUDGET_EXHAUSTED: 1 });
    expect(summary.lifecycle.byTerminal).toEqual({ SHADOW_ONLY: 10, BUDGET_EXHAUSTED: 1 });
    expect(summary.lifecycle.shadow).toEqual({ DISAGREEMENT: 10 });
    expect(summary.lifecycle.validation).toEqual({ valid: 10, invalid: 0, notReceived: 1 });
    expect(summary.lifecycle.execution.executedFromAi).toBe(0);
    expect(summary.lifecycle.execution.notExecuted).toMatchObject({ ASSIST_MODE: 10, NO_RESPONSE: 1 });
    expect(summary.lifecycle.consistent).toBe(true);
    expect(summary.lifecycle.notCalled).toBe(1);
  });

  it('§53 COUNTERS: every call has exactly one classified response; the sums match the call count', async () => {
    const provider = new ScriptedProvider([
      propose('Enterprise'), // accord
      propose('Apply'), // désaccord
      status('INCONCLUSIVE'),
      status('NEED_MORE_EVIDENCE'),
      () => ({ status: 'MAYBE' }), // schéma invalide
      (request) => ({ ...propose('Apply')(request), selectedActionId: 'A99' }), // action inventée
      (request) => ({ ...propose('Apply')(request), supportingEvidenceIds: ['E999'] }), // preuve inventée
      () => 'THROW',
    ]);
    const { gateway } = setup('ASSIST', provider);
    for (let index = 0; index < 8; index++) await consult(gateway, `S${String(index)}`, 'Enterprise');
    const lifecycle = gateway.summary().lifecycle;
    expect(lifecycle.calls).toBe(8);
    const responses = Object.values(lifecycle.byResponse).reduce<number>((sum, count) => sum + count, 0);
    expect(responses).toBe(8);
    expect(lifecycle.byResponse).toEqual({
      PROPOSAL: 4,
      INCONCLUSIVE: 1,
      NEED_MORE_EVIDENCE: 1,
      INVALID_RESPONSE: 1,
      ERROR: 1,
    });
    expect(lifecycle.byTerminal).toEqual({
      SHADOW_ONLY: 2,
      INCONCLUSIVE: 1,
      NEED_MORE_EVIDENCE: 1,
      INVALID_RESPONSE: 1,
      VALIDATION_REJECTED: 2,
      ERROR: 1,
    });
    expect(lifecycle.validation).toEqual({ valid: 4, invalid: 3, notReceived: 1 });
    expect(lifecycle.shadow).toEqual({
      AGREEMENT: 1,
      DISAGREEMENT: 1,
      AI_INCONCLUSIVE: 2,
      DETERMINISTIC_ONLY: 4,
    });
    // ASSIST n'est jamais un repli : seuls les chemins IA qui n'ont pas servi.
    expect(lifecycle.fallbacks.byReason).toEqual({
      AI_INCONCLUSIVE: 1,
      AI_NEED_MORE_EVIDENCE: 1,
      INVALID_PROPOSAL: 1,
      UNKNOWN_ACTION: 1,
      INVALID_EVIDENCE: 1,
      AI_ERROR: 1,
    });
    expect(lifecycle.fallbacks.total).toBe(6);
    expect(lifecycle.consistent).toBe(true);
  });

  it('§48 ASSIST: Copilot proposes A2 (Apply), deterministic chose A1 (Enterprise) → valid, DISAGREEMENT, not accepted, ASSIST_MODE, no fallback', async () => {
    const { gateway, events } = setup('ASSIST', new ScriptedProvider([propose('Apply')]));
    const { record } = await consult(gateway, 'S1', 'Enterprise');
    expect(record.lifecycle).toMatchObject({
      call: true,
      response: 'PROPOSAL',
      terminal: 'SHADOW_ONLY',
      proposalValid: true,
      shadowResult: 'DISAGREEMENT',
      acceptedForExecution: false,
      notExecutedReason: 'ASSIST_MODE',
      runtime: 'NOT_APPLICABLE',
    });
    expect(record.lifecycle.fallbackReason).toBeUndefined();
    expect(record.id).toBe('AI-00001');
    expect(events.map((event) => event.event)).not.toContain('AI_FALLBACK_ACTIVATED');
    // §45 : une trace lisible par décision.
    const trace = events.find((event) => event.event === 'AI_DECISION_CLASSIFIED')?.message ?? '';
    expect(trace).toMatch(/^\[AI AI-00001\] trigger=AMBIGUOUS_TARGET /);
    expect(trace).toContain('mission=CREATE_REQUEST');
    expect(trace).toContain('goal=CREATE_REQUEST_DONE');
    expect(trace).toContain('checkpoint=CREATE_REQUEST_READY');
    expect(trace).toContain('mode=ASSIST');
    expect(trace).toContain('validation=VALID');
    expect(trace).toContain('shadow=DISAGREEMENT');
    expect(trace).toContain('execution=NOT_EXECUTED_ASSIST_MODE');
  });

  it('§49 INCONCLUSIVE → AI_INCONCLUSIVE, exactly one fallback counted', async () => {
    const { gateway, events } = setup('ASSIST', new ScriptedProvider([status('INCONCLUSIVE')]));
    const { record } = await consult(gateway, 'S1', 'Enterprise');
    expect(record.lifecycle).toMatchObject({
      response: 'INCONCLUSIVE',
      terminal: 'INCONCLUSIVE',
      shadowResult: 'AI_INCONCLUSIVE',
      fallbackReason: 'AI_INCONCLUSIVE',
    });
    expect(gateway.summary().fallbacks).toBe(1);
    expect(events.filter((event) => event.event === 'AI_FALLBACK_ACTIVATED')).toHaveLength(1);
  });

  it('§50 HYBRID: weak deterministic, valid SAFE proposal → ACCEPTED; the runtime confirms with goal progress', async () => {
    const { gateway } = setup('HYBRID', new ScriptedProvider([propose('Apply', 0.9)]));
    const { record, decision } = await consult(gateway, 'S1', 'Enterprise', 0.3);
    expect(decision.accepted).toBe(true);
    expect(record.lifecycle).toMatchObject({
      terminal: 'ACCEPTED',
      acceptedForExecution: true,
      execution: 'PENDING',
    });
    gateway.recordRuntime(record.id, true, 'observed: textbox:company name', {
      goal: 'CREATE_REQUEST_DONE',
      before: 0.7,
      after: 0.9,
      impact: 'ADVANCED',
    });
    gateway.recordKnowledge(record.id, {
      impact: 'RUNTIME_SUPPORTED',
      hypothesisId: 'H-3',
      hypothesisStatus: 'SUPPORTED',
    });
    const summary = gateway.summary();
    expect(summary.decisions[0]?.lifecycle).toMatchObject({
      execution: 'EXECUTED',
      runtime: 'CONFIRMED',
      goalProgress: { before: 0.7, after: 0.9, impact: 'ADVANCED' },
      knowledge: { impact: 'RUNTIME_SUPPORTED', hypothesisId: 'H-3' },
    });
    expect(summary.lifecycle.execution.executedFromAi).toBe(1);
    expect(summary.lifecycle.runtime.confirmed).toBe(1);
    expect(summary.fallbacks).toBe(0);
  });

  it('§51 WRONG AI: executed, but the expected effect is absent → RUNTIME_CONTRADICTED, never learned as truth', async () => {
    const { gateway } = setup('HYBRID', new ScriptedProvider([propose('Apply', 0.9)]));
    const { record } = await consult(gateway, 'S1', undefined, 0);
    gateway.recordRuntime(record.id, false, 'expected VISIBLE_FIELD:Company name; observed no new control');
    const decision = gateway.summary().decisions[0];
    expect(decision?.lifecycle.runtime).toBe('CONTRADICTED');
    expect(decision?.runtimeResult).toBe('RUNTIME_CONTRADICTED');
    expect(decision?.knowledgeCandidate).toEqual({ origin: 'AI_PROPOSAL', runtimeConfirmed: false });
  });

  it('HYBRID, not selected: SafetyPolicy refusal is SAFETY_REJECTED; a confident deterministic is DETERMINISTIC_PRIORITY', async () => {
    const unsafe = setup('HYBRID', new ScriptedProvider([propose('Create', 0.95)]));
    const refused = await consult(unsafe.gateway, 'S1', 'Enterprise', 0.3);
    expect(refused.record.lifecycle).toMatchObject({
      terminal: 'SAFETY_REJECTED',
      fallbackReason: 'SAFETY_BLOCKED',
    });
    const confident = setup('HYBRID', new ScriptedProvider([propose('Apply', 0.95)]));
    const kept = await consult(confident.gateway, 'S1', 'Enterprise', 0.9);
    expect(kept.record.lifecycle).toMatchObject({
      terminal: 'PROPOSAL',
      fallbackReason: 'DETERMINISTIC_PRIORITY',
    });
  });

  it('an advisory analysis (blocked goal) proposes without executing: SHADOW_ONLY in ASSIST, never a fallback; the request carries the functional context', async () => {
    const provider = new ScriptedProvider([
      (request) => ({
        status: 'PROPOSAL',
        selectedActionId: idOf(request, 'Apply'),
        missingPrecondition: 'FINAL_APPLY_REQUIRED',
        hypothesis: {
          type: 'WORKFLOW_PRECONDITION',
          statement: 'A final Apply action may be required before creation.',
          evidenceIds: ['E31'],
        },
        expectedEffects: [{ kind: 'CHECKPOINT', value: 'CREATE_REQUEST_DONE' }],
        supportingEvidenceIds: ['E31'],
        uncertainties: [],
        confidence: 0.74,
      }),
    ]);
    const { gateway } = setup('ASSIST', provider);
    const built = builder().build('UNKNOWN_BLOCKING_PRECONDITION', SOURCES);
    expect(built.request.functionalContext).toMatchObject({
      missingPreconditions: ['UNKNOWN'],
      lastConfirmedCheckpoint: 'CREATE_REQUEST_READY',
      unknownPrecondition: true,
    });
    const { record } = await gateway.consult({
      context: 'BLOCKED_GOAL',
      request: built.request,
      scope: { divergence: 'blocked' },
      deterministic: { confidence: 0.42 },
      safety: () => ({ allowed: false, classification: 'ADVISORY', reason: 'analysis' }),
      knownEvidence: (id) => id === 'E31',
    });
    expect(record.lifecycle).toMatchObject({
      response: 'PROPOSAL',
      terminal: 'SHADOW_ONLY',
      proposalValid: true,
      shadowResult: 'AI_ONLY_CANDIDATE',
      notExecutedReason: 'ASSIST_MODE',
    });
    expect(record.lifecycle.fallbackReason).toBeUndefined();
    expect(record.proposal).toMatchObject({
      hypothesisType: 'WORKFLOW_PRECONDITION',
      missingPrecondition: 'FINAL_APPLY_REQUIRED',
      expectedEffects: ['CHECKPOINT:CREATE_REQUEST_DONE'],
    });
    expect(record.functionalContext).toMatchObject({
      mission: 'CREATE_REQUEST',
      goal: 'CREATE_REQUEST_DONE',
      lastConfirmedCheckpoint: 'CREATE_REQUEST_READY',
      missingPreconditions: ['UNKNOWN'],
      unknownPrecondition: true,
    });
  });

  it('timeouts are classified (TIMEOUT / AI_TIMEOUT) and counted as a call', async () => {
    const { gateway } = setup('ASSIST', new ScriptedProvider([() => 'HANG']), { timeoutMs: 30 });
    const { record } = await consult(gateway, 'S1', 'Enterprise');
    expect(record.lifecycle).toMatchObject({
      call: true,
      response: 'TIMEOUT',
      terminal: 'TIMEOUT',
      fallbackReason: 'AI_TIMEOUT',
    });
    expect(gateway.summary().lifecycle.consistent).toBe(true);
  });

  it('classifyDecision is pure: NO_LLM_REQUIRED is neither a call nor a fallback', () => {
    expect(classifyDecision({ mode: 'ASSIST', advisory: false, failure: 'NO_LLM_REQUIRED' })).toMatchObject({
      call: false,
      response: 'NO_LLM_REQUIRED',
      terminal: 'NO_LLM_REQUIRED',
    });
    expect(
      classifyDecision({ mode: 'ASSIST', advisory: false, failure: 'NO_LLM_REQUIRED' }).fallbackReason,
    ).toBeUndefined();
    const request = builder().build('AMBIGUOUS_TARGET', SOURCES).request;
    const valid = validateIntelligenceProposal(propose('Apply')(request), request, () => true);
    expect(classifyDecision({ mode: 'ASSIST', advisory: false, validation: valid }).shadowResult).toBe(
      'AI_ONLY_CANDIDATE',
    );
  });

  it('§46 intelligence-decisions.json: the full lifecycle per decision, sanitized (no token, password, Authorization or cookie)', async () => {
    const leak = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const { gateway } = setup(
      'ASSIST',
      new ScriptedProvider([propose('Apply', 0.8, { summary: `${leak} password=hunter2-secret` })]),
    );
    await consult(gateway, 'S1', 'Enterprise');
    const artifact = intelligenceDecisionsArtifact(gateway.summary());
    const text = JSON.stringify(artifact);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).not.toContain('hunter2-secret');
    expect(artifact.decisions[0]).toMatchObject({
      decisionId: 'AI-00001',
      trigger: 'AMBIGUOUS_TARGET',
      mode: 'ASSIST',
      response: 'PROPOSAL',
      terminal: 'SHADOW_ONLY',
      shadowResult: 'DISAGREEMENT',
      executionResult: {
        acceptedForExecution: false,
        execution: 'NOT_EXECUTED',
        notExecutedReason: 'ASSIST_MODE',
      },
      runtimeVerification: { result: 'NOT_APPLICABLE (mode=ASSIST: shadow only)' },
      functionalContextSummary: {
        goal: 'CREATE_REQUEST_DONE',
        lastConfirmedCheckpoint: 'CREATE_REQUEST_READY',
      },
    });
    expect(artifact.lifecycle.calls).toBe(1);
  });
});
