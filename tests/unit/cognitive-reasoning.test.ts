import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '../../src/cognitive/evidence.js';
import { HypothesisEngine } from '../../src/cognitive/hypothesis-engine.js';
import type { ExecutionPlan } from '../../src/cognitive/planning.js';
import {
  DeterministicReasoningAdvisor,
  LLMReasoningAdvisor,
  shouldConsultAdvisor,
  validateProposal,
  type ReasoningProblem,
} from '../../src/cognitive/reasoning-advisor.js';
import {
  QAReasoningEngine,
  decisionUtility,
  narrate,
  type QAReasoningContext,
  type ScreenAction,
} from '../../src/cognitive/reasoning-engine.js';

const NOW = '2026-10-02T12:00:00Z';
const action = (label: string, extra: Partial<ScreenAction> = {}): ScreenAction => ({
  key: `button:${label.toLowerCase()}`,
  kind: 'click',
  label,
  role: 'button',
  safety: 'SAFE',
  allowed: true,
  ...extra,
});

function context(overrides: Partial<QAReasoningContext> = {}): QAReasoningContext {
  const evidence = new EvidenceStore('E-t');
  const hypotheses = new HypothesisEngine({ runtimeObservationsToConfirm: 2, now: () => NOW });
  const reveal = hypotheses.propose(
    { kind: 'CAUSAL', subject: 'click company', relation: 'REVEALS', object: 'textbox:business number' },
    evidence.add({ type: 'RUNTIME', source: 'run 1', timestamp: NOW, confidence: 0.8, details: {} }),
  );
  hypotheses.propose(
    { kind: 'CAUSAL', subject: 'click company', relation: 'REVEALS', object: 'textbox:business number' },
    evidence.add({ type: 'STATIC_SOURCE', source: 'company.component.html', confidence: 0.9, details: {} }),
  );
  return {
    mission: 'CREATE_REQUEST',
    goal: 'COMPANY_INFORMATION_AVAILABLE',
    businessState: {
      mission: 'CREATE_REQUEST',
      phase: 'COMPANY_INFORMATION',
      facts: [],
      phases: [],
      submission: 'BLOCKED',
      missing: ['Business number'],
      evidence: [{ id: 'E-t-9', type: 'DOM' }],
    },
    availableActions: [
      action('Company', { role: 'tab', staticEvidence: true, historicalSuccess: 0.8 }),
      action('Create company', { safety: 'MUTATION', allowed: false }),
      action('Company profile'),
    ],
    hypotheses: hypotheses.all(),
    causal: [
      { cause: 'click company', relation: 'REVEALS', effect: 'textbox:business number', hypothesis: reveal },
    ],
    coverageGaps: [],
    contradictions: [],
    nextFields: ['Business number'],
    budgets: { maxCandidates: 20, maxReasoningDurationMs: 1000 },
    ...overrides,
  };
}

describe('Lot J — QAReasoningEngine (§38–§43, §86–§88, §101)', () => {
  it('§101 / §43: three candidates — WHY the tab, WHY NOT the mutation and the weakly related button', () => {
    const engine = new QAReasoningEngine();
    const decision = engine.decide(context());
    expect(decision).toMatchObject({
      status: 'DECIDED',
      path: 'DEEP',
      reason: 'GOAL',
      selectedAction: { label: 'Company', role: 'tab' },
    });
    expect(decision.why).toEqual(
      expect.arrayContaining([
        'NEXT_FIELDS_DEPEND_ON_TARGET',
        'STATIC_COMPONENT_MATCH',
        'HISTORICAL_SUCCESS',
        'RUNTIME_TARGET_EXISTS',
        'SAFE_ACTION',
      ]),
    );
    expect(decision.alternatives).toEqual(
      expect.arrayContaining([
        {
          action: 'click "Create company"',
          utility: expect.any(Number) as unknown,
          reasons: ['MUTATION_NOT_REQUIRED'],
        },
        expect.objectContaining({
          action: 'click "Company profile"',
          reasons: expect.arrayContaining(['NO_EXPECTED_GOAL_EVIDENCE', 'LOWER_UTILITY']) as unknown,
        }),
      ]),
    );
    expect(decision.evidence.map((reference) => reference.id)).toContain('E-t-9');
    expect(decision.utility?.total).toBe(decisionUtility(decision.utility ?? ({} as never)));
    const story = narrate(decision, context());
    expect(story.join(' ')).toMatch(/Submission is blocked; missing: Business number/);
    expect(story.join(' ')).toMatch(/Rejected click "Create company": MUTATION_NOT_REQUIRED/);
    expect(engine.trace).toHaveLength(1);
  });

  it('§86: FAST path — the next step of a confident known plan is on screen: deterministic, no deep reasoning', () => {
    const plan: ExecutionPlan = {
      kind: 'CURRENT_PLAN',
      mission: 'CREATE_REQUEST',
      goal: 'CREATE_REQUEST_DONE',
      steps: [
        {
          kind: 'click',
          label: 'Company profile',
          role: 'button',
          intent: 'X_AVAILABLE',
          source: 'HUMAN_FLOW',
          expectedEffects: ['x'],
        },
      ],
      checkpoints: ['X_COMPLETE'],
      confidence: 0.9,
      assumptions: [],
      alternatives: [],
    };
    const decision = new QAReasoningEngine().decide(context({ currentPlan: plan, planPosition: 0 }));
    expect(decision).toMatchObject({
      path: 'FAST',
      selectedAction: { label: 'Company profile' },
      why: ['PLAN_NEXT_STEP', 'RUNTIME_TARGET_EXISTS', 'SAFE_ACTION'],
    });
  });

  it('a coverage gap is a reason; no reason at all is never an action (no random exploration)', () => {
    const gap = {
      item: {
        id: 'FIELD_INVALID:Business number',
        dimension: 'FIELD_INVALID' as const,
        label: 'invalid Business number',
        group: 'Company information',
        covered: false,
        importance: 0.8,
        evidence: [],
      },
      reason: 'COVERAGE' as const,
      suggestion: 'x',
    };
    const decision = new QAReasoningEngine().decide(
      context({
        causal: [],
        nextFields: [],
        hypotheses: [],
        coverageGaps: [gap],
        availableActions: [action('Company information'), action('Help')],
      }),
    );
    expect(decision).toMatchObject({ reason: 'COVERAGE', selectedAction: { label: 'Company information' } });
    const nothing = new QAReasoningEngine().decide(
      context({ causal: [], nextFields: [], hypotheses: [], availableActions: [action('Help')] }),
    );
    expect(nothing.status).toBe('INCONCLUSIVE');
  });

  it('§88: budget exhausted → REASONING_BUDGET_EXHAUSTED, never "unreachable"', () => {
    let clock = 0;
    const decision = new QAReasoningEngine().decide(
      context({ now: () => (clock += 600), budgets: { maxCandidates: 20, maxReasoningDurationMs: 1000 } }),
    );
    expect(decision.status).toBe('REASONING_BUDGET_EXHAUSTED');
  });

  it('no allowed action: NO_SAFE_ACTION, the unsafe ones are listed with their reason', () => {
    const decision = new QAReasoningEngine().decide(
      context({ availableActions: [action('Delete', { safety: 'DANGEROUS', allowed: false })] }),
    );
    expect(decision).toMatchObject({
      status: 'NO_SAFE_ACTION',
      alternatives: [{ action: 'click "Delete"', reasons: ['UNSAFE'] }],
    });
  });
});

describe('Lot K — ReasoningAdvisor (§72–§79, §102–§104)', () => {
  const problem: ReasoningProblem = {
    goal: 'COMPANY_INFORMATION_AVAILABLE',
    functionalState: 'phase COMPANY_INFORMATION · submission BLOCKED',
    visibleControls: [{ kind: 'click', label: 'Company', role: 'tab' }],
    previousActions: ['check EUR'],
    nextActions: ['fill Business number'],
    knownRules: [],
    staticEvidence: [{ id: 'E-1', summary: 'CompanyComponent owns businessNumber' }],
    runtimeEvidence: [],
    historicalEvidence: [],
    contradictions: [],
    allowedActions: [{ kind: 'click', label: 'Company', role: 'tab' }],
    trigger: 'SEMANTIC_AMBIGUITY',
  };
  const known = (id: string): boolean => id === 'E-1';

  it('§102: an LLM proposal of a "Magic Button" that exists nowhere is rejected (no action)', async () => {
    const advisor = new LLMReasoningAdvisor(() =>
      Promise.resolve(
        'Sure! {"candidateActions":[{"kind":"click","label":"Magic Button"}],"evidenceIds":[],"uncertainties":[]}',
      ),
    );
    const verdict = validateProposal(await advisor.advise(problem), problem, known);
    expect(verdict).toMatchObject({
      status: 'REJECTED',
      reasons: [expect.stringMatching(/hallucinated action: click "Magic Button"/) as unknown],
    });
  });

  it('§103: an existing, evidence-backed action is accepted (it still goes through the SafetyPolicy and runtime verification)', async () => {
    const advisor = new LLMReasoningAdvisor(() =>
      Promise.resolve(
        '{"candidateIntent":"OPEN_COMPANY","candidateActions":[{"kind":"click","label":"Company","role":"tab"}],"expectedGoal":"COMPANY_INFORMATION_AVAILABLE","evidenceIds":["E-1"],"uncertainties":[]}',
      ),
    );
    const verdict = validateProposal(await advisor.advise(problem), problem, known);
    expect(verdict).toMatchObject({
      status: 'ACCEPTED',
      actions: [{ kind: 'click', label: 'Company', role: 'tab' }],
    });
  });

  it('invalid schema or unknown evidence → rejected', () => {
    expect(validateProposal({ candidateActions: 'click', evidenceIds: [] }, problem, known).status).toBe(
      'REJECTED',
    );
    expect(
      validateProposal(
        {
          candidateActions: [{ kind: 'click', label: 'Company' }],
          evidenceIds: ['E-404'],
          uncertainties: [],
        },
        problem,
        known,
      ),
    ).toMatchObject({ status: 'REJECTED', reasons: ['unknown evidence: E-404'] });
  });

  it('§104 / §79: an advisor claim becomes at most a HYPOTHESIS, never confirmed knowledge', () => {
    const evidence = new EvidenceStore('E-t');
    const engine = new HypothesisEngine({ runtimeObservationsToConfirm: 2, now: () => NOW });
    const verdict = validateProposal(
      {
        hypothesis: 'EUR requires Business number',
        candidateActions: [{ kind: 'click', label: 'Company', role: 'tab' }],
        evidenceIds: [],
        uncertainties: [],
      },
      problem,
      known,
      { engine, addEvidence: (input) => evidence.add(input) },
    );
    expect(verdict.hypothesisId).toBeDefined();
    expect(engine.byId(verdict.hypothesisId ?? '')).toMatchObject({ status: 'HYPOTHESIS' });
    expect(engine.byId(verdict.hypothesisId ?? '')?.confidence).toBeLessThanOrEqual(0.3);
  });

  it('§73 / §74: the advisor is consulted only when the deterministic path is not enough, within its budget', () => {
    expect(
      shouldConsultAdvisor({
        exactLocatorFound: true,
        planKnown: false,
        confidence: 0.2,
        trigger: 'SEMANTIC_AMBIGUITY',
        callsUsed: 0,
        maxCalls: 3,
      }),
    ).toBe(false);
    expect(
      shouldConsultAdvisor({
        exactLocatorFound: false,
        planKnown: false,
        confidence: 0.9,
        trigger: 'SEMANTIC_AMBIGUITY',
        callsUsed: 0,
        maxCalls: 3,
      }),
    ).toBe(false);
    expect(
      shouldConsultAdvisor({
        exactLocatorFound: false,
        planKnown: false,
        confidence: 0.2,
        trigger: 'SEMANTIC_AMBIGUITY',
        callsUsed: 3,
        maxCalls: 3,
      }),
    ).toBe(false);
    expect(
      shouldConsultAdvisor({
        exactLocatorFound: false,
        planKnown: false,
        confidence: 0.2,
        trigger: 'SEMANTIC_AMBIGUITY',
        callsUsed: 0,
        maxCalls: 3,
      }),
    ).toBe(true);
  });

  it('the deterministic advisor invents nothing', async () => {
    const proposal = await new DeterministicReasoningAdvisor().advise({
      ...problem,
      goal: 'COMPANY_INFORMATION_AVAILABLE',
    });
    expect(validateProposal(proposal, problem, known).status).toBe('ACCEPTED');
    const none = await new DeterministicReasoningAdvisor().advise({ ...problem, goal: 'PAYMENT_DONE' });
    expect(none.candidateActions).toEqual([]);
  });
});
