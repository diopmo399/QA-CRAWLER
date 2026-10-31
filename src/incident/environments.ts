import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { runProcess } from '../sdk/server/test-runs.js';
import { redactText } from '../security/redactor.js';
import { guardedFiles, type GuardedFiles } from './guarded-fs.js';
import type {
  EnvironmentCapabilities,
  ExecutionEnvironmentConfig,
  ExecutionTarget,
  PolicyDecision,
  PolicyOperation,
} from './model.js';
import { ScopeDeniedError, type ScopePolicy } from './scope-policy.js';

/**
 * ENVIRONNEMENT D'EXÉCUTION : un seul contrat pour LOCAL, REMOTE et ARO. L'investigation (périmètre,
 * reproduction, code, hypothèses, vérifications) est la même partout ; seul l'adaptateur change :
 *   - LOCAL : QA-CRAWLER, Playwright et les dépôts sur la machine de la personne ;
 *   - REMOTE : les applications sont distantes, les dépôts restent locaux ; OpenShift en lecture seule
 *     quand `remote.openshift` est déclaré ;
 *   - ARO : QA-CRAWLER dans Azure Red Hat OpenShift (Playwright conteneurisé), les dépôts montés sous
 *     `aro.repositoriesMount`, les journaux lus avec le ServiceAccount du pod.
 * Toute opération passe par `policy.require(...)` AVANT d'exécuter quoi que ce soit. Les sorties sont
 * masquées (redactor) et tronquées. Les capacités se lisent sans effet de bord (PATH, fichiers).
 */

export interface ProcessRunner {
  (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number },
  ): Promise<{ code: number | null; output: string; timedOut: boolean; missing: boolean }>;
}

export type LogSource =
  | { path: string }
  | {
      openshift: {
        namespace: string;
        selector: string;
        container?: string;
        tail?: number;
        sinceSeconds?: number;
      };
    };

export interface ExecutionEnvironmentAdapter {
  readonly target: ExecutionTarget;
  capabilities(): Promise<EnvironmentCapabilities>;
  files(policy: ScopePolicy): GuardedFiles;
  runTest(
    policy: ScopePolicy,
    op: Extract<PolicyOperation, { kind: 'RUN_TEST' }>,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  readLogs(
    policy: ScopePolicy,
    source: LogSource,
    options: { maxLines: number; signal: AbortSignal },
  ): Promise<string[]>;
}

export interface EnvironmentDeps {
  run?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  /** Dossier du ServiceAccount monté dans le pod (tests : un dossier temporaire). */
  serviceAccountDir?: string;
}

/** Erreur d'environnement (outil absent, journal OpenShift non configuré, chemin hors du montage). */
export class EnvironmentError extends Error {
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const MAX_OUTPUT_CHARS = 16_000;
const MAX_LINE_CHARS = 2_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const OC_TIMEOUT_MS = 60_000;

/** Interpréteurs de commandes : jamais lancés, quelle que soit la politique. */
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'eval',
  'exec',
]);
const SHELL_META = /[;|&`$()<>\n\r]/;
/** Variables d'environnement jamais transmises aux outils lancés. */
const SECRET_ENV = /pass(word|wd)?|secret|token|credential|api[-_]?key|private|auth|cookie|session/i;

/** Retire de l'environnement transmis à un outil les variables qui ressemblent à des secrets. */
export function toolEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!SECRET_ENV.test(name)) result[name] = value;
  return result;
}

/** Masque puis garde la fin d'une sortie (les erreurs sont à la fin). */
export function boundedOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const clean = redactText(text.replace(/\u001b\[[0-9;]*m/g, ''));
  return clean.length > max
    ? `[…${String(clean.length - max)} caractères omis]\n${clean.slice(-max)}`
    : clean;
}

/**
 * Le lanceur par défaut : `runProcess` (shell false), précédé d'un refus sans exécution des
 * interpréteurs de commandes et des arguments porteurs de métacaractères (sous Windows, runProcess
 * passe par le shell pour un nom nu : ces arguments n'y arrivent donc jamais).
 */
export const defaultProcessRunner: ProcessRunner = async (command, args, options) => {
  const base = path.basename(command).toLowerCase();
  if (SHELLS.has(base))
    return {
      code: null,
      output: `refused: ${base} is a command interpreter`,
      timedOut: false,
      missing: false,
    };
  const unsafe = [command, ...args].find((value) => SHELL_META.test(value));
  if (unsafe !== undefined)
    return {
      code: null,
      output: 'refused: an argument contains shell metacharacters',
      timedOut: false,
      missing: false,
    };
  let output = '';
  const result = await runProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    log: (text) => {
      output = (output + text).slice(-4 * MAX_OUTPUT_CHARS);
    },
  });
  return { code: result.code, output, timedOut: result.timedOut, missing: result.missing };
};

/** Cherche un exécutable dans le PATH, sans le lancer. */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of dirs)
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // absent de ce dossier
      }
    }
  return undefined;
}

/** Le pod tourne-t-il dans un cluster : variable du service et fichier namespace (jamais le jeton). */
export async function inClusterNamespace(
  env: NodeJS.ProcessEnv,
  serviceAccountDir = SERVICE_ACCOUNT_DIR,
): Promise<string | undefined> {
  if (!env.KUBERNETES_SERVICE_HOST) return undefined;
  try {
    const namespace = (await readFile(path.join(serviceAccountDir, 'namespace'), 'utf8')).trim();
    return namespace || undefined;
  } catch {
    return undefined;
  }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const SELECTOR =
  /^[A-Za-z0-9._/-]+\s*(=|==|!=)\s*[A-Za-z0-9._-]*(\s*,\s*[A-Za-z0-9._/-]+\s*(=|==|!=)\s*[A-Za-z0-9._-]*)*$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** Les arguments de `oc logs`, validés (sélecteur, conteneur, bornes). */
export function ocLogsArgs(
  source: Extract<LogSource, { openshift: unknown }>['openshift'],
  maxLines: number,
  connection?: { apiServer?: string; context?: string },
): string[] {
  if (!DNS_LABEL.test(source.namespace)) throw new EnvironmentError('invalid namespace', 'ENV_OC_ARGS');
  if (!SELECTOR.test(source.selector)) throw new EnvironmentError('invalid label selector', 'ENV_OC_ARGS');
  if (source.container !== undefined && !DNS_LABEL.test(source.container))
    throw new EnvironmentError('invalid container name', 'ENV_OC_ARGS');
  const tail = Math.max(1, Math.min(Math.floor(source.tail ?? maxLines), Math.floor(maxLines)));
  const args = [
    'logs',
    '-n',
    source.namespace,
    '-l',
    source.selector.replace(/\s+/g, ''),
    '--tail',
    String(tail),
  ];
  if (source.sinceSeconds !== undefined) {
    const since = Math.floor(source.sinceSeconds);
    if (!(since > 0)) throw new EnvironmentError('sinceSeconds must be positive', 'ENV_OC_ARGS');
    args.push(`--since=${String(since)}s`);
  }
  if (source.container) args.push('-c', source.container);
  if (connection?.context) args.push(`--context=${connection.context}`);
  if (connection?.apiServer) args.push(`--server=${connection.apiServer}`);
  return args;
}

function toLines(text: string, maxLines: number): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines
    .slice(-Math.max(0, Math.floor(maxLines)))
    .map((line) => redactText(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** La fin d'un fichier de journal (au plus MAX_LOG_BYTES lus). */
async function tailFile(file: string, maxLines: number): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // Une lecture partielle commence au milieu d'une ligne : elle est écartée.
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    return toLines(text, maxLines);
  } finally {
    await handle.close();
  }
}

/** Le refus d'un chemin hors du montage des dépôts (ARO), au format du Scope Policy Engine. */
function mountDenial(operation: PolicyOperation, reason: string): PolicyDecision {
  return { allowed: false, rule: 'environment.aro-mount', reason, operation };
}

/** GuardedFiles limité au montage des dépôts (ARO) : un chemin hors du montage est refusé et consigné. */
function mountedFiles(inner: GuardedFiles, mount: string): GuardedFiles {
  const extraDenied: { path: string; reason: string }[] = [];
  const outside = (target: string, kind: 'READ_FILE' | 'LIST_DIR'): ScopeDeniedError => {
    const reason = `ARO: ${target} is outside the repositories mount ${mount}`;
    extraDenied.push({ path: target, reason });
    return new ScopeDeniedError(mountDenial({ kind, path: target }, reason));
  };
  return {
    async readText(target) {
      if (!inside(target, mount)) throw outside(target, 'READ_FILE');
      return inner.readText(target);
    },
    async list(root, options) {
      if (!inside(root, mount)) throw outside(root, 'LIST_DIR');
      return inner.list(root, options);
    },
    get denied() {
      return [...extraDenied, ...inner.denied];
    },
    get truncated() {
      return inner.truncated;
    },
  };
}

class Adapter implements ExecutionEnvironmentAdapter {
  readonly target: ExecutionTarget;
  private readonly run: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serviceAccountDir: string;

  constructor(
    private readonly config: ExecutionEnvironmentConfig,
    deps: EnvironmentDeps,
  ) {
    this.target = config.target;
    this.run = deps.run ?? defaultProcessRunner;
    this.env = deps.env ?? process.env;
    this.serviceAccountDir = deps.serviceAccountDir ?? SERVICE_ACCOUNT_DIR;
  }

  /** La connexion OpenShift de cette cible (absente : pas de journaux OpenShift). */
  private openshift(): { namespace: string; apiServer?: string; context?: string } | undefined {
    if (this.target === 'ARO') {
      const aro = this.config.aro;
      return aro
        ? { namespace: aro.namespace, ...(aro.apiServer ? { apiServer: aro.apiServer } : {}) }
        : undefined;
    }
    // LOCAL : seulement si une connexion est déclarée explicitement ; REMOTE : facultative.
    return this.config.remote?.openshift;
  }

  async capabilities(): Promise<EnvironmentCapabilities> {
    const limitations: string[] = [];
    const [mvn, mvnw, gradle, npm, npx, oc] = await Promise.all(
      ['mvn', 'mvnw', 'gradle', 'npm', 'npx', 'oc'].map((tool) => findOnPath(tool, this.env)),
    );
    const java = Boolean(mvn ?? mvnw ?? gradle);
    const node = Boolean(npm ?? npx);
    if (!java) limitations.push('Maven/Gradle not found on PATH: Java tests cannot run');
    if (!node) limitations.push('npm/npx not found on PATH: frontend tests cannot run');
    const openshift = this.openshift();
    let clusterLogs = false;
    let kubernetesJobs = false;
    if (this.target === 'ARO') {
      const aro = this.config.aro;
      const namespace = await inClusterNamespace(this.env, this.serviceAccountDir);
      if (!aro)
        limitations.push(
          'ARO target without `aro` configuration (namespace, serviceAccount, image, repositoriesMount)',
        );
      if (!namespace)
        limitations.push(
          'not running inside a cluster (no KUBERNETES_SERVICE_HOST or service account namespace)',
        );
      else if (aro && namespace !== aro.namespace)
        limitations.push(`pod namespace ${namespace} differs from configured namespace ${aro.namespace}`);
      if (aro) {
        try {
          if (!(await stat(aro.repositoriesMount)).isDirectory()) throw new Error('not a directory');
        } catch {
          limitations.push(`repositories mount ${aro.repositoriesMount} is not available`);
        }
      }
      if (!oc) limitations.push('oc not found on PATH: OpenShift logs cannot be read');
      clusterLogs = Boolean(aro && namespace && oc);
      kubernetesJobs = Boolean(aro && namespace);
    } else if (openshift) {
      if (!oc) limitations.push('OpenShift configured but oc not found on PATH');
      clusterLogs = Boolean(oc);
    } else if (this.target === 'REMOTE') {
      limitations.push('no OpenShift connection configured (remote.openshift): only local log files');
    }
    const logs: EnvironmentCapabilities['logs'] =
      this.target === 'ARO'
        ? clusterLogs
          ? 'OPENSHIFT'
          : 'NONE'
        : clusterLogs
          ? 'FILES_AND_OPENSHIFT'
          : 'FILES';
    return {
      target: this.target,
      playwright: this.target === 'ARO' ? 'CONTAINER' : 'LOCAL_PROCESS',
      repositories: this.target === 'ARO' ? 'CLUSTER_VOLUME' : 'LOCAL',
      tests: java || node,
      logs,
      kubernetesJobs,
      limitations,
    };
  }

  files(policy: ScopePolicy): GuardedFiles {
    const inner = guardedFiles(policy);
    if (this.target !== 'ARO') return inner;
    if (!this.config.aro)
      throw new EnvironmentError('ARO target without `aro` configuration', 'ENV_ARO_CONFIG');
    return mountedFiles(inner, this.config.aro.repositoriesMount);
  }

  async runTest(
    policy: ScopePolicy,
    op: Extract<PolicyOperation, { kind: 'RUN_TEST' }>,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    const decision = await policy.require(op);
    if (this.target === 'ARO') {
      if (!this.config.aro)
        throw new EnvironmentError('ARO target without `aro` configuration', 'ENV_ARO_CONFIG');
      if (!inside(op.cwd, this.config.aro.repositoriesMount))
        throw new ScopeDeniedError(
          mountDenial(
            op,
            `ARO: ${op.cwd} is outside the repositories mount ${this.config.aro.repositoriesMount}`,
          ),
        );
    }
    const result = await this.run(op.command, op.args, {
      cwd: decision.resolvedPath ?? op.cwd,
      env: toolEnvironment(this.env),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const output = result.missing
      ? `${op.command}: command not found on this ${this.target} environment\n${result.output}`
      : result.output;
    return { code: result.code, output: boundedOutput(output), timedOut: result.timedOut };
  }

  async readLogs(
    policy: ScopePolicy,
    source: LogSource,
    options: { maxLines: number; signal: AbortSignal },
  ): Promise<string[]> {
    if ('path' in source) {
      const decision = await policy.require({ kind: 'READ_LOG', path: source.path });
      options.signal.throwIfAborted();
      return tailFile(decision.resolvedPath ?? source.path, options.maxLines);
    }
    const connection = this.openshift();
    if (!connection)
      throw new EnvironmentError(
        this.target === 'LOCAL'
          ? 'LOCAL target: no OpenShift connection configured (remote.openshift)'
          : `${this.target} target: no OpenShift connection configured`,
        'ENV_OPENSHIFT_NOT_CONFIGURED',
      );
    const args = ocLogsArgs(
      source.openshift,
      options.maxLines,
      this.target === 'ARO' ? undefined : connection, // ARO : configuration du pod (ServiceAccount)
    );
    await policy.require({
      kind: 'OPENSHIFT',
      verb: 'logs',
      resource: 'pods',
      namespace: source.openshift.namespace,
    });
    const result = await this.run('oc', args, {
      cwd: tmpdir(),
      env: toolEnvironment(this.env),
      signal: options.signal,
      timeoutMs: OC_TIMEOUT_MS,
    });
    if (result.missing) throw new EnvironmentError('oc not found on PATH', 'ENV_TOOL_MISSING');
    if (result.timedOut) throw new EnvironmentError('oc logs timed out', 'ENV_TIMEOUT');
    if (result.code !== 0)
      throw new EnvironmentError(
        `oc logs failed (exit ${String(result.code)}): ${boundedOutput(result.output, 500)}`,
        'ENV_OC_FAILED',
      );
    return toLines(result.output, options.maxLines);
  }
}

/** L'adaptateur de la cible d'exécution configurée. */
export function environmentAdapter(
  config: ExecutionEnvironmentConfig,
  deps: EnvironmentDeps = {},
): ExecutionEnvironmentAdapter {
  return new Adapter(config, deps);
}

/** Valeurs qui ressemblent à un secret écrit en clair : refusées dans un manifeste. */
const SECRET_VALUE =
  /(pass(word|wd)?|secret|token|api[-_]?key|credential|bearer)\s*[=:]|\bbearer\s+\S|\beyJ[a-zA-Z0-9_-]{5,}\./i;

/**
 * ARO : le Job Kubernetes qui joue une vérification dans le cluster (image QA-CRAWLER, ServiceAccount,
 * dépôts montés). Aucune valeur secrète : seulement le ServiceAccount (référence) ; un argument qui
 * ressemble à un secret est refusé. Pod non root, sans élévation de privilèges, sans jeton monté,
 * limites de ressources, durée bornée et nettoyage après exécution.
 */
export function investigationJobManifest(input: {
  config: ExecutionEnvironmentConfig;
  incidentId: string;
  command: string;
  args: string[];
  cwd: string;
  /** La PVC qui porte les dépôts (par défaut `qa-crawler-repositories`). */
  repositoriesClaim?: string;
  activeDeadlineSeconds?: number;
}): string {
  const aro = input.config.aro;
  if (input.config.target !== 'ARO' || !aro)
    throw new EnvironmentError(
      'an investigation Job needs the ARO target and its configuration',
      'ENV_ARO_CONFIG',
    );
  if (!DNS_LABEL.test(aro.namespace)) throw new EnvironmentError('invalid ARO namespace', 'ENV_ARO_CONFIG');
  if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(aro.serviceAccount))
    throw new EnvironmentError('invalid ServiceAccount name', 'ENV_ARO_CONFIG');
  if (!path.isAbsolute(aro.repositoriesMount))
    throw new EnvironmentError('repositoriesMount must be absolute', 'ENV_ARO_CONFIG');
  if (!inside(input.cwd, aro.repositoriesMount))
    throw new EnvironmentError(
      `${input.cwd} is outside the repositories mount ${aro.repositoriesMount}`,
      'ENV_ARO_MOUNT',
    );
  if (SHELLS.has(path.basename(input.command).toLowerCase()))
    throw new EnvironmentError(`${input.command} is a command interpreter`, 'ENV_SHELL');
  for (const value of [input.command, ...input.args]) {
    if (SHELL_META.test(value))
      throw new EnvironmentError('an argument contains shell metacharacters', 'ENV_SHELL');
    if (SECRET_VALUE.test(value))
      throw new EnvironmentError(
        'an argument looks like a secret value: reference a Secret instead',
        'ENV_SECRET',
      );
  }
  const slug =
    input.incidentId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'incident';
  const hash = createHash('sha256')
    .update(JSON.stringify([input.incidentId, input.command, input.args, input.cwd]))
    .digest('hex')
    .slice(0, 8);
  const name = `qa-incident-${slug}-${hash}`.replace(/-+/g, '-');
  const labels = {
    'app.kubernetes.io/name': 'qa-crawler',
    'app.kubernetes.io/component': 'incident-investigation',
    'qa-crawler/incident': slug.slice(0, 63).replace(/-+$/, ''),
  };
  const manifest = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: aro.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.max(60, Math.floor(input.activeDeadlineSeconds ?? 1800)),
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: aro.serviceAccount,
          // La vérification n'appelle pas l'API du cluster : pas de jeton monté.
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'investigation',
              image: aro.image,
              command: [input.command],
              args: input.args,
              workingDir: input.cwd,
              env: [{ name: 'QA_INCIDENT_ID', value: input.incidentId }],
              resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '2', memory: '3Gi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                runAsNonRoot: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'repositories', mountPath: aro.repositoriesMount },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            {
              name: 'repositories',
              persistentVolumeClaim: { claimName: input.repositoriesClaim ?? 'qa-crawler-repositories' },
            },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
  return `# Generated by QA-CRAWLER (incident investigation). No secret values: ServiceAccount only.\n${stringify(manifest, { lineWidth: 0 })}`;
}
