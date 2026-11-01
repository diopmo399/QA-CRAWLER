import {
  SCOPE_MODES,
  type CodeLayer,
  type Incident,
  type InvestigationScope,
  type ResourceLimits,
  type ScopeApplication,
  type ScopeMode,
  type ScopeTree,
  type ScopeTreeNode,
} from '../core/incident-contracts.js';
import { icon } from './dashboard-parts.js';
import type { Lang, WorkspaceContext } from './incident-parts.js';
import { esc } from './view.js';

/**
 * L'ÉCRAN « DÉFINITION DU PÉRIMÈTRE » : le mode (guidé, manuel, automatique), l'arborescence des dossiers de
 * chaque application du périmètre (cases à trois états : cocher un dossier l'ajoute à `include`, le décocher
 * l'en retire ; la racine cochée : toute l'application), la profondeur d'analyse (1 à 5), la liste des
 * éléments inclus et les limites de ressources. Des fonctions pures : le brouillon (`ScopeUi`) est tenu par
 * le contrôleur des incidents, qui lit les arborescences (`incidents.scopeTree`) et enregistre puis valide le
 * périmètre (`incidents.update`, `incidents.validateScope`). Rien n'est inventé : les dossiers viennent du
 * serveur, les valeurs du périmètre enregistré ou de la saisie.
 */

// ── État ─────────────────────────────────────────────────────────────────────────────────────

/** La lecture d'une arborescence : en cours, refusée (403), en échec. */
export type ScopeTreeState = 'loading' | 'denied' | { error: string };

export interface ScopeTreeEntry {
  tree?: ScopeTree;
  state?: ScopeTreeState;
  /** La racine du dépôt lue : une autre racine (application modifiée) demande une nouvelle lecture. */
  root?: string;
}

export type ScopeTrees = Readonly<Record<string, ScopeTreeEntry | undefined>>;

/** Ce qui est retenu d'une application : tout le dépôt, ou des dossiers (relatifs à la racine). */
export interface AppSelection {
  whole: boolean;
  paths: string[];
}

/** Les limites saisies (texte, validé à l'enregistrement). */
export const SCOPE_LIMIT_FIELDS = [
  'duration',
  'memory',
  'maxFiles',
  'maxFileKib',
  'maxRequests',
  'maxExperiments',
] as const;
export type ScopeLimitField = (typeof SCOPE_LIMIT_FIELDS)[number];

/** Les bornes vérifiées dans la page (le serveur revérifie tout). */
export const SCOPE_BOUNDS = {
  durationMin: { min: 1, max: 120 },
  memoryMb: { min: 64, max: 16384 },
} as const;

/** L'ordre des modes à l'écran (« Mode guidé » d'abord : le mode par défaut). */
export const SCOPE_MODES_ORDER: readonly ScopeMode[] = ['GUIDED', 'MANUAL', 'AUTO_WITHIN_SCOPE'];

export const MIN_SCOPE_DEPTH = 1;
export const MAX_SCOPE_DEPTH = 5;

export interface ScopeUi {
  /** L'incident du brouillon (un autre incident repart de zéro). */
  incidentId?: string;
  mode?: ScopeMode;
  depth?: number;
  /** Les applications modifiées ; absente : le périmètre enregistré. */
  selection: Record<string, AppSelection>;
  limits: Partial<Record<ScopeLimitField, string>>;
  /** Les nœuds dépliés ou repliés explicitement, par clé `application|chemin`. */
  expanded: Record<string, boolean>;
  /** Les entrées refusées au dernier envoi : `limit:<champ>`, `app:<id>`. */
  invalid: string[];
  /** L'arborescence des applications repliée (« Gérer » la rouvre) ; absente : dépliée. */
  treeHidden?: boolean;
}

export const emptyScopeUi = (incidentId?: string): ScopeUi => ({
  ...(incidentId ? { incidentId } : {}),
  selection: {},
  limits: {},
  expanded: {},
  invalid: [],
});

/** Un chemin du dépôt comparable : « / » seulement, sans « ./ » au début ni « / » au début ou à la fin. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

const under = (path: string, parent: string): boolean => path.startsWith(`${parent}/`);

/** Ce qui est retenu d'une application enregistrée : `include` vide veut dire tout le dépôt. */
export function savedSelection(app: ScopeApplication): AppSelection {
  const paths = [...new Set(app.repository.include.map(normalizePath))].filter(Boolean).sort();
  return paths.length === 0 ? { whole: true, paths: [] } : { whole: false, paths };
}

export function selectionOf(app: ScopeApplication, ui: ScopeUi): AppSelection {
  return ui.selection[app.id] ?? savedSelection(app);
}

export type CheckState = 'true' | 'false' | 'mixed';

/** L'état de la case d'un dossier (« » : la racine de l'application). */
export function nodeCheck(selection: AppSelection, path: string): CheckState {
  const at = normalizePath(path);
  if (selection.whole) return 'true';
  if (at === '') return selection.paths.length > 0 ? 'mixed' : 'false';
  if (selection.paths.some((entry) => entry === at || under(at, entry))) return 'true';
  if (selection.paths.some((entry) => under(entry, at))) return 'mixed';
  return 'false';
}

function findNode(node: ScopeTreeNode, path: string): ScopeTreeNode | undefined {
  if (normalizePath(node.path) === path) return node;
  for (const child of node.children) {
    const childPath = normalizePath(child.path);
    if (childPath === path || under(path, childPath)) return findNode(child, path);
  }
  return undefined;
}

/**
 * Les dossiers qui remplacent `covering` quand `target` (en dessous) est décoché : ses sous-dossiers, sauf la
 * branche de `target`, descendue jusqu'à lui. Undefined quand l'arborescence ne connaît pas ce chemin.
 */
function replaceExcept(root: ScopeTreeNode, covering: string, target: string): string[] | undefined {
  const node = findNode(root, covering);
  if (!node) return undefined;
  const kept: string[] = [];
  for (const child of node.children) {
    const childPath = normalizePath(child.path);
    if (childPath === target) continue;
    if (under(target, childPath)) {
      const deeper = replaceExcept(root, childPath, target);
      if (!deeper) return undefined;
      kept.push(...deeper);
    } else kept.push(childPath);
  }
  return kept;
}

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort();

/**
 * Le clic sur la case d'un dossier. Racine : cochée → plus rien (à choisir avant l'enregistrement), sinon
 * toute l'application. Dossier coché (lui-même ou un parent) → retiré ; quand c'est un parent qui le couvrait,
 * ce parent est remplacé par ses autres sous-dossiers (l'arborescence lue est nécessaire). Dossier non coché
 * ou partiel → ajouté, ses sous-dossiers déjà retenus s'effacent devant lui.
 */
export function toggleSelection(
  selection: AppSelection,
  tree: ScopeTree | undefined,
  path: string,
): AppSelection {
  const at = normalizePath(path);
  const state = nodeCheck(selection, at);
  if (at === '') return state === 'true' ? { whole: false, paths: [] } : { whole: true, paths: [] };
  if (state !== 'true')
    return { whole: false, paths: sorted([...selection.paths.filter((entry) => !under(entry, at)), at]) };
  if (!selection.whole && selection.paths.includes(at))
    return { whole: false, paths: selection.paths.filter((entry) => entry !== at) };
  const covering = selection.whole ? '' : selection.paths.find((entry) => under(at, entry));
  if (covering === undefined || !tree || !findNode(tree.root, at)) return selection;
  const replacement = replaceExcept(tree.root, covering, at);
  if (!replacement) return selection;
  return {
    whole: false,
    paths: sorted([...selection.paths.filter((entry) => entry !== covering), ...replacement]),
  };
}

/** Le retrait d'un élément de la liste « Éléments inclus » (« » : toute l'application). */
export function removeFromSelection(selection: AppSelection, path: string): AppSelection {
  const at = normalizePath(path);
  if (at === '') return { whole: false, paths: [] };
  return { whole: false, paths: selection.paths.filter((entry) => entry !== at) };
}

const sameSelection = (left: AppSelection, right: AppSelection): boolean =>
  left.whole === right.whole &&
  left.paths.length === right.paths.length &&
  left.paths.every((entry, index) => entry === right.paths[index]);

// ── Limites ──────────────────────────────────────────────────────────────────────────────────

/** La valeur affichée d'une limite : la saisie, sinon la valeur enregistrée (durée en minutes, fichier en Kio). */
export function limitValue(limits: ResourceLimits, ui: ScopeUi, field: ScopeLimitField): string {
  const typed = ui.limits[field];
  if (typed !== undefined) return typed;
  switch (field) {
    case 'duration':
      return String(Math.round(limits.maxDurationMs / 60_000));
    case 'memory':
      return limits.maxMemoryMb === undefined ? '' : String(limits.maxMemoryMb);
    case 'maxFiles':
      return String(limits.maxFiles);
    case 'maxFileKib':
      return String(Math.round(limits.maxFileBytes / 1024));
    case 'maxRequests':
      return String(limits.maxRequests);
    case 'maxExperiments':
      return String(limits.maxExperiments);
  }
}

const integer = (text: string): number | undefined => {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : undefined;
};

/** Les limites du brouillon et les champs refusés (entiers positifs ; durée ≤ 120 min ; mémoire 64 à 16384 Mio). */
export function limitsOf(
  saved: ResourceLimits,
  ui: ScopeUi,
): { limits: ResourceLimits; invalid: ScopeLimitField[] } {
  const invalid: ScopeLimitField[] = [];
  const read = (field: ScopeLimitField, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    if (ui.limits[field] === undefined) return undefined;
    const value = integer(ui.limits[field]);
    if (value === undefined || value < min || value > max) {
      invalid.push(field);
      return undefined;
    }
    return value;
  };
  const duration = read('duration', SCOPE_BOUNDS.durationMin.min, SCOPE_BOUNDS.durationMin.max);
  const memoryText = ui.limits.memory?.trim();
  const memory =
    memoryText === '' ? null : read('memory', SCOPE_BOUNDS.memoryMb.min, SCOPE_BOUNDS.memoryMb.max);
  const maxFiles = read('maxFiles', 1);
  const maxFileKib = read('maxFileKib', 1);
  const maxRequests = read('maxRequests', 1);
  const maxExperiments = read('maxExperiments', 1);
  const limits: ResourceLimits = {
    ...saved,
    ...(duration !== undefined ? { maxDurationMs: duration * 60_000 } : {}),
    ...(maxFiles !== undefined ? { maxFiles } : {}),
    ...(maxFileKib !== undefined ? { maxFileBytes: maxFileKib * 1024 } : {}),
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    ...(maxExperiments !== undefined ? { maxExperiments } : {}),
  };
  if (memory === null) delete limits.maxMemoryMb;
  else if (memory !== undefined) limits.maxMemoryMb = memory;
  return { limits, invalid };
}

// ── Brouillon → périmètre ────────────────────────────────────────────────────────────────────

/**
 * Le périmètre à envoyer (`incidents.update(revision, { scope })`) et ce qui le rend invalide : une
 * application sans aucun dossier retenu (`app:<id>`), une limite hors bornes (`limit:<champ>`). Les
 * permissions et extensions restent celles du serveur.
 */
export function scopeDraftOf(
  incident: Incident,
  ui: ScopeUi,
): { scope: InvestigationScope; invalid: string[] } {
  const saved = incident.scope;
  const invalid: string[] = [];
  const applications = saved.applications.map((app): ScopeApplication => {
    const selection = selectionOf(app, ui);
    if (!selection.whole && selection.paths.length === 0) invalid.push(`app:${app.id}`);
    if (!ui.selection[app.id]) return app;
    return {
      ...app,
      repository: { ...app.repository, include: selection.whole ? [] : [...selection.paths] },
    };
  });
  const limits = limitsOf(saved.limits, ui);
  invalid.push(...limits.invalid.map((field) => `limit:${field}`));
  return {
    scope: {
      ...saved,
      mode: ui.mode ?? saved.mode,
      depth: ui.depth ?? saved.depth,
      applications,
      limits: limits.limits,
    },
    invalid,
  };
}

/** Le brouillon diffère-t-il du périmètre enregistré ? */
export function scopeDirty(incident: Incident, ui: ScopeUi): boolean {
  const saved = incident.scope;
  if (ui.mode !== undefined && ui.mode !== saved.mode) return true;
  if (ui.depth !== undefined && ui.depth !== saved.depth) return true;
  if (
    saved.applications.some(
      (app) =>
        ui.selection[app.id] !== undefined && !sameSelection(selectionOf(app, ui), savedSelection(app)),
    )
  )
    return true;
  return SCOPE_LIMIT_FIELDS.some(
    (field) =>
      ui.limits[field] !== undefined &&
      ui.limits[field].trim() !== limitValue(saved.limits, emptyScopeUi(), field),
  );
}

/** Les applications dont l'arborescence manque (ou dont la racine a changé) : à lire par le contrôleur. */
export function scopeTreeRequests(incident: Incident, trees: ScopeTrees): ScopeApplication[] {
  return incident.scope.applications.filter((app) => {
    const entry = trees[app.id];
    return !entry || (entry.root !== undefined && entry.root !== app.repository.root);
  });
}

/** Le brouillon peut-il être modifié (droit RUN, ni démonstration, ni reproduction en cours, ni annulation) ? */
export const scopeEditable = (ctx: ScopeContext): boolean =>
  ctx.can('RUN') && !ctx.demo && ctx.incident.state !== 'CANCELLED' && ctx.incident.state !== 'REPRODUCING';

// ── Réducteur ────────────────────────────────────────────────────────────────────────────────

const isMode = (value: string | undefined): value is ScopeMode =>
  (SCOPE_MODES as readonly string[]).includes(value ?? '');
const isLimit = (value: string | undefined): value is ScopeLimitField =>
  (SCOPE_LIMIT_FIELDS as readonly string[]).includes(value ?? '');

export const nodeKey = (applicationId: string, path: string): string =>
  `${applicationId}|${normalizePath(path)}`;

/**
 * Le réducteur pur des actions de l'écran (préfixe `inc-scope-`) : `inc-scope-mode` (`mode`),
 * `inc-scope-depth` (`value`), `inc-scope-limit` (`field`, `value`), `inc-scope-expand` (`block` :
 * l'application, `index` : le chemin, `open` : l'état affiché), `inc-scope-toggle` et `inc-scope-remove`
 * (`block`, `index` ; `env` donne l'incident et les arborescences), `inc-scope-manage` (l'arborescence
 * repliée ou dépliée), `inc-scope-reset` (le brouillon abandonné), `inc-scope-invalid` (`fields`, séparés par des virgules), `inc-scope-saved`. Undefined : action
 * d'un autre écran.
 */
export function reduceScope(
  ui: ScopeUi,
  action: string,
  dataset: Record<string, string | undefined>,
  env?: { incident: Incident; trees: ScopeTrees },
): ScopeUi | undefined {
  switch (action) {
    case 'inc-scope-mode':
      return isMode(dataset.mode) ? { ...ui, mode: dataset.mode } : ui;
    case 'inc-scope-depth': {
      const value = Number(dataset.value);
      return Number.isInteger(value) && value >= MIN_SCOPE_DEPTH && value <= MAX_SCOPE_DEPTH
        ? { ...ui, depth: value }
        : ui;
    }
    case 'inc-scope-limit': {
      const field = dataset.field;
      if (!isLimit(field)) return ui;
      return {
        ...ui,
        limits: { ...ui.limits, [field]: dataset.value ?? '' },
        invalid: ui.invalid.filter((entry) => entry !== `limit:${field}`),
      };
    }
    case 'inc-scope-expand': {
      const app = dataset.block;
      if (!app) return ui;
      const key = nodeKey(app, dataset.index ?? '');
      return { ...ui, expanded: { ...ui.expanded, [key]: dataset.open !== 'true' } };
    }
    case 'inc-scope-toggle':
    case 'inc-scope-remove': {
      const app = env?.incident.scope.applications.find((entry) => entry.id === dataset.block);
      if (!env || !app) return ui;
      const current = selectionOf(app, ui);
      const next =
        action === 'inc-scope-toggle'
          ? toggleSelection(current, env.trees[app.id]?.tree, dataset.index ?? '')
          : removeFromSelection(current, dataset.index ?? '');
      return {
        ...ui,
        selection: { ...ui.selection, [app.id]: next },
        invalid: ui.invalid.filter((entry) => entry !== `app:${app.id}`),
      };
    }
    case 'inc-scope-manage':
      return { ...ui, treeHidden: !(ui.treeHidden ?? false) };
    case 'inc-scope-reset':
      return {
        ...emptyScopeUi(ui.incidentId),
        expanded: ui.expanded,
        ...(ui.treeHidden ? { treeHidden: true } : {}),
      };
    case 'inc-scope-invalid':
      return {
        ...ui,
        invalid: (dataset.fields ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
    case 'inc-scope-saved':
      return {
        ...emptyScopeUi(ui.incidentId),
        expanded: ui.expanded,
        ...(ui.treeHidden ? { treeHidden: true } : {}),
      };
    default:
      return undefined;
  }
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const fr = {
  title: 'Définition du périmètre',
  sub: 'Sélection des éléments à inclure dans l’investigation.',
  modes: 'Mode d’investigation',
  modeTabs: { GUIDED: 'Mode guidé', MANUAL: 'Mode manuel', AUTO_WITHIN_SCOPE: 'Mode automatique' } as Record<
    ScopeMode,
    string
  >,
  modeHints: {
    MANUAL: 'Rien n’est lancé ni proposé sans vous.',
    GUIDED: 'Les extensions et vérifications sont proposées ; chacune attend votre clic.',
    AUTO_WITHIN_SCOPE:
      'Les vérifications sans effet de bord autorisées s’exécutent seules ; le périmètre ne s’étend jamais seul.',
  } as Record<ScopeMode, string>,
  applications: 'Applications',
  selected: (count: number, total: number) =>
    `${String(count)} application(s) sélectionnée(s) sur ${String(total)}`,
  manage: 'Gérer',
  manageClose: 'Réduire',
  manageHint: 'Affiche ou masque les dossiers de chaque application.',
  noApplication:
    'Aucune application dans le périmètre : analysez un dépôt dans « Applications et dépôts », ci-dessus.',
  layers: { FRONTEND: 'Frontend', BFF: 'BFF', BACKEND: 'Backend' } as Record<CodeLayer, string>,
  wholeApp: 'tout le dépôt',
  expand: (name: string) => `Déplier ${name}`,
  collapse: (name: string) => `Replier ${name}`,
  treeLoading: 'Lecture des dossiers…',
  treeDenied: 'Votre rôle ne permet pas de parcourir les dépôts.',
  treeError: (message: string) => `Lecture des dossiers impossible : ${message}`,
  treeRetry: 'Relire les dossiers',
  treeDemo: 'Arborescence indisponible en démonstration.',
  treeEmpty: 'Aucun sous-dossier lisible.',
  truncated: 'sous-dossiers non affichés (profondeur de lecture)',
  replaceNote:
    'Décocher un dossier couvert par son parent remplace ce parent par ses autres sous-dossiers : les fichiers posés directement dans le parent ne sont alors plus inclus.',
  appEmpty: 'Aucun dossier retenu : cocher l’application entière ou au moins un dossier.',
  depth: 'Profondeur d’analyse',
  depthLevels: {
    1: 'Limitée',
    2: 'Réduite',
    3: 'Standard',
    4: 'Étendue',
    5: 'Complète',
  } as Record<number, string>,
  depthValue: (depth: number, level: string) => `${String(depth)} sur 5 — ${level}`,
  depthHint: 'Nombre de sauts dans le code depuis l’endpoint observé.',
  included: (count: number) => `Éléments inclus (${String(count)})`,
  noIncluded: 'Aucun élément inclus.',
  remove: (path: string, app: string) => `Retirer ${path} de ${app}`,
  limits: 'Limites de ressources',
  duration: 'Durée max (min)',
  memory: 'Mémoire max (Mio)',
  memoryEmpty: 'Vide : aucune limite de mémoire.',
  memoryNotApplied: (target: string) =>
    `Sans effet en ${target} : seul un Job ARO borne la mémoire de son conteneur.`,
  memoryApplied: 'Imposée au conteneur du Job ARO.',
  moreLimits: 'Plus de limites',
  maxFiles: 'Fichiers lus au plus',
  maxFileKib: 'Taille max d’un fichier (Kio)',
  maxRequests: 'Requêtes au plus',
  maxExperiments: 'Vérifications au plus',
  limitErrors: {
    duration: 'Un nombre entier de minutes, de 1 à 120.',
    memory: 'Un nombre entier de Mio, de 64 à 16384 (ou vide).',
    maxFiles: 'Un nombre entier positif.',
    maxFileKib: 'Un nombre entier positif.',
    maxRequests: 'Un nombre entier positif.',
    maxExperiments: 'Un nombre entier positif.',
  } as Record<ScopeLimitField, string>,
  invalid: 'Corriger les éléments signalés avant de continuer.',
  dirty: 'Modifications non enregistrées.',
  reset: 'Annuler les modifications',
  next: 'Étape suivante',
  nextHint: 'Enregistre le périmètre, le vérifie, puis ouvre « Environnement ».',
  nextReadOnly: 'Ouvre « Environnement ».',
  readOnly: 'Lecture seule : votre rôle ne permet pas de modifier le périmètre.',
  check: 'Vérifier le périmètre enregistré',
  valid: 'Périmètre valide : les dépôts, hôtes et limites sont acceptés.',
  issues: (count: number) => `${String(count)} problème(s) dans le périmètre`,
  locked: 'Le périmètre ne change pas pendant une reproduction ni après une annulation.',
};

const en: typeof fr = {
  title: 'Scope definition',
  sub: 'Choose what the investigation includes.',
  modes: 'Investigation mode',
  modeTabs: { GUIDED: 'Guided mode', MANUAL: 'Manual mode', AUTO_WITHIN_SCOPE: 'Automatic mode' },
  modeHints: {
    MANUAL: 'Nothing is started or proposed without you.',
    GUIDED: 'Extensions and verifications are proposed; each waits for your click.',
    AUTO_WITHIN_SCOPE:
      'Allowed verifications without side effects run on their own; the scope never grows by itself.',
  },
  applications: 'Applications',
  selected: (count, total) => `${String(count)} application(s) selected out of ${String(total)}`,
  manage: 'Manage',
  manageClose: 'Collapse',
  manageHint: 'Shows or hides the folders of each application.',
  noApplication:
    'No application in the scope: analyze a repository in “Applications and repositories”, above.',
  layers: { FRONTEND: 'Frontend', BFF: 'BFF', BACKEND: 'Backend' },
  wholeApp: 'whole repository',
  expand: (name) => `Expand ${name}`,
  collapse: (name) => `Collapse ${name}`,
  treeLoading: 'Reading the folders…',
  treeDenied: 'Your role does not allow browsing the repositories.',
  treeError: (message) => `The folders could not be read: ${message}`,
  treeRetry: 'Read the folders again',
  treeDemo: 'Folder tree unavailable in the demonstration.',
  treeEmpty: 'No readable subfolder.',
  truncated: 'subfolders not shown (read depth)',
  replaceNote:
    'Unchecking a folder covered by its parent replaces that parent with its other subfolders: files lying directly in the parent are then no longer included.',
  appEmpty: 'Nothing kept: check the whole application or at least one folder.',
  depth: 'Analysis depth',
  depthLevels: { 1: 'Limited', 2: 'Reduced', 3: 'Standard', 4: 'Extended', 5: 'Complete' },
  depthValue: (depth, level) => `${String(depth)} of 5 — ${level}`,
  depthHint: 'Number of hops in the code from the observed endpoint.',
  included: (count) => `Included items (${String(count)})`,
  noIncluded: 'No included item.',
  remove: (path, app) => `Remove ${path} from ${app}`,
  limits: 'Resource limits',
  duration: 'Max duration (min)',
  memory: 'Max memory (MiB)',
  memoryEmpty: 'Empty: no memory limit.',
  memoryNotApplied: (target) => `No effect in ${target}: only an ARO Job bounds the memory of its container.`,
  memoryApplied: 'Set on the container of the ARO Job.',
  moreLimits: 'More limits',
  maxFiles: 'Files read at most',
  maxFileKib: 'Max file size (KiB)',
  maxRequests: 'Requests at most',
  maxExperiments: 'Verifications at most',
  limitErrors: {
    duration: 'A whole number of minutes, from 1 to 120.',
    memory: 'A whole number of MiB, from 64 to 16384 (or empty).',
    maxFiles: 'A positive whole number.',
    maxFileKib: 'A positive whole number.',
    maxRequests: 'A positive whole number.',
    maxExperiments: 'A positive whole number.',
  },
  invalid: 'Fix the flagged items before going on.',
  dirty: 'Unsaved changes.',
  reset: 'Discard the changes',
  next: 'Next step',
  nextHint: 'Saves the scope, checks it, then opens “Environment”.',
  nextReadOnly: 'Opens “Environment”.',
  readOnly: 'Read only: your role does not allow changing the scope.',
  check: 'Check the saved scope',
  valid: 'Valid scope: repositories, hosts and limits are accepted.',
  issues: (count) => `${String(count)} issue(s) in the scope`,
  locked: 'The scope does not change during a reproduction nor after a cancellation.',
};

const TEXT: Record<Lang, typeof fr> = { fr, en };

export const scopeText = (lang: Lang): typeof fr => TEXT[lang];

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

/** Ce que l'écran lit du contexte de l'espace (un WorkspaceContext complet convient). */
export type ScopeContext = Pick<WorkspaceContext, 'incident' | 'lang' | 'can' | 'demo'>;

const FOLDER =
  '<svg class="ico inc-sc-folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

const layerPill = (lang: Lang, layer: CodeLayer): string =>
  `<span class="inc-sc-layer inc-sc-l-${layer.toLowerCase()}">${esc(TEXT[lang].layers[layer])}</span>`;

const box = (state: CheckState): string =>
  `<span class="inc-sc-box" aria-hidden="true">${state === 'true' ? icon('check') : state === 'mixed' ? '<span class="inc-sc-dash"></span>' : ''}</span>`;

function checkbox(
  app: ScopeApplication,
  path: string,
  state: CheckState,
  label: string,
  disabled: boolean,
  extra = '',
  attrs = '',
): string {
  return `<button type="button" role="checkbox" class="inc-sc-cb" aria-checked="${state}"${attrs} data-action="inc-scope-toggle" data-block="${esc(app.id)}" data-index="${esc(path)}"${disabled ? ' disabled' : ''}>${box(state)}${label}${extra}</button>`;
}

function expander(lang: Lang, app: ScopeApplication, path: string, name: string, open: boolean): string {
  const t = TEXT[lang];
  return `<button type="button" class="inc-sc-exp" data-action="inc-scope-expand" data-block="${esc(app.id)}" data-index="${esc(path)}" data-open="${String(open)}" aria-expanded="${String(open)}" aria-label="${esc(open ? t.collapse(name) : t.expand(name))}">${icon(open ? 'down' : 'right')}</button>`;
}

/** Les dossiers de premier niveau sont dépliés d'office quand ils sont peu nombreux (au plus 8). */
const OPEN_FIRST_LEVEL = 8;

/**
 * Un nœud déplié : le choix de la personne, sinon la racine, un dossier partiellement retenu (on voit ce qui
 * l'est) et, pour un petit dépôt, les dossiers de premier niveau.
 */
function isOpen(ui: ScopeUi, app: ScopeApplication, path: string, state: CheckState, siblings = 0): boolean {
  const explicit = ui.expanded[nodeKey(app.id, path)];
  if (explicit !== undefined) return explicit;
  return path === '' || state === 'mixed' || (!path.includes('/') && siblings <= OPEN_FIRST_LEVEL);
}

function folderNodes(
  ctx: ScopeContext,
  ui: ScopeUi,
  app: ScopeApplication,
  selection: AppSelection,
  nodes: readonly ScopeTreeNode[],
  disabled: boolean,
): string {
  const t = TEXT[ctx.lang];
  return `<ul class="inc-sc-tree" role="list">${nodes
    .map((node) => {
      const path = normalizePath(node.path);
      const state = nodeCheck(selection, path);
      const hasChildren = node.children.length > 0;
      const open = hasChildren && isOpen(ui, app, path, state, nodes.length);
      const name = `${node.name}/`;
      const lead = hasChildren
        ? expander(ctx.lang, app, path, name, open)
        : '<span class="inc-sc-gap" aria-hidden="true"></span>';
      const truncated = node.truncated
        ? `<small class="mu inc-sc-trunc" title="${esc(t.truncated)}">…<span class="sr"> ${esc(t.truncated)}</span></small>`
        : '';
      return `<li><div class="inc-sc-row">${lead}${checkbox(app, path, state, `${FOLDER}<span class="inc-sc-name" title="${esc(path)}">${esc(name)}</span>`, disabled)}${truncated}</div>${
        open ? folderNodes(ctx, ui, app, selection, node.children, disabled) : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

function treeBody(
  ctx: ScopeContext,
  ui: ScopeUi,
  app: ScopeApplication,
  selection: AppSelection,
  entry: ScopeTreeEntry | undefined,
  disabled: boolean,
): string {
  const t = TEXT[ctx.lang];
  if (ctx.demo) return `<p class="mu inc-sc-note">${esc(t.treeDemo)}</p>`;
  if (!ctx.can('RUN')) return `<p class="mu inc-sc-note">${esc(t.treeDenied)}</p>`;
  if (entry?.tree) {
    const children = entry.tree.root.children;
    return children.length === 0
      ? `<p class="mu inc-sc-note">${esc(t.treeEmpty)}</p>`
      : folderNodes(ctx, ui, app, selection, children, disabled);
  }
  const state = entry?.state;
  if (state === 'denied') return `<p class="mu inc-sc-note">${esc(t.treeDenied)}</p>`;
  if (state && typeof state === 'object')
    return `<div class="inc-sc-note" role="alert"><p class="err">${esc(t.treeError(state.error))}</p><button type="button" class="btn small" data-action="inc-scope-tree-retry" data-block="${esc(app.id)}">${icon('refresh')}<span>${esc(t.treeRetry)}</span></button></div>`;
  return `<p class="mu inc-sc-note" aria-busy="true"><span class="spin sm" aria-hidden="true"></span> ${esc(t.treeLoading)}</p>`;
}

/** Le résumé de la sélection : les applications retenues (entières ou par dossiers), leurs noms, « Gérer ». */
function selectionSummary(ctx: ScopeContext, ui: ScopeUi): string {
  const t = TEXT[ctx.lang];
  const apps = ctx.incident.scope.applications;
  if (apps.length === 0) return '';
  const kept = apps.filter((app) => {
    const selection = selectionOf(app, ui);
    return selection.whole || selection.paths.length > 0;
  });
  const hidden = ui.treeHidden === true;
  return `<div class="inc-sc-sel"><div class="inc-sc-sel-t"><b>${esc(t.selected(kept.length, apps.length))}</b><span class="inc-sc-sel-n">${kept.map((app) => `<span class="inc-sc-sel-a">${layerPill(ctx.lang, app.layer)}${esc(app.name)}</span>`).join('')}</span></div><button type="button" class="btn small" data-action="inc-scope-manage" aria-expanded="${String(!hidden)}"${hidden ? '' : ' aria-controls="inc-sc-apps-tree"'} title="${esc(t.manageHint)}">${icon(hidden ? 'down' : 'up')}<span>${esc(hidden ? t.manage : t.manageClose)}</span></button></div>`;
}

function applicationsTree(ctx: ScopeContext, ui: ScopeUi, trees: ScopeTrees, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const apps = ctx.incident.scope.applications;
  if (apps.length === 0) return `<p class="mu">${esc(t.noApplication)}</p>`;
  return `<ul class="inc-sc-tree inc-sc-apps-list" id="inc-sc-apps-tree" role="list">${apps
    .map((app) => {
      const selection = selectionOf(app, ui);
      const state = nodeCheck(selection, '');
      const open = isOpen(ui, app, '', state);
      const empty = ui.invalid.includes(`app:${app.id}`);
      const errorId = `inc-sc-app-${app.id}-e`;
      const label = `<span class="inc-sc-name inc-sc-app-name" title="${esc(app.repository.root)}">${esc(app.name)}</span>`;
      const extra = layerPill(ctx.lang, app.layer);
      const cb = checkbox(
        app,
        '',
        state,
        label,
        disabled,
        extra,
        empty ? ` aria-invalid="true" aria-describedby="${esc(errorId)}"` : '',
      );
      return `<li class="inc-sc-app"><div class="inc-sc-row">${expander(ctx.lang, app, '', app.name, open)}${cb}</div>${
        empty
          ? `<p id="${esc(errorId)}" class="err inc-sc-field-err">${icon('alert')}<span>${esc(t.appEmpty)}</span></p>`
          : ''
      }${open ? treeBody(ctx, ui, app, selection, trees[app.id], disabled) : ''}</li>`;
    })
    .join('')}</ul>`;
}

/** Les éléments inclus : une ligne par application entière ou par dossier retenu. */
export function includedItems(incident: Incident, ui: ScopeUi): { app: ScopeApplication; path: string }[] {
  return incident.scope.applications.flatMap((app) => {
    const selection = selectionOf(app, ui);
    return selection.whole ? [{ app, path: '' }] : selection.paths.map((path) => ({ app, path }));
  });
}

function includedList(ctx: ScopeContext, ui: ScopeUi, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const items = includedItems(ctx.incident, ui);
  const list =
    items.length === 0
      ? `<p class="mu">${esc(t.noIncluded)}</p>`
      : `<ul class="inc-sc-inc" role="list">${items
          .map(({ app, path }) => {
            const shown = path === '' ? t.wholeApp : `${path}/`;
            return `<li>${layerPill(ctx.lang, app.layer)}<span class="inc-sc-inc-t"><small class="mu">${esc(app.name)}</small><code title="${esc(path === '' ? app.repository.root : path)}">${esc(shown)}</code></span>${
              disabled
                ? ''
                : `<button type="button" class="inc-sc-rm" data-action="inc-scope-remove" data-block="${esc(app.id)}" data-index="${esc(path)}" aria-label="${esc(t.remove(shown, app.name))}" title="${esc(t.remove(shown, app.name))}">${icon('close')}</button>`
            }</li>`;
          })
          .join('')}</ul>`;
  return `<section class="inc-sc-box-s" aria-labelledby="inc-sc-inc-t"><h3 id="inc-sc-inc-t">${esc(t.included(items.length))}</h3>${list}</section>`;
}

function depthControl(ctx: ScopeContext, ui: ScopeUi, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const depth = ui.depth ?? ctx.incident.scope.depth;
  const level = t.depthLevels[depth] ?? String(depth);
  const ticks = [1, 2, 3, 4, 5]
    .map(
      (value) =>
        `<span class="${value === depth ? 'on' : ''}"><b>${String(value)}</b>${value % 2 === 1 ? `<small>${esc(t.depthLevels[value] ?? '')}</small>` : ''}</span>`,
    )
    .join('');
  return `<section class="inc-sc-box-s inc-sc-depth"><label for="inc-sc-depth" class="inc-sc-h">${esc(t.depth)}</label><input type="range" id="inc-sc-depth" data-inc="scope.range" min="${String(MIN_SCOPE_DEPTH)}" max="${String(MAX_SCOPE_DEPTH)}" step="1" value="${String(depth)}" aria-valuetext="${esc(t.depthValue(depth, level))}" aria-describedby="inc-sc-depth-h"${disabled ? ' disabled' : ''}><div class="inc-sc-ticks" aria-hidden="true">${ticks}</div><small id="inc-sc-depth-h" class="mu"><b class="inc-sc-depth-v">${esc(t.depthValue(depth, level))}</b> · ${esc(t.depthHint)}</small></section>`;
}

function limitField(
  ctx: ScopeContext,
  ui: ScopeUi,
  field: ScopeLimitField,
  text: string,
  disabled: boolean,
  options: { min: number; max?: number; hint?: string },
): string {
  const t = TEXT[ctx.lang];
  const id = `inc-sc-limit-${field}`;
  const invalid = ui.invalid.includes(`limit:${field}`);
  const described = [invalid ? `${id}-e` : '', options.hint ? `${id}-h` : ''].filter(Boolean).join(' ');
  return `<div class="inc-sc-limit"><label class="field" for="${id}">${esc(text)}<input id="${id}" type="number" inputmode="numeric" data-inc="scope.limit.${field}" min="${String(options.min)}"${options.max !== undefined ? ` max="${String(options.max)}"` : ''} step="1" value="${esc(limitValue(ctx.incident.scope.limits, ui, field))}"${invalid ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}${disabled ? ' disabled' : ''}></label>${
    invalid
      ? `<small id="${id}-e" class="err inc-sc-field-err">${icon('alert')}<span>${esc(t.limitErrors[field])}</span></small>`
      : ''
  }${options.hint ? `<small id="${id}-h" class="mu">${esc(options.hint)}</small>` : ''}</div>`;
}

function limitsBlock(ctx: ScopeContext, ui: ScopeUi, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const target = ctx.incident.execution.target;
  const memoryHint = `${target === 'ARO' ? t.memoryApplied : t.memoryNotApplied(target === 'LOCAL' ? 'LOCAL' : 'REMOTE')} ${t.memoryEmpty}`;
  const more = `<details class="inc-sc-more"${(['maxFiles', 'maxFileKib', 'maxRequests', 'maxExperiments'] as const).some((field) => ui.invalid.includes(`limit:${field}`)) ? ' open' : ''}><summary>${esc(t.moreLimits)}</summary><div class="inc-sc-limits">${limitField(ctx, ui, 'maxFiles', t.maxFiles, disabled, { min: 1 })}${limitField(ctx, ui, 'maxFileKib', t.maxFileKib, disabled, { min: 1 })}${limitField(ctx, ui, 'maxRequests', t.maxRequests, disabled, { min: 1 })}${limitField(ctx, ui, 'maxExperiments', t.maxExperiments, disabled, { min: 1 })}</div></details>`;
  return `<section class="inc-sc-box-s" aria-labelledby="inc-sc-lim-t"><h3 id="inc-sc-lim-t">${esc(t.limits)}</h3><div class="inc-sc-limits">${limitField(ctx, ui, 'duration', t.duration, disabled, { min: SCOPE_BOUNDS.durationMin.min, max: SCOPE_BOUNDS.durationMin.max })}${limitField(ctx, ui, 'memory', t.memory, disabled, { min: SCOPE_BOUNDS.memoryMb.min, max: SCOPE_BOUNDS.memoryMb.max, hint: memoryHint })}</div>${more}</section>`;
}

/**
 * L'écran « Définition du périmètre ». `trees` : les arborescences lues par application. `opts.busy` : une
 * opération est en cours (boutons désactivés). Le bouton « Étape suivante » vaut `inc-scope-next` quand le
 * périmètre est modifiable (enregistrer si modifié, valider, puis ouvrir « Environnement »), sinon il
 * navigue seulement (`ws-ux-stage`, étape `environment`).
 */
export function renderScopeEditor(
  ctx: ScopeContext,
  ui: ScopeUi,
  trees: ScopeTrees,
  opts: {
    busy?: boolean;
    validation?: { ok: boolean; issues: { field: string; message: string }[] };
  } = {},
): string {
  const t = TEXT[ctx.lang];
  const incident = ctx.incident;
  const editable = scopeEditable(ctx);
  const disabled = !editable || opts.busy === true;
  const treeHidden = ui.treeHidden === true && incident.scope.applications.length > 0;
  const mode = ui.mode ?? incident.scope.mode;
  const modes = `<div class="inc-sc-modes" role="radiogroup" aria-label="${esc(t.modes)}">${SCOPE_MODES_ORDER.map(
    (key) =>
      `<button type="button" role="radio" class="inc-sc-mode" data-action="inc-scope-mode" data-mode="${key}" data-index="${key}" aria-checked="${String(key === mode)}" tabindex="${key === mode ? '0' : '-1'}" aria-describedby="inc-sc-mode-h"${disabled ? ' disabled' : ''}>${esc(t.modeTabs[key])}</button>`,
  ).join('')}</div><p id="inc-sc-mode-h" class="mu inc-sc-mode-h">${esc(t.modeHints[mode])}</p>`;
  const dirty = editable && scopeDirty(incident, ui);
  const problems = ui.invalid.length > 0 ? `<p class="err" role="alert">${esc(t.invalid)}</p>` : '';
  const notes = !ctx.can('RUN')
    ? `<p class="note">${icon('info')}<span>${esc(t.readOnly)}</span></p>`
    : !editable && !ctx.demo
      ? `<p class="note">${icon('info')}<span>${esc(t.locked)}</span></p>`
      : '';
  const next = editable
    ? `<button type="button" class="btn primary" data-action="inc-scope-next" aria-describedby="inc-sc-next-h" aria-busy="${String(opts.busy === true)}"${opts.busy ? ' disabled' : ''}><span>${esc(t.next)}</span>${icon('right')}</button><small id="inc-sc-next-h" class="sr">${esc(t.nextHint)}</small>`
    : `<button type="button" class="btn primary" data-action="ws-ux-stage" data-stage="environment" aria-describedby="inc-sc-next-h"><span>${esc(t.next)}</span>${icon('right')}</button><small id="inc-sc-next-h" class="sr">${esc(t.nextReadOnly)}</small>`;
  const validation = opts.validation
    ? opts.validation.ok
      ? `<p class="ok-t" role="status">${icon('check')}<span>${esc(t.valid)}</span></p>`
      : `<div role="alert" class="inc-sc-issues"><p class="err"><b>${esc(t.issues(opts.validation.issues.length))}</b></p><ul class="checks">${opts.validation.issues.map((issue) => `<li class="ko">${icon('cross')}<span><code>${esc(issue.field)}</code> ${esc(issue.message)}</span></li>`).join('')}</ul></div>`
    : '';
  const check =
    ctx.can('RUN') && !ctx.demo
      ? `<button type="button" class="btn" data-action="inc-validate"${opts.busy || incident.state === 'CANCELLED' ? ' disabled' : ''}>${esc(t.check)}</button>`
      : '';
  const footer = `<div class="inc-sc-foot">${check}${dirty ? `<span class="mu">${esc(t.dirty)}</span><button type="button" class="btn ghost" data-action="inc-scope-reset"${opts.busy ? ' disabled' : ''}>${esc(t.reset)}</button>` : ''}${next}</div>`;
  return `<section class="card wide inc-sc" aria-labelledby="inc-sc-t"><div class="inc-sc-head"><div><h2 id="inc-sc-t" class="fl">${esc(t.title)}</h2><p class="mu">${esc(t.sub)}</p></div></div>${notes}${modes}<div class="inc-sc-grid"><section class="inc-sc-box-s inc-sc-apps" aria-labelledby="inc-sc-apps-t"><h3 id="inc-sc-apps-t">${icon('code')}<span>${esc(t.applications)}</span></h3>${selectionSummary(ctx, ui)}${treeHidden ? '' : applicationsTree(ctx, ui, trees, disabled)}${editable && !treeHidden && incident.scope.applications.length > 0 ? `<p class="mu inc-sc-note">${esc(t.replaceNote)}</p>` : ''}</section><div class="inc-sc-side">${depthControl(ctx, ui, disabled)}${includedList(ctx, ui, disabled)}${limitsBlock(ctx, ui, disabled)}</div></div>${problems}${validation}${footer}</section>`;
}

/** Le texte de la profondeur (aria-valuetext et légende), pour la mise à jour pendant le glissement. */
export function depthText(lang: Lang, depth: number): string {
  const t = TEXT[lang];
  return t.depthValue(depth, t.depthLevels[depth] ?? String(depth));
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** Les styles de l'écran (préfixe `inc-sc-`) : jetons du thème seulement, clair et sombre. */
export const INCIDENT_SCOPE_CSS = `
.inc-sc{display:flex;flex-direction:column;gap:12px;min-width:0}
.inc-sc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
.inc-sc-head h2{margin:0}
.inc-sc-head p{margin:2px 0 0}
.inc-sc-modes{display:inline-flex;align-self:flex-start;max-width:100%;gap:4px;padding:4px;border-radius:12px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow-x:auto;scrollbar-width:thin}
.inc-sc-mode{flex:none;min-height:36px;padding:0 16px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--qa-color-muted);font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.inc-sc-mode:hover:not(:disabled){color:var(--qa-color-text);background:color-mix(in srgb,var(--qa-color-surface) 60%,var(--qa-color-surface-2))}
.inc-sc-mode[aria-checked="true"]{color:var(--qa-color-primary-2);background:var(--qa-color-surface);border-color:color-mix(in srgb,var(--qa-color-primary) 30%,var(--qa-color-border));box-shadow:0 1px 2px color-mix(in srgb,var(--qa-color-text) 8%,transparent)}
.inc-sc-mode:disabled{cursor:default}
.inc-sc-mode:disabled:not([aria-checked="true"]){opacity:.75}
.inc-sc-mode-h{margin:0;font-size:13px}
.inc-sc-grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(300px,1.15fr);gap:12px;align-items:start;min-width:0}
.inc-sc-side{display:flex;flex-direction:column;gap:12px;min-width:0}
.inc-sc-box-s{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;background:var(--qa-color-surface);display:flex;flex-direction:column;gap:8px;min-width:0}
.inc-sc-box-s h3,.inc-sc-h{margin:0;font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px}
.inc-sc-box-s h3 .ico{width:16px;height:16px;color:var(--qa-color-muted)}
.inc-sc-apps{max-height:min(62vh,560px);overflow:auto}
.inc-sc-sel{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;background:var(--qa-color-primary-soft-2);border:1px solid color-mix(in srgb,var(--qa-color-primary) 18%,var(--qa-color-border))}
.inc-sc-sel-t{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 220px}
.inc-sc-sel-t b{font-size:13px;color:var(--qa-color-primary-2)}
.inc-sc-sel-n{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:13px}
.inc-sc-sel-a{display:inline-flex;align-items:center;gap:6px;min-width:0}
.inc-sc-sel .btn{align-self:center}
.inc-sc-tree{list-style:none;margin:0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:1px}
.inc-sc-apps-list{padding-left:0}
.inc-sc-row{display:flex;align-items:center;gap:2px;min-width:0}
.inc-sc-exp,.inc-sc-gap{flex:none;width:24px;height:28px}
.inc-sc-exp{display:inline-grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--qa-color-muted);cursor:pointer;padding:0}
.inc-sc-exp:hover{background:var(--qa-color-surface-2);color:var(--qa-color-text)}
.inc-sc-exp .ico{width:14px;height:14px}
.inc-sc-cb{display:inline-flex;align-items:center;gap:6px;min-height:28px;min-width:0;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--qa-color-text);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.inc-sc-cb:hover:not(:disabled){background:var(--qa-color-surface-2)}
.inc-sc-cb:disabled{cursor:default}
.inc-sc-cb:focus-visible,.inc-sc-exp:focus-visible,.inc-sc-mode:focus-visible,.inc-sc-rm:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.inc-sc-box{flex:none;width:16px;height:16px;border-radius:4px;border:2px solid var(--qa-color-border-strong);background:var(--qa-color-surface);display:grid;place-items:center;color:var(--qa-color-surface)}
.inc-sc-cb[aria-checked="true"] .inc-sc-box,.inc-sc-cb[aria-checked="mixed"] .inc-sc-box{border-color:var(--qa-color-primary);background:var(--qa-color-primary)}
.inc-sc-cb[aria-invalid="true"] .inc-sc-box{border-color:var(--qa-color-danger)}
.inc-sc-cb:disabled .inc-sc-box{opacity:.7}
.inc-sc-box .ico{width:12px;height:12px;stroke-width:3.5}
.inc-sc-dash{display:block;width:8px;height:2px;border-radius:1px;background:var(--qa-color-surface)}
.inc-sc-folder{width:15px;height:15px;color:var(--qa-color-muted);flex:none}
.inc-sc-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--qa-font-mono,ui-monospace,monospace);font-size:12.5px}
.inc-sc-app-name{font-family:inherit;font-size:13.5px;font-weight:600}
.inc-sc-trunc{flex:none}
.inc-sc-layer{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap;flex:none;border:1px solid var(--qa-color-border)}
.inc-sc-l-frontend{color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface))}
.inc-sc-l-bff{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.inc-sc-l-backend{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));background:var(--qa-color-success-soft)}
.inc-sc-note{margin:4px 0 4px 26px;font-size:12.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.inc-sc-apps>.inc-sc-note{margin-left:0}
.inc-sc-field-err{display:flex;align-items:center;gap:4px;margin:0 0 0 26px;font-size:12.5px;font-weight:500}
.inc-sc-limit .inc-sc-field-err{margin:2px 0 0}
.inc-sc-field-err .ico{width:14px;height:14px;flex:none}
.inc-sc-depth input[type="range"]{width:100%;accent-color:var(--qa-color-primary);margin:4px 0 0}
.inc-sc-ticks{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));font-size:12px;color:var(--qa-color-muted)}
.inc-sc-ticks>span{display:flex;flex-direction:column;align-items:center;gap:0;text-align:center}
.inc-sc-ticks>span:first-child{align-items:flex-start;text-align:left}
.inc-sc-ticks>span:last-child{align-items:flex-end;text-align:right}
.inc-sc-ticks>span.on{color:var(--qa-color-primary);font-weight:600}
.inc-sc-ticks small{font-size:12px}
.inc-sc-inc{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}
.inc-sc-inc li{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 4px 4px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2)}
.inc-sc-inc-t{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}
.inc-sc-inc-t small{font-size:11.5px;line-height:1.2}
.inc-sc-inc-t code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;background:transparent;border:0;padding:0;color:var(--qa-color-text)}
.inc-sc-rm{flex:none;width:28px;height:28px;display:inline-grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--qa-color-muted);cursor:pointer;padding:0}
.inc-sc-rm:hover{background:var(--qa-color-danger-soft);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.inc-sc-rm .ico{width:14px;height:14px}
.inc-sc-limits{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 12px;align-items:start}
.inc-sc-limit{display:flex;flex-direction:column;gap:2px;min-width:0}
.inc-sc-limit small.mu{font-size:12px}
.inc-sc-limit input[aria-invalid="true"]{border-color:var(--qa-color-danger);box-shadow:0 0 0 1px var(--qa-color-danger)}
.inc-sc-more summary{cursor:pointer;font-size:13px;color:var(--qa-color-primary);padding:4px 0}
.inc-sc-more[open] summary{margin-bottom:6px}
.inc-sc-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.inc-sc-foot>.btn[data-action="inc-validate"]{margin-right:auto}
.inc-sc-issues{display:flex;flex-direction:column;gap:4px}
.inc-sc-issues p{margin:0}
.inc-sc-foot .btn .ico{width:16px;height:16px}
@container (max-width:760px){
  .inc-sc-grid{grid-template-columns:minmax(0,1fr)}
  .inc-sc-apps{max-height:none}
}
@media (max-width:760px){
  .inc-sc-grid{grid-template-columns:minmax(0,1fr)}
  .inc-sc-apps{max-height:none}
}
`;
