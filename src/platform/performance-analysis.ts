import type { PerformanceSample } from '../knowledge/knowledge-model.js';
import type { FlowRunReport } from '../model/flow-run.js';
import { round2, type Finding } from './model.js';

/**
 * HISTORICAL BASELINE ANALYZER (performance) : chaque durée du run confrontée à son historique.
 *
 * Ce qui existait : les durées par étape (StepTimingReport), l'écart avec le run précédent
 * (FlowRunComparison, seuils 300 ms / 50 %), les durées de la base de connaissances
 * (PerformanceKnowledge : 50 dernières, par écran / action / requête) et la baseline de
 * performance du traceur (performance.baseline, un fichier). Ce qui est nouveau : une baseline
 * HISTORIQUE par métrique de flow (`flow:<nom>`, `flow:<nom>#<étape>`), la médiane des runs
 * précédents, la tendance, le premier run où la dégradation est apparue, et la règle
 * absolue : UNE variation isolée n'est PAS une régression. PERFORMANCE_REGRESSION exige que la
 * mesure courante ET la précédente dépassent la tolérance.
 */

export type PerformanceStatus =
  'STABLE' | 'VARIATION' | 'PERFORMANCE_REGRESSION' | 'IMPROVED' | 'INSUFFICIENT_DATA';
export type PerformanceTrend = 'IMPROVING' | 'STABLE' | 'DEGRADING' | 'UNKNOWN';

export interface PerformanceMetricAnalysis {
  metric: string;
  label: string;
  currentValue: number;
  baselineValue?: number;
  percentageChange?: number;
  trend: PerformanceTrend;
  status: PerformanceStatus;
  samples: number;
  /** 0..1 : plus d'échantillons, plus de confiance. */
  confidence: number;
  firstDetectedRun?: string;
}

export interface PerformanceAnalysis {
  metrics: PerformanceMetricAnalysis[];
  summary: Record<PerformanceStatus, number> & { metrics: number };
  findings: Finding[];
}

export interface PerformanceAnalysisOptions {
  /** Facteur au-delà duquel une mesure dépasse la baseline (1.3 = +30 %). */
  tolerance: number;
  minSamples: number;
  /** Les variations sous ce plancher (ms) ne comptent jamais. */
  floorMs: number;
}

export interface PerformanceHistory {
  history(metric: string): PerformanceSample[];
}

const STATUSES: PerformanceStatus[] = [
  'STABLE',
  'VARIATION',
  'PERFORMANCE_REGRESSION',
  'IMPROVED',
  'INSUFFICIENT_DATA',
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function trendOf(values: readonly number[]): PerformanceTrend {
  if (values.length < 4) return 'UNKNOWN';
  const half = Math.floor(values.length / 2);
  const older = median(values.slice(0, half));
  const recent = median(values.slice(half));
  if (older === 0) return 'UNKNOWN';
  const change = (recent - older) / older;
  return change > 0.2 ? 'DEGRADING' : change < -0.2 ? 'IMPROVING' : 'STABLE';
}

/** Les métriques du run : la durée de chaque flow et de chaque étape exécutée. */
export function currentMetrics(
  flows: readonly FlowRunReport[],
): { metric: string; label: string; value: number }[] {
  const metrics: { metric: string; label: string; value: number }[] = [];
  for (const flow of flows) {
    metrics.push({ metric: `flow:${flow.name}`, label: `flow ${flow.name}`, value: flow.durationMs });
    for (const step of flow.steps)
      if (step.status === 'PASSED' || step.status === 'FAILED')
        metrics.push({
          metric: `flow:${flow.name}#${String(step.index)}`,
          label: `${flow.name} step ${String(step.index)} ${step.description}`,
          value: step.durationMs,
        });
  }
  return metrics;
}

/** Une métrique jugée contre son historique (les échantillons précédents, le courant exclu). */
export function judgeMetric(
  metric: { metric: string; label: string; value: number },
  previous: readonly PerformanceSample[],
  options: PerformanceAnalysisOptions,
): PerformanceMetricAnalysis {
  const samples = previous.length;
  const confidence = round2(Math.min(1, samples / (options.minSamples * 2)));
  const base = {
    metric: metric.metric,
    label: metric.label,
    currentValue: metric.value,
    samples,
    confidence,
  };
  if (samples < options.minSamples) return { ...base, trend: 'UNKNOWN', status: 'INSUFFICIENT_DATA' };
  const baselineValue = Math.round(median(previous.map((sample) => sample.value)));
  const percentageChange =
    baselineValue === 0 ? 0 : round2(((metric.value - baselineValue) / baselineValue) * 100);
  const trend = trendOf([...previous.map((sample) => sample.value), metric.value]);
  const exceeds = (value: number): boolean =>
    value > baselineValue * options.tolerance && value - baselineValue > options.floorMs;
  const last = previous[previous.length - 1];
  let status: PerformanceStatus = 'STABLE';
  let firstDetectedRun: string | undefined;
  if (exceeds(metric.value)) {
    if (last && exceeds(last.value)) {
      status = 'PERFORMANCE_REGRESSION';
      // Le premier run de la série consécutive qui dépasse.
      let index = previous.length - 1;
      while (index > 0 && exceeds(previous[index - 1]?.value ?? 0)) index -= 1;
      firstDetectedRun = previous[index]?.runId;
    } else status = 'VARIATION';
  } else if (
    metric.value < baselineValue / options.tolerance &&
    baselineValue - metric.value > options.floorMs
  )
    status = 'IMPROVED';
  return {
    ...base,
    baselineValue,
    percentageChange,
    trend,
    status,
    ...(firstDetectedRun ? { firstDetectedRun } : {}),
  };
}

/** L'analyse de performance du run, et les échantillons à enregistrer pour le run suivant. */
export function analyzePerformance(
  flows: readonly FlowRunReport[],
  history: PerformanceHistory,
  options: PerformanceAnalysisOptions,
): PerformanceAnalysis {
  const metrics = currentMetrics(flows).map((metric) =>
    judgeMetric(metric, history.history(metric.metric), options),
  );
  const summary = Object.fromEntries(
    STATUSES.map((status) => [status, metrics.filter((entry) => entry.status === status).length]),
  ) as Record<PerformanceStatus, number>;
  const findings: Finding[] = metrics
    .filter((entry) => entry.status === 'PERFORMANCE_REGRESSION' || entry.status === 'VARIATION')
    .map((entry) => ({
      conclusion: `${entry.status}: ${entry.label} ${String(entry.currentValue)} ms vs baseline ${String(entry.baselineValue ?? 0)} ms (${entry.percentageChange !== undefined && entry.percentageChange > 0 ? '+' : ''}${String(entry.percentageChange ?? 0)} %)`,
      evidence: [
        `${String(entry.samples)} previous sample(s), trend ${entry.trend}`,
        ...(entry.firstDetectedRun
          ? [`first exceeded in run ${entry.firstDetectedRun}`]
          : ['the previous run was within tolerance: an isolated variation is not a regression']),
      ],
      confidence: entry.status === 'PERFORMANCE_REGRESSION' ? entry.confidence : round2(entry.confidence / 2),
      source: 'HISTORICAL' as const,
    }));
  return { metrics, summary: { ...summary, metrics: metrics.length }, findings };
}
