import type { ExplorationResult } from '../model/exploration-result.js';
import {
  countBy,
  EXPECTED_CATEGORIES,
  REGRESSION_STATUSES,
  type Finding,
  type RegressionStatus,
  type RunAnomaly,
} from './model.js';

/**
 * REGRESSION ANALYZER : chaque anomalie et chaque changement du run situés dans le temps.
 *
 * Ce qui existait : le cycle de vie des anomalies (NEW / KNOWN / RESOLVED / REOPENED / FLAKY, avec
 * persistance), l'évolution des flows, l'écart de chaque flow avec son run précédent
 * (FlowRunComparison), la dérive des flows (FlowDriftReport) et le diff de baseline (FlowDiff).
 * Ce qui est nouveau : un seul vocabulaire orienté décision —
 *
 *   NEW_REGRESSION        un défaut qui n'existait pas (anomalie NEW ou REOPENED, flow passé → échoué) ;
 *   REGRESSION_PERSISTING un défaut déjà connu, toujours là ;
 *   REGRESSION_FIXED      un défaut connu qui a disparu (anomalie RESOLVED, flow échoué → passé) ;
 *   FLAKY_BEHAVIOR        un comportement qui va et vient ;
 *   KNOWN_FAILURE         un échec attendu (validation, refus métier) ;
 *   NEW_BEHAVIOR          un écran ou une transition jamais vus (pas un défaut) ;
 *   EXPECTED_CHANGE       une dérive de flow que l'application assume (mise à jour du flow suggérée).
 *
 * Le runtime de ce run l'emporte ; l'historique situe. Sans persistance ni connaissance, seul
 * ce que le run sait de lui-même est utilisé (et le statut reste prudent).
 */

export interface RegressionEntry {
  status: RegressionStatus;
  subject: string;
  anomalyId?: string;
  evidence: string[];
  source: 'RUNTIME' | 'HISTORICAL';
}

export interface RegressionAnalysis {
  entries: RegressionEntry[];
  summary: Record<RegressionStatus, number>;
  /** Pour le statut global. */
  signals: { newRegressions: number; fixedRegressions: number; flaky: number };
  findings: Finding[];
}

const LIFECYCLE: Record<string, RegressionStatus> = {
  NEW: 'NEW_REGRESSION',
  REOPENED: 'NEW_REGRESSION',
  KNOWN: 'REGRESSION_PERSISTING',
  FLAKY: 'FLAKY_BEHAVIOR',
};

/** Situe les anomalies dans le temps et pose `anomaly.regression`. */
export function analyzeRegression(result: ExplorationResult, anomalies: RunAnomaly[]): RegressionAnalysis {
  const entries: RegressionEntry[] = [];
  const lifecycle = result.regression?.anomalies;
  for (const anomaly of anomalies) {
    if (anomaly.severity === 'INFO' && EXPECTED_CATEGORIES.includes(anomaly.category)) {
      anomaly.regression = 'KNOWN_FAILURE';
      continue;
    }
    const issue = anomaly.issueIds.map((id) => lifecycle?.byIssue[id]).find((entry) => entry !== undefined);
    let status: RegressionStatus | undefined;
    let evidence: string[] = [];
    let source: RegressionEntry['source'] = 'HISTORICAL';
    if (issue) {
      status = LIFECYCLE[issue.status];
      evidence = [`anomaly lifecycle ${issue.status} (${issue.anomalyId})`];
    } else if (anomaly.location.flow) {
      const flow = result.flows.find((entry) => entry.name === anomaly.location.flow);
      const previous = flow?.comparison?.previous;
      if (previous) {
        status = previous.status === 'PASSED' ? 'NEW_REGRESSION' : 'REGRESSION_PERSISTING';
        evidence = [`flow ${anomaly.location.flow} was ${previous.status} in run ${previous.runId}`];
      } else if (flow?.drift?.flowUpdateSuggested) {
        status = 'EXPECTED_CHANGE';
        evidence = [`flow drift ${flow.drift.classification}: flow update suggested`];
        source = 'RUNTIME';
      }
    }
    if (!status) {
      // Rien d'historique : le défaut est nouveau pour ce que le run sait, mais sans certitude.
      status = 'NEW_REGRESSION';
      evidence = ['no history available for this anomaly: treated as new'];
      source = 'RUNTIME';
    }
    anomaly.regression = status;
    entries.push({
      status,
      subject: `${anomaly.category}: ${anomaly.symptom}`,
      anomalyId: anomaly.id,
      evidence,
      source,
    });
  }
  for (const entry of lifecycle?.entries ?? [])
    if (entry.status === 'RESOLVED' && entry.lastSeen.run !== result.runId)
      entries.push({
        status: 'REGRESSION_FIXED',
        subject: `${entry.type}: ${entry.message}`,
        evidence: [`anomaly ${entry.id} resolved after ${String(entry.cleanChecks)} clean check(s)`],
        source: 'HISTORICAL',
      });
  for (const flow of result.flows) {
    const previous = flow.comparison?.previous;
    if (previous && previous.status !== 'PASSED' && flow.status === 'PASSED')
      entries.push({
        status: 'REGRESSION_FIXED',
        subject: `flow ${flow.name}`,
        evidence: [`was ${previous.status} in run ${previous.runId}, PASSED now`],
        source: 'HISTORICAL',
      });
    if (flow.drift?.flowUpdateSuggested && flow.status === 'PASSED')
      entries.push({
        status: 'EXPECTED_CHANGE',
        subject: `flow ${flow.name}`,
        evidence: [`drift ${flow.drift.classification}`, ...flow.drift.explanation.slice(0, 3)],
        source: 'RUNTIME',
      });
  }
  const diff = result.flowDiff;
  if (diff) {
    for (const state of diff.addedStates.slice(0, 20))
      entries.push({
        status: 'NEW_BEHAVIOR',
        subject: `new screen ${state.label}`,
        evidence: ['absent from the baseline'],
        source: 'HISTORICAL',
      });
    if (diff.addedTransitions.length > 0)
      entries.push({
        status: 'NEW_BEHAVIOR',
        subject: `${String(diff.addedTransitions.length)} new transition(s)`,
        evidence: ['absent from the baseline'],
        source: 'HISTORICAL',
      });
  }
  const summary = countBy(
    REGRESSION_STATUSES,
    entries.map((entry) => entry.status),
  );
  const findings: Finding[] = entries
    .filter(
      (entry) =>
        entry.status === 'NEW_REGRESSION' ||
        entry.status === 'REGRESSION_FIXED' ||
        entry.status === 'FLAKY_BEHAVIOR',
    )
    .slice(0, 20)
    .map((entry) => ({
      conclusion: `${entry.status}: ${entry.subject}`,
      evidence: entry.evidence,
      confidence: entry.source === 'HISTORICAL' ? 0.8 : 0.5,
      source: entry.source,
    }));
  return {
    entries,
    summary,
    signals: {
      newRegressions: entries.filter(
        (entry) => entry.status === 'NEW_REGRESSION' && entry.source === 'HISTORICAL',
      ).length,
      fixedRegressions: summary.REGRESSION_FIXED,
      flaky: summary.FLAKY_BEHAVIOR,
    },
    findings,
  };
}
