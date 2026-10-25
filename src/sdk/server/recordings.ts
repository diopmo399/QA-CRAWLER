import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RecordOutcome, RecordRequest } from '../../recording/record-orchestrator.js';
import { inFlow } from '../../recording/assertion-proposals.js';
import type { HumanFlowRecorder } from '../../recording/human-flow-recorder.js';
import type { RecordedFlow, RecordingEvent } from '../../recording/model.js';
import {
  FLOW_FILES,
  loadStoredRecording,
  type StoredRecording,
} from '../../recording/recording-workspace.js';
import { redactText } from '../../security/redactor.js';
import type {
  FlowView,
  GraphView,
  RecordingSnapshot,
  RecordingStatus,
  RecordingStreamEvent,
  RecordingSummary,
  ReportEntry,
} from '../core/contracts.js';

/**
 * LES ENREGISTREMENTS DU SERVEUR : chaque session lance le vrai recorder (`runRecording`) dans un
 * Chromium VISIBLE sur la machine du serveur ; un humain y joue le parcours et l'arrête depuis la barre
 * d'enregistrement (ou le SDK l'arrête par l'API). Le moteur construit ensuite le flow. Une session à
 * la fois : un humain, un navigateur.
 */
export type RecordRunner = (request: RecordRequest) => Promise<RecordOutcome>;

export interface RecordingStart {
  projectId: string;
  name: string;
  /** La requête complète du recorder (mission dérivée du projet, dossier des rapports, langue). */
  request: RecordRequest;
}

type Listener = (event: RecordingStreamEvent) => void;

const MAX_EVENTS = 2000;
/** Ces événements du recorder sont des traces techniques (une ligne par événement brut) : pas relayés. */
const SILENT = new Set(['RAW_EVENT_CAPTURED', 'RECORDER_DEBUG']);

export class RecordingSession {
  status: RecordingStatus = 'RECORDING';
  readonly startedAt = new Date().toISOString();
  error?: string;
  summary?: RecordingSummary;
  recorder?: HumanFlowRecorder;
  /** Un arrêt demandé avant que le recorder soit prêt : appliqué dès qu'il l'est (jamais perdu). */
  stopRequested = false;
  private seq = 0;
  private readonly events: RecordingStreamEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly projectId: string,
    readonly name: string,
  ) {
    this.emit({ type: 'status', status: 'RECORDING' });
  }

  get terminal(): boolean {
    return this.status === 'COMPLETED' || this.status === 'FAILED';
  }

  emit(event: DistributiveOmit<RecordingStreamEvent, 'seq' | 'at'>): void {
    this.seq += 1;
    const full: RecordingStreamEvent = { ...event, seq: this.seq, at: new Date().toISOString() };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const listener of this.listeners) listener(full);
  }

  transition(status: RecordingStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  eventsAfter(after: number): RecordingStreamEvent[] {
    return this.events.filter((event) => event.seq > after);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): RecordingSnapshot {
    return {
      name: this.name,
      projectId: this.projectId,
      status: this.status,
      startedAt: this.startedAt,
      serverTime: new Date().toISOString(),
      lastSeq: this.seq,
      ...(this.summary ? { summary: this.summary } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class RecordingBusyError extends Error {
  constructor(readonly active: RecordingSession) {
    super(`a recording is already in progress (${active.name}): one at a time`);
    this.name = 'RecordingBusyError';
  }
}

export class RecordingManager {
  private readonly sessions = new Map<string, RecordingSession>();

  constructor(private readonly options: { record: RecordRunner; onWarning?: (message: string) => void }) {}

  private key(projectId: string, name: string): string {
    return `${projectId}/${name}`;
  }

  active(): RecordingSession | undefined {
    return [...this.sessions.values()].find((session) => !session.terminal);
  }

  get(projectId: string, name: string): RecordingSession | undefined {
    return this.sessions.get(this.key(projectId, name));
  }

  forProject(projectId: string): RecordingSession[] {
    return [...this.sessions.values()].filter((session) => session.projectId === projectId);
  }

  start(input: RecordingStart): RecordingSession {
    const active = this.active();
    if (active) throw new RecordingBusyError(active);
    const session = new RecordingSession(input.projectId, input.name);
    this.sessions.set(this.key(input.projectId, input.name), session);
    void this.execute(session, input.request);
    return session;
  }

  /** Arrête la session (comme le bouton de la barre d'enregistrement) ; sans effet après l'arrêt. */
  stop(session: RecordingSession): void {
    session.stopRequested = true;
    session.recorder?.requestStop('api');
  }

  private async execute(session: RecordingSession, request: RecordRequest): Promise<void> {
    try {
      const outcome = await this.options.record({
        ...request,
        onEvent: (event: RecordingEvent) => {
          if (SILENT.has(event.type)) return;
          session.emit({ type: 'recorder', event: event.type, message: redactText(event.message) });
          if (event.type === 'RECORDING_STOPPED' && session.status === 'RECORDING')
            session.transition('PROCESSING');
        },
        onProgress: (update) => {
          if (session.status === 'RECORDING') session.transition('PROCESSING');
          session.emit({ type: 'phase', phase: update.label });
        },
        control: (recorder) => {
          session.recorder = recorder;
          if (session.stopRequested) recorder.requestStop('api');
          return () => {
            delete session.recorder;
          };
        },
      });
      session.summary = summaryOf(session.name, outcome);
      if (session.status === 'RECORDING') session.transition('PROCESSING');
      session.emit({ type: 'completed', summary: session.summary });
      session.transition('COMPLETED');
    } catch (error) {
      session.error = redactText(error instanceof Error ? error.message : String(error));
      this.options.onWarning?.(`recording ${session.name} failed: ${session.error}`);
      session.emit({ type: 'failed', error: session.error });
      session.transition('FAILED');
    }
  }
}

function proposalCounts(flow: RecordedFlow): RecordingSummary['proposals'] {
  const proposals = flow.proposals ?? [];
  return {
    total: proposals.length,
    pending: proposals.filter((proposal) => proposal.status === 'PROPOSED').length,
    inFlow: proposals.filter((proposal) => inFlow(proposal)).length,
  };
}

export function summaryOf(name: string, outcome: RecordOutcome): RecordingSummary {
  const flow = outcome.result.flow;
  return {
    name,
    steps: flow.steps.length,
    stopReason: outcome.stopReason,
    replay: outcome.replay.status,
    proposals: proposalCounts(flow),
    groups: flow.groups?.length ?? 0,
    files: Object.keys(outcome.files).sort(),
    warnings: outcome.warnings.map((warning) => redactText(warning)),
  };
}

export async function storedSummary(recording: StoredRecording): Promise<RecordingSummary> {
  return {
    name: path.basename(recording.directory),
    steps: recording.flow.steps.length,
    proposals: proposalCounts(recording.flow),
    groups: recording.flow.groups?.length ?? 0,
    files: (await readdir(recording.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
    warnings: [],
  };
}

/** Le dossier des enregistrements d'un projet (le recorder écrit sous `<rapports>/recordings/<nom>/`). */
export function recordingsDir(reportsDir: string): string {
  return path.join(reportsDir, 'recordings');
}

export async function storedRecordingNames(reportsDir: string): Promise<string[]> {
  const entries = await readdir(recordingsDir(reportsDir), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** La vue du flow : les étapes du flow enregistré et les fichiers générés (YAML, .feature). */
export async function flowView(recording: StoredRecording): Promise<FlowView> {
  const groupOf = new Map<string, string>();
  for (const group of recording.flow.groups ?? [])
    for (const stepId of group.stepIds) groupOf.set(stepId, group.id);
  const read = (file: string): Promise<string | undefined> =>
    readFile(path.join(recording.directory, file), 'utf8').catch(() => undefined);
  const [yaml, feature] = await Promise.all([read(FLOW_FILES.yaml), read(FLOW_FILES.feature)]);
  return {
    name: recording.flow.name,
    startAt: recording.flow.startAt,
    steps: recording.flow.steps.map((item) => ({
      id: item.id,
      kind: item.step.kind,
      description: describeStep(item.step),
      ...(groupOf.has(item.id) ? { groupId: groupOf.get(item.id) } : {}),
    })),
    ...(yaml !== undefined ? { yaml } : {}),
    ...(feature !== undefined ? { feature } : {}),
  };
}

function describeStep(step: RecordedFlow['steps'][number]['step']): string {
  const target = (step as { target?: unknown }).target;
  const label =
    target && typeof target === 'object'
      ? Object.values(target as Record<string, unknown>)
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 2)
          .join(' ')
      : typeof target === 'string'
        ? target
        : '';
  const url = (step as { url?: unknown }).url;
  return [step.kind, label || (typeof url === 'string' ? url : '')].filter(Boolean).join(' ');
}

interface FlowGraphFile {
  rootId?: string;
  nodes?: { id: string; label?: string; route?: string; title?: string; depth?: number }[];
  edges?: {
    from: string;
    to: string;
    action?: { type?: string; text?: string; label?: string; classification?: string };
    result?: string;
    reason?: string;
  }[];
}

/** Le graphe d'écrans écrit par le moteur (flow-graph.json), réduit à ce qu'un écran affiche. */
export async function graphView(directory: string): Promise<GraphView | undefined> {
  const raw = await readFile(path.join(directory, 'flow-graph.json'), 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  const graph = JSON.parse(raw) as FlowGraphFile;
  return {
    ...(graph.rootId ? { rootId: graph.rootId } : {}),
    nodes: (graph.nodes ?? []).map((node) => ({
      id: node.id,
      label: node.label ?? node.id,
      route: node.route ?? '',
      title: node.title ?? '',
      depth: node.depth ?? 0,
    })),
    edges: (graph.edges ?? []).map((edge) => ({
      from: edge.from,
      to: edge.to,
      action: edge.action?.text ?? edge.action?.label ?? '',
      type: edge.action?.type ?? '',
      ...(edge.action?.classification ? { classification: edge.action.classification } : {}),
      result: edge.result ?? '',
      ...(edge.reason ? { reason: redactText(edge.reason) } : {}),
    })),
  };
}

interface ResultFile {
  stopReason?: string;
  stats?: { states?: number; actionsExecuted?: number; issuesBySeverity?: Record<string, number> };
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Les rapports d'un projet sur disque : les explorations (`run-…`) et les enregistrements. */
export async function reportEntries(reportsDir: string): Promise<ReportEntry[]> {
  const entries: ReportEntry[] = [];
  const runs = await readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of runs) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const dir = path.join(reportsDir, entry.name);
    const raw = await readFile(path.join(dir, 'result.json'), 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    const result = JSON.parse(raw) as ResultFile;
    const issues = Object.values(result.stats?.issuesBySeverity ?? {}).reduce((sum, count) => sum + count, 0);
    entries.push({
      kind: 'exploration',
      name: entry.name,
      createdAt: (await stat(dir)).mtime.toISOString(),
      exploration: {
        states: result.stats?.states ?? 0,
        actions: result.stats?.actionsExecuted ?? 0,
        issues,
        stopReason: result.stopReason ?? '',
      },
      hasGraph: await exists(path.join(dir, 'flow-graph.json')),
    });
  }
  for (const name of await storedRecordingNames(reportsDir)) {
    const dir = path.join(recordingsDir(reportsDir), name);
    const recording = await loadStoredRecording(dir);
    if (!recording) continue;
    entries.push({
      kind: 'recording',
      name,
      createdAt: recording.startedAt || (await stat(dir)).mtime.toISOString(),
      recording: { steps: recording.flow.steps.length },
      hasGraph: await exists(path.join(dir, 'flow-graph.json')),
    });
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
