import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { MavenRemote } from '../cartography/maven-resolve.js';
import { startSdkServer, type RunningSdkServer, type SdkServerOptions } from '../sdk/server/server.js';
import { UsageError } from './args.js';
import { logger } from './logger.js';

/**
 * `qa-crawler sdk-server` : le serveur du SDK embarquable (l'assistant de création de projet et
 * son API). Les projets créés par l'assistant sont écrits sous --workspace ; chaque exploration
 * lance le moteur dans le même programme Node.
 */
export const SDK_SERVER_HELP = `qa-crawler sdk-server — the server of the embeddable SDK (project wizard + API)

Usage:
  qa-crawler sdk-server --workspace <dir> [options]

Options:
      --workspace <dir>        Where the wizard writes projects (one folder per project) (required)
      --host <address>         Address to listen on (default: 127.0.0.1; another address exposes the API on the network)
      --port <n>               Port (default: 4310; 0 picks a free port)
      --allow-origin <url>     Origin of a host application allowed to call the API (repeatable)
      --allow-source-root <dir>  Folder under which an Angular source folder may be read (repeatable; default: none)
      --git-host <host>        Git host from which the cartography may clone remote repositories over https
                               (repeatable; default: none, remote Git sources refused)
      --git-allow-private      Allow --git-host names that resolve to private addresses (self-hosted Git)
      --maven-repo <dir>       Local Maven repository read (never written) for API contract jars (repeatable;
                               default: none, Maven contract resolution disabled)
      --maven-remote <id=url>  Remote Maven repository allowed for contract jars, https only (repeatable)
      --maven-auth <id=USER_ENV:PASS_ENV|id=token:TOKEN_ENV>
                               Credentials of a --maven-remote, read from environment variables named QA_*
      --maven-cache <dir>      Where downloaded artifacts are kept (default: <workspace>/.maven-cache)
      --maven-offline          Read local repositories and the cache only; contact no remote repository
      --token-env <NAME>       Read the API token from this environment variable (default: generated and printed)
      --language <fr|en>       Language of the standalone page and of the engine reports (default: en)
      --concurrency <n>        Explorations running at the same time (default: 1)
      --access <single|named>  single (default): one service token, carried by the served pages;
                               named: personal tokens with roles and a journal (the pages carry no
                               token; sign in with yours; the service token stays administrator)
      --quiet                  Only the URL
  -h, --help                   This help

The API requires the token (Authorization: Bearer …) on every call; browsers may only call it from the
same origin or an --allow-origin. Environment variables are only read when their name matches QA_*, and
only their presence is returned, never their value. Ctrl+C stops the server.
`;

interface SdkServerArgs {
  workspace?: string;
  host: string;
  port: number;
  origins: string[];
  sourceRoots: string[];
  gitHosts: string[];
  gitAllowPrivate: boolean;
  /** La résolution des contrats Maven ; absente sans --maven-repo ni --maven-remote. */
  maven?: NonNullable<SdkServerOptions['mavenContracts']>;
  tokenEnv?: string;
  language: 'fr' | 'en';
  concurrency: number;
  access: 'single' | 'named';
  quiet: boolean;
  help: boolean;
}

export function parseSdkServerArgs(argv: readonly string[]): SdkServerArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        workspace: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        'allow-origin': { type: 'string', multiple: true },
        'allow-source-root': { type: 'string', multiple: true },
        'git-host': { type: 'string', multiple: true },
        'git-allow-private': { type: 'boolean' },
        'maven-repo': { type: 'string', multiple: true },
        'maven-remote': { type: 'string', multiple: true },
        'maven-auth': { type: 'string', multiple: true },
        'maven-cache': { type: 'string' },
        'maven-offline': { type: 'boolean' },
        'token-env': { type: 'string' },
        language: { type: 'string' },
        concurrency: { type: 'string' },
        access: { type: 'string' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  const integer = (name: string, value: string | undefined, min: number, fallback: number): number => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min)
      throw new UsageError(`--${name} must be an integer ≥ ${String(min)}`);
    return number;
  };
  const language = values.language ?? 'en';
  if (language !== 'fr' && language !== 'en') throw new UsageError('--language must be fr or en');
  const access = values.access ?? 'single';
  if (access !== 'single' && access !== 'named') throw new UsageError('--access must be single or named');
  const origins = values['allow-origin'] ?? [];
  for (const origin of origins)
    if (!/^https?:\/\//i.test(origin) || !URL.canParse(origin))
      throw new UsageError(`--allow-origin must be an http(s) origin: ${origin}`);
  const maven = mavenArgs(values);
  return {
    ...(maven ? { maven } : {}),
    ...(values.workspace !== undefined ? { workspace: path.resolve(values.workspace) } : {}),
    host: values.host ?? '127.0.0.1',
    port: integer('port', values.port, 0, 4310),
    origins,
    sourceRoots: (values['allow-source-root'] ?? []).map((root) => path.resolve(root)),
    gitHosts: (values['git-host'] ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
    gitAllowPrivate: values['git-allow-private'] ?? false,
    ...(values['token-env'] !== undefined ? { tokenEnv: values['token-env'] } : {}),
    language,
    concurrency: integer('concurrency', values.concurrency, 1, 1),
    access,
    quiet: values.quiet ?? false,
    help: values.help ?? false,
  };
}

/** Les options Maven de la ligne de commande : dépôts locaux, distants (https), identifiants par nom de variable. */
function mavenArgs(values: {
  'maven-repo'?: string[];
  'maven-remote'?: string[];
  'maven-auth'?: string[];
  'maven-cache'?: string;
  'maven-offline'?: boolean;
}): SdkServerArgs['maven'] {
  const local = (values['maven-repo'] ?? []).map((dir) => path.resolve(dir));
  const remotes: MavenRemote[] = [];
  for (const entry of values['maven-remote'] ?? []) {
    const at = entry.indexOf('=');
    const id = entry.slice(0, at).trim();
    const url = entry.slice(at + 1).trim();
    if (at <= 0 || !/^[A-Za-z0-9._-]{1,64}$/.test(id) || !/^https:\/\//i.test(url) || !URL.canParse(url))
      throw new UsageError(`--maven-remote must be <id>=https://…: ${entry}`);
    if (remotes.some((remote) => remote.id === id)) throw new UsageError(`--maven-remote ${id} is repeated`);
    remotes.push({ id, url });
  }
  for (const entry of values['maven-auth'] ?? []) {
    const match = /^([A-Za-z0-9._-]{1,64})=(?:token:([A-Z0-9_]+)|([A-Z0-9_]+):([A-Z0-9_]+))$/.exec(entry);
    const remote = match ? remotes.find((r) => r.id === match[1]) : undefined;
    if (!match || !remote)
      throw new UsageError(
        '--maven-auth must be <id>=USER_ENV:PASS_ENV or <id>=token:ENV for a --maven-remote',
      );
    if (match[2]) remote.tokenEnv = match[2];
    else {
      remote.usernameEnv = match[3] ?? '';
      remote.passwordEnv = match[4] ?? '';
    }
  }
  if (local.length === 0 && remotes.length === 0) {
    if (values['maven-cache'] !== undefined || values['maven-offline'])
      throw new UsageError('--maven-cache and --maven-offline need --maven-repo or --maven-remote');
    return undefined;
  }
  return {
    localRepositories: local,
    remotes,
    ...(values['maven-cache'] !== undefined ? { cacheDir: path.resolve(values['maven-cache']) } : {}),
    ...(values['maven-offline'] ? { offline: true } : {}),
  };
}

export interface SdkServerRuntime {
  waitForStop?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  onStarted?: (running: RunningSdkServer) => void;
  /** Le moteur (tests seulement). */
  run?: SdkServerOptions['run'];
}

export async function runSdkServerCli(argv: string[], runtime: SdkServerRuntime = {}): Promise<number> {
  let args: SdkServerArgs;
  try {
    args = parseSdkServerArgs(argv);
    if (!args.help && !args.workspace) throw new UsageError('--workspace is required');
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(SDK_SERVER_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help || !args.workspace) {
    logger.info(SDK_SERVER_HELP);
    return 0;
  }
  const env = runtime.env ?? process.env;
  let token: string | undefined;
  if (args.tokenEnv) {
    token = env[args.tokenEnv];
    if (!token || token.length < 16) {
      logger.error(
        `Error: the environment variable ${args.tokenEnv} must hold a token of at least 16 characters`,
      );
      return 2;
    }
  }
  await mkdir(args.workspace, { recursive: true });
  let running: RunningSdkServer;
  try {
    running = await startSdkServer({
      workspace: args.workspace,
      host: args.host,
      port: args.port,
      allowedOrigins: args.origins,
      allowedSourceRoots: args.sourceRoots,
      ...(args.gitHosts.length > 0
        ? {
            gitSources: {
              allowedHosts: args.gitHosts,
              ...(args.gitAllowPrivate ? { allowPrivateAddresses: true } : {}),
            },
          }
        : {}),
      ...(args.maven ? { mavenContracts: args.maven } : {}),
      language: args.language,
      concurrency: args.concurrency,
      access: args.access,
      env,
      ...(token ? { token } : {}),
      ...(runtime.run ? { run: runtime.run } : {}),
      onWarning: (message) => {
        logger.warn(`  ! ${message}`);
      },
    });
  } catch (error) {
    logger.error(
      `Error: cannot listen on ${args.host}:${String(args.port)} (${error instanceof Error ? error.message : String(error)})`,
    );
    return 3;
  }
  if (args.quiet) logger.info(running.url);
  else {
    logger.info('QA-CRAWLER SDK server');
    logger.info(`  Workspace : ${args.workspace}`);
    logger.info(`  Origins   : ${args.origins.length > 0 ? args.origins.join(', ') : 'same origin only'}`);
    logger.info(
      `  Sources   : ${args.sourceRoots.length > 0 ? args.sourceRoots.join(', ') : 'static analysis refused'}`,
    );
    logger.info(`  Token     : ${args.tokenEnv ? `from ${args.tokenEnv}` : running.token}`);
    logger.info(
      `  Access    : ${args.access === 'named' ? 'named tokens (the service token is the administrator)' : 'single service token'}`,
    );
    logger.info(`  Module    : ${running.url}/sdk/ui/index.js`);
    logger.info(`  API       : ${running.url}/api`);
    logger.info('');
    logger.info(`  ${running.url}   (Ctrl+C to stop)`);
  }
  runtime.onStarted?.(running);
  await (runtime.waitForStop ?? waitForSignal)();
  await running.close().catch(() => undefined);
  return 0;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}
