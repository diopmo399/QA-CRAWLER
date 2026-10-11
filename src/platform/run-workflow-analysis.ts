import type { RunAnalysis } from '../analysis/run-analysis.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import { analyzeAnomalies, defects } from './anomaly-analyzer.js';
import { buildFunctionalCoverage, type FunctionalCoverageGraph } from './functional-coverage.js';
import {
  countBy,
  ANOMALY_CATEGORIES,
  type AnalysisPath,
  type AnomalyCategory,
  type Finding,
  type OverallStatus,
  type RunAnomaly,
} from './model.js';
import { buildWorkflowGraph, type ObservedWorkflowGraph } from './workflow-graph.js';

/**
 * RUN WORKFLOW ANALYSIS : le rapport unique d'un run de workflow.
 *
 *   RUN → EXECUTION MODEL → OBSERVED GRAPH → ANOMALIES (symptôme / cause) → COUVERTURE →
 *   [API, VISUEL, PERFORMANCE, ACTEURS, RÉGRESSION, REPRODUCTIONS] → OVERALL_STATUS
 *
 * Ce qui existait : la RunAnalysis (verdict fonctionnel et chaîne causale), les flows, les
 * anomalies, le moteur cognitif, l'intelligence fonctionnelle, la régression. Ce qui est
 * nouveau : le modèle d'exécution compact (`run.json`), les anomalies catégorisées
 * (`anomalies.json`), le graphe observé (`workflow-graph.json`), la couverture fonctionnelle
 * (`functional-coverage.json`) et le STATUT GLOBAL en cinq valeurs, expliqué par des conclusions
 * (Conclusion / Evidence / Confidence / Source). Les analyses des phases suivantes (API, visuel,
 * performance, acteurs, régression, reproductions, tests générés) s'y branchent par des champs
 * optionnels : chacune reste un module pur, la composition se fait ici.
 *
 * FAST PATH : aucun défaut, aucune divergence, aucune récupération → l'analyse profonde n'est pas
 * déroulée (les champs restent absents). DEEP PATH : au moins un signal l'exige.
 */

export interface RunExecutionStep {
  index: number;
  kind: string;
  description: string;
  status: string;
  stateId?: string;
  url?: string;
  durationMs: number;
  effect?: string;
  network?: { requests: number; writes: number; errors: number };
  /** Clés des données de test citées, jamais des valeurs. */
  testData?: string[];
  screenshot?: string;
}

export interface RunExecutionFlow {
  name: string;
  status: string;
  startedAt: string;
  durationMs: number;
  steps: RunExecutionStep[];
  states: string[];
  divergence?: { step: number; reason: string; category?: string };
  recovered?: boolean;
  businessProof?: string;
}

/** Le modèle d'exécution : ce qui s'est passé, compact, sans aucune valeur saisie. */
export interface RunExecutionModel {
  runId: string;
  mission: string;
  mode: string;
  target: { baseUrl: string; startUrl: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: string;
  actor: string;
  environment?: string;
  version?: string;
  flows: RunExecutionFlow[];
  exploration: {
    states: number;
    transitions: number;
    actionsExecuted: number;
    actionsFailed: number;
    actionsBlocked: number;
  };
  mutations: { executed: number; autonomous: number; flows: number };
  intelligence?: { mode: string; calls: number; accepted: number };
}

export interface AnomalySummary {
  total: number;
  defects: number;
  expected: number;
  byCategory: Record<AnomalyCategory, number>;
  bySeverity: Record<RunAnomaly['severity'], number>;
}

/** Un fichier d'artefact posé par une analyse optionnelle (api-analysis.json, visual-analysis.json…). */
export interface ExtensionFile {
  name: string;
  data: unknown;
}

export interface RunWorkflowAnalysisReport {
  overallStatus: OverallStatus;
  /** Pourquoi ce statut : la première raison est déterminante. */
  statusReasons: string[];
  path: AnalysisPath;
  /** Le verdict fonctionnel de la RunAnalysis, quand elle existe. */
  verdict?: RunAnalysis['status'];
  execution: RunExecutionModel;
  anomalies: RunAnomaly[];
  anomalySummary: AnomalySummary;
  workflowGraph: ObservedWorkflowGraph;
  functionalCoverage: FunctionalCoverageGraph;
  /** Les conclusions explicables du run, dans l'ordre d'importance. */
  findings: Finding[];
  /** Les analyses optionnelles (phases 5 à 12), chacune dans son fichier : le reporter les écrit telles quelles. */
  extensionFiles?: Record<string, ExtensionFile>;
  /** Les fichiers écrits (reporter), par nom logique. */
  artifacts: Record<string, string>;
}

const FAILING_VERDICTS = new Set<RunAnalysis['status']>(['DIVERGED', 'BLOCKED']);
const DEGRADING_CATEGORIES = new Set<AnomalyCategory>(['PERFORMANCE_REGRESSION', 'VISUAL_REGRESSION']);

function executionModelOf(result: ExplorationResult): RunExecutionModel {
  const settings = result.settings as { authorization?: { primaryActor?: string }; environment?: string };
  const environment = result.baseline?.environment ?? result.learnedBaseline?.environment;
  const identity = result.intelligence?.knowledge?.identity;
  const version = identity?.commit ?? identity?.appVersion;
  return {
    runId: result.runId ?? '',
    mission: result.mission,
    mode: result.mode,
    target: result.target,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    stopReason: result.stopReason,
    actor: result.authorization?.primaryActor ?? settings.authorization?.primaryActor ?? 'primary',
    ...(environment ? { environment } : {}),
    ...(version ? { version } : {}),
    flows: result.flows.map((flow) => ({
      name: flow.name,
      status: flow.status,
      startedAt: flow.startedAt,
      durationMs: flow.durationMs,
      steps: flow.steps.map((step) => ({
        index: step.index,
        kind: step.kind,
        description: step.description,
        status: step.status,
        ...(step.stateId ? { stateId: step.stateId } : {}),
        ...(step.url ? { url: step.url } : {}),
        durationMs: step.durationMs,
        ...(step.effect ? { effect: step.effect.status } : {}),
        ...(step.network
          ? {
              network: {
                requests: step.network.requests.length,
                writes: step.network.writes,
                errors: step.network.errors,
              },
            }
          : {}),
        ...(step.testData && step.testData.length > 0 ? { testData: step.testData } : {}),
        ...(step.screenshot ? { screenshot: step.screenshot } : {}),
      })),
      states: flow.states,
      ...(flow.divergence
        ? {
            divergence: {
              step: flow.divergence.stepIndex,
              reason: flow.divergence.reason,
              ...(flow.divergence.probableCause ? { category: flow.divergence.probableCause.category } : {}),
            },
          }
        : {}),
      ...(flow.drift && /^PASS_WITH_/.test(flow.drift.result) ? { recovered: true } : {}),
      ...(flow.businessProof && flow.businessProof.status !== 'NOT_APPLICABLE'
        ? { businessProof: flow.businessProof.status }
        : {}),
    })),
    exploration: {
      states: result.stats.states,
      transitions: result.stats.transitions,
      actionsExecuted: result.stats.actionsExecuted,
      actionsFailed: result.stats.actionsFailed,
      actionsBlocked: result.stats.actionsBlocked,
    },
    mutations: {
      executed: result.mutations?.executed ?? 0,
      autonomous: result.mutations?.autonomous ?? 0,
      flows: result.mutations?.flows ?? 0,
    },
    ...(result.ai
      ? { intelligence: { mode: result.ai.mode, calls: result.ai.calls, accepted: result.ai.accepted } }
      : {}),
  };
}

function summarize(anomalies: readonly RunAnomaly[]): AnomalySummary {
  const own = defects(anomalies);
  return {
    total: anomalies.length,
    defects: own.length,
    expected: anomalies.filter((anomaly) => anomaly.severity === 'INFO').length,
    byCategory: countBy(
      ANOMALY_CATEGORIES,
      anomalies.map((anomaly) => anomaly.category),
    ),
    bySeverity: countBy(
      ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const,
      anomalies.map((anomaly) => anomaly.severity),
    ),
  };
}

export interface OverallStatusInput {
  verdict?: RunAnalysis['status'];
  anomalies: readonly RunAnomaly[];
  flows: number;
  states: number;
  /** Posés par les phases 7 à 9 : une régression visuelle ou de performance DÉGRADE, une nouvelle régression ÉCHOUE. */
  signals?: {
    visualRegressions?: number;
    performanceRegressions?: number;
    newRegressions?: number;
    fixedRegressions?: number;
    flaky?: number;
  };
}

/**
 * Le STATUT GLOBAL, par règles explicites (la première qui s'applique) :
 *   INCONCLUSIVE  rien ne permet de conclure (verdict INCONCLUSIVE, rien n'a été parcouru) ;
 *   FAIL          un flow a divergé ou a été bloqué, un défaut ERROR/CRITICAL, une nouvelle régression ;
 *   DEGRADED      réussi mais dégradé : récupération nécessaire, régression de performance ou visuelle ;
 *   PASS_WITH_WARNINGS  réussi avec des avertissements (défaut WARNING, effet non vérifié, comportement instable) ;
 *   PASS          rien à signaler.
 */
export function overallStatusOf(input: OverallStatusInput): { status: OverallStatus; reasons: string[] } {
  const own = defects(input.anomalies);
  const blocking = own.filter(
    (anomaly) =>
      (anomaly.severity === 'ERROR' || anomaly.severity === 'CRITICAL') &&
      !DEGRADING_CATEGORIES.has(anomaly.category),
  );
  const signals = input.signals ?? {};
  if (input.verdict === 'INCONCLUSIVE')
    return { status: 'INCONCLUSIVE', reasons: ['the functional verdict is inconclusive'] };
  if (input.flows === 0 && input.states === 0)
    return { status: 'INCONCLUSIVE', reasons: ['nothing was executed: no flow, no screen reached'] };
  const fail: string[] = [];
  if (input.verdict && FAILING_VERDICTS.has(input.verdict)) fail.push(`functional verdict ${input.verdict}`);
  if (blocking.length > 0)
    fail.push(
      `${String(blocking.length)} blocking defect(s): ${[...new Set(blocking.map((anomaly) => anomaly.category))].join(', ')}`,
    );
  if ((signals.newRegressions ?? 0) > 0) fail.push(`${String(signals.newRegressions)} new regression(s)`);
  if (fail.length > 0) return { status: 'FAIL', reasons: fail };
  const degraded: string[] = [];
  if (input.verdict === 'PASSED_WITH_RECOVERY') degraded.push('the flows passed only thanks to a recovery');
  if ((signals.performanceRegressions ?? 0) > 0)
    degraded.push(`${String(signals.performanceRegressions)} performance regression(s)`);
  if ((signals.visualRegressions ?? 0) > 0)
    degraded.push(`${String(signals.visualRegressions)} visual regression(s)`);
  const degradingAnomalies = own.filter((anomaly) => DEGRADING_CATEGORIES.has(anomaly.category));
  if (degradingAnomalies.length > 0 && degraded.length === 0)
    degraded.push(`${String(degradingAnomalies.length)} performance or visual anomaly(ies)`);
  if (degraded.length > 0) return { status: 'DEGRADED', reasons: degraded };
  const warnings: string[] = [];
  if (own.length > 0) warnings.push(`${String(own.length)} warning-level defect(s)`);
  if (input.verdict === 'PASSED_UNVERIFIED') warnings.push('an expected effect could not be verified');
  if ((signals.flaky ?? 0) > 0) warnings.push(`${String(signals.flaky)} unstable behaviour(s)`);
  if (warnings.length > 0) return { status: 'PASS_WITH_WARNINGS', reasons: warnings };
  return {
    status: 'PASS',
    reasons: [
      input.verdict === 'PROVEN'
        ? 'every flow passed and the business proof is made'
        : `${String(input.flows)} flow(s) passed, ${String(input.anomalies.length)} anomaly(ies), none a defect`,
    ],
  };
}

function findingsOf(
  result: ExplorationResult,
  anomalies: readonly RunAnomaly[],
  status: { status: OverallStatus; reasons: string[] },
): Finding[] {
  const findings: Finding[] = [
    {
      conclusion: `overall status ${status.status}`,
      evidence: status.reasons,
      confidence: 1,
      source: 'RUNTIME',
    },
  ];
  const analysis = result.runAnalysis;
  if (analysis)
    findings.push({
      conclusion: `functional verdict ${analysis.status}: ${analysis.summary.headline}`,
      evidence: analysis.explainability.verdictReasons,
      confidence: 1,
      source: 'RUNTIME',
    });
  if (analysis?.rootCause)
    findings.push({
      conclusion: `root cause ${analysis.rootCause.category} at step ${String(analysis.rootCause.step)}`,
      evidence: analysis.rootCause.evidence.map((entry) => `${entry.source}: ${entry.detail}`),
      confidence: analysis.rootCause.confidence,
      source: 'RUNTIME',
    });
  for (const anomaly of defects(anomalies).slice(0, 10))
    findings.push({
      conclusion: `${anomaly.category}: ${anomaly.symptom}`,
      evidence: anomaly.evidence,
      confidence: anomaly.confidence,
      source: anomaly.source,
    });
  return findings;
}

/** Le rapport d'analyse du run (phases 1 à 3) ; les autres phases l'étendent par `extend`. */
export function buildRunWorkflowAnalysis(result: ExplorationResult): RunWorkflowAnalysisReport {
  const anomalies = analyzeAnomalies(result);
  const verdict = result.runAnalysis?.status;
  const status = overallStatusOf({
    ...(verdict ? { verdict } : {}),
    anomalies,
    flows: result.flows.length,
    states: result.states.length,
  });
  const recoveries = result.flows.filter((flow) => flow.steps.some((step) => step.recovery)).length;
  const path: AnalysisPath =
    defects(anomalies).length === 0 && !result.flows.some((flow) => flow.divergence) && recoveries === 0
      ? 'FAST'
      : 'DEEP';
  return {
    overallStatus: status.status,
    statusReasons: status.reasons,
    path,
    ...(verdict ? { verdict } : {}),
    execution: executionModelOf(result),
    anomalies,
    anomalySummary: summarize(anomalies),
    workflowGraph: buildWorkflowGraph(result),
    functionalCoverage: buildFunctionalCoverage(result),
    findings: findingsOf(result, anomalies, status),
    artifacts: {},
  };
}

/** Recalcule le statut global une fois les analyses optionnelles posées (phases 7 à 9). */
export function refreshOverallStatus(
  report: RunWorkflowAnalysisReport,
  result: ExplorationResult,
  signals: OverallStatusInput['signals'],
): void {
  const status = overallStatusOf({
    ...(report.verdict ? { verdict: report.verdict } : {}),
    anomalies: report.anomalies,
    flows: result.flows.length,
    states: result.states.length,
    ...(signals ? { signals } : {}),
  });
  report.overallStatus = status.status;
  report.statusReasons = status.reasons;
  report.anomalySummary = summarize(report.anomalies);
  report.findings = findingsOf(result, report.anomalies, status);
}

/** Branche une analyse optionnelle : son fichier, ses conclusions. */
export function attachExtension(
  report: RunWorkflowAnalysisReport,
  key: string,
  fileName: string,
  data: unknown,
  findings: readonly Finding[] = [],
): void {
  (report.extensionFiles ??= {})[key] = { name: fileName, data };
  report.findings.push(...findings);
}
