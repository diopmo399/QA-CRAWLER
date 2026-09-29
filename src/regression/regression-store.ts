import type { ScenarioConfig } from '../config/config.js';
import type { FlowGraphData } from '../model/flow.js';
import type { FlowRunReport } from '../model/flow-run.js';
import type { Issue } from '../model/issue.js';
import type { KeyedRecord } from '../persistence/model.js';
import type { PersistenceProvider } from '../persistence/persistence-provider.js';
import {
  lifecycleCounts,
  updateLifecycle,
  type AnomalyRecord,
  type AnomalyStatus,
  type LifecycleEvent,
  type LifecycleRunInfo,
} from './anomaly-lifecycle.js';
import {
  evolveFlows,
  type ElementEvolution,
  type EvolutionChangeView,
  type EvolutionKind,
  type EvolutionRunInfo,
} from './flow-evolution.js';

/** Ce que le rapport montre de la régression intelligente (évolution, anomalies). */
export interface RegressionReport {
  /** Pourquoi rien n'a été calculé (pas de persistance, mémoire coupée, stockage en erreur). */
  skipped?: string;
  evolution?: {
    tracked: Record<EvolutionKind, number>;
    /** Éléments disparus (connus de l'historique). */
    disappeared: number;
    changes: EvolutionChangeView[];
    /** Les flows imposés : versions traversées, changements de chemin. */
    flows: { name: string; versionCount: number; runs: number; pathChanges: number; firstSeen: string }[];
  };
  anomalies?: {
    counts: Record<AnomalyStatus, number>;
    /** Les anomalies touchées par ce run (vues, ou vérifiées absentes). */
    entries: Pick<
      AnomalyRecord,
      | 'id'
      | 'type'
      | 'severity'
      | 'message'
      | 'status'
      | 'firstSeen'
      | 'lastSeen'
      | 'occurrenceCount'
      | 'runsSeen'
      | 'environments'
      | 'actors'
      | 'reproductionPath'
      | 'cleanChecks'
      | 'reopenedCount'
    >[];
    events: LifecycleEvent[];
    /** Le statut de chaque anomalie de ce run, par id d'issue. */
    byIssue: Record<string, { anomalyId: string; status: AnomalyStatus }>;
  };
}

export interface RegressionInput {
  provider: PersistenceProvider;
  applicationId: string;
  config: ScenarioConfig;
  graph: FlowGraphData;
  flows: readonly FlowRunReport[];
  issues: readonly Issue[];
  run: EvolutionRunInfo & LifecycleRunInfo;
}

/**
 * Charge l'historique (une ligne par élément), calcule ce run, enregistre ce qui a changé.
 * Tout passe par le provider (déjà nettoyé) : jamais une requête depuis le moteur.
 */
export async function runRegression(input: RegressionInput): Promise<RegressionReport> {
  const { provider, applicationId, config, run } = input;
  const report: RegressionReport = {};
  const settings = config.regression;

  if (settings.flowEvolution.enabled) {
    const previous = (await provider.evolution.load(applicationId, settings.flowEvolution.loadLimit)).flatMap(
      (record) => evolutionOf(record),
    );
    const evolved = evolveFlows(previous, input.graph, input.flows, run, {
      historyLimit: settings.flowEvolution.historyLimit,
    });
    await provider.evolution.save(evolved.records.map((record) => keyedOfEvolution(applicationId, record)));
    const all = new Map(previous.map((record) => [record.key, record]));
    for (const record of evolved.records) all.set(record.key, record);
    const tracked: Record<EvolutionKind, number> = { STATE: 0, TRANSITION: 0, FLOW: 0 };
    let disappeared = 0;
    for (const record of all.values()) {
      tracked[record.kind] += 1;
      if (record.status === 'DISAPPEARED') disappeared += 1;
    }
    report.evolution = {
      tracked,
      disappeared,
      changes: evolved.changes,
      flows: [...all.values()]
        .filter((record) => record.kind === 'FLOW')
        .map((record) => ({
          name: record.label,
          versionCount: record.versionCount,
          runs: record.runs,
          pathChanges: record.history.filter((event) => event.change === 'PATH_CHANGED').length,
          firstSeen: record.firstSeen.at,
        })),
    };
  }

  if (settings.anomalyLifecycle.enabled) {
    const previous = (
      await provider.anomalies.load(applicationId, settings.anomalyLifecycle.loadLimit)
    ).flatMap((record) => anomalyOf(record));
    const updated = updateLifecycle(previous, input.issues, input.graph, run, {
      resolveAfterChecks: settings.anomalyLifecycle.resolveAfterChecks,
      flakyAfterFlips: settings.anomalyLifecycle.flakyAfterFlips,
      historyLimit: settings.flowEvolution.historyLimit,
    });
    await provider.anomalies.save(updated.records.map((record) => keyedOfAnomaly(applicationId, record)));
    const all = new Map(previous.map((record) => [record.key, record]));
    for (const record of updated.records) all.set(record.key, record);
    report.anomalies = {
      counts: lifecycleCounts([...all.values()]),
      entries: updated.records.map((record) => ({
        id: record.id,
        type: record.type,
        severity: record.severity,
        message: record.message,
        status: record.status,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        occurrenceCount: record.occurrenceCount,
        runsSeen: record.runsSeen,
        environments: record.environments,
        actors: record.actors,
        reproductionPath: record.reproductionPath,
        cleanChecks: record.cleanChecks,
        reopenedCount: record.reopenedCount,
      })),
      events: updated.events,
      byIssue: Object.fromEntries(
        Object.entries(updated.byIssue).map(([id, entry]) => [
          id,
          { anomalyId: entry.anomalyId, status: entry.status },
        ]),
      ),
    };
  }
  return report;
}

function keyedOfEvolution(applicationId: string, record: ElementEvolution): KeyedRecord {
  return {
    applicationId,
    key: record.key,
    status: record.status,
    firstSeenAt: record.firstSeen.at,
    lastSeenAt: record.lastSeen.at,
    data: record as unknown as Record<string, unknown>,
  };
}

function keyedOfAnomaly(applicationId: string, record: AnomalyRecord): KeyedRecord {
  return {
    applicationId,
    key: record.key,
    status: record.status,
    firstSeenAt: record.firstSeen.at,
    lastSeenAt: record.lastSeen.at,
    data: record as unknown as Record<string, unknown>,
  };
}

/** Une ligne relue : gardée seulement si sa forme est celle attendue (jamais d'erreur au chargement). */
function evolutionOf(record: KeyedRecord): ElementEvolution[] {
  const data = record.data as Partial<ElementEvolution>;
  if (!data.kind || !data.firstSeen || !data.lastSeen || !Array.isArray(data.history) || !data.snapshot)
    return [];
  return [
    {
      ...(data as ElementEvolution),
      key: record.key,
      status: record.status === 'DISAPPEARED' ? 'DISAPPEARED' : 'PRESENT',
    },
  ];
}

function anomalyOf(record: KeyedRecord): AnomalyRecord[] {
  const data = record.data as Partial<AnomalyRecord>;
  if (
    !data.id ||
    !data.firstSeen ||
    !data.lastSeen ||
    !Array.isArray(data.stateIds) ||
    !Array.isArray(data.history)
  )
    return [];
  return [{ ...(data as AnomalyRecord), key: record.key, status: record.status as AnomalyStatus }];
}
