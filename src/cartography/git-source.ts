import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitProvider, MapSource } from '../sdk/core/cartography.js';
import { SourceAccessError } from './files.js';

/**
 * LES SOURCES GIT DISTANTES : le serveur prépare lui-même une copie de travail (dépôt initialisé, une seule
 * révision récupérée, extraite sans hooks, sans sous-modules, sans liens symboliques) sous son propre dossier,
 * puis la donne au scan comme n'importe quel dossier. Les commandes git sont lancées sans shell, avec un
 * environnement épuré (aucune configuration système ou utilisateur, aucun assistant d'identifiants, aucune
 * invite), des délais et des limites. L'adresse est contrôlée (protocole, hôte autorisé, adresses résolues,
 * pas d'identifiants dans l'URL, pas de redirection) ; le jeton vient d'une variable d'environnement du serveur
 * désignée par son nom, et n'apparaît ni dans la configuration, ni dans les erreurs, ni dans les preuves.
 */
export interface GitPolicy {
  /** Les hôtes autorisés (nom exact, sans port). Vide : aucune source distante http(s). */
  allowedHosts: readonly string[];
  /** Les protocoles admis : https seul par défaut (http et file servent aux tests). */
  protocols?: readonly ('https' | 'http' | 'file')[];
  /** Le dossier des copies de travail, contrôlé par le serveur. */
  workRoot: string;
  /** Pour file:// : seulement sous ces racines. */
  fileRoots?: readonly string[];
  /** Les adresses privées ou de bouclage sont refusées, sauf si l'administrateur les autorise. */
  allowPrivateAddresses?: boolean;
  timeoutMs?: number;
  maxRepoBytes?: number;
  env: NodeJS.ProcessEnv;
  envNames: RegExp;
  /** La résolution DNS (remplaçable dans les tests). */
  resolve?: (host: string) => Promise<string[]>;
}

export type GitErrorCode =
  | 'GIT_DISABLED'
  | 'URL_REFUSED'
  | 'HOST_REFUSED'
  | 'CREDENTIALS_MISSING'
  | 'AUTH_FAILED'
  | 'BRANCH_NOT_FOUND'
  | 'COMMIT_NOT_FOUND'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'LIMIT'
  | 'BUSY'
  | 'FAILED';

export class GitSourceError extends SourceAccessError {
  constructor(
    readonly code: GitErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'GitSourceError';
  }
}

export interface ParsedRepo {
  /** L'adresse normalisée, sans identifiants, sans « / » final. */
  url: string;
  protocol: 'https' | 'http' | 'file';
  host: string;
  provider?: GitProvider;
}

export interface PreparedGit {
  root: string;
  commit: string;
  repo: ParsedRepo;
}

const HEX_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(\/|$))(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const REPO_PATH = /^(\/[A-Za-z0-9._~@+%-]+)+\/?$/;
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export const isCommitId = (value: string): boolean => HEX_ID.test(value);
export const isBranchName = (value: string): boolean => BRANCH.test(value);

/** L'hébergeur déduit de l'hôte (les instances auto-hébergées se déclarent avec `provider`). */
export function providerOf(host: string): GitProvider | undefined {
  const h = host.toLowerCase();
  if (h === 'github.com') return 'GITHUB';
  if (h === 'gitlab.com' || h.startsWith('gitlab.')) return 'GITLAB';
  if (h === 'bitbucket.org') return 'BITBUCKET';
  if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com')) return 'AZURE_DEVOPS';
  return undefined;
}

/** Contrôle une adresse de dépôt : protocole admis, aucun identifiant, hôte autorisé, chemin simple. */
export function parseRepoUrl(
  raw: string,
  policy: Pick<GitPolicy, 'allowedHosts' | 'protocols'> | undefined,
): ParsedRepo {
  if (!policy) throw new GitSourceError('GIT_DISABLED', 'remote Git sources are not enabled on this server');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new GitSourceError('URL_REFUSED', 'the repository URL is not a valid URL');
  }
  const protocol = url.protocol.replace(/:$/, '');
  const allowed = policy.protocols ?? ['https'];
  if (protocol !== 'https' && protocol !== 'http' && protocol !== 'file')
    throw new GitSourceError('URL_REFUSED', `the protocol ${protocol} is not allowed (https only)`);
  if (!allowed.includes(protocol))
    throw new GitSourceError('URL_REFUSED', `the protocol ${protocol} is not allowed on this server`);
  if (url.username || url.password)
    throw new GitSourceError(
      'URL_REFUSED',
      'credentials must not be written in the URL: name a server environment variable (tokenEnv)',
    );
  if (url.search || url.hash)
    throw new GitSourceError('URL_REFUSED', 'the repository URL must not carry a query or a fragment');
  if (protocol === 'file') {
    let local: string;
    try {
      local = fileURLToPath(url);
    } catch {
      throw new GitSourceError('URL_REFUSED', 'a file:// repository must be an absolute path');
    }
    if (!path.isAbsolute(local) || local.split(/[\\/]/).includes('..'))
      throw new GitSourceError('URL_REFUSED', 'a file:// repository must be an absolute path');
    return { url: url.href.replace(/\/+$/, ''), protocol, host: '' };
  }
  const host = url.hostname.toLowerCase();
  if (policy.allowedHosts.length === 0)
    throw new GitSourceError('GIT_DISABLED', 'no Git host is allowed on this server');
  if (!policy.allowedHosts.some((entry) => entry.toLowerCase() === host))
    throw new GitSourceError('HOST_REFUSED', `the host ${host} is not in the server's allowed Git hosts`);
  if (!REPO_PATH.test(url.pathname) || url.pathname.split('/').includes('..'))
    throw new GitSourceError('URL_REFUSED', 'the repository path contains characters that are not allowed');
  const pathname = url.pathname.replace(/\/+$/, '');
  return {
    url: `${protocol}://${url.host.toLowerCase()}${pathname}`,
    protocol,
    host,
    ...(providerOf(host) ? { provider: providerOf(host) } : {}),
  };
}

// ── Adresses (SSRF) ─────────────────────────────────────────────────────────────────────────────

function privateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Une adresse de bouclage, privée, de lien local, non spécifiée ou de multidiffusion. */
export function internalAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address);
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (mapped) return privateV4(mapped);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

const linkLocal = (address: string): boolean =>
  /^169\.254\./.test(address) || /^fe[89ab]/i.test(address) || /^::ffff:169\.254\./i.test(address);

async function checkAddresses(host: string, policy: GitPolicy): Promise<void> {
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : policy.resolve
        ? await policy.resolve(host)
        : (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    throw new GitSourceError('UNREACHABLE', `the host ${host} cannot be resolved`);
  }
  if (addresses.length === 0) throw new GitSourceError('UNREACHABLE', `the host ${host} has no address`);
  for (const address of addresses) {
    // Les métadonnées des nuages (169.254.x.x) ne sont jamais jointes, même autorisées.
    if (linkLocal(address) || (!policy.allowPrivateAddresses && internalAddress(address)))
      throw new GitSourceError('HOST_REFUSED', `the host ${host} resolves to an internal address`);
  }
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────────

interface GitRun {
  stdout: string;
  stderr: string;
}

/** Les réglages imposés à chaque commande : rien d'hérité, rien d'exécuté, rien de suivi. */
/**
 * Une configuration globale vide et un dossier de hooks vide, propres au serveur : ni le fichier nul du
 * système (refusé par git sous Windows) ni ceux de l'utilisateur ne sont lus.
 */
function supportOf(workRoot: string): { config: string; hooks: string } {
  return { config: path.join(workRoot, '.qa-git', 'config'), hooks: path.join(workRoot, '.qa-git', 'hooks') };
}

async function ensureSupport(workRoot: string): Promise<void> {
  const support = supportOf(workRoot);
  await mkdir(support.hooks, { recursive: true });
  await writeFile(support.config, '', { flag: 'a' });
}

function hardening(protocols: readonly string[], hooks: string): string[] {
  const settings = [
    `core.hooksPath=${hooks}`,
    'core.fsmonitor=false',
    'core.symlinks=false',
    'core.protectNTFS=true',
    'core.protectHFS=true',
    'credential.helper=',
    'protocol.allow=never',
    ...protocols.map((p) => `protocol.${p}.allow=always`),
    'http.followRedirects=false',
    'http.lowSpeedLimit=1000',
    'http.lowSpeedTime=30',
    'submodule.recurse=false',
    'fetch.recurseSubmodules=false',
    'transfer.fsckObjects=true',
    'gc.auto=0',
    'maintenance.auto=false',
    'advice.detachedHead=false',
    'init.defaultBranch=main',
  ];
  return settings.flatMap((setting) => ['-c', setting]);
}

function gitEnv(workRoot: string, header?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: workRoot,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: supportOf(workRoot).config,
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(workRoot),
    LC_ALL: 'C',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  // Le jeton passe par l'environnement de la seule commande git (jamais en argument ni dans l'URL).
  if (header)
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: header,
    });
  return env;
}

class GitCommandError extends Error {
  constructor(
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(stderr);
  }
}

function runGit(
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    workRoot: string;
    protocols: readonly string[];
    timeout: number;
    signal?: AbortSignal;
    maxBuffer?: number;
  },
): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...hardening(options.protocols, supportOf(options.workRoot).hooks), ...args],
      {
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as { killed?: boolean }).killed === true;
          reject(new GitCommandError(stderr || error.message, killed));
        } else resolve({ stdout, stderr });
      },
    );
  });
}

/** Le message d'une erreur git, sans jeton ni en-tête d'authentification. */
function clean(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  out = out
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/Authorization:[^\n]*/gi, 'Authorization: ***');
  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? 'git failed').slice(0, 300);
}

function classify(
  error: unknown,
  target: { branch?: string; commit?: string; token: boolean },
  secrets: readonly string[],
): GitSourceError {
  if (error instanceof GitSourceError) return error;
  if (!(error instanceof GitCommandError))
    return new GitSourceError('FAILED', clean((error as Error).message, secrets));
  if (error.timedOut) return new GitSourceError('TIMEOUT', 'the Git operation exceeded its time limit');
  const text = error.stderr.toLowerCase();
  if (
    /authentication failed|could not read username|could not read password|returned error: 40[13]|access denied|http basic: access denied/.test(
      text,
    )
  )
    return new GitSourceError(
      'AUTH_FAILED',
      target.token
        ? 'the Git host refused the credentials'
        : 'the repository requires credentials: name a server environment variable (tokenEnv)',
    );
  if (
    target.commit &&
    /not our ref|unadvertised object|no such remote ref|bad object|unable to read tree|not a valid|couldn't find remote ref/.test(
      text,
    )
  )
    return new GitSourceError(
      'COMMIT_NOT_FOUND',
      `the commit ${target.commit} does not exist in the repository`,
    );
  if (/couldn't find remote ref|no such remote ref/.test(text))
    return target.branch
      ? new GitSourceError('BRANCH_NOT_FOUND', `the branch ${target.branch} does not exist in the repository`)
      : new GitSourceError('UNREACHABLE', 'the repository has no default branch');
  if (
    /could not resolve host|connection refused|failed to connect|couldn't connect|does not appear to be a git repository|repository not found|returned error: 404|not found|no such file or directory|connection timed out|redirect/.test(
      text,
    )
  )
    return new GitSourceError(
      'UNREACHABLE',
      `the repository is not reachable (${clean(error.stderr, secrets)})`,
    );
  return new GitSourceError('FAILED', clean(error.stderr, secrets));
}

// ── Copies de travail ──────────────────────────────────────────────────────────────────────────

/** Le dossier de travail d'une source d'un projet, sous la racine du serveur. */
export async function workdirOf(
  policy: Pick<GitPolicy, 'workRoot'>,
  projectKey: string,
  sourceId: string,
): Promise<string> {
  await mkdir(policy.workRoot, { recursive: true });
  const root = await realpath(policy.workRoot);
  const key = createHash('sha256').update(projectKey).digest('hex').slice(0, 16);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(sourceId))
    throw new GitSourceError('FAILED', 'invalid source identifier');
  return path.join(root, key, sourceId);
}

/** Une préparation à la fois par copie de travail (dans ce serveur, et entre serveurs par un dossier marqueur). */
const LOCKS = new Map<string, Promise<unknown>>();

async function withLock<T>(dir: string, timeout: number, work: () => Promise<T>): Promise<T> {
  const previous = LOCKS.get(dir) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const lock = `${dir}.lock`;
      const started = Date.now();
      await mkdir(path.dirname(dir), { recursive: true });
      for (;;) {
        try {
          await mkdir(lock);
          break;
        } catch {
          const info = await stat(lock).catch(() => undefined);
          // Un marqueur laissé par un serveur arrêté est repris après deux délais.
          if (info && Date.now() - info.mtimeMs > timeout * 2)
            await rm(lock, { recursive: true, force: true });
          else if (Date.now() - started > timeout)
            throw new GitSourceError('BUSY', 'the source is being prepared by another scan');
          else await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      try {
        return await work();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    });
  LOCKS.set(dir, run);
  try {
    return await run;
  } finally {
    if (LOCKS.get(dir) === run) LOCKS.delete(dir);
  }
}

function basicHeader(provider: GitProvider | undefined, token: string): string {
  const user =
    provider === 'GITLAB'
      ? 'oauth2'
      : provider === 'BITBUCKET'
        ? 'x-token-auth'
        : provider === 'AZURE_DEVOPS'
          ? 'pat'
          : 'x-access-token';
  return `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

/**
 * Prépare la copie de travail d'une source GIT : contrôle de l'adresse, réservation, dépôt initialisé (ou repris),
 * une seule révision récupérée (commit, sinon branche, sinon branche par défaut), extraite de force, commit
 * vérifié, taille contrôlée. Une première préparation qui échoue ne laisse rien derrière elle.
 */
export async function prepareGitSource(
  source: MapSource,
  projectKey: string,
  policy: GitPolicy,
  signal?: AbortSignal,
): Promise<PreparedGit> {
  const repo = parseRepoUrl(source.repoUrl ?? '', policy);
  const provider = source.provider ?? repo.provider;
  const protocols = policy.protocols ?? ['https'];
  const timeout = policy.timeoutMs ?? DEFAULT_TIMEOUT;
  if (repo.protocol === 'file') {
    // La racine est contrôlée avant l'existence : un dossier hors des racines est refusé, présent ou non.
    const candidate = path.resolve(fileURLToPath(new URL(repo.url)));
    const real = await realpath(candidate).catch(() => undefined);
    const parent = await realpath(path.dirname(candidate)).catch(() => path.dirname(candidate));
    const target = real ?? path.join(parent, path.basename(candidate));
    const roots = await Promise.all(
      (policy.fileRoots ?? []).map((r) => realpath(r).catch(() => path.resolve(r))),
    );
    if (
      !roots.some(
        (root) =>
          !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target)),
      )
    )
      throw new GitSourceError('URL_REFUSED', 'the file:// repository is outside the allowed source roots');
    if (!real) throw new GitSourceError('UNREACHABLE', 'the repository folder does not exist');
  } else await checkAddresses(repo.host, policy);
  if (source.branch !== undefined && !isBranchName(source.branch))
    throw new GitSourceError('FAILED', 'invalid branch name');
  if (source.commit !== undefined && !isCommitId(source.commit))
    throw new GitSourceError('FAILED', 'the commit must be a full identifier (40 hexadecimal characters)');
  let token: string | undefined;
  if (source.tokenEnv) {
    if (!policy.envNames.test(source.tokenEnv))
      throw new GitSourceError(
        'CREDENTIALS_MISSING',
        `the server does not read the variable ${source.tokenEnv}`,
      );
    token = policy.env[source.tokenEnv];
    if (!token)
      throw new GitSourceError('CREDENTIALS_MISSING', `the server has no value for ${source.tokenEnv}`);
  }
  const header = token && repo.protocol !== 'file' ? basicHeader(provider, token) : undefined;
  const secrets = [token ?? '', header ?? '', header?.replace('Authorization: Basic ', '') ?? ''];
  const dir = await workdirOf(policy, projectKey, source.id);
  const env = gitEnv(policy.workRoot, header);
  await ensureSupport(policy.workRoot);
  const git = (args: string[], maxBuffer?: number): Promise<GitRun> =>
    runGit(args, {
      env,
      workRoot: policy.workRoot,
      protocols,
      timeout,
      ...(signal ? { signal } : {}),
      ...(maxBuffer ? { maxBuffer } : {}),
    });
  return withLock(dir, timeout, async () => {
    const existing = await lstat(path.join(dir, '.git', 'HEAD')).catch(() => undefined);
    const fresh = !existing;
    try {
      if (fresh) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await git(['init', '--quiet', '--template=', dir]);
      }
      const target = source.commit ?? (source.branch ? `refs/heads/${source.branch}` : 'HEAD');
      await git([
        '-C',
        dir,
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        repo.url,
        target,
      ]);
      await git(['-C', dir, 'checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD']);
      await git(['-C', dir, 'clean', '-ffdxq']);
      const commit = (await git(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
      if (!isCommitId(commit)) throw new GitSourceError('FAILED', 'the extracted revision cannot be read');
      if (source.commit && commit !== source.commit)
        throw new GitSourceError(
          'COMMIT_NOT_FOUND',
          `the extracted commit ${commit} is not the requested ${source.commit}`,
        );
      const counts = (await git(['-C', dir, 'count-objects', '-v'])).stdout;
      const kib = [/^size: (\d+)$/m, /^size-pack: (\d+)$/m].reduce(
        (sum, pattern) => sum + Number(pattern.exec(counts)?.[1] ?? 0),
        0,
      );
      const max = policy.maxRepoBytes ?? DEFAULT_MAX_BYTES;
      if (kib * 1024 > max)
        throw new GitSourceError(
          'LIMIT',
          `the repository exceeds ${String(Math.round(max / 1024 / 1024))} MB`,
        );
      return { root: await realpath(dir), commit, repo: { ...repo, ...(provider ? { provider } : {}) } };
    } catch (error) {
      if (fresh) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      else if (error instanceof GitSourceError && error.code === 'LIMIT')
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw classify(
        error,
        {
          ...(source.branch ? { branch: source.branch } : {}),
          ...(source.commit ? { commit: source.commit } : {}),
          token: Boolean(token),
        },
        secrets,
      );
    }
  });
}

/** Le texte d'un fichier à une révision, lu dans la copie de travail ; absent si la révision ou le fichier manque. */
export async function gitShow(
  dir: string,
  revision: string,
  file: string,
  policy: Pick<GitPolicy, 'workRoot'>,
): Promise<string | undefined> {
  if (!isCommitId(revision) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return undefined;
  try {
    await ensureSupport(policy.workRoot);
    const run = await runGit(['-C', dir, 'show', `${revision}:${file}`], {
      env: gitEnv(policy.workRoot),
      workRoot: policy.workRoot,
      protocols: [],
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return run.stdout;
  } catch {
    return undefined;
  }
}

/** Retire les copies de travail des sources GIT qui ne sont plus configurées. */
export async function removeWorkdirs(
  policy: Pick<GitPolicy, 'workRoot'>,
  projectKey: string,
  sourceIds: readonly string[],
): Promise<void> {
  for (const id of sourceIds) {
    const dir = await workdirOf(policy, projectKey, id).catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * « Voir sur Git » : l'adresse d'un fichier chez son hébergeur, à une révision exacte et à une ligne. Aucun
 * lien n'est fabriqué pour un hébergeur inconnu, ni sans commit (une branche bouge).
 */
export function gitFileUrl(
  repoUrl: string | undefined,
  provider: GitProvider | undefined,
  revision: string | undefined,
  file: string,
  line?: number,
): string | undefined {
  if (!repoUrl || !revision || !isCommitId(revision)) return undefined;
  if (!file || path.isAbsolute(file) || file.split('/').includes('..')) return undefined;
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const kind = provider ?? providerOf(url.hostname);
  if (!kind) return undefined;
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  const at = line && line > 0 ? line : undefined;
  switch (kind) {
    case 'GITHUB':
      return `${base}/blob/${revision}/${encoded}${at ? `#L${String(at)}` : ''}`;
    case 'GITLAB':
      return `${base}/-/blob/${revision}/${encoded}${at ? `#L${String(at)}` : ''}`;
    case 'BITBUCKET':
      return `${base}/src/${revision}/${encoded}${at ? `#lines-${String(at)}` : ''}`;
    case 'AZURE_DEVOPS': {
      const query = new URLSearchParams({ path: `/${file}`, version: `GC${revision}`, _a: 'contents' });
      if (at) {
        query.set('line', String(at));
        query.set('lineEnd', String(at));
        query.set('lineStartColumn', '1');
        query.set('lineEndColumn', '1');
        query.set('lineStyle', 'plain');
      }
      return `${base}?${query.toString()}`;
    }
  }
}
