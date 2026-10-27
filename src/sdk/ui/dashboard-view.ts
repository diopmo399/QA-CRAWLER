import type {
  ExecutionDetail,
  ExecutionRecord,
  ExplorationEvent,
  ExplorationSnapshot,
  OverviewView,
  ProjectDetail,
  ProjectSummary,
} from '../core/contracts.js';
import { isTerminal } from '../core/lifecycle.js';
import type { DashboardStrings } from './dashboard-i18n.js';
import { enginePhase } from './engine-phases.js';
import { esc } from './view.js';

/**
 * LE RENDU DU DASHBOARD : des fonctions pures, de l'état vers le HTML (échappé). Tout chiffre vient
 * du SDK tel quel ; un taux dit son numérateur, son dénominateur et son périmètre ; une valeur saisie
 * ou un secret n'apparaît jamais (le SDK ne les renvoie pas, et rien n'est reconstitué ici).
 */
export type DashboardRoute =
  | { view: 'overview' }
  | { view: 'projects' }
  | { view: 'project'; projectId: string }
  | { view: 'execution'; projectId: string; run: string; explorationId?: string };

export interface LiveStep {
  flow: string;
  index: number;
  label: string;
  status: string;
  durationMs: number;
  reason?: string;
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
  project?: ProjectDetail;
  executions?: ExecutionRecord[];
  launch: { environmentId: string; scenarios: string[]; busy: boolean; error?: string };
  /** Une action à confirmer dans la page (jamais une boîte de dialogue du navigateur). */
  confirm?: 'archive' | 'cancel';
  /** L'exécution suivie en direct (son instantané, ses étapes, la dernière phase annoncée). */
  live?: { snapshot: ExplorationSnapshot; steps: LiveStep[]; phase?: string; cancelRequested: boolean };
  execution?: ExecutionDetail;
  /** `capabilities.cancellation` du serveur. */
  cancellation: boolean;
  notice?: string;
}

export const PERIODS = [1, 7, 30] as const;

const TONE: Record<string, string> = {
  PASSED: 'ok',
  PASS: 'ok',
  COMPLETED: 'ok',
  ACTIVE: 'ok',
  FAILED: 'ko',
  FAIL: 'ko',
  CANCELLED: 'warn',
  INCOMPLETE: 'warn',
  BLOCKED: 'warn',
  INCONCLUSIVE: 'warn',
  RUNNING: 'live',
  QUEUED: 'mu',
  SKIPPED: 'mu',
  NO_FLOW: 'mu',
  ARCHIVED: 'mu',
};

export const pill = (raw: string, text = raw): string =>
  `<span class="pill ${TONE[raw] ?? 'mu'}">${esc(text)}</span>`;

const ICONS: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  projects: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
};

const icon = (name: string): string =>
  `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

export function formatDate(iso: string, locale: 'fr' | 'en'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

export function renderDashboard(state: DashboardState): string {
  const t = state.t;
  const active = state.route.view === 'overview' ? 'overview' : 'projects';
  const nav = (['overview', 'projects'] as const)
    .map(
      (view) =>
        `<a href="#" data-action="nav" data-view="${view}" ${active === view ? 'aria-current="page"' : ''}>${icon(view)}<span>${esc(t.nav[view])}</span></a>`,
    )
    .join('');
  return `<div class="dash">
<nav class="side" aria-label="${esc(t.tag)}"><div class="brand"><span class="logo" aria-hidden="true"><i></i></span><span><b>${esc(t.product)}</b><small>${esc(t.tag)}</small></span></div>${nav}</nav>
<main class="main">${state.notice ? `<p class="notice" role="status">${esc(state.notice)}</p>` : ''}${body(state)}</main>
</div>`;
}

function body(state: DashboardState): string {
  const t = state.t;
  if (state.phase === 'idle') return `<section class="msg"><p class="mu">${esc(t.noToken)}</p></section>`;
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
    case 'execution':
      return executionView(state);
  }
}

/** `title` est déjà échappé (il porte des pastilles). */
function header(t: DashboardStrings, title: string, extra = '', back?: string): string {
  return `<header class="hd">${back ? `<button class="btn ghost" data-action="back" data-to="${esc(back)}">${icon('back')}<span>${esc(t.back)}</span></button>` : ''}<h1>${title}</h1><span class="sp"></span><div class="acts">${extra}</div></header>`;
}

// ── Vue d'ensemble ──────────────────────────────────────────────────────────────────────────────

function overviewView(state: DashboardState): string {
  const t = state.t;
  const o = state.overview;
  const periods = `<label class="pick">${esc(t.period)} <select data-action="period">${PERIODS.map((days) => `<option value="${String(days)}" ${days === state.days ? 'selected' : ''}>${esc(t.days(days))}</option>`).join('')}</select></label><button class="btn ghost" data-action="refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>`;
  if (!o) return header(t, esc(t.nav.overview), periods);
  const rate =
    o.replays.passRate === undefined
      ? `<b class="big">—</b><small>${esc(t.kpi.passRateNone)}</small>`
      : `<b class="big">${String(Math.round(o.replays.passRate * 100))} %</b><small>${esc(t.kpi.passRateFraction(o.replays.passed, o.replays.finished))}</small>`;
  const kpis = `<section class="kpis" aria-label="${esc(t.nav.overview)}">
<article class="kpi"><span>${esc(t.kpi.projects)}</span><b class="big">${String(o.projects.active)}</b><small>${esc(t.kpi.projectsSub(o.projects.archived))}</small></article>
<article class="kpi"><span>${esc(t.kpi.scenarios)}</span><b class="big">${String(o.scenarios)}</b><small>${esc(t.kpi.scenariosSub(o.recordings))}</small></article>
<article class="kpi"><span>${esc(t.kpi.executions)}</span><b class="big">${String(o.executions.total)}</b><small>${esc(t.kpi.executionsSub(o.executions.byKind.REPLAY, o.executions.byKind.EXPLORATION))}</small></article>
<article class="kpi accent"><span>${esc(t.kpi.passRate)}</span>${rate}${scopeOf(t, o.replays.definition)}</article>
</section>`;
  const max = Math.max(1, ...o.trend.map((day) => day.passed + day.failed));
  const trend = `<section class="card"><h2>${esc(t.trend)}</h2><div class="bars">${o.trend
    .map((day) => {
      const label = `${day.day} : ${String(day.passed)} ${t.trendLegend.passed}, ${String(day.failed)} ${t.trendLegend.failed}`;
      return `<div class="bar" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="f" style="height:${String(Math.round((day.failed / max) * 100))}%"></span><span class="p" style="height:${String(Math.round((day.passed / max) * 100))}%"></span><small>${esc(day.day.slice(5))}</small></div>`;
    })
    .join(
      '',
    )}</div><p class="legend"><i class="p"></i>${esc(t.trendLegend.passed)} <i class="f"></i>${esc(t.trendLegend.failed)}</p></section>`;
  const alerts = `<section class="card"><h2>${esc(t.alerts)}</h2>${
    o.alerts.length === 0
      ? `<p class="mu">${esc(t.noAlert)}</p>`
      : `<ul class="alerts">${o.alerts
          .map(
            (alert) =>
              `<li>${icon('alert')}<span>${esc(alert.message)}</span>${alert.projectId && alert.run ? `<button class="lnk" data-action="open-run" data-project="${esc(alert.projectId)}" data-run="${esc(alert.run)}">${esc(alert.run)}</button>` : ''}</li>`,
          )
          .join('')}</ul>`
  }</section>`;
  const recent = `<section class="card wide"><h2>${esc(t.recent)}</h2>${
    o.recent.length === 0 ? `<p class="mu">${esc(t.noExecution)}</p>` : executionTable(state, o.recent, true)
  }</section>`;
  return `${header(t, esc(t.nav.overview), periods)}${kpis}<div class="grid">${trend}${alerts}</div>${recent}`;
}

function executionTable(
  state: DashboardState,
  rows: (ExecutionRecord & { projectName?: string })[],
  withProject: boolean,
): string {
  const t = state.t;
  const head = [
    ...(withProject ? [t.col.project] : []),
    t.col.kind,
    t.col.verdict,
    t.col.flows,
    t.col.environment,
    t.col.date,
  ];
  return `<div class="tw"><table class="tbl"><thead><tr>${head.map((cell) => `<th scope="col">${esc(cell)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${withProject ? `<td>${esc(row.projectName ?? row.projectId)}</td>` : ''}<td>${esc(t.kinds[row.kind] ?? row.kind)}</td><td>${pill(row.verdict, t.verdicts[row.verdict] ?? row.verdict)}</td><td>${String(row.flows.passed)}/${String(row.flows.total)}</td><td>${esc(row.environment?.name ?? '—')}</td><td><button class="lnk" data-action="open-run" data-project="${esc(row.projectId)}" data-run="${esc(row.run)}">${esc(formatDate(row.createdAt, t.locale))}</button></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
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
  return `${header(t, esc(t.projects), toggle)}${list}`;
}

function projectView(state: DashboardState): string {
  const t = state.t;
  const p = state.project;
  if (!p) return header(t, esc(t.projects), '', 'projects');
  const archived = p.state === 'ARCHIVED';
  const actions = archived
    ? `<button class="btn" data-action="restore">${esc(t.restore)}</button>`
    : state.confirm === 'archive'
      ? `<span class="confirm" role="group"><small class="mu">${esc(t.archiveHint)}</small><button class="btn danger" data-action="archive-confirm">${esc(t.archiveConfirm)}</button><button class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
      : `<button class="btn" data-action="archive">${esc(t.archive)}</button>`;
  const title = `${esc(p.name)} ${pill(p.state, t.states[p.state] ?? p.state)}`;
  const environments =
    p.environments.length === 0
      ? `<p class="mu">${esc(t.noEnvironment)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(t.col.name)}</th><th scope="col">${esc(t.col.kind)}</th><th scope="col">${esc(t.col.base)}</th><th scope="col">${esc(t.col.writes)}</th><th scope="col">${esc(t.col.secrets)}</th></tr></thead><tbody>${p.environments
          .map(
            (environment) =>
              `<tr><td><b>${esc(environment.name)}</b></td><td>${esc(environment.kind)}</td><td><code>${esc(environment.baseUrl)}</code></td><td>${esc(environment.mutations?.enabled ? t.writesAllowed(environment.mutations.maxPerRun) : t.writesNone)}</td><td>${(environment.secretEnv ?? []).map((name) => `<code>${esc(name)}</code>`).join(' ') || '—'}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  const scenarios =
    p.scenarios.length === 0
      ? `<p class="mu">${esc(t.noScenario)}</p>`
      : `<ul class="plain">${p.scenarios.map((scenario) => `<li><b>${esc(scenario.name)}</b> <span class="mu">${esc(scenario.format)}${scenario.steps === undefined ? '' : ` · ${String(scenario.steps)} ${esc(t.col.steps.toLowerCase())}`} · <code>${esc(scenario.file)}</code></span></li>`).join('')}</ul>`;
  const launch = archived
    ? `<p class="note">${esc(t.archivedNote)}</p>`
    : `<form class="launch" data-action="launch"><label class="pick">${esc(t.launchEnv)}<select data-bind="environment"><option value="">${esc(t.projectTarget)}</option>${p.environments.map((environment) => `<option value="${esc(environment.id)}" ${state.launch.environmentId === environment.id ? 'selected' : ''}>${esc(environment.name)} · ${esc(environment.kind)}</option>`).join('')}</select></label><fieldset><legend>${esc(t.launchScenarios)}</legend>${p.scenarios.map((scenario) => `<label class="chk"><input type="checkbox" data-bind="scenario" value="${esc(scenario.name)}" ${state.launch.scenarios.includes(scenario.name) ? 'checked' : ''}> ${esc(scenario.name)}</label>`).join('')}<small class="mu">${esc(t.allScenarios)}</small></fieldset><button class="btn primary" type="submit" ${state.launch.busy || p.scenarios.length === 0 ? 'disabled' : ''}>${icon('play')}<span>${esc(state.launch.busy ? t.launching : t.launchButton)}</span></button>${state.launch.error ? `<p class="err" role="alert">${esc(state.launch.error)}</p>` : ''}</form>`;
  const executions = state.executions ?? [];
  return `${header(t, title, actions, 'projects')}<p class="mu url">${esc(p.targetUrl)}</p>
<div class="grid"><section class="card"><h2>${esc(t.launch)}</h2>${launch}</section><section class="card"><h2>${esc(t.scenarios)}</h2>${scenarios}</section></div>
<section class="card wide"><h2>${esc(t.environments)}</h2>${environments}</section>
<section class="card wide"><h2>${esc(t.executions)}</h2>${executions.length === 0 ? `<p class="mu">${esc(t.noExecution)}</p>` : executionTable(state, executions, false)}</section>`;
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

function executionView(state: DashboardState): string {
  const t = state.t;
  const route = state.route as Extract<DashboardRoute, { view: 'execution' }>;
  const live = state.live;
  const running = live !== undefined && !isTerminal(live.snapshot.status);
  if (running) {
    const status = live.snapshot.status;
    const cancel = !state.cancellation
      ? `<small class="mu">${esc(t.cancelNotOffered)}</small>`
      : live.cancelRequested
        ? `<small class="mu" role="status">${esc(t.cancelRequested)}</small>`
        : state.confirm === 'cancel'
          ? `<span class="confirm" role="group"><small class="mu">${esc(t.cancelHint)}</small><button class="btn danger" data-action="cancel-confirm">${esc(t.cancelConfirm)}</button><button class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
          : `<button class="btn danger" data-action="cancel">${icon('stop')}<span>${esc(t.cancelRun)}</span></button>`;
    const flows = [...new Set(live.steps.map((step) => step.flow))];
    return `${header(t, `${esc(t.execution)} <code>${esc(route.run)}</code> ${pill(status, t.statuses[status] ?? status)}`, cancel, 'project')}
<section class="card wide live" aria-live="polite"><h2><span class="dot" aria-hidden="true"></span>${esc(t.live)}</h2>${live.phase ? `<p class="mu">${esc(enginePhase(live.phase, t.locale))}</p>` : ''}${flows
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
    return `${header(t, `${esc(t.execution)} <code>${esc(route.run)}</code>`, '', 'project')}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.waitingResult)}</p></section>`;
  const summary = `<section class="kpis"><article class="kpi accent"><span>${esc(t.col.verdict)}</span><b class="big">${esc(t.verdicts[detail.verdict] ?? detail.verdict)}</b><small>${esc(t.verdictOf(detail.flows.passed, detail.flows.total))}</small></article><article class="kpi"><span>${esc(t.col.kind)}</span><b class="mid">${esc(t.kinds[detail.kind] ?? detail.kind)}</b><small>${esc(formatDate(detail.createdAt, t.locale))}${detail.durationMs === undefined ? '' : ` · ${esc(t.duration(detail.durationMs))}`}</small></article><article class="kpi"><span>${esc(t.col.environment)}</span><b class="mid">${esc(detail.environment?.name ?? t.projectTarget)}</b><small>${esc((detail.scenarios ?? []).join(', '))}</small></article></section>`;
  const flows = detail.flowsDetail
    .map(
      (flow) =>
        `<section class="card wide"><h2 class="fl">${esc(flow.name)} ${pill(flow.status, t.results[flow.status] ?? flow.status)} <small class="mu">${esc(t.duration(flow.durationMs))}</small></h2>${flow.divergence ? `<p class="err">${esc(t.divergence(flow.divergence.stepIndex, flow.divergence.reason))}</p>` : ''}<ol class="steps">${flow.steps.map((step) => `<li>${pill(step.status, t.results[step.status] ?? step.status)}<span>${String(step.index)}. ${esc(step.label)}</span><small class="mu">${esc(t.duration(step.durationMs))}</small>${step.reason ? `<small class="why">${esc(step.reason)}</small>` : ''}</li>`).join('')}</ol><h3>${esc(t.assertions)}</h3>${flow.assertions.length === 0 ? `<p class="mu">${esc(t.noAssertion)}</p>` : `<ul class="plain">${flow.assertions.map((assertion) => `<li>${pill(assertion.status, t.results[assertion.status] ?? assertion.status)} <code>${esc(assertion.id)}</code> ${esc(assertion.description)}</li>`).join('')}</ul>`}${flow.testData.length > 0 ? `<p class="mu">${esc(t.testData)} : ${flow.testData.map((key) => `<code>${esc(key)}</code>`).join(' ')}</p>` : ''}</section>`,
    )
    .join('');
  const report = detail.reports.html
    ? `<button class="btn" data-action="report">${esc(t.openReport)}</button>`
    : '';
  return `${header(t, `${esc(t.execution)} <code>${esc(detail.run)}</code>`, report, 'project')}${summary}${flows}`;
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
