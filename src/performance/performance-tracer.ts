import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * PERFORMANCE TRACER : mesurer AVANT d'optimiser. Chaque action (étape de flow) a sa trace : ses
 * phases (résolution, exécution, attente de transition, vérification, récupération…), ses attentes
 * (pourquoi elles se sont terminées, ce qu'elles ont observé, combien de temps a été UTILE), son chemin
 * (FAST_PATH / DEEP_PATH). Rien n'est jamais accéléré ici : on observe seulement.
 */
export type PerformancePath = 'FAST_PATH' | 'DEEP_PATH';

export interface PerformancePhase {
  name: string;
  /** La phase englobante (une observation pendant une récupération) : jamais comptée deux fois. */
  parent?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  outcome?: string;
}

export type WaitTermination = 'CONDITION_MET' | 'NO_PROGRESS' | 'MAX_TIMEOUT' | 'CANCELLED';

export interface WaitTrace {
  type: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  terminationReason: WaitTermination;
  signalsObserved: string[];
  /** Jusqu'au dernier signal utile (la preuve était là). */
  usefulWaitMs?: number;
  /** Au-delà : du temps passé à attendre sans rien apprendre de plus. */
  wastedWaitMs?: number;
  /** Le calme exigé APRÈS la dernière preuve, pour confirmer (inclus dans durationMs). */
  confirmationWaitMs?: number;
}

export interface PerformanceWarning {
  code: string;
  message: string;
}

export interface ActionPerformanceTrace {
  runId: string;
  actionId: string;
  step: number;
  description: string;
  kind: string;
  path: PerformancePath;
  /** Pourquoi le chemin profond (ambiguïté, divergence, récupération…). */
  deepReasons: string[];
  startedAt: number;
  completedAt: number;
  totalDurationMs: number;
  phases: PerformancePhase[];
  waits: WaitTrace[];
  recovery?: { durationMs: number; outcome?: string };
  ai?: { calls: number; durationMs: number };
  cache: { hits: number; misses: number };
  warnings: PerformanceWarning[];
  status?: string;
}

/** Les familles de phases du résumé (« Browser execution », « Transition waiting »…). */
export const PHASE_BUCKETS: Record<string, string> = {
  execute: 'Browser execution',
  'transition-wait': 'Transition waiting',
  'next-target-probe': 'Transition waiting',
  'target-resolution': 'Target resolution',
  'fingerprint-matching': 'Target resolution',
  'candidate-discovery': 'Target resolution',
  'locator-wait': 'Target resolution',
  locate: 'Target resolution',
  reacquire: 'Target resolution',
  'locator-healing': 'Target resolution',
  assertion: 'Effect verification',
  'effect-verification': 'Effect verification',
  'fill-verification': 'Effect verification',
  recovery: 'Recovery',
  'state-observation': 'State observation',
  screenshot: 'Reporting',
  'functional-observation': 'Knowledge / learning',
  'cognitive-observation': 'Knowledge / learning',
  'knowledge-lookup': 'Knowledge / learning',
  ai: 'AI',
};

const round = (value: number): number => Math.round(value);

/** Des signaux qui concluent ou constatent l'absence : pas une preuve de progrès. */
const NOT_EVIDENCE = new Set(['UI_STABLE', 'NO_PROGRESS', 'CONDITION_CONFIRMED', 'FUNCTIONAL_STATE_REACHED']);

export class PerformanceTracer {
  private readonly done: ActionPerformanceTrace[] = [];
  private current: ActionPerformanceTrace | undefined;
  private readonly runStartedAt: number;
  private readonly scope = new AsyncLocalStorage<string>();

  constructor(
    readonly runId: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.runStartedAt = this.now();
  }

  /** Une action commence (une étape de flow). */
  beginAction(actionId: string, step: number, description: string, kind: string): void {
    if (this.current) this.endAction('INTERRUPTED');
    const at = this.now();
    this.current = {
      runId: this.runId,
      actionId,
      step,
      description,
      kind,
      path: 'FAST_PATH',
      deepReasons: [],
      startedAt: at,
      completedAt: at,
      totalDurationMs: 0,
      phases: [],
      waits: [],
      cache: { hits: 0, misses: 0 },
      warnings: [],
    };
  }

  /** Mesure une phase (asynchrone) de l'action courante ; sans action, la mesure est ignorée. */
  async phase<T>(
    name: string,
    run: () => Promise<T>,
    outcome?: (result: T) => string | undefined,
  ): Promise<T> {
    const startedAt = this.now();
    const action = this.current;
    const parent = this.scope.getStore();
    try {
      const result = await this.scope.run(name, run);
      if (action) this.record(action, name, startedAt, outcome?.(result), parent);
      return result;
    } catch (error) {
      if (action) this.record(action, name, startedAt, 'ERROR', parent);
      throw error;
    }
  }

  private record(
    action: ActionPerformanceTrace,
    name: string,
    startedAt: number,
    outcome?: string,
    parent?: string,
  ): void {
    const completedAt = this.now();
    action.phases.push({
      name,
      ...(parent ? { parent } : {}),
      startedAt: round(startedAt - this.runStartedAt),
      completedAt: round(completedAt - this.runStartedAt),
      durationMs: round(completedAt - startedAt),
      ...(outcome ? { outcome } : {}),
    });
  }

  /**
   * Mesure un appel, synchrone OU asynchrone, sans en changer la nature (une méthode synchrone reste
   * synchrone pour ses appelants).
   */
  track<T>(name: string, call: () => T): T {
    const startedAt = this.now();
    const action = this.current;
    // La phase PARENTE suit le fil asynchrone (des observations concurrentes ne se croisent pas).
    const parent = this.scope.getStore();
    const finish = (outcome?: string): void => {
      if (action) this.record(action, name, startedAt, outcome, parent);
    };
    let result: T;
    try {
      result = this.scope.run(name, call);
    } catch (error) {
      finish('ERROR');
      throw error;
    }
    if (result instanceof Promise)
      return result.then(
        (value: unknown) => {
          finish();
          return value;
        },
        (error: unknown) => {
          finish('ERROR');
          throw error;
        },
      ) as T;
    finish();
    return result;
  }

  /**
   * Une attente terminée (transition…), avec ses signaux. Utile : jusqu'à la DERNIÈRE preuve (un signal
   * de progrès) ; confirmation : le calme exigé ensuite ; perdu : une attente qui se termine sans la
   * condition (borne, absence de progrès) au-delà de la dernière preuve.
   */
  wait(input: {
    type: string;
    durationMs: number;
    terminationReason: WaitTermination;
    signals: { kind: string; atMs: number }[];
  }): void {
    const action = this.current;
    if (!action) return;
    const completedAt = round(this.now() - this.runStartedAt);
    const lastEvidence = Math.min(
      input.durationMs,
      Math.max(
        0,
        ...input.signals.filter((signal) => !NOT_EVIDENCE.has(signal.kind)).map((signal) => signal.atMs),
      ),
    );
    const met = input.terminationReason === 'CONDITION_MET';
    const after = Math.max(0, input.durationMs - lastEvidence);
    action.waits.push({
      type: input.type,
      startedAt: completedAt - round(input.durationMs),
      completedAt,
      durationMs: round(input.durationMs),
      terminationReason: input.terminationReason,
      signalsObserved: input.signals.map((signal) => `${signal.kind}@${String(round(signal.atMs))}`),
      usefulWaitMs: round(lastEvidence),
      confirmationWaitMs: round(met ? after : 0),
      wastedWaitMs: round(met ? 0 : after),
    });
  }

  /** Le chemin profond, et pourquoi (une fois par raison). */
  deep(reason: string): void {
    const action = this.current;
    if (!action) return;
    action.path = 'DEEP_PATH';
    if (!action.deepReasons.includes(reason)) action.deepReasons.push(reason);
  }

  cache(hit: boolean): void {
    if (!this.current) return;
    if (hit) this.current.cache.hits += 1;
    else this.current.cache.misses += 1;
  }

  ai(durationMs: number): void {
    const action = this.current;
    if (!action) return;
    action.ai = {
      calls: (action.ai?.calls ?? 0) + 1,
      durationMs: (action.ai?.durationMs ?? 0) + round(durationMs),
    };
  }

  /** L'action est terminée : sa trace, avec ses avertissements. */
  endAction(status?: string): ActionPerformanceTrace | undefined {
    const action = this.current;
    if (!action) return undefined;
    this.current = undefined;
    action.completedAt = this.now();
    action.totalDurationMs = round(action.completedAt - action.startedAt);
    action.startedAt = round(action.startedAt - this.runStartedAt);
    action.completedAt = round(action.completedAt - this.runStartedAt);
    if (status) action.status = status;
    const recovery = action.phases.filter((phase) => phase.name === 'recovery');
    if (recovery.length > 0)
      action.recovery = {
        durationMs: recovery.reduce((sum, phase) => sum + phase.durationMs, 0),
        ...(recovery.at(-1)?.outcome ? { outcome: recovery.at(-1)?.outcome } : {}),
      };
    const waiting = action.waits.reduce((sum, wait) => sum + wait.durationMs, 0);
    if (action.totalDurationMs > 0 && waiting / action.totalDurationMs >= 0.6 && waiting >= 1000)
      action.warnings.push({
        code: 'MOSTLY_WAITING',
        message: `${String(Math.round((waiting / action.totalDurationMs) * 100))}% of execution time spent waiting`,
      });
    this.done.push(action);
    return action;
  }

  traces(): readonly ActionPerformanceTrace[] {
    return this.done;
  }

  elapsed(): number {
    return round(this.now() - this.runStartedAt);
  }
}

export type SlowActionReason =
  | 'SLOW_TARGET_RESOLUTION'
  | 'SLOW_LOCATOR_WAIT'
  | 'SLOW_BROWSER_ACTION'
  | 'SLOW_TRANSITION'
  | 'SLOW_UI_STABILIZATION'
  | 'SLOW_NETWORK'
  | 'SLOW_EFFECT_VERIFICATION'
  | 'SLOW_RECOVERY'
  | 'SLOW_STATIC_ANALYSIS'
  | 'SLOW_KNOWLEDGE_LOOKUP'
  | 'SLOW_REPORTING'
  | 'SLOW_AI'
  | 'UNKNOWN_SLOWDOWN';

export interface SlowAction {
  actionId: string;
  step: number;
  description: string;
  phase: string;
  durationMs: number;
  reason: SlowActionReason;
  evidence: string[];
}

const REASON_OF: Record<string, SlowActionReason> = {
  'target-resolution': 'SLOW_TARGET_RESOLUTION',
  'candidate-discovery': 'SLOW_TARGET_RESOLUTION',
  'fingerprint-matching': 'SLOW_TARGET_RESOLUTION',
  'locator-wait': 'SLOW_LOCATOR_WAIT',
  execute: 'SLOW_BROWSER_ACTION',
  'transition-wait': 'SLOW_TRANSITION',
  'next-target-probe': 'SLOW_TRANSITION',
  'state-observation': 'SLOW_UI_STABILIZATION',
  'effect-verification': 'SLOW_EFFECT_VERIFICATION',
  'fill-verification': 'SLOW_EFFECT_VERIFICATION',
  recovery: 'SLOW_RECOVERY',
  'static-analysis': 'SLOW_STATIC_ANALYSIS',
  'knowledge-lookup': 'SLOW_KNOWLEDGE_LOOKUP',
  'functional-observation': 'SLOW_KNOWLEDGE_LOOKUP',
  'cognitive-observation': 'SLOW_KNOWLEDGE_LOOKUP',
  screenshot: 'SLOW_REPORTING',
  ai: 'SLOW_AI',
};

/** SLOW ACTION DETECTOR : une action plus lente que le seuil — dans quelle phase, et pourquoi. */
export function detectSlowAction(trace: ActionPerformanceTrace, thresholdMs: number): SlowAction | undefined {
  if (trace.totalDurationMs < thresholdMs) return undefined;
  const byPhase = new Map<string, number>();
  for (const phase of trace.phases.filter((entry) => !entry.parent))
    byPhase.set(phase.name, (byPhase.get(phase.name) ?? 0) + phase.durationMs);
  const [name, duration] = [...byPhase.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0];
  // Une phase qui n'explique pas la moitié du temps : le ralentissement est ailleurs (non instrumenté).
  const reason: SlowActionReason =
    duration < trace.totalDurationMs * 0.4 ? 'UNKNOWN_SLOWDOWN' : (REASON_OF[name] ?? 'UNKNOWN_SLOWDOWN');
  const wait = trace.waits.find((entry) => entry.type === 'transition');
  const evidence = [
    `${name} ${String(duration)} ms of ${String(trace.totalDurationMs)} ms`,
    ...(wait
      ? [
          `transition wait ${String(wait.durationMs)} ms → ${wait.terminationReason}${wait.wastedWaitMs ? ` (${String(wait.wastedWaitMs)} ms without new evidence)` : ''}`,
          `signals: ${wait.signalsObserved.slice(0, 8).join(', ') || 'none'}`,
        ]
      : []),
    ...(trace.deepReasons.length > 0 ? [`DEEP_PATH: ${trace.deepReasons.join(', ')}`] : []),
  ];
  return {
    actionId: trace.actionId,
    step: trace.step,
    description: trace.description,
    phase: name,
    durationMs: trace.totalDurationMs,
    reason,
    evidence,
  };
}

export interface PerformanceSummary {
  totalRunMs: number;
  actions: number;
  buckets: { name: string; durationMs: number; share: number }[];
  fastPath: number;
  deepPath: number;
  cache: { hits: number; misses: number; ratio: number };
  medianActionMs: number;
  p95ActionMs: number;
  averageActionMs: number;
  waitMs: number;
  usefulWaitMs: number;
  confirmationWaitMs: number;
  wastedWaitMs: number;
  timeouts: number;
  recoveries: number;
  slowest: { step: number; description: string; durationMs: number; cause: string }[];
  topPhases: { name: string; durationMs: number; count: number }[];
}

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

/** PERFORMANCE SUMMARY : où est parti le temps du run. */
export function summarizePerformance(
  traces: readonly ActionPerformanceTrace[],
  totalRunMs: number,
): PerformanceSummary {
  const buckets = new Map<string, number>();
  const phases = new Map<string, { durationMs: number; count: number }>();
  for (const trace of traces)
    for (const phase of trace.phases) {
      const bucket = PHASE_BUCKETS[phase.name] ?? 'Other';
      // Une phase imbriquée est déjà dans le temps de sa phase parente.
      if (!phase.parent) buckets.set(bucket, (buckets.get(bucket) ?? 0) + phase.durationMs);
      const entry = phases.get(phase.name) ?? { durationMs: 0, count: 0 };
      entry.durationMs += phase.durationMs;
      entry.count += 1;
      phases.set(phase.name, entry);
    }
  const measured = [...buckets.values()].reduce((sum, value) => sum + value, 0);
  const actionTotal = traces.reduce((sum, trace) => sum + trace.totalDurationMs, 0);
  if (actionTotal > measured) buckets.set('Other (not instrumented)', actionTotal - measured);
  const waits = traces.flatMap((trace) => trace.waits);
  const durations = traces.map((trace) => trace.totalDurationMs);
  const hits = traces.reduce((sum, trace) => sum + trace.cache.hits, 0);
  const misses = traces.reduce((sum, trace) => sum + trace.cache.misses, 0);
  return {
    totalRunMs,
    actions: traces.length,
    buckets: [...buckets.entries()]
      .map(([name, durationMs]) => ({
        name,
        durationMs,
        share: totalRunMs > 0 ? durationMs / totalRunMs : 0,
      }))
      .sort((a, b) => b.durationMs - a.durationMs),
    fastPath: traces.filter((trace) => trace.path === 'FAST_PATH').length,
    deepPath: traces.filter((trace) => trace.path === 'DEEP_PATH').length,
    cache: { hits, misses, ratio: hits + misses > 0 ? hits / (hits + misses) : 0 },
    medianActionMs: percentile(durations, 50),
    p95ActionMs: percentile(durations, 95),
    averageActionMs: durations.length > 0 ? Math.round(actionTotal / durations.length) : 0,
    waitMs: waits.reduce((sum, wait) => sum + wait.durationMs, 0),
    usefulWaitMs: waits.reduce((sum, wait) => sum + (wait.usefulWaitMs ?? 0), 0),
    confirmationWaitMs: waits.reduce((sum, wait) => sum + (wait.confirmationWaitMs ?? 0), 0),
    wastedWaitMs: waits.reduce((sum, wait) => sum + (wait.wastedWaitMs ?? 0), 0),
    timeouts: waits.filter((wait) => wait.terminationReason === 'MAX_TIMEOUT').length,
    recoveries: traces.filter((trace) => trace.recovery).length,
    slowest: [...traces]
      .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
      .slice(0, 5)
      .map((trace) => ({
        step: trace.step,
        description: trace.description,
        durationMs: trace.totalDurationMs,
        cause: trace.waits.find((wait) => wait.terminationReason === 'MAX_TIMEOUT')
          ? 'TRANSITION_TIMEOUT'
          : trace.recovery
            ? 'RECOVERY'
            : ([...trace.phases].sort((a, b) => b.durationMs - a.durationMs)[0]?.name ?? '—').toUpperCase(),
      })),
    topPhases: [...phases.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10),
  };
}

/** Le résumé en texte (rapport, console). */
export function summaryText(summary: PerformanceSummary): string[] {
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const pct = (share: number): string => `${(share * 100).toFixed(1)} %`;
  return [
    'PERFORMANCE SUMMARY',
    `Total runtime               ${s(summary.totalRunMs)}`,
    ...summary.buckets.map(
      (bucket) => `${bucket.name.padEnd(28)}${s(bucket.durationMs)} (${pct(bucket.share)})`,
    ),
    `FAST_PATH actions: ${String(summary.fastPath)} / ${String(summary.actions)}`,
    `DEEP_PATH actions: ${String(summary.deepPath)} / ${String(summary.actions)}`,
    `Cache: hits ${String(summary.cache.hits)}, misses ${String(summary.cache.misses)}`,
    `Action duration: median ${String(summary.medianActionMs)} ms, p95 ${String(summary.p95ActionMs)} ms`,
    `Waiting: ${s(summary.waitMs)} (until last evidence ${s(summary.usefulWaitMs)}, confirmation after evidence ${s(summary.confirmationWaitMs)}, wasted ${s(summary.wastedWaitMs)})`,
    'Slowest actions:',
    ...summary.slowest.map(
      (entry) =>
        `  #${String(entry.step)} ${entry.description} — ${String(entry.durationMs)} ms ${entry.cause}`,
    ),
  ];
}

/** PERFORMANCE WATERFALL d'une action. */
export function waterfall(trace: ActionPerformanceTrace): string[] {
  const max = Math.max(1, ...trace.phases.map((phase) => phase.durationMs));
  const lines = trace.phases.map(
    (phase) =>
      `${phase.name.padEnd(22)}${'█'.repeat(Math.max(1, Math.round((phase.durationMs / max) * 30)))} ${String(phase.durationMs)}ms${phase.outcome ? ` (${phase.outcome})` : ''}`,
  );
  return [
    `STEP ${String(trace.step)} ${trace.description} [${trace.path}]`,
    ...lines,
    `Total ${String(trace.totalDurationMs)}ms`,
    ...trace.warnings.map((warning) => `WARNING: ${warning.message}`),
  ];
}

/** PERFORMANCE REGRESSION : comparé à une baseline (performance-baseline.json). */
export interface PerformanceBaseline {
  totalRunMs: number;
  medianActionMs: number;
  p95ActionMs: number;
  waitMs: number;
  recoveryMs: number;
  targetResolutionMs: number;
}

export function baselineOf(summary: PerformanceSummary): PerformanceBaseline {
  const bucket = (name: string): number =>
    summary.buckets.find((entry) => entry.name === name)?.durationMs ?? 0;
  return {
    totalRunMs: summary.totalRunMs,
    medianActionMs: summary.medianActionMs,
    p95ActionMs: summary.p95ActionMs,
    waitMs: summary.waitMs,
    recoveryMs: bucket('Recovery'),
    targetResolutionMs: bucket('Target resolution'),
  };
}

export function compareToBaseline(
  current: PerformanceBaseline,
  baseline: PerformanceBaseline,
  /** Au-delà de ce ratio ET d'un écart absolu notable : régression. */
  tolerance = 1.3,
): { metric: keyof PerformanceBaseline; baseline: number; current: number; ratio: number }[] {
  return (Object.keys(baseline) as (keyof PerformanceBaseline)[])
    .map((metric) => ({
      metric,
      baseline: baseline[metric],
      current: current[metric],
      ratio: baseline[metric] > 0 ? current[metric] / baseline[metric] : current[metric] > 0 ? Infinity : 1,
    }))
    .filter((entry) => entry.ratio > tolerance && entry.current - entry.baseline > 500);
}

/**
 * Mesure des méthodes EXISTANTES (sans toucher leur code ni leurs appelants) : chaque appel devient
 * une phase de l'action courante ; une méthode « profonde » marque l'action DEEP_PATH.
 */
export function instrumentMethods(
  target: object,
  tracer: PerformanceTracer,
  phases: Record<string, { phase: string; deep?: string }>,
): void {
  const host = target as Record<string, unknown>;
  for (const [name, spec] of Object.entries(phases)) {
    const original = host[name];
    if (typeof original !== 'function') continue;
    const method = original as (...args: unknown[]) => unknown;
    host[name] = (...args: unknown[]): unknown => {
      if (spec.deep) tracer.deep(spec.deep);
      return tracer.track(spec.phase, () => method.apply(target, args));
    };
  }
}

/** Le contenu de performance.json : résumé, actions lentes, waterfalls et traces complètes. */
export interface PerformanceReport {
  summary: PerformanceSummary;
  slowActions: SlowAction[];
  waterfalls: string[][];
  actions: readonly ActionPerformanceTrace[];
}

export function performanceReportOf(
  traces: readonly ActionPerformanceTrace[],
  totalRunMs: number,
  slowActionThresholdMs: number,
): PerformanceReport {
  const slowActions = traces.flatMap((trace) => detectSlowAction(trace, slowActionThresholdMs) ?? []);
  const slowIds = new Set(slowActions.map((entry) => entry.actionId));
  return {
    summary: summarizePerformance(traces, totalRunMs),
    slowActions,
    waterfalls: traces.filter((trace) => slowIds.has(trace.actionId)).map(waterfall),
    actions: traces,
  };
}
