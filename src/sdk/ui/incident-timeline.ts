import type {
  Evidence,
  Experiment,
  GraphNode,
  HttpExchange,
  Layer,
  RelationStatus,
  ReproductionRun,
  TimelineEvent,
  TimelineKind,
  TimelineStatus,
} from '../core/incident-contracts.js';
import { incidentReproduction, LAYERS, TIMELINE_STATUSES } from '../core/incident-contracts.js';
import { stepId } from './incident-links.js';
import {
  demoBanner,
  evidenceChips,
  panelState,
  partsText,
  relationBadge,
  selectable,
  selectionClass,
  sourceLink,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { esc, icon } from './view.js';

/**
 * LA CHRONOLOGIE, LES REQUÊTES HTTP ET LES JOURNAUX DE L'ESPACE D'INVESTIGATION.
 *
 * - « Chronologie » : la chronologie unifiée calculée par le serveur (`investigation.timeline`), groupée
 *   par étape, avec ses critères d'affichage (couche, étape, statut, période, reproduction) et, quand une
 *   sélection existe, « Seulement ce qui est relié à la sélection » (ctx.related).
 * - « Requêtes HTTP » : les échanges de la reproduction de référence ; le détail d'un échange montre les
 *   corps masqués, les en-têtes de la liste blanche, le temps, l'étape, la corrélation et les nœuds du
 *   graphe reliés. Ni l'hôte ni la chaîne de requête ne sont capturés.
 * - « Journaux » : les lignes LOG_LINE des vérifications INSPECT_LOGS (fichier ou OpenShift).
 *
 * Une heure estimée est toujours signalée ; rien n'est déduit ici : tout vient des données de l'incident.
 * Les interactions passent par `data-action` (`ws-timeline-…`, `ws-select`) ; le contrôleur les traite.
 */

// ── État local ───────────────────────────────────────────────────────────────────────────────

export const TIMELINE_PERIODS = ['ALL', 'REFERENCE', 'ERROR', 'CUSTOM'] as const;
export type TimelinePeriod = (typeof TIMELINE_PERIODS)[number];

/** ALL : tout ; REFERENCE : la reproduction de l'incident ; VERIFICATION : les rejeux ; INVESTIGATION : historique, vérifications, journaux. */
export const TIMELINE_ORIGINS = ['ALL', 'REFERENCE', 'VERIFICATION', 'INVESTIGATION'] as const;
export type TimelineOrigin = (typeof TIMELINE_ORIGINS)[number];

export interface TimelineUi {
  /** Couches affichées ; vide : toutes. */
  layers: Layer[];
  /** Étapes affichées (index 1-based) ; vide : toutes. */
  steps: number[];
  /** Statuts affichés ; vide : tous. */
  statuses: TimelineStatus[];
  origin: TimelineOrigin;
  period: TimelinePeriod;
  /** Période CUSTOM : secondes depuis le premier événement daté. */
  fromSeconds?: number;
  toSeconds?: number;
  /** Seulement ce qui est relié à la sélection (sans effet quand rien n'est sélectionné). */
  onlyRelated: boolean;
  /** Onglet « Requêtes HTTP » : seulement les échanges en erreur (≥ 400 ou échec réseau). */
  requestErrorsOnly: boolean;
}

export function emptyTimelineUi(): TimelineUi {
  return {
    layers: [],
    steps: [],
    statuses: [],
    origin: 'ALL',
    period: 'ALL',
    onlyRelated: false,
    requestErrorsOnly: false,
  };
}

/** Autour de la première erreur : cinq secondes de part et d'autre. */
const ERROR_MARGIN_MS = 5000;

const toggle = <T>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

const seconds = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * Le réducteur PUR de la chronologie. Actions : `ws-timeline-layer` (data-layer), `ws-timeline-status`
 * (data-status), `ws-timeline-step` (data-step, « all » pour toutes), `ws-timeline-origin` (data-value),
 * `ws-timeline-period` (data-value), `ws-timeline-from` / `ws-timeline-to` (data-value : la valeur du
 * champ, en secondes), `ws-timeline-related`, `ws-timeline-req-errors`, `ws-timeline-reset`.
 */
export function reduceTimeline(
  ui: TimelineUi,
  action: string,
  dataset: Record<string, string | undefined>,
): TimelineUi | undefined {
  switch (action) {
    case 'ws-timeline-layer': {
      const layer = dataset.layer as Layer | undefined;
      if (layer === undefined || !(LAYERS as readonly string[]).includes(layer)) return ui;
      return { ...ui, layers: toggle(ui.layers, layer) };
    }
    case 'ws-timeline-status': {
      const status = dataset.status as TimelineStatus | undefined;
      if (status === undefined || !(TIMELINE_STATUSES as readonly string[]).includes(status)) return ui;
      return { ...ui, statuses: toggle(ui.statuses, status) };
    }
    case 'ws-timeline-step': {
      if (dataset.step === 'all') return { ...ui, steps: [] };
      const step = Number(dataset.step);
      if (!Number.isInteger(step) || step < 1) return ui;
      return { ...ui, steps: toggle(ui.steps, step).sort((left, right) => left - right) };
    }
    case 'ws-timeline-origin': {
      const origin = dataset.value as TimelineOrigin | undefined;
      if (origin === undefined || !(TIMELINE_ORIGINS as readonly string[]).includes(origin)) return ui;
      return { ...ui, origin };
    }
    case 'ws-timeline-period': {
      const period = dataset.value as TimelinePeriod | undefined;
      if (period === undefined || !(TIMELINE_PERIODS as readonly string[]).includes(period)) return ui;
      return { ...ui, period };
    }
    case 'ws-timeline-from':
    case 'ws-timeline-to': {
      const value = seconds(dataset.value);
      const key = action === 'ws-timeline-from' ? 'fromSeconds' : 'toSeconds';
      const { [key]: _previous, ...rest } = ui;
      return { ...rest, period: 'CUSTOM', ...(value !== undefined ? { [key]: value } : {}) };
    }
    case 'ws-timeline-related':
      return { ...ui, onlyRelated: !ui.onlyRelated };
    case 'ws-timeline-req-errors':
      return { ...ui, requestErrorsOnly: !ui.requestErrorsOnly };
    case 'ws-timeline-reset':
      return { ...emptyTimelineUi(), requestErrorsOnly: ui.requestErrorsOnly };
    default:
      return undefined;
  }
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    locale: 'fr-FR',
    timelineTitle: 'Chronologie',
    timelineSub:
      'Actions, requêtes, réponses, console, erreurs, captures, journaux, vérifications et historique, dans l’ordre.',
    show: 'Afficher :',
    layers: 'Couches',
    steps: 'Étapes',
    allSteps: 'Toutes',
    statuses: 'Statuts',
    origin: 'Reproduction',
    origins: {
      ALL: 'Tout',
      REFERENCE: 'Reproduction de référence',
      VERIFICATION: 'Rejeux de vérification',
      INVESTIGATION: 'Investigation (historique, vérifications, journaux)',
    } as Record<TimelineOrigin, string>,
    period: 'Période',
    periods: {
      ALL: 'Toute la durée',
      REFERENCE: 'Durée de la reproduction',
      ERROR: 'Autour de la première erreur (±5 s)',
      CUSTOM: 'Intervalle personnalisé',
    } as Record<TimelinePeriod, string>,
    from: 'De (secondes depuis le début)',
    to: 'À (secondes depuis le début)',
    onlyRelated: 'Seulement ce qui est relié à la sélection',
    reset: 'Tout afficher',
    count: (shown: number, total: number) => `${String(shown)} événement(s) sur ${String(total)}`,
    noTimeline:
      'La chronologie n’est pas encore calculée : elle apparaît après une reproduction de l’incident.',
    noVisible: 'Aucun événement ne correspond à ces critères d’affichage.',
    estimatedNote:
      'Les heures marquées ≈ sont estimées (début du flow + durées des étapes précédentes) : seules les heures des requêtes capturées et des anomalies sont mesurées.',
    undatedNote: 'Les événements sans heure sont masqués quand une période est choisie.',
    estimated: 'heure estimée',
    noTime: 'heure inconnue',
    step: (index: number) => `Étape ${String(index)}`,
    reference: 'référence',
    verification: 'rejeu de vérification',
    investigation: 'Investigation',
    outsideStep: 'Hors étape',
    kinds: {
      ACTION: 'Action',
      PAGE: 'Page',
      REQUEST: 'Requête',
      RESPONSE: 'Réponse',
      CONSOLE: 'Console',
      JS_ERROR: 'Erreur JavaScript',
      SCREENSHOT: 'Capture d’écran',
      TRACE: 'Trace Playwright',
      ASSERTION: 'Assertion',
      LOG: 'Journal',
      EXPERIMENT: 'Vérification',
      STATE: 'Historique',
    } as Record<TimelineKind, string>,
    statusLabels: {
      OK: 'OK',
      INFO: 'Info',
      WARNING: 'Avertissement',
      ERROR: 'Erreur',
    } as Record<TimelineStatus, string>,
    openRequest: (label: string) => `Sélectionner la requête ${label}`,
    selectStep: (label: string) => `Sélectionner ${label}`,
    // Requêtes
    requestsTitle: 'Requêtes HTTP',
    requestsSub: 'Les échanges de la reproduction de référence, dans l’ordre des étapes.',
    requestErrorsOnly: 'Seulement les échanges en erreur',
    requestCount: (shown: number, total: number) => `${String(shown)} requête(s) sur ${String(total)}`,
    noReproduction: 'Aucune reproduction terminée du scénario de l’incident : pas de requête à montrer.',
    noRequests: 'Aucune requête enregistrée pendant la reproduction.',
    noErrorRequests: 'Aucun échange en erreur.',
    hostNote:
      'Ni l’hôte ni la chaîne de requête (paramètres après « ? ») ne sont capturés : seul le chemin est gardé, masqué.',
    columns: {
      method: 'Méthode',
      path: 'Chemin',
      status: 'Statut',
      duration: 'Durée',
      step: 'Étape',
      correlation: 'Corrélation',
    },
    requestsCaption: 'Requêtes HTTP de la reproduction de référence',
    noResponse: 'sans réponse',
    // Détail d'une requête
    unknownRequest: 'Cette requête n’existe pas dans les reproductions de l’incident.',
    detailTitle: 'Détail de la requête',
    timing: 'Temps',
    startedAt: 'Départ',
    endedAt: 'Fin',
    durationLabel: 'Durée',
    noStart: 'Heure de départ non capturée (network.captureBodies désactivé).',
    stepLabel: 'Étape',
    reproductionLabel: 'Reproduction',
    correlationLabel: 'Corrélation',
    correlationReasons: {
      OBSERVED: (step?: number) =>
        step !== undefined
          ? `Vue pendant la fenêtre réseau de l’action de l’étape ${String(step)}.`
          : 'Vue pendant la fenêtre réseau d’une action.',
      INFERRED: (step?: number) =>
        step !== undefined
          ? `Rattachée à l’étape ${String(step)} par son horodatage, sans observation directe.`
          : 'Rattachée par son horodatage.',
      STATICALLY_RESOLVED: () => 'Lue dans le code.',
      UNKNOWN: () => 'Aucune étape ne l’encadre : le lien avec une action n’est pas établi.',
    } as Record<RelationStatus, (step?: number) => string>,
    failure: 'Échec réseau',
    requestPayload: 'Corps de la requête (masqué)',
    responsePayload: 'Corps de la réponse (masqué)',
    noPayload: 'Corps non capturé (seulement les erreurs et les écritures, avec network.captureBodies).',
    truncated: 'Corps tronqué à 8 Kio.',
    prettyJson: 'JSON mis en forme',
    requestHeaders: 'En-têtes de la requête',
    responseHeaders: 'En-têtes de la réponse',
    noHeaders:
      'Aucun en-tête gardé : seuls ceux de la liste blanche (type, longueur, cache, redirection, identifiants de corrélation) le sont, avec network.captureBodies.',
    headerName: 'Nom',
    headerValue: 'Valeur (masquée)',
    graphNodes: 'Nœuds du graphe reliés',
    noGraphNodes: 'Aucun nœud du graphe ne cite cette requête.',
    // Journaux
    logsTitle: 'Journaux',
    logsSub: 'Les lignes trouvées par les vérifications INSPECT_LOGS, dans le périmètre autorisé.',
    noLogs:
      'Aucune ligne de journal. Pour en obtenir, ajoutez une vérification INSPECT_LOGS au périmètre (fichiers de journaux de l’application ou OpenShift en lecture, lecture des journaux permise) puis lancez-la.',
    logsDenied: 'La lecture des journaux n’est pas permise par le périmètre (readLogs).',
    logColumns: {
      at: 'Heure',
      source: 'Source',
      pattern: 'Motif',
      line: 'Ligne',
      experiment: 'Vérification',
    },
    logsCaption: 'Lignes de journaux trouvées',
    sourceFile: 'Fichier',
    sourceOpenshift: 'OpenShift',
    logExperiments: 'Vérifications INSPECT_LOGS',
    // Captures
    screenshotLoading: (label: string) => `Chargement de la capture « ${label} »…`,
    screenshotInvalid: 'Format de capture non pris en charge (seules les images data: sont affichées).',
  },
  en: {
    locale: 'en-GB',
    timelineTitle: 'Timeline',
    timelineSub:
      'Actions, requests, responses, console, errors, screenshots, logs, verifications and history, in order.',
    show: 'Show:',
    layers: 'Layers',
    steps: 'Steps',
    allSteps: 'All',
    statuses: 'Statuses',
    origin: 'Reproduction',
    origins: {
      ALL: 'Everything',
      REFERENCE: 'Reference reproduction',
      VERIFICATION: 'Verification replays',
      INVESTIGATION: 'Investigation (history, verifications, logs)',
    } as Record<TimelineOrigin, string>,
    period: 'Period',
    periods: {
      ALL: 'Whole duration',
      REFERENCE: 'Reproduction span',
      ERROR: 'Around the first error (±5 s)',
      CUSTOM: 'Custom range',
    } as Record<TimelinePeriod, string>,
    from: 'From (seconds since start)',
    to: 'To (seconds since start)',
    onlyRelated: 'Only what is related to the selection',
    reset: 'Show everything',
    count: (shown: number, total: number) => `${String(shown)} of ${String(total)} event(s)`,
    noTimeline: 'The timeline is not computed yet: it appears after a reproduction of the incident.',
    noVisible: 'No event matches these display criteria.',
    estimatedNote:
      'Times marked ≈ are estimated (flow start + durations of previous steps): only captured requests and anomalies have measured times.',
    undatedNote: 'Events without a time are hidden when a period is chosen.',
    estimated: 'estimated time',
    noTime: 'unknown time',
    step: (index: number) => `Step ${String(index)}`,
    reference: 'reference',
    verification: 'verification replay',
    investigation: 'Investigation',
    outsideStep: 'Outside steps',
    kinds: {
      ACTION: 'Action',
      PAGE: 'Page',
      REQUEST: 'Request',
      RESPONSE: 'Response',
      CONSOLE: 'Console',
      JS_ERROR: 'JavaScript error',
      SCREENSHOT: 'Screenshot',
      TRACE: 'Playwright trace',
      ASSERTION: 'Assertion',
      LOG: 'Log',
      EXPERIMENT: 'Verification',
      STATE: 'History',
    } as Record<TimelineKind, string>,
    statusLabels: {
      OK: 'OK',
      INFO: 'Info',
      WARNING: 'Warning',
      ERROR: 'Error',
    } as Record<TimelineStatus, string>,
    openRequest: (label: string) => `Select request ${label}`,
    selectStep: (label: string) => `Select ${label}`,
    requestsTitle: 'HTTP requests',
    requestsSub: 'The exchanges of the reference reproduction, in step order.',
    requestErrorsOnly: 'Only failing exchanges',
    requestCount: (shown: number, total: number) => `${String(shown)} of ${String(total)} request(s)`,
    noReproduction: 'No completed reproduction of the incident scenario: no request to show.',
    noRequests: 'No request recorded during the reproduction.',
    noErrorRequests: 'No failing exchange.',
    hostNote:
      'Neither the host nor the query string (parameters after “?”) are captured: only the path is kept, masked.',
    columns: {
      method: 'Method',
      path: 'Path',
      status: 'Status',
      duration: 'Duration',
      step: 'Step',
      correlation: 'Correlation',
    },
    requestsCaption: 'HTTP requests of the reference reproduction',
    noResponse: 'no response',
    unknownRequest: 'This request does not exist in the incident reproductions.',
    detailTitle: 'Request detail',
    timing: 'Timing',
    startedAt: 'Start',
    endedAt: 'End',
    durationLabel: 'Duration',
    noStart: 'Start time not captured (network.captureBodies disabled).',
    stepLabel: 'Step',
    reproductionLabel: 'Reproduction',
    correlationLabel: 'Correlation',
    correlationReasons: {
      OBSERVED: (step?: number) =>
        step !== undefined
          ? `Seen during the network window of the step ${String(step)} action.`
          : 'Seen during the network window of an action.',
      INFERRED: (step?: number) =>
        step !== undefined
          ? `Attached to step ${String(step)} by its timestamp, not directly observed.`
          : 'Attached by its timestamp.',
      STATICALLY_RESOLVED: () => 'Read in the code.',
      UNKNOWN: () => 'No step frames it: the link with an action is not established.',
    } as Record<RelationStatus, (step?: number) => string>,
    failure: 'Network failure',
    requestPayload: 'Request body (masked)',
    responsePayload: 'Response body (masked)',
    noPayload: 'Body not captured (only errors and writes, with network.captureBodies).',
    truncated: 'Body truncated to 8 KiB.',
    prettyJson: 'Formatted JSON',
    requestHeaders: 'Request headers',
    responseHeaders: 'Response headers',
    noHeaders:
      'No header kept: only allowlisted ones (type, length, cache, redirect, correlation identifiers) are, with network.captureBodies.',
    headerName: 'Name',
    headerValue: 'Value (masked)',
    graphNodes: 'Related graph nodes',
    noGraphNodes: 'No graph node cites this request.',
    logsTitle: 'Logs',
    logsSub: 'The lines found by INSPECT_LOGS verifications, within the allowed scope.',
    noLogs:
      'No log line. To get some, add an INSPECT_LOGS verification to the scope (application log files or read-only OpenShift, log reading allowed) and run it.',
    logsDenied: 'Reading logs is not allowed by the scope (readLogs).',
    logColumns: {
      at: 'Time',
      source: 'Source',
      pattern: 'Pattern',
      line: 'Line',
      experiment: 'Verification',
    },
    logsCaption: 'Log lines found',
    sourceFile: 'File',
    sourceOpenshift: 'OpenShift',
    logExperiments: 'INSPECT_LOGS verifications',
    screenshotLoading: (label: string) => `Loading screenshot “${label}”…`,
    screenshotInvalid: 'Unsupported screenshot format (only data: images are shown).',
  },
};

type Text = (typeof TEXT)['fr'];
const textOf = (lang: Lang): Text => TEXT[lang];

const KIND_ICONS: Record<TimelineKind, string> = {
  ACTION: 'play',
  PAGE: 'eye',
  REQUEST: 'arrowR',
  RESPONSE: 'arrowL',
  CONSOLE: 'text',
  JS_ERROR: 'alert',
  SCREENSHOT: 'file',
  TRACE: 'layers',
  ASSERTION: 'check',
  LOG: 'book',
  EXPERIMENT: 'spark',
  STATE: 'refresh',
};

// ── Données ──────────────────────────────────────────────────────────────────────────────────

const timeOf = (at: string | undefined): number => (at ? Date.parse(at) : Number.NaN);

function eventsOf(ctx: WorkspaceContext): TimelineEvent[] {
  return [...(ctx.incident.investigation.timeline ?? [])].sort((left, right) => left.order - right.order);
}

/** Le premier instant daté de la chronologie : l'origine des secondes affichées et de la période CUSTOM. */
function originOf(events: readonly TimelineEvent[]): number | undefined {
  const times = events.map((event) => timeOf(event.at)).filter((time) => Number.isFinite(time));
  return times.length > 0 ? Math.min(...times) : undefined;
}

/** Les bornes (ms) de la période choisie, ou undefined pour « toute la durée ». */
function periodBounds(
  ctx: WorkspaceContext,
  ui: TimelineUi,
  events: readonly TimelineEvent[],
): { from: number; to: number } | undefined {
  switch (ui.period) {
    case 'ALL':
      return undefined;
    case 'REFERENCE': {
      const reference = incidentReproduction(ctx.incident);
      if (!reference) return { from: Number.NaN, to: Number.NaN };
      const own = events
        .filter((event) => event.reproduction === reference.id)
        .map((event) => timeOf(event.at))
        .filter((time) => Number.isFinite(time));
      const start = Math.min(timeOf(reference.startedAt), ...own);
      const finished = timeOf(reference.finishedAt);
      const end = Math.max(Number.isFinite(finished) ? finished : Number.NEGATIVE_INFINITY, ...own);
      return { from: start, to: end };
    }
    case 'ERROR': {
      const reference = incidentReproduction(ctx.incident);
      const errors = events.filter(
        (event) =>
          event.status === 'ERROR' &&
          Number.isFinite(timeOf(event.at)) &&
          (!reference || event.reproduction === reference.id),
      );
      const first = errors[0];
      if (!first) return { from: Number.NaN, to: Number.NaN };
      const time = timeOf(first.at);
      return { from: time - ERROR_MARGIN_MS, to: time + ERROR_MARGIN_MS };
    }
    case 'CUSTOM': {
      const origin = originOf(events);
      if (origin === undefined) return { from: Number.NaN, to: Number.NaN };
      return {
        from: origin + (ui.fromSeconds ?? 0) * 1000,
        to: ui.toSeconds !== undefined ? origin + ui.toSeconds * 1000 : Number.POSITIVE_INFINITY,
      };
    }
  }
}

/** L'événement est-il relié à la sélection (lui-même, sa requête, ses preuves, son étape) ? */
function isRelated(ctx: WorkspaceContext, event: TimelineEvent): boolean {
  const related = ctx.related;
  if (related.has(`event:${event.id}`)) return true;
  if (event.requestId && related.has(`request:${event.requestId}`)) return true;
  if (event.evidence.some((ref) => related.has(`evidence:${ref}`) || related.has(`request:${ref}`)))
    return true;
  return (
    event.step !== undefined &&
    event.reproduction !== undefined &&
    related.has(`step:${stepId(event.reproduction, event.step)}`)
  );
}

/** Les événements affichés : la chronologie de l'incident, restreinte par les critères de `ui`. Pure. */
export function visibleEvents(ctx: WorkspaceContext, ui: TimelineUi): TimelineEvent[] {
  const events = eventsOf(ctx);
  const reference = incidentReproduction(ctx.incident)?.id;
  const bounds = periodBounds(ctx, ui, events);
  return events.filter((event) => {
    if (ui.layers.length > 0 && !ui.layers.includes(event.layer)) return false;
    if (ui.statuses.length > 0 && !ui.statuses.includes(event.status)) return false;
    if (ui.steps.length > 0 && (event.step === undefined || !ui.steps.includes(event.step))) return false;
    switch (ui.origin) {
      case 'REFERENCE':
        if (reference === undefined || event.reproduction !== reference) return false;
        break;
      case 'VERIFICATION':
        if (event.reproduction === undefined || event.reproduction === reference) return false;
        break;
      case 'INVESTIGATION':
        if (event.reproduction !== undefined) return false;
        break;
      case 'ALL':
        break;
    }
    if (bounds) {
      const time = timeOf(event.at);
      if (!Number.isFinite(time) || !(time >= bounds.from && time <= bounds.to)) return false;
    }
    if (ui.onlyRelated && ctx.selection && !isRelated(ctx, event)) return false;
    return true;
  });
}

// ── Mise en forme ────────────────────────────────────────────────────────────────────────────

function clock(lang: Lang, at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString(textOf(lang).locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function formatSeconds(lang: Lang, ms: number): string {
  return `+${(ms / 1000).toLocaleString(textOf(lang).locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

function formatDuration(lang: Lang, ms: number): string {
  return ms < 1000
    ? `${String(Math.round(ms))} ms`
    : `${(ms / 1000).toLocaleString(textOf(lang).locale, { maximumFractionDigits: 2 })} s`;
}

const statusClass = (status: TimelineStatus): string => `ws-timeline-st-${status.toLowerCase()}`;

function httpPill(request: Pick<HttpExchange, 'status' | 'failure'>, t: Text): string {
  if (request.status === undefined)
    return `<span class="pill ko">${esc(request.failure !== undefined ? t.failure : t.noResponse)}</span>`;
  const tone = request.status >= 500 ? 'ko' : request.status >= 400 ? 'warn' : 'ok';
  return `<span class="pill ${tone}">${String(request.status)}</span>`;
}

function timeCell(lang: Lang, event: TimelineEvent, origin: number | undefined): string {
  const t = textOf(lang);
  if (!event.at) return `<span class="ws-timeline-time mu">${esc(t.noTime)}</span>`;
  const time = timeOf(event.at);
  const offset = origin !== undefined && Number.isFinite(time) ? formatSeconds(lang, time - origin) : '';
  return `<span class="ws-timeline-time"><time datetime="${esc(event.at)}">${event.estimated ? `<span class="ws-timeline-est" title="${esc(t.estimated)}" aria-label="${esc(t.estimated)}">≈</span>` : ''}${esc(clock(lang, event.at))}</time>${offset ? `<small class="mu">${esc(offset)}</small>` : ''}</span>`;
}

function findRequest(
  ctx: WorkspaceContext,
  requestId: string,
): { request: HttpExchange; run: ReproductionRun } | undefined {
  for (const run of ctx.incident.investigation.reproductions) {
    const request = run.requests.find((entry) => entry.id === requestId);
    if (request) return { request, run };
  }
  return undefined;
}

function requestLabel(request: Pick<HttpExchange, 'method' | 'path'>): string {
  return `${request.method} ${request.path}`;
}

function toggleButton(action: string, attrs: string, pressed: boolean, label: string): string {
  return `<button type="button" class="ws-timeline-tog" data-action="${action}" ${attrs} aria-pressed="${String(pressed)}">${label}</button>`;
}

function controlGroup(legend: string, body: string): string {
  return `<div class="ws-timeline-grp" role="group" aria-label="${esc(legend)}"><span class="ws-timeline-lbl">${esc(legend)}</span><span class="ws-timeline-opts">${body}</span></div>`;
}

// ── « Chronologie » ──────────────────────────────────────────────────────────────────────────

function renderControls(ctx: WorkspaceContext, ui: TimelineUi, events: readonly TimelineEvent[]): string {
  const t = textOf(ctx.lang);
  const parts = partsText(ctx.lang);
  const layers = LAYERS.filter((layer) => events.some((event) => event.layer === layer));
  const steps = [...new Set(events.map((event) => event.step).filter((step) => step !== undefined))].sort(
    (left, right) => left - right,
  );
  const groups = [
    controlGroup(
      t.layers,
      layers
        .map((layer) =>
          toggleButton(
            'ws-timeline-layer',
            `data-layer="${layer}"`,
            ui.layers.includes(layer),
            esc(parts.layers[layer]),
          ),
        )
        .join(''),
    ),
    steps.length > 0
      ? controlGroup(
          t.steps,
          toggleButton('ws-timeline-step', 'data-step="all"', ui.steps.length === 0, esc(t.allSteps)) +
            steps
              .map((step) =>
                toggleButton(
                  'ws-timeline-step',
                  `data-step="${String(step)}" aria-label="${esc(t.step(step))}"`,
                  ui.steps.includes(step),
                  String(step),
                ),
              )
              .join(''),
        )
      : '',
    controlGroup(
      t.statuses,
      TIMELINE_STATUSES.map((status) =>
        toggleButton(
          'ws-timeline-status',
          `data-status="${status}"`,
          ui.statuses.includes(status),
          `<span class="ws-timeline-dot ${statusClass(status)}" aria-hidden="true"></span>${esc(t.statusLabels[status])}`,
        ),
      ).join(''),
    ),
    controlGroup(
      t.origin,
      TIMELINE_ORIGINS.map((origin) =>
        toggleButton(
          'ws-timeline-origin',
          `data-value="${origin}"`,
          ui.origin === origin,
          esc(t.origins[origin]),
        ),
      ).join(''),
    ),
    controlGroup(
      t.period,
      TIMELINE_PERIODS.map((period) =>
        toggleButton(
          'ws-timeline-period',
          `data-value="${period}"`,
          ui.period === period,
          esc(t.periods[period]),
        ),
      ).join('') +
        (ui.period === 'CUSTOM'
          ? `<label class="ws-timeline-num"><span>${esc(t.from)}</span><input type="number" min="0" step="1" inputmode="decimal" data-action="ws-timeline-from" value="${ui.fromSeconds !== undefined ? String(ui.fromSeconds) : ''}"></label><label class="ws-timeline-num"><span>${esc(t.to)}</span><input type="number" min="0" step="1" inputmode="decimal" data-action="ws-timeline-to" value="${ui.toSeconds !== undefined ? String(ui.toSeconds) : ''}"></label>`
          : ''),
    ),
  ];
  const related = ctx.selection
    ? `<label class="ws-timeline-rel"><input type="checkbox" data-action="ws-timeline-related"${ui.onlyRelated ? ' checked' : ''}> ${esc(t.onlyRelated)}</label>`
    : '';
  return `<div class="ws-timeline-ctl"><p class="ws-timeline-show">${esc(t.show)}</p>${groups.join('')}<div class="ws-timeline-row">${related}<button type="button" class="btn small ghost" data-action="ws-timeline-reset">${esc(t.reset)}</button></div></div>`;
}

function groupHeader(ctx: WorkspaceContext, event: TimelineEvent, reference: string | undefined): string {
  const t = textOf(ctx.lang);
  if (event.reproduction === undefined) return `<h3 class="ws-timeline-gh">${esc(t.investigation)}</h3>`;
  const run = ctx.incident.investigation.reproductions.find((entry) => entry.id === event.reproduction);
  const origin = `<small class="mu">${esc(event.reproduction)} · ${esc(event.reproduction === reference ? t.reference : `${t.verification}${run ? ` (${run.scenario})` : ''}`)}</small>`;
  if (event.step === undefined) return `<h3 class="ws-timeline-gh">${esc(t.outsideStep)} ${origin}</h3>`;
  const action = run?.actions.find((entry) => entry.index === event.step);
  const label = `${t.step(event.step)}${action ? ` : ${action.description}` : ''}`;
  const id = stepId(event.reproduction, event.step);
  return `<h3 class="ws-timeline-gh"><button type="button" class="lnk ws-timeline-step ${selectionClass(ctx, 'step', id)}" ${selectable(ctx, 'step', id)} aria-label="${esc(t.selectStep(label))}">${esc(label)}</button> ${origin}</h3>`;
}

function eventItem(ctx: WorkspaceContext, event: TimelineEvent, origin: number | undefined): string {
  const t = textOf(ctx.lang);
  const found = event.requestId ? findRequest(ctx, event.requestId) : undefined;
  const requestButton =
    event.requestId !== undefined
      ? `<button type="button" class="ws-chip ws-timeline-reqref ${selectionClass(ctx, 'request', event.requestId)}" ${selectable(ctx, 'request', event.requestId)} aria-label="${esc(t.openRequest(found ? requestLabel(found.request) : event.requestId))}">${icon('link')}${esc(found ? requestLabel(found.request) : event.requestId)}</button>`
      : '';
  const chips = evidenceChips(
    ctx,
    event.evidence.filter((ref) => ref !== event.requestId),
  );
  const source = event.source ? sourceLink(ctx.lang, event.source) : '';
  const extra = requestButton || chips || source;
  return `<li class="ws-timeline-ev ${statusClass(event.status)} ${selectionClass(ctx, 'event', event.id)}"><button type="button" class="ws-timeline-main" ${selectable(ctx, 'event', event.id)}>${timeCell(ctx.lang, event, origin)}<span class="ws-timeline-kind">${icon(KIND_ICONS[event.kind])}${esc(t.kinds[event.kind])}</span><span class="ws-timeline-status">${esc(t.statusLabels[event.status])}</span><span class="ws-timeline-sum">${esc(event.summary)}</span></button>${extra ? `<span class="ws-timeline-extra">${requestButton}${chips}${source}</span>` : ''}</li>`;
}

/** L'onglet « Chronologie » : critères d'affichage, notes, liste verticale groupée par étape. */
export function renderTimeline(ctx: WorkspaceContext, ui: TimelineUi): string {
  const t = textOf(ctx.lang);
  const events = eventsOf(ctx);
  const head = `<header class="ws-timeline-head"><h2>${esc(t.timelineTitle)}</h2><p class="mu">${esc(t.timelineSub)}</p></header>`;
  if (events.length === 0)
    return `<section class="ws-timeline">${demoBanner(ctx)}${head}${panelState(ctx.lang, 'empty', t.noTimeline)}</section>`;
  const visible = visibleEvents(ctx, ui);
  const origin = originOf(events);
  const reference = incidentReproduction(ctx.incident)?.id;
  const notes: string[] = [];
  if (visible.some((event) => event.estimated)) notes.push(t.estimatedNote);
  if (ui.period !== 'ALL' && events.some((event) => !event.at)) notes.push(t.undatedNote);
  let body: string;
  if (visible.length === 0) body = panelState(ctx.lang, 'empty', t.noVisible);
  else {
    const groups: string[] = [];
    let key: string | undefined;
    let items: string[] = [];
    const flush = (header: string): void => {
      groups.push(
        `<li class="ws-timeline-group">${header}<ol class="ws-timeline-list">${items.join('')}</ol></li>`,
      );
      items = [];
    };
    let header = '';
    for (const event of visible) {
      const next = `${event.reproduction ?? ''}#${event.step !== undefined ? String(event.step) : ''}`;
      if (next !== key) {
        if (key !== undefined) flush(header);
        key = next;
        header = groupHeader(ctx, event, reference);
      }
      items.push(eventItem(ctx, event, origin));
    }
    flush(header);
    body = `<ol class="ws-timeline-groups">${groups.join('')}</ol>`;
  }
  return `<section class="ws-timeline">${demoBanner(ctx)}${head}${renderControls(ctx, ui, events)}<p class="ws-timeline-count mu">${esc(t.count(visible.length, events.length))}</p>${notes.map((note) => `<p class="ws-timeline-note" role="note">${esc(note)}</p>`).join('')}${body}</section>`;
}

// ── « Requêtes HTTP » ────────────────────────────────────────────────────────────────────────

const isFailing = (request: HttpExchange): boolean =>
  request.failure !== undefined || (request.status ?? 0) >= 400;

/** L'onglet « Requêtes HTTP » : les échanges de la reproduction de référence, sélectionnables. */
export function renderRequests(ctx: WorkspaceContext, ui: TimelineUi): string {
  const t = textOf(ctx.lang);
  const head = `<header class="ws-timeline-head"><h2>${esc(t.requestsTitle)}</h2><p class="mu">${esc(t.requestsSub)}</p></header>`;
  const reference = incidentReproduction(ctx.incident);
  if (!reference)
    return `<section class="ws-timeline">${demoBanner(ctx)}${head}${panelState(ctx.lang, 'empty', t.noReproduction)}</section>`;
  const requests = [...reference.requests].sort(
    (left, right) =>
      (left.step ?? Number.MAX_SAFE_INTEGER) - (right.step ?? Number.MAX_SAFE_INTEGER) ||
      reference.requests.indexOf(left) - reference.requests.indexOf(right),
  );
  const shown = ui.requestErrorsOnly ? requests.filter(isFailing) : requests;
  const toggleErrors = `<label class="ws-timeline-rel"><input type="checkbox" data-action="ws-timeline-req-errors"${ui.requestErrorsOnly ? ' checked' : ''}> ${esc(t.requestErrorsOnly)}</label>`;
  const note = `<p class="ws-timeline-note" role="note">${esc(t.hostNote)}</p>`;
  if (requests.length === 0)
    return `<section class="ws-timeline">${demoBanner(ctx)}${head}${panelState(ctx.lang, 'empty', t.noRequests)}${note}</section>`;
  const c = t.columns;
  const rows = shown
    .map((request) => {
      const step =
        request.step !== undefined
          ? `<button type="button" class="lnk ${selectionClass(ctx, 'step', stepId(reference.id, request.step))}" ${selectable(ctx, 'step', stepId(reference.id, request.step))} aria-label="${esc(t.selectStep(t.step(request.step)))}">${String(request.step)}</button>`
          : '—';
      return `<tr class="ws-timeline-tr ${isFailing(request) ? 'ws-timeline-tr-ko' : ''} ${selectionClass(ctx, 'request', request.id)}"><td><code>${esc(request.method)}</code></td><td><button type="button" class="lnk ws-timeline-path" ${selectable(ctx, 'request', request.id)} aria-label="${esc(t.openRequest(requestLabel(request)))}"><code>${esc(request.path)}</code></button></td><td>${httpPill(request, t)}</td><td class="ws-timeline-dur">${request.durationMs !== undefined ? esc(formatDuration(ctx.lang, request.durationMs)) : '—'}</td><td class="ws-timeline-dur">${step}</td><td>${relationBadge(ctx.lang, request.correlation)}</td></tr>`;
    })
    .join('');
  const table =
    shown.length === 0
      ? panelState(ctx.lang, 'empty', t.noErrorRequests)
      : `<div class="tw"><table class="tbl ws-timeline-tbl"><caption class="ws-timeline-sr">${esc(t.requestsCaption)}</caption><thead><tr><th scope="col">${esc(c.method)}</th><th scope="col">${esc(c.path)}</th><th scope="col">${esc(c.status)}</th><th scope="col" class="ws-timeline-dur">${esc(c.duration)}</th><th scope="col" class="ws-timeline-dur">${esc(c.step)}</th><th scope="col">${esc(c.correlation)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<section class="ws-timeline">${demoBanner(ctx)}${head}<div class="ws-timeline-row">${toggleErrors}<span class="mu">${esc(t.requestCount(shown.length, requests.length))}</span></div>${table}${note}</section>`;
}

// ── Détail d'une requête ─────────────────────────────────────────────────────────────────────

/** Les clés JSON masquées par l'interface en plus du serveur (défense en profondeur). */
const SENSITIVE_KEY =
  /password|passwd|secret|token|authorization|cookie|session|apikey|api_key|credential|private/i;
const SENSITIVE_HEADER =
  /authorization|cookie|^proxy-|api[-_]?key|secret|token|session|credential|passw|auth/i;
const MASK = '[REDACTED]';
const TRUNCATED = '…[truncated]';

function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? MASK : maskJson(entry),
      ]),
    );
  return value;
}

function maskText(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]{6,}/gi, `$1 ${MASK}`)
    .replace(
      /(["']?\b(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)\b["']?\s*[:=]\s*)(["']?)[^\s"'&,;}]+\2/gi,
      `$1$2${MASK}$2`,
    );
}

/** Un corps prêt à l'affichage : JSON valide mis en forme (clés sensibles masquées), sinon le texte masqué. */
export function prettyBody(text: string): { text: string; json: boolean; truncated: boolean } {
  const truncated = text.endsWith(TRUNCATED);
  if (!truncated && /^\s*[[{]/.test(text)) {
    try {
      return { text: JSON.stringify(maskJson(JSON.parse(text)), null, 2), json: true, truncated };
    } catch {
      // Pas du JSON : affiché comme du texte.
    }
  }
  return { text: maskText(text), json: false, truncated };
}

function payload(ctx: WorkspaceContext, title: string, body: string | undefined, open: boolean): string {
  const t = textOf(ctx.lang);
  if (body === undefined)
    return `<div class="ws-timeline-pl"><h4>${esc(title)}</h4><p class="mu">${esc(t.noPayload)}</p></div>`;
  const pretty = prettyBody(body);
  return `<details class="ws-timeline-pl"${open ? ' open' : ''}><summary>${esc(title)}${pretty.json ? ` <small class="mu">${esc(t.prettyJson)}</small>` : ''}</summary><pre class="ws-timeline-pre">${esc(pretty.text)}</pre>${pretty.truncated ? `<p class="mu">${esc(t.truncated)}</p>` : ''}</details>`;
}

function headersBlock(
  ctx: WorkspaceContext,
  title: string,
  headers: Record<string, string> | undefined,
): string {
  const t = textOf(ctx.lang);
  const entries = Object.entries(headers ?? {})
    .filter(([name]) => !SENSITIVE_HEADER.test(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0)
    return `<div class="ws-timeline-hd"><h4>${esc(title)}</h4><p class="mu">${esc(t.noHeaders)}</p></div>`;
  return `<div class="ws-timeline-hd"><h4>${esc(title)}</h4><dl class="ws-timeline-dl">${entries
    .map(
      ([name, value]) =>
        `<div><dt><code>${esc(name)}</code></dt><dd><code>${esc(maskText(value))}</code></dd></div>`,
    )
    .join('')}</dl></div>`;
}

function linkedNodes(ctx: WorkspaceContext, requestId: string): GraphNode[] {
  const key = `request:${requestId}`;
  const keys = new Set<string>(ctx.links.neighbors.get(key) ?? []);
  const selected = ctx.selection ? `${ctx.selection.kind}:${ctx.selection.id}` : undefined;
  if (selected === key) for (const entry of ctx.related) keys.add(entry);
  return (ctx.incident.investigation.graph?.nodes ?? []).filter(
    (node) => keys.has(`node:${node.id}`) || node.evidence.includes(requestId),
  );
}

/** Le détail d'une requête (panneau latéral) : temps, étape, corrélation, en-têtes, corps, nœuds reliés. */
export function renderRequestDetail(ctx: WorkspaceContext, requestId: string): string {
  const t = textOf(ctx.lang);
  const parts = partsText(ctx.lang);
  const found = findRequest(ctx, requestId);
  if (!found) return panelState(ctx.lang, 'empty', t.unknownRequest);
  const { request, run } = found;
  const reference = incidentReproduction(ctx.incident)?.id;
  const start = timeOf(request.startedAt);
  const end =
    Number.isFinite(start) && request.durationMs !== undefined ? start + request.durationMs : Number.NaN;
  const timing = `<dl class="ws-timeline-dl">${
    request.startedAt
      ? `<div><dt>${esc(t.startedAt)}</dt><dd><time datetime="${esc(request.startedAt)}">${esc(clock(ctx.lang, request.startedAt))}</time></dd></div>`
      : ''
  }${
    Number.isFinite(end)
      ? `<div><dt>${esc(t.endedAt)}</dt><dd><time datetime="${esc(new Date(end).toISOString())}">${esc(clock(ctx.lang, new Date(end).toISOString()))}</time></dd></div>`
      : ''
  }${
    request.durationMs !== undefined
      ? `<div><dt>${esc(t.durationLabel)}</dt><dd>${esc(formatDuration(ctx.lang, request.durationMs))}</dd></div>`
      : ''
  }</dl>${request.startedAt ? '' : `<p class="mu">${esc(t.noStart)}</p>`}`;
  const step =
    request.step !== undefined
      ? (() => {
          const action = run.actions.find((entry) => entry.index === request.step);
          const label = `${t.step(request.step)}${action ? ` : ${action.description}` : ''}`;
          const id = stepId(run.id, request.step);
          return `<button type="button" class="lnk ${selectionClass(ctx, 'step', id)}" ${selectable(ctx, 'step', id)} aria-label="${esc(t.selectStep(label))}">${esc(label)}</button>`;
        })()
      : '—';
  const nodes = linkedNodes(ctx, requestId);
  const nodeList =
    nodes.length === 0
      ? `<p class="mu">${esc(t.noGraphNodes)}</p>`
      : `<ul class="ws-timeline-nodes">${nodes
          .map(
            (node) =>
              `<li><button type="button" class="lnk ${selectionClass(ctx, 'node', node.id)}" ${selectable(ctx, 'node', node.id)}>${esc(node.label)}</button> <small class="mu">${esc(parts.layers[node.layer])} · ${esc(node.kind)}</small>${node.source ? ` ${sourceLink(ctx.lang, node.source)}` : ''}</li>`,
          )
          .join('')}</ul>`;
  const correlationReason = t.correlationReasons[request.correlation](request.step);
  return `<article class="ws-timeline-detail" aria-label="${esc(`${t.detailTitle} ${requestLabel(request)}`)}">
<header><h3><code>${esc(request.method)}</code> <code>${esc(request.path)}</code> ${httpPill(request, t)}</h3>
<p class="mu">${esc(t.reproductionLabel)} : ${esc(run.id)} · ${esc(run.id === reference ? t.reference : t.verification)}</p></header>
${request.failure !== undefined ? `<p class="err" role="alert"><b>${esc(t.failure)}</b> : ${esc(request.failure)}</p>` : ''}
<section><h4>${esc(t.timing)}</h4>${timing}</section>
<section><h4>${esc(t.stepLabel)}</h4><p>${step}</p></section>
<section><h4>${esc(t.correlationLabel)}</h4><p>${relationBadge(ctx.lang, request.correlation)} ${esc(correlationReason)}</p></section>
${headersBlock(ctx, t.requestHeaders, request.requestHeaders)}
${payload(ctx, t.requestPayload, request.requestBody, false)}
${headersBlock(ctx, t.responseHeaders, request.responseHeaders)}
${payload(ctx, t.responsePayload, request.responseBody, isFailing(request))}
<section><h4>${esc(t.graphNodes)}</h4>${nodeList}</section>
<p class="ws-timeline-note" role="note">${esc(t.hostNote)}</p>
</article>`;
}

// ── « Journaux » ─────────────────────────────────────────────────────────────────────────────

interface LogRow {
  evidence: Evidence;
  experiment?: Experiment;
}

function logRows(ctx: WorkspaceContext): LogRow[] {
  const rows: LogRow[] = [];
  for (const experiment of ctx.incident.investigation.experiments)
    for (const item of experiment.evidence)
      if (item.kind === 'LOG_LINE') rows.push({ evidence: item, experiment });
  for (const run of ctx.incident.investigation.reproductions)
    for (const item of run.evidence) if (item.kind === 'LOG_LINE') rows.push({ evidence: item });
  const at = (row: LogRow): number => {
    const value = row.evidence.data?.at;
    return typeof value === 'string' ? timeOf(value) : Number.NaN;
  };
  return rows
    .map((row, index) => ({ row, index, time: at(row) }))
    .sort(
      (left, right) =>
        (Number.isFinite(left.time) ? left.time : Number.POSITIVE_INFINITY) -
          (Number.isFinite(right.time) ? right.time : Number.POSITIVE_INFINITY) || left.index - right.index,
    )
    .map((entry) => entry.row);
}

function logSource(lang: Lang, item: Evidence): string {
  const t = textOf(lang);
  const label = typeof item.data?.source === 'string' ? item.data.source : (item.source.file ?? '—');
  const openshift = label.startsWith('openshift ');
  return `<span class="pill mu">${esc(openshift ? t.sourceOpenshift : t.sourceFile)}</span> <code>${esc(openshift ? label.slice('openshift '.length) : (item.source.file ?? label))}</code>`;
}

/** L'onglet « Journaux » : les lignes LOG_LINE, leur source (fichier, OpenShift), le motif et l'heure. */
export function renderLogs(ctx: WorkspaceContext): string {
  const t = textOf(ctx.lang);
  const head = `<header class="ws-timeline-head"><h2>${esc(t.logsTitle)}</h2><p class="mu">${esc(t.logsSub)}</p></header>`;
  const rows = logRows(ctx);
  const inspections = ctx.incident.investigation.experiments.filter(
    (experiment) => experiment.kind === 'INSPECT_LOGS',
  );
  const experimentsList =
    inspections.length > 0
      ? `<div class="ws-timeline-exps"><h3>${esc(t.logExperiments)}</h3><ul>${inspections
          .map(
            (experiment) =>
              `<li><button type="button" class="lnk ${selectionClass(ctx, 'experiment', experiment.id)}" ${selectable(ctx, 'experiment', experiment.id)}>${esc(experiment.id)}</button> <span class="pill mu">${esc(experiment.status)}</span> <span>${esc(experiment.summary ?? experiment.description)}</span></li>`,
          )
          .join('')}</ul></div>`
      : '';
  if (rows.length === 0) {
    const denied = !ctx.incident.scope.permissions.readLogs
      ? `<p class="ws-timeline-note" role="note">${esc(t.logsDenied)}</p>`
      : '';
    return `<section class="ws-timeline">${demoBanner(ctx)}${head}${experimentsList}${panelState(ctx.lang, 'empty', t.noLogs)}${denied}</section>`;
  }
  const c = t.logColumns;
  const body = rows
    .map(({ evidence, experiment }) => {
      const at = typeof evidence.data?.at === 'string' ? evidence.data.at : undefined;
      const pattern = typeof evidence.data?.pattern === 'string' ? evidence.data.pattern : '—';
      return `<tr class="${selectionClass(ctx, 'evidence', evidence.id)}"><td>${at ? `<time datetime="${esc(at)}">${esc(clock(ctx.lang, at))}</time>` : `<span class="mu">${esc(t.noTime)}</span>`}</td><td>${logSource(ctx.lang, evidence)}</td><td><code>${esc(pattern)}</code></td><td><button type="button" class="ws-timeline-logline" ${selectable(ctx, 'evidence', evidence.id)}><code>${esc(evidence.summary)}</code></button></td><td>${experiment ? `<button type="button" class="lnk ${selectionClass(ctx, 'experiment', experiment.id)}" ${selectable(ctx, 'experiment', experiment.id)}>${esc(experiment.id)}</button>` : '—'}</td></tr>`;
    })
    .join('');
  return `<section class="ws-timeline">${demoBanner(ctx)}${head}${experimentsList}<div class="tw"><table class="tbl ws-timeline-tbl"><caption class="ws-timeline-sr">${esc(t.logsCaption)}</caption><thead><tr><th scope="col">${esc(c.at)}</th><th scope="col">${esc(c.source)}</th><th scope="col">${esc(c.pattern)}</th><th scope="col">${esc(c.line)}</th><th scope="col">${esc(c.experiment)}</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

// ── Capture d'écran ──────────────────────────────────────────────────────────────────────────

/**
 * Une capture d'écran (preuve SCREENSHOT) : l'image quand le contrôleur a obtenu son URL data:, un état
 * de chargement sinon. Seules les images `data:image/…` sont affichées (la CSP n'autorise que celles-là).
 */
export function renderScreenshot(ctx: WorkspaceContext, dataUrl: string | undefined, label: string): string {
  const t = textOf(ctx.lang);
  if (dataUrl === undefined) return panelState(ctx.lang, 'loading', t.screenshotLoading(label));
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(dataUrl))
    return panelState(ctx.lang, 'error', t.screenshotInvalid);
  return `<figure class="ws-timeline-shot"><img src="${esc(dataUrl)}" alt="${esc(label)}" loading="lazy" decoding="async"><figcaption class="mu">${esc(label)}</figcaption></figure>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

export const INCIDENT_TIMELINE_CSS = `
.ws-timeline{display:flex;flex-direction:column;gap:12px;min-width:0}
.ws-timeline-head h2{margin:0;font-size:18px}
.ws-timeline-head p{margin:4px 0 0}
.ws-timeline-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ws-timeline-ctl{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.ws-timeline-show{margin:0;font-weight:600}
.ws-timeline-grp{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.ws-timeline-lbl{font-size:12px;color:var(--qa-color-muted);font-weight:600;min-width:90px}
.ws-timeline-opts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ws-timeline-tog{min-height:32px;padding:2px 10px;border-radius:999px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-text);font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ws-timeline-tog:hover{border-color:var(--qa-color-primary)}
.ws-timeline-tog[aria-pressed="true"]{border-color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 14%,var(--qa-color-surface));font-weight:600}
.ws-timeline-tog:focus-visible,.ws-timeline-main:focus-visible,.ws-timeline-logline:focus-visible,.ws-timeline .lnk:focus-visible,.ws-timeline-detail .lnk:focus-visible,.ws-timeline-pl summary:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-timeline-num{display:inline-flex;flex-direction:column;gap:2px;font-size:12px;color:var(--qa-color-muted)}
.ws-timeline-num input{width:110px;min-height:32px;border:1px solid var(--qa-color-border-strong);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);padding:0 8px}
.ws-timeline-num input:focus-visible,.ws-timeline-rel input:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-timeline-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.ws-timeline-rel{display:inline-flex;align-items:center;gap:6px;min-height:32px;cursor:pointer}
.ws-timeline-count{margin:0;font-size:13px}
.ws-timeline-note{margin:0;padding:8px 12px;border-left:3px solid var(--qa-color-warning);background:color-mix(in srgb,var(--qa-color-warning) 8%,transparent);border-radius:6px;font-size:13px}
.ws-timeline-groups,.ws-timeline-list{list-style:none;margin:0;padding:0}
.ws-timeline-group{margin:0 0 12px}
.ws-timeline-gh{margin:0 0 6px;font-size:14px;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.ws-timeline-list{border-left:2px solid var(--qa-color-border);margin-left:6px;padding-left:10px;display:flex;flex-direction:column;gap:4px}
.ws-timeline-ev{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:4px 8px;border-left:4px solid var(--qa-color-border);border-radius:6px;background:var(--qa-color-surface)}
.ws-timeline-ev.ws-timeline-st-ok{border-left-color:var(--qa-color-success)}
.ws-timeline-ev.ws-timeline-st-info{border-left-color:var(--qa-color-border-strong)}
.ws-timeline-ev.ws-timeline-st-warning{border-left-color:var(--qa-color-warning)}
.ws-timeline-ev.ws-timeline-st-error{border-left-color:var(--qa-color-danger);background:color-mix(in srgb,var(--qa-color-danger) 6%,var(--qa-color-surface))}
.ws-timeline-main{flex:1 1 320px;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;border:0;background:none;color:var(--qa-color-text);text-align:left;cursor:pointer;padding:4px 0;min-height:32px;font:inherit}
.ws-timeline-time{display:inline-flex;gap:6px;align-items:baseline;font:12px var(--qa-font-family-mono);min-width:120px}
.ws-timeline-est{color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text));font-weight:700;margin-right:2px}
.ws-timeline-kind{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;color:var(--qa-color-muted);min-width:120px}
.ws-timeline-kind .ico{width:14px;height:14px}
.ws-timeline-status{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.ws-timeline-st-error .ws-timeline-status{color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text))}
.ws-timeline-st-warning .ws-timeline-status{color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.ws-timeline-st-ok .ws-timeline-status{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.ws-timeline-sum{flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.ws-timeline-extra{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center}
.ws-timeline-reqref{display:inline-flex;align-items:center;gap:4px}
.ws-timeline-reqref .ico{width:12px;height:12px}
.ws-timeline-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--qa-color-border-strong)}
.ws-timeline-dot.ws-timeline-st-ok{background:var(--qa-color-success)}
.ws-timeline-dot.ws-timeline-st-warning{background:var(--qa-color-warning)}
.ws-timeline-dot.ws-timeline-st-error{background:var(--qa-color-danger)}
.ws-timeline-tbl{min-width:560px}
.ws-timeline-tbl td{padding:8px}
.ws-timeline-tbl .ws-timeline-dur{white-space:nowrap;overflow-wrap:normal;min-width:9ch;font-variant-numeric:tabular-nums}
.ws-timeline-tr-ko td:first-child{box-shadow:inset 3px 0 0 var(--qa-color-danger)}
.ws-timeline-path{min-height:32px;overflow-wrap:anywhere}
.ws-timeline-logline{border:0;background:none;color:var(--qa-color-text);text-align:left;cursor:pointer;padding:4px 0;min-height:32px;overflow-wrap:anywhere;font:inherit}
.ws-timeline-detail{display:flex;flex-direction:column;gap:10px;min-width:0}
.ws-timeline-detail h3{margin:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:15px;overflow-wrap:anywhere}
.ws-timeline-detail h4{margin:0 0 4px;font-size:13px;color:var(--qa-color-muted)}
.ws-timeline-detail section p,.ws-timeline-detail header p{margin:0}
.ws-timeline-dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px 12px;margin:0}
.ws-timeline-dl div{min-width:0}
.ws-timeline-dl dt{font-size:12px;color:var(--qa-color-muted)}
.ws-timeline-dl dd{margin:0;overflow-wrap:anywhere}
.ws-timeline-pl summary{cursor:pointer;font-weight:600;min-height:32px;display:flex;align-items:center;gap:6px}
.ws-timeline-pl h4{margin:0 0 4px}
.ws-timeline-pre{margin:4px 0 0;padding:10px;max-height:320px;overflow:auto;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2);color:var(--qa-color-text);font:12px/1.5 var(--qa-font-family-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.ws-timeline-nodes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ws-timeline-exps h3{margin:0 0 4px;font-size:14px}
.ws-timeline-exps ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.ws-timeline-shot{margin:0;display:flex;flex-direction:column;gap:6px}
.ws-timeline-shot img{max-width:100%;height:auto;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2)}
@media (max-width:640px){.ws-timeline-lbl{min-width:0;width:100%}.ws-timeline-time,.ws-timeline-kind{min-width:0}}
`;
