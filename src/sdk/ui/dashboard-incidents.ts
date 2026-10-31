import type { IncidentScopeValidation } from '../core/client.js';
import type { ProjectDetail } from '../core/contracts.js';
import {
  EXECUTION_TARGETS,
  INCIDENT_SEVERITIES,
  incidentReproduction,
  SCOPE_EXTENSION_KINDS,
  SCOPE_MODES,
  type CodeLayer,
  type ExecutionTarget,
  type Incident,
  type IncidentInput,
  type IncidentSeverity,
  type IncidentState,
  type IncidentSummary,
  type InvestigationScope,
  type ScopeApplication,
  type ScopeExtensionKind,
  type ScopeMode,
} from '../core/incident-contracts.js';
import { can } from './dashboard-access.js';
import { formatDate, header, icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { panelState } from './incident-parts.js';
import { uxText, type WorkspaceProgress } from './incident-ux.js';
import {
  disableForDemo,
  emptyWorkspaceUi,
  isDemoIncident,
  renderWorkspace,
  WORKSPACE_TABS,
  type WorkspaceTab,
  type WorkspaceUi,
} from './incident-workspace.js';
import { esc } from './view.js';

/**
 * LES ÉCRANS INCIDENTS : la liste et la déclaration, la liste des investigations (avec leur progression),
 * puis l'ESPACE D'INVESTIGATION d'un incident (`incident-workspace.ts`), dont l'onglet « Périmètre »
 * (applications, permissions, limites, extensions) est rendu ici. Des fonctions pures, de l'état vers le
 * HTML échappé : tout vient du serveur, ou des données de démonstration signalées comme telles.
 */
export const INCIDENT_TABS = WORKSPACE_TABS;
export type IncidentTab = WorkspaceTab;

export const CODE_LAYERS: readonly CodeLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];

/** Le formulaire de déclaration, tel que saisi (converti en IncidentInput à l'envoi). */
export interface IncidentForm {
  title: string;
  description: string;
  observed: string;
  expected: string;
  severity: IncidentSeverity;
  scenario: string;
  environmentId: string;
  target: ExecutionTarget;
  /** REMOTE : namespace OpenShift (facultatif) ; ARO : namespace, ServiceAccount, image, montage des dépôts. */
  namespace: string;
  serviceAccount: string;
  image: string;
  repositoriesMount: string;
}

/** Une application à ajouter au périmètre. */
export interface ApplicationForm {
  id: string;
  name: string;
  layer: CodeLayer;
  root: string;
  include: string;
  classes: string;
  baseUrl: string;
}

/** La modification du périmètre : les listes en texte (une entrée par ligne). */
export interface ScopeForm {
  mode: ScopeMode;
  depth: string;
  scenarios: string;
  steps: string;
  endpoints: string;
  allowedHosts: string;
  applications: ScopeApplication[];
  app: ApplicationForm;
  /** Pourquoi l'application saisie n'a pas été ajoutée. */
  appError?: 'missing' | 'duplicate' | 'relative';
}

export interface ExtensionForm {
  kind: ScopeExtensionKind;
  target: string;
  applicationId: string;
  reason: string;
}

/** Une investigation de la liste : le résumé, et sa progression quand l'incident a pu être lu. */
export interface InvestigationRow {
  summary: IncidentSummary;
  progress?: WorkspaceProgress;
}

export interface IncidentsUi {
  list?: IncidentSummary[];
  /** La liste « Investigations » : les incidents qui ne sont plus des brouillons, avec leur progression. */
  investigations?: InvestigationRow[];
  /** L'incident ouvert, tel que lu (sa révision sert aux modifications). */
  incident?: Incident;
  /** La lecture de l'incident a échoué (refusée : 403). */
  loadError?: { message: string; denied: boolean };
  validation?: IncidentScopeValidation;
  form?: IncidentForm;
  scopeForm?: ScopeForm;
  extension: ExtensionForm;
  /** L'annulation de l'investigation attend sa confirmation dans la page. */
  confirmCancel: boolean;
  /** Les champs refusés au dernier envoi d'un formulaire (clés `data-inc`). */
  invalid?: string[];
  /** L'opération en cours (une à la fois). */
  busy?: string;
  error?: string;
  details?: string[];
  /** Ce qui vient de changer (dit par la zone aria-live). */
  notice?: string;
  /** L'espace d'investigation : sélection, vues des modules, fichiers et captures lus. */
  ws: WorkspaceUi;
}

export const emptyExtensionForm = (): ExtensionForm => ({
  kind: 'ADD_PATH',
  target: '',
  applicationId: '',
  reason: '',
});

export const emptyIncidentsUi = (): IncidentsUi => ({
  extension: emptyExtensionForm(),
  confirmCancel: false,
  ws: emptyWorkspaceUi(),
});

export const emptyApplicationForm = (): ApplicationForm => ({
  id: '',
  name: '',
  layer: 'BACKEND',
  root: '',
  include: '',
  classes: '',
  baseUrl: '',
});

/** Le formulaire vierge : le premier scénario et le premier environnement du projet, cible LOCAL. */
export function emptyIncidentForm(project?: Pick<ProjectDetail, 'scenarios' | 'environments'>): IncidentForm {
  return {
    title: '',
    description: '',
    observed: '',
    expected: '',
    severity: 'MEDIUM',
    scenario: incidentScenarios(project)[0] ?? '',
    environmentId: project?.environments[0]?.id ?? '',
    target: 'LOCAL',
    namespace: '',
    serviceAccount: '',
    image: '',
    repositoriesMount: '',
  };
}

/** Les scénarios qui mènent à un symptôme : ceux de la bibliothèque qui se rejouent seuls. */
export function incidentScenarios(project?: Pick<ProjectDetail, 'scenarios'>): string[] {
  return (project?.scenarios ?? []).filter((scenario) => !scenario.reusable).map((scenario) => scenario.name);
}

const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Les entrées d'une liste saisie une par ligne (les virgules ne coupent pas : « POST /api/a, b » reste entier). */
const rows = (text: string): string[] =>
  text
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Ce que le formulaire manque encore (le serveur revalide tout). */
export function incidentFormProblems(form: IncidentForm): (keyof IncidentForm)[] {
  const missing: (keyof IncidentForm)[] = [];
  for (const key of ['title', 'observed', 'expected'] as const) if (!form[key].trim()) missing.push(key);
  if (form.target === 'ARO')
    for (const key of ['namespace', 'serviceAccount', 'image', 'repositoriesMount'] as const)
      if (!form[key].trim()) missing.push(key);
  return missing;
}

export function incidentInputOf(form: IncidentForm): IncidentInput {
  const namespace = form.namespace.trim();
  const execution: IncidentInput['execution'] =
    form.target === 'ARO'
      ? {
          target: 'ARO',
          aro: {
            namespace,
            serviceAccount: form.serviceAccount.trim(),
            image: form.image.trim(),
            repositoriesMount: form.repositoriesMount.trim(),
          },
        }
      : form.target === 'REMOTE'
        ? { target: 'REMOTE', ...(namespace ? { remote: { openshift: { namespace } } } : {}) }
        : { target: 'LOCAL' };
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    observed: form.observed.trim(),
    expected: form.expected.trim(),
    severity: form.severity,
    ...(form.scenario ? { scenario: form.scenario } : {}),
    ...(form.environmentId ? { environmentId: form.environmentId } : {}),
    execution,
  };
}

export function scopeFormOf(scope: InvestigationScope): ScopeForm {
  return {
    mode: scope.mode,
    depth: String(scope.depth),
    scenarios: scope.scenarios.join('\n'),
    steps: scope.steps.join(', '),
    endpoints: scope.endpoints.join('\n'),
    allowedHosts: scope.allowedHosts.join('\n'),
    applications: scope.applications.map((application) => ({ ...application })),
    app: emptyApplicationForm(),
  };
}

/** Une application saisie, ou la raison de son refus (identifiant pris, chemin non absolu…). */
export function applicationOf(
  form: ApplicationForm,
  taken: readonly ScopeApplication[],
): ScopeApplication | 'missing' | 'duplicate' | 'relative' {
  const id = form.id.trim();
  const root = form.root.trim();
  if (!id || !root) return 'missing';
  if (taken.some((application) => application.id === id)) return 'duplicate';
  if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) return 'relative';
  const classes = lines(form.classes);
  const baseUrl = form.baseUrl.trim();
  return {
    id,
    name: form.name.trim() || id,
    layer: form.layer,
    repository: { root, include: lines(form.include), ...(classes.length > 0 ? { classes } : {}) },
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Le périmètre modifié, complet : les permissions, limites et extensions restent celles du serveur
 * (elles ne changent que par une extension approuvée).
 */
export function scopeOf(form: ScopeForm, scope: InvestigationScope): InvestigationScope {
  const depth = Number(form.depth);
  return {
    ...scope,
    mode: form.mode,
    depth: Number.isInteger(depth) ? depth : scope.depth,
    scenarios: rows(form.scenarios),
    steps: lines(form.steps)
      .map(Number)
      .filter((step) => Number.isInteger(step) && step > 0),
    endpoints: rows(form.endpoints),
    allowedHosts: lines(form.allowedHosts),
    applications: form.applications,
  };
}

const STABLE_BEFORE_REPRODUCTION: readonly IncidentState[] = [
  'SCOPED',
  'REPRODUCED',
  'NOT_REPRODUCED',
  'INVESTIGATING',
  'DIAGNOSED',
  'INCONCLUSIVE',
  'FAILED',
];

/** La reproduction peut-elle être lancée (transitions du serveur vers REPRODUCING) ? */
export const canReproduce = (incident: Pick<Incident, 'state'>): boolean =>
  STABLE_BEFORE_REPRODUCTION.includes(incident.state);

/** L'incident change-t-il sur le serveur sans action de la page (reproduction, vérification en cours) ? */
export const needsPolling = (incident: Incident | undefined): boolean =>
  incident !== undefined &&
  (incident.state === 'REPRODUCING' ||
    incident.investigation.experiments.some((experiment) => experiment.status === 'RUNNING'));

/** L'icône du menu : une loupe sur un signal d'alerte. */
export const incidentIcon = (): string =>
  '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v3.5M10.5 13.5v.5"/></svg>';

// ── Pièces ───────────────────────────────────────────────────────────────────────────────────

const TONES: Record<string, string> = {
  DRAFT: 'mu',
  SCOPED: 'live',
  REPRODUCING: 'live',
  REPRODUCED: 'warn',
  NOT_REPRODUCED: 'mu',
  INVESTIGATING: 'live',
  DIAGNOSED: 'ok',
  INCONCLUSIVE: 'warn',
  CANCELLED: 'mu',
  FAILED: 'ko',
  LOW: 'mu',
  MEDIUM: 'warn',
  HIGH: 'ko',
  CRITICAL: 'ko',
  OBSERVED: 'ok',
  STATICALLY_RESOLVED: 'live',
  INFERRED: 'warn',
  UNKNOWN: 'mu',
  PROPOSED: 'mu',
  SUPPORTED: 'live',
  REFUTED: 'mu',
  CONFIRMED: 'ok',
  PROBABLE: 'warn',
  REFUSED: 'ko',
  APPROVAL_REQUIRED: 'warn',
  RUNNING: 'live',
  DONE: 'ok',
  ERROR: 'ko',
  PENDING: 'warn',
  APPROVED: 'ok',
  REJECTED: 'mu',
  ACCEPTED: 'ok',
  COMPLETED: 'ok',
  PASSED: 'ok',
  NOT_RUN: 'mu',
  SUPPORTS: 'ok',
  REFUTES: 'ko',
  NEUTRAL: 'mu',
};

const tag = (raw: string, text: string): string =>
  `<span class="pill ${TONES[raw] ?? 'mu'}">${esc(text)}</span>`;

const label = (labels: Record<string, string>, raw: string): string => labels[raw] ?? raw;

function messages(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t.inc;
  const incident = ui.incident;
  const live =
    ui.busy !== undefined
      ? (t.busy[ui.busy] ?? t.working)
      : incident?.state === 'REPRODUCING'
        ? t.reproducingLive
        : (ui.notice ?? '');
  return `<p class="inc-live" role="status" aria-live="polite">${live ? `${ui.busy !== undefined || incident?.state === 'REPRODUCING' ? '<span class="spin sm" aria-hidden="true"></span>' : ''}<span>${esc(live)}</span>` : ''}</p>${
    ui.error
      ? `<div class="err-box" role="alert"><p class="err"><b>${esc(ui.error)}</b></p>${
          ui.details && ui.details.length > 0
            ? `<ul class="plain tight">${ui.details.map((detail) => `<li>${esc(detail)}</li>`).join('')}</ul>`
            : ''
        }</div>`
      : ''
  }`;
}

/** Un bouton d'action : absent sans le droit, désactivé pendant une opération ou quand l'état l'interdit. */
function actionButton(
  ui: IncidentsUi,
  action: string,
  text: string,
  options: { primary?: boolean; danger?: boolean; disabled?: boolean; extra?: string; title?: string } = {},
): string {
  const busy = ui.busy === action;
  const off = options.disabled === true || ui.busy !== undefined;
  return `<button type="button" class="btn${options.primary ? ' primary' : ''}${options.danger ? ' danger' : ''}" data-action="${action}" ${options.extra ?? ''} ${off ? 'disabled' : ''} aria-busy="${String(busy)}"${options.title ? ` title="${esc(options.title)}"` : ''}>${esc(text)}</button>`;
}

// ── Liste et déclaration ─────────────────────────────────────────────────────────────────────

/** L'entrée de la démonstration : un incident fictif, sans appel au serveur. */
function demoEntry(state: DashboardState): string {
  const i = state.t.inc;
  return `<section class="card wide ws-demo-entry" aria-labelledby="inc-demo-t"><div><h2 id="inc-demo-t" class="fl">${esc(i.demo.title)}</h2><p class="mu">${esc(i.demo.hint)}</p></div><button type="button" class="btn" data-action="inc-demo">${icon('eye')}<span>${esc(i.demo.open)}</span></button></section>`;
}

export function incidentsView(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const route = state.route;
  if (route.view !== 'incidents') return '';
  const project = state.project;
  const list = ui.list;
  const runner = can(state, 'RUN');
  const actions = `<button class="btn icon-only" data-action="inc-refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button><button class="btn" data-action="inc-demo">${icon('eye')}<span>${esc(i.demo.open)}</span></button>${
    runner && !route.create
      ? `<button class="btn primary" data-action="inc-new">${icon('plus')}<span>${esc(i.newIncident)}</span></button>`
      : ''
  }`;
  const top = header(esc(t.nav.incidents), {
    sub: esc(project ? i.listSub(project.name, list?.length ?? 0) : i.sub),
    actions,
  });
  const form = route.create && runner ? createForm(state, ui) : '';
  const readOnly = runner ? '' : `<p class="note">${icon('info')}<span>${esc(i.readOnly)}</span></p>`;
  if (!list)
    return `${top}${messages(state, ui)}${form}<section class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const table =
    list.length === 0
      ? `<p class="mu">${esc(i.noIncident)}</p>`
      : `<div class="tw"><table class="tbl"><caption class="sr">${esc(t.nav.incidents)}</caption><thead><tr><th scope="col">${esc(i.col.title)}</th><th scope="col">${esc(i.col.severity)}</th><th scope="col">${esc(i.col.state)}</th><th scope="col">${esc(i.col.scenario)}</th><th scope="col">${esc(i.col.target)}</th><th scope="col">${esc(i.col.diagnosis)}</th><th scope="col">${esc(i.col.updated)}</th></tr></thead><tbody>${list
          .map(
            (row) =>
              `<tr><td><button class="lnk" data-action="inc-open" data-incident="${esc(row.id)}">${esc(row.title)}</button><small class="mu block"><code>${esc(row.id)}</code></small></td><td>${tag(row.severity, label(i.severities, row.severity))}</td><td>${tag(row.state, label(i.states, row.state))}</td><td>${esc(row.scenario ?? '—')}</td><td>${esc(label(i.targets, row.target))}</td><td>${row.diagnosis ? tag(row.diagnosis, label(i.diagnosisStatus, row.diagnosis)) : '<span class="mu">—</span>'}</td><td>${esc(formatDate(row.updatedAt, t.locale))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  return `${top}${messages(state, ui)}${readOnly}${form}<section class="card wide">${table}</section>${list.length === 0 ? demoEntry(state) : ''}`;
}

// ── Investigations ───────────────────────────────────────────────────────────────────────────

/** La progression d'une investigation : barre, nombre d'étapes, étape actuelle (ou bloquée). */
function progressCell(state: DashboardState, row: InvestigationRow): string {
  const i = state.t.inc.inv;
  const progress = row.progress;
  if (!progress) return `<span class="mu">${esc(i.unknown)}</span>`;
  const stages = uxText(state.t.locale).stages;
  const total = progress.stages.length;
  const blocked = progress.stages.find((stage) => stage.status === 'BLOCKED');
  const now = progress.running ?? progress.current;
  const status = blocked
    ? i.blocked(stages[blocked.key])
    : progress.running
      ? i.running(stages[progress.running])
      : now
        ? i.current(stages[now])
        : i.complete;
  const percent = Math.round((progress.done / Math.max(1, total)) * 100);
  return `<div class="ws-inv-progress${blocked ? ' ws-inv-blocked' : ''}"><span class="ws-inv-bar" role="img" aria-label="${esc(i.progress(progress.done, total))}"><span style="width:${String(percent)}%"></span></span><small>${esc(i.progress(progress.done, total))}</small><small class="mu">${esc(status)}</small></div>`;
}

export function investigationsView(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const route = state.route;
  if (route.view !== 'investigations') return '';
  const rows = ui.investigations;
  const project = state.project;
  const actions = `<button class="btn icon-only" data-action="inc-refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button><button class="btn" data-action="inc-demo">${icon('eye')}<span>${esc(i.demo.open)}</span></button>`;
  const top = header(esc(t.nav.investigations), {
    sub: esc(project ? i.inv.sub(project.name, rows?.length ?? 0) : i.inv.intro),
    actions,
  });
  if (!rows)
    return `${top}${messages(state, ui)}<section class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const table =
    rows.length === 0
      ? `<p class="mu">${esc(i.inv.none)}</p>`
      : `<div class="tw"><table class="tbl"><caption class="sr">${esc(t.nav.investigations)}</caption><thead><tr><th scope="col">${esc(i.col.title)}</th><th scope="col">${esc(i.inv.progressCol)}</th><th scope="col">${esc(i.col.state)}</th><th scope="col">${esc(i.col.severity)}</th><th scope="col">${esc(i.col.diagnosis)}</th><th scope="col">${esc(i.col.updated)}</th></tr></thead><tbody>${rows
          .map((row) => {
            const summary = row.summary;
            return `<tr><td><button class="lnk" data-action="inc-open" data-incident="${esc(summary.id)}">${esc(summary.title)}</button><small class="mu block"><code>${esc(summary.id)}</code> · ${esc(summary.scenario ?? '—')}</small></td><td>${progressCell(state, row)}</td><td>${tag(summary.state, label(i.states, summary.state))}</td><td>${tag(summary.severity, label(i.severities, summary.severity))}</td><td>${summary.diagnosis ? tag(summary.diagnosis, label(i.diagnosisStatus, summary.diagnosis)) : '<span class="mu">—</span>'}</td><td>${esc(formatDate(summary.updatedAt, t.locale))}</td></tr>`;
          })
          .join('')}</tbody></table></div>`;
  return `${top}${messages(state, ui)}<p class="mu">${esc(i.inv.intro)}</p><section class="card wide">${table}</section>${demoEntry(state)}`;
}

function textField(
  key: string,
  text: string,
  value: string,
  options: { required?: boolean; area?: boolean; hint?: string; invalid?: boolean; mono?: boolean } = {},
): string {
  const id = `inc-f-${key}`;
  const described = options.hint ? ` aria-describedby="${id}-h"` : '';
  const common = `id="${id}" data-inc="${key}"${options.required ? ' required aria-required="true"' : ''}${options.invalid ? ' aria-invalid="true"' : ''}${described}${options.mono ? ' class="mono" spellcheck="false"' : ''} autocomplete="off"`;
  const input = options.area
    ? `<textarea ${common} rows="3">${esc(value)}</textarea>`
    : `<input ${common} value="${esc(value)}">`;
  return `<label class="field" for="${id}">${esc(text)}${options.required ? ' <span aria-hidden="true">*</span>' : ''}${input}</label>${options.hint ? `<small id="${id}-h" class="mu">${esc(options.hint)}</small>` : ''}`;
}

function selectField(
  key: string,
  text: string,
  value: string,
  options: { value: string; text: string }[],
): string {
  const id = `inc-f-${key}`;
  return `<label class="field" for="${id}">${esc(text)}<select id="${id}" data-inc="${key}">${options
    .map(
      (option) =>
        `<option value="${esc(option.value)}" ${option.value === value ? 'selected' : ''}>${esc(option.text)}</option>`,
    )
    .join('')}</select></label>`;
}

function createForm(state: DashboardState, ui: IncidentsUi): string {
  const i = state.t.inc;
  const form = ui.form;
  if (!form) return '';
  const project = state.project;
  const scenarios = incidentScenarios(project);
  const environments = project?.environments ?? [];
  const invalid = new Set(ui.invalid ?? []);
  const bad = (key: keyof IncidentForm): boolean => invalid.has(key);
  const targetFields =
    form.target === 'ARO'
      ? `<div class="fields">${textField('namespace', i.form.namespace, form.namespace, { required: true, mono: true, invalid: bad('namespace') })}${textField('serviceAccount', i.form.serviceAccount, form.serviceAccount, { required: true, mono: true, invalid: bad('serviceAccount') })}${textField('image', i.form.image, form.image, { required: true, mono: true, invalid: bad('image') })}${textField('repositoriesMount', i.form.repositoriesMount, form.repositoriesMount, { required: true, mono: true, hint: i.form.repositoriesMountHint, invalid: bad('repositoriesMount') })}</div>`
      : form.target === 'REMOTE'
        ? `<div class="fields">${textField('namespace', i.form.remoteNamespace, form.namespace, { mono: true, hint: i.form.remoteNamespaceHint })}</div>`
        : '';
  return `<section class="card wide" aria-labelledby="inc-create-t"><h2 id="inc-create-t" class="fl">${esc(i.form.title)}</h2><p class="mu">${esc(i.form.sub)}</p><form class="col inc-form" data-action="inc-create" novalidate>
<div class="fields">${textField('title', i.form.titleField, form.title, { required: true, invalid: bad('title') })}${selectField(
    'severity',
    i.form.severity,
    form.severity,
    INCIDENT_SEVERITIES.map((severity) => ({ value: severity, text: label(i.severities, severity) })),
  )}</div>
${textField('description', i.form.description, form.description, { area: true })}
<div class="fields">${textField('observed', i.form.observed, form.observed, { required: true, area: true, hint: i.form.observedHint, invalid: bad('observed') })}${textField('expected', i.form.expected, form.expected, { required: true, area: true, hint: i.form.expectedHint, invalid: bad('expected') })}</div>
<div class="fields">${selectField('scenario', i.form.scenario, form.scenario, [
    { value: '', text: i.form.noScenario },
    ...scenarios.map((name) => ({ value: name, text: name })),
  ])}${selectField('environmentId', i.form.environment, form.environmentId, [
    { value: '', text: i.form.firstEnvironment },
    ...environments.map((environment) => ({ value: environment.id, text: environment.name })),
  ])}</div>
<fieldset class="inc-targets"><legend>${esc(i.form.target)}</legend><div class="chips" role="radiogroup" aria-label="${esc(i.form.target)}">${EXECUTION_TARGETS.map(
    (target) =>
      `<label class="choice${form.target === target ? ' on' : ''}"><input type="radio" name="inc-target" data-inc="target" value="${target}" ${form.target === target ? 'checked' : ''}><span><b>${esc(label(i.targets, target))}</b><small>${esc(label(i.targetHints, target))}</small></span></label>`,
  ).join('')}</div></fieldset>
${targetFields}
${invalid.size > 0 ? `<p class="err" role="alert">${esc(i.form.required)}</p>` : `<small class="mu">${esc(i.form.required)}</small>`}
<div class="form-acts start"><button type="submit" class="btn primary" ${ui.busy !== undefined ? 'disabled' : ''} aria-busy="${String(ui.busy === 'inc-create')}">${esc(i.form.create)}</button><button type="button" class="btn ghost" data-action="inc-create-cancel">${esc(state.t.cancelAction)}</button></div>
</form></section>`;
}

// ── L'espace d'investigation d'un incident ───────────────────────────────────────────────────

/** Les actions de l'en-tête : actualiser, reproduire, annuler (confirmé dans la page) ou reprendre. */
function headerActions(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const t = state.t;
  const i = t.inc;
  const runner = can(state, 'RUN');
  const refresh = `<button class="btn icon-only" data-action="inc-refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>`;
  if (!runner) return refresh;
  const reproduction = incidentReproduction(incident);
  const launchable = canReproduce(incident);
  const why =
    launchable || incident.state === 'REPRODUCING'
      ? undefined
      : incident.state === 'DRAFT'
        ? i.repro.draft
        : i.repro.notNow(label(i.states, incident.state));
  const reproduce = actionButton(ui, 'inc-reproduce', reproduction ? i.repro.again : i.repro.launch, {
    primary: !reproduction && launchable,
    disabled: !launchable,
    ...(why ? { title: why } : {}),
  });
  const cancelControl =
    incident.state === 'CANCELLED'
      ? ''
      : ui.confirmCancel
        ? `<span class="confirm" role="group" aria-label="${esc(i.cancelInvestigation)}"><small>${esc(i.cancelHint)}</small><button class="btn danger" data-action="inc-cancel-yes" ${ui.busy !== undefined ? 'disabled' : ''}>${esc(i.cancelConfirm)}</button><button class="btn ghost" data-action="inc-cancel-no">${esc(t.cancelAction)}</button></span>`
        : actionButton(ui, 'inc-cancel', i.cancelInvestigation);
  const resume =
    incident.state === 'CANCELLED' ? actionButton(ui, 'inc-resume', i.resume, { primary: true }) : '';
  return `${refresh}${resume}${incident.state === 'CANCELLED' ? '' : reproduce}${cancelControl}`;
}

export function incidentView(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const route = state.route;
  if (route.view !== 'incident') return '';
  const back: [string, string] = ['incidents', t.nav.incidents];
  const incident = ui.incident;
  if (incident?.id !== route.incidentId) {
    const title = `${esc(i.incident)} <code>${esc(route.incidentId)}</code>`;
    if (ui.loadError)
      return `${header(title, { back })}${messages(state, ui)}<section class="card wide">${
        ui.loadError.denied
          ? panelState(t.locale, 'denied', i.denied)
          : panelState(t.locale, 'error', ui.loadError.message, 'inc-refresh')
      }</section>`;
    return `${header(title, { back })}${messages(state, ui)}<section class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  }
  const tab: IncidentTab = route.tab ?? 'overview';
  const demo = ui.ws.demo && isDemoIncident(incident.id);
  const html = renderWorkspace({
    incident,
    ws: ui.ws,
    tab,
    lang: t.locale,
    can: (right) => can(state, right),
    back: `<button class="back" data-action="back" data-to="incidents">${icon('back')}<span>${esc(t.nav.incidents)}</span></button>`,
    actions: headerActions(state, ui, incident),
    messages: messages(state, ui),
    scope: tab === 'scope' ? scopeTab(state, ui, incident) : '',
    notes: can(state, 'RUN') ? '' : `<p class="note">${icon('info')}<span>${esc(i.readOnly)}</span></p>`,
  });
  return demo ? disableForDemo(html, t.locale) : html;
}

// ── Périmètre ────────────────────────────────────────────────────────────────────────────────

function scopeTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const i = state.t.inc;
  const s = i.scope;
  const scope = incident.scope;
  const runner = can(state, 'RUN');
  const editable = runner && incident.state !== 'CANCELLED' && incident.state !== 'REPRODUCING';
  const apps =
    scope.applications.length === 0
      ? `<p class="mu">${esc(s.noApplication)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(s.application)}</th><th scope="col">${esc(s.layer)}</th><th scope="col">${esc(s.repository)}</th><th scope="col">${esc(s.include)}</th><th scope="col">${esc(s.classes)}</th></tr></thead><tbody>${scope.applications
          .map(
            (app) =>
              `<tr><td><b>${esc(app.name)}</b><small class="mu block"><code>${esc(app.id)}</code>${app.baseUrl ? ` · ${esc(app.baseUrl)}` : ''}</small></td><td>${esc(label(i.layers, app.layer))}</td><td><code>${esc(app.repository.root)}</code></td><td>${app.repository.include.length === 0 ? `<span class="mu">${esc(s.wholeRoot)}</span>` : app.repository.include.map((entry) => `<code>${esc(entry)}</code>`).join(' ')}</td><td>${(app.repository.classes ?? []).length === 0 ? `<span class="mu">${esc(s.allClasses)}</span>` : (app.repository.classes ?? []).map((entry) => `<code>${esc(entry)}</code>`).join(' ')}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  const chipsOf = (items: (string | number)[], none: string): string =>
    items.length === 0
      ? `<span class="mu">${esc(none)}</span>`
      : items.map((item) => `<code>${esc(String(item))}</code>`).join(' ');
  const perms = scope.permissions;
  const limits = scope.limits;
  const yesNo = (value: boolean): string => (value ? s.allowed : s.denied);
  const facts = `<dl class="inc-dl">
<div><dt>${esc(s.mode)}</dt><dd>${esc(label(i.modes, scope.mode))}<small class="mu block">${esc(label(i.modeHints, scope.mode))}</small></dd></div>
<div><dt>${esc(s.depth)}</dt><dd>${esc(s.depthValue(scope.depth))}</dd></div>
<div><dt>${esc(s.scenarios)}</dt><dd>${chipsOf(scope.scenarios, s.none)}</dd></div>
<div><dt>${esc(s.steps)}</dt><dd>${chipsOf(scope.steps, s.allSteps)}</dd></div>
<div><dt>${esc(s.endpoints)}</dt><dd>${chipsOf(scope.endpoints, s.observedEndpoints)}</dd></div>
<div><dt>${esc(s.hosts)}</dt><dd>${chipsOf(scope.allowedHosts, s.none)}</dd></div>
</dl>`;
  const permissions = `<div class="policy">
<div><b>${esc(s.perm.readSources)}</b><span>${esc(yesNo(perms.readSources))}</span></div>
<div><b>${esc(s.perm.navigate)}</b><span>${esc(yesNo(perms.navigate))}</span></div>
<div><b>${esc(s.perm.httpRequests)}</b><span>${esc(label(s.http, perms.httpRequests))}</span></div>
<div><b>${esc(s.perm.runTests)}</b><span>${esc(label(s.tests, perms.runTests))}</span></div>
<div><b>${esc(s.perm.localCommands)}</b><span>${esc(yesNo(perms.localCommands))}</span></div>
<div><b>${esc(s.perm.readLogs)}</b><span>${esc(yesNo(perms.readLogs))}</span></div>
<div><b>${esc(s.perm.openshift)}</b><span>${esc(perms.openshift === 'READ' ? s.readOnly : s.denied)}</span></div>
<div><b>${esc(s.perm.sideEffects)}</b><span>${esc(perms.sideEffects ? s.withApproval : s.denied)}</span></div>
</div>`;
  const limitsBox = `<div class="policy">
<div><b>${esc(s.limit.maxFiles)}</b><span>${String(limits.maxFiles)}</span></div>
<div><b>${esc(s.limit.maxFileBytes)}</b><span>${esc(s.kib(limits.maxFileBytes))}</span></div>
<div><b>${esc(s.limit.maxDurationMs)}</b><span>${esc(s.minutes(limits.maxDurationMs))}</span></div>
<div><b>${esc(s.limit.maxRequests)}</b><span>${String(limits.maxRequests)}</span></div>
<div><b>${esc(s.limit.maxExperiments)}</b><span>${String(limits.maxExperiments)}</span></div>
</div>`;
  const decider = can(state, 'DECIDE');
  const pending = scope.extensions.filter((extension) => extension.status === 'PENDING');
  const decided = scope.extensions.filter((extension) => extension.status !== 'PENDING');
  const extensionRow = (extension: Incident['scope']['extensions'][number]): string =>
    `<li class="inc-ext" data-extension="${esc(extension.id)}"><div class="row">${tag(extension.status, label(s.extStatus, extension.status))}<b>${esc(label(i.extensionKinds, extension.kind))}</b><code>${esc(extension.target)}</code>${extension.applicationId ? `<small class="mu">${esc(s.inApplication(extension.applicationId))}</small>` : ''}</div><p class="mu">${esc(extension.reason)}</p><small class="mu">${esc(
      extension.decidedAt
        ? s.decidedBy(extension.decidedBy ?? '—', formatDate(extension.decidedAt, state.t.locale))
        : s.requestedBy(extension.requestedBy, formatDate(extension.requestedAt, state.t.locale)),
    )}</small>${
      extension.status === 'PENDING' && decider && incident.state !== 'CANCELLED'
        ? `<div class="row-acts">${actionButton(ui, 'inc-ext-approve', s.approve, { primary: true, extra: `data-block="${esc(extension.id)}"` })}${actionButton(ui, 'inc-ext-reject', s.reject, { extra: `data-block="${esc(extension.id)}"` })}</div>`
        : ''
    }</li>`;
  const extensions = `<section class="card" aria-labelledby="inc-ext-t"><h2 id="inc-ext-t">${esc(s.extensions)}</h2>${
    pending.length === 0
      ? `<p class="mu">${esc(s.noPending)}</p>`
      : `<ul class="plain">${pending.map(extensionRow).join('')}</ul>`
  }${pending.length > 0 && !decider ? `<p class="mu">${esc(s.decideRight)}</p>` : ''}${
    decided.length > 0
      ? `<details><summary>${esc(s.decided(decided.length))}</summary><ul class="plain">${decided.map(extensionRow).join('')}</ul></details>`
      : ''
  }${editable ? extensionForm(state, ui, incident) : ''}</section>`;
  const validation = ui.validation
    ? ui.validation.ok
      ? `<p class="ok-t" role="status">${icon('check')}<span>${esc(s.valid)}</span></p>`
      : `<div role="alert"><p class="err"><b>${esc(s.invalid(ui.validation.issues.length))}</b></p><ul class="checks">${ui.validation.issues.map((issue) => `<li class="ko">${icon('cross')}<span><code>${esc(issue.field)}</code> ${esc(issue.message)}</span></li>`).join('')}</ul></div>`
    : '';
  const head = `<div class="card-h"><h2>${esc(s.title)}</h2><div class="row-acts">${
    runner ? actionButton(ui, 'inc-validate', s.validate, { disabled: incident.state === 'CANCELLED' }) : ''
  }${editable && !ui.scopeForm ? actionButton(ui, 'inc-scope-edit', s.edit) : ''}</div></div>`;
  const draft =
    incident.state === 'DRAFT' ? `<p class="note">${icon('info')}<span>${esc(s.draftHint)}</span></p>` : '';
  const body = ui.scopeForm
    ? scopeEditor(state, ui)
    : `${facts}<h3>${esc(s.applications)}</h3>${apps}<h3>${esc(s.permissions)}</h3>${permissions}<h3>${esc(s.limits)}</h3>${limitsBox}`;
  return `<section class="card wide">${head}${draft}${validation}${body}</section>${extensions}`;
}

function scopeEditor(state: DashboardState, ui: IncidentsUi): string {
  const i = state.t.inc;
  const s = i.scope;
  const form = ui.scopeForm;
  if (!form) return '';
  const apps =
    form.applications.length === 0
      ? `<p class="mu">${esc(s.noApplication)}</p>`
      : `<ul class="plain">${form.applications
          .map(
            (app, index) =>
              `<li class="row inc-app"><b>${esc(app.name)}</b><code>${esc(app.id)}</code><span class="mu">${esc(label(i.layers, app.layer))}</span><code>${esc(app.repository.root)}</code><button type="button" class="btn ghost small push" data-action="inc-app-remove" data-index="${String(index)}" aria-label="${esc(s.removeApp(app.name))}">${icon('trash')}<span>${esc(s.remove)}</span></button></li>`,
          )
          .join('')}</ul>`;
  const app = form.app;
  const appForm = `<fieldset class="inc-app-form"><legend>${esc(s.addApplication)}</legend><div class="fields">${textField('app.id', s.appId, app.id, { mono: true })}${textField('app.name', s.appName, app.name)}${selectField(
    'app.layer',
    s.layer,
    app.layer,
    CODE_LAYERS.map((layer) => ({ value: layer, text: label(i.layers, layer) })),
  )}${textField('app.root', s.repository, app.root, { mono: true, hint: s.rootHint })}${textField('app.include', s.include, app.include, { mono: true, hint: s.includeHint })}${textField('app.classes', s.classes, app.classes, { mono: true, hint: s.classesHint })}${textField('app.baseUrl', s.baseUrl, app.baseUrl, { mono: true })}</div>${
    form.appError ? `<p class="err" role="alert">${esc(label(s.appProblem, form.appError))}</p>` : ''
  }<div class="form-acts start"><button type="button" class="btn" data-action="inc-app-add">${icon('plus')}<span>${esc(s.addApplication)}</span></button></div></fieldset>`;
  return `<form class="col inc-form" data-action="inc-scope-save" novalidate>
<div class="fields">${selectField(
    'scope.mode',
    s.mode,
    form.mode,
    SCOPE_MODES.map((mode) => ({ value: mode, text: label(i.modes, mode) })),
  )}<label class="field" for="inc-f-scope.depth">${esc(s.depth)}<input id="inc-f-scope.depth" data-inc="scope.depth" type="number" min="1" max="5" step="1" value="${esc(form.depth)}" aria-describedby="inc-f-scope.depth-h"></label></div>
<small id="inc-f-scope.depth-h" class="mu">${esc(s.depthHint)}</small>
<div class="fields">${textField('scope.scenarios', s.scenarios, form.scenarios, { area: true, hint: s.onePerLine })}${textField('scope.steps', s.steps, form.steps, { hint: s.stepsHint })}</div>
<div class="fields">${textField('scope.endpoints', s.endpoints, form.endpoints, { area: true, mono: true, hint: s.endpointsHint })}${textField('scope.allowedHosts', s.hosts, form.allowedHosts, { area: true, mono: true, hint: s.onePerLine })}</div>
<h3>${esc(s.applications)}</h3>${apps}${appForm}
<p class="mu">${esc(s.policyNote)}</p>
<div class="form-acts start"><button type="submit" class="btn primary" ${ui.busy !== undefined ? 'disabled' : ''} aria-busy="${String(ui.busy === 'inc-scope-save')}">${esc(s.save)}</button><button type="button" class="btn ghost" data-action="inc-scope-cancel">${esc(state.t.cancelAction)}</button></div>
</form>`;
}

function extensionForm(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const i = state.t.inc;
  const s = i.scope;
  const form = ui.extension;
  const invalid = new Set(ui.invalid ?? []);
  return `<form class="col inc-form" data-action="inc-ext-request" novalidate><h3>${esc(s.requestTitle)}</h3><p class="mu">${esc(s.requestSub)}</p><div class="fields">${selectField(
    'ext.kind',
    s.extKind,
    form.kind,
    SCOPE_EXTENSION_KINDS.map((kind) => ({ value: kind, text: label(i.extensionKinds, kind) })),
  )}${textField('ext.target', s.extTarget, form.target, { required: true, mono: true, hint: label(s.targetHints, form.kind), invalid: invalid.has('ext.target') })}${selectField(
    'ext.applicationId',
    s.application,
    form.applicationId,
    [
      { value: '', text: s.noApplicationChoice },
      ...incident.scope.applications.map((app) => ({ value: app.id, text: app.name })),
    ],
  )}</div>${textField('ext.reason', s.extReason, form.reason, { required: true, area: true, invalid: invalid.has('ext.reason') })}${invalid.has('ext.target') || invalid.has('ext.reason') ? `<p class="err" role="alert">${esc(i.form.required)}</p>` : ''}<div class="form-acts start"><button type="submit" class="btn" ${ui.busy !== undefined ? 'disabled' : ''} aria-busy="${String(ui.busy === 'inc-ext-request')}">${esc(s.request)}</button></div></form>`;
}
