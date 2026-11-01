import type {
  AccessMe,
  Capabilities,
  Environment,
  EnvironmentCheck,
  ExecutionDetail,
  ExecutionRecord,
  ExplorationEvent,
  ExplorationSnapshot,
  GraphView,
  OverviewView,
  ProjectDetail,
  ProjectSummary,
  RecordingSnapshot,
  RunComparisonView,
  ScenarioHistoryView,
} from '../core/contracts.js';
import { isTerminal } from '../core/lifecycle.js';
import type { DashboardStrings } from './dashboard-i18n.js';
import { environmentsView, explorationsView, historyView, scenariosView } from './dashboard-ops.js';
import { accessView, can, signInView, type AccessUi } from './dashboard-access.js';
import { recordingsView, type RecordingsUi } from './dashboard-recordings.js';
import { reviewView, type ReviewTab, type ReviewUi } from './dashboard-review.js';
import { libraryView, runnableScenarios, type LibraryUi } from './dashboard-library.js';
import { testsView, type TestsUi } from './dashboard-tests.js';
import { editorView, type EditorUi } from './dashboard-editor.js';
import {
  emptyIncidentsUi,
  incidentIcon,
  incidentsView,
  incidentView,
  investigationsView,
  type IncidentTab,
  type IncidentsUi,
} from './dashboard-incidents.js';
import {
  importView,
  indicatorsView,
  requirementsView,
  sourcesView,
  traceabilityView,
  trendsView,
  type RequirementsUi,
} from './dashboard-requirements.js';
import {
  checkLines,
  executionTable,
  formatDate,
  header,
  icon,
  pill,
  readiness,
  readinessPill,
  visibleBrowserControl,
} from './dashboard-parts.js';
import { enginePhase } from './engine-phases.js';
import { esc } from './view.js';

export { formatDate, pill, readiness } from './dashboard-parts.js';

/**
 * LE RENDU DU DASHBOARD : des fonctions pures, de l'état vers le HTML (échappé). Tout chiffre vient
 * du SDK tel quel ; un taux dit son numérateur, son dénominateur et son périmètre ; une valeur saisie
 * ou un secret n'apparaît jamais (le SDK ne les renvoie pas, et rien n'est reconstitué ici).
 */
export const PROJECT_TABS = ['launch', 'environments', 'scenarios', 'executions', 'security'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type DashboardRoute =
  | { view: 'overview' }
  | { view: 'projects' }
  | { view: 'project'; projectId: string; tab?: ProjectTab }
  | { view: 'executions'; projectId: string }
  | { view: 'execution'; projectId: string; run: string; explorationId?: string }
  | { view: 'history'; projectId: string }
  | { view: 'scenarios'; projectId: string; scenario?: string }
  | { view: 'recordings'; projectId: string }
  /** La bibliothèque de scénarios : des blocs réutilisables. */
  | { view: 'library'; projectId: string }
  /** Les tests générés d'un enregistrement : génération et exécution réelle. */
  | { view: 'tests'; projectId: string; recording?: string }
  /** L'éditeur des tests générés d'un enregistrement (un fichier ouvert, une comparaison). */
  | { view: 'editor'; projectId: string; recording?: string; file?: string; compare?: boolean }
  /** La revue d'un enregistrement écrit (ce que fait la fenêtre du recorder après l'arrêt). */
  | { view: 'recording'; projectId: string; name: string; tab?: ReviewTab }
  /** `environmentId: 'new'` : la création d'un environnement. */
  | { view: 'environments'; projectId: string; environmentId?: string }
  | { view: 'explorations'; projectId: string; run?: string }
  /** Les incidents d'un projet ; `create` : le formulaire de déclaration ouvert. */
  | { view: 'incidents'; projectId: string; create?: boolean }
  /** Les investigations d'un projet : les incidents qui ne sont plus des brouillons, avec leur progression. */
  | { view: 'investigations'; projectId: string }
  /** L'espace d'investigation d'un incident, par onglet (vue d'ensemble par défaut) ; `demo` : la démonstration. */
  | { view: 'incident'; projectId: string; incidentId: string; tab?: IncidentTab }
  | { view: 'sources'; projectId: string }
  | { view: 'import'; projectId: string; batchId: string }
  | { view: 'requirements'; projectId: string; entityId?: string }
  | { view: 'traceability'; projectId: string; entityId?: string }
  | { view: 'indicators'; projectId: string }
  /** Sans projet : tous les projets actifs. */
  | { view: 'trends'; projectId?: string }
  | { view: 'access' };

/** Le formulaire d'un environnement, tel que saisi (converti en EnvironmentInput à l'envoi). */
export interface EnvironmentForm {
  id?: string;
  name: string;
  kind: string;
  baseUrl: string;
  domains: string;
  writes: boolean;
  maxPerRun: string;
  secrets: string;
  variables: string;
  maxStates: string;
  maxActions: string;
  maxDurationMinutes: string;
  actionTimeoutMs: string;
}

export interface LiveStep {
  flow: string;
  index: number;
  label: string;
  status: string;
  durationMs: number;
  reason?: string;
}

export interface LaunchState {
  kind: 'REPLAY' | 'EXPLORATION';
  environmentId: string;
  scenarios: string[];
  /** Dans un navigateur visible (sur la machine du serveur), ralenti. */
  headed?: boolean;
  slowMoMs?: number;
  busy: boolean;
  error?: string;
}

export interface DashboardState {
  t: DashboardStrings;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  route: DashboardRoute;
  days: number;
  overview?: OverviewView;
  projects?: ProjectSummary[];
  showArchived: boolean;
  /** Les projets actifs du sélecteur du menu. */
  catalog?: ProjectSummary[];
  /** Le projet choisi dans le menu ('' : tous les projets). */
  projectId: string;
  /** Le menu replié (écran étroit) est-il ouvert ? */
  menuOpen: boolean;
  capabilities?: Capabilities;
  project?: ProjectDetail;
  executions?: ExecutionRecord[];
  launch: LaunchState;
  /** Les vérifications d'environnement du projet affiché, par identifiant. */
  checks: Record<string, EnvironmentCheck>;
  /** L'environnement dont la vérification (avec l'URL) est en cours. */
  checking?: string;
  /** Une action à confirmer dans la page (jamais une boîte de dialogue du navigateur). */
  confirm?: 'archive' | 'cancel' | 'remove-env' | 'publish-partial' | `revoke:${string}`;
  /** Historique : les deux exécutions cochées (la plus ancienne d'abord) et leur comparaison. */
  picked: string[];
  comparison?: RunComparisonView;
  comparing?: boolean;
  /** Scénarios : leur stabilité et les enregistrements du projet. */
  scenarioHistory?: ScenarioHistoryView[];
  recordings?: RecordingSnapshot[];
  promoting?: string;
  /** Environnements : le formulaire ouvert, sa vérification, l'enregistrement en cours. */
  envForm?: EnvironmentForm;
  envCheck?: EnvironmentCheck;
  envBusy?: boolean;
  envError?: string;
  /** Explorations : le détail et la carte de l'exploration ouverte, la gravité affichée. */
  explored?: ExecutionDetail;
  graph?: GraphView;
  severity: string;
  /** Exigences : connecteurs, imports, lot ouvert, référentiel, matrice, indicateurs, tendances. */
  req: RequirementsUi;
  /** Qui est connecté et ses droits (`access.me`) ; absent : le serveur ne le dit pas. */
  me?: AccessMe;
  /** La page demande un jeton nominatif (mode `named`). */
  signIn: boolean;
  access: AccessUi;
  /** Enregistrements : le formulaire et la session suivie en direct. */
  recs: RecordingsUi;
  /** L'adresse du Flow Studio (même serveur que l'API). */
  studioUrl?: string;
  /** La revue de l'enregistrement ouvert. */
  review?: ReviewUi;
  /** La bibliothèque de scénarios (blocs, ajout, composition, insertion). */
  lib: LibraryUi;
  /** Les tests générés : l'enregistrement affiché, sa génération, ses exécutions. */
  tst: TestsUi;
  /** L'éditeur des tests générés : fichiers ouverts, brouillons, vues, diagnostics. */
  ed: EditorUi;
  /** Les incidents : la liste, la déclaration, l'incident ouvert (absent : rien de chargé). */
  inc?: IncidentsUi;
  /** L'exécution suivie en direct (son instantané, ses étapes, la dernière phase annoncée). */
  live?: { snapshot: ExplorationSnapshot; steps: LiveStep[]; phase?: string; cancelRequested: boolean };
  execution?: ExecutionDetail;
  /** `capabilities.cancellation` du serveur. */
  cancellation: boolean;
  notice?: string;
}

export const PERIODS = [1, 7, 30] as const;

// ── La coquille : menu par sections, sélecteur de projet, menu repliable sur écran étroit ───────────

export type NavView = keyof DashboardStrings['nav'];
type NavSection = keyof DashboardStrings['sections'];

/** Les entrées du menu : seulement les écrans que le Dashboard sait afficher. */
const NAV: { section: NavSection; items: NavView[] }[] = [
  {
    section: 'pilot',
    items: [
      'overview',
      'projects',
      'executions',
      'history',
      'scenarios',
      'library',
      'recordings',
      'tests',
      'editor',
      'explorations',
    ],
  },
  { section: 'incidents', items: ['incidents', 'investigations'] },
  { section: 'requirements', items: ['requirements', 'traceability', 'sources'] },
  { section: 'measure', items: ['indicators', 'trends'] },
  { section: 'admin', items: ['environments', 'access'] },
];

/** L'entrée du menu qui correspond à la vue affichée. */
export function activeNav(route: DashboardRoute): NavView {
  if (route.view === 'project' || route.view === 'projects') return 'projects';
  if (route.view === 'execution' || route.view === 'executions') return 'executions';
  if (route.view === 'history' || route.view === 'scenarios' || route.view === 'environments')
    return route.view;
  if (route.view === 'explorations') return 'explorations';
  if (route.view === 'sources' || route.view === 'import') return 'sources';
  if (route.view === 'access') return 'access';
  if (route.view === 'recordings' || route.view === 'recording') return 'recordings';
  if (route.view === 'library') return 'library';
  if (route.view === 'tests') return 'tests';
  if (route.view === 'editor') return 'editor';
  if (route.view === 'incidents' || route.view === 'incident') return 'incidents';
  if (route.view === 'investigations') return 'investigations';
  if (
    route.view === 'requirements' ||
    route.view === 'traceability' ||
    route.view === 'indicators' ||
    route.view === 'trends'
  )
    return route.view;
  return 'overview';
}

export function renderDashboard(state: DashboardState): string {
  const t = state.t;
  const active = activeNav(state.route);
  const sections = NAV.map(
    ({ section, items }) =>
      `<div class="sec"><div class="sec-t">${esc(t.sections[section])}</div>${items
        .map(
          (view) =>
            `<a href="#" data-action="nav" data-view="${view}" ${active === view ? 'aria-current="page"' : ''}>${view === 'incidents' ? incidentIcon() : view === 'investigations' ? icon('search') : icon(view)}<span>${esc(t.nav[view])}</span>${view === 'requirements' && state.req.repository && state.req.repository.pending > 0 ? `<span class="badge" aria-label="${esc(t.req.repoSub(state.req.repository.entities.length, state.req.repository.pending))}">${String(state.req.repository.pending)}</span>` : ''}</a>`,
        )
        .join('')}</div>`,
  ).join('');
  const catalog = state.catalog ?? [];
  const context = `<label class="ctx"><span>${esc(t.projectContext)}</span><select data-action="project-context"><option value="">${esc(t.allProjects)}</option>${catalog
    .map(
      (project) =>
        `<option value="${esc(project.id)}" ${project.id === state.projectId ? 'selected' : ''}>${esc(project.name)}</option>`,
    )
    .join('')}</select></label>`;
  const caps = state.capabilities;
  const me = state.me;
  const who =
    me && me.kind === 'MEMBER'
      ? `<span class="who">${esc(t.access.signedAs(me.name, t.access.roles[me.projectRole ?? me.role] ?? me.role))}</span>${state.signIn ? `<button class="lnk out" data-action="sign-out">${esc(t.access.signOut)}</button>` : ''}`
      : '';
  const foot =
    caps || who
      ? `<div class="foot">${who}${caps ? `<span><i class="on" aria-hidden="true"></i>${esc(t.service(caps.apiVersion))}</span><span>${esc(t.engine(caps.engineVersion, caps.cancellation))}</span>` : ''}</div>`
      : '';
  return `<div class="dash" data-menu="${state.menuOpen ? 'open' : 'closed'}">
<nav class="side" aria-label="${esc(t.tag)}">
<div class="top"><div class="brand"><span class="logo" aria-hidden="true">Q</span><span><b>${esc(t.product)}</b><small>${esc(t.tag)}</small></span></div><button class="menu-btn" data-action="menu" aria-expanded="${state.menuOpen ? 'true' : 'false'}" aria-controls="qa-drawer">${icon(state.menuOpen ? 'close' : 'menu')}<span>${esc(state.menuOpen ? t.menuClose : t.menu)}</span></button></div>
<div class="drawer" id="qa-drawer">${context}${sections}${foot}</div>
</nav>
<main class="main">${state.notice ? `<p class="notice" role="status">${esc(state.notice)}</p>` : ''}${body(state)}</main>
</div>`;
}

function body(state: DashboardState): string {
  const t = state.t;
  if (state.phase === 'idle')
    return state.signIn
      ? signInView(state)
      : `<section class="msg"><p class="mu">${esc(t.noToken)}</p></section>`;
  if (state.phase === 'loading')
    return `<section class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  if (state.phase === 'error')
    return `<section class="msg" role="alert"><p class="err"><b>${esc(t.serverDown)}</b></p>${state.error ? `<p class="mu">${esc(state.error)}</p>` : ''}<button class="btn" data-action="retry">${esc(t.retry)}</button></section>`;
  switch (state.route.view) {
    case 'overview':
      return overviewView(state);
    case 'projects':
      return projectsView(state);
    case 'project':
      return projectView(state);
    case 'executions':
      return executionsView(state);
    case 'execution':
      return executionView(state);
    case 'history':
      return historyView(state);
    case 'scenarios':
      return scenariosView(state);
    case 'environments':
      return environmentsView(state);
    case 'explorations':
      return explorationsView(state);
    case 'sources':
      return sourcesView(state);
    case 'import':
      return importView(state);
    case 'requirements':
      return requirementsView(state);
    case 'traceability':
      return traceabilityView(state);
    case 'indicators':
      return indicatorsView(state);
    case 'trends':
      return trendsView(state);
    case 'access':
      return accessView(state);
    case 'recordings':
      return recordingsView(state);
    case 'recording':
      return reviewView(state);
    case 'library':
      return libraryView(state);
    case 'tests':
      return testsView(state);
    case 'editor':
      return editorView(state);
    case 'incidents':
      return incidentsView(state, state.inc ?? emptyIncidentsUi());
    case 'investigations':
      return investigationsView(state, state.inc ?? emptyIncidentsUi());
    case 'incident':
      return incidentView(state, state.inc ?? emptyIncidentsUi());
  }
}

// ── Vue d'ensemble ──────────────────────────────────────────────────────────────────────────────

function overviewView(state: DashboardState): string {
  const t = state.t;
  const o = state.overview;
  const actions = `<label class="pick">${esc(t.period)} <select data-action="period">${PERIODS.map((days) => `<option value="${String(days)}" ${days === state.days ? 'selected' : ''}>${esc(t.days(days))}</option>`).join('')}</select></label><button class="btn icon-only" data-action="refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>${can(state, 'RUN') ? `<button class="btn primary" data-action="launch-shortcut">${icon('play')}<span>${esc(t.launchReplay)}</span></button>` : ''}`;
  if (!o) return header(esc(t.nav.overview), { actions });
  const rate =
    o.replays.passRate === undefined
      ? `<b class="big">—</b><small>${esc(t.kpi.passRateNone)}</small>`
      : `<b class="big">${String(Math.round(o.replays.passRate * 100))} %</b><small>${esc(t.kpi.passRateFraction(o.replays.passed, o.replays.finished))}</small>`;
  const kpis = `<section class="kpis" aria-label="${esc(t.nav.overview)}">
<article class="kpi accent"><span>${esc(t.kpi.passRate)}</span>${rate}${scopeOf(t, o.replays.definition)}</article>
<article class="kpi"><span>${esc(t.kpi.executions)}</span><b class="big">${String(o.executions.total)}</b><small>${esc(t.kpi.executionsSub(o.executions.byKind.REPLAY, o.executions.byKind.EXPLORATION))}</small></article>
<article class="kpi"><span>${esc(t.kpi.issues)}</span><b class="big">${String(o.issues.CRITICAL + o.issues.ERROR + o.issues.WARNING + o.issues.INFO)}</b><small>${esc(t.kpi.issuesSub(o.issues.CRITICAL, o.issues.ERROR))}</small></article>
<article class="kpi"><span>${esc(t.kpi.projects)}</span><b class="big">${String(o.projects.active)}</b><small>${esc(t.kpi.projectsSub(o.projects.archived))} · ${esc(t.kpi.scenariosSub(o.recordings))}</small><small>${esc(t.kpi.scenarios)} : ${String(o.scenarios)}</small></article>
</section>`;
  const max = Math.max(1, ...o.trend.map((day) => day.passed + day.failed));
  const trend = `<section class="card"><div class="card-h"><h2>${esc(t.trend)}</h2><p class="legend"><i class="p"></i>${esc(t.trendLegend.passed)} <i class="f"></i>${esc(t.trendLegend.failed)}</p></div><div class="bars">${o.trend
    .map((day) => {
      const label = `${day.day} : ${String(day.passed)} ${t.trendLegend.passed}, ${String(day.failed)} ${t.trendLegend.failed}`;
      return `<div class="bar" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="p" style="height:${String(Math.round((day.passed / max) * 100))}%"></span><span class="f" style="height:${String(Math.round((day.failed / max) * 100))}%"></span><small>${esc(day.day.slice(8))}/${esc(day.day.slice(5, 7))}</small></div>`;
    })
    .join('')}</div></section>`;
  const alerts = `<section class="card"><h2>${esc(t.alerts)}</h2>${
    o.alerts.length === 0
      ? `<p class="mu">${esc(t.noAlert)}</p>`
      : `<ul class="alerts">${o.alerts
          .map(
            (alert) =>
              `<li class="${alert.kind === 'SECRET_MISSING' ? 'warn' : 'ko'}"><span class="tag">${esc(t.alertKinds[alert.kind] ?? alert.kind)}</span><span class="txt"><strong>${esc(alert.projectName)}</strong> · ${esc(alert.message)}</span>${alert.projectId && alert.run ? `<button class="lnk" data-action="open-run" data-project="${esc(alert.projectId)}" data-run="${esc(alert.run)}">${esc(t.col.run)}</button>` : ''}</li>`,
          )
          .join('')}</ul>`
  }</section>`;
  const recent = `<section class="card wide"><h2>${esc(t.recent)}</h2>${
    o.recent.length === 0
      ? `<p class="mu">${esc(t.noExecution)}</p>`
      : executionTable(state.t, o.recent, true)
  }</section>`;
  return `${header(esc(t.nav.overview), { sub: esc(t.overviewSub(formatDate(o.generatedAt, t.locale))), actions })}${kpis}<div class="grid">${trend}${alerts}</div>${recent}`;
}

// ── Projets ─────────────────────────────────────────────────────────────────────────────────────

function projectsView(state: DashboardState): string {
  const t = state.t;
  const toggle = `<label class="chk"><input type="checkbox" data-action="archived" ${state.showArchived ? 'checked' : ''}> ${esc(t.showArchived)}</label>`;
  const projects = state.projects ?? [];
  const list =
    projects.length === 0
      ? `<section class="card"><p class="mu">${esc(t.noProject)}</p></section>`
      : `<ul class="cards">${projects
          .map(
            (project) =>
              `<li><button class="pcard" data-action="open-project" data-project="${esc(project.id)}"><span class="pt"><b>${esc(project.name)}</b>${pill(project.state, t.states[project.state] ?? project.state)}</span><span class="mu url">${esc(project.targetUrl)}</span><span class="mu">${esc(t.counts(project.counts.environments, project.counts.scenarios, project.counts.executions))}</span><span class="last">${esc(t.lastRun)} : ${project.lastExecution ? `${pill(project.lastExecution.verdict, t.verdicts[project.lastExecution.verdict] ?? project.lastExecution.verdict)} <span class="mu">${esc(formatDate(project.lastExecution.createdAt, t.locale))}</span>` : `<span class="mu">${esc(t.never)}</span>`}</span></button></li>`,
          )
          .join('')}</ul>`;
  return `${header(esc(t.projects), { actions: toggle })}${list}`;
}

function environmentCard(state: DashboardState, environment: Environment, archived: boolean): string {
  const t = state.t;
  const check = state.checks[environment.id];
  const writes = environment.mutations?.enabled
    ? `${t.col.writes.toLowerCase()} ${t.writesAllowed(environment.mutations.maxPerRun)}`
    : t.readOnly;
  return `<article class="env"><div class="env-h"><b>${esc(environment.name)}</b>${readinessPill(t, check)}</div><span class="mu">${esc(t.envKinds[environment.kind] ?? environment.kind)} · ${esc(writes)}</span><code class="url">${esc(environment.baseUrl)}</code>${checkLines(t, check)}${archived ? '' : `<button class="btn small" data-action="check-env" data-env="${esc(environment.id)}" ${state.checking === environment.id ? 'disabled' : ''}>${esc(state.checking === environment.id ? t.checking : t.checkEnvironment)}</button>`}</article>`;
}

function projectView(state: DashboardState): string {
  const t = state.t;
  const p = state.project;
  if (!p) return header(esc(t.projects), { back: ['projects', t.allProjectsBack] });
  const route = state.route as Extract<DashboardRoute, { view: 'project' }>;
  const tab = route.tab ?? 'launch';
  const archived = p.state === 'ARCHIVED';
  const actions = !can(state, 'MANAGE_PROJECTS')
    ? ''
    : archived
      ? `<button class="btn" data-action="restore">${esc(t.restore)}</button>`
      : state.confirm === 'archive'
        ? `<span class="confirm" role="group"><small>${esc(t.archiveHint)}</small><button class="btn danger" data-action="archive-confirm">${esc(t.archiveConfirm)}</button><button class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
        : `<button class="btn" data-action="archive">${esc(t.archive)}</button>`;
  const title = `${esc(p.name)} ${pill(p.state, t.states[p.state] ?? p.state)}`;
  const sub = `${esc(p.framework)} · <code>${esc(p.targetUrl)}</code>`;
  const executions = state.executions ?? [];
  const labels: Record<ProjectTab, string> = {
    launch: t.tabs.launch,
    environments: t.tabs.environments(p.environments.length),
    scenarios: t.tabs.scenarios(p.scenarios.length),
    executions: t.tabs.executions(executions.length),
    security: t.tabs.security,
  };
  const tabs = `<div class="tabs" role="tablist" aria-label="${esc(p.name)}">${PROJECT_TABS.map(
    (name) =>
      `<button role="tab" data-action="tab" data-tab="${name}" aria-selected="${name === tab ? 'true' : 'false'}">${esc(labels[name])}</button>`,
  ).join('')}</div>`;
  const content =
    tab === 'launch'
      ? launchTab(state, p, archived)
      : tab === 'environments'
        ? environmentsTab(state, p, archived)
        : tab === 'scenarios'
          ? scenariosTab(state, p)
          : tab === 'executions'
            ? `<section class="card wide">${executions.length === 0 ? `<p class="mu">${esc(t.noExecutionYet)}</p>` : executionTable(state.t, executions, false)}</section>`
            : securityTab(state, p);
  return `${header(title, { sub, actions, back: ['projects', t.allProjectsBack] })}${archived ? `<p class="note">${esc(t.archivedNote)}</p>` : ''}${tabs}<div role="tabpanel">${content}</div>`;
}

function launchTab(state: DashboardState, p: ProjectDetail, archived: boolean): string {
  const t = state.t;
  if (archived) return `<section class="card"><p class="mu">${esc(t.archivedNote)}</p></section>`;
  if (!can(state, 'RUN'))
    return `<section class="card"><p class="mu">${esc(t.access.noRunRight)}</p></section>`;
  const launch = state.launch;
  const replay = launch.kind === 'REPLAY';
  const environment = p.environments.find((candidate) => candidate.id === launch.environmentId);
  const kind = (value: LaunchState['kind'], label: string, hint: string): string =>
    `<label class="choice ${launch.kind === value ? 'on' : ''}"><input type="radio" name="kind" data-bind="kind" value="${value}" ${launch.kind === value ? 'checked' : ''}><span><b>${esc(label)}</b><small>${esc(hint)}</small></span></label>`;
  const note = !replay
    ? t.explorationTarget
    : environment?.mutations?.enabled
      ? t.writesNote(environment.mutations.maxPerRun)
      : t.readOnlyNote;
  const scenarios = runnableScenarios(p.scenarios)
    .map(
      (scenario) =>
        `<label class="row-chk"><input type="checkbox" data-bind="scenario" value="${esc(scenario.name)}" ${launch.scenarios.includes(scenario.name) ? 'checked' : ''} ${replay ? '' : 'disabled'}><span class="nm">${esc(scenario.name)}</span><small class="mu">${scenario.steps === undefined ? esc(scenario.format) : `${String(scenario.steps)} ${esc(t.col.steps.toLowerCase())}`}</small></label>`,
    )
    .join('');
  const form = `<form class="launch card" data-action="launch"><h2>${esc(t.launch)}</h2>
<fieldset class="kinds"><legend>${esc(t.launchKind)}</legend>${kind('REPLAY', t.kindReplay, t.kindReplayHint)}${kind('EXPLORATION', t.kindExploration, t.kindExplorationHint)}</fieldset>
<label class="field">${esc(t.launchEnv)}<select data-bind="environment" ${replay ? '' : 'disabled'}><option value="">${esc(t.projectTarget)}</option>${p.environments.map((env) => `<option value="${esc(env.id)}" ${launch.environmentId === env.id ? 'selected' : ''}>${esc(env.name)} · ${esc(readiness(state.checks[env.id]) === 'NOT_READY' ? t.readiness.notReady : (t.envKinds[env.kind] ?? env.kind))}</option>`).join('')}</select></label>
<div class="field vb-field">${visibleBrowserControl(t.visibleBrowser, { headed: launch.headed === true, slowMoMs: launch.slowMoMs ?? 0 }, { attr: 'data-bind', available: state.capabilities?.visibleBrowser === true })}</div>
<fieldset class="scen"><legend>${esc(t.launchScenarios)}</legend>${scenarios || `<p class="mu">${esc(t.noScenario)}</p>`}${replay && runnableScenarios(p.scenarios).length > 0 ? `<small class="mu">${esc(t.allScenarios)}</small>` : ''}</fieldset>
<p class="note">${icon('alert')}<span>${esc(note)}</span></p>${replay && environment?.mutations?.enabled && !can(state, 'RUN_WRITES') ? `<p class="note warn">${icon('alert')}<span>${esc(t.access.noWritesRight)}</span></p>` : ''}
<div class="form-acts">${replay && environment ? `<button type="button" class="btn" data-action="check-env" data-env="${esc(environment.id)}" ${state.checking === environment.id ? 'disabled' : ''}>${esc(state.checking === environment.id ? t.checking : t.checkEnvironment)}</button>` : ''}<button class="btn primary" type="submit" ${launch.busy || (replay && runnableScenarios(p.scenarios).length === 0) ? 'disabled' : ''}>${icon('play')}<span>${esc(launch.busy ? t.launching : replay ? t.launchButton : t.launchExploration)}</span></button></div>
${launch.error ? `<p class="err" role="alert">${esc(launch.error)}</p>` : ''}</form>`;
  const environments = `<section class="card"><h2>${esc(t.environments)}</h2>${
    p.environments.length === 0
      ? `<p class="mu">${esc(t.noEnvironment)}</p>`
      : p.environments.map((env) => environmentCard(state, env, archived)).join('')
  }</section>`;
  return `<div class="split">${form}<div class="col">${environments}</div></div>`;
}

function environmentsTab(state: DashboardState, p: ProjectDetail, archived: boolean): string {
  const t = state.t;
  if (p.environments.length === 0)
    return `<section class="card"><p class="mu">${esc(t.noEnvironment)}</p></section>`;
  return `<div class="env-grid">${p.environments.map((env) => environmentCard(state, env, archived)).join('')}</div>
<section class="card wide"><div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(t.col.name)}</th><th scope="col">${esc(t.col.kind)}</th><th scope="col">${esc(t.col.base)}</th><th scope="col">${esc(t.col.writes)}</th><th scope="col">${esc(t.col.secrets)}</th></tr></thead><tbody>${p.environments
    .map(
      (environment) =>
        `<tr><td><b>${esc(environment.name)}</b></td><td>${esc(t.envKinds[environment.kind] ?? environment.kind)}</td><td><code>${esc(environment.baseUrl)}</code></td><td>${esc(environment.mutations?.enabled ? t.writesAllowed(environment.mutations.maxPerRun) : t.writesNone)}</td><td>${(environment.secretEnv ?? []).map((name) => `<code>${esc(name)}</code>`).join(' ') || '—'}</td></tr>`,
    )
    .join('')}</tbody></table></div></section>`;
}

function scenariosTab(state: DashboardState, p: ProjectDetail): string {
  const t = state.t;
  if (p.scenarios.length === 0)
    return `<section class="card"><p class="mu">${esc(t.noScenario)}</p></section>`;
  return `<section class="card wide"><div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(t.col.name)}</th><th scope="col">${esc(t.col.steps)}</th><th scope="col">${esc(t.col.file)}</th></tr></thead><tbody>${p.scenarios
    .map(
      (scenario) =>
        `<tr><td><b class="mono">${esc(scenario.name)}</b>${scenario.reusable ? ` <span class="pill mu">${esc(t.nav.library)}</span>` : ''}${scenario.fromRecording ? `<small class="mu block">${esc(t.fromRecording(scenario.fromRecording))}</small>` : ''}</td><td>${scenario.steps === undefined ? '—' : String(scenario.steps)}</td><td><code>${esc(scenario.file)}</code> <small class="mu">${esc(scenario.format)}</small></td></tr>`,
    )
    .join('')}</tbody></table></div></section>`;
}

function securityTab(state: DashboardState, p: ProjectDetail): string {
  const t = state.t;
  const blocked = state.capabilities?.safety?.blocked ?? [];
  const blockedText = blocked.map((risk) => t.security.risks[risk] ?? risk).join(', ') || '—';
  const ignored = p.draft.exploration.ignoredPaths;
  const card = (name: string, domains: string, writes: string): string =>
    `<section class="card"><h2>${esc(t.security.title(name))}</h2><div class="policy">
<div><b>${esc(t.security.allowed)}</b><span>${esc(t.security.allowedValue)}</span></div>
<div><b>${esc(t.security.withAgreement)}</b><span>${esc(writes)}</span></div>
<div><b>${esc(t.security.blocked)}</b><span>${esc(blockedText)}</span></div>
<div><b>${esc(t.security.domains)}</b><span class="mono">${esc(domains)}</span></div>
<div><b>${esc(t.security.ignored)}</b><span class="mono">${esc(ignored.join(', ') || '—')}</span></div>
</div></section>`;
  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const cards =
    p.environments.length === 0
      ? [
          card(
            t.security.projectTarget,
            (p.draft.exploration.allowedHosts.length > 0
              ? p.draft.exploration.allowedHosts
              : [hostOf(p.targetUrl)]
            ).join(', '),
            t.security.noWrites,
          ),
        ]
      : p.environments.map((environment) =>
          card(
            environment.name,
            ((environment.allowedDomains ?? []).length > 0
              ? (environment.allowedDomains ?? [])
              : [hostOf(environment.baseUrl)]
            ).join(', '),
            environment.mutations?.enabled
              ? t.security.writes(environment.mutations.maxPerRun)
              : t.security.noWrites,
          ),
        );
  return `<div class="grid">${cards.join('')}</div>`;
}

// ── Exécutions du projet ────────────────────────────────────────────────────────────────────────

function executionsView(state: DashboardState): string {
  const t = state.t;
  const p = state.project;
  if (!p)
    return `${header(esc(t.nav.executions))}<section class="msg"><p class="mu">${esc(t.pickProject)}</p></section>`;
  const executions = state.executions ?? [];
  const actions = `<button class="btn icon-only" data-action="refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>${p.state === 'ARCHIVED' || !can(state, 'RUN') ? '' : `<button class="btn primary" data-action="launch-shortcut">${icon('play')}<span>${esc(t.launchReplay)}</span></button>`}`;
  return `${header(esc(t.nav.executions), { sub: esc(p.name), actions })}<section class="card wide">${executions.length === 0 ? `<p class="mu">${esc(t.noExecutionYet)}</p>` : executionTable(state.t, executions, false)}</section>`;
}

// ── Exécution ───────────────────────────────────────────────────────────────────────────────────

/** Les étapes vues en direct : la dernière version de chaque étape, flow par flow. */
export function liveSteps(steps: LiveStep[], event: ExplorationEvent): LiveStep[] {
  if (event.type !== 'flow-step') return steps;
  const next = steps.filter((step) => !(step.flow === event.flow && step.index === event.index));
  next.push({
    flow: event.flow,
    index: event.index,
    label: event.label,
    status: event.status,
    durationMs: event.durationMs,
    ...(event.reason ? { reason: event.reason } : {}),
  });
  return next;
}

function elapsedOf(snapshot: ExplorationSnapshot): number {
  const start = Date.parse(snapshot.startedAt ?? snapshot.queuedAt);
  const now = Date.parse(snapshot.serverTime);
  return Number.isNaN(start) || Number.isNaN(now) ? 0 : now - start;
}

function executionView(state: DashboardState): string {
  const t = state.t;
  const route = state.route as Extract<DashboardRoute, { view: 'execution' }>;
  const back: [string, string] = ['project', state.project?.name ?? t.back];
  const live = state.live;
  const running = live !== undefined && !isTerminal(live.snapshot.status);
  if (running) {
    const status = live.snapshot.status;
    const cancel = !state.cancellation
      ? `<small class="mu">${esc(t.cancelNotOffered)}</small>`
      : live.cancelRequested
        ? `<small class="mu" role="status">${esc(t.cancelRequested)}</small>`
        : state.confirm === 'cancel'
          ? `<span class="confirm" role="group"><small>${esc(t.cancelHint)}</small><button class="btn danger" data-action="cancel-confirm">${esc(t.cancelConfirm)}</button><button class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
          : can(state, 'RUN')
            ? `<button class="btn danger" data-action="cancel">${icon('stop')}<span>${esc(t.cancelRun)}</span></button>`
            : '';
    const flows = [...new Set(live.steps.map((step) => step.flow))];
    const replay = live.snapshot.kind === 'REPLAY';
    const planned = replay ? state.launch.scenarios.length || state.project?.scenarios.length : undefined;
    const counters = live.snapshot.counters;
    const summary = `<section class="kpis">
<article class="kpi"><span>${esc(replay ? t.progress : t.explored)}</span><b class="mid">${esc(replay ? t.flowsSeen(flows.length, planned) : t.exploredValue(counters.states, counters.actions))}</b><small>${esc(replay ? '' : t.budget(live.snapshot.budget.maxStates, live.snapshot.budget.maxActions))}</small></article>
<article class="kpi"><span>${esc(t.phase)}</span><b class="mid">${esc(live.phase ? enginePhase(live.phase, t.locale) : (t.statuses[status] ?? status))}</b></article>
</section>`;
    return `${header(`${esc(t.execution)} <code>${esc(route.run)}</code> ${pill(status, t.running(t.elapsed(elapsedOf(live.snapshot))))}`, { actions: cancel, back })}${summary}
<section class="card wide live" aria-live="polite"><h2><span class="dot" aria-hidden="true"></span>${esc(t.live)}</h2>${flows
      .map((flow) =>
        stepList(
          t,
          flow,
          live.steps.filter((step) => step.flow === flow),
        ),
      )
      .join('')}</section>`;
  }
  const detail = state.execution;
  if (!detail)
    return `${header(`${esc(t.execution)} <code>${esc(route.run)}</code>`, { back })}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.waitingResult)}</p></section>`;
  const assertions = detail.flowsDetail.flatMap((flow) => flow.assertions);
  const verified = assertions.filter((assertion) => assertion.status === 'PASS').length;
  const failedAssertions = assertions.filter((assertion) => assertion.status === 'FAIL').length;
  const screenshots = detail.flowsDetail.reduce(
    (count, flow) => count + flow.steps.filter((step) => step.screenshot).length,
    0,
  );
  const summary = `<section class="kpis"><article class="kpi accent"><span>${esc(t.col.verdict)}</span><b class="big">${esc(t.verdicts[detail.verdict] ?? detail.verdict)}</b><small>${esc(t.verdictOf(detail.flows.passed, detail.flows.total))}</small></article><article class="kpi"><span>${esc(t.col.kind)}</span><b class="mid">${esc(t.kinds[detail.kind] ?? detail.kind)}</b><small>${esc(formatDate(detail.createdAt, t.locale))}${detail.durationMs === undefined ? '' : ` · ${esc(t.duration(detail.durationMs))}`}</small></article><article class="kpi"><span>${esc(t.col.environment)}</span><b class="mid">${esc(detail.environment?.name ?? t.projectTarget)}</b><small>${esc((detail.scenarios ?? []).join(', '))}</small></article><article class="kpi"><span>${esc(t.assertions)}</span><b class="mid">${String(assertions.length)}</b><small>${esc(t.assertionsCount(verified, failedAssertions))}</small></article></section>`;
  const flows = detail.flowsDetail
    .map(
      (flow) =>
        `<section class="card wide"><h2 class="fl">${esc(flow.name)} ${pill(flow.status, t.results[flow.status] ?? flow.status)} <small class="mu">${esc(t.duration(flow.durationMs))}</small></h2>${flow.divergence ? `<p class="err">${esc(t.divergence(flow.divergence.stepIndex, flow.divergence.reason))}</p>` : ''}<ol class="steps">${flow.steps.map((step) => `<li>${pill(step.status, t.results[step.status] ?? step.status)}<span>${String(step.index)}. ${esc(step.label)}</span><small class="mu">${esc(t.duration(step.durationMs))}</small>${step.reason ? `<small class="why">${esc(step.reason)}</small>` : ''}</li>`).join('')}</ol><h3>${esc(t.assertions)}</h3>${flow.assertions.length === 0 ? `<p class="mu">${esc(t.noAssertion)}</p>` : `<ul class="plain">${flow.assertions.map((assertion) => `<li>${pill(assertion.status, t.results[assertion.status] ?? assertion.status)} <code>${esc(assertion.id)}</code> ${esc(assertion.description)}</li>`).join('')}</ul>`}${flow.testData.length > 0 ? `<p class="mu">${esc(t.testData)} : ${flow.testData.map((key) => `<code>${esc(key)}</code>`).join(' ')}</p>` : ''}</section>`,
    )
    .join('');
  const issues =
    detail.issuesList.length === 0
      ? ''
      : `<section class="card wide"><h2>${esc(t.issuesTitle)}</h2><ul class="plain">${detail.issuesList
          .map(
            (issue) =>
              `<li>${pill(issue.severity === 'CRITICAL' || issue.severity === 'ERROR' ? 'FAILED' : 'INCOMPLETE', t.severities[issue.severity] ?? issue.severity)} ${esc(issue.message)} <small class="mu">${esc(issue.pageUrl)}</small></li>`,
          )
          .join('')}</ul></section>`;
  const side = `<section class="card"><h2>${esc(t.evidence)}</h2><p>${esc(t.evidenceCount(screenshots, detail.issues))}</p><p class="mu">${esc(t.evidenceNote)}</p></section><section class="card"><h2>${esc(t.afterRun)}</h2>${detail.reports.html ? `<button class="btn" data-action="report">${esc(t.openReport)}</button>` : '<p class="mu">—</p>'}</section>`;
  return `${header(`${esc(t.execution)} <code>${esc(detail.run)}</code>`, { actions: detail.reports.html ? `<button class="btn" data-action="report">${esc(t.openReport)}</button>` : '', back })}${summary}<div class="split"><div class="col">${flows}${issues}</div><div class="col narrow">${side}</div></div>`;
}

function stepList(t: DashboardStrings, flow: string, steps: LiveStep[]): string {
  return `<h3>${esc(flow)}</h3><ol class="steps">${steps
    .sort((a, b) => a.index - b.index)
    .map(
      (step) =>
        `<li>${pill(step.status, t.results[step.status] ?? step.status)}<span>${String(step.index)}. ${esc(step.label)}</span><small class="mu">${esc(t.duration(step.durationMs))}</small>${step.reason ? `<small class="why">${esc(step.reason)}</small>` : ''}</li>`,
    )
    .join('')}</ol>`;
}

/** La définition du taux : en champs quand c'est celle du serveur, telle quelle sinon. */
export const KNOWN_PASS_RATE_DEFINITION =
  'REPLAY executions finished in the period with a verdict (cancelled ones excluded); passed = every replayed flow PASSED';

function scopeOf(t: DashboardStrings, definition: string): string {
  if (definition !== KNOWN_PASS_RATE_DEFINITION)
    return `<small class="scope"><b>${esc(t.kpi.scope)} :</b> ${esc(definition)}</small>`;
  const parts = t.kpi.passRateParts;
  return `<ul class="scope">${[parts.numerator, parts.denominator, parts.exclusions].map((part) => `<li>${esc(part)}</li>`).join('')}</ul>`;
}
