import { describe, expect, it } from 'vitest';
import type { FlowConfig } from '../../src/config/flow-schema.js';
import { BusinessStateEngine, type ScreenObservation } from '../../src/cognitive/business-state-engine.js';
import { CausalKnowledgeGraph } from '../../src/cognitive/causal-graph.js';
import { EvidenceStore } from '../../src/cognitive/evidence.js';
import { EvidenceGraph } from '../../src/cognitive/evidence-graph.js';
import { FunctionalModelBuilder } from '../../src/cognitive/functional-model.js';
import { buildGoalGraph, describeChain, resolvePreconditions } from '../../src/cognitive/goal-graph.js';
import { HypothesisEngine } from '../../src/cognitive/hypothesis-engine.js';
import {
  checkpointsOf,
  describePlan,
  evaluateCheckpoint,
  planGoal,
  recordedPlan,
  repairPlan,
} from '../../src/cognitive/planning.js';

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

function setup() {
  const evidence = new EvidenceStore('E-t');
  const hypotheses = new HypothesisEngine({ runtimeObservationsToConfirm: 2, now: () => NOW });
  const causal = new CausalKnowledgeGraph(hypotheses, new EvidenceGraph({ now: () => NOW }));
  // L'humain a montré : cocher EUR révèle « Company information ».
  causal.observe(
    { kind: 'ACTION', label: 'check eur' },
    'REVEALS',
    { kind: 'CONTROL', label: 'button:company information' },
    evidence.add({ type: 'HUMAN_RECORDING', source: 'flow', confidence: 0.9, details: {} }),
  );
  const model = new FunctionalModelBuilder().addFlow(FLOW).build();
  const states = new BusinessStateEngine(
    model,
    (input) => evidence.add(input),
    () => NOW,
  );
  return { evidence, causal, model, states, graph: buildGoalGraph(model, causal) };
}

const screen = (overrides: Partial<ScreenObservation>): ScreenObservation => ({
  route: '/request',
  fields: [],
  choices: [],
  buttons: [],
  tabs: [],
  alerts: [],
  busy: false,
  ...overrides,
});
const field = (label: string, hasValue: boolean) => ({
  label,
  visible: true,
  hasValue,
  required: true,
  invalid: false,
  disabled: false,
});

describe('Lot D — GoalGraph and PreconditionResolver (§23–§28)', () => {
  it('the mission becomes a goal graph: done ← ready ← phase complete ← available / fields valid; the opener requires the choice', () => {
    const { graph } = setup();
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(graph.root).toBe('CREATE_REQUEST_DONE');
    expect(byId.get('CREATE_REQUEST_DONE')?.requires).toEqual(['CREATE_REQUEST_READY']);
    expect(byId.get('CREATE_REQUEST_READY')?.requires).toEqual([
      'EUR_SELECTED',
      'COMPANY_INFORMATION_COMPLETE',
    ]);
    expect(byId.get('COMPANY_INFORMATION_COMPLETE')?.requires).toEqual([
      'COMPANY_INFORMATION_AVAILABLE',
      'COMPANY_NAME_VALID',
      'BUSINESS_NUMBER_VALID',
    ]);
    // Appris du graphe causal : l'ouvreur n'apparaît qu'une fois EUR choisi.
    expect(byId.get('COMPANY_INFORMATION_AVAILABLE')?.requires).toEqual([
      'COMPANY_INFORMATION_CONTROL_AVAILABLE',
    ]);
    expect(byId.get('COMPANY_INFORMATION_CONTROL_AVAILABLE')?.requires).toEqual(['EUR_SELECTED']);
  });

  it('§90: submit blocked → WHY? SUBMIT ← READY ← COMPANY_INFORMATION_COMPLETE ← BUSINESS_NUMBER_VALID, with the action to take', () => {
    const { graph, states } = setup();
    const { situation } = states.evaluate(
      screen({
        fields: [field('Company name', true), field('Business number', false)],
        choices: [{ label: 'EUR', checked: true, kind: 'checkbox' }],
        buttons: [{ label: 'Submit', enabled: false, submit: true }],
      }),
    );
    const resolution = resolvePreconditions(graph, 'CREATE_REQUEST_DONE', { situation });
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.chains.map(describeChain)).toEqual([
      'CREATE_REQUEST_DONE ← CREATE_REQUEST_READY ← COMPANY_INFORMATION_COMPLETE ← BUSINESS_NUMBER_VALID',
    ]);
    expect(resolution.missingPreconditions.map((node) => node.id)).toEqual(['BUSINESS_NUMBER_VALID']);
    expect(resolution.candidateActions).toEqual([
      expect.objectContaining({ kind: 'fill', label: 'Business number' }),
    ]);
    expect(resolution.supportingEvidence.length).toBeGreaterThan(0);
  });

  it('nothing chosen yet: the deepest missing precondition is the choice, then the section', () => {
    const { graph, states } = setup();
    const { situation } = states.evaluate(
      screen({ choices: [{ label: 'EUR', checked: false, kind: 'checkbox' }] }),
    );
    const resolution = resolvePreconditions(graph, 'CREATE_REQUEST_DONE', { situation, controls: new Set() });
    expect(resolution.missingPreconditions.map((node) => node.id)).toContain('EUR_SELECTED');
    expect(resolution.chains.map(describeChain)).toContain(
      'CREATE_REQUEST_DONE ← CREATE_REQUEST_READY ← EUR_SELECTED',
    );
  });
});

describe('Lot E — PlanEngine, SemanticCheckpoint, PlanRepairEngine (§29–§37)', () => {
  it('the current plan goes from the deepest missing condition to the goal, and lists what it only assumes', () => {
    const { graph, states } = setup();
    const { situation } = states.evaluate(screen({}));
    const plan = planGoal(graph, 'CREATE_REQUEST_DONE', { situation, controls: new Set() });
    expect(describePlan(plan)).toBe(
      'check "EUR" → click button "Company information" → fill "Company name" → fill "Business number" → click button "Submit"',
    );
    expect(plan.steps.at(-1)).toMatchObject({ writes: true, intent: 'CREATE_REQUEST_DONE' });
    expect(plan.checkpoints).toEqual([
      'COMPANY_INFORMATION_COMPLETE',
      'CREATE_REQUEST_READY',
      'CREATE_REQUEST_DONE',
    ]);
    expect(plan.kind).toBe('CURRENT_PLAN');
  });

  it('§97: a restructured UI that reaches the same business state reaches the same checkpoint (not the URL)', () => {
    const { graph, states } = setup();
    const [checkpoint] = checkpointsOf(graph).filter(
      (candidate) => candidate.id === 'COMPANY_INFORMATION_COMPLETE',
    );
    if (!checkpoint) throw new Error('no checkpoint');
    // V1 : bouton « Company information » ; V2 : un onglet « Company », une autre route.
    for (const [route, tabs] of [
      ['/request/step/3', []],
      ['/company', [{ label: 'Company', selected: true }]],
    ] as const) {
      const { situation } = states.evaluate(
        screen({
          route,
          tabs: [...tabs],
          fields: [field('Company name', true), field('Business number', true)],
        }),
      );
      expect(evaluateCheckpoint(checkpoint, graph, { situation }, NOW).status, route).toBe('CONFIRMED');
    }
    // La même URL sans les champs remplis : pas confirmé.
    const { situation } = states.evaluate(
      screen({
        route: '/request/step/3',
        fields: [field('Company name', true), field('Business number', false)],
      }),
    );
    expect(evaluateCheckpoint(checkpoint, graph, { situation }, NOW).status).toBe('PARTIAL');
  });

  it('§96: A → B → C → D becomes A → B → X → D; the recorded plan is unchanged', () => {
    const { graph } = setup();
    const recorded = recordedPlan(FLOW, graph.mission ?? '', graph.root ?? '');
    const before = JSON.stringify(recorded);
    const result = repairPlan(
      recorded,
      [
        {
          originalIndex: 1,
          reason: 'TARGET_REPLACED: goal confirmed at runtime',
          replacement: [
            {
              kind: 'click',
              role: 'tab',
              label: 'Company',
              intent: 'COMPANY_INFORMATION_AVAILABLE',
              source: 'RECOVERY',
              expectedEffects: [],
            },
          ],
        },
      ],
      () => ({ allowed: true, reason: 'SAFE' }),
    );
    expect(result.status).toBe('REPAIRED');
    expect(describePlan(result.recovered ?? recorded)).toBe(
      'check "EUR" → click tab "Company" → fill "Company name" → fill "Business number" → click button "Submit"',
    );
    expect(result.suggested?.kind).toBe('SUGGESTED_PLAN');
    expect(JSON.stringify(recorded)).toBe(before);
  });

  it('§34: a repair whose new step the SafetyPolicy refuses (or that would write) produces no plan', () => {
    const { graph } = setup();
    const recorded = recordedPlan(FLOW, graph.mission ?? '', graph.root ?? '');
    const unsafe = repairPlan(
      recorded,
      [
        {
          originalIndex: 1,
          reason: 'x',
          replacement: [
            { kind: 'click', label: 'Delete company', intent: 'x', source: 'RECOVERY', expectedEffects: [] },
          ],
        },
      ],
      (action) =>
        /delete/i.test(action.label)
          ? { allowed: false, reason: 'DANGEROUS' }
          : { allowed: true, reason: 'SAFE' },
    );
    expect(unsafe).toMatchObject({
      status: 'UNSAFE',
      rejected: [{ label: 'Delete company', reason: 'DANGEROUS' }],
    });
    expect(unsafe.recovered).toBeUndefined();
    const writing = repairPlan(
      recorded,
      [
        {
          originalIndex: 1,
          reason: 'x',
          replacement: [
            {
              kind: 'click',
              label: 'Save',
              intent: 'x',
              source: 'RECOVERY',
              expectedEffects: [],
              writes: true,
            },
          ],
        },
      ],
      () => ({ allowed: true, reason: 'SAFE' }),
    );
    expect(writing.status).toBe('UNSAFE');
  });
});
