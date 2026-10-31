import type { IncidentScopeValidation } from '../core/client.js';
import type { ProjectDetail } from '../core/contracts.js';
import {
  EXECUTION_TARGETS,
  EXPERIMENT_KINDS,
  INCIDENT_SEVERITIES,
  SCOPE_EXTENSION_KINDS,
  SCOPE_MODES,
  type CodeLayer,
  type EnvironmentCapabilities,
  type ExecutionTarget,
  type Experiment,
  type ExperimentKind,
  type GraphNode,
  type Hypothesis,
  type Incident,
  type IncidentInput,
  type IncidentSeverity,
  type IncidentState,
  type IncidentSummary,
  type InvestigationGraph,
  type InvestigationReport,
  type InvestigationScope,
  type ProposedVerification,
  type RegressionTestProposal,
  type RelationStatus,
  type ReproductionRun,
  type ScopeApplication,
  type ScopeExtensionKind,
  type ScopeMode,
} from '../core/incident-contracts.js';
import { can } from './dashboard-access.js';
import { formatDate, header, icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LES ÉCRANS INCIDENTS : la liste, la déclaration, puis la page d'un incident par onglets (périmètre,
 * environnement, reproduction, chronologie, graphe, code, hypothèses, vérifications, diagnostic,
 * rapport, non-régression). Des fonctions pures, de l'état vers le HTML échappé : tout vient du
 * serveur. Une relation montre toujours son statut (observée, lue dans le code, déduite, inconnue) ;
 * un test de non-régression n'est dit réussi que sur le résultat d'une exécution réelle.
 */
export const INCIDENT_TABS = [
  'scope',
  'environment',
  'reproduction',
  'timeline',
  'graph',
  'code',
  'hypotheses',
  'experiments',
  'diagnosis',
  'report',
  'regression',
] as const;
export type IncidentTab = (typeof INCIDENT_TABS)[number];

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

export interface ExperimentForm {
  kind: ExperimentKind;
  hypothesisId: string;
  /** Une ligne `clé=valeur` par paramètre. */
  params: string;
}

export interface IncidentsUi {
  list?: IncidentSummary[];
  /** L'incident ouvert, tel que lu (sa révision sert aux modifications). */
  incident?: Incident;
  capabilities?: EnvironmentCapabilities;
  capabilitiesError?: string;
  validation?: IncidentScopeValidation;
  report?: InvestigationReport;
  reportError?: string;
  form?: IncidentForm;
  scopeForm?: ScopeForm;
  extension: ExtensionForm;
  experiment: ExperimentForm;
  /** La vérification avec effets de bord en attente d'une approbation explicite dans la page. */
  approving?: string;
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
}

export const emptyExtensionForm = (): ExtensionForm => ({
  kind: 'ADD_PATH',
  target: '',
  applicationId: '',
  reason: '',
});

export const emptyExperimentForm = (): ExperimentForm => ({ kind: 'REPLAY', hypothesisId: '', params: '' });

export const emptyIncidentsUi = (): IncidentsUi => ({
  extension: emptyExtensionForm(),
  experiment: emptyExperimentForm(),
  confirmCancel: false,
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

/** Les paramètres d'une vérification saisis `clé=valeur` (booléens et nombres reconnus, listes avec « | »). */
export function parseParams(text: string): ProposedVerification['params'] {
  const params: ProposedVerification['params'] = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    if (!key) continue;
    params[key] =
      raw === 'true'
        ? true
        : raw === 'false'
          ? false
          : raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)
            ? Number(raw)
            : raw.includes('|')
              ? raw
                  .split('|')
                  .map((entry) => entry.trim())
                  .filter(Boolean)
              : raw;
  }
  return params;
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

/** L'investigation avance-t-elle (analyse, vérifications, diagnostic) dans cet état ? */
export const canInvestigate = (incident: Pick<Incident, 'state'>): boolean =>
  incident.state !== 'DRAFT' &&
  incident.state !== 'REPRODUCING' &&
  incident.state !== 'CANCELLED' &&
  incident.state !== 'FAILED';

/** L'incident change-t-il sur le serveur sans action de la page (reproduction, vérification en cours) ? */
export const needsPolling = (incident: Incident | undefined): boolean =>
  incident !== undefined &&
  (incident.state === 'REPRODUCING' ||
    incident.investigation.experiments.some((experiment) => experiment.status === 'RUNNING'));

/** Le verdict d'un test de non-régression : jamais « réussi » sans résultat d'exécution réel. */
export function regressionVerdict(
  proposal: Pick<RegressionTestProposal, 'execution'> | undefined,
): 'NOT_RUN' | 'PASSED' | 'FAILED' {
  const execution = proposal?.execution;
  if (!execution) return 'NOT_RUN';
  return execution.passed ? 'PASSED' : 'FAILED';
}

export const latestReproduction = (incident: Incident): ReproductionRun | undefined =>
  incident.investigation.reproductions.at(-1);

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

const percent = (value: number): string => `${String(Math.round(Math.max(0, Math.min(1, value)) * 100))} %`;

const where = (file: string | undefined, line: number | undefined): string =>
  file ? `<code>${esc(line !== undefined ? `${file}:${String(line)}` : file)}</code>` : '';

const listOrNone = (items: string[], none: string): string =>
  items.length === 0
    ? `<p class="mu">${esc(none)}</p>`
    : `<ul class="plain tight">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;

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

export function incidentsView(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const route = state.route;
  if (route.view !== 'incidents') return '';
  const project = state.project;
  const list = ui.list;
  const runner = can(state, 'RUN');
  const actions = `<button class="btn icon-only" data-action="inc-refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>${
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
  return `${top}${messages(state, ui)}${readOnly}${form}<section class="card wide">${table}</section>`;
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

// ── La page d'un incident ────────────────────────────────────────────────────────────────────

export function incidentView(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const route = state.route;
  if (route.view !== 'incident') return '';
  const back: [string, string] = ['incidents', t.nav.incidents];
  const incident = ui.incident;
  if (incident?.id !== route.incidentId)
    return `${header(`${esc(i.incident)} <code>${esc(route.incidentId)}</code>`, { back })}${messages(state, ui)}<section class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const tab: IncidentTab = route.tab ?? 'scope';
  const runner = can(state, 'RUN');
  const cancelControl =
    !runner || incident.state === 'CANCELLED'
      ? ''
      : ui.confirmCancel
        ? `<span class="confirm" role="group" aria-label="${esc(i.cancelInvestigation)}"><small>${esc(i.cancelHint)}</small><button class="btn danger" data-action="inc-cancel-yes" ${ui.busy !== undefined ? 'disabled' : ''}>${esc(i.cancelConfirm)}</button><button class="btn ghost" data-action="inc-cancel-no">${esc(t.cancelAction)}</button></span>`
        : actionButton(ui, 'inc-cancel', i.cancelInvestigation);
  const resume =
    runner && incident.state === 'CANCELLED'
      ? actionButton(ui, 'inc-resume', i.resume, { primary: true })
      : '';
  const actions = `<button class="btn icon-only" data-action="inc-refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>${resume}${cancelControl}`;
  const title = `${esc(incident.title)} ${tag(incident.state, label(i.states, incident.state))} ${tag(incident.severity, label(i.severities, incident.severity))}`;
  const sub = esc(
    i.pageSub(
      incident.id,
      incident.scenario ?? '—',
      label(i.targets, incident.execution.target),
      formatDate(incident.updatedAt, t.locale),
    ),
  );
  const counts = incidentCounts(incident);
  const tabs = `<div class="tabs inc-tabs" role="tablist" aria-label="${esc(i.tabsLabel)}">${INCIDENT_TABS.map(
    (key) =>
      `<button role="tab" id="inc-tab-${key}" data-action="inc-tab" data-tab="${key}" aria-selected="${key === tab ? 'true' : 'false'}" aria-controls="inc-panel" tabindex="${key === tab ? '0' : '-1'}">${esc(i.tabs[key])}${counts[key] !== undefined ? ` <span class="inc-count">${String(counts[key])}</span>` : ''}</button>`,
  ).join('')}</div>`;
  const facts = `<section class="card wide inc-facts" aria-label="${esc(i.facts)}"><dl class="inc-dl"><div><dt>${esc(i.form.observed)}</dt><dd>${esc(incident.observed)}</dd></div><div><dt>${esc(i.form.expected)}</dt><dd>${esc(incident.expected)}</dd></div>${incident.description ? `<div class="wide"><dt>${esc(i.form.description)}</dt><dd>${esc(incident.description)}</dd></div>` : ''}</dl>${runner ? '' : `<p class="note">${icon('info')}<span>${esc(i.readOnly)}</span></p>`}</section>`;
  const panel = `<div id="inc-panel" role="tabpanel" aria-labelledby="inc-tab-${tab}" class="col inc-panel">${tabBody(state, ui, incident, tab)}</div>`;
  return `${header(title, { back, sub, actions })}${messages(state, ui)}${facts}${tabs}${panel}`;
}

function incidentCounts(incident: Incident): Partial<Record<IncidentTab, number>> {
  const inv = incident.investigation;
  const pending = incident.scope.extensions.filter((extension) => extension.status === 'PENDING').length;
  return {
    ...(pending > 0 ? { scope: pending } : {}),
    ...(inv.reproductions.length > 0 ? { reproduction: inv.reproductions.length } : {}),
    ...(inv.hypotheses.length > 0 ? { hypotheses: inv.hypotheses.length } : {}),
    ...(inv.experiments.length > 0 ? { experiments: inv.experiments.length } : {}),
  };
}

function tabBody(state: DashboardState, ui: IncidentsUi, incident: Incident, tab: IncidentTab): string {
  switch (tab) {
    case 'scope':
      return scopeTab(state, ui, incident);
    case 'environment':
      return environmentTab(state, ui, incident);
    case 'reproduction':
      return reproductionTab(state, ui, incident);
    case 'timeline':
      return timelineTab(state, ui, incident);
    case 'graph':
      return graphTab(state, incident);
    case 'code':
      return codeTab(state, incident);
    case 'hypotheses':
      return hypothesesTab(state, ui, incident);
    case 'experiments':
      return experimentsTab(state, ui, incident);
    case 'diagnosis':
      return diagnosisTab(state, ui, incident);
    case 'report':
      return reportTab(state, ui);
    case 'regression':
      return regressionTab(state, ui, incident);
  }
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

// ── Environnement ────────────────────────────────────────────────────────────────────────────

function environmentTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const i = state.t.inc;
  const e = i.env;
  const execution = incident.execution;
  const environment = state.project?.environments.find((entry) => entry.id === incident.environmentId);
  const details: string[] = [];
  if (execution.remote?.openshift)
    details.push(
      `<div><dt>${esc(e.namespace)}</dt><dd><code>${esc(execution.remote.openshift.namespace)}</code></dd></div>`,
    );
  if (execution.aro)
    details.push(
      `<div><dt>${esc(e.namespace)}</dt><dd><code>${esc(execution.aro.namespace)}</code></dd></div>`,
      `<div><dt>${esc(e.serviceAccount)}</dt><dd><code>${esc(execution.aro.serviceAccount)}</code></dd></div>`,
      `<div><dt>${esc(e.image)}</dt><dd><code>${esc(execution.aro.image)}</code></dd></div>`,
      `<div><dt>${esc(e.mount)}</dt><dd><code>${esc(execution.aro.repositoriesMount)}</code></dd></div>`,
    );
  const config = `<section class="card"><h2>${esc(e.target)}</h2><dl class="inc-dl"><div><dt>${esc(e.target)}</dt><dd><b>${esc(label(i.targets, execution.target))}</b><small class="mu block">${esc(label(i.targetHints, execution.target))}</small></dd></div><div><dt>${esc(e.projectEnvironment)}</dt><dd>${environment ? `${esc(environment.name)} <code>${esc(environment.baseUrl)}</code>` : esc(incident.environmentId ?? e.firstEnvironment)}</dd></div>${details.join('')}</dl></section>`;
  const caps = ui.capabilities;
  const capsCard = caps
    ? `<section class="card"><div class="card-h"><h2>${esc(e.capabilities)}</h2>${actionButton(ui, 'inc-capabilities', e.reread)}</div><dl class="inc-dl"><div><dt>${esc(e.playwright)}</dt><dd>${esc(label(e.playwrightKinds, caps.playwright))}</dd></div><div><dt>${esc(e.repositories)}</dt><dd>${esc(label(e.repositoryKinds, caps.repositories))}</dd></div><div><dt>${esc(e.tests)}</dt><dd>${esc(caps.tests ? e.available : e.unavailable)}</dd></div><div><dt>${esc(e.logs)}</dt><dd>${esc(label(e.logKinds, caps.logs))}</dd></div><div><dt>${esc(e.jobs)}</dt><dd>${esc(caps.kubernetesJobs ? e.available : e.unavailable)}</dd></div></dl>${
        caps.limitations.length === 0
          ? `<p class="ok-t">${icon('check')}<span>${esc(e.noLimitation)}</span></p>`
          : `<h3>${esc(e.limitations)}</h3><ul class="checks">${caps.limitations.map((entry) => `<li class="ko">${icon('alert')}<span>${esc(entry)}</span></li>`).join('')}</ul>`
      }</section>`
    : ui.capabilitiesError
      ? `<section class="card" role="alert"><h2>${esc(e.capabilities)}</h2><p class="err">${esc(ui.capabilitiesError)}</p>${actionButton(ui, 'inc-capabilities', e.reread)}</section>`
      : `<section class="card" aria-busy="true"><h2>${esc(e.capabilities)}</h2><p class="mu">${esc(state.t.loading)}</p></section>`;
  return `<div class="split">${config}${capsCard}</div>`;
}

// ── Reproduction ─────────────────────────────────────────────────────────────────────────────

function reproductionTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const t = state.t;
  const i = t.inc;
  const r = i.repro;
  const runs = incident.investigation.reproductions;
  const latest = runs.at(-1);
  const launchable = canReproduce(incident);
  const launch = can(state, 'RUN')
    ? `<div class="row-acts">${actionButton(ui, 'inc-reproduce', latest ? r.again : r.launch, { primary: true, disabled: !launchable })}${
        !launchable && incident.state !== 'REPRODUCING'
          ? `<small class="mu">${esc(incident.state === 'DRAFT' ? r.draft : r.notNow(label(i.states, incident.state)))}</small>`
          : ''
      }</div>`
    : '';
  const status =
    incident.state === 'REPRODUCING'
      ? `<p class="inc-running" aria-busy="true"><span class="spin sm" aria-hidden="true"></span><span>${esc(r.running)}</span></p>`
      : '';
  if (!latest)
    return `<section class="card wide"><div class="card-h"><h2>${esc(r.title)}</h2>${launch}</div>${status}<p class="mu">${esc(r.none)}</p></section>`;
  const verdict =
    latest.reproduced === true
      ? tag('REPRODUCED', r.reproduced)
      : latest.reproduced === false
        ? tag('NOT_REPRODUCED', r.notReproduced)
        : tag('UNKNOWN', r.noResult);
  const summary = `<dl class="inc-dl"><div><dt>${esc(r.status)}</dt><dd>${tag(latest.status, label(r.statuses, latest.status))} ${verdict}</dd></div><div><dt>${esc(r.scenario)}</dt><dd>${esc(latest.scenario)}</dd></div><div><dt>${esc(r.started)}</dt><dd>${esc(formatDate(latest.startedAt, t.locale))}${latest.finishedAt ? ` → ${esc(formatDate(latest.finishedAt, t.locale))}` : ''}</dd></div><div><dt>${esc(r.target)}</dt><dd>${esc(label(i.targets, latest.target))}${latest.baseUrl ? ` · <code>${esc(latest.baseUrl)}</code>` : ''}</dd></div>${latest.run ? `<div><dt>${esc(r.run)}</dt><dd><code>${esc(latest.run)}</code></dd></div>` : ''}${latest.symptomMatch ? `<div class="wide"><dt>${esc(r.match)}</dt><dd>${esc(latest.symptomMatch)}</dd></div>` : ''}</dl>${latest.error ? `<p class="err" role="alert">${esc(latest.error)}</p>` : ''}`;
  const actions =
    latest.actions.length === 0
      ? `<p class="mu">${esc(r.noAction)}</p>`
      : `<ol class="steps">${latest.actions
          .map(
            (action) =>
              `<li><span class="mu">${String(action.index)}</span><span>${esc(action.description)}${action.url ? `<small class="mu block">${esc(action.url)}</small>` : ''}</span>${tag(action.status === 'PASSED' || action.status === 'COMPLETED' ? 'COMPLETED' : action.status === 'FAILED' ? 'ERROR' : 'UNKNOWN', action.status)}${action.reason ? `<span class="why">${esc(action.reason)}</span>` : ''}</li>`,
          )
          .join('')}</ol>`;
  const requests =
    latest.requests.length === 0
      ? `<p class="mu">${esc(r.noRequest)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(r.col.request)}</th><th scope="col">${esc(r.col.status)}</th><th scope="col">${esc(r.col.step)}</th><th scope="col">${esc(r.col.correlation)}</th><th scope="col">${esc(r.col.duration)}</th></tr></thead><tbody>${latest.requests
          .map(
            (request) =>
              `<tr class="${request.status !== undefined && request.status >= 500 ? 'inc-ko' : ''}"><td><code>${esc(`${request.method} ${request.path}`)}</code>${request.responseBody ? `<details><summary>${esc(r.responseBody)}</summary><pre class="inc-pre">${esc(request.responseBody)}</pre></details>` : ''}</td><td>${request.status !== undefined ? `<b>${String(request.status)}</b>` : esc(request.failure ?? '—')}</td><td>${request.step !== undefined ? String(request.step) : '—'}</td><td>${tag(request.correlation, label(i.relations, request.correlation))}</td><td>${request.durationMs !== undefined ? esc(t.duration(request.durationMs)) : '—'}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  const evidence =
    latest.evidence.length === 0
      ? ''
      : `<h3>${esc(r.evidence)}</h3><ul class="plain tight">${latest.evidence.map((entry) => `<li>${tag('UNKNOWN', label(i.evidenceKinds, entry.kind))} ${esc(entry.summary)}</li>`).join('')}</ul>`;
  const files =
    latest.screenshots.length > 0 || latest.trace
      ? `<h3>${esc(r.artifacts)}</h3><ul class="plain tight">${latest.screenshots.map((shot) => `<li><code>${esc(shot)}</code></li>`).join('')}${latest.trace ? `<li>${esc(r.trace)} <code>${esc(latest.trace)}</code></li>` : ''}</ul>`
      : '';
  const previous =
    runs.length > 1
      ? `<details><summary>${esc(r.previous(runs.length - 1))}</summary><ul class="plain tight">${runs
          .slice(0, -1)
          .reverse()
          .map(
            (run) =>
              `<li>${esc(formatDate(run.startedAt, t.locale))} · ${tag(run.status, label(r.statuses, run.status))} ${run.reproduced === true ? esc(r.reproduced) : run.reproduced === false ? esc(r.notReproduced) : esc(r.noResult)}</li>`,
          )
          .join('')}</ul></details>`
      : '';
  return `<section class="card wide"><div class="card-h"><h2>${esc(r.title)}</h2>${launch}</div>${status}${summary}${previous}</section><section class="card wide"><h2>${esc(r.actions(latest.actions.length))}</h2>${actions}</section><section class="card wide"><h2>${esc(r.requests(latest.requests.length))}</h2>${requests}${evidence}${files}</section>`;
}

// ── Chronologie ──────────────────────────────────────────────────────────────────────────────

function timelineTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const t = state.t;
  const i = t.inc;
  const report = ui.report;
  const events = report
    ? report.timeline.length === 0
      ? `<p class="mu">${esc(i.timeline.empty)}</p>`
      : `<ol class="inc-timeline">${report.timeline
          .map(
            (entry) =>
              `<li><span class="mu inc-at">${entry.at ? esc(formatDate(entry.at, t.locale)) : '—'}</span><span>${tag('UNKNOWN', label(i.evidenceKinds, entry.kind))}${entry.step !== undefined ? ` <small class="mu">${esc(i.timeline.step(entry.step))}</small>` : ''}</span><span>${esc(entry.summary)}<small class="mu block"><code>${esc(entry.ref)}</code></small></span></li>`,
          )
          .join('')}</ol>`
    : ui.reportError
      ? `<p class="err" role="alert">${esc(ui.reportError)}</p>`
      : `<p class="mu" aria-busy="true">${esc(t.loading)}</p>`;
  const history = `<ol class="inc-timeline">${incident.history
    .map(
      (event) =>
        `<li><span class="mu inc-at">${esc(formatDate(event.at, t.locale))}</span><span>${tag('UNKNOWN', label(i.historyKinds, event.kind))}</span><span>${esc(event.message)}<small class="mu block">${esc(event.actor)}</small></span></li>`,
    )
    .join('')}</ol>`;
  return `<section class="card wide"><h2>${esc(i.timeline.title)}</h2><p class="mu">${esc(i.timeline.sub)}</p>${events}</section><section class="card wide"><h2>${esc(i.timeline.history)}</h2>${history}</section>`;
}

// ── Graphe ───────────────────────────────────────────────────────────────────────────────────

const NODE_W = 156;
const NODE_H = 40;
const COL_W = 196;
const ROW_H = 56;
const TOP = 40;
const LEFT = 12;
const COLUMNS = 7;

/** La colonne d'un nœud : incident et scénario, actions, frontend, BFF, appel sortant, backend, données. */
function columnOf(node: Pick<GraphNode, 'kind' | 'layer'>): number {
  switch (node.kind) {
    case 'INCIDENT':
    case 'SCENARIO':
      return 0;
    case 'ACTION':
      return 1;
    case 'REQUEST':
    case 'FRONTEND_CODE':
      return 2;
    case 'BFF_ENDPOINT':
    case 'BFF_SERVICE':
      return 3;
    case 'BACKEND_CALL':
      return 4;
    case 'BACKEND_ENDPOINT':
    case 'BACKEND_SERVICE':
      return 5;
    case 'REPOSITORY':
      return 6;
    case 'EXCEPTION':
      return node.layer === 'FRONTEND' ? 2 : node.layer === 'BFF' ? 4 : 6;
  }
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: (GraphNode & { x: number; y: number; column: number })[];
  edges: { from: string; to: string; status: RelationStatus; d: string }[];
  /** Les relations dont une extrémité manque au graphe (listées, jamais dessinées vers le vide). */
  dangling: number;
}

/** La disposition en couches : Incident → Frontend → BFF → Backend, de gauche à droite. */
export function graphLayout(graph: InvestigationGraph): GraphLayout {
  const rowsUsed = new Array<number>(COLUMNS).fill(0);
  const nodes = graph.nodes.map((node) => {
    const column = columnOf(node);
    const row = rowsUsed[column] ?? 0;
    rowsUsed[column] = row + 1;
    return { ...node, column, x: LEFT + column * COL_W, y: TOP + row * ROW_H };
  });
  const position = new Map(nodes.map((node) => [node.id, node]));
  let dangling = 0;
  const edges: GraphLayout['edges'] = [];
  for (const edge of graph.edges) {
    const a = position.get(edge.from);
    const b = position.get(edge.to);
    if (!a || !b) {
      dangling += 1;
      continue;
    }
    let d: string;
    if (a.column === b.column) {
      const down = b.y > a.y;
      const x = a.x + NODE_W / 2;
      const y1 = down ? a.y + NODE_H : a.y;
      const y2 = down ? b.y : b.y + NODE_H;
      d = `M${String(x)},${String(y1)} C${String(x + 28)},${String(y1)} ${String(x + 28)},${String(y2)} ${String(x)},${String(y2)}`;
    } else {
      const forward = b.column > a.column;
      const x1 = forward ? a.x + NODE_W : a.x;
      const x2 = forward ? b.x : b.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      d = `M${String(x1)},${String(y1)} C${String(mid)},${String(y1)} ${String(mid)},${String(y2)} ${String(x2)},${String(y2)}`;
    }
    edges.push({ from: edge.from, to: edge.to, status: edge.status, d });
  }
  const maxRows = Math.max(1, ...rowsUsed);
  return {
    width: LEFT * 2 + (COLUMNS - 1) * COL_W + NODE_W,
    height: TOP + maxRows * ROW_H,
    nodes,
    edges,
    dangling,
  };
}

const STATUS_CLASS: Record<RelationStatus, string> = {
  OBSERVED: 'e-obs',
  STATICALLY_RESOLVED: 'e-stat',
  INFERRED: 'e-inf',
  UNKNOWN: 'e-unk',
};

const shortLabel = (text: string): string => (text.length > 22 ? `${text.slice(0, 21)}…` : text);

function graphSvg(state: DashboardState, graph: InvestigationGraph): string {
  const g = state.t.inc.graph;
  const layout = graphLayout(graph);
  const bands: [number, number, string][] = [
    [0, 1, g.bands.incident],
    [2, 2, g.bands.frontend],
    [3, 4, g.bands.bff],
    [5, 6, g.bands.backend],
  ];
  const bandRects = bands
    .map(([from, to, text]) => {
      const x = LEFT + from * COL_W - 6;
      const width = (to - from) * COL_W + NODE_W + 12;
      return `<rect class="band" x="${String(x)}" y="4" width="${String(width)}" height="${String(layout.height - 8)}" rx="10"/><text class="band-t" x="${String(x + 10)}" y="24">${esc(text)}</text>`;
    })
    .join('');
  const markers = (Object.keys(STATUS_CLASS) as RelationStatus[])
    .map(
      (status) =>
        `<marker id="inc-m-${STATUS_CLASS[status]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk ${STATUS_CLASS[status]}"/></marker>`,
    )
    .join('');
  const edges = layout.edges
    .map(
      (edge) =>
        `<path class="edge ${STATUS_CLASS[edge.status]}" d="${edge.d}" marker-end="url(#inc-m-${STATUS_CLASS[edge.status]})"/>`,
    )
    .join('');
  const nodes = layout.nodes
    .map(
      (node) =>
        `<g class="gn n-${node.layer.toLowerCase()}"><title>${esc(`${label(state.t.inc.nodeKinds, node.kind)} · ${node.label}${node.file ? ` · ${node.file}${node.line !== undefined ? `:${String(node.line)}` : ''}` : ''}`)}</title><rect x="${String(node.x)}" y="${String(node.y)}" width="${String(NODE_W)}" height="${String(NODE_H)}" rx="8"/><text x="${String(node.x + 8)}" y="${String(node.y + 15)}" class="gk">${esc(label(state.t.inc.nodeKinds, node.kind))}</text><text x="${String(node.x + 8)}" y="${String(node.y + 31)}" class="gl">${esc(shortLabel(node.label))}</text></g>`,
    )
    .join('');
  return `<div class="inc-graph" tabindex="0" role="group" aria-label="${esc(g.scroll)}"><svg width="${String(layout.width)}" height="${String(layout.height)}" viewBox="0 0 ${String(layout.width)} ${String(layout.height)}" role="img" aria-labelledby="inc-graph-desc" xmlns="http://www.w3.org/2000/svg"><defs>${markers}</defs>${bandRects}${edges}${nodes}</svg></div>`;
}

function legend(state: DashboardState): string {
  const i = state.t.inc;
  return `<ul class="inc-legend" aria-label="${esc(i.graph.legend)}">${(
    Object.keys(STATUS_CLASS) as RelationStatus[]
  )
    .map(
      (status) =>
        `<li><svg width="36" height="10" aria-hidden="true"><path class="edge ${STATUS_CLASS[status]}" d="M2,5 L34,5"/></svg><b>${esc(label(i.relations, status))}</b><small class="mu">${esc(label(i.relationHints, status))}</small></li>`,
    )
    .join('')}</ul>`;
}

function graphTab(state: DashboardState, incident: Incident): string {
  const i = state.t.inc;
  const g = i.graph;
  const graph = incident.investigation.graph;
  if (!graph)
    return `<section class="card wide"><h2>${esc(g.title)}</h2><p class="mu">${esc(g.none)}</p>${legend(state)}</section>`;
  const count = (status: RelationStatus): number =>
    graph.edges.filter((edge) => edge.status === status).length;
  const caption = g.caption(
    graph.nodes.length,
    graph.edges.length,
    count('OBSERVED'),
    count('STATICALLY_RESOLVED'),
    count('INFERRED'),
    count('UNKNOWN'),
  );
  const labelOf = (id: string): string => graph.nodes.find((node) => node.id === id)?.label ?? id;
  const known = new Set(graph.nodes.map((node) => node.id));
  const table = `<div class="tw"><table class="tbl"><caption class="sr">${esc(g.relations)}</caption><thead><tr><th scope="col">${esc(g.from)}</th><th scope="col">${esc(g.to)}</th><th scope="col">${esc(g.status)}</th><th scope="col">${esc(g.reason)}</th><th scope="col">${esc(g.evidence)}</th></tr></thead><tbody>${graph.edges
    .map(
      (edge) =>
        `<tr><td>${esc(labelOf(edge.from))}</td><td>${known.has(edge.to) ? esc(labelOf(edge.to)) : `<span class="mu">${esc(g.missingNode(edge.to))}</span>`}</td><td>${tag(edge.status, label(i.relations, edge.status))}</td><td>${esc(edge.reason)}</td><td>${edge.evidence.length === 0 ? '<span class="mu">—</span>' : edge.evidence.map((ref) => `<code title="${esc(ref)}">${esc(shortRef(ref))}</code>`).join(' ')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
  return `<section class="card wide"><div class="card-h"><h2>${esc(g.title)}</h2></div><figure class="inc-fig"><figcaption id="inc-graph-desc" class="mu">${esc(caption)}</figcaption>${graphSvg(state, graph)}</figure>${legend(state)}<p class="note">${icon('info')}<span>${esc(g.staticNote)}</span></p></section><section class="card wide"><h2>${esc(g.relations)}</h2>${table}</section>`;
}

/** Une preuve, en court : la fin de son identifiant (fichier, symbole) ; l'identifiant complet en infobulle. */
export function shortRef(ref: string): string {
  return ref.split(/[/#]/).filter(Boolean).at(-1) ?? ref;
}

// ── Code ─────────────────────────────────────────────────────────────────────────────────────

const SYMBOLS_SHOWN = 200;

function codeTab(state: DashboardState, incident: Incident): string {
  const i = state.t.inc;
  const c = i.code;
  const code = incident.investigation.code;
  if (!code)
    return `<section class="card wide"><h2>${esc(c.title)}</h2><p class="mu">${esc(c.none)}</p></section>`;
  const apps = `<ul class="plain tight">${code.applications.map((app) => `<li><b>${esc(app.id)}</b> · ${esc(label(i.layers, app.layer))} · ${esc(c.files(app.files, app.skipped))}</li>`).join('')}</ul>`;
  const byLayer = CODE_LAYERS.map((layer) => {
    const symbols = code.symbols.filter((symbol) => symbol.layer === layer);
    if (symbols.length === 0) return '';
    const files = new Set(symbols.map((symbol) => symbol.file)).size;
    return `<section class="card wide" aria-labelledby="inc-code-${layer}"><h2 id="inc-code-${layer}">${esc(c.layerTitle(label(i.layers, layer), symbols.length, files))}</h2><div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(c.kind)}</th><th scope="col">${esc(c.name)}</th><th scope="col">${esc(c.file)}</th></tr></thead><tbody>${symbols
      .slice(0, SYMBOLS_SHOWN)
      .map(
        (symbol) =>
          `<tr><td>${esc(label(i.symbolKinds, symbol.kind))}</td><td><code>${esc(symbol.name)}</code></td><td>${where(symbol.file, symbol.line)}</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table></div>${symbols.length > SYMBOLS_SHOWN ? `<p class="mu">${esc(c.more(symbols.length - SYMBOLS_SHOWN))}</p>` : ''}</section>`;
  }).join('');
  const endpoints =
    code.endpoints.length === 0
      ? `<p class="mu">${esc(c.noEndpoint)}</p>`
      : `<ul class="plain tight">${code.endpoints.map((endpoint) => `<li><code>${esc(`${endpoint.method} ${endpoint.path}`)}</code> <small class="mu">${esc(label(i.layers, endpoint.layer))} · ${esc(endpoint.applicationId)}</small></li>`).join('')}</ul>`;
  const outgoing =
    code.outgoing.length === 0
      ? `<p class="mu">${esc(c.noOutgoing)}</p>`
      : `<ul class="plain tight">${code.outgoing.map((call) => `<li><code>${esc(`${call.method ?? '?'} ${call.path ?? '?'}`)}</code> ${tag(call.status, label(i.relations, call.status))} ${where(call.file, call.line)}</li>`).join('')}</ul>`;
  const denied =
    code.denied.length === 0
      ? `<p class="mu">${esc(c.noDenied)}</p>`
      : `<ul class="checks">${code.denied.map((entry) => `<li class="ko">${icon('cross')}<span><code>${esc(entry.path)}</code> ${esc(entry.reason)}</span></li>`).join('')}</ul>`;
  const truncated =
    code.truncated.length === 0
      ? ''
      : `<p class="note">${icon('alert')}<span>${esc(c.truncated)} ${esc(code.truncated.join(' · '))}</span></p>`;
  return `<section class="card wide"><h2>${esc(c.title)}</h2>${apps}${truncated}</section>${byLayer}<div class="split"><section class="card"><h2>${esc(c.endpoints)}</h2>${endpoints}</section><section class="card"><h2>${esc(c.outgoing)}</h2>${outgoing}</section></div><section class="card wide"><h2>${esc(c.denied)}</h2>${denied}</section>`;
}

// ── Hypothèses ───────────────────────────────────────────────────────────────────────────────

function hypothesesTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const i = state.t.inc;
  const h = i.hyp;
  const runner = can(state, 'RUN');
  const ready = canInvestigate(incident);
  const analyze = runner
    ? actionButton(ui, 'inc-analyze', incident.investigation.code ? h.reanalyze : h.analyze, {
        primary: incident.investigation.hypotheses.length === 0,
        disabled: !ready,
      })
    : '';
  const hint = !ready ? `<small class="mu">${esc(h.notReady)}</small>` : '';
  const list = incident.investigation.hypotheses;
  if (list.length === 0)
    return `<section class="card wide"><div class="card-h"><h2>${esc(h.title)}</h2><div class="row-acts">${analyze}${hint}</div></div><p class="mu">${esc(h.none)}</p></section>`;
  const facts = (items: Hypothesis['supporting'], none: string): string =>
    listOrNone(
      items.map((item) => `${esc(item.fact)} <small class="mu"><code>${esc(item.ref)}</code></small>`),
      none,
    );
  const cards = list
    .map((hypothesis) => {
      const verifications =
        hypothesis.verifications.length === 0
          ? `<p class="mu">${esc(h.noVerification)}</p>`
          : `<ul class="plain">${hypothesis.verifications
              .map(
                (verification, index) =>
                  `<li class="row"><span>${tag('PROPOSED', label(i.experimentKinds, verification.kind))} ${esc(verification.description)}</span>${
                    runner
                      ? `<button type="button" class="btn small push" data-action="inc-plan" data-block="${esc(hypothesis.id)}" data-index="${String(index)}" ${ui.busy !== undefined || !ready ? 'disabled' : ''}>${esc(h.plan)}</button>`
                      : ''
                  }</li>`,
              )
              .join('')}</ul>`;
      return `<li class="card inc-hyp" aria-labelledby="inc-h-${esc(hypothesis.id)}"><div class="card-h"><h3 id="inc-h-${esc(hypothesis.id)}">${esc(hypothesis.title)}</h3><span class="row">${tag(hypothesis.status, label(i.hypothesisStatus, hypothesis.status))}<span>${esc(label(i.layers, hypothesis.layer))}</span></span></div><p>${esc(hypothesis.description)}</p><p><b>${esc(h.cause)}</b> ${esc(hypothesis.suspectedCause)}</p><p class="inc-conf"><span>${esc(h.confidence)}</span><meter min="0" max="1" low="0.34" high="0.67" optimum="1" value="${String(hypothesis.confidence)}" aria-label="${esc(h.confidence)}">${esc(percent(hypothesis.confidence))}</meter><b>${esc(percent(hypothesis.confidence))}</b></p>${
        hypothesis.files.length > 0
          ? `<p>${hypothesis.files.map((file) => `<code>${esc(file)}</code>`).join(' ')}</p>`
          : ''
      }<div class="split"><div><h4>${esc(h.supporting(hypothesis.supporting.length))}</h4>${facts(hypothesis.supporting, h.noneFact)}</div><div><h4>${esc(h.contradicting(hypothesis.contradicting.length))}</h4>${facts(hypothesis.contradicting, h.noneFact)}</div></div><h4>${esc(h.verifications)}</h4>${verifications}</li>`;
    })
    .join('');
  return `<section class="card wide"><div class="card-h"><h2>${esc(h.title)}</h2><div class="row-acts">${analyze}${hint}</div></div><p class="mu">${esc(h.sub)}</p></section><ul class="plain inc-hyps">${cards}</ul>`;
}

// ── Vérifications ────────────────────────────────────────────────────────────────────────────

function experimentsTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const i = state.t.inc;
  const x = i.exp;
  const runner = can(state, 'RUN');
  const ready = canInvestigate(incident);
  const list = incident.investigation.experiments;
  const titleOf = (id: string | undefined): string =>
    incident.investigation.hypotheses.find((hypothesis) => hypothesis.id === id)?.title ?? '';
  const cards = list
    .map((experiment) => experimentCard(state, ui, incident, experiment, titleOf(experiment.hypothesisId)))
    .join('');
  const plan = runner && ready ? planForm(state, ui, incident) : '';
  return `<section class="card wide"><h2>${esc(x.title)}</h2><p class="mu">${esc(x.sub)}</p>${list.length === 0 ? `<p class="mu">${esc(x.none)}</p>` : ''}${!incident.scope.permissions.sideEffects ? `<p class="mu">${esc(x.noSideEffects)}</p>` : ''}</section>${list.length > 0 ? `<ul class="plain inc-exps">${cards}</ul>` : ''}${plan}`;
}

function experimentCard(
  state: DashboardState,
  ui: IncidentsUi,
  incident: Incident,
  experiment: Experiment,
  hypothesis: string,
): string {
  const t = state.t;
  const i = t.inc;
  const x = i.exp;
  const runner = can(state, 'RUN');
  const refusals = experiment.decisions.filter((decision) => !decision.allowed);
  const runnable =
    runner &&
    canInvestigate(incident) &&
    (experiment.status === 'PROPOSED' || experiment.status === 'APPROVAL_REQUIRED');
  const needsApproval = experiment.sideEffects || experiment.status === 'APPROVAL_REQUIRED';
  const id = esc(experiment.id);
  const control = !runnable
    ? ''
    : ui.approving === experiment.id
      ? approvalPanel(state, ui, incident, experiment)
      : `<div class="row-acts">${actionButton(ui, 'inc-run', needsApproval ? x.review : x.run, { primary: !needsApproval, extra: `data-block="${id}"` })}</div>`;
  const decisions =
    refusals.length === 0
      ? ''
      : `<div class="inc-refused" role="note"><b>${esc(x.refused(refusals.length))}</b><ul class="checks">${refusals.map((decision) => `<li class="ko">${icon('cross')}<span>${esc(decision.reason)} <small class="mu">${esc(decision.rule)}</small></span></li>`).join('')}</ul></div>`;
  const evidence =
    experiment.evidence.length === 0
      ? ''
      : `<details><summary>${esc(x.evidence(experiment.evidence.length))}</summary><ul class="plain tight">${experiment.evidence.map((entry) => `<li>${tag('UNKNOWN', label(i.evidenceKinds, entry.kind))} ${esc(entry.summary)}</li>`).join('')}</ul></details>`;
  const params = Object.entries(experiment.params);
  return `<li class="card inc-exp" data-experiment="${id}"><div class="card-h"><h3>${esc(label(i.experimentKinds, experiment.kind))}</h3><span class="row">${tag(experiment.status, label(i.experimentStatus, experiment.status))}${experiment.sideEffects ? tag('APPROVAL_REQUIRED', x.sideEffects) : ''}${experiment.outcome ? tag(experiment.outcome, label(x.outcomes, experiment.outcome)) : ''}</span></div><p>${esc(experiment.description)}</p>${hypothesis ? `<p class="mu">${esc(x.forHypothesis(hypothesis))}</p>` : ''}${
    params.length > 0
      ? `<p class="inc-params">${params.map(([key, value]) => `<code>${esc(`${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)}</code>`).join(' ')}</p>`
      : ''
  }${experiment.summary ? `<p><b>${esc(x.result)}</b> ${esc(experiment.summary)}</p>` : ''}${experiment.approvedBy ? `<p class="mu">${esc(x.approvedBy(experiment.approvedBy))}</p>` : ''}${decisions}${evidence}${control}</li>`;
}

/** L'approbation explicite d'une vérification avec effets de bord : dans la page, jamais une boîte du navigateur. */
function approvalPanel(
  state: DashboardState,
  ui: IncidentsUi,
  incident: Incident,
  experiment: Experiment,
): string {
  const x = state.t.inc.exp;
  const id = esc(experiment.id);
  const writer = can(state, 'RUN_WRITES');
  return `<div class="inc-approve" role="group" aria-labelledby="inc-ap-${id}"><h4 id="inc-ap-${id}">${icon('alert')}<span>${esc(x.approveTitle)}</span></h4><p>${esc(x.approveText)}</p>${
    incident.scope.permissions.sideEffects
      ? ''
      : `<p class="note">${icon('info')}<span>${esc(x.scopeForbids)}</span></p>`
  }${writer ? '' : `<p class="note">${icon('info')}<span>${esc(x.writesRight)}</span></p>`}<div class="row-acts">${
    writer
      ? actionButton(ui, 'inc-approve-yes', x.approveRun, { danger: true, extra: `data-block="${id}"` })
      : ''
  }<button type="button" class="btn ghost" data-action="inc-approve-no" data-block="${id}">${esc(state.t.cancelAction)}</button></div></div>`;
}

function planForm(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const i = state.t.inc;
  const x = i.exp;
  const form = ui.experiment;
  return `<section class="card wide"><form class="col inc-form" data-action="inc-plan-form" novalidate><h2>${esc(x.planTitle)}</h2><div class="fields">${selectField(
    'exp.kind',
    x.kind,
    form.kind,
    EXPERIMENT_KINDS.map((kind) => ({ value: kind, text: label(i.experimentKinds, kind) })),
  )}${selectField('exp.hypothesisId', x.hypothesis, form.hypothesisId, [
    { value: '', text: x.noHypothesis },
    ...incident.investigation.hypotheses.map((hypothesis) => ({
      value: hypothesis.id,
      text: hypothesis.title,
    })),
  ])}</div>${textField('exp.params', x.params, form.params, { area: true, mono: true, hint: x.paramsHint })}<div class="form-acts start"><button type="submit" class="btn" ${ui.busy !== undefined ? 'disabled' : ''} aria-busy="${String(ui.busy === 'inc-plan-form')}">${esc(x.plan)}</button></div></form></section>`;
}

// ── Diagnostic ───────────────────────────────────────────────────────────────────────────────

function diagnosisTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const t = state.t;
  const i = t.inc;
  const d = i.diag;
  const diagnosis = incident.investigation.diagnosis;
  const action = can(state, 'RUN')
    ? actionButton(ui, 'inc-diagnose', diagnosis ? d.again : d.run, {
        primary: !diagnosis,
        disabled: !canInvestigate(incident) || incident.investigation.hypotheses.length === 0,
      })
    : '';
  if (!diagnosis)
    return `<section class="card wide"><div class="card-h"><h2>${esc(d.title)}</h2>${action}</div><p class="mu">${esc(incident.investigation.hypotheses.length === 0 ? d.needHypotheses : d.none)}</p></section>`;
  const root = diagnosis.rootCause;
  return `<section class="card wide"><div class="card-h"><h2>${esc(d.title)}</h2>${action}</div><p class="row">${tag(diagnosis.status, label(i.diagnosisStatus, diagnosis.status))}<small class="mu">${esc(d.generated(formatDate(diagnosis.generatedAt, t.locale)))}</small></p><p class="mu">${esc(label(d.statusHints, diagnosis.status))}</p>${
    root
      ? `<div class="inc-root"><h3>${esc(d.rootCause)}</h3><p><b>${esc(root.statement)}</b></p><p class="mu">${esc(label(i.layers, root.layer))}</p>${root.files.length > 0 ? `<p>${root.files.map((file) => `<code>${esc(file)}</code>`).join(' ')}</p>` : ''}</div>`
      : `<p class="mu">${esc(d.noRootCause)}</p>`
  }<h3>${esc(d.alternatives)}</h3>${listOrNone(
    diagnosis.alternatives.map(
      (entry) => `${esc(entry.statement)} <small class="mu">${esc(percent(entry.confidence))}</small>`,
    ),
    d.noneItem,
  )}<h3>${esc(d.missing)}</h3>${listOrNone(
    diagnosis.missing.map((entry) => esc(entry)),
    d.noneItem,
  )}<h3>${esc(d.recommendations)}</h3>${listOrNone(
    diagnosis.recommendations.map((entry) => esc(entry)),
    d.noneItem,
  )}</section>`;
}

// ── Rapport ──────────────────────────────────────────────────────────────────────────────────

function reportTab(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const r = i.report;
  const report = ui.report;
  const exports = `<div class="row-acts">${actionButton(ui, 'inc-export-json', r.exportJson, { extra: 'data-format="json"' })}${actionButton(ui, 'inc-export-markdown', r.exportMarkdown, { extra: 'data-format="markdown"' })}${actionButton(ui, 'inc-report', r.reread)}</div>`;
  if (!report)
    return `<section class="card wide"><div class="card-h"><h2>${esc(r.title)}</h2>${exports}</div>${ui.reportError ? `<p class="err" role="alert">${esc(ui.reportError)}</p>` : `<p class="mu" aria-busy="true">${esc(t.loading)}</p>`}</section>`;
  const failing = report.requests.filter((request) => request.status !== undefined && request.status >= 400);
  return `<section class="card wide"><div class="card-h"><h2>${esc(r.title)}</h2>${exports}</div><p class="mu">${esc(r.generated(formatDate(report.generatedAt, t.locale)))}</p><dl class="inc-dl"><div><dt>${esc(r.state)}</dt><dd>${tag(report.incident.state, label(i.states, report.incident.state))}</dd></div><div><dt>${esc(r.target)}</dt><dd>${esc(label(i.targets, report.environment.execution.target))}${report.environment.baseUrl ? ` · <code>${esc(report.environment.baseUrl)}</code>` : ''}</dd></div><div><dt>${esc(r.scenario)}</dt><dd>${esc(report.scenario ?? '—')}</dd></div><div><dt>${esc(r.diagnosis)}</dt><dd>${report.diagnosis ? tag(report.diagnosis.status, label(i.diagnosisStatus, report.diagnosis.status)) : '—'}</dd></div></dl><div class="tiles"><div class="tile"><b>${String(report.timeline.length)}</b><span>${esc(r.timeline)}</span></div><div class="tile${failing.length > 0 ? ' ko' : ''}"><b>${String(failing.length)}</b><span>${esc(r.failing(report.requests.length))}</span></div><div class="tile"><b>${String(report.code.files.length)}</b><span>${esc(r.files)}</span></div><div class="tile"><b>${String(report.hypotheses.length)}</b><span>${esc(r.hypotheses)}</span></div><div class="tile"><b>${String(report.experiments.length)}</b><span>${esc(r.experiments)}</span></div></div>${
    report.diagnosis?.rootCause
      ? `<h3>${esc(i.diag.rootCause)}</h3><p>${esc(report.diagnosis.rootCause.statement)}</p>`
      : ''
  }<h3>${esc(r.limitations)}</h3>${listOrNone(
    report.limitations.map((entry) => esc(entry)),
    r.noLimitation,
  )}</section>`;
}

// ── Non-régression ───────────────────────────────────────────────────────────────────────────

function regressionTab(state: DashboardState, ui: IncidentsUi, incident: Incident): string {
  const t = state.t;
  const i = t.inc;
  const g = i.reg;
  const proposal = incident.investigation.regression;
  const runner = can(state, 'RUN');
  const ready = canInvestigate(incident);
  const propose = runner
    ? actionButton(ui, 'inc-reg-propose', proposal ? g.proposeAgain : g.propose, {
        primary: !proposal,
        disabled: !ready || !incident.scenario,
      })
    : '';
  if (!proposal)
    return `<section class="card wide"><div class="card-h"><h2>${esc(g.title)}</h2>${propose}</div><p class="mu">${esc(incident.scenario ? g.none : g.noScenario)}</p></section>`;
  const verdict = regressionVerdict(proposal);
  const execution = proposal.execution;
  const result =
    verdict === 'NOT_RUN' || !execution
      ? `<p class="inc-verdict">${tag('NOT_RUN', g.notRun)}<small class="mu">${esc(g.notRunHint)}</small></p>`
      : `<p class="inc-verdict">${tag(verdict, verdict === 'PASSED' ? g.passed : g.failed)}<small class="mu">${esc(g.ranAt(execution.run, formatDate(execution.at, t.locale)))}</small></p>`;
  const decided = proposal.status !== 'PROPOSED';
  const buttons = `<div class="row-acts">${runner ? actionButton(ui, 'inc-reg-run', execution ? g.runAgain : g.run, { disabled: !ready || proposal.status === 'REJECTED' }) : ''}${
    !decided && can(state, 'PUBLISH') ? actionButton(ui, 'inc-reg-accept', g.accept, { primary: true }) : ''
  }${!decided && can(state, 'DECIDE') ? actionButton(ui, 'inc-reg-reject', g.reject) : ''}${propose}</div>`;
  return `<section class="card wide"><div class="card-h"><h2>${esc(g.title)}</h2>${tag(proposal.status, label(g.statuses, proposal.status))}</div><dl class="inc-dl"><div><dt>${esc(g.name)}</dt><dd>${esc(proposal.name)}</dd></div><div><dt>${esc(g.basedOn)}</dt><dd>${esc(proposal.basedOn)}</dd></div><div class="wide"><dt>${esc(g.expected)}</dt><dd>${esc(proposal.expected)}</dd></div>${proposal.file ? `<div><dt>${esc(g.file)}</dt><dd><code>${esc(proposal.file)}</code></dd></div>` : ''}</dl><h3>${esc(g.verdict)}</h3>${result}${!decided && !execution ? `<p class="mu">${esc(g.acceptNote)}</p>` : ''}${buttons}</section><section class="card wide"><h2>${esc(g.flow)}</h2><pre class="inc-pre" tabindex="0" aria-label="${esc(g.flow)}">${esc(proposal.flowYaml)}</pre></section>`;
}
