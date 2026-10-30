import type {
  RunLogCategory,
  RunLogEvent,
  RunLogLevel,
  RunLogStatus,
  TestRunView,
} from '../core/contracts.js';
import { RUN_LOG_CATEGORIES, RUN_LOG_LEVELS, RUN_LOG_STATUSES } from '../core/contracts.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA CONSOLE D'EXÉCUTION DE L'ÉDITEUR : le journal réel d'une exécution (moteur, reporter Playwright,
 * Maven et pilote Playwright Java), reçu en direct ou relu une fois le run terminé. Des fonctions pures :
 * les critères d'affichage, la progression des étapes, les erreurs, le résumé, le HTML d'une ligne. La liste des
 * lignes elle-même est tenue par le contrôleur (ajout ligne à ligne, sans redessiner l'écran).
 */

export const CONSOLE_TABS = [
  'console',
  'steps',
  'errors',
  'network',
  'browser',
  'summary',
  'diagnostics',
] as const;
export type ConsoleTab = (typeof CONSOLE_TABS)[number];

export type ConsoleConnection =
  'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'interrupted' | 'unavailable';

export interface ConsoleFilters {
  levels: RunLogLevel[];
  category: RunLogCategory | '';
  step: string;
  type: string;
  status: RunLogStatus | '';
  text: string;
  /** Période : heures locales « HH:MM:SS » (vide : sans borne). */
  from: string;
  to: string;
}

export interface ConsoleUi {
  open: boolean;
  /** La hauteur du panneau (px) choisie avec la poignée ; 0 : la part par défaut de l'éditeur. */
  height: number;
  /** La console occupe toute la colonne de l'éditeur (le code est masqué, pas fermé). */
  maximized: boolean;
  tab: ConsoleTab;
  /** L'exécution suivie, et sa vue (format, outil, statut). */
  runId?: string;
  run?: TestRunView;
  /** Les événements reçus de CE run (la référence tenue par le contrôleur). */
  events: RunLogEvent[];
  connection: ConsoleConnection;
  attempt?: number;
  filters: ConsoleFilters;
  /** Suivre les nouvelles lignes en bas de la liste. */
  follow: boolean;
  /** Suivi visuel en pause (le moteur, lui, continue). */
  paused: boolean;
  /** Lignes arrivées sans être montrées (suivi désactivé ou en pause). */
  unseen: number;
  /** Effacé localement jusqu'à ce `seq` (le journal conservé n'est pas touché). */
  cleared: number;
  /** Événements oubliés par l'écran (au-delà de la limite en mémoire) : le téléchargement les garde. */
  dropped: number;
  stopping?: 'requested' | 'failed';
  stopError?: string;
  /** Les critères fins dépliés. */
  moreFilters: boolean;
}

export const DEFAULT_LEVELS: RunLogLevel[] = ['INFO', 'WARN', 'ERROR'];

export const emptyFilters = (): ConsoleFilters => ({
  levels: [...DEFAULT_LEVELS],
  category: '',
  step: '',
  type: '',
  status: '',
  text: '',
  from: '',
  to: '',
});

export const emptyConsoleUi = (): ConsoleUi => ({
  open: true,
  height: 0,
  maximized: false,
  tab: 'console',
  events: [],
  connection: 'idle',
  filters: emptyFilters(),
  follow: true,
  paused: false,
  unseen: 0,
  cleared: 0,
  dropped: 0,
  moreFilters: false,
});

/** Les lignes gardées dans la page à la fois (les plus récentes qui passent les critères). */
export const MAX_DOM_LINES = 1500;
/** Les événements gardés en mémoire par l'écran (le fichier du serveur garde le reste). */
export const MAX_CLIENT_EVENTS = 20_000;

// ── Critères d'affichage ──────────────────────────────────────────────────────────────────────────────────

const timeOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
};

/** Un événement passe-t-il les critères de la console ? */
export function matches(event: RunLogEvent, filters: ConsoleFilters): boolean {
  if (!filters.levels.includes(event.level)) return false;
  if (filters.category && event.category !== filters.category) return false;
  if (filters.step && String(event.step ?? '') !== filters.step) return false;
  if (filters.type && event.type !== filters.type) return false;
  if (filters.status && event.status !== filters.status) return false;
  if (filters.from || filters.to) {
    const time = timeOf(event.at);
    if (filters.from && time < normalizeTime(filters.from)) return false;
    if (filters.to && time > normalizeTime(filters.to)) return false;
  }
  if (filters.text) {
    const needle = filters.text.toLowerCase();
    const haystack = `${event.message} ${event.type} ${event.scenario ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const normalizeTime = (value: string): string => (value.length === 5 ? `${value}:00` : value);

export const filtersActive = (filters: ConsoleFilters): boolean =>
  JSON.stringify(filters) !== JSON.stringify(emptyFilters());

/** Les événements montrés : après l'effacement local, retenus par les critères. */
export const shownEvents = (ui: ConsoleUi): RunLogEvent[] =>
  ui.events.filter((event) => event.seq > ui.cleared && matches(event, ui.filters));

// ── Les étapes, les erreurs, le résumé ───────────────────────────────────────────────────────

export interface StepRow {
  step: number;
  line?: number;
  file?: string;
  scenario?: string;
  /** Le dernier état dit par la source ; `UNFINISHED` : commencée, sans fin rapportée, run terminé. */
  status: RunLogStatus | 'UNFINISHED';
  message: string;
  durationMs?: number;
  errors: number;
  events: number;
  startedAt?: string;
}

const FINAL = new Set<RunLogStatus>(['EXECUTED', 'CONFIRMED', 'FAILED', 'BLOCKED', 'SKIPPED', 'NOT_RUN']);

export const runFinished = (events: readonly RunLogEvent[]): boolean =>
  events.some((event) => event.type === 'RUN_FINISHED');

/**
 * La progression par étape, d'après les événements qui portent une étape : un échec l'emporte, sinon
 * le dernier état final rapporté ; une étape commencée sans fin reste « en cours » (« sans fin
 * rapportée » une fois le run fini : jamais un succès supposé).
 */
export function stepRows(events: readonly RunLogEvent[]): StepRow[] {
  const rows = new Map<number, StepRow>();
  const finished = runFinished(events);
  for (const event of events) {
    if (event.step === undefined) continue;
    let row = rows.get(event.step);
    if (!row) {
      row = { step: event.step, status: 'REQUESTED', message: '', errors: 0, events: 0 };
      rows.set(event.step, row);
    }
    row.events += 1;
    if (event.line !== undefined && (row.line === undefined || event.type === 'STEP_STARTED'))
      row.line = event.line;
    if (event.file) row.file = event.file;
    if (event.scenario) row.scenario = event.scenario;
    if (event.level === 'ERROR') row.errors += 1;
    if (!event.status) continue;
    if (row.status === 'FAILED' || row.status === 'BLOCKED') continue;
    if (event.status === 'RUNNING' || event.status === 'REQUESTED') {
      if (!FINAL.has(row.status as RunLogStatus) || event.type === 'STEP_STARTED') {
        row.status = 'RUNNING';
        row.startedAt ??= event.at;
        row.message = event.message;
      }
      continue;
    }
    row.status = event.status;
    row.message = event.message;
    if (event.durationMs !== undefined) row.durationMs = event.durationMs;
  }
  for (const row of rows.values())
    if (finished && (row.status === 'RUNNING' || row.status === 'REQUESTED')) row.status = 'UNFINISHED';
  return [...rows.values()].sort((a, b) => a.step - b.step);
}

/** L'étape en cours : commencée, sans fin rapportée, run pas fini. */
export function currentStep(events: readonly RunLogEvent[]): StepRow | undefined {
  if (runFinished(events)) return undefined;
  return stepRows(events)
    .filter((row) => row.status === 'RUNNING')
    .at(-1);
}

/**
 * Les erreurs : un événement de niveau ERROR, ou une opération échouée ou bloquée. La sortie brute de
 * l'outil (lignes `[ERROR]` de Maven, pile d'appels) reste dans la console : un échec s'y dit en
 * plusieurs lignes, l'onglet Erreurs ne le compte qu'une fois, par ses événements classés.
 */
export const errorEvents = (events: readonly RunLogEvent[]): RunLogEvent[] =>
  events.filter(
    (event) =>
      event.type !== 'RUN_FINISHED' &&
      (event.category !== 'OUTPUT' || event.errorKind !== undefined) &&
      (event.level === 'ERROR' || event.status === 'FAILED' || event.status === 'BLOCKED'),
  );

/** Les sources d'un run : réseau et navigateur seulement quand l'outil les observe. */
export function consoleSources(run: TestRunView | undefined): { network: boolean; browser: boolean } {
  if (!run) return { network: false, browser: false };
  // Le moteur relève les requêtes de chaque étape et les événements du navigateur ; le pilote Playwright
  // Java dit les navigations ; le reporter de Playwright Test ne voit ni l'un ni l'autre.
  return { network: run.kind === 'ENGINE', browser: run.kind === 'ENGINE' || run.format === 'java' };
}

export interface ConsoleSummary {
  total: number;
  byLevel: Record<RunLogLevel, number>;
  byCategory: Partial<Record<RunLogCategory, number>>;
  steps: Partial<Record<StepRow['status'], number>>;
  firstError?: RunLogEvent;
  finished?: RunLogEvent;
}

export function summaryOf(events: readonly RunLogEvent[]): ConsoleSummary {
  const byLevel = Object.fromEntries(RUN_LOG_LEVELS.map((level) => [level, 0])) as Record<
    RunLogLevel,
    number
  >;
  const byCategory: Partial<Record<RunLogCategory, number>> = {};
  for (const event of events) {
    byLevel[event.level] += 1;
    byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
  }
  const steps: ConsoleSummary['steps'] = {};
  for (const row of stepRows(events)) steps[row.status] = (steps[row.status] ?? 0) + 1;
  const firstError = errorEvents(events)[0];
  const finished = events.find((event) => event.type === 'RUN_FINISHED');
  return {
    total: events.length,
    byLevel,
    byCategory,
    steps,
    ...(firstError ? { firstError } : {}),
    ...(finished ? { finished } : {}),
  };
}

// ── Le HTML ──────────────────────────────────────────────────────────────────────────────────

/** L'heure d'un événement, à la milliseconde (lisible dans un journal). */
export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${timeOf(iso)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

const STATUS_ICON: Partial<Record<RunLogStatus | 'UNFINISHED', string>> = {
  CONFIRMED: 'check',
  EXECUTED: 'right',
  FAILED: 'cross',
  BLOCKED: 'alert',
  RUNNING: 'play',
  REQUESTED: 'info',
  UNFINISHED: 'alert',
};

/** Le statut d'une opération : une icône et un mot (jamais la couleur seule). */
export function statusChip(state: DashboardState, status: RunLogStatus | 'UNFINISHED' | undefined): string {
  if (!status) return '';
  const label = state.t.ed.con.statuses[status] ?? status;
  return `<span class="ev-st st-${status}">${STATUS_ICON[status] ? icon(STATUS_ICON[status]) : ''}<span>${esc(label)}</span></span>`;
}

/** Où se rattache un événement : son étape et sa ligne (boutons qui y mènent). */
export function placeButtons(
  state: DashboardState,
  event: Pick<RunLogEvent, 'step' | 'line' | 'file'>,
  fallbackPath: string,
): string {
  const t = state.t.ed;
  if (event.step === undefined && event.line === undefined) return '';
  const path = event.file ?? fallbackPath;
  const label = [
    event.step !== undefined ? t.step(event.step) : '',
    event.line !== undefined ? t.line(event.line) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<button class="ev-at" data-action="ed-diag" data-path="${esc(path)}" ${event.step !== undefined ? `data-step="${String(event.step)}"` : ''} ${event.line !== undefined ? `data-line="${String(event.line)}"` : ''} title="${esc(t.con.openPlace)}">${esc(label)}</button>`;
}

/** Une ligne du journal (la liste est tenue par le contrôleur, qui l'ajoute sans redessiner). */
export function lineHtml(state: DashboardState, event: RunLogEvent, path: string, selected: boolean): string {
  const t = state.t.ed.con;
  return `<li class="ev lv-${event.level}${selected ? ' sel' : ''}" data-seq="${String(event.seq)}"><button class="ev-main" data-action="ed-con-line" data-seq="${String(event.seq)}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${esc(`${clock(event.at)} ${t.levels[event.level]} ${event.message}`)}"><time datetime="${esc(event.at)}">${esc(clock(event.at))}</time><span class="ev-lv">${esc(event.level)}</span><span class="ev-cat">${esc(t.categories[event.category] ?? event.category)}</span><span class="ev-type">${esc(event.type)}</span></button>${statusChip(state, event.status)}${placeButtons(state, event, path)}<span class="ev-msg">${esc(event.message)}</span>${event.durationMs !== undefined ? `<span class="ev-dur">${esc(`${String(event.durationMs)} ms`)}</span>` : ''}</li>`;
}

/** Le détail d'un événement : ses champs, son diagnostic, ses preuves, les chemins vers l'étape et la ligne. */
export function detailHtml(state: DashboardState, event: RunLogEvent, path: string): string {
  const t = state.t.ed;
  const c = t.con;
  const rows: [string, string][] = [
    [c.fields.at, event.at],
    [c.fields.type, event.type],
    [c.fields.source, event.source],
    ...(event.scenario ? ([[c.fields.scenario, event.scenario]] as [string, string][]) : []),
    ...(event.status
      ? ([[c.fields.status, c.statuses[event.status] ?? event.status]] as [string, string][])
      : []),
    ...(event.errorKind
      ? ([[c.fields.errorKind, c.errorKinds[event.errorKind] ?? event.errorKind]] as [string, string][])
      : []),
    ...(event.durationMs !== undefined
      ? ([[c.fields.duration, `${String(event.durationMs)} ms`]] as [string, string][])
      : []),
    ...Object.entries(event.data ?? {}).map(([key, value]): [string, string] => [key, String(value)]),
  ];
  const hint = event.errorKind ? c.hints[event.errorKind] : undefined;
  const actions = [
    event.step !== undefined || event.line !== undefined ? placeButtons(state, event, path) : '',
    event.line !== undefined
      ? `<button class="lnk" data-action="ed-goto" data-path="${esc(event.file ?? path)}" data-line="${String(event.line)}">${esc(c.goLine)}</button>`
      : '',
    event.step !== undefined
      ? `<button class="lnk" data-action="ed-con-step-events" data-step="${String(event.step)}">${esc(c.stepEvents)}</button>`
      : '',
    event.evidence?.screenshot
      ? `<button class="lnk" data-action="ed-con-evidence" data-shot="${esc(event.evidence.screenshot)}">${esc(c.screenshot)}</button>`
      : '',
    event.evidence?.report ? `<button class="lnk" data-action="ed-con-report">${esc(c.report)}</button>` : '',
  ]
    .filter(Boolean)
    .join('');
  return `<div class="ev-detail" data-detail="${String(event.seq)}"><p class="ev-full">${esc(event.message)}</p>${hint ? `<p class="ev-hint">${icon('info')}<span>${esc(hint)}</span></p>` : ''}<dl class="ed-dl">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>${actions ? `<p class="ed-row">${actions}</p>` : ''}</div>`;
}

const option = (value: string, label: string, current: string): string =>
  `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;

/** Les critères fins (catégorie, étape, type, statut, période), dépliés sous la barre. */
function moreFilters(state: DashboardState, ui: ConsoleUi): string {
  const c = state.t.ed.con;
  const f = ui.filters;
  if (!ui.moreFilters) return '';
  const steps = [
    ...new Set(ui.events.flatMap((event) => (event.step !== undefined ? [event.step] : []))),
  ].sort((a, b) => a - b);
  const types = [...new Set(ui.events.map((event) => event.type))].sort();
  return `<div class="ed-con-more" role="group" aria-label="${esc(c.moreFilters)}"><label class="ed-con-f"><span>${esc(c.category)}</span><select data-ed="con-category">${option('', c.all, f.category)}${RUN_LOG_CATEGORIES.map((category) => option(category, c.categories[category] ?? category, f.category)).join('')}</select></label><label class="ed-con-f"><span>${esc(c.stepFilter)}</span><select data-ed="con-step">${option('', c.all, f.step)}${steps.map((step) => option(String(step), state.t.ed.step(step), f.step)).join('')}</select></label><label class="ed-con-f"><span>${esc(c.typeFilter)}</span><select data-ed="con-type">${option('', c.all, f.type)}${types.map((type) => option(type, type, f.type)).join('')}</select></label><label class="ed-con-f"><span>${esc(c.statusFilter)}</span><select data-ed="con-status">${option('', c.all, f.status)}${RUN_LOG_STATUSES.map((status) => option(status, c.statuses[status] ?? status, f.status)).join('')}</select></label><label class="ed-con-f"><span>${esc(c.from)}</span><input type="time" step="1" data-ed="con-from" value="${esc(f.from)}"></label><label class="ed-con-f"><span>${esc(c.to)}</span><input type="time" step="1" data-ed="con-to" value="${esc(f.to)}"></label></div>`;
}

function filterBar(state: DashboardState, ui: ConsoleUi): string {
  const c = state.t.ed.con;
  const f = ui.filters;
  const levels = RUN_LOG_LEVELS.map(
    (level) =>
      `<label class="ed-lvl lv-${level}" title="${esc(c.levels[level])}"><input type="checkbox" data-ed="con-level" value="${level}" aria-label="${esc(c.levels[level])}" ${f.levels.includes(level) ? 'checked' : ''}><span aria-hidden="true">${esc(c.levelsShort[level])}</span></label>`,
  ).join('');
  // Les critères fins se déplient sous la barre : la barre garde sa forme.
  const advanced = [f.category, f.step, f.type, f.status, f.from, f.to].filter(Boolean).length;
  return `<div class="ed-con-filters" role="group" aria-label="${esc(c.filters)}"><span class="ed-con-levels" role="group" aria-label="${esc(c.levelsLabel)}">${levels}</span><label class="ed-con-search"><span class="sr">${esc(c.search)}</span>${icon('search')}<input type="search" data-ed="con-text" placeholder="${esc(c.searchShort)}" value="${esc(f.text)}"></label><button class="btn btn-s ed-con-crit" data-action="ed-con-more" title="${esc(c.moreFilters)}" aria-expanded="${ui.moreFilters ? 'true' : 'false'}">${icon('sliders')}<span>${esc(c.moreFilters)}</span>${advanced > 0 ? `<span class="ed-count">${String(advanced)}</span>` : ''}</button>${filtersActive(f) ? `<button class="lnk" data-action="ed-con-reset">${esc(c.reset)}</button>` : ''}</div>`;
}

function stateLine(state: DashboardState, ui: ConsoleUi): string {
  const c = state.t.ed.con;
  const run = ui.run;
  const shown = shownEvents(ui).length;
  const logs = run?.logs;
  const kept =
    ui.connection === 'unavailable' || logs?.state === 'UNAVAILABLE'
      ? c.logsUnavailable
      : logs?.state === 'STORED'
        ? c.logsStored(logs.count)
        : run && (run.status === 'QUEUED' || run.status === 'RUNNING')
          ? c.logsLive
          : '';
  const connection = c.connections[ui.connection] ?? ui.connection;
  return `<p class="ed-con-state" role="status" aria-live="polite"><span class="ed-con-conn cn-${ui.connection}">${esc(ui.connection === 'reconnecting' && ui.attempt ? `${connection} (${String(ui.attempt)})` : connection)}</span>${kept ? `<span>${esc(kept)}</span>` : ''}<span>${esc(c.shown(shown, ui.events.filter((event) => event.seq > ui.cleared).length))}</span>${ui.cleared > 0 ? `<span>${esc(c.clearedNote)}</span>` : ''}${ui.dropped > 0 ? `<span>${esc(c.droppedNote(ui.dropped))}</span>` : ''}${ui.connection === 'interrupted' ? `<button class="lnk" data-action="ed-con-resume">${esc(c.resumeStream)}</button>` : ''}${ui.stopping === 'requested' ? `<span class="warn">${esc(c.stopRequested)}</span>` : ''}${ui.stopping === 'failed' ? `<span class="err">${esc(`${c.stopFailed}${ui.stopError ? ` · ${ui.stopError}` : ''}`)}</span>` : ''}</p>`;
}

function toolbar(state: DashboardState, ui: ConsoleUi, canRun: boolean): string {
  const c = state.t.ed.con;
  const run = ui.run;
  const active = run !== undefined && (run.status === 'QUEUED' || run.status === 'RUNNING');
  // L'action principale (arrêter, relancer) garde son mot ; les autres sont des icônes, nommées par leur
  // infobulle et pour les lecteurs d'écran : la barre tient sur une ligne, le journal garde la place.
  const button = (action: string, label: string, name: string, extra = '', tone = ''): string =>
    `<button class="btn btn-s${tone}" data-action="${action}" ${extra}>${icon(name)}<span>${esc(label)}</span></button>`;
  const tool = (action: string, label: string, name: string, extra = ''): string =>
    `<button class="ed-ib" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(name)}</button>`;
  return `<div class="ed-con-tools" role="toolbar" aria-label="${esc(c.tools)}">${
    active
      ? button('ed-con-stop', c.stop, 'stop', ui.stopping === 'requested' ? 'disabled' : '', ' danger')
      : ''
  }${run && !active && canRun ? button('ed-con-rerun', c.rerun, 'refresh') : ''}${tool('ed-con-pause', ui.paused ? c.resume : c.pause, ui.paused ? 'play' : 'pause', `aria-pressed="${ui.paused ? 'true' : 'false'}"`)}<label class="ed-tog" title="${esc(c.follow)}"><input type="checkbox" data-ed="con-follow" aria-label="${esc(c.follow)}" ${ui.follow ? 'checked' : ''}>${icon('down')}</label>${tool('ed-con-copy', c.copy, 'copy', run ? '' : 'disabled')}<span class="ed-con-dl" role="group" aria-label="${esc(c.download)}" title="${esc(c.download)}">${icon('download')}<button data-action="ed-con-download" data-format="json" aria-label="${esc(`${c.download} ${c.downloadJson}`)}" ${run ? '' : 'disabled'}>${esc(c.downloadJson)}</button><button data-action="ed-con-download" data-format="text" aria-label="${esc(`${c.download} ${c.downloadText}`)}" ${run ? '' : 'disabled'}>${esc(c.downloadText)}</button></span>${tool('ed-con-clear', c.clear, 'trash', run ? '' : 'disabled')}</div>`;
}

function consoleBody(state: DashboardState, ui: ConsoleUi, canRun: boolean): string {
  const c = state.t.ed.con;
  if (!ui.runId) return `<p class="mu ed-empty">${esc(canRun ? c.noRun : c.noRunReadOnly)}</p>`;
  // Une barre (critères, puis actions), le journal, et sous lui sa barre d'état : rien ne le recouvre.
  return `<div class="ed-con-bar">${filterBar(state, ui)}${toolbar(state, ui, canRun)}</div>${moreFilters(state, ui)}<div class="ed-log-frame"><div class="ed-log-host" data-log-host></div><div class="ed-con-foot">${stateLine(state, ui)}<button class="ed-con-new" data-action="ed-con-bottom" data-log-unseen ${ui.unseen > 0 ? '' : 'hidden'}>${icon('down')}<span>${esc(c.newEvents(ui.unseen))}</span></button></div></div>`;
}

function stepsBody(state: DashboardState, ui: ConsoleUi, path: string): string {
  const t = state.t.ed;
  const c = t.con;
  const rows = stepRows(ui.events);
  if (rows.length === 0) return `<p class="mu ed-empty">${esc(ui.runId ? c.noSteps : c.noRun)}</p>`;
  const current = currentStep(ui.events);
  return `<table class="ed-con-table"><thead><tr><th scope="col">${esc(c.stepCol)}</th><th scope="col">${esc(c.statusCol)}</th><th scope="col">${esc(c.durationCol)}</th><th scope="col">${esc(c.messageCol)}</th><th scope="col"><span class="sr">${esc(c.actionsCol)}</span></th></tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr class="${row.status === 'FAILED' || row.status === 'BLOCKED' ? 'ko' : ''}" ${current?.step === row.step ? 'aria-current="step"' : ''}><td>${placeButtons(state, { step: row.step, ...(row.line !== undefined ? { line: row.line } : {}), ...(row.file ? { file: row.file } : {}) }, path)}</td><td>${statusChip(state, row.status)}${row.errors > 0 ? ` <span class="ev-err">${esc(c.errorsCount(row.errors))}</span>` : ''}</td><td>${row.durationMs !== undefined ? esc(`${String(row.durationMs)} ms`) : '—'}</td><td class="ev-msg">${esc(row.message)}</td><td><button class="lnk" data-action="ed-con-step-events" data-step="${String(row.step)}">${esc(c.stepEvents)}</button></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function errorsBody(state: DashboardState, ui: ConsoleUi, path: string): string {
  const c = state.t.ed.con;
  const errors = errorEvents(ui.events);
  if (errors.length === 0)
    return `<p class="mu ed-empty">${esc(!ui.runId ? c.noRun : runFinished(ui.events) ? c.noErrors : c.noErrorsYet)}</p>`;
  return `<ul class="ed-con-errors">${errors
    .map(
      (event) =>
        `<li><div class="ed-row"><span class="ev-kind">${icon('cross')}${esc(event.errorKind ? (c.errorKinds[event.errorKind] ?? event.errorKind) : c.errorKinds.UNCLASSIFIED)}</span><time>${esc(clock(event.at))}</time>${placeButtons(state, event, path)}<span class="mu">${esc(event.type)}</span></div>${detailHtml(state, event, path)}</li>`,
    )
    .join('')}</ul>`;
}

function networkBody(state: DashboardState, ui: ConsoleUi, path: string): string {
  const c = state.t.ed.con;
  const requests = ui.events.filter((event) => event.category === 'NETWORK');
  return `<p class="mu">${esc(c.networkNote)}</p>${
    requests.length === 0
      ? `<p class="mu ed-empty">${esc(c.noNetwork)}</p>`
      : `<table class="ed-con-table"><thead><tr><th scope="col">${esc(c.timeCol)}</th><th scope="col">${esc(c.stepCol)}</th><th scope="col">${esc(c.requestCol)}</th><th scope="col">${esc(c.durationCol)}</th></tr></thead><tbody>${requests
          .map(
            (event) =>
              `<tr class="${event.level === 'WARN' || event.level === 'ERROR' ? 'ko' : ''}"><td><time>${esc(clock(event.at))}</time></td><td>${placeButtons(state, event, path) || '—'}</td><td class="ev-msg">${event.level === 'WARN' || event.level === 'ERROR' ? `${icon('alert')} ` : ''}${esc(event.message)}</td><td>${event.durationMs !== undefined ? esc(`${String(event.durationMs)} ms`) : '—'}</td></tr>`,
          )
          .join('')}</tbody></table>`
  }`;
}

function browserBody(state: DashboardState, ui: ConsoleUi, path: string): string {
  const c = state.t.ed.con;
  const events = ui.events.filter((event) => event.category === 'BROWSER');
  return events.length === 0
    ? `<p class="mu ed-empty">${esc(c.noBrowser)}</p>`
    : `<ol class="ed-log ed-log-static">${events.map((event) => lineHtml(state, event, path, false)).join('')}</ol>`;
}

function summaryBody(state: DashboardState, ui: ConsoleUi, path: string): string {
  const t = state.t.ed;
  const c = t.con;
  const run = ui.run;
  if (!run) return `<p class="mu ed-empty">${esc(c.noRun)}</p>`;
  const summary = summaryOf(ui.events);
  const stat = (label: string, value: string | number): string =>
    `<div class="ed-con-stat"><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`;
  const statuses = state.t.tst.statuses;
  const cases = run.cases
    .map(
      (entry) =>
        `<li><button data-action="ed-diag" data-path="${esc(path)}" ${entry.line !== undefined ? `data-line="${String(entry.line)}"` : ''} ${entry.step !== undefined ? `data-step="${String(entry.step)}"` : ''}><span class="ev-st st-${entry.status}">${esc(state.t.tst.caseStatuses[entry.status] ?? entry.status)}</span><span class="ed-msg">${esc(entry.name)}</span><span class="ed-where">${esc([entry.detail, entry.message].filter(Boolean).join(' · '))}</span></button></li>`,
    )
    .join('');
  return `<dl class="ed-con-stats">${stat(c.runStatus, statuses[run.status] ?? run.status)}${run.dryRunStatus ? stat(c.dryRunVerdict, t.dryRunStatuses[run.dryRunStatus] ?? run.dryRunStatus) : ''}${stat(c.tool, run.tool)}${stat(c.durationCol, run.durationMs !== undefined ? `${String(run.durationMs)} ms` : '—')}${stat(c.eventsCount, summary.total)}${stat(c.levels.ERROR, summary.byLevel.ERROR)}${stat(c.levels.WARN, summary.byLevel.WARN)}${Object.entries(
    summary.steps,
  )
    .map(([status, count]) => stat(`${c.stepCol} · ${c.statuses[status] ?? status}`, count))
    .join(
      '',
    )}</dl>${summary.firstError ? `<p>${esc(c.firstError)} ${placeButtons(state, summary.firstError, path)} <span class="ev-msg">${esc(summary.firstError.message)}</span></p>` : ''}${run.message ? `<p class="${run.status === 'CANCELLED' ? 'mu' : 'err'}">${esc(run.message)}</p>` : ''}${cases ? `<h4>${esc(c.cases)}</h4><ul class="ed-dlist">${cases}</ul>` : ''}${run.report ? `<p><button class="btn btn-s" data-action="ed-report" data-run="${esc(run.id)}">${esc(state.t.tst.report)}</button></p>` : ''}${run.output ? `<details><summary>${esc(state.t.tst.output)}</summary><pre class="tst-code" tabindex="0">${esc(run.output)}</pre></details>` : ''}<p class="mu">${esc(t.staticOnly)}</p>`;
}

/**
 * Le panneau inférieur de l'éditeur : la console et ses onglets, plus les diagnostics de la
 * vérification statique. `diagnostics` : le rendu de l'onglet Diagnostics (fait par l'éditeur).
 */
export function consolePanel(
  state: DashboardState,
  path: string,
  options: { diagnostics: string; diagnosticsCount: number; canRun: boolean; runs: TestRunView[] },
): string {
  const t = state.t.ed;
  const c = t.con;
  const ui = state.ed.console;
  const sources = consoleSources(ui.run);
  const errors = errorEvents(ui.events).length;
  const tabs: [ConsoleTab, string, string][] = [
    ['console', c.tabs.console, ''],
    ['steps', c.tabs.steps, ''],
    ['errors', c.tabs.errors, errors > 0 ? String(errors) : ''],
    ...(sources.network ? ([['network', c.tabs.network, '']] as [ConsoleTab, string, string][]) : []),
    ...(sources.browser ? ([['browser', c.tabs.browser, '']] as [ConsoleTab, string, string][]) : []),
    ['summary', c.tabs.summary, ''],
    ['diagnostics', t.diagnostics, String(options.diagnosticsCount)],
  ];
  const tab = tabs.some(([id]) => id === ui.tab) ? ui.tab : 'console';
  const current = currentStep(ui.events);
  const runChoice =
    options.runs.length > 0
      ? `<label class="ed-con-run"><span class="sr">${esc(c.runSelect)}</span><select data-ed="con-run">${ui.runId ? '' : option('', c.chooseRun, '')}${options.runs
          .map((run) =>
            option(
              run.id,
              `${run.mode === 'DRY_RUN' ? t.dryRun : t.run} · ${state.t.tst.statuses[run.status] ?? run.status} · ${clock(run.startedAt ?? run.queuedAt)}${run.headed ? ` · ${state.t.visibleBrowser.shown}` : ''}`,
              ui.runId ?? '',
            ),
          )
          .join('')}</select></label>`
      : '';
  const body =
    tab === 'console'
      ? consoleBody(state, ui, options.canRun)
      : tab === 'steps'
        ? stepsBody(state, ui, path)
        : tab === 'errors'
          ? errorsBody(state, ui, path)
          : tab === 'network'
            ? networkBody(state, ui, path)
            : tab === 'browser'
              ? browserBody(state, ui, path)
              : tab === 'summary'
                ? summaryBody(state, ui, path)
                : options.diagnostics;
  // La poignée au-dessus de la console : la glisser (ou ↑/↓ au clavier) règle sa hauteur ; Entrée l'agrandit.
  const split =
    ui.open && !ui.maximized
      ? `<div class="ed-con-split" role="separator" aria-orientation="horizontal" tabindex="0" data-con-split aria-label="${esc(c.resize)}" title="${esc(c.resizeHint)}"${ui.height > 0 ? ` aria-valuenow="${String(ui.height)}"` : ''}></div>`
      : '';
  const maximize = ui.open
    ? `<button class="ed-ib" data-action="ed-con-max" aria-pressed="${ui.maximized ? 'true' : 'false'}" aria-label="${esc(ui.maximized ? c.restore : c.maximize)}" title="${esc(ui.maximized ? c.restore : c.maximize)}">${icon(ui.maximized ? 'minimize' : 'maximize')}</button>`
    : '';
  return `<section class="ed-panel ed-con${ui.open ? '' : ' closed'}${ui.open && ui.maximized ? ' max' : ''}" aria-label="${esc(t.panel)}" data-con-panel>${split}<div class="ed-ptabs"><div role="tablist" aria-label="${esc(t.panel)}">${tabs
    .map(
      ([id, label, count]) =>
        `<button role="tab" id="ed-tab-${id}" aria-selected="${tab === id ? 'true' : 'false'}" aria-controls="ed-con-body" data-action="ed-con-tab" data-tab="${id}">${esc(label)}${count ? ` <span class="ed-count">${esc(count)}</span>` : ''}</button>`,
    )
    .join(
      '',
    )}</div><div class="ed-con-head">${current ? `<span class="ed-con-now" title="${esc(c.currentStep)}">${icon('play')}<span>${esc(`${c.currentStep} · ${t.step(current.step)}`)}</span></span>` : ''}${runChoice}${maximize}<button class="ed-ib" data-action="ed-con-toggle" aria-expanded="${ui.open ? 'true' : 'false'}" aria-label="${esc(ui.open ? c.collapse : c.expand)}" title="${esc(ui.open ? c.collapse : c.expand)}">${icon(ui.open ? 'down' : 'up')}</button></div></div>${ui.open ? `<div class="ed-pbody" id="ed-con-body" role="tabpanel" aria-labelledby="ed-tab-${tab}">${body}</div>` : ''}</section>`;
}
