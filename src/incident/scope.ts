import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  SCOPE_EXTENSION_KINDS,
  SCOPE_MODES,
  type CodeLayer,
  type InvestigationScope,
  type ResourceLimits,
  type ScopeApplication,
  type ScopeExtension,
  type ScopeExtensionKind,
  type ScopeMode,
  type ScopePermissions,
} from './model.js';

/**
 * LE PÉRIMÈTRE D'INVESTIGATION : valeurs sûres par défaut, validation, extensions demandées puis
 * décidées (une extension approuvée modifie le périmètre ; refusée, elle ne change rien), et ce
 * que chaque mode autorise à faire sans intervention humaine.
 */

export const DEFAULT_PERMISSIONS: Readonly<ScopePermissions> = Object.freeze({
  readSources: true,
  navigate: true,
  httpRequests: 'NONE',
  runTests: 'NONE',
  localCommands: false,
  readLogs: false,
  openshift: 'NONE',
  sideEffects: false,
});

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 524_288,
  maxDurationMs: 600_000,
  maxRequests: 200,
  maxExperiments: 20,
});

/** Plafonds : un périmètre ne peut pas demander davantage, même approuvé. */
export const LIMIT_CAPS: Readonly<ResourceLimits> = Object.freeze({
  maxFiles: 100_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxRequests: 10_000,
  maxExperiments: 500,
});

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 5;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const CODE_LAYERS: readonly CodeLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const IPV6_BRACKETED = /^\[[0-9a-f:.]+\]$/i;
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const JAVA_CLASS = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const APPLICATION_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const EXECUTABLE = /^(\.\/)?[A-Za-z0-9][\w.+-]{0,63}$/;
const SELECTOR = /^[\w./-]+(=|==|!=)[\w./-]*(,[\w./-]+(=|==|!=)[\w./-]*)*$/;

/** Le périmètre sûr par défaut, complété par `partial` (permissions et limites fusionnées champ à champ). */
export function defaultScope(partial: Partial<InvestigationScope> = {}): InvestigationScope {
  const defined = Object.fromEntries(
    Object.entries(partial as Record<string, unknown>).filter(([, value]) => value !== undefined),
  ) as Partial<InvestigationScope>;
  const scope: InvestigationScope = {
    mode: 'GUIDED',
    applications: [],
    scenarios: [],
    steps: [],
    endpoints: [],
    depth: 3,
    allowedHosts: [],
    logRoots: [],
    allowedCommands: [],
    extensions: [],
    ...defined,
    permissions: { ...DEFAULT_PERMISSIONS, ...defined.permissions },
    limits: { ...DEFAULT_LIMITS, ...defined.limits },
  };
  return structuredClone(scope);
}

/** « host », « host:port », « [::1]:8080 » ; undefined si l'entrée n'est pas un hôte. */
export function parseHostEntry(entry: string): { host: string; port?: number } | undefined {
  const value = entry.trim().toLowerCase();
  if (value === '') return undefined;
  let host = value;
  let portText: string | undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return undefined;
    host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined;
      portText = rest.slice(1);
    }
    if (!IPV6_BRACKETED.test(host)) return undefined;
  } else {
    const colon = value.lastIndexOf(':');
    if (colon >= 0) {
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
    }
    host = host.replace(/\.$/, '');
    if (!HOSTNAME.test(host)) return undefined;
  }
  if (portText === undefined) return { host };
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65_535) return undefined;
  return { host, port };
}

/** « POST /api/books » → méthode et chemin ; undefined si la forme n'est pas respectée. */
export function parseEndpoint(entry: string): { method: string; path: string } | undefined {
  const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(entry.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const method = match[1].toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) return undefined;
  return { method, path: match[2] };
}

/** Un chemin relatif sans remontée (« .. ») ni chemin absolu. */
export function isSafeRelativePath(value: string): boolean {
  if (value.trim() === '' || value.includes('\0')) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return !value.split(/[\\/]+/).includes('..');
}

/** Une valeur reçue de l'extérieur, affichable même si son type n'est pas celui attendu. */
const shown = (value: unknown): string => String(value);

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Valide un périmètre : racines absolues existantes, dossiers inclus relatifs et existants,
 * endpoints « MÉTHODE /chemin », hôtes, profondeur, limites plafonnées, identifiants uniques,
 * namespaces OpenShift (DNS-1123), racines de journaux absolues.
 */
export async function validateScope(
  scope: InvestigationScope,
): Promise<{ ok: boolean; issues: { field: string; message: string }[] }> {
  const issues: { field: string; message: string }[] = [];
  const issue = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  if (!(SCOPE_MODES as readonly string[]).includes(scope.mode)) {
    issue('mode', `Mode inconnu « ${shown(scope.mode)} » (attendu : ${SCOPE_MODES.join(', ')}).`);
  }

  const ids = new Set<string>();
  for (const [index, application] of scope.applications.entries()) {
    const field = `applications[${index}]`;
    if (!APPLICATION_ID.test(application.id)) {
      issue(`${field}.id`, `Identifiant d'application invalide « ${application.id} ».`);
    } else if (ids.has(application.id)) {
      issue(`${field}.id`, `Identifiant d'application en double « ${application.id} ».`);
    }
    ids.add(application.id);
    if (application.name.trim() === '') issue(`${field}.name`, 'Le nom de l’application est vide.');
    if (!CODE_LAYERS.includes(application.layer)) {
      issue(`${field}.layer`, `Couche inconnue « ${shown(application.layer)} ».`);
    }
    const root = application.repository.root;
    let rootReal: string | undefined;
    if (!path.isAbsolute(root)) {
      issue(`${field}.repository.root`, `La racine du dépôt doit être absolue : « ${root} ».`);
    } else if (!(await isDirectory(root))) {
      issue(
        `${field}.repository.root`,
        `La racine du dépôt n'existe pas ou n'est pas un dossier : « ${root} ».`,
      );
    } else {
      rootReal = await realpath(root);
    }
    for (const [i, include] of application.repository.include.entries()) {
      const includeField = `${field}.repository.include[${i}]`;
      if (!isSafeRelativePath(include)) {
        issue(includeField, `Dossier inclus invalide « ${include} » : relatif à la racine, sans « .. ».`);
        continue;
      }
      if (rootReal === undefined) continue;
      try {
        const real = await realpath(path.join(rootReal, include));
        if (!isWithin(real, rootReal)) {
          issue(includeField, `« ${include} » mène hors de la racine du dépôt (lien symbolique).`);
        }
      } catch {
        issue(includeField, `« ${include} » n'existe pas dans le dépôt.`);
      }
    }
    for (const [i, name] of (application.repository.classes ?? []).entries()) {
      if (!JAVA_CLASS.test(name)) {
        issue(`${field}.repository.classes[${i}]`, `Nom de classe invalide « ${name} ».`);
      }
    }
    if (application.baseUrl !== undefined) {
      try {
        const url = new URL(application.baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          issue(`${field}.baseUrl`, 'L’URL de l’application doit être en http ou https.');
        }
      } catch {
        issue(`${field}.baseUrl`, `URL invalide « ${application.baseUrl} ».`);
      }
    }
    for (const [i, logFile] of (application.logFiles ?? []).entries()) {
      const logField = `${field}.logFiles[${i}]`;
      if (path.isAbsolute(logFile)) {
        if (!scope.logRoots.some((logRoot) => path.isAbsolute(logRoot) && isWithin(logFile, logRoot))) {
          issue(logField, `Le journal absolu « ${logFile} » doit se trouver sous une racine de journaux.`);
        }
      } else if (!isSafeRelativePath(logFile)) {
        issue(logField, `Journal invalide « ${logFile} » : relatif à la racine, sans « .. ».`);
      }
    }
    if (application.openshift) {
      if (!DNS_1123_LABEL.test(application.openshift.namespace)) {
        issue(
          `${field}.openshift.namespace`,
          `Namespace invalide « ${application.openshift.namespace} » (DNS-1123 : minuscules, chiffres, tirets, 63 caractères au plus).`,
        );
      }
      if (!SELECTOR.test(application.openshift.selector)) {
        issue(
          `${field}.openshift.selector`,
          `Sélecteur invalide « ${application.openshift.selector} » (forme attendue : app=books).`,
        );
      }
    }
  }

  for (const [index, scenario] of scope.scenarios.entries()) {
    if (scenario.trim() === '') issue(`scenarios[${index}]`, 'Nom de scénario vide.');
  }
  if (new Set(scope.scenarios).size !== scope.scenarios.length) issue('scenarios', 'Scénario en double.');
  for (const [index, step] of scope.steps.entries()) {
    if (!positiveInteger(step)) issue(`steps[${index}]`, `Étape invalide « ${String(step)} » (entier ≥ 1).`);
  }
  for (const [index, endpoint] of scope.endpoints.entries()) {
    if (!parseEndpoint(endpoint)) {
      issue(
        `endpoints[${index}]`,
        `Endpoint invalide « ${endpoint} » (forme attendue : « POST /api/books »).`,
      );
    }
  }
  if (!Number.isInteger(scope.depth) || scope.depth < MIN_DEPTH || scope.depth > MAX_DEPTH) {
    issue('depth', `La profondeur doit être un entier entre ${MIN_DEPTH} et ${MAX_DEPTH}.`);
  }
  for (const [index, host] of scope.allowedHosts.entries()) {
    if (!parseHostEntry(host)) {
      issue(`allowedHosts[${index}]`, `Hôte invalide « ${host} » (nom d'hôte, éventuellement « :port »).`);
    }
  }
  for (const [index, logRoot] of scope.logRoots.entries()) {
    if (!path.isAbsolute(logRoot))
      issue(`logRoots[${index}]`, `Racine de journaux non absolue « ${logRoot} ».`);
  }
  for (const [index, command] of scope.allowedCommands.entries()) {
    if (!EXECUTABLE.test(command)) {
      issue(`allowedCommands[${index}]`, `Commande invalide « ${command} » (nom d'exécutable attendu).`);
    }
  }
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ResourceLimits)[]) {
    const value = scope.limits[key];
    if (!positiveInteger(value)) {
      issue(`limits.${key}`, `La limite doit être un entier positif.`);
    } else if (value > LIMIT_CAPS[key]) {
      issue(`limits.${key}`, `La limite dépasse le plafond (${LIMIT_CAPS[key]}).`);
    }
  }
  const extensionIds = new Set<string>();
  for (const [index, extension] of scope.extensions.entries()) {
    if (extensionIds.has(extension.id))
      issue(`extensions[${index}].id`, `Extension en double « ${extension.id} ».`);
    extensionIds.add(extension.id);
  }
  return { ok: issues.length === 0, issues };
}

/** Une demande ou une décision d'extension impossible (cible invalide, déjà décidée…). */
export class ScopeExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeExtensionError';
  }
}

function newExtensionId(): string {
  return `ext_${randomBytes(9).toString('base64url')}`;
}

function applicationOf(scope: InvestigationScope, id: string | undefined): ScopeApplication | undefined {
  return id === undefined ? undefined : scope.applications.find((application) => application.id === id);
}

/** Normalise la cible selon le genre d'extension ; lève ScopeExtensionError si elle est invalide. */
function normalizeTarget(
  scope: InvestigationScope,
  kind: ScopeExtensionKind,
  target: string,
  applicationId: string | undefined,
): { target: string; applicationId?: string } {
  const value = target.trim();
  if (value === '' || value.length > 2048 || /[\0\r\n]/.test(value)) {
    throw new ScopeExtensionError('La cible de l’extension est vide ou invalide.');
  }
  switch (kind) {
    case 'ADD_APPLICATION': {
      const { layer, root } = splitLayer(value);
      if (!path.isAbsolute(root)) {
        throw new ScopeExtensionError(
          `La racine de la nouvelle application doit être absolue : « ${root} ».`,
        );
      }
      if (root.split(/[\\/]+/).includes('..')) throw new ScopeExtensionError('Chemin avec « .. » refusé.');
      if (applicationId !== undefined && !APPLICATION_ID.test(applicationId)) {
        throw new ScopeExtensionError(`Identifiant d'application invalide « ${applicationId} ».`);
      }
      if (applicationOf(scope, applicationId)) {
        throw new ScopeExtensionError(`L'application « ${String(applicationId)} » existe déjà.`);
      }
      const normalized = path.normalize(root);
      const existing = scope.applications.find(
        (application) => path.resolve(application.repository.root) === path.resolve(normalized),
      );
      if (existing) {
        throw new ScopeExtensionError(
          `« ${normalized} » est déjà le dépôt de l'application « ${existing.id} ».`,
        );
      }
      return {
        target: layer ? `${layer}:${normalized}` : normalized,
        ...(applicationId ? { applicationId } : {}),
      };
    }
    case 'ADD_PATH': {
      let application = applicationOf(scope, applicationId);
      let relative = value;
      if (path.isAbsolute(value)) {
        application ??= scope.applications.find((candidate) =>
          isWithin(path.resolve(value), path.resolve(candidate.repository.root)),
        );
        if (!application)
          throw new ScopeExtensionError(`« ${value} » n'appartient à aucune application du périmètre.`);
        if (value.split(/[\\/]+/).includes('..')) throw new ScopeExtensionError('Chemin avec « .. » refusé.');
        relative = path.relative(path.resolve(application.repository.root), path.resolve(value)) || '.';
      }
      if (!application) throw new ScopeExtensionError('ADD_PATH exige une application du périmètre.');
      if (relative !== '.' && !isSafeRelativePath(relative)) {
        throw new ScopeExtensionError(`Chemin invalide « ${relative} » : relatif à la racine, sans « .. ».`);
      }
      return { target: path.normalize(relative).split(path.sep).join('/'), applicationId: application.id };
    }
    case 'ADD_CLASS': {
      const application = applicationOf(scope, applicationId);
      if (!application) throw new ScopeExtensionError('ADD_CLASS exige une application du périmètre.');
      if (!JAVA_CLASS.test(value)) throw new ScopeExtensionError(`Nom de classe invalide « ${value} ».`);
      return { target: value, applicationId: application.id };
    }
    case 'ADD_ENDPOINT': {
      const endpoint = parseEndpoint(value);
      if (!endpoint)
        throw new ScopeExtensionError(`Endpoint invalide « ${value} » (forme : « POST /api/books »).`);
      return { target: `${endpoint.method} ${endpoint.path}` };
    }
    case 'ADD_HOST': {
      let hostText = value;
      if (value.includes('://')) {
        try {
          hostText = new URL(value).host;
        } catch {
          throw new ScopeExtensionError(`URL invalide « ${value} ».`);
        }
      }
      const host = parseHostEntry(hostText);
      if (!host) throw new ScopeExtensionError(`Hôte invalide « ${value} ».`);
      return { target: host.port === undefined ? host.host : `${host.host}:${host.port}` };
    }
    case 'RAISE_DEPTH':
      if (scope.depth >= MAX_DEPTH) {
        throw new ScopeExtensionError(`La profondeur est déjà au maximum (${MAX_DEPTH}).`);
      }
      return { target: String(scope.depth + 1) };
    case 'ALLOW_SIDE_EFFECTS':
      return { target: value };
    case 'ALLOW_COMMAND':
      if (!EXECUTABLE.test(value)) throw new ScopeExtensionError(`Commande invalide « ${value} ».`);
      if (ALWAYS_REFUSED_COMMANDS.has(commandName(value))) {
        throw new ScopeExtensionError(`La commande « ${value} » est toujours refusée.`);
      }
      return { target: value };
  }
}

function splitLayer(value: string): { layer?: CodeLayer; root: string } {
  const match = /^(FRONTEND|BFF|BACKEND):(.+)$/.exec(value);
  if (match?.[1] && match[2]) return { layer: match[1] as CodeLayer, root: match[2] };
  return { root: value };
}

/** Le nom d'un exécutable sans chemin ni suffixe Windows, en minuscules. */
export function commandName(command: string): string {
  return path
    .basename(command.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

/** Commandes toujours refusées, quelle que soit l'extension approuvée. */
export const ALWAYS_REFUSED_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'del',
  'rd',
  'shred',
  'truncate',
  'sudo',
  'su',
  'doas',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'mkfs',
  'fdisk',
  'mount',
  'umount',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'systemctl',
  'service',
  'launchctl',
  'crontab',
  'kill',
  'pkill',
  'killall',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'docker',
  'podman',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'powershell',
  'pwsh',
  'cmd',
  'eval',
  'exec',
  'source',
  'env',
  'xargs',
  'nohup',
  'timeout',
  'nice',
  'watch',
]);

/**
 * Enregistre une demande d'extension (statut PENDING). Le périmètre ne change pas tant qu'elle n'est
 * pas approuvée ; une demande identique encore en attente est renvoyée au lieu d'être dupliquée.
 */
export function requestExtension(
  scope: InvestigationScope,
  request: { kind: ScopeExtensionKind; target: string; applicationId?: string; reason: string },
  by: string,
  now: Date,
): { scope: InvestigationScope; extension: ScopeExtension } {
  if (!(SCOPE_EXTENSION_KINDS as readonly string[]).includes(request.kind)) {
    throw new ScopeExtensionError(`Extension inconnue « ${shown(request.kind)} ».`);
  }
  const reason = request.reason.trim();
  if (reason === '') throw new ScopeExtensionError('Une extension doit être motivée.');
  const normalized = normalizeTarget(scope, request.kind, request.target, request.applicationId);
  const pending = scope.extensions.find(
    (extension) =>
      extension.status === 'PENDING' &&
      extension.kind === request.kind &&
      extension.target === normalized.target &&
      extension.applicationId === normalized.applicationId,
  );
  if (pending) return { scope: structuredClone(scope), extension: structuredClone(pending) };
  const extension: ScopeExtension = {
    id: newExtensionId(),
    kind: request.kind,
    target: normalized.target,
    ...(normalized.applicationId !== undefined ? { applicationId: normalized.applicationId } : {}),
    reason: reason.slice(0, 2000),
    status: 'PENDING',
    requestedAt: now.toISOString(),
    requestedBy: by,
  };
  const next = structuredClone(scope);
  next.extensions.push(extension);
  return { scope: next, extension: structuredClone(extension) };
}

function uniqueApplicationId(scope: InvestigationScope, wanted: string): string {
  const base =
    wanted
      .toLowerCase()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 48) || 'app';
  let candidate = base;
  for (let n = 2; scope.applications.some((application) => application.id === candidate); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/** Modifie le périmètre selon une extension approuvée. */
function extend(scope: InvestigationScope, extension: ScopeExtension): void {
  const application = applicationOf(scope, extension.applicationId);
  switch (extension.kind) {
    case 'ADD_APPLICATION': {
      const { layer, root } = splitLayer(extension.target);
      const inferred: CodeLayer =
        layer ?? (existsSync(path.join(root, 'package.json')) ? 'FRONTEND' : 'BACKEND');
      scope.applications.push({
        id: uniqueApplicationId(scope, extension.applicationId ?? path.basename(root)),
        name: path.basename(root) || root,
        layer: inferred,
        repository: { root, include: [] },
      });
      return;
    }
    case 'ADD_PATH': {
      if (!application) throw new ScopeExtensionError('L’application de l’extension n’existe plus.');
      const include = application.repository.include;
      // Liste vide : toute la racine est déjà incluse ; « . » rend toute la racine.
      if (extension.target === '.') application.repository.include = [];
      else if (include.length > 0 && !include.includes(extension.target)) include.push(extension.target);
      return;
    }
    case 'ADD_CLASS': {
      if (!application) throw new ScopeExtensionError('L’application de l’extension n’existe plus.');
      const classes = application.repository.classes;
      // Aucune classe ciblée : toutes le sont déjà.
      if (classes && classes.length > 0 && !classes.includes(extension.target))
        classes.push(extension.target);
      return;
    }
    case 'ADD_ENDPOINT':
      if (!scope.endpoints.includes(extension.target)) scope.endpoints.push(extension.target);
      return;
    case 'ADD_HOST':
      if (!scope.allowedHosts.includes(extension.target)) scope.allowedHosts.push(extension.target);
      return;
    case 'RAISE_DEPTH':
      if (scope.depth >= MAX_DEPTH)
        throw new ScopeExtensionError(`Profondeur maximale (${MAX_DEPTH}) atteinte.`);
      scope.depth += 1;
      return;
    case 'ALLOW_SIDE_EFFECTS':
      scope.permissions.sideEffects = true;
      return;
    case 'ALLOW_COMMAND':
      // L'approbation autorise les commandes locales, pour cet exécutable seulement.
      scope.permissions.localCommands = true;
      if (!scope.allowedCommands.includes(extension.target)) scope.allowedCommands.push(extension.target);
      return;
  }
}

/** Approuve (le périmètre est étendu) ou refuse une extension en attente ; une décision est définitive. */
export function decideExtension(
  scope: InvestigationScope,
  extensionId: string,
  approve: boolean,
  by: string,
  now: Date,
): InvestigationScope {
  const next = structuredClone(scope);
  const extension = next.extensions.find((candidate) => candidate.id === extensionId);
  if (!extension) throw new ScopeExtensionError(`Extension inconnue « ${extensionId} ».`);
  if (extension.status !== 'PENDING') {
    throw new ScopeExtensionError(`L'extension « ${extensionId} » a déjà été décidée (${extension.status}).`);
  }
  if (approve) extend(next, extension);
  extension.status = approve ? 'APPROVED' : 'REJECTED';
  extension.decidedAt = now.toISOString();
  extension.decidedBy = by;
  return next;
}

/** Ce que le mode autorise sans intervention humaine. */
export function automation(mode: ScopeMode): {
  proposeExtensions: boolean;
  autoRunExperiments: boolean;
  askBeforeEachStep: boolean;
} {
  switch (mode) {
    case 'MANUAL':
      return { proposeExtensions: false, autoRunExperiments: false, askBeforeEachStep: true };
    case 'AUTO_WITHIN_SCOPE':
      // Vérifications sans effet de bord lancées seules, jamais d'extension du périmètre.
      return { proposeExtensions: false, autoRunExperiments: true, askBeforeEachStep: false };
    case 'GUIDED':
      return { proposeExtensions: true, autoRunExperiments: false, askBeforeEachStep: false };
  }
}
