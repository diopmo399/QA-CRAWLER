import { describe, expect, it } from 'vitest';
import { requestCompleted } from '../../src/flows/action-effect-verifier.js';
import {
  expectationOf,
  TransitionTracker,
  type TransitionSample,
  type TransitionSettings,
  type TransitionWaitResult,
} from '../../src/observation/transition-waiter.js';
import { evaluateFastPath, type FastPathInput } from '../../src/performance/fast-path.js';
import {
  baselineOf,
  compareToBaseline,
  detectSlowAction,
  instrumentMethods,
  performanceReportOf,
  PerformanceTracer,
  summarizePerformance,
  waterfall,
} from '../../src/performance/performance-tracer.js';

/** Une horloge pilotée par le test. */
const clock = () => {
  let at = 0;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

describe('PerformanceTracer', () => {
  it('A phases are measured per action, nested phases keep their parent, the action has its total', async () => {
    const time = clock();
    const tracer = new PerformanceTracer('run', time.now);
    tracer.beginAction('step-1', 1, 'click Save', 'click');
    await tracer.phase('execute', async () => {
      time.advance(30);
      await tracer.phase('locate', () => {
        time.advance(10);
        return Promise.resolve();
      });
    });
    tracer.track('state-observation', () => {
      time.advance(5);
    });
    const trace = tracer.endAction('PASSED');
    expect(trace?.totalDurationMs).toBe(45);
    expect(trace?.phases).toEqual([
      expect.objectContaining({ name: 'locate', parent: 'execute', durationMs: 10 }),
      expect.objectContaining({ name: 'execute', durationMs: 40 }),
      expect.objectContaining({ name: 'state-observation', durationMs: 5 }),
    ]);
    expect(trace?.phases[1]?.parent).toBeUndefined();
    expect(trace?.status).toBe('PASSED');
  });

  it("B concurrent observations never become each other's parent (the async thread decides)", async () => {
    const tracer = new PerformanceTracer('run');
    tracer.beginAction('step-1', 1, 'click', 'click');
    const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.all([
      tracer.track('transition-wait', () => later(20)),
      tracer.track('next-target-probe', () => later(5)),
    ]);
    const trace = tracer.endAction();
    expect(trace?.phases.map((phase) => [phase.name, phase.parent])).toEqual([
      ['next-target-probe', undefined],
      ['transition-wait', undefined],
    ]);
  });

  it('C a wait that ends on its condition: useful until the last evidence, then confirmation; a timeout is wasted after it', () => {
    const tracer = new PerformanceTracer('run');
    tracer.beginAction('step-1', 1, 'click', 'click');
    tracer.wait({
      type: 'transition',
      durationMs: 420,
      terminationReason: 'CONDITION_MET',
      signals: [
        { kind: 'DIALOG_OPENED', atMs: 40 },
        { kind: 'UI_STABLE', atMs: 420 },
      ],
    });
    tracer.wait({
      type: 'transition',
      durationMs: 10_000,
      terminationReason: 'MAX_TIMEOUT',
      signals: [{ kind: 'DOM_CHANGED', atMs: 300 }],
    });
    const [met, timeout] = tracer.endAction()?.waits ?? [];
    expect(met).toMatchObject({ usefulWaitMs: 40, confirmationWaitMs: 380, wastedWaitMs: 0 });
    expect(timeout).toMatchObject({ usefulWaitMs: 300, confirmationWaitMs: 0, wastedWaitMs: 9700 });
  });

  it('D summary: buckets over top-level phases only, FAST / DEEP counts, median and p95, MOSTLY_WAITING warning', () => {
    const time = clock();
    const tracer = new PerformanceTracer('run', time.now);
    for (const [index, deep] of [false, true, false].entries()) {
      tracer.beginAction(`step-${String(index)}`, index + 1, `step ${String(index)}`, 'click');
      if (deep) tracer.deep('FUNCTIONAL_RESOLUTION');
      tracer.track('transition-wait', () => {
        tracer.track('next-target-probe', () => {
          time.advance(100);
        });
        time.advance(1100);
      });
      tracer.wait({ type: 'transition', durationMs: 1200, terminationReason: 'CONDITION_MET', signals: [] });
      tracer.track('execute', () => {
        time.advance(100 * (index + 1));
      });
      tracer.endAction('PASSED');
    }
    const summary = summarizePerformance(tracer.traces(), 5000);
    expect(summary.fastPath).toBe(2);
    expect(summary.deepPath).toBe(1);
    // La sonde imbriquée n'est pas comptée deux fois.
    expect(summary.buckets.find((bucket) => bucket.name === 'Transition waiting')?.durationMs).toBe(3600);
    expect(summary.buckets.find((bucket) => bucket.name === 'Browser execution')?.durationMs).toBe(600);
    expect(summary.medianActionMs).toBe(1400);
    expect(summary.p95ActionMs).toBe(1500);
    expect(tracer.traces()[0]?.warnings.map((warning) => warning.code)).toContain('MOSTLY_WAITING');
    const deep = tracer.traces()[1];
    expect(deep && waterfall(deep)[0]).toMatch(/STEP 2 .*DEEP_PATH/);
  });

  it('E SLOW_ACTION_DETECTED names the dominant phase, its cause and the evidence; nothing below the threshold', () => {
    const time = clock();
    const tracer = new PerformanceTracer('run', time.now);
    tracer.beginAction('step-1', 1, 'click Apply', 'click');
    tracer.track('transition-wait', () => {
      time.advance(2600);
    });
    tracer.wait({
      type: 'transition',
      durationMs: 2600,
      terminationReason: 'NO_PROGRESS',
      signals: [{ kind: 'DOM_CHANGED', atMs: 100 }],
    });
    tracer.endAction('FAILED');
    tracer.beginAction('step-2', 2, 'fill Name', 'fill');
    time.advance(50);
    tracer.endAction('PASSED');
    const [slow, fast] = tracer.traces();
    if (!slow || !fast) throw new Error('two traces expected');
    const detected = detectSlowAction(slow, 2000);
    expect(detected).toMatchObject({ reason: 'SLOW_TRANSITION', phase: 'transition-wait', durationMs: 2600 });
    expect(detected?.evidence.join(' ')).toMatch(/NO_PROGRESS \(2500 ms without new evidence\)/);
    expect(detectSlowAction(fast, 2000)).toBeUndefined();
    const report = performanceReportOf(tracer.traces(), 3000, 2000);
    expect(report.slowActions).toHaveLength(1);
    expect(report.waterfalls).toHaveLength(1);
  });

  it('F PERFORMANCE_REGRESSION: only a metric clearly worse than the baseline (ratio AND absolute difference)', () => {
    const base = baselineOf(summarizePerformance([], 10_000));
    expect(compareToBaseline({ ...base, totalRunMs: 12_000 }, base)).toEqual([]);
    expect(compareToBaseline({ ...base, totalRunMs: 14_000 }, base).map((entry) => entry.metric)).toEqual([
      'totalRunMs',
    ]);
  });

  it('G instrumentMethods: a sync method stays sync, a deep method marks the action DEEP_PATH, an error is recorded and rethrown', async () => {
    const tracer = new PerformanceTracer('run');
    const host = {
      count: 0,
      observe(): number {
        this.count += 1;
        return this.count;
      },
      heal(): Promise<string> {
        return Promise.reject(new Error('no candidate'));
      },
    };
    instrumentMethods(host, tracer, {
      observe: { phase: 'state-observation' },
      heal: { phase: 'locator-healing', deep: 'LOCATOR_HEALING' },
    });
    tracer.beginAction('step-1', 1, 'click', 'click');
    expect(host.observe()).toBe(1);
    await expect(host.heal()).rejects.toThrow('no candidate');
    const trace = tracer.endAction();
    expect(trace?.path).toBe('DEEP_PATH');
    expect(trace?.deepReasons).toEqual(['LOCATOR_HEALING']);
    expect(trace?.phases.map((phase) => [phase.name, phase.outcome])).toEqual([
      ['state-observation', undefined],
      ['locator-healing', 'ERROR'],
    ]);
  });
});

describe('FastPathEligibilityEvaluator', () => {
  const known: FastPathInput = {
    enabled: true,
    recorded: true,
    healed: false,
    functionalResolution: false,
    contextualResolution: false,
    reacquired: false,
    inRecovery: false,
    previousStatus: 'PASSED',
    dangerous: false,
  };

  it('H a recorded step, resolved directly, after a passed step: FAST_PATH', () => {
    expect(evaluateFastPath(known)).toEqual({ path: 'FAST_PATH', reasons: [] });
    expect(evaluateFastPath({ ...known, previousStatus: undefined }).path).toBe('FAST_PATH');
  });

  it('I every unusual situation takes the DEEP_PATH, with its reason', () => {
    const cases: [Partial<FastPathInput>, string][] = [
      [{ enabled: false }, 'FAST_PATH_DISABLED'],
      [{ recorded: false }, 'UNKNOWN_STEP'],
      [{ healed: true }, 'LOCATOR_HEALED'],
      [{ functionalResolution: true }, 'FUNCTIONAL_RESOLUTION'],
      [{ contextualResolution: true }, 'CONTEXTUAL_RESOLUTION'],
      [{ reacquired: true }, 'REACQUIRED_AFTER_RERENDER'],
      [{ inRecovery: true }, 'RECOVERY_IN_PROGRESS'],
      [{ previousStatus: 'FAILED' }, 'PREVIOUS_STEP_NOT_PASSED'],
      [{ dangerous: true }, 'DANGEROUS_ACTION'],
    ];
    for (const [over, reason] of cases)
      expect(evaluateFastPath({ ...known, ...over }), reason).toEqual({
        path: 'DEEP_PATH',
        reasons: [reason],
      });
  });
});

describe('Condition-driven transition wait (FAST_PATH confirmation)', () => {
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
  const FAST = { ...SETTINGS, confirmationQuietMs: 150 };
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
  const every50 = (until: number, over: (at: number) => Partial<TransitionSample>) =>
    Array.from({ length: until / 50 }, (_, index) => sample((index + 1) * 50, over((index + 1) * 50)));
  const dialogClick = () =>
    expectationOf({ kind: 'click', effectsDeclared: true, nextKnown: true, nextReadyBefore: false });
  // Le dialogue s'ouvre à 40 ms (la dernière mutation), l'effet et la cible suivante sont là.
  const dialogOpened = (at: number): Partial<TransitionSample> =>
    at >= 50
      ? {
          mutations: 5,
          msSinceMutation: at - 40,
          dialogsOpened: true,
          effectObserved: true,
          nextReady: true,
        }
      : {};

  it('J the positive evidence is there: the wait ends after the SHORT confirmation (CONDITION_CONFIRMED), not the full window', () => {
    const { result, at } = run(new TransitionTracker(dialogClick(), FAST), every50(2000, dialogOpened));
    expect(at).toBe(200);
    expect(result?.status).toBe('NEXT_ACTION_READY');
    expect(result?.signals.map((signal) => signal.kind)).toEqual(
      expect.arrayContaining(['EXPECTED_EFFECT_OBSERVED', 'UI_STABLE']),
    );
    expect(result?.signals.map((signal) => signal.kind)).toContain('CONDITION_CONFIRMED');
  });

  it('K DEEP_PATH (no confirmation setting): the same samples wait for the full stability window, as before', () => {
    const { result, at } = run(new TransitionTracker(dialogClick(), SETTINGS), every50(2000, dialogOpened));
    expect(at).toBe(450);
    expect(result?.status).toBe('NEXT_ACTION_READY');
    expect(result?.signals.map((signal) => signal.kind)).not.toContain('CONDITION_CONFIRMED');
  });

  it('L evidence but the DOM keeps changing, or a request is pending, or a loader is shown: no confirmation until calm', () => {
    const busy = (at: number): Partial<TransitionSample> => ({
      ...dialogOpened(at),
      // Une mutation toutes les 100 ms jusqu'à 600 ms ; une requête en vol jusqu'à 700 ms ; un chargement jusqu'à 800 ms.
      ...(at >= 50
        ? {
            mutations: 5 + Math.floor(Math.min(at, 600) / 100),
            msSinceMutation: at <= 600 ? at % 100 : at - 600,
          }
        : {}),
      network: { started: 1, pending: at < 700 ? 1 : 0, completed: at < 700 ? 0 : 1 },
      loaderVisible: at < 800,
    });
    const { at } = run(new TransitionTracker(dialogClick(), FAST), every50(3000, busy));
    expect(at).toBe(800);
  });

  it('M no positive evidence (next target not there, no effect): the FAST setting changes nothing — full window, and a missing effect still times out', () => {
    const nothing = run(
      new TransitionTracker(dialogClick(), FAST),
      every50(12_000, (at) => ({
        nextReady: false,
        mutations: at > 100 ? 1 : 0,
        msSinceMutation: at > 100 ? at - 100 : at,
      })),
    );
    // Rien ne vient : jamais un succès raccourci ; la conclusion reste TIMEOUT (absence de progrès).
    expect(nothing.result?.status).toBe('TIMEOUT');
    expect(nothing.result?.missing.join(' ')).toMatch(/EXPECTED_EFFECT_OBSERVED/);
  });

  it('N the confirmation never ends before its own delay since the action (a late reaction has time to start)', () => {
    // La cible suivante est prête d'emblée et rien ne bouge : au plus tôt à 150 ms.
    const fill = expectationOf({
      kind: 'fill',
      effectsDeclared: false,
      nextKnown: true,
      nextReadyBefore: true,
    });
    const { result, at } = run(
      new TransitionTracker(fill, FAST),
      every50(2000, () => ({ nextReady: true })),
    );
    expect(at).toBe(150);
    expect(result?.status).toBe('NO_TRANSITION_EXPECTED');
    // DEEP : la fenêtre complète.
    expect(
      run(
        new TransitionTracker(fill, SETTINGS),
        every50(2000, () => ({ nextReady: true })),
      ).at,
    ).toBe(400);
  });

  it('O a recorded request is a positive evidence only when it completed with success (2xx / 3xx)', () => {
    expect(requestCompleted('POST /api/apply', ['POST /api/apply 200'])).toBe(true);
    expect(requestCompleted('GET /api/requests/:id', ['GET /api/requests/42 304'])).toBe(true);
    expect(requestCompleted('POST /api/apply', ['POST /api/apply 500'])).toBe(false);
    expect(requestCompleted('POST /api/apply', ['GET /api/apply 200'])).toBe(false);
    expect(requestCompleted('POST /api/apply', undefined)).toBe(false);
  });

  it('P a mutation is never confirmed by the next target alone while its request is still in flight', () => {
    const save = expectationOf({
      kind: 'click',
      effectsDeclared: false,
      nextKnown: true,
      nextReadyBefore: true,
    });
    const inFlight = (at: number): Partial<TransitionSample> => ({
      nextReady: true,
      network: { started: 1, pending: at < 900 ? 1 : 0, completed: at < 900 ? 0 : 1 },
    });
    const { at } = run(new TransitionTracker(save, FAST), every50(3000, inFlight));
    expect(at).toBe(900);
  });
});
