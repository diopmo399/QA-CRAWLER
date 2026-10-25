import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
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
      --token-env <NAME>       Read the API token from this environment variable (default: generated and printed)
      --language <fr|en>       Language of the standalone page and of the engine reports (default: en)
      --concurrency <n>        Explorations running at the same time (default: 1)
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
  tokenEnv?: string;
  language: 'fr' | 'en';
  concurrency: number;
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
        'token-env': { type: 'string' },
        language: { type: 'string' },
        concurrency: { type: 'string' },
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
  const origins = values['allow-origin'] ?? [];
  for (const origin of origins)
    if (!/^https?:\/\//i.test(origin) || !URL.canParse(origin))
      throw new UsageError(`--allow-origin must be an http(s) origin: ${origin}`);
  return {
    ...(values.workspace !== undefined ? { workspace: path.resolve(values.workspace) } : {}),
    host: values.host ?? '127.0.0.1',
    port: integer('port', values.port, 0, 4310),
    origins,
    sourceRoots: (values['allow-source-root'] ?? []).map((root) => path.resolve(root)),
    ...(values['token-env'] !== undefined ? { tokenEnv: values['token-env'] } : {}),
    language,
    concurrency: integer('concurrency', values.concurrency, 1, 1),
    quiet: values.quiet ?? false,
    help: values.help ?? false,
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
      language: args.language,
      concurrency: args.concurrency,
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
