import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProgressTracker, type ProgressSink } from './progress/progress.js';
import { readCoreVersion, toolIdentity } from './tool-identity.js';
import { EXPLORER_CLOSING_PHASES } from './explorer/flow-explorer.js';
import { effectiveMode } from './ai/factory.js';
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
import {
  defaultPlaywrightJavaVersion,
  generateJavaJUnitPlaywrightProject,
  writeJavaProject,
} from './platform/java-junit-playwright-generator.js';
import { JUnitReporter } from './reporting/junit-reporter.js';
import { writeReports } from './reporting/reporter.js';
import { buildRunAnalysis } from './analysis/run-analysis.js';
import {
  addAnomaly,
  attachExtension,
  buildRunWorkflowAnalysis,
  refreshOverallStatus,
} from './platform/run-workflow-analysis.js';
import { analyzePerformance, currentMetrics } from './platform/performance-analysis.js';
import { analyzeRegression } from './platform/regression-analysis.js';
import { analyzeVisual, type VisualAnalysis } from './platform/visual-analysis.js';
import { planReproductions, type ReproductionAnalysis } from './platform/reproduction-planner.js';
import { generatePlaywrightTests } from './platform/playwright-test-generator.js';
import { PixelVisualComparator } from './visual/pixel-visual-comparator.js';
import { rememberRun } from './platform/flow-memory.js';
import { adviseOnAmbiguities } from './platform/ambiguity-advisor.js';
import { GitHubPullRequestReporter, renderPullRequestComment } from './platform/pull-request-reporter.js';
import { createConfiguredProvider, secretValuesOf } from './ai/factory.js';
import { IntelligenceContextSanitizer } from './ai/sanitizer.js';
import type { IntelligenceProvider } from './ai/provider.js';
import { analyzeActors } from './platform/actor-analysis.js';
import { correlateUiAndApi } from './platform/ui-api-correlation.js';
import {
  buildApiAnalysis,
  buildApiTestModel,
  observedRequests,
  runApiTests,
  type ApiResponse,
  type ApiTestModel,
  type ApiTestResult,
} from './platform/api-testing.js';
import { redactText, redactUrl } from './security/redactor.js';
import { ManualCleanup, type TestDataCleanup } from './data/created-data.js';
import { combineListeners, EngineEventLog } from './logging/engine-log.js';
import {
  baselineOf,
  compareToBaseline,
  performanceReportOf,
  summaryText,
  type PerformanceBaseline,
} from './performance/performance-tracer.js';
import { flowsYaml, generateFlows } from './flows/flow-generator.js';
import { compareFlowRuns, flowRunMemoryOf } from './flows/flow-run-comparison.js';
import { DefaultTestDataProvider } from './data/test-data-provider.js';
import { AuthorizationObserver, type AuthorizationReport } from './actors/authorization-observer.js';
import { JsonKnowledgeBase, knowledgeFileOf, knowledgeIdentityOf } from './knowledge/json-knowledge-base.js';
import { buildQualityVerification, type QualityVerificationReport } from './quality/quality-verification.js';
import { COVERAGE_STATUSES, loadHistory, saveHistory, updateHistory } from './quality/traceability.js';
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
  /** La progression après le dernier flow (autres acteurs, régression, mémoire, rapports). */
  onProgress?: ProgressSink;
  /**
   * L'ANNULATION CONTRÔLÉE : une fois le signal levé, le moteur s'arrête à la prochaine vérification de
   * ses limites (stopReason `cancelled`), saute les flows restants, ferme le navigateur et écrit son rapport.
   */
  signal?: AbortSignal;
}

/** Les phases après le dernier flow, dans l'ordre. */
export const RUN_PHASES = {
  close: 'Closing the run',
  actors: 'Checking the other actors',
  history: 'Comparing with earlier runs',
  knowledge: 'Saving the knowledge',
  artifacts: 'Writing the artifacts',
  baseline: 'Saving the baseline',
  reports: 'Writing the reports',
} as const;

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
  const warn = options.onWarning ?? ((message: string) => process.stderr.write(`WARNING: ${message}\n`));
  const persistence = await openPersistence(config.persistence, env, { warn });
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
  const authorizationChecks = config.actors.length > 0 && config.authorization.enabled;
  // Dès la fin du dernier flow : navigateur, client d'intelligence, mémoire, puis rapports.
  const progress = new ProgressTracker(
    'Finishing the run',
    [
      ...Object.values(EXPLORER_CLOSING_PHASES).filter(
        (phase) => phase !== EXPLORER_CLOSING_PHASES.intelligence || effectiveMode(config.ai) !== 'OFF',
      ),
      ...Object.values(RUN_PHASES).filter(
        (phase) =>
          (phase !== RUN_PHASES.actors || authorizationChecks) &&
          (phase !== RUN_PHASES.baseline || mode === 'learn'),
      ),
    ],
    options.onProgress,
  );
  const explorer = new FlowExplorer(config, {
    progress,
    semantics,
    knowledge,
    memory,
    ...(options.decisionEngine ? { decisionEngine: options.decisionEngine } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.testData ? { testData: options.testData } : {}),
    ...(options.observer ? { observer: options.observer } : {}),
    ...(options.dryRun ? { dryRun: options.dryRun } : {}),
    ...(contract && config.apiTesting.enabled
      ? {
          afterFlows: async (page, flows) => {
            const model = buildApiTestModel(contract, observedRequests(flows), config.apiTesting);
            const results = await runApiTests(
              model,
              contract,
              async (method, requestPath): Promise<ApiResponse> => {
                const response = await page.request.fetch(
                  new URL(requestPath, config.target.baseUrl).toString(),
                  {
                    method,
                    timeout: config.apiTesting.timeoutMs,
                    failOnStatusCode: false,
                    maxRedirects: 0,
                  },
                );
                const contentType = response.headers()['content-type'];
                const body = contentType?.includes('json')
                  ? ((await response.json().catch(() => undefined)) as unknown)
                  : undefined;
                return {
                  status: response.status(),
                  ...(contentType ? { contentType } : {}),
                  ...(body !== undefined ? { body } : {}),
                };
              },
            );
            apiTests = { model, results };
          },
        }
      : {}),
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
  // QA PLATFORM — API TESTING : après les flows, dans la session connectée du run (méthodes sûres seulement).
  let apiTests: { model: ApiTestModel; results: ApiTestResult[] } | undefined;
  const exploreStartedAt = performance.now();
  try {
    outcome = await explorer.explore();
  } catch (error) {
    await recorder?.finish('FAILED');
    await persistence.provider?.close().catch(() => undefined);
    throw error;
  }
  progress.start(RUN_PHASES.close);
  // RUN_FINISHED : ce qui attend est écrit, le run est clos, la connexion fermée.
  recorder?.recordBlockedEdges(outcome.graph.toJSON().edges);
  await recorder?.finish('COMPLETED');
  const current = outcome.graph.toJSON();

  // Les autres acteurs ouvrent les écrans trouvés : qu'atteint chacun ?
  let authorization: AuthorizationReport | undefined;
  if (authorizationChecks) {
    progress.start(RUN_PHASES.actors, 'each actor opens the screens found');
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
  progress.start(RUN_PHASES.history);
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

  progress.start(RUN_PHASES.knowledge);
  // QA PLATFORM — ACTEURS : profils, différences classées, écart de comportement avec le run précédent.
  const actorAnalysis = authorization
    ? analyzeActors(authorization, knowledge.actorAccess(), outcome.runId, outcome.finishedAt.toISOString())
    : undefined;
  if (actorAnalysis && knowledgeFile) knowledge.rememberActorAccess(actorAnalysis.memory);
  // ÉCART AVEC LE RUN PRÉCÉDENT : le dernier run de chaque flow, gardé dans la base de connaissances.
  if (knowledgeFile)
    for (const flow of outcome.flows) {
      const previous = knowledge.flowRunMemory(flow.name);
      if (previous) flow.comparison = compareFlowRuns(previous, flow);
      knowledge.rememberFlowRun(flow.name, flowRunMemoryOf(flow, outcome.runId));
    }
  // QA PLATFORM — PERFORMANCE : les durées du run jugées contre leur historique, puis enregistrées.
  const performanceAnalysis = analyzePerformance(
    outcome.flows,
    { history: (metric) => knowledge.performanceHistory(metric) },
    config.platform.performance,
  );
  if (knowledgeFile)
    for (const metric of currentMetrics(outcome.flows))
      knowledge.recordPerformance(metric.metric, {
        runId: outcome.runId,
        at: outcome.startedAt.toISOString(),
        value: metric.value,
      });
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
  progress.start(RUN_PHASES.artifacts);
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
  if (config.performance.tracing.enabled) {
    const report = performanceReportOf(
      explorer.performanceTraces(),
      Math.round(performance.now() - exploreStartedAt),
      config.performance.tracing.slowActionThresholdMs,
    );
    for (const slow of report.slowActions)
      engineLog.log(
        'WARN',
        'SLOW_ACTION_DETECTED',
        `step ${String(slow.step)} ${slow.description}: ${String(slow.durationMs)} ms, ${slow.reason} — ${slow.evidence.join('; ')}`,
        {
          actionId: slow.actionId,
          data: { durationMs: slow.durationMs, phase: slow.phase, reason: slow.reason },
        },
      );
    if (report.summary.actions > 0) {
      engineLog.log('INFO', 'PERFORMANCE_SUMMARY', summaryText(report.summary).join(' | '));
      await mkdir(config.output.reportsDir, { recursive: true });
      const file = path.join(config.output.reportsDir, 'performance.json');
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      await writeFile(
        path.join(config.output.reportsDir, 'performance-summary.txt'),
        [...summaryText(report.summary), '', ...report.waterfalls.flatMap((lines) => [...lines, ''])].join(
          '\n',
        ),
        'utf8',
      );
      result.artifacts.performance = file;
      const baselineFile = config.performance.baseline.file;
      if (baselineFile) {
        const current = baselineOf(report.summary);
        const previous = await readFile(baselineFile, 'utf8')
          .then((text) => JSON.parse(text) as PerformanceBaseline)
          .catch(() => undefined);
        if (!previous) await writeFile(baselineFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        else
          for (const regression of compareToBaseline(
            current,
            previous,
            config.performance.baseline.tolerance,
          ))
            engineLog.log(
              'WARN',
              'PERFORMANCE_REGRESSION',
              `${regression.metric}: ${String(regression.current)} ms vs baseline ${String(regression.baseline)} ms (×${regression.ratio.toFixed(2)})`,
              {
                data: {
                  metric: regression.metric,
                  current: regression.current,
                  baseline: regression.baseline,
                },
              },
            );
      }
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
    progress.start(RUN_PHASES.baseline);
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

  progress.start(RUN_PHASES.reports);
  // RUN ANALYSIS : relie ce que les moteurs ont produit (flows, divergences, récupérations, hypothèses,
  // dérive, apprentissage, conseiller) et rend le verdict fonctionnel — jamais une décision recalculée.
  result.runAnalysis = buildRunAnalysis(result);
  result.tool = await toolIdentity();
  // QA PLATFORM : le rapport du run de workflow (statut global, anomalies catégorisées, graphe observé, couverture).
  const workflowAnalysis = buildRunWorkflowAnalysis(result);
  result.workflowAnalysis = workflowAnalysis;
  const apiAnalysis = buildApiAnalysis(
    correlateUiAndApi(result.flows, contract),
    contract && apiTests
      ? {
          contract,
          model: apiTests.model,
          results: apiTests.results,
          observed: observedRequests(result.flows),
        }
      : undefined,
  );
  attachExtension(workflowAnalysis, 'apiAnalysis', 'api-analysis.json', apiAnalysis, apiAnalysis.findings);
  if (actorAnalysis)
    attachExtension(
      workflowAnalysis,
      'actorAnalysis',
      'actor-analysis.json',
      actorAnalysis,
      actorAnalysis.findings,
    );
  // QA PLATFORM — RÉGRESSION, PERFORMANCE, VISUEL, REPRODUCTIONS, TESTS GÉNÉRÉS (chaque module est pur ; la composition est ici).
  const regressionAnalysis = analyzeRegression(result, workflowAnalysis.anomalies);
  attachExtension(
    workflowAnalysis,
    'regressionAnalysis',
    'regression-analysis.json',
    regressionAnalysis,
    regressionAnalysis.findings,
  );
  for (const metric of performanceAnalysis.metrics)
    if (metric.status === 'PERFORMANCE_REGRESSION')
      addAnomaly(workflowAnalysis, {
        category: 'PERFORMANCE_REGRESSION',
        severity: 'WARNING',
        symptom: `${metric.label}: ${String(metric.currentValue)} ms vs baseline ${String(metric.baselineValue ?? 0)} ms`,
        evidence: [
          `${String(metric.samples)} sample(s)`,
          `trend ${metric.trend}`,
          ...(metric.firstDetectedRun ? [`since run ${metric.firstDetectedRun}`] : []),
        ],
        confidence: metric.confidence,
        source: 'HISTORICAL',
        location: metric.metric.includes('#')
          ? {
              flow: metric.metric.slice(5, metric.metric.indexOf('#')),
              step: Number(metric.metric.slice(metric.metric.indexOf('#') + 1)),
            }
          : { flow: metric.metric.slice(5) },
        issueIds: [],
        regression: 'NEW_REGRESSION',
      });
  attachExtension(
    workflowAnalysis,
    'performanceAnalysis',
    'performance-analysis.json',
    performanceAnalysis,
    performanceAnalysis.findings,
  );
  let visualRegressions = 0;
  if (config.visual.enabled) {
    const visualDir = config.visual.baselineDir ?? store.directory;
    const visualAnalysis = await analyzeVisual(result, workflowAnalysis.anomalies, {
      comparator: new PixelVisualComparator({
        colorThreshold: config.visual.colorThreshold,
        masks: config.visual.masks,
        diffImage: (_baseline, current) => current.replace(/\.png$/, '-diff.png'),
      }),
      baselineDir: visualDir,
      minorChangeRatio: config.visual.minorChangeRatio,
      majorChangeRatio: config.visual.majorChangeRatio,
      updateBaseline: config.visual.updateBaseline,
    });
    for (const checkpoint of visualAnalysis.checkpoints)
      if (checkpoint.verdict === 'VISUAL_REGRESSION') {
        visualRegressions += 1;
        addAnomaly(workflowAnalysis, {
          category: 'VISUAL_REGRESSION',
          severity: 'WARNING',
          symptom: `${checkpoint.flow} step ${String(checkpoint.step)}: the screen changed where the step failed`,
          evidence: [
            `${String(Math.round((checkpoint.difference ?? 0) * 10_000) / 100)} % of the image changed`,
            ...(checkpoint.diffImage ? [`diff ${checkpoint.diffImage}`] : []),
            ...checkpoint.anomalies.map((id) => `anomaly ${id}`),
          ],
          confidence: 0.8,
          source: 'RUNTIME',
          location: { flow: checkpoint.flow, step: checkpoint.step },
          issueIds: [],
        });
      }
    attachExtension(
      workflowAnalysis,
      'visualAnalysis',
      'visual-analysis.json',
      visualAnalysis,
      visualAnalysis.findings,
    );
  }
  if (config.platform.reproductions.enabled) {
    const reproductions = planReproductions(workflowAnalysis.anomalies, config.flows, result.flows);
    attachExtension(
      workflowAnalysis,
      'reproductions',
      'reproductions.json',
      reproductions,
      reproductions.findings,
    );
  }
  // Les tests Playwright générés sont un produit DÉRIVÉ du run : une erreur de génération ou
  // d'écriture est un avertissement, jamais l'échec d'un run QA par ailleurs valide.
  if (config.platform.generatedTests.enabled && config.flows.length > 0) {
    try {
      const tests = generatePlaywrightTests(config.flows, result.flows, {
        baseUrl: config.target.baseUrl,
        ...(result.cognitive ? { checkpoints: result.cognitive.checkpoints } : {}),
      });
      const directory = path.join(config.output.reportsDir, 'generated-tests');
      await mkdir(directory, { recursive: true });
      for (const test of tests) await writeFile(path.join(directory, test.fileName), test.content, 'utf8');
      attachExtension(workflowAnalysis, 'generatedTests', 'generated-tests.json', {
        directory,
        tests: tests.map((test) => ({
          flow: test.flow,
          file: path.join(directory, test.fileName),
          steps: test.steps,
          assertions: test.assertions,
        })),
      });
    } catch (error) {
      warn(`Playwright tests not generated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Le projet JUnit 5 + Playwright Java (platform.generatedTests.java) : un adaptateur à part du
  // moteur, dérivé du run ; une erreur de génération est un avertissement.
  if (config.platform.generatedTests.java.enabled && config.flows.length > 0) {
    try {
      const javaOptions = config.platform.generatedTests.java;
      const project = generateJavaJUnitPlaywrightProject(config.flows, result.flows, {
        baseUrl: config.target.baseUrl,
        packageName: javaOptions.packageName,
        versions: { playwright: javaOptions.playwrightVersion ?? defaultPlaywrightJavaVersion() },
        ...(result.cognitive ? { checkpoints: result.cognitive.checkpoints } : {}),
      });
      const directory = path.join(config.output.reportsDir, 'generated-tests-java');
      await writeJavaProject(project, directory);
      attachExtension(workflowAnalysis, 'generatedJavaTests', 'generated-java-tests.json', {
        directory,
        packageName: project.packageName,
        versions: project.versions,
        tests: project.tests.map((test) => ({ ...test, file: path.join(directory, test.file) })),
      });
    } catch (error) {
      warn(`Java tests not generated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // VÉRIFICATION MÉTIER : verdict des assertions, cohérence des données, traçabilité des exigences.
  const quality = await verifyQuality(config, result, outcome.runId, contract, engineLog);
  if (quality)
    attachExtension(workflowAnalysis, 'qualityVerification', 'quality-verification.json', quality, [
      {
        conclusion: `business verdict ${quality.verdict}: ${String(quality.metrics.assertionsByStatus.PASS)}/${String(quality.metrics.assertionsDeclared)} assertion(s) passed, ${String(quality.metrics.requirementsVerified)}/${String(quality.metrics.requirementsTotal)} requirement(s) verified`,
        evidence: [
          ...quality.traceability.summary.criticalFailures.map(
            (id) => `critical requirement ${id} not verified`,
          ),
          ...quality.limits.slice(0, 1),
        ],
        confidence: 1,
        source: 'RUNTIME',
      },
    ]);
  refreshOverallStatus(workflowAnalysis, result, {
    visualRegressions,
    performanceRegressions: performanceAnalysis.summary.PERFORMANCE_REGRESSION,
    ...regressionAnalysis.signals,
  });
  // QA PLATFORM — CONSEILLER D'AMBIGUÏTÉ : le LLM consulté seulement pour ce qu'aucune règle n'explique ; un avis, jamais une décision.
  const advisorEnabled = config.platform.advisor.enabled && effectiveMode(config.ai) !== 'OFF';
  const advisorProvider: IntelligenceProvider | undefined = advisorEnabled
    ? (options.intelligenceProvider ??
      createConfiguredProvider(config.ai, {
        env,
        sanitize: (value) =>
          new IntelligenceContextSanitizer({ secretValues: secretValuesOf(env) }).sanitizeValue(value),
      }))
    : undefined;
  const advisor = await adviseOnAmbiguities(workflowAnalysis.anomalies, advisorProvider, {
    enabled: advisorEnabled,
    maxCalls: config.platform.advisor.maxCalls,
    minConfidence: config.platform.advisor.minConfidence,
    timeoutMs: config.platform.advisor.timeoutMs,
    secretValues: secretValuesOf(env),
  });
  if (advisorProvider && advisorProvider !== options.intelligenceProvider)
    await advisorProvider.close?.().catch(() => undefined);
  attachExtension(workflowAnalysis, 'advisor', 'advisor.json', advisor);
  // QA PLATFORM — FLOW MEMORY : ce que la plateforme retient du run, par sorte, dans la persistance.
  if (persistence.provider && config.platform.flowMemory.enabled) {
    const visualAnalysis = workflowAnalysis.extensionFiles?.visualAnalysis?.data as
      VisualAnalysis | undefined;
    const reproductions = workflowAnalysis.extensionFiles?.reproductions?.data as
      ReproductionAnalysis | undefined;
    const remembered = await rememberRun(persistence.provider.memory, {
      applicationId,
      result,
      report: workflowAnalysis,
      ...(actorAnalysis ? { actors: actorAnalysis } : {}),
      ...(reproductions ? { reproductions } : {}),
      ...(visualAnalysis ? { visual: visualAnalysis } : {}),
    }).catch((error: unknown) => {
      engineLog.log(
        'WARN',
        'FLOW_EVOLVED',
        `flow memory not updated: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    });
    workflowAnalysis.artifacts.flowMemory = `${String(remembered)} record(s) in ${persistence.provider.description}`;
  }
  await persistence.provider?.close().catch(() => undefined);
  const written = await writeReports(result, config.output, memory.location, config.report.language);
  // JUNIT XML (report.junit) : un fichier de plus pour la CI, écrit APRÈS les rapports QA-CRAWLER ;
  // une erreur d'écriture est un avertissement, sauf `required`, où elle fait échouer le run.
  if (config.report.junit.enabled) {
    try {
      written.artifacts.junit = await new JUnitReporter(config.output.reportsDir, config.report.junit.file, {
        failOnSeverity: config.report.failOnSeverity,
      }).write(written);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (config.report.junit.required)
        throw new Error(`JUnit report not written (report.junit.required): ${reason}`);
      warn(`JUnit report not written: ${reason}`);
    }
  }
  // QA PLATFORM — PULL REQUEST : le résultat structuré publié en commentaire (jeton par variable d'environnement, jamais journalisé).
  if (config.platform.pullRequest.enabled && written.workflowAnalysis) {
    const settings = config.platform.pullRequest;
    const [envOwner, envRepo] = (env.GITHUB_REPOSITORY ?? '').split('/');
    const owner = settings.owner ?? envOwner;
    const repo = settings.repo ?? envRepo;
    const number = settings.number ?? Number(env.QA_PR_NUMBER);
    const comment = renderPullRequestComment({
      result: written,
      report: written.workflowAnalysis,
      regression: regressionAnalysis,
      performance: performanceAnalysis,
      ...(actorAnalysis ? { actors: actorAnalysis } : {}),
      ...(settings.reportUrl ? { reportUrl: settings.reportUrl } : {}),
    });
    const publication =
      owner && repo && Number.isInteger(number) && number > 0
        ? await new GitHubPullRequestReporter({
            owner,
            repo,
            pullNumber: number,
            tokenEnv: settings.tokenEnv,
            env,
            ...(settings.apiBaseUrl ? { apiBaseUrl: settings.apiBaseUrl } : {}),
          }).publish(comment)
        : {
            posted: false,
            action: 'skipped' as const,
            reason:
              'platform.pullRequest needs owner, repo and number (or GITHUB_REPOSITORY and QA_PR_NUMBER)',
          };
    const file = path.join(config.output.reportsDir, 'pull-request-comment.md');
    await writeFile(file, `${comment}\n`, 'utf8');
    written.workflowAnalysis.artifacts.pullRequestComment = file;
    written.workflowAnalysis.artifacts.pullRequest = publication.posted
      ? (publication.url ?? 'posted')
      : `not posted: ${publication.reason ?? ''}`;
    if (!publication.posted)
      (options.onWarning ?? ((message: string) => process.stderr.write(`WARNING: ${message}\n`)))(
        `pull request comment not posted: ${publication.reason ?? ''}`,
      );
  }
  progress.done(`${String(written.flows.length)} flow(s), ${String(written.issues.length)} issue(s)`);
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
  const version = await readCoreVersion();
  return version === 'unknown' ? {} : { crawlerVersion: version };
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

/**
 * Le rapport de vérification métier (quality-verification.json), quand la mission déclare des exigences,
 * des règles ou des assertions. L'historique de la traçabilité (STALE_EVIDENCE) est facultatif ; une
 * erreur de lecture ou d'écriture ne fait jamais échouer le run.
 */
async function verifyQuality(
  config: ScenarioConfig,
  result: ExplorationResult,
  runId: string,
  contract: ApiContract | undefined,
  engineLog: EngineEventLog,
): Promise<QualityVerificationReport | undefined> {
  const declared = config.flows.map((flow) => ({
    name: flow.name,
    requirements: flow.requirements,
    assertions: flow.assertions,
    ...(/\.feature:\d*$/.test(flow.description ?? '') ? { gherkin: true } : {}),
  }));
  const operations = contract?.operations.filter((operation) => operation.requirements?.length);
  const anything =
    config.requirements.length > 0 ||
    config.businessRules.length > 0 ||
    (operations?.length ?? 0) > 0 ||
    result.flows.some((flow) => flow.quality) ||
    declared.some((flow) => flow.requirements.length > 0 || flow.assertions.length > 0);
  if (!anything) return undefined;
  const historyFile =
    config.quality.history === false
      ? undefined
      : path.resolve(path.dirname(knowledgeFileOf(config)), config.quality.history);
  const history = historyFile ? await loadHistory(historyFile) : undefined;
  const report = buildQualityVerification({
    runId,
    flows: result.flows,
    declared,
    requirements: config.requirements,
    rules: config.businessRules,
    ...(operations?.length ? { operations } : {}),
    ...(history ? { history } : {}),
    evidenceMaxAgeDays: config.quality.evidenceMaxAgeDays,
    now: new Date(),
  });
  if (historyFile)
    await saveHistory(historyFile, updateHistory(history, report.traceability)).catch((error: unknown) => {
      engineLog.log(
        'WARN',
        'REQUIREMENT_COVERAGE_COMPUTED',
        `traceability history not saved: ${String(error)}`,
      );
    });
  const summary = report.traceability.summary;
  engineLog.log(
    summary.criticalFailures.length > 0 ? 'WARN' : 'INFO',
    'REQUIREMENT_COVERAGE_COMPUTED',
    `business verdict ${report.verdict}; requirements ${COVERAGE_STATUSES.map((status) => `${status} ${String(summary.byStatus[status])}`).join(', ')}${summary.criticalFailures.length > 0 ? `; critical: ${summary.criticalFailures.join(', ')}` : ''}`,
  );
  return report;
}
