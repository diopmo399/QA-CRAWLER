/**
 * @qa-crawler/core — l'API publique du cœur. Tout ce que la CLI utilise est accessible par
 * programme : la mission (configuration, chargeur), l'orchestrateur, l'enregistrement, le dry run,
 * les analyses de la plateforme, les interfaces d'extension (fournisseur d'intelligence, provider de
 * persistance, comparateur visuel, authentificateur, reporter de pull request) et la configuration
 * de projet. Les modules internes restent importables par leur chemin (`@qa-crawler/core/dist/...`)
 * mais seule cette surface est stable.
 */
export {
  runMission,
  RUN_PHASES,
  BaselineMissingError,
  type RunOptions,
  type RunOutcome,
} from './orchestrator.js';
export {
  loadConfigFile,
  parseConfig,
  ConfigError,
  type ConfigOverrides,
  type LoadedConfig,
} from './config/config-loader.js';
export type { ScenarioConfig, AuthConfig, ActorConfig, ActorProfile, MissionMode } from './config/config.js';
export type { FlowConfig, FlowStep, FlowTarget, FlowValue } from './config/flow-schema.js';
export type { ExplorationResult, StateReport, ExplorationStats } from './model/exploration-result.js';
export type { FlowRunReport, FlowStepReport } from './model/flow-run.js';
export type { Issue, IssueType, Severity } from './model/issue.js';

// Enregistrement humain, dry run, génération de flows.
export { runRecording, type RecordRequest, type RecordOutcome } from './recording/record-orchestrator.js';
export { generateFlows, flowsYaml } from './flows/flow-generator.js';

// Analyses.
export { buildRunAnalysis, type RunAnalysis, type RunVerdict } from './analysis/run-analysis.js';
export {
  buildRunWorkflowAnalysis,
  overallStatusOf,
  type RunWorkflowAnalysisReport,
  type RunExecutionModel,
} from './platform/run-workflow-analysis.js';
export { analyzeAnomalies } from './platform/anomaly-analyzer.js';
export { buildWorkflowGraph, type ObservedWorkflowGraph } from './platform/workflow-graph.js';
export { buildFunctionalCoverage, type FunctionalCoverageGraph } from './platform/functional-coverage.js';
export { correlateUiAndApi, type UiApiCorrelation } from './platform/ui-api-correlation.js';
export {
  buildApiTestModel,
  runApiTests,
  judgeApiResponse,
  buildApiAnalysis,
  type ApiAnalysis,
  type ApiRequester,
} from './platform/api-testing.js';
export { analyzeVisual, type VisualAnalysis } from './platform/visual-analysis.js';
export { analyzePerformance, type PerformanceAnalysis } from './platform/performance-analysis.js';
export { analyzeRegression, type RegressionAnalysis } from './platform/regression-analysis.js';
export {
  planReproductions,
  minimalPath,
  assessReproduction,
  type ReproductionAnalysis,
} from './platform/reproduction-planner.js';
export {
  generatePlaywrightTests,
  generatePlaywrightTest,
  type GeneratedTest,
} from './platform/playwright-test-generator.js';
export { analyzeActors, type ActorAnalysis } from './platform/actor-analysis.js';
export {
  runExplorationJobs,
  jobsPerActor,
  type ExplorationJob,
  type ParallelRunReport,
} from './platform/exploration-jobs.js';
export { renderQaJobManifest, type QaJobManifestOptions } from './platform/kubernetes-manifest.js';
export {
  renderPullRequestComment,
  GitHubPullRequestReporter,
  type PullRequestReporter,
  type PullRequestPublication,
} from './platform/pull-request-reporter.js';
export { adviseOnAmbiguities } from './platform/ambiguity-advisor.js';
export type {
  OverallStatus,
  RunAnomaly,
  AnomalyCategory,
  RegressionStatus,
  Finding,
  Provenance,
} from './platform/model.js';

// Interfaces d'extension (adapters / providers).
export type { IntelligenceProvider } from './ai/provider.js';
export type { IntelligenceRequest, ProviderResult, ProviderCallOptions } from './ai/model.js';
export type { PersistenceProvider, FlowMemoryRepository } from './persistence/persistence-provider.js';
export type { VisualComparator, VisualComparison } from './visual/visual-comparator.js';
export { PixelVisualComparator } from './visual/pixel-visual-comparator.js';
export { NoVisualComparator } from './visual/visual-comparator.js';
export type { Authenticator } from './auth/authenticator.js';
export { createAuthenticator } from './auth/authenticator.js';
export { AuthenticationSessionProvider, type SessionReport } from './auth/session-provider.js';
export type { DecisionEngine, ActionDecision } from './decision/decision-engine.js';
export type { TestDataProvider } from './data/test-data-provider.js';

// Configuration de projet (package installé).
export {
  findProjectConfigFile,
  loadProjectConfig,
  loadProjectMission,
  projectMission,
  discoverFlows,
  projectConfigSchema,
  type ProjectConfig,
  type ProjectConfigFile,
} from './project/project-config.js';
export { detectProject, type ProjectDetection } from './project/detect.js';
export { initProject, renderProjectConfig, type InitOptions, type InitOutcome } from './project/init.js';
export {
  readPlaywrightConfig,
  parsePlaywrightConfigText,
  type PlaywrightSettings,
} from './project/playwright-config.js';

// La CLI, par programme.
export { runCli, EXIT, type CliOptions } from './cli/cli.js';

// Functional intent : element + contexte + action + état → intention fonctionnelle (3 niveaux, preuves, candidats).
export {
  PHYSICAL_ACTIONS,
  UI_INTENTS,
  FUNCTIONAL_OPERATIONS,
  DEFAULT_INTENT_THRESHOLDS,
  functionalName,
  generalize,
  genericOf,
  annotationOf,
  type FunctionalIntent,
  type IntentCandidate,
  type IntentEvidence,
  type IntentEvidenceType,
  type IntentStatus,
  type IntentThresholds,
  type StepIntentAnnotation,
  type PhysicalAction,
  type UiIntent,
  type FunctionalOperation,
} from './intent/model.js';
export {
  collectIntentEvidence,
  historyKeyOf,
  type IntentEvidenceInput,
  type IntentHistoryHint,
} from './intent/evidence.js';
export { resolveFunctionalIntent, adoptCandidate } from './intent/resolver.js';
export {
  resolveRecordingIntents,
  annotateFlowSteps,
  type RecordingIntents,
  type RecordingIntentSummary,
} from './intent/resolve-recording.js';
export { arbitrateIntents, type ArbitratedIntents } from './intent/ai-arbiter.js';
// INTENT-DRIVEN REPLAY : machine à états, checkpoints, préconditions / dépendances, planificateur, confiance.
export {
  REPLAY_EVENTS,
  type ReplayEvent,
  type ReplayPosition,
  type FunctionalCheckpoint,
  type CheckpointResult,
  type StepPrecondition,
  type PreconditionCheck,
  type StepDependency,
  type PreconditionExplanation,
  type ReplayStepVerdict,
  type ReplayConfidence,
  type ReplayPlan,
  type ReplayStepReport,
  type FlowReplayReport,
  type ObservedFunctionalState,
} from './replay/model.js';
export { deriveCheckpoints, evaluateCheckpoint, checkpointsAfter } from './replay/checkpoints.js';
export { ReplayStateMachine } from './replay/state-machine.js';
export {
  deriveDependencies,
  derivePreconditions,
  checkPreconditions,
  explainUnmetPrecondition,
} from './replay/preconditions.js';
export { planReplayAction, type PlannerInput } from './replay/planner.js';
export { replayConfidence, type ConfidenceInput } from './replay/confidence.js';
export { resolutionKeyOf, historicalResolutions } from './replay/resolution-memory.js';
