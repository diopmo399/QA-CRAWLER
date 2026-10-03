import { describe, expect, it } from 'vitest';
import {
  expectationOf,
  TransitionTracker,
  type TransitionSample,
  type TransitionSettings,
  type TransitionWaitResult,
} from '../../src/observation/transition-waiter.js';

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

/** Un échantillon : rien ne bouge, sauf ce qui est donné. */
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

/** Joue des échantillons jusqu'au premier résultat (l'attente s'arrête là). */
const run = (
  tracker: TransitionTracker,
  samples: TransitionSample[],
): { result?: TransitionWaitResult; at?: number } => {
  for (const entry of samples) {
    const result = tracker.observe(entry);
    if (result) return { result, at: entry.elapsedMs };
  }
  return {};
};

const click = (over: Partial<Parameters<typeof expectationOf>[0]> = {}) =>
  expectationOf({ kind: 'click', effectsDeclared: false, nextKnown: true, nextReadyBefore: false, ...over });

describe('UITransitionWaiter — the decision (pure)', () => {
  it('TEST 1 delayed dialog: nothing for 800 ms, then the dialog opens — the waiter waits, never validates during the gap', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result, at } = run(tracker, [
      sample(100, { nextReady: false, nextReason: 'not on the screen yet' }),
      sample(500),
      sample(800, { mutations: 12, msSinceMutation: 0, dialogsOpened: true }),
      sample(900, { mutations: 12, msSinceMutation: 100, dialogsOpened: true, nextReady: true }),
      sample(1300, { mutations: 12, msSinceMutation: 500, dialogsOpened: true }),
    ]);
    expect(at).toBe(1300);
    expect(result?.status).toBe('NEXT_ACTION_READY');
    expect(result?.evidence).toEqual(
      expect.arrayContaining(['DIALOG_OPENED', 'DOM_CHANGED', 'NEXT_ACTION_TARGET_AVAILABLE']),
    );
    expect(result?.stable).toBe(true);
  });

  it('TEST 2 delayed next target: B appears after 1200 ms — NEXT_ACTION_TARGET_AVAILABLE first, then stability, only then B may start', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result, at } = run(tracker, [
      sample(200, { mutations: 3, msSinceMutation: 0, nextReady: false }),
      sample(700, { mutations: 3, msSinceMutation: 500, nextReady: false }),
      sample(1200, { mutations: 9, msSinceMutation: 0, nextReady: true }),
      sample(1400, { mutations: 9, msSinceMutation: 200 }),
      sample(1650, { mutations: 9, msSinceMutation: 450 }),
    ]);
    // Stable à 700 ms mais la cible suivante n'était pas là : on ne conclut pas.
    expect(at).toBe(1650);
    expect(result?.status).toBe('NEXT_ACTION_READY');
    expect(result?.nextAction).toBe('READY');
  });

  it('TEST 3 same-URL SPA: a tab switch changes the DOM only (no URL change) — a valid transition', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result } = run(tracker, [
      sample(100, { mutations: 20, msSinceMutation: 0, nextReady: true }),
      sample(600, { mutations: 20, msSinceMutation: 500 }),
    ]);
    expect(result?.status).toBe('NEXT_ACTION_READY');
    expect(result?.evidence).not.toContain('URL_CHANGED');
  });

  it('TEST 5 loader: never validated while the spinner is visible; LOADER_DISAPPEARED then target', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result, at } = run(tracker, [
      sample(100, { mutations: 2, msSinceMutation: 0, loaderVisible: true }),
      sample(1500, { mutations: 2, msSinceMutation: 1400, loaderVisible: true, nextReady: false }),
      sample(2000, { mutations: 6, msSinceMutation: 0, loaderVisible: false, nextReady: true }),
      sample(2500, { mutations: 6, msSinceMutation: 500 }),
    ]);
    expect(at).toBe(2500);
    expect(result?.evidence).toEqual(expect.arrayContaining(['LOADER_APPEARED', 'LOADER_DISAPPEARED']));
  });

  it('TEST 6 network: request → response → DOM update → next target: confirmed only once the request completed', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result, at } = run(tracker, [
      sample(100, { network: { started: 1, pending: 1, completed: 0, lastStarted: 'POST /search' } }),
      sample(700, { network: { started: 1, pending: 1, completed: 0 }, nextReady: true }),
      sample(900, {
        mutations: 4,
        msSinceMutation: 0,
        network: { started: 1, pending: 0, completed: 1, lastCompleted: 'POST /search 200' },
      }),
      sample(1350, { mutations: 4, msSinceMutation: 450, network: { started: 1, pending: 0, completed: 1 } }),
    ]);
    // À 700 ms la cible était là, mais la requête corrélée était encore en cours.
    expect(at).toBe(1350);
    expect(result?.evidence).toEqual(
      expect.arrayContaining([
        'NETWORK_ACTIVITY_STARTED POST /search',
        'NETWORK_ACTIVITY_COMPLETED POST /search 200',
      ]),
    );
  });

  it('TEST 7 polling: background requests never idle (not correlated, pending = 0) — never waits for networkidle', () => {
    const tracker = new TransitionTracker(click({ nextReadyBefore: true }), SETTINGS);
    const { result, at } = run(tracker, [
      sample(100, { mutations: 5, msSinceMutation: 0 }),
      sample(600, { mutations: 5, msSinceMutation: 500 }),
    ]);
    expect(at).toBe(600);
    expect(result?.status).toBe('STABLE_WITH_LOCAL_EFFECT');
  });

  it('TEST 8 no transition expected (a fill without recorded effect): stability only, never the full timeout', () => {
    const tracker = new TransitionTracker(
      expectationOf({ kind: 'fill', effectsDeclared: false, nextKnown: true, nextReadyBefore: true }),
      SETTINGS,
    );
    const { result, at } = run(tracker, [
      sample(100, { mutations: 1, msSinceMutation: 50 }),
      sample(450, { mutations: 1, msSinceMutation: 400 }),
    ]);
    expect(at).toBe(450);
    expect(result?.status).toBe('NO_TRANSITION_EXPECTED');
  });

  it('TEST 9 real timeout: the awaited effect never arrives — TIMEOUT with what is missing (never a TARGET_MISMATCH)', () => {
    const tracker = new TransitionTracker(click({ effectsDeclared: true }), SETTINGS);
    const samples = [sample(500, { mutations: 2, msSinceMutation: 100 })];
    for (let at = 1000; at <= 10_000; at += 1000)
      samples.push(
        sample(at, { mutations: 2, msSinceMutation: at - 400, effectObserved: false, nextReady: false }),
      );
    const { result } = run(tracker, samples);
    expect(result?.status).toBe('TIMEOUT');
    expect(result?.missing.join(' ')).toMatch(/EXPECTED_EFFECT_OBSERVED/);
    expect(result?.missing.join(' ')).toMatch(/NEXT_ACTION_TARGET_AVAILABLE/);
  });

  it('TEST 10 stale locator: the next locator matched the OLD DOM (fingerprint differs) — not ready until the fresh target appears', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result, at } = run(tracker, [
      sample(100, {
        mutations: 1,
        msSinceMutation: 0,
        nextReady: false,
        nextPresent: true,
        nextReason: 'fingerprint differs',
      }),
      sample(300, { mutations: 8, msSinceMutation: 0, nextReady: true }),
      sample(750, { mutations: 8, msSinceMutation: 450 }),
    ]);
    expect(at).toBe(750);
    expect(result?.status).toBe('NEXT_ACTION_READY');
  });

  it('a click with nothing observed and nothing precise expected: AMBIGUOUS after the grace period, not the full timeout', () => {
    const tracker = new TransitionTracker(click({ nextKnown: false, nextReadyBefore: undefined }), SETTINGS);
    const { result, at } = run(tracker, [sample(500), sample(1000), sample(1100)]);
    expect(at).toBe(1000);
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.nextAction).toBe('UNKNOWN');
  });

  it('a pending correlated request keeps the UI "not stable"; a route change is a strong signal', () => {
    const tracker = new TransitionTracker(click({ nextKnown: false, nextReadyBefore: undefined }), SETTINGS);
    const { result } = run(tracker, [
      sample(100, {
        routeChanged: true,
        urlChanged: true,
        network: { started: 1, pending: 1, completed: 0 },
      }),
      sample(600, {
        routeChanged: true,
        urlChanged: true,
        network: { started: 1, pending: 1, completed: 0 },
      }),
      sample(800, {
        routeChanged: true,
        urlChanged: true,
        network: { started: 1, pending: 0, completed: 1 },
      }),
    ]);
    expect(result?.status).toBe('TRANSITION_CONFIRMED');
    expect(result?.evidence).toEqual(expect.arrayContaining(['URL_CHANGED', 'ROUTE_CHANGED']));
  });

  it('the next target present but with another fingerprint: once durably stable, synchronization ends (target resolution judges, not the waiter)', () => {
    const tracker = new TransitionTracker(click(), SETTINGS);
    const { result, at } = run(tracker, [
      sample(100, { mutations: 3, msSinceMutation: 0, nextReady: false, nextPresent: true }),
      sample(600, { mutations: 3, msSinceMutation: 500, nextReady: false, nextPresent: true }),
      sample(950, { mutations: 3, msSinceMutation: 850, nextReady: false, nextPresent: true }),
    ]);
    expect(at).toBe(950);
    expect(result?.status).toBe('TRANSITION_CONFIRMED');
  });
});
