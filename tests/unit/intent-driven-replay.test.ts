import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import { deriveCheckpoints, evaluateCheckpoint } from '../../src/replay/checkpoints.js';
import { replayConfidence } from '../../src/replay/confidence.js';
import type { ObservedFunctionalState } from '../../src/replay/model.js';
import { planReplayAction } from '../../src/replay/planner.js';
import {
  checkPreconditions,
  deriveDependencies,
  derivePreconditions,
  explainUnmetPrecondition,
} from '../../src/replay/preconditions.js';
import { historicalResolutions, resolutionKeyOf, routeKey } from '../../src/replay/resolution-memory.js';
import { ReplayStateMachine } from '../../src/replay/state-machine.js';
import type { ScreenControl } from '../../src/workflow-healing/model.js';

/** search → pick in the list → open → edit → save : le parcours de référence (effets et intentions enregistrés). */
const STEPS: FlowStep[] = [
  { kind: 'goto', url: '/items', allow: [], optional: false },
  {
    kind: 'fill',
    target: { strategy: 'label', value: 'Name' },
    value: 'alpha',
    allow: [],
    optional: false,
    functionalIntent: { name: 'ENTER_VALUE', status: 'CONFIRMED', confidence: 0.95, ui: 'ENTER_VALUE' },
  },
  {
    kind: 'click',
    target: { strategy: 'role', role: 'button', name: 'Search' },
    allow: [],
    optional: false,
    effects: { appears: ['link:Item 42'], request: 'GET /api/items' },
    functionalIntent: {
      name: 'SEARCH_ITEM',
      status: 'PROBABLE',
      confidence: 0.78,
      ui: 'SEARCH',
      operation: 'SEARCH',
      entity: 'item',
    },
  },
  {
    kind: 'click',
    target: { strategy: 'role', role: 'link', name: 'Item 42' },
    allow: [],
    optional: false,
    effects: { route: '/items/{id}', appears: ['button:Edit'] },
    functionalIntent: {
      name: 'OPEN_ITEM',
      status: 'CONFIRMED',
      confidence: 0.93,
      ui: 'OPEN_ITEM',
      operation: 'OPEN',
      entity: 'item',
    },
  },
  {
    kind: 'click',
    target: { strategy: 'role', role: 'button', name: 'Edit' },
    allow: [],
    optional: false,
    effects: { appears: ['textbox:Description', 'button:Save'] },
    functionalIntent: { name: 'OPEN_DIALOG', status: 'CONFIRMED', confidence: 0.97, ui: 'OPEN_DIALOG' },
  },
  {
    kind: 'fill',
    target: { strategy: 'label', value: 'Description' },
    value: 'updated',
    allow: [],
    optional: false,
    fingerprint: { role: 'textbox', dialog: 'Edit item' },
  },
  {
    kind: 'click',
    target: { strategy: 'role', role: 'button', name: 'Save' },
    allow: ['MUTATION'],
    optional: false,
    effects: { request: 'PUT /api/items/{id}' },
    functionalIntent: {
      name: 'SAVE_ITEM',
      status: 'CONFIRMED',
      confidence: 0.88,
      ui: 'SAVE',
      operation: 'SAVE',
      entity: 'item',
    },
  },
  { kind: 'expect', expect: { text: 'Saved' }, allow: [], optional: false },
];

const observed = (overrides: Partial<ObservedFunctionalState> = {}): ObservedFunctionalState => ({
  route: '/items',
  controls: ['button:Search', 'textbox:Name'],
  enabledControls: ['button:Search', 'textbox:Name'],
  fields: ['Name'],
  requests: [],
  text: '',
  ...overrides,
});

describe('Functional checkpoints', () => {
  it('derives one checkpoint per step that promises an observable state, named after the intention', () => {
    const checkpoints = deriveCheckpoints(STEPS);
    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'CP1_GOTO_ITEM',
      'CP2_ENTER_VALUE',
      'CP3_SEARCH_ITEM',
      'CP4_OPEN_ITEM',
      'CP5_OPEN_DIALOG',
      'CP6_FILL_DESCRIPTION',
      'CP7_SAVE_ITEM',
      'CP8_EXPECT_SAVED',
    ]);
    const search = checkpoints.find((checkpoint) => checkpoint.id === 'CP3_SEARCH_ITEM');
    expect(search?.strength).toBe('STRONG');
    expect(search?.source).toEqual(
      expect.arrayContaining(['EXPECTED_EFFECTS', 'FUNCTIONAL_INTENT', 'NEXT_ACTION']),
    );
    expect(search?.predicates.map((predicate) => predicate.kind)).toEqual(
      expect.arrayContaining(['VISIBLE_CONTROL', 'REQUEST', 'CONTROL_AVAILABLE']),
    );
    // Un checkpoint porté seulement par la cible de l'étape suivante est FAIBLE : il n'arrête jamais le parcours.
    expect(checkpoints.find((checkpoint) => checkpoint.id === 'CP2_ENTER_VALUE')?.strength).toBe('WEAK');
    expect(checkpoints.find((checkpoint) => checkpoint.id === 'CP8_EXPECT_SAVED')?.strength).toBe('STRONG');
  });

  it('confirms, fails or stays inconclusive from the observed state (controls, route, requests, text)', () => {
    const [, , search, open, , , , saved] = deriveCheckpoints(STEPS);
    if (!search || !open || !saved) throw new Error('checkpoints missing');
    expect(
      evaluateCheckpoint(
        search,
        observed({
          controls: ['button:Search', 'link:Item 42'],
          enabledControls: ['button:Search', 'link:Item 42'],
          requests: ['GET /api/items 200'],
        }),
      ),
    ).toMatchObject({ status: 'CONFIRMED', progress: 1 });
    // Résultats absents, aucune requête : la recherche n'a pas vraiment eu lieu.
    expect(evaluateCheckpoint(search, observed({ requests: [] }))).toMatchObject({
      status: 'FAILED',
      progress: 0,
    });
    expect(evaluateCheckpoint(search, observed({ controls: ['link:Item 42'], requests: [] })).status).toBe(
      'INCONCLUSIVE',
    );
    expect(
      evaluateCheckpoint(
        open,
        observed({ route: '/items/42', controls: ['button:Edit'], enabledControls: ['button:Edit'] }),
      ),
    ).toMatchObject({ status: 'CONFIRMED' });
    expect(evaluateCheckpoint(saved, observed({ text: 'Item saved successfully' })).status).toBe('CONFIRMED');
    expect(evaluateCheckpoint(saved, undefined).status).toBe('INCONCLUSIVE');
  });
});

describe('Replay state machine', () => {
  it('keeps the functional position: confirmed checkpoints, last committed action, divergence window', () => {
    const machine = new ReplayStateMachine(
      'find-item',
      STEPS,
      deriveCheckpoints(STEPS),
      deriveDependencies(STEPS),
    );
    machine.beginStep(1);
    machine.observe(1, observed());
    machine.commit(1, {
      preconditions: 'NOT_CHECKED',
      execution: 'SUCCESS',
      target: 'NOT_VERIFIED',
      effect: 'NOT_VERIFIED',
      functionalState: 'SUCCESS',
      outcome: 'COMMITTED',
    });
    machine.beginStep(2);
    machine.observe(2, observed());
    machine.commit(2, {
      preconditions: 'SATISFIED',
      execution: 'SUCCESS',
      target: 'CORRECT',
      effect: 'SUCCESS',
      functionalState: 'SUCCESS',
      outcome: 'COMMITTED',
    });
    const position = machine.beginStep(3);
    expect(position).toMatchObject({
      stepIndex: 3,
      lastConfirmedAction: 2,
      currentIntent: { name: 'SEARCH_ITEM' },
      nextCheckpoint: 'CP3_SEARCH_ITEM',
    });
    expect(position.confirmedCheckpoints).toEqual(['CP1_GOTO_ITEM', 'CP2_ENTER_VALUE']);
    // La recherche n'a produit ni résultats ni requête : CP3 manque ; l'étape 4 échoue ensuite.
    const results = machine.observe(3, observed({ requests: [] }));
    expect(results[0]?.status).toBe('FAILED');
    machine.commit(3, {
      preconditions: 'SATISFIED',
      execution: 'SUCCESS',
      target: 'CORRECT',
      effect: 'FAILED',
      functionalState: 'DIVERGED',
      outcome: 'ROLLED_BACK',
    });
    machine.beginStep(4);
    const divergence = machine.diverge(4, 'link "Item 42" not found', 3);
    expect(divergence).toMatchObject({
      stepIndex: 4,
      rootStep: 3,
      window: { from: 'CP2_ENTER_VALUE', to: 'CP3_SEARCH_ITEM' },
    });
    expect(machine.snapshot().divergence?.reasons.join(' ')).toMatch(
      /first missing checkpoint CP3_SEARCH_ITEM/,
    );
    expect(machine.lastConfirmedBefore(4)?.id).toBe('CP2_ENTER_VALUE');
    expect(machine.isCommitted(3)).toBe(false);
  });
});

describe('Preconditions and dependencies', () => {
  it('links a submit to the fields it submits, a target to the step that revealed it, a dialog field to its opener', () => {
    const dependencies = deriveDependencies(STEPS);
    const of = (step: number): string[] =>
      dependencies
        .filter((dependency) => dependency.step === step)
        .map((dependency) => `${dependency.kind}:${String(dependency.requires)}`);
    expect(of(3)).toEqual(expect.arrayContaining(['FILLS_FIELD:2', 'REACHES_ROUTE:1']));
    expect(of(4)).toEqual(expect.arrayContaining(['REVEALS_TARGET:3']));
    expect(of(5)).toEqual(expect.arrayContaining(['REVEALS_TARGET:4']));
    expect(of(6)).toEqual(expect.arrayContaining(['OPENS_DIALOG:5']));
    expect(of(7)).toEqual(expect.arrayContaining(['FILLS_FIELD:6', 'REVEALS_TARGET:5']));
  });

  it('derives what a click requires before it runs, and reads it against the screen without any value', () => {
    const dependencies = deriveDependencies(STEPS);
    const checkpoints = deriveCheckpoints(STEPS);
    const preconditions = derivePreconditions(STEPS, 3, dependencies, checkpoints);
    expect(preconditions.map((precondition) => `${precondition.kind}:${precondition.severity}`)).toEqual(
      expect.arrayContaining([
        'TARGET_PRESENT:HARD',
        'TARGET_ENABLED:SOFT',
        'NO_OVERLAY:SOFT',
        'FIELD_FILLED:HARD',
        'ROUTE:SOFT',
      ]),
    );
    // Le dernier checkpoint FORT précédent (la recherche) est une précondition de l'ouverture.
    expect(
      derivePreconditions(STEPS, 4, dependencies, checkpoints).find(
        (precondition) => precondition.kind === 'CHECKPOINT',
      ),
    ).toMatchObject({ value: 'CP3_SEARCH_ITEM', severity: 'SOFT', establishedBy: 3 });
    const held = checkPreconditions(preconditions, observed({ filledHeld: ['Name'] }), ['CP1_GOTO_ITEM']);
    expect(held.every((check) => check.satisfied !== false)).toBe(true);
    const lost = checkPreconditions(
      preconditions,
      observed({ filledLost: ['Name'], overlay: 'Loading' }),
      [],
    );
    expect(lost.filter((check) => check.satisfied === false).map((check) => check.precondition.kind)).toEqual(
      expect.arrayContaining(['FIELD_FILLED', 'NO_OVERLAY']),
    );
    expect(lost.find((check) => check.precondition.kind === 'FIELD_FILLED')?.detail).toMatch(
      /no longer in the field/,
    );
  });

  it('explains an unmet precondition by walking the dependency chain to the root step', () => {
    const dependencies = deriveDependencies(STEPS);
    const preconditions = derivePreconditions(STEPS, 4, dependencies, deriveCheckpoints(STEPS));
    const [check] = checkPreconditions(preconditions, observed({ controls: ['button:Search'] }));
    if (!check) throw new Error('no precondition');
    // L'étape 3 (la recherche) n'a pas tenu son checkpoint ; l'étape 2 (la saisie) l'a tenu.
    const explanation = explainUnmetPrecondition(check, 4, STEPS, dependencies, (step) =>
      step === 3 ? false : step === 2 ? true : undefined,
    );
    expect(explanation.rootStep).toBe(3);
    expect(explanation.chain.map((link) => link.step)).toEqual([4, 3, 2]);
    expect(explanation.reasons.join(' ')).toMatch(/root step 3: click "Search"/);
  });
});

describe('Replay planner', () => {
  const controls: ScreenControl[] = [
    { role: 'button', name: 'Run search', visible: true, disabled: false },
    { role: 'button', name: 'Cancel', visible: true, disabled: false },
    { role: 'textbox', name: 'Name', visible: true, disabled: false, field: true },
    { role: 'button', name: 'Delete', visible: true, disabled: false },
  ];
  const original = { kind: 'click', role: 'button', label: 'Search' };
  const intent = STEPS[2]?.functionalIntent;

  it('takes the recorded target when it is on screen, nothing else', () => {
    const plan = planReplayAction({
      original,
      goal: 'SEARCH_ITEM',
      controls: [...controls, { role: 'button', name: 'Search', visible: true, disabled: false }],
    });
    expect(plan.choice).toBe('RECORDED');
    expect(plan.candidates).toHaveLength(1);
  });

  it('proposes a learned resolution first, then a semantic candidate that says the same intent; never a field, never a cancel', () => {
    const semantic = planReplayAction({
      original,
      ...(intent ? { intent } : {}),
      goal: 'SEARCH_ITEM',
      controls,
    });
    expect(semantic.choice).toBe('SEMANTIC');
    expect(semantic.selected).toMatchObject({ role: 'button', name: 'Run search' });
    expect(semantic.candidates.map((candidate) => candidate.name)).not.toContain('Name');
    expect(semantic.candidates.find((candidate) => candidate.name === 'Cancel')?.score ?? 0).toBeLessThan(
      0.3,
    );
    const historical = planReplayAction({
      original,
      ...(intent ? { intent } : {}),
      goal: 'SEARCH_ITEM',
      controls,
      historical: {
        candidates: [
          { role: 'button', name: 'Run search', source: 'HISTORICAL', score: 0.8, reasons: ['learned'] },
        ],
        avoid: [],
      },
    });
    expect(historical.choice).toBe('HISTORICAL');
    expect(historical.selected?.reasons.join(' ')).toMatch(/learned/);
  });

  it('stops on ambiguity instead of choosing arbitrarily, and avoids resolutions that failed twice', () => {
    const twins: ScreenControl[] = [
      { role: 'button', name: 'Search items', visible: true, disabled: false },
      { role: 'button', name: 'Search people', visible: true, disabled: false },
    ];
    const plan = planReplayAction({ original, goal: 'SEARCH_ITEM', controls: twins });
    expect(plan.choice).toBe('NONE');
    expect(plan.ambiguous).toBe(true);
    const avoided = planReplayAction({
      original,
      goal: 'SEARCH_ITEM',
      controls,
      historical: { candidates: [], avoid: ['button:Run search'] },
    });
    expect(avoided.candidates.map((candidate) => candidate.name)).not.toContain('Run search');
  });
});

describe('Replay confidence', () => {
  const satisfied = checkPreconditions(
    derivePreconditions(STEPS, 3, deriveDependencies(STEPS)),
    observed({ filledHeld: ['Name'] }),
  );
  it('combines target, intent, preconditions, effect and state; a weak dimension pulls everything down', () => {
    const good = replayConfidence({
      targetScore: 0.98,
      targetVerdict: 'CORRECT',
      intent: { confidence: 0.95, status: 'CONFIRMED' },
      preconditions: satisfied,
      effect: { status: 'CONFIRMED' },
      checkpoints: [{ status: 'CONFIRMED', progress: 1 }],
    });
    expect(good.overall).toBeGreaterThanOrEqual(0.9);
    expect(good.continueSilently).toBe(true);
    const doubtful = replayConfidence({
      targetScore: 0.92,
      targetVerdict: 'CORRECT',
      intent: { confidence: 0.54, status: 'AMBIGUOUS' },
      preconditions: satisfied,
      effect: { status: 'NO_EFFECT' },
      checkpoints: [{ status: 'FAILED', progress: 0 }],
    });
    expect(doubtful.overall).toBeLessThan(0.4);
    expect(doubtful.continueSilently).toBe(false);
    expect(doubtful.reasons.join(' ')).toMatch(/no effect observed/);
    // Un clic réussi avec un effet manquant n'est jamais un succès : l'exécution ne compte pas seule.
    const executedOnly = replayConfidence({
      targetVerdict: 'CORRECT',
      preconditions: [],
      effect: { status: 'NO_EFFECT' },
      checkpoints: [],
    });
    expect(executedOnly.continueSilently).toBe(false);
  });
});

describe('Resolution memory', () => {
  it('keys a resolution by action and screen (ids generalized), weighs successes, avoids repeated failures', () => {
    expect(routeKey('/items/42?tab=1')).toBe('/items/{id}');
    const key = resolutionKeyOf({ kind: 'click', role: 'button', label: 'Search' }, '/items/42');
    expect(key).toBe('click|button|search|/items/{id}');
    const kb = JsonKnowledgeBase.inMemory();
    const base = {
      key,
      original: 'Search',
      originalRole: 'button',
      kind: 'click',
      route: '/items/{id}',
      how: 'GOAL_RECOVERY',
    };
    kb.recordTargetResolution({
      ...base,
      resolved: { role: 'button', name: 'Run search' },
      result: 'SUCCESS',
      at: '2026-10-01T00:00:00.000Z',
    });
    kb.recordTargetResolution({
      ...base,
      resolved: { role: 'button', name: 'Run search' },
      result: 'SUCCESS',
      at: '2026-10-02T00:00:00.000Z',
    });
    kb.recordTargetResolution({
      ...base,
      resolved: { role: 'link', name: 'Search help' },
      result: 'FAILURE',
      at: '2026-10-02T00:00:00.000Z',
    });
    kb.recordTargetResolution({
      ...base,
      resolved: { role: 'link', name: 'Search help' },
      result: 'FAILURE',
      at: '2026-10-03T00:00:00.000Z',
    });
    const { candidates, avoid } = historicalResolutions(kb.targetResolutions(key), {
      now: '2026-10-04T00:00:00.000Z',
    });
    expect(candidates.map((candidate) => candidate.name)).toEqual(['Run search']);
    expect(candidates[0]?.score).toBeGreaterThan(0.2);
    expect(avoid).toEqual(['link:Search help']);
    expect(kb.targetResolutions('unknown')).toBeUndefined();
  });
});
