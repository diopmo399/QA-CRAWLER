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
import { flowsYaml, generateFlows } from './flows/flow-generator.js';
import { DefaultTestDataProvider } from './data/test-data-provider.js';
import { AuthorizationObserver, type AuthorizationReport } from './actors/authorization-observer.js';

export interface RunOutcome {
  result: ExplorationResult;
  /** Anomalies de gravité report.failOnSeverity ou plus. */
  failingIssues: Issue[];
  /** verify : transitions connues qui ont changé, échouent ou ne peuvent plus être atteintes. */
  regressions: number;
  passed: boolean;
}

export interface RunOptions {
  listener?: ExplorationListener;
  decisionEngine?: DecisionEngine;
  testData?: TestDataProvider;
  memory?: FlowMemory;
  env?: NodeJS.ProcessEnv;
  /** learn / verify / explore ; par défaut : mission.mode. */
  mode?: MissionMode;
  /** Où se trouve la baseline ; par défaut : baseline.dir. */
  baselineDir?: string;
  /** Supprime ce que le run a créé ; par défaut : ne supprime rien et le liste. */
  cleanup?: TestDataCleanup;
}

/** verify a besoin d'une baseline : `learn` d'abord. */
export class BaselineMissingError extends Error {
  constructor(directory: string) {
    super(`no baseline in ${directory}: run "learn" first`);
    this.name = 'BaselineMissingError';
  }
}

/**
 * Orchestrateur QA : mission → explorateur de flows → rapports → verdict.
 * Indépendant de la CLI pour pouvoir être intégré (tests, autres exécuteurs).
 *
 * - learn : explore, puis enregistre le graphe des flows comme nouvelle baseline (les
 *   précédentes restent dans l'historique de la baseline) ;
 * - verify : rejoue les transitions connues de la baseline et signale ce qui a
 *   changé (régressions) ;
 * - explore : explore, en utilisant la baseline (s'il y en a une) seulement comme
 *   indice — les actions connues passent après le nouveau terrain — et signale ce qui est nouveau.
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

  // Les autres acteurs ouvrent les écrans trouvés : qu'atteint chacun ?
  let authorization: AuthorizationReport | undefined;
  if (config.actors.length > 0 && config.authorization.enabled) {
    const targets = outcome.graph
      .allNodes()
      .map((node) => ({ stateId: node.id, label: node.label, url: node.url }));
    const observed = await new AuthorizationObserver(config, env).observe(targets);
    authorization = observed.report;
    outcome.issues.push(...observed.issues);
  }

  const result = buildResult(outcome, config);
  result.mode = mode;
  if (authorization) result.authorization = authorization;
  result.cleanup = await (options.cleanup ?? new ManualCleanup()).cleanup(outcome.createdData);
  if (config.flowGeneration.enabled) {
    const flows = generateFlows(
      {
        graph: outcome.graph,
        details: outcome.details,
        forms: outcome.forms,
        testData:
          options.testData ??
          new DefaultTestDataProvider({
            runId: outcome.runId,
            fields: config.testData.fields,
            defaults: config.testData.defaults,
          }),
      },
      { maxFlows: config.flowGeneration.maxFlows },
    );
    if (flows.length > 0) {
      await mkdir(config.output.reportsDir, { recursive: true });
      const file = path.join(config.output.reportsDir, 'generated-flows.yaml');
      await writeFile(
        file,
        flowsYaml(flows, { mission: config.mission.name, date: outcome.finishedAt.toISOString() }),
        'utf8',
      );
      result.artifacts.generatedFlows = file;
    }
  }
  if (config.logging.file) {
    await mkdir(config.output.reportsDir, { recursive: true });
    const file = path.join(config.output.reportsDir, 'engine-log.jsonl');
    await writeFile(file, engineLog.toJsonLines(), 'utf8');
    result.artifacts.engineLog = file;
  }
  if (baseline) {
    // verify ne rejoue qu'une partie des transitions (pas les formulaires remplis, les échecs connus, les bloquées) :
    // il n'est comparé qu'avec cette partie de la baseline.
    const verification = mode === 'verify' ? outcome.verification : undefined;
    const reference = verification ? replayedPart(baseline.graph, verification) : baseline.graph;
    // …et avec les états atteints par ses transitions (pas les écrans seulement vus en chemin).
    const diff = new FlowDiffEngine().compare(reference, verification ? reachedPart(current) : current);
    // explore suit d'abord le nouveau terrain : ce qu'il n'a pas revisité n'a pas disparu. Seulement ce qui est nouveau ou modifié.
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

/** Les transitions de la baseline que verify a rejouées, et les états qu'elles relient. */
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

/** États qui sont le début ou la fin d'une transition, et la racine. */
function reachedPart(graph: FlowGraphData): FlowGraphData {
  const states = new Set([
    ...(graph.rootId ? [graph.rootId] : []),
    // Les actions bloquées sont enregistrées sur des écrans seulement vus en chemin : elles n'atteignent rien.
    ...graph.edges.filter((edge) => edge.result !== 'BLOCKED').flatMap((edge) => [edge.from, edge.to]),
  ]);
  return { ...graph, nodes: graph.nodes.filter((node) => states.has(node.id)) };
}

/** Le contrat d'API (OpenAPI) : un fichier local, ou une URL sur un hôte autorisé seulement. */
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

/** `stateId::actionId` de chaque transition exécutée par la baseline. */
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
