import { describe, expect, it } from 'vitest';
import type { FlowConfig } from '../../src/config/flow-schema.js';
import {
  ActiveLearningEngine,
  informationGain,
  type ExperimentDriver,
} from '../../src/cognitive/active-learning.js';
import { BusinessStateEngine } from '../../src/cognitive/business-state-engine.js';
import { ContradictionDetector, TemporalDependencyGraph } from '../../src/cognitive/contradictions.js';
import { EvidenceStore } from '../../src/cognitive/evidence.js';
import { FunctionalCoverageGraph } from '../../src/cognitive/functional-coverage.js';
import { FunctionalModelBuilder } from '../../src/cognitive/functional-model.js';
import { HypothesisEngine } from '../../src/cognitive/hypothesis-engine.js';
import {
  FailureKnowledge,
  InvariantDiscoveryEngine,
  understandFailure,
} from '../../src/cognitive/invariants-failures.js';

const NOW = '2026-10-02T12:00:00Z';
const step = (kind: string, target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ kind, target, optional: false, allow: [], ...extra }) as unknown as FlowConfig['steps'][number];
const FLOW = {
  name: 'Create request',
  steps: [
    step('check', { strategy: 'label', value: 'EUR' }),
    step('click', { strategy: 'role', role: 'button', name: 'Company information' }),
    step('fill', { strategy: 'label', value: 'Company name' }, { value: 'x' }),
    step('fill', { strategy: 'label', value: 'Business number' }, { value: 'x' }),
    step('click', { strategy: 'role', role: 'button', name: 'Submit' }, { allow: ['MUTATION'] }),
  ],
};

describe('Lot F — InformationGainEstimator and ActiveLearningEngine (§17–§21, §94, §95)', () => {
  const competing = () => {
    const evidence = new EvidenceStore('E-t');
    const hypotheses = new HypothesisEngine({ runtimeObservationsToConfirm: 2, now: () => NOW });
    const seen = evidence.add({
      type: 'RUNTIME',
      source: 'run#1',
      timestamp: NOW,
      confidence: 0.6,
      details: {},
    });
    // Les deux actions ont précédé l'apparition du formulaire : laquelle le révèle ?
    const h1 = hypotheses.propose(
      { kind: 'CAUSAL', subject: 'check eur', relation: 'REVEALS', object: 'textbox:company name' },
      seen,
    );
    const h2 = hypotheses.propose(
      {
        kind: 'CAUSAL',
        subject: 'click enterprise interview',
        relation: 'REVEALS',
        object: 'textbox:company name',
      },
      seen,
    );
    const engine = new ActiveLearningEngine(hypotheses, (input) => evidence.add(input), {
      maxExperiments: 3,
      now: () => NOW,
    });
    return { hypotheses, engine, h1, h2 };
  };

  it('the information gain is the expected entropy reduction (bits); testing one of two equal causes is informative', () => {
    expect(informationGain([0.45, 0.45], new Set([0]))).toBeGreaterThan(0.8);
    expect(informationGain([0.9, 0.05], new Set([0]))).toBeLessThan(
      informationGain([0.45, 0.45], new Set([0])),
    );
  });

  it('§94: a SAFE, reversible experiment separates the hypotheses; it is executed, observed, both are updated', async () => {
    const { engine, h1, h2, hypotheses } = competing();
    const { proposals } = engine.propose(
      'textbox:company name',
      new Set(['checkbox:eur', 'button:enterprise interview']),
      () => 'SAFE',
    );
    expect(proposals.length).toBe(2);
    const proposal = proposals.find((candidate) => candidate.tests === h1.id);
    expect(proposal).toMatchObject({ safetyClass: 'SAFE', reversible: true, hypothesisIds: [h1.id, h2.id] });
    let undone = false;
    const driver: ExperimentDriver = {
      execute: () =>
        Promise.resolve({
          done: true,
          appeared: ['textbox:company name'],
          undo: () => ((undone = true), Promise.resolve(true)),
        }),
      observe: () => Promise.resolve(true),
    };
    if (!proposal) throw new Error('no proposal for H1');
    const result = await engine.run(proposal, driver);
    expect(result).toMatchObject({ executed: true, observed: true, restored: true });
    expect(undone).toBe(true);
    // Une expérience contrôlée est une source indépendante : avec deux observations runtime, la relation est confirmée.
    expect(hypotheses.byId(h1.id)?.evidenceFor.map((reference) => reference.type)).toEqual([
      'RUNTIME',
      'TEST_RESULT',
    ]);
    // L'autre hypothèse : la même expérience sur sa cause ne montrerait rien → contredite.
    const other = proposals.find((candidate) => candidate.tests === h2.id);
    if (!other) throw new Error('no proposal for H2');
    const negative = await engine.run(other, {
      execute: () => Promise.resolve({ done: true, appeared: [] }),
      observe: () => Promise.resolve(false),
    });
    expect(negative.observed).toBe(false);
    expect(hypotheses.byId(h2.id)?.status).toBe('CONTRADICTED');
  });

  it('§95: the theoretically best experiment needs DELETE → the SafetyPolicy blocks it, nothing is executed', async () => {
    const { engine } = competing();
    const { proposals, rejected } = engine.propose(
      'textbox:company name',
      new Set(['checkbox:eur', 'button:enterprise interview']),
      (action) => (action.label === 'eur' ? 'DANGEROUS' : 'MUTATION'),
    );
    expect(proposals).toEqual([]);
    expect(rejected.every((entry) => /SafetyPolicy/.test(entry.reason))).toBe(true);
    let executed = false;
    const [first] = rejected;
    if (!first) throw new Error('nothing rejected');
    const result = await engine.run(first.proposal, {
      execute: () => ((executed = true), Promise.resolve({ done: true, appeared: [] })),
      observe: () => Promise.resolve(false),
    });
    expect(result.executed).toBe(false);
    expect(executed).toBe(false);
  });
});

describe('Lot G — ContradictionDetector and TemporalDependencyGraph (§44–§50, §93)', () => {
  it('§45 / §93: human, OpenAPI, static and runtime disagree on "required": recorded, visible, typed, penalized', () => {
    const detected: string[] = [];
    const detector = new ContradictionDetector((contradiction) => detected.push(contradiction.id));
    detector.claim({ property: 'Business number.required', source: 'HUMAN_RECORDING', value: true });
    detector.claim({ property: 'Business number.required', source: 'OPENAPI', value: true });
    detector.claim({ property: 'Business number.required', source: 'STATIC_SOURCE', value: false });
    const contradiction = detector.claim({
      property: 'Business number.required',
      source: 'RUNTIME',
      value: false,
      detail: 'submit accepted without the field',
    });
    expect(contradiction?.types).toEqual(
      expect.arrayContaining([
        'OPENAPI_RUNTIME_MISMATCH',
        'HUMAN_RUNTIME_MISMATCH',
        'CONTRACT_IMPLEMENTATION_MISMATCH',
      ]),
    );
    expect(contradiction).toMatchObject({ runtimeValue: false, status: 'OPEN' });
    expect(detector.penalty('Business number.required')).toBeGreaterThan(0);
    expect(contradiction?.investigation).toMatch(/runtime \(SAFE\)/);
    expect(detected.length).toBeGreaterThan(0);
  });

  it('agreeing sources raise no contradiction', () => {
    const detector = new ContradictionDetector();
    detector.claim({ property: 'x.required', source: 'OPENAPI', value: true });
    expect(detector.claim({ property: 'x.required', source: 'RUNTIME', value: true })).toBeUndefined();
  });

  it('§48 / §50: CLICK → request → loading → response → dropdown: the dropdown WAITS_FOR the request (not "immediately visible")', () => {
    const temporal = new TemporalDependencyGraph();
    temporal.learn([
      { at: 0, kind: 'ACTION', label: 'click search' },
      { at: 10, kind: 'REQUEST_STARTED', label: 'GET /api/provinces', end: 600 },
      { at: 20, kind: 'LOADING_STARTED', label: 'spinner' },
      { at: 640, kind: 'CONTROL_APPEARED', label: 'combobox:province' },
    ]);
    expect(temporal.waitsFor('combobox:province')).toEqual([
      expect.objectContaining({ to: 'GET /api/provinces', relation: 'WAITS_FOR', latencyMs: 640 }),
    ]);
    const relations = temporal.all().map((link) => `${link.from} ${link.relation} ${link.to}`);
    expect(relations).toEqual(
      expect.arrayContaining([
        'click search TRIGGERS GET /api/provinces',
        'LOADING DURING GET /api/provinces',
        'GET /api/provinces COMPLETES_BEFORE combobox:province',
        'LOADING UNTIL combobox:province',
      ]),
    );
  });
});

describe('Lot H — InvariantDiscoveryEngine, FailureUnderstandingEngine, FailureKnowledge (§51–§59, §98, §99)', () => {
  const blocked = {
    mission: 'CREATE_REQUEST',
    facts: [],
    phases: [],
    submission: 'BLOCKED' as const,
    missing: ['Business number'],
    evidence: [],
  };

  it('§53 / §98: one observation is a candidate; several runs make it CONFIRMED; a new version that breaks it → VIOLATED', () => {
    const changes: string[] = [];
    let saved = new InvariantDiscoveryEngine({ run: 'r1', version: 'v1', now: () => NOW }).all();
    for (const run of ['r1', 'r2', 'r3', 'r4']) {
      const engine = new InvariantDiscoveryEngine(
        { run, version: 'v1', now: () => NOW },
        undefined,
        (invariant) => changes.push(`${run}:${invariant.status}`),
      );
      engine.restore(saved);
      for (let i = 0; i < 3; i += 1) engine.observeSituation(blocked);
      saved = engine.all();
      if (run === 'r1') expect(engine.all()[0]?.status).toBe('OBSERVED_MULTIPLE_TIMES');
    }
    expect(saved[0]?.status).toBe('CONFIRMED');
    const single = new InvariantDiscoveryEngine({ run: 'x', now: () => NOW });
    single.observeSituation(blocked);
    expect(single.all()[0]?.status).toBe('CANDIDATE');
    // V2 : l'envoi est actif alors qu'un champ requis manque.
    const v2 = new InvariantDiscoveryEngine({ run: 'r5', version: 'v1', now: () => NOW });
    v2.restore(saved);
    v2.observeSituation({ ...blocked, submission: 'ALLOWED_WHILE_INCOMPLETE' });
    expect(v2.all()[0]).toMatchObject({
      status: 'VIOLATED',
      counterexamples: [expect.objectContaining({ run: 'r5' })],
    });
    expect(v2.oracleInvariants()).toEqual([]);
  });

  it('a field preserved across a choice change becomes an invariant; a cleared field violates it', () => {
    const engine = new InvariantDiscoveryEngine(
      { run: 'r1', now: () => NOW },
      { multiple: 2, supported: 3, confirmed: 4, runsForSupported: 1, runsForConfirmed: 1 },
    );
    for (let i = 0; i < 4; i += 1) engine.observePreservation('check eur', 'Company name', true);
    expect(engine.all()[0]).toMatchObject({
      status: 'CONFIRMED',
      statement: '"check eur" MUST NOT clear "Company name"',
    });
    engine.observePreservation('check eur', 'Company name', false);
    expect(engine.all()[0]?.status).toBe('VIOLATED');
  });

  it('§57 / §99: failures are classified before being reported; known ones are recognized', () => {
    expect(
      understandFailure({
        status: 500,
        message: 'java.lang.NullPointerException',
        request: 'POST /api/company',
      }).class,
    ).toBe('TECHNICAL_FAILURE');
    expect(
      understandFailure({ status: 400, message: 'Business number invalid', expectedRejection: true }).class,
    ).toBe('EXPECTED_VALIDATION');
    expect(understandFailure({ status: 400, message: 'Business number invalid' }).class).toBe(
      'FUNCTIONAL_FAILURE',
    );
    expect(understandFailure({ status: 200, effectMissing: true }).class).toBe('FUNCTIONAL_FAILURE');
    expect(understandFailure({ status: 403, unauthorizedRole: true }).class).toBe('PERMISSION_FAILURE');
    expect(understandFailure({ timedOut: true }).class).toBe('TIMEOUT_FAILURE');
    const knowledge = new FailureKnowledge();
    const first = understandFailure({ status: 500, request: 'POST /api/company' }, knowledge);
    knowledge.record(first, NOW, 'v1', 'retry after the backend recovers');
    const again = understandFailure({ status: 500, request: 'POST /api/company' }, knowledge);
    expect(again.chain).toMatchObject({ occurrences: 1, knownRecovery: 'retry after the backend recovers' });
    expect(again.reasons.join(' ')).toMatch(/seen 1 time\(s\) before/);
  });
});

describe('Lot I — FunctionalCoverageGraph (§60–§64, §100)', () => {
  const model = new FunctionalModelBuilder()
    .addFlow(FLOW)
    .choice('Currency', 'EUR')
    .choice('Currency', 'CAD')
    .build();

  it('§100: many screens visited, but "invalid Business number" never tested → the gap is visible and becomes the next goal', () => {
    const coverage = new FunctionalCoverageGraph(model);
    const evidence = new EvidenceStore('E-t');
    const states = new BusinessStateEngine(
      model,
      (input) => evidence.add(input),
      () => NOW,
    );
    const field = (label: string, hasValue: boolean, invalid = false) => ({
      label,
      visible: true,
      hasValue,
      required: true,
      invalid,
      disabled: false,
    });
    for (let page = 0; page < 20; page += 1)
      coverage.observeSituation(
        states.evaluate({
          route: `/page/${String(page)}`,
          fields: [field('Company name', true), field('Business number', true)],
          choices: [{ group: 'Currency', label: 'EUR', checked: true, kind: 'radio' }],
          buttons: [{ label: 'Submit', enabled: true, submit: true }],
          tabs: [],
          alerts: [],
          busy: false,
        }).situation,
        `page ${String(page)}`,
      );
    coverage.observeSubmission('SUCCESS', 'POST /api/company 201');
    const lines = coverage.describe();
    expect(lines).toContain('Currency: ✓ EUR  ? CAD');
    expect(lines.find((line) => line.startsWith('Company information'))).toMatch(
      /✓ valid Business number .*\? invalid Business number .*\? missing Business number/,
    );
    const gaps = coverage.gaps().map((gap) => gap.item.id);
    expect(gaps).toContain('FIELD_INVALID:Business number');
    expect(gaps).toContain('SUBMISSION:VALIDATION_REJECTION');
    // La prochaine raison d'explorer : un chemin négatif important, pas un bouton jamais cliqué.
    expect(coverage.nextGoal()).toMatchObject({
      reason: 'COVERAGE',
      item: { id: 'FIELD_INVALID:Business number' },
    });
    expect(coverage.gaps().map((gap) => gap.item.id)).not.toContain('CAPABILITY:SUBMIT_CREATE_REQUEST');
    coverage.observeSubmission('EXPECTED_VALIDATION', 'POST /api/company 400');
    expect(coverage.gaps().map((gap) => gap.item.id)).not.toContain('SUBMISSION:VALIDATION_REJECTION');
  });
});
