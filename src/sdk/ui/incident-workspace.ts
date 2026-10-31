import type {
  CodeLayer,
  EnvironmentCapabilities,
  Evidence,
  Incident,
  InvestigationReport,
  SourceFileView,
  SourceLocation,
  SourceTree,
  TimelineEvent,
} from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import {
  codeTarget,
  emptyCodeUi,
  renderCodeExcerpt,
  renderLayerCode,
  type CodeLoadState,
  type CodeUi,
} from './incident-code.js';
import {
  emptyDiagnosisUi,
  renderDiagnosis,
  renderExperimentDetail,
  renderExperiments,
  renderHypotheses,
  renderHypothesisDetail,
  renderRegression,
  renderReport,
  type DiagnosisUi,
  type ReportViewState,
} from './incident-diagnosis.js';
import {
  emptyFrontendTraceUi,
  renderFrontendStepDetail,
  renderFrontendTrace,
  type FrontendTraceUi,
} from './incident-frontend-trace.js';
import {
  emptyGraphUi,
  renderGraph,
  renderGraphDetail,
  renderRelationsTable,
  type GraphUi,
} from './incident-graph.js';
import {
  fileId,
  selectionKey,
  sourceOf,
  stepId,
  workspaceLinks,
  type SelectionKind,
  type WorkspaceLinks,
  type WorkspaceSelection,
} from './incident-links.js';
import {
  demoBanner,
  evidenceChips,
  panelState,
  partsText,
  selectable,
  selectionClass,
  sourceLink,
  workspaceContext,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import {
  emptyTimelineUi,
  renderLogs,
  renderRequestDetail,
  renderRequests,
  renderScreenshot,
  renderTimeline,
  type TimelineUi,
} from './incident-timeline.js';
import {
  emptyUxUi,
  renderEnvironmentSelector,
  renderOverview,
  renderStepper,
  renderTabPanel,
  renderTabs,
  renderWorkspaceHeader,
  uxText,
  workspaceTabs,
  type UxTab,
  type UxUi,
  type WorkspaceStage,
} from './incident-ux.js';
import { esc } from './view.js';

/**
 * LA COQUILLE DE L'ESPACE D'INVESTIGATION : l'en-tête, la progression, les onglets, la zone principale
 * (le contenu de l'onglet, le graphe full-stack quand l'onglet n'est pas déjà le graphe, le panneau
 * contextuel de la sélection). Elle assemble les vues des modules (`incident-ux`, `-graph`, `-timeline`,
 * `-frontend-trace`, `-code`, `-diagnosis`) sur un seul contexte : la même sélection, les mêmes liens,
 * les mêmes droits. Des fonctions pures : l'état (`WorkspaceUi`) est tenu par le contrôleur, qui lit
 * l'arborescence, les fichiers, les captures, le rapport et les capacités et les range ici.
 */

/** L'identifiant de route de la démonstration (`{ view: 'incident', incidentId: 'demo' }`). */
export const DEMO_INCIDENT_ID = 'demo';

export const isDemoIncident = (incidentId: string | undefined): boolean => incidentId === DEMO_INCIDENT_ID;

// ── Onglets ──────────────────────────────────────────────────────────────────────────────────

export const WORKSPACE_TABS = [
  'overview',
  'scope',
  'environment',
  'timeline',
  'traceability',
  'requests',
  'frontend',
  'bff',
  'backend',
  'logs',
  'hypotheses',
  'experiments',
  'diagnosis',
  'report',
  'regression',
] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const isWorkspaceTab = (value: string | undefined): value is WorkspaceTab =>
  (WORKSPACE_TABS as readonly string[]).includes(value ?? '');

/** L'onglet ouvert par chaque étape de la progression. */
export const STAGE_TABS: Record<WorkspaceStage, WorkspaceTab> = {
  description: 'overview',
  scope: 'scope',
  environment: 'environment',
  reproduction: 'timeline',
  evidence: 'requests',
  code: 'frontend',
  traceability: 'traceability',
  diagnosis: 'diagnosis',
  report: 'report',
  regression: 'regression',
};

/** La couche de code d'un onglet (Frontend, BFF, Backend). */
export const LAYER_TABS: Partial<Record<WorkspaceTab, CodeLayer>> = {
  frontend: 'FRONTEND',
  bff: 'BFF',
  backend: 'BACKEND',
};

/** Les onglets dont le contenu demande de la largeur (code, formulaires) : le graphe passe dessous. */
const WIDE_TABS: readonly WorkspaceTab[] = ['scope', 'environment', 'frontend', 'bff', 'backend'];

/** L'onglet d'une couche de code. */
export const tabOfLayer = (layer: CodeLayer): WorkspaceTab =>
  layer === 'FRONTEND' ? 'frontend' : layer === 'BFF' ? 'bff' : 'backend';

// ── État ─────────────────────────────────────────────────────────────────────────────────────

/** Une lecture : en cours, refusée (403), en échec (message). */
export type LoadState = 'loading' | 'denied' | { error: string };

/** Un fichier lu (ou en lecture) : la révision de l'incident qui a calculé ses lignes signalées. */
export interface SourceEntry {
  view?: SourceFileView;
  revision: number;
  state?: LoadState;
}

export interface ShotEntry {
  dataUrl?: string;
  state?: LoadState;
}

export interface WorkspaceUi {
  /** L'incident dont l'état est tenu (un autre incident repart de zéro). */
  incidentId?: string;
  /** Données de démonstration : aucun appel au serveur, actions désactivées. */
  demo: boolean;
  /** La sélection partagée par toutes les vues. */
  selection?: WorkspaceSelection;
  ux: UxUi;
  graph: GraphUi;
  timeline: TimelineUi;
  trace: FrontendTraceUi;
  code: CodeUi;
  dx: DiagnosisUi;
  /** L'arborescence du périmètre (lue une fois par incident). */
  tree?: SourceTree;
  treeState?: LoadState;
  /** Les fichiers lus, par clé `application:fichier` (petit cache). */
  sources: Record<string, SourceEntry>;
  /** Les captures d'écran lues, par clé `reproduction|fichier`. */
  shots: Record<string, ShotEntry>;
  report?: InvestigationReport;
  reportState: ReportViewState;
  capabilities?: EnvironmentCapabilities;
  capabilitiesState?: LoadState;
}

export function emptyWorkspaceUi(incidentId?: string, demo = false): WorkspaceUi {
  return {
    ...(incidentId ? { incidentId } : {}),
    demo,
    ux: emptyUxUi(),
    graph: emptyGraphUi(),
    timeline: emptyTimelineUi(),
    trace: emptyFrontendTraceUi(),
    code: emptyCodeUi(),
    dx: emptyDiagnosisUi(),
    sources: {},
    shots: {},
    reportState: {},
  };
}

/** La clé d'une capture d'écran. */
export const shotKey = (reproduction: string, file: string): string => `${reproduction}|${file}`;

// ── Contexte ─────────────────────────────────────────────────────────────────────────────────

/** Les liens d'un incident : calculés une fois par incident lu (un redessin ne les recalcule pas). */
const LINKS = new WeakMap<Incident, WorkspaceLinks>();

export function linksOf(incident: Incident): WorkspaceLinks {
  let links = LINKS.get(incident);
  if (!links) {
    links = workspaceLinks(incident);
    LINKS.set(incident, links);
  }
  return links;
}

export function workspaceCtx(
  incident: Incident,
  ws: WorkspaceUi,
  lang: Lang,
  can: WorkspaceContext['can'],
): WorkspaceContext {
  return workspaceContext({
    incident,
    lang,
    ...(ws.selection ? { selection: ws.selection } : {}),
    links: linksOf(incident),
    demo: ws.demo,
    can,
  });
}

/** Le contexte des vues du code : sans le droit de lecture quand le serveur a refusé l'accès (403). */
export function codeCtxOf(ctx: WorkspaceContext, ws: WorkspaceUi): WorkspaceContext {
  if (ws.treeState !== 'denied') return ctx;
  return { ...ctx, can: (right) => right !== 'RUN' && ctx.can(right) };
}

/** Les fichiers que la vue affichée lit : celui de l'onglet de couche, celui du panneau contextuel. */
export function neededSources(ctx: WorkspaceContext, ws: WorkspaceUi, tab: WorkspaceTab): SourceLocation[] {
  const needed: SourceLocation[] = [];
  const layer = LAYER_TABS[tab];
  if (layer) {
    const target = codeTarget(ctx, ws.code, layer, ws.tree);
    if (target) needed.push(target);
  }
  const selected = sourceOf(ctx.links, ctx.selection);
  if (selected) needed.push(selected);
  return needed;
}

/** La preuve désignée (reproductions et vérifications). */
export function evidenceOf(incident: Incident, id: string): Evidence | undefined {
  for (const run of incident.investigation.reproductions) {
    const found = run.evidence.find((item) => item.id === id);
    if (found) return found;
  }
  for (const experiment of incident.investigation.experiments) {
    const found = experiment.evidence.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}

/** La capture d'écran qu'une sélection demande (preuve SCREENSHOT avec reproduction et fichier). */
export function screenshotOf(
  incident: Incident,
  selection: WorkspaceSelection | undefined,
): { reproduction: string; file: string; label: string } | undefined {
  if (selection?.kind !== 'evidence') return undefined;
  const evidence = evidenceOf(incident, selection.id);
  if (evidence?.kind !== 'SCREENSHOT' || !evidence.source.file || !evidence.source.reproduction)
    return undefined;
  return { reproduction: evidence.source.reproduction, file: evidence.source.file, label: evidence.summary };
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    workspace: 'Espace d’investigation',
    graphZone: 'Graphe full-stack de l’incident',
    panel: 'Détail de la sélection',
    clear: 'Vider la sélection',
    clearHint: 'Échap vide aussi la sélection.',
    kinds: {
      node: 'Nœud du graphe',
      edge: 'Relation du graphe',
      request: 'Requête HTTP',
      event: 'Événement de la chronologie',
      evidence: 'Preuve',
      symbol: 'Symbole du code',
      file: 'Fichier',
      hypothesis: 'Hypothèse',
      experiment: 'Expérience',
      step: 'Étape de la reproduction',
    } as Record<SelectionKind, string>,
    code: 'Code relié',
    codeLoading: 'Lecture du fichier…',
    notInDemo: 'Ce fichier n’est pas inclus dans les données de démonstration.',
    shotNotInDemo: 'La capture d’écran n’est pas incluse dans les données de démonstration.',
    shotDenied: 'Votre rôle ne permet pas de voir les captures d’écran.',
    codeDenied: 'Votre rôle ne permet pas de lire le code du périmètre.',
    unknown: 'Cet élément n’existe plus dans l’investigation (relue entre-temps).',
    evidenceKind: 'Nature',
    at: 'Heure',
    reproduction: 'Reproduction',
    step: (index: number) => `Étape ${String(index)}`,
    stepLabel: 'Étape',
    file: 'Fichier',
    experiment: 'Expérience',
    data: 'Données',
    eventStatus: 'Statut',
    layer: 'Couche',
    related: 'Requête reliée',
    evidence: 'Preuves',
    action: 'Action',
    durationLabel: 'Durée',
    duration: (ms: number) => `${String(ms)} ms`,
    reason: 'Raison',
    cancelled: (from: string) =>
      `Investigation annulée à l’état « ${from} » : les preuves restent lisibles, la reprendre pour continuer.`,
    cancelledPlain: 'Investigation annulée : les preuves restent lisibles, la reprendre pour continuer.',
    failed:
      'L’investigation est en échec : lire l’erreur ci-dessous, corriger, puis relancer la reproduction.',
    failedRun: (error: string) => `Dernière reproduction : ${error}`,
    demoWhy:
      'Données de démonstration : action indisponible. Les boutons qui modifient l’incident ou interrogent le serveur sont désactivés ; la navigation, la sélection et l’exploration restent possibles.',
    capabilitiesError: (message: string) => `Capacités non lues : ${message}`,
    relations: 'Toutes les relations',
    fileFailed: (file: string, message: string) => `Fichier ${file} non lu : ${message}`,
    fileDenied: 'Lecture du code refusée : votre rôle ne le permet pas.',
    treeFailed: (message: string) => `Arborescence du code non lue : ${message}`,
  },
  en: {
    workspace: 'Investigation workspace',
    graphZone: 'Full-stack graph of the incident',
    panel: 'Selection detail',
    clear: 'Clear the selection',
    clearHint: 'Escape also clears the selection.',
    kinds: {
      node: 'Graph node',
      edge: 'Graph relation',
      request: 'HTTP request',
      event: 'Timeline event',
      evidence: 'Evidence',
      symbol: 'Code symbol',
      file: 'File',
      hypothesis: 'Hypothesis',
      experiment: 'Experiment',
      step: 'Reproduction step',
    } as Record<SelectionKind, string>,
    code: 'Linked code',
    codeLoading: 'Reading the file…',
    notInDemo: 'This file is not part of the demonstration data.',
    shotNotInDemo: 'The screenshot is not part of the demonstration data.',
    shotDenied: 'Your role does not allow you to see screenshots.',
    codeDenied: 'Your role does not allow you to read the code of the scope.',
    unknown: 'This item no longer exists in the investigation (read again meanwhile).',
    evidenceKind: 'Kind',
    at: 'Time',
    reproduction: 'Reproduction',
    step: (index: number) => `Step ${String(index)}`,
    stepLabel: 'Step',
    file: 'File',
    experiment: 'Experiment',
    data: 'Data',
    eventStatus: 'Status',
    layer: 'Layer',
    related: 'Linked request',
    evidence: 'Evidence',
    action: 'Action',
    durationLabel: 'Duration',
    duration: (ms: number) => `${String(ms)} ms`,
    reason: 'Reason',
    cancelled: (from: string) =>
      `Investigation cancelled in state “${from}”: the evidence stays readable, resume it to continue.`,
    cancelledPlain: 'Investigation cancelled: the evidence stays readable, resume it to continue.',
    failed: 'The investigation failed: read the error below, fix it, then launch the reproduction again.',
    failedRun: (error: string) => `Last reproduction: ${error}`,
    demoWhy:
      'Demonstration data: action unavailable. Buttons that change the incident or query the server are disabled; navigation, selection and exploration remain possible.',
    capabilitiesError: (message: string) => `Capabilities not read: ${message}`,
    relations: 'All relations',
    fileFailed: (file: string, message: string) => `File ${file} not read: ${message}`,
    fileDenied: 'Reading the code was denied: your role does not allow it.',
    treeFailed: (message: string) => `Code tree not read: ${message}`,
  },
};

export const workspaceText = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

/** Le motif court affiché sur une action indisponible en démonstration. */
export const demoUnavailable = (lang: Lang): string =>
  lang === 'fr' ? 'Données de démonstration : action indisponible' : 'Demonstration data: action unavailable';

// ── Pièces ───────────────────────────────────────────────────────────────────────────────────

const row = (term: string, value: string): string => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;

function loadPanel(lang: Lang, state: LoadState | undefined, loading: string, retry?: string): string {
  if (state === 'denied') return panelState(lang, 'denied');
  if (state && typeof state === 'object') return panelState(lang, 'error', state.error, retry);
  return panelState(lang, 'loading', loading);
}

/** L'extrait du code relié à la sélection (fichier lu par le contrôleur), ou son état de lecture. */
function codeExcerpt(ctx: WorkspaceContext, codeCtx: WorkspaceContext, ws: WorkspaceUi): string {
  const source = sourceOf(ctx.links, ctx.selection);
  if (!source) return '';
  const t = TEXT[ctx.lang];
  const entry = ws.sources[fileId(source.applicationId, source.file)];
  const body = !codeCtx.can('RUN')
    ? panelState(ctx.lang, 'denied', t.codeDenied)
    : entry?.view
      ? renderCodeExcerpt(codeCtx, entry.view, source.line)
      : ws.demo && entry?.state && typeof entry.state === 'object'
        ? panelState(ctx.lang, 'empty', t.notInDemo)
        : loadPanel(ctx.lang, entry?.state, t.codeLoading, 'ws-code-reload');
  return `<section class="ws-ctx-code" aria-label="${esc(t.code)}"><h3>${icon('code')}<span>${esc(t.code)}</span> ${sourceLink(ctx.lang, source)}</h3>${body}</section>`;
}

function evidenceDetail(ctx: WorkspaceContext, ws: WorkspaceUi, evidence: Evidence): string {
  const t = TEXT[ctx.lang];
  const source = evidence.source;
  const stepButton =
    source.step !== undefined && source.reproduction
      ? `<button type="button" class="lnk ${selectionClass(ctx, 'step', stepId(source.reproduction, source.step))}" ${selectable(ctx, 'step', stepId(source.reproduction, source.step))}>${esc(t.step(source.step))}</button>`
      : '';
  const data = Object.entries(evidence.data ?? {})
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 12)
    .map(([key, value]) => {
      const text = String(value);
      return row(key, `<code>${esc(text.length > 240 ? `${text.slice(0, 239)}…` : text)}</code>`);
    })
    .join('');
  let shot = '';
  const screenshot = screenshotOf(ctx.incident, { kind: 'evidence', id: evidence.id });
  if (screenshot) {
    const entry = ws.shots[shotKey(screenshot.reproduction, screenshot.file)];
    shot = ws.demo
      ? panelState(ctx.lang, 'empty', t.shotNotInDemo)
      : entry?.state === 'denied'
        ? panelState(ctx.lang, 'denied', t.shotDenied)
        : entry?.state && typeof entry.state === 'object'
          ? panelState(ctx.lang, 'error', entry.state.error, 'ws-shot-reload')
          : renderScreenshot(ctx, entry?.dataUrl, screenshot.label);
  }
  return `<article class="ws-ctx-card" aria-labelledby="ws-ctx-ev-t"><p class="ws-ctx-eyebrow">${esc(t.kinds.evidence)} · ${esc(evidence.kind)}</p><h3 id="ws-ctx-ev-t">${esc(evidence.summary)}</h3><dl class="ws-ctx-dl">${
    evidence.at
      ? row(t.at, `<time datetime="${esc(evidence.at)}">${esc(formatDate(evidence.at, ctx.lang))}</time>`)
      : ''
  }${source.reproduction ? row(t.reproduction, `<code>${esc(source.reproduction)}</code>`) : ''}${stepButton ? row(t.stepLabel, stepButton) : ''}${
    source.file
      ? row(
          t.file,
          `<code>${esc(source.line !== undefined ? `${source.file}:${String(source.line)}` : source.file)}</code>`,
        )
      : ''
  }${
    source.experiment
      ? row(
          t.experiment,
          `<button type="button" class="lnk ${selectionClass(ctx, 'experiment', source.experiment)}" ${selectable(ctx, 'experiment', source.experiment)}>${esc(source.experiment)}</button>`,
        )
      : ''
  }</dl>${data ? `<h4>${esc(t.data)}</h4><dl class="ws-ctx-dl">${data}</dl>` : ''}${shot}</article>`;
}

function eventDetail(ctx: WorkspaceContext, event: TimelineEvent): string {
  const t = TEXT[ctx.lang];
  const parts = partsText(ctx.lang);
  const chips = evidenceChips(
    ctx,
    event.evidence.filter((ref) => ref !== event.requestId),
    6,
  );
  const step =
    event.step !== undefined && event.reproduction
      ? `<button type="button" class="lnk ${selectionClass(ctx, 'step', stepId(event.reproduction, event.step))}" ${selectable(ctx, 'step', stepId(event.reproduction, event.step))}>${esc(t.step(event.step))}</button>`
      : '';
  return `<article class="ws-ctx-card" aria-labelledby="ws-ctx-evt-t"><p class="ws-ctx-eyebrow">${esc(t.kinds.event)} · ${esc(event.kind)}</p><h3 id="ws-ctx-evt-t">${esc(event.summary)}</h3><dl class="ws-ctx-dl">${row(t.eventStatus, esc(event.status))}${row(t.layer, esc(parts.layers[event.layer]))}${
    event.at
      ? row(
          t.at,
          `<time datetime="${esc(event.at)}">${event.estimated ? '≈ ' : ''}${esc(formatDate(event.at, ctx.lang))}</time>`,
        )
      : ''
  }${step ? row(t.stepLabel, step) : ''}${chips ? row(t.evidence, chips) : ''}</dl>${
    event.requestId ? `<h4>${esc(t.related)}</h4>${renderRequestDetail(ctx, event.requestId)}` : ''
  }</article>`;
}

function stepDetail(ctx: WorkspaceContext, id: string): string {
  const t = TEXT[ctx.lang];
  const at = id.lastIndexOf('#');
  const reproduction = id.slice(0, at);
  const index = Number(id.slice(at + 1));
  const trace = ctx.incident.investigation.frontendTrace;
  if (trace?.reproduction === reproduction && trace.steps.some((step) => step.index === index))
    return renderFrontendStepDetail(ctx, index);
  const run = ctx.incident.investigation.reproductions.find((entry) => entry.id === reproduction);
  const action = run?.actions.find((entry) => entry.index === index);
  if (!run || !action) return panelState(ctx.lang, 'empty', t.unknown);
  return `<article class="ws-ctx-card" aria-labelledby="ws-ctx-step-t"><p class="ws-ctx-eyebrow">${esc(t.kinds.step)} · <code>${esc(run.id)}</code></p><h3 id="ws-ctx-step-t">${esc(`${t.step(index)} : ${action.description}`)}</h3><dl class="ws-ctx-dl">${row(t.action, `<code>${esc(action.kind)}</code> ${esc(action.status)}`)}${row(t.durationLabel, esc(t.duration(action.durationMs)))}${action.reason ? row(t.reason, esc(action.reason)) : ''}${
    action.requestIds.length > 0 ? row(t.evidence, evidenceChips(ctx, action.requestIds, 6)) : ''
  }</dl></article>`;
}

/** Le détail de la sélection, selon sa nature. */
function selectionDetail(ctx: WorkspaceContext, ws: WorkspaceUi): string {
  const selection = ctx.selection;
  const t = TEXT[ctx.lang];
  if (!selection) return renderGraphDetail(ctx);
  const incident = ctx.incident;
  switch (selection.kind) {
    case 'node':
    case 'edge':
      return renderGraphDetail(ctx) || panelState(ctx.lang, 'empty', t.unknown);
    case 'request':
      return renderRequestDetail(ctx, selection.id);
    case 'step':
      return stepDetail(ctx, selection.id);
    case 'hypothesis':
      return renderHypothesisDetail(ctx, selection.id, ws.dx);
    case 'experiment':
      return renderExperimentDetail(ctx, selection.id, ws.dx);
    case 'evidence': {
      const evidence = evidenceOf(incident, selection.id);
      return evidence ? evidenceDetail(ctx, ws, evidence) : panelState(ctx.lang, 'empty', t.unknown);
    }
    case 'event': {
      const event = (incident.investigation.timeline ?? []).find((entry) => entry.id === selection.id);
      return event ? eventDetail(ctx, event) : panelState(ctx.lang, 'empty', t.unknown);
    }
    case 'symbol': {
      const symbol = incident.investigation.code?.symbols.find((entry) => entry.id === selection.id);
      return symbol
        ? `<p class="ws-ctx-eyebrow">${esc(t.kinds.symbol)} · ${esc(symbol.kind)}</p><h3 class="ws-ctx-h">${esc(symbol.name)}</h3>`
        : panelState(ctx.lang, 'empty', t.unknown);
    }
    case 'file':
      return `<p class="ws-ctx-eyebrow">${esc(t.kinds.file)}</p><h3 class="ws-ctx-h"><code>${esc(selection.id)}</code></h3>`;
  }
}

/** Le panneau contextuel : la sélection, son détail, le code qui lui est relié. */
export function renderContextPanel(
  ctx: WorkspaceContext,
  codeCtx: WorkspaceContext,
  ws: WorkspaceUi,
): string {
  const t = TEXT[ctx.lang];
  const selection = ctx.selection;
  const head = `<div class="ws-ctx-h2"><h2 id="ws-ctx-t">${esc(t.panel)}</h2>${
    selection
      ? `<button type="button" class="btn small ghost" data-action="ws-select-clear" title="${esc(t.clearHint)}">${icon('close')}<span>${esc(t.clear)}</span></button>`
      : ''
  }</div>${selection ? `<p class="mu ws-ctx-kind">${esc(t.kinds[selection.kind])} <code>${esc(selection.id)}</code></p>` : ''}`;
  return `${head}<div class="ws-ctx-body" data-sel="${esc(selection ? selectionKey(selection) : '')}">${selectionDetail(ctx, ws)}${codeExcerpt(ctx, codeCtx, ws)}</div>`;
}

// ── Contenu des onglets ──────────────────────────────────────────────────────────────────────

/** L'état de lecture d'un fichier pour les vues du code (absent : la lecture va commencer). */
function codeStateOf(entry: SourceEntry | undefined, demo: boolean, lang: Lang): CodeLoadState | undefined {
  if (entry?.view) return undefined;
  if (entry?.state && typeof entry.state === 'object')
    return demo ? { error: TEXT[lang].notInDemo } : entry.state;
  return 'loading';
}

function treeStateOf(ws: WorkspaceUi): CodeLoadState | undefined {
  if (ws.tree) return undefined;
  if (ws.treeState && typeof ws.treeState === 'object') return ws.treeState;
  return 'loading';
}

function layerCode(codeCtx: WorkspaceContext, ws: WorkspaceUi, layer: CodeLayer): string {
  const target = codeTarget(codeCtx, ws.code, layer, ws.tree);
  const entry = target ? ws.sources[fileId(target.applicationId, target.file)] : undefined;
  return renderLayerCode(
    codeCtx,
    ws.code,
    layer,
    ws.tree,
    entry?.view,
    target ? codeStateOf(entry, ws.demo, codeCtx.lang) : undefined,
    treeStateOf(ws),
  );
}

function tabBody(
  ctx: WorkspaceContext,
  codeCtx: WorkspaceContext,
  ws: WorkspaceUi,
  tab: WorkspaceTab,
  scope: string,
): string {
  const t = TEXT[ctx.lang];
  switch (tab) {
    case 'overview':
      return renderOverview(ctx);
    case 'scope':
      return `${demoBanner(ctx)}${scope}`;
    case 'environment': {
      const failed =
        ws.capabilitiesState && typeof ws.capabilitiesState === 'object'
          ? `<p class="mu" role="note">${esc(t.capabilitiesError(ws.capabilitiesState.error))}</p>`
          : '';
      return `${demoBanner(ctx)}${renderEnvironmentSelector(ctx, ws.ux, ws.capabilities)}${failed}`;
    }
    case 'timeline':
      return renderTimeline(ctx, ws.timeline);
    case 'traceability':
      return `${demoBanner(ctx)}${renderGraph(ctx, ws.graph)}<section class="card ws-rel-table" aria-labelledby="ws-rel-t"><h3 id="ws-rel-t">${esc(t.relations)}</h3>${renderRelationsTable(ctx)}</section>`;
    case 'requests':
      return renderRequests(ctx, ws.timeline);
    case 'frontend':
      return `${renderFrontendTrace(ctx, ws.trace)}${layerCode(codeCtx, ws, 'FRONTEND')}`;
    case 'bff':
      return layerCode(codeCtx, ws, 'BFF');
    case 'backend':
      return layerCode(codeCtx, ws, 'BACKEND');
    case 'logs':
      return renderLogs(ctx);
    case 'hypotheses':
      return `${demoBanner(ctx)}${renderHypotheses(ctx, ws.dx)}`;
    case 'experiments':
      return `${demoBanner(ctx)}${renderExperiments(ctx, ws.dx)}`;
    case 'diagnosis':
      return renderDiagnosis(ctx, ws.dx);
    case 'report':
      return renderReport(ctx, ws.report, ws.reportState);
    case 'regression':
      return `${demoBanner(ctx)}${renderRegression(ctx, ws.dx)}`;
  }
}

/** Les onglets, dans l'ordre de l'investigation, avec les nombres connus. */
export function tabsOf(ctx: WorkspaceContext): UxTab[] {
  const ux = uxText(ctx.lang);
  const known = new Map(workspaceTabs(ctx).map((tab) => [tab.key, tab]));
  const pending = ctx.incident.scope.extensions.filter((extension) => extension.status === 'PENDING').length;
  return WORKSPACE_TABS.map((key): UxTab => {
    const tab = known.get(key);
    if (tab) return tab;
    const label =
      key === 'scope' || key === 'environment' || key === 'diagnosis'
        ? ux.stages[key]
        : (ux.tabs[key] ?? key);
    return { key, label, ...(key === 'scope' && pending > 0 ? { count: pending } : {}) };
  });
}

function statusBanner(ctx: WorkspaceContext): string {
  const t = TEXT[ctx.lang];
  const incident = ctx.incident;
  if (incident.state === 'CANCELLED') {
    const from = incident.cancelledFrom ? uxText(ctx.lang).states[incident.cancelledFrom] : undefined;
    return `<p class="note warn ws-banner" role="note">${icon('alert')}<span>${esc(from ? t.cancelled(from) : t.cancelledPlain)}</span></p>`;
  }
  if (incident.state === 'FAILED') {
    const error = [...incident.investigation.reproductions].reverse().find((run) => run.error)?.error;
    return `<div class="err-box ws-banner" role="alert"><p class="err"><b>${esc(t.failed)}</b></p>${error ? `<p>${esc(t.failedRun(error))}</p>` : ''}</div>`;
  }
  return '';
}

// ── La coquille ──────────────────────────────────────────────────────────────────────────────

export interface WorkspaceView {
  incident: Incident;
  ws: WorkspaceUi;
  tab: WorkspaceTab;
  lang: Lang;
  can: WorkspaceContext['can'];
  /** Le retour à la liste (bouton). */
  back: string;
  /** Les actions de l'en-tête (reproduire, actualiser, annuler, reprendre). */
  actions: string;
  /** La zone des messages (la seule zone aria-live de la page). */
  messages: string;
  /** Le contenu de l'onglet « Périmètre » (liste, édition, extensions). */
  scope: string;
  /** Les remarques sous l'en-tête (lecture seule…). */
  notes?: string;
}

/**
 * L'ESPACE D'INVESTIGATION : en-tête, messages, progression, onglets, puis la zone principale — le
 * graphe full-stack (sauf sur l'onglet Traçabilité, qui est le graphe), le contenu de l'onglet et le
 * panneau contextuel (`.ws-ux-shell`). Au-dessus de 1 280 px, le graphe est une bande pleine largeur
 * sous les onglets, le contenu et le panneau (340 px) côte à côte en dessous ; entre 960 et 1 280 px,
 * bande du graphe, contenu puis panneau s'empilent ; en dessous, contenu, graphe puis panneau. Sur les
 * onglets de code et de formulaire (`ws-wide`), la bande passe sous le contenu, qui prend toute la
 * largeur (le panneau à côté de la bande au-dessus de 1 280 px).
 */
export function renderWorkspace(view: WorkspaceView): string {
  const { incident, ws, tab } = view;
  const ctx = workspaceCtx(incident, ws, view.lang, view.can);
  const codeCtx = codeCtxOf(ctx, ws);
  const t = TEXT[view.lang];
  const graph = incident.investigation.graph;
  const showGraph = tab !== 'traceability' && graph !== undefined && graph.nodes.length > 0;
  // Le code et les formulaires demandent de la largeur : la bande du graphe passe sous le contenu de l'onglet.
  // L'ordre du document suit l'ordre affiché sur grand écran (tabulation : bande, contenu, panneau).
  const wide = showGraph && WIDE_TABS.includes(tab);
  const demo = ws.demo
    ? `<p class="note ws-demo-why" id="ws-demo-why" role="note">${icon('info')}<span>${esc(t.demoWhy)}</span></p>`
    : '';
  const main = `<div class="ws-ux-main ws-zone-main" data-ws-zone="main">${renderTabPanel(tab, tabBody(ctx, codeCtx, ws, tab, view.scope))}</div>`;
  const graphZone = showGraph
    ? `<section class="ws-ux-graph ws-zone" data-ws-zone="graph" aria-label="${esc(t.graphZone)}">${renderGraph(ctx, ws.graph)}</section>`
    : '';
  const aside = `<aside class="ws-ux-aside ws-zone ws-ctx" data-ws-zone="aside" aria-labelledby="ws-ctx-t">${renderContextPanel(ctx, codeCtx, ws)}</aside>`;
  return `<div class="ws-root" data-incident="${esc(incident.id)}">${view.back}${renderWorkspaceHeader(ctx, view.actions)}${view.messages}${demo}${statusBanner(ctx)}${view.notes ?? ''}${renderStepper(ctx)}${renderTabs(ctx, tabsOf(ctx), tab)}<div class="ws-ux-shell${showGraph ? (wide ? ' ws-wide' : '') : ' ws-nograph'}">${wide ? `${main}${graphZone}` : `${graphZone}${main}`}${aside}</div></div>`;
}

/**
 * La démonstration : chaque bouton qui modifierait l'incident ou interrogerait le serveur est désactivé,
 * avec la raison (infobulle, et la note `#ws-demo-why` liée par aria-describedby). Les envois de
 * formulaires aussi.
 */
export const DEMO_DISABLED_ACTIONS = [
  'inc-reproduce',
  'inc-cancel',
  'inc-cancel-yes',
  'inc-resume',
  'inc-validate',
  'inc-scope-edit',
  'inc-ext-approve',
  'inc-ext-reject',
  'inc-app-add',
  'inc-app-remove',
  'ws-ux-target-save',
  'ws-dx-analyze',
  'ws-dx-plan',
  'ws-dx-plan-submit',
  'ws-dx-run',
  'ws-dx-approve',
  'ws-dx-diagnose',
  'ws-dx-report',
  'ws-dx-export',
  'ws-dx-regression',
  'ws-code-reload',
  'ws-shot-reload',
] as const;

const DEMO_BUTTON = new RegExp(
  `<button\\b(?=[^>]*\\b(?:data-action="(?:${DEMO_DISABLED_ACTIONS.join('|')})"|type="submit"))`,
  'g',
);

export function disableForDemo(html: string, lang: Lang): string {
  return html.replace(
    DEMO_BUTTON,
    `<button disabled title="${esc(demoUnavailable(lang))}" aria-describedby="ws-demo-why"`,
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** Les styles de la coquille (après ceux des modules) : jetons du thème seulement, clair et sombre. */
export const INCIDENT_WORKSPACE_CSS = `
.ws-root{display:flex;flex-direction:column;gap:16px;min-width:0}
.ws-root>.back{align-self:flex-start}
.ws-zone{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:14px;min-width:0}
.ws-zone-main{display:flex;flex-direction:column;gap:16px;min-width:0}
.ws-zone-main p,.ws-zone-main li,.ws-ctx p,.ws-ctx li{overflow-wrap:anywhere}
.ws-ux-shell.ws-nograph{grid-template-areas:"main" "aside"}
.ws-ux-shell.ws-wide{grid-template-areas:"main" "graph" "aside"}
@container (min-width:1280px){
  .ws-ux-shell.ws-nograph{grid-template-areas:"main aside"}
  .ws-ux-shell.ws-wide{grid-template-areas:"main main" "graph aside"}
}
.ws-ctx{display:flex;flex-direction:column;gap:10px}
.ws-ctx-h2{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.ws-ctx-h2 h2{margin:0;font-size:16px}
.ws-ctx-kind{margin:0;font-size:12px;overflow-wrap:anywhere}
.ws-ctx-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.ws-ctx-card{display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-ctx-card h3,.ws-ctx-h{margin:0;font-size:15px;overflow-wrap:anywhere}
.ws-ctx-card h4{margin:4px 0 0;font-size:13px}
.ws-ctx-eyebrow{margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-ctx-dl{display:grid;grid-template-columns:minmax(80px,max-content) minmax(0,1fr);gap:4px 12px;margin:0;font-size:13px}
.ws-ctx-dl>div{display:contents}
.ws-ctx-dl dt{color:var(--qa-color-muted)}
.ws-ctx-dl dd{margin:0;overflow-wrap:anywhere}
.ws-ctx-code{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--qa-color-border);padding-top:10px}
.ws-ctx-code h3{margin:0;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ws-banner{margin:0;display:flex;gap:8px;align-items:flex-start}
.ws-demo-why{margin:0;display:flex;gap:8px;align-items:flex-start}
.ws-rel-table h3{margin:0 0 8px}
.ws-inv-progress{display:flex;flex-direction:column;gap:4px;min-width:160px}
.ws-inv-bar{display:block;height:8px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden}
.ws-inv-bar>span{display:block;height:100%;background:var(--qa-color-primary)}
.ws-inv-blocked .ws-inv-bar>span{background:var(--qa-color-danger)}
.ws-demo-entry{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.ws-demo-entry p{margin:0}
[data-ws-graph="canvas"]{touch-action:none;cursor:grab}
[data-ws-graph="canvas"].ws-dragging{cursor:grabbing}
`;
