import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RecordOutcome, RecordRequest } from '../../recording/record-orchestrator.js';
import { inFlow } from '../../recording/assertion-proposals.js';
import type { HumanFlowRecorder } from '../../recording/human-flow-recorder.js';
import type { RecordedFlow, RecordingEvent } from '../../recording/model.js';
import { dependencyViolations, stepDependencies } from '../../recording/step-groups.js';
import {
  FLOW_FILES,
  loadStoredRecording,
  type StoredRecording,
} from '../../recording/recording-workspace.js';
import { redactText } from '../../security/redactor.js';
import {
  STEP_REPLAY_OUTCOMES,
  type AssertionVerdict,
  type FlowStudioView,
  type FlowView,
  type GraphView,
  type GroupViewDto,
  type StepReplayOutcome,
  type StudioStep,
  type RecordingSnapshot,
  type RecordingStatus,
  type RecordingStreamEvent,
  type RecordingSummary,
  type ReportEntry,
} from '../core/contracts.js';
import { verdictOfAssertionStatus, verdictOfReplayOutcome } from '../core/verdicts.js';

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

interface ReplayFile {
  status?: string;
  findings?: { intentId?: string; outcome?: string; reasons?: string[] }[];
}

interface QualityFile {
  flows?: {
    assertions?: {
      id?: string;
      status?: string;
      observed?: string;
      reasons?: string[];
      evidence?: string[];
    }[];
  }[];
}

/** Le dernier rejeu du flow, tel que le moteur l'a écrit. */
interface ReplayResults {
  status: string;
  at: Date;
  /** Le flow a été réécrit après ce rejeu. */
  stale: boolean;
  /** Le résultat de chaque étape, par position (1…n) dans le flow rejoué. */
  outcomes: Map<number, { outcome: StepReplayOutcome; reasons: string[] }>;
  /** Le verdict du moteur d'assertions métier, quand il a tourné pendant ce rejeu. */
  quality?: QualityFile;
}

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/**
 * Le dernier rejeu du flow écrit par le moteur (`replay/dry-run/<…>/reconciliation.json`, et
 * `exploration/quality-verification.json` à côté) : chaque résultat est rattaché à l'étape de même
 * position (`…#<position>`, comme pendant le rejeu).
 */
async function lastReplay(directory: string): Promise<ReplayResults | undefined> {
  const root = path.join(directory, 'replay', 'dry-run');
  const runs = await readdir(root, { withFileTypes: true }).catch(() => []);
  let best: { dir: string; at: Date } | undefined;
  for (const run of runs.filter((entry) => entry.isDirectory())) {
    const dir = path.join(root, run.name);
    const info = await stat(path.join(dir, 'reconciliation.json')).catch(() => undefined);
    if (info && (!best || info.mtime > best.at)) best = { dir, at: info.mtime };
  }
  if (!best) return undefined;
  const file = await readJson<ReplayFile>(path.join(best.dir, 'reconciliation.json'));
  if (!file) return undefined;
  const outcomes = new Map<number, { outcome: StepReplayOutcome; reasons: string[] }>();
  for (const finding of file.findings ?? []) {
    const position = Number(finding.intentId?.split('#').pop());
    const outcome = finding.outcome as StepReplayOutcome;
    if (Number.isInteger(position) && STEP_REPLAY_OUTCOMES.includes(outcome))
      outcomes.set(position, {
        outcome,
        reasons: (finding.reasons ?? []).map((reason) => redactText(reason)),
      });
  }
  const at = best.at;
  const stale = await stat(path.join(directory, 'recorded-flow.json')).then(
    (info) => info.mtime > at,
    () => false,
  );
  const quality = await readJson<QualityFile>(
    path.join(best.dir, 'exploration', 'quality-verification.json'),
  );
  return { status: file.status ?? 'UNKNOWN', at, stale, outcomes, ...(quality ? { quality } : {}) };
}

/**
 * LE VERDICT DE CHAQUE PROPOSITION D'ASSERTION au dernier rejeu : l'étape `expect` qui la porte
 * (résultat du rejeu pour cette étape), ou le moteur d'assertions métier (quality-verification.json).
 * Sans exécution : NOT_EXECUTED, jamais un succès supposé.
 */
export async function assertionVerdicts(
  recording: StoredRecording,
): Promise<Map<string, { stepId?: string; verdict: AssertionVerdict }>> {
  const replay = await lastReplay(recording.directory);
  const steps = recording.flow.steps;
  const results = new Map<string, { stepId?: string; verdict: AssertionVerdict }>();
  const business = new Map(
    (replay?.quality?.flows ?? []).flatMap((flow) =>
      (flow.assertions ?? []).flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : [])),
    ),
  );
  const when = replay ? { at: replay.at.toISOString(), stale: replay.stale } : {};
  for (const proposal of recording.flow.proposals ?? []) {
    if (!inFlow(proposal)) {
      results.set(proposal.id, { verdict: { status: 'NOT_EXECUTED', reasons: ['not in the flow'] } });
      continue;
    }
    if (proposal.verificationMethod === 'UI_EXPECT' && proposal.expect) {
      const key = JSON.stringify(proposal.expect);
      const same = (item: (typeof steps)[number]): boolean =>
        item.step.kind === 'expect' && JSON.stringify(item.step.expect) === key;
      // L'étape de l'action d'ancrage ; sinon la seule vérification identique du flow (le recorder
      // peut ranger la vérification sous l'action suivante). Jamais une vérification ambiguë.
      const anchored = steps.findIndex(
        (item) => same(item) && item.actionIds.includes(proposal.afterActionId),
      );
      const alike = steps.flatMap((item, position) => (same(item) ? [position] : []));
      const index = anchored >= 0 ? anchored : alike.length === 1 ? (alike[0] ?? -1) : -1;
      const stepId = steps[index]?.id;
      const played = index >= 0 ? replay?.outcomes.get(index + 1) : undefined;
      results.set(proposal.id, {
        ...(stepId ? { stepId } : {}),
        verdict: played
          ? {
              status: verdictOfReplayOutcome(played.outcome),
              source: 'REPLAY_STEP',
              engineStatus: played.outcome,
              reasons: played.reasons,
              ...when,
            }
          : {
              status: 'NOT_EXECUTED',
              reasons: [replay ? 'not replayed since it was added' : 'never replayed'],
            },
      });
      continue;
    }
    const checked = proposal.assertion ? business.get(proposal.assertion.id) : undefined;
    results.set(proposal.id, {
      verdict: checked
        ? {
            status: verdictOfAssertionStatus(checked.status),
            source: 'QUALITY_ENGINE',
            ...(checked.status ? { engineStatus: checked.status } : {}),
            reasons: (checked.reasons ?? []).map((reason) => redactText(reason)),
            ...(checked.observed ? { observed: redactText(checked.observed) } : {}),
            ...(checked.evidence ? { evidence: checked.evidence } : {}),
            ...when,
          }
        : {
            status: 'NOT_EXECUTED',
            reasons: [
              proposal.verificationMethod === 'REPORT_ONLY'
                ? 'reported only, never checked by a run'
                : replay
                  ? 'the business assertion engine gave no result for it in the last replay'
                  : 'never replayed',
            ],
          },
    });
  }
  return results;
}

/**
 * LA VUE DU FLOW STUDIO : les étapes avec les données qu'elles produisent et citent (le moteur :
 * `stepDependencies`), les liens producteur → consommateur, les citations placées avant leur
 * producteur (`dependencyViolations`), les groupes, et le dernier rejeu s'il existe. Rien n'est
 * recalculé ici : tout vient du moteur ou de ses fichiers.
 */
export async function studioView(
  recording: StoredRecording,
  groups: GroupViewDto[],
): Promise<FlowStudioView> {
  const steps = recording.flow.steps;
  const roles = stepDependencies(recording.flow);
  const groupOf = new Map<string, string>();
  for (const group of groups) for (const stepId of group.stepIds) groupOf.set(stepId, group.id);
  const producerOf = new Map<string, string>();
  for (const role of roles) for (const key of role.produces) producerOf.set(key, role.stepId);
  const dependencies = roles.flatMap((role) =>
    role.consumes.flatMap((key) => {
      const from = producerOf.get(key);
      return from && from !== role.stepId ? [{ from, to: role.stepId, key }] : [];
    }),
  );
  const replay = await lastReplay(recording.directory);
  const studioSteps: StudioStep[] = steps.map((item, index) => {
    const role = roles[index];
    const replayed = replay?.outcomes.get(index + 1);
    return {
      id: item.id,
      position: index + 1,
      kind: item.step.kind,
      // Le libellé que le moteur a donné à l'étape (« saisir le titre »), sinon sa cible.
      description: item.label.trim() || describeStep(item.step),
      ...(groupOf.has(item.id) ? { groupId: groupOf.get(item.id) } : {}),
      consumes: role?.consumes ?? [],
      produces: role?.produces ?? [],
      ...(replayed ? { replay: replayed } : {}),
    };
  });
  return {
    name: recording.flow.name,
    startAt: recording.flow.startAt,
    steps: studioSteps,
    groups,
    dependencies,
    violations: dependencyViolations(steps),
    ...(replay
      ? {
          replay: {
            status: replay.status,
            at: replay.at.toISOString(),
            stale: replay.stale,
          },
        }
      : {}),
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
