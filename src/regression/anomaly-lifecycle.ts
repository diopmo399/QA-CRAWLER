import { createHash } from 'node:crypto';
import { dedupeKey } from '../anomaly/issue-collector.js';
import type { FlowGraphData } from '../model/flow.js';
import type { Issue, IssueType, Severity } from '../model/issue.js';
import type { Sighting } from './flow-evolution.js';

/**
 * ANOMALY LIFECYCLE : chaque anomalie suivie de run en run.
 *
 *   NEW       vue pour la première fois
 *   KNOWN     revue
 *   RESOLVED  absente pendant N vérifications CONSÉCUTIVES (son écran revisité, son action
 *             rejouée) — jamais parce qu'on n'est simplement pas repassé par là
 *   REOPENED  revenue après avoir été RESOLVED
 *   FLAKY     elle va et vient (absente à une vérification, puis revenue, plusieurs fois)
 *
 * La clé est celle du regroupement existant (IssueCollector) : même type, même requête,
 * même message (nombres masqués).
 */
export const ANOMALY_STATUSES = ['NEW', 'KNOWN', 'RESOLVED', 'REOPENED', 'FLAKY'] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

export interface AnomalyRecord {
  /** Clé de stockage (≤ 200 caractères). */
  key: string;
  /** Id lisible et stable : ANOMALY-1a2b3c4d. */
  id: string;
  type: IssueType;
  severity: Severity;
  message: string;
  status: AnomalyStatus;
  firstSeen: Sighting;
  lastSeen: Sighting;
  /** Occurrences cumulées sur tous les runs. */
  occurrenceCount: number;
  runsSeen: number;
  environments: string[];
  actors: string[];
  /** Chemin de reproduction : les écrans (libellés) depuis le départ. */
  reproductionPath: string[];
  /** Écrans (id) et actions (id) où l'anomalie a été vue : ce qu'une vérification doit revoir. */
  stateIds: string[];
  actionIds: string[];
  /** Vérifications consécutives sans l'anomalie. */
  cleanChecks: number;
  /** Allers-retours : absente à une vérification, puis revenue. */
  flips: number;
  reopenedCount: number;
  resolvedAt?: Sighting;
  history: { at: string; run: string; version: string; status: AnomalyStatus; detail?: string }[];
}

export interface LifecycleRunInfo extends Sighting {
  environment?: string;
  actor?: string;
}

export interface LifecycleOptions {
  resolveAfterChecks: number;
  flakyAfterFlips: number;
  historyLimit: number;
}

export type LifecycleEventKind =
  'ANOMALY_CREATED' | 'ANOMALY_RESOLVED' | 'ANOMALY_REOPENED' | 'ANOMALY_FLAKY';

export interface LifecycleEvent {
  kind: LifecycleEventKind;
  anomalyId: string;
  type: IssueType;
  message: string;
  detail: string;
}

export interface LifecycleResult {
  /** Les anomalies touchées par ce run (à enregistrer). */
  records: AnomalyRecord[];
  events: LifecycleEvent[];
  /** Le statut de chaque anomalie de ce run, par id d'issue. */
  byIssue: Record<
    string,
    { anomalyId: string; status: AnomalyStatus; firstSeen: Sighting; runsSeen: number }
  >;
}

/** La clé de stockage d'une anomalie (le regroupement de l'IssueCollector, réduit). */
export function anomalyKeyOf(issue: Issue): string {
  return createHash('sha1').update(dedupeKey(issue)).digest('hex').slice(0, 40);
}

export function updateLifecycle(
  previous: readonly AnomalyRecord[],
  issues: readonly Issue[],
  graph: FlowGraphData,
  run: LifecycleRunInfo,
  options: LifecycleOptions,
): LifecycleResult {
  const byKey = new Map(previous.map((record) => [record.key, structuredClone(record)]));
  const touched = new Map<string, AnomalyRecord>();
  const events: LifecycleEvent[] = [];
  const byIssue: LifecycleResult['byIssue'] = {};
  const sighting: Sighting = { at: run.at, run: run.run, version: run.version };
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const setStatus = (record: AnomalyRecord, status: AnomalyStatus, detail?: string): void => {
    record.status = status;
    record.history.push({ ...sighting, status, ...(detail ? { detail } : {}) });
    if (record.history.length > options.historyLimit)
      record.history.splice(0, record.history.length - options.historyLimit);
  };
  const emit = (kind: LifecycleEventKind, record: AnomalyRecord, detail: string): void => {
    events.push({ kind, anomalyId: record.id, type: record.type, message: record.message, detail });
  };

  // ---- les anomalies de ce run
  const seenKeys = new Set<string>();
  for (const issue of issues) {
    const key = anomalyKeyOf(issue);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    let record = byKey.get(key);
    const path = (issue.flow ?? (issue.stateId ? [issue.stateId] : [])).map((id) => labels.get(id) ?? id);
    if (!record) {
      record = {
        key,
        id: `ANOMALY-${key.slice(0, 8)}`,
        type: issue.type,
        severity: issue.severity,
        message: issue.message.slice(0, 300),
        status: 'NEW',
        firstSeen: sighting,
        lastSeen: sighting,
        occurrenceCount: 0,
        runsSeen: 0,
        environments: [],
        actors: [],
        reproductionPath: path,
        stateIds: [],
        actionIds: [],
        cleanChecks: 0,
        flips: 0,
        reopenedCount: 0,
        history: [],
      };
      byKey.set(key, record);
      setStatus(record, 'NEW');
      emit('ANOMALY_CREATED', record, `first seen on ${path.at(-1) ?? issue.pageUrl}`);
    } else if (record.status === 'RESOLVED') {
      record.reopenedCount += 1;
      record.flips += 1;
      delete record.resolvedAt;
      setStatus(
        record,
        'REOPENED',
        `back after ${record.history.length > 1 ? 'being resolved' : 'resolution'}`,
      );
      emit('ANOMALY_REOPENED', record, `resolved ${record.reopenedCount} time(s) before, seen again`);
    } else {
      // Absente à une vérification, puis revenue : un aller-retour.
      if (record.cleanChecks > 0) record.flips += 1;
      if (record.flips >= options.flakyAfterFlips && record.status !== 'FLAKY') {
        setStatus(record, 'FLAKY', `${record.flips} flip(s)`);
        emit('ANOMALY_FLAKY', record, `comes and goes (${record.flips} flip(s))`);
      } else if (record.status !== 'FLAKY' && record.status !== 'KNOWN') setStatus(record, 'KNOWN');
    }
    record.lastSeen = sighting;
    record.runsSeen += 1;
    record.occurrenceCount += issue.occurrences;
    record.severity = issue.severity;
    record.cleanChecks = 0;
    if (path.length > 0) record.reproductionPath = path;
    if (run.environment && !record.environments.includes(run.environment))
      record.environments.push(run.environment);
    if (run.actor && !record.actors.includes(run.actor)) record.actors.push(run.actor);
    for (const state of issue.states) if (!record.stateIds.includes(state)) record.stateIds.push(state);
    if (issue.actionId && !record.actionIds.includes(issue.actionId)) record.actionIds.push(issue.actionId);
    record.stateIds = record.stateIds.slice(-20);
    record.actionIds = record.actionIds.slice(-20);
    touched.set(key, record);
    byIssue[issue.id] = {
      anomalyId: record.id,
      status: record.status,
      firstSeen: record.firstSeen,
      runsSeen: record.runsSeen,
    };
  }

  // ---- les anomalies absentes : une vérification seulement si leur écran (et leur action) a été rejoué
  const visited = new Set(graph.nodes.map((node) => node.id));
  const executed = new Set(
    graph.edges.filter((edge) => edge.result !== 'BLOCKED').map((edge) => edge.actionId),
  );
  for (const record of byKey.values()) {
    if (seenKeys.has(record.key) || record.status === 'RESOLVED') continue;
    const checked =
      record.stateIds.some((state) => visited.has(state)) &&
      (record.actionIds.length === 0 || record.actionIds.some((action) => executed.has(action)));
    if (!checked) continue; // pas repassé par là : rien n'est prouvé
    record.cleanChecks += 1;
    if (record.cleanChecks >= options.resolveAfterChecks) {
      record.resolvedAt = sighting;
      setStatus(record, 'RESOLVED', `${record.cleanChecks} consecutive clean check(s)`);
      emit('ANOMALY_RESOLVED', record, `absent for ${record.cleanChecks} consecutive verification(s)`);
    }
    touched.set(record.key, record);
  }

  return { records: [...touched.values()], events, byIssue };
}

/** Répartition par statut (rapport). */
export function lifecycleCounts(records: readonly AnomalyRecord[]): Record<AnomalyStatus, number> {
  const counts = Object.fromEntries(ANOMALY_STATUSES.map((status) => [status, 0])) as Record<
    AnomalyStatus,
    number
  >;
  for (const record of records) counts[record.status] += 1;
  return counts;
}
