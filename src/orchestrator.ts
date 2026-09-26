import type { ScenarioConfig } from './config/config.js';
import { CrawlEngine, type CrawlListener } from './crawler/crawler.js';
import type { DecisionEngine } from './decision/decision-engine.js';
import type { CrawlResult } from './model/crawl-result.js';
import { isAtLeast, type Issue } from './model/issue.js';
import { writeReports } from './reporting/reporter.js';

export interface RunOutcome {
  result: CrawlResult;
  /** Issues at or above report.failOnSeverity. */
  failingIssues: Issue[];
  passed: boolean;
}

export interface RunOptions {
  listener?: CrawlListener;
  decisionEngine?: DecisionEngine;
  env?: NodeJS.ProcessEnv;
}

/**
 * QA orchestrator: scenario → crawl engine → reports → verdict.
 * Kept independent from the CLI so it can be embedded (tests, other runners).
 */
export async function runScenario(config: ScenarioConfig, options: RunOptions = {}): Promise<RunOutcome> {
  const engine = new CrawlEngine(config, options);
  const result = await writeReports(await engine.run(), config.output);
  const threshold = config.report.failOnSeverity;
  const failingIssues =
    threshold === 'NONE' ? [] : result.issues.filter((issue) => isAtLeast(issue.severity, threshold));
  return { result, failingIssues, passed: failingIssues.length === 0 };
}
