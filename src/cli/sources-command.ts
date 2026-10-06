import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfigFile } from '../config/config-loader.js';
import { redactText } from '../security/redactor.js';
import { prepareGitSources } from '../static-analysis/sources/prepared-source.js';
import { UsageError } from './args.js';
import { color, logger } from './logger.js';

export const SOURCES_HELP = `qa-crawler sources — fetch and analyse the application code from git, once, outside the runs

Clones (or updates) the repositories of staticAnalysis.source.git, read-only, analyses
them (fields, forms, routes, application rules) and writes the prepared knowledge next to
the clones. The runs then read it as is: no git call, no source reading, no analysis
during a test (staticAnalysis.source.gitFetch: command, the default).
Run it when the application code changes (e.g. once a day, or in the CI after a merge).

Usage:
  qa-crawler sources <mission.yaml> [options]
  npm run qa -- sources mission.yaml

Options:
  -c, --config <file>        Mission file (or pass it as the first argument)
      --reports-dir <dir>    As for a run (the clones default to .qa-crawler/sources next to it)
      --dotenv <file>        Environment variables to load (the token: tokenEnv)
  -q, --quiet                Only print the summary
  -h, --help                 Show this help

Exit codes:
  0  every repository fetched and analysed
  1  some repositories failed (the others were analysed) or nothing could be analysed
  2  invalid usage or mission
`;

interface SourcesArgs {
  configPath?: string;
  reportsDir?: string;
  quiet: boolean;
  help: boolean;
}

function parseSourcesArgs(argv: string[]): SourcesArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        'reports-dir': { type: 'string' },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1 || (positionals.length === 1 && values.config !== undefined))
    throw new UsageError('Provide a single mission file.');
  const configPath = values.config ?? positionals[0];
  return {
    ...(configPath !== undefined ? { configPath } : {}),
    ...(values['reports-dir'] !== undefined ? { reportsDir: values['reports-dir'] } : {}),
    quiet: values.quiet,
    help: values.help,
  };
}

export async function runSourcesCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: SourcesArgs;
  try {
    args = parseSourcesArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(SOURCES_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    logger.info(SOURCES_HELP);
    return 0;
  }
  if (!args.configPath) {
    logger.error('Error: no mission file given.\n');
    logger.info(SOURCES_HELP);
    return 2;
  }
  let config;
  try {
    ({ config } = await loadConfigFile(
      args.configPath,
      args.reportsDir !== undefined ? { reportsDir: args.reportsDir } : {},
      env,
    ));
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(`Error: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const source = config.staticAnalysis.source;
  if (source.git.length === 0) {
    logger.error('Error: no repository in staticAnalysis.source.git.');
    return 2;
  }
  if (source.root)
    logger.warn('staticAnalysis.source.root is set: the runs read it and ignore the prepared git source.');
  const started = Date.now();
  const outcome = await prepareGitSources({
    config,
    env,
    onEvent: (event, message) => {
      if (!args.quiet) logger.info(color.dim(`  ${event}: ${redactText(message)}`));
    },
  });
  for (const repo of outcome.fetch.repositories) {
    if (repo.status === 'FAILED')
      logger.error(`${color.red('✗')} ${repo.url} (${repo.ref}): ${repo.reason ?? 'failed'}`);
    else
      logger.info(
        `${color.green('✓')} ${repo.url} (${repo.ref}) ${repo.status.toLowerCase()} @ ${repo.commit ?? '?'}`,
      );
  }
  for (const note of outcome.fetch.notes.filter((entry) => !entry.startsWith('GIT_SOURCE_FAILED')))
    logger.warn(note);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!outcome.knowledge) {
    logger.error(`Nothing prepared: ${outcome.reason ?? 'unknown reason'} (${seconds} s).`);
    return 1;
  }
  const { graph } = outcome.knowledge;
  logger.info(
    `Prepared in ${seconds} s: ${String(graph.stats.files)} file(s), ${String(graph.forms.length)} form(s), ${String(graph.fields.length)} field(s), ${String(graph.routes.length)} route(s), ${String(graph.rules?.length ?? 0)} rule(s) — coverage ${graph.coverage}.`,
  );
  const relative = path.relative(process.cwd(), outcome.file);
  logger.info(`Knowledge: ${relative && !relative.startsWith('..') ? relative : outcome.file}`);
  if (source.gitFetch === 'run')
    logger.warn(
      'staticAnalysis.source.gitFetch is "run": the runs still fetch and analyse; set it to "command".',
    );
  return outcome.fetch.repositories.some((repo) => repo.status === 'FAILED') ? 1 : 0;
}
