import path from 'node:path';
import { parseArgs } from 'node:util';
import { AuthError } from '../auth/authenticator.js';
import { ConfigError, PERSISTENCE_CHOICES, type PersistenceChoice } from '../config/config-loader.js';
import type { DryRunEvent } from '../dry-run/dry-run-engine.js';
import { runDryRun, type DryRunOutputFormat, type DryRunResult } from '../dry-run/dry-run-orchestrator.js';
import type { Reconciliation, ReconciliationStatus } from '../dry-run/reconciliation-model.js';
import { UsageError } from './args.js';
import { color, logger } from './logger.js';

export const DRY_RUN_HELP = `qa-crawler dry-run — check a developer scenario against the real application

The scenario (.feature or flow.yaml) is a list of semantic checkpoints, not a
script: each step is looked for on the screen; when it is not there, QA-CRAWLER
explores (safety policy always applied) to find it or the next ones, never stops
at the first mismatch, then writes ONE reconciliation and ONE suggested flow.
The scenario file is never modified.

Usage:
  qa-crawler dry-run <scenario.feature | scenario.flow.yaml> [--config <mission.yaml>] [options]
  npm run qa -- dry-run create-user.feature -c mission.yaml --output-format both

Options:
  -c, --config <file>          Mission (target, sign-in, safety, gherkin.steps, reusable flows).
                               A mission given as the scenario (dry-run mission.yaml) checks its own flows.
      --base-url <url>         Target (without --config, or to override it; also QA_BASE_URL)
      --use-history            Try known paths (memory, knowledge) before exploring
      --no-history             Current exploration only
      --isolated-memory        Keep this dry run's knowledge apart (default: shared with the
                               mission's runs, knowledge.file)
      --max-depth <n>          Actions at most between two found intents (dryRun.maxDepth)
      --max-actions <n>        Guided actions at most (dryRun.maxActions)
      --max-duration <time>    Time budget: ms, or 90s, 2m (dryRun.maxDurationMs)
      --output-format <f>      gherkin | yaml | both (default: dryRun.suggestion)
      --reports-dir <dir>      Reports go to <dir>/dry-run/<scenario>/
      --headed                 Show the browser window
      --persistence <p> / --no-persistence / --memory / --no-memory   as for a run
  -q, --quiet                  Only print the summary
  -h, --help                   Show this help

Exit codes:
  0  FULLY_MATCHED or PARTIALLY_MATCHED (every expected step found)
  1  DIVERGED, BLOCKED or INCONCLUSIVE
  2  invalid usage or scenario
  3  runtime failure (browser, sign-in)
`;

export interface DryRunArgs {
  scenario?: string;
  configPath?: string;
  baseUrl?: string;
  useHistory?: boolean;
  isolatedMemory?: boolean;
  maxDepth?: number;
  maxActions?: number;
  maxDurationMs?: number;
  outputFormat?: DryRunOutputFormat;
  reportsDir?: string;
  headless?: boolean;
  persistence?: PersistenceChoice;
  memory?: boolean;
  quiet: boolean;
  help: boolean;
}

export function parseDryRunArgs(argv: string[]): DryRunArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        'base-url': { type: 'string' },
        'use-history': { type: 'boolean', default: false },
        'no-history': { type: 'boolean', default: false },
        'isolated-memory': { type: 'boolean', default: false },
        'max-depth': { type: 'string' },
        'max-actions': { type: 'string' },
        'max-duration': { type: 'string' },
        'output-format': { type: 'string' },
        'reports-dir': { type: 'string' },
        headed: { type: 'boolean', default: false },
        persistence: { type: 'string' },
        'no-persistence': { type: 'boolean', default: false },
        memory: { type: 'boolean' },
        'no-memory': { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError('Provide a single scenario file.');
  if (values['use-history'] && values['no-history'])
    throw new UsageError('Use either --use-history or --no-history.');
  const format = values['output-format'];
  if (format !== undefined && !['gherkin', 'yaml', 'both'].includes(format))
    throw new UsageError('--output-format must be gherkin, yaml or both.');
  const persistence = values['no-persistence'] ? 'off' : values.persistence;
  if (persistence !== undefined && !(PERSISTENCE_CHOICES as readonly string[]).includes(persistence))
    throw new UsageError(`--persistence must be one of ${PERSISTENCE_CHOICES.join(', ')}.`);
  if (values['no-memory'] && values.memory) throw new UsageError('Use either --memory or --no-memory.');
  const memory = values['no-memory'] ? false : values.memory;
  const maxDepth = integer('max-depth', values['max-depth']);
  const maxActions = integer('max-actions', values['max-actions']);
  const maxDurationMs = duration(values['max-duration']);
  const scenario = positionals[0];
  return {
    ...(scenario !== undefined ? { scenario } : {}),
    ...(values.config !== undefined ? { configPath: values.config } : {}),
    ...(values['base-url'] !== undefined ? { baseUrl: values['base-url'] } : {}),
    ...(values['use-history'] ? { useHistory: true } : values['no-history'] ? { useHistory: false } : {}),
    ...(values['isolated-memory'] ? { isolatedMemory: true } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxActions !== undefined ? { maxActions } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(format !== undefined ? { outputFormat: format as DryRunOutputFormat } : {}),
    ...(values['reports-dir'] !== undefined ? { reportsDir: values['reports-dir'] } : {}),
    ...(values.headed ? { headless: false } : {}),
    ...(persistence !== undefined ? { persistence: persistence as PersistenceChoice } : {}),
    ...(memory !== undefined ? { memory } : {}),
    quiet: values.quiet,
    help: values.help,
  };
}

function integer(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`--${name} must be a positive integer.`);
  return parsed;
}

/** 120000, 90s, 2m → millisecondes. */
function duration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match?.[1]) throw new UsageError('--max-duration must be a duration: 120000, 90s or 2m.');
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const ms = unit === 'm' ? amount * 60_000 : unit === 's' ? amount * 1000 : amount;
  if (ms < 1000) throw new UsageError('--max-duration must be at least 1s.');
  return ms;
}

const SYMBOL: Record<ReconciliationStatus, string> = {
  MATCHED: '✓',
  INSERTED: '+',
  MISSING: '?',
  REORDERED: '↕',
  ALTERNATIVE: '⇄',
  AMBIGUOUS: '≈',
  UNREACHABLE: '✗',
  POSSIBLY_OBSOLETE: '−',
  ASSERTION_MISMATCH: '≠',
  BLOCKED_BY_POLICY: '⛔',
  NOT_VERIFIED: '…',
};

export async function runDryRunCli(argv: string[]): Promise<number> {
  let args: DryRunArgs;
  try {
    args = parseDryRunArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(DRY_RUN_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    logger.info(DRY_RUN_HELP);
    return 0;
  }
  if (!args.scenario) {
    logger.error('Error: no scenario file given.\n');
    logger.info(DRY_RUN_HELP);
    return 2;
  }
  logger.info(color.bold('QA-CRAWLER dry run'));
  logger.info(
    `  Scenario : ${args.scenario}${args.configPath ? color.dim(` (mission ${args.configPath})`) : ''}`,
  );
  logger.info('');
  let result: DryRunResult;
  try {
    result = await runDryRun({
      scenarioFile: args.scenario,
      ...(args.configPath ? { missionFile: args.configPath } : {}),
      overrides: {
        ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
        ...(args.reportsDir !== undefined ? { reportsDir: args.reportsDir } : {}),
        ...(args.headless !== undefined ? { headless: args.headless } : {}),
        ...(args.persistence !== undefined ? { persistence: args.persistence } : {}),
        ...(args.memory !== undefined ? { memory: args.memory } : {}),
      },
      ...(args.useHistory !== undefined ? { useHistory: args.useHistory } : {}),
      ...(args.isolatedMemory ? { isolatedMemory: true } : {}),
      ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
      ...(args.maxActions !== undefined ? { maxActions: args.maxActions } : {}),
      ...(args.maxDurationMs !== undefined ? { maxDurationMs: args.maxDurationMs } : {}),
      ...(args.outputFormat ? { outputFormat: args.outputFormat } : {}),
      ...(args.quiet ? {} : { onEvent: printEvent }),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      // Le message contient déjà le détail (une ligne par cause).
      logger.error(error.message);
      return 2;
    }
    if (error instanceof AuthError) {
      logger.error(`Authentication failed: ${error.message}`);
      return 3;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Dry run failed: ${message.split('\n')[0] ?? message}`);
    return 3;
  }
  for (const warning of result.warnings) logger.warn(`  ! ${warning}`);
  for (const flow of result.flows) printSummary(flow.reconciliation, flow.directory, flow.files);
  return result.status === 'FULLY_MATCHED' || result.status === 'PARTIALLY_MATCHED' ? 0 : 1;
}

function printEvent(event: DryRunEvent): void {
  const shown: Partial<Record<DryRunEvent['type'], (text: string) => string>> = {
    INTENT_MATCHED: color.green,
    INTENT_MISMATCH: color.yellow,
    GUIDED_EXPLORATION_STARTED: color.cyan,
    PATH_DISCOVERED: color.cyan,
    FLOW_STEP_INSERTED: color.blue,
    FLOW_STEP_REORDERED: color.magenta,
    FLOW_STEP_POSSIBLY_OBSOLETE: color.yellow,
    FLOW_STEP_AMBIGUOUS: color.yellow,
  };
  const paint = shown[event.type];
  if (paint) logger.info(`  ${paint(`[${event.type}]`)} ${event.message}`);
}

/** Le résumé et la vue côte à côte : original · statut · suggéré. */
function printSummary(
  reconciliation: Reconciliation,
  directory: string,
  files: Record<string, string>,
): void {
  const s = reconciliation.summary;
  logger.info('');
  logger.info(color.bold(`${reconciliation.flow} — DRY RUN`));
  logger.info('');
  const width = Math.min(
    40,
    Math.max(8, ...reconciliation.entries.map((entry) => entry.expectedIntent?.label.length ?? 0)),
  );
  logger.info(`  ${'Original'.padEnd(width)}      Suggested`);
  logger.info(`  ${'─'.repeat(width + 30)}`);
  for (const entry of reconciliation.entries) {
    const kept = ['POSSIBLY_OBSOLETE', 'MISSING', 'UNREACHABLE'].includes(entry.status);
    const original = (entry.expectedIntent?.label ?? '').slice(0, width).padEnd(width);
    const suggested =
      entry.observedTarget?.label ??
      (kept ? color.dim('(kept for review)') : (entry.expectedIntent?.label ?? ''));
    logger.info(`  ${original}  ${SYMBOL[entry.status]}   ${suggested}  ${color.dim(entry.status)}`);
  }
  logger.info('');
  const line = (label: string, value: number | string): void => {
    logger.info(`  ${label.padEnd(18)}: ${String(value)}`);
  };
  line('Scenario status', reconciliation.status);
  line('Original intents', s.originalIntents);
  line('Matched', s.matched);
  line('Inserted', s.inserted);
  line('Reordered', s.reordered);
  line('Alternative', s.alternative);
  line('Possibly obsolete', s.possiblyObsolete);
  line('Missing', s.missing);
  line('Ambiguous', s.ambiguous);
  line('Unreachable', s.unreachable);
  line('Assertion mismatch', s.assertionMismatch);
  line('Blocked', s.blocked);
  line('Not verified', s.notVerified);
  logger.info('');
  logger.info(`  Report    : ${path.join(directory, 'index.html')}`);
  const suggested = Object.keys(files).filter((name) => name.startsWith('suggested.'));
  if (suggested.length > 0)
    logger.info(`  Suggested : ${suggested.map((name) => path.join(directory, name)).join(', ')}`);
}
