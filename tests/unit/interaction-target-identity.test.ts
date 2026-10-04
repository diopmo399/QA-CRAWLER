import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { verifyEffects } from '../../src/flows/action-effect-verifier.js';
import {
  buildTemporalContext,
  decide,
  functionalIdentityOf,
  scoreCandidates,
  type FunctionalCandidate,
} from '../../src/flows/functional-target.js';
import {
  actionContextFingerprintOf,
  interactionTargetIdentityOf,
} from '../../src/flows/interaction-target-identity.js';
import {
  expectationOf,
  TransitionTracker,
  type TransitionSample,
  type TransitionSettings,
  type TransitionWaitResult,
} from '../../src/observation/transition-waiter.js';
import { attributeEffects } from '../../src/recording/human-journey.js';
import type { RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';
import { analyzeDivergence } from '../../src/workflow-healing/divergence-analyzer.js';
import { analyzeExpectedTarget } from '../../src/workflow-healing/expected-target.js';
import { locateFirstFunctionalDivergence } from '../../src/workflow-healing/first-divergence.js';
import type { ScreenControl } from '../../src/workflow-healing/model.js';

/**
 * FOUND ELEMENT ≠ CORRECT ELEMENT. « Quel contrôle métier, dans quel contexte, pour quel état ? »
 * Tests A–O : chaque interaction (bouton, liste, case, onglet, accordéon, composant maison) est
 * identifiée par son propriétaire et son contexte, jamais par un CSS seul.
 */
const steps = (yaml: string): FlowStep[] =>
  parseConfig(
    `mission: { name: unit }\ntarget: { baseUrl: "http://app.test" }\nflows:\n  - name: F\n    steps:\n${yaml}`,
    {},
    {},
  ).config.flows[0]?.steps ?? [];

const candidate = (overrides: Partial<FunctionalCandidate> & { id: string }): FunctionalCandidate => ({
  tag: 'button',
  role: 'button',
  name: 'Apply',
  visible: true,
  enabled: true,
  editable: true,
  matchesRecordedLocator: true,
  nearText: [],
  stableAttributes: {},
  ...overrides,
});

/** Résout la cible de l'étape `at` parmi les candidats (le même moteur qu'au rejeu). */
const resolve = (flow: FlowStep[], at: number, candidates: FunctionalCandidate[]) => {
  const step = flow[at] as Extract<FlowStep, { target: unknown }>;
  const identity = functionalIdentityOf(step, flow, at);
  const ranked = scoreCandidates(identity, buildTemporalContext(flow, at, []), candidates);
  return { identity, ranked, decision: decide(ranked) };
};

describe('Context-aware target resolution (A, B, C, D, J, K)', () => {
  it('A two "Apply" buttons in two open dialogs: the owner picks the Filter one', () => {
    const flow = steps(`      - click: { role: button, name: Apply }
        fingerprint: { role: button, name: Apply, tag: button, dialog: Filter, owner: "dialog:Filter" }
`);
    const { decision, ranked } = resolve(flow, 0, [
      candidate({ id: 'T1', dialog: 'Edit request', owner: 'dialog:Edit request' }),
      candidate({ id: 'T2', dialog: 'Filter', owner: 'dialog:Filter' }),
    ]);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T2');
    expect(ranked.find((entry) => entry.id === 'T1')?.contradictions?.join(' ')).toMatch(/OWNER_MISMATCH/);
  });

  it('B two #valueInput in two components (forms): the form context separates them', () => {
    const flow = steps(`      - fill: { css: "#valueInput", value: alpha }
        fingerprint: { role: textbox, tag: input, id: valueInput, form: Search filter, owner: "form:Search filter" }
`);
    const field = (id: string, form: string): FunctionalCandidate =>
      candidate({
        id,
        tag: 'input',
        role: 'textbox',
        name: '',
        form,
        owner: `form:${form}`,
        stableAttributes: { id: 'valueInput' },
      });
    const { decision } = resolve(flow, 0, [field('T1', 'Quick search'), field('T2', 'Search filter')]);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T2');
  });

  it('C two lists with the same DOM structure: the label (and the listbox owner of an option) identifies them', () => {
    const flow = steps(`      - select: { css: "mat-select", option: Like }
        fingerprint: { role: combobox, tag: mat-select, label: Operator, formField: Operator, form: Filter }
`);
    const list = (id: string, label: string): FunctionalCandidate =>
      candidate({ id, tag: 'mat-select', role: 'combobox', name: label, label, form: 'Filter' });
    const { decision } = resolve(flow, 0, [list('T1', 'Field'), list('T2', 'Operator')]);
    expect(decision.chosen?.id).toBe('T2');
    // Une option cliquée seule appartient à SA liste : l'intention nomme le contrôle, pas l'option.
    const option = steps(`      - click: { role: option, name: Like }
        fingerprint: { role: option, name: Like, listbox: Operator, owner: "listbox:Operator" }
`);
    const identity = interactionTargetIdentityOf(
      option[0] as Extract<FlowStep, { target: unknown }>,
      functionalIdentityOf(option[0] as Extract<FlowStep, { target: unknown }>, option, 0),
    );
    expect(identity).toMatchObject({
      type: 'OPTION',
      semanticIntent: 'SELECT_OPERATOR',
      owner: { kind: 'listbox', name: 'Operator' },
    });
  });

  it('D a checkbox without a stable id but with a business label: found by its label and section; CHECK → checked', () => {
    const flow = steps(`      - check: { css: "mat-checkbox > div > div > input" }
        fingerprint: { role: checkbox, tag: input, label: Interview done, section: Interview, owner: "section:Interview", expectedState: checked }
`);
    const box = (id: string, label: string): FunctionalCandidate =>
      candidate({
        id,
        tag: 'input',
        role: 'checkbox',
        name: label,
        label,
        section: 'Interview',
        owner: 'section:Interview',
      });
    const { decision } = resolve(flow, 0, [box('T1', 'Documents received'), box('T2', 'Interview done')]);
    expect(decision.chosen?.id).toBe('T2');
    const identity = interactionTargetIdentityOf(
      flow[0] as Extract<FlowStep, { target: unknown }>,
      functionalIdentityOf(flow[0] as Extract<FlowStep, { target: unknown }>, flow, 0),
    );
    expect(identity).toMatchObject({
      type: 'CHECK',
      expectedState: 'checked',
      semanticIntent: 'CHECK_INTERVIEW_DONE',
    });
  });

  it('J the generated id changed between recording and replay (mat-input-12 → mat-input-31): resolution continues by identity', () => {
    const flow = steps(`      - fill: { css: "#mat-input-12", value: alpha }
        fingerprint: { role: textbox, tag: input, id: mat-input-12, label: Company name, formField: Company name, form: Create request, owner: "form:Create request" }
`);
    const { decision } = resolve(flow, 0, [
      candidate({
        id: 'T1',
        tag: 'input',
        role: 'textbox',
        name: 'Company name',
        label: 'Company name',
        form: 'Create request',
        owner: 'form:Create request',
        matchesRecordedLocator: false,
        stableAttributes: { id: 'mat-input-31' },
        generatedId: true,
      }),
      candidate({
        id: 'T2',
        tag: 'input',
        role: 'textbox',
        name: 'City',
        label: 'City',
        form: 'Create request',
        owner: 'form:Create request',
        matchesRecordedLocator: false,
        stableAttributes: { id: 'mat-input-32' },
        generatedId: true,
      }),
    ]);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T1');
  });

  it('K two candidates nothing distinguishes (same label, same owner): AMBIGUOUS, never the first one', () => {
    const flow = steps(`      - click: { role: button, name: Apply }
        fingerprint: { role: button, name: Apply, owner: "dialog:Filter", dialog: Filter }
`);
    const { decision } = resolve(flow, 0, [
      candidate({ id: 'T1', dialog: 'Filter', owner: 'dialog:Filter' }),
      candidate({ id: 'T2', dialog: 'Filter', owner: 'dialog:Filter' }),
    ]);
    expect(decision.status).toBe('AMBIGUOUS');
    expect(decision.chosen).toBeUndefined();
  });
});

describe('InteractionTargetIdentity (L) and ActionContextFingerprint', () => {
  it('L an unknown custom component: the owner is discovered generically (its tag), the type is CUSTOM_COMPONENT', () => {
    const flow = steps(`      - click: { css: "x-rating-stars > span:nth-of-type(4)" }
        fingerprint: { tag: span, owner: "component:x-rating-stars", component: x-rating-stars }
`);
    const step = flow[0] as Extract<FlowStep, { target: unknown }>;
    const identity = interactionTargetIdentityOf(step, functionalIdentityOf(step, flow, 0));
    expect(identity).toMatchObject({
      type: 'CUSTOM_COMPONENT',
      adapter: 'CustomComponentTargetAdapter',
      owner: { kind: 'component', name: 'x-rating-stars' },
    });
    expect(identity.confidence).toBeLessThan(0.6);
  });

  it('the same "Apply" in two contexts gets two intents and two action keys (Filter > Apply ≠ Edit > Apply)', () => {
    const of = (dialog: string) => {
      const flow = steps(`      - click: { role: button, name: Apply }
        fingerprint: { role: button, name: Apply, dialog: "${dialog}", owner: "dialog:${dialog}" }
`);
      const step = flow[0] as Extract<FlowStep, { target: unknown }>;
      return interactionTargetIdentityOf(step, functionalIdentityOf(step, flow, 0));
    };
    expect(of('Filter').semanticIntent).toBe('APPLY_FILTER');
    expect(of('Edit').semanticIntent).toBe('APPLY_EDIT');
    expect(actionContextFingerprintOf(of('Filter'), '/requests').key).not.toBe(
      actionContextFingerprintOf(of('Edit'), '/requests').key,
    );
  });
});

const control = (role: string, name: string, extra: Partial<ScreenControl> = {}): ScreenControl => ({
  role,
  name,
  visible: true,
  disabled: false,
  ...extra,
});
const expected = (recordedContext: { tab?: string; accordion?: string }, controls: ScreenControl[]) =>
  analyzeExpectedTarget({
    current: { index: 10, kind: 'fill', label: 'Business number', role: 'textbox', field: true },
    identifiable: true,
    probe: { attached: false, visible: false, readable: false },
    controls,
    previous: [],
    recordedContext,
  });

describe('Context mismatch (E, F) and authorization (AUTH)', () => {
  it('E the target lives in tab "Company", "Individual" is selected: TARGET_CONTEXT_MISMATCH / WRONG_TAB_SELECTED (exact, not guessed)', () => {
    const analysis = expected({ tab: 'Company' }, [
      control('tab', 'Individual', { selected: true }),
      control('tab', 'Company', { selected: false }),
    ]);
    expect(analysis.contextMismatch).toMatchObject({
      type: 'TARGET_CONTEXT_MISMATCH',
      cause: 'WRONG_TAB_SELECTED',
      expected: 'Company',
      actual: 'Individual',
    });
    expect(analysis.rootCauses[0]).toMatchObject({ category: 'WRONG_TAB_SELECTED', confidence: 0.92 });
    // Le planificateur de récupération reconnaît l'onglet comme section parente (action SAFE possible).
    expect(analysis.parentSection).toMatchObject({ label: 'tab:Company', state: 'UNSELECTED_TAB' });
  });

  it('F the target lives in the collapsed accordion "Interview": TARGET_NOT_RENDERED_BECAUSE_PARENT_CLOSED', () => {
    const analysis = expected({ accordion: 'Interview' }, [
      control('button', 'Interview', { expanded: false }),
      control('button', 'Documents', { expanded: true }),
    ]);
    expect(analysis.contextMismatch).toMatchObject({
      cause: 'PARENT_SECTION_CLOSED',
      classification: 'TARGET_NOT_RENDERED_BECAUSE_PARENT_CLOSED',
    });
    expect(analysis.rootCauses[0]?.category).toBe('PARENT_SECTION_CLOSED');
    expect(analysis.parentSection).toMatchObject({ label: 'button:Interview', state: 'CLOSED' });
  });

  it('AUTH a sign-in form and a 401: AUTH_CONTEXT_DIVERGENCE (expected / observed), never recoverable', () => {
    const analysis = analyzeDivergence({
      actionId: 'F#3',
      stepIndex: 3,
      symptom: 'TARGET_NOT_FOUND',
      expected: { label: 'Approve', role: 'button', kind: 'click' },
      screen: { route: '/login', controls: [], text: 'Sign in', loginFormVisible: true },
      network: [{ request: 'GET /api/requests/42', status: 401 }],
      expectedRole: 'manager',
    });
    expect(analysis.recoverable).toBe(false);
    expect(analysis.authContext).toMatchObject({
      type: 'AUTH_CONTEXT_DIVERGENCE',
      cause: 'AUTH_STATE_CHANGED',
      expectedRole: 'manager',
      observedRole: 'signed out (sign-in form displayed)',
      expectedCapabilities: ['click Approve'],
      observedCapabilities: ['GET /api/requests/42 → 401'],
    });
  });
});

const SETTINGS: TransitionSettings = {
  transitionTimeoutMs: 10_000,
  stabilityWindowMs: 400,
  noTransitionCapMs: 1500,
  graceMs: 1000,
  observeDomChanges: true,
  observeRouteChanges: true,
  observeNetwork: true,
  observeDialogs: true,
  observeLoaders: true,
};
const sample = (elapsedMs: number, over: Partial<TransitionSample> = {}): TransitionSample => ({
  elapsedMs,
  mutations: 0,
  msSinceMutation: elapsedMs,
  urlChanged: false,
  routeChanged: false,
  dialogsOpened: false,
  dialogsClosed: false,
  loaderVisible: false,
  network: { started: 0, pending: 0, completed: 0 },
  ...over,
});
const play = (
  tracker: TransitionTracker,
  samples: TransitionSample[],
): { result?: TransitionWaitResult; at?: number } => {
  for (const entry of samples) {
    const result = tracker.observe(entry);
    if (result) return { result, at: entry.elapsedMs };
  }
  return {};
};
/** Le scénario §22 : clic → réseau → DOM → route → cible suivante → stable, toutes les 100 ms. */
const timeline = (opts: { pendingUntil?: number; nextAt?: number }): TransitionSample[] => {
  const out: TransitionSample[] = [];
  for (let at = 100; at <= 10_000; at += 100) {
    const lastMutation = at < 1450 ? at : 1450;
    const pending = opts.pendingUntil !== undefined && at < opts.pendingUntil ? 1 : 0;
    out.push(
      sample(at, {
        mutations: at >= 500 ? 10 : 0,
        msSinceMutation: at - lastMutation,
        urlChanged: at >= 1100,
        routeChanged: at >= 1100,
        network: { started: at >= 120 ? 1 : 0, pending, completed: at >= 120 && !pending ? 1 : 0 },
        ...(opts.nextAt !== undefined ? { nextReady: at >= opts.nextAt } : {}),
      }),
    );
  }
  return out;
};

describe('Transition: success predicate and progress (G, H)', () => {
  it('G route changed and the next target available at 1.45 s: the wait ends at ~1.9 s, never 10 s', () => {
    const tracker = new TransitionTracker(
      expectationOf({ kind: 'click', effectsDeclared: true, nextKnown: true, nextReadyBefore: false }),
      SETTINGS,
    );
    const { result, at } = play(tracker, timeline({ nextAt: 1450, pendingUntil: 900 }));
    expect(result?.status).toBe('NEXT_ACTION_READY');
    expect(at).toBeLessThanOrEqual(2000);
  });

  it('G (bis) declared effects never observed, no next target known, but the route changed and the UI is stable: FUNCTIONAL_STATE_REACHED at ~2.3 s (the verifier judges the effects), not a 10 s TIMEOUT', () => {
    const tracker = new TransitionTracker(
      expectationOf({ kind: 'click', effectsDeclared: true, nextKnown: false, nextReadyBefore: undefined }),
      SETTINGS,
    );
    const { result, at } = play(tracker, timeline({ pendingUntil: 900 }));
    expect(result?.status).toBe('TRANSITION_CONFIRMED');
    expect(result?.signals.map((signal) => signal.kind)).toContain('FUNCTIONAL_STATE_REACHED');
    expect(at).toBeLessThan(3000);
  });

  it('H the network is still active: never concluded while a request is pending, then confirmed once it completes and the UI settles', () => {
    const tracker = new TransitionTracker(
      expectationOf({ kind: 'click', effectsDeclared: true, nextKnown: true, nextReadyBefore: false }),
      SETTINGS,
    );
    const { result, at } = play(tracker, timeline({ nextAt: 1450, pendingUntil: 4000 }));
    expect(at).toBeGreaterThanOrEqual(4000);
    expect(result?.status).toBe('NEXT_ACTION_READY');
  });

  it('no progress at all (nothing changes after the click): TIMEOUT once no meaningful progress remains, long before the 10 s bound', () => {
    const tracker = new TransitionTracker(
      expectationOf({ kind: 'click', effectsDeclared: true, nextKnown: true, nextReadyBefore: false }),
      SETTINGS,
    );
    const samples = Array.from({ length: 100 }, (_, i) =>
      sample((i + 1) * 100, { nextReady: false, effectObserved: false }),
    );
    const { result, at } = play(tracker, samples);
    expect(result?.status).toBe('TIMEOUT');
    expect(result?.missing.join(' ')).toMatch(/NO_PROGRESS_TIMEOUT/);
    expect(at).toBeLessThanOrEqual(3200);
  });
});

describe('Causal effects (I), effect verification (M, N), first functional divergence (O)', () => {
  it('I action N immediately followed by N+1 (one shared observation after N+1): the effects of N+1 are never attributed to N', () => {
    const state = (id: string, route: string, controls: string[]): RecordedState => ({
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
    });
    const action = (id: string, extra: Partial<SemanticRecordedAction>): SemanticRecordedAction => ({
      id,
      type: 'CLICK',
      rawEventIds: [`r-${id}`],
      at: 0,
      url: 'http://app.test/list',
      network: [],
      provenance: 'HUMAN_RECORDED',
      confidence: 0.9,
      evidence: [],
      ...extra,
    });
    const n = action('a1', { stateBefore: 's1', stateAfter: 's2' });
    const next = action('a2', { stateAfter: 's2' });
    attributeEffects(
      [n, next],
      [state('s1', '/list', ['button:Apply']), state('s2', '/detail', ['heading:Detail', 'button:Back'])],
    );
    expect(JSON.stringify(n.expectedEffects ?? {})).not.toMatch(/heading:Detail|button:Back|\/detail/);
    expect(
      n.effectCausality?.every((candidate) => candidate.classification === 'BELONGS_TO_NEXT_ACTION'),
    ).toBe(true);
  });

  const verify = (appeared: string[]) =>
    verifyEffects({
      effects: { appears: ['heading:Results'] },
      // Les contrôles observés sont des clés normalisées (rôle:nom en minuscules), comme au rejeu.
      observed: { appeared, disappeared: [], requests: [] },
      afterControls: new Set(appeared),
      afterRoute: '/list',
      mutation: false,
      writes: [],
    });

  it('M executed, but another effect: WRONG_EFFECT (Playwright success ≠ functional success)', () => {
    expect(verify(['heading:error']).status).toBe('WRONG_EFFECT');
  });

  it('N right target, right effect, next action available: ACTION_CONFIRMED (effect CONFIRMED + NEXT_ACTION_READY)', () => {
    expect(verify(['heading:results']).status).toBe('CONFIRMED');
    const tracker = new TransitionTracker(
      expectationOf({ kind: 'click', effectsDeclared: true, nextKnown: true, nextReadyBefore: false }),
      SETTINGS,
    );
    expect(play(tracker, timeline({ nextAt: 1450 })).result?.status).toBe('NEXT_ACTION_READY');
  });

  it('O step 10 fails because step 8 selected the wrong tab (step 9 technically passed): FIRST_FUNCTIONAL_DIVERGENCE = 8', () => {
    const history = Array.from({ length: 9 }, (_, i) => {
      const index = i + 1;
      const tab = index < 8 ? 'Company' : 'Individual';
      const before = index <= 8 ? 'Company' : 'Individual';
      return {
        index,
        description: index === 8 ? 'click tab "Company"' : `step ${String(index)}`,
        ...(index === 8 ? { target: { role: 'tab', name: 'Company' } } : {}),
        before: { route: '/client', selectedTabs: [before] },
        after: { route: '/client', selectedTabs: [tab] },
      };
    });
    // Le contexte se perd APRÈS l'étape 8 (avant : Company, après : Individual).
    const located = locateFirstFunctionalDivergence({
      failedStep: 10,
      required: { tab: 'Company' },
      history,
      current: { route: '/client', selectedTabs: ['Individual'] },
    });
    expect(located).toMatchObject({
      stepIndex: 8,
      failedStep: 10,
      dimension: 'tab',
      expected: 'Company',
      observed: 'Individual',
      lastConfirmedCheckpoint: 7,
    });
    // Le contexte requis tient maintenant : il n'explique pas l'échec (racine = l'étape en échec).
    expect(
      locateFirstFunctionalDivergence({
        failedStep: 10,
        required: { tab: 'Company' },
        history,
        current: { selectedTabs: ['Company'] },
      }).stepIndex,
    ).toBe(10);
  });
});
