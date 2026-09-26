import { readFile } from 'node:fs/promises';
import { AuthError } from '../auth/authenticator.js';
import { ConfigError, loadConfigFile } from '../config/config-loader.js';
import type { CrawlListener } from '../crawler/crawler.js';
import { type Issue, type Severity } from '../model/issue.js';
import { runScenario } from '../orchestrator.js';
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
    logger.error('Error: no scenario file given.\n');
    logger.info(HELP_TEXT);
    return EXIT.USAGE;
  }

  let loaded;
  try {
    loaded = await loadConfigFile(args.configPath, {
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
      ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
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
  const startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
  logger.info(color.bold('QA Crawler'));
  logger.info(`  Scenario : ${config.name} ${color.dim(`(${args.configPath})`)}`);
  logger.info(`  Target   : ${startUrl}`);
  logger.info(
    `  Limits   : ${config.exploration.maxPages} pages, depth ${config.exploration.maxDepth}, ${config.exploration.maxUrlsPerRoute} URL(s) per route`,
  );
  logger.info(
    `  Safety   : allowed hosts [${config.safety.allowedHosts.join(', ')}], executable actions [${config.safety.allowedActionClasses.join(', ')}]`,
  );
  for (const warning of warnings) logger.warn(`  ! ${warning}`);
  logger.info('');

  try {
    const outcome = await runScenario(config, { listener: progressListener(args.quiet) });
    const { result } = outcome;
    const counts = result.stats.issuesBySeverity;

    logger.info('');
    logger.info(color.bold('Summary'));
    logger.info(
      `  Pages visited : ${result.pagesVisited}${result.maxPagesReached ? color.dim(` (maxPages reached, ${result.pendingUrls} URL(s) not visited)`) : ''}`,
    );
    logger.info(`  Routes        : ${result.routes.length}`);
    logger.info(
      `  Issues        : ${result.issues.length} (${color.red(`${counts.CRITICAL} critical`)}, ${color.red(`${counts.ERROR} error`)}, ${color.yellow(`${counts.WARNING} warning`)}, ${counts.INFO} info)`,
    );
    const actions = result.stats.actionsByClassification;
    logger.info(
      `  Actions found : ${actions.SAFE} safe, ${actions.MUTATION} mutation, ${actions.DANGEROUS} dangerous, ${actions.UNKNOWN} unknown (executed: ${result.stats.actionsExecuted})`,
    );
    logger.info(`  Duration      : ${(result.durationMs / 1000).toFixed(1)} s`);
    if (result.artifacts.json) logger.info(`  JSON report   : ${result.artifacts.json}`);
    if (result.artifacts.html) logger.info(`  HTML report   : ${result.artifacts.html}`);
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
    logger.error(`Crawl failed: ${message.split('\n')[0] ?? message}`);
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      logger.error('Chromium is not installed. Run: npx playwright install chromium');
    }
    return EXIT.RUNTIME;
  }
}

function progressListener(quiet: boolean): CrawlListener {
  return {
    onAuthenticated(description) {
      logger.info(`${color.green('✓')} Authenticated: ${description}`);
    },
    onPageStart(item, sequence, queued) {
      if (quiet) return;
      logger.info(
        `${color.cyan(`[${String(sequence).padStart(3, ' ')}]`)} ${item.url} ${color.dim(`(depth ${item.depth}, ${queued} queued)`)}`,
      );
    },
    onPageDone(page, newIssues: Issue[]) {
      if (quiet) return;
      const status = page.failed
        ? color.red('FAILED')
        : page.status !== undefined
          ? String(page.status)
          : '-';
      const detail = `${status} · ${page.loadTimeMs} ms · ${page.links.queued} new link(s) · ${page.actions.length} action(s)`;
      logger.info(`      ${color.dim(detail)}`);
      for (const issue of newIssues) {
        logger.info(
          `      ${SEVERITY_COLOR[issue.severity](issue.severity.padEnd(8))} ${issue.type}: ${issue.message}`,
        );
      }
    },
    onActionExecuted(_pageUrl, label, outcome) {
      if (quiet) return;
      logger.info(`      ${color.magenta('↳ action')} "${label}": ${outcome}`);
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
