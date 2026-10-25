import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfigFile } from '../config/config-loader.js';
import type { ScenarioConfig } from '../config/config.js';
import { openKnowledgeCenter, type KnowledgeCenterContext } from '../knowledge-center/context.js';
import { startKnowledgeCenterServer, type RunningServer } from '../knowledge-center/server.js';
import { KnowledgeCenterService } from '../knowledge-center/service.js';
import { PersistenceUnavailableError } from '../persistence/persistence-manager.js';
import { findProjectConfigFile, loadProjectConfig, loadProjectMission } from '../project/project-config.js';
import { UsageError } from './args.js';
import { logger } from './logger.js';

/**
 * `qa-crawler knowledge-center` : le tableau de bord de la mémoire, servi en local. La mission est
 * celle du projet (qa-crawler.config.yaml, cherché vers le haut) ou un fichier de mission (-c) : la
 * même configuration effective que les runs, la même persistance (ouverte comme l'orchestrateur
 * l'ouvre), les mêmes fichiers. Rien n'est activé en plus : `memory` et `persistence` sont lus.
 */
export const KNOWLEDGE_CENTER_HELP = `qa-crawler knowledge-center — the Knowledge Center: see, understand and manage what QA-CRAWLER learned

Usage:
  qa-crawler knowledge-center [options]                      project configuration (qa-crawler.config.yaml, searched upwards)
  qa-crawler knowledge-center -c <mission.yaml> [options]    a mission file

Options:
  -c, --config <file>      Mission file (legacy usage); otherwise the project configuration
      --cwd <dir>          Project directory (default: current directory)
      --reports-dir <dir>  Reports directory of the mission (recordings are read under <dir>/recordings)
      --host <address>     Address to listen on (default: 127.0.0.1; another address exposes the dashboard on the network)
      --port <n>           Port (default: 4190; 0 picks a free port)
      --read-only          No decision, import, backup or restore: consultation only
      --stale-days <n>     A knowledge not seen for more than n days is STALE (default: 90)
      --limit <n>          Rows read at most per table (default: 20000)
      --language <fr|en>   Language of the page (default: report.language of the mission)
      --token <value>      Session token for write operations (default: generated and printed)
      --quiet              Only the URL
  -h, --help               This help

The persistence is opened exactly as a run opens it (persistence.enabled, provider, fallback). The memory
configuration (memory.enabled, historicalKnowledge) is read and shown, never changed. Nothing is written
without an explicit action in the page; every write goes to the review ledger
(<knowledge>/knowledge-center/review-ledger.json). Ctrl+C stops the server.
`;

interface KnowledgeCenterArgs {
  configPath?: string;
  cwd: string;
  reportsDir?: string;
  host: string;
  port: number;
  readOnly: boolean;
  staleDays?: number;
  limit?: number;
  language?: 'fr' | 'en';
  token?: string;
  quiet: boolean;
  help: boolean;
}

export function parseKnowledgeCenterArgs(argv: readonly string[]): KnowledgeCenterArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string', short: 'c' },
        cwd: { type: 'string' },
        'reports-dir': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        'read-only': { type: 'boolean' },
        'stale-days': { type: 'string' },
        limit: { type: 'string' },
        language: { type: 'string' },
        token: { type: 'string' },
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
  const integer = (name: string, value: string | undefined, min: number): number | undefined => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min)
      throw new UsageError(`--${name} must be an integer ≥ ${String(min)}`);
    return number;
  };
  const language = values.language;
  if (language !== undefined && language !== 'fr' && language !== 'en')
    throw new UsageError('--language must be fr or en');
  const port = integer('port', values.port, 0) ?? 4190;
  return {
    ...(values.config !== undefined ? { configPath: values.config } : {}),
    cwd: values.cwd !== undefined ? path.resolve(values.cwd) : process.cwd(),
    ...(values['reports-dir'] !== undefined ? { reportsDir: values['reports-dir'] } : {}),
    host: values.host ?? '127.0.0.1',
    port,
    readOnly: values['read-only'] ?? false,
    ...(integer('stale-days', values['stale-days'], 1) !== undefined
      ? { staleDays: integer('stale-days', values['stale-days'], 1) }
      : {}),
    ...(integer('limit', values.limit, 1) !== undefined ? { limit: integer('limit', values.limit, 1) } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(values.token !== undefined ? { token: values.token } : {}),
    quiet: values.quiet ?? false,
    help: values.help ?? false,
  };
}

/** La configuration effective : un fichier de mission, ou la mission dérivée du projet. */
export async function knowledgeCenterConfig(
  args: Pick<KnowledgeCenterArgs, 'configPath' | 'cwd' | 'reportsDir'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ config: ScenarioConfig; source: string; warnings: string[] }> {
  const overrides = args.reportsDir !== undefined ? { reportsDir: args.reportsDir } : {};
  if (args.configPath) {
    const loaded = await loadConfigFile(args.configPath, overrides, env);
    return { config: loaded.config, source: loaded.source, warnings: loaded.warnings };
  }
  const file = await findProjectConfigFile(args.cwd);
  if (!file)
    throw new ConfigError(
      `No qa-crawler.config.yaml found from ${args.cwd} (run "qa-crawler init"), and no mission file given (-c <mission.yaml>)`,
    );
  const project = await loadProjectConfig(file);
  const loaded = await loadProjectMission(project, { command: 'explore' }, overrides, env);
  return { config: loaded.config, source: file, warnings: loaded.warnings };
}

export interface KnowledgeCenterRuntime {
  /** Résout dès que le serveur doit s'arrêter (par défaut : SIGINT / SIGTERM). */
  waitForStop?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  onStarted?: (running: RunningServer, context: KnowledgeCenterContext) => void;
}

export async function runKnowledgeCenterCli(
  argv: string[],
  runtime: KnowledgeCenterRuntime = {},
): Promise<number> {
  let args: KnowledgeCenterArgs;
  try {
    args = parseKnowledgeCenterArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(KNOWLEDGE_CENTER_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    logger.info(KNOWLEDGE_CENTER_HELP);
    return 0;
  }
  const env = runtime.env ?? process.env;
  let loaded;
  try {
    loaded = await knowledgeCenterConfig(args, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(`Error: ${error.message}`);
      for (const detail of error.details) logger.error(`  - ${detail}`);
      return 2;
    }
    throw error;
  }
  let context: KnowledgeCenterContext;
  try {
    context = await openKnowledgeCenter(
      loaded.config,
      {
        readOnly: args.readOnly,
        language: args.language ?? loaded.config.report.language,
        ...(args.staleDays !== undefined ? { staleAfterDays: args.staleDays } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      env,
    );
  } catch (error) {
    if (error instanceof PersistenceUnavailableError) {
      logger.error(`Error: ${error.message}`);
      return 3;
    }
    throw error;
  }
  const service = new KnowledgeCenterService(context);
  let running: RunningServer;
  try {
    running = await startKnowledgeCenterServer(service, {
      host: args.host,
      port: args.port,
      ...(args.token ? { token: args.token } : {}),
    });
  } catch (error) {
    await context.close();
    logger.error(
      `Error: cannot listen on ${args.host}:${String(args.port)} (${error instanceof Error ? error.message : String(error)})`,
    );
    return 3;
  }
  if (args.quiet) logger.info(running.url);
  else {
    logger.info('QA-CRAWLER Knowledge Center');
    logger.info(`  Mission     : ${loaded.config.mission.name} (${loaded.source})`);
    logger.info(`  Application : ${context.current.applicationId}`);
    logger.info(`  Persistence : ${persistenceLine(context)}`);
    logger.info(
      `  Memory      : ${context.memoryMode}${context.config.memory.enabled === undefined ? ' (memory.enabled not set)' : ''}`,
    );
    logger.info(`  Knowledge   : ${context.knowledgeFile}`);
    logger.info(`  Recordings  : ${context.recordingsDir}`);
    for (const warning of [...loaded.warnings, ...context.warnings]) logger.warn(`  ! ${warning}`);
    logger.info(
      `  Mode        : ${args.readOnly ? 'read-only' : 'read-write (session token printed below, carried by the page)'}`,
    );
    if (!args.readOnly) logger.info(`  Token       : ${running.token}`);
    logger.info('');
    logger.info(`  ${running.url}   (Ctrl+C to stop)`);
  }
  runtime.onStarted?.(running, context);
  await (runtime.waitForStop ?? waitForSignal)();
  await running.close().catch(() => undefined);
  await context.close();
  return 0;
}

function persistenceLine(context: KnowledgeCenterContext): string {
  const { status } = context.persistence;
  if (!status.enabled) return 'disabled';
  const actual = status.actual
    ? (status.actual.database ?? status.actual.provider) +
      (status.actual.location ? ` · ${status.actual.location}` : '')
    : '?';
  return `${status.status.toLowerCase()} · ${actual}${status.reason ? ` (${status.reason})` : ''}`;
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
