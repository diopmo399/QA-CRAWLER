import { describe, expect, it } from 'vitest';
import { IntelligenceContextBuilder, type ContextSources } from '../../src/ai/context-builder.js';
import {
  decisionConfidenceOf,
  describeConfidence,
  proposedActionOf,
} from '../../src/ai/decision-confidence.js';
import { IntelligenceGateway, type AiEventRecord, type GatewayOptions } from '../../src/ai/gateway.js';
import type { IntelligenceRequest } from '../../src/ai/model.js';
import type { IntelligenceProvider } from '../../src/ai/provider.js';
import { buildCopilotRecoveryCandidate } from '../../src/ai/recovery-candidate.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import { IntelligenceTriggerPolicy, type TriggerSettings } from '../../src/ai/trigger-policy.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

/**
 * PROPOSITION → CANDIDAT DE RÉCUPÉRATION : une proposition validée, sûre et assez confiante DANS SON
 * ACTION devient un candidat exécutable (jamais une exécution directe) ; une abstention sûre n'est
 * jamais une action sûre ; une action ou une preuve inconnue, une action dangereuse sont refusées.
 */
const TRIGGERS: TriggerSettings = {
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
};

/** La V2 : l'ancien bouton a disparu, un onglet « Enterprise » rend visibles les champs attendus. */
const SOURCES: ContextSources = {
  mission: 'CREATE_REQUEST',
  goal: { id: 'COMPANY_INFORMATION_AVAILABLE', conditions: ['field Company name', 'field Business number'] },
  workflow: {
    previous: ['click Tasks', 'check EUR'],
    next: ['fill Company name', 'fill Business number'],
    requiredFields: ['Company name', 'Business number'],
  },
  candidates: [
    { key: 'tab:Enterprise', kind: 'click', role: 'tab', name: 'Enterprise', safety: 'SAFE', allowed: true },
    {
      key: 'link:Company profile',
      kind: 'click',
      role: 'link',
      name: 'Company profile',
      safety: 'SAFE',
      allowed: true,
    },
    {
      key: 'button:Delete company',
      kind: 'click',
      role: 'button',
      name: 'Delete company',
      safety: 'DANGEROUS',
      allowed: false,
    },
  ],
  evidence: [
    {
      id: 'E42',
      type: 'STATIC_SOURCE',
      source: 'routes.ts',
      confidence: 0.6,
      details: { tab: 'Enterprise' },
    },
  ],
  hypotheses: [],
  contradictions: [],
};

const idOf = (request: IntelligenceRequest, name: string): string =>
  request.availableActions.find((action) => action.name === name)?.id ?? 'A999';

function setup(
  mode: GatewayOptions['mode'],
  answer: (request: IntelligenceRequest) => unknown,
  provider?: IntelligenceProvider,
): { gateway: IntelligenceGateway; events: AiEventRecord[]; fake: FakeIntelligenceProvider } {
  const fake = new FakeIntelligenceProvider(answer);
  const events: AiEventRecord[] = [];
  const gateway = new IntelligenceGateway({
    mode,
    providerId: 'fake',
    createProvider: () => provider ?? fake,
    triggers: TRIGGERS,
    thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    budgets: {
      maxCallsPerRun: 10,
      maxCallsPerAction: 1,
      maxCallsPerDivergence: 1,
      maxToolCallsPerRequest: 4,
      maxReasoningDurationMs: 60_000,
    },
    timeoutMs: 2_000,
    maxRetries: 0,
    failOnUnavailable: false,
    sanitizer: new IntelligenceContextSanitizer(),
    emit: (record) => events.push(record),
  });
  return { gateway, events, fake };
}

async function recover(gateway: IntelligenceGateway, deterministic = 0) {
  const built = new IntelligenceContextBuilder({
    maxActions: 25,
    maxEvidence: 10,
    maxHypotheses: 5,
    maxPlanSteps: 10,
  }).build('RECOVERY_EXHAUSTED', SOURCES);
  const result = await gateway.consult({
    context: 'RECOVERY',
    request: built.request,
    scope: { divergence: 'COMPANY_INFORMATION_AVAILABLE|Company information' },
    deterministic: { confidence: deterministic },
    safety: (id) => {
      const candidate = built.candidateOf(id);
      return {
        allowed: candidate?.safety === 'SAFE',
        classification: candidate?.safety ?? 'UNKNOWN',
        reason: 'SafetyPolicy',
      };
    },
    knownEvidence: (id) => id === 'E42',
  });
  const build = buildCopilotRecoveryCandidate(result, {
    goal: 'COMPANY_INFORMATION_AVAILABLE',
    isKnownAction: (id) => built.candidateOf(id) !== undefined,
  });
  return { result, build, built };
}

const tabProposal = (request: IntelligenceRequest, extra: Record<string, unknown> = {}) => ({
  status: 'PROPOSAL',
  intent: 'open company information section',
  selectedActionId: idOf(request, 'Enterprise'),
  proposedGoal: { id: 'COMPANY_INFORMATION_AVAILABLE' },
  expectedEffects: [
    { kind: 'VISIBLE_FIELD', value: 'Company name' },
    { kind: 'VISIBLE_FIELD', value: 'Business number' },
  ],
  supportingEvidenceIds: ['E42'],
  uncertainties: [],
  confidence: 0.89,
  confidenceBreakdown: {
    action: 0.87,
    hypothesis: 0.82,
    goal: 0.94,
    evidence: 0.91,
    safety: 0.99,
    abstention: 0.1,
    overall: 0.89,
  },
  ...extra,
});

const names = (events: AiEventRecord[]) => events.map((event) => event.event);

describe('AI proposal → executable recovery candidate (HYBRID)', () => {
  it('1 / 4 / 12 a valid, SAFE, confident proposal becomes a COPILOT recovery candidate (the tab replacing the old button)', async () => {
    const { gateway, events } = setup('HYBRID', (request) => tabProposal(request));
    const { result, build, built } = await recover(gateway);
    expect(result.decision).toMatchObject({ accepted: true, source: 'AI_PROPOSAL', code: 'ACCEPTED' });
    expect(result.record.lifecycle).toMatchObject({ acceptedForExecution: true, terminal: 'ACCEPTED' });
    expect(result.record.lifecycle.notExecutedReason).toBeUndefined();
    expect('candidate' in build).toBe(true);
    if (!('candidate' in build)) return;
    expect(build.candidate).toMatchObject({
      source: 'COPILOT',
      goal: 'COMPANY_INFORMATION_AVAILABLE',
      confidence: 0.87,
      risk: 0,
      evidenceIds: ['E42'],
      expectedEffects: ['VISIBLE_FIELD:Company name', 'VISIBLE_FIELD:Business number'],
    });
    expect(built.candidateOf(build.candidate.actionId)?.name).toBe('Enterprise');
    expect(build.candidate.explainability.join(' ')).toContain('action 0.87');
    expect(names(events)).toEqual(
      expect.arrayContaining([
        'AI_PROPOSAL_RECEIVED',
        'AI_PROPOSAL_VALIDATED',
        'AI_PROPOSAL_CONVERTED_TO_RECOVERY_CANDIDATE',
        'AI_PROPOSAL_ACCEPTED',
      ]),
    );
    expect(events.find((event) => event.event === 'AI_PROPOSAL_RECEIVED')?.message).toContain(
      'action 0.87 · hypothesis 0.82',
    );
    expect(result.record.proposal?.confidences).toMatchObject({ action: 0.87, abstention: 0.1 });
  });

  it('an action given only as the first plan step is an action (no more "PROPOSAL without action")', async () => {
    const { gateway } = setup('HYBRID', (request) => {
      const { selectedActionId, ...rest } = tabProposal(request);
      return { ...rest, plan: { steps: [selectedActionId] } };
    });
    const { result, build } = await recover(gateway);
    expect(result.decision.accepted).toBe(true);
    expect('candidate' in build && build.candidate.source).toBe('COPILOT');
  });

  it('2 an unknown action ID is rejected by the validator — nothing reaches the executor', async () => {
    const { gateway } = setup('HYBRID', (request) => tabProposal(request, { selectedActionId: 'A99' }));
    const { result, build } = await recover(gateway);
    expect(result.validation?.valid).toBe(false);
    expect(result.record.lifecycle.fallbackReason).toBe('UNKNOWN_ACTION');
    expect(build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
  });

  it('3 an unknown evidence ID is rejected — nothing reaches the executor', async () => {
    const { gateway } = setup('HYBRID', (request) =>
      tabProposal(request, { supportingEvidenceIds: ['E999'] }),
    );
    const { result, build } = await recover(gateway);
    expect(result.validation?.valid).toBe(false);
    expect(result.record.lifecycle.fallbackReason).toBe('INVALID_EVIDENCE');
    expect(build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
  });

  it('5 a DANGEROUS proposal is blocked by the SafetyPolicy (AI_RECOVERY_BLOCKED_BY_SAFETY)', async () => {
    const { gateway, events } = setup('HYBRID', (request) =>
      tabProposal(request, { selectedActionId: idOf(request, 'Delete company') }),
    );
    const { result, build } = await recover(gateway);
    expect(result.decision).toMatchObject({ accepted: false, code: 'SAFETY' });
    expect(result.record.lifecycle.notExecutedReason).toBe('SAFETY_BLOCKED');
    expect(names(events)).toContain('AI_RECOVERY_BLOCKED_BY_SAFETY');
    expect(build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
  });

  it('6 a low ACTION confidence is not executed even when the overall confidence is high', async () => {
    const { gateway } = setup('HYBRID', (request) =>
      tabProposal(request, {
        confidence: 0.92,
        confidenceBreakdown: { action: 0.3, overall: 0.92, abstention: 0.2 },
      }),
    );
    const { result } = await recover(gateway);
    expect(result.decision).toMatchObject({ accepted: false, code: 'LOW_CONFIDENCE' });
    expect(result.decision.reasons[0]).toBe('action confidence 0.30 < 0.60');
  });

  it('an abstention at 0.99 is an ABSTENTION, never an action confidence (AI_ABSTENTION_SELECTED)', async () => {
    const answer = {
      status: 'NEED_MORE_EVIDENCE',
      supportingEvidenceIds: [],
      uncertainties: ['two tabs'],
      confidence: 0.99,
    };
    const { gateway, events } = setup('HYBRID', () => answer);
    const { result, build } = await recover(gateway);
    expect(result.decision.code).toBe('NOT_ACTIONABLE');
    expect(result.decision.reasons[0]).toBe(
      'proposal NEED_MORE_EVIDENCE (abstention confidence 0.99 — not an action confidence)',
    );
    expect(result.record.proposal?.confidences).toMatchObject({ action: 0, abstention: 0.99 });
    expect(names(events)).toContain('AI_ABSTENTION_SELECTED');
    expect(build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
  });

  it('7 a confident deterministic decision: the trigger policy never calls the provider (fast path)', () => {
    const policy = new IntelligenceTriggerPolicy(TRIGGERS, 0.85);
    expect(policy.evaluate({ deterministicConfidence: 0.92, knownState: true })).toMatchObject({
      shouldInvoke: false,
      skippedBecause: 'FAST_PATH',
    });
  });

  it('8 / 9 timeout or unavailable provider: no candidate, deterministic fallback', async () => {
    const slow = new FakeIntelligenceProvider(() => ({}), { delayMs: 3_000 });
    const timeout = await recover(setup('HYBRID', () => ({}), slow).gateway);
    expect(timeout.result.record.lifecycle.fallbackReason).toBe('AI_TIMEOUT');
    expect(timeout.build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
    const offline = new FakeIntelligenceProvider(() => ({}), { available: false });
    const unavailable = await recover(setup('HYBRID', () => ({}), offline).gateway);
    expect(unavailable.result.record.lifecycle.fallbackReason).toBe('AI_UNAVAILABLE');
    expect(unavailable.build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
  }, 10_000);

  it('OFF never calls; ASSIST only records (shadow) — no candidate in either mode', async () => {
    const assist = setup('ASSIST', (request) => tabProposal(request));
    const shadow = await recover(assist.gateway);
    expect(shadow.result.decision.accepted).toBe(false);
    expect(shadow.result.record.lifecycle.notExecutedReason).toBe('ASSIST_MODE');
    expect(shadow.build).toMatchObject({ rejected: 'NOT_ACCEPTED' });
    const off = setup('OFF', (request) => tabProposal(request));
    expect(off.gateway.evaluate({ deterministicConfidence: 0, recoveryExhausted: true }).skippedBecause).toBe(
      'MODE_OFF',
    );
    expect(off.fake.requests).toHaveLength(0);
  });

  it('the candidate builder refuses an action that is not in the context, even if accepted upstream', async () => {
    const { gateway } = setup('HYBRID', (request) => tabProposal(request));
    const { result } = await recover(gateway);
    expect(buildCopilotRecoveryCandidate(result, { goal: 'G', isKnownAction: () => false })).toMatchObject({
      rejected: 'UNKNOWN_ACTION_ID',
    });
  });
});

describe('decision confidence: each score says what it measures', () => {
  it('a proposal without breakdown: confidence is the action confidence; an abstention: the abstention confidence', () => {
    const base = { supportingEvidenceIds: [], uncertainties: [] };
    expect(
      decisionConfidenceOf({ ...base, status: 'PROPOSAL', selectedActionId: 'A1', confidence: 0.78 }),
    ).toMatchObject({ action: 0.78, abstention: 0 });
    expect(decisionConfidenceOf({ ...base, status: 'INCONCLUSIVE', confidence: 0.99 })).toMatchObject({
      action: 0,
      abstention: 0.99,
    });
    expect(
      proposedActionOf({ ...base, status: 'PROPOSAL', plan: { steps: ['A3', 'A4'] }, confidence: 0.7 }),
    ).toBe('A3');
    expect(describeConfidence({ action: 0.87, abstention: 0.1, overall: 0.89, goal: 0.94 })).toBe(
      'action 0.87 · goal 0.94 · abstention 0.10 · overall 0.89',
    );
  });
});
