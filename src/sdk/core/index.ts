/**
 * @qa-crawler/core/sdk — le cœur du SDK embarquable : contrats, client HTTP + flux d'événements,
 * cycle de vie. Utilisable dans un navigateur (aucune dépendance Node).
 */
export * from './contracts.js';
export * from './lifecycle.js';
export * from './verdicts.js';
export * from './journey.js';
export * from './journey-loop.js';
export * from './wait.js';
export {
  createQaCrawler,
  isCompatible,
  readEventStream,
  QaCrawlerError,
  type ClientOptions,
  type IncidentExperimentInput,
  type IncidentExtensionRequest,
  type IncidentScopeValidation,
  type QaCrawlerClient,
  type RecordingStartInput,
  type SubscribeOptions,
  type Subscription,
} from './client.js';
/** Les incidents (Incident Reconstruction) : le contrat commun, en types seulement. */
export type {
  Diagnosis,
  EnvironmentCapabilities,
  ExecutionEnvironmentConfig,
  ExecutionTarget,
  Experiment,
  ExperimentKind,
  Hypothesis,
  HttpExchange,
  Incident,
  IncidentEvent,
  IncidentInput,
  IncidentSeverity,
  IncidentState,
  IncidentSummary,
  InvestigationGraph,
  InvestigationReport,
  InvestigationScope,
  RegressionTestProposal,
  RelationStatus,
  ReproductionRun,
  ScopeExtension,
  ScopeExtensionKind,
  ScopeDiscovery,
  DiscoveredApplication,
  DiscoveredModule,
  DiscoveryRelation,
  DiscoveryProblem,
  DiscoveryProblemCode,
  DiscoveryConfidence,
  KnownRepository,
  ScopeApplicationOrigin,
} from './incident-contracts.js';
/** La découverte des déclencheurs : le contrat commun, en types seulement. */
export type {
  IncidentBrief,
  TriggerBudget,
  TriggerCondition,
  TriggerDepth,
  TriggerInvestigationInput,
  TriggerRun,
  TriggerRunReport,
  TriggerState,
  TriggerTrial,
} from './incident-trigger-contracts.js';
