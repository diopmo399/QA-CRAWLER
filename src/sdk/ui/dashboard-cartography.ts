import type {
  ApiCatalog,
  ApiSheet,
  ConceptRow,
  Evidence,
  EvidenceExcerpt,
  FeatureDetail,
  FeatureRow,
  FieldIssue,
  FieldRow,
  FieldSheet,
  ImpactReport,
  MapEdge,
  MapNode,
  MapPage,
  MapSource,
  MapSubgraph,
  MapSummary,
  ScanRecord,
  SourceScan,
} from '../core/cartography.js';
import type { ScenarioView } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { mapStrings, type MapStrings } from './dashboard-cartography-i18n.js';
import { GRAPH_CSS, shortPath, traceView, type GraphSelection } from './dashboard-cartography-graph.js';
import { apiKpis, apisTab, APIS_CSS, type ApiTab } from './dashboard-cartography-apis.js';
import { LANES_CSS, NO_FILTERS, type GraphView, type LaneFilters } from './dashboard-cartography-lanes.js';
import { header, icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * L'ÉCRAN CARTOGRAPHIE, EN EXPLORATION PROGRESSIVE : le premier affichage ne lit qu'un résumé (comptes,
 * listes courtes) ; une fonctionnalité choisie charge sa fiche et une page de ses champs ; un champ choisi
 * charge sa seule fiche (sous-graphe borné, séquence, réutilisations, scénarios, impact). Rien ne télécharge
 * le graphe entier. Chaque lien montre sa confiance et ses preuves ; une étape non démontrée est dite
 * « lien non démontré » ; les décisions sont celles des personnes.
 */
export const MAP_TABS = [
  'overview',
  'scan',
  'features',
  'fields',
  'apis',
  'coverage',
  'trace',
  'impact',
] as const;
export type MapTab = (typeof MAP_TABS)[number];
export const CENTER_TABS = ['summary', 'fields', 'trace', 'reuse', 'scenarios'] as const;
export type CenterTab = (typeof CENTER_TABS)[number];
const LAYER_ORDER = ['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE'] as const;

export interface ListCriteria {
  q: string;
  module: string;
  layer: string;
  status: string;
  coverage: string;
  type: string;
  sort: string;
  page: number;
  size: number;
}

export const emptyCriteria = (size: number, sort = ''): ListCriteria => ({
  q: '',
  module: '',
  layer: '',
  status: '',
  coverage: '',
  type: '',
  sort,
  page: 1,
  size,
});

/** Ce qui se charge, et l'erreur d'une zone (chaque zone a son propre état). */
export type MapPane =
  | 'summary'
  | 'features'
  | 'detail'
  | 'fields'
  | 'sheet'
  | 'concepts'
  | 'issues'
  | 'conceptSheet'
  | 'apis'
  | 'apiSheet';

export interface CartographyUi {
  tab: MapTab;
  summary?: MapSummary;
  loading: Partial<Record<MapPane, boolean>>;
  errors: Partial<Record<MapPane, string>>;
  error?: string;
  /** Niveau 1. */
  features?: MapPage<FeatureRow>;
  featureCriteria: ListCriteria;
  showCriteria: boolean;
  feature?: string;
  detail?: FeatureDetail;
  centerTab: CenterTab;
  /** Niveau 2. */
  fields?: MapPage<FieldRow>;
  fieldCriteria: ListCriteria;
  /** Niveau 3. */
  field?: string;
  sheet?: FieldSheet;
  /** Après « Réutilisé dans » : le concept à reprendre dans la fonctionnalité ouverte. */
  pendingConcept?: string;
  graphView: 'graph' | 'sequence';
  /** Le graphe du champ : parcours principal ou graphe complet, et sa vue (zoom, position, plein écran). */
  graphMode: 'path' | 'full';
  grouped: boolean;
  zoom: number;
  panX: number;
  panY: number;
  fullscreen: boolean;
  graphSel?: GraphSelection;
  /** L'étape dont les relations sont listées (compteur « N liens » cliqué). */
  relStep?: string;
  relOpen: boolean;
  allEvidence?: boolean;
  /** Le panneau droit (détails du champ) replié. */
  detailsCollapsed?: boolean;
  impactOpen?: boolean;
  /** Les nœuds ajoutés à la demande au sous-graphe affiché. */
  expansion?: MapSubgraph;
  /** Onglet Champs & Réutilisations. */
  concepts?: MapPage<ConceptRow>;
  conceptCriteria: ListCriteria;
  concept?: string;
  conceptSheet?: FieldSheet;
  issues?: MapPage<FieldIssue>;
  issuesPage: number;
  /** Sources, scan. */
  sources?: MapSource[];
  sourcesBusy?: boolean;
  sourcesError?: string;
  incremental: boolean;
  scanBusy?: boolean;
  /** Décisions. */
  decision?: { kind: 'RENAME' | 'MERGE'; value: string };
  decisionBusy?: boolean;
  decisionError?: string;
  linkDraft: { scenario: string; path: 'POSITIVE' | 'NEGATIVE' };
  linkOpen?: boolean;
  fieldLinkDraft: string;
  scenarios?: ScenarioView[];
  /** Impact entre deux scans. */
  impact?: ImpactReport;
  impactFrom: string;
  impactTo: string;
  impactBusy?: boolean;
  impactError?: string;
  impactPicked: string[];
  impactEnv: string;
  /** Rejeu préparé depuis l'impact d'un champ. */
  fieldPicked: string[];
  launching?: boolean;
  evidence?: EvidenceExcerpt;
  evidenceError?: string;
  /** API & Services : le catalogue (une page), l'API choisie, sa fiche et son onglet. */
  apis?: ApiCatalog;
  apiCriteria: ListCriteria;
  apiScope: string;
  showApiSort?: boolean;
  api?: string;
  apiSheet?: ApiSheet;
  apiTab: ApiTab;
  /** Le nom métier en cours de saisie (renommage ouvert). */
  apiRename?: string;
  apiPicked: string[];
  /** Le graphe de l'API : parcours ou graphe complet (en couloirs), sa vue, ses critères d'affichage, ce qui est déplié. */
  apiGraphMode: 'path' | 'full';
  apiView: GraphView;
  apiFilters: LaneFilters;
  showApiFilters?: boolean;
  lnCards: string[];
  lnBundles: string[];
  /** Ajuster le graphe à la zone après son prochain affichage (ouverture, changement de mode). */
  autoFit?: boolean;
}

export const emptyCartographyUi = (): CartographyUi => ({
  tab: 'overview',
  loading: {},
  errors: {},
  featureCriteria: emptyCriteria(5, 'name'),
  showCriteria: false,
  centerTab: 'trace',
  fieldCriteria: emptyCriteria(5),
  graphView: 'graph',
  graphMode: 'path',
  grouped: true,
  zoom: 1,
  panX: 0,
  panY: 0,
  fullscreen: false,
  relOpen: true,
  conceptCriteria: emptyCriteria(20),
  issuesPage: 1,
  incremental: true,
  linkDraft: { scenario: '', path: 'POSITIVE' },
  fieldLinkDraft: '',
  impactFrom: '',
  impactTo: '',
  impactPicked: [],
  impactEnv: '',
  fieldPicked: [],
  apiCriteria: emptyCriteria(5, 'name'),
  apiScope: '',
  apiTab: 'summary',
  apiPicked: [],
  apiGraphMode: 'full',
  apiView: 'architecture',
  apiFilters: { ...NO_FILTERS },
  lnCards: [],
  lnBundles: [],
});

// ── Petites pièces ────────────────────────────────────────────────────────────────────────────────

const TONE: Record<string, string> = {
  CONFIRMED: 'ok',
  VALIDATED: 'ok',
  PROBABLE: 'warn',
  UNKNOWN: 'mu',
  COVERED: 'ok',
  PARTIAL: 'warn',
  NOT_COVERED: 'ko',
  TO_CONFIRM: 'warn',
  OUT_OF_SCOPE: 'mu',
  SCANNED: 'ok',
  REUSED: 'ok',
  FAILED: 'ko',
  DENIED: 'ko',
  DISABLED: 'mu',
  NEVER: 'mu',
  COMPLETED: 'ok',
  RUNNING: 'live',
  CANCELLED: 'mu',
  CANDIDATE: 'mu',
  REJECTED: 'mu',
  PROPOSED: 'warn',
  PASSED: 'ok',
  VERIFIED: 'ok',
  EXECUTED: 'live',
  ASSOCIATED: 'warn',
  NONE: 'mu',
};
const chip = (raw: string, text: string): string =>
  `<span class="pill ${TONE[raw] ?? 'mu'}">${esc(text)}</span>`;
const conf = (m: MapStrings, value: string): string => chip(value, m.confidence[value] ?? value);
const SHORT: Record<string, string> = {
  FRONTEND: 'F',
  BFF: 'BFF',
  BACKEND: 'BE',
  API: 'API',
  DATABASE: 'DB',
  EVENTS: 'EV',
  OTHER: '…',
};
const layerChip = (m: MapStrings, layer: string): string =>
  `<span class="map-layer l-${esc(layer.toLowerCase())}">${esc(m.layers[layer] ?? layer)}</span>`;
const layerShort = (m: MapStrings, layer: string): string =>
  `<span class="map-layer l-${esc(layer.toLowerCase())}" title="${esc(m.layers[layer] ?? layer)}">${esc(SHORT[layer] ?? layer)}</span>`;
const spinner = (m: MapStrings): string =>
  `<p class="map-loading mu" role="status"><span class="spin" aria-hidden="true"></span>${esc(m.p.loading)}</p>`;
const paneError = (text: string | undefined): string =>
  text ? `<p class="err" role="alert">${esc(text)}</p>` : '';
const date = (iso: string | undefined, state: DashboardState): string =>
  iso ? new Date(iso).toLocaleString(state.t.locale) : '—';

/** Le bouton qui ouvre l'extrait de code d'une preuve (quand elle a un fichier). */
function evidenceButton(m: MapStrings, evidence: Evidence | undefined, state: MapState): string {
  if (!evidence?.file || !evidence.sourceId || evidence.sourceId === 'scenarios' || !can(state, 'RUN'))
    return '';
  return `<button class="lnk map-ev-btn" data-action="map-evidence" data-source="${esc(evidence.sourceId)}" data-file="${esc(evidence.file)}" data-line="${String(evidence.line ?? 1)}" title="${esc(`${evidence.file}:${String(evidence.line ?? 1)}`)}">${icon('code')}<span>${esc(m.evidence)}</span></button>`;
}
/** Le chemin d'une preuve, cliquable quand son code peut être ouvert (sinon un simple texte). */
function evidenceLink(m: MapStrings, evidence: Evidence, state: MapState, text: string): string {
  const full = `${evidence.sourceId ? `${evidence.sourceId}/` : ''}${evidence.file ?? ''}:${String(evidence.line ?? 1)}${evidence.symbol ? ` · ${evidence.symbol}` : ''}`;
  if (!evidence.file || !evidence.sourceId || evidence.sourceId === 'scenarios' || !can(state, 'RUN'))
    return `<span class="map-pv-f" title="${esc(full)}">${esc(text)}</span>`;
  return `<button class="lnk map-pv-f" data-action="map-evidence" data-source="${esc(evidence.sourceId)}" data-file="${esc(evidence.file)}" data-line="${String(evidence.line ?? 1)}" title="${esc(`${m.g.viewCode} : ${full}`)}">${esc(text)}</button>`;
}
const where = (evidence: Evidence | undefined): string =>
  evidence?.file
    ? `<code class="map-loc">${esc(evidence.file)}${evidence.line ? `:${String(evidence.line)}` : ''}</code>`
    : '';

type MapState = DashboardState & { map: CartographyUi };
const withMap = (state: DashboardState): MapState =>
  state.map ? (state as MapState) : { ...state, map: emptyCartographyUi() };

/** Une pagination de serveur : pages voisines, précédente et suivante, taille. */
function pager(m: MapStrings, list: string, page: MapPage<unknown>, sizes: readonly number[]): string {
  const pages = Math.max(1, Math.ceil(page.total / page.size));
  if (page.total === 0) return '';
  const numbers = Array.from({ length: pages }, (_, i) => i + 1).filter(
    (n) => n === 1 || n === pages || Math.abs(n - page.page) <= 2,
  );
  let previous = 0;
  const buttons = numbers
    .map((n) => {
      const gap = n - previous > 1 ? '<span class="mu" aria-hidden="true">…</span>' : '';
      previous = n;
      return `${gap}<button class="btn small ${n === page.page ? 'primary' : 'ghost'}" data-action="map-page" data-list="${list}" data-page="${String(n)}" aria-label="${esc(m.page(n))}" ${n === page.page ? 'aria-current="page"' : ''}>${String(n)}</button>`;
    })
    .join('');
  return `<div class="map-pager"><button class="btn small ghost icon-only" data-action="map-page" data-list="${list}" data-page="${String(page.page - 1)}" ${page.page <= 1 ? 'disabled' : ''} aria-label="${esc(m.prev)}">${icon('back')}</button>${buttons}<button class="btn small ghost icon-only map-next" data-action="map-page" data-list="${list}" data-page="${String(page.page + 1)}" ${page.page >= pages ? 'disabled' : ''} aria-label="${esc(m.next)}">${icon('back')}</button><label class="pick"><select data-map="${list}-size" aria-label="${esc(m.p.perPage(page.size))}">${sizes.map((n) => `<option value="${String(n)}" ${n === page.size ? 'selected' : ''}>${esc(m.p.perPage(n))}</option>`).join('')}</select></label></div>`;
}

// ── L'écran ───────────────────────────────────────────────────────────────────────────────────────

const TAB_ICON: Record<MapTab, string> = {
  overview: 'overview',
  scan: 'search',
  features: 'cube',
  fields: 'merge',
  coverage: 'scenarios',
  trace: 'traceability',
  apis: 'code',
  impact: 'trends',
};

export function cartographyView(input: DashboardState): string {
  const state = withMap(input);
  const m = mapStrings(state.t.locale);
  const ui = state.map;
  const project = state.project;
  if (!project)
    return `${header(esc(m.title))}<section class="msg"><p class="mu">${esc(m.noProject)}</p></section>`;
  const summary = ui.summary;
  const running = summary?.running;
  const actions = `${
    can(state, 'RUN') && summary && summary.allowedRoots.length > 0
      ? running
        ? `<button class="btn" data-action="map-scan-cancel">${icon('stop')}<span>${esc(m.cancelScan)}</span></button>`
        : `<button class="btn primary" data-action="map-scan" ${ui.scanBusy || summary.config.sources.length === 0 ? 'disabled' : ''}>${icon('play')}<span>${esc(m.launchScan)}</span></button>`
      : ''
  }<button class="btn" disabled aria-disabled="true" title="${esc(m.a.scheduleUnavailable)}" aria-label="${esc(`${m.a.schedule} — ${m.a.scheduleUnavailable}`)}">${icon('history')}<span>${esc(m.a.schedule)}</span></button>${summary?.scan ? `<button class="btn" data-action="map-export">${icon('download')}<span>${esc(m.export)}</span></button>` : ''}<button class="btn icon-only" data-action="map-refresh" aria-label="${esc(m.refresh)}" title="${esc(m.refresh)}">${icon('refresh')}</button>`;
  const crumb = ui.tab === 'features' ? m.g.crumbFeatures : m.tabs[ui.tab];
  const crumbs = `<nav class="map-crumbs" aria-label="${esc(m.g.crumbsLabel)}"><button class="lnk" data-action="map-tab" data-tab="overview">${icon('back')}<span>${esc(m.g.navLabel)}</span></button><span aria-hidden="true">›</span><b aria-current="page">${esc(crumb)}</b></nav>`;
  const apisView = ui.tab === 'apis';
  const head = `<div class="map-head"><header class="hd map-hd"><div class="hd-t">${crumbs}<h1>${esc(apisView ? m.a.title : m.title)}</h1><p class="sub">${esc(apisView ? m.a.sub : m.sub)}</p></div><div class="acts">${actions}</div></header>${apisView && summary?.scan ? apiKpis(m, ui) : summary ? kpis(m, summary) : ''}</div>`;
  const tabs = `<div class="tabs map-tabs" role="tablist" aria-label="${esc(m.title)}">${MAP_TABS.map((tab) => `<button role="tab" data-action="map-tab" data-tab="${tab}" aria-selected="${String(ui.tab === tab)}">${icon(TAB_ICON[tab])}<span>${esc(m.tabs[tab])}</span></button>`).join('')}</div>`;
  if (!summary)
    return `<div class="map">${head}${tabs}${paneError(ui.errors.summary ?? ui.error)}${ui.errors.summary ? '' : spinner(m)}</div>`;
  const banners = [
    ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : '',
    summary.allowedRoots.length === 0 ? `<p class="map-note warn-t" role="note">${esc(m.noRoot)}</p>` : '',
    running && summary.scan
      ? `<p class="map-run" role="status"><span class="spin" aria-hidden="true"></span>${esc(m.p.runningData(date(summary.scan.finishedAt ?? summary.scan.startedAt, state)))}</p>`
      : running
        ? `<p class="map-run" role="status"><span class="spin" aria-hidden="true"></span>${esc(m.running(running.sources.length, summary.config.sources.filter((s) => s.enabled).length))}</p>`
        : '',
    summary.stale ? `<p class="map-note warn-t" role="note">${esc(m.p.stale)}</p>` : '',
    summary.scan?.state === 'PARTIAL' ? `<p class="map-note warn-t" role="note">${esc(m.p.partial)}</p>` : '',
  ].join('');
  let content: string;
  if (ui.tab === 'scan') content = scanTab(m, state, summary);
  else if (!summary.scan) content = `<section class="card msg"><p class="mu">${esc(m.noScan)}</p></section>`;
  else if (ui.tab === 'overview') content = overviewTab(m, state, summary);
  else if (ui.tab === 'features') content = explorerTab(m, state);
  else if (ui.tab === 'fields') content = fieldsTab(m, state);
  else if (ui.tab === 'coverage') content = coverageTab(m, state, summary);
  else if (ui.tab === 'trace') content = traceTab(m, state);
  else if (ui.tab === 'apis')
    content = apisTab(m, ui, {
      chip,
      conf: (value) => conf(m, value),
      evidence: (e) => evidenceButton(m, e, state),
      where,
      date: (iso) => date(iso, state),
      pager: (list, page, sizes) => pager(m, list, page, sizes),
      spinner: () => spinner(m),
      paneError,
      canDecide: can(state, 'DECIDE') && state.project?.state !== 'ARCHIVED',
      canRun: can(state, 'RUN'),
      environments: state.project?.environments ?? [],
      scenarios: ui.scenarios ?? [],
      summary,
    });
  else content = impactTab(m, state, summary);
  return `<div class="map">${head}${tabs}${banners}${content}${evidencePanel(m, ui)}</div>`;
}

function kpis(m: MapStrings, summary: MapSummary): string {
  const k = summary.kpis;
  const percent = summary.coverage.percent;
  const tile = (name: string, value: string, label: string, title?: string): string =>
    `<article class="map-kpi"${title ? ` title="${esc(title)}"` : ''}>${icon(name)}<span><b>${esc(value)}</b><small>${esc(label)}</small></span></article>`;
  return `<section class="map-kpis" aria-label="${esc(m.counts)}">${tile('cube', String(k.features), m.kpi.features)}${tile('play', String(k.scenarios), m.kpi.scenarios)}${tile('check', percent === undefined ? '—' : `${String(percent)} %`, percent === undefined ? `${m.kpi.coverage} · ${m.kpi.notComputable}` : m.kpi.coverage, summary.coverage.formula)}${tile('data', String(k.fields), m.p.fieldsIndexed)}${tile('merge', String(k.reuse), m.kpi.reuse)}${tile('alert', String(k.toValidate), m.p.toValidate)}</section>`;
}

// ── Vue d'ensemble ────────────────────────────────────────────────────────────────────────────────

function overviewTab(m: MapStrings, state: MapState, summary: MapSummary): string {
  const ui = state.map;
  return `<div class="map-top">${sourcesCard(m, state, summary)}${chainCard(m, ui.detail)}${featureListCard(m, state, true)}</div>
<div class="map-bottom">${reuseCard(m, summary)}${coverageCard(m, summary)}${performanceCard(m, state, summary)}</div>`;
}

function sourceScanOf(summary: MapSummary, id: string): SourceScan | undefined {
  return (summary.running ?? summary.scan)?.sources.find((entry) => entry.sourceId === id);
}

function sourcesCard(m: MapStrings, state: MapState, summary: MapSummary): string {
  const editable = can(state, 'MANAGE_PROJECTS');
  const rows = summary.config.sources
    .map((source, index) => {
      const scan = sourceScanOf(summary, source.id);
      const technologies = scan?.technologies ?? [];
      const known = technologies.filter((t) => t.supported).map((t) => t.technology);
      const missing = technologies.filter((t) => !t.supported).map((t) => t.technology);
      const state0 = source.enabled ? (scan?.state ?? 'NEVER') : 'DISABLED';
      const tech = [...known, ...missing.map((t) => `${t} : ${m.missingConnector}`)].join(' · ') || '—';
      return `<li class="map-src"><input type="checkbox" data-map="src-enabled" data-index="${String(index)}" ${source.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${esc(`${m.srcField.enabled} : ${source.name}`)}"><span class="map-src-n"><b>${esc(source.name)}</b>${layerChip(m, source.layer)}<small>${esc(tech)}${scan && scan.files > 0 ? ` · ${esc(m.files(scan.files))}` : ''}</small></span>${chip(state0, m.sourceShort[state0] ?? state0)}</li>`;
    })
    .join('');
  return `<section class="card map-sources"><div class="card-h"><h2>${icon('sources')}<span>${esc(m.sources)}</span></h2><button class="btn small ghost icon-only" data-action="map-tab" data-tab="scan" aria-label="${esc(m.tabs.scan)}" title="${esc(m.tabs.scan)}">${icon('edit')}</button></div>${rows ? `<ul class="map-src-l">${rows}</ul>` : `<p class="mu">${esc(m.noScan)}</p>`}${can(state, 'RUN') && summary.allowedRoots.length > 0 && !summary.running ? `<button class="btn primary wide" data-action="map-scan" ${summary.config.sources.length === 0 ? 'disabled' : ''}>${icon('play')}<span>${esc(m.rescan)}</span></button>` : ''}<p class="mu small">${esc(m.supported)} : ${esc(summary.supported.join(', '))}</p></section>`;
}

/** La chaîne d'une fonctionnalité, couche par couche, avec les étapes non démontrées. */
function chainCard(m: MapStrings, detail: FeatureDetail | undefined): string {
  if (!detail) return `<section class="card map-chain"><p class="mu">${esc(m.chainEmpty)}</p></section>`;
  const feature = detail.feature;
  const lanes = LAYER_ORDER.map((layer) => {
    const steps = feature.chain.filter((step) => step.layer === layer);
    if (steps.length === 0) return '';
    const boxes = steps
      .map((step) =>
        step.gap
          ? `<span class="map-box gap" title="${esc(step.gap)}">${esc(m.gap)}</span>`
          : `<span class="map-box ${step.confidence === 'CONFIRMED' ? '' : 'probable'}" title="${esc(m.confidence[step.confidence] ?? step.confidence)}">${esc(step.label)}</span>`,
      )
      .map((box, i) =>
        i === 0
          ? box
          : `<span class="map-step"><span class="map-arrow" aria-hidden="true">→</span>${box}</span>`,
      )
      .join('');
    return `<li class="map-lane l-${esc(layer.toLowerCase())}"><span class="map-lane-n">${esc(m.layers[layer] ?? layer)}</span><span class="map-lane-b">${boxes}</span></li>`;
  }).join('');
  return `<section class="card map-chain"><h2>${icon('traceability')}<span>${esc(m.chain(feature.name))}</span></h2><ol class="map-lanes">${lanes}</ol><p class="mu small"><span class="map-box sample"></span> ${esc(m.confidence.CONFIRMED ?? '')} · <span class="map-box sample probable"></span> ${esc(m.confidence.PROBABLE ?? '')} · <span class="map-box sample gap"></span> ${esc(m.gap)}</p></section>`;
}

// ── Niveau 1 : la liste des fonctionnalités ───────────────────────────────────────────────────────

function featureListCard(m: MapStrings, state: MapState, compact: boolean): string {
  const ui = state.map;
  const c = ui.featureCriteria;
  const summary = ui.summary;
  const select = (name: string, value: string, options: [string, string][], label: string): string =>
    `<label class="pick"><select data-map="f-${name}" aria-label="${esc(label)}"><option value="">${esc(label)} : ${esc(m.all)}</option>${options.map(([v, text]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  const criteria = ui.showCriteria
    ? `<div class="map-filters">${select(
        'module',
        c.module,
        (summary?.modules ?? []).map((v) => [v, v]),
        m.col.module,
      )}${select(
        'layer',
        c.layer,
        LAYER_ORDER.map((l) => [l, m.layers[l] ?? l]),
        m.col.layers,
      )}${select(
        'status',
        c.status,
        ['CANDIDATE', 'CONFIRMED', 'REJECTED'].map((s) => [s, m.featureStatus[s] ?? s]),
        m.col.status,
      )}${select(
        'coverage',
        c.coverage,
        ['COVERED', 'PARTIAL', 'NOT_COVERED', 'TO_CONFIRM', 'OUT_OF_SCOPE'].map((s) => [
          s,
          m.coverageStatus[s] ?? s,
        ]),
        m.col.coverage,
      )}<label class="pick"><select data-map="f-sort" aria-label="${esc(m.p.sortBy)}">${['name', 'fields', 'scenarios', 'coverage', 'reuse'].map((s) => `<option value="${s}" ${s === (c.sort || 'name') ? 'selected' : ''}>${esc(m.p.sortBy)} : ${esc(m.p.sorts[s] ?? s)}</option>`).join('')}</select></label></div>`
    : '';
  const page = ui.features;
  const items = (page?.items ?? [])
    .map((row) => {
      const cov = row.coverage;
      const selected = row.id === ui.feature;
      return `<li><button class="map-item${selected ? ' sel' : ''}" data-action="map-feature" data-feature="${esc(row.id)}" data-nav="features" aria-pressed="${String(selected)}">${icon('cube')}<span class="map-item-n"><b>${esc(row.name)}</b><small>${row.module ? esc(`${m.col.module} ${row.module}`) : ''}${row.status === 'CONFIRMED' ? ` · ${esc(m.featureStatus.CONFIRMED ?? '')}` : ''}</small></span><span class="map-item-c"><span class="map-count">${esc(m.p.fieldsCount(row.fields))}</span>${cov ? chip(cov.status, `${m.coverageStatus[cov.status] ?? cov.status} · ${m.criteriaRatio(cov.met, cov.applicable)}`) : ''}</span></button></li>`;
    })
    .join('');
  const body =
    ui.loading.features && !page
      ? spinner(m)
      : page && page.total === 0
        ? `<p class="mu">${esc(m.p.noFeatureMatch)}</p>`
        : `<ul class="map-items" aria-busy="${String(Boolean(ui.loading.features))}">${items}</ul>`;
  return `<section class="card map-flist${compact ? ' compact' : ''}"><h2>${icon('cube')}<span>${esc(m.discovered(page?.total ?? summary?.kpis.features ?? 0))}</span></h2><div class="map-filters"><label class="map-search">${icon('search')}<input type="search" data-map="f-q" value="${esc(c.q)}" placeholder="${esc(m.search)}" aria-label="${esc(m.search)}"></label><button class="btn small ghost icon-only" data-action="map-criteria" aria-expanded="${String(ui.showCriteria)}" aria-label="${esc(m.p.toggleFilters)}" title="${esc(m.p.toggleFilters)}">${icon('sliders')}</button></div>${criteria}${paneError(ui.errors.features)}${body}${page ? pager(m, 'features', page, [5, 10, 20, 50]) : ''}</section>`;
}

// ── Le module d'exploration (onglet Fonctionnalités) ──────────────────────────────────────────────

function explorerTab(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const right = ui.detailsCollapsed
    ? `<button class="map-rail" data-action="map-details-toggle" aria-expanded="false" title="${esc(m.g.expandPanel)}">${icon('text')}<span>${esc(m.g.expandPanel)}</span></button>`
    : fieldDetailsCard(m, state);
  return `<div class="map-explorer${ui.detailsCollapsed ? ' collapsed' : ''}">${featureListCard(m, state, false)}${centerCard(m, state)}${right}</div>
<div class="map-bottom two">${scenariosCard(m, state)}${fieldImpactCard(m, state)}</div>`;
}

function centerCard(m: MapStrings, state: MapState): string {
  const ui = state.map;
  if (!ui.feature)
    return `<section class="card map-center"><p class="mu">${esc(m.p.pickFeature)}</p></section>`;
  const detail = ui.detail;
  if (!detail)
    return `<section class="card map-center">${paneError(ui.errors.detail)}${ui.errors.detail ? '' : spinner(m)}</section>`;
  const feature = detail.feature;
  const coverage = detail.coverage;
  const links = detail.links.filter((l) => l.status !== 'REJECTED');
  const fieldsTotal = ui.fields?.total ?? 0;
  const tabs: [typeof ui.centerTab, string][] = [
    ['summary', m.p.centerTabs.summary],
    ['fields', m.p.centerTabs.fields(fieldsTotal)],
    ['trace', m.p.centerTabs.trace],
    ['reuse', m.p.centerTabs.reuse(detail.related.length)],
    ['scenarios', m.p.centerTabs.scenarios(links.length)],
  ];
  let body: string;
  if (ui.centerTab === 'summary') body = summaryPane(m, state, detail);
  else if (ui.centerTab === 'trace')
    body = ui.sheet
      ? traceView({
          m,
          ...(ui.summary ? { summary: ui.summary } : {}),
          sheet: ui.sheet,
          ...(ui.expansion ? { expansion: ui.expansion } : {}),
          mode: ui.graphMode,
          grouped: ui.grouped,
          zoom: ui.zoom,
          panX: ui.panX,
          panY: ui.panY,
          fullscreen: ui.fullscreen,
          ...(ui.graphSel ? { selection: ui.graphSel } : {}),
          ...(ui.relStep ? { step: ui.relStep } : {}),
          relationsOpen: ui.relOpen,
          conf: (value) => conf(m, value),
          evidence: (e) => evidenceButton(m, e, state),
          where,
          scanVersion: m.p.scanVersion(ui.sheet.scanId),
        })
      : graphPane(m, state, undefined, undefined, false);
  else if (ui.centerTab === 'reuse') body = reusePane(m, detail);
  else if (ui.centerTab === 'scenarios') body = scenariosPane(m, state, detail);
  else body = `<div class="map-fields-w">${fieldsPane(m, state)}${miniTrace(m, ui.sheet)}</div>`;
  return `<section class="card map-center" aria-label="${esc(feature.name)}"><div class="map-sheet-h">${icon('cube')}<div><h2>${esc(feature.name)}</h2><small class="mu">${esc(feature.module ? m.sheet.module(feature.module) : m.sheet.noModule)}</small></div><p class="map-head-c">${coverage ? chip(coverage.status, `${m.col.coverage} : ${m.coverageStatus[coverage.status] ?? coverage.status} · ${m.criteriaRatio(coverage.met, coverage.applicable)}`) : ''}${feature.status === 'CANDIDATE' ? '' : ` ${chip(feature.status, m.featureStatus[feature.status] ?? feature.status)}`}</p></div><div class="tabs map-sheet-t" role="tablist">${tabs.map(([id, label]) => `<button role="tab" data-action="map-center-tab" data-tab="${id}" aria-selected="${String(ui.centerTab === id)}">${esc(label)}</button>`).join('')}</div><div class="map-center-b">${body}</div></section>`;
}

function summaryPane(m: MapStrings, state: MapState, detail: FeatureDetail): string {
  const ui = state.map;
  const feature = detail.feature;
  const decide = can(state, 'DECIDE') && state.project?.state !== 'ARCHIVED';
  const outOfScope = detail.coverage?.status === 'OUT_OF_SCOPE';
  const others = (ui.features?.items ?? []).filter((f) => f.id !== feature.id);
  const form = ui.decision
    ? `<div class="map-decide-f">${ui.decision.kind === 'RENAME' ? `<label class="field"><span>${esc(m.decide.newName)}</span><input data-map="decision-value" value="${esc(ui.decision.value)}" maxlength="120" autocomplete="off"></label>` : `<label class="field"><span>${esc(m.decide.mergeWith)}</span><select data-map="decision-value"><option value="">—</option>${others.map((f) => `<option value="${esc(f.id)}" ${f.id === ui.decision?.value ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>`}<div class="form-acts start"><button class="btn small primary" data-action="map-decision-save" data-kind="${ui.decision.kind}" ${ui.decisionBusy ? 'disabled' : ''}>${esc(m.decide.save)}</button><button class="btn small ghost" data-action="map-decision-cancel">${esc(m.decide.cancel)}</button></div></div>`
    : '';
  const buttons = decide
    ? `<div class="map-decide">${feature.status !== 'CONFIRMED' ? `<button class="btn small primary" data-action="map-decide" data-kind="CONFIRM" data-target="${esc(feature.id)}">${icon('check')}<span>${esc(m.decide.confirm)}</span></button>` : ''}<button class="btn small" data-action="map-decision-open" data-kind="RENAME">${icon('edit')}<span>${esc(m.decide.rename)}</span></button>${others.length > 0 ? `<button class="btn small" data-action="map-decision-open" data-kind="MERGE">${icon('merge')}<span>${esc(m.decide.merge)}</span></button>` : ''}${feature.status === 'CANDIDATE' || feature.status === 'CONFIRMED' ? `<button class="btn small ghost" data-action="map-decide" data-kind="REJECT" data-target="${esc(feature.id)}">${esc(m.decide.reject)}</button>` : ''}${feature.status !== 'CANDIDATE' || feature.name !== feature.proposedName ? `<button class="btn small ghost" data-action="map-decide" data-kind="RESTORE" data-target="${esc(feature.id)}">${esc(m.decide.restore)}</button>` : ''}<button class="btn small ghost" data-action="map-decide" data-kind="${outOfScope ? 'IN_SCOPE' : 'OUT_OF_SCOPE'}" data-target="${esc(feature.id)}">${esc(outOfScope ? m.decide.inScope : m.decide.outOfScope)}</button></div>${form}${paneError(ui.decisionError)}`
    : '';
  const evidence = feature.evidence
    .slice(0, 6)
    .map(
      (e) =>
        `<li>${where(e)} ${e.detail ? `<span class="mu">${esc(e.detail)}</span>` : ''} ${evidenceButton(m, e, state)}</li>`,
    )
    .join('');
  const criteria = detail.coverage
    ? `<h3>${esc(m.p.criteriaLabel)}</h3><ul class="map-crit-l">${detail.coverage.criteria.map((c) => `<li class="${c.met === undefined ? 'na' : c.met ? 'ok' : 'ko'}">${esc(c.met === undefined ? m.na : c.met ? '✓' : '✗')} <b>${esc(c.label)}</b> <small class="mu">${esc(c.detail)}</small></li>`).join('')}</ul><p class="mu small">${esc(detail.coverage.formula)}</p>`
    : '';
  return `<dl class="map-dl"><dt>${esc(m.sheet.basis)}</dt><dd>${esc(feature.basis)}</dd><dt>${esc(m.sheet.proposed)}</dt><dd>${esc(feature.proposedName)}</dd><dt>${esc(m.sheet.layers)}</dt><dd>${feature.layers.map((l) => layerChip(m, l)).join(' ')}</dd>${feature.mergedFrom?.length ? `<dt>${esc(m.sheet.mergedFrom)}</dt><dd>${esc(feature.mergedFrom.join(', '))}</dd>` : ''}</dl>${chainCard(m, detail)}${criteria}${evidence ? `<h3>${esc(m.sheet.evidence)}</h3><ul class="map-ev-l">${evidence}</ul>` : ''}${buttons}`;
}

// ── Niveau 2 : les champs d'une fonctionnalité ────────────────────────────────────────────────────

function fieldsPane(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const c = ui.fieldCriteria;
  const page = ui.fields;
  const types = [
    ...new Set((page?.items ?? []).map((r) => r.type).filter((t): t is string => Boolean(t))),
  ].sort();
  const rows = (page?.items ?? [])
    .map((row) => {
      const selected = row.id === ui.field;
      return `<tr class="${selected ? 'sel' : ''}"><td><button class="lnk map-frow" data-action="map-field" data-field="${esc(row.id)}" data-nav="fields" aria-pressed="${String(selected)}">${esc(row.label ?? row.name)}</button>${row.label ? `<small class="mono mu"> ${esc(row.name)}</small>` : ''}</td><td>${esc(row.type ?? '—')}</td><td class="map-lys">${LAYER_ORDER.filter(
        (l) => row.layers.includes(l),
      )
        .map((l) => layerShort(m, l))
        .join(
          '',
        )}</td><td class="num">${String(row.reuse)}</td><td>${conf(m, row.status)} ${chip(row.tested, m.p.tested[row.tested] ?? row.tested)}</td></tr>`;
    })
    .join('');
  const table =
    ui.loading.fields && !page
      ? spinner(m)
      : page && page.total === 0
        ? `<p class="mu">${esc(m.p.noFieldMatch)}</p>`
        : `<div class="tbl-w" aria-busy="${String(Boolean(ui.loading.fields))}"><table class="tbl map-tbl"><thead><tr><th>${esc(m.col.field)}</th><th>${esc(m.col.type)}</th><th>${esc(m.col.layers)}</th><th class="num">${esc(m.col.reuse)}</th><th>${esc(m.col.status)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<div class="map-fields"><div class="map-filters"><label class="map-search">${icon('search')}<input type="search" data-map="c-q" value="${esc(c.q)}" placeholder="${esc(m.p.fieldSearch)}" aria-label="${esc(m.p.fieldSearch)}"></label><label class="pick"><select data-map="c-type" aria-label="${esc(m.col.type)}"><option value="">${esc(m.p.allTypes)}</option>${[...new Set([...types, ...(c.type ? [c.type] : [])])].map((t) => `<option value="${esc(t)}" ${t === c.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label><label class="pick"><select data-map="c-layer" aria-label="${esc(m.col.layers)}"><option value="">${esc(m.p.allLayers)}</option>${LAYER_ORDER.map((l) => `<option value="${l}" ${l === c.layer ? 'selected' : ''}>${esc(m.layers[l] ?? l)}</option>`).join('')}</select></label></div>${paneError(ui.errors.fields)}${table}${page ? pager(m, 'fields', page, [5, 10, 20, 50]) : ''}</div>`;
}

/** La traçabilité du champ choisi, en colonne : son passage de couche en couche. */
function miniTrace(m: MapStrings, sheet: FieldSheet | undefined): string {
  if (!sheet) return `<aside class="map-mini"><p class="mu small">${esc(m.p.pickField)}</p></aside>`;
  const byLayer = new Map<string, MapNode[]>();
  for (const node of sheet.graph.nodes)
    if (
      (node.kind === 'FIELD' || node.kind === 'COLUMN') &&
      (sheet.sequence.some((e) => e.from === node.id || e.to === node.id) || node.id === sheet.node.id)
    )
      byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), node]);
  const boxes = LAYER_ORDER.filter((l) => byLayer.has(l))
    .map((layer) => {
      const nodes = byLayer.get(layer) ?? [];
      return `<li class="map-lane l-${layer.toLowerCase()}"><b>${esc(m.layers[layer] ?? layer)}</b>${nodes
        .slice(0, 3)
        .map(
          (n) =>
            `<small>${esc(String(n.detail.container ?? ''))}${n.detail.container ? ' · ' : ''}${esc(n.label ?? n.name)}</small>`,
        )
        .join('')}${nodes.length > 3 ? `<small class="mu">+${String(nodes.length - 3)}</small>` : ''}</li>`;
    })
    .join('<li class="map-down" aria-hidden="true">↓</li>');
  return `<aside class="map-mini" aria-label="${esc(m.p.traceOf(sheet.node.label ?? sheet.node.name))}"><div class="card-h"><h3>${esc(m.p.traceOf(sheet.node.label ?? sheet.node.name))}</h3><button class="btn small ghost icon-only" data-action="map-center-tab" data-tab="trace" aria-label="${esc(m.p.centerTabs.trace)}" title="${esc(m.p.centerTabs.trace)}">${icon('maximize')}</button></div><ol class="map-mini-l">${boxes}</ol>${sheet.concept.gaps.length ? `<p class="warn-t small">${esc(sheet.concept.gaps[0] ?? '')}</p>` : ''}</aside>`;
}

// ── Niveau 3 : la traçabilité d'un champ (graphe ou séquence) ─────────────────────────────────────

const verb = (m: MapStrings, edge: MapEdge): string => m.edgeKinds[edge.kind] ?? edge.kind;

/** Le sous-graphe du champ : colonnes par couche, liens colorés par confiance ; un nœud s'étend à la demande. */
export function graphSvg(m: MapStrings, graph: MapSubgraph, focus: string): string {
  const columns: string[] = [...LAYER_ORDER, 'EVENTS', 'OTHER'];
  const used = columns.filter((layer) => graph.nodes.some((n) => n.layer === layer));
  const W = 196;
  const H = 46;
  const GX = 56;
  const GY = 14;
  const pos = new Map<string, { x: number; y: number }>();
  const heights: number[] = [];
  used.forEach((layer, col) => {
    // Les champs d'abord (le parcours de la donnée), puis leur contexte (composants, DTO, méthodes…).
    const rank = (n: MapNode): number =>
      n.id === focus ? 0 : n.kind === 'FIELD' || n.kind === 'COLUMN' ? 1 : 2;
    const nodes = graph.nodes
      .filter((n) => n.layer === layer)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          a.kind.localeCompare(b.kind) ||
          (a.label ?? a.name).localeCompare(b.label ?? b.name),
      );
    nodes.forEach((n, row) => pos.set(n.id, { x: 12 + col * (W + GX), y: 36 + row * (H + GY) }));
    heights.push(36 + nodes.length * (H + GY));
  });
  const width = 24 + used.length * (W + GX) - GX;
  const height = Math.max(...heights, 120) + 10;
  const lines = graph.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      const x1 = a.x + (b.x >= a.x ? W : 0);
      const x2 = b.x + (b.x >= a.x ? 0 : W);
      const y1 = a.y + H / 2;
      const y2 = b.y + H / 2;
      const same = a.x === b.x;
      const path = same
        ? `M${String(a.x + W)} ${String(y1)} C${String(a.x + W + 40)} ${String(y1)} ${String(b.x + W + 40)} ${String(y2)} ${String(b.x + W)} ${String(y2)}`
        : `M${String(x1)} ${String(y1)} C${String((x1 + x2) / 2)} ${String(y1)} ${String((x1 + x2) / 2)} ${String(y2)} ${String(x2)} ${String(y2)}`;
      return `<path class="map-g-e c-${e.confidence.toLowerCase()}" d="${path}" marker-end="url(#map-arrow)"><title>${esc(`${verb(m, e)} · ${m.confidence[e.confidence] ?? e.confidence} · ${e.reason}`)}</title></path>`;
    })
    .join('');
  const boxes = graph.nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return '';
      const field = n.kind === 'FIELD' || n.kind === 'COLUMN';
      const label = (n.label ?? n.name).slice(0, 30);
      const sub = `${n.kind}${n.detail.container ? ` · ${String(n.detail.container)}` : ''}`.slice(0, 34);
      return `<g class="map-g-n${n.id === focus ? ' focus' : ''}${field ? ' field' : ''}" transform="translate(${String(p.x)},${String(p.y)})" data-action="map-expand" data-node="${esc(n.id)}" role="button" tabindex="0" aria-label="${esc(m.p.expand(n.label ?? n.name))}"><rect width="${String(W)}" height="${String(H)}" rx="8"/><text x="10" y="19">${esc(label)}</text><text class="sub" x="10" y="35">${esc(sub)}</text><title>${esc(n.id)}</title></g>`;
    })
    .join('');
  const titles = used
    .map(
      (layer, col) =>
        `<text class="map-g-t" x="${String(12 + col * (W + GX))}" y="20">${esc(m.layers[layer] ?? layer)}</text>`,
    )
    .join('');
  return `<div class="map-graph-w"><svg class="map-graph" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-label="${esc(m.p.graphView)}"><defs><marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>${titles}${lines}${boxes}</svg></div>`;
}

/** Le sous-graphe affiché : celui de la fiche, plus les nœuds étendus à la demande (sans doublon). */
export function mergedGraph(sheet: FieldSheet, expansion: MapSubgraph | undefined): MapSubgraph {
  if (!expansion) return sheet.graph;
  const nodes = new Map(sheet.graph.nodes.map((n) => [n.id, n]));
  for (const n of expansion.nodes) nodes.set(n.id, n);
  const edges = new Map(sheet.graph.edges.map((e) => [e.id, e]));
  for (const e of expansion.edges) edges.set(e.id, e);
  return {
    ...sheet.graph,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: sheet.graph.truncated || expansion.truncated,
  };
}

function sequenceList(m: MapStrings, state: MapState, sheet: FieldSheet): string {
  const nodes = new Map(sheet.graph.nodes.map((n) => [n.id, n]));
  const name = (id: string): string => {
    const node = nodes.get(id);
    return node
      ? `${node.label ?? node.name}${node.detail.container ? ` (${String(node.detail.container)})` : ''}`
      : id;
  };
  if (sheet.sequence.length === 0) return `<p class="mu">${esc(m.gap)}</p>`;
  return `<ol class="map-seq">${sheet.sequence
    .map((e) => {
      const evidence = e.evidence[0];
      return `<li class="map-edge"><div>${layerChip(m, nodes.get(e.from)?.layer ?? 'OTHER')} <b>${esc(name(e.from))}</b> <span class="map-verb">${esc(verb(m, e))} →</span> ${layerChip(m, nodes.get(e.to)?.layer ?? 'OTHER')} <b>${esc(name(e.to))}</b> ${conf(m, e.confidence)}</div><small class="mu">${esc(e.reason)}</small><div>${where(evidence)}${evidence?.symbol ? ` <code class="map-loc">${esc(evidence.symbol)}</code>` : ''} <small class="mu">${esc(m.p.scanVersion(sheet.scanId))}</small> ${evidenceButton(m, evidence, state)}</div></li>`;
    })
    .join('')}</ol>`;
}

function graphPane(
  m: MapStrings,
  state: MapState,
  sheet: FieldSheet | undefined,
  expansion: MapSubgraph | undefined,
  withSwitch: boolean,
): string {
  const ui = state.map;
  if (!sheet)
    return ui.loading.sheet
      ? spinner(m)
      : `${paneError(ui.errors.sheet)}<p class="mu">${esc(m.p.pickField)}</p>`;
  const graph = mergedGraph(sheet, expansion);
  const toggle = withSwitch
    ? `<div class="map-seg" role="tablist"><button role="tab" data-action="map-graph-view" data-view="graph" aria-selected="${String(ui.graphView === 'graph')}">${esc(m.p.graphView)}</button><button role="tab" data-action="map-graph-view" data-view="sequence" aria-selected="${String(ui.graphView === 'sequence')}">${esc(m.p.sequenceView)}</button></div>`
    : '';
  const body =
    ui.graphView === 'sequence' && withSwitch
      ? sequenceList(m, state, sheet)
      : graphSvg(m, graph, sheet.node.id);
  return `<h3>${esc(m.p.traceOf(sheet.node.label ?? sheet.node.name))} ${conf(m, sheet.concept.status)}</h3>${toggle}${graph.truncated ? `<p class="map-note warn-t small" role="note">${esc(m.p.truncated(graph.limit, graph.depth))}</p>` : ''}${body}${sheet.concept.gaps.length ? `<h3>${esc(m.gaps)}</h3><ul class="map-why warn-t">${sheet.concept.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}${sheet.concept.homonyms.length ? `<h3>${esc(m.homonyms)}</h3><ul class="map-reuse-l">${sheet.concept.homonyms.map((h) => `<li>${esc(h.name)} <small class="mu">${esc(h.layers.map((l) => m.layers[l] ?? l).join(' → '))}</small></li>`).join('')}</ul>` : ''}`;
}

function reusePane(m: MapStrings, detail: FeatureDetail): string {
  if (detail.related.length === 0) return `<p class="mu">${esc(m.sheet.noRelated)}</p>`;
  return `<h3>${esc(m.sheet.related)}</h3><ul class="map-reuse-l">${detail.related.map((r) => `<li><button class="lnk" data-action="map-feature" data-feature="${esc(r.id)}">${esc(r.name)}</button> <small class="mu">${esc(r.via.join(', '))}</small></li>`).join('')}</ul>`;
}

function scenariosPane(m: MapStrings, state: MapState, detail: FeatureDetail): string {
  const ui = state.map;
  const decide = can(state, 'DECIDE') && state.project?.state !== 'ARCHIVED';
  const coverage = detail.coverage;
  const rows = detail.links
    .map((link) => {
      const row = coverage?.scenarios.find((s) => s.scenario === link.scenario);
      const acts = decide
        ? `${link.status !== 'VALIDATED' ? `<button class="btn small" data-action="map-decide" data-kind="VALIDATE_LINK" data-target="${esc(detail.feature.id)}" data-value="${esc(link.scenario)}">${esc(m.decide.validateLink)}</button>` : ''}${link.status !== 'REJECTED' ? `<button class="btn small ghost" data-action="map-decide" data-kind="REJECT_LINK" data-target="${esc(detail.feature.id)}" data-value="${esc(link.scenario)}">${esc(m.decide.rejectLink)}</button>` : ''}${link.origin === 'MANUAL' || link.status !== 'PROPOSED' ? `<button class="btn small ghost" data-action="map-decide" data-kind="UNLINK_SCENARIO" data-target="${esc(detail.feature.id)}" data-value="${esc(link.scenario)}">${esc(m.decide.unlink)}</button>` : ''}`
        : '';
      const run = row?.lastRun
        ? `${chip(row.lastRun.verdict, row.lastRun.verdict === 'NOT_PLAYED' ? m.notPlayed : row.lastRun.verdict)} <small class="mu">${esc(row.lastRun.run)}</small>`
        : `<small class="mu">${esc(m.notPlayed)}</small>`;
      return `<li class="map-link"><div><b>${esc(link.scenario)}</b> ${chip(link.status, m.linkStatus[link.status] ?? link.status)} ${conf(m, link.confidence)} <small class="mu">${esc(m.origin[link.origin] ?? link.origin)} · ${esc(link.path === 'NEGATIVE' ? m.decide.negative : m.decide.positive)}</small></div><div class="mu small">${run}${row?.traversed !== undefined ? ` · ${esc(row.traversed ? m.traversed : m.notTraversed)}` : ''}</div><ul class="map-why">${link.reasons
        .slice(0, 4)
        .map((r) => `<li>${esc(r)}</li>`)
        .join('')}</ul><div class="map-decide">${acts}</div></li>`;
    })
    .join('');
  const scenarios = (ui.scenarios ?? []).filter(
    (s) => !detail.links.some((link) => link.scenario === s.name && link.status !== 'REJECTED'),
  );
  const add = decide
    ? `<form class="map-add" data-action="map-link-add"><label class="field"><span>${esc(m.decide.linkScenario)}</span><select data-map="link-scenario"><option value="">—</option>${scenarios.map((s) => `<option value="${esc(s.name)}" ${s.name === ui.linkDraft.scenario ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="field"><span>${esc(m.decide.linkPath)}</span><select data-map="link-path"><option value="POSITIVE" ${ui.linkDraft.path === 'POSITIVE' ? 'selected' : ''}>${esc(m.decide.positive)}</option><option value="NEGATIVE" ${ui.linkDraft.path === 'NEGATIVE' ? 'selected' : ''}>${esc(m.decide.negative)}</option></select></label><button class="btn small primary" type="submit" ${ui.linkDraft.scenario ? '' : 'disabled'}>${icon('link')}<span>${esc(m.decide.addLink)}</span></button></form>`
    : '';
  const recos = coverage?.recommendations.length
    ? `<h3>${esc(m.sheet.recommendations)}</h3><ul class="map-why">${coverage.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
    : '';
  return `${rows ? `<ul class="map-links">${rows}</ul>` : ''}${add}${recos}`;
}

// ── Colonne droite : les détails du champ ─────────────────────────────────────────────────────────

function fieldDetailsCard(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const sheet = ui.sheet;
  const tools = `<span class="map-fd-acts"><button class="btn small ghost icon-only" data-action="map-details-toggle" aria-expanded="true" aria-label="${esc(m.g.collapsePanel)}" title="${esc(m.g.collapsePanel)}">${icon('right')}</button>${sheet ? `<button class="btn small ghost icon-only" data-action="map-field-close" aria-label="${esc(m.sheet.close)}" title="${esc(m.sheet.close)}">${icon('close')}</button>` : ''}</span>`;
  const title = `<div class="card-h"><h2>${icon('text')}<span>${esc(m.p.fieldDetails)}</span></h2>${tools}</div>`;
  if (!sheet)
    return `<aside class="map-right"><section class="card map-fdetails">${title}${ui.loading.sheet ? spinner(m) : `${paneError(ui.errors.sheet)}<p class="mu">${esc(m.p.pickField)}</p>`}</section></aside>`;
  const node = sheet.node;
  const type = typeof node.detail.type === 'string' ? node.detail.type : '—';
  const cov = sheet.coverage;
  const bar =
    cov.percent === undefined
      ? `<span class="mu">${esc(m.kpi.notComputable)}</span>`
      : `<span class="map-cov-l"><span class="map-bar wide" role="img" aria-label="${esc(`${String(cov.percent)} %`)}" title="${esc(cov.formula)}"><i style="width:${String(cov.percent)}%"></i></span><b>${String(cov.percent)} %</b></span>`;
  const ratio = `<small class="mu" title="${esc(cov.formula)}">${esc(m.g.coverageRatio(cov.numerator, cov.denominator))}</small>`;
  const details = `<section class="card map-fdetails" aria-label="${esc(m.p.fieldDetails)}">${title}<dl class="map-dl map-fd-dl"><dt>${esc(m.p.name)}</dt><dd><b>${esc(node.label ?? node.name)}</b></dd><dt>${esc(m.g.identifier)}</dt><dd class="mono">${esc(node.name)}</dd><dt>${esc(m.p.type)}</dt><dd>${esc(type)}</dd><dt>${esc(m.p.feature)}</dt><dd>${esc(sheet.feature?.name ?? '—')}</dd><dt>${esc(m.col.layers)}</dt><dd class="map-lys">${sheet.concept.layers.map((l) => layerShort(m, l)).join('')}</dd><dt>${esc(m.p.reuse)}</dt><dd>${icon('merge')} ${esc(m.g.reuseCount(sheet.reuse.length))} <span class="map-help" title="${esc(m.g.reuseHelp)}">${icon('info')}</span></dd><dt>${esc(m.p.coverage)}</dt><dd>${bar}${ratio}</dd><dt>${esc(m.p.status)}</dt><dd>${conf(m, sheet.concept.status)}</dd></dl></section>`;
  const others = sheet.reuse.filter((r) => r.id !== ui.feature);
  const reused = `<section class="card map-fd-reuse"><h2>${icon('merge')}<span>${esc(m.g.reusedIn(others.length))}</span></h2>${
    others.length
      ? `<ul class="map-reused">${others.map((r) => `<li>${icon('cube')}<button class="lnk" data-action="map-reuse-open" data-feature="${esc(r.id)}" data-concept="${esc(sheet.concept.id)}">${esc(r.name)}</button>${conf(m, r.confidence)}</li>`).join('')}</ul>`
      : `<p class="mu small">${esc(m.sheet.noRelated)}</p>`
  }</section>`;
  // Les preuves : celle du champ, puis celles des liens de son parcours (sans doublon de fichier et de ligne).
  const seen = new Set<string>();
  const all = [
    node.evidence[0],
    ...sheet.sequence.map((e) => e.evidence.find((x) => x.file) ?? e.evidence[0]),
  ]
    .filter((e): e is Evidence => e !== undefined)
    .filter((e) => {
      const key = `${e.sourceId ?? ''}|${e.file ?? ''}|${String(e.line ?? '')}|${e.symbol ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const shown = ui.allEvidence ? all : all.slice(0, 3);
  const items = shown
    .map(
      (e) =>
        `<li>${icon(e.file ? 'file' : 'requirements')}<span class="map-pv-t">${e.file ? evidenceLink(m, e, state, `${e.sourceId ? `${e.sourceId}/` : ''}${shortPath(e.file, e.line)}`) : `<small class="mu">${esc(m.g.noEvidenceFile)}</small>`}${e.symbol ? `<small class="mono mu" title="${esc(e.symbol)}">${esc(e.symbol)}</small>` : ''}</span>${e.confidence === 'CONFIRMED' ? '' : conf(m, e.confidence)}</li>`,
    )
    .join('');
  const toggle =
    all.length > 3
      ? `<button class="lnk map-pv-all" data-action="map-evidence-all" aria-expanded="${String(Boolean(ui.allEvidence))}">${esc(ui.allEvidence ? m.g.fewerEvidence : m.g.allEvidence)} ${icon('right')}</button>`
      : '';
  const proofs = `<section class="card map-fd-proofs"><h2>${icon('code')}<span>${esc(m.g.evidenceTitle(all.length))}</span></h2>${items ? `<ul class="map-pv-l">${items}</ul>` : ''}${toggle}</section>`;
  const decide = can(state, 'DECIDE') && state.project?.state !== 'ARCHIVED';
  const linkable = (ui.scenarios ?? []).filter((s) => !sheet.scenarios.some((x) => x.scenario === s.name));
  const link = decide
    ? `<form class="map-add" data-action="map-field-link"><label class="field"><span>${esc(m.p.linkField)}</span><select data-map="field-link"><option value="">—</option>${linkable.map((s) => `<option value="${esc(s.name)}" ${s.name === ui.fieldLinkDraft ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><button class="btn small" type="submit" ${ui.fieldLinkDraft ? '' : 'disabled'}>${icon('link')}<span>${esc(m.decide.addLink)}</span></button></form>`
    : '';
  const issues = sheet.issues.length
    ? `<h3>${esc(m.issues)}</h3><ul class="map-why">${sheet.issues.map((i) => `<li>${esc(m.issueKinds[i.kind] ?? i.kind)} : ${esc(i.message)}</li>`).join('')}</ul>`
    : '';
  const more =
    issues || link
      ? `<details class="card map-fd-more"${sheet.issues.length ? ' open' : ''}><summary>${icon('alert')}<span>${esc(m.g.moreTools)}${sheet.issues.length ? ` (${String(sheet.issues.length)})` : ''}</span></summary>${issues}${link}</details>`
      : '';
  return `<aside class="map-right">${details}${reused}${proofs}${more}</aside>`;
}

// ── Zone inférieure : scénarios, impact du champ, performance ─────────────────────────────────────

function scenariosCard(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const detail = ui.detail;
  const links = (detail?.links ?? []).filter((l) => l.status !== 'REJECTED');
  const coverage = detail?.coverage;
  const format = (name: string): string => {
    const view = ui.scenarios?.find((s) => s.name === name);
    return view ? (view.format === 'gherkin' ? 'Gherkin' : 'YAML') : '—';
  };
  const rows = links
    .map((link) => {
      const row = coverage?.scenarios.find((s) => s.scenario === link.scenario);
      const stateKey =
        row?.traversed && row.asserted ? 'verified' : row?.traversed ? 'executed' : 'associated';
      const tone = stateKey === 'verified' ? 'VERIFIED' : stateKey === 'executed' ? 'EXECUTED' : 'ASSOCIATED';
      return `<tr><td><button class="lnk" data-action="map-open-scenario" data-scenario="${esc(link.scenario)}" title="${esc(m.p.openScenario)}">${icon('play')} ${esc(link.scenario)}</button></td><td>${esc(format(link.scenario))}</td><td>${chip(tone, m.p.scenarioState[stateKey] ?? stateKey)}</td><td>${row?.lastRun ? esc(date(row.lastRun.at, state)) : `<span class="mu">${esc(m.notPlayed)}</span>`}</td></tr>`;
    })
    .join('');
  const add =
    can(state, 'DECIDE') && detail
      ? `<button class="lnk" data-action="map-center-tab" data-tab="scenarios">${icon('plus')} ${esc(m.p.addScenario)}</button>`
      : '';
  return `<section class="card map-scards"><div class="card-h"><h2>${icon('play')}<span>${esc(m.p.scenariosAssoc(links.length))}</span></h2>${add}</div>${rows ? `<div class="tbl-w"><table class="tbl map-tbl"><thead><tr><th>${esc(m.col.scenario)}</th><th>${esc(m.p.colType)}</th><th>${esc(m.p.colStatus)}</th><th>${esc(m.p.colLastRun)}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="mu">${esc(detail ? m.sheet.noRelated : m.p.pickFeature)}</p>`}</section>`;
}

function fieldImpactCard(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const sheet = ui.sheet;
  const head = `<h2>${icon('target')}<span>${esc(m.p.impactTitle)}</span></h2>`;
  if (!sheet)
    return `<section class="card map-icard">${head}<p class="mu">${esc(m.p.pickField)}</p></section>`;
  const impact = sheet.impact;
  const d = impact.demonstrated;
  const p = impact.potential;
  const scenarios = [...new Set([...d.scenarios, ...p.scenarios])];
  const buckets = (['components', 'dtos', 'services', 'endpoints', 'tables'] as const)
    .map((key) => {
      const dem = d[key];
      const pot = p[key];
      if (dem.length + pot.length === 0) return '';
      return `<li><b>${esc(m.p.impactBuckets[key] ?? key)}</b> ${dem.map((v) => `<span class="map-tag ok">${esc(v)}</span>`).join('')}${pot.map((v) => `<span class="map-tag warn" title="${esc(m.p.potential)}">${esc(v)}</span>`).join('')}</li>`;
    })
    .join('');
  const environments = state.project?.environments ?? [];
  const picks = scenarios
    .map(
      (s) =>
        `<li><label class="map-pickrow"><input type="checkbox" data-map="field-pick" data-scenario="${esc(s)}" ${ui.fieldPicked.includes(s) ? 'checked' : ''}> ${esc(s)} ${d.scenarios.includes(s) ? chip('CONFIRMED', m.p.demonstrated) : chip('PROBABLE', m.p.potential)}</label></li>`,
    )
    .join('');
  const launch =
    can(state, 'RUN') && scenarios.length > 0
      ? `<details class="map-replay"><summary>${esc(m.p.prepareReplay)}</summary><ul class="map-imp-l">${picks}</ul><div class="map-filters"><label class="pick">${esc(m.environment)} <select data-map="impact-env"><option value="">${esc(m.noEnvironment)}</option>${environments.map((e) => `<option value="${esc(e.id)}" ${e.id === ui.impactEnv ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label><button class="btn small primary" data-action="map-field-launch" ${ui.fieldPicked.length === 0 || ui.launching ? 'disabled' : ''}>${icon('play')}<span>${esc(m.launchSelection(ui.fieldPicked.length))}</span></button></div><p class="mu small">${esc(m.selectionNote)}</p></details>`
      : '';
  const tables = [...d.tables, ...p.tables];
  const detailBody = ui.impactOpen
    ? `<div class="map-imp-d"><ul class="map-ibuckets">${d.features.length + p.features.length ? `<li><b>${esc(m.p.impactBuckets.features ?? '')}</b> ${d.features.map((f) => `<span class="map-tag ok">${esc(f.name)}</span>`).join('')}${p.features.map((f) => `<span class="map-tag warn">${esc(f.name)}</span>`).join('')}</li>` : ''}${buckets}</ul><p class="mu small">${esc(m.p.depthReached(impact.depth))} · <span class="map-tag ok">${esc(m.p.demonstrated)}</span> <span class="map-tag warn">${esc(m.p.potential)}</span></p>${launch}</div>`
    : '';
  return `<section class="card map-icard">${head}<div class="map-icard-b"><div><p>${esc(m.g.impactPre)} <b>${esc(sheet.node.label ?? sheet.node.name)}</b> ${esc(m.g.impactPost)}</p><ul class="map-ifacts"><li>${icon('cube')} ${esc(m.p.featuresImpacted(d.features.length, p.features.length))}</li><li>${icon('play')} ${esc(m.p.scenariosToReplay(scenarios.length))}</li><li>${icon('code')} ${esc(m.p.filesConcerned(impact.files.length))}</li><li>${icon('data')} ${esc(m.g.tablesNamed(tables.length, tables.slice(0, 3).join(', ')))}</li></ul></div><button class="btn map-imp-btn" data-action="map-impact-open" aria-expanded="${String(Boolean(ui.impactOpen))}">${esc(ui.impactOpen ? m.g.impactLess : m.g.impactDetails)} ${icon('right')}</button></div>${detailBody}</section>`;
}

function performanceCard(m: MapStrings, state: MapState, summary: MapSummary): string {
  const perf = summary.performance;
  return `<section class="card map-perf"><h2>${icon('indicators')}<span>${esc(m.p.perfTitle)}</span></h2><ul class="map-trace"><li class="ok">${icon('check')}<span>${esc(m.p.perfIndexed(perf.indexedFields, perf.indexBuildMs))}</span></li><li class="ok">${icon('check')}<span>${esc(m.p.perfLazy)}</span></li><li class="ok">${icon('check')}<span>${esc(m.p.perfShared(perf.indexedEdges, perf.mergedEvidence))}</span></li><li class="ok">${icon('check')}<span>${esc(m.p.perfCache(perf.cache.hits, perf.cache.misses))}</span></li><li class="ok">${icon('history')}<span>${esc(m.p.perfScan(date(perf.scanAt, state)))}</span></li></ul></section>`;
}

// ── Cartes de la vue d'ensemble ───────────────────────────────────────────────────────────────────

function reuseCard(m: MapStrings, summary: MapSummary): string {
  const max = Math.max(1, ...summary.topReuse.map((c) => c.features));
  const top = summary.topReuse
    .map(
      (c) =>
        `<li><button class="lnk" data-action="map-concept" data-concept="${esc(c.concept)}">${esc(c.name)}</button><span class="map-bar" role="img" aria-label="${esc(m.usedIn(c.features))}"><i style="width:${String(Math.round((c.features / max) * 100))}%"></i></span><small>${esc(m.usedIn(c.features))}</small></li>`,
    )
    .join('');
  return `<section class="card map-reuse"><h2>${icon('merge')}<span>${esc(m.reuseTitle)}</span></h2>${top ? `<ul class="map-bars">${top}</ul>` : `<p class="mu">${esc(m.noReuse)}</p>`}<button class="btn wide" data-action="map-tab" data-tab="fields">${esc(m.allFields(summary.kpis.fields))}</button></section>`;
}

/** L'anneau de couverture : les parts sont des comptes réels ; « non calculable » sans dénominateur. */
function donut(m: MapStrings, summary: MapSummary): string {
  const counts = summary.coverage.counts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const parts: [string, number, string][] = [
    ['COVERED', counts.COVERED, 'var(--qa-color-success)'],
    ['PARTIAL', counts.PARTIAL, 'var(--qa-color-warning)'],
    [
      'TO_CONFIRM',
      counts.TO_CONFIRM,
      'color-mix(in srgb,var(--qa-color-warning) 55%,var(--qa-color-surface))',
    ],
    ['NOT_COVERED', counts.NOT_COVERED, 'var(--qa-color-danger)'],
    ['OUT_OF_SCOPE', counts.OUT_OF_SCOPE, 'var(--qa-color-border-strong)'],
  ];
  let start = 0;
  const stops =
    total === 0
      ? 'var(--qa-color-border) 0 100%'
      : parts
          .filter(([, n]) => n > 0)
          .map(([, n, color]) => {
            const from = start;
            start += (n / total) * 100;
            return `${color} ${String(from)}% ${String(start)}%`;
          })
          .join(',');
  const percent = summary.coverage.percent;
  return `<div class="map-donut-w"><div class="map-donut" style="background:conic-gradient(${stops})" role="img" aria-label="${esc(`${m.kpi.coverage} : ${percent === undefined ? m.kpi.notComputable : `${String(percent)} %`}`)}"><span><b>${percent === undefined ? '—' : `${String(percent)} %`}</b><small>${esc(percent === undefined ? m.kpi.notComputable : m.kpi.coverage)}</small></span></div><ul class="map-legend">${parts.map(([key, n, color]) => `<li><i style="background:${color}"></i>${esc(m.coverageStatus[key] ?? key)} (${String(n)})</li>`).join('')}</ul></div><p class="mu small"><b>${esc(m.formula)} :</b> ${esc(summary.coverage.formula)}</p>`;
}

function coverageCard(m: MapStrings, summary: MapSummary): string {
  const t = summary.traceability;
  const item = (ok: boolean, text: string): string =>
    `<li class="${ok ? 'ok' : 'off'}">${icon(ok ? 'check' : 'close')}<span>${esc(text)}</span></li>`;
  return `<section class="card map-cov"><h2>${icon('check')}<span>${esc(m.coverageTitle)}</span></h2>${donut(m, summary)}<h3>${esc(m.trace)}</h3><ul class="map-trace">${item(t.fieldsLayers, m.traceItems.fieldsLayers)}${item(t.featureScenarios, m.traceItems.featureScenarios)}${item(t.impact, m.traceItems.impact)}${item(false, m.traceItems.requirements)}</ul></section>`;
}

// ── Champs & Réutilisations ───────────────────────────────────────────────────────────────────────

function fieldsTab(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const c = ui.conceptCriteria;
  const page = ui.concepts;
  const list = (page?.items ?? [])
    .map(
      (row) =>
        `<li class="${row.id === ui.concept ? 'sel' : ''}"><button class="map-c" data-action="map-concept" data-concept="${esc(row.id)}" aria-pressed="${String(row.id === ui.concept)}"><b>${esc(row.name)}</b>${conf(m, row.status)}<small class="mu">${esc(row.layers.map((l) => m.layers[l] ?? l).join(' → '))} · ${String(row.fields)} · ${esc(m.usedIn(row.features))}</small></button></li>`,
    )
    .join('');
  const filters = `<div class="map-filters"><label class="map-search">${icon('search')}<input type="search" data-map="k-q" value="${esc(c.q)}" placeholder="${esc(m.fieldsSearch)}" aria-label="${esc(m.fieldsSearch)}"></label><label class="pick"><select data-map="k-layer" aria-label="${esc(m.col.layers)}"><option value="">${esc(m.col.layers)} : ${esc(m.all)}</option>${LAYER_ORDER.map((l) => `<option value="${l}" ${l === c.layer ? 'selected' : ''}>${esc(m.layers[l] ?? l)}</option>`).join('')}</select></label><label class="pick"><select data-map="k-status" aria-label="${esc(m.col.confidence)}"><option value="">${esc(m.col.confidence)} : ${esc(m.all)}</option>${['CONFIRMED', 'PROBABLE', 'UNKNOWN', 'VALIDATED'].map((s) => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${esc(m.confidence[s] ?? s)}</option>`).join('')}</select></label></div>`;
  const sheet = ui.conceptSheet;
  const validate =
    sheet &&
    can(state, 'DECIDE') &&
    sheet.concept.status !== 'VALIDATED' &&
    state.project?.state !== 'ARCHIVED'
      ? `<button class="btn small" data-action="map-decide" data-kind="VALIDATE_CONCEPT" data-target="${esc(sheet.concept.id)}">${icon('check')}<span>${esc(m.decide.validateConcept)}</span></button>`
      : '';
  const right = sheet
    ? `<section class="card map-concept"><div class="card-h"><h2>${esc(sheet.concept.name)} ${conf(m, sheet.concept.status)}</h2>${validate}</div><p class="mu small">${esc(m.conceptFlow)}</p>${graphSvg(m, sheet.graph, sheet.node.id)}<p>${sheet.reuse.map((f) => `<button class="map-mod" data-action="map-feature" data-feature="${esc(f.id)}">${esc(f.name)}</button>`).join(' ')}</p>${sheet.concept.gaps.length ? `<h3>${esc(m.gaps)}</h3><ul class="map-why warn-t">${sheet.concept.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}<h3>${esc(m.edgesTitle(sheet.sequence.length))}</h3>${sequenceList(m, state, sheet)}${sheet.concept.homonyms.length ? `<h3>${esc(m.homonyms)}</h3><ul class="map-reuse-l">${sheet.concept.homonyms.map((h) => `<li><button class="lnk" data-action="map-concept" data-concept="${esc(h.id)}">${esc(h.name)}</button> <small class="mu">${esc(h.layers.map((l) => m.layers[l] ?? l).join(' → '))}</small></li>`).join('')}</ul>` : ''}</section>`
    : `<section class="card">${ui.loading.conceptSheet ? spinner(m) : `${paneError(ui.errors.conceptSheet)}<p class="mu">${esc(m.pickConcept)}</p>`}</section>`;
  const issues = ui.issues;
  const issueRows = (issues?.items ?? [])
    .map(
      (issue) =>
        `<li>${chip(issue.kind === 'UNUSED' || issue.kind === 'DUPLICATE' ? 'PROPOSED' : 'NOT_COVERED', m.issueKinds[issue.kind] ?? issue.kind)} <span>${esc(issue.message)}</span>${issue.concept ? ` <button class="lnk" data-action="map-concept" data-concept="${esc(issue.concept)}" aria-label="${esc(m.conceptFlow)}">${icon('eye')}</button>` : ''}</li>`,
    )
    .join('');
  return `<div class="map-split right"><section class="card map-concepts"><h2>${icon('merge')}<span>${esc(m.concepts(page?.total ?? 0))}</span></h2>${filters}${paneError(ui.errors.concepts)}${ui.loading.concepts && !page ? spinner(m) : `<ul class="map-c-l">${list}</ul>`}${page ? pager(m, 'concepts', page, [10, 20, 50]) : ''}</section>${right}</div><section class="card map-issues"><h2>${icon('alert')}<span>${esc(m.issues)} (${String(issues?.total ?? 0)})</span></h2>${issueRows ? `<ul class="map-issue-l">${issueRows}</ul>` : `<p class="mu">${esc(m.noIssue)}</p>`}${issues ? pager(m, 'issues', issues, [20]) : ''}</section>`;
}

// ── Scénarios & Couverture ────────────────────────────────────────────────────────────────────────

function coverageTab(m: MapStrings, state: MapState, summary: MapSummary): string {
  const ui = state.map;
  const ids = ['LINKED', 'TRAVERSED', 'ASSERTED', 'PASSED', 'CRITICAL_FIELDS', 'NEGATIVE_PATH'];
  const page = ui.features;
  const rows = (page?.items ?? [])
    .map((row) => {
      const cov = row.coverage;
      const cells = ids
        .map((id) => {
          const c = cov?.criteria.find((entry) => entry.id === id);
          const text = c?.met === undefined ? m.na : c.met ? '✓' : '✗';
          return `<td class="map-crit ${c?.met === undefined ? 'na' : c.met ? 'ok' : 'ko'}" title="${esc(c?.detail ?? '')}">${esc(text)}</td>`;
        })
        .join('');
      return `<tr class="${row.id === ui.feature ? 'sel' : ''}"><th scope="row"><button class="lnk" data-action="map-feature" data-feature="${esc(row.id)}">${esc(row.name)}</button></th>${cells}<td>${cov ? `${chip(cov.status, m.coverageStatus[cov.status] ?? cov.status)} <small class="mu">${esc(m.criteriaRatio(cov.met, cov.applicable))}</small>` : '—'}</td></tr>`;
    })
    .join('');
  const matrix = `<section class="card map-matrix wide"><h2>${icon('grid')}<span>${esc(m.matrix)}</span></h2><div class="tbl-w"><table class="tbl map-tbl"><thead><tr><th>${esc(m.col.feature)}</th>${ids.map((id) => `<th>${esc(m.criteria[id] ?? id)}</th>`).join('')}<th>${esc(m.col.status)}</th></tr></thead><tbody>${rows}</tbody></table></div>${page ? pager(m, 'features', page, [5, 10, 20, 50]) : ''}</section>`;
  const detail = ui.detail;
  const links = detail
    ? `<section class="card"><h2>${esc(detail.feature.name)}</h2>${scenariosPane(m, state, detail)}</section>`
    : `<section class="card"><p class="mu">${esc(m.p.pickFeature)}</p></section>`;
  return `<div class="map-split"><section class="card map-cov">${donut(m, summary)}</section>${links}</div>${matrix}`;
}

// ── Traçabilité ───────────────────────────────────────────────────────────────────────────────────

function traceTab(m: MapStrings, state: MapState): string {
  const ui = state.map;
  const detail = ui.detail;
  if (!detail)
    return `<section class="card">${ui.loading.detail ? spinner(m) : `<p class="mu">${esc(m.p.pickFeature)}</p>`}</section>`;
  const nodes = new Map(detail.nodes.map((n) => [n.id, n]));
  const name = (id: string): string => nodes.get(id)?.label ?? nodes.get(id)?.name ?? id;
  const rows = detail.edges
    .map(
      (e) =>
        `<tr><td>${esc(name(e.from))}</td><td>${esc(verb(m, e))}</td><td>${esc(name(e.to))}</td><td>${conf(m, e.confidence)}</td><td><small>${esc(e.reason)}</small></td><td>${where(e.evidence[0])} ${evidenceButton(m, e.evidence[0], state)}</td></tr>`,
    )
    .join('');
  const options = (ui.features?.items ?? [])
    .map(
      (f) =>
        `<option value="${esc(f.id)}" ${f.id === detail.feature.id ? 'selected' : ''}>${esc(f.name)}</option>`,
    )
    .join('');
  return `<section class="card"><label class="pick">${esc(m.col.feature)} <select data-map="trace-feature">${options}</select></label></section>${chainCard(m, detail)}<section class="card wide"><h2>${esc(m.edgesTitle(detail.edges.length))}</h2>${detail.truncated ? `<p class="map-note warn-t small">${esc(m.p.truncated(detail.edges.length, 1))}</p>` : ''}<div class="tbl-w"><table class="tbl map-tbl"><thead><tr><th>${esc(m.col.from)}</th><th>${esc(m.col.kind)}</th><th>${esc(m.col.to)}</th><th>${esc(m.col.confidence)}</th><th>${esc(m.col.reason)}</th><th>${esc(m.col.evidence)}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ── Impact entre deux scans ───────────────────────────────────────────────────────────────────────

function impactTab(m: MapStrings, state: MapState, summary: MapSummary): string {
  const ui = state.map;
  const scans: ScanRecord[] = summary.scans;
  if (scans.length < 2)
    return `<section class="card"><h2>${esc(m.impactTitle)}</h2><p class="mu">${esc(m.impactNeedTwo)}</p></section>`;
  const scanOption = (id: string, selected: string): string => {
    const scan = scans.find((s) => s.id === id);
    return `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(scan ? `${date(scan.startedAt, state)} · ${m.scanState[scan.state] ?? scan.state}` : id)}</option>`;
  };
  const from = ui.impactFrom || scans[1]?.id || '';
  const to = ui.impactTo || scans[0]?.id || '';
  const pickers = `<div class="map-filters"><label class="pick">${esc(m.impactFrom)} <select data-map="impact-from">${scans.map((s) => scanOption(s.id, from)).join('')}</select></label><label class="pick">${esc(m.impactTo)} <select data-map="impact-to">${scans.map((s) => scanOption(s.id, to)).join('')}</select></label><button class="btn primary" data-action="map-impact" ${ui.impactBusy ? 'disabled' : ''}>${icon('refresh')}<span>${esc(m.impactRun)}</span></button></div><p class="mu small">${esc(m.limitNote)}</p>${paneError(ui.impactError)}`;
  const report = ui.impact;
  if (!report) return `<section class="card"><h2>${esc(m.impactTitle)}</h2>${pickers}</section>`;
  const changes = report.changes
    .slice(0, 200)
    .map(
      (c) =>
        `<li>${chip(c.change === 'REMOVED' ? 'FAILED' : c.change === 'ADDED' ? 'COMPLETED' : 'PROPOSED', m.changeKind[c.change] ?? c.change)} <b>${esc(c.name)}</b> <small class="mu">${esc(c.kind)}</small>${
          c.detail.length
            ? `<ul class="map-why">${c.detail
                .slice(0, 6)
                .map((d) => `<li>${esc(d)}</li>`)
                .join('')}</ul>`
            : ''
        }</li>`,
    )
    .join('');
  const features = report.features
    .map(
      (f) =>
        `<li>${conf(m, f.confidence)} <button class="lnk" data-action="map-feature" data-feature="${esc(f.feature)}">${esc(f.name)}</button><ul class="map-why">${f.via
          .slice(0, 4)
          .map((v) => `<li>${esc(v)}</li>`)
          .join('')}</ul></li>`,
    )
    .join('');
  const environments = state.project?.environments ?? [];
  const scenarios = report.scenarios
    .map(
      (s) =>
        `<li><label class="map-pickrow"><input type="checkbox" data-map="impact-pick" data-scenario="${esc(s.scenario)}" ${ui.impactPicked.includes(s.scenario) ? 'checked' : ''}> <b>${esc(s.scenario)}</b> ${conf(m, s.confidence)}</label><small class="mu">${esc(s.reason)}</small></li>`,
    )
    .join('');
  const launch =
    can(state, 'RUN') && report.scenarios.length > 0
      ? `<div class="map-filters"><label class="pick">${esc(m.environment)} <select data-map="impact-env"><option value="">${esc(m.noEnvironment)}</option>${environments.map((e) => `<option value="${esc(e.id)}" ${e.id === ui.impactEnv ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label><button class="btn primary" data-action="map-impact-launch" ${ui.impactPicked.length === 0 || ui.launching ? 'disabled' : ''}>${icon('play')}<span>${esc(m.launchSelection(ui.impactPicked.length))}</span></button></div><p class="mu small">${esc(m.selectionNote)}</p>`
      : '';
  return `<section class="card"><h2>${esc(m.impactTitle)}</h2>${pickers}</section><div class="map-impact"><section class="card"><h2>${esc(m.changes(report.changes.length))}</h2>${changes ? `<ul class="map-imp-l">${changes}</ul>` : `<p class="mu">${esc(m.noChange)}</p>`}</section><section class="card"><h2>${esc(m.impacted(report.features.length))}</h2><ul class="map-imp-l">${features}</ul></section><section class="card"><h2>${esc(m.toReplay(report.scenarios.length))}</h2><ul class="map-imp-l">${scenarios}</ul>${launch}</section></div>`;
}

// ── Scan & Découverte ─────────────────────────────────────────────────────────────────────────────

function scanTab(m: MapStrings, state: MapState, summary: MapSummary): string {
  const ui = state.map;
  const editable = can(state, 'MANAGE_PROJECTS') && state.project?.state !== 'ARCHIVED';
  const sources = ui.sources ?? summary.config.sources;
  const layers = ['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE', 'EVENTS', 'OTHER'];
  const rows = sources
    .map((s, i) => {
      const input = (name: string, value: string, label: string, extra = ''): string =>
        `<label class="field"><span>${esc(label)}</span><input data-map="src-${name}" data-index="${String(i)}" value="${esc(value)}" ${editable ? '' : 'disabled'} autocomplete="off" spellcheck="false" ${extra}></label>`;
      return `<li class="map-src-e"><div class="map-src-g">${input('id', s.id, m.srcField.id, 'maxlength="40"')}${input('name', s.name, m.srcField.name, 'maxlength="80"')}<label class="field"><span>${esc(m.srcField.layer)}</span><select data-map="src-layer" data-index="${String(i)}" ${editable ? '' : 'disabled'}>${layers.map((l) => `<option value="${l}" ${l === s.layer ? 'selected' : ''}>${esc(m.layers[l] ?? l)}</option>`).join('')}</select></label>${input('path', s.path, m.srcField.path, 'class="mono"')}${input('include', s.include.join(', '), m.srcField.include)}<label class="map-check"><input type="checkbox" data-map="src-enabled" data-index="${String(i)}" ${s.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}> ${esc(m.srcField.enabled)}</label></div>${editable ? `<button class="btn small ghost" data-action="map-src-remove" data-index="${String(i)}">${icon('close')}<span>${esc(m.removeSource)}</span></button>` : ''}</li>`;
    })
    .join('');
  const editor = `<section class="card"><h2>${icon('sources')}<span>${esc(m.sourcesEditor)}</span></h2><p class="mu small">${esc(m.allowedRoots)} : ${summary.allowedRoots.length ? summary.allowedRoots.map((r) => `<code>${esc(r)}</code>`).join(' ') : '—'}</p><ul class="map-src-el">${rows}</ul>${editable ? `<div class="form-acts start"><button class="btn" data-action="map-src-add">${icon('plus')}<span>${esc(m.addSource)}</span></button><button class="btn primary" data-action="map-src-save" ${ui.sourcesBusy ? 'disabled' : ''}>${esc(m.saveSources)}</button></div>` : ''}${paneError(ui.sourcesError)}${can(state, 'RUN') && summary.allowedRoots.length > 0 ? `<div class="form-acts start"><label class="map-check"><input type="checkbox" data-map="incremental" ${ui.incremental ? 'checked' : ''}> ${esc(m.incremental)}</label>${summary.running ? `<button class="btn" data-action="map-scan-cancel">${icon('stop')}<span>${esc(m.cancelScan)}</span></button>` : `<button class="btn primary" data-action="map-scan" ${summary.config.sources.length === 0 ? 'disabled' : ''}>${icon('play')}<span>${esc(m.launchScan)}</span></button>`}</div>` : ''}</section>`;
  const scan = summary.running ?? summary.scan;
  const detail = scan
    ? `<section class="card"><h2>${esc(date(scan.startedAt, state))} ${chip(scan.state, m.scanState[scan.state] ?? scan.state)}</h2><ul class="map-scan-l">${scan.sources
        .map(
          (s) =>
            `<li><b>${esc(s.name)}</b> ${layerChip(m, s.layer)} ${chip(s.state, m.sourceState[s.state] ?? s.state)}<small class="mu"> ${esc(m.files(s.files))}${s.skipped ? ` · ${esc(m.skipped(s.skipped))}` : ''}${s.secretsExcluded ? ` · ${esc(m.secrets(s.secretsExcluded))}` : ''}${s.revision ? ` · ${esc(m.revision(s.revision))}` : ''}</small><ul class="map-why">${s.technologies.map((t) => `<li>${esc(t.technology)} ${t.supported ? chip('CONFIRMED', '✓') : chip('PROPOSED', m.missingConnector)}${t.note ? ` <small class="mu">${esc(t.note)}</small>` : ''}</li>`).join('')}${s.errors
              .slice(0, 5)
              .map((e) => `<li class="warn-t">${esc(e)}</li>`)
              .join('')}</ul></li>`,
        )
        .join('')}</ul>${
        Object.keys(scan.counts).length
          ? `<p class="mu small">${esc(m.counts)} : ${esc(
              Object.entries(scan.counts)
                .map(([k, v]) => `${k} ${String(v)}`)
                .join(' · '),
            )}</p>`
          : ''
      }</section>`
    : '';
  const history = `<section class="card"><h2>${esc(m.history(summary.scans.length))}</h2>${summary.scans.length ? `<ul class="map-scan-h">${summary.scans.map((s) => `<li>${chip(s.state, m.scanState[s.state] ?? s.state)} ${esc(date(s.startedAt, state))} <small class="mu">${s.incremental ? `${esc(m.incrementalShort)} · ` : ''}${esc(m.edgesCount(s.edges))}</small></li>`).join('')}</ul>` : `<p class="mu">${esc(m.noHistory)}</p>`}</section>`;
  return `<div class="map-scan">${editor}${detail}${history}</div>`;
}

function evidencePanel(m: MapStrings, ui: CartographyUi): string {
  if (!ui.evidence && !ui.evidenceError) return '';
  const e = ui.evidence;
  const code = e
    ? `${e.stale ? `<p class="map-note warn-t small" role="note"><b>${esc(m.p.staleEvidence)} :</b> ${esc(e.stale)}</p>` : ''}<pre class="map-code"><code>${e.lines.map((line, i) => `<span class="${e.start + i === e.line ? 'hit' : ''}"><i>${String(e.start + i)}</i>${esc(line)}</span>`).join('\n')}</code></pre>`
    : paneError(ui.evidenceError);
  return `<aside class="map-ev" role="dialog" aria-label="${esc(e ? m.evidenceTitle(e.file, e.line) : m.evidence)}"><div class="card-h"><h2 class="mono">${esc(e ? `${e.source} · ${m.evidenceTitle(e.file, e.line)}` : m.evidence)}</h2><button class="btn small ghost icon-only" data-action="map-evidence-close" aria-label="${esc(m.closeEvidence)}">${icon('close')}</button></div>${code}</aside>`;
}

export const CARTOGRAPHY_CSS = `${GRAPH_CSS}${APIS_CSS}${LANES_CSS}
.map{display:flex;flex-direction:column;gap:14px}
.map-head{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between}
.map-head .hd{flex:1 1 460px;flex-direction:column;align-items:flex-start}
.map-head .hd .acts{order:-1;align-self:flex-end}
.map-kpis{display:flex;flex-wrap:wrap;gap:8px}
.map-kpi{display:flex;gap:8px;align-items:center;padding:8px 12px;border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);background:var(--qa-color-surface);min-width:118px}
.map-kpi .ico{width:22px;height:22px;color:var(--qa-color-primary)}
.map-kpi b{display:block;font-size:20px;line-height:1.1}
.map-kpi small{color:var(--qa-color-muted);font-size:11px}
.map-tabs{margin-top:-4px}
.map-note{margin:0;padding:8px 12px;border-radius:8px;background:var(--qa-color-warning-soft)}
.map-run{display:flex;gap:8px;align-items:center;margin:0}
.map-top{display:grid;grid-template-columns:minmax(220px,.9fr) minmax(320px,1.6fr) minmax(290px,1.2fr);gap:14px;align-items:start}
.map-bottom{display:grid;grid-template-columns:minmax(360px,1.8fr) minmax(240px,1fr) minmax(240px,1fr);gap:14px;align-items:start}
.map-split{display:grid;grid-template-columns:minmax(360px,1.5fr) minmax(320px,1fr);gap:14px;align-items:start}
.map-impact{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;align-items:start}
.map-scan{display:grid;grid-template-columns:minmax(440px,1.7fr) minmax(280px,1fr) minmax(240px,.8fr);gap:14px;align-items:start}
@media (max-width:1300px){.map-scan{grid-template-columns:1fr 1fr}.map-scan>:first-child{grid-column:1 / -1}}
.map .card h2{display:flex;flex-wrap:nowrap;gap:8px;align-items:center;font-size:15px;margin:0 0 10px;text-transform:none;letter-spacing:0;color:var(--qa-color-text)}
.map .card h2 .ico{color:var(--qa-color-primary);flex:none}
.map-split.right{grid-template-columns:minmax(280px,1fr) minmax(360px,1.7fr)}
.map-step{display:inline-flex;gap:6px;align-items:center;white-space:nowrap;max-width:100%}
.map-step .map-box{white-space:normal}
.map-edges{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.map-edge{padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:8px;display:flex;flex-direction:column;gap:4px;font-size:13px}
.map-verb{color:var(--qa-color-primary-2);font-weight:600}
.map-tbl{font-size:13px}
.map-tbl th{white-space:nowrap}
.map-top>*,.map-bottom>*,.map-split>*,.map-impact>*,.map-scan>*{min-width:0}
.map .tbl-w{overflow-x:auto;max-width:100%}
.map-tbl th,.map-tbl td{padding:8px 8px}
.map .card h3{font-size:13px;margin:12px 0 6px}
.map .card-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
.map .small{font-size:12px}
.map .wide{width:100%;justify-content:center}
.map-src-l,.map-c-l,.map-links,.map-reuse-l,.map-imp-l,.map-scan-l,.map-scan-h,.map-issue-l,.map-ev-l,.map-src-el{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.map-src{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--qa-color-border)}
.map-src .pill{font-size:11px;padding:2px 8px}
.map-src-n b{margin-right:4px}
.map-src-n small{display:block;color:var(--qa-color-muted);font-size:11px}
.map-layer{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border)}
.map-layer.l-frontend,.map-lane.l-frontend{--lane:color-mix(in srgb,#7c5cd6 14%,var(--qa-color-surface))}
.map-layer.l-bff,.map-lane.l-bff{--lane:color-mix(in srgb,#2f80c8 14%,var(--qa-color-surface))}
.map-layer.l-backend,.map-lane.l-backend{--lane:color-mix(in srgb,var(--qa-color-success) 16%,var(--qa-color-surface))}
.map-layer.l-api,.map-lane.l-api{--lane:color-mix(in srgb,var(--qa-color-warning) 18%,var(--qa-color-surface))}
.map-layer.l-database,.map-lane.l-database{--lane:color-mix(in srgb,#5b6b7a 14%,var(--qa-color-surface))}
.map-layer[class*="l-"]{background:var(--lane,var(--qa-color-surface-2))}
.map-lanes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.map-lane{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:center;padding:8px 10px;border-radius:10px;background:var(--lane,var(--qa-color-surface-2))}
.map-lane-n{font-weight:600;font-size:13px}
.map-lane-b{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.map-box{display:inline-flex;flex-direction:column;padding:4px 10px;border:1.5px solid var(--qa-color-primary);border-radius:8px;background:var(--qa-color-surface);font-size:12px;max-width:100%;overflow-wrap:anywhere}
.map-box small{color:var(--qa-color-muted);font-size:11px}
.map-box.probable{border-style:dashed;border-color:var(--qa-color-warning)}
.map-box.gap{border-style:dotted;border-color:var(--qa-color-danger);color:var(--qa-color-danger)}
.map-box.sample{width:18px;height:10px;padding:0;vertical-align:middle;display:inline-block}
.map-arrow{color:var(--qa-color-muted)}
.map-sheet{display:flex;flex-direction:column;gap:8px;min-width:0}
.map-sheet-h{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start}
.map-sheet-h h2{margin:0}
.map-sheet-h p{margin:4px 0 0;display:flex;flex-wrap:wrap;gap:6px}
.map-sheet-t button{min-height:32px;padding:0 8px;font-size:12.5px}
.map-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}
.map-dl dt{color:var(--qa-color-muted);font-size:12px}
.map-dl dd{margin:0}
.map-decide{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.map-decide-f,.map-add{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:8px}
.map-why{margin:4px 0 0;padding-left:18px;font-size:12px}
.map-link{padding:8px;border:1px solid var(--qa-color-border);border-radius:8px}
.map-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px}
.map-filters .pick select{min-height:34px;font-size:13px;max-width:170px}
.map-search{display:flex;gap:6px;align-items:center;flex:1 1 200px;padding:0 10px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface)}
.map-search input{border:0;flex:1;min-height:36px;background:transparent;color:inherit;min-width:0}
.map-tbl tr.sel td,.map-tbl tr.sel th{background:var(--qa-color-primary-soft-2)}
.map-tbl td.num,.map-tbl th.num{text-align:right}
.map-mod{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--qa-color-primary-soft-2);color:var(--qa-color-primary-2);border:0;cursor:pointer}
.map-pager{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:8px}
.map-next .ico{transform:rotate(180deg)}
.map-seg{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--qa-color-surface-2);margin-bottom:8px}
.map-seg button{flex:1;min-height:32px;border:0;border-radius:6px;background:transparent;color:var(--qa-color-muted);cursor:pointer}
.map-seg button[aria-selected="true"]{background:var(--qa-color-primary);color:#fff}
.map-bars{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:8px}
.map-bars li{display:grid;grid-template-columns:minmax(90px,1fr) 1fr auto;gap:8px;align-items:center;font-size:13px}
.map-bar{height:8px;border-radius:999px;background:var(--qa-color-surface-2);overflow:hidden}
.map-bar i{display:block;height:100%;background:var(--qa-color-success);border-radius:999px}
.map-donut-w{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.map-donut{width:132px;height:132px;border-radius:50%;display:grid;place-items:center;flex:none}
.map-donut span{width:96px;height:96px;border-radius:50%;background:var(--qa-color-surface);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.map-donut b{font-size:22px}
.map-donut small{font-size:11px;color:var(--qa-color-muted)}
.map-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.map-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.map-trace{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.map-trace li{display:flex;gap:6px;align-items:center}
.map-trace li.ok .ico{color:var(--qa-color-success)}
.map-trace li.off{color:var(--qa-color-muted)}
.map-c{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;text-align:left;padding:8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:inherit;cursor:pointer}
.map-c small{flex-basis:100%}
.map-c-l li.sel .map-c{border-color:var(--qa-color-primary);background:var(--qa-color-primary-soft-2)}
.map-c-l{max-height:560px;overflow:auto}
.map-crit{text-align:center;font-weight:700}
.map-crit.ok{color:var(--qa-color-success)}
.map-crit.ko{color:var(--qa-color-danger)}
.map-crit.na{color:var(--qa-color-muted);font-weight:400;font-size:12px}
.map-pickrow{display:flex;gap:6px;align-items:center}
.map-check{display:inline-flex;gap:6px;align-items:center}
.map-src-e{padding:10px;border:1px solid var(--qa-color-border);border-radius:8px;display:flex;flex-direction:column;gap:6px}
.map-src-g{display:grid;grid-template-columns:minmax(90px,.6fr) minmax(120px,1fr) minmax(120px,.8fr);gap:8px;align-items:end}
.map-src-g .field:nth-child(4),.map-src-g .field:nth-child(5){grid-column:span 2}
.map-src-e{flex-direction:row;flex-wrap:wrap;align-items:flex-end}
.map-src-e .map-src-g{flex:1 1 380px}
.map-loc{font-size:11px}
.map-ev-btn{display:inline-flex;gap:4px;align-items:center;font-size:12px}
.map-ev{position:fixed;right:16px;bottom:16px;width:min(720px,calc(100vw - 32px));max-height:60vh;overflow:auto;z-index:20;padding:12px;border:1px solid var(--qa-color-border-strong);border-radius:12px;background:var(--qa-color-surface);box-shadow:0 12px 32px rgba(0,0,0,.18)}
.map-code{margin:0;font-family:var(--qa-font-family-mono);font-size:12px;line-height:1.5;overflow:auto}
.map-code span{display:block;white-space:pre}
.map-code span.hit{background:var(--qa-color-warning-soft)}
.map-code i{display:inline-block;width:3.5em;color:var(--qa-color-muted);font-style:normal;user-select:none}
@media (max-width:1560px){.map-bottom{grid-template-columns:1fr 1fr}.map-features{grid-column:1 / -1}}
@media (max-width:1200px){.map-top,.map-bottom{grid-template-columns:1fr 1fr}.map-sheet{grid-column:1 / -1}}
@media (max-width:800px){.map-top,.map-bottom,.map-split{grid-template-columns:1fr}.map-lane{grid-template-columns:1fr}}
.map-explorer{display:grid;grid-template-columns:minmax(240px,1fr) minmax(400px,2.2fr) minmax(250px,1.05fr);gap:14px;align-items:start}
.map-explorer>*{min-width:0}
.map-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.map-item{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"i n" "i c";gap:4px 8px;align-items:center;width:100%;text-align:left;padding:10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);color:inherit;cursor:pointer}
.map-item .ico{color:var(--qa-color-primary);grid-area:i}
.map-item.sel{border-color:var(--qa-color-primary);background:var(--qa-color-primary-soft-2);box-shadow:0 0 0 1px var(--qa-color-primary)}
.map-item:focus-visible,.map-frow:focus-visible,.map-g-n:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.map-item-n{min-width:0;display:flex;flex-direction:column;grid-area:n}
.map-item-n b{overflow-wrap:anywhere}
.map-item-n small{color:var(--qa-color-muted);font-size:12px}
.map-item-c{display:flex;flex-wrap:wrap;align-items:center;gap:4px;grid-area:c}
.map-item-c .pill{font-size:11px;padding:2px 8px}
.map-count{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);white-space:nowrap}
.map-center .map-sheet-h{grid-template-columns:auto 1fr auto}
.map-head-c{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.map-center-b{display:flex;flex-direction:column;gap:8px;min-width:0}
.map-fields-w{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
@media (min-width:1760px){.map-fields-w{grid-template-columns:minmax(0,1.7fr) minmax(200px,1fr)}}
.map-mini-l{flex-direction:row !important;flex-wrap:wrap;align-items:center !important}
@media (min-width:1760px){.map-mini-l{flex-direction:column !important;align-items:stretch !important}}
.map-fields{min-width:0}
.map-fields .map-tbl th,.map-fields .map-tbl td{padding:6px 5px;font-size:12.5px}
.map-fields .map-tbl td:last-child{display:flex;flex-wrap:wrap;gap:3px}
.map-fields .pill{font-size:10.5px;padding:1px 6px}
.map-lys{white-space:nowrap}
.map-lys .map-layer{margin-right:2px;padding:1px 6px}
.map-mini{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px;background:var(--qa-color-surface-2);min-width:0}
.map-mini h3{margin:0;font-size:13px}
.map-mini-l{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:2px;align-items:stretch}
.map-mini-l .map-lane{display:flex;flex-direction:column;gap:2px;padding:6px 8px;grid-template-columns:none}
.map-mini-l small{font-size:11px;overflow-wrap:anywhere}
.map-down{text-align:center;color:var(--qa-color-danger);font-weight:700;line-height:1;transform:rotate(-90deg)}
@media (min-width:1760px){.map-down{transform:none}}
.map-graph-w{overflow:auto;max-width:100%;max-height:560px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.map-graph{display:block}
.map-g-t{font-size:12px;font-weight:700;fill:var(--qa-color-muted)}
.map-g-n{cursor:pointer}
.map-g-n rect{fill:var(--qa-color-surface-2);stroke:var(--qa-color-border-strong);stroke-width:1}
.map-g-n.field rect{fill:color-mix(in srgb,var(--qa-color-primary) 8%,var(--qa-color-surface));stroke:var(--qa-color-primary)}
.map-g-n.focus rect{stroke-width:3}
.map-g-n text{font-size:12px;fill:var(--qa-color-text);font-weight:600}
.map-g-n text.sub{font-size:10px;font-weight:400;fill:var(--qa-color-muted)}
.map-g-e{fill:none;stroke-width:1.6}
.map-g-e.c-confirmed{stroke:var(--qa-color-primary)}
.map-g-e.c-probable{stroke:var(--qa-color-warning);stroke-dasharray:6 4}
.map-g-e.c-unknown{stroke:var(--qa-color-danger);stroke-dasharray:2 4}
#map-arrow path{fill:var(--qa-color-muted)}
.map-seq{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.map-fdetails{display:flex;flex-direction:column;gap:6px}
.map-fdetails h3{display:flex;gap:6px;align-items:center}
.map-reused{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.map-reused li{display:flex;gap:6px;align-items:center}
.map-reused .ico{color:var(--qa-color-primary);width:16px;height:16px}
.map-bar.wide{display:inline-block;width:80px;vertical-align:middle;margin-right:4px}
.map-crit-l{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.map-crit-l li.ok{color:var(--qa-color-success)}
.map-crit-l li.ko{color:var(--qa-color-danger)}
.map-crit-l li.na{color:var(--qa-color-muted)}
.map-crit-l b{color:var(--qa-color-text);font-weight:600}
.map-ifacts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.map-ifacts li{display:flex;gap:8px;align-items:center}
.map-ifacts .ico{color:var(--qa-color-primary)}
.map-ibuckets{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:13px}
.map-tag{display:inline-block;margin:2px 4px 2px 0;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--qa-color-border)}
.map-tag.ok{background:var(--qa-color-success-soft)}
.map-tag.warn{background:var(--qa-color-warning-soft);border-style:dashed}
.map-loading{display:flex;gap:8px;align-items:center;margin:0}
.map details summary{cursor:pointer;font-weight:600;margin-top:6px}
@media (max-width:1400px){.map-explorer{grid-template-columns:minmax(240px,1fr) minmax(0,2fr)}.map-fdetails{grid-column:1 / -1}.map-fields-w{grid-template-columns:1fr}}
@media (max-width:860px){.map-explorer{grid-template-columns:1fr}}

/* ── Maquette de référence : en-tête, indicateurs, onglets, trois colonnes, panneaux ── */
.map-hd{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;width:100%}
.map-head .map-hd .acts{order:0;align-self:flex-start}
.map-hd h1{margin:2px 0 0;font-size:24px}
.map-hd .sub{margin:2px 0 0}
.map-crumbs{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--qa-color-muted)}
.map-crumbs .lnk{display:inline-flex;gap:6px;align-items:center;color:var(--qa-color-text);font-weight:600}
.map-crumbs .ico{width:16px;height:16px}
.map-crumbs b{color:var(--qa-color-text)}
.map-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;width:100%}
.map-kpi{min-width:0;padding:12px 14px;gap:12px;border-radius:12px;box-shadow:0 1px 2px rgba(15,40,30,.05)}
.map-kpi .ico{width:26px;height:26px;color:var(--qa-color-primary);flex:none}
.map-kpi:last-child .ico{color:var(--qa-color-warning)}
.map-kpi b{font-size:22px}
.map-kpi small{font-size:12px;color:var(--qa-color-text)}
.map-tabs{gap:6px;border-bottom:0;padding:4px 0}
.map-tabs button{display:inline-flex;gap:8px;align-items:center;min-height:38px;border:0;border-radius:8px;padding:0 14px;font-weight:600;color:var(--qa-color-text)}
.map-tabs button .ico{width:17px;height:17px}
.map-tabs button[aria-selected="true"]{background:var(--qa-color-primary);color:#fff;border-radius:8px}
.map-tabs button[aria-selected="true"] .ico{color:#fff}
.map-tabs button:hover:not([aria-selected="true"]){border-radius:8px}
.map-explorer{grid-template-columns:minmax(220px,20fr) minmax(0,57fr) minmax(250px,23fr)}
.map-explorer.collapsed{grid-template-columns:minmax(220px,20fr) minmax(0,78fr) 44px}
.map-rail{writing-mode:vertical-rl;display:flex;gap:8px;align-items:center;justify-content:flex-start;padding:12px 8px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);color:var(--qa-color-text);font-weight:600;cursor:pointer;min-height:180px}
.map-rail .ico{transform:rotate(90deg);color:var(--qa-color-primary)}
.map-right{display:flex;flex-direction:column;gap:12px;min-width:0}
.map-right .card{padding:14px}
.map-right .card h2{font-size:14px;margin:0 0 6px}
.map-fd-acts{display:inline-flex;gap:2px}
.map-fd-dl{grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;margin:0}
.map-fd-dl dt{color:var(--qa-color-text);font-weight:600}
.map-fd-dl dd{margin:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0;overflow-wrap:anywhere}
.map-fd-dl dd .ico{width:14px;height:14px;color:var(--qa-color-primary)}
.map-help .ico{color:var(--qa-color-muted)!important}
.map-cov-l{display:flex;gap:8px;align-items:center;flex:1 1 100%}
.map-cov-l .map-bar{flex:1}
.map-reused{display:flex;flex-direction:column;gap:6px}
.map-reused li{display:flex;gap:6px;align-items:center}
.map-reused li .pill{margin-left:auto}
.map-pv-l{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.map-pv-l li{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px}
.map-pv-l li>.ico{width:15px;height:15px;color:var(--qa-color-muted);flex:none}
.map-pv-t{display:flex;flex-direction:column;min-width:0;flex:1}
.map-pv-t .map-loc{overflow-wrap:anywhere;background:transparent;padding:0}
.map-pv-all{display:inline-flex;gap:4px;align-items:center;align-self:center;margin-top:6px;font-weight:600}
.map-pv-all .ico{width:14px;height:14px}
.map-fd-proofs{display:flex;flex-direction:column}
.map-fd-more summary{display:flex;gap:6px;align-items:center;font-weight:600;cursor:pointer}
.map-fd-more summary .ico{color:var(--qa-color-warning);width:16px;height:16px}
.map-bottom.two{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.map-icard-b{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.map-icard-b p{margin:0 0 6px}
.map-ifacts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.map-ifacts li{display:flex;gap:8px;align-items:center}
.map-ifacts .ico{width:16px;height:16px;color:var(--qa-color-primary)}
.map-imp-btn{border:1px solid var(--qa-color-primary);color:var(--qa-color-primary-2);font-weight:600;background:var(--qa-color-surface)}
.map-imp-btn .ico{width:15px;height:15px}
.map-imp-d{border-top:1px solid var(--qa-color-border);margin-top:10px;padding-top:10px}
.map-center .map-sheet-t{border-bottom:1px solid var(--qa-color-border)}
.map-center .map-sheet-t button{flex:1 1 auto;justify-content:center}
@media (max-width:1400px){.map-explorer{grid-template-columns:minmax(220px,1fr) minmax(0,2.6fr)}.map-explorer>.map-right{grid-column:1 / -1;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.map-explorer.collapsed{grid-template-columns:minmax(220px,1fr) minmax(0,2.6fr)}.map-explorer.collapsed .map-rail{grid-column:1 / -1;writing-mode:horizontal-tb;min-height:0}.map-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:860px){.map-explorer,.map-explorer.collapsed{grid-template-columns:1fr}.map-bottom.two{grid-template-columns:1fr}.map-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.map-explorer>.map-right{display:flex}}

.map-head .map-hd{flex-direction:row;flex-wrap:wrap;align-items:flex-start}
.map-head .map-hd .hd-t{flex:1 1 420px;min-width:0}
.map-tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin}
.map-tabs button{padding:0 11px;font-size:13.5px;white-space:nowrap;flex:none}
.map-flist .map-filters{flex-wrap:nowrap}
.map-flist .map-search{flex:1 1 auto;min-width:0}
.map-flist .map-search input{min-width:0;width:100%}
.map-item-c .pill{white-space:normal;max-width:100%}
.map-item{padding:10px 8px}
.map-right .card-h{flex-wrap:nowrap}
.map-right .card-h h2{flex:1;min-width:0;margin:0}
.map-pv-f{font-family:var(--qa-font-family-mono);font-size:11.5px;color:var(--qa-color-text);display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:0}
button.map-pv-f{color:var(--qa-color-primary-2)}
.map-pv-t small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.map-scards .tbl td{white-space:normal}
.map-scards .tbl,.map-rel-t{min-width:0}
.map-item-c .pill{font-size:10.5px;padding:2px 7px}
.map-right .card-h .btn.icon-only{width:26px;height:26px;min-height:26px;padding:0}
.map-right .card-h h2{font-size:14px}
.map-pv-t small{font-size:10.5px}
.map-scards .tbl th{white-space:normal}
.map-explorer{grid-template-columns:minmax(210px,18fr) minmax(0,59fr) minmax(250px,23fr)}
.map-explorer.collapsed{grid-template-columns:minmax(210px,18fr) minmax(0,80fr) 44px}

@media (max-width:1400px){.map-explorer,.map-explorer.collapsed{grid-template-columns:minmax(210px,1fr) minmax(0,3fr)}.map-explorer>.map-right{grid-column:1 / -1;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.map-explorer.collapsed .map-rail{grid-column:1 / -1;writing-mode:horizontal-tb;min-height:0}.map-kpis{grid-template-columns:repeat(6,minmax(0,1fr))}.map-kpi{padding:10px;gap:8px}.map-kpi b{font-size:19px}.map-tabs button{padding:0 8px;font-size:13px;gap:6px}}
@media (max-width:1100px){.map-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:860px){.map-explorer,.map-explorer.collapsed{grid-template-columns:1fr}.map-explorer>.map-right{display:flex}.map-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:1600px){.map-tabs button{padding:0 8px;font-size:13px;gap:6px}.map-tabs{gap:2px}}
`;
