import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { AuthError } from '../auth/authenticator.js';
import { ConfigError } from '../config/config-loader.js';
import type { HumanFlowRecorder } from '../recording/human-flow-recorder.js';
import type { RecordingEvent } from '../recording/model.js';
import {
  runRecording,
  type RecordOutcome,
  type RecordOutputFormat,
} from '../recording/record-orchestrator.js';
import { UsageError } from './args.js';
import { color, logger } from './logger.js';
import { terminalProgress } from './progress-renderer.js';

export const RECORD_HELP = `qa-crawler record — turn a human demonstration into an imposed flow

Chromium opens on the application. Use it as usual: QA-CRAWLER observes (nothing is
changed in the page, no request is intercepted), then writes ONE clean flow as
flow.yaml and .feature (the same model): stable locators, test data instead of what
you typed, secrets from environment variables, the outcomes it observed.

Usage:
  qa-crawler record --url <address> --name <flow name> [options]
  qa-crawler record -c mission.yaml --name "Create user" [--url /users]

While recording (banner in the page, or this terminal):
  Stop         the banner's Stop button, Enter here, Ctrl+C, or close the browser
  Checkpoint   the banner's Checkpoint button, or "c <label>" + Enter here
  Pause        the banner's Pause button, or "p" + Enter here

Options:
      --url <address>          Where to start (absolute, or a route of the mission)
      --name <name>            Flow name (required)
  -c, --config <file>          Mission: target, sign-in (done before recording), safety, recording:
      --output-format <f>      yaml | gherkin | both (default: recording.outputFormat, both)
      --language <fr|en>       Language of the .feature (default: report.language)
      --validate               Replay the generated flow right after (dry run): REPLAY_CONFIRMED / REPLAY_FAILED
      --reports-dir <dir>      Files go to <dir>/recordings/<name>/
      --headless               No browser window (automation only: nobody can use it)
      --dotenv <file>          Environment variables to load (default: .env if present)
  -q, --quiet                  Only print the summary
  -h, --help                   Show this help

Exit codes:
  0  flow generated (and replay confirmed with --validate)
  1  flow generated, replay failed
  2  invalid usage or configuration
  3  runtime failure (browser, sign-in)
`;

export interface RecordArgs {
  url?: string;
  name?: string;
  configPath?: string;
  outputFormat?: RecordOutputFormat;
  language?: 'fr' | 'en';
  validate: boolean;
  reportsDir?: string;
  headless: boolean;
  quiet: boolean;
  help: boolean;
}

export function parseRecordArgs(argv: string[]): RecordArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        url: { type: 'string' },
        name: { type: 'string' },
        config: { type: 'string', short: 'c' },
        'output-format': { type: 'string' },
        language: { type: 'string' },
        validate: { type: 'boolean', default: false },
        'reports-dir': { type: 'string' },
        headless: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  const format = values['output-format'];
  if (format !== undefined && !['yaml', 'gherkin', 'both'].includes(format))
    throw new UsageError('--output-format must be yaml, gherkin or both.');
  const language = values.language;
  if (language !== undefined && language !== 'fr' && language !== 'en')
    throw new UsageError('--language must be fr or en.');
  return {
    ...(values.url !== undefined ? { url: values.url } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.config !== undefined ? { configPath: values.config } : {}),
    ...(format !== undefined ? { outputFormat: format as RecordOutputFormat } : {}),
    ...(language !== undefined ? { language } : {}),
    validate: values.validate,
    ...(values['reports-dir'] !== undefined ? { reportsDir: values['reports-dir'] } : {}),
    headless: values.headless,
    quiet: values.quiet,
    help: values.help,
  };
}

export async function runRecordCli(argv: string[]): Promise<number> {
  let args: RecordArgs;
  try {
    args = parseRecordArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(RECORD_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    logger.info(RECORD_HELP);
    return 0;
  }
  if (!args.name) {
    logger.error('Error: --name is required.\n');
    logger.info(RECORD_HELP);
    return 2;
  }
  if (!args.url && !args.configPath) {
    logger.error('Error: give --url or a mission with -c.\n');
    logger.info(RECORD_HELP);
    return 2;
  }
  logger.info(color.bold('QA-CRAWLER — human flow recorder'));
  logger.info(
    `  Flow     : ${args.name}${args.configPath ? color.dim(` (mission ${args.configPath})`) : ''}`,
  );
  if (args.url) logger.info(`  Start    : ${args.url}`);
  logger.info('');
  let outcome: RecordOutcome;
  // Après Stop : une barre de progression tant que le système finalise (flow, audits, rapport).
  const progress = terminalProgress();
  try {
    outcome = await runRecording({
      onProgress: progress.sink,
      name: args.name,
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.configPath !== undefined ? { missionFile: args.configPath } : {}),
      overrides: {
        headless: args.headless,
        ...(args.reportsDir !== undefined ? { reportsDir: args.reportsDir } : {}),
      },
      ...(args.outputFormat ? { outputFormat: args.outputFormat } : {}),
      ...(args.language ? { language: args.language } : {}),
      ...(args.validate ? { validate: true } : {}),
      ...(args.quiet ? {} : { onEvent: printEvent }),
      ...(process.stdin.isTTY ? { control: terminalControl } : { control: signalControl }),
    });
  } catch (error) {
    progress.stop();
    if (error instanceof ConfigError) {
      logger.error(error.message);
      return 2;
    }
    if (error instanceof AuthError) {
      logger.error(`Authentication failed: ${error.message}`);
      return 3;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Recording failed: ${message.split('\n')[0] ?? message}`);
    return 3;
  }
  printSummary(outcome);
  return outcome.replay.status === 'REPLAY_FAILED' ? 1 : 0;
}

/** Le terminal pilote aussi l'enregistrement : Entrée (arrêter), « c libellé » (point de contrôle), « p » (pause). */
function terminalControl(recorder: HumanFlowRecorder): () => void {
  logger.info(
    color.dim('  Recording. Enter: stop · "c <label>": checkpoint · "p": pause/resume · Ctrl+C: stop'),
  );
  const lines = createInterface({ input: process.stdin });
  let paused = false;
  lines.on('line', (line) => {
    const text = line.trim();
    if (text === '') recorder.requestStop('terminal');
    else if (/^c(\s|$)/i.test(text)) void recorder.checkpoint(text.slice(1).trim());
    else if (/^p$/i.test(text)) {
      paused = !paused;
      void (paused ? recorder.pause() : recorder.resume());
    }
  });
  const stop = signalControl(recorder);
  return () => {
    lines.close();
    stop();
  };
}

function signalControl(recorder: HumanFlowRecorder): () => void {
  const onSignal = (): void => {
    recorder.requestStop('terminal');
  };
  process.on('SIGINT', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
  };
}

function printEvent(event: RecordingEvent): void {
  const shown: Partial<Record<RecordingEvent['type'], (text: string) => string>> = {
    RECORDING_STARTED: color.green,
    CHECKPOINT_ADDED: color.cyan,
    RECORDING_PAUSED: color.yellow,
    RECORDING_RESUMED: color.yellow,
    RECORDING_STOPPED: color.cyan,
    RECORDING_STOPPING: color.yellow,
    RECORDING_STOP_TIMING: color.cyan,
    RECORDING_SEMANTIC_AUDITED: color.blue,
    RECORDING_ENRICHED: color.blue,
    RECORDING_NORMALIZED: color.blue,
    OUTCOME_INFERRED: color.blue,
    FLOW_GENERATED: color.green,
    REPLAY_VALIDATION_STARTED: color.cyan,
    REPLAY_CONFIRMED: color.green,
    REPLAY_FAILED: color.red,
  };
  // Le journal de validation des cibles : une ligne concise par étape ([TARGET_MISMATCH] …).
  if (event.type === 'TARGET_VALIDATION' && event.message.startsWith('[')) {
    const ok = /^\[TARGET_(VALIDATED|REVALIDATED|CAPTURED|VALIDATING)\]/.test(event.message);
    const repaired = event.message.startsWith('[TARGET_REPAIRED]');
    logger.info(`  ${(ok ? color.dim : repaired ? color.cyan : color.yellow)(event.message)}`);
    return;
  }
  const paint = shown[event.type];
  if (paint) logger.info(`  ${paint(`[${event.type}]`)} ${event.message}`);
}

function printSummary(outcome: RecordOutcome): void {
  const { flow, session, normalized } = outcome.result;
  const q = flow.quality;
  logger.info('');
  logger.info(color.bold(`${flow.name} — RECORDED`));
  const line = (label: string, value: number | string): void => {
    logger.info(`  ${label.padEnd(20)}: ${String(value)}`);
  };
  line('Raw events', session.rawEvents.length);
  line('Semantic actions', normalized.actions.length);
  line('Final steps', flow.steps.length);
  line('Intent', flow.intent.workflow ?? '-');
  line('Assertions selected', q.assertions.selected);
  line('Ambiguous targets', q.ambiguousTargets);
  line('Fragile locators', q.fragileLocators);
  line('Replay', outcome.replay.status);
  // RECORDING VALIDATION : le détail, jamais caché derrière une note.
  const v = outcome.result.targetValidation.summary;
  logger.info('');
  logger.info(color.bold('RECORDING VALIDATION'));
  line('Human actions', v.humanActions);
  line('Targets validated', v.validated);
  line('Validated after repair', v.validatedAfterRepair);
  line('Fragile', v.fragile);
  line('Ambiguous', v.ambiguous);
  line('Unresolved', v.unresolved);
  line('AI audits', v.aiAudits);
  line('AI confirmed', v.aiConfirmed);
  line('AI rejected', v.aiRejected);
  line('AI inconclusive', v.aiInconclusive);
  line('Flow generated', flow.steps.length > 0 ? 'YES' : 'NO');
  line('Replay confidence', outcome.result.targetValidation.replayConfidence);
  for (const warning of outcome.result.warnings) logger.warn(`  ! ${warning.code}: ${warning.message}`);
  logger.info('');
  logger.info(`  Report : ${path.join(outcome.directory, 'index.html')}`);
  const generated = Object.keys(outcome.files).filter((name) => name.startsWith('generated.'));
  if (generated.length > 0)
    logger.info(`  Flow   : ${generated.map((name) => path.join(outcome.directory, name)).join(', ')}`);
}
