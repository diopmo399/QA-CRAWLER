import { describe, expect, it } from 'vitest';
import { buildRunAnalysis } from '../../src/analysis/run-analysis.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport, FlowStepReport } from '../../src/model/flow-run.js';
import { runAnalysisSection } from '../../src/reporting/run-analysis-section.js';

/**
 * RUN ANALYSIS : le verdict fonctionnel par règles, et la chaîne explicative qui relie ce que les
 * moteurs ont produit (divergence → cause → hypothèses → récupération → vérification → dérive →
 * apprentissage). Chaque cas est un ExplorationResult minimal : rien n'est recalculé ici.
 */
function step(index: number, description: string, extra: Partial<FlowStepReport> = {}): FlowStepReport {
  return { index, kind: 'click', description, status: 'PASSED', optional: false, durationMs: 100, ...extra };
}

const effect = (
  status: FlowStepReport['effect'] extends infer E ? (E extends { status: infer S } ? S : never) : never,
  extra = {},
) => ({
  execution: 'EXECUTED' as const,
  status,
  expected: [],
  observed: [],
  reasons: [],
  recovery: [],
  ...extra,
});

function flow(name: string, steps: FlowStepReport[], extra: Partial<FlowRunReport> = {}): FlowRunReport {
  const failed = steps.some((entry) => entry.status === 'FAILED');
  const blocked = steps.some((entry) => entry.status === 'BLOCKED');
  return {
    name,
    status: blocked ? 'BLOCKED' : failed ? 'FAILED' : 'PASSED',
    startedAt: '2026-10-11T10:00:00.000Z',
    durationMs: steps.reduce((sum, entry) => sum + entry.durationMs, 0),
    steps,
    states: [],
    issueIds: [],
    explored: false,
    ...extra,
  };
}

function result(flows: FlowRunReport[], extra: Partial<ExplorationResult> = {}): ExplorationResult {
  return {
    mission: 'create-and-find',
    mode: 'explore',
    target: { baseUrl: 'http://app.test', startUrl: 'http://app.test/' },
    startedAt: '2026-10-11T10:00:00.000Z',
    finishedAt: '2026-10-11T10:00:10.000Z',
    durationMs: 10_000,
    runId: 'run-1',
    stats: { issuesBySeverity: { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 } },
    flows,
    mutations: { enabled: true, executed: 1, autonomous: 0, flows: 1 },
    artifacts: {},
    ...extra,
  } as unknown as ExplorationResult;
}

const PROVEN_FLOW = (): FlowRunReport =>
  flow(
    'create-and-find',
    [
      step(1, 'click New company', {
        effect: effect('CONFIRMED', { locator: 'role=button[name="New company"]' }),
      }),
      step(2, 'fill Display label = ${testData:company.name}', { kind: 'fill' }),
      step(3, 'click Save', { effect: effect('CONFIRMED', { locator: 'role=button[name="Save"]' }) }),
      step(4, 'click ${testData:company.name}', { testData: ['testData.company.name'] }),
    ],
    {
      testDataReport: {
        entries: [
          {
            key: 'company.name',
            strategy: 'GENERATE_AT_REPLAY',
            sensitive: false,
            producedAt: 2,
            usedBy: [
              { step: 2, how: 'INPUT' },
              { step: 4, how: 'CITATION' },
            ],
          },
        ],
      },
      businessProof: {
        status: 'PROVEN',
        key: 'company.name',
        creation: {
          step: 3,
          description: 'click Save',
          status: 'PASSED',
          request: 'POST /api/companies → 204',
        },
        search: { step: 2, description: 'fill', status: 'PASSED' },
        open: { step: 4, description: 'click', status: 'PASSED' },
        evidence: ['CREATE: …', 'SEARCH: …', 'OPEN: …'],
        missing: [],
      },
    },
  );

describe('Run analysis — the functional verdict', () => {
  it('PROVEN: every flow passed as recorded and the business proof is made', () => {
    const analysis = buildRunAnalysis(result([PROVEN_FLOW()]));
    expect(analysis.status).toBe('PROVEN');
    expect(analysis.summary).toMatchObject({
      flows: { total: 1, passed: 1 },
      businessProof: { proven: 1 },
      mutations: { flows: 1 },
    });
    expect(analysis.summary.headline).toMatch(/^Goal proven/);
    expect(analysis.firstDivergence).toBeUndefined();
    expect(analysis.explainability.chain.map((link) => link.stage)).toEqual([
      'INTENT',
      'OBSERVED',
      'DIVERGENCE',
      'CONTINUATION',
      'VERDICT',
    ]);
    expect(analysis.testData?.flows[0]?.proof?.status).toBe('PROVEN');
    // Un objectif « bloqué » du moteur cognitif n'est pas une cause racine quand rien n'a divergé.
    const healthy = result([PROVEN_FLOW()], {
      cognitive: {
        checkpoints: [],
        hypotheses: { byStatus: {}, top: [] },
        confirmedRelations: [],
        contradictions: [],
        recoveredPlans: [],
        coverage: [],
        coverageGaps: [],
        invariants: [],
        decisions: [],
        experiments: { proposed: 0, rejected: 0 },
        knowledge: { evidence: 0, hypotheses: 0, confirmed: 0, contradicted: 0 },
        progressTimeline: [],
        hypothesisDetails: [],
        contradictedAnalysis: [],
        divergences: [],
        failures: [],
        blockedGoal: {
          goal: 'X',
          node: 'X_DONE',
          state: 'BLOCKED',
          satisfiedPreconditions: [],
          missingPreconditions: ['A'],
          unknownPrecondition: true,
          blockingReasons: ['A is missing'],
          candidateActions: [],
          candidateHypotheses: [],
          progress: 0.1,
          confidence: 0.3,
        },
      },
    } as unknown as Partial<ExplorationResult>);
    expect(buildRunAnalysis(healthy).rootCause).toBeUndefined();
  });

  it('PASSED: flows passed, no business proof applicable', () => {
    const analysis = buildRunAnalysis(
      result([flow('login', [step(1, 'click Sign in', { effect: effect('CONFIRMED') })])]),
    );
    expect(analysis.status).toBe('PASSED');
    expect(analysis.explainability.verdictReasons[0]).toContain('no business proof was applicable');
  });

  it('PASSED_UNVERIFIED: a step ran but its effect was never verified (or the recorded expectation is suspect)', () => {
    const analysis = buildRunAnalysis(
      result([
        flow('f', [
          step(1, 'click Save', { effect: effect('NOT_VERIFIED', { expected: ['route /done'] }) }),
          step(2, 'click Next', {
            effect: effect('CONFIRMED'),
            recordingModelDivergence: {
              classification: 'RECORDED_EXPECTATION_CONTAMINATED',
              suspectEffects: ['+ dialog'],
              reasons: ['describes a later step'],
            },
          }),
        ]),
      ]),
    );
    expect(analysis.status).toBe('PASSED_UNVERIFIED');
    expect(analysis.summary.steps.unverified).toBe(2);
    expect(analysis.recommendations.map((item) => item.kind)).toContain('FLOW_UPDATE');
  });

  it('PASSED_WITH_RECOVERY: a goal recovery reached its goal and the next step confirmed it', () => {
    const recovery = {
      originalActionId: 'a3',
      originalTarget: 'button "Validate"',
      divergence: {
        actionId: 'a3',
        stepIndex: 3,
        symptom: 'TARGET_NOT_FOUND',
        category: 'TARGET_RENAMED',
        confidence: 0.82,
        evidence: [{ source: 'RUNTIME', detail: 'a button "Confirm" sits where "Validate" was' }],
        possibleCauses: [
          { category: 'TARGET_RENAMED', confidence: 0.82, evidence: [] },
          { category: 'TARGET_MOVED', confidence: 0.3, evidence: [] },
        ],
        rootStepIndex: 3,
        recoverable: true,
        technicalSymptom: 'TARGET_FINGERPRINT_MISMATCH',
      },
      context: { previous: [], next: [], requiredFields: [] },
      goal: { id: 'ORDER_VALIDATED', predicates: [], confidence: 0.8, level: 'HIGH', source: [] },
      plan: {
        status: 'EXECUTED',
        candidates: [
          {
            signature: 'click:Confirm',
            source: 'CURRENT_UI',
            score: 0.9,
            risk: 'SAFE',
            reasons: ['same section', 'same role'],
          },
        ],
        rejected: [{ signature: 'click:Delete', risk: 'DANGEROUS', reason: 'dangerous action' }],
        truncated: 0,
      },
      outcome: {
        status: 'GOAL_REACHED',
        path: [{ kind: 'click', role: 'button', name: 'Confirm', part: 'GOAL' }],
        pathSource: 'CURRENT_UI',
        attempts: [{ path: 'click:Confirm', source: 'CURRENT_UI', result: 'GOAL_REACHED', progress: 1 }],
        experiments: 1,
        actionsExecuted: 1,
        durationMs: 300,
        confirmedCategory: 'TARGET_RENAMED',
        reasons: ['goal predicates satisfied after the click'],
      },
      selected: {
        signature: 'click:Confirm',
        source: 'CURRENT_UI',
        reasons: ['same section', 'same role'],
        risk: 'SAFE',
      },
      nextActionVerified: true,
    } as unknown as FlowStepReport['recovery'];
    const analysis = buildRunAnalysis(
      result([
        flow('order', [
          step(1, 'click New'),
          step(2, 'fill Amount', { kind: 'fill' }),
          step(3, 'click Validate', {
            effect: effect('CONFIRMED', { locator: 'role=button[name="Confirm"]' }),
            recovery,
          }),
          step(4, 'expect text Done', { kind: 'expect' }),
        ]),
      ]),
    );
    expect(analysis.status).toBe('PASSED_WITH_RECOVERY');
    expect(analysis.recovery).toMatchObject({ succeeded: 1, failed: 0 });
    expect(analysis.recovery?.attempts[0]).toMatchObject({
      step: 3,
      divergenceCategory: 'TARGET_RENAMED',
      selected: { signature: 'click:Confirm', source: 'CURRENT_UI' },
      outcome: { status: 'GOAL_REACHED', confirmedCategory: 'TARGET_RENAMED', path: ['click "Confirm"'] },
      verified: true,
      aiAssisted: false,
    });
    // La cause racine vient de l'analyse de divergence de l'étape récupérée, avec ses preuves et les autres candidats.
    expect(analysis.rootCause).toMatchObject({
      step: 3,
      category: 'TARGET_RENAMED',
      confidence: 0.82,
      recoverable: true,
    });
    expect(analysis.rootCause?.candidates).toHaveLength(2);
    expect(analysis.rootCause?.evidence[0]?.detail).toContain('Confirm');
    const stages = analysis.explainability.chain.map((link) => link.stage);
    expect(stages).toEqual(expect.arrayContaining(['ROOT_CAUSE', 'RECOVERY', 'VERIFICATION', 'VERDICT']));
    expect(analysis.explainability.chain.find((link) => link.stage === 'VERIFICATION')?.text).toContain(
      'next step',
    );
    expect(analysis.explainability.chain.find((link) => link.stage === 'RECOVERY')?.evidence[0]).toContain(
      'chose click:Confirm',
    );
    expect(analysis.recommendations.some((item) => item.kind === 'KNOWLEDGE')).toBe(true);
  });

  it('DIVERGED: a flow failed, the first divergence and the probable cause are named, no safe recovery', () => {
    const analysis = buildRunAnalysis(
      result([
        flow(
          'f',
          [
            step(1, 'click New', { effect: effect('CONFIRMED') }),
            step(2, 'click Save', {
              effect: effect('WRONG_EFFECT', {
                expected: ['route /tasks'],
                observed: ['route /companies/new'],
                deferred: true,
              }),
              reason: 'expected effect changed',
            }),
            step(3, 'click Result', { status: 'FAILED', reason: 'element not found within 10000 ms' }),
            step(4, 'expect url /companies/', { kind: 'expect', status: 'SKIPPED' }),
          ],
          {
            divergence: {
              stepIndex: 2,
              description: 'click Save',
              reason: 'expected effect changed → reported at step 3',
              lastConfirmedStep: 1,
              symptomStep: 3,
              probableCause: { category: 'WRONG_WORKFLOW_STATE', confidence: 0.6 },
            },
          },
        ),
      ]),
    );
    expect(analysis.status).toBe('DIVERGED');
    expect(analysis.firstDivergence).toMatchObject({
      step: 2,
      symptomStep: 3,
      lastConfirmedStep: 1,
      rootBeforeSymptom: true,
      kind: 'WRONG_EFFECT',
    });
    expect(analysis.rootCause).toMatchObject({ category: 'WRONG_WORKFLOW_STATE', confidence: 0.6 });
    expect(analysis.failures).toHaveLength(1);
    expect(analysis.explainability.verdictReasons[0]).toMatch(/first divergence at step 2 \(WRONG_EFFECT\)/);
    const continuation = analysis.explainability.chain.find((link) => link.stage === 'CONTINUATION');
    expect(continuation?.text).toContain('1 skipped, 1 failed');
    expect(analysis.explainability.chain.find((link) => link.stage === 'RECOVERY')?.text).toContain(
      'no safe recovery',
    );
  });

  it('BLOCKED: a step refused by the safety policy is never a divergence to recover', () => {
    const analysis = buildRunAnalysis(
      result([
        flow('f', [
          step(1, 'click Delete all', { status: 'BLOCKED', reason: 'DANGEROUS action without allow' }),
        ]),
      ]),
    );
    expect(analysis.status).toBe('BLOCKED');
    expect(analysis.recommendations.map((item) => item.kind)).toContain('SAFETY');
  });

  it('INCONCLUSIVE: flows passed but the business proof is only PARTIAL', () => {
    const partial = PROVEN_FLOW();
    partial.businessProof = {
      status: 'PARTIAL',
      key: 'company.name',
      evidence: [],
      missing: ['never opened'],
    };
    const analysis = buildRunAnalysis(result([partial]));
    expect(analysis.status).toBe('INCONCLUSIVE');
    expect(analysis.recommendations.find((item) => item.origin === 'BusinessProof')?.message).toContain(
      'never opened',
    );
  });

  it('EXPLORED: no imposed flow — the verdict is the one of the anomalies', () => {
    const analysis = buildRunAnalysis(result([]));
    expect(analysis.status).toBe('EXPLORED');
    expect(analysis.executionTimeline.entries).toEqual([]);
  });
});

describe('Run analysis — hypotheses, drift, knowledge, intelligence and the HTML section', () => {
  const cognitive = {
    mission: 'CREATE_AND_FIND',
    functionalState: 'mission CREATE_AND_FIND · submission NOT_VISIBLE',
    goal: 'CREATE_AND_FIND_DONE',
    checkpoints: [
      { id: 'FORM_COMPLETE', status: 'CONFIRMED' },
      { id: 'SUBMITTED', status: 'NOT_REACHED' },
    ],
    hypotheses: { byStatus: { CONFIRMED: 1, CONTRADICTED: 1 }, top: [] },
    confirmedRelations: ['click Save → POST /api/companies'],
    contradictions: [],
    recoveredPlans: [],
    failures: [
      {
        step: 'step 3',
        class: 'WORKFLOW_FAILURE',
        reason: 'the journey diverged',
        context: { observed: 'submission NOT_VISIBLE', firstDivergence: 'step 2 click Save' },
      },
    ],
    coverage: ['valid Company name'],
    coverageGaps: ['invalid Company name: not exercised — submit an invalid value to observe the rejection'],
    invariants: [],
    decisions: [],
    experiments: { proposed: 0, rejected: 0 },
    knowledge: { evidence: 12, hypotheses: 2, confirmed: 1, contradicted: 1 },
    progressTimeline: [{ source: 'screen', before: 0, after: 0.3 }],
    divergences: [
      {
        flow: 'f',
        divergence: {
          step: 2,
          description: 'click Save',
          kind: 'EFFECT_MISSING',
          expected: ['route /tasks'],
          observed: ['route /companies/new'],
          reason: 'the expected route never came',
          lastFailedStep: 3,
          lastConfirmedStep: 1,
          rootBeforeSymptom: true,
        },
      },
    ],
    hypothesisDetails: [
      {
        id: 'H-1',
        type: 'CAUSAL',
        origin: 'RUNTIME',
        description: 'click Save leads to route /tasks',
        supportingEvidence: ['e1', 'e2'],
        contradictingEvidence: [],
        confidence: 0.9,
        status: 'CONFIRMED',
        createdAt: '',
        lastEvaluatedAt: '',
        runtimeConfirmed: true,
      },
      {
        id: 'H-2',
        type: 'CAUSAL',
        origin: 'AI_PROPOSAL',
        description: 'Save is disabled until the address is valid',
        supportingEvidence: [],
        contradictingEvidence: ['e3'],
        confidence: 0.2,
        status: 'CONTRADICTED',
        createdAt: '',
        lastEvaluatedAt: '',
        runtimeConfirmed: false,
      },
    ],
    contradictedAnalysis: [
      {
        id: 'H-2',
        description: 'Save is disabled until the address is valid',
        why: 'Save was enabled with an empty address',
        alternatives: ['Save validates on submit'],
        investigation: 'submit with an empty address (safe: a rejection is expected)',
        needsAnalysis: false,
      },
    ],
  };
  const diverged = (): ExplorationResult =>
    result(
      [
        flow(
          'f',
          [
            step(1, 'click New', { effect: effect('CONFIRMED') }),
            step(2, 'click Save', { effect: effect('NO_EFFECT'), reason: 'no effect' }),
            step(3, 'click Result', { status: 'FAILED', reason: 'not found' }),
          ],
          {
            drift: {
              detected: true,
              classification: 'WORKFLOW_DRIFT',
              result: 'FAIL_NO_SAFE_RECOVERY',
              facts: {
                totalActions: 3,
                exactActions: 1,
                locatorHealedActions: 0,
                goalRecoveredActions: 0,
                insertedRuntimeActions: 0,
                obsoleteCandidates: 0,
                changedEffects: 1,
                ambiguousActions: 0,
                unverifiedActions: 0,
                renamedTargets: 0,
                replacedTargets: 0,
              },
              explanation: ['the effect of Save changed'],
              suggestedFiles: ['suggested.flow.yaml'],
              flowUpdateSuggested: true,
            },
          },
        ),
      ],
      {
        cognitive,
        ai: {
          mode: 'ASSIST',
          provider: 'copilot',
          available: true,
          triggersEvaluated: 3,
          fastPath: 1,
          calls: 2,
          proposals: 2,
          accepted: 1,
          rejected: 1,
          inconclusive: 0,
          runtimeConfirmed: 0,
          runtimeContradicted: 1,
          aiAssistedRecoveries: 0,
          shadow: { compared: 0, agreements: 0, disagreements: 0 },
          timeouts: 0,
          unavailable: 0,
          budgetExhausted: 0,
          fallbacks: 0,
          averageLatencyMs: 800,
          toolCalls: 0,
          byTrigger: {},
          noLlmRequired: 1,
          models: [],
          effectiveness: [],
        },
        intelligence: {
          strategy: 'best-first',
          goals: [],
          patterns: {},
          coverage: {},
          decisions: [],
          budget: {},
          domainPacks: [],
          knowledge: { identity: { application: 'app' }, runs: 4 },
        },
      } as unknown as Partial<ExplorationResult>,
    );

  it('the cognitive divergence (the cause) wins over the step symptom; hypotheses about it are flagged; the failure class is kept', () => {
    const analysis = buildRunAnalysis(diverged());
    expect(analysis.status).toBe('DIVERGED');
    expect(analysis.firstDivergence).toMatchObject({
      step: 2,
      symptomStep: 3,
      kind: 'EFFECT_MISSING',
      rootBeforeSymptom: true,
    });
    expect(analysis.rootCause).toMatchObject({ failureClass: 'WORKFLOW_FAILURE' });
    expect(analysis.hypotheses.find((hypothesis) => hypothesis.id === 'H-1')?.relatedToDivergence).toBe(true);
    expect(
      analysis.hypotheses.find((hypothesis) => hypothesis.id === 'H-2')?.contradiction?.alternatives,
    ).toEqual(['Save validates on submit']);
    expect(analysis.failures[0]).toMatchObject({
      class: 'WORKFLOW_FAILURE',
      firstDivergence: 'step 2 click Save',
    });
    expect(analysis.checkpoints).toEqual([
      { id: 'FORM_COMPLETE', status: 'CONFIRMED' },
      { id: 'SUBMITTED', status: 'NOT_REACHED' },
    ]);
    expect(analysis.workflowDrift?.flows[0]).toMatchObject({
      detected: true,
      classification: 'WORKFLOW_DRIFT',
    });
    expect(analysis.functionalCoverage?.gaps).toHaveLength(1);
    expect(analysis.knowledge).toMatchObject({ evidence: 12, confirmed: 1, contradicted: 1, runs: 4 });
    expect(analysis.intelligence).toMatchObject({
      mode: 'ASSIST',
      calls: 2,
      accepted: 1,
      contribution: 'ADVISORY',
      hypothesesProposed: 1,
    });
    const kinds = analysis.recommendations.map((item) => item.kind);
    expect(kinds).toEqual(expect.arrayContaining(['FLOW_UPDATE', 'COVERAGE', 'INVESTIGATE']));
    const stages = analysis.explainability.chain.map((link) => link.stage);
    expect(stages).toEqual([
      'INTENT',
      'OBSERVED',
      'DIVERGENCE',
      'ROOT_CAUSE',
      'HYPOTHESES',
      'RECOVERY',
      'CONTINUATION',
      'DRIFT',
      'COVERAGE',
      'LEARNING',
      'INTELLIGENCE',
      'VERDICT',
    ]);
  });

  it('the HTML section shows the verdict, the chain, the divergence, the hypotheses and the recommendations, in French', () => {
    const value = diverged();
    value.runAnalysis = buildRunAnalysis(value);
    value.artifacts.runAnalysis = '/tmp/run-analysis.json';
    const html = runAnalysisSection(value, 'fr');
    for (const text of [
      'Analyse du run',
      'Divergé',
      'Chaîne causale',
      'Première divergence',
      'Cause racine',
      'Hypothèses',
      'Recommandations',
      'Dérive',
      'Conseiller d’intelligence',
      'run-analysis.json',
      'WORKFLOW_FAILURE',
      'H-2',
      'Save validates on submit',
    ])
      expect(html, text).toContain(text);
    expect(runAnalysisSection(result([]), 'en')).toBe('');
  });
});
