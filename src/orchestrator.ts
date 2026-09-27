import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BaselineStore, runIdOf, type Baseline, type BaselineMetadata } from './baseline/baseline-store.js';
import { sourceInfo } from './baseline/source-info.js';
import type { MissionMode, ScenarioConfig } from './config/config.js';
import type { DecisionEngine } from './decision/decision-engine.js';
import type { TestDataProvider } from './data/test-data-provider.js';
import { hostMatches } from './config/config-loader.js';
import { FlowDiffEngine, type FlowDiff } from './diff/flow-diff.js';
import { OpenApiContractProvider, type ApiContract } from './oracles/api-contract.js';
import { FlowExplorer, type ExplorationListener } from './explorer/flow-explorer.js';
import type { FlowMemory } from './memory/flow-memory.js';
import { JsonFlowMemory } from './memory/json-flow-memory.js';
import type { ExplorationResult } from './model/exploration-result.js';
import type { FlowGraphData } from './model/flow.js';
import type { VerificationReport } from './model/verification.js';
import { isAtLeast, type Issue } from './model/issue.js';
import { buildResult } from './reporting/result-builder.js';
import { writeReports } from './reporting/reporter.js';
import { redactUrl } from './security/redactor.js';
import { ManualCleanup, type TestDataCleanup } from './data/created-data.js';
import { combineListeners, EngineEventLog } from './logging/engine-log.js';

export interface RunOutcome {
  result: ExplorationResult;
  /** Issues at or above report.failOnSeverity. */
  failingIssues: Issue[];
  /** verify: known transitions that changed, fail or cannot be reached any more. */
  regressions: number;
  passed: boolean;
}

export interface RunOptions {
  listener?: ExplorationListener;
  decisionEngine?: DecisionEngine;
  testData?: TestDataProvider;
  memory?: FlowMemory;
  env?: NodeJS.ProcessEnv;
  /** learn / verify / explore; default: mission.mode. */
  mode?: MissionMode;
  /** Where the baseline lives; default: baseline.dir. */
  baselineDir?: string;
  /** Removes what the run created; default: deletes nothing and lists it. */
  cleanup?: TestDataCleanup;
}

/** verify needs a baseline: `learn` first. */
export class BaselineMissingError extends Error {
  constructor(directory: string) {
    super(`no baseline in ${directory}: run "learn" first`);
    this.name = 'BaselineMissingError';
  }
}

/**
 * QA orchestrator: mission → flow explorer → reports → verdict.
 * Independent from the CLI so it can be embedded (tests, other runners).
 *
 * - learn: explores, then stores the flow graph as the new baseline (the
 *   previous ones stay in the baseline's history);
 * - verify: replays the known transitions of the baseline and reports what
 *   changed (regressions);
 * - explore: explores, using the baseline (if any) as a hint only — known
 *   actions come after new ground — and reports what is new.
 */
export async function runMission(config: ScenarioConfig, options: RunOptions = {}): Promise<RunOutcome> {
  const mode = options.mode ?? config.mission.mode;
  const env = options.env ?? process.env;
  const store = new BaselineStore(options.baselineDir ?? config.baseline.dir, config.baseline.keepRuns);
  const baseline = await store.load();
  if (mode === 'verify' && !baseline) throw new BaselineMissingError(store.directory);

  const contract = config.openapi.enabled && config.openapi.source ? await loadContract(config) : undefined;
  const memory =
    options.memory ??
    new JsonFlowMemory(config.memory.file ?? path.join(config.output.reportsDir, 'flow-graph.json'));
  const engineLog = new EngineEventLog(config.logging.level);
  const explorer = new FlowExplorer(config, {
    memory,
    ...(options.decisionEngine ? { decisionEngine: options.decisionEngine } : {}),
    ...(options.testData ? { testData: options.testData } : {}),
    listener: combineListeners(options.listener, engineLog.listener()),
    ...(options.env ? { env: options.env } : {}),
    ...(mode === 'explore' && baseline ? { knownActions: knownActionsOf(baseline) } : {}),
    ...(baseline ? { baseline: baseline.graph } : {}),
    ...(contract ? { contract } : {}),
    ...(mode === 'verify' && baseline
      ? {
          verifyBaseline: baseline.graph,
          ...(baseline.metadata ? { baselineRunId: baseline.metadata.runId } : {}),
        }
      : {}),
  });
  const outcome = await explorer.explore();
  const current = outcome.graph.toJSON();

  const result = buildResult(outcome, config);
  result.mode = mode;
  result.cleanup = await (options.cleanup ?? new ManualCleanup()).cleanup(outcome.createdData);
  if (config.logging.file) {
    await mkdir(config.output.reportsDir, { recursive: true });
    const file = path.join(config.output.reportsDir, 'engine-log.jsonl');
    await writeFile(file, engineLog.toJsonLines(), 'utf8');
    result.artifacts.engineLog = file;
  }
  if (baseline) {
    // verify only replays some transitions (not filled forms, known failures, blocked ones):
    // it is compared with that part of the baseline only.
    const verification = mode === 'verify' ? outcome.verification : undefined;
    const reference = verification ? replayedPart(baseline.graph, verification) : baseline.graph;
    // …and with the states its transitions reached (not the screens only seen on the way).
    const diff = new FlowDiffEngine().compare(reference, verification ? reachedPart(current) : current);
    // explore follows new ground first: what it did not revisit is not gone. Only what is new or changed.
    result.flowDiff = mode === 'explore' ? onlyNewAndChanged(diff) : diff;
    if (baseline.metadata) result.baseline = baseline.metadata;
  }
  if (mode === 'learn') {
    const createdAt = new Date().toISOString();
    const source = await sourceInfo(config.baseline, env);
    const metadata: BaselineMetadata = {
      runId: runIdOf(createdAt, source.commit),
      application: config.baseline.application ?? config.mission.name,
      mission: config.mission.name,
      targetUrl: redactUrl(config.target.baseUrl),
      createdAt,
      ...source,
      ...((config.baseline.environment ?? env.QA_ENVIRONMENT)
        ? { environment: config.baseline.environment ?? env.QA_ENVIRONMENT }
        : {}),
      ...(await crawlerVersion()),
      states: current.nodes.length,
      transitions: result.stats.transitions,
    };
    await store.save(current, metadata);
    result.learnedBaseline = metadata;
    result.artifacts.baseline = store.graphFile;
  }

  const written = await writeReports(result, config.output, memory.location, config.report.language);
  const threshold = config.report.failOnSeverity;
  const failingIssues =
    threshold === 'NONE' ? [] : written.issues.filter((issue) => isAtLeast(issue.severity, threshold));
  const regressions = mode === 'verify' ? (written.verification?.regressions ?? 0) : 0;
  const regressionFails = mode === 'verify' && config.verify.failOnRegression && regressions > 0;
  return {
    result: written,
    failingIssues,
    regressions,
    passed: failingIssues.length === 0 && !regressionFails,
  };
}

/** The transitions of the baseline that verify replayed, and the states they link. */
function replayedPart(graph: FlowGraphData, verification: VerificationReport): FlowGraphData {
  const replayed = new Set(
    verification.transitions
      .filter((verified) => verified.status !== 'SKIPPED' && verified.status !== 'BLOCKED')
      .map((verified) => `${verified.from}::${verified.actionId}`),
  );
  const edges = graph.edges.filter(
    (edge) => edge.result !== 'BLOCKED' && replayed.has(`${edge.from}::${edge.actionId}`),
  );
  const states = new Set([
    ...(graph.rootId ? [graph.rootId] : []),
    ...edges.flatMap((edge) => [edge.from, edge.to]),
  ]);
  return { ...graph, nodes: graph.nodes.filter((node) => states.has(node.id)), edges };
}

function onlyNewAndChanged(diff: FlowDiff): FlowDiff {
  return {
    ...diff,
    removedStates: [],
    removedTransitions: [],
    summary: { ...diff.summary, removedStates: 0, removedTransitions: 0 },
  };
}

/** States that are the start or the end of a transition, and the root. */
function reachedPart(graph: FlowGraphData): FlowGraphData {
  const states = new Set([
    ...(graph.rootId ? [graph.rootId] : []),
    // Blocked actions are recorded on screens only seen on the way: they reach nothing.
    ...graph.edges.filter((edge) => edge.result !== 'BLOCKED').flatMap((edge) => [edge.from, edge.to]),
  ]);
  return { ...graph, nodes: graph.nodes.filter((node) => states.has(node.id)) };
}

/** The API contract (OpenAPI): a local file, or an URL on an allowed host only. */
async function loadContract(config: ScenarioConfig): Promise<ApiContract> {
  const provider = new OpenApiContractProvider(config.openapi.source ?? '', (url) => {
    try {
      const host = new URL(url).hostname;
      return config.safety.allowedHosts.some((pattern) => hostMatches(host, pattern));
    } catch {
      return false;
    }
  });
  return provider.load();
}

/** `stateId::actionId` of every transition the baseline executed. */
function knownActionsOf(baseline: Baseline): Set<string> {
  return new Set(
    baseline.graph.edges
      .filter((edge) => edge.result !== 'BLOCKED')
      .map((edge) => `${edge.from}::${edge.actionId}`),
  );
}

async function crawlerVersion(): Promise<{ crawlerVersion?: string }> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ? { crawlerVersion: pkg.version } : {};
  } catch {
    return {};
  }
}
