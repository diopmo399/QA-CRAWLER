import { isIP } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExecutionEnvironmentConfig,
  InvestigationScope,
  PolicyDecision,
  PolicyOperation,
  ScopeApplication,
  ScopeExtension,
} from './model.js';
import { ALWAYS_REFUSED_COMMANDS, commandName, parseHostEntry } from './scope.js';

/**
 * LE SCOPE POLICY ENGINE : toute opération de l'investigation (lire un fichier, un journal, naviguer,
 * envoyer une requête, lancer un test ou une commande, consulter OpenShift) est refusée par défaut et
 * n'est permise que si le périmètre l'autorise explicitement. Les chemins sont jugés sur leur chemin
 * réel (liens symboliques résolus) ; chaque décision est conservée (audit) et chaque refus dit la
 * règle, la raison et, quand elle existe, l'extension de périmètre qui la rendrait possible.
 */

export class ScopeDeniedError extends Error {
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super(`Refusé par le périmètre (${decision.rule}) : ${decision.reason}`);
    this.name = 'ScopeDeniedError';
    this.decision = decision;
  }
}

export interface ScopePolicyOptions {
  /** Hôtes de l'environnement cible (hôte, hôte:port ou URL de base). */
  extraHosts?: string[];
  /** Namespaces OpenShift déclarés par la configuration d'exécution. */
  namespaces?: string[];
  /** La configuration d'exécution : ses namespaces (REMOTE, ARO) sont autorisés en lecture. */
  execution?: ExecutionEnvironmentConfig;
  /**
   * Résolution DNS facultative (protection contre un nom qui pointe vers une adresse interdite) :
   * les adresses renvoyées passent par les mêmes règles que les adresses littérales.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

type Extension = Pick<ScopeExtension, 'kind' | 'target' | 'applicationId'>;
type BudgetResource = 'file' | 'request' | 'experiment';

// ── Fichiers sensibles ───────────────────────────────────────────────────────────────────────

const SENSITIVE_DIRECTORIES = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.svn',
]);
const SENSITIVE_NAMES: readonly RegExp[] = [
  /^\.env/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /credentials/i,
  /^\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|pgpass|htpasswd|dockercfg|git-credentials)$/i,
  /^settings(-security)?\.xml$/i,
  /^kubeconfig/i,
  /(^|[._-])secrets?\.(ya?ml|json|properties|env|txt)$/i,
];

/** Un chemin dont un segment désigne un dossier ou un fichier sensible (clé, secret, dépôt git…). */
export function isSensitivePath(file: string): boolean {
  const segments = file.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment.toLowerCase()))) return true;
  const name = segments.at(-1) ?? '';
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

/** Une valeur reçue de l'extérieur (l'opération peut venir d'une requête), toujours affichable. */
const shown = (value: unknown): string => String(value);

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

async function realOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

// ── Adresses interdites (métadonnées cloud, lien local) ──────────────────────────────────────

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);
const METADATA_IPV4 = new Set(['100.100.100.200', '192.0.0.192', '169.254.169.254', '169.254.170.2']);

function ipv4Parts(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split('.').map(Number);
}

/** Les 8 groupes d'une adresse IPv6 (forme compacte et IPv4 terminale acceptées). */
function ipv6Groups(address: string): number[] | undefined {
  let value = address.toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (isIP(value) !== 6) return undefined;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (tail?.[1]) {
    const v4 = ipv4Parts(tail[1]);
    if (!v4) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    value = `${value.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = value.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: rest === undefined ? 0 : missing }, () => '0'), ...right];
  if (groups.length !== 8) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

/** Pourquoi une adresse ou un nom est interdit (métadonnées cloud, lien local) ; undefined sinon. */
export function forbiddenAddress(hostname: string): string | undefined {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (METADATA_HOSTNAMES.has(host) || host.endsWith('.metadata.google.internal')) {
    return `« ${host} » est un service de métadonnées cloud.`;
  }
  const v4 = ipv4Parts(host);
  if (v4) return forbiddenIpv4(v4);
  const v6 = ipv6Groups(host);
  if (v6) {
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6;
    if ((g0 & 0xffc0) === 0xfe80) return `« ${host} » est une adresse IPv6 de lien local (fe80::/10).`;
    if (g0 === 0xfd00 && g1 === 0x0ec2) return `« ${host} » est le service de métadonnées cloud (IPv6).`;
    // IPv4 encapsulée : ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d.
    const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0);
    const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
    if ((mapped || nat64) && (g6 !== 0 || g7 > 1)) {
      return forbiddenIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
    }
  }
  return undefined;
}

function forbiddenIpv4(parts: number[]): string | undefined {
  const address = parts.join('.');
  if (METADATA_IPV4.has(address)) return `« ${address} » est un service de métadonnées cloud.`;
  if (parts[0] === 169 && parts[1] === 254)
    return `« ${address} » est une adresse de lien local (169.254.0.0/16).`;
  return undefined;
}

// ── Commandes ────────────────────────────────────────────────────────────────────────────────

/** Métacaractères du shell : jamais dans un argument, même sans shell. */
const METACHARACTERS = /[;|&`<>()\r\n\0]|\$\(|\$\{/;

const TEST_COMMANDS = new Set(['mvn', './mvnw', 'mvnw', 'gradle', './gradlew', 'npm', 'npx', 'pnpm', 'yarn']);

const MAVEN_GOALS = new Set(['clean', 'compile', 'test-compile', 'test', 'surefire:test']);
const MAVEN_INTEGRATION_GOALS = new Set([
  'verify',
  'integration-test',
  'failsafe:integration-test',
  'failsafe:verify',
]);
const MAVEN_FORBIDDEN = /^(deploy|install|release(:.*)?|site-deploy|site(:.*)?|deploy:.*|install:.*)$/;
const MAVEN_SKIP = /^-D(skipTests|maven\.test\.skip|skipITs)(=|$)/i;
/** Options Maven suivies d'une valeur séparée. */
const MAVEN_VALUE_OPTIONS = new Set([
  '-pl',
  '--projects',
  '-P',
  '--activate-profiles',
  '-T',
  '--threads',
  '-rf',
  '--resume-from',
  '-f',
  '--file',
  '-D',
  '--define',
]);
const MAVEN_REFUSED_OPTIONS = new Set(['-s', '--settings', '-gs', '--global-settings', '-t', '--toolchains']);

const GRADLE_TASK =
  /^(:[\w-]+)*:?(test|integrationTest|check|clean|compileJava|compileTestJava|testClasses|compileKotlin|compileTestKotlin)$/;
const GRADLE_TEST_TASK = /(^|:)(test|integrationTest|check)$/;
const GRADLE_VALUE_OPTIONS = new Set(['--tests', '-p', '--project-dir', '-P', '-D', '--max-workers']);
const GRADLE_REFUSED_OPTIONS = new Set([
  '-I',
  '--init-script',
  '-c',
  '--settings-file',
  '-b',
  '--build-file',
  '-x',
  '--exclude-task',
]);

const SCRIPT_TEST = /^test([:._-][\w:.-]*)?$/;

const GIT_READ_VERBS = new Set([
  'status',
  'log',
  'show',
  'diff',
  'blame',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
  'rev-list',
  'branch',
  'version',
  '--version',
]);
const KUBE_READ_VERBS = new Set([
  'get',
  'describe',
  'logs',
  'events',
  'explain',
  'api-resources',
  'version',
  'top',
  'whoami',
]);
const INLINE_CODE_FLAGS: Record<string, ReadonlySet<string>> = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  php: new Set(['-r']),
  deno: new Set(['eval']),
  java: new Set(['--source']),
};
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls']);
/** Lanceurs dont le premier argument est lui-même exécuté. */
const RUNNERS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
};

// ── OpenShift ────────────────────────────────────────────────────────────────────────────────

const OPENSHIFT_VERBS = new Set(['get', 'describe', 'logs', 'events']);
const OPENSHIFT_RESOURCES: Record<string, string> = {
  pod: 'pods',
  pods: 'pods',
  po: 'pods',
  deployment: 'deployments',
  deployments: 'deployments',
  deploy: 'deployments',
  replicaset: 'replicasets',
  replicasets: 'replicasets',
  rs: 'replicasets',
  event: 'events',
  events: 'events',
  ev: 'events',
  service: 'services',
  services: 'services',
  svc: 'services',
  route: 'routes',
  routes: 'routes',
  log: 'logs',
  logs: 'logs',
};
const OPENSHIFT_SENSITIVE = /^(secrets?|configmaps?|cm|serviceaccounts?|sa|tokens?|serviceaccounttokens?)$/;
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface AllowedHost {
  host: string;
  /** Absent : tous les ports. */
  port?: number;
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function hostOfUrl(value: string): AllowedHost | undefined {
  try {
    const url = new URL(value);
    return { host: normalizeHost(url.hostname), port: Number(url.port) || defaultPort(url.protocol) };
  } catch {
    return undefined;
  }
}

function allowedHostOf(entry: string): AllowedHost | undefined {
  if (entry.includes('://')) return hostOfUrl(entry);
  const parsed = parseHostEntry(entry);
  if (!parsed) return undefined;
  return { host: normalizeHost(parsed.host), ...(parsed.port !== undefined ? { port: parsed.port } : {}) };
}

/**
 * Le Scope Policy Engine d'une investigation. Refus par défaut : une opération inconnue, un champ
 * manquant ou une erreur pendant l'examen donnent un refus.
 */
export class ScopePolicy {
  readonly scope: InvestigationScope;
  readonly decisions: PolicyDecision[] = [];
  private readonly hosts: AllowedHost[];
  private readonly namespaces: Set<string>;
  private readonly resolveHost: ((hostname: string) => Promise<string[]>) | undefined;
  private readonly roots = new Map<string, string | undefined>();
  private readonly used: Record<BudgetResource, number> = { file: 0, request: 0, experiment: 0 };

  constructor(scope: InvestigationScope, options: ScopePolicyOptions = {}) {
    this.scope = structuredClone(scope);
    const entries = [
      ...this.scope.allowedHosts.map(allowedHostOf),
      ...this.scope.applications.map((application) =>
        application.baseUrl ? hostOfUrl(application.baseUrl) : undefined,
      ),
      ...(options.extraHosts ?? []).map(allowedHostOf),
    ];
    this.hosts = entries.filter((entry): entry is AllowedHost => entry !== undefined);
    this.namespaces = new Set(
      [
        ...this.scope.applications.map((application) => application.openshift?.namespace),
        ...(options.namespaces ?? []),
        options.execution?.remote?.openshift?.namespace,
        options.execution?.aro?.namespace,
      ].filter((namespace): namespace is string => typeof namespace === 'string' && namespace !== ''),
    );
    this.resolveHost = options.resolveHost;
  }

  /** Décide (sans lever) et conserve la décision. */
  async check(operation: PolicyOperation): Promise<PolicyDecision> {
    let decision: PolicyDecision;
    try {
      decision = await this.decide(operation);
    } catch (error) {
      decision = this.deny(
        operation,
        'internal.error',
        `Examen impossible, refus par défaut : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.decisions.push(decision);
    return decision;
  }

  /** Comme check, mais lève ScopeDeniedError sur un refus. */
  async require(operation: PolicyOperation): Promise<PolicyDecision> {
    const decision = await this.check(operation);
    if (!decision.allowed) throw new ScopeDeniedError(decision);
    return decision;
  }

  /** Consomme une unité du budget ; false (sans rien consommer) une fois le budget épuisé. */
  consume(resource: BudgetResource): boolean {
    const limit =
      resource === 'file'
        ? this.scope.limits.maxFiles
        : resource === 'request'
          ? this.scope.limits.maxRequests
          : this.scope.limits.maxExperiments;
    if (this.used[resource] >= limit) return false;
    this.used[resource] += 1;
    return true;
  }

  /** Ce qui a été consommé de chaque budget. */
  usage(): Readonly<Record<BudgetResource, number>> {
    return { ...this.used };
  }

  // ── Décisions ──────────────────────────────────────────────────────────────────────────────

  private allow(
    operation: PolicyOperation,
    rule: string,
    reason: string,
    resolvedPath?: string,
  ): PolicyDecision {
    return {
      allowed: true,
      rule,
      reason,
      operation,
      ...(resolvedPath !== undefined ? { resolvedPath } : {}),
    };
  }

  private deny(
    operation: PolicyOperation,
    rule: string,
    reason: string,
    extra: { extension?: Extension; resolvedPath?: string } = {},
  ): PolicyDecision {
    return { allowed: false, rule, reason, operation, ...extra };
  }

  private async decide(operation: PolicyOperation): Promise<PolicyDecision> {
    switch (operation.kind) {
      case 'READ_FILE':
      case 'LIST_DIR':
        return this.decideSource(operation);
      case 'READ_LOG':
        return this.decideLog(operation);
      case 'NAVIGATE':
        if (!this.scope.permissions.navigate) {
          return this.deny(
            operation,
            'permissions.navigate',
            'La navigation n’est pas autorisée par le périmètre.',
          );
        }
        return this.decideUrl(operation, operation.url, 'navigate');
      case 'HTTP':
        return this.decideHttp(operation);
      case 'RUN_TEST':
        return this.decideTest(operation);
      case 'COMMAND':
        return this.decideCommand(operation);
      case 'OPENSHIFT':
        return this.decideOpenshift(operation);
      default:
        return this.deny(
          operation,
          'operation.unknown',
          `Opération inconnue « ${String((operation as { kind?: unknown }).kind)} » : refusée par défaut.`,
        );
    }
  }

  /** Le chemin réel de la racine d'une application (mis en cache) ; undefined si elle n'existe pas. */
  private async rootOf(application: ScopeApplication): Promise<string | undefined> {
    const root = application.repository.root;
    if (!path.isAbsolute(root)) return undefined;
    if (!this.roots.has(root)) this.roots.set(root, await realOrUndefined(root));
    return this.roots.get(root);
  }

  private invalidPath(operation: PolicyOperation, value: unknown): PolicyDecision | undefined {
    if (typeof value !== 'string' || value === '' || value.includes('\0')) {
      return this.deny(operation, 'path.invalid', 'Chemin vide ou invalide.');
    }
    if (!path.isAbsolute(value)) {
      return this.deny(operation, 'path.absolute', `Le chemin doit être absolu : « ${value} ».`);
    }
    if (hasParentSegment(value)) {
      return this.deny(operation, 'path.traversal', `Remontée « .. » refusée : « ${value} ».`);
    }
    return undefined;
  }

  private async decideSource(
    operation: Extract<PolicyOperation, { kind: 'READ_FILE' | 'LIST_DIR' }>,
  ): Promise<PolicyDecision> {
    if (!this.scope.permissions.readSources) {
      return this.deny(
        operation,
        'permissions.readSources',
        'La lecture des sources n’est pas autorisée par le périmètre.',
      );
    }
    const invalid = this.invalidPath(operation, operation.path);
    if (invalid) return invalid;
    const requested = path.resolve(operation.path);
    const applications =
      operation.applicationId === undefined
        ? this.scope.applications
        : this.scope.applications.filter((application) => application.id === operation.applicationId);
    if (operation.applicationId !== undefined && applications.length === 0) {
      return this.deny(
        operation,
        'application.unknown',
        `Application inconnue « ${operation.applicationId} ».`,
      );
    }
    if (isSensitivePath(path.basename(requested))) {
      return this.deny(
        operation,
        'path.sensitive',
        `Fichier sensible refusé : « ${path.basename(requested)} ».`,
      );
    }
    const real = await realOrUndefined(requested);
    if (real === undefined) {
      return this.deny(operation, 'path.missing', `Chemin introuvable : « ${operation.path} ».`);
    }

    const candidates: { application: ScopeApplication; root: string }[] = [];
    let escapedFrom: ScopeApplication | undefined;
    for (const application of applications) {
      const root = await this.rootOf(application);
      if (root === undefined) continue;
      if (isWithin(real, root)) candidates.push({ application, root });
      else if (isWithin(requested, root) || isWithin(requested, path.resolve(application.repository.root))) {
        escapedFrom = application;
      }
    }
    if (candidates.length === 0) {
      if (escapedFrom) {
        return this.deny(
          operation,
          'path.symlink-escape',
          `« ${operation.path} » est un lien symbolique qui mène hors du dépôt « ${escapedFrom.id} » (${real}).`,
          { resolvedPath: real },
        );
      }
      const directory = operation.kind === 'LIST_DIR' ? real : path.dirname(real);
      return this.deny(
        operation,
        'path.outside-scope',
        `« ${operation.path} » est hors des dépôts du périmètre.`,
        {
          resolvedPath: real,
          extension: { kind: 'ADD_APPLICATION', target: directory },
        },
      );
    }

    let suggestion: { application: ScopeApplication; relative: string } | undefined;
    for (const { application, root } of candidates) {
      const relative = path.relative(root, real);
      if (isSensitivePath(relative) || isSensitivePath(path.basename(real))) {
        return this.deny(operation, 'path.sensitive', `Fichier sensible refusé : « ${relative || real} ».`, {
          resolvedPath: real,
        });
      }
      const verdict = await this.includes(application, root, real, operation.kind === 'LIST_DIR');
      if (verdict === undefined) {
        const directory = operation.kind === 'LIST_DIR' ? relative : path.dirname(relative);
        suggestion ??= { application, relative: (directory || '.').split(path.sep).join('/') };
        continue;
      }
      const info = await stat(real);
      if (operation.kind === 'LIST_DIR') {
        if (!info.isDirectory()) {
          return this.deny(operation, 'path.not-directory', `« ${operation.path} » n'est pas un dossier.`, {
            resolvedPath: real,
          });
        }
      } else {
        if (!info.isFile()) {
          return this.deny(operation, 'path.not-file', `« ${operation.path} » n'est pas un fichier.`, {
            resolvedPath: real,
          });
        }
        if (info.size > this.scope.limits.maxFileBytes) {
          return this.deny(
            operation,
            'limits.maxFileBytes',
            `« ${relative} » fait ${info.size} octets, au-delà de la limite (${this.scope.limits.maxFileBytes}).`,
            { resolvedPath: real },
          );
        }
      }
      return this.allow(
        operation,
        verdict,
        `Dans le périmètre de « ${application.id} » : ${relative || '.'}`,
        real,
      );
    }
    const target = suggestion ?? { application: candidates[0]?.application, relative: '.' };
    const applicationId = target.application?.id;
    return this.deny(
      operation,
      'path.outside-include',
      `« ${operation.path} » est dans le dépôt « ${String(applicationId)} » mais hors des dossiers inclus.`,
      {
        resolvedPath: real,
        extension: {
          kind: 'ADD_PATH',
          target: target.relative,
          ...(applicationId !== undefined ? { applicationId } : {}),
        },
      },
    );
  }

  /** La règle qui inclut `real` dans les dossiers de l'application ; undefined s'il en est exclu. */
  private async includes(
    application: ScopeApplication,
    root: string,
    real: string,
    directory: boolean,
  ): Promise<string | undefined> {
    const include = application.repository.include;
    if (include.length === 0) return 'path.in-scope';
    let ancestor = false;
    for (const entry of include) {
      if (hasParentSegment(entry) || path.isAbsolute(entry)) continue;
      const included = await realOrUndefined(path.join(root, entry));
      if (included === undefined || !isWithin(included, root)) continue;
      if (isWithin(real, included)) return 'path.in-scope';
      // Un dossier parent d'un dossier inclus peut être parcouru pour l'atteindre.
      if (directory && isWithin(included, real)) ancestor = true;
    }
    return ancestor ? 'path.include-ancestor' : undefined;
  }

  private async decideLog(
    operation: Extract<PolicyOperation, { kind: 'READ_LOG' }>,
  ): Promise<PolicyDecision> {
    if (!this.scope.permissions.readLogs) {
      return this.deny(
        operation,
        'permissions.readLogs',
        'La lecture des journaux n’est pas autorisée par le périmètre.',
      );
    }
    const invalid = this.invalidPath(operation, operation.path);
    if (invalid) return invalid;
    const real = await realOrUndefined(operation.path);
    if (real === undefined)
      return this.deny(operation, 'path.missing', `Journal introuvable : « ${operation.path} ».`);
    if (isSensitivePath(path.basename(real)) || isSensitivePath(path.basename(operation.path))) {
      return this.deny(operation, 'path.sensitive', `Fichier sensible refusé : « ${operation.path} ».`, {
        resolvedPath: real,
      });
    }
    let allowed: string | undefined;
    for (const logRoot of this.scope.logRoots) {
      if (!path.isAbsolute(logRoot)) continue;
      const rootReal = await realOrUndefined(logRoot);
      if (rootReal !== undefined && isWithin(real, rootReal)) {
        allowed = `Sous la racine de journaux « ${logRoot} ».`;
        break;
      }
    }
    if (allowed === undefined) {
      for (const application of this.scope.applications) {
        const root = await this.rootOf(application);
        for (const logFile of application.logFiles ?? []) {
          if (hasParentSegment(logFile)) continue;
          const declared = path.isAbsolute(logFile) ? logFile : root ? path.join(root, logFile) : undefined;
          if (declared === undefined) continue;
          if ((await realOrUndefined(declared)) === real) {
            allowed = `Journal déclaré par « ${application.id} ».`;
            break;
          }
        }
        if (allowed !== undefined) break;
      }
    }
    if (allowed === undefined) {
      return this.deny(
        operation,
        'log.outside-scope',
        `« ${operation.path} » n'est ni sous une racine de journaux ni un journal déclaré.`,
        { resolvedPath: real },
      );
    }
    if (!(await stat(real)).isFile()) {
      return this.deny(operation, 'path.not-file', `« ${operation.path} » n'est pas un fichier.`, {
        resolvedPath: real,
      });
    }
    return this.allow(operation, 'log.in-scope', allowed, real);
  }

  private async decideUrl(
    operation: PolicyOperation,
    value: string,
    prefix: string,
  ): Promise<PolicyDecision> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return this.deny(operation, `${prefix}.url`, `URL invalide « ${shown(value)} ».`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return this.deny(
        operation,
        `${prefix}.protocol`,
        `Seuls http et https sont permis (« ${url.protocol} »).`,
      );
    }
    if (url.username !== '' || url.password !== '') {
      return this.deny(operation, `${prefix}.credentials`, 'Une URL ne doit pas porter d’identifiants.');
    }
    const host = normalizeHost(url.hostname);
    const forbidden = forbiddenAddress(host);
    if (forbidden) return this.deny(operation, 'network.metadata', `${forbidden} Toujours refusé.`);
    const port = Number(url.port) || defaultPort(url.protocol);
    const known = this.hosts.some(
      (entry) => entry.host === host && (entry.port === undefined || entry.port === port),
    );
    if (!known) {
      return this.deny(
        operation,
        'network.host',
        `L'hôte « ${url.host} » n'est pas autorisé par le périmètre.`,
        {
          extension: { kind: 'ADD_HOST', target: url.host },
        },
      );
    }
    if (this.resolveHost && isIP(host) === 0) {
      let addresses: string[];
      try {
        addresses = await this.resolveHost(host);
      } catch {
        addresses = [];
      }
      for (const address of addresses) {
        const reason = forbiddenAddress(address);
        if (reason) {
          return this.deny(operation, 'network.metadata', `« ${host} » se résout en ${address} : ${reason}`);
        }
      }
    }
    return this.allow(operation, `${prefix}.host`, `Hôte autorisé « ${url.host} ».`);
  }

  private async decideHttp(operation: Extract<PolicyOperation, { kind: 'HTTP' }>): Promise<PolicyDecision> {
    const level = this.scope.permissions.httpRequests;
    const method = shown(operation.method).toUpperCase();
    if (level === 'NONE') {
      return this.deny(
        operation,
        'permissions.httpRequests',
        'Aucune requête HTTP directe n’est autorisée par le périmètre.',
      );
    }
    if (!SAFE_HTTP_METHODS.has(method) && !WRITE_HTTP_METHODS.has(method)) {
      return this.deny(operation, 'http.method', `Méthode HTTP refusée « ${method} ».`);
    }
    if (level === 'READ_ONLY' && !SAFE_HTTP_METHODS.has(method)) {
      return this.deny(
        operation,
        'http.read-only',
        `Requêtes en lecture seule (GET, HEAD, OPTIONS) : « ${method} » refusée.`,
      );
    }
    if (WRITE_HTTP_METHODS.has(method) && !this.scope.permissions.sideEffects) {
      return this.deny(
        operation,
        'permissions.sideEffects',
        `« ${method} » peut modifier des données : approbation des effets de bord exigée.`,
        {
          extension: { kind: 'ALLOW_SIDE_EFFECTS', target: `${method} ${operation.url}` },
        },
      );
    }
    return this.decideUrl(operation, operation.url, 'http');
  }

  /** Arguments : liste de chaînes, sans métacaractère du shell. */
  private invalidArgs(operation: PolicyOperation, args: unknown): PolicyDecision | undefined {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) {
      return this.deny(operation, 'command.args', 'Arguments invalides.');
    }
    const bad = (args as string[]).find((arg) => METACHARACTERS.test(arg));
    if (bad !== undefined) {
      return this.deny(
        operation,
        'command.metacharacters',
        `Métacaractère du shell refusé dans « ${bad.slice(0, 120)} ».`,
      );
    }
    return undefined;
  }

  private async cwdDecision(operation: PolicyOperation, cwd: unknown): Promise<PolicyDecision | undefined> {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || hasParentSegment(cwd) || cwd.includes('\0')) {
      return this.deny(
        operation,
        'command.cwd',
        'Le dossier de travail doit être un chemin absolu, sans « .. ».',
      );
    }
    const real = await realOrUndefined(cwd);
    if (real === undefined)
      return this.deny(operation, 'command.cwd', `Dossier de travail introuvable « ${cwd} ».`);
    for (const application of this.scope.applications) {
      const root = await this.rootOf(application);
      if (root !== undefined && isWithin(real, root)) {
        if (isSensitivePath(path.relative(root, real))) {
          return this.deny(operation, 'path.sensitive', `Dossier sensible refusé « ${cwd} ».`, {
            resolvedPath: real,
          });
        }
        return undefined;
      }
    }
    return this.deny(operation, 'command.cwd', `« ${cwd} » n'est dans aucun dépôt du périmètre.`, {
      resolvedPath: real,
      extension: { kind: 'ADD_APPLICATION', target: real },
    });
  }

  private async decideTest(
    operation: Extract<PolicyOperation, { kind: 'RUN_TEST' }>,
  ): Promise<PolicyDecision> {
    const level = this.scope.permissions.runTests;
    const requested: unknown = operation.level;
    if (requested !== 'UNIT' && requested !== 'INTEGRATION') {
      return this.deny(operation, 'test.level', `Niveau de test inconnu « ${shown(requested)} ».`);
    }
    if (level === 'NONE' || (level === 'UNIT' && operation.level === 'INTEGRATION')) {
      return this.deny(
        operation,
        'permissions.runTests',
        `Les tests ${operation.level} ne sont pas autorisés (niveau du périmètre : ${level}).`,
      );
    }
    if (operation.level === 'INTEGRATION' && !this.scope.permissions.sideEffects) {
      return this.deny(
        operation,
        'permissions.sideEffects',
        'Un test d’intégration peut modifier des données : approbation des effets de bord exigée.',
        {
          extension: {
            kind: 'ALLOW_SIDE_EFFECTS',
            target: `${operation.command} ${operation.args.join(' ')}`.slice(0, 500),
          },
        },
      );
    }
    if (!TEST_COMMANDS.has(operation.command)) {
      return this.deny(
        operation,
        'test.command',
        `« ${shown(operation.command)} » n'est pas une commande de test autorisée (${[...TEST_COMMANDS].join(', ')}).`,
      );
    }
    const invalid = this.invalidArgs(operation, operation.args);
    if (invalid) return invalid;
    const refused = testInvocationProblem(operation.command, operation.args, operation.level);
    if (refused) return this.deny(operation, 'test.args', refused);
    const cwd = await this.cwdDecision(operation, operation.cwd);
    if (cwd) return cwd;
    return this.allow(
      operation,
      'test.allowed',
      `Test ${operation.level} « ${operation.command} ${operation.args.join(' ')} » autorisé.`,
    );
  }

  private async decideCommand(
    operation: Extract<PolicyOperation, { kind: 'COMMAND' }>,
  ): Promise<PolicyDecision> {
    if (
      typeof operation.command !== 'string' ||
      operation.command.trim() === '' ||
      METACHARACTERS.test(operation.command)
    ) {
      return this.deny(operation, 'command.invalid', 'Commande vide ou invalide.');
    }
    const invalid = this.invalidArgs(operation, operation.args);
    if (invalid) return invalid;
    const dangerous = dangerousCommand(operation.command, operation.args);
    if (dangerous) return this.deny(operation, 'command.dangerous', dangerous);
    if (!this.scope.permissions.localCommands || !this.scope.allowedCommands.includes(operation.command)) {
      return this.deny(
        operation,
        this.scope.permissions.localCommands ? 'command.not-allowed' : 'permissions.localCommands',
        `La commande « ${operation.command} » n'est pas autorisée par le périmètre.`,
        { extension: { kind: 'ALLOW_COMMAND', target: operation.command } },
      );
    }
    const cwd = await this.cwdDecision(operation, operation.cwd);
    if (cwd) return cwd;
    return this.allow(
      operation,
      'command.allowed',
      `Commande « ${operation.command} » autorisée par extension approuvée.`,
    );
  }

  private decideOpenshift(operation: Extract<PolicyOperation, { kind: 'OPENSHIFT' }>): PolicyDecision {
    if (this.scope.permissions.openshift !== 'READ') {
      return this.deny(
        operation,
        'permissions.openshift',
        'La consultation OpenShift n’est pas autorisée par le périmètre.',
      );
    }
    const verb = shown(operation.verb).toLowerCase();
    const [kind = ''] = shown(operation.resource).toLowerCase().split('/');
    if (OPENSHIFT_SENSITIVE.test(kind)) {
      return this.deny(
        operation,
        'openshift.sensitive-resource',
        `« ${kind} » peut contenir des secrets : toujours refusé.`,
      );
    }
    if (!OPENSHIFT_VERBS.has(verb)) {
      return this.deny(
        operation,
        'openshift.verb',
        `Verbe OpenShift refusé « ${verb} » (lecture seule : ${[...OPENSHIFT_VERBS].join(', ')}).`,
      );
    }
    const resource = OPENSHIFT_RESOURCES[kind];
    if (resource === undefined) {
      return this.deny(operation, 'openshift.resource', `Ressource OpenShift refusée « ${kind} ».`);
    }
    const namespace = shown(operation.namespace);
    if (!DNS_1123_LABEL.test(namespace) || !this.namespaces.has(namespace)) {
      return this.deny(
        operation,
        'openshift.namespace',
        `Namespace non déclaré « ${namespace} » (déclarés : ${[...this.namespaces].join(', ') || 'aucun'}).`,
      );
    }
    return this.allow(operation, 'openshift.read', `Lecture « ${verb} ${resource} » dans « ${namespace} ».`);
  }
}

/** Pourquoi les arguments ne forment pas une simple invocation de tests ; undefined s'ils en forment une. */
export function testInvocationProblem(
  command: string,
  args: readonly string[],
  level: 'UNIT' | 'INTEGRATION',
): string | undefined {
  switch (command) {
    case 'mvn':
    case 'mvnw':
    case './mvnw':
      return mavenProblem(args, level);
    case 'gradle':
    case './gradlew':
      return gradleProblem(args, level);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return scriptProblem(command, args);
    case 'npx':
      return npxProblem(args);
    default:
      return `« ${command} » n'est pas une commande de test.`;
  }
}

function mavenProblem(args: readonly string[], level: 'UNIT' | 'INTEGRATION'): string | undefined {
  let test = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (MAVEN_SKIP.test(arg)) return `« ${arg} » désactive les tests.`;
    if (MAVEN_REFUSED_OPTIONS.has(arg) || /^--?(s|gs|settings|global-settings)=/.test(arg)) {
      return `Option Maven refusée « ${arg} » (fichier de configuration externe).`;
    }
    if (arg.startsWith('-')) {
      if (/^-Dtest=./.test(arg) || /^-Dit\.test=./.test(arg)) test = true;
      if (MAVEN_VALUE_OPTIONS.has(arg)) {
        const value = args[i + 1] ?? '';
        if (arg === '-D' || arg === '--define') {
          if (MAVEN_SKIP.test(`-D${value}`)) return `« ${value} » désactive les tests.`;
          if (/^test=./.test(value)) test = true;
        } else if (hasParentSegment(value) || path.isAbsolute(value)) {
          return `Valeur refusée « ${value} » : relative au dépôt, sans « .. ».`;
        }
        i += 1;
      } else if (arg.startsWith('--file=') || arg.startsWith('--projects=')) {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (hasParentSegment(value) || path.isAbsolute(value)) return `Valeur refusée « ${arg} ».`;
      }
      continue;
    }
    if (MAVEN_FORBIDDEN.test(arg))
      return `Phase Maven refusée « ${arg} » (déploiement, installation, publication).`;
    if (MAVEN_GOALS.has(arg)) {
      if (arg === 'test' || arg === 'surefire:test') test = true;
      continue;
    }
    if (MAVEN_INTEGRATION_GOALS.has(arg)) {
      if (level !== 'INTEGRATION')
        return `« ${arg} » lance des tests d'intégration : niveau INTEGRATION exigé.`;
      test = true;
      continue;
    }
    return `But Maven refusé « ${arg} » (permis : ${[...MAVEN_GOALS, ...MAVEN_INTEGRATION_GOALS].join(', ')}).`;
  }
  return test ? undefined : 'Une invocation Maven doit contenir le but « test » ou « -Dtest=… ».';
}

function gradleProblem(args: readonly string[], level: 'UNIT' | 'INTEGRATION'): string | undefined {
  let test = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (
      GRADLE_REFUSED_OPTIONS.has(arg) ||
      /^--(init-script|settings-file|build-file|exclude-task)=/.test(arg)
    ) {
      return `Option Gradle refusée « ${arg} ».`;
    }
    if (arg.startsWith('-')) {
      if (GRADLE_VALUE_OPTIONS.has(arg)) {
        const value = args[i + 1] ?? '';
        if (
          (arg === '-p' || arg === '--project-dir') &&
          (hasParentSegment(value) || path.isAbsolute(value))
        ) {
          return `Valeur refusée « ${value} » : relative au dépôt, sans « .. ».`;
        }
        i += 1;
      }
      continue;
    }
    if (!GRADLE_TASK.test(arg)) return `Cible Gradle refusée « ${arg} ».`;
    if (/integrationTest$/.test(arg) && level !== 'INTEGRATION') {
      return `« ${arg} » lance des tests d'intégration : niveau INTEGRATION exigé.`;
    }
    if (GRADLE_TEST_TASK.test(arg)) test = true;
  }
  return test
    ? undefined
    : 'Une invocation Gradle doit contenir « test » (ou « integrationTest », « check »).';
}

function scriptProblem(command: string, args: readonly string[]): string | undefined {
  let i = 0;
  // Options de tête sans effet sur ce qui est exécuté.
  while (
    i < args.length &&
    /^(--silent|-s|--if-present|--workspace=[\w@/.-]+|-w|--workspace|--filter|--filter=[\w@/.*-]+)$/.test(
      args[i] ?? '',
    )
  ) {
    if (args[i] === '-w' || args[i] === '--workspace' || args[i] === '--filter') {
      const value = args[i + 1] ?? '';
      if (!/^[\w@/.*-]+$/.test(value) || hasParentSegment(value)) return `Valeur refusée « ${value} ».`;
      i += 1;
    }
    i += 1;
  }
  const first = args[i];
  if (first === 'test' || first === 't') return undefined;
  if (first === 'run' || first === 'run-script') {
    const script = args[i + 1] ?? '';
    return SCRIPT_TEST.test(script) ? undefined : `Seuls les scripts « test… » sont permis (« ${script} »).`;
  }
  if (command !== 'npm' && first !== undefined && SCRIPT_TEST.test(first)) return undefined;
  return `« ${command} » : seuls « test » et « run test… » sont permis.`;
}

function npxProblem(args: readonly string[]): string | undefined {
  let i = 0;
  while (i < args.length && /^(--no-install|--no|--offline|--prefer-offline)$/.test(args[i] ?? '')) i += 1;
  const tool = args[i];
  if (tool === 'vitest' && args[i + 1] === 'run') return undefined;
  if (tool === 'jest') return undefined;
  return 'npx : seuls « vitest run » et « jest » sont permis (sans installation).';
}

/** Pourquoi une commande ou ses arguments sont dangereux ; undefined sinon. */
export function dangerousCommand(command: string, args: readonly string[]): string | undefined {
  const name = commandName(command);
  if (ALWAYS_REFUSED_COMMANDS.has(name) || name.startsWith('mkfs')) {
    return `La commande « ${name} » est toujours refusée.`;
  }
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const refusedArg = positional.find((arg) => {
    const argName = commandName(arg);
    return ALWAYS_REFUSED_COMMANDS.has(argName) || argName.startsWith('mkfs');
  });
  if (refusedArg !== undefined) return `L'argument « ${refusedArg} » désigne une commande toujours refusée.`;
  if (name === 'git') {
    if (
      args.some(
        (arg) =>
          arg === '-c' ||
          arg.startsWith('--exec-path') ||
          arg.startsWith('--upload-pack') ||
          arg === '--config-env',
      )
    ) {
      return 'git : options de configuration ou d’exécution refusées.';
    }
    const verb = positional[0] ?? '';
    if (!GIT_READ_VERBS.has(verb) && !(args[0] === '--version'))
      return `git ${verb} : seules les commandes de lecture sont permises.`;
    if (
      verb === 'branch' &&
      args.some((arg) =>
        /^(-[dDmMcCf]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))/.test(arg),
      )
    ) {
      return 'git branch : seule la liste des branches est permise.';
    }
    return undefined;
  }
  if (name === 'kubectl' || name === 'oc') {
    if (args.some((arg) => /^--(token|kubeconfig|as|as-group|password|username)(=|$)/.test(arg))) {
      return `${name} : options d'identité refusées.`;
    }
    const verb = positional[0] ?? '';
    if (!KUBE_READ_VERBS.has(verb)) return `${name} ${verb} : seules les commandes de lecture sont permises.`;
    if (positional.slice(1).some((arg) => OPENSHIFT_SENSITIVE.test(arg.toLowerCase().split('/')[0] ?? ''))) {
      return `${name} : secrets et configmaps toujours refusés.`;
    }
    return undefined;
  }
  if (name === 'find' && args.some((arg) => FIND_EXEC.has(arg))) {
    return 'find : exécution ou suppression refusée.';
  }
  const inline = INLINE_CODE_FLAGS[name];
  if (
    inline &&
    args.some(
      (arg) =>
        inline.has(arg) || [...inline].some((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`)),
    )
  ) {
    return `${name} : code en ligne refusé.`;
  }
  const runner = RUNNERS[name];
  if (name === 'npx' || (runner && runner.has(positional[0] ?? ''))) {
    return `${name} : exécution d'un programme arbitraire refusée.`;
  }
  return undefined;
}
