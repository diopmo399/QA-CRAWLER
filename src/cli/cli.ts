import { readFile } from 'node:fs/promises';
import { AuthError } from '../auth/authenticator.js';
import { ConfigError, loadConfigFile } from '../config/config-loader.js';
import type { ExplorationListener } from '../explorer/flow-explorer.js';
import { actionLabel } from '../model/discovered-action.js';
import type { Severity } from '../model/issue.js';
import { runMission } from '../orchestrator.js';
import { buildFlowTree, renderTextTree } from '../reporting/flow-tree.js';
import { HELP_TEXT, parseCliArgs, UsageError } from './args.js';
import { color, logger } from './logger.js';

export const EXIT = { OK: 0, ISSUES: 1, USAGE: 2, RUNTIME: 3 } as const;

const SEVERITY_COLOR: Record<Severity, (text: string) => string> = {
  INFO: color.blue,
  WARNING: color.yellow,
  ERROR: color.red,
  CRITICAL: (text) => color.bold(color.red(text)),
};

export async function runCli(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(HELP_TEXT);
      return EXIT.USAGE;
    }
    throw error;
  }

  if (args.help) {
    logger.info(HELP_TEXT);
    return EXIT.OK;
  }
  if (args.version) {
    logger.info(await readVersion());
    return EXIT.OK;
  }
  if (!args.configPath) {
    logger.error('Error: no mission file given.\n');
    logger.info(HELP_TEXT);
    return EXIT.USAGE;
  }

  let loaded;
  try {
    loaded = await loadConfigFile(args.configPath, {
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
      ...(args.maxStates !== undefined ? { maxStates: args.maxStates } : {}),
      ...(args.maxActions !== undefined ? { maxActions: args.maxActions } : {}),
      ...(args.headless !== undefined ? { headless: args.headless } : {}),
      ...(args.reportsDir !== undefined ? { reportsDir: args.reportsDir } : {}),
      ...(args.screenshotsDir !== undefined ? { screenshotsDir: args.screenshotsDir } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message);
      return EXIT.USAGE;
    }
    throw error;
  }

  const { config, warnings } = loaded;
  const { exploration, safety, goals } = config;
  const startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
  const enabledGoals = Object.entries(goals)
    .filter(([, enabled]) => enabled)
    .map(([goal]) => goal)
    .join(', ');
  logger.info(color.bold('QA Flow Explorer'));
  logger.info(`  Mission  : ${config.mission.name} ${color.dim(`(${args.configPath})`)}`);
  logger.info(`  Target   : ${startUrl}`);
  logger.info(`  Goals    : ${enabledGoals}`);
  logger.info(
    `  Limits   : ${exploration.maxStates} states, ${exploration.maxActions} actions, depth ${exploration.maxDepth}, ${exploration.maxDurationMinutes} min`,
  );
  logger.info(
    `  Safety   : executes [${safety.allowedActionClasses.join(', ')}] ${safety.allow.join('/')}; blocks ${safety.block.join(', ')}`,
  );
  if (config.flows.length > 0) {
    logger.info(
      `  Flows    : ${config.flows.map((flow) => `${flow.name} (${flow.steps.length} steps)`).join(', ')}${exploration.autonomous ? ', then autonomous exploration' : ' only'}`,
    );
  }
  for (const warning of warnings) logger.warn(`  ! ${warning}`);
  logger.info('');

  try {
    const outcome = await runMission(config, { listener: progressListener(args.quiet) });
    const { result } = outcome;
    const { stats } = result;
    const counts = stats.issuesBySeverity;

    logger.info('');
    logger.info(color.bold('Discovered flow'));
    logger.info(renderTextTree(buildFlowTree(result.states, result.transitions, result.states[0]?.id)));
    logger.info('');
    logger.info(color.bold('Summary'));
    logger.info(`  States        : ${stats.states} (max depth ${stats.maxDepth})`);
    logger.info(`  Transitions   : ${stats.transitions}`);
    logger.info(
      `  Actions       : ${stats.actionsExecuted} executed, ${stats.actionsBlocked} blocked, ${stats.actionsFailed} failed, ${stats.backtracks} backtrack(s)`,
    );
    logger.info(
      `  Issues        : ${result.issues.length} (${color.red(`${counts.CRITICAL} critical`)}, ${color.red(`${counts.ERROR} error`)}, ${color.yellow(`${counts.WARNING} warning`)}, ${counts.INFO} info)`,
    );
    if (result.flows.length > 0) {
      const statusCount = (status: string): number =>
        result.flows.filter((flow) => flow.status === status).length;
      logger.info(
        `  Flows         : ${result.flows.length} (${color.green(`${statusCount('PASSED')} passed`)}, ${color.red(`${statusCount('FAILED')} failed`)}, ${color.yellow(`${statusCount('BLOCKED')} blocked`)}, ${statusCount('SKIPPED')} skipped)`,
      );
    }
    if (result.browserInteractions.length > 0) {
      const byStatus = Object.entries(stats.interactionsByStatus)
        .map(([status, count]) => `${count} ${status.toLowerCase()}`)
        .join(', ');
      logger.info(`  Browser inter.: ${result.browserInteractions.length} (${byStatus})`);
    }
    logger.info(`  Stopped       : ${result.stopReason} after ${(result.durationMs / 1000).toFixed(1)} s`);
    if (result.artifacts.json) logger.info(`  JSON report   : ${result.artifacts.json}`);
    if (result.artifacts.html) logger.info(`  HTML report   : ${result.artifacts.html}`);
    if (result.artifacts.flowGraph) logger.info(`  Flow graph    : ${result.artifacts.flowGraph}`);
    if (result.artifacts.flowGraphHtml) logger.info(`  Flow graph UI : ${result.artifacts.flowGraphHtml}`);
    logger.info(`  Screenshots   : ${result.artifacts.screenshotsDir ?? '-'}`);
    logger.info('');

    if (outcome.passed) {
      logger.info(color.green(`PASSED — no issue at or above ${config.report.failOnSeverity}`));
      return EXIT.OK;
    }
    logger.info(
      color.red(
        `FAILED — ${outcome.failingIssues.length} issue(s) at or above ${config.report.failOnSeverity}`,
      ),
    );
    return EXIT.ISSUES;
  } catch (error) {
    if (error instanceof AuthError) {
      logger.error(`Authentication failed: ${error.message}`);
      return EXIT.RUNTIME;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Exploration failed: ${message.split('\n')[0] ?? message}`);
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      logger.error('Chromium is not installed. Run: npx playwright install chromium');
    }
    return EXIT.RUNTIME;
  }
}

function progressListener(quiet: boolean): ExplorationListener {
  let step = 0;
  return {
    onAuthenticated(description) {
      logger.info(`${color.green('✓')} Authenticated: ${description}`);
    },
    onState(context, isNew) {
      if (quiet || !isNew) return;
      logger.info(
        `${color.green('◆ new state')} ${color.bold(context.stateLabel)} ${color.dim(`${context.url} · ${context.actions.length} action(s) · depth ${context.metadata.depth}`)}`,
      );
    },
    onTransition(edge, action) {
      if (quiet) return;
      step += 1;
      const target =
        edge.result !== 'SUCCESS'
          ? color.red(`${edge.result}: ${edge.reason ?? ''}`)
          : edge.to === edge.from
            ? color.dim('(same state)')
            : edge.to;
      logger.info(
        `${color.cyan(`[${String(step).padStart(3, ' ')}]`)} ${action.type} "${actionLabel(action)}" → ${target}`,
      );
    },
    onBlocked(_context, action, reason) {
      if (quiet) return;
      logger.info(
        `      ${color.yellow('⛔ blocked')} ${action.type} "${actionLabel(action)}" ${color.dim(`(${action.classification}: ${reason})`)}`,
      );
    },
    onBacktrack(_from, to, method) {
      if (quiet) return;
      logger.info(`      ${color.magenta('↩ backtrack')} ${to ?? ''} ${color.dim(`(${method})`)}`);
    },
    onFlowStart(flow) {
      logger.info(
        `${color.bold(color.cyan('▶ flow'))} ${color.bold(flow.name)} ${color.dim(`(${flow.steps.length} steps)`)}`,
      );
    },
    onFlowStep(_flow, step) {
      const mark =
        step.status === 'PASSED'
          ? color.green('✓')
          : step.status === 'SKIPPED'
            ? color.dim('-')
            : step.status === 'BLOCKED'
              ? color.yellow('⛔')
              : color.red('✗');
      const reason = step.reason ? ` ${color.dim(`(${step.reason})`)}` : '';
      logger.info(
        `   ${mark} ${String(step.index).padStart(2, ' ')}. ${step.description}${step.status !== 'PASSED' ? ` ${step.status}` : ''}${reason}`,
      );
    },
    onFlowEnd(report) {
      const status =
        report.status === 'PASSED'
          ? color.green(report.status)
          : report.status === 'SKIPPED'
            ? color.dim(report.status)
            : color.red(report.status);
      logger.info(
        `${color.bold(color.cyan('■ flow'))} ${report.name}: ${status} ${color.dim(`${(report.durationMs / 1000).toFixed(1)} s${report.explored ? ', last screen explored' : ''}`)}`,
      );
    },
    onInteractionLog(line) {
      // Structured, without secrets: [BROWSER_INTERACTION] type=HTTP_AUTH origin=… handler=… status=… attempt=1
      if (!quiet) logger.info(`      ${color.magenta(line)}`);
    },
    onIssue(issue, isNew) {
      if (quiet || !isNew) return;
      logger.info(
        `      ${SEVERITY_COLOR[issue.severity](issue.severity.padEnd(8))} ${issue.type}: ${issue.message}`,
      );
    },
  };
}

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
