import { redactText } from '../security/redactor.js';
import type {
  ActionEvidence,
  Evidence,
  EvidenceKind,
  Experiment,
  HttpExchange,
  Incident,
  IncidentEvent,
  Layer,
  ReproductionRun,
  TimelineEvent,
  TimelineKind,
  TimelineStatus,
} from './model.js';
import { incidentReproduction } from './model.js';

/**
 * LA CHRONOLOGIE UNIFIÉE DE L'INCIDENT : pour la reproduction de référence (incidentReproduction) et
 * pour les autres reproductions (rejeux de vérification, marqués par `reproduction`), une ligne par
 * action, par requête et par réponse, par preuve (console, erreur JavaScript, assertion, page, capture,
 * trace) ; puis les lignes de journaux des vérifications INSPECT_LOGS, une ligne par vérification
 * terminée et une par événement de l'historique de l'incident.
 *
 * Une heure n'est jamais inventée : l'heure d'une action est reconstruite (début du flow + durées des
 * étapes précédentes) et marquée `estimated` ; celle d'une requête est mesurée quand
 * network.captureBodies l'a gardée, sinon reprise de son étape (estimée). Sans heure, l'événement est
 * classé à côté de ce qui l'encadre (`order`), sans `at`.
 *
 * Les identifiants sont stables : `<reproduction>:<sorte>:<preuve>` pour une reproduction,
 * `experiment:<id>` et `experiment:<id>:LOG:<preuve>` pour une vérification, `history:<index>` pour
 * l'historique. Fonction pure et déterministe : aucune horloge, aucun accès disque.
 */

const KIND_RANK: Record<TimelineKind, number> = {
  STATE: 0,
  ACTION: 1,
  PAGE: 2,
  REQUEST: 3,
  RESPONSE: 4,
  CONSOLE: 5,
  JS_ERROR: 6,
  ASSERTION: 7,
  SCREENSHOT: 8,
  TRACE: 9,
  LOG: 10,
  EXPERIMENT: 11,
};

/** Les preuves d'une reproduction qui deviennent une ligne (les actions et requêtes ont la leur). */
const EVIDENCE_KINDS: Partial<Record<EvidenceKind, TimelineKind>> = {
  CONSOLE: 'CONSOLE',
  JS_ERROR: 'JS_ERROR',
  ASSERTION: 'ASSERTION',
  PAGE: 'PAGE',
  SCREENSHOT: 'SCREENSHOT',
  TRACE: 'TRACE',
  LOG_LINE: 'LOG',
};

interface Draft {
  event: Omit<TimelineEvent, 'order'>;
  /** L'heure de classement : celle de l'événement, sinon celle de ce qui l'encadre. */
  time: number;
  /** Le rang de la source : reproductions dans l'ordre, puis vérifications, puis historique. */
  group: number;
  sequence: number;
}

const timeOf = (at: string | undefined): number => {
  if (!at) return Number.NaN;
  return Date.parse(at);
};

const iso = (time: number): string | undefined =>
  Number.isFinite(time) ? new Date(time).toISOString() : undefined;

const summary = (text: string): string => redactText(text.replace(/\s+/g, ' ').trim());

/** Le statut d'un échange : OK sous 400, WARNING pour 4xx, ERROR à partir de 500 ou en cas d'échec réseau. */
export function exchangeStatus(request: Pick<HttpExchange, 'status' | 'failure'>): TimelineStatus {
  if (request.failure !== undefined) return 'ERROR';
  if (request.status === undefined) return 'WARNING';
  if (request.status >= 500) return 'ERROR';
  if (request.status >= 400) return 'WARNING';
  return 'OK';
}

function actionStatus(action: ActionEvidence): TimelineStatus {
  switch (action.status) {
    case 'PASSED':
      return 'OK';
    case 'FAILED':
      return 'ERROR';
    case 'BLOCKED':
      return 'WARNING';
    default:
      return 'INFO';
  }
}

function evidenceStatus(item: Evidence, kind: TimelineKind): TimelineStatus {
  const data = item.data ?? {};
  switch (kind) {
    case 'JS_ERROR':
    case 'ASSERTION':
      return 'ERROR';
    case 'CONSOLE':
      return data.severity === 'ERROR' || data.severity === 'CRITICAL' ? 'ERROR' : 'WARNING';
    case 'PAGE':
      if (data.type === 'UI_ERROR') return 'ERROR';
      if (data.type === 'NAVIGATION') return 'WARNING';
      return 'INFO';
    case 'LOG':
      return logStatus(item.summary);
    default:
      return 'INFO';
  }
}

function logStatus(line: string): TimelineStatus {
  if (/\b(error|exception|severe|fatal|erreur)\b|Exception\b/i.test(line)) return 'ERROR';
  if (/\b(warn|warning|avertissement)\b/i.test(line)) return 'WARNING';
  return 'INFO';
}

/** La couche d'une ligne de journal : l'application du périmètre qui déclare ce fichier ou ce sélecteur OpenShift. */
function logLayer(incident: Incident, item: Evidence): Layer {
  const label = typeof item.data?.source === 'string' ? item.data.source : '';
  const file = item.source.file ?? label;
  for (const application of incident.scope.applications) {
    if (file && (application.logFiles ?? []).some((entry) => entry === file || file.endsWith(entry)))
      return application.layer;
    const openshift = application.openshift;
    if (openshift && label === `openshift ${openshift.namespace} ${openshift.selector}`)
      return application.layer;
  }
  return 'UNKNOWN';
}

function reproductionDrafts(
  incident: Incident,
  run: ReproductionRun,
  group: number,
  push: (draft: Draft) => void,
): void {
  const stepTime = new Map<number, number>();
  for (const action of run.actions) stepTime.set(action.index, timeOf(action.startedAt));
  const stepAt = (step: number | undefined): number =>
    step === undefined ? Number.NaN : (stepTime.get(step) ?? Number.NaN);
  const evidenceById = new Map(run.evidence.map((item) => [item.id, item]));
  let sequence = 0;
  const add = (event: Omit<TimelineEvent, 'order'>, time: number): void => {
    sequence += 1;
    push({ event, time, group, sequence });
  };
  let runEnd = timeOf(run.finishedAt);

  for (const action of run.actions) {
    const evidenceId = `${run.id}:ev-action-${String(action.index)}`;
    const time = timeOf(action.startedAt);
    const at = iso(time);
    add(
      {
        id: `${run.id}:ACTION:${evidenceId}`,
        ...(at ? { at, estimated: true } : {}),
        reproduction: run.id,
        step: action.index,
        layer: 'FRONTEND',
        kind: 'ACTION',
        status: actionStatus(action),
        summary: summary(
          `${action.description} : ${action.status}${action.reason ? ` (${action.reason})` : ''}`,
        ),
        evidence: evidenceById.has(evidenceId) ? [evidenceId] : [],
      },
      time,
    );
    if (Number.isFinite(time) && !(runEnd >= time + action.durationMs)) runEnd = time + action.durationMs;
  }

  for (const request of run.requests) {
    const status = exchangeStatus(request);
    const measured = timeOf(request.startedAt);
    const fallback = stepAt(request.step);
    const start = Number.isFinite(measured) ? measured : fallback;
    const startAt = iso(start);
    const correlation = request.correlation === 'OBSERVED' ? '' : ` [${request.correlation}]`;
    const common = {
      reproduction: run.id,
      ...(request.step !== undefined ? { step: request.step } : {}),
      layer: 'NETWORK' as const,
      evidence: [request.id],
      requestId: request.id,
    };
    add(
      {
        id: `${run.id}:REQUEST:${request.id}`,
        ...(startAt ? { at: startAt, ...(Number.isFinite(measured) ? {} : { estimated: true }) } : {}),
        ...common,
        kind: 'REQUEST',
        status,
        summary: summary(
          `${request.method} ${request.path}${request.status === undefined ? ` → ${request.failure ?? 'sans réponse enregistrée'}` : ''}${correlation}`,
        ),
      },
      start,
    );
    if (request.status === undefined) continue;
    const timed = Number.isFinite(measured) && request.durationMs !== undefined;
    const end = timed ? measured + (request.durationMs ?? 0) : start;
    const endAt = iso(end);
    add(
      {
        id: `${run.id}:RESPONSE:${request.id}`,
        ...(endAt ? { at: endAt, ...(timed ? {} : { estimated: true }) } : {}),
        ...common,
        kind: 'RESPONSE',
        status,
        summary: summary(
          `${request.method} ${request.path} → ${String(request.status)}${request.durationMs !== undefined ? ` (${String(request.durationMs)} ms)` : ''}${correlation}`,
        ),
      },
      end,
    );
    if (Number.isFinite(end) && !(runEnd >= end)) runEnd = end;
  }

  const trailing: Evidence[] = [];
  for (const item of run.evidence) {
    const kind = EVIDENCE_KINDS[item.kind];
    if (!kind) continue;
    const own = timeOf(item.at);
    // Une anomalie du run (issueId) a son heure ; une preuve tirée d'une étape reprend l'heure estimée de l'étape.
    const fromStep = item.data?.issueId === undefined && item.source.step !== undefined;
    const time = Number.isFinite(own) ? own : stepAt(item.source.step);
    if (!Number.isFinite(time) && item.source.step === undefined) {
      trailing.push(item);
      continue;
    }
    const at = iso(time);
    add(
      {
        id: `${run.id}:${kind}:${item.id}`,
        ...(at ? { at, ...(fromStep || !Number.isFinite(own) ? { estimated: true } : {}) } : {}),
        reproduction: run.id,
        ...(item.source.step !== undefined ? { step: item.source.step } : {}),
        layer: kind === 'LOG' ? logLayer(incident, item) : 'FRONTEND',
        kind,
        status: evidenceStatus(item, kind),
        summary: summary(item.summary),
        evidence: [item.id],
      },
      time,
    );
    if (Number.isFinite(time) && !(runEnd >= time)) runEnd = time;
  }
  // Sans heure ni étape (la trace Playwright) : à la fin du run, sans heure affichée.
  for (const item of trailing) {
    const kind = EVIDENCE_KINDS[item.kind] ?? 'TRACE';
    add(
      {
        id: `${run.id}:${kind}:${item.id}`,
        reproduction: run.id,
        layer: kind === 'LOG' ? logLayer(incident, item) : 'FRONTEND',
        kind,
        status: evidenceStatus(item, kind),
        summary: summary(item.summary),
        evidence: [item.id],
      },
      runEnd,
    );
  }
}

function experimentDrafts(
  incident: Incident,
  experiment: Experiment,
  group: number,
  push: (draft: Draft) => void,
): void {
  let sequence = 0;
  const add = (event: Omit<TimelineEvent, 'order'>, time: number): void => {
    sequence += 1;
    push({ event, time, group, sequence });
  };
  const started = timeOf(experiment.startedAt);
  const finished = timeOf(experiment.finishedAt);
  for (const item of experiment.evidence) {
    if (item.kind !== 'LOG_LINE') continue;
    // L'heure de la ligne lue dans le journal (jamais celle de la lecture) ; sans elle, pas d'heure affichée.
    const logged = typeof item.data?.at === 'string' ? timeOf(item.data.at) : Number.NaN;
    const at = iso(logged);
    add(
      {
        id: `experiment:${experiment.id}:LOG:${item.id}`,
        ...(at ? { at } : {}),
        layer: logLayer(incident, item),
        kind: 'LOG',
        status: logStatus(item.summary),
        summary: summary(item.summary),
        evidence: [item.id],
      },
      Number.isFinite(logged) ? logged : Number.isFinite(started) ? started : finished,
    );
  }
  if (!['DONE', 'ERROR', 'CANCELLED'].includes(experiment.status)) return;
  const time = Number.isFinite(finished) ? finished : started;
  const at = iso(time);
  const hypothesis = experiment.hypothesisId
    ? incident.investigation.hypotheses.find((entry) => entry.id === experiment.hypothesisId)
    : undefined;
  const status: TimelineStatus =
    experiment.status === 'ERROR' ? 'ERROR' : experiment.status === 'CANCELLED' ? 'WARNING' : 'OK';
  add(
    {
      id: `experiment:${experiment.id}`,
      ...(at ? { at } : {}),
      layer: hypothesis?.layer ?? 'UNKNOWN',
      kind: 'EXPERIMENT',
      status,
      summary: summary(
        `${experiment.kind} ${experiment.status}${experiment.outcome ? ` (${experiment.outcome})` : ''} : ${experiment.summary ?? experiment.description}`,
      ),
      evidence: experiment.evidence.filter((item) => item.kind !== 'LOG_LINE').map((item) => item.id),
    },
    time,
  );
}

const ENVIRONMENT_EVENTS = new Set<IncidentEvent['kind']>([
  'SCOPE',
  'EXTENSION_REQUESTED',
  'EXTENSION_DECIDED',
  'REPRODUCTION',
]);

function historyStatus(event: IncidentEvent): TimelineStatus {
  if (event.kind === 'CANCELLED') return 'WARNING';
  if (event.kind !== 'STATE') return 'INFO';
  const to = /→\s*([A-Z_]+)/.exec(event.message)?.[1];
  if (to === 'FAILED') return 'ERROR';
  if (to === 'NOT_REPRODUCED' || to === 'INCONCLUSIVE' || to === 'CANCELLED') return 'WARNING';
  if (to === 'REPRODUCED' || to === 'DIAGNOSED') return 'OK';
  return 'INFO';
}

/** La chronologie unifiée, classée (heure, puis source, étape, sorte, ordre d'origine) ; `order` = position. */
export function buildTimeline(incident: Incident): TimelineEvent[] {
  const drafts: Draft[] = [];
  const push = (draft: Draft): void => {
    drafts.push(draft);
  };
  const { investigation } = incident;
  const reference = incidentReproduction(incident);
  // La référence d'abord (à heure égale), puis les autres reproductions dans leur ordre.
  const runs = [
    ...(reference ? [reference] : []),
    ...investigation.reproductions.filter((run) => run !== reference),
  ];
  runs.forEach((run, index) => {
    reproductionDrafts(incident, run, index, push);
  });
  investigation.experiments.forEach((experiment, index) => {
    experimentDrafts(incident, experiment, runs.length + index, push);
  });
  const historyGroup = runs.length + investigation.experiments.length;
  incident.history.forEach((event, index) => {
    const time = timeOf(event.at);
    const at = iso(time);
    drafts.push({
      event: {
        id: `history:${String(index)}`,
        ...(at ? { at } : {}),
        layer: ENVIRONMENT_EVENTS.has(event.kind) ? 'ENVIRONMENT' : 'UNKNOWN',
        kind: 'STATE',
        status: historyStatus(event),
        summary: summary(`${event.kind} : ${event.message}`),
        evidence: [],
      },
      time,
      group: historyGroup,
      sequence: index,
    });
  });

  const rank = (time: number): number => (Number.isFinite(time) ? time : Number.POSITIVE_INFINITY);
  drafts.sort(
    (left, right) =>
      rank(left.time) - rank(right.time) ||
      left.group - right.group ||
      (left.event.step ?? Number.MAX_SAFE_INTEGER) - (right.event.step ?? Number.MAX_SAFE_INTEGER) ||
      KIND_RANK[left.event.kind] - KIND_RANK[right.event.kind] ||
      left.sequence - right.sequence,
  );
  return drafts.map((draft, order) => ({ ...draft.event, order }));
}
