import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { EffectVerification } from '../../src/flows/action-effect-verifier.js';
import { analyzeWrongEffect } from '../../src/flows/wrong-effect-analyzer.js';
import { classifyEffects, expectedEffectsFrom } from '../../src/recording/effect-causality.js';
import { attributeEffects } from '../../src/recording/human-journey.js';
import type { RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';
import { futureEffectsOf, validateRecordingConsistency } from '../../src/recording/recording-consistency.js';

/**
 * TIME DOES NOT PROVE CAUSALITY : un effet observé APRÈS une action n'est pas forcément SON effet.
 * La prochaine action humaine est une frontière ; le réseau corrélé est plus fort que la proximité.
 */
const state = (id: string, route: string, controls: string[], observedAt?: number): RecordedState => ({
  id,
  stateId: id,
  label: route,
  route,
  url: `http://app.test${route}`,
  title: route,
  headings: [],
  alerts: [],
  invalidFields: 0,
  dialogs: [],
  controls,
  ...(observedAt !== undefined ? { observedAt } : {}),
});
const action = (id: string, extra: Partial<SemanticRecordedAction> = {}): SemanticRecordedAction => ({
  id,
  type: 'CLICK',
  rawEventIds: [`r-${id}`],
  at: 0,
  url: 'http://app.test/requests',
  network: [],
  provenance: 'HUMAN_RECORDED',
  confidence: 0.9,
  evidence: [],
  ...extra,
});
const NAV: NonNullable<SemanticRecordedAction['navigation']> = {
  routes: ['/process'],
  navigationIds: ['n1'],
  confidence: 'HIGH',
  score: 0.9,
  reasons: [],
  provenance: 'RUNTIME_OBSERVED',
};
const LIST = state('o1', '/requests', ['button:Filter', 'button:Apply']);
const FILTERED = state('o2', '/requests', ['button:Filter', 'button:Apply', 'button:Process request'], 300);
const PROCESS = state('o3', '/process', ['heading:Process', 'button:Back'], 1500);

describe('Causal effect attribution (recording)', () => {
  it('TEST 1 click → request → response → DOM update: everything belongs to the click (DIRECT request, STRONGLY screen)', () => {
    const apply = action('a9', {
      stateBefore: 'o1',
      stateAfter: 'o2',
      network: [{ method: 'GET', path: '/api/search', status: 200 }],
    });
    attributeEffects([apply], [LIST, FILTERED]);
    expect(apply.expectedEffects).toMatchObject({
      appears: ['button:Process request'],
      request: 'GET /api/search',
    });
    expect(apply.effectCausality?.map((candidate) => [candidate.effect, candidate.classification])).toEqual([
      ['+ button:Process request', 'STRONGLY_CORRELATED'],
      ['request GET /api/search', 'DIRECT'],
    ]);
    expect(apply.expectedEffects?.provenance?.actionId).toBe('a9');
  });

  it('TEST 2 / 4 / 9 click A → stable → click B → navigation: the navigation and its screen belong to B (separate observations)', () => {
    const apply = action('a9', { stateBefore: 'o1', stateAfter: 'o2' });
    const next = action('a10', {
      stateBefore: 'o2',
      stateAfter: 'o3',
      navigation: NAV,
    });
    attributeEffects([apply, next], [LIST, FILTERED, PROCESS]);
    expect(apply.expectedEffects?.route).toBeUndefined();
    expect(apply.expectedEffects?.appears).toEqual(['button:Process request']);
    expect(next.expectedEffects).toMatchObject({
      route: '/process',
      appears: ['heading:Process', 'button:Back'],
    });
    expect(next.effectCausality?.find((candidate) => candidate.kind === 'ROUTE')?.classification).toBe(
      'DIRECT',
    );
  });

  it("THE BUG: A and B share ONE observation (taken after B's navigation) — the screen goes to B, never to A (BELONGS_TO_NEXT_ACTION)", () => {
    const apply = action('a9', {
      stateBefore: 'o1',
      stateAfter: 'o3',
      network: [{ method: 'GET', path: '/api/search', status: 200 }],
    });
    const next = action('a10', { stateAfter: 'o3' });
    attributeEffects([apply, next], [LIST, PROCESS]);
    // Avant : le PREMIER geste (« Apply ») recevait route /process et les contrôles du nouvel écran.
    expect(apply.expectedEffects).toEqual({
      request: 'GET /api/search',
      provenance: {
        actionId: 'a9',
        effects: [{ effect: 'request GET /api/search', causality: 'DIRECT', confidence: 0.97 }],
      },
    });
    expect(
      apply.effectCausality
        ?.filter((candidate) => candidate.classification === 'BELONGS_TO_NEXT_ACTION')
        .map((candidate) => [candidate.effect, candidate.ownerActionId]),
    ).toEqual(
      [
        ['+ heading:Process', 'a10'],
        ['+ button:Back', 'a10'],
        ['- button:Filter', 'a10'],
        ['- button:Apply', 'a10'],
        ['route /process', 'a10'],
      ].filter(([effect]) => effect?.startsWith('+') || effect?.startsWith('route')),
    );
    expect(next.expectedEffects).toMatchObject({ route: '/process' });
  });

  it("TEST 3 click A → request A → click B → response A: the response stays A's (correlated by its network window)", () => {
    const apply = action('a9', {
      network: [{ method: 'GET', path: '/api/search', status: 200 }],
      observationClosedBy: 'r-a10',
    });
    const candidates = classifyEffects({
      action: apply,
      learned: { request: 'GET /api/search' },
      ownsScreen: true,
      screenShared: false,
      next: action('a10'),
    });
    expect(candidates[0]).toMatchObject({
      classification: 'DIRECT',
      ownerActionId: 'a9',
      correlationId: 'a9',
    });
  });

  it('TEST 5 / 6 a request never answered during the window: POSSIBLY_CORRELATED → optional, never required', () => {
    const apply = action('a9', { network: [{ method: 'GET', path: '/api/search' }] });
    const candidates = classifyEffects({
      action: apply,
      learned: { request: 'GET /api/search' },
      ownsScreen: true,
      screenShared: false,
    });
    expect(candidates[0]?.classification).toBe('POSSIBLY_CORRELATED');
    const effects = expectedEffectsFrom(apply, candidates);
    expect(effects?.request).toBeUndefined();
    expect(effects?.optional).toEqual(['request GET /api/search']);
  });

  it("a route that the correlation gives to the NEXT action is never this action's effect", () => {
    const next = action('a10', {
      navigation: NAV,
    });
    const candidates = classifyEffects({
      action: action('a9', { observationClosedBy: 'r-a10' }),
      learned: { route: '/process' },
      ownsScreen: true,
      screenShared: false,
      next,
    });
    expect(candidates[0]).toMatchObject({ classification: 'BELONGS_TO_NEXT_ACTION', ownerActionId: 'a10' });
  });
});

describe('Recording consistency validator', () => {
  it('TEST 7 a future-action effect: rejected and REPORTED (resolved), the action stays CLEAN; the timeline is ordered', () => {
    const apply = action('a9', {
      stateBefore: 'o1',
      stateAfter: 'o3',
      at: 1000,
      network: [{ method: 'GET', path: '/api/search', status: 200 }],
    });
    const next = action('a10', { stateAfter: 'o3', at: 2300 });
    attributeEffects([apply, next], [LIST, PROCESS]);
    const report = validateRecordingConsistency([apply, next], [LIST, PROCESS]);
    const a9 = report.actions.find((entry) => entry.actionId === 'a9');
    expect(a9?.status).toBe('CLEAN');
    expect(
      a9?.issues.some(
        (issue) =>
          issue.type === 'FUTURE_ACTION_EFFECT_CONTAMINATION' &&
          issue.resolved &&
          issue.probableOwner === 'a10',
      ),
    ).toBe(true);
    expect(report.timeline.map((entry) => entry.kind)).toEqual(['HUMAN', 'REQUEST', 'OBSERVATION', 'HUMAN']);
  });

  it('TEST 7 / 8 an OLD recording: a route owned by a later action, the same effect expected twice — CONTAMINATED / ownership conflict', () => {
    const apply = action('a9', { expectedEffects: { route: '/process', appears: ['button:Back'] } });
    const next = action('a10', {
      expectedEffects: { appears: ['button:Back'] },
      navigation: NAV,
    });
    const report = validateRecordingConsistency([apply, next]);
    const a9 = report.actions[0];
    expect(a9?.status).toBe('CONTAMINATED');
    expect(a9?.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(['ROUTE_OWNED_BY_ANOTHER_ACTION', 'OWNERSHIP_CONFLICT']),
    );
    expect(report.status).toBe('CONTAMINATED');
  });
});

describe('Replay defensive check: WrongEffectAnalyzer (root cause before recovery)', () => {
  const steps = (): FlowStep[] =>
    parseConfig(
      `mission: { name: unit }
target: { baseUrl: "http://app.test" }
flows:
  - name: Filter
    steps:
      - click: { role: button, name: Apply }
        effects: { appears: ["heading:Process", "button:Back"], route: /process }
      - click: { role: button, name: Process request }
      - click: { role: button, name: Back }
`,
      {},
      {},
    ).config.flows[0]?.steps ?? [];
  const failed: EffectVerification = {
    status: 'WRONG_EFFECT',
    expected: ['+ heading:Process', '+ button:Back', 'route /process'],
    observed: ['+ button:process request', 'request GET /api/search 200'],
    reasons: ['the screen changed, but not as during the recording'],
  };
  const base = {
    verification: failed,
    steps: steps(),
    index: 0,
    writes: [],
    requests: ['GET /api/search 200'],
    routeChanged: false,
    nextTargetAvailable: true,
  };

  it('TEST 10 / §15 every missing expectation describes a LATER step, the action worked, the journey can continue: RECORDED_EXPECTATION_CONTAMINATED (no recovery)', () => {
    const analysis = analyzeWrongEffect({ ...base, effects: base.steps[0]?.effects });
    expect(analysis.classification).toBe('RECORDED_EXPECTATION_CONTAMINATED');
    expect(analysis.suspectEffects).toEqual(['+ heading:Process', '+ button:Back', 'route /process']);
  });

  it('never masks a regression: a refused write, an unavailable next target, or a navigation proven at recording time', () => {
    expect(
      analyzeWrongEffect({
        ...base,
        effects: base.steps[0]?.effects,
        writes: [{ request: 'POST /api/filter', status: 500 }],
      }).classification,
    ).toBe('APPLICATION_REGRESSION');
    expect(
      analyzeWrongEffect({ ...base, effects: base.steps[0]?.effects, nextTargetAvailable: false })
        .classification,
    ).toBe('EXPECTED_EFFECT_CHANGED');
    const proven = {
      ...base.steps[0]?.effects,
      provenance: {
        actionId: 'a9',
        effects: [{ effect: 'route /process', causality: 'DIRECT', confidence: 0.97 }],
      },
    };
    expect(analyzeWrongEffect({ ...base, effects: proven }).classification).toBe('EXPECTED_EFFECT_CHANGED');
  });

  it('migration: an old step whose expected controls are targets of later steps is flagged (never rewritten)', () => {
    expect(futureEffectsOf(base.steps, 0)).toEqual(['button:Back']);
  });
});
