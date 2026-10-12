import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowMemoryKind, FlowMemoryRecord } from '../persistence/model.js';
import type { FlowMemoryRepository } from '../persistence/persistence-provider.js';
import type { ActorAnalysis } from './actor-analysis.js';
import type { ReproductionAnalysis } from './reproduction-planner.js';
import type { RunWorkflowAnalysisReport } from './run-workflow-analysis.js';
import type { VisualAnalysis } from './visual-analysis.js';

/**
 * FLOW MEMORY SERVICE : ce que la plateforme retient d'un run, par SORTE, dans la persistance
 * (mémoire, fichier, SQLite, PostgreSQL, SQL Server) — sans SQL dans ce code : le provider
 * traduit. Une ligne par (application, sorte, clé), remplacée sur place.
 *
 * Ce qui existait : les repositories runs / states / transitions / knowledge / evolution /
 * anomalies (PersistenceRecorder). Ce qui est nouveau : la mémoire orientée plateforme —
 * anomalies catégorisées, récupérations, acteurs, reproductions, captures visuelles,
 * performance, runs — interrogeable par sorte, statut et préfixe de clé.
 */

export interface FlowMemoryInput {
  applicationId: string;
  result: ExplorationResult;
  report: RunWorkflowAnalysisReport;
  actors?: ActorAnalysis;
  reproductions?: ReproductionAnalysis;
  visual?: VisualAnalysis;
}

const LIMIT = 200;
const key = (parts: readonly string[]): string => parts.join('|').replace(/\s+/g, ' ').slice(0, LIMIT);

/** Les enregistrements d'un run (déterministes : la même entrée donne les mêmes lignes). */
export function flowMemoryRecordsOf(input: FlowMemoryInput): FlowMemoryRecord[] {
  const { applicationId, result, report } = input;
  const at = result.finishedAt;
  const runId = result.runId ?? '';
  const row = (
    kind: FlowMemoryKind,
    parts: readonly string[],
    status: string,
    data: Record<string, unknown>,
  ): FlowMemoryRecord => ({
    applicationId,
    kind,
    key: key(parts),
    status,
    firstSeenAt: at,
    lastSeenAt: at,
    data: { runId, ...data },
  });
  const records: FlowMemoryRecord[] = [
    row('run', [runId], report.overallStatus, {
      mission: result.mission,
      mode: result.mode,
      verdict: report.verdict ?? '',
      reasons: report.statusReasons,
      path: report.path,
      durationMs: result.durationMs,
      anomalies: report.anomalySummary.total,
      defects: report.anomalySummary.defects,
    }),
  ];
  for (const state of result.states)
    records.push(
      row('state', [state.route, state.label], 'SEEN', {
        stateId: state.id,
        visits: state.visits,
        issues: state.issueIds.length,
      }),
    );
  for (const edge of result.transitions)
    records.push(
      row('transition', [edge.from, edge.actionId, edge.to], edge.result, {
        label: edge.action.label ?? edge.action.text ?? edge.action.type,
        ...(edge.flow ? { flow: edge.flow } : {}),
        ...(edge.durationMs !== undefined ? { durationMs: edge.durationMs } : {}),
      }),
    );
  for (const flow of result.flows)
    for (const step of flow.steps) {
      records.push(
        row('action', [flow.name, String(step.index), step.kind], step.status, {
          description: step.description,
          durationMs: step.durationMs,
          ...(step.effect ? { effect: step.effect.status } : {}),
        }),
      );
      if (step.recovery)
        records.push(
          row(
            'recovery',
            [flow.name, String(step.index), step.recovery.divergence.category],
            step.recovery.outcome.status,
            {
              plan: step.recovery.plan.status,
              ...(step.recovery.selected
                ? { selected: step.recovery.selected.signature, source: step.recovery.selected.source }
                : {}),
            },
          ),
        );
    }
  for (const anomaly of report.anomalies)
    records.push(
      row(
        'anomaly',
        [
          anomaly.category,
          anomaly.location.flow ?? anomaly.location.url ?? '',
          String(anomaly.location.step ?? ''),
        ],
        anomaly.regression ?? anomaly.severity,
        {
          symptom: anomaly.symptom,
          severity: anomaly.severity,
          confidence: anomaly.confidence,
          source: anomaly.source,
          ...(anomaly.probableCause ? { probableCause: anomaly.probableCause.conclusion } : {}),
          ...(anomaly.confirmedCause ? { confirmedCause: anomaly.confirmedCause.conclusion } : {}),
        },
      ),
    );
  for (const actor of input.actors?.actors ?? [])
    records.push(
      row('actor', [actor.name], actor.loginError ? 'LOGIN_ERROR' : 'OBSERVED', {
        reached: actor.reached,
        denied: actor.denied,
        ...(actor.profile ? { roles: actor.profile.roles } : {}),
        ...(actor.session ? { session: actor.session.status } : {}),
      }),
    );
  for (const diff of input.actors?.behaviorDiff ?? [])
    records.push(
      row('actor', [diff.actor, diff.label], diff.change, {
        previous: diff.previous,
        current: diff.current,
        previousRun: diff.previousRun,
      }),
    );
  for (const artifact of input.reproductions?.artifacts ?? [])
    records.push(
      row('reproduction', [artifact.anomalyId], artifact.status, {
        category: artifact.category,
        steps: artifact.path?.steps ?? [],
        testDataKeys: artifact.testDataKeys,
      }),
    );
  for (const checkpoint of input.visual?.checkpoints ?? [])
    records.push(
      row('visual', [checkpoint.flow, String(checkpoint.step)], checkpoint.verdict, {
        ...(checkpoint.difference !== undefined ? { difference: checkpoint.difference } : {}),
        ...(checkpoint.baseline ? { baseline: checkpoint.baseline } : {}),
      }),
    );
  for (const flow of result.flows)
    records.push(
      row('performance', [flow.name], flow.status, { durationMs: flow.durationMs, steps: flow.steps.length }),
    );
  return records;
}

/** Enregistre la mémoire du run ; renvoie le nombre de lignes (0 quand aucune persistance). */
export async function rememberRun(
  repository: FlowMemoryRepository | undefined,
  input: FlowMemoryInput,
): Promise<number> {
  if (!repository) return 0;
  const records = flowMemoryRecordsOf(input);
  await repository.save(records);
  return records.length;
}
