import type { IncidentScopeValidation } from '../core/client.js';
import type { ProjectDetail, Right } from '../core/contracts.js';
import {
  ATTACHMENT_TYPES,
  EXECUTION_TARGETS,
  INCIDENT_GROUPS,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  incidentGroup,
  incidentReproduction,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SCOPE_EXTENSION_KINDS,
  type AttachmentType,
  type CodeLayer,
  type ExecutionTarget,
  type Incident,
  type IncidentGroup,
  type IncidentInput,
  type IncidentKind,
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
import { panelState, type Lang } from './incident-parts.js';
import { emptyScopeUi, renderScopeEditor, type ScopeTrees, type ScopeUi } from './incident-scope.js';
import {
  advancedDetails,
  emptyDiscoveryUi,
  renderScopeDiscovery,
  type DiscoveryUi,
} from './incident-scope-discovery.js';
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
import { triggerActive } from './incident-trigger.js';

/**
 * LES ÉCRANS INCIDENTS : la liste et la déclaration, la liste des investigations (avec leur progression),
 * puis l'ESPACE D'INVESTIGATION d'un incident (`incident-workspace.ts`), dont l'onglet « Périmètre »
 * (applications, permissions, limites, extensions) est rendu ici. Des fonctions pures, de l'état vers le
 * HTML échappé : tout vient du serveur, ou des données de démonstration signalées comme telles.
 */
export const INCIDENT_TABS = WORKSPACE_TABS;
export type IncidentTab = WorkspaceTab;

export const CODE_LAYERS: readonly CodeLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];

/** Une pièce jointe choisie, lue dans la page, envoyée après la création de l'incident. */
export interface PendingAttachment {
  name: string;
  type: AttachmentType;
  bytes: number;
  dataBase64: string;
}

/** Un fichier écarté avant tout envoi, et pourquoi. */
export interface RejectedAttachment {
  name: string;
  reason: 'type' | 'size' | 'count' | 'empty' | 'read';
}

/** Le formulaire de déclaration, tel que saisi (converti en IncidentInput à l'envoi). */
export interface IncidentForm {
  title: string;
  description: string;
  observed: string;
  expected: string;
  severity: IncidentSeverity;
  /** L'application touchée, telle que la personne la nomme (120 caractères au plus). */
  application: string;
  kind: IncidentKind;
  scenario: string;
  environmentId: string;
  target: ExecutionTarget;
  /** REMOTE : namespace OpenShift (facultatif) ; ARO : namespace, ServiceAccount, image, montage des dépôts. */
  namespace: string;
  serviceAccount: string;
  image: string;
  repositoriesMount: string;
  attachments: PendingAttachment[];
  rejected: RejectedAttachment[];
  /** Le volet « Options d'exécution » est ouvert. */
  optionsOpen?: boolean;
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

/** L'onglet de la liste : tous les incidents, ou un groupe d'états. */
export type IncidentListGroup = 'ALL' | IncidentGroup;

export interface IncidentsUi {
  list?: IncidentSummary[];
  /** La lecture de la liste a échoué. */
  listError?: string;
  /** L'onglet de la liste et la recherche (identifiant, titre, application, scénario). */
  group: IncidentListGroup;
  query: string;
  /** Le brouillon de l'écran « Définition du périmètre » et les arborescences lues par application. */
  scope: ScopeUi;
  scopeTrees: Record<string, ScopeTrees[string]>;
  /** Le bloc « Applications et dépôts » : chemin saisi, dépôts connus, résultat de la découverte, sélection. */
  discovery: DiscoveryUi;
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
  group: 'ALL',
  query: '',
  scope: emptyScopeUi(),
  scopeTrees: {},
  discovery: emptyDiscoveryUi(),
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
    application: '',
    kind: 'FUNCTIONAL',
    scenario: incidentScenarios(project)[0] ?? '',
    environmentId: project?.environments[0]?.id ?? '',
    target: 'LOCAL',
    namespace: '',
    serviceAccount: '',
    image: '',
    repositoriesMount: '',
    attachments: [],
    rejected: [],
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

/** La longueur maximale du nom d'application (le serveur la revérifie). */
export const MAX_APPLICATION_LENGTH = 120;

/** Ce que le formulaire manque encore (le serveur revalide tout), dans l'ordre des champs. */
export function incidentFormProblems(form: IncidentForm): (keyof IncidentForm)[] {
  const missing: (keyof IncidentForm)[] = [];
  for (const key of ['title', 'description', 'application'] as const)
    if (!form[key].trim()) missing.push(key);
  if (form.application.trim().length > MAX_APPLICATION_LENGTH) missing.push('application');
  for (const key of ['expected', 'observed'] as const) if (!form[key].trim()) missing.push(key);
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
  const application = form.application.trim();
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    observed: form.observed.trim(),
    expected: form.expected.trim(),
    severity: form.severity,
    ...(application ? { application } : {}),
    kind: form.kind,
    ...(form.scenario ? { scenario: form.scenario } : {}),
    ...(form.environmentId ? { environmentId: form.environmentId } : {}),
    execution,
  };
}

// ── Pièces jointes ───────────────────────────────────────────────────────────────────────────

const EXTENSION_TYPES: Record<string, AttachmentType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
};

/** Les types acceptés par le sélecteur de fichiers (`accept`). */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_TYPES,
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.log',
  '.json',
].join(',');

/** Le type d'une pièce jointe : celui que donne le navigateur s'il est accepté, sinon d'après l'extension. */
export function attachmentTypeOf(name: string, mime: string): AttachmentType | undefined {
  if ((ATTACHMENT_TYPES as readonly string[]).includes(mime)) return mime as AttachmentType;
  if (mime && !mime.startsWith('text/') && mime !== 'application/octet-stream') return undefined;
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension ? EXTENSION_TYPES[extension] : undefined;
}

/**
 * Le tri des fichiers choisis : acceptés (type connu, 1 octet à MAX_ATTACHMENT_BYTES, dans la limite de
 * MAX_ATTACHMENTS avec ceux déjà retenus) ou écartés avec leur raison. Le serveur revérifie le contenu.
 */
export function sortAttachments(
  kept: number,
  files: readonly { name: string; type: string; size: number }[],
): { accepted: { index: number; type: AttachmentType }[]; rejected: RejectedAttachment[] } {
  const accepted: { index: number; type: AttachmentType }[] = [];
  const rejected: RejectedAttachment[] = [];
  files.forEach((file, index) => {
    const type = attachmentTypeOf(file.name, file.type);
    if (!type) rejected.push({ name: file.name, reason: 'type' });
    else if (file.size <= 0) rejected.push({ name: file.name, reason: 'empty' });
    else if (file.size > MAX_ATTACHMENT_BYTES) rejected.push({ name: file.name, reason: 'size' });
    else if (kept + accepted.length >= MAX_ATTACHMENTS) rejected.push({ name: file.name, reason: 'count' });
    else accepted.push({ index, type });
  });
  return { accepted, rejected };
}

/** Le contenu d'un fichier en base64 (par tranches : un gros fichier ne dépasse pas la pile). */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** Une taille lisible (octets, Kio, Mio). */
export function sizeText(bytes: number, lang: Lang): string {
  const unit = lang === 'fr' ? ['o', 'Kio', 'Mio'] : ['B', 'KiB', 'MiB'];
  if (bytes < 1024) return `${String(bytes)} ${unit[0] ?? ''}`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} ${unit[1] ?? ''}`;
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  return `${lang === 'fr' ? mib.replace('.', ',') : mib} ${unit[2] ?? ''}`;
}

// ── La liste ─────────────────────────────────────────────────────────────────────────────────

export const INCIDENT_LIST_GROUPS: readonly IncidentListGroup[] = ['ALL', ...INCIDENT_GROUPS];

export const isListGroup = (value: string | undefined): value is IncidentListGroup =>
  (INCIDENT_LIST_GROUPS as readonly string[]).includes(value ?? '');

const createdOf = (row: IncidentSummary): string => row.createdAt || row.updatedAt;

/** Le nombre d'incidents de chaque onglet. */
export function groupCounts(list: readonly IncidentSummary[]): Record<IncidentListGroup, number> {
  const counts: Record<IncidentListGroup, number> = {
    ALL: list.length,
    OPEN: 0,
    INVESTIGATING: 0,
    RESOLVED: 0,
    CLOSED: 0,
  };
  for (const row of list) counts[incidentGroup(row.state)] += 1;
  return counts;
}

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * Les lignes affichées : l'onglet, puis la recherche (identifiant, titre, application, scénario ; sans
 * accents ni casse), triées par date de création, la plus récente d'abord.
 */
export function visibleIncidents(
  list: readonly IncidentSummary[],
  group: IncidentListGroup,
  query: string,
): IncidentSummary[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return list
    .filter((row) => group === 'ALL' || incidentGroup(row.state) === group)
    .filter((row) => {
      if (words.length === 0) return true;
      const text = fold([row.id, row.title, row.application ?? '', row.scenario ?? ''].join(' '));
      return words.every((word) => text.includes(word));
    })
    .sort((left, right) => createdOf(right).localeCompare(createdOf(left)));
}

/** Une cellule CSV : entre guillemets, sans formule interprétée par un tableur. */
const csvCell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Les lignes affichées en CSV (séparateur « ; » en français), les libellés de la langue de la page. */
export function incidentsCsv(
  rows: readonly IncidentSummary[],
  labels: {
    columns: [string, string, string, string, string, string];
    severities: Record<string, string>;
    states: Record<string, string>;
  },
  lang: Lang,
): string {
  const separator = lang === 'fr' ? ';' : ',';
  const lines = [
    labels.columns.map(csvCell).join(separator),
    ...rows.map((row) =>
      [
        row.id,
        row.title,
        labels.severities[row.severity] ?? row.severity,
        row.application ?? '',
        labels.states[row.state] ?? row.state,
        createdOf(row),
      ]
        .map(csvCell)
        .join(separator),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Les noms d'application proposés : le projet, puis ceux déjà donnés aux incidents (sans doublon). */
export function applicationSuggestions(
  projectName: string | undefined,
  list: readonly IncidentSummary[] = [],
): string[] {
  const names = [projectName ?? '', ...list.map((row) => row.application ?? '')].map((name) => name.trim());
  return [...new Set(names.filter(Boolean))].sort((left, right) => left.localeCompare(right));
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
    incident.investigation.experiments.some((experiment) => experiment.status === 'RUNNING') ||
    (incident.investigation.ai?.runs.some((run) => run.status === 'RUNNING') ?? false) ||
    triggerActive(incident));

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
      ? (t.busy[ui.busy] ?? FLOW[state.t.locale].busy[ui.busy] ?? t.working)
      : incident?.state === 'REPRODUCING'
        ? t.reproducingLive
        : (ui.notice ?? '');
  // Le message en clair ; il est annoncé par la zone live permanente du Dashboard (`.inc-live`, hors de la
  // partie redessinée), qui en reprend le texte quand il change (IncidentsController.afterPaint).
  return `${live ? `<p class="inc-msg">${ui.busy !== undefined || incident?.state === 'REPRODUCING' ? '<span class="spin sm" aria-hidden="true"></span>' : ''}<span>${esc(live)}</span></p>` : ''}${
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

/** Les textes des écrans « Liste des incidents » et « Création d'un incident » (le reste vient de `t.inc`). */
const FLOW = {
  fr: {
    newIncident: 'Nouvel incident',
    listSub: (project: string, count: number) => `${project} · ${String(count)} incident(s)`,
    listSubNone: 'Vue globale de tous les incidents, avec leur statut',
    groups: {
      ALL: 'Tous',
      OPEN: 'Ouverts',
      INVESTIGATING: 'En investigation',
      RESOLVED: 'Résolus',
      CLOSED: 'Fermés',
    } as Record<IncidentListGroup, string>,
    groupsLabel: 'Afficher :',
    count: (count: number) => `${String(count)} incident(s)`,
    search: 'Rechercher un incident…',
    searchLabel: 'Rechercher un incident (identifiant, titre, application, scénario)',
    export: 'Exporter les lignes affichées (CSV)',
    shown: (shown: number, total: number) => `${String(shown)} incident(s) affiché(s) sur ${String(total)}`,
    noMatch: 'Aucun incident ne correspond à cet affichage.',
    noMatchQuery: (query: string) => `Aucun incident ne correspond à « ${query} » dans cet onglet.`,
    showAll: 'Tout afficher',
    listError: (message: string) => `La liste des incidents n’a pas pu être lue : ${message}`,
    col: {
      id: 'ID',
      title: 'Titre',
      severity: 'Sévérité',
      application: 'Application',
      state: 'Statut',
      created: 'Date de création',
    },
    open: (title: string) => `Ouvrir l’incident ${title}`,
    crumbs: 'Fil d’Ariane',
    createTitle: 'Créer un incident',
    createSub:
      'Formulaire simple et guidé : l’observé et l’attendu servent à reconnaître le symptôme pendant la reproduction.',
    titleField: 'Titre',
    description: 'Description',
    application: 'Application',
    applicationHint: 'Le nom de l’application touchée, tel que vous le connaissez (120 caractères au plus).',
    kind: 'Type',
    kinds: {
      FUNCTIONAL: 'Fonctionnel',
      TECHNICAL: 'Technique',
      PERFORMANCE: 'Performance',
      SECURITY: 'Sécurité',
      DATA: 'Données',
    } as Record<IncidentKind, string>,
    severity: 'Sévérité',
    scenario: 'Scénario associé',
    expected: 'Résultat attendu',
    expectedHint: 'Par exemple : le livre est créé et un message de succès s’affiche.',
    observed: 'Résultat observé',
    observedHint: 'Par exemple : erreur HTTP 500 après Enregistrer.',
    attachments: 'Pièces jointes',
    optional: '(facultatif)',
    addFiles: 'Ajouter des fichiers',
    filesHint: (count: number, size: string) =>
      `Captures PNG, JPEG ou WebP, journaux texte ou JSON ; ${String(count)} fichiers au plus, ${size} chacun. Envoyés après la création.`,
    removeFile: (name: string) => `Retirer ${name}`,
    rejected: 'Fichiers écartés',
    rejectReasons: {
      type: 'type non accepté',
      size: 'trop volumineux',
      count: 'nombre maximal atteint',
      empty: 'fichier vide',
      read: 'lecture impossible',
    } as Record<RejectedAttachment['reason'], string>,
    options: 'Options d’exécution',
    optionsHint: 'Environnement du projet et cible d’exécution (LOCAL par défaut).',
    required: 'Champ obligatoire.',
    tooLong: '120 caractères au plus.',
    problems: (count: number) => `${String(count)} champ(s) à compléter.`,
    requiredNote: 'Les champs marqués * sont obligatoires.',
    create: 'Créer et investiguer',
    cancel: 'Annuler',
    exported: (file: string, count: number) => `${String(count)} incident(s) exporté(s) : ${file}`,
    attachmentsSent: (count: number) => `${String(count)} pièce(s) jointe(s) envoyée(s).`,
    attachmentsFailed: (count: number) =>
      `${String(count)} pièce(s) jointe(s) non envoyée(s) : l’incident est créé, les raisons suivent.`,
    otherScope: 'Autres paramètres du périmètre',
    appsDetails: (count: number) => `Applications et dépôts (${String(count)})`,
    busy: {
      'inc-create': 'Création de l’incident…',
      'inc-attach': 'Envoi des pièces jointes…',
      'inc-scope-next': 'Enregistrement et vérification du périmètre…',
    } as Record<string, string>,
  },
  en: {
    newIncident: 'New incident',
    listSub: (project: string, count: number) => `${project} · ${String(count)} incident(s)`,
    listSubNone: 'Overview of all incidents, with their status',
    groups: {
      ALL: 'All',
      OPEN: 'Open',
      INVESTIGATING: 'Under investigation',
      RESOLVED: 'Resolved',
      CLOSED: 'Closed',
    } as Record<IncidentListGroup, string>,
    groupsLabel: 'Show:',
    count: (count: number) => `${String(count)} incident(s)`,
    search: 'Search an incident…',
    searchLabel: 'Search an incident (identifier, title, application, scenario)',
    export: 'Export the shown rows (CSV)',
    shown: (shown: number, total: number) => `${String(shown)} of ${String(total)} incident(s) shown`,
    noMatch: 'No incident matches this view.',
    noMatchQuery: (query: string) => `No incident matches “${query}” in this tab.`,
    showAll: 'Show everything',
    listError: (message: string) => `The incident list could not be read: ${message}`,
    col: {
      id: 'ID',
      title: 'Title',
      severity: 'Severity',
      application: 'Application',
      state: 'Status',
      created: 'Created',
    },
    open: (title: string) => `Open the incident ${title}`,
    crumbs: 'Breadcrumb',
    createTitle: 'Create an incident',
    createSub:
      'Simple guided form: observed and expected results identify the symptom during the reproduction.',
    titleField: 'Title',
    description: 'Description',
    application: 'Application',
    applicationHint: 'The name of the affected application, as you know it (120 characters at most).',
    kind: 'Type',
    kinds: {
      FUNCTIONAL: 'Functional',
      TECHNICAL: 'Technical',
      PERFORMANCE: 'Performance',
      SECURITY: 'Security',
      DATA: 'Data',
    } as Record<IncidentKind, string>,
    severity: 'Severity',
    scenario: 'Related scenario',
    expected: 'Expected result',
    expectedHint: 'For example: the book is created and a success message is shown.',
    observed: 'Observed result',
    observedHint: 'For example: HTTP 500 error after Save.',
    attachments: 'Attachments',
    optional: '(optional)',
    addFiles: 'Add files',
    filesHint: (count: number, size: string) =>
      `PNG, JPEG or WebP screenshots, text or JSON logs; ${String(count)} files at most, ${size} each. Sent after creation.`,
    removeFile: (name: string) => `Remove ${name}`,
    rejected: 'Files left out',
    rejectReasons: {
      type: 'type not accepted',
      size: 'too large',
      count: 'maximum count reached',
      empty: 'empty file',
      read: 'could not be read',
    } as Record<RejectedAttachment['reason'], string>,
    options: 'Execution options',
    optionsHint: 'Project environment and execution target (LOCAL by default).',
    required: 'Required field.',
    tooLong: '120 characters at most.',
    problems: (count: number) => `${String(count)} field(s) to complete.`,
    requiredNote: 'Fields marked * are required.',
    create: 'Create and investigate',
    cancel: 'Cancel',
    exported: (file: string, count: number) => `${String(count)} incident(s) exported: ${file}`,
    attachmentsSent: (count: number) => `${String(count)} attachment(s) sent.`,
    attachmentsFailed: (count: number) =>
      `${String(count)} attachment(s) not sent: the incident is created, the reasons follow.`,
    otherScope: 'Other scope settings',
    appsDetails: (count: number) => `Applications and repositories (${String(count)})`,
    busy: {
      'inc-create': 'Creating the incident…',
      'inc-attach': 'Sending the attachments…',
      'inc-scope-next': 'Saving and checking the scope…',
    } as Record<string, string>,
  },
};

/** Les textes des écrans de liste et de création (pour le contrôleur : export, pièces jointes). */
export const flowText = (lang: Lang): (typeof FLOW)['fr'] => FLOW[lang];

const SEVERITY_TONES: Record<IncidentSeverity, string> = {
  LOW: 'mu',
  MEDIUM: 'warn',
  HIGH: 'ko',
  CRITICAL: 'ko',
};

const severityTag = (severity: IncidentSeverity, text: string): string =>
  `<span class="pill ${SEVERITY_TONES[severity]} inc-sev"><span class="inc-dot inc-dot-${severity.toLowerCase()}" aria-hidden="true"></span>${esc(text)}</span>`;

/** Les onglets de la liste (tabindex itinérant, flèches par le contrôleur), avec leur nombre d'incidents. */
function groupTabs(lang: Lang, ui: IncidentsUi, list: readonly IncidentSummary[]): string {
  const f = FLOW[lang];
  const counts = groupCounts(list);
  return `<div class="tabs inc-l-tabs" role="tablist" aria-label="${esc(f.groupsLabel)}">${INCIDENT_LIST_GROUPS.map(
    (group) => {
      const selected = group === ui.group;
      return `<button type="button" role="tab" id="inc-l-tab-${group}" data-action="inc-group" data-group="${group}" data-index="${group}" aria-selected="${String(selected)}" aria-controls="inc-l-panel" tabindex="${selected ? '0' : '-1'}">${esc(f.groups[group])} <span class="inc-l-n"><span aria-hidden="true">${String(counts[group])}</span><span class="sr">${esc(f.count(counts[group]))}</span></span></button>`;
    },
  ).join('')}</div>`;
}

export function incidentsView(state: DashboardState, ui: IncidentsUi): string {
  const t = state.t;
  const i = t.inc;
  const lang = t.locale;
  const f = FLOW[lang];
  const route = state.route;
  if (route.view !== 'incidents') return '';
  const project = state.project;
  const list = ui.list;
  const runner = can(state, 'RUN');
  if (route.create && runner)
    return `<nav class="inc-cf-crumbs" aria-label="${esc(f.crumbs)}"><ol><li><button type="button" class="lnk" data-action="inc-create-cancel">${esc(t.nav.incidents)}</button></li><li aria-current="page">${esc(f.newIncident)}</li></ol></nav>${header(esc(f.createTitle), { sub: esc(f.createSub) })}${messages(state, ui)}${createForm(state, ui)}`;
  const actions = `<button class="btn" data-action="inc-demo">${icon('eye')}<span>${esc(i.demo.open)}</span></button>${
    runner
      ? `<button class="btn primary" data-action="inc-new">${icon('plus')}<span>${esc(f.newIncident)}</span></button>`
      : ''
  }`;
  const top = header(esc(t.nav.incidents), {
    sub: esc(project && list ? f.listSub(project.name, list.length) : f.listSubNone),
    actions,
  });
  const readOnly = runner ? '' : `<p class="note">${icon('info')}<span>${esc(i.readOnly)}</span></p>`;
  if (!list) {
    const body = ui.listError
      ? panelState(lang, 'error', f.listError(ui.listError), 'inc-refresh')
      : `<section class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
    return `${top}${messages(state, ui)}${readOnly}<section class="card wide inc-l">${body}</section>`;
  }
  const rows = visibleIncidents(list, ui.group, ui.query);
  const tools = `<div class="inc-l-tools"><label class="inc-l-search" for="inc-l-q">${icon('search')}<span class="sr">${esc(f.searchLabel)}</span><input type="search" id="inc-l-q" data-inc="list.query" value="${esc(ui.query)}" placeholder="${esc(f.search)}" autocomplete="off" spellcheck="false" aria-describedby="inc-l-shown"></label><div class="inc-l-icons"><button type="button" class="btn icon-only" data-action="inc-refresh" aria-label="${esc(t.refresh)}" title="${esc(t.refresh)}">${icon('refresh')}</button><button type="button" class="btn icon-only" data-action="inc-export" aria-label="${esc(f.export)}" title="${esc(f.export)}"${rows.length === 0 ? ' disabled' : ''}>${icon('download')}</button></div></div>`;
  const shown = `<p id="inc-l-shown" class="mu inc-l-shown">${esc(f.shown(rows.length, list.length))}</p>`;
  let table: string;
  if (list.length === 0)
    table = `<div class="ws-state"><p class="mu">${esc(i.noIncident)}</p>${runner ? `<button type="button" class="btn primary" data-action="inc-new">${icon('plus')}<span>${esc(f.newIncident)}</span></button>` : ''}</div>`;
  else if (rows.length === 0)
    table = `<div class="ws-state"><p class="mu">${esc(ui.query.trim() ? f.noMatchQuery(ui.query.trim()) : f.noMatch)}</p><button type="button" class="btn small" data-action="inc-list-reset">${esc(f.showAll)}</button></div>`;
  else
    table = `<div class="tw"><table class="tbl inc-l-tbl"><caption class="sr">${esc(`${t.nav.incidents} — ${f.groups[ui.group]}`)}</caption><thead><tr><th scope="col">${esc(f.col.id)}</th><th scope="col">${esc(f.col.title)}</th><th scope="col">${esc(f.col.severity)}</th><th scope="col">${esc(f.col.application)}</th><th scope="col">${esc(f.col.state)}</th><th scope="col">${esc(f.col.created)}</th></tr></thead><tbody>${rows
      .map(
        (row) =>
          `<tr class="inc-l-row" data-action="inc-open" data-incident="${esc(row.id)}"><td><code class="inc-l-id">${esc(row.id)}</code></td><td class="inc-l-title"><button type="button" class="lnk" data-action="inc-open" data-incident="${esc(row.id)}" title="${esc(f.open(row.title))}">${esc(row.title)}</button>${row.scenario ? `<small class="mu block">${esc(row.scenario)}</small>` : ''}</td><td>${severityTag(row.severity, label(i.severities, row.severity))}</td><td>${row.application ? esc(row.application) : '<span class="mu">—</span>'}</td><td>${tag(row.state, label(i.states, row.state))}</td><td><time datetime="${esc(createdOf(row))}">${esc(formatDate(createdOf(row), lang))}</time></td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  const labelledBy = `inc-l-tab-${ui.group}`;
  return `${top}${messages(state, ui)}${readOnly}<section class="card wide inc-l">${tools}${groupTabs(lang, ui, list)}<div id="inc-l-panel" role="tabpanel" aria-labelledby="${labelledBy}">${shown}${table}</div></section>${list.length === 0 ? demoEntry(state) : ''}`;
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
  const label = `<label class="field" for="${id}"><span class="field-l">${esc(text)}${options.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</span>${input}</label>`;
  // L'aide reste dans la cellule de son champ (sinon la grille des champs lui donne une colonne à elle).
  return options.hint
    ? `<div class="field-w">${label}<small id="${id}-h" class="mu">${esc(options.hint)}</small></div>`
    : label;
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

/**
 * Un champ du formulaire de création : son libellé à gauche (au-dessus en étroit), le contrôle, puis son
 * erreur (aria-describedby, avant l'indication) et son indication.
 */
function formRow(
  key: string,
  text: string,
  control: (attrs: string) => string,
  options: { required?: boolean; error?: string; hint?: string; extraLabel?: string; cls?: string } = {},
): string {
  const id = `inc-f-${key}`;
  const described = [options.error ? `${id}-e` : '', options.hint ? `${id}-h` : ''].filter(Boolean).join(' ');
  const attrs = `id="${id}" data-inc="${key}"${options.required ? ' required aria-required="true"' : ''}${options.error ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}`;
  return `<div class="inc-cf-f${options.cls ? ` ${options.cls}` : ''}"><label class="inc-cf-l" for="${id}">${esc(text)}${options.required ? ' <span aria-hidden="true">*</span>' : ''}${options.extraLabel ? ` <small class="mu">${esc(options.extraLabel)}</small>` : ''}</label><div class="inc-cf-c">${control(attrs)}${
    options.error
      ? `<small id="${id}-e" class="err inc-cf-err">${icon('alert')}<span>${esc(options.error)}</span></small>`
      : ''
  }${options.hint ? `<small id="${id}-h" class="mu">${esc(options.hint)}</small>` : ''}</div></div>`;
}

const optionsOf = (values: { value: string; text: string }[], current: string): string =>
  values
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${option.value === current ? ' selected' : ''}>${esc(option.text)}</option>`,
    )
    .join('');

/**
 * L'écran « Création d'un incident » : titre, description, application (avec suggestions), type, sévérité
 * (pastille de couleur), scénario associé, résultats attendu et observé, pièces jointes (envoyées après la
 * création), puis le volet « Options d'exécution » (environnement du projet, cible LOCAL / REMOTE / ARO et
 * leurs champs). « Créer et investiguer » crée l'incident, envoie les pièces jointes et ouvre « Périmètre ».
 */
function createForm(state: DashboardState, ui: IncidentsUi): string {
  const i = state.t.inc;
  const lang = state.t.locale;
  const f = FLOW[lang];
  const form = ui.form;
  if (!form) return '';
  const project = state.project;
  const scenarios = incidentScenarios(project);
  const environments = project?.environments ?? [];
  const invalid = new Set(ui.invalid ?? []);
  const errorOf = (key: keyof IncidentForm): string | undefined => {
    if (!invalid.has(key)) return undefined;
    if (key === 'application' && form.application.trim().length > MAX_APPLICATION_LENGTH) return f.tooLong;
    return f.required;
  };
  const bad = (key: keyof IncidentForm): boolean => invalid.has(key);
  const input =
    (key: 'title' | 'application', extra = '') =>
    (attrs: string) =>
      `<input ${attrs} value="${esc(form[key])}" autocomplete="off"${extra}>`;
  const area = (key: 'description' | 'expected' | 'observed', rows: number) => (attrs: string) =>
    `<textarea ${attrs} rows="${String(rows)}">${esc(form[key])}</textarea>`;
  const select = (values: { value: string; text: string }[], current: string) => (attrs: string) =>
    `<select ${attrs}>${optionsOf(values, current)}</select>`;
  const suggestions = applicationSuggestions(project?.name, ui.list);

  const targetFields =
    form.target === 'ARO'
      ? `<div class="fields">${textField('namespace', i.form.namespace, form.namespace, { required: true, mono: true, invalid: bad('namespace') })}${textField('serviceAccount', i.form.serviceAccount, form.serviceAccount, { required: true, mono: true, invalid: bad('serviceAccount') })}${textField('image', i.form.image, form.image, { required: true, mono: true, invalid: bad('image') })}${textField('repositoriesMount', i.form.repositoriesMount, form.repositoriesMount, { required: true, mono: true, hint: i.form.repositoriesMountHint, invalid: bad('repositoriesMount') })}</div>`
      : form.target === 'REMOTE'
        ? `<div class="fields">${textField('namespace', i.form.remoteNamespace, form.namespace, { mono: true, hint: i.form.remoteNamespaceHint })}</div>`
        : '';
  const aroInvalid = (['namespace', 'serviceAccount', 'image', 'repositoriesMount'] as const).some(bad);
  const optionsOpen = form.optionsOpen === true || form.target !== 'LOCAL' || aroInvalid;
  const options = `<details class="inc-cf-opts"${optionsOpen ? ' open' : ''}><summary data-action="inc-options-toggle">${icon('sliders')}<span>${esc(f.options)}</span><small class="mu">${esc(`${label(i.targets, form.target)} · ${environments.find((environment) => environment.id === form.environmentId)?.name ?? i.form.firstEnvironment}`)}</small></summary><p class="mu">${esc(f.optionsHint)}</p><div class="fields">${selectField(
    'environmentId',
    i.form.environment,
    form.environmentId,
    [
      { value: '', text: i.form.firstEnvironment },
      ...environments.map((environment) => ({ value: environment.id, text: environment.name })),
    ],
  )}</div><fieldset class="inc-targets"><legend>${esc(i.form.target)}</legend><div class="chips" role="radiogroup" aria-label="${esc(i.form.target)}">${EXECUTION_TARGETS.map(
    (target) =>
      `<label class="choice${form.target === target ? ' on' : ''}"><input type="radio" name="inc-target" data-inc="target" value="${target}" ${form.target === target ? 'checked' : ''}><span><b>${esc(label(i.targets, target))}</b><small>${esc(label(i.targetHints, target))}</small></span></label>`,
  ).join('')}</div></fieldset>${targetFields}</details>`;

  const files =
    form.attachments.length === 0
      ? ''
      : `<ul class="inc-cf-atts" role="list">${form.attachments
          .map(
            (file, index) =>
              `<li><span class="inc-cf-att-i" aria-hidden="true">${icon(file.type.startsWith('image/') ? 'eye' : 'editor')}</span><span class="inc-cf-att-n" title="${esc(file.name)}">${esc(file.name)}</span><small class="mu">${esc(sizeText(file.bytes, lang))}</small><button type="button" class="inc-cf-att-rm" data-action="inc-att-remove" data-index="${String(index)}" aria-label="${esc(f.removeFile(file.name))}" title="${esc(f.removeFile(file.name))}">${icon('close')}</button></li>`,
          )
          .join('')}</ul>`;
  const rejected =
    form.rejected.length === 0
      ? ''
      : `<div class="inc-cf-rej" role="alert"><p class="err"><b>${esc(f.rejected)}</b></p><ul class="plain tight">${form.rejected.map((file) => `<li><code>${esc(file.name)}</code> — ${esc(f.rejectReasons[file.reason])}</li>`).join('')}</ul></div>`;
  const full = form.attachments.length >= MAX_ATTACHMENTS;
  const attachments = `<div class="inc-cf-f inc-cf-files"><span class="inc-cf-l" id="inc-f-files-l">${esc(f.attachments)} <small class="mu">${esc(f.optional)}</small></span><div class="inc-cf-c"><div class="inc-cf-pick"><input type="file" id="inc-f-files" class="inc-cf-file" data-inc="files" multiple accept="${esc(ATTACHMENT_ACCEPT)}" aria-labelledby="inc-f-files-l inc-f-files-b" aria-describedby="inc-f-files-h"${full ? ' disabled' : ''}><label for="inc-f-files" id="inc-f-files-b" class="btn${full ? ' disabled' : ''}">${icon('sources')}<span>${esc(f.addFiles)}</span></label></div>${files}${rejected}<small id="inc-f-files-h" class="mu">${esc(f.filesHint(MAX_ATTACHMENTS, sizeText(MAX_ATTACHMENT_BYTES, lang)))}</small></div></div>`;

  const severity = `<span class="inc-cf-sev inc-cf-sev-${form.severity.toLowerCase()}"><span class="inc-dot inc-dot-${form.severity.toLowerCase()}" aria-hidden="true"></span>${select(
    INCIDENT_SEVERITIES.map((value) => ({ value, text: label(i.severities, value) })),
    form.severity,
  )('id="inc-f-severity" data-inc="severity" required aria-required="true"')}</span>`;

  const count = invalid.size;
  const summary =
    count > 0
      ? `<p class="err" role="alert">${icon('alert')}<span>${esc(f.problems(count))}</span></p>`
      : `<small class="mu">${esc(f.requiredNote)}</small>`;
  const busy = ui.busy !== undefined;
  return `<section class="card wide inc-cf" aria-labelledby="inc-create-t"><h2 id="inc-create-t" class="sr">${esc(f.createTitle)}</h2><form class="inc-cf-form inc-form" data-action="inc-create" novalidate>
${formRow('title', f.titleField, input('title'), { required: true, error: errorOf('title') })}
${formRow('description', f.description, area('description', 3), { required: true, error: errorOf('description') })}
<div class="inc-cf-pair">${formRow('application', f.application, input('application', ' list="inc-f-apps" maxlength="240"'), { required: true, error: errorOf('application'), hint: f.applicationHint })}<datalist id="inc-f-apps">${suggestions.map((name) => `<option value="${esc(name)}"></option>`).join('')}</datalist>${formRow(
    'kind',
    f.kind,
    select(
      INCIDENT_KINDS.map((value) => ({ value, text: f.kinds[value] })),
      form.kind,
    ),
    { required: true },
  )}</div>
<div class="inc-cf-pair"><div class="inc-cf-f"><label class="inc-cf-l" for="inc-f-severity">${esc(f.severity)} <span aria-hidden="true">*</span></label><div class="inc-cf-c">${severity}</div></div>${formRow(
    'scenario',
    f.scenario,
    select(
      [{ value: '', text: i.form.noScenario }, ...scenarios.map((name) => ({ value: name, text: name }))],
      form.scenario,
    ),
  )}</div>
${formRow('expected', f.expected, area('expected', 2), { required: true, error: errorOf('expected'), hint: f.expectedHint })}
${formRow('observed', f.observed, area('observed', 2), { required: true, error: errorOf('observed'), hint: f.observedHint })}
${attachments}
${options}
<div class="inc-cf-foot">${summary}<div class="inc-cf-acts"><button type="button" class="btn" data-action="inc-create-cancel">${esc(f.cancel)}</button><button type="submit" class="btn primary" ${busy ? 'disabled' : ''} aria-busy="${String(ui.busy === 'inc-create' || ui.busy === 'inc-attach')}"><span>${esc(f.create)}</span>${icon('right')}</button></div></div>
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
        : actionButton(ui, 'inc-cancel', i.cancelInvestigation, { primary: true });
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
              `<tr><td><b>${esc(app.name)}</b><small class="mu block"><code>${esc(app.id)}</code>${app.baseUrl ? ` · ${esc(app.baseUrl)}` : ''}${app.origin?.kind === 'DISCOVERED' ? ` · ${esc(s.discovered(formatDate(app.origin.at, state.t.locale)))}` : ''}</small></td><td>${esc(label(i.layers, app.layer))}</td><td><code>${esc(app.repository.root)}</code></td><td>${app.repository.include.length === 0 ? `<span class="mu">${esc(s.wholeRoot)}</span>` : app.repository.include.map((entry) => `<code>${esc(entry)}</code>`).join(' ')}</td><td>${(app.repository.classes ?? []).length === 0 ? `<span class="mu">${esc(s.allClasses)}</span>` : (app.repository.classes ?? []).map((entry) => `<code>${esc(entry)}</code>`).join(' ')}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  const chipsOf = (items: (string | number)[], none: string): string =>
    items.length === 0
      ? `<span class="mu">${esc(none)}</span>`
      : items.map((item) => `<code>${esc(String(item))}</code>`).join(' ');
  const perms = scope.permissions;
  const yesNo = (value: boolean): string => (value ? s.allowed : s.denied);
  const facts = `<dl class="inc-dl">
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
  const f = FLOW[state.t.locale];
  const head = `<div class="card-h"><h2>${esc(f.otherScope)}</h2><div class="row-acts">${
    editable && !ui.scopeForm ? actionButton(ui, 'inc-scope-edit', s.edit) : ''
  }</div></div>`;
  const draft =
    incident.state === 'DRAFT' ? `<p class="note">${icon('info')}<span>${esc(s.draftHint)}</span></p>` : '';
  const body = ui.scopeForm
    ? scopeEditor(state, ui)
    : `${facts}<details class="inc-sc-apps-d"><summary>${esc(f.appsDetails(scope.applications.length))}</summary>${apps}</details><h3>${esc(s.permissions)}</h3>${permissions}`;
  const scopeUi = ui.scope.incidentId === incident.id ? ui.scope : emptyScopeUi(incident.id);
  const scopeCtx = {
    incident,
    lang: state.t.locale,
    can: (right: Right) => can(state, right),
    demo: ui.ws.demo && isDemoIncident(incident.id),
  };
  const discoveryUi = ui.discovery.incidentId === incident.id ? ui.discovery : emptyDiscoveryUi(incident.id);
  const discovery = renderScopeDiscovery(
    scopeCtx,
    discoveryUi,
    ui.busy !== undefined ? { busy: ui.busy } : {},
  );
  const editor = renderScopeEditor(scopeCtx, scopeUi, ui.scopeTrees, {
    busy: ui.busy !== undefined,
    ...(ui.validation ? { validation: ui.validation } : {}),
  });
  // La saisie manuelle (identifiant, couche, racine, dossiers, classes) reste disponible, repliée.
  const advanced = advancedDetails(
    state.t.locale,
    discoveryUi.advanced || ui.scopeForm !== undefined,
    `<section class="card wide inc-sc-other" aria-label="${esc(f.otherScope)}">${head}${draft}${body}</section>`,
  );
  return `${discovery}${editor}${advanced}${extensions}`;
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
