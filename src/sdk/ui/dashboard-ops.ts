import {
  ENVIRONMENT_KINDS,
  type Environment,
  type EnvironmentInput,
  type EnvironmentKind,
  type ScenarioHistoryView,
} from '../core/contracts.js';
import type { DashboardRoute, DashboardState, EnvironmentForm } from './dashboard-view.js';
import { checkLines, formatDate, header, icon, pill, readinessPill } from './dashboard-parts.js';
import { can } from './dashboard-access.js';
import { esc } from './view.js';

/**
 * LES ÉCRANS D'EXPLOITATION DU DASHBOARD : historique et comparaison de deux exécutions, scénarios
 * (stabilité, promotion d'un enregistrement), environnements (édition, vérification, suppression
 * confirmée), explorations (carte des écrans, anomalies par gravité). Des fonctions pures : tout vient
 * du SDK, rien n'est estimé ; un secret n'est jamais qu'un nom de variable.
 */

const pickProjectMessage = (state: DashboardState, title: string): string =>
  `${header(esc(title))}<section class="msg"><p class="mu">${esc(state.t.pickProject)}</p></section>`;

// ── Historique et comparaison ───────────────────────────────────────────────────────────────────

export function historyView(state: DashboardState): string {
  const t = state.t;
  const o = t.ops;
  const p = state.project;
  if (!p) return pickProjectMessage(state, t.nav.history);
  const executions = state.executions ?? [];
  const rows = executions
    .map((row) => {
      const checked = state.picked.includes(row.run);
      return `<tr class="${checked ? 'sel' : ''}"><td><label class="cell-chk"><input type="checkbox" data-bind="pick" value="${esc(row.run)}" ${checked ? 'checked' : ''} aria-label="${esc(o.pickLabel(row.run))}"></label></td><td><button class="lnk mono" data-action="open-run" data-project="${esc(row.projectId)}" data-run="${esc(row.run)}">${esc(row.run)}</button></td><td>${esc(t.kinds[row.kind] ?? row.kind)}</td><td>${pill(row.verdict, t.verdicts[row.verdict] ?? row.verdict)}</td><td>${String(row.flows.passed)}/${String(row.flows.total)}</td><td>${row.durationMs === undefined ? '—' : esc(t.duration(row.durationMs))}</td><td>${esc(row.environment?.name ?? '—')}</td><td>${esc(formatDate(row.createdAt, t.locale))}</td></tr>`;
    })
    .join('');
  const table =
    executions.length === 0
      ? `<p class="mu">${esc(t.noExecutionYet)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col"><span class="sr">${esc(o.compare)}</span></th><th scope="col">${esc(t.col.run)}</th><th scope="col">${esc(t.col.kind)}</th><th scope="col">${esc(t.col.verdict)}</th><th scope="col">${esc(t.col.flows)}</th><th scope="col">${esc(t.col.duration)}</th><th scope="col">${esc(t.col.environment)}</th><th scope="col">${esc(t.col.date)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `${header(esc(t.nav.history), { sub: esc(o.historySub(p.name, executions.length)) })}<section class="card wide">${table}</section>${comparisonCard(state)}`;
}

function comparisonCard(state: DashboardState): string {
  const t = state.t;
  const o = t.ops;
  const c = state.comparison;
  const title = `<div class="card-h"><h2>${esc(o.compare)}</h2>${c ? `<span class="mu">${esc(o.beforeAfter(c.base.run, c.head.run))}</span>` : ''}</div>`;
  if (state.picked.length < 2)
    return `<section class="card wide">${title}<p class="mu">${esc(o.pickTwo)}</p></section>`;
  if (state.comparing || !c)
    return `<section class="card wide" aria-busy="true">${title}<p class="mu">${esc(o.comparing)}</p></section>`;
  const s = c.summary;
  const tiles = `<div class="tiles">
<div class="tile ko"><b>${String(s.newlyFailing.length)}</b><span>${esc(o.regressions)}</span></div>
<div class="tile ok"><b>${String(s.newlyPassing.length)}</b><span>${esc(o.fixes)}</span></div>
<div class="tile"><b>${String(s.changed)}</b><span>${esc(o.changed)}</span></div>
<div class="tile"><b>${String(s.same)}</b><span>${esc(o.same)}${s.onlyBase || s.onlyHead ? ` · ${esc(o.onlyBase(s.onlyBase))} · ${esc(o.onlyHead(s.onlyHead))}` : ''}</span></div>
</div>`;
  const flows = c.flows
    .map(
      (flow) =>
        `<tr><td class="mono">${esc(flow.name)}</td><td>${flow.baseStatus ? pill(flow.baseStatus, t.results[flow.baseStatus] ?? flow.baseStatus) : '—'}</td><td>${flow.headStatus ? pill(flow.headStatus, t.results[flow.headStatus] ?? flow.headStatus) : '—'}</td><td>${
          flow.changes.length === 0
            ? `<span class="mu">${esc(o.noChange)}</span>`
            : `<ul class="plain tight">${flow.changes.map((change) => `<li>${change.step === undefined ? '' : `<span class="mu">${String(change.step)}.</span> `}${esc(change.detail)}</li>`).join('')}</ul>`
        }</td><td>${flow.durationDeltaMs === undefined ? '—' : esc(o.durationDelta(flow.durationDeltaMs))}</td></tr>`,
    )
    .join('');
  const requirements =
    s.requirementsChanged > 0 ? `<p class="mu">${esc(o.requirementsChanged(s.requirementsChanged))}</p>` : '';
  const failing = s.newlyFailing.length > 0 && state.project?.state !== 'ARCHIVED';
  return `<section class="card wide">${title}${tiles}<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(o.flowCol)}</th><th scope="col">${esc(o.before)}</th><th scope="col">${esc(o.now)}</th><th scope="col">${esc(o.changes)}</th><th scope="col">${esc(t.col.duration)}</th></tr></thead><tbody>${flows}</tbody></table></div>${requirements}<div class="form-acts start">${failing && can(state, 'RUN') ? `<button class="btn primary" data-action="replay-failed">${icon('play')}<span>${esc(t.ops.replay)} : ${esc(s.newlyFailing.join(', '))}</span></button>` : ''}<button class="btn" data-action="open-run" data-project="${esc(state.project?.id ?? '')}" data-run="${esc(c.head.run)}">${esc(t.col.run)} ${esc(c.head.run)}</button></div></section>`;
}

// ── Scénarios ───────────────────────────────────────────────────────────────────────────────────

/** Ce que l'historique dit d'un scénario : instable (au moins deux bascules), jamais rejoué, ou son dernier statut. */
export function scenarioTag(history: ScenarioHistoryView | undefined): string {
  if (!history || history.runs.length === 0) return 'NEVER';
  if (history.flips >= 2) return 'FLAKY';
  return history.runs[0]?.status ?? 'NEVER';
}

function tagPill(state: DashboardState, tag: string): string {
  const o = state.t.ops;
  if (tag === 'FLAKY') return pill('INCOMPLETE', o.flaky);
  if (tag === 'NEVER') return pill('UNKNOWN', o.neverRun);
  return pill(tag, state.t.results[tag] ?? tag);
}

function strip(state: DashboardState, history: ScenarioHistoryView | undefined): string {
  const runs = history?.runs ?? [];
  if (runs.length === 0) return '';
  const label = runs.map((run) => state.t.results[run.status] ?? run.status).join(', ');
  return `<span class="strip" role="img" aria-label="${esc(state.t.ops.stabilityLabel(label))}">${runs
    .map((run) => `<i class="${run.status === 'PASSED' ? 'ok' : run.status === 'FAILED' ? 'ko' : 'mu'}"></i>`)
    .join('')}</span>`;
}

export function scenariosView(state: DashboardState): string {
  const t = state.t;
  const o = t.ops;
  const p = state.project;
  if (!p) return pickProjectMessage(state, t.nav.scenarios);
  const route = state.route as Extract<DashboardRoute, { view: 'scenarios' }>;
  const histories = new Map((state.scenarioHistory ?? []).map((entry) => [entry.name, entry]));
  const promoted = new Set(p.scenarios.map((scenario) => scenario.fromRecording).filter(Boolean));
  const pending = (state.recordings ?? []).filter(
    (recording) =>
      (recording.status === 'COMPLETED' || recording.status === 'STORED') &&
      recording.summary !== undefined &&
      !promoted.has(recording.name),
  );
  const selected = p.scenarios.find((scenario) => scenario.name === route.scenario) ?? p.scenarios[0];
  const cards =
    p.scenarios.length === 0
      ? `<section class="card"><p class="mu">${esc(t.noScenario)}</p></section>`
      : p.scenarios
          .map((scenario) => {
            const history = histories.get(scenario.name);
            const decided = (history?.passed ?? 0) + (history?.failed ?? 0);
            return `<button class="scard ${scenario.name === selected?.name ? 'on' : ''}" data-action="pick-scenario" data-name="${esc(scenario.name)}" aria-pressed="${scenario.name === selected?.name ? 'true' : 'false'}"><span class="row"><b class="mono">${esc(scenario.name)}</b>${tagPill(state, scenarioTag(history))}<span class="mu push">${scenario.steps === undefined ? esc(scenario.format) : `${String(scenario.steps)} ${esc(t.col.steps.toLowerCase())}`}</span></span><span class="row mu">${strip(state, history)}${decided > 0 ? `<span>${esc(o.stability(history?.passed ?? 0, decided))}</span>` : ''}${history && history.flips > 0 ? `<span>${esc(o.flips(history.flips))}</span>` : ''}</span></button>`;
          })
          .join('');
  const recordings =
    pending.length === 0
      ? `<p class="mu">${esc(o.noRecording)}</p>`
      : pending
          .map(
            (recording) =>
              `<div class="rec"><span class="mono">${esc(recording.name)}</span>${pill('UNKNOWN', o.toPromote)}<span class="mu push">${esc(o.recordingSteps(recording.summary?.steps ?? 0))}</span>${p.state === 'ARCHIVED' || !can(state, 'PUBLISH') ? '' : `<button class="btn small" data-action="promote" data-recording="${esc(recording.name)}" ${state.promoting ? 'disabled' : ''}>${esc(state.promoting === recording.name ? o.promoting : o.promote)}</button>`}</div>`,
          )
          .join('');
  const history = selected ? histories.get(selected.name) : undefined;
  const detail = selected
    ? `<aside class="card" aria-label="${esc(selected.name)}"><div class="row"><b class="mono big-name">${esc(selected.name)}</b>${tagPill(state, scenarioTag(history))}</div>
<p class="mu">${esc(o.origin)} : ${esc(selected.fromRecording ? t.fromRecording(selected.fromRecording) : o.written)} · <code>${esc(selected.file)}</code></p>
${history && history.flips >= 2 ? `<p class="note">${icon('alert')}<span>${esc(o.flakyNote(history.flips, history.runs.length))}</span></p>` : ''}
<h3>${esc(o.lastRuns)}</h3>${
        history && history.runs.length > 0
          ? `<ul class="plain">${history.runs.map((run) => `<li class="row">${pill(run.status, t.results[run.status] ?? run.status)}<button class="lnk" data-action="open-run" data-project="${esc(p.id)}" data-run="${esc(run.run)}">${esc(formatDate(run.at, t.locale))}</button><span class="mu push">${esc(t.duration(run.durationMs))}</span></li>`).join('')}</ul>`
          : `<p class="mu">${esc(o.neverRun)}</p>`
      }
${p.state === 'ARCHIVED' || !can(state, 'RUN') ? '' : `<div class="form-acts start"><button class="btn primary" data-action="replay-scenario" data-name="${esc(selected.name)}">${icon('play')}<span>${esc(o.replay)}</span></button></div>`}</aside>`
    : '';
  return `${header(esc(t.nav.scenarios), { sub: esc(o.scenariosSub(p.name, p.scenarios.length, pending.length)) })}<div class="split"><div class="col">${cards}<section class="card"><h2>${esc(o.recordingsTitle)}</h2>${recordings}</section></div><div class="col narrow">${detail}</div></div>`;
}

// ── Environnements ──────────────────────────────────────────────────────────────────────────────

/** Le formulaire d'un environnement : vide (création) ou rempli depuis l'environnement existant. */
export function environmentForm(environment?: Environment): EnvironmentForm {
  return {
    ...(environment ? { id: environment.id } : {}),
    name: environment?.name ?? '',
    kind: environment?.kind ?? 'TEST',
    baseUrl: environment?.baseUrl ?? '',
    domains: (environment?.allowedDomains ?? []).join(', '),
    writes: environment?.mutations?.enabled ?? false,
    maxPerRun: environment?.mutations?.maxPerRun === undefined ? '' : String(environment.mutations.maxPerRun),
    secrets: (environment?.secretEnv ?? []).join(', '),
    variables: Object.entries(environment?.variables ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
    maxStates: environment?.limits?.maxStates === undefined ? '' : String(environment.limits.maxStates),
    maxActions: environment?.limits?.maxActions === undefined ? '' : String(environment.limits.maxActions),
    maxDurationMinutes:
      environment?.limits?.maxDurationMinutes === undefined
        ? ''
        : String(environment.limits.maxDurationMinutes),
    actionTimeoutMs:
      environment?.limits?.actionTimeoutMs === undefined ? '' : String(environment.limits.actionTimeoutMs),
  };
}

const list = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

const integer = (text: string): number | undefined => {
  const value = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(value) ? undefined : Math.trunc(value);
};

/**
 * Le formulaire vers l'entrée du SDK. Seule la forme est vérifiée ici (une ligne de variable sans
 * `=`) : les règles (nom unique, URL, domaines, noms de variables, limites) sont celles du serveur.
 */
export function environmentInputOf(
  form: EnvironmentForm,
  t: DashboardState['t'],
): { input: EnvironmentInput } | { error: string } {
  const variables: Record<string, string> = {};
  for (const line of form.variables
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const at = line.indexOf('=');
    if (at <= 0) return { error: t.ops.badVariable(line) };
    variables[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const limits = {
    ...(integer(form.maxStates) === undefined ? {} : { maxStates: integer(form.maxStates) }),
    ...(integer(form.maxActions) === undefined ? {} : { maxActions: integer(form.maxActions) }),
    ...(integer(form.maxDurationMinutes) === undefined
      ? {}
      : { maxDurationMinutes: integer(form.maxDurationMinutes) }),
    ...(integer(form.actionTimeoutMs) === undefined
      ? {}
      : { actionTimeoutMs: integer(form.actionTimeoutMs) }),
  };
  const kind = (ENVIRONMENT_KINDS as readonly string[]).includes(form.kind)
    ? (form.kind as EnvironmentKind)
    : 'OTHER';
  const max = integer(form.maxPerRun);
  return {
    input: {
      name: form.name.trim(),
      kind,
      baseUrl: form.baseUrl.trim(),
      allowedDomains: list(form.domains),
      variables,
      secretEnv: list(form.secrets),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      mutations: { enabled: form.writes, ...(form.writes && max !== undefined ? { maxPerRun: max } : {}) },
    },
  };
}

function field(name: keyof EnvironmentForm, label: string, value: string, extra = ''): string {
  return `<label class="field">${esc(label)}<input type="text" data-field="${name}" value="${esc(value)}" ${extra}></label>`;
}

export function environmentsView(state: DashboardState): string {
  const t = state.t;
  const o = t.ops;
  const p = state.project;
  if (!p) return pickProjectMessage(state, t.nav.environments);
  const route = state.route as Extract<DashboardRoute, { view: 'environments' }>;
  const archived = p.state === 'ARCHIVED';
  const cards = p.environments
    .map((environment) => {
      const writes = environment.mutations?.enabled
        ? `${t.col.writes.toLowerCase()} ${t.writesAllowed(environment.mutations.maxPerRun)}`
        : t.readOnly;
      return `<article class="env ${route.environmentId === environment.id ? 'on' : ''}"><div class="env-h"><b>${esc(environment.name)}</b>${readinessPill(t, state.checks[environment.id])}</div><span class="mu">${esc(t.envKinds[environment.kind] ?? environment.kind)} · ${esc(writes)}</span><code class="url">${esc(environment.baseUrl)}</code><span class="mu">${esc(t.col.secrets)} : ${(environment.secretEnv ?? []).map((name) => `<code>${esc(name)}</code>`).join(' ') || '—'}</span>${archived || !can(state, 'MANAGE_ENVIRONMENTS') ? '' : `<button class="btn small" data-action="edit-env" data-env="${esc(environment.id)}">${esc(o.edit)}</button>`}</article>`;
    })
    .join('');
  const actions =
    archived || !can(state, 'MANAGE_ENVIRONMENTS')
      ? ''
      : `<button class="btn primary" data-action="edit-env" data-env="new">${esc(o.newEnvironment)}</button>`;
  const list =
    p.environments.length === 0
      ? `<section class="card"><p class="mu">${esc(t.noEnvironment)}</p></section>`
      : `<div class="env-grid">${cards}</div>`;
  return `${header(esc(t.nav.environments), { sub: esc(o.environmentsSub(p.name)), actions })}${list}${state.envForm && !archived && can(state, 'MANAGE_ENVIRONMENTS') ? environmentEditor(state) : ''}`;
}

function environmentEditor(state: DashboardState): string {
  const t = state.t;
  const o = t.ops;
  const form = state.envForm as EnvironmentForm;
  const existing = form.id !== undefined;
  const title = existing ? o.editTitle(form.name) : o.newTitle;
  const remove = !existing
    ? ''
    : state.confirm === 'remove-env'
      ? `<span class="confirm" role="group"><small>${esc(o.removeHint)}</small><button type="button" class="btn danger" data-action="env-remove-confirm">${esc(o.removeConfirm)}</button><button type="button" class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
      : `<button type="button" class="btn danger" data-action="env-remove">${esc(o.remove)}</button>`;
  const kinds = ENVIRONMENT_KINDS.map(
    (kind) =>
      `<option value="${kind}" ${form.kind === kind ? 'selected' : ''}>${esc(t.envKinds[kind] ?? kind)}</option>`,
  ).join('');
  const editor = `<form class="col env-form" data-action="env-form" aria-label="${esc(title)}">
<section class="card"><h2>${esc(o.target)}</h2><div class="fields">${field('name', o.fieldName, form.name)}<label class="field">${esc(o.fieldKind)}<select data-field="kind">${kinds}</select></label>${field('baseUrl', o.fieldBase, form.baseUrl, 'inputmode="url" class="mono"')}${field('domains', o.fieldDomains, form.domains)}</div><small class="mu">${esc(o.domainsHint)}</small></section>
<section class="card"><h2>${esc(o.writesTitle)}</h2><label class="chk"><input type="checkbox" data-field="writes" ${form.writes ? 'checked' : ''}> ${esc(o.fieldWrites)}</label>${field('maxPerRun', o.fieldMax, form.maxPerRun, `inputmode="numeric" ${form.writes ? '' : 'disabled'}`)}<p class="note">${icon('alert')}<span>${esc(o.writesHint)}</span></p></section>
<section class="card"><h2>${esc(o.secretsTitle)}</h2><p class="mu">${esc(o.secretsHint)}</p>${field('secrets', o.fieldSecrets, form.secrets, 'class="mono" autocomplete="off" spellcheck="false"')}<label class="field">${esc(o.fieldVariables)}<textarea data-field="variables" rows="3" class="mono" spellcheck="false">${esc(form.variables)}</textarea></label></section>
<section class="card"><h2>${esc(o.limitsTitle)}</h2><div class="fields">${field('maxStates', o.fieldMaxStates, form.maxStates, 'inputmode="numeric"')}${field('maxActions', o.fieldMaxActions, form.maxActions, 'inputmode="numeric"')}${field('maxDurationMinutes', o.fieldMaxDuration, form.maxDurationMinutes, 'inputmode="numeric"')}${field('actionTimeoutMs', o.fieldTimeout, form.actionTimeoutMs, 'inputmode="numeric"')}</div></section>
<div class="form-acts">${remove}<button type="button" class="btn" data-action="env-verify" ${state.envBusy ? 'disabled' : ''}>${esc(o.verify)}</button><button type="button" class="btn primary" data-action="env-save" ${state.envBusy ? 'disabled' : ''}>${esc(state.envBusy ? o.saving : o.save)}</button></div>
${state.envError ? `<p class="err" role="alert">${esc(state.envError)}</p>` : ''}</form>`;
  const check = state.envCheck;
  const aside = `<aside class="col narrow"><section class="card" aria-live="polite"><div class="card-h"><h2>${esc(o.verification)}</h2>${readinessPill(t, check)}</div>${checkLines(t, check)}<p class="mu">${esc(o.sameAsCli(state.project?.name ?? '', form.name || '…'))}</p></section></aside>`;
  return `<h2 class="section-t">${esc(title)}</h2><div class="split">${editor}${aside}</div>`;
}

// ── Explorations ────────────────────────────────────────────────────────────────────────────────

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

export function explorationsView(state: DashboardState): string {
  const t = state.t;
  const o = t.ops;
  const p = state.project;
  if (!p) return pickProjectMessage(state, t.nav.explorations);
  const route = state.route as Extract<DashboardRoute, { view: 'explorations' }>;
  const explorations = (state.executions ?? []).filter((row) => row.kind === 'EXPLORATION');
  if (!route.run) {
    const rows = explorations
      .map(
        (row) =>
          `<tr><td><button class="lnk mono" data-action="open-exploration" data-run="${esc(row.run)}">${esc(row.run)}</button></td><td>${pill(row.verdict, t.verdicts[row.verdict] ?? row.verdict)}</td><td>${String(row.issues)}</td><td>${row.durationMs === undefined ? '—' : esc(t.duration(row.durationMs))}</td><td>${esc(formatDate(row.createdAt, t.locale))}</td></tr>`,
      )
      .join('');
    return `${header(esc(t.nav.explorations), { sub: esc(o.explorationsSub(p.name, explorations.length)) })}<section class="card wide">${
      explorations.length === 0
        ? `<p class="mu">${esc(o.noExploration)}</p>`
        : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(t.col.run)}</th><th scope="col">${esc(t.col.verdict)}</th><th scope="col">${esc(t.col.issues)}</th><th scope="col">${esc(t.col.duration)}</th><th scope="col">${esc(t.col.date)}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    }</section>`;
  }
  const detail = state.explored;
  const graph = state.graph;
  const back: [string, string] = ['explorations', t.nav.explorations];
  if (!detail)
    return `${header(`${esc(t.explored)} <code>${esc(route.run)}</code>`, { back })}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const issues = detail.issuesList;
  const bySeverity = (severity: string): number =>
    issues.filter((issue) => issue.severity === severity).length;
  const edges = graph?.edges ?? [];
  const blocked = edges.filter((edge) => edge.result === 'BLOCKED').length;
  const kpis = `<section class="kpis">
<article class="kpi"><span>${esc(o.screens)}</span><b class="big">${graph ? String(graph.nodes.length) : '—'}</b></article>
<article class="kpi"><span>${esc(o.actions)}</span><b class="big">${graph ? String(edges.length) : '—'}</b><small>${graph ? `${String(blocked)} ${esc(o.blocked)}` : ''}</small></article>
<article class="kpi"><span>${esc(o.issues)}</span><b class="big">${String(issues.length)}</b><small>${esc(t.kpi.issuesSub(bySeverity('CRITICAL'), bySeverity('ERROR')))}</small></article>
<article class="kpi"><span>${esc(o.stopReason)}</span><b class="mid">${esc(detail.stopReason ?? '—')}</b><small>${detail.durationMs === undefined ? '' : esc(t.duration(detail.durationMs))}</small></article>
</section>`;
  const issuesOn = (route: string): number =>
    issues.filter((issue) => pathOf(issue.pageUrl) === route).length;
  const labelOf = (id: string): string => graph?.nodes.find((node) => node.id === id)?.label ?? id;
  const map = !graph
    ? `<p class="mu">${esc(o.mapEmpty)}</p>`
    : `<div class="map">${graph.nodes
        .map((node) => {
          const out = edges.filter((edge) => edge.from === node.id);
          const count = issuesOn(node.route);
          return `<article class="node ${node.id === graph.rootId ? 'root' : ''} ${count > 0 ? 'has-issue' : ''}">${node.id === graph.rootId ? `<span class="tag-s">${esc(o.start)}</span>` : ''}<b>${esc(node.label || node.title)}</b><code>${esc(node.route)}</code>${count > 0 ? `<span class="ko-t">${esc(o.nodeIssues(count))}</span>` : ''}${
            out.length === 0
              ? ''
              : `<ul class="plain tight">${out
                  .slice(0, 6)
                  .map((edge) =>
                    edge.result === 'BLOCKED'
                      ? `<li class="mu">${esc(edge.action)} · ${esc(o.blockedBySafety)}</li>`
                      : `<li>${esc(edge.action)} → ${esc(labelOf(edge.to))}</li>`,
                  )
                  .join('')}${out.length > 6 ? `<li class="mu">+${String(out.length - 6)}</li>` : ''}</ul>`
          }</article>`;
        })
        .join('')}</div>`;
  const levels = ['ALL', 'CRITICAL', 'ERROR', 'WARNING', 'INFO'];
  const chips = levels
    .map(
      (level) =>
        `<button class="chip" data-action="severity" data-level="${level}" aria-pressed="${state.severity === level ? 'true' : 'false'}">${esc(level === 'ALL' ? o.all(issues.length) : `${t.severities[level] ?? level} (${String(bySeverity(level))})`)}</button>`,
    )
    .join('');
  const shown = issues.filter((issue) => state.severity === 'ALL' || issue.severity === state.severity);
  const issueList =
    shown.length === 0
      ? `<p class="mu">${esc(o.noIssue)}</p>`
      : `<ul class="plain">${shown
          .map(
            (issue) =>
              `<li class="issue">${pill(issue.severity === 'CRITICAL' || issue.severity === 'ERROR' ? 'FAILED' : issue.severity === 'WARNING' ? 'INCOMPLETE' : 'UNKNOWN', t.severities[issue.severity] ?? issue.severity)}<span><b>${esc(issue.message)}</b><small class="mu block">${esc(issue.type)} · ${esc(issue.pageUrl)}</small></span></li>`,
          )
          .join('')}</ul>`;
  const actions = detail.reports.html
    ? `<button class="btn" data-action="report">${esc(t.openReport)}</button>`
    : '';
  return `${header(`${esc(t.explored)} <code>${esc(detail.run)}</code>`, { sub: esc(formatDate(detail.createdAt, t.locale)), actions, back })}${kpis}<section class="card wide"><h2>${esc(o.map)}</h2>${map}</section><section class="card wide"><div class="card-h"><h2>${esc(o.issues)}</h2><div class="chips" role="group">${chips}</div></div>${issueList}</section>`;
}
