import { navigationLogLines } from '../navigation/navigation-guard.js';
import { readFile } from 'node:fs/promises';
import { AuthError } from '../auth/authenticator.js';
import { ConfigError, loadConfigFile } from '../config/config-loader.js';
import type { ExplorationListener } from '../explorer/flow-explorer.js';
import { actionLabel } from '../model/discovered-action.js';
import type { Severity } from '../model/issue.js';
import { renderFlowDiffText } from '../diff/flow-diff.js';
import { BaselineMissingError, runMission } from '../orchestrator.js';
import { buildFlowTree, renderTextTree } from '../reporting/flow-tree.js';
import { storageLabel } from '../reporting/persistence-section.js';
import { HELP_TEXT, parseCliArgs, UsageError } from './args.js';
import { runDryRunCli } from './dry-run-command.js';
import { color, logger } from './logger.js';

export const EXIT = { OK: 0, ISSUES: 1, USAGE: 2, RUNTIME: 3 } as const;

const SEVERITY_COLOR: Record<Severity, (text: string) => string> = {
  INFO: color.blue,
  WARNING: color.yellow,
  ERROR: color.red,
  CRITICAL: (text) => color.bold(color.red(text)),
};

export async function runCli(argv: string[]): Promise<number> {
  // DRY RUN : une commande à part, ses propres options ; les autres commandes ne changent pas.
  if (argv[0] === 'dry-run') return runDryRunCli(argv.slice(1));
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
      ...(args.persistence !== undefined ? { persistence: args.persistence } : {}),
      ...(args.memory !== undefined ? { memory: args.memory } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message);
      return EXIT.USAGE;
    }
    throw error;
  }

  const { config, warnings } = loaded;
  const mode = args.mode ?? config.mission.mode;
  const { exploration, safety, goals } = config;
  const startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
  const enabledGoals = [
    ...Object.entries(goals)
      .filter(([, enabled]) => enabled === true)
      .map(([goal]) => goal),
    ...(goals.keywords.length > 0 ? [`keywords: ${goals.keywords.join(', ')}`] : []),
  ].join(', ');
  logger.info(color.bold('QA Flow Explorer'));
  logger.info(`  Mission  : ${config.mission.name} ${color.dim(`(${args.configPath})`)}`);
  logger.info(`  Mode     : ${mode} ${color.dim(`(baseline: ${args.baselineDir ?? config.baseline.dir})`)}`);
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
    const outcome = await runMission(config, {
      listener: progressListener(args.quiet),
      mode,
      ...(args.baselineDir !== undefined ? { baselineDir: args.baselineDir } : {}),
    });
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
    const intelligence = result.intelligence;
    if (intelligence) {
      const missionGoals = intelligence.goals.filter((goal) => goal.kind === 'mission');
      if (missionGoals.length > 0) {
        const reached = missionGoals.filter((goal) => goal.status === 'REACHED').length;
        logger.info(
          `  Goals         : ${reached}/${missionGoals.length} reached (${missionGoals.map((goal) => `${goal.id} ${goal.status === 'REACHED' ? color.green(goal.status) : goal.status === 'BLOCKED' ? color.yellow(goal.status) : color.red(goal.status)}`).join(', ')})`,
        );
      }
      const { actions } = intelligence.coverage;
      const total = actions.DISCOVERED + actions.EXECUTED + actions.BLOCKED + actions.UNREACHABLE;
      logger.info(
        `  Coverage      : ${actions.EXECUTED}/${total} actions executed, ${actions.BLOCKED} blocked (${intelligence.strategy})`,
      );
    }
    if (result.blockedWrites && result.blockedWrites.length > 0)
      logger.info(
        `  Writes blocked: ${color.yellow(String(result.blockedWrites.length))} (side effects, see the report)`,
      );
    if (result.browserInteractions.length > 0) {
      const byStatus = Object.entries(stats.interactionsByStatus)
        .map(([status, count]) => `${count} ${status.toLowerCase()}`)
        .join(', ');
      logger.info(`  Browser inter.: ${result.browserInteractions.length} (${byStatus})`);
    }
    if (result.verification) {
      const counts = Object.entries(result.verification.summary)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${status.toLowerCase()}`)
        .join(', ');
      const regressions = result.verification.regressions;
      logger.info(
        `  Verification  : ${result.verification.transitions.length} known transition(s) replayed (${counts}) — ${regressions > 0 ? color.red(`${regressions} regression(s)`) : color.green('no regression')}`,
      );
      for (const verified of result.verification.transitions) {
        if (verified.status === 'PASSED' || verified.status === 'SKIPPED' || verified.status === 'BLOCKED')
          continue;
        logger.info(
          `    ${color.red(verified.status.padEnd(14))} ${verified.fromLabel} → "${verified.action.text ?? verified.action.href ?? verified.action.type}"${verified.reason ? color.dim(` (${verified.reason})`) : ''}`,
        );
      }
    }
    if (result.learnedBaseline)
      logger.info(
        `  Baseline      : stored ${result.learnedBaseline.runId} → ${result.artifacts.baseline ?? ''}`,
      );
    else if (result.baseline) logger.info(`  Baseline      : ${result.baseline.runId}`);
    logger.info(`  Stopped       : ${result.stopReason} after ${(result.durationMs / 1000).toFixed(1)} s`);
    if (result.artifacts.json) logger.info(`  JSON report   : ${result.artifacts.json}`);
    if (result.artifacts.html) logger.info(`  HTML report   : ${result.artifacts.html}`);
    if (result.artifacts.flowGraph) logger.info(`  Flow graph    : ${result.artifacts.flowGraph}`);
    if (result.artifacts.flowGraphHtml) logger.info(`  Flow graph UI : ${result.artifacts.flowGraphHtml}`);
    if (result.artifacts.generatedFlows) logger.info(`  Flows (YAML)  : ${result.artifacts.generatedFlows}`);
    else if (config.flowGeneration.enabled)
      logger.info(`  Flows (YAML)  : ${color.dim('none (no screen reached by a replayable click path)')}`);
    if (result.artifacts.engineLog) logger.info(`  Engine log    : ${result.artifacts.engineLog}`);
    if (result.artifacts.decisionTrace) logger.info(`  Decisions     : ${result.artifacts.decisionTrace}`);
    if (result.artifacts.knowledge)
      logger.info(
        `  Knowledge     : ${result.artifacts.knowledge}${intelligence?.knowledge ? color.dim(` (${intelligence.knowledge.runs} run(s))`) : ''}`,
      );
    const persistence = result.persistence;
    if (persistence?.enabled) {
      const actual = storageLabel(persistence.actual);
      logger.info(
        persistence.status === 'FALLBACK'
          ? `  Persistence   : ${color.yellow(`${actual} (fallback)`)} ${color.dim(`configured ${storageLabel(persistence.configured)} — ${persistence.reason ?? ''}`)}`
          : `  Persistence   : ${actual} ${color.dim(`CONNECTED${persistence.latencyMs !== undefined ? ` latency=${persistence.latencyMs}ms` : ''}`)}`,
      );
      if (persistence.writeErrors.length > 0)
        logger.info(`  Persist. errors: ${color.yellow(persistence.writeErrors.slice(0, 3).join(' · '))}`);
    }
    if (persistence && (persistence.memory.mode === 'isolated' || persistence.memory.mode === 'current-run'))
      logger.info(`  Memory        : ${persistence.memory.mode} ${color.dim('(no history used)')}`);
    else if (persistence?.memory.mode === 'historical') {
      const memory = persistence.memory;
      logger.info(
        `  Memory        : ${memory.mode} ${color.dim(`(loaded ${memory.historicalStatesLoaded} state(s), ${memory.historicalTransitionsLoaded} transition(s); learned ${memory.newStatesLearned} new state(s), ${memory.newTransitionsLearned} new transition(s))`)}`,
      );
    }
    logger.info(`  Screenshots   : ${result.artifacts.screenshotsDir ?? '-'}`);
    if (result.artifacts.flowDiff) logger.info(`  Flow diff     : ${result.artifacts.flowDiff}`);
    logger.info('');
    if (result.flowDiff) {
      logger.info(renderFlowDiffText(result.flowDiff));
      logger.info('');
    }

    if (outcome.passed) {
      logger.info(color.green(`PASSED — no issue at or above ${config.report.failOnSeverity}`));
      return EXIT.OK;
    }
    if (outcome.regressions > 0 && outcome.failingIssues.length === 0) {
      logger.info(color.red(`FAILED — ${outcome.regressions} regression(s) compared with the baseline`));
      return EXIT.ISSUES;
    }
    logger.info(
      color.red(
        `FAILED — ${outcome.failingIssues.length} issue(s) at or above ${config.report.failOnSeverity}`,
      ),
    );
    return EXIT.ISSUES;
  } catch (error) {
    if (error instanceof BaselineMissingError) {
      logger.error(`Error: ${error.message}`);
      return EXIT.USAGE;
    }
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
    onRecovery(event) {
      if (quiet) return;
      const mark = event.success ? color.green('↻ recovered') : color.yellow('↻ recovery failed');
      logger.info(
        `      ${mark} ${event.strategy} ${color.dim(`(${event.failure}${event.message ? `: ${event.message}` : ''})`)}`,
      );
    },
    onStuck(event) {
      logger.info(
        `      ${color.yellow('⟲ stuck')} ${event.kind}: ${event.message} ${color.dim('(branch left)')}`,
      );
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
            : step.status === 'MANUAL'
              ? color.yellow('?')
              : step.status === 'BLOCKED'
                ? color.yellow('⛔')
                : color.red('✗');
      const reason = step.reason ? ` ${color.dim(`(${step.reason})`)}` : '';
      logger.info(
        `   ${mark} ${String(step.index).padStart(2, ' ')}. ${step.description}${step.status !== 'PASSED' ? ` ${step.status}` : ''}${reason}`,
      );
      if (step.interpretation) logger.info(color.dim(`       ↳ ${step.interpretation}`));
      if (step.suggestions && step.suggestions.length > 0) {
        logger.info(color.yellow('       Suggested step (found on the screen):'));
        for (const line of step.suggestions) logger.info(`         ${line}`);
      }
      if (step.onScreen && step.onScreen.length > 0)
        logger.info(color.dim(`       On the screen: ${step.onScreen.join(' · ')}`));
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
    onNavigation(event) {
      // Événement technique, jamais une anomalie : [NAVIGATION] detected / recovering / recovered, [NAVIGATION_RECOVERY_FAILED].
      if (quiet && event.type !== 'NAVIGATION_RECOVERY_FAILED') return;
      for (const line of navigationLogLines(event)) {
        logger.info(
          `      ${event.type === 'NAVIGATION_RECOVERY_FAILED' ? color.yellow(line) : color.dim(line)}`,
        );
      }
    },
    onInteractionLog(line) {
      // Structuré, sans secret : [BROWSER_INTERACTION] type=HTTP_AUTH origin=… handler=… status=… attempt=1
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
