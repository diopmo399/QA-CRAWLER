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
import {
  FlowExplorer,
  type ExplorationListener,
  type FlowExplorerOptions,
} from './explorer/flow-explorer.js';
import type { FlowMemory } from './memory/flow-memory.js';
import { JsonFlowMemory } from './memory/json-flow-memory.js';
import type { ExplorationResult } from './model/exploration-result.js';
import type { FlowGraphData } from './model/flow.js';
import type { VerificationReport } from './model/verification.js';
import { isAtLeast, type Issue } from './model/issue.js';
import { buildResult } from './reporting/result-builder.js';
import { writeReports } from './reporting/reporter.js';
import { redactText, redactUrl } from './security/redactor.js';
import { ManualCleanup, type TestDataCleanup } from './data/created-data.js';
import { combineListeners, EngineEventLog } from './logging/engine-log.js';
import { flowsYaml, generateFlows } from './flows/flow-generator.js';
import { DefaultTestDataProvider } from './data/test-data-provider.js';
import { AuthorizationObserver, type AuthorizationReport } from './actors/authorization-observer.js';
import { JsonKnowledgeBase, knowledgeFileOf, knowledgeIdentityOf } from './knowledge/json-knowledge-base.js';
import { InvariantOracle } from './oracles/invariant-oracle.js';
import { loadSemantics } from './semantics/domain-packs.js';
import { IssueCollector } from './anomaly/issue-collector.js';
import { randomUUID } from 'node:crypto';
import { KnowledgeService } from './persistence/knowledge-service.js';
import { openPersistence, type PersistenceSession } from './persistence/persistence-manager.js';
import { PersistenceRecorder } from './persistence/persistence-recorder.js';
import type { PersistenceProvider } from './persistence/persistence-provider.js';
import type { MemoryReport, PersistenceReport } from './model/persistence-report.js';
import {
  applicationIdOf,
  confidenceEngineOf,
  flakinessOf,
  knowledgeContextOf,
} from './intelligence/intelligence.js';
import { FLAKINESS_CLASSES, type FlakinessClass } from './intelligence/flakiness.js';
import { summarizeKnowledge } from './intelligence/knowledge-summary.js';
import { runRegression, type RegressionInput, type RegressionReport } from './regression/regression-store.js';
import { isSemanticSignature, learnFrom } from './semantics/resolution/semantic-knowledge.js';

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
  /** Observation de l'écran (point d'extension ; par défaut l'UIObserver). */
  observer?: FlowExplorerOptions['observer'];
  memory?: FlowMemory;
  env?: NodeJS.ProcessEnv;
  /** learn / verify / explore ; par défaut : mission.mode. */
  mode?: MissionMode;
  /** Où se trouve la baseline ; par défaut : baseline.dir. */
  baselineDir?: string;
  /** Supprime ce que le run a créé ; par défaut : ne supprime rien et le liste. */
  cleanup?: TestDataCleanup;
  /** Avertissements d'exécution (repli de la persistance…) ; par défaut : stderr. */
  onWarning?: (message: string) => void;
  /** DRY RUN : le navigateur (connecté, sur la page de départ) est confié au Dry Run (dry-run-orchestrator). */
  dryRun?: FlowExplorerOptions['dryRun'];
  /** Fournisseur d'intelligence injecté par programme (remplace ai.provider ; sans effet en OFF). */
  intelligenceProvider?: FlowExplorerOptions['intelligenceProvider'];
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
  // Vocabulaire et packs de domaine ; ce que le crawler a appris des runs précédents.
  const semantics = await loadSemantics(config);
  // PERSISTANCE (où enregistrer) et MÉMOIRE (l'historique influence-t-il ce run ?) : indépendantes.
  const persistence = await openPersistence(config.persistence, env, {
    warn: options.onWarning ?? ((message) => process.stderr.write(`WARNING: ${message}\n`)),
  });
  const identity = knowledgeIdentityOf(
    config.knowledge,
    config.target.baseUrl,
    env,
    (await crawlerVersion()).crawlerVersion,
  );
  const memoryMode = memoryModeOf(config, persistence);
  // Mode historique (legacy) : la base de connaissances fichier, exactement comme avant. Sinon, la
  // mémoire de travail ne lit ni n'écrit le fichier : seulement le run courant, plus l'historique préchargé.
  const knowledgeFile =
    memoryMode === 'legacy' && config.knowledge.enabled ? knowledgeFileOf(config) : undefined;
  const knowledge = new JsonKnowledgeBase(knowledgeFile, identity, {
    halfLifeDays: config.knowledge.halfLifeDays,
    minObservations: config.knowledge.minObservations,
    dominance: config.knowledge.dominance,
  });
  await knowledge.load();
  knowledge.startRun();
  const applicationId = applicationIdOf(identity);
  // Contexte des observations (environnement, acteur, version, navigateur, écran) : stocké avec la
  // persistance ; dans la base de connaissances fichier seulement avec intelligence.enabled.
  const knowledgeContext = knowledgeContextOf(config, identity);
  const { applicationId: _application, ...observedContext } = knowledgeContext;
  if (config.intelligence.enabled) knowledge.setObservationContext(observedContext);
  const knowledgeService = persistence.provider
    ? new KnowledgeService(persistence.provider.knowledge, applicationId, knowledge, observedContext)
    : undefined;
  if (knowledgeService && memoryMode === 'historical') {
    const loaded = await knowledgeService.preload(config.memory.preload);
    engineLog.log(
      'INFO',
      'KNOWLEDGE_LOADED',
      `${loaded.transitions} transition(s), ${loaded.states} state(s) preloaded`,
      {
        data: {
          transitions: loaded.transitions,
          states: loaded.states,
          maxTransitions: config.memory.preload.maxTransitions,
        },
      },
    );
  }
  const recorder =
    persistence.provider &&
    new PersistenceRecorder(
      persistence.provider,
      {
        id: randomUUID(),
        applicationId,
        missionName: config.mission.name,
        ...(identity.environment ? { environment: identity.environment } : {}),
        ...(identity.branch ? { branch: identity.branch } : {}),
        ...(identity.commit ? { commitSha: identity.commit } : {}),
        ...(identity.crawlerVersion ? { crawlerVersion: identity.crawlerVersion } : {}),
        mode,
        startedAt: new Date().toISOString(),
        status: 'RUNNING',
        statesCount: 0,
        actionsCount: 0,
        transitionsCount: 0,
        anomaliesCount: 0,
      },
      knowledgeService,
      { flushEvery: config.persistence.flushEvery },
    );
  await recorder?.start();
  const explorer = new FlowExplorer(config, {
    semantics,
    knowledge,
    memory,
    ...(options.decisionEngine ? { decisionEngine: options.decisionEngine } : {}),
    ...(options.testData ? { testData: options.testData } : {}),
    ...(options.observer ? { observer: options.observer } : {}),
    ...(options.dryRun ? { dryRun: options.dryRun } : {}),
    ...(options.intelligenceProvider ? { intelligenceProvider: options.intelligenceProvider } : {}),
    listener: combineListeners(
      options.listener,
      engineLog.listener(),
      recorder?.listener(),
      // Les résolutions sémantiques enrichissent la mémoire de travail (et, par elle, le fichier de connaissance).
      config.gherkin.semanticResolution.enabled
        ? {
            onSemanticResolution: (event) => {
              learnFrom(knowledge, event);
            },
          }
        : undefined,
    ),
    ...(options.env ? { env: options.env } : {}),
    ...(mode === 'explore' && baseline ? { knownActions: knownActionsOf(baseline) } : {}),
    historyAvailable: memoryMode === 'historical' || (memoryMode === 'legacy' && knowledgeFile !== undefined),
    ...(baseline ? { baseline: baseline.graph } : {}),
    ...(contract ? { contract } : {}),
    ...(mode === 'verify' && baseline
      ? {
          verifyBaseline: baseline.graph,
          ...(baseline.metadata ? { baselineRunId: baseline.metadata.runId } : {}),
        }
      : {}),
  });
  let outcome: Awaited<ReturnType<FlowExplorer['explore']>>;
  try {
    outcome = await explorer.explore();
  } catch (error) {
    await recorder?.finish('FAILED');
    await persistence.provider?.close().catch(() => undefined);
    throw error;
  }
  // RUN_FINISHED : ce qui attend est écrit, le run est clos, la connexion fermée.
  recorder?.recordBlockedEdges(outcome.graph.toJSON().edges);
  await recorder?.finish('COMPLETED');
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
  // Invariants d'accès (« l'acteur user n'accède pas à /admin/** ») : jugés sur ce que chaque acteur a vu.
  const accessRules = [...semantics.invariants, ...config.invariants].filter(
    (rule) => rule.when.actor && rule.expect.access,
  );
  if (accessRules.length > 0) {
    const judged = new InvariantOracle(accessRules, config.authorization.primaryActor).evaluateAccess(
      authorization,
    );
    outcome.invariants.push(...judged);
    const collector = new IssueCollector();
    for (const failed of judged.filter((entry) => entry.status === 'FAIL'))
      outcome.issues.push({
        ...collector.add({
          type: 'INVARIANT',
          severity: failed.severity,
          message: `invariant ${failed.invariantId} (${failed.actor ?? ''}): expected ${failed.expected}, observed ${failed.observed}`,
          pageUrl: failed.url ?? '',
          ...(failed.stateId ? { stateId: failed.stateId } : {}),
        }),
        // Un préfixe propre : pas de collision avec les id de l'explorateur (ISSUE-0001…).
        id: `ISSUE-INV-${String(collector.all().length).padStart(4, '0')}`,
      });
  }

  // RÉGRESSION : l'évolution des flows et le cycle de vie des anomalies, d'un run à l'autre
  // (persistance active, mémoire non coupée). Une erreur de stockage n'arrête jamais le run.
  const regression = await regressionOf(config, persistence.provider, memoryMode, {
    applicationId,
    graph: current,
    flows: outcome.flows,
    issues: outcome.issues,
    run: {
      at: outcome.finishedAt.toISOString(),
      run: recorder?.run.id ?? outcome.runId,
      version: identity.commit ?? identity.appVersion ?? 'unversioned',
      complete: outcome.stopReason === 'exhausted',
      ...(identity.environment ? { environment: identity.environment } : {}),
      actor: config.authorization.primaryActor,
    },
    log: engineLog,
  });
  await persistence.provider?.close().catch(() => undefined);

  if (knowledgeFile) await knowledge.save();

  const result = buildResult(outcome, config);
  if (regression) {
    result.regression = regression;
    for (const issue of result.issues) {
      const lifecycle = regression.anomalies?.byIssue[issue.id];
      if (lifecycle) issue.lifecycle = lifecycle;
    }
  }
  if (result.intelligence) {
    result.intelligence.domainPacks = semantics.packs;
    result.intelligence.knowledge = {
      identity: knowledge.identity,
      runs: knowledge.snapshot.runs,
      ...(knowledgeFile ? { file: knowledgeFile } : {}),
    };
  }
  if (knowledgeFile) result.artifacts.knowledge = knowledgeFile;
  const confidence = confidenceEngineOf(config);
  if (confidence && result.intelligence) {
    const summary = summarizeKnowledge(
      Object.values(knowledge.snapshot.transitions).filter(
        (entry) => !isSemanticSignature(entry.actionSignature),
      ),
      confidence,
      knowledgeContext,
    );
    const flaky = flakinessOf(config);
    if (flaky) {
      const transitions = Object.values(knowledge.snapshot.transitions).filter(
        (entry) => !isSemanticSignature(entry.actionSignature),
      );
      summary.flakiness = Object.fromEntries(FLAKINESS_CLASSES.map((kind) => [kind, 0])) as Record<
        FlakinessClass,
        number
      >;
      for (const entry of transitions) summary.flakiness[flaky(entry).class] += 1;
    }
    result.intelligence.historicalKnowledge = summary;
    engineLog.log('INFO', 'CONFIDENCE_EVALUATED', `${summary.transitions} transition(s) evaluated`, {
      data: { ...summary.levels, transitions: summary.transitions },
    });
    if (summary.aged > 0)
      engineLog.log(
        'INFO',
        'KNOWLEDGE_AGED',
        `${summary.aged} transition(s) weigh less than half (older knowledge)`,
        {
          data: { aged: summary.aged },
        },
      );
  }
  result.persistence = persistenceReportOf(
    config,
    persistence,
    memoryMode,
    knowledgeService,
    recorder,
    applicationId,
  );
  if (config.logging.decisionTrace && outcome.decisionTraces) {
    await mkdir(config.output.reportsDir, { recursive: true });
    const file = path.join(config.output.reportsDir, 'decision-trace.json');
    await writeFile(file, `${JSON.stringify(outcome.decisionTraces, null, 2)}\n`, 'utf8');
    result.artifacts.decisionTrace = file;
  }
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
            language: config.report.language,
            preserveExistingValues: config.forms.preserveExistingValues,
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

/**
 * La mémoire de ce run :
 * - memory.enabled absent : le comportement d'avant (base de connaissances fichier `knowledge`) ;
 * - false : isolé ; true : historique préchargé si la persistance est active, sinon run courant seulement.
 */
function memoryModeOf(config: ScenarioConfig, persistence: PersistenceSession): MemoryReport['mode'] {
  if (config.memory.enabled === undefined) return 'legacy';
  if (!config.memory.enabled) return 'isolated';
  return persistence.provider && config.memory.historicalKnowledge ? 'historical' : 'current-run';
}

function persistenceReportOf(
  config: ScenarioConfig,
  session: PersistenceSession,
  mode: MemoryReport['mode'],
  knowledge: KnowledgeService | undefined,
  recorder: PersistenceRecorder | undefined,
  applicationId: string,
): PersistenceReport {
  const stats = knowledge?.statistics;
  const { status } = session;
  return {
    enabled: status.enabled,
    status: status.status,
    ...(status.configured ? { configured: status.configured } : {}),
    ...(status.actual ? { actual: status.actual } : {}),
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.latencyMs !== undefined ? { latencyMs: status.latencyMs } : {}),
    ...(status.schemaVersion !== undefined ? { schemaVersion: status.schemaVersion } : {}),
    ...(recorder ? { runId: recorder.run.id, applicationId } : {}),
    writeErrors: [...status.writeErrors, ...(recorder?.errors ?? [])],
    memory: {
      mode,
      enabled: config.memory.enabled ?? config.knowledge.enabled,
      historicalKnowledge: mode === 'historical' || (mode === 'legacy' && config.knowledge.enabled),
      historicalStatesLoaded: stats?.historicalStatesLoaded ?? 0,
      historicalTransitionsLoaded: stats?.historicalTransitionsLoaded ?? 0,
      newStatesLearned: stats?.newStatesLearned ?? 0,
      newTransitionsLearned: stats?.newTransitionsLearned ?? 0,
    },
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

/**
 * Évolution des flows et cycle de vie des anomalies. Rien quand ils sont désactivés ; une
 * raison claire quand ils ne peuvent pas s'appliquer (pas de persistance, mémoire coupée).
 */
async function regressionOf(
  config: ScenarioConfig,
  provider: PersistenceProvider | undefined,
  memoryMode: MemoryReport['mode'],
  input: Omit<RegressionInput, 'provider' | 'config'> & { log: EngineEventLog },
): Promise<RegressionReport | undefined> {
  const { flowEvolution, anomalyLifecycle } = config.regression;
  if (!flowEvolution.enabled && !anomalyLifecycle.enabled) return undefined;
  if (!provider) return { skipped: 'regression needs persistence.enabled: true (an available provider)' };
  if (memoryMode === 'isolated') return { skipped: 'memory.enabled is false: no history is used' };
  const { log, ...rest } = input;
  try {
    const report = await runRegression({ ...rest, provider, config });
    for (const event of report.anomalies?.events ?? [])
      log.log(
        event.kind === 'ANOMALY_CREATED' ? 'INFO' : 'WARN',
        event.kind,
        `${event.anomalyId} ${event.type}: ${event.detail}`,
        {
          data: { anomalyId: event.anomalyId, type: event.type },
        },
      );
    if (report.evolution)
      log.log(
        'INFO',
        'FLOW_EVOLVED',
        `${report.evolution.changes.length} change(s) since the previous runs`,
        {
          data: {
            changes: report.evolution.changes.length,
            states: report.evolution.tracked.STATE,
            transitions: report.evolution.tracked.TRANSITION,
            disappeared: report.evolution.disappeared,
          },
        },
      );
    return report;
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    log.log('WARN', 'FLOW_EVOLVED', `regression history not updated: ${message}`);
    return { skipped: `history storage failed: ${redactText(message)}` };
  }
}
