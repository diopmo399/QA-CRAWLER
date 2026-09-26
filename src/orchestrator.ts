import path from 'node:path';
import type { ScenarioConfig } from './config/config.js';
import type { DecisionEngine } from './decision/decision-engine.js';
import type { TestDataProvider } from './data/test-data-provider.js';
import { FlowExplorer, type ExplorationListener } from './explorer/flow-explorer.js';
import type { FlowMemory } from './memory/flow-memory.js';
import { JsonFlowMemory } from './memory/json-flow-memory.js';
import type { ExplorationResult } from './model/exploration-result.js';
import { isAtLeast, type Issue } from './model/issue.js';
import { buildResult } from './reporting/result-builder.js';
import { writeReports } from './reporting/reporter.js';

export interface RunOutcome {
  result: ExplorationResult;
  /** Issues at or above report.failOnSeverity. */
  failingIssues: Issue[];
  passed: boolean;
}

export interface RunOptions {
  listener?: ExplorationListener;
  decisionEngine?: DecisionEngine;
  testData?: TestDataProvider;
  memory?: FlowMemory;
  env?: NodeJS.ProcessEnv;
}

/**
 * QA orchestrator: mission → flow explorer → reports → verdict.
 * Independent from the CLI so it can be embedded (tests, other runners).
 */
export async function runMission(config: ScenarioConfig, options: RunOptions = {}): Promise<RunOutcome> {
  const memory =
    options.memory ??
    new JsonFlowMemory(config.memory.file ?? path.join(config.output.reportsDir, 'flow-graph.json'));
  const explorer = new FlowExplorer(config, {
    memory,
    ...(options.decisionEngine ? { decisionEngine: options.decisionEngine } : {}),
    ...(options.testData ? { testData: options.testData } : {}),
    ...(options.listener ? { listener: options.listener } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const outcome = await explorer.explore();
  const result = await writeReports(buildResult(outcome, config), config.output, memory.location);
  const threshold = config.report.failOnSeverity;
  const failingIssues =
    threshold === 'NONE' ? [] : result.issues.filter((issue) => isAtLeast(issue.severity, threshold));
  return { result, failingIssues, passed: failingIssues.length === 0 };
}
