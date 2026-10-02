import { describe, expect, it } from 'vitest';
import type { FlowConfig } from '../../src/config/flow-schema.js';
import {
  BusinessStateEngine,
  describeSituation,
  type ScreenObservation,
} from '../../src/cognitive/business-state-engine.js';
import { CausalKnowledgeGraph } from '../../src/cognitive/causal-graph.js';
import {
  combineWeights,
  EvidenceStore,
  evidenceWeight,
  type Evidence,
} from '../../src/cognitive/evidence.js';
import { EvidenceGraph } from '../../src/cognitive/evidence-graph.js';
import { FunctionalModelBuilder } from '../../src/cognitive/functional-model.js';
import { HypothesisEngine } from '../../src/cognitive/hypothesis-engine.js';

const NOW = '2026-10-02T12:00:00Z';
const step = (kind: string, target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ kind, target, optional: false, allow: [], ...extra }) as unknown as FlowConfig['steps'][number];

/** Le parcours démontré : choisir la devise, ouvrir les informations de l'entreprise, remplir, envoyer. */
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

const store = () => new EvidenceStore('E-t');
const runtime = (evidence: EvidenceStore, source: string, extra: Partial<Evidence> = {}): Evidence =>
  evidence.add({ type: 'RUNTIME', source, timestamp: NOW, confidence: 0.8, details: { source }, ...extra });

describe('Lot A — Evidence and EvidenceGraph (§2–§5)', () => {
  it('the type caps what a piece of evidence can prove; weights combine without ever reaching certainty', () => {
    expect(evidenceWeight({ type: 'RUNTIME', confidence: 1 })).toBe(1);
    expect(evidenceWeight({ type: 'STATIC_SOURCE', confidence: 1 })).toBe(0.6);
    expect(evidenceWeight({ type: 'LLM_PROPOSAL', confidence: 1 })).toBe(0.2);
    expect(
      evidenceWeight({ type: 'RUNTIME', confidence: 1, applicationVersion: 'v1' }, { version: 'v2' }),
    ).toBe(0.7);
    expect(combineWeights([0.6, 0.6])).toBe(0.84);
    expect(combineWeights([1, 1])).toBe(0.99);
  });

  it('every relation keeps its provenance: sources, count, first/last observed, runtime confirmation', () => {
    const evidence = store();
    const graph = new EvidenceGraph({ version: 'v42', now: () => NOW });
    const field = graph.node('FIELD', 'Business number');
    const dto = graph.node('DTO', 'CompanyDto.businessNumber');
    const fromCode = evidence.add({
      type: 'STATIC_SOURCE',
      source: 'company.component.ts:12',
      confidence: 1,
      details: {},
    });
    let edge = graph.relate(field, 'MAPS_TO', dto, fromCode);
    expect(edge.provenance).toMatchObject({
      runtimeConfirmed: false,
      observationCount: 1,
      sources: ['STATIC_SOURCE'],
    });
    // Le code seul reste plafonné : il suggère, il ne confirme pas.
    expect(edge.provenance.confidence).toBeLessThanOrEqual(0.8);
    edge = graph.relate(field, 'MAPS_TO', dto, runtime(evidence, 'POST /api/company 201'));
    expect(edge.provenance).toMatchObject({ runtimeConfirmed: true, observationCount: 2, version: 'v42' });
    expect(edge.provenance.sources).toEqual(['STATIC_SOURCE', 'RUNTIME']);
    expect(graph.explain(field.id)[0]).toMatch(/MAPS_TO .*STATIC_SOURCE\+RUNTIME.*runtime confirmed/);
  });

  it('the same evidence is never counted twice; ids carry the run', () => {
    const evidence = store();
    const a = runtime(evidence, 'x');
    const b = runtime(evidence, 'x');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('E-t-1');
  });
});

describe('Lot B — FunctionalModel and BusinessStateEngine (§6–§9, §89)', () => {
  const model = new FunctionalModelBuilder()
    .addFlow(FLOW)
    .choice('Currency', 'EUR')
    .choice('Currency', 'CAD')
    .build();

  it('the demonstrated journey becomes capabilities, phases, choices and a submission', () => {
    expect(model.mission?.id).toBe('CREATE_REQUEST');
    expect(model.phases).toEqual([
      expect.objectContaining({
        id: 'COMPANY_INFORMATION',
        fields: ['Company name', 'Business number'],
        opener: { role: 'button', label: 'Company information' },
      }),
    ]);
    expect(model.capabilities.map((capability) => capability.id)).toEqual([
      'CREATE_REQUEST',
      'SELECT_EUR',
      'ENTER_COMPANY_INFORMATION',
      'SUBMIT_CREATE_REQUEST',
    ]);
    expect(model.submit).toEqual({ label: 'Submit', role: 'button' });
  });

  it('§89: EUR selected, company fields visible, business number empty, submit disabled → INCOMPLETE and BLOCKED', () => {
    const evidence = store();
    const engine = new BusinessStateEngine(
      model,
      (input) => evidence.add(input),
      () => NOW,
    );
    const screen: ScreenObservation = {
      route: '/request/create',
      fields: [
        {
          label: 'Company name',
          visible: true,
          hasValue: true,
          required: true,
          invalid: false,
          disabled: false,
        },
        {
          label: 'Business number',
          visible: true,
          hasValue: false,
          required: true,
          invalid: false,
          disabled: false,
        },
      ],
      choices: [
        { label: 'EUR', checked: true, kind: 'radio' },
        { label: 'CAD', checked: false, kind: 'radio' },
      ],
      buttons: [{ label: 'Submit', enabled: false, submit: true }],
      tabs: [],
      alerts: [],
      busy: false,
    };
    const { situation, state } = engine.evaluate(screen);
    expect(situation).toMatchObject({
      mission: 'CREATE_REQUEST',
      phase: 'COMPANY_INFORMATION',
      submission: 'BLOCKED',
      missing: ['Business number'],
    });
    expect(situation.facts).toEqual([expect.objectContaining({ name: 'Currency', value: 'EUR' })]);
    expect(situation.phases).toEqual([
      { phase: 'COMPANY_INFORMATION', status: 'INCOMPLETE', missing: ['Business number'], invalid: [] },
    ]);
    expect(describeSituation(situation)).toBe(
      'mission CREATE_REQUEST · phase COMPANY_INFORMATION · Currency=EUR · COMPANY_INFORMATION INCOMPLETE (missing: Business number) · submission BLOCKED',
    );
    expect(state.blockedGoals.map((goal) => goal.goal)).toEqual([
      'COMPANY_INFORMATION_COMPLETE',
      'SUBMIT_CREATE_REQUEST',
    ]);
    expect(state.capabilities).toContainEqual({ id: 'SUBMIT_CREATE_REQUEST', status: 'BLOCKED' });
    // Chaque fait porte une preuve DOM.
    expect(situation.evidence.every((reference) => reference.type === 'DOM')).toBe(true);
  });

  it('fields not on screen: the phase is UNAVAILABLE (not "incomplete")', () => {
    const engine = new BusinessStateEngine(
      model,
      (input) => store().add(input),
      () => NOW,
    );
    const { situation } = engine.evaluate({
      route: '/',
      fields: [],
      choices: [],
      buttons: [],
      tabs: [],
      alerts: [],
      busy: false,
    });
    expect(situation.phases[0]?.status).toBe('UNAVAILABLE');
    expect(situation.submission).toBe('NOT_VISIBLE');
  });
});

describe('Lot C — HypothesisEngine and CausalKnowledgeGraph (§10–§16, §91, §92, §104)', () => {
  const setup = (version?: string) => {
    const evidence = store();
    const hypotheses = new HypothesisEngine({
      runtimeObservationsToConfirm: 2,
      now: () => NOW,
      ...(version ? { version } : {}),
    });
    const graph = new EvidenceGraph({ now: () => NOW });
    return { evidence, hypotheses, causal: new CausalKnowledgeGraph(hypotheses, graph), graph };
  };
  const EUR = { kind: 'CONDITION' as const, label: 'EUR_SELECTED' };
  const COMPANY = { kind: 'STATE' as const, label: 'COMPANY_INFORMATION_VISIBLE' };

  it('§91: one observation is a HYPOTHESIS, never a confirmed causal relation', () => {
    const { evidence, causal } = setup();
    const hypothesis = causal.observe(EUR, 'REVEALS', COMPANY, runtime(evidence, 'run#1 click EUR'));
    expect(hypothesis.status).toBe('HYPOTHESIS');
    expect(causal.confirmed()).toEqual([]);
  });

  it('§92: static source + several runtime observations → RUNTIME_CONFIRMED', () => {
    const { evidence, causal, graph } = setup();
    causal.observe(EUR, 'REVEALS', COMPANY, runtime(evidence, 'run#1'));
    expect(causal.observe(EUR, 'REVEALS', COMPANY, runtime(evidence, 'run#2')).status).toBe('SUPPORTED');
    const confirmed = causal.observe(
      EUR,
      'REVEALS',
      COMPANY,
      evidence.add({
        type: 'STATIC_SOURCE',
        source: 'request.component.html:40 *ngIf currency',
        confidence: 0.9,
        details: {},
      }),
    );
    expect(confirmed.status).toBe('RUNTIME_CONFIRMED');
    expect(causal.confirmed()).toHaveLength(1);
    expect(graph.allEdges()[0]?.provenance).toMatchObject({ runtimeConfirmed: true, observationCount: 3 });
  });

  it('runtime contradictions are recorded, lower confidence, and reject a relation never observed', () => {
    const { evidence, causal, hypotheses } = setup();
    causal.observe(
      EUR,
      'REVEALS',
      COMPANY,
      evidence.add({ type: 'STATIC_SOURCE', source: 'code', confidence: 0.9, details: {} }),
    );
    const contradicted = causal.refute(
      'EUR_SELECTED',
      'REVEALS',
      'COMPANY_INFORMATION_VISIBLE',
      runtime(evidence, 'run#3 no effect'),
    );
    expect(contradicted?.status).toBe('CONTRADICTED');
    causal.refute(
      'EUR_SELECTED',
      'REVEALS',
      'COMPANY_INFORMATION_VISIBLE',
      runtime(evidence, 'run#4 no effect'),
    );
    expect(hypotheses.all()[0]?.status).toBe('REJECTED');
    expect(hypotheses.all()[0]?.evidenceAgainst).toHaveLength(2);
  });

  it('§104: an LLM assertion without evidence stays a HYPOTHESIS, whatever is repeated', () => {
    const { evidence, hypotheses } = setup();
    const proposition = {
      kind: 'BUSINESS_RULE' as const,
      subject: 'EUR',
      relation: 'REQUIRES',
      object: 'Business number',
    };
    hypotheses.propose(
      proposition,
      evidence.add({ type: 'LLM_PROPOSAL', source: 'advisor #1', confidence: 1, details: {} }),
    );
    const again = hypotheses.propose(
      proposition,
      evidence.add({ type: 'LLM_PROPOSAL', source: 'advisor #2', confidence: 1, details: {} }),
    );
    expect(again.status).toBe('HYPOTHESIS');
    expect(again.confidence).toBeLessThanOrEqual(0.3);
  });

  it('knowledge confirmed on another version becomes STALE until the runtime sees it again', () => {
    const { evidence, causal } = setup();
    for (const run of ['a', 'b'])
      causal.observe(EUR, 'REVEALS', COMPANY, runtime(evidence, `run ${run}`, { applicationVersion: 'v1' }));
    causal.observe(
      EUR,
      'REVEALS',
      COMPANY,
      evidence.add({ type: 'HUMAN_RECORDING', source: 'flow', confidence: 0.9, details: {} }),
    );
    const saved = setup('v2');
    saved.hypotheses.restore(
      causal.links().map((link) => link.hypothesis),
      evidence.all(),
    );
    expect(saved.hypotheses.all()[0]?.status).toBe('STALE');
  });

  it('learns causal hypotheses from what an action changed (appeared, enabled, route, request)', () => {
    const { evidence, causal } = setup();
    const learned = causal.learnFromAction(
      {
        action: 'check EUR',
        appeared: ['button:company information'],
        disappeared: [],
        enabled: ['button:submit'],
        disabled: [],
        route: '/request/2',
        requests: ['GET /api/rates'],
      },
      runtime(evidence, 'flow step 1'),
    );
    expect(learned.map((hypothesis) => hypothesis.proposition.relation)).toEqual([
      'REVEALS',
      'ENABLES',
      'NAVIGATES_TO',
      'TRIGGERS',
    ]);
    expect(causal.causesOf('button:company information')[0]?.cause).toBe('check EUR');
  });
});
