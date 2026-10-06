import { hostMatches } from '../config/config-loader.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import type { AiSummary } from '../ai/audit-trail.js';
import {
  IntelligenceContextBuilder,
  toolContextOf,
  type ContextSources,
  type DiscoveredCandidate,
} from '../ai/context-builder.js';
import { createIntelligenceGateway } from '../ai/factory.js';
import type { ProgressTracker } from '../progress/progress.js';
import type { AiEventRecord, IntelligenceGateway } from '../ai/gateway.js';
import type { ProposalValidation } from '../ai/proposal-validator.js';
import { intelligenceDecisionsArtifact } from '../ai/decision-report.js';
import type { IntelligenceProposal } from '../ai/model.js';
import type { IntelligenceProvider } from '../ai/provider.js';
import type { AdviceInput, AdvisedRecovery } from '../workflow-healing/workflow-healer.js';
import { IssueCollector } from '../anomaly/issue-collector.js';
import { SeverityRules } from '../anomaly/severity-rules.js';
import { AuthError, createAuthenticator, type Authenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { ScreenshotService } from '../browser/screenshot-service.js';
import type { ScenarioConfig } from '../config/config.js';
import {
  describeDropZone,
  describeExpectation,
  describeStep,
  describeTarget,
  type FlowConfig,
  type FlowExpectation,
  type FlowStep,
  type FlowTarget,
  type StepEffects,
  type TargetFingerprint,
} from '../config/flow-schema.js';
import { findByName, planAutoStep } from '../flows/gherkin/auto-step.js';
import { normalizeText } from '../policies/keywords.js';
import { DefaultTestDataProvider, type TestDataProvider } from '../data/test-data-provider.js';
import { TestDataRunContext, type ResolvedTestData } from '../data/test-data-run-context.js';
import {
  controlsOf,
  normalize as normalizeControl,
  healingCandidates,
  isFragileTarget,
  compatibleRoles,
  matchFingerprint,
  verifyFieldFill,
  observeEffects,
  readTarget,
  classifyValueLoss,
  restorableValueLoss,
  requestCompleted,
  routeMatches,
  type FieldProbe,
  verifyEffects,
  type EffectVerification,
  type ValueLossKind,
} from '../flows/action-effect-verifier.js';
import { fetchGitSources } from '../static-analysis/sources/git-source.js';
import {
  describePrepared,
  gitDirectoryOf,
  readPreparedKnowledge,
  staticAnalyzerOptionsOf,
} from '../static-analysis/sources/prepared-source.js';
import { suggestedFeature, suggestedFlowYaml } from '../dry-run/suggested-flow.js';
import type { RecoveryInput } from '../knowledge/knowledge-model.js';
import { buildRecoveredFlow, detectFlowDrift } from '../workflow-healing/flow-drift.js';
import type { RecoveryDriver } from '../workflow-healing/goal-recovery-engine.js';
import type {
  DivergenceSymptom,
  GoalPredicate,
  HealingEvent,
  HealingEventRecord,
  ScreenControl,
  StepRecoveryReport,
} from '../workflow-healing/model.js';
import type { SafetyJudgement } from '../workflow-healing/recovery-planner.js';
import { screenControlsOf } from '../workflow-healing/screen.js';
import { dependencyLinkEvidence, staticLinkEvidence } from '../workflow-healing/static-hints.js';
import { goalProgressOf, predicateText } from '../workflow-healing/workflow-context.js';
import { healWorkflow, type HealingPorts } from '../workflow-healing/workflow-healer.js';
import {
  CognitiveEngine,
  type CognitiveEventRecord,
  type CognitiveSummary,
} from '../cognitive/cognitive-engine.js';
import { DeterministicReasoningAdvisor, type ReasoningAdvisor } from '../cognitive/reasoning-advisor.js';
import type { QAReasoningDecision, ScreenAction } from '../cognitive/reasoning-engine.js';
import type { FailureUnderstanding } from '../cognitive/invariants-failures.js';

/** Le chemin d'une URL (route observée au rejeu). */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** Pourquoi une transition a atteint sa borne : l'écran ne s'est jamais stabilisé, ou il est stable sans l'effet attendu. */
function transitionTimeoutText(result: TransitionWaitResult, who: string): string {
  return result.stable
    ? `${who}: the expected transition never came — ${result.missing.join('; ') || 'nothing observed'}`
    : `${who}: the screen never settled — ${result.missing.join('; ')}`;
}

/** Le rapport de synchronisation d'une étape (exécution, transition, signaux, stabilité, préparation de la suite). */
function synchronizationReportOf(result: TransitionWaitResult): StepSynchronizationReport {
  return {
    execution: 'EXECUTED',
    transition: result.status,
    signals: result.evidence,
    missing: result.missing,
    stability: { stable: result.stable, durationMs: result.stabilityDurationMs },
    durationMs: result.durationMs,
    nextAction: result.nextAction,
  };
}

/** Le type HTML qui fait générer la bonne valeur à un générateur nommé (testData: { generator: email }). */
const GENERATOR_TYPES: Readonly<Record<string, string>> = {
  email: 'email',
  phone: 'tel',
  url: 'url',
  number: 'number',
  date: 'date',
  text: 'text',
  textarea: 'textarea',
};
import type { ActionDecision, DecisionEngine } from '../decision/decision-engine.js';
import { RuleBasedDecisionEngine } from '../decision/rule-based-decision-engine.js';
import { scoringWeights } from '../decision/scoring-weights.js';
import { ActionDiscovery } from '../discovery/action-discovery.js';
import {
  PlaywrightActionExecutor,
  type ActionExecutionResult,
} from '../execution/playwright-action-executor.js';
import { evaluateFlowAction, evaluateFlowUrl } from '../flows/flow-safety.js';
import { actionsInScope, isInScope, scopeOf, type ExplorationScope } from '../flows/flow-scope.js';
import { FlowStepExecutor, type DragOutcome, type FlowElementAction } from '../flows/flow-step-executor.js';
import { suggestTargets } from '../flows/target-suggester.js';
import { FormExerciser, formName, type FormRun } from '../forms/form-exerciser.js';
import { formReportOf, type FormReport } from '../forms/form-report.js';
import { FlowGraph, summaryOf } from '../graph/flow-graph.js';
import { BrowserEventDiscovery } from '../interactions/browser-event-discovery.js';
import { BrowserInteractionManager } from '../interactions/browser-interaction-manager.js';
import { EnvironmentCredentialProvider } from '../interactions/credential-provider.js';
import { DialogHandler } from '../interactions/handlers/dialog-handler.js';
import { DownloadHandler } from '../interactions/handlers/download-handler.js';
import { ExternalNavigationHandler } from '../interactions/handlers/external-navigation-handler.js';
import { FileChooserHandler } from '../interactions/handlers/file-chooser-handler.js';
import { HttpAuthHandler } from '../interactions/handlers/http-auth-handler.js';
import { PermissionHandler } from '../interactions/handlers/permission-handler.js';
import { PopupHandler } from '../interactions/handlers/popup-handler.js';
import type { BrowserInteractionResult, InteractionContext } from '../interactions/types.js';
import { InteractionPolicy } from '../policies/interaction-policy.js';
import { AllowedOriginPolicy } from '../policies/origin-policy.js';
import type { FlowMemory } from '../memory/flow-memory.js';
import { actionLabel, type DiscoveredAction, type FormSummary } from '../model/discovered-action.js';
import type { StopReason } from '../model/exploration-result.js';
import type { FlowEdge, FlowGraphData } from '../model/flow.js';
import {
  REGRESSION_STATUSES,
  VERIFICATION_STATUSES,
  type VerificationReport,
  type VerificationStatus,
  type VerifiedTransition,
} from '../model/verification.js';
import type {
  FlowRunReport,
  FlowStatus,
  CssResolutionReport,
  FlowStepReport,
  SemanticResolutionReport,
  StepEffectReport,
  StepSynchronizationReport,
} from '../model/flow-run.js';
import { isAtLeast, type Issue, type IssueType, type Severity } from '../model/issue.js';
import type { NetworkExchange } from '../model/network.js';
import type { PageContext } from '../model/page-context.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { StateDetector, stateSubtitle } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
import { waitForScreenReady } from '../observation/screen-ready.js';
import type { FunctionalStepContext, ReplayedStepView } from '../workflow-healing/first-divergence.js';
import {
  actionContextFingerprintOf,
  interactionTargetIdentityOf,
} from '../flows/interaction-target-identity.js';
import { analyzeWrongEffect, type WrongEffectAnalysis } from '../flows/wrong-effect-analyzer.js';
import {
  expectationOf,
  installTransitionProbe,
  UITransitionWaiter,
  type TransitionWaitResult,
} from '../observation/transition-waiter.js';
import { fieldLabel, formFieldsFor } from '../forms/form-fields.js';
import { StaticApplicationAnalyzer, type StaticAnalysisEvent } from '../static-analysis/static-analyzer.js';
import { StaticKnowledge, annotateStaticFields } from '../static-analysis/static-knowledge.js';
import { isScriptResponse, playwrightFetcher, runtimeScriptUrls } from '../static-analysis/bundle.js';
import {
  RepositorySourceProvider,
  RuntimeBundleSourceProvider,
} from '../static-analysis/sources/source-providers.js';
import { StaticSourceDiscovery } from '../static-analysis/sources/source-discovery.js';
import { newValueSalt, valueDigest } from '../forms/state/value-digest.js';
import { decideFieldAction } from '../forms/state/field-state.js';
import { fieldStateOfFormField } from '../forms/state/form-field-state.js';
import { fieldOf } from '../forms/form-analyzer.js';
import { CrawlerValueMemory, ResponseValueIndex } from '../forms/state/value-sources.js';
import { FormKnowledgeObserver } from '../forms/state/form-knowledge-observer.js';
import { FormRuleCoordinator, type FormRulesSummary } from '../rules/form-rule-coordinator.js';
import {
  FunctionalIntelligence,
  screenFactsOf,
  type FunctionalEvent,
  type FunctionalSummary,
} from '../functional/functional-intelligence.js';
import type { FunctionalActionObservation } from '../functional/model.js';
import { judgeGoalAction } from '../functional/goal-safety.js';
import { FunctionalKnowledgeStore } from '../knowledge/functional-knowledge-store.js';
import { SemanticFunctionalOracle } from '../oracles/semantic-functional-oracle.js';
import type { RuleEvent } from '../rules/runtime-rule-verifier.js';
import { RuleKnowledgeStore } from '../knowledge/rule-knowledge-store.js';
import type { StaticAnalysisOutcome } from '../static-analysis/static-analyzer.js';
import { StaticPathResolver } from '../static-analysis/static-path-resolver.js';
import { SemanticVocabulary } from '../semantics/resolution/vocabulary.js';
import type { FieldDescriptor } from '../semantics/resolution/field-descriptor.js';
import type { FieldProvenance, StaticAnalysisSummary } from '../static-analysis/model.js';
import {
  classifyPlaywrightError,
  NavigationGuard,
  NavigationRecoveryError,
  type NavigationEvent,
} from '../navigation/navigation-guard.js';
import { ConsoleObserver } from '../observers/console-observer.js';
import { NetworkObserver } from '../observers/network-observer.js';
import type { IssueAttribution, ObservationContext, PageObserver } from '../observers/observer.js';
import { NetworkTraceRecorder } from '../observers/network-trace-recorder.js';
import type { ApiContract } from '../oracles/api-contract.js';
import { BaselineOracle } from '../oracles/baseline-oracle.js';
import { CompositeTestOracle, type OracleVerdict } from '../oracles/composite-oracle.js';
import { ContractOracle } from '../oracles/contract-oracle.js';
import { TechnicalOracle } from '../oracles/technical-oracle.js';
import { DEFAULT_ERROR_TEXTS, UIOracle } from '../oracles/ui-oracle.js';
import { PageErrorObserver } from '../observers/page-error-observer.js';
import { SafetyPolicy, type SafetyVerdict } from '../policies/safety-policy.js';
import type { DryRunDriver } from '../dry-run/dry-run-driver.js';
import type { FlowIntent } from '../dry-run/flow-intent-graph.js';
import { findKnownPaths, type KnownEdge } from '../dry-run/known-paths.js';
import type { ObservedState } from '../dry-run/reconciliation-model.js';
import { redactText, redactUrl } from '../security/redactor.js';
import { CircuitBreaker } from '../recovery/circuit-breaker.js';
import { RecoveryEngine, type RecoveryActions } from '../recovery/recovery-engine.js';
import {
  aiTriggerOf,
  analyzeRerender,
  buildTemporalContext,
  candidateSelector,
  candidateSummary,
  clearCandidateMarks,
  decide,
  discoverCandidates,
  functionalIdentityOf,
  recordedLocatorCandidate,
  redactDeep,
  sameFilledValue,
  scoreCandidates,
  targetResolutionRequest,
  temporalLine,
  traceText,
  resolutionOutcomeOf,
  type ScoredCandidate,
  type TargetResolutionTrace,
  type TargetResolutionTrigger,
} from '../flows/functional-target.js';
import type { FailureKind, RecoveryEvent, RecoverySummary, StuckEvent } from '../recovery/recovery-model.js';
import { StuckDetector } from '../recovery/stuck-detector.js';
import { AccessibilityChecker } from '../accessibility/accessibility-checker.js';
import { CreatedDataRegistry, type CreatedDataRecord } from '../data/created-data.js';
import { routeKey } from '../crawler/route-normalizer.js';
import { RuleBasedActionScorer, optionKey } from '../decision/action-scorer.js';
import { AdvancedActionScorer } from '../decision/advanced-action-scorer.js';
import { CoverageTracker, type CoverageMap } from '../coverage/coverage-map.js';
import { DomOpenApiConstraintExtractor } from '../constraints/constraints.js';
import { OneFactorPropertyTestGenerator } from '../constraints/test-case-generators.js';
import { DecisionTraceRecorder, type DecisionTrace } from '../exploration/decision-trace.js';
import { BudgetTracker, budgetOf, type BudgetKind } from '../exploration/exploration-budget.js';
import { ExplorationFrontier, type ExplorationStrategy } from '../exploration/frontier.js';
import { GraphNoveltyDetector, type NoveltyScore } from '../exploration/novelty-detector.js';
import { BestFirstExplorationStrategy, DepthFirstExplorationStrategy } from '../exploration/strategies.js';
import { RuleBasedGoalMatcher } from '../goals/goal-matcher.js';
import type { GoalState } from '../goals/goal-model.js';
import { missionOf, RuleBasedGoalPlanner } from '../goals/goal-planner.js';
import { GoalTracker } from '../goals/goal-tracker.js';
import { firstFunctionalDivergence } from '../cognitive/functional-reasoning.js';
import { loadRecordingCandidates, recordingCandidatesFile } from '../recording/recording-intelligence.js';
import type { KnownRevealer, TargetProbe } from '../workflow-healing/expected-target.js';
import { isTechnicalTarget } from '../workflow-healing/workflow-context.js';
import { toLocator } from '../execution/locator-resolver.js';
import { JsonKnowledgeBase } from '../knowledge/json-knowledge-base.js';
import type { KnowledgeBase, TransitionKnowledge } from '../knowledge/knowledge-model.js';
import type { ConfidenceResult } from '../intelligence/confidence-engine.js';
import {
  adaptiveScorerOf,
  confidenceEngineOf,
  flakinessOf,
  knowledgeContextOf,
} from '../intelligence/intelligence.js';
import type { FlakinessResult } from '../intelligence/flakiness.js';
import { SemanticResolver, type SemanticResolution } from '../semantics/resolution/semantic-resolver.js';
import { describeIntent, type GherkinIntent } from '../semantics/resolution/intent.js';
import {
  AssertionResolver,
  IDENTITY_CONCEPTS,
  type ScenarioValue,
  classifyMessage,
  judgeTexts,
  type AssertionVerdict,
} from '../semantics/resolution/assertion-resolver.js';
import {
  KnowledgeSemanticHistory,
  type SemanticOutcome,
  type SemanticResolutionEvent,
} from '../semantics/resolution/semantic-knowledge.js';
import { DeterministicConfidenceEngine, type ConfidenceEngine } from '../intelligence/confidence-engine.js';
import { ValidDataFillStrategy } from '../forms/form-fill-strategy.js';
import { actionSignature, slug, stateSignature } from '../knowledge/signatures.js';
import { HistoricalOracle, apiOperation } from '../oracles/historical-oracle.js';
import { InvariantOracle, type InvariantEvaluation } from '../oracles/invariant-oracle.js';
import { RuleBasedPatternDetector } from '../patterns/pattern-detector.js';
import type { DetectedPattern } from '../patterns/ui-pattern.js';
import { WriteGuard, writePattern, type BlockedWrite } from '../policies/write-guard.js';
import { evaluateFastPath } from '../performance/fast-path.js';
import {
  instrumentMethods,
  PerformanceTracer,
  type ActionPerformanceTrace,
} from '../performance/performance-tracer.js';
import { semanticsOf, type Semantics } from '../semantics/domain-packs.js';
import { browserHttpCredentials, type BrowserHttpCredentials } from '../interactions/browser-credentials.js';

/** Part des contrôles en commun à partir de laquelle un écran retrouvé est le jumeau de l'écran attendu. */
const TWIN_SIMILARITY = 0.75;

/** L'empreinte d'un état sans la liste de ses contrôles : ce qui doit être identique chez un jumeau. */
function frameOf(signature: readonly string[]): string {
  return signature.filter((line) => !line.startsWith('controls=')).join('\n');
}

/** Notifications de progression (sortie de la CLI, tests). */
export interface ExplorationListener {
  onAuthenticated?(description: string): void;
  onState?(context: PageContext, isNew: boolean): void;
  onDecision?(context: PageContext, decision: ActionDecision): void;
  onBlocked?(context: PageContext, action: DiscoveredAction, reason: string): void;
  onTransition?(edge: FlowEdge, action: DiscoveredAction): void;
  /** Les oracles de test ont jugé une action exécutée. */
  onOracle?(edge: FlowEdge, verdict: OracleVerdict): void;
  onBacktrack?(from: string, to: string | undefined, method: string): void;
  /** Une stratégie de récupération a été essayée après un échec. */
  onRecovery?(event: RecoveryEvent): void;
  /** Une navigation a interrompu une lecture de la page : détectée, récupérée, ou non (événement technique, jamais une anomalie). */
  onNavigation?(event: NavigationEvent): void;
  /** L'exploration tournait en rond sur une branche et l'a quittée. */
  onStuck?(event: StuckEvent): void;
  onIssue?(issue: Issue, isNew: boolean): void;
  /** Un objectif de la mission est atteint (preuve observable). */
  onGoal?(goal: GoalState): void;
  onFlowStart?(flow: FlowConfig): void;
  onFlowStep?(flow: FlowConfig, step: FlowStepReport): void;
  onFlowEnd?(report: FlowRunReport): void;
  /** Une interaction du navigateur hors du DOM a été traitée (ou refusée). */
  onInteraction?(result: BrowserInteractionResult): void;
  /** Ligne de log structurée d'une interaction du navigateur (aucun secret). */
  onInteractionLog?(line: string): void;
  /**
   * Une phrase d'intention Gherkin a été résolue (ou non) puis exécutée :
   * SEMANTIC_RESOLUTION_SUCCEEDED / FAILED / AMBIGUOUS. Jamais une valeur saisie.
   */
  onSemanticResolution?(event: SemanticResolutionEvent): void;
  /** ANALYSE STATIQUE : cache, découvertes, preuves, chemins suggérés/confirmés. Jamais un secret. */
  onStaticAnalysis?(event: { at: string; event: StaticAnalysisEvent; message: string }): void;
  /** Règles de l'application, état des formulaires, dépendances (sans valeur saisie). */
  onRule?(event: { at: string; event: RuleEvent; message: string }): void;
  /** Intelligence fonctionnelle : états métier, invariants, effets, objectifs de test (sans valeur saisie). */
  onFunctional?(event: { at: string; event: FunctionalEvent; message: string }): void;
  /** TEST_DATA_GENERATED_FOR_RUN, TEST_DATA_STRATEGY_CANDIDATE (des clés, jamais des valeurs). */
  onTestData?(event: {
    at: string;
    event: 'TEST_DATA_GENERATED_FOR_RUN' | 'TEST_DATA_STRATEGY_CANDIDATE';
    message: string;
  }): void;
  /** WORKFLOW SELF-HEALING : divergence analysée, objectif, plan, récupération, dérive. */
  onHealing?(event: HealingEventRecord): void;
  /** QA COGNITIVE ENGINE : preuves, hypothèses, relations causales, état métier. */
  onCognitive?(event: CognitiveEventRecord): void;
  /** AI REASONING ADVISOR : déclencheurs, requêtes, propositions, validation, runtime. */
  onIntelligence?(event: AiEventRecord): void;
}

/** Ce que l'explorateur fait après le dernier flow, avant de rendre la main (annoncé : rien n'a l'air bloqué). */
export const EXPLORER_CLOSING_PHASES = {
  events: 'Waiting for open tabs and downloads',
  browser: 'Closing the browser',
  intelligence: 'Stopping the intelligence client',
  memory: 'Saving the memory',
} as const;

export interface FlowExplorerOptions {
  memory: FlowMemory;
  /** La progression de la fin du run (navigateur, client d'intelligence, mémoire…). */
  progress?: ProgressTracker;
  /**
   * Observation de l'écran (point d'extension : vision, captures, tests). Reçoit le garde de
   * navigation de l'explorateur, pour que ses lectures soient relues après une navigation.
   */
  observer?: (navigation: NavigationGuard) => UIObserver;
  decisionEngine?: DecisionEngine;
  testData?: TestDataProvider;
  listener?: ExplorationListener;
  env?: NodeJS.ProcessEnv;
  /** `stateId::actionId` connus par la baseline (mode explore) : essayés après le nouveau terrain. */
  knownActions?: ReadonlySet<string>;
  /**
   * Conseiller du raisonnement (QA Cognitive Engine). Par défaut : déterministe. Un conseiller LLM
   * ne s'injecte QUE par programme (aucune dépendance de fournisseur dans le cœur) ; ses
   * propositions sont validées, puis jugées par la SafetyPolicy, puis vérifiées au runtime.
   */
  reasoningAdvisor?: ReasoningAdvisor;
  /**
   * Fournisseur d'intelligence injecté par programme (tests, intégrations) : remplace
   * `ai.provider`. Sans effet en mode OFF (aucun fournisseur n'est alors créé).
   */
  intelligenceProvider?: IntelligenceProvider;
  /**
   * La mémoire de travail contient-elle l'historique d'anciens runs ? (base de connaissances
   * fichier, ou préchargement de la persistance). false : l'AdaptiveScoring n'a aucun effet.
   */
  historyAvailable?: boolean;
  /** Id du run (par défaut : testData.runId, sinon généré). */
  runId?: string;
  /** Transitions connues (la baseline), pour le BaselineOracle. */
  baseline?: FlowGraphData;
  /** Contrat d'API (OpenAPI), pour le ContractOracle et les champs de formulaire. */
  contract?: ApiContract;
  /** verify : les transitions connues de cette baseline sont rejouées au lieu d'explorer. */
  verifyBaseline?: FlowGraphData;
  /** Id du run de baseline vérifié (rapports). */
  baselineRunId?: string;
  /** Vocabulaire, packs de domaine, invariants des packs (par défaut : la mission seule). */
  semantics?: Semantics;
  /** Ce que le crawler a appris des runs précédents (par défaut : en mémoire, vide). */
  knowledge?: KnowledgeBase;
  /**
   * DRY RUN : au lieu des flows et de l'exploration autonome, confier le navigateur (connecté,
   * sur la page de départ) au Dry Run, à travers un DryRunDriver par flow.
   */
  dryRun?: (driverFor: (flow: FlowConfig) => DryRunDriver) => Promise<void>;
}

/** Ce que sait l'explorateur après un run ; les reporters en font des fichiers. */
export interface ExplorationOutcome {
  graph: FlowGraph;
  issues: Issue[];
  /** Dernière observation complète de chaque état (actions avec leurs localisateurs, formulaires). */
  details: Map<string, { actions: DiscoveredAction[]; forms: FormSummary[] }>;
  /** Flows imposés, dans l'ordre de la mission. */
  flows: FlowRunReport[];
  /** Interactions du navigateur hors du DOM, dans l'ordre. */
  interactions: BrowserInteractionResult[];
  stopReason: StopReason;
  startedAt: Date;
  finishedAt: Date;
  actionsExecuted: number;
  backtracks: number;
  decisionEngine: string;
  startUrl: string;
  /** Id du run, porté par les données qu'il a créées (QA-CRAWLER-<runId>). */
  runId: string;
  /** Formulaires trouvés et remplis. */
  forms: FormReport[];
  /** Analyse statique (seulement si activée). */
  staticAnalysis?: StaticAnalysisSummary;
  /** État des formulaires, dépendances entre champs, règles de l'application et leur couverture. */
  formRules?: FormRulesSummary;
  functional?: FunctionalSummary;
  cognitive?: CognitiveSummary;
  /** AI REASONING ADVISOR : mode, fournisseur, appels, propositions, runtime (absent en OFF). */
  ai?: AiSummary;
  /** Tentatives de récupération, branches abandonnées et circuits ouverts. */
  recovery: RecoverySummary;
  /** Actions qui modifient des données : exécutées, et le budget (safety.mutations). */
  mutations: { enabled: boolean; executed: number; maxPerRun?: number };
  /** Données que le run a probablement créées (à nettoyer), jamais les valeurs envoyées. */
  createdData: CreatedDataRecord[];
  /** Mode verify : chaque transition connue de la baseline, rejouée. */
  verification?: VerificationReport;
  /** Objectifs de la mission, avec leur statut et leurs preuves. */
  goals: GoalState[];
  /** Motifs d'interface reconnus, par état. */
  patterns: Record<string, DetectedPattern[]>;
  coverage: CoverageMap;
  /** Actions choisies, dans l'ordre, avec leur score expliqué. */
  decisions: ReturnType<DecisionTraceRecorder['selections']>;
  /** Toutes les décisions (logging.decisionTrace). */
  decisionTraces?: DecisionTrace[];
  strategy: string;
  /** Requêtes d'écriture annulées par la garde d'écriture. */
  blockedWrites: BlockedWrite[];
  /** Invariants jugés pendant le run. */
  invariants: InvariantEvaluation[];
  budget: Record<BudgetKind, { used: number; max: number }>;
}

interface StackEntry {
  stateId: string;
  url: string;
}

/**
 * Orchestre la boucle d'exploration. Chaque responsabilité appartient à un composant :
 *
 *   UIObserver + StateDetector   « Où suis-je ? »
 *   ActionDiscovery              « Que puis-je faire ? »
 *   DecisionEngine               « Que dois-je essayer ? »
 *   SafetyPolicy                 « Ai-je le droit ? »
 *   PlaywrightActionExecutor     « Exécute. »
 *   Observers                    « Qu'est-ce qui s'est mal passé ? »
 *   FlowGraph + FlowMemory       « Qu'ai-je appris ? »
 *
 * L'explorateur ne fait que les enchaîner, garder la pile de navigation, revenir
 * en arrière et faire respecter les limites de la mission.
 */
export class FlowExplorer {
  private readonly collector = new IssueCollector();
  private readonly safety: SafetyPolicy;
  /** Le seul endroit qui sait qu'une navigation n'est pas une erreur ; partagé par l'observation et l'exécution. */
  private readonly navigation: NavigationGuard;
  private readonly navigationEvents: NavigationEvent[] = [];
  private readonly observer: UIObserver;
  private readonly stateDetector: StateDetector;
  private readonly discovery: ActionDiscovery;
  private readonly decisionEngine: DecisionEngine;
  private readonly executor: PlaywrightActionExecutor;
  private readonly testData: TestDataProvider;
  /** Les données de test d'un run : chaque clé résolue une seule fois (TEST DATA RUN CONTEXT). */
  private readonly testDataRun: TestDataRunContext;
  /** Les clés RECORDED_LITERAL utilisées par le flow en cours (pour l'apprentissage sur un 409). */
  private readonly flowRecordedKeys = new Set<string>();
  /** L'étape en cours d'un flow (pour la précondition de l'étape suivante). */
  private stepPosition: { flow: FlowConfig; index: number } | undefined;
  /** Le rapport du flow en cours (l'étape précédente, pour le contexte de la divergence). */
  private currentFlowReport: FlowRunReport | undefined;
  /** Une récupération ne déclenche jamais une autre récupération (pas de boucle). */
  private healingDepth = 0;
  /** Récupération réussie, apprise quand l'étape suivante l'aura confirmée (ou infirmée). */
  private pendingLearning: { index: number; input: RecoveryInput; report: StepRecoveryReport } | undefined;
  /** Événements du self-healing, pour le journal du moteur et le rapport. */
  readonly healingEvents: HealingEventRecord[] = [];
  /** QA COGNITIVE ENGINE : la couche de connaissance (observe et apprend ; n'exécute rien). */
  readonly cognitive: CognitiveEngine | undefined;
  /** Début de l'action en cours (chronologie : requêtes, chargement, apparition des contrôles). */
  private actionClock = 0;
  /** QA REASONING : le signal de la décision raisonnée, par `stateId::actionId`. */
  private readonly cognitiveSignals = new Map<string, { points: number; reason: string; decision: string }>();
  private readonly reasonedStates = new Set<string>();
  private advisor: ReasoningAdvisor | undefined;
  /** AI REASONING ADVISOR (optionnel) : absent en mode OFF — aucun client, aucun appel. */
  readonly ai: IntelligenceGateway | undefined;
  private readonly aiContext: IntelligenceContextBuilder;
  /** REPLAY TRANSITION SYNCHRONIZATION : observe la transition d'une action, n'agit jamais. */
  private readonly transitionWaiter: UITransitionWaiter;
  /** La transition de l'étape précédente : une cible introuvable juste après un TIMEOUT n'est pas une divergence fonctionnelle. */
  private lastTransition: TransitionWaitResult | undefined;
  /** Les artefacts de débogage des résolutions de cible (un fichier par résolution, réécrit à la vérification). */
  private readonly resolutionFiles = new WeakMap<TargetResolutionTrace, string>();
  private resolutionCount = 0;
  /** Propositions retenues en attente de vérification au runtime, par `stateId::actionId`. */
  private readonly aiPending = new Map<
    string,
    { auditId: string; expected: string[]; progressBefore?: number }
  >();
  /** Hypothèses contredites déjà soumises à l'analyse (une fois chacune). */
  private readonly aiAnalyzedHypotheses = new Set<string>();
  /** Avancement de l'objectif au moment d'une récupération proposée par l'IA. */
  private readonly aiRecoveryProgress = new Map<string, number>();
  /** Décision IA → l'hypothèse qu'elle a proposée (jugée ensuite par le runtime). */
  private readonly aiHypothesisOf = new Map<string, string>();
  private readonly screenshots: ScreenshotService;
  private readonly authenticator: Authenticator;
  private readonly listener: ExplorationListener;
  private readonly memory: FlowMemory;
  private readonly startUrl: string;
  private readonly flowSteps: FlowStepExecutor;
  /** Interactions du navigateur hors du DOM (fenêtre de connexion native, dialogues JS, popups, téléchargements…). */
  private readonly interactions: BrowserInteractionManager;
  private readonly browserEvents: BrowserEventDiscovery;
  private readonly progress: ProgressTracker | undefined;
  private readonly credentials: EnvironmentCredentialProvider;
  /** Connexion HTTP confiée au navigateur (une origine, un profil) : aucune course avec les popups. */
  private readonly browserCredentials: BrowserHttpCredentials | undefined;
  /** Action en cours d'exécution, pour rattacher les interactions et détecter les boucles. */
  private currentAction: InteractionContext | undefined;
  private readonly env: NodeJS.ProcessEnv;

  private graph = new FlowGraph();
  private readonly details = new Map<string, { actions: DiscoveredAction[]; forms: FormSummary[] }>();
  private stack: StackEntry[] = [];
  /** États où le moteur n'a plus rien trouvé à faire. */
  private readonly exhausted = new Set<string>();
  /** États où l'explorateur n'a pas pu revenir. */
  private readonly unreachable = new Set<string>();
  private currentUrl: string;
  private attribution: IssueAttribution = {};
  /** Faux pendant l'exploration sous le dernier écran d'un flow (thenExplore). */
  private allowJump = true;
  private actionsExecuted = 0;
  private backtracks = 0;
  private startedAt = new Date();
  private readonly flowReports: FlowRunReport[] = [];
  /** Dernière observation brute (permet aux étapes de flow de trouver l'élément qu'elles visent). */
  private lastSnapshot: UiSnapshot | undefined;
  /** Le contexte fonctionnel avant / après chaque étape du flow en cours (FIRST FUNCTIONAL DIVERGENCE). */
  private stepContexts: ReplayedStepView[] = [];
  private readonly forms: FormExerciser;
  /** Fenêtre réseau de chaque action (FlowEdge.network). */
  private readonly networkTrace: NetworkTraceRecorder;
  /** Id de ce run, porté par les données qu'il crée (QA-CRAWLER-<runId>). */
  readonly runId: string;
  private readonly verifyBaseline: FlowGraphData | undefined;
  private readonly baselineRunId: string | undefined;
  private verification: VerificationReport | undefined;
  /** Juge chaque action exécutée (undefined quand oracles.enabled vaut false). */
  private readonly oracle: CompositeTestOracle | undefined;
  /** Formulaires déjà remplis, par état (`stateId|group`). */
  private readonly formsExercised = new Set<string>();
  /** Transitions qui ont rempli un formulaire : id → formulaire, pour le remplir à nouveau quand un chemin est rejoué. */
  private readonly formActions = new Map<string, string>();
  /** Chaque formulaire rempli, pour le rapport (jamais une valeur sensible). */
  private readonly formReports: FormReport[] = [];
  private readonly recovery: RecoveryEngine;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly stuck: StuckDetector | undefined;
  /** La dernière action a laissé la branche bloquée : la boucle la quitte. */
  private pendingStuck: StuckEvent | undefined;
  private readonly accessibility: AccessibilityChecker | undefined;
  private readonly createdData: CreatedDataRegistry;
  // ---- moteur de décision avancé
  private readonly semantics: Semantics;
  /** Résolution sémantique des phrases d'intention (gherkin.semanticResolution.enabled). */
  private readonly semanticResolver: SemanticResolver | undefined;
  /** Connaissance statique (code de l'application) : chargée une fois, à la demande ou au début. */
  private staticKnowledge: StaticKnowledge | undefined;
  private staticLoading: Promise<StaticKnowledge | undefined> | undefined;
  private staticCache: 'HIT' | 'MISS' | 'DISABLED' | undefined;
  private readonly staticWarnings: string[] = [];
  /** Découverte des sources (dépôt, source maps, bundles) et l'analyseur qui les lit, gardés pour l'enrichissement. */
  private staticDiscovery: StaticSourceDiscovery | undefined;
  private staticAnalyzer: StaticApplicationAnalyzer | undefined;
  private staticRuntime: RuntimeBundleSourceProvider | undefined;
  /** Scripts vus par le navigateur avant que la découverte existe. */
  private readonly observedScripts = new Set<string>();
  private readonly watchedContexts = new WeakSet();
  /** Sel des empreintes de valeurs de ce run (jamais écrit nulle part). */
  private readonly valueSalt = newValueSalt();
  /** État des formulaires, provenance des valeurs, règles de l'application et dépendances entre champs. */
  private readonly crawlerValues = new CrawlerValueMemory(this.valueSalt);
  private readonly responseValues = new ResponseValueIndex(this.valueSalt);
  private readonly formNetwork: FormKnowledgeObserver;
  private readonly coordinator: FormRuleCoordinator;
  /** Intelligence fonctionnelle (functionalIntelligence.enabled), sinon absente : rien ne change. */
  private readonly functional: FunctionalIntelligence | undefined;
  /** La valeur saisie par la dernière action exécutée (données de test du crawler). */
  private lastExecutedValue: string | undefined;
  /** Le scénario en cours : le formulaire rempli, les valeurs saisies (non sensibles) pour les vérifications. */
  private scenario: { formGroup?: string; values: ScenarioValue[] } = { values: [] };
  private semanticEngine: ConfidenceEngine | undefined;
  private readonly assertions: AssertionResolver;
  private readonly patternDetector: RuleBasedPatternDetector;
  private readonly patternsByState = new Map<string, DetectedPattern[]>();
  private readonly coverage = new CoverageTracker();
  private readonly novelty: GraphNoveltyDetector;
  private readonly noveltyByState = new Map<string, NoveltyScore>();
  private readonly knowledge: KnowledgeBase;
  private readonly goalMatcher: RuleBasedGoalMatcher;
  private goals: GoalTracker | undefined;
  /** Options de groupes déjà essayées pendant ce run (chaque option une fois au total). */
  private readonly triedOptions = new Set<string>();
  /** `stateId::actionId` déjà tentés sur l'écran qu'un jumeau remplace (voir `isTwinOf`). */
  private readonly triedOnTwin = new Set<string>();
  /** Le cadre de chaque état : son empreinte sans les contrôles (route, titres, fenêtres, onglets…). */
  private readonly frames = new Map<string, string>();
  /** Pénalités des actions prises dans une boucle (`stateId::actionId`). */
  private readonly loopPenalties = new Map<string, { points: number; detail: string }>();
  private readonly frontier = new ExplorationFrontier();
  private readonly strategy: ExplorationStrategy;
  private readonly traces = new DecisionTraceRecorder();
  private readonly budget: BudgetTracker;
  private readonly writeGuard: WriteGuard;
  private readonly invariantOracle: InvariantOracle | undefined;
  private readonly contract: ApiContract | undefined;
  /** Candidat pour lequel l'exploration vient de changer d'écran : il est exécuté en arrivant. */
  private pendingCandidate: { stateId: string; actionId: string } | undefined;
  /** Requêtes vues depuis le début du flow en cours (expect.response). */
  private flowNetwork: NetworkExchange[] = [];

  /** DRY RUN (options.dryRun) et mémoire des runs précédents disponible. */
  private readonly dryRunHook: FlowExplorerOptions['dryRun'];
  private readonly historyAvailable: boolean;
  private readonly perf: PerformanceTracer;
  /** Profondeur d'exécution d'étapes (> 1 : une étape rejouée à l'intérieur d'une récupération). */
  private stepDepth = 0;
  /** Statut de la dernière étape terminée (le chemin rapide suppose que tout allait bien avant). */
  private previousStepStatus: string | undefined;
  /** Les saisies confirmées sur l'écran courant : relues avant une étape qui écrit. */
  private filledOnScreen: { key: string; route: string; target: FlowTarget; value: string; label: string }[] =
    [];

  constructor(
    private readonly config: ScenarioConfig,
    options: FlowExplorerOptions,
  ) {
    const { exploration, goals } = config;
    this.progress = options.progress;
    this.dryRunHook = options.dryRun;
    this.historyAvailable = options.historyAvailable ?? false;
    this.safety = new SafetyPolicy(config.safety);
    this.stateDetector = new StateDetector(exploration.queryParams.mode, exploration.queryParams.ignored);
    this.discovery = new ActionDiscovery(this.safety, exploration.maxRecordedActions);
    this.semantics = options.semantics ?? semanticsOf(config);
    const semantic = config.gherkin.semanticResolution;
    this.semanticResolver = semantic.enabled
      ? new SemanticResolver(this.semantics.dictionary, {
          autoResolveThreshold: semantic.autoResolveThreshold,
          ambiguityMargin: semantic.ambiguityMargin,
          minCandidateScore: semantic.minCandidateScore,
          vocabulary: semantic.vocabulary,
        })
      : undefined;
    this.assertions = new AssertionResolver(this.semantics.dictionary);
    const { dictionary } = this.semantics;
    this.patternDetector = new RuleBasedPatternDetector(dictionary);
    this.novelty = new GraphNoveltyDetector(() => this.coverage.seenPatterns());
    this.knowledge =
      options.knowledge ??
      JsonKnowledgeBase.inMemory(
        { application: new URL(config.target.baseUrl).host },
        {
          halfLifeDays: config.knowledge.halfLifeDays,
          minObservations: config.knowledge.minObservations,
          dominance: config.knowledge.dominance,
        },
      );
    this.goalMatcher = new RuleBasedGoalMatcher(dictionary);
    this.strategy =
      exploration.strategy === 'depth-first'
        ? new DepthFirstExplorationStrategy()
        : new BestFirstExplorationStrategy();
    this.budget = new BudgetTracker(budgetOf(config));
    this.writeGuard = new WriteGuard({
      enabled: config.safety.writeGuard.enabled,
      allow: config.safety.writeGuard.allow,
      isGuardedHost: (host) => this.safety.navigation.isAllowedHost(host),
    });
    this.decisionEngine =
      options.decisionEngine ??
      new RuleBasedDecisionEngine(
        this.safety,
        {
          maxSimilarActions: config.exploration.maxSimilarActions,
          missionName: config.mission.name,
          keywords: goals.keywords,
          weights: scoringWeights(config.scoring.weights),
          ...(options.knownActions ? { knownActions: options.knownActions } : {}),
          triedOptions: this.triedOptions,
          triedOnTwin: this.triedOnTwin,
          goals,
          maxDepth: exploration.maxDepth,
          maxStatesPerRoute: exploration.maxStatesPerRoute,
          queryParamMode: exploration.queryParams.mode,
        },
        adaptiveScorerOf(
          config,
          new AdvancedActionScorer(new RuleBasedActionScorer(this.safety), {
            dictionary,
            weights: {
              goalWeight: exploration.goalWeight,
              patternWeight: exploration.patternWeight,
              noveltyWeight: exploration.noveltyWeight,
              coverageWeight: exploration.coverageWeight,
              historyWeight: exploration.historyWeight,
            },
            patternsOf: (stateId) => this.patternsByState.get(stateId) ?? [],
            patternHints: this.semantics.patternRules,
            currentGoals: () => this.goals,
            knowledge: this.knowledge,
            coverage: this.coverage,
            noveltyOf: (stateId) => this.noveltyByState.get(stateId),
            loopPenaltyOf: (stateId, actionId) => this.loopPenalties.get(`${stateId}::${actionId}`),
            version: this.knowledge.identity.commit ?? this.knowledge.identity.appVersion ?? 'unversioned',
            ...(config.rules.enabled && config.rules.influenceDecisionEngine
              ? {
                  ruleOpportunityOf: (action: DiscoveredAction, context: PageContext) =>
                    this.coordinator.opportunityOf(action, context),
                  rulesWeight: config.rules.decisionWeight,
                }
              : {}),
            ...(config.functionalIntelligence.enabled &&
            config.functionalIntelligence.testGoals.enabled &&
            config.functionalIntelligence.testGoals.influenceDecisionEngine
              ? {
                  functionalSignalOf: (action: DiscoveredAction) => {
                    const route = action.href ? pathnameOf(action.href) : undefined;
                    return this.functional?.signalFor({
                      label: actionLabel(action),
                      type: action.type,
                      ...(route ? { route } : {}),
                    });
                  },
                  functionalWeight: config.functionalIntelligence.testGoals.decisionWeight,
                }
              : {}),
            ...(config.cognitive.enabled &&
            config.cognitive.reasoning.enabled &&
            config.cognitive.reasoning.influenceDecisionEngine
              ? {
                  cognitiveSignalOf: (action: DiscoveredAction, context: PageContext) =>
                    this.cognitiveSignals.get(`${context.stateId}::${action.id}`),
                  cognitiveWeight: config.cognitive.reasoning.decisionWeight,
                }
              : {}),
          }),
          {
            knowledge: this.knowledge,
            coverage: this.coverage,
            historyAvailable: options.historyAvailable ?? false,
          },
        ),
      );
    this.navigation = new NavigationGuard({
      // Attente d'une nouvelle page utilisable, par tentative : jamais plus que le délai de navigation de la mission.
      readyTimeoutMs: Math.min(exploration.navigationTimeoutMs, 10_000),
      onEvent: (event) => {
        this.onNavigation(event);
      },
    });
    this.observer =
      options.observer?.(this.navigation) ?? new UIObserver(400, this.navigation, this.valueSalt);
    this.executor = new PlaywrightActionExecutor(
      exploration.actionTimeoutMs,
      exploration.settleTimeMs,
      this.navigation,
      exploration.readyTimeoutMs,
    );
    this.flowSteps = new FlowStepExecutor(exploration.settleTimeMs, exploration.readyTimeoutMs);
    const sync = config.replay.synchronization;
    this.transitionWaiter = new UITransitionWaiter({
      transitionTimeoutMs: sync.transitionTimeoutMs,
      stabilityWindowMs: sync.stabilityWindowMs,
      noTransitionCapMs: sync.noTransitionCapMs,
      graceMs: sync.graceMs,
      ...(sync.noProgressTimeoutMs !== undefined ? { noProgressTimeoutMs: sync.noProgressTimeoutMs } : {}),
      observeDomChanges: sync.observeDomChanges,
      observeRouteChanges: sync.observeRouteChanges,
      observeNetwork: sync.observeNetwork,
      observeDialogs: sync.observeDialogs,
      observeLoaders: sync.observeLoaders,
    });
    this.env = options.env ?? process.env;
    const origins = new AllowedOriginPolicy(
      new URL(config.target.startAt, config.target.baseUrl).origin,
      this.safety.navigation,
      config.browserInteractions.blockedOrigins,
    );
    this.credentials = new EnvironmentCredentialProvider(config.credentials, this.env);
    this.interactions = new BrowserInteractionManager({
      config: config.browserInteractions,
      policy: new InteractionPolicy(config.browserInteractions, this.safety, origins),
      credentials: this.credentials,
      crawlContext: () =>
        this.currentAction ?? (this.attribution.stateId ? { stateId: this.attribution.stateId } : {}),
      onResult: (result) => {
        this.onInteractionResult(result);
      },
      log: (line) => this.listener.onInteractionLog?.(line),
    })
      .register(new HttpAuthHandler())
      .register(new DialogHandler(this.env))
      .register(
        new PopupHandler({
          observe: config.browserInteractions.popups.observe,
          closeAfterMs: config.browserInteractions.popups.closeAfterMs,
          inspect: (page) => this.inspectNewPage(page),
        }),
      )
      .register(new DownloadHandler())
      .register(new FileChooserHandler())
      .register(new PermissionHandler())
      .register(new ExternalNavigationHandler());
    this.browserCredentials = browserHttpCredentials(config, this.env);
    this.browserEvents = new BrowserEventDiscovery(this.interactions, {
      origins,
      httpAuth: config.browserInteractions.enabled,
      answerAuth: this.browserCredentials === undefined,
      popupLoadTimeoutMs: Math.min(config.exploration.navigationTimeoutMs, 5_000),
    });
    this.runId = options.runId ?? config.testData.runId ?? newRunId();
    this.testData =
      options.testData ??
      new DefaultTestDataProvider({
        runId: this.runId,
        fields: config.testData.fields,
        defaults: config.testData.defaults,
        language: config.report.language,
        preserveExistingValues: config.forms.preserveExistingValues,
      });
    this.testDataRun = new TestDataRunContext({
      runId: this.runId,
      env: this.env,
      onGenerated: (key) => {
        this.listener.onTestData?.({
          at: new Date().toISOString(),
          event: 'TEST_DATA_GENERATED_FOR_RUN',
          message: `testData.${key}: generated once for this run`,
        });
      },
    });
    this.contract = options.contract;
    this.forms = new FormExerciser(
      this.executor,
      this.testData,
      this.safety,
      this.runId,
      undefined,
      options.contract,
    );
    const { oracles } = config;
    // Invariants : ceux des packs de domaine, puis ceux de la mission (même id : la mission l'emporte).
    const invariants = [
      ...this.semantics.invariants.filter((rule) => !config.invariants.some((own) => own.id === rule.id)),
      ...config.invariants,
    ];
    this.invariantOracle =
      invariants.length > 0 ? new InvariantOracle(invariants, config.authorization.primaryActor) : undefined;
    this.oracle = oracles.enabled
      ? new CompositeTestOracle([
          new TechnicalOracle({ api404: oracles.technical.api404 }),
          ...(oracles.ui.enabled ? [new UIOracle([...DEFAULT_ERROR_TEXTS, ...oracles.ui.errorTexts])] : []),
          ...(oracles.baseline.enabled ? [new BaselineOracle(options.baseline)] : []),
          new ContractOracle(options.contract),
          ...(this.invariantOracle ? [this.invariantOracle] : []),
          ...(config.functionalIntelligence.enabled
            ? [new SemanticFunctionalOracle((actionId) => this.functional?.findingsFor(actionId) ?? [])]
            : []),
          ...(config.knowledge.enabled
            ? [
                new HistoricalOracle(
                  this.knowledge,
                  {
                    minObservations: config.knowledge.minObservations,
                    dominance: config.knowledge.dominance,
                    slowFactor: config.knowledge.slowFactor,
                    ...this.confidenceOption(config),
                  },
                  exploration.queryParams.mode,
                ),
              ]
            : []),
        ])
      : undefined;
    this.networkTrace = new NetworkTraceRecorder(config.network);
    this.formNetwork = new FormKnowledgeObserver(
      (url) => this.safety.navigation.isAllowedHost(new URL(url).hostname),
      this.responseValues,
      // La forme des corps (clés, types) n'est lue que pour l'intelligence fonctionnelle.
      config.functionalIntelligence.enabled ? this.valueSalt : undefined,
    );
    this.coordinator = new FormRuleCoordinator({
      config,
      salt: this.valueSalt,
      network: this.formNetwork,
      responses: this.responseValues,
      crawlerValues: this.crawlerValues,
      observe: (page) => this.observer.observe(page),
      settle: async (page) => {
        await page.waitForTimeout(config.exploration.settleTimeMs).catch(() => undefined);
        await waitForScreenReady(page, Math.min(config.exploration.readyTimeoutMs, 3000)).catch(
          () => undefined,
        );
      },
      allowed: (action) => this.safety.evaluate(action).verdict !== 'BLOCK',
      submitAllowed: config.forms.submit === true || !config.safety.block.includes('form-submit'),
      emit: (event, message) => {
        this.listener.onRule?.({ at: new Date().toISOString(), event, message: redactText(message) });
      },
      ...(config.rules.enabled
        ? {
            store: new RuleKnowledgeStore(
              path.join(path.dirname(path.resolve(config.output.reportsDir)), 'knowledge', 'rules'),
              {
                application: config.mission.name,
                ...((config.staticAnalysis.version ?? this.env.QA_VERSION)
                  ? { version: config.staticAnalysis.version ?? this.env.QA_VERSION }
                  : {}),
                ...((config.staticAnalysis.commit ?? this.env.QA_COMMIT)
                  ? { commit: config.staticAnalysis.commit ?? this.env.QA_COMMIT }
                  : {}),
              },
            ),
          }
        : {}),
      ...((config.staticAnalysis.version ?? this.env.QA_VERSION)
        ? { version: config.staticAnalysis.version ?? this.env.QA_VERSION }
        : {}),
    });
    this.functional = config.functionalIntelligence.enabled
      ? new FunctionalIntelligence({
          config: config.functionalIntelligence,
          salt: this.valueSalt,
          safety: (target) => judgeGoalAction(this.safety, target.actionLabel),
          emit: (event, message) => {
            this.listener.onFunctional?.({
              at: new Date().toISOString(),
              event,
              message: redactText(message),
            });
          },
          rules: () => this.coordinator.ruleList(),
          knownPath: (route) => this.knownPathTo(route),
          store: new FunctionalKnowledgeStore(
            path.join(path.dirname(path.resolve(config.output.reportsDir)), 'knowledge', 'functional'),
            {
              application: config.mission.name,
              ...((config.staticAnalysis.version ?? this.env.QA_VERSION)
                ? { version: config.staticAnalysis.version ?? this.env.QA_VERSION }
                : {}),
              ...((config.staticAnalysis.commit ?? this.env.QA_COMMIT)
                ? { commit: config.staticAnalysis.commit ?? this.env.QA_COMMIT }
                : {}),
            },
          ),
        })
      : undefined;
    const { recovery } = config;
    this.recovery = new RecoveryEngine(recovery);
    this.breaker = recovery.enabled ? new CircuitBreaker(recovery.circuitBreaker) : undefined;
    this.stuck = recovery.enabled ? new StuckDetector(recovery.stuck) : undefined;
    this.accessibility = config.accessibility.enabled
      ? new AccessibilityChecker(config.accessibility)
      : undefined;
    this.createdData = new CreatedDataRegistry(this.runId);
    this.verifyBaseline = options.verifyBaseline;
    this.baselineRunId = options.baselineRunId;
    this.screenshots = new ScreenshotService(config.output.screenshotsDir, config.checks.fullPageScreenshots);
    this.authenticator = createAuthenticator(
      config.auth,
      config.target.baseUrl,
      options.env,
      new URL(config.target.startAt, config.target.baseUrl).toString(),
    );
    this.listener = options.listener ?? {};
    const cognitive = config.cognitive;
    this.cognitive = cognitive.enabled
      ? new CognitiveEngine({
          runTag: this.runId.replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'run',
          runtimeObservationsToConfirm: cognitive.runtimeObservationsToConfirm,
          maxHypotheses: cognitive.budgets.maxHypotheses,
          invariantThresholds: cognitive.invariants,
          budgets: cognitive.budgets,
          ...((this.knowledge.identity.commit ?? this.knowledge.identity.appVersion)
            ? { version: this.knowledge.identity.commit ?? this.knowledge.identity.appVersion }
            : {}),
          emit: (record) => this.listener.onCognitive?.(record),
        })
      : undefined;
    this.cognitive?.restore(this.knowledge.cognitiveKnowledge());
    this.advisor =
      options.reasoningAdvisor ??
      (cognitive.reasoning.advisor === 'deterministic' ? new DeterministicReasoningAdvisor() : undefined);
    this.ai = createIntelligenceGateway(config.ai, {
      env: options.env ?? process.env,
      ...(options.intelligenceProvider ? { provider: options.intelligenceProvider } : {}),
      emit: (record) => this.listener.onIntelligence?.(record),
    });
    this.aiContext = new IntelligenceContextBuilder({
      maxActions: config.ai.context.maxActions,
      maxEvidence: config.ai.context.maxEvidence,
      maxHypotheses: config.ai.context.maxHypotheses,
      maxPlanSteps: 10,
    });
    if (this.cognitive)
      // Un invariant découvert, soutenu puis violé : un avertissement, avec sa provenance.
      this.cognitive.onInvariantViolated = (invariant) =>
        this.collector.add({
          type: 'FUNCTIONAL',
          severity: 'WARNING',
          message: `Invariant violated: ${invariant.statement} — ${invariant.counterexamples.at(-1)?.detail ?? ''} (observed ${String(invariant.observations)} time(s) over ${String(invariant.runs.length)} run(s) before)`,
          pageUrl: this.currentUrl,
        });
    this.memory = options.memory;
    this.startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
    this.currentUrl = this.startUrl;
    this.collector.onIssue((issue, isNew) => this.listener.onIssue?.(issue, isNew));
    // Le traceur est toujours là (il porte aussi la profondeur d'étape) ; ses rapports seulement si tracing.
    this.perf = new PerformanceTracer(this.runId);
    this.instrumentPerformance(this.perf);
  }

  /**
   * PERFORMANCE TRACING : chaque étape de flow devient une action tracée, et les méthodes EXISTANTES du
   * pipeline des phases mesurées — sans changer leur code, leur ordre ni leurs attentes.
   */
  private instrumentPerformance(perf: PerformanceTracer): void {
    instrumentMethods(this, perf, {
      observeState: { phase: 'state-observation' },
      resolveFunctionalTarget: { phase: 'candidate-discovery', deep: 'FUNCTIONAL_RESOLUTION' },
      healTarget: { phase: 'locator-healing', deep: 'LOCATOR_HEALING' },
      reacquireAfterRerender: { phase: 'reacquire', deep: 'REACQUIRE' },
      healDivergence: { phase: 'recovery', deep: 'RECOVERY' },
      nextReadiness: { phase: 'next-target-probe' },
      targetAvailable: { phase: 'next-target-probe' },
      waitForEffect: { phase: 'effect-verification' },
      filledValue: { phase: 'fill-verification' },
      observeFunctional: { phase: 'functional-observation' },
      observeCognitive: { phase: 'cognitive-observation' },
      captureErrorScreenshot: { phase: 'screenshot' },
      adviseRecovery: { phase: 'ai', deep: 'AI' },
      adviseFailure: { phase: 'ai', deep: 'AI' },
    });
    instrumentMethods(this.flowSteps, perf, {
      locate: { phase: 'locate' },
      perform: { phase: 'execute' },
      expect: { phase: 'assertion' },
    });
    const host = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const wait = host['waitTransition'];
    if (wait)
      host['waitTransition'] = async (...args: unknown[]) => {
        const result = (await perf.track('transition-wait', () =>
          wait.apply(this, args),
        )) as TransitionWaitResult;
        perf.wait({
          type: 'transition',
          durationMs: result.durationMs,
          terminationReason:
            result.status === 'TIMEOUT'
              ? 'MAX_TIMEOUT'
              : result.signals.some((signal) => signal.kind === 'NO_PROGRESS')
                ? 'NO_PROGRESS'
                : 'CONDITION_MET',
          signals: result.signals,
        });
        return result;
      };
    // Une étape = une action (les étapes rejouées à l'intérieur d'une récupération restent dans celle-ci).
    const step = host['runFlowStep'];
    if (step)
      host['runFlowStep'] = async (...args: unknown[]) => {
        const flowStep = args[4] as FlowStep;
        const index = args[5] as number;
        if (this.stepDepth === 0)
          perf.beginAction(`step-${String(index)}`, index, describeStep(flowStep), flowStep.kind);
        this.stepDepth += 1;
        let status = 'ERROR';
        try {
          const outcome = (await step.apply(this, args)) as { report: FlowStepReport };
          status = outcome.report.status;
          return outcome;
        } finally {
          this.stepDepth -= 1;
          if (this.stepDepth === 0) {
            perf.endAction(status);
            this.previousStepStatus = status;
          }
        }
      };
  }

  /** Les traces de performance du run (vide si le tracing est désactivé). */
  performanceTraces(): readonly ActionPerformanceTrace[] {
    return this.perf.traces();
  }

  async explore(): Promise<ExplorationOutcome> {
    this.startedAt = new Date();
    if (this.config.memory.resume) this.graph = await this.memory.load();
    if (
      this.config.checks.screenshots ||
      this.config.checks.screenshotOnError ||
      this.config.flows.some((flow) => flow.steps.some((step) => step.kind === 'screenshot'))
    )
      await this.screenshots.prepare();

    const browser = new BrowserManager(this.config.browser);
    const observers = this.createObservers();
    let stopReason: StopReason = 'exhausted';
    try {
      const context = await browser.start({
        ...(this.browserCredentials?.options ?? {}),
        ...this.authenticator.contextOptions(),
      });
      if (this.browserCredentials)
        this.listener.onInteractionLog?.(
          `HTTP sign-in for ${this.browserCredentials.origin}: answered by the browser with credential profile "${this.browserCredentials.profile}" (every page and popup)`,
        );
      // Garde d'écriture : une requête POST/PUT/PATCH/DELETE que l'action en cours n'a pas le droit d'envoyer est annulée.
      await this.writeGuard.attach(context, (write) => {
        this.onBlockedWrite(write);
      });
      // Les interactions du navigateur hors du DOM (nouvelles fenêtres, dialogues, fenêtre de connexion…) passent par le gestionnaire.
      if (this.config.browserInteractions.enabled) await this.browserEvents.attachContext(context);
      const { grant } = this.config.browserInteractions.permissions;
      if (grant.length > 0) await context.grantPermissions(grant, { origin: new URL(this.startUrl).origin });
      let page = await this.openPage(browser, observers.all);

      const loginMark = this.interactions.mark();
      // La connexion écrit (POST du formulaire) : permise.
      await this.writeGuard.permit('sign-in', () => this.authenticator.login(page));
      if (this.config.auth.type === 'http') this.assertHttpLogin(loginMark);
      if (this.config.auth.type !== 'none') this.listener.onAuthenticated?.(this.authenticator.description);

      const startMark = this.interactions.mark();
      const started = await this.goto(page, this.startUrl);
      if (started && this.interactions.blockingSince(startMark).length > 0) {
        // par exemple AUTH_REQUIRED sur la page de départ : enregistré, rien d'autre ne peut être exploré.
        this.skipFlows('the start page requires an interaction that cannot be completed');
        return this.outcome('unreachable-start');
      }
      if (!started) {
        page = await this.recyclePage(browser, page, observers.all);
        if (!(await this.goto(page, this.startUrl))) {
          this.skipFlows('the start page is unreachable');
          return this.outcome('unreachable-start');
        }
      }
      // ANALYSE STATIQUE : au début (eager, ou Dry Run qui s'en sert pour ses indices), sinon à la demande.
      // Les scripts reçus sont suivis dès maintenant, pour que les chunks à la demande soient connus.
      if (this.config.staticAnalysis.enabled) this.watchScripts(page);
      if (
        this.config.staticAnalysis.enabled &&
        (this.config.staticAnalysis.strategy === 'eager' ||
          // Les règles de l'application se lisent dans le code : dès le début.
          (this.config.rules.enabled && this.config.rules.staticDiscovery) ||
          (this.dryRunHook !== undefined && this.config.staticAnalysis.dryRun.useStaticKnowledge))
      )
        await this.ensureStaticKnowledge(page);
      // INTELLIGENCE FONCTIONNELLE : la connaissance du code (si l'analyse statique est là) et du contrat.
      if (this.functional) {
        await this.functional.loadHistory();
        if (this.config.staticAnalysis.enabled) await this.ensureStaticKnowledge(page);
        this.functional.useStaticKnowledge(
          this.staticKnowledge?.graph,
          this.contract,
          this.declaredScenarios(),
        );
      }
      // RECORDING INTELLIGENCE (HYBRID) : les candidats proposés à l'enregistrement deviennent des hypothèses
      // observables — le rejeu les soutiendra ou les contredira (jamais une vérité d'emblée).
      if (this.cognitive && this.ai?.mode === 'HYBRID') await this.loadRecordingCandidates();
      // L'état de départ est la racine du graphe des flows, quel que soit ce que les flows visitent d'abord.
      let current = await this.observeState(page, 0);
      // GOAL PLANNER : des objectifs fonctionnels (jamais des clics), suivis pendant tout le run.
      const blockedConcepts = new Set(
        (['delete', 'logout'] as const).filter((risk) => this.config.safety.block.includes(risk)),
      );
      const plan = await new RuleBasedGoalPlanner(this.semantics.dictionary, { blockedConcepts }).plan(
        missionOf(this.config),
        current,
        this.graph,
        this.knowledge,
      );
      if (plan.goals.length > 0) {
        this.goals = new GoalTracker(plan, this.goalMatcher);
        this.observeGoals(current);
      }

      // DRY RUN : le scénario est confronté à l'application ; ni flows imposés ni exploration autonome.
      const dryRun = this.dryRunHook;
      if (dryRun) {
        const holder = { page };
        await dryRun((flow) => this.dryRunDriver(holder, browser, observers, flow));
        await this.memory.save(this.graph);
        return this.outcome('flows-only');
      }

      // 1. Flows imposés, dans l'ordre de la mission.
      let flowsStop: StopReason | undefined;
      if (this.config.flows.length > 0) {
        const flows = await this.runFlows(page, browser, observers);
        page = flows.page;
        flowsStop = flows.stopReason;
      }

      // 2. verify : rejouer les transitions connues de la baseline. Sinon, exploration autonome.
      if (flowsStop) {
        stopReason = flowsStop;
      } else if (this.verifyBaseline) {
        const verified = await this.verifyKnownTransitions(page, browser, observers, this.verifyBaseline);
        page = verified.page;
        stopReason = verified.stopReason;
      } else if (!this.config.exploration.autonomous) {
        stopReason = 'flows-only';
      } else {
        if (this.config.flows.length > 0) {
          if (!/^https?:/.test(page.url()) || page.isClosed())
            page = await this.recyclePage(browser, page, observers.all);
          if (await this.goto(page, this.startUrl)) current = await this.observeState(page, 0);
        }
        this.stack = [{ stateId: current.stateId, url: current.url }];
        const loop = await this.explorationLoop(page, browser, observers, current);
        stopReason = loop.stopReason;
      }
    } finally {
      // Un nouvel onglet, une fenêtre ou un téléchargement encore en traitement (machine lente) : les attendre,
      // le temps de charger la page (popupLoadTimeoutMs), de l'observer et de la laisser ouverte si demandé.
      const { exploration, browserInteractions } = this.config;
      const popupLoad = Math.min(exploration.navigationTimeoutMs, 5_000);
      const progress = this.progress;
      const waiting = this.browserEvents.pendingCount();
      if (waiting > 0)
        progress?.start(
          EXPLORER_CLOSING_PHASES.events,
          `${String(waiting)} tab(s) or download(s) still being handled`,
        );
      await this.browserEvents
        .settle(
          Math.max(
            5_000,
            2 * popupLoad + exploration.actionTimeoutMs + browserInteractions.popups.closeAfterMs,
          ),
        )
        .catch(() => undefined);
      progress?.start(EXPLORER_CLOSING_PHASES.browser);
      await browser.close();
      // Le client d'intelligence (s'il a été créé) s'arrête avec le run, quoi qu'il arrive.
      if (this.ai) {
        progress?.start(EXPLORER_CLOSING_PHASES.intelligence);
        await this.ai.close();
      }
    }
    this.progress?.start(EXPLORER_CLOSING_PHASES.memory);
    await this.memory.save(this.graph);
    await this.coordinator.persist();
    await this.functional?.persist();
    await this.persistCognitive();
    await this.persistIntelligence();
    return this.outcome(stopReason);
  }

  /**
   * OBSERVER → DÉCIDER → CONTRÔLE DE SÉCURITÉ → EXÉCUTER → OBSERVER → ENREGISTRER, depuis
   * `current` jusqu'à ce que le moteur s'arrête, qu'une limite soit atteinte ou qu'il ne
   * reste rien. Avec un `scope` (exploration du dernier écran d'un flow, `thenExplore`),
   * seuls les contrôles de la page et les liens vers les pages sous cet écran sont
   * considérés, le menu global est ignoré, un écran hors du périmètre est quitté aussitôt,
   * et l'exploration ne saute jamais vers d'autres états.
   */
  private async explorationLoop(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    start: PageContext,
    scope?: ExplorationScope,
  ): Promise<{ page: Page; stopReason: StopReason }> {
    const allowJump = scope === undefined;
    this.allowJump = allowJump;
    let current = start;
    for (;;) {
      const limit = this.limitReached();
      if (limit) return { page, stopReason: limit };

      if (scope && !isInScope(scope, current.url)) {
        // Un contrôle de la page a mené ailleurs : revenir sans explorer cet écran ici.
        const restored = await this.backtrack(page, browser, observers.all, false);
        page = restored.page;
        if (!restored.context) return { page, stopReason: 'exhausted' };
        current = restored.context;
        continue;
      }

      // COMPRENDRE L'ÉCRAN (une fois par état) : état des champs, provenance des valeurs, règles du code
      // confirmées ou contredites par le navigateur. Rien n'est envoyé ; une valeur posée est rétablie.
      if (this.lastSnapshot) {
        const understood = await this.coordinator
          .understand(page, this.lastSnapshot, current)
          .catch(() => ({ navigated: false }));
        if (understood.navigated) {
          current = await this.observeState(page, current.metadata.depth);
          continue;
        }
      }

      // Les formulaires d'abord : un écran avec des champs (une fenêtre « Nouveau dossier »…) est rempli, puis vérifié.
      const form = this.formToExercise(current);
      if (form) {
        const step = await this.exerciseForm(page, current, form);
        page = step.page;
        current = step.context;
        continue;
      }

      // Le moteur ne voit que ce que le périmètre permet ; les autres actions restent inexplorées pour plus tard.
      const candidates = scope ? { ...current, actions: actionsInScope(scope, current.actions) } : current;
      await this.reasonAboutState(candidates);
      const { decision, jumpTo } = await this.chooseNext(candidates, allowJump);
      this.listener.onDecision?.(current, decision);

      if (jumpTo) {
        // BEST-FIRST : un candidat nettement meilleur attend sur un autre écran — y aller, puis l'exécuter.
        const moved = await this.jumpTo(page, browser, observers.all, current.stateId, jumpTo);
        page = moved.page;
        if (moved.context) current = moved.context;
        continue;
      }

      if (decision.decision === 'STOP') return { page, stopReason: 'engine-stop' };
      if (decision.decision === 'BACKTRACK') {
        this.exhausted.add(current.stateId);
        const restored = await this.backtrack(page, browser, observers.all, allowJump);
        page = restored.page;
        if (!restored.context) return { page, stopReason: 'exhausted' }; // plus rien nulle part
        current = restored.context;
        continue;
      }

      const action = current.actions.find((candidate) => candidate.id === decision.actionId);
      if (!action) {
        // Le moteur a proposé quelque chose qui n'est pas à l'écran : ne jamais le retenter.
        this.graph.addEdge({
          from: current.stateId,
          to: current.stateId,
          actionId: decision.actionId ?? 'unknown',
          action: { type: 'click', category: 'other', classification: 'UNKNOWN' },
          result: 'FAILED',
          reason: 'action not available on this state',
        });
        continue;
      }

      // « Ai-je le droit ? » — après la décision, avant Playwright, quel que soit le moteur.
      const verdict = this.safety.evaluate(action);
      if (verdict.verdict === 'BLOCK') {
        this.graph.recordBlocked(current.stateId, action, verdict.reason);
        this.coverage.actionBlocked(current.stateId, action);
        this.frontier.remove(current.stateId, action.id);
        this.knowledge.recordActionResult({ actionSignature: actionSignature(action), result: 'BLOCKED' });
        this.listener.onBlocked?.(current, action, verdict.reason);
        continue;
      }

      let step: { page: Page; context: PageContext };
      try {
        step = await this.executeAndObserve(page, browser, observers, current, action);
      } catch (error) {
        if (!(error instanceof NavigationRecoveryError)) throw error;
        // La page n'a pas cessé de naviguer pendant qu'on la lisait (NAVIGATION_RECOVERY_FAILED, déjà
        // journalisé) : l'action a eu lieu et n'est jamais rejouée (marquée comme essayée) ; revenir à
        // l'état d'où elle partait, sinon à un autre état connu, et continuer l'exploration.
        this.currentAction = undefined;
        this.graph.markTried(current.stateId, action.id);
        const back = await this.restore(page, current.stateId).catch(() => undefined);
        if (back) {
          current = back;
          continue;
        }
        const restored = await this.backtrack(page, browser, observers.all, allowJump);
        page = restored.page;
        if (!restored.context) return { page, stopReason: 'exhausted' };
        current = restored.context;
        continue;
      }
      page = step.page;
      current = step.context;
      await this.memory.save(this.graph);

      const stuck = this.pendingStuck;
      if (stuck) {
        // On tourne en rond : cette branche est quittée, l'exploration continue ailleurs.
        this.pendingStuck = undefined;
        this.exhausted.add(current.stateId);
        const restored = await this.backtrack(page, browser, observers.all, allowJump);
        page = restored.page;
        this.recovery.record(
          { stateId: stuck.stateId, kind: 'stuck', message: stuck.message },
          'abandon-branch',
          restored.context,
        );
        this.emitRecovery();
        if (!restored.context) return { page, stopReason: 'exhausted' };
        current = restored.context;
      }
    }
  }

  // ---------------------------------------------------------------- étapes de la boucle

  /** OBSERVER → ÉTAT → DÉCOUVRIR → enregistrer le nœud. */
  private async observeState(page: Page, depth: number): Promise<PageContext> {
    const snapshot = await this.observer.observe(page);
    this.lastSnapshot = snapshot;
    const state = this.stateDetector.detect(snapshot);
    this.frames.set(state.stateId, frameOf(state.signature));
    const actions = this.discovery.discover(snapshot, state.stateId);
    this.annotateStatic(actions, snapshot.url);
    const isNew = this.graph.addNode({
      id: state.stateId,
      label: state.label,
      url: redactUrl(snapshot.url),
      route: state.route,
      title: snapshot.title,
      headings: snapshot.headings,
      ...(stateSubtitle(snapshot) ? { subtitle: stateSubtitle(snapshot) } : {}),
      depth,
      actions,
    });
    this.details.set(state.stateId, { actions, forms: snapshot.forms });
    this.currentUrl = snapshot.url;
    this.functional?.observeScreen(screenFactsOf(snapshot, state.route));
    if (this.cognitive && this.config.cognitive.businessState)
      this.cognitive.observeScreen(snapshot, state.route);
    if (this.cognitive && this.staticKnowledge) this.claimRequiredFields(snapshot, state.route);

    const flow = this.graph.flowTo(state.stateId);
    // Les anomalies levées en atteignant cet état lui appartiennent.
    const pending = this.collector
      .all()
      .filter((issue) => issue.stateId === undefined)
      .map((issue) => issue.id);
    this.collector.assignState(pending, state.stateId, flow);
    const errors = this.collector.forState(state.stateId);
    this.graph.attachIssues(
      state.stateId,
      errors.map((issue) => issue.id),
    );

    if (isNew) {
      this.recordRefusedActions(state.stateId, actions);
      await this.checkAccessibility(page, snapshot.url, state.stateId, flow);
    }

    const node = this.graph.getNode(state.stateId);
    if (isNew && node) {
      const sequence = this.graph.nodeCount;
      const serious = errors.some((issue) => isAtLeast(issue.severity, 'ERROR'));
      if (this.config.checks.screenshots || (serious && this.config.checks.screenshotOnError)) {
        const file = await this.screenshots.captureState(
          page,
          sequence,
          state.label,
          serious ? 'error' : undefined,
        );
        if (file) {
          this.graph.setScreenshot(state.stateId, file);
          for (const issue of errors) if (isAtLeast(issue.severity, 'ERROR')) issue.screenshot ??= file;
        }
      }
    }

    const context: PageContext = {
      url: redactUrl(snapshot.url),
      title: snapshot.title,
      stateId: state.stateId,
      stateLabel: state.label,
      route: state.route,
      headings: snapshot.headings,
      ...(snapshot.textExcerpt ? { text: snapshot.textExcerpt } : {}),
      ...(snapshot.structure ? { structure: snapshot.structure } : {}),
      dialogs: snapshot.dialogs,
      actions,
      forms: snapshot.forms,
      errors,
      metadata: { depth: node?.depth ?? depth, timestamp: new Date().toISOString(), flow },
    };
    this.attribution = { stateId: state.stateId, flow };
    // PATTERN RECOGNITION → nouveauté → couverture → objectifs.
    const patterns = this.patternDetector.detect(context);
    this.patternsByState.set(state.stateId, patterns);
    if (isNew) {
      this.noveltyByState.set(
        state.stateId,
        this.novelty.evaluate(
          context,
          this.graph,
          this.knowledge,
          patterns.map((pattern) => pattern.type),
        ),
      );
      for (const action of actions)
        this.knowledge.recordActionResult({ actionSignature: actionSignature(action), result: 'SEEN' });
    }
    this.coverage.observeState(context, patterns);
    this.budget.set('states', this.graph.nodeCount);
    this.observeGoals(context);
    this.listener.onState?.(context, isNew);
    return context;
  }

  /** Les objectifs prouvés par cet écran passent REACHED (avec leurs preuves). */
  private observeGoals(context: PageContext): void {
    if (!this.goals) return;
    for (const goal of this.goals.observe(context, this.patternsByState.get(context.stateId) ?? []))
      this.listener.onGoal?.(goal);
  }

  /**
   * ConfidenceEngine (intelligence.enabled + intelligence.confidence.enabled) : la confiance
   * de l'oracle historique devient progressive et expliquée. Sinon : rien, le barème d'avant.
   */
  private confidenceOption(config: ScenarioConfig): {
    confidence?: (knowledge: TransitionKnowledge) => ConfidenceResult;
    flakiness?: (knowledge: TransitionKnowledge) => FlakinessResult;
  } {
    const flakiness = flakinessOf(config);
    const engine = confidenceEngineOf(config);
    if (!engine) return flakiness ? { flakiness } : {};
    const context = knowledgeContextOf(config, this.knowledge.identity);
    return {
      confidence: (knowledge) => engine.evaluate(knowledge, context),
      ...(flakiness ? { flakiness } : {}),
    };
  }

  /** Une requête d'écriture annulée par la garde : une anomalie « effet de bord ». */
  private onBlockedWrite(write: BlockedWrite): void {
    // Le modèle de la requête : les écritures d'une même saisie (une par frappe) font une seule anomalie.
    const path = writePattern(write.url);
    const issue = this.collector.add({
      type: 'WRITE_BLOCKED',
      severity: 'WARNING',
      message: `write request blocked: ${write.method} ${path} — side effect of ${write.during} (not allowed to change data)`,
      pageUrl: this.currentUrl,
      ...(write.actionId ? { actionId: write.actionId } : {}),
      ...(write.stateId ? { stateId: write.stateId } : {}),
    });
    if (write.stateId) this.graph.attachIssues(write.stateId, [issue.id]);
  }

  /** EXÉCUTER → OBSERVER LE NOUVEL ÉTAT → ENREGISTRER LA TRANSITION. */
  private async executeAndObserve(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    from: PageContext,
    action: DiscoveredAction,
    afterLogin = false,
  ): Promise<{ page: Page; context: PageContext }> {
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    const urlBefore = page.url();
    const snapshotBefore = this.lastSnapshot;
    this.lastExecutedValue = undefined;
    this.formNetwork.start(`action-${action.id}`);
    if (this.functional) {
      this.formNetwork.startFunctional(`action-${action.id}`);
      this.functional.onActionSelected({ label: actionLabel(action), type: action.type });
    }
    // Les anomalies levées à partir de maintenant sont causées par cette action ; leur état est connu après l'observation.
    this.attribution = { actionId: action.id };
    this.currentAction = { stateId: from.stateId, actionId: action.id };
    this.writeGuard.during(from.stateId, action.id, `${action.type} "${actionLabel(action)}"`);
    this.frontier.remove(from.stateId, action.id);
    const interactionMark = this.interactions.mark();

    this.networkTrace.start(action.id);
    this.actionClock = Date.now();
    let result = await this.execute(page, from, action);
    this.actionsExecuted += 1;
    // RETRY : une erreur Playwright passagère (élément réaffiché sous le clic), jamais une action qui envoie des données.
    for (
      let attempt = 0;
      result.status === 'FAILED' && this.recovery.shouldRetry(result.error, action, attempt);
      attempt++
    ) {
      await page.waitForTimeout(this.config.exploration.settleTimeMs).catch(() => undefined);
      const failed = result.error;
      result = await this.execute(page, from, action);
      this.recovery.record(
        {
          stateId: from.stateId,
          actionId: action.id,
          kind: 'action-failed',
          ...(failed ? { message: failed } : {}),
        },
        'retry',
        result.status === 'SUCCESS' ? from : undefined,
      );
      this.emitRecovery();
    }

    // SESSION EXPIRÉE : l'action a abouti sur la page de connexion. Se reconnecter (dans une limite), revenir, réessayer une fois.
    let expired = false;
    if (result.status === 'SUCCESS' && (await this.sessionExpired(page, from))) {
      expired = true;
      if (!afterLogin) {
        this.networkTrace.stop(action.id);
        const renewed = await this.reauthenticate(page);
        const back = renewed ? await this.restore(page, from.stateId) : undefined;
        this.recovery.record(
          { stateId: from.stateId, actionId: action.id, kind: 'session-expired', message: 'session expired' },
          'reauthenticate',
          back,
        );
        this.emitRecovery();
        if (back) return this.executeAndObserve(page, browser, observers, back, action, true);
      }
      result = { ...result, status: 'FAILED', error: 'session expired (login page shown)' };
    }
    const raised = this.interactions.since(interactionMark);
    const blocking = raised.filter((interaction) => interaction.blocking);
    const interactionIds =
      raised.length > 0 ? { interactionIds: raised.map((interaction) => interaction.id) } : {};
    this.currentAction = undefined;
    const newIssues = (): string[] =>
      this.collector
        .all()
        .filter((issue) => !issuesBefore.has(issue.id))
        .map((issue) => issue.id);

    const leftAllowedHosts = !this.isExplorablePage(page);
    const crashed = observers.pageErrors.consumeCrash();
    const beforeSignals = this.lastSnapshot?.signals;
    if (result.status === 'FAILED' || blocking.length > 0 || leftAllowedHosts || crashed) {
      if (this.functional) await this.formNetwork.stopFunctional(`action-${action.id}`);
      const kind: FailureKind = expired
        ? 'session-expired'
        : crashed
          ? 'page-crash'
          : leftAllowedHosts
            ? 'left-allowed-hosts'
            : 'action-failed';
      if (leftAllowedHosts && result.status === 'SUCCESS' && /^https?:/.test(page.url())) {
        this.collector.add({
          type: 'NAVIGATION',
          severity: SeverityRules.navigationFailure('external-redirect'),
          message: `"${actionLabel(action)}" led outside the allowed hosts (${new URL(page.url()).origin}); not explored`,
          pageUrl: from.url,
          requestUrl: page.url(),
          actionId: action.id,
        });
      }
      const ids = newIssues();
      this.collector.assignState(ids, from.stateId, from.metadata.flow);
      const edge = this.graph.addEdge({
        from: from.stateId,
        to: from.stateId,
        actionId: action.id,
        action: summaryOf(action),
        ...this.networkOf(action.id),
        // Une interaction du navigateur qui n'a pas pu aboutir (par exemple AUTH_REQUIRED) bloque la transition.
        result: blocking.length > 0 ? 'BLOCKED' : 'FAILED',
        reason:
          blocking.length > 0
            ? blockingReason(blocking)
            : (result.error ??
              (leftAllowedHosts ? 'left the allowed hosts or the page failed to load' : 'page crashed')),
        durationMs: result.durationMs,
        issueIds: ids,
        ...interactionIds,
      });
      if (blocking.length === 0) {
        await this.judge(edge, from, action, undefined, {
          error: edge.reason ?? 'failed',
          crashed,
          beforeSignals,
        });
        ids.push(...edge.issueIds.filter((id) => !ids.includes(id)));
      }
      this.learn(edge, from, action, undefined);
      this.graph.attachIssues(from.stateId, ids);
      this.listener.onTransition?.(edge, action);
      await this.captureErrorScreenshot(page, from, ids);
      // Revenir là où on était, sur une page neuve si la page courante est cassée.
      if (!/^https?:/.test(page.url()) || page.isClosed()) {
        page = await this.recyclePage(browser, page, observers.all);
      }
      const recovered = await this.recoverFrom(page, browser, observers.all, from, {
        stateId: from.stateId,
        actionId: action.id,
        kind,
        message: edge.reason ?? 'failed',
        navigated: page.url() !== urlBefore,
        // Une interaction bloquée (AUTH_REQUIRED…) n'est pas un échec de l'action elle-même.
        countFailure: blocking.length === 0,
      });
      if (recovered.context) return { page: recovered.page, context: recovered.context };
      const fallback = { page: recovered.page };
      // La page n'est plus dans l'état d'où partait l'action (par exemple une fenêtre fermée par le
      // rechargement) : continuer à partir de ce qui est vraiment à l'écran, pas de l'ancienne liste d'actions.
      if (this.isExplorablePage(fallback.page)) {
        const current = await this.observeState(fallback.page, from.metadata.depth).catch(() => undefined);
        if (current) return { page: fallback.page, context: current };
      }
      return { page: fallback.page, context: from };
    }

    // Les entrées du menu global sont atteignables depuis l'état de départ : un niveau de profondeur, où qu'on ait cliqué dessus.
    const depth = action.category === 'menu' ? 1 : from.metadata.depth + 1;
    const after = await this.observeState(page, depth);
    // Une saisie : ce qui a changé ailleurs (dépendances entre champs), les règles de ce champ revues.
    const formExchanges = this.formNetwork.stop(`action-${action.id}`);
    await this.observeFunctional(action, snapshotBefore, this.lastSnapshot, from.route, after.route);
    if (action.field)
      this.coordinator.afterAction({
        action,
        ...this.executedValue(),
        before: snapshotBefore,
        after: this.lastSnapshot,
        stateId: after.stateId,
        route: after.route,
        network: formExchanges,
      });
    const ids = newIssues();
    const edge = this.graph.addEdge({
      from: from.stateId,
      to: after.stateId,
      actionId: action.id,
      action: summaryOf(action),
      ...this.networkOf(action.id),
      result: 'SUCCESS',
      durationMs: result.durationMs,
      issueIds: ids,
      ...interactionIds,
    });
    await this.judge(edge, from, action, after, { crashed, beforeSignals });
    ids.push(...edge.issueIds.filter((id) => !ids.includes(id)));
    this.learn(edge, from, action, after);
    this.observeCognitive(
      action.type,
      actionLabel(action),
      snapshotBefore,
      from.route,
      after.route,
      edge.network,
      `exploration ${from.stateId}`,
    );
    this.verifyAiProposal(
      `${from.stateId}::${action.id}`,
      snapshotBefore,
      from.route,
      after.route,
      ids.length,
    );
    if (this.safety.changesData(action) && edge.network) {
      this.createdData.record({
        stateId: from.stateId,
        actionId: action.id,
        action: actionLabel(action),
        ...(action.formGroup ? { form: action.formGroup } : {}),
        requests: edge.network,
      });
    }
    const stuck = this.stuck?.observe({
      from: from.stateId,
      to: after.stateId,
      actionId: action.id,
      requests: edge.network?.length ?? 0,
      busy: this.lastSnapshot?.signals?.busy ?? false,
    });
    if (stuck) {
      // Boucle vue pour la première fois : ses actions perdent des points, l'exploration continue.
      // Sinon (même boucle à nouveau, oscillation, actions sans effet, chargement sans fin) : quitter la branche.
      if (stuck.response === 'penalize') {
        for (const step of stuck.actions ?? [])
          this.loopPenalties.set(`${step.stateId}::${step.actionId}`, { points: 80, detail: stuck.message });
      } else this.pendingStuck = stuck;
      this.listener.onStuck?.(stuck);
    }
    // Les anomalies du nouvel état savent maintenant quelle action et quel chemin y ont mené.
    for (const issue of this.collector.all()) {
      if (ids.includes(issue.id)) {
        issue.actionId ??= action.id;
        issue.flow = this.graph.flowTo(after.stateId);
      }
    }
    await this.captureErrorScreenshot(page, after, ids);
    this.listener.onTransition?.(edge, action);
    this.pushState(after);
    return { page, context: { ...after, errors: this.collector.forState(after.stateId) } };
  }

  /**
   * RÉCUPÉRATION après une action en échec : les stratégies configurées dans l'ordre
   * (calque au premier plan, Escape, historique, URL, chemin rejoué, nouvelle connexion,
   * autre branche). Un échec qui revient ouvre le circuit : l'action, ou tout l'état,
   * n'est plus retentée.
   */
  private async recoverFrom(
    page: Page,
    browser: BrowserManager,
    observers: PageObserver[],
    from: PageContext,
    failure: {
      stateId: string;
      actionId: string;
      kind: FailureKind;
      message: string;
      navigated: boolean;
      countFailure: boolean;
    },
  ): Promise<{ page: Page; context?: PageContext }> {
    let current = page;
    const circuit = failure.countFailure
      ? (this.breaker?.record(failure.stateId, failure.actionId, failure.message) ?? 'closed')
      : 'closed';
    const abandon = circuit === 'state-open';
    if (abandon) this.exhausted.add(from.stateId);
    const steps = this.restoreSteps(current, from.stateId);
    this.attribution = {};
    const actions: RecoveryActions = {
      ...(steps && !abandon
        ? {
            // Seulement quand une fenêtre, un menu ou un sélecteur était devant l'écran.
            ...(this.lastSnapshot?.elements.some((element) => element.foreground)
              ? { 'dismiss-dialog': steps.dismiss }
              : {}),
            // Rien n'a bougé : Escape et un nouveau regard suffisent. La page a changé : l'historique d'abord.
            ...(failure.navigated ? { back: steps.back } : { escape: steps.escape }),
            'known-url': steps.url,
            'replay-path': steps.replay,
          }
        : {}),
      ...(failure.kind === 'session-expired'
        ? {
            reauthenticate: async () =>
              (await this.reauthenticate(current)) ? this.restore(current, from.stateId) : undefined,
          }
        : {}),
      'abandon-branch': async () => {
        this.exhausted.add(from.stateId);
        const elsewhere = await this.backtrack(current, browser, observers, this.allowJump);
        current = elsewhere.page;
        this.stuck?.reset();
        return elsewhere.context;
      },
    };
    const recovered = await this.recovery.recover(
      {
        stateId: failure.stateId,
        actionId: failure.actionId,
        kind: abandon ? 'circuit-open' : failure.kind,
        message: failure.message,
      },
      actions,
    );
    this.emitRecovery();
    return { page: current, ...(recovered.context ? { context: recovered.context } : {}) };
  }

  /** ACCESSIBILITÉ : vérifications de base sur un nouvel écran, signalées comme anomalies de cet état. */
  private async checkAccessibility(page: Page, url: string, stateId: string, flow: string[]): Promise<void> {
    if (!this.accessibility || page.isClosed()) return;
    const findings = await this.accessibility.check(page).catch(() => []);
    const ids: string[] = [];
    for (const finding of findings) {
      const issue = this.collector.add({
        type: 'ACCESSIBILITY',
        severity: finding.severity,
        message: finding.message,
        pageUrl: redactUrl(url),
        stateId,
        flow,
      });
      ids.push(issue.id);
    }
    if (ids.length > 0) this.graph.attachIssues(stateId, ids);
  }

  /** Événements de récupération pas encore transmis au listener. */
  private recoveryEmitted = 0;
  private emitRecovery(): void {
    const events = this.recovery.events();
    for (const event of events.slice(this.recoveryEmitted)) this.listener.onRecovery?.(event);
    this.recoveryEmitted = events.length;
  }

  /** Événement technique du garde de navigation : journalisé, transmis, résumé dans le rapport — jamais une anomalie. */
  private onNavigation(event: NavigationEvent): void {
    const redacted = {
      ...event,
      previousUrl: redactUrl(event.previousUrl),
      currentUrl: redactUrl(event.currentUrl),
    };
    this.navigationEvents.push(redacted);
    this.listener.onNavigation?.(redacted);
  }

  /** La session a-t-elle expiré ? Avec une connexion par formulaire : la page montre la page de connexion qu'elle n'a pas demandée. */
  private async sessionExpired(page: Page, from: PageContext): Promise<boolean> {
    return Promise.resolve(this.onLoginPage(page) && !this.isLoginUrl(from.url));
  }

  private onLoginPage(page: Page): boolean {
    return !page.isClosed() && this.isLoginUrl(page.url());
  }

  private isLoginUrl(url: string): boolean {
    const { auth } = this.config;
    if (auth.type !== 'form') return false;
    try {
      return new URL(url).pathname === new URL(auth.loginUrl, this.config.target.baseUrl).pathname;
    } catch {
      return false;
    }
  }

  /** Se reconnecte après une expiration de session, dans la limite configurée. */
  private async reauthenticate(page: Page): Promise<boolean> {
    if (!this.recovery.mayReauthenticate()) return false;
    return this.writeGuard
      .permit('sign-in', () => this.authenticator.login(page))
      .then(() => true)
      .catch(() => false);
  }

  /**
   * ORACLE DE TEST : juge une action exécutée à partir de ce qui a été observé (réseau,
   * anomalies, écran) et attache le verdict à sa transition. Les avertissements des
   * oracles écran, baseline et contrat deviennent des anomalies (les échecs techniques
   * en sont déjà : HTTP, erreurs JavaScript…).
   */
  private async judge(
    edge: FlowEdge,
    from: PageContext,
    action: DiscoveredAction,
    after: PageContext | undefined,
    facts: { error?: string; crashed: boolean; beforeSignals: UiSnapshot['signals'] },
  ): Promise<void> {
    if (!this.oracle) return;
    const issues = this.collector.all().filter((issue) => edge.issueIds.includes(issue.id));
    const verdict = await this.oracle.evaluate(
      from,
      {
        id: action.id,
        type: action.type,
        category: action.category,
        classification: action.classification,
        ...(action.text ? { text: action.text } : {}),
        ...(action.href ? { href: action.href } : {}),
        ...(action.submitsForm ? { submitsForm: true } : {}),
        result: after ? 'SUCCESS' : 'FAILED',
        ...(facts.error ? { error: facts.error } : {}),
        ...(edge.durationMs !== undefined ? { durationMs: edge.durationMs } : {}),
      },
      after,
      {
        issues,
        network: edge.network ?? [],
        pageCrashed: facts.crashed,
        ...(facts.beforeSignals ? { before: facts.beforeSignals } : {}),
        ...(after && this.lastSnapshot?.signals ? { after: this.lastSnapshot.signals } : {}),
        formFilledWithValidData:
          action.formGroup !== undefined && this.formsExercised.has(`${from.stateId}|${action.formGroup}`),
        beforePatterns: this.patternsByState.get(from.stateId) ?? [],
        ...(after ? { afterPatterns: this.patternsByState.get(after.stateId) ?? [] } : {}),
        actor: this.config.authorization.primaryActor,
      },
    );
    edge.oracle = verdict;
    const anomaly: Record<string, IssueType | undefined> = {
      ui: 'UI_ERROR',
      baseline: 'REGRESSION',
      contract: 'CONTRACT',
      historical: 'UNEXPECTED_BEHAVIOR',
    };
    const add = (type: IssueType, severity: Severity, message: string): void => {
      const issue = this.collector.add({
        type,
        severity,
        message: `"${actionLabel(action)}": ${message}`,
        pageUrl: from.url,
        actionId: action.id,
        stateId: after?.stateId ?? from.stateId,
      });
      if (!edge.issueIds.includes(issue.id)) edge.issueIds.push(issue.id);
    };
    for (const opinion of verdict.results) {
      if (opinion.oracle === 'invariant') {
        // La sévérité vient de la règle elle-même (INFO … CRITICAL), jamais toutes bloquantes.
        const severities: Record<string, Severity> = {
          'invariant-critical': 'CRITICAL',
          'invariant-error': 'ERROR',
          'invariant-warning': 'WARNING',
          'invariant-info': 'INFO',
        };
        for (const reason of opinion.reasons) {
          const severity = severities[reason.code];
          if (severity) add('INVARIANT', severity, reason.message);
        }
        continue;
      }
      if (opinion.oracle === 'functional') {
        // Une attente fonctionnelle non tenue : un avertissement, jamais un échec confirmé ; un écart de contrat reste CONTRACT.
        if (opinion.status === 'WARNING')
          for (const reason of opinion.reasons)
            add(reason.code === 'contract-mismatch' ? 'CONTRACT' : 'FUNCTIONAL', 'WARNING', reason.message);
        continue;
      }
      const type = anomaly[opinion.oracle];
      if (!type || (opinion.status !== 'WARNING' && opinion.status !== 'FAIL')) continue;
      for (const reason of opinion.reasons)
        add(
          reason.code === 'performance-warning' ? 'PERFORMANCE' : type,
          opinion.status === 'FAIL' ? 'ERROR' : 'WARNING',
          reason.message,
        );
    }
    this.listener.onOracle?.(edge, verdict);
  }

  /**
   * APPRENTISSAGE : après le verdict (l'historique juge l'action AVANT de l'apprendre),
   * la KnowledgeBase enregistre le résultat, la transition, les statuts d'API et les
   * durées ; la couverture et les options essayées sont mises à jour.
   */
  private learn(
    edge: FlowEdge,
    from: PageContext,
    action: DiscoveredAction,
    after: PageContext | undefined,
  ): void {
    const signature = actionSignature(action);
    const success = edge.result === 'SUCCESS';
    this.knowledge.recordActionResult({
      actionSignature: signature,
      result: edge.result === 'BLOCKED' ? 'BLOCKED' : success ? 'SUCCESS' : 'FAILED',
      ...(edge.durationMs !== undefined ? { durationMs: edge.durationMs } : {}),
    });
    if (edge.durationMs !== undefined) this.knowledge.recordDuration('action', signature, edge.durationMs);
    if (after && success) {
      this.knowledge.recordTransition({
        fromStateSignature: stateSignature(from.stateLabel),
        actionSignature: signature,
        toStateSignature: stateSignature(after.stateLabel),
        success: true,
      });
      this.knowledge.recordOutcomePatterns(
        actionLabel(action),
        (this.patternsByState.get(after.stateId) ?? []).map((pattern) => pattern.type),
      );
    }
    for (const exchange of edge.network ?? []) {
      if (exchange.resourceType === 'document' || exchange.status === undefined) continue;
      const operation = apiOperation(exchange.method, exchange.url, this.config.exploration.queryParams.mode);
      this.knowledge.recordApiCall(operation, exchange.status, exchange.durationMs);
      if (exchange.durationMs !== undefined)
        this.knowledge.recordDuration('request', operation, exchange.durationMs);
    }
    this.coverage.actionExecuted(from.stateId, action, success);
    if (action.type === 'check' || action.type === 'select') this.triedOptions.add(optionKey(action));
    this.budget.set('actions', this.actionsExecuted);
  }

  /** Ferme la fenêtre réseau d'une action : ce qu'il faut ajouter à sa FlowEdge. */
  private networkOf(actionId: string): Pick<FlowEdge, 'network' | 'networkWindow'> {
    const trace = this.networkTrace.stop(actionId);
    if (!trace) return {};
    // Les requêtes du flow en cours, pour `expect.response` (plafonnées : un flow ne fait pas des milliers d'appels).
    this.flowNetwork.push(...trace.requests);
    if (this.flowNetwork.length > 500) this.flowNetwork.splice(0, this.flowNetwork.length - 500);
    return {
      network: trace.requests,
      networkWindow: { startedAt: trace.startedAt, finishedAt: trace.finishedAt },
    };
  }

  /** Prochain formulaire de cet état à remplir, si la mission explore les formulaires. */
  private formToExercise(context: PageContext): string | undefined {
    if (!this.config.forms.exercise || !this.config.goals.discoverForms) return undefined;
    return this.forms
      .groupsOf(context)
      .find((group) => !this.formsExercised.has(`${context.stateId}|${group}`));
  }

  /**
   * REMPLIR UN FORMULAIRE → VÉRIFIER SA VALIDATION → ENREGISTRER LA TRANSITION. Rien
   * n'est envoyé : le bouton qui envoie le formulaire est une action comme les autres,
   * soumise à la SafetyPolicy (forms.submit / safety.block).
   */
  private async exerciseForm(
    page: Page,
    from: PageContext,
    group: string,
  ): Promise<{ page: Page; context: PageContext }> {
    this.formsExercised.add(`${from.stateId}|${group}`);
    const actionId = `form-${createHash('sha1').update(`${from.stateId}|${group}`).digest('hex').slice(0, 10)}`;
    this.formActions.set(actionId, group);
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    this.attribution = { actionId };
    this.currentAction = { stateId: from.stateId, actionId };
    const started = Date.now();

    this.networkTrace.start(actionId);
    this.writeGuard.during(from.stateId, actionId, `filling the form "${formName(group, from)}"`);
    const run = await this.forms.fill(page, from, group);
    run.problems = await this.forms.validate(page, run);
    const { forms, propertyTesting } = this.config;
    if (forms.validationTesting && this.budget.allows('validationCases')) {
      run.validationCases = await this.forms.testValidation(page, from, run, {
        maxCasesPerField: forms.maxValidationCasesPerField,
        maxCasesPerForm: Math.min(forms.maxValidationCasesPerForm, this.budget.remaining('validationCases')),
      });
      this.budget.consume('validationCases', run.validationCases.length);
    }
    // PROPERTY TESTING : bornes et partitions d'équivalence depuis les contraintes (DOM + OpenAPI).
    if (propertyTesting.enabled && this.budget.allows('propertyCases')) {
      const constraints = new DomOpenApiConstraintExtractor().extractForm(run.form, this.contract);
      const cases = new OneFactorPropertyTestGenerator().generate(
        run.form,
        constraints,
        Math.min(propertyTesting.maxCasesPerForm, this.budget.remaining('propertyCases')),
      );
      run.propertyCases = await this.forms.testProperties(page, from, run, cases);
      this.budget.consume('propertyCases', run.propertyCases.length);
      for (const failed of run.propertyCases.filter((entry) => entry.verdict === 'FAIL'))
        this.collector.add({
          type: 'FORM_VALIDATION',
          severity: 'WARNING',
          message: `form "${run.name}": valid value refused — ${failed.description}${failed.message ? `: ${failed.message}` : ''}`,
          pageUrl: from.url,
          actionId,
        });
    }
    this.coverage.formExercised(from.stateId, from.forms[0]?.index ?? 0);
    this.formReports.push(formReportOf(run, from.stateId, actionId));
    // Ses champs ont été traités avec le formulaire : pas retentés un par un.
    for (const field of run.fields) this.graph.markTried(from.stateId, field.action.id);
    this.actionsExecuted += 1;
    this.currentAction = undefined;
    for (const problem of run.problems) {
      this.collector.add({
        type: 'FORM_VALIDATION',
        severity: SeverityRules.formValidation(),
        message: validationMessage(run, problem.field, problem.message),
        pageUrl: from.url,
        actionId,
      });
    }

    const after = await this.observeState(page, from.metadata.depth).catch(() => from);
    this.formsExercised.add(`${after.stateId}|${group}`);
    const ids = this.collector
      .all()
      .filter((issue) => !issuesBefore.has(issue.id))
      .map((issue) => issue.id);
    this.collector.assignState(ids, after.stateId, this.graph.flowTo(after.stateId));
    const filled = run.fields.filter((field) => !field.skipped && !field.error).length;
    const action: DiscoveredAction = {
      id: actionId,
      stateId: from.stateId,
      type: 'fill',
      category: 'form-input',
      elementType: 'form',
      text: run.name,
      label: 'form',
      disabled: false,
      visible: true,
      classification: 'SAFE',
      reason: `${filled} field(s) filled, ${run.problems.length} validation message(s), nothing sent`,
      risks: [],
      locator: { strategy: 'css', value: 'form' },
    };
    const failures = run.fields.filter((field) => field.error);
    const edge = this.graph.addEdge({
      from: from.stateId,
      to: after.stateId,
      actionId,
      action: summaryOf(action),
      ...this.networkOf(actionId),
      result: filled === 0 && failures.length > 0 ? 'FAILED' : 'SUCCESS',
      reason:
        failures.length > 0
          ? `${action.reason}; not filled: ${failures.map((field) => `${fieldName(field.action)} (${field.error ?? ''})`).join(', ')}`
          : action.reason,
      durationMs: Date.now() - started,
      issueIds: ids,
    });
    this.graph.attachIssues(after.stateId, ids);
    await this.captureErrorScreenshot(page, after, ids);
    this.listener.onTransition?.(edge, action);
    if (after.stateId !== from.stateId) this.pushState(after);
    return { page, context: { ...after, errors: this.collector.forState(after.stateId) } };
  }

  /** Prépare le formulaire si besoin, puis laisse l'exécuteur agir. */
  private async execute(
    page: Page,
    context: PageContext,
    action: DiscoveredAction,
  ): Promise<ActionExecutionResult> {
    if (action.type === 'click' && this.config.goals.discoverForms)
      await this.prepareForm(page, formFieldsFor(action, context.actions));
    const instruction =
      action.type === 'fill' || action.type === 'select' ? this.testData.instructionFor(action) : undefined;
    // RULE COVERAGE : une liste dont une valeur vérifierait des règles non couvertes reçoit cette valeur (expliquée).
    const ruleValue =
      action.type === 'select' && this.config.rules.enabled
        ? this.coordinator.ruleValueFor(action, context)
        : undefined;
    const value =
      ruleValue ??
      (instruction?.kind === 'fill'
        ? instruction.value
        : instruction?.kind === 'select'
          ? instruction.label
          : undefined);
    this.lastExecutedValue = value;
    // FIELD ACTION DECISION : une valeur existante et valide est GARDÉE (KEEP), un champ calculé OBSERVÉ —
    // jamais écrasé par une option au hasard. Le champ est seulement marqué comme vu.
    if (
      (action.type === 'fill' || action.type === 'select') &&
      instruction?.kind === 'skip' &&
      ruleValue === undefined &&
      /^(KEEP|OBSERVE_ONLY|SKIP_)/.test(instruction.reason)
    )
      return {
        status: 'SUCCESS',
        urlBefore: page.url(),
        urlAfter: page.url(),
        durationMs: 0,
        usedFallback: false,
        openedPopup: false,
      };
    // Compté avant l'exécution : une action qui échoue à mi-chemin a peut-être déjà modifié des données.
    this.safety.recordExecuted(action);
    const run = (): Promise<ActionExecutionResult> =>
      this.executor.execute(page, action, value !== undefined ? { value } : {});
    // Seule une action que la SafetyPolicy a permise ET qui modifie des données peut écrire côté serveur.
    return this.safety.changesData(action) ? this.writeGuard.permit('mutation action', run) : run();
  }

  /**
   * Remplit un formulaire avec des données de test avant de cliquer sur l'un de ses
   * boutons (« Suivant » d'un assistant, recherche…). Chaque champ passe par la
   * SafetyPolicy : les champs sensibles (mots de passe, données de paiement, secrets) ne sont jamais remplis.
   */
  private async prepareForm(page: Page, fields: readonly DiscoveredAction[]): Promise<void> {
    for (const field of fields) {
      if (this.safety.evaluate(field).verdict === 'BLOCK') continue;
      const instruction = this.testData.instructionFor(field);
      if (instruction.kind === 'skip') continue;
      const value =
        instruction.kind === 'fill'
          ? instruction.value
          : instruction.kind === 'select'
            ? instruction.label
            : undefined;
      await this.executor.execute(page, field, value !== undefined ? { value } : {});
    }
  }

  /**
   * Les actions risquées refusées par la SafetyPolicy sont enregistrées BLOCKED tout
   * de suite : les rapports les montrent et aucun moteur ne les propose à nouveau.
   */
  private recordRefusedActions(stateId: string, actions: readonly DiscoveredAction[]): void {
    for (const action of actions) {
      if (action.disabled || !action.visible) continue;
      const verdict = this.safety.evaluate(action);
      if (verdict.verdict === 'BLOCK' && !this.graph.hasTransition(stateId, action.id)) {
        this.graph.recordBlocked(stateId, action, verdict.reason);
        this.coverage.actionBlocked(stateId, action);
      }
    }
  }

  // ---------------------------------------------------------------- dry run

  /**
   * Le DryRunDriver d'un flow : le pipeline habituel, exposé au Dry Run sans rien dupliquer.
   * - probe : SemanticResolver (étapes d'intention) ou localisateur (étapes YAML), sans exécuter ;
   * - perform : runFlowStep (la SafetyPolicy des flows imposés, `allow` de l'étape compris) ;
   * - actions / take : ActionDiscovery, score du moteur de décision, SafetyPolicy de la mission
   *   ET permissions du scénario, puis executeAndObserve (oracles, recovery, garde d'écriture) ;
   * - restore : retour à un état connu (URL, chemin rejoué) ;
   * - knownPaths : graphe du run et mémorisé, KnowledgeBase — proposés, jamais crus sans confirmation.
   */
  private dryRunDriver(
    holder: { page: Page },
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
  ): DryRunDriver {
    const allow = [...new Set(flow.steps.flatMap((step) => step.allow))];
    const seen = new Map<string, PageContext>();
    let current: PageContext | undefined;
    const probeTimeout = Math.min(1_000, this.config.exploration.actionTimeoutMs);
    const stateOf = (context: PageContext): ObservedState => ({
      id: context.stateId,
      signature: stateSignature(context.stateLabel),
      label: context.stateLabel,
      url: context.url,
    });
    const set = (context: PageContext): ObservedState => {
      current = context;
      seen.set(context.stateId, context);
      return stateOf(context);
    };
    const context = (): PageContext => {
      if (!current) throw new Error('dry run: no current state (start() first)');
      return current;
    };
    const done =
      (step: FlowStep, index: number) =>
      (status: FlowStatus, extra: Partial<FlowStepReport> = {}): FlowStepReport => ({
        index,
        kind: step.kind,
        description: describeStep(step),
        optional: step.optional,
        status,
        durationMs: 0,
        ...extra,
      });
    const verdictOf = (action: DiscoveredAction): SafetyVerdict => {
      // Une étape insérée n'est pas écrite par le développeur : la SafetyPolicy de la mission ET les permissions du scénario.
      const mission = this.safety.evaluate(action);
      if (mission.verdict === 'BLOCK') return mission;
      return evaluateFlowAction(this.safety, action, { allow });
    };
    const formFieldsOf = (action: DiscoveredAction, of: PageContext): string[] | undefined => {
      if (!this.config.goals.discoverForms) return undefined;
      const fields = formFieldsFor(action, of.actions)
        .filter(
          (candidate) =>
            this.safety.evaluate(candidate).verdict !== 'BLOCK' &&
            this.testData.instructionFor(candidate).kind !== 'skip',
        )
        .map((candidate) => fieldLabel(candidate));
      return fields.length > 0 ? fields : undefined;
    };
    const semanticOf = (text: string | undefined): string => slug(text ?? '');
    const targetsIn = (of: PageContext, intent: FlowIntent): boolean =>
      intent.type === 'NAVIGATE' || intent.type === 'ASSERT'
        ? semanticOf(of.stateLabel).includes(intent.semanticTarget) ||
          of.headings.some((heading) => semanticOf(heading) === intent.semanticTarget)
        : of.actions.some((action) => semanticOf(actionLabel(action)) === intent.semanticTarget);

    const driver: DryRunDriver = {
      start: async (startAt) => {
        this.flowNetwork = [];
        this.flowRecordedKeys.clear();
        this.scenario = { values: [] };
        this.attribution = {};
        const url = new URL(startAt ?? this.config.target.startAt, this.config.target.baseUrl).toString();
        if (!/^https?:/.test(holder.page.url()) || holder.page.isClosed())
          holder.page = await this.recyclePage(browser, holder.page, observers.all);
        // Déjà sur la page de départ (la mission vient de l'ouvrir) : ne pas la recharger.
        const already = current === undefined && holder.page.url() === url;
        if (!already && !(await this.goto(holder.page, url))) return undefined;
        const observed = await this.observeState(holder.page, 0).catch(() => undefined);
        return observed ? set(observed) : undefined;
      },
      current: () => stateOf(context()),
      probe: async (intent) => {
        const step = intent.step;
        const where = context();
        switch (step.kind) {
          case 'goto': {
            const url = new URL(step.url, this.config.target.baseUrl).toString();
            const verdict = evaluateFlowUrl(this.safety, url);
            return verdict.verdict === 'BLOCK'
              ? { status: 'BLOCKED', target: step.url, reason: verdict.reason, confidence: 1 }
              : { status: 'RESOLVED', target: step.url, reason: 'address', confidence: 1 };
          }
          case 'click':
          case 'check':
          case 'uncheck':
          case 'fill':
          case 'select': {
            const located = await this.flowSteps.locate(holder.page, step.target, probeTimeout);
            return typeof located === 'string'
              ? { status: 'NOT_FOUND', reason: located, confidence: 0 }
              : {
                  status: 'RESOLVED',
                  target: describeTarget(step.target),
                  reason: 'element on the screen',
                  confidence: 0.97,
                };
          }
          case 'expect': {
            const failure = await this.flowSteps.expect(
              holder.page,
              step.expect,
              probeTimeout,
              this.flowNetwork,
            );
            return failure
              ? { status: 'NOT_FOUND', reason: failure, confidence: 0 }
              : {
                  status: 'RESOLVED',
                  target: describeExpectation(step.expect),
                  reason: 'expectation met',
                  confidence: 1,
                };
          }
          case 'intent': {
            const resolver = this.semanticResolver;
            if (!resolver)
              return { status: 'NOT_FOUND', reason: 'gherkin.semanticResolution is disabled', confidence: 0 };
            if (step.intent.kind === 'ASSERT') {
              const checked = await this.runAssertion(
                holder.page,
                step.intent,
                where,
                probeTimeout,
                done(step, intent.index),
              );
              return checked.report.status === 'PASSED'
                ? {
                    status: 'RESOLVED',
                    target: intent.label,
                    reason: checked.report.reason ?? 'verified',
                    confidence: 0.95,
                  }
                : { status: 'NOT_FOUND', reason: checked.report.reason ?? 'not verified', confidence: 0 };
            }
            const resolution = resolver.resolve(step.intent, where, {
              stateSignature: stateSignature(where.stateLabel),
            });
            const selected = this.resolutionReport(resolution).selected;
            const status =
              resolution.status === 'RESOLVED'
                ? 'RESOLVED'
                : resolution.status === 'AMBIGUOUS'
                  ? 'AMBIGUOUS'
                  : resolution.status === 'BLOCKED'
                    ? 'BLOCKED'
                    : 'NOT_FOUND';
            return {
              status,
              ...(selected ? { target: selected } : {}),
              reason: resolution.reasons[0] ?? resolution.status,
              confidence: resolution.score,
            };
          }
          case 'auto':
          case 'manual':
          case 'screenshot':
          case 'dragAndDrop':
            return { status: 'NOT_FOUND', reason: 'interpreted only when performed', confidence: 0 };
        }
      },
      perform: async (intent) => {
        const outcome = await this.runFlowStep(
          holder.page,
          browser,
          observers,
          flow,
          intent.step,
          intent.index,
          context(),
        );
        holder.page = outcome.page;
        const after = outcome.context ?? context();
        const state = set(after);
        const report = outcome.report;
        const status =
          report.status === 'PASSED'
            ? 'PASSED'
            : report.status === 'BLOCKED'
              ? 'BLOCKED'
              : report.status === 'MANUAL'
                ? 'NOT_VERIFIED'
                : 'FAILED';
        return {
          status,
          state,
          ...(report.resolution?.selected ? { target: report.resolution.selected } : {}),
          ...(report.reason ? { reason: report.reason } : {}),
          confidence: report.resolution ? report.resolution.score : status === 'PASSED' ? 0.97 : 0,
        };
      },
      actions: () => {
        const where = context();
        const scores = new Map<string, number>();
        if (this.decisionEngine instanceof RuleBasedDecisionEngine)
          for (const ranked of this.decisionEngine.rank(where, this.graph))
            scores.set(ranked.action.id, ranked.score);
        return where.actions
          .filter((action) => action.visible && !action.disabled)
          .map((action) => {
            const verdict = verdictOf(action);
            const fields = formFieldsOf(action, where);
            return {
              id: action.id,
              signature: actionSignature(action),
              label: actionLabel(action),
              type: action.type,
              category: action.category,
              classification: action.classification,
              ...(action.locator.role ? { role: action.locator.role } : {}),
              ...(action.href ? { href: redactUrl(action.href) } : {}),
              verdict: verdict.verdict === 'BLOCK' ? 'BLOCK' : 'ALLOW',
              reason: verdict.reason,
              score: scores.get(action.id) ?? 0,
              ...(fields ? { formFields: fields } : {}),
            };
          });
      },
      take: async (actionId) => {
        const from = context();
        const action = from.actions.find((candidate) => candidate.id === actionId);
        if (!action) return { status: 'FAILED', state: stateOf(from), reason: 'action not on this screen' };
        // « Ai-je le droit ? » — juste avant Playwright, comme dans l'exploration.
        const verdict = verdictOf(action);
        if (verdict.verdict === 'BLOCK') {
          this.graph.recordBlocked(from.stateId, action, verdict.reason);
          return { status: 'BLOCKED', state: stateOf(from), reason: verdict.reason };
        }
        const formFields = formFieldsOf(action, from);
        try {
          const step = await this.executeAndObserve(holder.page, browser, observers, from, action);
          holder.page = step.page;
          const edge = [...this.graph.allEdges()]
            .reverse()
            .find((candidate) => candidate.from === from.stateId && candidate.actionId === action.id);
          const state = set(step.context);
          if (edge?.result !== 'SUCCESS')
            return {
              status: edge?.result === 'BLOCKED' ? 'BLOCKED' : 'FAILED',
              state,
              reason: edge?.reason ?? 'failed',
            };
          return { status: 'SUCCESS', state, ...(formFields ? { formFields } : {}) };
        } catch (error) {
          if (!(error instanceof NavigationRecoveryError)) throw error;
          this.currentAction = undefined;
          this.graph.markTried(from.stateId, action.id);
          return { status: 'FAILED', state: stateOf(from), reason: error.message };
        }
      },
      restore: async (stateId) => {
        if (current && current.stateId === stateId) return stateOf(current);
        if (!/^https?:/.test(holder.page.url()) || holder.page.isClosed())
          holder.page = await this.recyclePage(browser, holder.page, observers.all);
        // L'historique du navigateur d'abord : dans une application monopage, il ne recharge pas la page.
        const back: PageContext | undefined = await this.restore(holder.page, stateId, true).catch(
          () => undefined,
        );
        return back ? set(back) : undefined;
      },
      knownPaths: (target) => {
        const nodeOf = new Map(this.graph.allNodes().map((node) => [node.id, node]));
        const edges: KnownEdge[] = [];
        for (const edge of this.graph.allEdges()) {
          if (edge.result !== 'SUCCESS' || edge.from === edge.to) continue;
          const from = nodeOf.get(edge.from);
          const to = nodeOf.get(edge.to);
          if (!from || !to) continue;
          edges.push({
            from: stateSignature(from.label),
            action: actionSignature({ ...edge.action, elementType: edge.action.type }),
            to: stateSignature(to.label),
            count: 1,
            source: 'graph',
          });
        }
        if (this.historyAvailable)
          for (const transition of this.knowledge.transitions()) {
            if (transition.actionSignature.startsWith('intent:')) continue;
            for (const [to, count] of Object.entries(transition.targets))
              edges.push({
                from: transition.fromStateSignature,
                action: transition.actionSignature,
                to,
                count,
                source: 'historical',
              });
          }
        const actionTargets = new Set(
          edges
            .filter((edge) => edge.action.split(':')[1] === target.semanticTarget)
            .map((edge) => edge.from),
        );
        const isTarget = (state: string): boolean =>
          target.type === 'NAVIGATE' || target.type === 'ASSERT'
            ? state.includes(target.semanticTarget)
            : actionTargets.has(state);
        return findKnownPaths(edges, stateSignature(context().stateLabel), isTarget, {
          maxDepth: this.config.dryRun.maxDepth,
          maxPaths: this.config.dryRun.maxAlternativePaths,
        });
      },
      seenDuringRun: (target) => [...seen.values()].some((of) => targetsIn(of, target)),
      now: () => Date.now(),
    };
    // ANALYSE STATIQUE : les routes du code comme indices ; jamais un goto vers une route cachée.
    const knowledge = this.staticKnowledge;
    if (knowledge && this.config.staticAnalysis.dryRun.useStaticKnowledge) {
      const paths = new StaticPathResolver(knowledge, this.semantics.dictionary);
      const suggested = new Set<string>();
      driver.staticHints = (target) => {
        if (target.type !== 'NAVIGATE' && target.type !== 'CLICK') return undefined;
        const hint = paths.suggest(pathnameOf(context().url), target.label);
        if (hint && !suggested.has(`${target.id}|${hint.route}`)) {
          suggested.add(`${target.id}|${hint.route}`);
          this.emitStatic(
            'STATIC_PATH_SUGGESTED',
            `"${target.label}": ${hint.description} (confidence ${String(hint.confidence)}, not confirmed)`,
          );
        }
        return hint;
      };
      driver.staticPathOutcome = (hint, confirmed, path) => {
        if (confirmed) {
          hint.runtimeConfirmed = true;
          knowledge.confirmRoute(hint.route);
          this.emitStatic('STATIC_PATH_CONFIRMED', `${hint.description}: ${path.join(' → ')}`);
        } else
          this.emitStatic('STATIC_PATH_REJECTED', `${hint.description}: not confirmed by the application`);
      };
    }
    if (this.historyAvailable)
      driver.historicalObservations = (target) =>
        this.knowledge
          .transitions()
          .filter((transition) => transition.actionSignature.split(':')[1] === target.semanticTarget)
          .reduce((sum, transition) => sum + transition.successCount, 0);
    return driver;
  }

  // ---------------------------------------------------------------- flows imposés

  /** Exécute chaque flow imposé dans l'ordre. Renvoie une raison d'arrêt quand une limite de la mission a mis fin au run. */
  private async runFlows(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
  ): Promise<{ page: Page; stopReason?: StopReason }> {
    for (const flow of this.config.flows) {
      const limit = this.limitReached();
      if (limit) {
        this.skipFlows(`mission limit reached (${limit})`);
        return { page, stopReason: limit };
      }
      const run = await this.runFlow(page, browser, observers, flow);
      page = run.page;
      if (run.stopReason) {
        this.skipFlows(`mission limit reached (${run.stopReason})`);
        return { page, stopReason: run.stopReason };
      }
    }
    return { page };
  }

  /** Signale SKIPPED chaque flow pas encore exécuté. */
  private skipFlows(reason: string): void {
    const done = new Set(this.flowReports.map((report) => report.name));
    for (const flow of this.config.flows) {
      if (done.has(flow.name)) continue;
      const report: FlowRunReport = {
        name: flow.name,
        ...(flow.description ? { description: flow.description } : {}),
        status: 'SKIPPED',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        steps: flow.steps.map((step, position) => skippedStep(step, position + 1, reason)),
        states: [],
        issueIds: [],
        explored: false,
      };
      this.flowReports.push(report);
      this.listener.onFlowEnd?.(report);
    }
  }

  private async runFlow(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
  ): Promise<{ page: Page; stopReason?: StopReason }> {
    const started = Date.now();
    const report: FlowRunReport = {
      name: flow.name,
      ...(flow.description ? { description: flow.description } : {}),
      status: 'PASSED',
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      steps: [],
      states: [],
      issueIds: [],
      explored: false,
    };
    this.flowReports.push(report);
    this.currentFlowReport = report;
    this.pendingLearning = undefined;
    this.flowNetwork = [];
    this.stepContexts = [];
    this.previousStepStatus = undefined;
    this.filledOnScreen = [];
    this.flowRecordedKeys.clear();
    this.scenario = { values: [] };
    this.listener.onFlowStart?.(flow);
    this.cognitive?.learnFlow(flow);
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    const knownStates = new Set(this.graph.allNodes().map((node) => node.id));
    let stopReason: StopReason | undefined;

    // Chaque flow part d'une page fraîchement chargée.
    const flowStart = new URL(
      flow.startAt ?? this.config.target.startAt,
      this.config.target.baseUrl,
    ).toString();
    if (!/^https?:/.test(page.url()) || page.isClosed())
      page = await this.recyclePage(browser, page, observers.all);
    this.attribution = {};
    let context: PageContext | undefined;
    if (await this.goto(page, flowStart)) {
      context = await this.observeState(page, flowStart === this.startUrl ? 0 : 1).catch(() => undefined);
    }
    if (context) report.states.push(context.stateId);

    let stopped: string | undefined = context ? undefined : `start page ${flowStart} could not be loaded`;
    if (stopped) {
      report.status = 'FAILED';
      await this.flowIssue(flow, undefined, stopped, false, page);
    }
    for (const [position, step] of flow.steps.entries()) {
      const index = position + 1;
      if (stopped !== undefined || !context) {
        const skipped = skippedStep(step, index, stopped ?? 'flow stopped');
        report.steps.push(skipped);
        this.listener.onFlowStep?.(flow, skipped);
        continue;
      }
      const limit = this.limitReached();
      if (limit) {
        stopReason = limit;
        stopped = `mission limit reached (${limit})`;
        const skipped = skippedStep(step, index, stopped);
        report.steps.push(skipped);
        this.listener.onFlowStep?.(flow, skipped);
        continue;
      }

      const networkMark = this.flowNetwork.length;
      const contextBefore = functionalContextOf(this.lastSnapshot);
      const outcome = await this.runFlowStep(page, browser, observers, flow, step, index, context);
      this.stepContexts.push({
        index,
        description: outcome.report.description,
        ...('target' in step
          ? {
              target: {
                ...((step.fingerprint?.role ?? step.target.role)
                  ? { role: step.fingerprint?.role ?? step.target.role }
                  : {}),
                ...((step.fingerprint?.name ?? step.target.name ?? step.target.value)
                  ? { name: step.fingerprint?.name ?? step.target.name ?? step.target.value }
                  : {}),
              },
            }
          : {}),
        ...(contextBefore ? { before: contextBefore } : {}),
        ...(functionalContextOf(this.lastSnapshot) ? { after: functionalContextOf(this.lastSnapshot) } : {}),
      });
      const understood = this.understandStep(step, outcome.report, this.flowNetwork.slice(networkMark));
      if (understood?.class === 'UNKNOWN_FAILURE')
        await this.adviseFailure(page, outcome.report, [...report.steps, outcome.report]);
      page = outcome.page;
      context = outcome.context ?? context;
      report.steps.push(outcome.report);
      // RECOVERY LEARNING : une récupération n'est apprise que si le parcours CONTINUE ensuite.
      const pending = this.pendingRecovery();
      if (pending && pending.index < index && outcome.report.status !== 'MANUAL') {
        this.pendingLearning = undefined;
        const continued = outcome.report.status === 'PASSED';
        pending.report.nextActionVerified = continued;
        this.learnRecovery({ ...pending.input, result: continued ? 'SUCCESS' : 'FAILURE' });
      }
      this.listener.onFlowStep?.(flow, outcome.report);
      if (outcome.report.stateId && report.states[report.states.length - 1] !== outcome.report.stateId) {
        report.states.push(outcome.report.stateId);
      }
      if (outcome.report.status === 'FAILED' || outcome.report.status === 'BLOCKED') {
        await this.flowIssue(flow, outcome.report, outcome.report.reason ?? '', step.optional, page, context);
        if (!step.optional) {
          report.status = outcome.report.status;
          stopped = `step ${index} ${outcome.report.status.toLowerCase()}`;
          // REPLAY DIVERGENCE : la première étape qui diverge, et le dernier point de reprise fiable.
          if (this.config.replay.detectFirstDivergence && !report.divergence) {
            const confirmed = report.steps
              .filter((candidate) => candidate.effect?.status === 'CONFIRMED')
              .at(-1);
            // SYMPTÔME ≠ CAUSE : une étape antérieure dont l'effet a changé est la vraie divergence.
            const root = report.steps.find(
              (candidate) =>
                candidate.effect?.deferred === true &&
                candidate.index > (confirmed?.index ?? 0) &&
                candidate.index < index,
            );
            const cause = outcome.report.recovery?.divergence;
            report.divergence = {
              stepIndex: root?.index ?? index,
              description: root?.description ?? outcome.report.description,
              reason: root
                ? `${root.reason ?? 'expected effect changed'} → reported at step ${String(index)}: ${outcome.report.reason ?? outcome.report.status}`
                : (outcome.report.reason ?? outcome.report.status),
              ...(confirmed ? { lastConfirmedStep: confirmed.index } : {}),
              ...(root ? { symptomStep: index } : {}),
              ...(cause
                ? {
                    probableCause: root
                      ? { category: 'WRONG_WORKFLOW_STATE', confidence: Math.max(0.6, cause.confidence) }
                      : { category: cause.category, confidence: cause.confidence },
                  }
                : {}),
            };
          }
        }
      }
      await this.memory.save(this.graph);
    }

    // Explorer le dernier écran du flow (souvent atteignable seulement par le flow).
    if (report.status === 'PASSED' && flow.thenExplore && context && !stopReason) {
      report.explored = true;
      this.stack = [{ stateId: context.stateId, url: context.url }];
      const exhaustedBefore = new Set(this.exhausted);
      const loop = await this.explorationLoop(page, browser, observers, context, scopeOf(context.url));
      page = loop.page;
      this.allowJump = true;
      // « Plus rien » voulait dire « plus rien dans le périmètre » : l'exploration autonome peut encore aller plus loin.
      for (const stateId of [...this.exhausted])
        if (!exhaustedBefore.has(stateId)) this.exhausted.delete(stateId);
      if (loop.stopReason !== 'exhausted' && loop.stopReason !== 'engine-stop') stopReason = loop.stopReason;
    } else if (!flow.thenExplore) {
      // Les états que seul le flow atteint ne sont pas explorés en autonomie ensuite.
      for (const stateId of report.states) if (!knownStates.has(stateId)) this.exhausted.add(stateId);
    }

    // RUNTIME LEARNING : une valeur enregistrée réutilisée telle quelle, puis un 409 (déjà existant) →
    // une suggestion tracée (jamais une modification silencieuse du flow ou du jeu de données).
    const conflict = this.flowNetwork.find((exchange) => exchange.status === 409);
    if (conflict && this.flowRecordedKeys.size > 0) {
      report.testDataSuggestions = [...this.flowRecordedKeys].map(
        (key) =>
          `testData.${key}: RECORDED_LITERAL → GENERATE_AT_REPLAY (${conflict.method} answered 409: the recorded value probably exists already)`,
      );
      for (const suggestion of report.testDataSuggestions)
        this.listener.onTestData?.({
          at: new Date().toISOString(),
          event: 'TEST_DATA_STRATEGY_CANDIDATE',
          message: suggestion,
        });
    }
    // Fin du parcours sans étape suivante : l'objectif atteint suffit pour apprendre.
    const unconfirmed = this.pendingRecovery();
    if (unconfirmed) {
      this.learnRecovery({ ...unconfirmed.input, result: 'SUCCESS' });
      this.pendingLearning = undefined;
    }
    // PLANS : enregistré (connu), courant (depuis l'état atteint), réparé (récupérations confirmées).
    this.cognitive?.planFlow(flow, report.steps, (action) => {
      if (action.kind !== 'click' && action.kind !== 'check') return { allowed: true, reason: 'field input' };
      const verdict = this.judgeRecovery(
        { role: action.role ?? 'button', name: action.label, visible: true, disabled: false },
        action.kind,
      );
      return { allowed: verdict.allowed, reason: verdict.reason };
    });
    // FIRST FUNCTIONAL DIVERGENCE, puis : l'objectif est-il bloqué pour une raison inconnue ?
    if (this.cognitive) {
      this.cognitive.recordFlow(flow.name, report.steps);
      this.cognitive.blockedGoal();
      if (this.ai && !page.isClosed()) {
        await this.adviseBlockedGoal(page, flow.name);
        await this.adviseContradictedHypotheses();
      }
    }
    // FLOW DRIFT : le flow marche-t-il encore tel quel, ou seulement grâce au self-healing ?
    const healing = this.config.replay.intelligentRecovery;
    if (healing.enabled && healing.detectFlowDrift) {
      const drift = detectFlowDrift(report.status, report.steps);
      report.drift = drift;
      if (drift.detected)
        this.emitHealing(
          'FLOW_DRIFT_DETECTED',
          `flow "${flow.name}": ${drift.classification} (${drift.result}) — exact ${String(drift.facts.exactActions)}, healed ${String(drift.facts.locatorHealedActions)}, goal recovered ${String(drift.facts.goalRecoveredActions)}, inserted ${String(drift.facts.insertedRuntimeActions)}`,
        );
      if (healing.suggestFlowUpdates && drift.flowUpdateSuggested) {
        const files = await this.writeSuggestedFlow(flow, report).catch(() => undefined);
        if (files) {
          drift.suggestedFiles = files;
          this.emitHealing(
            'SUGGESTED_FLOW_UPDATE_CREATED',
            `flow "${flow.name}": ${files.map((file) => path.basename(file)).join(', ')} (original unchanged)`,
          );
        }
      }
    }
    this.currentFlowReport = undefined;
    report.durationMs = Date.now() - started;
    report.issueIds = this.collector
      .all()
      .filter((issue) => !issuesBefore.has(issue.id))
      .map((issue) => issue.id);
    this.listener.onFlowEnd?.(report);
    return stopReason ? { page, stopReason } : { page };
  }

  /** Une étape : trouver → classer → SafetyPolicy → exécuter → observer → enregistrer. */
  private async runFlowStep(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
    step: FlowStep,
    index: number,
    context: PageContext,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    const started = Date.now();
    // La position de l'étape : l'étape suivante est la précondition à vérifier après celle-ci.
    this.stepPosition = { flow, index };
    const timeout = step.timeoutMs ?? this.config.exploration.actionTimeoutMs;
    const base = { index, kind: step.kind, description: describeStep(step), optional: step.optional };
    const done = (status: FlowStatus, extra: Partial<FlowStepReport> = {}): FlowStepReport => ({
      ...base,
      status,
      durationMs: Date.now() - started,
      ...extra,
    });

    switch (step.kind) {
      case 'expect': {
        const failure = await this.flowSteps.expect(page, step.expect, timeout, this.flowNetwork);
        return {
          page,
          report: failure
            ? done('FAILED', {
                reason: `expectation not met: ${failure}`,
                stateId: context.stateId,
                url: context.url,
              })
            : done('PASSED', { stateId: context.stateId, url: redactUrl(page.url()) }),
        };
      }
      case 'auto':
        return this.runAutoStep(page, browser, observers, flow, step, context, timeout, done);
      case 'intent':
        return this.runIntentStep(page, browser, observers, flow, step, context, timeout, done);
      case 'manual':
        // Le robot ne sait pas le vérifier : noté pour une personne, le flow continue.
        return {
          page,
          report: done('MANUAL', {
            reason: `to check manually: ${step.text}`,
            stateId: context.stateId,
            url: context.url,
          }),
        };
      case 'screenshot': {
        const file = await this.screenshots.captureState(
          page,
          this.graph.nodeCount,
          `${flow.name}-${step.label}`,
          'flow',
        );
        return {
          page,
          report: done('PASSED', {
            stateId: context.stateId,
            url: context.url,
            ...(file ? { screenshot: file } : {}),
          }),
        };
      }
      case 'goto': {
        const url = new URL(step.url, this.config.target.baseUrl).toString();
        const verdict = evaluateFlowUrl(this.safety, url);
        if (verdict.verdict === 'BLOCK') {
          return { page, report: done('BLOCKED', { reason: verdict.reason, stateId: context.stateId }) };
        }
        const actionId = `flow:${flow.name}:${index}`;
        this.attribution = { actionId };
        if (!/^https?:/.test(page.url()) || page.isClosed())
          page = await this.recyclePage(browser, page, observers.all);
        this.currentAction = { stateId: context.stateId, actionId, flow: flow.name };
        const gotoMark = this.interactions.mark();
        const reached = await this.goto(page, url);
        const gotoBlocking = this.interactions.blockingSince(gotoMark);
        this.currentAction = undefined;
        if (gotoBlocking.length > 0) {
          return {
            page,
            report: done('BLOCKED', { reason: blockingReason(gotoBlocking), stateId: context.stateId }),
          };
        }
        if (!reached) {
          return {
            page,
            report: done('FAILED', {
              reason: `navigation to ${redactUrl(url)} failed`,
              stateId: context.stateId,
            }),
          };
        }
        this.actionsExecuted += 1;
        const after = await this.observeState(page, context.metadata.depth + 1);
        this.graph.addEdge({
          from: context.stateId,
          to: after.stateId,
          actionId,
          action: {
            type: 'navigate',
            category: 'navigation',
            classification: 'SAFE',
            href: redactUrl(url),
            text: step.url,
          },
          result: 'SUCCESS',
          durationMs: Date.now() - started,
          flow: flow.name,
        });
        return {
          page,
          context: after,
          report: done('PASSED', { stateId: after.stateId, url: after.url, classification: 'SAFE' }),
        };
      }
      case 'fill':
      case 'select': {
        // flow.yaml et Gherkin convergent : un champ que le libellé ne trouve pas (aucun
        // <label>) est résolu comme l'intention équivalente, avec les preuves statiques.
        const semantic = await this.semanticFallback(
          page,
          browser,
          observers,
          flow,
          step,
          context,
          timeout,
          done,
        );
        if (semantic) return semantic;
        return this.runFlowElementStep(page, browser, observers, flow, step, context, timeout, done);
      }
      case 'click':
      case 'check':
      case 'uncheck':
        return this.runFlowElementStep(page, browser, observers, flow, step, context, timeout, done);
      case 'dragAndDrop':
        return this.runDragStep(page, flow, step, context, timeout, done);
    }
  }

  /**
   * DRAG_AND_DROP, action de premier ordre : la SafetyPolicy décide d'abord (le texte de l'élément
   * déplacé est classé comme un clic) ; une écriture déclenchée par le dépôt reste soumise au
   * garde des écritures. Réussi seulement si ITEM_MOVED est observé ; un glisser exécuté sans
   * déplacement est ACTION_EFFECT_MISMATCH (jamais un succès technique pris pour un succès).
   */
  private async runDragStep(
    page: Page,
    flow: FlowConfig,
    step: Extract<FlowStep, { kind: 'dragAndDrop' }>,
    context: PageContext,
    timeout: number,
    done: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    const label = `drag ${step.item}`;
    const classification = this.safety.classify({ type: 'click', category: 'other', text: step.item });
    const action: DiscoveredAction = {
      id: `flow-drag:${context.stateId}:${step.item}`,
      stateId: context.stateId,
      type: 'click',
      category: 'other',
      elementType: 'element',
      text: label,
      disabled: false,
      visible: true,
      ...classification,
      locator: { strategy: 'text', value: step.item },
    };
    const verdict = evaluateFlowAction(this.safety, action, { allow: step.allow, valueFromEnv: false });
    if (verdict.verdict === 'BLOCK')
      return {
        page,
        context,
        report: done('BLOCKED', {
          reason: verdict.reason,
          stateId: context.stateId,
          url: context.url,
          classification: action.classification,
        }),
      };
    this.attribution = { actionId: action.id };
    this.currentAction = { stateId: context.stateId, actionId: action.id, flow: flow.name };
    const interactionMark = this.interactions.mark();
    this.networkTrace.start(action.id);
    this.writeGuard.during(context.stateId, action.id, `flow "${flow.name}" step "${label}"`);
    const mayWrite = step.allow.some((allowed) => allowed === 'MUTATION' || allowed === 'DANGEROUS');
    const effectTimeout = Math.max(this.config.replay.effectTimeoutMs, 500);
    const perform = (): Promise<DragOutcome> =>
      this.flowSteps.dragAndDrop(page, step, timeout, effectTimeout);
    const outcome = mayWrite ? await this.writeGuard.permit(`flow ${flow.name}`, perform) : await perform();
    this.actionsExecuted += 1;
    this.currentAction = undefined;
    const blocking = this.interactions.since(interactionMark).filter((interaction) => interaction.blocking);
    const after = await this.observeState(page, context.metadata.depth + 1).catch(() => context);
    const moved = outcome.status === 'MOVED';
    const executed = moved || outcome.status === 'NOT_MOVED';
    this.graph.addEdge({
      from: context.stateId,
      to: after.stateId,
      actionId: action.id,
      action: summaryOf(action),
      ...this.networkOf(action.id),
      result: blocking.length > 0 ? 'BLOCKED' : moved ? 'SUCCESS' : 'FAILED',
      ...(moved ? {} : { reason: outcome.reason }),
      flow: flow.name,
    });
    const effect = {
      execution: executed ? ('EXECUTED' as const) : ('FAILED' as const),
      status: moved
        ? ('CONFIRMED' as const)
        : executed
          ? ('NO_EFFECT' as const)
          : ('TARGET_MISMATCH' as const),
      expected: [`ITEM_MOVED "${step.item}" → ${describeDropZone(step.to)}`],
      observed: outcome.membership
        ? [
            `destination: ${outcome.membership.destinationItems.join(', ') || '(empty)'}`,
            ...(outcome.membership.sourceItems.length > 0
              ? [`source: ${outcome.membership.sourceItems.join(', ')}`]
              : []),
          ]
        : [],
      reasons: [outcome.reason, ...outcome.evidence, ...(outcome.mode ? [`drag mode ${outcome.mode}`] : [])],
      recovery: [],
    };
    if (blocking.length > 0)
      return {
        page,
        context: after,
        report: done('BLOCKED', { reason: blockingReason(blocking), stateId: after.stateId, effect }),
      };
    return {
      page,
      context: after,
      report: done(moved ? 'PASSED' : 'FAILED', {
        ...(moved ? {} : { reason: outcome.reason }),
        stateId: after.stateId,
        url: after.url,
        classification: action.classification,
        effect,
      }),
    };
  }

  private async semanticFallback(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
    step: Extract<FlowStep, { kind: 'fill' | 'select' }>,
    context: PageContext,
    timeout: number,
    done: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport } | undefined> {
    if (!this.config.staticAnalysis.enabled || !this.semanticResolver) return undefined;
    const name =
      step.target.strategy === 'label' || step.target.strategy === 'text'
        ? step.target.value
        : step.target.name;
    if (!name) return undefined;
    const located = await this.flowSteps.locate(page, step.target, Math.min(1_000, timeout));
    if (typeof located !== 'string') return undefined;
    const intentStep: Extract<FlowStep, { kind: 'intent' }> = {
      kind: 'intent',
      intent:
        step.kind === 'fill'
          ? { kind: 'FILL', field: name, value: step.value }
          : { kind: 'SELECT', field: name, option: step.option },
      allow: step.allow,
      optional: step.optional,
      ...(step.name ? { name: step.name } : {}),
    };
    const outcome = await this.runIntentStep(
      page,
      browser,
      observers,
      flow,
      intentStep,
      context,
      timeout,
      done,
    );
    return {
      ...outcome,
      report: {
        ...outcome.report,
        interpretation: `no element labelled "${name}": resolved as an intent${outcome.report.interpretation ? ` · ${outcome.report.interpretation}` : ''}`,
      },
    };
  }

  // ---------------------------------------------------------------- analyse statique

  /**
   * Suit les scripts que le navigateur reçoit (chunks à la demande compris). Seules
   * des adresses sont gardées ; les scripts sont relus plus tard, et seulement s'ils
   * viennent d'un hôte autorisé.
   */
  private watchScripts(page: Page): void {
    const settings = this.config.staticAnalysis;
    if (!settings.enabled || !settings.sourceMaps.discoverFromRuntime || settings.mode === 'source') return;
    const context = page.context();
    if (this.watchedContexts.has(context)) return;
    this.watchedContexts.add(context);
    context.on('response', (response) => {
      if (!isScriptResponse(response)) return;
      const url = response.url();
      if (this.staticRuntime) this.staticRuntime.observe(url);
      else if (this.observedScripts.size < 1000) this.observedScripts.add(url);
    });
  }

  /**
   * Charge une fois la connaissance statique ; ensuite, si des chunks ont été chargés
   * depuis (routes à la demande), le workspace s'enrichit et l'analyse est refaite.
   * Jamais une dépendance : un échec rend undefined, le run continue.
   */
  private ensureStaticKnowledge(page?: Page): Promise<StaticKnowledge | undefined> {
    if (!this.config.staticAnalysis.enabled) return Promise.resolve(undefined);
    if (page) this.watchScripts(page);
    const remember = (knowledge: StaticKnowledge | undefined): StaticKnowledge | undefined => {
      this.staticKnowledge = knowledge;
      if (knowledge) this.cognitive?.learnStatic(knowledge.graph);
      return knowledge;
    };
    if (!this.staticLoading)
      this.staticLoading = this.loadStaticKnowledge(page)
        .catch((error: unknown) => {
          this.emitStatic(
            'STATIC_ANALYSIS_UNAVAILABLE',
            `static analysis failed: ${(error as Error).message}`,
          );
          this.staticWarnings.push(redactText(`static analysis failed: ${(error as Error).message}`));
          return undefined;
        })
        .then(remember);
    else if (this.config.staticAnalysis.sourceMaps.incrementalChunks && this.staticDiscovery?.hasPending())
      this.staticLoading = this.staticLoading
        .then((current) =>
          this.enrichStaticKnowledge(current).catch((error: unknown) => {
            this.staticWarnings.push(redactText(`static enrichment failed: ${(error as Error).message}`));
            return current;
          }),
        )
        .then(remember);
    return this.staticLoading;
  }

  private async loadStaticKnowledge(page?: Page): Promise<StaticKnowledge | undefined> {
    const settings = this.config.staticAnalysis;
    const analyzer = new StaticApplicationAnalyzer(
      staticAnalyzerOptionsOf(this.config, this.env, (event, message) => {
        this.emitStatic(event, message);
      }),
    );
    this.staticAnalyzer = analyzer;
    // GIT préparé (`qa-crawler sources`) : la connaissance est lue telle quelle — aucun git, aucune analyse.
    const git = settings.source.enabled && !settings.source.root && settings.source.git.length > 0;
    if (git && settings.source.gitFetch === 'command') {
      const prepared = await readPreparedKnowledge(this.config);
      if (prepared.status === 'READY') {
        this.emitStatic('GIT_SOURCE_PREPARED', describePrepared(prepared.knowledge));
        return this.knowledgeOf({ graph: prepared.knowledge.graph, cache: 'HIT' });
      }
      this.emitStatic('GIT_SOURCE_NOT_PREPARED', prepared.reason);
      this.staticWarnings.push(prepared.reason);
    }
    const root = settings.source.enabled
      ? (settings.source.root ??
        (git && settings.source.gitFetch === 'run' ? await this.gitSourceRoot() : undefined))
      : undefined;
    // SOURCE : le dépôt seul, lu exactement comme avant.
    if (settings.mode === 'source') {
      if (!root) {
        this.staticUnavailable('no source (staticAnalysis.source.root)');
        return undefined;
      }
      return this.knowledgeOf(await analyzer.analyzeSource(root));
    }
    const strategy = settings.mode;
    const runtime =
      page && settings.bundle.enabled
        ? new RuntimeBundleSourceProvider({
            fetch: playwrightFetcher(page),
            // Lire le code : les hôtes de navigation, et ceux des scripts autorisés en lecture seule.
            isAllowedUrl: (url) => {
              const host = new URL(url).hostname;
              return (
                this.safety.navigation.isAllowedHost(host) ||
                settings.bundle.allowedHosts.some((pattern) => hostMatches(host, pattern))
              );
            },
            sourceMaps: {
              enabled: strategy !== 'bundle' && settings.sourceMaps.enabled && settings.bundle.sourceMaps,
              inline: settings.sourceMaps.inline,
              external: settings.sourceMaps.external,
            },
            bundleFallback: strategy === 'bundle' || settings.bundleFallback.enabled,
            budgets: {
              maxBundles: settings.budgets.maxBundles,
              maxSourceMaps: settings.budgets.maxSourceMaps,
              maxSourceMapBytes: settings.budgets.maxSourceMapBytes,
              maxFileSizeBytes: settings.budgets.maxFileSizeBytes,
            },
            onEvent: (event, message) => {
              this.emitStatic(event, message);
            },
          })
        : undefined;
    if (runtime && page) {
      for (const url of [...(await runtimeScriptUrls(page)), ...this.observedScripts]) runtime.observe(url);
      this.observedScripts.clear();
    }
    const discovery = new StaticSourceDiscovery({
      strategy,
      ...(root ? { repository: new RepositorySourceProvider(root, settings.budgets) } : {}),
      ...(runtime ? { runtime } : {}),
      workspace: {
        maxExtractedSources: settings.budgets.maxExtractedSources,
        maxFileSizeBytes: settings.budgets.maxFileSizeBytes,
      },
      settingsKey: JSON.stringify([settings.sourceMaps, settings.bundleFallback, settings.bundle]),
      onEvent: (event, message) => {
        this.emitStatic(event, message);
      },
    });
    this.staticDiscovery = discovery;
    this.staticRuntime = runtime;
    this.emitStatic('STATIC_ANALYSIS_STARTED', `source discovery (${strategy})`);
    await discovery.prepare();
    const alias = discovery.alias();
    const cached = alias ? await analyzer.cachedByAlias(alias) : undefined;
    if (cached) return this.knowledgeOf(cached);
    await discovery.complete();
    if (discovery.workspace.size === 0) {
      this.staticUnavailable(
        root || runtime
          ? 'no readable source: repository empty, no source map and no bundle from an allowed host'
          : 'no source (staticAnalysis.source.root) and no bundle to read',
      );
      return undefined;
    }
    return this.knowledgeOf(
      await analyzer.analyzeSet(discovery.workspace.toSourceSet(), discovery.analysisMode(), {
        ...(alias ? { alias } : {}),
      }),
    );
  }

  /** Chunks chargés depuis la dernière analyse : workspace enrichi, analyse refaite, confirmations gardées. */
  private async enrichStaticKnowledge(
    current: StaticKnowledge | undefined,
  ): Promise<StaticKnowledge | undefined> {
    const discovery = this.staticDiscovery;
    const analyzer = this.staticAnalyzer;
    if (!discovery || !analyzer || !(await discovery.enrich())) return current;
    const alias = discovery.alias();
    const next = this.knowledgeOf(
      await analyzer.analyzeSet(discovery.workspace.toSourceSet(), discovery.analysisMode(), {
        ...(alias ? { alias } : {}),
      }),
    );
    if (!next) return current;
    for (const field of current?.confirmedFields() ?? []) {
      const [component, control] = field.split('#');
      if (control) next.confirm(control, component);
    }
    for (const route of current?.graph.routes ?? [])
      if (route.truth === 'RUNTIME_CONFIRMED') next.confirmRoute(route.path);
    return next;
  }

  /**
   * GIT SOURCE (`gitFetch: run`) : sans `source.root`, les dépôts `staticAnalysis.source.git` sont clonés
   * (lecture seule) ou mis à jour, une fois par run ; leur racine devient celle du dépôt. Un échec n'arrête rien.
   */
  private gitSource: Promise<string | undefined> | undefined;
  private gitSourceRoot(): Promise<string | undefined> {
    const source = this.config.staticAnalysis.source;
    if (source.git.length === 0) return Promise.resolve(undefined);
    this.gitSource ??= fetchGitSources({
      repositories: source.git,
      directory: gitDirectoryOf(this.config),
      env: this.env,
      timeoutMs: source.gitTimeoutMs,
    }).then((result) => {
      for (const repo of result.repositories)
        this.emitStatic(
          repo.status === 'FAILED' ? 'GIT_SOURCE_FAILED' : 'GIT_SOURCE_FETCHED',
          repo.status === 'FAILED'
            ? `${repo.url} (${repo.ref}): ${repo.reason ?? 'failed'}`
            : `${repo.url} (${repo.ref}) ${repo.status.toLowerCase()} at ${repo.commit ?? '?'}`,
        );
      for (const note of result.notes.filter((entry) => !entry.startsWith('GIT_SOURCE_FAILED')))
        this.emitStatic('GIT_SOURCE_FETCHED', note);
      return result.root;
    });
    return this.gitSource;
  }

  private staticUnavailable(reason: string): void {
    this.emitStatic('STATIC_ANALYSIS_UNAVAILABLE', reason);
    this.staticWarnings.push(reason);
    return undefined;
  }

  private knowledgeOf(outcome: StaticAnalysisOutcome): StaticKnowledge | undefined {
    this.staticCache = outcome.cache;
    if (outcome.graph.coverage === 'UNAVAILABLE') {
      this.staticWarnings.push(...outcome.graph.warnings);
      return undefined;
    }
    const vocabulary = this.semanticResolver?.vocabulary ?? new SemanticVocabulary(this.semantics.dictionary);
    const knowledge = new StaticKnowledge(
      outcome.graph,
      (text) => vocabulary.conceptOf(text)?.concept,
      this.contract,
    );
    this.coordinator.useStaticKnowledge(knowledge);
    return knowledge;
  }

  /** Les preuves statiques d'un champ, pour le résolveur (index en mémoire, jamais l'AST). */
  private staticEvidenceFor(
    url: string,
  ): ((field: FieldDescriptor) => readonly FieldProvenance[]) | undefined {
    const knowledge = this.staticKnowledge;
    if (!knowledge || !this.config.staticAnalysis.semanticResolution.enabled) return undefined;
    const pathname = pathnameOf(url);
    return (field) => knowledge.provenanceFor(field.frameworkName, pathname);
  }

  /**
   * Chaque champ observé qui porte un formControlName reçoit ce que le code en dit :
   * concept (données de test), propriété d'API et validateurs (contraintes). Des preuves,
   * pas des vérités : l'exécution reste juge.
   */
  private annotateStatic(actions: readonly DiscoveredAction[], url: string): void {
    if (this.staticKnowledge) annotateStaticFields(this.staticKnowledge, actions, pathnameOf(url));
  }

  /** Un champ prouvé par le code, rempli sans erreur : RUNTIME_CONFIRMED. */
  private confirmStatic(action: DiscoveredAction, url: string, reasons: readonly string[]): void {
    const knowledge = this.staticKnowledge;
    const control = action.field?.frameworkName;
    if (!knowledge || !control) return;
    const usedStatic = reasons.some((reason) => reason.includes('static evidence means'));
    knowledge.confirm(control, knowledge.componentAt(pathnameOf(url)));
    if (usedStatic)
      this.emitStatic('SEMANTIC_EVIDENCE_ADDED', `formControlName="${control}" confirmed at runtime`);
    for (const conflict of reasons.filter((reason) => reason.includes('SEMANTIC_EVIDENCE_CONFLICT')))
      this.emitStatic('SEMANTIC_EVIDENCE_CONFLICT', conflict);
  }

  private emitStatic(event: StaticAnalysisEvent, message: string): void {
    this.listener.onStaticAnalysis?.({ at: new Date().toISOString(), event, message: redactText(message) });
  }

  /**
   * MODE AUTOMATIQUE : la phrase est interprétée sur l'écran courant (auto-step.ts), puis
   * exécutée avec les étapes ordinaires — même localisation, même SafetyPolicy, même garde
   * d'écriture. Ce qui n'est pas sûr devient « À VÉRIFIER », jamais une action devinée.
   */
  private async runAutoStep(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
    step: Extract<FlowStep, { kind: 'auto' }>,
    context: PageContext,
    timeout: number,
    done: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    const plan = planAutoStep(step.sentence, step.type, context.actions);
    const where = { stateId: context.stateId, url: context.url };
    const targetOf = (action: DiscoveredAction): FlowTarget => ({ ...action.locator });
    const common = { allow: step.allow, optional: false };

    switch (plan.kind) {
      case 'manual':
        return {
          page,
          report: done('MANUAL', { reason: `not understood automatically: ${plan.reason}`, ...where }),
        };
      case 'verify': {
        const checks: string[] = [];
        const failures: string[] = [];
        const check = async (label: string, expectation: FlowExpectation): Promise<void> => {
          checks.push(label);
          const failure = await this.flowSteps.expect(page, expectation, timeout, this.flowNetwork);
          if (failure) failures.push(failure);
        };
        for (const text of plan.texts) await check(`text "${text}"`, { text });
        for (const text of plan.hidden)
          await check(`no text "${text}"`, { hidden: { strategy: 'text', value: text } });
        if (plan.noError) await check('no error message', { noError: true });
        if (plan.lastWriteOk) {
          const write = this.flowNetwork.filter((exchange) => exchange.method !== 'GET').at(-1);
          if (write) {
            checks.push(`last write ${write.method} answered 2xx`);
            if (write.status === undefined || Math.floor(write.status / 100) !== 2)
              failures.push(
                `last write ${write.method} ${new URL(write.url).pathname} answered ${write.status ?? write.failure ?? 'nothing'}`,
              );
          }
        }
        const interpretation = `check ${checks.join(', ')}`;
        return {
          page,
          report:
            failures.length > 0
              ? done('FAILED', {
                  reason: `expectation not met: ${failures.join('; ')}`,
                  interpretation,
                  ...where,
                })
              : done('PASSED', { interpretation, ...where }),
        };
      }
      case 'field': {
        const target = targetOf(plan.field);
        const concrete: Extract<FlowStep, { target: unknown }> =
          plan.action === 'fill'
            ? { ...common, kind: 'fill', target, value: plan.value }
            : plan.action === 'select'
              ? { ...common, kind: 'select', target, option: plan.value }
              : { ...common, kind: plan.action, target };
        const outcome = await this.runFlowElementStep(
          page,
          browser,
          observers,
          flow,
          concrete,
          context,
          timeout,
          done,
        );
        const interpretation =
          plan.action === 'fill' && plan.field.risks.includes('sensitive-data')
            ? describeStep(concrete, true)
            : describeStep(concrete);
        return { ...outcome, report: { ...outcome.report, interpretation } };
      }
      case 'navigate': {
        // Chaque nom cité, dans l'ordre de la phrase ; un nom pas encore à l'écran (la section d'un
        // panneau fermé) est réessayé après les clics suivants.
        let current = context;
        let remaining = [...plan.mentions];
        const steps: string[] = [];
        for (let progress = true; remaining.length > 0 && progress;) {
          progress = false;
          for (const mention of remaining) {
            const found = findByName(current.actions, mention);
            const onScreen =
              !found &&
              [current.title, ...current.headings, ...current.dialogs].some(
                (text) => normalizeText(text) === normalizeText(mention.text),
              );
            if (!found && !onScreen) continue;
            remaining = remaining.filter((other) => other !== mention);
            progress = true;
            if (!found || found.selected) {
              steps.push(`"${mention.text}" already shown`);
              break;
            }
            const click: Extract<FlowStep, { target: unknown }> = {
              ...common,
              kind: 'click',
              target: targetOf(found),
            };
            const outcome = await this.runFlowElementStep(
              page,
              browser,
              observers,
              flow,
              click,
              current,
              timeout,
              done,
            );
            page = outcome.page;
            current = outcome.context ?? current;
            steps.push(`click ${found.role ?? found.type} "${actionLabel(found)}"`);
            if (outcome.report.status !== 'PASSED')
              return { ...outcome, report: { ...outcome.report, interpretation: steps.join(' → ') } };
            break;
          }
        }
        const interpretation = steps.join(' → ');
        if (remaining.length > 0) {
          const names = current.actions
            .filter(
              (action) =>
                action.visible && !action.disabled && (action.type === 'click' || action.type === 'navigate'),
            )
            .map((action) => actionLabel(action))
            .slice(0, 15);
          return {
            page,
            context: current,
            report: done('FAILED', {
              reason: `not found on the screen: ${remaining.map((mention) => `"${mention.text}"`).join(', ')}`,
              ...(interpretation ? { interpretation } : {}),
              onScreen: names,
              stateId: current.stateId,
              url: current.url,
            }),
          };
        }
        return {
          page,
          context: current,
          report: done('PASSED', { interpretation, stateId: current.stateId, url: current.url }),
        };
      }
    }
  }

  /**
   * RÉSOLUTION SÉMANTIQUE : l'intention de la phrase (« FILL prénom ») est résolue sur
   * l'écran courant (SemanticResolver : candidats, scores, ambiguïté), puis exécutée comme
   * une étape ordinaire — même localisation, même SafetyPolicy, même garde d'écriture.
   * Ambigu ou introuvable : l'étape échoue avec l'explication, jamais une cible devinée.
   */
  private async runIntentStep(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
    step: Extract<FlowStep, { kind: 'intent' }>,
    context: PageContext,
    timeout: number,
    done: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    const where = { stateId: context.stateId, url: context.url };
    const intent = step.intent;
    const resolver = this.semanticResolver;
    if (!resolver)
      return { page, report: done('MANUAL', { reason: 'gherkin.semanticResolution is disabled', ...where }) };
    if (intent.kind === 'ASSERT') return this.runAssertion(page, intent, context, timeout, done);
    const signature = stateSignature(context.stateLabel);
    const history = this.semanticHistory(signature);
    // ON_DEMAND : l'analyse statique n'est lancée que si la résolution en a besoin (un champ
    // sans libellé porte un formControlName), puis la phrase est résolue à nouveau.
    if (
      this.config.staticAnalysis.enabled &&
      (!this.staticKnowledge || this.staticDiscovery?.hasPending()) &&
      (intent.kind === 'FILL' || intent.kind === 'SELECT' || intent.kind === 'FILL_FORM') &&
      context.actions.some((action) => action.field?.frameworkName !== undefined)
    ) {
      const probe = resolver.resolve(intent, context, {
        stateSignature: signature,
        ...(history ? { history } : {}),
      });
      if (probe.status !== 'RESOLVED' && (await this.ensureStaticKnowledge(page)))
        this.annotateStatic(context.actions, context.url);
    }
    const staticEvidence = this.staticEvidenceFor(context.url);
    const resolution = resolver.resolve(intent, context, {
      ...(staticEvidence ? { staticEvidence } : {}),
      stateSignature: signature,
      ...(history ? { history } : {}),
      ...(this.scenario.formGroup ? { previousFormGroup: this.scenario.formGroup } : {}),
      // L'explication cite la phrase, jamais les valeurs saisies.
      ...(step.name
        ? {
            sentence:
              intent.kind === 'FILL' || intent.kind === 'FILL_FORM'
                ? step.name.replace(/"[^"]*"|«[^»]*»|“[^”]*”/g, '"…"')
                : step.name,
          }
        : {}),
      ...(intent.kind === 'FILL' && typeof intent.value !== 'string' && 'env' in intent.value
        ? { sensitiveValue: true }
        : {}),
    });
    const report = this.resolutionReport(resolution);
    const common = { allow: step.allow, optional: false };
    const targetOf = (action: DiscoveredAction): FlowTarget => ({ ...action.locator });
    const interpretation = resolution.explanation.slice(0, 4).join(' · ');

    const emit = (
      outcome: SemanticOutcome,
      extra: {
        intentKey?: string;
        targetSignature?: string;
        selected?: string;
        score?: number;
        reason?: string;
      } = {},
    ): void =>
      this.listener.onSemanticResolution?.({
        at: new Date().toISOString(),
        flow: flow.name,
        stateId: context.stateId,
        stateSignature: signature,
        intentKey: extra.intentKey ?? resolution.intentKey,
        intent: resolution.description,
        outcome,
        ...((extra.targetSignature ?? resolution.targetSignature)
          ? { targetSignature: extra.targetSignature ?? resolution.targetSignature }
          : {}),
        ...((extra.selected ?? report.selected) ? { selected: extra.selected ?? report.selected } : {}),
        score: extra.score ?? resolution.score,
        confidence: resolution.confidence,
        candidates: report.candidates,
        ...(extra.reason ? { reason: extra.reason } : {}),
      });

    if (resolution.status !== 'RESOLVED' || !resolution.target) {
      const reason = `${failureCode(intent, resolution.status)}: ${resolution.reasons[0] ?? 'not resolved'}`;
      emit(
        resolution.status === 'AMBIGUOUS'
          ? 'AMBIGUOUS'
          : resolution.status === 'BLOCKED'
            ? 'BLOCKED'
            : 'NOT_FOUND',
        { reason },
      );
      return {
        page,
        report: done(resolution.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED', {
          reason,
          interpretation,
          resolution: report,
          onScreen: resolution.candidates.map((candidate) => `${candidate.label} (${candidate.score})`),
          ...where,
        }),
      };
    }
    const target = resolution.target;
    const run = async (
      concrete: Extract<FlowStep, { target: unknown }>,
      current: PageContext,
      currentPage: Page,
    ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> =>
      this.runFlowElementStep(currentPage, browser, observers, flow, concrete, current, timeout, done);
    const finish = (outcome: { page: Page; context?: PageContext; report: FlowStepReport }) => {
      if (target.kind === 'action' || target.kind === 'field')
        emit(outcome.report.status === 'PASSED' ? 'SUCCEEDED' : 'FAILED', {
          ...(outcome.report.reason ? { reason: outcome.report.reason } : {}),
        });
      return { ...outcome, report: { ...outcome.report, interpretation, resolution: report } };
    };

    switch (target.kind) {
      case 'here':
        return { page, report: done('PASSED', { interpretation, resolution: report, ...where }) };
      case 'action':
        return finish(
          await run({ ...common, kind: 'click', target: targetOf(target.action) }, context, page),
        );
      case 'field': {
        const field = target.field;
        // FIELD ACTION DECISION d'une valeur imposée par le scénario : FILL, REPLACE (EXPLICIT_SCENARIO_VALUE)
        // sur une valeur déjà présente — « je sélectionne France » sur « Canada » —, ou KEEP si elle y est déjà.
        const decision = decideFieldAction(fieldStateOfFormField(fieldOf(field.action)), {
          preserveExisting: this.config.forms.preserveExistingValues,
          explicit:
            target.operation === 'select'
              ? { option: target.option ?? '' }
              : intent.kind === 'FILL' && typeof intent.value === 'string'
                ? { digest: valueDigest(intent.value, this.valueSalt) }
                : 'any',
        });
        const decided = `${decision.decision} (${decision.reason})`;
        const concrete: Extract<FlowStep, { target: unknown }> =
          target.operation === 'fill' && intent.kind === 'FILL'
            ? { ...common, kind: 'fill', target: targetOf(field.action), value: intent.value }
            : target.operation === 'select'
              ? { ...common, kind: 'select', target: targetOf(field.action), option: target.option ?? '' }
              : {
                  ...common,
                  kind: target.operation === 'uncheck' ? 'uncheck' : 'check',
                  target: targetOf(field.action),
                };
        const outcome = await run(concrete, context, page);
        if (outcome.report.status === 'PASSED') {
          this.remember(field, intent);
          this.confirmStatic(field.action, context.url, resolution.reasons);
        }
        const finished = finish(outcome);
        return {
          ...finished,
          report: {
            ...finished.report,
            interpretation: `${finished.report.interpretation} · ${decided}`,
          },
        };
      }
      case 'form': {
        let current = context;
        let currentPage = page;
        const done_: string[] = [];
        for (const mapping of target.plan.mappings) {
          const action = targetOf(mapping.field.action);
          const concrete: Extract<FlowStep, { target: unknown }> =
            mapping.operation === 'fill'
              ? { ...common, kind: 'fill', target: action, value: mapping.value }
              : mapping.operation === 'select'
                ? {
                    ...common,
                    kind: 'select',
                    target: action,
                    option: mapping.option ?? (typeof mapping.value === 'string' ? mapping.value : ''),
                  }
                : { ...common, kind: mapping.operation, target: action };
          const outcome = await run(concrete, current, currentPage);
          currentPage = outcome.page;
          current = outcome.context ?? current;
          done_.push(`"${mapping.intent}" → "${mapping.target}" ${mapping.confidence}`);
          emit(outcome.report.status === 'PASSED' ? 'SUCCEEDED' : 'FAILED', {
            intentKey: mapping.intentKey,
            targetSignature: mapping.targetSignature,
            selected: mapping.target,
            score: mapping.confidence,
          });
          if (outcome.report.status !== 'PASSED')
            return finish({
              ...outcome,
              report: {
                ...outcome.report,
                reason: `"${mapping.intent}": ${outcome.report.reason ?? outcome.report.status}`,
              },
            });
          if (mapping.operation === 'fill')
            this.remember(mapping.field, { kind: 'FILL', field: mapping.intent, value: mapping.value });
          else this.scenario.formGroup = mapping.field.formGroup ?? this.scenario.formGroup;
        }
        return {
          page: currentPage,
          context: current,
          report: done('PASSED', {
            interpretation: done_.join(' · '),
            resolution: report,
            stateId: current.stateId,
            url: current.url,
          }),
        };
      }
      case 'synthetic-form': {
        const plan = await new ValidDataFillStrategy(this.testData, this.safety, this.runId).fill(
          target.form,
          context,
        );
        let current = context;
        let currentPage = page;
        const filled: string[] = [];
        for (const operation of plan.operations) {
          if (operation.operation === 'skip') continue;
          const field = target.form.fields.find((entry) => entry.id === operation.fieldId);
          if (!field) continue;
          const locator: FlowTarget = { ...field.locator };
          const concrete: Extract<FlowStep, { target: unknown }> =
            operation.operation === 'fill'
              ? { ...common, kind: 'fill', target: locator, value: operation.value ?? '' }
              : operation.operation === 'select'
                ? { ...common, kind: 'select', target: locator, option: operation.value ?? '' }
                : { ...common, kind: operation.operation, target: locator };
          const outcome = await run(concrete, current, currentPage);
          currentPage = outcome.page;
          current = outcome.context ?? current;
          filled.push(`${field.label ?? field.name ?? field.id} (${operation.source ?? 'type'})`);
          if (outcome.report.status !== 'PASSED') return finish(outcome);
        }
        this.scenario.formGroup = target.form.group;
        return {
          page: currentPage,
          context: current,
          report: done('PASSED', {
            interpretation: `form "${target.form.name}": ${filled.length} field(s) with synthetic data — ${filled.join(', ')}`,
            resolution: report,
            stateId: current.stateId,
            url: current.url,
          }),
        };
      }
    }
  }

  /**
   * « Alors … » résolu sans sélecteur : la page (titres, adresse), un message (alerte,
   * statut, notification), les valeurs saisies pendant le scénario, ou la dernière
   * écriture. Preuve faible ou ambiguë : À VÉRIFIER, jamais un PASS.
   */
  private async runAssertion(
    page: Page,
    intent: Extract<GherkinIntent, { kind: 'ASSERT' }>,
    context: PageContext,
    timeout: number,
    done: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    const where = { stateId: context.stateId, url: context.url };
    const plan = this.assertions.plan(intent, context, this.scenario);
    let verdict: AssertionVerdict;
    let reasons: string[];
    switch (plan.kind) {
      case 'decided':
        ({ verdict, reasons } = plan);
        break;
      case 'message': {
        const deadline = Date.now() + Math.min(timeout, 5_000);
        let texts: string[] = [];
        for (;;) {
          texts = (
            await page
              .locator(MESSAGE_SELECTOR)
              .allInnerTexts()
              .catch(() => [])
          )
            .map((text) => text.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          if (texts.some((text) => classifyMessage(text) !== undefined) || Date.now() >= deadline) break;
          await page.waitForTimeout(200);
        }
        const kinds = texts.map((text) => classifyMessage(text));
        const found = kinds.includes('error')
          ? 'error'
          : kinds.includes('confirmation')
            ? 'confirmation'
            : undefined;
        const shown = texts.slice(0, 3).map((text) => `"${redactText(text).slice(0, 80)}"`);
        if (plan.expect === 'any')
          [verdict, reasons] =
            texts.length > 0
              ? ['PASSED', [`message ${shown.join(', ')}`]]
              : ['FAILED', ['no message displayed']];
        else if (found === plan.expect)
          [verdict, reasons] = ['PASSED', [`${found} message ${shown.join(', ')}`]];
        else if (found) [verdict, reasons] = ['FAILED', [`${found} message instead: ${shown.join(', ')}`]];
        else if (texts.length > 0)
          [verdict, reasons] = ['MANUAL', [`message(s) of unknown kind: ${shown.join(', ')}`]];
        else [verdict, reasons] = ['FAILED', [`no ${plan.expect} message displayed`]];
        break;
      }
      case 'texts': {
        const visible = new Set<string>();
        for (const value of plan.values) {
          const failure = await this.flowSteps.expect(
            page,
            { text: value },
            Math.min(timeout, 3_000),
            this.flowNetwork,
          );
          if (!failure) visible.add(value);
        }
        ({ verdict, reasons } = judgeTexts(plan, visible));
        break;
      }
      case 'write': {
        const write = this.flowNetwork.filter((exchange) => exchange.method !== 'GET').at(-1);
        if (!write) {
          [verdict, reasons] = ['MANUAL', ['no write request observed during the scenario']];
          break;
        }
        const path = new URL(write.url).pathname;
        if (write.status === undefined || Math.floor(write.status / 100) !== 2) {
          [verdict, reasons] = [
            'FAILED',
            [`${write.method} ${path} answered ${write.status ?? write.failure ?? 'nothing'}`],
          ];
          break;
        }
        const error = await this.flowSteps.expect(
          page,
          { noError: true },
          Math.min(timeout, 2_000),
          this.flowNetwork,
        );
        [verdict, reasons] = error
          ? ['FAILED', [`${write.method} ${path} answered ${write.status}, but ${error}`]]
          : ['PASSED', [`${write.method} ${path} answered ${write.status}, no error message`]];
        break;
      }
    }
    const resolution: SemanticResolutionReport = {
      status: verdict === 'MANUAL' ? 'AMBIGUOUS' : 'RESOLVED',
      intent: describeIntent(intent),
      score: verdict === 'MANUAL' ? 0.5 : 1,
      confidence: verdict === 'MANUAL' ? 'MEDIUM' : 'VERY_HIGH',
      reasons,
      candidates: [],
      ...(this.config.gherkin.semanticResolution.explain
        ? {
            explanation: [
              'ASSERTION',
              `Intent: ${describeIntent(intent)}`,
              `Verdict: ${verdict}`,
              ...reasons.map((reason) => `  ${reason}`),
            ],
          }
        : {}),
    };
    return {
      page,
      report: done(verdict, {
        ...(verdict !== 'PASSED'
          ? {
              reason: `${verdict === 'MANUAL' ? 'to check manually' : 'expectation not met'}: ${reasons.join('; ')}`,
            }
          : {}),
        interpretation: `${describeIntent(intent)} → ${verdict}: ${reasons.join('; ')}`,
        resolution,
        ...where,
      }),
    };
  }

  /**
   * L'historique des résolutions pour cet écran (gherkin.semanticResolution.historicalKnowledge) :
   * la KnowledgeBase EN MÉMOIRE, notée par le ConfidenceEngine — jamais une requête au stockage.
   */
  private semanticHistory(stateSignatureOf: string): KnowledgeSemanticHistory | undefined {
    if (!this.config.gherkin.semanticResolution.historicalKnowledge) return undefined;
    this.semanticEngine ??=
      confidenceEngineOf(this.config) ??
      new DeterministicConfidenceEngine({
        sampleHalfPoint: this.config.intelligence.confidence.sampleHalfPoint,
        aging: { halfLifeDays: this.config.knowledge.halfLifeDays, minWeight: 0.05 },
      });
    return new KnowledgeSemanticHistory(
      this.knowledge,
      stateSignatureOf,
      this.semanticEngine,
      knowledgeContextOf(this.config, this.knowledge.identity),
    );
  }

  /** Le formulaire du scénario, et les valeurs non sensibles saisies (pour « … apparaît dans la liste »). */
  private remember(
    field: { formGroup?: string; sensitive: boolean; type: string; label?: string; name?: string },
    intent: GherkinIntent,
  ): void {
    if (field.formGroup) this.scenario.formGroup = field.formGroup;
    if (
      intent.kind !== 'FILL' ||
      typeof intent.value !== 'string' ||
      field.sensitive ||
      intent.value.trim().length < 2 ||
      this.scenario.values.length >= 20
    )
      return;
    const vocabulary = this.semanticResolver?.vocabulary;
    const concept =
      vocabulary?.conceptOf(field.label)?.concept ??
      vocabulary?.conceptOf(field.name)?.concept ??
      vocabulary?.conceptOf(intent.field)?.concept;
    const identity = concept ? IDENTITY_CONCEPTS[concept] : undefined;
    this.scenario.values.push({ text: intent.value.trim(), ...(identity ? { identity } : {}) });
  }

  private resolutionReport(resolution: SemanticResolution): SemanticResolutionReport {
    const selected = resolution.explanation
      .find((line) => line.startsWith('Status: '))
      ?.match(/→ "(.*)" ·/)?.[1];
    return {
      status: resolution.status,
      intent: resolution.description,
      ...(selected ? { selected } : {}),
      score: resolution.score,
      confidence: resolution.confidence,
      ...(resolution.valueType ? { valueType: resolution.valueType } : {}),
      reasons: resolution.reasons.slice(0, 12),
      candidates: resolution.candidates
        .slice(0, 5)
        .map((candidate) => ({ label: candidate.label, score: candidate.score })),
      ...(this.config.gherkin.semanticResolution.explain ? { explanation: resolution.explanation } : {}),
    };
  }

  private async runFlowElementStep(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    flow: FlowConfig,
    step: Extract<FlowStep, { target: unknown }>,
    context: PageContext,
    timeout: number,
    finish: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport,
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    let done = finish;
    const replay = this.config.replay;
    const verifying =
      replay.verifyActionEffects && ['click', 'check', 'uncheck', 'select'].includes(step.kind);
    const effect: StepEffectReport = {
      execution: 'NOT_EXECUTED',
      status: 'NOT_VERIFIED',
      expected: [],
      observed: [],
      reasons: [],
      locator: describeTarget(step.target),
      recovery: [],
    };
    // WORKFLOW SELF-HEALING : une étape qui diverge est analysée (cause, objectif, chemin sûr)
    // avant d'être déclarée en échec. Rien de tout cela ne s'exécute quand l'étape réussit.
    const diverged = (
      symptom: DivergenceSymptom,
      failure: { page: Page; context?: PageContext; report: FlowStepReport },
    ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> => {
      // FIRST FUNCTIONAL DIVERGENCE ≠ écran pas encore prêt : juste après une transition qui n'a jamais
      // fini (TIMEOUT, écran instable), une cible absente est un problème TEMPOREL, dit comme tel.
      const previous = this.lastTransition;
      if (
        (symptom === 'TARGET_NOT_FOUND' || symptom === 'TARGET_MISMATCH') &&
        previous?.status === 'TIMEOUT' &&
        failure.report.reason &&
        !failure.report.reason.startsWith('TRANSITION_TIMEOUT')
      )
        failure.report.reason = `TRANSITION_TIMEOUT (${transitionTimeoutText(previous, 'the previous step')}) — ${failure.report.reason}`;
      return this.healDivergence(symptom, failure, {
        browser,
        observers,
        flow,
        step,
        context,
        timeout,
        finish: (status, extra) => done(status, extra),
      });
    };
    // AVANT de localiser la cible courante (une résolution par section remplace les marques posées) :
    // la cible de l'étape suivante est-elle déjà là, et déjà prête ?
    const next = verifying && replay.verifyNextActionPrecondition ? this.nextStepTarget() : undefined;
    const nextBefore = next ? await this.targetAvailable(page, next, 150) : undefined;
    const sync = this.synchronizationOn() ? replay.synchronization : undefined;
    const nextStep = sync?.useNextActionAsCheckpoint ? this.nextFlowStep() : undefined;
    const nextReadyBefore = nextStep ? (await this.nextReadiness(page, nextStep)).ready : undefined;
    // « Où est-il ? » — et est-ce bien LUI ? (un CSS structurel peut viser un autre élément)
    // Une cible désignée DANS UNE LIGNE (row: colonne → valeur) : la ligne fait foi. Aucune réparation par
    // l'empreinte ne peut la remplacer par l'élément d'une autre ligne (l'ordre du tableau a pu changer).
    const fingerprint = step.target.row ? undefined : step.fingerprint;
    let located: Locator | string | undefined;
    let resolution: TargetResolutionTrace | undefined;
    let reacquiredTarget: string | undefined;
    if (
      fingerprint &&
      replay.locatorHealing &&
      replay.locator.preferSemantic &&
      isFragileTarget(step.target)
    ) {
      const healed = await this.healTarget(page, step.target, fingerprint, Math.min(timeout, 3000));
      if (healed) {
        located = healed.locator;
        effect.healed = { from: describeTarget(step.target), to: describeTarget(healed.target) };
        effect.locator = describeTarget(healed.target);
        effect.targetMatch = healed.match;
      }
    }
    // Un CSS ambigu n'est jamais exécuté sur sa première correspondance : seule la résolution par
    // l'empreinte (ci-dessous) peut départager ; sans elle, le localisateur est strict.
    const disambiguated =
      fingerprint !== undefined &&
      replay.functionalTargetResolution.enabled &&
      replay.functionalTargetResolution.resolveNonUniqueLocators &&
      step.target.nth === undefined &&
      step.target.section === undefined;
    located ??= await this.flowSteps.locate(page, step.target, timeout, { strict: !disambiguated });
    // LOCATOR ≠ TARGET IDENTITY : un localisateur qui désigne PLUSIEURS éléments n'est qu'un générateur
    // de candidats. Jamais « le premier qui correspond » : le contexte (empreinte, fenêtre, champ,
    // parcours) départage ; une ambiguïté reste une ambiguïté (aucun choix arbitraire).
    let contextual = false;
    if (
      typeof located !== 'string' &&
      !effect.healed &&
      // Une étape enregistrée (empreinte) ; un flow écrit à la main garde ses règles (fenêtre ouverte d'abord).
      fingerprint !== undefined &&
      replay.functionalTargetResolution.enabled &&
      replay.functionalTargetResolution.resolveNonUniqueLocators &&
      step.target.nth === undefined &&
      step.target.section === undefined
    ) {
      // Seules les correspondances VISIBLES peuvent être confondues (une copie cachée ne l'est jamais).
      const rawMatches = await toLocator(page, step.target)
        .evaluateAll(
          (elements) =>
            elements.filter((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return (
                (rect.width > 0 || rect.height > 0) &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              );
            }).length,
        )
        .catch(() => 1);
      if (rawMatches > 1) {
        this.emitHealing(
          'TARGET_LOCATOR_NON_UNIQUE',
          `${step.kind} ${describeTarget(step.target)}: ${String(rawMatches)} elements match the recorded locator`,
        );
        const resolved = await this.resolveFunctionalTarget(
          page,
          flow,
          step,
          fingerprint,
          { reasons: [`${String(rawMatches)} elements match the recorded locator`] },
          located,
          'LOCATOR_NON_UNIQUE',
          rawMatches,
        );
        // AMBIGUOUS : plusieurs candidats aussi plausibles — jamais un choix arbitraire, rien d'exécuté.
        // Aucun candidat convaincant : le chemin strict habituel (empreinte vérifiée, healing) décide.
        if (resolved.locator || resolved.trace.outcome === 'AMBIGUOUS') {
          resolution = resolved.trace;
          const base = done;
          done = (status, extra) => base(status, { ...extra, targetResolution: resolved.trace });
        }
        if (resolved.trace.outcome === 'AMBIGUOUS')
          return diverged('TARGET_MISMATCH', {
            page,
            report: done('FAILED', {
              reason: `TARGET_LOCATOR_NON_UNIQUE: ${String(rawMatches)} elements match ${describeTarget(step.target)} — ${resolved.trace.outcome ?? resolved.trace.status}: ${resolved.trace.reason} (nothing chosen arbitrarily, not executed)${step.kind === 'fill' ? ' — FIELD_IDENTITY_AMBIGUOUS' : ''}`,
              stateId: context.stateId,
              url: context.url,
              effect: { ...effect, status: 'TARGET_MISMATCH', reasons: [resolved.trace.reason] },
            }),
          });
        // Aucun candidat ne porte l'identité enregistrée : jamais « le premier qui correspond ». Un
        // localisateur sémantique retrouvé par l'empreinte (healing) peut encore la désigner ; sinon rien
        // n'est exécuté (un FILL dans le mauvais champ est pire qu'un échec expliqué).
        if (!resolved.locator) {
          const healed = replay.locatorHealing
            ? await this.healTarget(page, step.target, fingerprint, Math.min(timeout, 3000))
            : undefined;
          if (!healed)
            return diverged('TARGET_MISMATCH', {
              page,
              report: done('FAILED', {
                reason: `TARGET_LOCATOR_NON_UNIQUE: ${String(rawMatches)} elements match ${describeTarget(step.target)} — no candidate carries the recorded identity: ${resolved.trace.reason} (nothing chosen arbitrarily, not executed)${step.kind === 'fill' ? ' — FIELD_LOCATOR_NON_UNIQUE' : ''}`,
                stateId: context.stateId,
                url: context.url,
                effect: { ...effect, status: 'TARGET_MISMATCH', reasons: [resolved.trace.reason] },
              }),
            });
          located = healed.locator;
          effect.healed = { from: describeTarget(step.target), to: describeTarget(healed.target) };
          effect.locator = describeTarget(healed.target);
          effect.targetMatch = healed.match;
        }
        if (resolved.locator && resolved.chosen) {
          located = resolved.locator;
          contextual = true;
          effect.locator = resolved.chosen.cssHint ?? describeTarget(step.target);
          effect.targetMatch = { verdict: 'CONTEXTUAL_MATCH', score: resolved.chosen.score };
          effect.reasons = [...effect.reasons, `CONTEXTUAL_MATCH among ${String(rawMatches)} candidates`];
        }
      }
    }
    // CSS REPLAY : le CSS PRÉFÉRÉ enregistré est vérifié sur le DOM ACTUEL (jamais réutilisé aveuglément).
    if (typeof located !== 'string' && fingerprint?.css) {
      const css = await this.cssResolutionOf(page, located, fingerprint.css);
      if (css) {
        const base = done;
        done = (status, extra) => base(status, { ...extra, cssResolution: css });
        this.emitHealing(
          css.resolution === 'CSS_CONFIRMED' ? 'LOCATOR_UNIQUE' : 'LOCATOR_AMBIGUOUS',
          `${step.kind} ${describeTarget(step.target)}: preferred css ${css.recordedPreferred} — recorded ${String(css.recordedMatches ?? '?')} match(es), current ${String(css.currentMatches)} → ${css.resolution}`,
        );
      }
    }
    if (
      typeof located !== 'string' &&
      fingerprint &&
      replay.targetFingerprintMatching &&
      !effect.healed &&
      !contextual
    ) {
      // Un élément re-rendu entre la localisation et la lecture se relit (au plus deux fois) :
      // une lecture ratée n'est jamais la preuve qu'il s'agit d'un autre élément.
      let observed = await readTarget(located);
      for (let retry = 0; retry < 2 && observed.tag === undefined; retry++) {
        await page.waitForTimeout(250);
        const again = await this.flowSteps.locate(page, step.target, Math.min(timeout, 1500));
        if (typeof again === 'string') break;
        located = again;
        observed = await readTarget(again);
      }
      const identifiable = Boolean(fingerprint.name ?? fingerprint.text ?? fingerprint.testId);
      if (observed.tag === undefined && !identifiable) {
        // Aucune identité enregistrée à comparer, élément illisible : rien ne prouve un mauvais élément.
        effect.targetMatch = { verdict: 'WEAK_MATCH', score: 0.4 };
        effect.reasons = [
          ...effect.reasons,
          'target identity not verifiable (no recorded name; element re-rendered)',
        ];
      }
      let match =
        observed.tag === undefined && !identifiable
          ? { verdict: 'WEAK_MATCH' as const, score: 0.4, reasons: [] as string[] }
          : matchFingerprint(fingerprint, observed);
      // RERENDER : la cible a peut-être été lue PENDANT un rendu (ancien nœud, nouveau nœud à venir).
      // Re-observer après stabilisation, re-résoudre sur le DOM frais, relire l'empreinte — avant
      // toute conclusion de mismatch (et avant tout conseiller : un rendu lent n'est pas une ambiguïté).
      if (
        match.verdict === 'MISMATCH' &&
        this.synchronizationOn() &&
        replay.synchronization.reacquireAfterRerender
      ) {
        const reacquired = await this.reacquireAfterRerender(page, step.target, fingerprint, timeout);
        if (reacquired) {
          located = reacquired.locator;
          match = reacquired.match;
          effect.reasons = [...effect.reasons, 'TARGET_REACQUIRED_AFTER_RERENDER'];
          reacquiredTarget = `${describeTarget(step.target)} (${match.verdict} ${String(match.score)})`;
        }
      }
      effect.targetMatch = { verdict: match.verdict, score: match.score };
      if (match.verdict === 'MISMATCH' && replay.locator.rejectFingerprintMismatch) {
        const healed = replay.locatorHealing
          ? await this.healTarget(page, step.target, fingerprint, Math.min(timeout, 3000))
          : undefined;
        // FINGERPRINT MISMATCH != AUTOMATIC FAILURE : l'élément qui remplit la MÊME FONCTION dans le
        // même contexte du parcours (re-rendu Angular, nouveau nœud) — prouvé ensuite par l'effet.
        const functional =
          !healed && replay.functionalTargetResolution.enabled
            ? await this.resolveFunctionalTarget(
                page,
                flow,
                step,
                fingerprint,
                { score: match.score, reasons: match.reasons },
                typeof located === 'string' ? undefined : located,
              )
            : undefined;
        if (functional) {
          resolution = functional.trace;
          const base = done;
          done = (status, extra) => base(status, { ...extra, targetResolution: functional.trace });
        }
        if (!healed && !functional?.locator) {
          // FOUND ELEMENT != CORRECT ELEMENT : ne jamais cliquer une cible qui n'est pas la bonne.
          // Illisible après relecture : la cible n'est pas là de façon stable (pas un « autre élément »).
          return diverged(observed.tag === undefined ? 'TARGET_NOT_FOUND' : 'TARGET_MISMATCH', {
            page,
            report: done('FAILED', {
              reason: `TARGET_FINGERPRINT_MISMATCH: expected "${fingerprint.name ?? fingerprint.text ?? fingerprint.testId ?? fingerprint.label ?? ''}", found ${match.reasons.join('; ')} (not clicked)${functional ? ` — ${functional.trace.status}: ${functional.trace.reason}` : ''}`,
              stateId: context.stateId,
              url: context.url,
              effect: { ...effect, status: 'TARGET_MISMATCH', reasons: match.reasons },
            }),
          });
        }
        if (healed) {
          located = healed.locator;
          effect.healed = { from: describeTarget(step.target), to: describeTarget(healed.target) };
          effect.locator = describeTarget(healed.target);
          effect.targetMatch = healed.match;
        } else if (functional?.locator && functional.chosen) {
          located = functional.locator;
          effect.healed = {
            from: describeTarget(step.target),
            to: `${functional.trace.status} ${functional.chosen.id}: ${candidateSummary(functional.chosen)}`,
          };
          effect.locator = functional.chosen.cssHint ?? describeTarget(step.target);
          effect.targetMatch = { verdict: functional.trace.status, score: functional.chosen.score };
        }
      }
    }
    if (typeof located === 'string' && fingerprint && replay.locatorHealing) {
      const healed = await this.healTarget(page, step.target, fingerprint, Math.min(timeout, 3000));
      if (healed) {
        located = healed.locator;
        effect.healed = { from: describeTarget(step.target), to: describeTarget(healed.target) };
        effect.locator = describeTarget(healed.target);
        effect.targetMatch = healed.match;
      }
    }
    // HEALING CONTEXTUEL : le localisateur enregistré ne trouve plus rien, l'empreinte simple non plus.
    // Les candidats de l'écran sont comparés à l'identité contextualisée (rôle, libellé, champ, fenêtre,
    // parcours) ; le healing n'est APPRIS qu'après confirmation par l'effet runtime.
    if (
      typeof located === 'string' &&
      fingerprint &&
      replay.locatorHealing &&
      replay.functionalTargetResolution.enabled &&
      step.target.section === undefined
    ) {
      this.emitHealing('TARGET_HEALING_REQUESTED', `${step.kind} ${describeTarget(step.target)}: ${located}`);
      const healed = await this.resolveFunctionalTarget(
        page,
        flow,
        step,
        fingerprint,
        { reasons: [located] },
        undefined,
        'LOCATOR_NOT_FOUND',
        0,
      );
      if (healed.locator && healed.chosen) {
        resolution = healed.trace;
        const base = done;
        done = (status, extra) => base(status, { ...extra, targetResolution: healed.trace });
        located = healed.locator;
        effect.healed = {
          from: describeTarget(step.target),
          to: `${healed.trace.outcome ?? 'HEALED'} ${healed.chosen.id}: ${candidateSummary(healed.chosen)}`,
        };
        effect.locator = healed.chosen.cssHint ?? describeTarget(step.target);
        effect.targetMatch = { verdict: 'HEALED', score: healed.chosen.score };
      }
    }
    // Un nom accessible trouvé par correspondance PARTIELLE (« Company information » dans
    // « Remove company information ») : la correspondance exacte d'abord ; sinon, si l'élément
    // trouvé n'est pas le même genre d'action (SAFE ≠ DANGEROUS), ce n'est pas la bonne cible.
    if (
      typeof located !== 'string' &&
      replay.intelligentRecovery.enabled &&
      step.target.strategy === 'role' &&
      step.target.name &&
      step.target.exact !== true
    ) {
      const expectedName = step.target.name;
      const found = await readTarget(located).catch(() => undefined);
      if (found?.name && normalizeControl(found.name) !== normalizeControl(expectedName)) {
        const exact = await this.flowSteps.locate(page, { ...step.target, exact: true }, 500);
        if (typeof exact !== 'string') located = exact;
        else {
          const kind = step.kind === 'fill' || step.kind === 'select' ? step.kind : 'click';
          const expectedClass = this.safety.classify({
            type: kind,
            category: 'other',
            text: expectedName,
          }).classification;
          const foundClass = this.safety.classify({
            type: kind,
            category: 'other',
            text: found.name,
          }).classification;
          if (expectedClass !== foundClass)
            return diverged('TARGET_MISMATCH', {
              page,
              report: done('FAILED', {
                reason: `TARGET_NAME_MISMATCH: "${expectedName}" only partially matches "${found.name}", a different kind of action (${expectedClass} → ${foundClass}) (not clicked)`,
                stateId: context.stateId,
                url: context.url,
                effect: {
                  ...effect,
                  status: 'TARGET_MISMATCH',
                  reasons: [`partial name match: "${found.name}"`],
                },
              }),
            });
        }
      }
    }
    if (typeof located === 'string') {
      // Chercher à l'écran ce que le YAML voulait probablement dire, et indiquer comment l'écrire.
      const found = await suggestTargets(page, step).catch(() => undefined);
      return diverged('TARGET_NOT_FOUND', {
        page,
        report: done('FAILED', {
          reason: located,
          stateId: context.stateId,
          url: context.url,
          ...(found && found.suggestions.length > 0 ? { suggestions: found.suggestions } : {}),
          ...(found && found.onScreen.length > 0 ? { onScreen: found.onScreen } : {}),
        }),
      });
    }
    const locator: Locator = located;

    // « Qu'est-ce que c'est ? » — la même observation et le même classement que l'exploration autonome.
    let before: PageContext;
    let action: DiscoveredAction | undefined;
    try {
      await this.flowSteps.mark(locator);
      before = await this.observeState(page, context.metadata.depth);
      const element = this.lastSnapshot?.elements.find((candidate) => candidate.flowTarget === true);
      action =
        element && this.lastSnapshot
          ? this.discovery.discover({ ...this.lastSnapshot, elements: [element] }, before.stateId)[0]
          : undefined;
    } catch (error) {
      await this.flowSteps.unmark(page);
      const message = error instanceof Error ? error.message : String(error);
      return {
        page,
        report: done('FAILED', {
          reason: `cannot inspect the element: ${message.split('\n')[0] ?? message}`,
          stateId: context.stateId,
        }),
      };
    } finally {
      await this.flowSteps.unmark(page);
    }
    if (!action) {
      // Pas un élément interactif (texte simple, div…) : classé d'après son texte visible.
      const text = ((await locator.innerText({ timeout }).catch(() => '')) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      action = this.syntheticAction(before.stateId, step, text);
    }
    if (action.risks.includes('sensitive-data')) {
      // Ne jamais montrer ce qui est saisi dans un champ sensible, même une valeur littérale de la mission.
      const masked = describeStep(step, true);
      done = (status, extra = {}) => ({ ...finish(status, extra), description: masked });
    }
    if (action.disabled) {
      return diverged('TARGET_DISABLED', {
        page,
        report: done('FAILED', {
          reason: 'element is disabled',
          stateId: before.stateId,
          url: before.url,
          classification: action.classification,
        }),
      });
    }

    // « Ai-je le droit ? » — avant Playwright, quoi que dise le YAML.
    const value = step.kind === 'fill' ? step.value : undefined;
    const verdict = evaluateFlowAction(this.safety, action, {
      allow: step.allow,
      valueFromEnv: value !== undefined && typeof value !== 'string' && 'env' in value,
    });
    if (verdict.verdict === 'BLOCK') {
      this.graph.addEdge({
        from: before.stateId,
        to: before.stateId,
        actionId: action.id,
        action: summaryOf(action),
        result: 'BLOCKED',
        reason: verdict.reason,
        flow: flow.name,
      });
      return {
        page,
        context: before,
        report: done('BLOCKED', {
          reason: verdict.reason,
          stateId: before.stateId,
          url: before.url,
          classification: action.classification,
        }),
      };
    }

    let elementAction: FlowElementAction;
    if (step.kind === 'fill') {
      const data =
        typeof step.value !== 'string' && 'testData' in step.value
          ? this.testDataValue(action, step.value.testData, flow)
          : undefined;
      if (data?.kind === 'preserve')
        return {
          page,
          context: before,
          report: done('PASSED', {
            reason: 'PRESERVE_EXISTING: the value already in the field is kept',
            stateId: before.stateId,
            url: before.url,
            classification: action.classification,
          }),
        };
      const resolved =
        typeof step.value === 'string'
          ? step.value
          : 'env' in step.value
            ? this.env[step.value.env]
            : data?.kind === 'value'
              ? data.value
              : undefined;
      if (resolved === undefined) {
        const reason =
          typeof step.value !== 'string' && 'env' in step.value
            ? `environment variable ${step.value.env} is not set`
            : data?.kind === 'missing'
              ? data.reason
              : `no test data for "${typeof step.value === 'string' ? '' : step.value.testData}"`;
        return {
          page,
          context: before,
          report: done('FAILED', {
            reason,
            stateId: before.stateId,
            url: before.url,
            classification: action.classification,
          }),
        };
      }
      elementAction = { kind: 'fill', value: resolved };
    } else if (step.kind === 'select') {
      elementAction = { kind: 'select', option: step.option };
    } else {
      elementAction = { kind: step.kind };
    }

    // « Exécute. »
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    this.attribution = { actionId: action.id };
    this.currentAction = { stateId: before.stateId, actionId: action.id, flow: flow.name };
    const interactionMark = this.interactions.mark();
    this.networkTrace.start(action.id);
    this.actionClock = Date.now();
    const snapshotBefore = this.lastSnapshot;
    // BEFORE SNAPSHOT : les contrôles visibles, la route, et la cible de l'étape suivante (déjà là ?).
    const controlsBefore = controlsOf(snapshotBefore);
    const routeBefore = pathOf(before.url);
    // TRANSITION SYNCHRONIZATION : la sonde est posée juste AVANT l'action.
    const probeBefore = sync ? await installTransitionProbe(page) : undefined;
    if (this.functional) {
      this.formNetwork.startFunctional(`action-${action.id}`);
      this.functional.onActionSelected({ label: actionLabel(action), type: action.type });
    }
    this.writeGuard.during(before.stateId, action.id, `flow "${flow.name}" step "${actionLabel(action)}"`);
    // Une étape qui a le droit de modifier des données (allow), ou l'écran de connexion d'un flow, peut écrire.
    const mayWrite =
      step.allow.some((allowed) => allowed === 'MUTATION' || allowed === 'DANGEROUS') ||
      (this.patternsByState.get(before.stateId) ?? []).some((pattern) => pattern.type === 'LOGIN');
    // ACTION_EXECUTED ≠ TRANSITION_COMPLETED : la transition fait partie de l'action — elle est attendue
    // dans la même fenêtre (une écriture permise par l'étape part souvent APRÈS le retour du clic).
    let transition: TransitionWaitResult | undefined;
    // FAST PATH / DEEP PATH : une situation connue, résolue directement, attend une preuve positive puis
    // un calme COURT ; tout le reste garde l'attente complète. Les vérifications restent les mêmes.
    const fastPath = evaluateFastPath({
      enabled: this.config.performance.fastPath.enabled,
      recorded: fingerprint !== undefined || step.effects !== undefined,
      healed: effect.healed !== undefined,
      functionalResolution: resolution !== undefined,
      contextualResolution: contextual,
      reacquired: reacquiredTarget !== undefined,
      inRecovery: this.stepDepth > 1,
      previousStatus: this.previousStepStatus,
      dangerous: action.classification === 'DANGEROUS' || step.allow.includes('DANGEROUS'),
    });
    for (const reason of fastPath.reasons) this.perf.deep(reason);
    this.emitHealing(
      fastPath.path === 'FAST_PATH' ? 'FAST_PATH_SELECTED' : 'DEEP_PATH_SELECTED',
      `${step.kind} ${describeTarget(step.target)}${fastPath.reasons.length > 0 ? `: ${fastPath.reasons.join(', ')}` : ''}`,
    );
    // FILLED_VALUE_LOST_BEFORE_SUBMIT : avant d'écrire, les saisies de cet écran sont-elles encore là ?
    // Une valeur perdue entre-temps est signalée (jamais refaite en silence : elle peut être voulue).
    const lostBeforeSubmit =
      mayWrite && step.kind === 'click' && replay.functionalTargetResolution.checkFilledValuesBeforeSubmit
        ? await this.filledValuesLost(page)
        : [];
    for (const lost of lostBeforeSubmit) {
      this.emitHealing('FILLED_VALUE_LOST_BEFORE_SUBMIT', `${lost.label}: ${lost.kind} — ${lost.reason}`);
      effect.recovery.push(`FILLED_VALUE_LOST_BEFORE_SUBMIT: ${lost.label} (${lost.kind})`);
    }
    const perform = async (): Promise<string | undefined> => {
      const failure = await this.flowSteps.perform(
        page,
        locator,
        elementAction,
        timeout,
        probeBefore === undefined,
      );
      if (failure || !sync || !probeBefore) return failure;
      // Observer ce que l'application fait encore (vue, rendu, dialogue, données, réseau), attendre
      // la transition pertinente puis la stabilité — jamais un sommeil fixe ; rien n'est rejoué.
      transition = await this.waitTransition(page, {
        actionId: action.id,
        label: `${step.kind} ${describeTarget(step.target)}`,
        kind: step.kind,
        effects: sync.useExpectedEffects ? step.effects : undefined,
        nextStep,
        nextReadyBefore,
        before: probeBefore,
        ...(fastPath.path === 'FAST_PATH'
          ? { confirmationQuietMs: this.config.performance.fastPath.confirmationQuietMs }
          : {}),
      });
      return undefined;
    };
    const error = mayWrite ? await this.writeGuard.permit(`flow ${flow.name}`, perform) : await perform();
    this.actionsExecuted += 1;
    const raised = this.interactions.since(interactionMark);
    const blocking = raised.filter((interaction) => interaction.blocking);
    const interactionIds =
      raised.length > 0 ? { interactionIds: raised.map((interaction) => interaction.id) } : {};
    this.currentAction = undefined;
    const newIssues = (): string[] =>
      this.collector
        .all()
        .filter((issue) => !issuesBefore.has(issue.id))
        .map((issue) => issue.id);

    if (error || blocking.length > 0 || !this.isExplorablePage(page) || observers.pageErrors.consumeCrash()) {
      if (this.functional) await this.formNetwork.stopFunctional(`action-${action.id}`);
      const ids = newIssues();
      this.collector.assignState(ids, before.stateId, before.metadata.flow);
      const edge = this.graph.addEdge({
        from: before.stateId,
        to: before.stateId,
        actionId: action.id,
        action: summaryOf(action),
        ...this.networkOf(action.id),
        result: blocking.length > 0 ? 'BLOCKED' : 'FAILED',
        reason:
          blocking.length > 0
            ? blockingReason(blocking)
            : (error ?? 'left the allowed hosts, or the page crashed'),
        issueIds: ids,
        flow: flow.name,
        ...interactionIds,
      });
      this.graph.attachIssues(before.stateId, ids);
      this.listener.onTransition?.(edge, action);
      if (!/^https?:/.test(page.url()) || page.isClosed())
        page = await this.recyclePage(browser, page, observers.all);
      return {
        page,
        context: before,
        report: done(blocking.length > 0 ? 'BLOCKED' : 'FAILED', {
          reason: edge.reason ?? 'action failed',
          stateId: before.stateId,
          url: before.url,
          classification: action.classification,
        }),
      };
    }

    if (transition) {
      const base = done;
      const report = synchronizationReportOf(transition);
      if (reacquiredTarget) report.reacquired = reacquiredTarget;
      done = (status, extra) => base(status, { ...extra, synchronization: report });
    }
    this.lastTransition = transition;

    // FAIL AT FIRST FUNCTIONAL DIVERGENCE : une saisie est PROUVÉE par la valeur lue ensuite. Une
    // cible résolue fonctionnellement n'est confirmée que par cet effet (jamais par son score).
    if (elementAction.kind === 'fill' && replay.functionalTargetResolution.verifyFillValue) {
      const held = await this.filledValue(page, locator, step.target);
      // Une saisie ne navigue pas : une page quittée contredit la cible résolue (l'effet n'est pas celui attendu).
      const navigated = resolution !== undefined && pathOf(page.url()) !== pathOf(before.url);
      let confirmed = navigated
        ? false
        : held === undefined
          ? undefined
          : sameFilledValue(held, elementAction.value);
      // VALUE_RESTORED_AFTER_APPLICATION_RESET : l'application a retiré la valeur du champ (formulaire
      // initialisé tardivement, champ dépendant réinitialisé, élément re-rendu) — refaite UNE fois, après
      // stabilisation, sur le même champ ; sinon la perte est classée et l'étape échoue.
      let filledLocator: Locator = locator;
      let restore: { attempted: boolean; restored: boolean; loss?: { kind: ValueLossKind; reason: string } } =
        {
          attempted: false,
          restored: false,
        };
      if (
        confirmed === false &&
        !navigated &&
        replay.functionalTargetResolution.restoreValueAfterApplicationReset
      ) {
        const loss = classifyValueLoss({
          expected: elementAction.value,
          probe: await this.probeFilledField(page, locator, step.target),
        });
        restore = { attempted: false, restored: false, loss };
        if (restorableValueLoss(loss)) {
          const again = await this.refillAfterApplicationReset(
            page,
            step.target,
            step.fingerprint,
            elementAction.value,
            {
              actionId: action.id,
              timeout,
            },
          );
          restore = { attempted: true, restored: again?.held === true, loss };
          if (again?.held === true) {
            filledLocator = again.locator;
            confirmed = true;
            effect.recovery.push(`VALUE_RESTORED_AFTER_APPLICATION_RESET: ${loss.kind}`);
            this.emitHealing(
              'VALUE_RESTORED_AFTER_APPLICATION_RESET',
              `${actionLabel(action)}: ${loss.kind} — ${loss.reason}; filled again once after the screen settled, the field now holds the value`,
            );
          } else
            this.emitHealing(
              'VALUE_RESTORE_FAILED',
              `${actionLabel(action)}: ${loss.kind} — ${again ? 'filled again once, the application removed the value again' : 'the recorded field could not be found again (or is another field)'}`,
            );
        }
      }
      // TARGET RESOLUTION MUST IDENTIFY THE FIELD BEFORE TRUSTING THE VALUE : le champ rempli est-il
      // celui enregistré ? (une valeur « tenue » par un AUTRE champ n'est pas une saisie confirmée).
      // Seulement si l'identité n'a pas déjà été vérifiée avant d'agir (empreinte, contexte, healing).
      const fieldCheck =
        step.fingerprint && !navigated
          ? verifyFieldFill({
              expected: step.fingerprint,
              observed:
                effect.targetMatch === undefined
                  ? await readTarget(filledLocator).catch(() => undefined)
                  : undefined,
              valueHeld: confirmed,
            })
          : undefined;
      if (fieldCheck?.verdict === 'FIELD_TARGET_MISMATCH') {
        confirmed = false;
        this.emitHealing(
          'REPLAY_FIELD_TARGET_MISMATCH',
          `${actionLabel(action)}: ${fieldCheck.reasons.join('; ')}`,
        );
      } else if (fieldCheck && fieldCheck.verdict !== 'UNKNOWN') {
        this.emitHealing(
          'REPLAY_FIELD_TARGET_CONFIRMED',
          `${actionLabel(action)}: the filled field is the recorded one`,
        );
        this.emitHealing(
          fieldCheck.verdict === 'CONFIRMED' ? 'REPLAY_FIELD_VALUE_CONFIRMED' : 'REPLAY_FIELD_VALUE_MISMATCH',
          `${actionLabel(action)}: ${fieldCheck.reasons.join('; ')}`,
        );
      }
      if (resolution)
        await this.confirmTargetResolution(
          page,
          resolution,
          confirmed,
          navigated ? 'unexpected navigation after the fill' : undefined,
        );
      if (confirmed === false) {
        if (this.functional) await this.formNetwork.stopFunctional(`action-${action.id}`);
        // VALUE LOSS : pourquoi, lu sur le TARGET RÉEL résolu (mauvais champ, effacé, remplacé, re-rendu…).
        const loss = navigated
          ? undefined
          : fieldCheck?.verdict !== 'FIELD_TARGET_MISMATCH' && restore.loss
            ? restore.attempted
              ? {
                  kind: restore.loss.kind,
                  reason: `${restore.loss.reason}; filled again once after the screen settled — the application removed it again`,
                }
              : restore.loss
            : classifyValueLoss({
                expected: elementAction.value,
                probe: await this.probeFilledField(page, filledLocator, step.target),
                wrongTarget: fieldCheck?.verdict === 'FIELD_TARGET_MISMATCH',
              });
        return {
          page,
          context: before,
          report: done('FAILED', {
            reason: `ACTION_EFFECT_NOT_CONFIRMED: ${navigated ? 'unexpected navigation after the fill' : fieldCheck?.verdict === 'FIELD_TARGET_MISMATCH' || fieldCheck?.verdict === 'FIELD_VALUE_MISMATCH' ? `${fieldCheck.verdict} — ${fieldCheck.reasons.join('; ')}` : 'the field does not hold the filled value'}${loss ? ` — ${loss.kind}: ${loss.reason}` : ''}${resolution ? ` (${resolution.status} ${resolution.resolution ?? ''}: the resolution is rejected)` : ''}`,
            stateId: before.stateId,
            url: before.url,
            classification: action.classification,
            effect: {
              ...effect,
              execution: 'EXECUTED',
              status: fieldCheck?.verdict === 'FIELD_TARGET_MISMATCH' ? 'TARGET_MISMATCH' : 'WRONG_EFFECT',
              expected:
                fieldCheck?.verdict === 'FIELD_TARGET_MISMATCH'
                  ? ['FIELD_IDENTITY', 'VALUE_CHANGED']
                  : ['VALUE_CHANGED'],
              observed: [
                fieldCheck?.verdict === 'FIELD_TARGET_MISMATCH'
                  ? 'another field received the value'
                  : 'value not held by the field',
              ],
              reasons: [...effect.reasons, 'ACTION_EFFECT_NOT_CONFIRMED'],
            },
          }),
        };
      }
      if (confirmed === true)
        this.rememberFilled(page, step.target, elementAction.value, actionLabel(action));
    } else if (resolution && (elementAction.kind === 'fill' || !verifying))
      await this.confirmTargetResolution(page, resolution, undefined);
    // CHECKED_STATE_CHANGED : une case est prouvée par son état relu, pas par un clic réussi.
    if (elementAction.kind === 'check' || elementAction.kind === 'uncheck') {
      const wanted = elementAction.kind === 'check';
      const state = await locator.isChecked({ timeout: 1000 }).catch(() => undefined);
      if (state !== undefined)
        this.emitHealing(
          state === wanted ? 'CHECKED_STATE_CHANGED' : 'CHECKED_STATE_NOT_CHANGED',
          `${actionLabel(action)}: ${state ? 'checked' : 'unchecked'} (expected ${wanted ? 'checked' : 'unchecked'})`,
        );
      if (state === !wanted) {
        if (this.functional) await this.formNetwork.stopFunctional(`action-${action.id}`);
        return {
          page,
          context: before,
          report: done('FAILED', {
            reason: `ACTION_EFFECT_NOT_CONFIRMED: CHECKED_STATE_NOT_CHANGED — the control is ${state ? 'checked' : 'unchecked'}, expected ${wanted ? 'checked' : 'unchecked'}`,
            stateId: before.stateId,
            url: before.url,
            classification: action.classification,
            effect: {
              ...effect,
              execution: 'EXECUTED',
              status: 'WRONG_EFFECT',
              expected: ['CHECKED_STATE_CHANGED'],
              observed: [state ? 'checked' : 'unchecked'],
              reasons: [...effect.reasons, 'CHECKED_STATE_NOT_CHANGED'],
            },
          }),
        };
      }
    }

    // « Que s'est-il passé ? »
    let after = await this.observeState(page, before.metadata.depth + 1);
    if (this.functional) {
      // Une étape de flow n'est pas jugée par les oracles : les constats fonctionnels deviennent des avertissements ici.
      await this.observeFunctional(action, snapshotBefore, this.lastSnapshot, before.route, after.route);
      for (const finding of this.functional.findingsFor(action.id))
        if (finding.status === 'WARNING')
          this.collector.add({
            type: finding.code === 'CONTRACT_MISMATCH' ? 'CONTRACT' : 'FUNCTIONAL',
            severity: 'WARNING',
            message: `"${actionLabel(action)}": ${finding.message}`,
            pageUrl: before.url,
            actionId: action.id,
          });
    }
    const ids = newIssues();
    const traced = this.networkOf(action.id);
    const edge = this.graph.addEdge({
      from: before.stateId,
      to: after.stateId,
      actionId: action.id,
      action: summaryOf(action),
      ...traced,
      result: 'SUCCESS',
      issueIds: ids,
      flow: flow.name,
      ...interactionIds,
    });
    for (const issue of this.collector.all()) {
      if (ids.includes(issue.id)) {
        issue.actionId ??= action.id;
        issue.flow = this.graph.flowTo(after.stateId);
      }
    }
    await this.captureErrorScreenshot(page, after, ids);
    this.listener.onTransition?.(edge, action);
    this.observeCognitive(
      step.kind,
      step.target.name ?? step.target.value ?? actionLabel(action),
      snapshotBefore,
      before.route,
      after.route,
      traced.network,
      `flow "${flow.name}"`,
    );

    // « A-t-il FONCTIONNÉ ? » — EXECUTED ≠ CONFIRMED.
    if (verifying) {
      effect.execution = 'EXECUTED';
      const mutation =
        action.classification !== 'SAFE' || step.allow.some((allowed) => allowed !== 'UNKNOWN');
      const exchanges = traced.network ?? [];
      const requests = exchanges.map(
        (exchange) =>
          `${exchange.method.toUpperCase()} ${pathOf(exchange.url)}${exchange.status ? ` ${String(exchange.status)}` : ''}`,
      );
      const writes = exchanges
        .filter((exchange) => !['GET', 'HEAD', 'OPTIONS'].includes(exchange.method.toUpperCase()))
        .map((exchange) => ({
          request: `${exchange.method.toUpperCase()} ${pathOf(exchange.url)}`,
          ...(exchange.status !== undefined ? { status: exchange.status } : {}),
        }));
      const awaitedNext = next && nextBefore === false ? next : undefined;
      const check = async (): Promise<EffectVerification> => {
        const controlsAfter = controlsOf(this.lastSnapshot);
        const nextAfter = awaitedNext ? await this.targetAvailable(page, awaitedNext, 150) : true;
        return verifyEffects({
          ...(step.effects ? { effects: step.effects } : {}),
          observed: observeEffects(controlsBefore, controlsAfter, routeBefore, pathOf(after.url), requests),
          afterControls: controlsAfter,
          afterRoute: pathOf(after.url),
          ...(next && nextBefore !== undefined
            ? { nextTarget: { label: describeTarget(next), before: nextBefore, after: nextAfter } }
            : {}),
          mutation,
          writes,
        });
      };
      const failed = (verification: EffectVerification): boolean =>
        verification.status === 'NO_EFFECT' || verification.status === 'WRONG_EFFECT';
      let verification = await check();
      // UI STABILIZATION : attendre l'effet attendu (sur condition, borné), jamais un sommeil fixe.
      // Déjà attendu par la synchronisation (borne atteinte) : pas une seconde attente.
      const alreadyWaited = transition?.status === 'TIMEOUT';
      if (
        failed(verification) &&
        !alreadyWaited &&
        (await this.waitForEffect(page, step.effects, awaitedNext, replay.effectTimeoutMs))
      ) {
        after = await this.observeState(page, before.metadata.depth + 1);
        verification = await check();
      }
      // ROOT CAUSE BEFORE RECOVERY : pourquoi l'effet manque ? Une attente enregistrée qui décrit la
      // SUITE du parcours (contamination temporelle) n'est pas une cible à réparer.
      let suspect: WrongEffectAnalysis | undefined;
      if (failed(verification)) {
        const index =
          this.stepPosition?.flow === flow ? this.stepPosition.index - 1 : flow.steps.indexOf(step);
        const analysis = analyzeWrongEffect({
          verification,
          effects: step.effects,
          steps: flow.steps,
          index,
          writes,
          requests,
          routeChanged: routeBefore !== pathOf(after.url),
          nextTargetAvailable: next ? await this.targetAvailable(page, next, 300) : undefined,
          screenNeverSettled: transition?.status === 'TIMEOUT' && !transition.stable,
        });
        this.emitHealing(
          'WRONG_EFFECT_ANALYZED',
          `${actionLabel(action)}: ${analysis.classification} — ${analysis.reasons.join('; ')}`,
        );
        if (analysis.classification === 'RECORDED_EXPECTATION_CONTAMINATED') suspect = analysis;
      }
      // RECOVERY : une action sûre est retentée (même cible re-résolue, puis les autres localisateurs
      // de son empreinte) ; une action qui écrit ne l'est JAMAIS automatiquement (pas de double envoi).
      if (failed(verification) && replay.recovery.enabled && !suspect) {
        if (mutation && !replay.recovery.retryMutations)
          effect.recovery.push('none: an action that writes is never retried automatically');
        else if (replay.recovery.retrySafeActions) {
          const attempts: { name: string; target: FlowTarget }[] = [
            { name: 'RE_RESOLVE_TARGET', target: step.target },
            ...(fingerprint && replay.locatorHealing
              ? healingCandidates(fingerprint, step.target).map((target) => ({
                  name: 'TRY_NEXT_LOCATOR',
                  target,
                }))
              : []),
          ].slice(0, 3);
          for (const attempt of attempts) {
            const again = await this.flowSteps.locate(page, attempt.target, Math.min(timeout, 3000));
            if (typeof again === 'string') {
              effect.recovery.push(`${attempt.name} ${describeTarget(attempt.target)}: not found`);
              continue;
            }
            if (fingerprint) {
              const match = matchFingerprint(fingerprint, await readTarget(again));
              if (match.verdict === 'MISMATCH') {
                effect.recovery.push(
                  `${attempt.name} ${describeTarget(attempt.target)}: another element (${match.reasons.join('; ')})`,
                );
                continue;
              }
            }
            const failure = await this.flowSteps.perform(page, again, elementAction, timeout);
            if (failure) {
              effect.recovery.push(`${attempt.name} ${describeTarget(attempt.target)}: ${failure}`);
              continue;
            }
            await this.waitForEffect(page, step.effects, awaitedNext, replay.effectTimeoutMs);
            after = await this.observeState(page, before.metadata.depth + 1);
            verification = await check();
            effect.recovery.push(`${attempt.name} ${describeTarget(attempt.target)}: ${verification.status}`);
            if (verification.status === 'CONFIRMED') {
              if (attempt.name === 'TRY_NEXT_LOCATOR') {
                effect.healed = { from: describeTarget(step.target), to: describeTarget(attempt.target) };
                effect.locator = describeTarget(attempt.target);
              }
              break;
            }
          }
        }
      }
      this.emitHealing(
        'EFFECT_VERIFY',
        `${actionLabel(action)}: expected=${verification.expected.join(', ') || '—'} observed=${verification.observed.join(', ') || '—'} → ${verification.status === 'CONFIRMED' ? 'ACTION_CONFIRMED' : verification.status}`,
      );
      effect.status = verification.status;
      effect.expected = verification.expected;
      effect.observed = verification.observed;
      effect.reasons = verification.reasons;
      // TARGET_CONFIRMED ≠ ACTION_CONFIRMED : une cible résolue (contexte, healing) n'est confirmée
      // que par l'effet observé — l'ActionEffectVerifier reste la preuve finale.
      if (resolution)
        await this.confirmTargetResolution(
          page,
          resolution,
          // Une attente suspecte (contamination de l'enregistrement) ne prouve rien contre la cible.
          verification.status === 'CONFIRMED' ? true : failed(verification) && !suspect ? false : undefined,
          failed(verification) && !suspect
            ? `ACTION_EFFECT_MISMATCH: expected ${verification.expected.join(', ') || 'an effect'}; observed ${verification.observed.join(', ') || 'no relevant change'}`
            : undefined,
          verification.status === 'CONFIRMED'
            ? `ACTION_CONFIRMED (${verification.reasons.join('; ')})`
            : undefined,
        );
      if (suspect) {
        // ACTION_EXECUTED + RUNTIME_EFFECT_CONFIRMED + RECORDED_EXPECTATION_SUSPECT : aucune récupération
        // (pas d'expérimentation sur une cible correcte) ; la divergence du MODÈLE d'enregistrement est
        // gardée dans le rapport, distincte d'une divergence applicative ; la suite vérifie le parcours.
        effect.status = 'EXPECTATION_SUSPECT';
        effect.reasons = [...suspect.reasons, `suspect expectations: ${suspect.suspectEffects.join(', ')}`];
        this.emitHealing(
          'REPLAY_EXPECTATION_SUSPECTED',
          `${actionLabel(action)}: ${suspect.suspectEffects.join(', ')} describe a later step`,
        );
        this.emitHealing(
          'REPLAY_RECORDING_MODEL_DIVERGENCE',
          `${actionLabel(action)}: RECORDED_EXPECTATION_CONTAMINATED — not an application divergence (no recovery)`,
        );
        return {
          page,
          context: after,
          report: done('PASSED', {
            reason: `REPLAY_INCONCLUSIVE_EXPECTATION_DRIFT: RECORDED_EXPECTATION_CONTAMINATED — expected ${suspect.suspectEffects.join(', ')} (a later step); ${suspect.reasons.slice(1).join('; ')}`,
            stateId: after.stateId,
            url: after.url,
            classification: action.classification,
            effect,
            recordingModelDivergence: {
              classification: 'RECORDED_EXPECTATION_CONTAMINATED',
              suspectEffects: suspect.suspectEffects,
              reasons: suspect.reasons,
            },
          }),
        };
      }
      const intelligent = replay.intelligentRecovery;
      if (
        verification.status === 'WRONG_EFFECT' &&
        intelligent.enabled &&
        this.healingDepth === 0 &&
        !mutation &&
        this.nextStepTarget() !== undefined
      ) {
        // L'écran a changé, mais pas comme enregistré : la SUITE dira si c'est une divergence
        // (son objectif sera vérifié) ; sinon la divergence d'origine sera ICI.
        effect.deferred = true;
        effect.reasons = [
          ...verification.reasons,
          'deferred: the next step and its goal will confirm or refute',
        ];
        return {
          page,
          context: after,
          report: done('PASSED', {
            reason: `EXPECTED_EFFECT_CHANGED (deferred): expected ${verification.expected.join(', ') || 'an effect'}; observed ${verification.observed.join(', ') || 'no relevant change'}`,
            stateId: after.stateId,
            url: after.url,
            classification: action.classification,
            effect,
          }),
        };
      }
      if (failed(verification) || verification.status === 'AMBIGUOUS') {
        // FAIL AT ROOT CAUSE : le parcours diverge ICI, pas à l'étape suivante qui ne trouvera rien.
        return diverged(
          verification.status === 'AMBIGUOUS'
            ? 'MUTATION_AMBIGUOUS'
            : verification.status === 'WRONG_EFFECT'
              ? 'WRONG_EFFECT'
              : 'NO_EFFECT',
          {
            page,
            context: after,
            report: done('FAILED', {
              // L'écran n'a jamais fini sa transition : un problème TEMPOREL, dit d'abord. Écran stable
              // sans l'effet : une vraie absence d'effet (la borne n'est qu'un complément).
              reason: `${transition?.status === 'TIMEOUT' && !transition.stable ? `TRANSITION_TIMEOUT (${transitionTimeoutText(transition, 'this action')}) — ` : ''}ACTION_NOT_CONFIRMED (${verification.status === 'AMBIGUOUS' ? 'MUTATION_EFFECT_AMBIGUOUS' : verification.status}): click executed, expected ${verification.expected.join(', ') || 'an effect'}; observed ${verification.observed.join(', ') || 'no relevant change'}${transition?.status === 'TIMEOUT' && transition.stable ? ` (transition TIMEOUT after ${String(transition.durationMs)} ms, screen stable: the expected transition never came)` : ''}`,
              stateId: after.stateId,
              url: after.url,
              classification: action.classification,
              effect,
            }),
          },
        );
      }
    }
    return {
      page,
      context: after,
      report: done('PASSED', {
        stateId: after.stateId,
        url: after.url,
        classification: action.classification,
        ...(verifying ? { effect } : {}),
      }),
    };
  }

  /** La cible de la prochaine étape d'action du flow (les vérifications expect sont sautées). */
  private nextStepTarget(): FlowTarget | undefined {
    const position = this.stepPosition;
    if (!position) return undefined;
    for (const step of position.flow.steps.slice(position.index)) {
      if (step.kind === 'expect' || step.kind === 'screenshot' || step.kind === 'manual') continue;
      if (step.optional) return undefined;
      return 'target' in step ? step.target : undefined;
    }
    return undefined;
  }

  /** La prochaine étape d'action du flow (les vérifications expect sont sautées). */
  private nextFlowStep(): Extract<FlowStep, { target: unknown }> | undefined {
    const position = this.stepPosition;
    if (!position) return undefined;
    for (const step of position.flow.steps.slice(position.index)) {
      if (step.kind === 'expect' || step.kind === 'screenshot' || step.kind === 'manual') continue;
      if (step.optional) return undefined;
      return 'target' in step ? step : undefined;
    }
    return undefined;
  }

  /**
   * TARGET_REACQUIRED_AFTER_RERENDER : attendre que l'écran soit calme (sans action, borné), puis
   * re-résoudre la cible sur le DOM frais et relire son empreinte. undefined : toujours un autre élément.
   */
  private async reacquireAfterRerender(
    page: Page,
    target: FlowTarget,
    fingerprint: TargetFingerprint,
    timeout: number,
  ): Promise<{ locator: Locator; match: ReturnType<typeof matchFingerprint> } | undefined> {
    const before = await installTransitionProbe(page);
    if (!before) return undefined;
    const settled = await this.transitionWaiter.waitForTransition({
      page,
      expectation: { expected: false, effectsDeclared: false, nextAwaited: false, nextKnown: false },
      before,
    });
    const again = await this.flowSteps.locate(page, target, Math.min(timeout, 2000));
    if (typeof again === 'string') return undefined;
    const match = matchFingerprint(fingerprint, await readTarget(again));
    if (match.verdict === 'MISMATCH') return undefined;
    this.emitHealing(
      'TARGET_REACQUIRED_AFTER_RERENDER',
      `${describeTarget(target)}: ${match.verdict} ${String(match.score)} after ${String(settled.durationMs)} ms of stabilization`,
    );
    return { locator: again, match };
  }

  private synchronizationOn(): boolean {
    return this.config.replay.uiStabilization && this.config.replay.synchronization.enabled;
  }

  /**
   * NEXT ACTION READINESS : la cible de l'étape suivante, résolue sur le DOM FRAIS (le résolveur
   * sémantique et contextuel existant), visible, active, et dont l'empreinte correspond — jamais
   * seulement « un élément existe pour le localisateur brut ». Lecture seule.
   */
  private async nextReadiness(
    page: Page,
    step: Extract<FlowStep, { target: unknown }>,
  ): Promise<{ ready: boolean; present?: boolean; reason?: string }> {
    const found = await this.flowSteps.locate(page, step.target, 50);
    if (typeof found === 'string')
      // Localisateur périmé : la cible peut être là sous une autre forme (résolue par son contexte).
      return (await this.contextuallyAvailable(page, step))
        ? { ready: true, reason: 'resolved by its context (recorded locator not found)' }
        : { ready: false, reason: 'not on the screen yet' };
    if (!(await found.isEnabled({ timeout: 200 }).catch(() => false)))
      return { ready: false, reason: 'present but disabled' };
    if (step.fingerprint && this.config.replay.targetFingerprintMatching) {
      const match = matchFingerprint(step.fingerprint, await readTarget(found));
      if (match.verdict === 'MISMATCH')
        return {
          ready: false,
          present: true,
          reason: `fingerprint differs (${match.reasons.slice(0, 1).join('')})`,
        };
    }
    return { ready: true };
  }

  /** L'effet enregistré est-il visible MAINTENANT ? (un contrôle apparu, la route attendue) */
  private async effectVisible(page: Page, effects: StepEffects): Promise<boolean> {
    if (effects.route) {
      const pattern = effects.route;
      if (routeMatches(pattern, pathOf(page.url()))) return true;
    }
    for (const control of (effects.appears ?? []).slice(0, 3)) {
      const colon = control.indexOf(':');
      const role = colon > 0 && !control.slice(0, colon).includes(' ') ? control.slice(0, colon) : undefined;
      const name = role ? control.slice(colon + 1) : control;
      const target: FlowTarget = role ? { strategy: 'role', role, name } : { strategy: 'text', value: name };
      if (typeof (await this.flowSteps.locate(page, target, 50)) !== 'string') return true;
    }
    return false;
  }

  /**
   * UITransitionWaiter, côté explorateur : il fournit l'action, ses effets enregistrés, la
   * préparation de l'action suivante et le réseau corrélé ; il journalise chaque signal.
   */
  private async waitTransition(
    page: Page,
    input: {
      actionId: string;
      label: string;
      kind: string;
      effects: StepEffects | undefined;
      nextStep: Extract<FlowStep, { target: unknown }> | undefined;
      nextReadyBefore: boolean | undefined;
      before: { href: string; route: string; dialogs: number };
      confirmationQuietMs?: number;
    },
  ): Promise<TransitionWaitResult> {
    const sync = this.config.replay.synchronization;
    const effectsDeclared =
      input.effects !== undefined &&
      (input.effects.route !== undefined || (input.effects.appears?.length ?? 0) > 0);
    const expectation = expectationOf({
      kind: input.kind,
      effectsDeclared,
      nextKnown: input.nextStep !== undefined,
      nextReadyBefore: input.nextReadyBefore,
    });
    this.emitHealing('ACTION_EXECUTED', input.label);
    this.emitHealing(
      'TRANSITION_WAIT',
      `${input.label}: ${expectation.expected ? 'transition expected' : 'no transition expected'}${effectsDeclared ? ' · expected effects' : ''}${expectation.nextAwaited && input.nextStep ? ` · awaiting next target ${describeTarget(input.nextStep.target)}` : ''} (bound ${String(sync.transitionTimeoutMs)} ms)`,
    );
    const effects = input.effects;
    const nextStep = input.nextStep;
    const result = await this.transitionWaiter.waitForTransition({
      page,
      expectation,
      before: input.before,
      ...(sync.observeNetwork
        ? {
            network: () =>
              this.networkTrace.activity(input.actionId, {
                correlationMs: sync.networkCorrelationMs,
                pendingCapMs: sync.networkPendingCapMs,
              }),
          }
        : {}),
      ...(effects && (effectsDeclared || effects.request)
        ? {
            effectObserved: async () =>
              (effectsDeclared && (await this.effectVisible(page, effects))) ||
              (effects.request !== undefined &&
                requestCompleted(
                  effects.request,
                  this.networkTrace.activity(input.actionId, {
                    correlationMs: sync.networkCorrelationMs,
                    pendingCapMs: sync.networkPendingCapMs,
                  }).completedRequests,
                )),
          }
        : {}),
      ...(nextStep ? { nextReady: () => this.nextReadiness(page, nextStep) } : {}),
      ...(input.confirmationQuietMs !== undefined ? { confirmationQuietMs: input.confirmationQuietMs } : {}),
      onSignal: (signal) => {
        this.emitHealing(
          signal.kind === 'UI_STABLE' ? 'UI_STABLE' : 'TRANSITION_SIGNAL',
          `${signal.kind}${signal.detail ? ` ${signal.detail}` : ''} +${String(signal.atMs)} ms`,
        );
      },
    });
    if (result.status === 'TIMEOUT')
      this.emitHealing(
        'TRANSITION_TIMEOUT',
        `${input.label}: timeout=${String(sync.transitionTimeoutMs)}ms signals=${result.evidence.join(', ') || 'none'} expected=${result.missing.join(', ') || '—'} result=TRANSITION_TIMEOUT`,
      );
    else
      this.emitHealing(
        result.status === 'NEXT_ACTION_READY' ? 'NEXT_ACTION_READY' : 'TRANSITION_CONFIRMED',
        `${input.label}: ${result.status} in ${String(result.durationMs)} ms (stable ${String(result.stabilityDurationMs)} ms)`,
      );
    return result;
  }

  /**
   * La cible d'une étape est-elle là ? Le localisateur brut d'abord ; s'il ne trouve rien et que
   * c'est la cible de l'étape SUIVANTE (avec une empreinte), sa résolution contextuelle (lecture seule) :
   * un localisateur périmé n'est pas la preuve que l'élément manque.
   */
  private async targetAvailable(page: Page, target: FlowTarget, timeoutMs: number): Promise<boolean> {
    if (typeof (await this.flowSteps.locate(page, target, timeoutMs)) !== 'string') return true;
    const next = this.nextFlowStep();
    return next?.target === target ? this.contextuallyAvailable(page, next) : false;
  }

  /** La cible d'une étape est-elle RÉSOLUE par son contexte (empreinte, fenêtre, champ, parcours) ? */
  private async contextuallyAvailable(
    page: Page,
    step: Extract<FlowStep, { target: unknown }>,
  ): Promise<boolean> {
    const settings = this.config.replay.functionalTargetResolution;
    const flow = this.stepPosition?.flow;
    if (!step.fingerprint || !settings.enabled || !flow) return false;
    const index = flow.steps.indexOf(step);
    if (index < 0) return false;
    const found = await discoverCandidates(page, step, settings.maxCandidates);
    const decision = decide(
      scoreCandidates(
        functionalIdentityOf(step, flow.steps, index),
        buildTemporalContext(flow.steps, index),
        found.candidates,
      ),
      settings.minScore,
      settings.ambiguityMargin,
    );
    await clearCandidateMarks(page, found.token);
    return decision.status === 'RESOLVED';
  }

  /**
   * L'effet attendu, ATTENDU sur condition (borné) : un contrôle appris qui apparaît, la route
   * attendue, la cible de l'étape suivante. Vrai dès que l'une arrive.
   */
  private async waitForEffect(
    page: Page,
    effects: StepEffects | undefined,
    nextTarget: FlowTarget | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    const waits: Promise<unknown>[] = [];
    for (const control of (effects?.appears ?? []).slice(0, 3)) {
      const colon = control.indexOf(':');
      const role = colon > 0 && !control.slice(0, colon).includes(' ') ? control.slice(0, colon) : undefined;
      const name = role ? control.slice(colon + 1) : control;
      const target: FlowTarget = role ? { strategy: 'role', role, name } : { strategy: 'text', value: name };
      waits.push(
        this.flowSteps.locate(page, target, timeoutMs).then((found) => {
          if (typeof found === 'string') throw new Error(found);
        }),
      );
    }
    if (effects?.route) {
      const pattern = effects.route;
      waits.push(page.waitForURL((url) => routeMatches(pattern, url.pathname), { timeout: timeoutMs }));
    }
    if (nextTarget)
      waits.push(
        this.flowSteps.locate(page, nextTarget, timeoutMs).then((found) => {
          if (typeof found === 'string') throw new Error(found);
        }),
      );
    if (waits.length === 0) return false;
    for (const wait of waits) wait.catch(() => undefined);
    return Promise.any(waits).then(
      () => true,
      () => false,
    );
  }

  /** LOCATOR HEALING : le MÊME élément retrouvé par son empreinte (rôle + nom, test id, texte), vérifié. */
  /**
   * RÉSOLUTION FONCTIONNELLE PAR PREUVES : identité fonctionnelle + contexte temporel → ensemble de
   * candidats multi-sources (le scan de l'écran ET l'élément que tient encore le localisateur
   * enregistré : jamais perdu) → preuves positives, négatives, contradictions → décision (jamais le
   * premier par hasard) → conseiller quand le déterministe ne prouve rien (ambiguïté, mismatch
   * fonctionnel, preuves contradictoires ; HYBRID : proposition validée ; ASSIST : consignée ;
   * OFF : aucun appel) → la cible retenue est re-résolue au runtime avant toute action.
   */
  private async resolveFunctionalTarget(
    page: Page,
    flow: FlowConfig,
    step: Extract<FlowStep, { target: unknown }>,
    fingerprint: TargetFingerprint,
    mismatch: { score?: number; reasons: readonly string[] },
    located: Locator | undefined,
    /** Pourquoi résoudre : une empreinte qui diffère, un localisateur NON UNIQUE, ou introuvable. */
    cause: TargetResolutionTrigger = 'FINGERPRINT_MISMATCH',
    rawMatches?: number,
  ): Promise<{ locator?: Locator; chosen?: ScoredCandidate; trace: TargetResolutionTrace }> {
    const settings = this.config.replay.functionalTargetResolution;
    const reasons = mismatch.reasons;
    const index = this.stepPosition?.flow === flow ? this.stepPosition.index - 1 : flow.steps.indexOf(step);
    const reports = this.currentFlowReport?.steps ?? [];
    const temporal = buildTemporalContext(
      flow.steps,
      index,
      reports.map((report) => ({ status: report.status, observed: report.effect?.observed ?? [] })),
    );
    const identity = functionalIdentityOf(step, flow.steps, index);
    const action = `${flow.name}#${String(index + 1)} ${identity.interaction} ${identity.businessConcept ?? identity.label ?? describeTarget(step.target)}`;
    this.emitHealing('TARGET_CONTEXT', `${action}: ${temporalLine(temporal)}`);
    const found = await discoverCandidates(page, step, settings.maxCandidates);
    // CandidateSet ≥ 1 dès que le localisateur enregistré tient encore un élément : il reste candidat,
    // avec ses preuves contradictoires, même quand le scan de l'écran ne le retient pas (ou échoue).
    if (located && !found.candidates.some((candidate) => candidate.matchesRecordedLocator)) {
      const kept = await recordedLocatorCandidate(
        located,
        found.token,
        `T${String(found.candidates.length + 1)}`,
      );
      if (kept) found.candidates.push(kept);
    }
    this.emitHealing(
      'TARGET_CANDIDATE_DISCOVERED',
      `${action}: ${String(found.candidates.length)} candidate(s)${found.candidates.length > 0 ? ` — ${found.candidates.map((candidate) => `${candidate.id} ${candidate.source ?? 'PAGE_SCAN'}${candidate.matchesRecordedLocator ? ' (recorded locator)' : ''}`).join(', ')}` : ''}${found.scanError ? ` · scan error: ${found.scanError}` : ''}`,
    );
    const ranked = scoreCandidates(identity, temporal, found.candidates, {
      ...(mismatch.score !== undefined ? { score: mismatch.score } : {}),
      reasons,
    });
    for (const candidate of ranked.filter((entry) => !entry.rejected).slice(0, 3)) {
      const evidence = candidate.evidence ?? [];
      this.emitHealing(
        'TARGET_EVIDENCE',
        `${action}: ${candidate.id} ${String(candidate.score)} ${evidence.map((entry) => `${entry.polarity === 'POSITIVE' ? '+' : '−'}${entry.kind}`).join(' ')}`,
      );
      if (
        evidence.some((entry) => entry.polarity === 'POSITIVE') &&
        (candidate.contradictions?.length ?? 0) > 0
      )
        this.emitHealing(
          'TARGET_CONTRADICTION',
          `${action}: ${candidate.id} ${evidence
            .filter((entry) => entry.polarity === 'NEGATIVE')
            .map((entry) => `${entry.kind} (${entry.detail})`)
            .join('; ')}`,
        );
    }
    const decision = decide(ranked, settings.minScore, settings.ambiguityMargin);
    const sourceOf = new Map(found.candidates.map((candidate) => [candidate.id, candidate.source]));
    const best = ranked.find((candidate) => !candidate.rejected);
    const contradictory =
      best !== undefined &&
      (best.contradictions?.length ?? 0) > 0 &&
      (best.evidence ?? []).some((entry) => entry.polarity === 'POSITIVE');
    let chosen = decision.chosen;
    const trace: TargetResolutionTrace = {
      action,
      recorded: { locator: describeTarget(step.target), fingerprint },
      runtime: {
        locator: describeTarget(step.target),
        fingerprintVerdict:
          cause === 'LOCATOR_NON_UNIQUE'
            ? `NON_UNIQUE (${String(rawMatches ?? 0)} matches)`
            : cause === 'LOCATOR_NOT_FOUND'
              ? 'NOT_FOUND'
              : 'MISMATCH',
        reasons: [...reasons],
      },
      trigger: cause,
      ...(rawMatches !== undefined ? { rawMatches } : {}),
      rerender: { detected: false, evidence: [] },
      identity,
      ...((): Pick<TargetResolutionTrace, 'interaction' | 'actionContext'> => {
        const interaction = interactionTargetIdentityOf(step, identity, temporal);
        return {
          interaction: {
            type: interaction.type,
            semanticIntent: interaction.semanticIntent,
            adapter: interaction.adapter,
            ...(interaction.owner ? { owner: `${interaction.owner.kind}:${interaction.owner.name}` } : {}),
            confidence: interaction.confidence,
          },
          actionContext: actionContextFingerprintOf(interaction, found.screen.route),
        };
      })(),
      temporal,
      screen: found.screen,
      candidates: ranked.map((candidate) => ({
        id: candidate.id,
        score: candidate.score,
        summary: candidateSummary(candidate),
        ...(candidate.rejected ? { rejected: candidate.rejected } : {}),
        source: sourceOf.get(candidate.id) ?? 'PAGE_SCAN',
        positive: (candidate.evidence ?? [])
          .filter((entry) => entry.polarity === 'POSITIVE')
          .map((entry) => entry.kind),
        negative: (candidate.evidence ?? [])
          .filter((entry) => entry.polarity === 'NEGATIVE')
          .map((entry) => `${entry.kind}: ${entry.detail}`),
      })),
      ...(found.scanError ? { scanError: found.scanError } : {}),
      ...(this.lastTransition
        ? {
            previousTransition: {
              status: this.lastTransition.status,
              signals: this.lastTransition.evidence.slice(0, 12),
              missing: this.lastTransition.missing,
              stable: this.lastTransition.stable,
            },
          }
        : {}),
      ...(best ? { evidenceStatus: contradictory ? 'CONTRADICTORY_EVIDENCE' : 'CONSISTENT' } : {}),
      decision: decision.status,
      reason: decision.reason,
      ai: { requested: false, outcome: 'NOT_REQUIRED' },
      status: 'TARGET_REQUIRES_REPLAY_VALIDATION',
    };
    const trigger = aiTriggerOf(decision);
    if (trigger) {
      trace.ai.trigger = trigger;
      const advice = await this.adviseTargetResolution(flow, step, trace, ranked);
      if (advice?.chosen) chosen = advice.chosen;
    }
    // RUNTIME RE-RESOLUTION : la cible retenue doit être encore là, unique, visible et actionnable.
    if (chosen) {
      const live = page.locator(candidateSelector(found.token, chosen.id));
      const count = await live.count().catch(() => 0);
      const visible = count === 1 && (await live.isVisible().catch(() => false));
      const usable =
        visible && (identity.interaction !== 'FILL' || (await live.isEditable().catch(() => false)));
      if (!usable) {
        const detail = `${chosen.id} ${count === 0 ? 'is gone' : count > 1 ? 'is no longer unique' : 'is not actionable'} at runtime`;
        if (trace.ai.outcome === 'VALIDATED') {
          trace.ai.outcome = 'REJECTED';
          trace.ai.rejection = 'AI_PROPOSAL_RUNTIME_REJECTED';
          this.emitHealing(
            'AI_TARGET_PROPOSAL_REJECTED',
            `${action}: AI_PROPOSAL_RUNTIME_REJECTED — ${detail}`,
          );
          if (trace.ai.auditId) this.aiRuntime(trace.ai.auditId, false, detail);
        }
        trace.reason = `${trace.reason}; ${detail}`;
        chosen = undefined;
      }
    }
    if (chosen) {
      // Un localisateur non unique n'a rien à voir avec un re-rendu : c'est le contexte qui a tranché.
      trace.rerender =
        cause === 'FINGERPRINT_MISMATCH'
          ? analyzeRerender(chosen, temporal, reasons)
          : { detected: false, evidence: [] };
      trace.resolution = chosen.id;
      if (trace.ai.outcome === 'VALIDATED') trace.status = 'TARGET_AI_ASSISTED';
      else
        trace.status = trace.rerender.detected
          ? 'TARGET_RERENDERED'
          : cause === 'LOCATOR_NON_UNIQUE'
            ? 'TARGET_CONTEXTUAL_MATCH'
            : chosen.matchesRecordedLocator
              ? 'TARGET_FUNCTIONALLY_EQUIVALENT'
              : 'TARGET_HEALED';
      if (trace.rerender.detected)
        this.emitHealing('TARGET_RERENDERED', `${trace.action}: ${trace.rerender.evidence.join('; ')}`);
      await clearCandidateMarks(page, found.token, chosen.id);
    } else {
      // Jamais masquer une régression : ambigu, contradictoire ou sans candidat reste un échec honnête.
      trace.status =
        ranked.length === 0
          ? 'TARGET_NO_CANDIDATE'
          : decision.status === 'AMBIGUOUS' && ranked.filter((candidate) => !candidate.rejected).length >= 2
            ? 'TARGET_AMBIGUOUS'
            : decision.reason.includes('context mismatch')
              ? 'TARGET_CONTEXT_MISMATCH'
              : contradictory
                ? 'TARGET_CONTRADICTORY_EVIDENCE'
                : 'TARGET_FUNCTIONAL_MISMATCH';
      trace.final = 'TARGET_UNRESOLVED';
      await clearCandidateMarks(page, found.token);
    }
    Object.assign(trace, resolutionOutcomeOf(trace, ranked, chosen, cause));
    if (trace.outcome === 'CONTEXTUAL_MATCH')
      this.emitHealing(
        'TARGET_CONTEXTUAL_MATCH',
        `${trace.action}: ${chosen ? candidateSummary(chosen) : ''} · confidence ${String(trace.confidence ?? 0)}`,
      );
    else if (trace.outcome === 'HEALED')
      this.emitHealing(
        'TARGET_HEALED',
        `${trace.action}: ${chosen ? candidateSummary(chosen) : ''} (to be confirmed by the runtime effect)`,
      );
    else if (trace.outcome === 'AMBIGUOUS')
      this.emitHealing(
        'TARGET_AMBIGUOUS',
        `${trace.action}: best ${String(trace.ambiguity?.bestScore ?? 0)} / second ${String(trace.ambiguity?.secondBestScore ?? 0)} — nothing chosen arbitrarily`,
      );
    this.emitHealing('TARGET_RESOLUTION', traceText(trace).join(' | '));
    await this.writeResolutionArtifact(trace);
    return {
      ...(chosen ? { locator: page.locator(candidateSelector(found.token, chosen.id)), chosen } : {}),
      trace,
    };
  }

  /**
   * reports/intelligence/target-resolution/<action>.json, en DEBUG / TRACE seulement : la trace
   * complète (candidats, preuves, contradictions, décision, conseiller, vérification), assainie.
   */
  private async writeResolutionArtifact(trace: TargetResolutionTrace): Promise<void> {
    if (!['DEBUG', 'TRACE'].includes(this.config.logging.level)) return;
    let file = this.resolutionFiles.get(trace);
    if (!file) {
      this.resolutionCount += 1;
      const slug =
        trace.action
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^A-Za-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 80) || 'action';
      file = path.join(
        this.config.output.reportsDir,
        'intelligence',
        'target-resolution',
        `${String(this.resolutionCount).padStart(3, '0')}-${slug}.json`,
      );
      this.resolutionFiles.set(trace, file);
    }
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(redactDeep(trace), null, 2)}\n`, 'utf8');
    } catch {
      // Un artefact de débogage ne fait jamais échouer un rejeu.
    }
  }

  /**
   * TARGET RESOLUTION, conseiller : le contexte STRUCTURÉ (mission, échec, faits connus, action,
   * avant / après, préconditions, identité fonctionnelle, écran compact, candidats avec leurs preuves
   * et contradictions) ; il ne choisit qu'un identifiant fourni, et QA-CRAWLER revalide (candidat
   * fourni, preuves citées existantes, visible, actionnable, compatible, SafetyPolicy), puis le runtime.
   */
  private async adviseTargetResolution(
    flow: FlowConfig,
    step: Extract<FlowStep, { target: unknown }>,
    trace: TargetResolutionTrace,
    ranked: readonly ScoredCandidate[],
  ): Promise<{ chosen?: ScoredCandidate } | undefined> {
    const ai = this.ai;
    if (!ai) return undefined;
    const viable = ranked.filter((candidate) => !candidate.rejected).slice(0, 8);
    const best = viable[0];
    const evaluation = ai.evaluate({
      deterministicConfidence: best?.score ?? 0,
      ambiguousTarget: true,
      inconclusive: true,
    });
    if (!evaluation.shouldInvoke || !evaluation.reason || viable.length === 0) return undefined;
    this.emitHealing(
      'AI_TARGET_TRIGGER',
      `${trace.action}: ${trace.ai.trigger ?? trace.decision} (deterministic ${String(best?.score ?? 0)}, ${String(viable.length)} viable candidate(s))`,
    );
    const kind =
      step.kind === 'fill'
        ? 'fill'
        : step.kind === 'select'
          ? 'select'
          : step.kind === 'check' || step.kind === 'uncheck'
            ? 'check'
            : 'click';
    const candidates: DiscoveredCandidate[] = viable.map((candidate) => ({
      key: candidate.id,
      kind,
      ...(candidate.role ? { role: candidate.role } : {}),
      name: candidateSummary(candidate),
      safety: 'SAFE',
      allowed: true,
      score: candidate.score,
    }));
    const sources: ContextSources = {
      evidence: [],
      hypotheses: [],
      contradictions: [],
      coverageGaps: [],
      candidates,
      workflow: {
        previous: trace.temporal.previousActions.map(
          (action) => `${action.type} ${action.target}${action.value ? ` = ${action.value}` : ''}`,
        ),
        next: trace.temporal.nextActions.map((action) => `${action.type} ${action.target}`),
        requiredFields: [],
      },
      deterministic: { confidence: best?.score ?? 0, status: trace.ai.trigger ?? 'TARGET_AMBIGUOUS' },
    };
    const built = this.aiContext.build(evaluation.reason, sources);
    built.request.targetResolution = targetResolutionRequest(
      trace,
      viable,
      (id) => built.idOf(id) ?? id,
      flow.name,
    );
    // Les seules preuves citables : celles des candidats fournis (une preuve inventée est rejetée).
    const known = new Set(viable.flatMap((candidate) => (candidate.evidence ?? []).map((entry) => entry.id)));
    trace.ai = { ...trace.ai, requested: true, mode: this.config.ai.mode };
    this.emitHealing(
      'AI_TARGET_CONTEXT_BUILT',
      `${trace.action}: candidates ${viable.map((candidate) => `${built.idOf(candidate.id) ?? candidate.id}=${candidate.id}`).join(' ')} · evidence ${String(known.size)} · contradictions ${String(viable.reduce((sum, candidate) => sum + (candidate.contradictions?.length ?? 0), 0))} · previous ${String(trace.temporal.previousActions.length)} · next ${String(trace.temporal.nextActions.length)} · context ${Object.values(trace.identity.configuration).join(' / ') || trace.identity.section || '—'} (sanitized, no DOM)`,
    );
    const result = await ai.consult({
      context: 'RECOVERY',
      request: built.request,
      scope: { action: `target-resolution|${flow.name}|${trace.action}` },
      deterministic: { confidence: best?.score ?? 0 },
      safety: (id) => {
        const key = built.keyOf(id);
        const candidate = viable.find((entry) => entry.id === key);
        if (!candidate)
          return { allowed: false, classification: 'UNKNOWN', reason: 'not a provided candidate' };
        const classification = this.safety.classify({
          type: kind,
          category: 'other',
          text: candidate.name,
        }).classification;
        const allowed =
          candidate.visible &&
          candidate.enabled &&
          (kind !== 'fill' || candidate.editable) &&
          (classification === 'SAFE' || step.allow.some((allowedClass) => allowedClass === classification));
        return {
          allowed,
          classification,
          reason: allowed ? 'visible, actionable, context-compatible' : 'not actionable or not allowed',
        };
      },
      knownEvidence: (id) => known.has(id),
    });
    this.learnAiProposal(result);
    trace.ai.auditId = result.record.id;
    const validation = result.validation;
    if (!validation) {
      trace.ai.outcome = 'UNAVAILABLE';
      this.emitHealing('AI_TARGET_PROPOSAL', `${trace.action}: no answer (${result.record.outcome})`);
      return undefined;
    }
    if (!validation.valid) {
      // Un identifiant qui n'est pas un candidat fourni (T99) : AI_PROPOSAL_INVALID_CANDIDATE.
      trace.ai.outcome = 'REJECTED';
      trace.ai.rejection =
        validation.rejection === 'AI_PROPOSAL_UNKNOWN_ACTION' ||
        (validation.rejection === 'AI_PROPOSAL_INVALID_SCHEMA' &&
          validation.reasons.some((reason) => reason.startsWith('selectedActionId'))) ||
        validation.rejection === 'AI_PROPOSAL_INCOMPATIBLE'
          ? 'AI_PROPOSAL_INVALID_CANDIDATE'
          : validation.rejection;
      if (validation.proposal?.selectedActionId) trace.ai.proposal = validation.proposal.selectedActionId;
      this.emitHealing(
        'AI_TARGET_PROPOSAL_REJECTED',
        `${trace.action}: ${trace.ai.rejection} — ${validation.reasons.slice(0, 2).join('; ')}`,
      );
      return undefined;
    }
    const proposal = validation.proposal;
    const proposedKey = proposal.selectedActionId ? built.keyOf(proposal.selectedActionId) : undefined;
    trace.ai.confidence = proposal.confidence;
    if (proposal.supportingEvidenceIds.length > 0)
      trace.ai.citedEvidence = [...proposal.supportingEvidenceIds];
    if (proposedKey) trace.ai.proposal = proposedKey;
    this.emitHealing(
      'AI_TARGET_PROPOSAL',
      `${trace.action}: ${proposedKey ? `selected ${proposedKey}` : proposal.status} confidence ${String(proposal.confidence)}${proposal.supportingEvidenceIds.length > 0 ? ` · evidence ${proposal.supportingEvidenceIds.join(' ')}` : ''}`,
    );
    if (!proposedKey) {
      trace.ai.outcome = 'INCONCLUSIVE';
      return undefined;
    }
    const chosen = viable.find((candidate) => candidate.id === proposedKey);
    if (!chosen) {
      trace.ai.outcome = 'REJECTED';
      trace.ai.rejection = 'AI_PROPOSAL_INVALID_CANDIDATE';
      this.emitHealing(
        'AI_TARGET_PROPOSAL_REJECTED',
        `${trace.action}: AI_PROPOSAL_INVALID_CANDIDATE — ${proposedKey}`,
      );
      return undefined;
    }
    if (!result.decision.accepted) {
      // ASSIST : consignée, jamais appliquée ; HYBRID : refusée (SafetyPolicy, confiance, compatibilité).
      if (this.config.ai.mode === 'ASSIST') trace.ai.outcome = 'RECORDED_ONLY';
      else {
        trace.ai.outcome = 'REJECTED';
        trace.ai.rejection = result.decision.code;
        this.emitHealing(
          'AI_TARGET_PROPOSAL_REJECTED',
          `${trace.action}: ${result.decision.code} — ${result.decision.reasons.slice(0, 2).join('; ')}`,
        );
      }
      return undefined;
    }
    trace.ai.outcome = 'VALIDATED';
    return { chosen };
  }

  /** La valeur que tient le champ (relu ; s'il a été re-rendu, retrouvé par son localisateur). */
  /** Le CSS préféré enregistré, compté sur le DOM actuel : désigne-t-il UN élément, celui utilisé ? */
  private async cssResolutionOf(
    page: Page,
    located: Locator,
    css: NonNullable<TargetFingerprint['css']>,
  ): Promise<CssResolutionReport | undefined> {
    const preferred = css.preferred;
    if (!preferred) return undefined;
    const count = async (selector: string): Promise<number> =>
      page
        .locator(selector)
        .count()
        .catch(() => 0);
    const currentMatches = await count(preferred.selector);
    const same =
      currentMatches === 1
        ? await located
            .evaluate((el, selector) => document.querySelector(selector) === el, preferred.selector)
            .catch(() => false)
        : false;
    return {
      recordedPreferred: preferred.selector,
      ...(preferred.matchCount !== undefined ? { recordedMatches: preferred.matchCount } : {}),
      currentMatches,
      resolution:
        currentMatches === 0
          ? 'CSS_NOT_FOUND'
          : currentMatches > 1
            ? 'CSS_AMBIGUOUS'
            : same
              ? 'CSS_CONFIRMED'
              : 'CSS_CONFLICT',
      ...(css.fallback
        ? {
            fallback: {
              selector: css.fallback.selector,
              ...(css.fallback.matchCount !== undefined ? { recordedMatches: css.fallback.matchCount } : {}),
              currentMatches: await count(css.fallback.selector),
            },
          }
        : {}),
    };
  }

  /** Le champ réellement rempli, relu : attaché ? sa valeur, invalide ? sinon son remplaçant (re-rendu). */
  private async probeFilledField(
    page: Page,
    locator: Locator,
    target: FlowTarget,
  ): Promise<FieldProbe | undefined> {
    const read = await locator
      .evaluate(
        (el) => {
          const input = el as HTMLInputElement;
          const box = el.closest('mat-form-field, .mat-mdc-form-field, .form-group, fieldset');
          const error = box?.querySelector(
            'mat-error, .mat-mdc-form-field-error, .invalid-feedback, [role="alert"]',
          );
          return {
            attached: el.isConnected,
            value: typeof input.value === 'string' ? input.value : undefined,
            invalid:
              el.getAttribute('aria-invalid') === 'true' ||
              (error !== null && error !== undefined && (error.textContent || '').trim() !== ''),
          };
        },
        undefined,
        { timeout: 500 },
      )
      .catch(() => ({ attached: false, value: undefined, invalid: false }));
    if (read.attached)
      return {
        attached: true,
        ...(read.value !== undefined ? { value: read.value } : {}),
        ...(read.invalid ? { invalid: true } : {}),
      };
    const again = await this.flowSteps.locate(page, target, 500);
    const rerendered =
      typeof again === 'string' ? undefined : await again.inputValue({ timeout: 500 }).catch(() => undefined);
    // Un marqueur de résolution contextuelle (data-qa-crawler-target) est retiré à la résolution suivante :
    // sa disparition ne dit pas que le champ a été re-rendu — le champ retrouvé est lu comme le même.
    if (
      (locator as unknown as { toString(): string }).toString().includes('data-qa-crawler-target') &&
      rerendered !== undefined
    )
      return { attached: true, value: rerendered };
    return { attached: false, ...(rerendered !== undefined ? { rerenderedValue: rerendered } : {}) };
  }

  /**
   * VALUE_RESTORED_AFTER_APPLICATION_RESET : attendre que l'écran soit calme (réseau corrélé terminé,
   * DOM stable — jamais un sommeil fixe), retrouver LE champ enregistré (CSS ambigu refusé, empreinte
   * vérifiée), le remplir une seule fois, attendre de nouveau le calme, puis relire. undefined : le
   * champ n'est plus trouvable ou c'est un autre — rien n'est rempli.
   */
  private async refillAfterApplicationReset(
    page: Page,
    target: FlowTarget,
    fingerprint: TargetFingerprint | undefined,
    value: string,
    input: { actionId: string; timeout: number },
  ): Promise<{ locator: Locator; held: boolean } | undefined> {
    const sync = this.config.replay.synchronization;
    const settle = async (): Promise<void> => {
      const before = await installTransitionProbe(page);
      if (!before) return;
      await this.transitionWaiter.waitForTransition({
        page,
        expectation: { expected: false, effectsDeclared: false, nextAwaited: false, nextKnown: false },
        before,
        ...(sync.observeNetwork
          ? {
              network: () =>
                this.networkTrace.activity(input.actionId, {
                  correlationMs: sync.networkCorrelationMs,
                  pendingCapMs: sync.networkPendingCapMs,
                }),
            }
          : {}),
      });
    };
    await settle();
    const again = await this.flowSteps.locate(page, target, Math.min(input.timeout, 2000), { strict: true });
    if (typeof again === 'string') return undefined;
    if (fingerprint && matchFingerprint(fingerprint, await readTarget(again)).verdict === 'MISMATCH')
      return undefined;
    const failure = await this.flowSteps.perform(page, again, { kind: 'fill', value }, input.timeout, false);
    if (failure) return undefined;
    await settle();
    const held = await this.filledValue(page, again, target);
    return { locator: again, held: held !== undefined && sameFilledValue(held, value) };
  }

  /** Une saisie confirmée : relue avant la prochaine étape qui écrit sur le même écran. */
  private rememberFilled(page: Page, target: FlowTarget, value: string, label: string): void {
    const route = pathOf(page.url());
    const key = describeTarget(target);
    // Un autre écran : les saisies précédentes ne le concernent plus ; le même champ rempli de nouveau
    // ne garde que la dernière valeur (une correction du parcours).
    this.filledOnScreen = this.filledOnScreen.filter((entry) => entry.route === route && entry.key !== key);
    this.filledOnScreen.push({ key, route, target, value, label });
  }

  /** Les saisies de cet écran que l'application a retirées depuis (vidées, écrasées). Lecture seule. */
  private async filledValuesLost(
    page: Page,
  ): Promise<{ label: string; kind: ValueLossKind; reason: string }[]> {
    const route = pathOf(page.url());
    const lost: { label: string; kind: ValueLossKind; reason: string }[] = [];
    for (const entry of this.filledOnScreen.filter((item) => item.route === route).slice(-20)) {
      const found = await this.flowSteps.locate(page, entry.target, 200, { strict: true });
      // Un champ caché ou retiré par le parcours (section repliée, étape suivante) n'est pas une perte.
      if (typeof found === 'string') continue;
      const held = await found.inputValue({ timeout: 300 }).catch(() => undefined);
      if (held === undefined || sameFilledValue(held, entry.value)) continue;
      const loss = classifyValueLoss({ expected: entry.value, probe: { attached: true, value: held } });
      if (restorableValueLoss(loss)) lost.push({ label: entry.label, ...loss });
    }
    return lost;
  }

  private async filledValue(page: Page, locator: Locator, target: FlowTarget): Promise<string | undefined> {
    const held = await locator.inputValue({ timeout: 1000 }).catch(() => undefined);
    if (held !== undefined) return held;
    const again = await this.flowSteps.locate(page, target, 1000);
    return typeof again === 'string' ? undefined : again.inputValue({ timeout: 1000 }).catch(() => undefined);
  }

  /**
   * RUNTIME PROVES : l'effet confirme (ou rejette) la résolution ; l'action suivante disponible la
   * renforce ; une proposition du conseiller est confirmée ou contredite ; une connaissance
   * CANDIDATE (jamais une vérité globale) est notée quand l'effet est confirmé.
   */
  private async confirmTargetResolution(
    page: Page,
    trace: TargetResolutionTrace,
    confirmed: boolean | undefined,
    contradiction?: string,
    /** Ce qui a confirmé l'effet (un clic : ACTION_CONFIRMED et l'effet observé). */
    confirmation?: string,
  ): Promise<void> {
    const next = this.nextStepTarget();
    trace.nextAction = next
      ? (await this.targetAvailable(page, next, 300))
        ? 'AVAILABLE'
        : 'NOT_AVAILABLE'
      : 'NOT_CHECKED';
    trace.runtimeVerification =
      confirmed === undefined
        ? { status: 'NOT_VERIFIED', detail: 'the effect could not be read' }
        : confirmed
          ? {
              status: 'CONFIRMED',
              detail: `${confirmation ?? 'VALUE_CHANGED confirmed'}${trace.nextAction === 'AVAILABLE' ? '; the next action remains available' : ''}`,
            }
          : { status: 'REJECTED', detail: contradiction ?? 'the field does not hold the filled value' };
    trace.final =
      confirmed === false
        ? 'TARGET_RECOVERY_REJECTED'
        : confirmed
          ? 'TARGET_RECOVERED_AND_CONFIRMED'
          : 'TARGET_RESOLVED_NOT_VERIFIED';
    // NE PAS APPRENDRE AVANT CONFIRMATION : une connaissance candidate seulement si l'effet est prouvé.
    if (trace.outcome === 'HEALED')
      this.emitHealing(
        confirmed ? 'TARGET_HEALING_CONFIRMED' : 'TARGET_HEALING_REJECTED',
        `${trace.action}: ${confirmed ? 'runtime effect confirmed — knowledge candidate' : confirmed === false ? 'runtime effect contradicted — nothing learned' : 'effect not verifiable — nothing learned'}`,
      );
    if (confirmed)
      trace.knowledge = {
        functionalTarget: trace.identity.businessConcept ?? trace.identity.semanticRole,
        context: {
          ...(trace.identity.dialog ? { dialog: trace.identity.dialog } : {}),
          ...(trace.identity.section ? { section: trace.identity.section } : {}),
          ...trace.identity.configuration,
        },
        knownRepresentations: [
          ...new Set([
            trace.recorded.locator,
            ...(trace.resolution
              ? [trace.candidates.find((candidate) => candidate.id === trace.resolution)?.summary ?? '']
              : []),
          ]),
        ].filter(Boolean),
        rerenderSensitive: trace.rerender.detected,
        status: 'CANDIDATE',
        globallyTrusted: false,
      };
    if (trace.ai.outcome === 'VALIDATED' && trace.ai.auditId && confirmed !== undefined) {
      this.aiRuntime(trace.ai.auditId, confirmed, trace.runtimeVerification.detail);
      this.emitHealing(
        !confirmed ? 'AI_TARGET_RUNTIME_CONTRADICTED' : 'AI_TARGET_RUNTIME_CONFIRMED',
        `${trace.action}: ${trace.runtimeVerification.detail}`,
      );
    }
    if (confirmed === false) trace.status = 'TARGET_RUNTIME_REJECTED';
    this.emitHealing(
      'TARGET_RESOLUTION',
      `${trace.action}: ${trace.final} (${trace.runtimeVerification.detail})`,
    );
    await this.writeResolutionArtifact(trace);
  }

  private async healTarget(
    page: Page,
    target: FlowTarget,
    fingerprint: TargetFingerprint,
    timeoutMs: number,
  ): Promise<
    { locator: Locator; target: FlowTarget; match: { verdict: string; score: number } } | undefined
  > {
    for (const candidate of healingCandidates(fingerprint, target)) {
      const found = await this.flowSteps.locate(page, candidate, Math.min(timeoutMs, 1500), { strict: true });
      if (typeof found === 'string') continue;
      const observed = await readTarget(found);
      const match = matchFingerprint(fingerprint, observed);
      // FOUND ELEMENT ≠ CORRECT ELEMENT : le même nom sur un autre GENRE d'élément (le libellé, une
      // option, un titre « Company name » pour un champ) n'est jamais la cible.
      const sameKind =
        (!fingerprint.tag || !observed.tag || fingerprint.tag === observed.tag) &&
        (!fingerprint.role || !observed.role || compatibleRoles(fingerprint.role, observed.role));
      if (match.verdict !== 'MISMATCH' && sameKind)
        return { locator: found, target: candidate, match: { verdict: match.verdict, score: match.score } };
    }
    return undefined;
  }

  /**
   * WORKFLOW SELF-HEALING, côté explorateur : seulement les accès (écran, réseau, SafetyPolicy,
   * connaissances) ; tout le raisonnement est dans healWorkflow. Une récupération ne déclenche
   * jamais une autre récupération ; une récupération réussie est apprise quand l'étape suivante
   * aura confirmé que le parcours continue.
   */
  private async healDivergence(
    symptom: DivergenceSymptom,
    failure: { page: Page; context?: PageContext; report: FlowStepReport },
    at: {
      browser: BrowserManager;
      observers: { all: PageObserver[]; pageErrors: PageErrorObserver };
      flow: FlowConfig;
      step: Extract<FlowStep, { target: unknown }>;
      context: PageContext;
      timeout: number;
      finish: (status: FlowStatus, extra?: Partial<FlowStepReport>) => FlowStepReport;
    },
  ): Promise<{ page: Page; context?: PageContext; report: FlowStepReport }> {
    const options = this.config.replay.intelligentRecovery;
    const position = this.stepPosition;
    const page = failure.page;
    if (!options.enabled || this.healingDepth > 0 || position?.flow !== at.flow) return failure;
    if (page.isClosed() || !this.isExplorablePage(page)) return failure;
    const previous = this.currentFlowReport?.steps.at(-1);
    this.healingDepth += 1;
    let result: Awaited<ReturnType<typeof healWorkflow>>;
    try {
      result = await healWorkflow(
        {
          steps: at.flow.steps,
          position: position.index - 1,
          actionId: `${at.flow.name}#${String(position.index)}`,
          symptom,
          ...(failure.report.reason
            ? { technicalSymptom: failure.report.reason.split(':')[0] ?? symptom }
            : {}),
          ...(this.config.authorization.primaryActor
            ? { expectedRole: this.config.authorization.primaryActor }
            : {}),
          history: [...this.stepContexts],
          identifiable:
            !isTechnicalTarget(at.step.target) ||
            Boolean(at.step.fingerprint?.name ?? at.step.fingerprint?.text ?? at.step.fingerprint?.testId),
          ...(previous
            ? {
                previous: {
                  index: previous.index,
                  deferredEffect: previous.effect?.deferred === true,
                  description: previous.description,
                  observed: previous.effect?.observed ?? [],
                },
              }
            : {}),
        },
        this.healingPorts(page),
        {
          analyzeDivergence: options.analyzeDivergence,
          useWorkflowContext: options.useWorkflowContext,
          inferFunctionalGoals: options.inferFunctionalGoals,
          goalBasedRecovery: options.goalBasedRecovery,
          useStaticKnowledge: options.useStaticKnowledge,
          useHistoricalRecovery: options.useHistoricalRecovery,
          onAmbiguity: options.onAmbiguity,
          budgets: options.budgets,
        },
      );
    } catch (error) {
      this.emitHealing(
        'GOAL_RECOVERY_FAILED',
        `recovery aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
      return failure;
    } finally {
      this.healingDepth -= 1;
    }
    const recovery = result.report;
    const outcome = recovery.outcome;
    if (outcome.status !== 'GOAL_REACHED' && outcome.status !== 'GOAL_ALREADY_REACHED') {
      return {
        ...failure,
        report: {
          ...failure.report,
          reason: `${failure.report.reason ?? 'step failed'} — ${outcome.status} (${recovery.divergence.category} ${String(recovery.divergence.confidence)})${outcome.reasons[0] ? `: ${outcome.reasons[0]}` : ''}`,
          recovery,
        },
      };
    }
    if (result.learning)
      this.pendingLearning = { index: position.index, input: result.learning, report: recovery };
    // L'objectif atteint n'est que la PRÉCONDITION de l'action d'origine (le champ, la case, la cible
    // d'un contexte rétabli — onglet sélectionné, section ouverte) : l'action elle-même doit encore
    // être exécutée. Jamais « réussie » sans avoir coché la case ni cliqué la cible.
    const contextRestored = recovery.divergence.expectedTarget?.contextMismatch !== undefined;
    if (
      at.step.kind === 'fill' ||
      at.step.kind === 'select' ||
      at.step.kind === 'check' ||
      at.step.kind === 'uncheck' ||
      contextRestored
    ) {
      // Le chemin a rendu la cible disponible : l'étape d'origine agit maintenant.
      this.healingDepth += 1;
      try {
        const fresh = await this.observeState(page, at.context.metadata.depth).catch(() => at.context);
        const again = await this.runFlowElementStep(
          page,
          at.browser,
          at.observers,
          at.flow,
          at.step,
          fresh,
          at.timeout,
          at.finish,
        );
        // L'objectif atteint n'était que la PRÉCONDITION de la saisie : si le champ reste introuvable,
        // l'étape n'est pas récupérée (jamais RECOVERED sur une étape en échec, jamais une cible validée).
        if (again.report.status !== 'PASSED')
          return {
            ...again,
            report: {
              ...again.report,
              recovery: {
                ...recovery,
                outcome: {
                  ...outcome,
                  status: 'NO_SAFE_RECOVERY',
                  reasons: [
                    `${outcome.status} only reached the precondition of this ${at.step.kind}: the step itself still fails`,
                    ...outcome.reasons,
                  ],
                },
              },
            },
          };
        return { ...again, report: { ...again.report, recovery } };
      } finally {
        this.healingDepth -= 1;
      }
    }
    const after = await this.observeState(page, at.context.metadata.depth + 1);
    const pathText = outcome.path
      .map((action) => `${action.kind} ${action.role} "${action.name}"`)
      .join(' → ');
    return {
      page,
      context: after,
      report: at.finish('PASSED', {
        reason:
          outcome.status === 'GOAL_ALREADY_REACHED'
            ? `GOAL_ALREADY_REACHED: ${recovery.goal.id} holds without "${recovery.originalTarget}" (possibly obsolete step)`
            : `GOAL_RECOVERED (${recovery.divergence.category}): ${pathText} reached ${recovery.goal.id}`,
        stateId: after.stateId,
        url: after.url,
        effect: {
          execution: outcome.path.length > 0 ? 'EXECUTED' : 'NOT_EXECUTED',
          status: 'CONFIRMED',
          expected: recovery.goal.predicates.map(predicateText),
          observed: outcome.progress?.satisfied ?? [],
          reasons: outcome.reasons,
          ...(pathText ? { locator: pathText } : {}),
          recovery: failure.report.effect?.recovery ?? [],
        },
        recovery,
      }),
    };
  }

  /** Une action exécutée : ce qu'elle a changé devient des hypothèses causales (jamais des vérités). */
  private observeCognitive(
    kind: string,
    label: string,
    before: UiSnapshot | undefined,
    beforeRoute: string,
    afterRoute: string,
    network: readonly NetworkExchange[] | undefined,
    source: string,
  ): void {
    if (!this.cognitive || !this.config.cognitive.learnCausality) return;
    this.cognitive.observeAction({
      kind,
      label,
      ...(before ? { before } : {}),
      ...(this.lastSnapshot ? { after: this.lastSnapshot } : {}),
      beforeRoute,
      afterRoute,
      requests: (network ?? []).map(
        (exchange) =>
          `${exchange.method.toUpperCase()} ${pathOf(exchange.url)}${exchange.status !== undefined ? ` ${String(exchange.status)}` : ''}`,
      ),
      source,
      ...(this.actionClock > 0
        ? {
            timing: {
              observedAfterMs: Date.now() - this.actionClock,
              durations: (network ?? []).map((exchange) => exchange.durationMs),
              busy: before?.signals?.busy === true || this.lastSnapshot?.signals?.busy === true,
            },
          }
        : {}),
    });
  }

  /**
   * CONTRADICTIONS : ce que l'écran déclare (required) et ce que le code impose (Validators.required)
   * pour un même contrôle. Un désaccord est enregistré et visible, jamais résolu en silence.
   */
  private claimRequiredFields(snapshot: UiSnapshot, route: string): void {
    const knowledge = this.staticKnowledge;
    if (!knowledge || !this.cognitive) return;
    for (const element of snapshot.elements) {
      if (!element.visible || !element.frameworkName) continue;
      const validators = knowledge.validatorsFor(element.frameworkName, route);
      if (validators.length === 0) continue;
      const property = `${element.label ?? element.name}.required`;
      this.cognitive.claim({
        property,
        source: 'RUNTIME',
        value: element.required,
        detail: `screen ${route}`,
      });
      this.cognitive.claim({
        property,
        source: 'STATIC_SOURCE',
        value: validators.some(
          (validator) => validator.kind === 'required' || validator.kind === 'requiredTrue',
        ),
        detail: element.frameworkName,
      });
    }
  }

  /** FAILURE UNDERSTANDING et couverture des envois, après chaque étape de flow. */
  private understandStep(
    step: FlowStep,
    report: FlowStepReport,
    exchanges: readonly NetworkExchange[],
  ): FailureUnderstanding | undefined {
    const cognitive = this.cognitive;
    if (!cognitive) return undefined;
    const writes = exchanges.filter(
      (exchange) => !['GET', 'HEAD', 'OPTIONS'].includes(exchange.method.toUpperCase()),
    );
    const label = 'target' in step ? (step.target.name ?? step.target.value ?? '') : '';
    const submitStep = writes.length > 0 || (label !== '' && cognitive.isSubmitAction(label));
    if (report.status === 'PASSED') {
      const accepted = writes.some(
        (exchange) => exchange.status !== undefined && exchange.status >= 200 && exchange.status < 300,
      );
      if (accepted && report.effect?.status === 'CONFIRMED')
        cognitive.submissionSucceeded(`step ${String(report.index)}`, label || report.description);
      else if (submitStep)
        // L'envoi a été fait sans effet confirmé : la preuve d'un objectif bloqué « sans raison connue ».
        cognitive.submissionAttempted({
          step: `step ${String(report.index)}`,
          label: label || report.description,
          outcome: 'UNCONFIRMED',
          detail: `${writes.length > 0 ? `${String(writes.length)} write(s), none accepted with a confirmed effect` : 'no write observed'}; effect ${report.effect?.status ?? 'not verified'}`,
        });
      return undefined;
    }
    if (submitStep && (report.status === 'FAILED' || report.status === 'BLOCKED'))
      cognitive.submissionAttempted({
        step: `step ${String(report.index)} "${report.description}"`,
        label: label || report.description,
        outcome: 'FAILED',
        detail: (report.reason ?? report.status).slice(0, 160),
      });
    if (report.status !== 'FAILED' && report.status !== 'BLOCKED') return undefined;
    const failing = [...exchanges]
      .reverse()
      .find((exchange) => (exchange.status ?? 0) >= 400 || exchange.failure);
    const reason = report.reason ?? '';
    return cognitive.understand(
      {
        ...(failing?.status !== undefined ? { status: failing.status } : {}),
        ...(failing ? { request: `${failing.method.toUpperCase()} ${pathOf(failing.url)}` } : {}),
        message: reason.slice(0, 160),
        ...(!failing && /within \d+ ?ms|timeout/i.test(reason) && !/not found|not visible/i.test(reason)
          ? { timedOut: true }
          : {}),
        ...(report.effect?.status === 'NO_EFFECT' || report.effect?.status === 'WRONG_EFFECT'
          ? { effectMissing: true }
          : {}),
        ...(/not found|not visible|disabled|MISMATCH|not clicked/i.test(reason) ? { uiProblem: true } : {}),
        ...(report.recovery
          ? { workflowDivergence: true, divergence: report.recovery.divergence.category }
          : {}),
      },
      `step ${String(report.index)} "${report.description}"`,
    );
  }

  private async loadRecordingCandidates(): Promise<void> {
    const cognitive = this.cognitive;
    if (!cognitive) return;
    const candidates = await loadRecordingCandidates(recordingCandidatesFile(this.config.output.reportsDir));
    for (const candidate of candidates.slice(-50))
      if (candidate.kind === 'CAUSAL' && candidate.observable && candidate.usage === 'HYPOTHESIS')
        cognitive.registerRecordingCandidate({
          id: candidate.id,
          statement: candidate.statement,
          sourceRecording: candidate.sourceRecording,
          ...(candidate.aiDecisionId ? { aiDecisionId: candidate.aiDecisionId } : {}),
          observable: candidate.observable,
        });
  }

  /**
   * COVERAGE GAP EXPLAINED : un objectif UNREACHABLE / BLOCKED dit pourquoi — dernier checkpoint,
   * objectif bloquant, préconditions manquantes, première divergence, preuves, hypothèse de l'IA.
   * L'IA peut avoir proposé une explication ; elle ne change jamais le statut (le runtime seul le peut).
   */
  private explainUnreachedGoals(stopReason: StopReason): void {
    const cognitive = this.cognitive;
    if (!this.goals || !cognitive) return;
    const analysis = cognitive.blockedGoal();
    const divergence = cognitive.latestDivergence();
    const aiHypotheses = cognitive
      .hypothesisDetails()
      .filter((detail) => detail.origin === 'AI_PROPOSAL' && detail.status !== 'REJECTED')
      .slice(-3)
      .map((detail) => `${detail.id} ${detail.description} — ${detail.status}`);
    for (const goal of this.goals.goals) {
      if (goal.status !== 'UNREACHABLE' && goal.status !== 'BLOCKED') continue;
      const missing = analysis?.missingPreconditions ?? [];
      const reason = analysis?.blockingReasons[0]
        ? analysis.blockingReasons[0]
        : divergence
          ? `the journey diverged at step ${String(divergence.divergence.step)} (${divergence.divergence.kind})`
          : (goal.reason ?? `not observed before the end of the exploration (${stopReason})`);
      goal.explanation = {
        reason: reason.slice(0, 300),
        ...(analysis?.lastConfirmedCheckpoint
          ? { lastReachedCheckpoint: analysis.lastConfirmedCheckpoint }
          : {}),
        ...(analysis && analysis.state !== 'SATISFIED' ? { blockingGoal: analysis.node } : {}),
        missingPreconditions: missing,
        ...(divergence
          ? {
              firstDivergence:
                `${divergence.flow}: step ${String(divergence.divergence.step)} "${divergence.divergence.description}" (${divergence.divergence.kind})`.slice(
                  0,
                  200,
                ),
            }
          : {}),
        supportingEvidence: [
          ...goal.evidence.map((evidence) => `${evidence.kind}: ${evidence.value}`),
          ...(analysis?.candidateHypotheses ?? []),
        ].slice(0, 8),
        aiHypotheses,
        confidence: analysis?.confidence ?? 0.3,
      };
    }
  }

  /** Les hypothèses vont dans la KnowledgeBase ; les vues de débogage dans reports/cognitive/. */
  private async persistCognitive(): Promise<void> {
    const cognitive = this.cognitive;
    if (!cognitive) return;
    // ACTIVE LEARNING : les expériences SÛRES qui départageraient des hypothèses concurrentes.
    cognitive.proposeExperiments(
      new Set(
        (this.lastSnapshot?.elements ?? [])
          .filter((element) => element.visible && !element.disabled && element.role && element.name)
          .map((element) => `${element.role}:${element.name.toLowerCase()}`),
      ),
      (action) =>
        this.judgeRecovery(
          {
            role: action.role ?? (action.kind === 'check' ? 'checkbox' : 'button'),
            name: action.label,
            visible: true,
            disabled: false,
          },
          action.kind === 'check' || action.kind === 'uncheck' ? 'check' : 'click',
        ).risk,
    );
    this.knowledge.saveCognitiveKnowledge(cognitive.export());
    if (!this.config.cognitive.writeArtifacts) return;
    const directory = path.join(this.config.output.reportsDir, 'cognitive');
    await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(cognitive.artifacts()))
      await writeFile(path.join(directory, name), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  }

  /**
   * QA REASONING (une fois par écran) : la décision raisonnée devient un signal du moteur de
   * décision existant. Le conseiller n'est consulté que si le raisonnement reste sans conclusion.
   */
  private async reasonAboutState(context: PageContext): Promise<void> {
    const cognitive = this.cognitive;
    const settings = this.config.cognitive.reasoning;
    if (!cognitive || !settings.enabled || this.reasonedStates.has(context.stateId)) return;
    this.reasonedStates.add(context.stateId);
    const byKey = new Map<string, DiscoveredAction>();
    const actions: ScreenAction[] = context.actions.map((action) => {
      const knowledge = this.knowledge.getActionKnowledge(actionSignature(action));
      byKey.set(action.id, action);
      return {
        key: action.id,
        kind:
          action.type === 'check' || action.type === 'uncheck'
            ? 'check'
            : action.type === 'fill'
              ? 'fill'
              : action.type === 'select'
                ? 'select'
                : 'click',
        label: actionLabel(action),
        ...(action.role ? { role: action.role } : {}),
        safety: action.classification,
        allowed: this.safety.evaluate(action).verdict !== 'BLOCK',
        novel: knowledge === undefined,
        ...(knowledge && knowledge.executionCount > 0
          ? {
              historicalSuccess: knowledge.successCount / knowledge.executionCount,
              failures: knowledge.failureCount,
            }
          : {}),
      };
    });
    const decision = cognitive.reason(actions);
    if (decision.status === 'DECIDED' && decision.selectedAction)
      this.cognitiveSignals.set(`${context.stateId}::${decision.selectedAction.key}`, {
        points: Math.round(20 + 30 * Math.min(1, decision.utility?.total ?? decision.confidence)),
        reason: `${decision.reason ?? 'GOAL'} — ${decision.why.join(', ')}`,
        decision: decision.id,
      });
    else if (decision.status === 'INCONCLUSIVE') {
      const verdict = await cognitive.consultAdvisor(
        this.advisor,
        cognitive.problemOf('INTENT_UNRESOLVED', actions),
        {
          exactLocatorFound: false,
          planKnown: false,
          confidence: decision.confidence,
          maxCalls: settings.maxAdvisorCalls,
        },
      );
      if (verdict?.status === 'ACCEPTED')
        for (const proposed of verdict.actions) {
          const match = actions.find(
            (action) =>
              action.label.toLowerCase() === proposed.label.toLowerCase() && action.kind === proposed.kind,
          );
          // Une proposition acceptée n'est qu'un signal : la SafetyPolicy jugera encore l'action.
          if (match && byKey.has(match.key))
            this.cognitiveSignals.set(`${context.stateId}::${match.key}`, {
              points: 15,
              reason: 'validated advisor proposal',
              decision: decision.id,
            });
        }
    }
    // AI REASONING ADVISOR : seulement si la situation l'exige (FAST PATH sinon).
    if (this.ai) await this.adviseExploration(context, actions, byKey, decision);
  }

  /**
   * AI REASONING ADVISOR, en exploration : appelé seulement quand le raisonnement déterministe
   * est faible, ambigu ou sans conclusion. ASSIST mesure (shadow) ; HYBRID peut donner à une
   * proposition VALIDÉE et SÛRE le signal du moteur de décision — qui reste celui qui choisit,
   * après la SafetyPolicy. Le résultat est vérifié au runtime après l'exécution.
   */
  private async adviseExploration(
    context: PageContext,
    actions: ScreenAction[],
    byKey: ReadonlyMap<string, DiscoveredAction>,
    decision: QAReasoningDecision,
  ): Promise<void> {
    const ai = this.ai;
    const cognitive = this.cognitive;
    if (!ai || !cognitive) return;
    const selected = decision.status === 'DECIDED' ? decision.selectedAction : undefined;
    const confidence = selected ? decision.confidence : 0;
    const sources = cognitive.intelligenceSources();
    const trigger = ai.evaluate({
      deterministicConfidence: confidence,
      inconclusive: decision.status !== 'DECIDED',
      ambiguousTarget: (decision.utility?.ambiguity ?? 0) > 0,
      unresolvedHypothesis: decision.assumptions.length > 0,
      contradiction: decision.status !== 'DECIDED' && sources.contradictions.length > 0,
      evidence: decision.evidence,
    });
    if (!trigger.shouldInvoke || !trigger.reason) return;
    const candidates: DiscoveredCandidate[] = actions.map((action) => ({
      key: action.key,
      kind: action.kind,
      ...(action.role ? { role: action.role } : {}),
      name: action.label,
      safety: action.safety,
      allowed: action.allowed,
      ...(selected?.key === action.key ? { score: confidence } : {}),
    }));
    const full: ContextSources = {
      ...sources,
      candidates,
      deterministic: { ...(selected ? { key: selected.key } : {}), confidence, status: decision.status },
    };
    const built = this.aiContext.build(trigger.reason, full);
    const selectedId = selected ? built.idOf(selected.key) : undefined;
    const result = await ai.consult({
      context: 'EXPLORATION',
      request: built.request,
      scope: { action: context.stateId },
      deterministic: { ...(selectedId ? { actionId: selectedId } : {}), confidence },
      safety: (id) => {
        const candidate = built.candidateOf(id);
        const action = candidate ? byKey.get(candidate.key) : undefined;
        if (!action) return { allowed: false, classification: 'UNKNOWN', reason: 'not a discovered action' };
        const verdict = this.safety.evaluate(action);
        return {
          allowed: verdict.verdict !== 'BLOCK' && action.classification === 'SAFE',
          classification: action.classification,
          reason: verdict.reason,
        };
      },
      knownEvidence: (id) => cognitive.evidence.get(id) !== undefined,
      ...(this.config.ai.copilot.tools ? { tools: toolContextOf(built, full) } : {}),
    });
    const proposal = this.learnAiProposal(result);
    if (!result.decision.accepted || !result.decision.actionId) return;
    const key = built.keyOf(result.decision.actionId);
    if (!key || !byKey.has(key)) return;
    if (selected) this.cognitiveSignals.delete(`${context.stateId}::${selected.key}`);
    this.cognitiveSignals.set(`${context.stateId}::${key}`, {
      points: 60,
      reason: `AI proposal ${result.record.id} (validated; SafetyPolicy ${result.decision.safety?.classification ?? 'SAFE'})`,
      decision: result.record.id,
    });
    const progressBefore = cognitive.goalProgress()?.progress;
    this.aiPending.set(`${context.stateId}::${key}`, {
      auditId: result.record.id,
      expected: (proposal?.expectedEffects ?? []).map((effect) => `${effect.kind}:${effect.value}`),
      ...(progressBefore !== undefined ? { progressBefore } : {}),
    });
  }

  /**
   * RUNTIME TRUTH : une proposition retenue et exécutée a-t-elle produit l'effet attendu ?
   * (contrôles ou champs apparus, route) — sinon AI_RUNTIME_CONTRADICTED, et rien n'est appris.
   */
  private verifyAiProposal(
    key: string,
    before: UiSnapshot | undefined,
    beforeRoute: string,
    afterRoute: string,
    newIssues: number,
  ): void {
    const pending = this.aiPending.get(key);
    if (!pending || !this.ai) return;
    this.aiPending.delete(key);
    const visible = (snapshot: UiSnapshot | undefined): Set<string> =>
      new Set(
        (snapshot?.elements ?? [])
          .filter((element) => element.visible && !element.disabled && element.role && element.name)
          .map((element) => `${element.role}:${normalizeControl(element.name)}`),
      );
    const prior = visible(before);
    const appeared = [...visible(this.lastSnapshot)].filter((entry) => !prior.has(entry));
    const routeChanged = afterRoute !== beforeRoute;
    const checkable = pending.expected.filter((effect) =>
      /^(VISIBLE_CONTROL|VISIBLE_FIELD|ROUTE|NEXT_ACTION_TARGET_AVAILABLE):/.test(effect),
    );
    const matched = checkable.filter((effect) => {
      const [kind, ...rest] = effect.split(':');
      const value = normalizeControl(rest.join(':'));
      if (kind === 'ROUTE') return afterRoute.toLowerCase().includes(value);
      return appeared.some(
        (entry) => entry === value || entry.endsWith(`:${value}`) || entry.includes(value),
      );
    });
    const confirmed =
      newIssues === 0 && (checkable.length > 0 ? matched.length > 0 : appeared.length > 0 || routeChanged);
    this.aiRuntime(
      pending.auditId,
      confirmed,
      confirmed
        ? `observed: ${(matched.length > 0 ? matched : appeared.slice(0, 5)).join(', ') || afterRoute}`
        : `expected ${checkable.join(', ') || 'a visible effect'}; observed ${appeared.slice(0, 5).join(', ') || 'no new control'}${newIssues > 0 ? `, ${String(newIssues)} new issue(s)` : ''}`,
      pending.progressBefore,
    );
  }

  /**
   * Une proposition VALIDE apporte au plus une hypothèse (AI_PROPOSED_HYPOTHESIS, preuve LLM
   * plafonnée, origine gardée) : l'hypothèse elle-même, ou la précondition manquante proposée.
   * Jamais une vérité ; le runtime la jugera.
   */
  private learnAiProposal(result: {
    record: { id: string };
    validation?: ProposalValidation;
  }): IntelligenceProposal | undefined {
    const proposal = result.validation?.valid ? result.validation.proposal : undefined;
    const cognitive = this.cognitive;
    if (!proposal || !cognitive || !this.ai) return proposal;
    const statement =
      proposal.hypothesis?.statement ??
      (proposal.missingPrecondition ? `missing precondition: ${proposal.missingPrecondition}` : undefined);
    if (!statement) return proposal;
    const type =
      proposal.hypothesis?.type ?? (proposal.missingPrecondition ? 'WORKFLOW_PRECONDITION' : undefined);
    const hypothesis = cognitive.recordAiHypothesis(
      statement,
      [...(proposal.hypothesis?.evidenceIds ?? []), ...proposal.supportingEvidenceIds],
      result.record.id,
      type ? { type } : {},
    );
    this.aiHypothesisOf.set(result.record.id, hypothesis.id);
    this.ai.recordKnowledge(result.record.id, {
      impact: 'AI_PROPOSED_HYPOTHESIS',
      hypothesisId: hypothesis.id,
      hypothesisStatus: hypothesis.status,
    });
    return proposal;
  }

  /**
   * RUNTIME TRUTH d'une proposition exécutée : l'audit (confirmée / contredite, avancement de
   * l'objectif avant → après) et l'hypothèse qu'elle portait (preuve runtime pour ou contre).
   */
  private aiRuntime(auditId: string, confirmed: boolean, detail: string, progressBefore?: number): void {
    const ai = this.ai;
    if (!ai) return;
    const progress = this.cognitive?.updateProgress(`AI ${auditId}`);
    ai.recordRuntime(
      auditId,
      confirmed,
      detail,
      progress && progressBefore !== undefined
        ? {
            goal: progress.goal,
            before: progressBefore,
            after: progress.progress,
            impact:
              progress.progress > progressBefore
                ? 'ADVANCED'
                : progress.progress < progressBefore
                  ? 'REGRESSED'
                  : 'NO_CHANGE',
          }
        : undefined,
    );
    const hypothesisId = this.aiHypothesisOf.get(auditId);
    const hypothesis = hypothesisId
      ? this.cognitive?.aiHypothesisRuntime(hypothesisId, confirmed, detail)
      : undefined;
    if (hypothesis)
      ai.recordKnowledge(auditId, {
        impact: confirmed ? 'RUNTIME_SUPPORTED' : 'RUNTIME_CONTRADICTED',
        hypothesisId: hypothesis.id,
        hypothesisStatus: hypothesis.status,
      });
  }

  /**
   * AI REASONING ADVISOR, après une divergence que la récupération déterministe n'a pas su
   * résoudre : au plus UNE action, prise parmi les contrôles présents, jugée par la SafetyPolicy
   * (judgeRecovery : seul SAFE passe). Le healer l'exécute par le driver existant et vérifie
   * l'objectif ; ASSIST ne rend jamais d'action (mesure seulement).
   */
  private async adviseRecovery(input: AdviceInput): Promise<AdvisedRecovery | undefined> {
    const ai = this.ai;
    if (!ai) return undefined;
    const trigger = ai.evaluate({
      deterministicConfidence: 0,
      recoveryExhausted: true,
      flowDivergence: true,
      ambiguousTarget: input.outcome.status === 'AMBIGUOUS_RECOVERY',
    });
    if (!trigger.shouldInvoke || !trigger.reason) return undefined;
    const candidates: DiscoveredCandidate[] = input.controls
      .filter((control) => control.visible && !control.field && control.role && control.name)
      .map((control) => {
        const kind = control.role === 'checkbox' || control.role === 'radio' ? 'check' : 'click';
        const judged = this.judgeRecovery(control, kind);
        const planned = input.plan.candidates.find((candidate) =>
          candidate.signature.endsWith(`${control.role}:${control.name.toLowerCase()}`),
        );
        return {
          key: `${control.role}:${control.name}`,
          kind,
          role: control.role,
          name: control.name,
          safety: judged.risk,
          allowed: judged.allowed,
          ...(control.disabled ? { disabled: true } : {}),
          ...(planned ? { score: planned.confidence } : {}),
        };
      });
    const context = input.context;
    // NEXT ACTION AS EVIDENCE : les cibles des actions suivantes du parcours humain doivent devenir disponibles.
    const nextTargets = [
      ...context.nextActions.map((action) => action.label),
      ...context.requiredFutureFields.map((action) => action.label),
    ].filter((label, index, list) => label.length > 0 && list.indexOf(label) === index);
    const target = input.expectedTarget;
    // FUNCTIONAL GOAL RECOVERY : jamais « trouve un autre localisateur » ; quelle précondition manque ?
    const question = target?.functionalRecovery
      ? `The expected ${target.target.field ? 'field' : 'control'} "${target.target.label}" is ${target.presence === 'HIDDEN' ? 'not visible' : 'not rendered'}. Given the current functional state, the expected target, known dependencies (${target.revealers.map((revealer) => `${revealer.kind} "${revealer.label}"${revealer.hypothetical ? ' (hypothesis)' : ''}`).join(', ') || 'none'}), the recorded journey and the available SAFE actions, what missing precondition most plausibly prevents it from becoming available, and which SAFE action establishes it? Use only the provided evidence and action IDs.`
      : `Which available action is most likely to restore goal ${input.goal.id} (so that the next recorded targets ${nextTargets.slice(0, 4).join(', ') || 'appear'}), using only the provided evidence and action IDs?`;
    const base = this.cognitive?.intelligenceSources({
      question,
      nextActions: context.nextActions.map((action) => `${action.kind} ${action.label}`),
      nextTargets,
      previousActions: context.previousActions.map((action) => `${action.kind} ${action.label}`),
    });
    const sources: ContextSources = {
      ...(base ?? { evidence: [], hypotheses: [], contradictions: [], coverageGaps: [] }),
      goal: { id: input.goal.id, conditions: input.goal.predicates.map(predicateText) },
      workflow: {
        previous: context.previousActions.map((action) => `${action.kind} ${action.label}`),
        next: context.nextActions.map((action) => `${action.kind} ${action.label}`),
        requiredFields: context.requiredFutureFields.map((action) => action.label),
        ...(context.businessIntent ? { intent: context.businessIntent.name } : {}),
      },
      candidates,
      deterministic: { confidence: 0, status: `${input.outcome.status} (${input.divergence})` },
      // L'état fonctionnel de la récupération : cible, chaîne de préconditions, hypothèses rééquilibrées.
      ...(base?.functional
        ? {
            functional: {
              ...base.functional,
              ...(target
                ? {
                    missingPreconditions: [
                      ...target.missingPreconditions,
                      ...base.functional.missingPreconditions,
                    ].slice(0, 8),
                    blockingReasons: [
                      ...target.rootCauses
                        .slice(0, 3)
                        .map(
                          (cause) =>
                            `${cause.category} ${String(cause.confidence)}: ${cause.evidence[0]?.detail ?? ''}`,
                        ),
                      ...base.functional.blockingReasons,
                    ].slice(0, 6),
                    nextActionTargets: [target.target.label, ...base.functional.nextActionTargets].slice(
                      0,
                      8,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };
    const built = this.aiContext.build(trigger.reason, sources);
    const result = await ai.consult({
      context: 'RECOVERY',
      request: built.request,
      scope: { divergence: `${input.goal.id}|${input.original.label}` },
      deterministic: { confidence: 0 },
      // Ce que la récupération a déjà essayé : la difficulté guide le choix du modèle et de l'effort.
      signals: {
        recoveryAttempts: input.outcome.attempts.length,
        plausiblePlans: input.plan.candidates.length,
        divergence: input.divergence,
      },
      safety: (id) => {
        const candidate = built.candidateOf(id);
        if (!candidate?.role)
          return { allowed: false, classification: 'UNKNOWN', reason: 'not a control on screen' };
        const judged = this.judgeRecovery(
          {
            role: candidate.role,
            name: candidate.name,
            visible: true,
            disabled: candidate.disabled ?? false,
          },
          candidate.kind === 'check' ? 'check' : 'click',
        );
        return { allowed: judged.allowed, classification: judged.risk, reason: judged.reason };
      },
      knownEvidence: (id) => this.cognitive?.evidence.get(id) !== undefined,
      ...(this.config.ai.copilot.tools ? { tools: toolContextOf(built, sources) } : {}),
    });
    this.learnAiProposal(result);
    if (!result.decision.accepted || !result.decision.actionId) return undefined;
    const progressBefore = this.cognitive?.goalProgress()?.progress;
    if (progressBefore !== undefined) this.aiRecoveryProgress.set(result.record.id, progressBefore);
    const chosen = built.candidateOf(result.decision.actionId);
    if (!chosen?.role) return undefined;
    return {
      action: { kind: chosen.kind === 'check' ? 'check' : 'click', role: chosen.role, name: chosen.name },
      auditId: result.record.id,
    };
  }

  /**
   * AI REASONING ADVISOR, pour une erreur métier que le FailureUnderstanding ne sait pas classer :
   * une catégorie probable, un sens métier possible, une investigation SÛRE — consignés dans
   * l'audit (et au plus une hypothèse). Le runtime et les oracles restent seuls juges.
   */
  private async adviseFailure(
    page: Page,
    report: FlowStepReport,
    steps: readonly FlowStepReport[] = [report],
  ): Promise<void> {
    const ai = this.ai;
    const cognitive = this.cognitive;
    if (!ai || !cognitive) return;
    const trigger = ai.evaluate({ deterministicConfidence: 0, unknownBusinessError: true });
    if (!trigger.shouldInvoke || !trigger.reason) return;
    const snapshot = await this.observer.observe(page).catch(() => undefined);
    const controls = snapshot ? screenControlsOf(snapshot) : [];
    // La PREMIÈRE divergence fonctionnelle, pas seulement la dernière erreur Playwright.
    const divergence = firstFunctionalDivergence(steps);
    const sources0 = cognitive.intelligenceSources({
      question: divergence?.rootBeforeSymptom
        ? `The failure was reported at step ${String(report.index)}, but the journey first diverged at step ${String(divergence.step)}. Which cause and which SAFE investigation best explain it, using only provided evidence?`
        : 'Classify this unknown business failure and propose a SAFE investigation, using only provided evidence.',
    });
    const functional = sources0.functional
      ? {
          ...sources0.functional,
          ...(divergence
            ? {
                firstDivergence: {
                  step: divergence.step,
                  description: divergence.description.slice(0, 160),
                  expected: divergence.expected,
                  observed: divergence.observed,
                  ...(divergence.lastFailedStep !== undefined
                    ? { lastFailedStep: divergence.lastFailedStep }
                    : {}),
                },
              }
            : {}),
        }
      : undefined;
    const sources: ContextSources = {
      ...sources0,
      ...(functional ? { functional } : {}),
      candidates: controls
        .filter((control) => control.visible && !control.field && control.role && control.name)
        .map((control) => {
          const kind = control.role === 'checkbox' || control.role === 'radio' ? 'check' : 'click';
          const judged = this.judgeRecovery(control, kind);
          return {
            key: `${control.role}:${control.name}`,
            kind,
            role: control.role,
            name: control.name,
            safety: judged.risk,
            allowed: judged.allowed,
          };
        }),
      failure: {
        step: `step ${String(report.index)} "${report.description}"`.slice(0, 160),
        symptom: (report.reason ?? 'unknown').slice(0, 200),
        observed: (report.effect?.observed ?? []).slice(0, 5),
      },
    };
    const built = this.aiContext.build(trigger.reason, sources);
    const result = await ai.consult({
      context: 'FAILURE',
      request: built.request,
      scope: { divergence: `failure|${String(report.index)}` },
      // Une analyse : aucune action n'est jamais exécutée sur sa foi.
      deterministic: { confidence: 1 },
      safety: () => ({
        allowed: false,
        classification: 'ADVISORY',
        reason: 'failure analysis is advisory only',
      }),
      knownEvidence: (id) => cognitive.evidence.get(id) !== undefined,
    });
    this.learnAiProposal(result);
  }

  /**
   * OBJECTIF BLOQUÉ, CAUSE INCONNUE (fin de flow) : le PreconditionResolver a dit ce qu'il savait ;
   * s'il ne sait pas pourquoi l'objectif reste bloqué (submission READY, mission toujours bloquée…),
   * le conseiller reçoit le contexte fonctionnel et propose une précondition manquante ou une
   * investigation SÛRE. Une analyse : rien n'est exécuté, la proposition devient une hypothèse.
   */
  private async adviseBlockedGoal(page: Page, flow: string): Promise<void> {
    const ai = this.ai;
    const cognitive = this.cognitive;
    if (!ai || !cognitive) return;
    const analysis = cognitive.blockedGoal();
    if (!analysis || analysis.state === 'SATISFIED' || !analysis.unknownPrecondition) return;
    // Un parcours qui a divergé AVANT d'être prêt est expliqué par sa divergence : la cause n'est pas
    // inconnue. Seul un objectif prêt (ou dont l'envoi a été tenté) et encore bloqué justifie l'appel.
    const established =
      analysis.satisfiedPreconditions.some((id) => id.endsWith('_READY')) ||
      cognitive.submissionWasAttempted();
    if (!established && cognitive.latestDivergence()?.flow === flow) return;
    const trigger = ai.evaluate({
      deterministicConfidence: analysis.confidence,
      unknownBlockingPrecondition: true,
    });
    if (!trigger.shouldInvoke || !trigger.reason) return;
    const snapshot = await this.observer.observe(page).catch(() => undefined);
    const controls = snapshot ? screenControlsOf(snapshot) : [];
    const sources: ContextSources = {
      ...cognitive.intelligenceSources({
        question: `Goal ${analysis.goal} remains blocked${analysis.lastConfirmedCheckpoint ? ` although ${analysis.lastConfirmedCheckpoint} is confirmed` : ''}. Identify the most plausible missing precondition or a SAFE investigation, using only provided evidence and action IDs.`,
      }),
      candidates: controls
        .filter((control) => control.visible && !control.field && control.role && control.name)
        .map((control) => {
          const kind = control.role === 'checkbox' || control.role === 'radio' ? 'check' : 'click';
          const judged = this.judgeRecovery(control, kind);
          return {
            key: `${control.role}:${control.name}`,
            kind,
            role: control.role,
            name: control.name,
            safety: judged.risk,
            allowed: judged.allowed,
          };
        }),
    };
    const built = this.aiContext.build(trigger.reason, sources);
    const result = await ai.consult({
      context: 'BLOCKED_GOAL',
      request: built.request,
      scope: { divergence: `blocked|${flow}|${analysis.goal}` },
      deterministic: { confidence: analysis.confidence },
      safety: (id) => {
        const candidate = built.candidateOf(id);
        if (!candidate?.role)
          return { allowed: false, classification: 'UNKNOWN', reason: 'not a control on screen' };
        const judged = this.judgeRecovery(
          { role: candidate.role, name: candidate.name, visible: true, disabled: false },
          candidate.kind === 'check' ? 'check' : 'click',
        );
        return { allowed: judged.allowed, classification: judged.risk, reason: judged.reason };
      },
      knownEvidence: (id) => cognitive.evidence.get(id) !== undefined,
      signals: { plausiblePlans: analysis.candidateActions.length },
    });
    this.learnAiProposal(result);
  }

  /**
   * HYPOTHÈSE CONTREDITE sans alternative ni investigation (l'apprentissage actif n'a rien
   * proposé) : le conseiller peut proposer une autre explication ou une investigation SÛRE.
   */
  private async adviseContradictedHypotheses(): Promise<void> {
    const ai = this.ai;
    const cognitive = this.cognitive;
    if (!ai || !cognitive) return;
    for (const contradicted of cognitive
      .contradictedAnalysis()
      .filter((entry) => entry.needsAnalysis)
      .slice(0, 1)) {
      if (this.aiAnalyzedHypotheses.has(contradicted.id)) continue;
      this.aiAnalyzedHypotheses.add(contradicted.id);
      const trigger = ai.evaluate({ deterministicConfidence: 0, contradictedHypothesis: true });
      if (!trigger.shouldInvoke || !trigger.reason) return;
      const built = this.aiContext.build(trigger.reason, {
        ...cognitive.intelligenceSources({
          question: `Hypothesis ${contradicted.id} "${contradicted.description}" was contradicted (${contradicted.why}) and no alternative is known. Propose an alternative hypothesis or a SAFE investigation, using only provided evidence.`,
        }),
        candidates: [],
      });
      const result = await ai.consult({
        context: 'HYPOTHESIS',
        request: built.request,
        scope: { divergence: `hypothesis|${contradicted.id}` },
        deterministic: { confidence: 0 },
        safety: () => ({
          allowed: false,
          classification: 'ADVISORY',
          reason: 'hypothesis analysis is advisory only',
        }),
        knownEvidence: (id) => cognitive.evidence.get(id) !== undefined,
      });
      this.learnAiProposal(result);
    }
  }

  /** L'audit de l'intelligence : reports/ai/intelligence.json (résumé, décisions, mesures). */
  private async persistIntelligence(): Promise<void> {
    if (!this.ai) return;
    for (const pending of this.aiPending.values()) this.ai.markNotExecuted(pending.auditId);
    this.aiPending.clear();
    if (!this.config.ai.audit.enabled) return;
    const directory = path.join(this.config.output.reportsDir, 'ai');
    await mkdir(directory, { recursive: true });
    const summary = this.ai.summary();
    await writeFile(
      path.join(directory, 'intelligence.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    // Le cycle de vie de chaque décision (déclencheur → contexte → proposition → validation → shadow
    // → repli → exécution → runtime → connaissance), nettoyé.
    await writeFile(
      path.join(this.config.output.reportsDir, 'intelligence-decisions.json'),
      `${JSON.stringify(intelligenceDecisionsArtifact(summary), null, 2)}\n`,
      'utf8',
    );
  }

  /** (lu par une méthode : la valeur change pendant les étapes, pas seulement ici) */
  private pendingRecovery(): typeof this.pendingLearning {
    return this.pendingLearning;
  }

  private healingPorts(page: Page): HealingPorts {
    const options = this.config.replay.intelligentRecovery;
    const statics = options.useStaticKnowledge ? this.staticComponents() : [];
    const edges = this.coordinator.dependencies.all();
    const version = this.knowledge.identity.commit ?? this.knowledge.identity.appVersion;
    return {
      driver: this.recoveryDriver(page),
      screen: async () => {
        const snapshot = await this.observer.observe(page);
        return {
          controls: screenControlsOf(snapshot),
          route: pathOf(snapshot.url),
          text: snapshot.textExcerpt,
          ...(snapshot.overlay ? { overlay: snapshot.overlay } : {}),
          loginFormVisible: snapshot.elements.some(
            (element) => element.visible && element.inputType === 'password',
          ),
        };
      },
      network: () =>
        this.flowNetwork.slice(-20).map((exchange) => ({
          request: `${exchange.method.toUpperCase()} ${pathOf(exchange.url)}`,
          ...(exchange.status !== undefined ? { status: exchange.status } : {}),
        })),
      judge: (control, kind) => this.judgeRecovery(control, kind),
      history: (key) => this.knowledge.recoveryKnowledge(key),
      ...(statics.length > 0
        ? { staticEvidence: (control: ScreenControl, goal) => staticLinkEvidence(statics, control, goal) }
        : {}),
      ...(edges.length > 0
        ? {
            dependencyEvidence: (control: ScreenControl, goal) =>
              dependencyLinkEvidence(edges, control, goal),
          }
        : {}),
      synonyms: (term) => this.semantics.dictionary.expand(term),
      probeTarget: (target) => this.probeTarget(page, target),
      revealersOf: (label, role) => this.revealersOf(label, role),
      learn: (input) => {
        this.learnRecovery(input);
      },
      emit: (event, message) => {
        this.emitHealing(event, message);
      },
      now: () => new Date().toISOString(),
      ...(version ? { version } : {}),
      ...(this.ai
        ? {
            advise: (input: AdviceInput) => this.adviseRecovery(input),
            adviceOutcome: (auditId: string, reached: boolean, detail: string) => {
              this.aiRuntime(auditId, reached, detail, this.aiRecoveryProgress.get(auditId));
            },
          }
        : {}),
    };
  }

  /** Les composants du code source et leurs contrôles (graphe statique déjà en cache). */
  private staticComponents(): { component: string; controls: string[] }[] {
    const byComponent = new Map<string, string[]>();
    for (const field of this.staticKnowledge?.graph.fields ?? [])
      byComponent.set(field.component, [...(byComponent.get(field.component) ?? []), field.control]);
    return [...byComponent].map(([component, controls]) => ({ component, controls }));
  }

  /** La SafetyPolicy pour une action de récupération : seul SAFE passe, quel que soit le score. */
  private judgeRecovery(control: ScreenControl, kind: 'click' | 'check'): SafetyJudgement {
    const category =
      control.role === 'tab'
        ? 'tab'
        : control.role === 'link'
          ? 'navigation'
          : control.role === 'menuitem'
            ? 'menu'
            : control.role === 'checkbox' || control.role === 'radio'
              ? 'form-input'
              : 'other';
    const verdict = this.safety.classify({
      type: kind,
      category,
      text: control.name,
      name: control.name,
      role: control.role,
    });
    return {
      risk: verdict.classification,
      allowed: verdict.classification === 'SAFE' && !verdict.risks.includes('sensitive-data'),
      reason: verdict.reason,
    };
  }

  /** Le navigateur vu par le GoalBasedRecoveryEngine : exécuter, observer, annuler. */
  private recoveryDriver(page: Page): RecoveryDriver {
    const keys = (snapshot: UiSnapshot): Set<string> =>
      new Set(
        snapshot.elements
          .filter((element) => element.visible && !element.disabled && element.role && element.name)
          .map((element) => `${element.role}:${normalizeControl(element.name)}`),
      );
    const targetOf = (action: { role: string; name: string }): FlowTarget => ({
      strategy: 'role',
      role: action.role,
      name: action.name,
      exact: true,
    });
    return {
      screen: async () => screenControlsOf(await this.observer.observe(page)),
      stateKey: async () => {
        const snapshot = await this.observer.observe(page);
        const checked = snapshot.elements
          .filter(
            (element) => element.checked === true || element.selected === true || element.expanded === true,
          )
          .map((element) => `${element.role}:${normalizeControl(element.name)}`);
        return `${pathOf(snapshot.url)}|${[...keys(snapshot)].sort().join(',')}|${checked.sort().join(',')}`;
      },
      progress: async (goal) =>
        goalProgressOf(
          goal,
          await Promise.all(goal.predicates.map((predicate) => this.predicateHolds(page, predicate))),
        ),
      execute: async (action) => {
        // SAFETY ALWAYS WINS : rejugé au moment d'exécuter (historique compris).
        const judged = this.judgeRecovery(
          { role: action.role, name: action.name, visible: true, disabled: false },
          action.kind,
        );
        if (!judged.allowed)
          return { status: 'FAILED', detail: `blocked by the SafetyPolicy: ${judged.reason}`, appeared: [] };
        const target = targetOf(action);
        const located = await this.flowSteps.locate(page, target, 1500);
        if (typeof located === 'string') return { status: 'NOT_FOUND', detail: located, appeared: [] };
        const before = await this.observer.observe(page);
        const keysBefore = keys(before);
        const routeBefore = pathOf(before.url);
        const expandedBefore = before.elements.find(
          (element) =>
            element.role === action.role && normalizeControl(element.name) === normalizeControl(action.name),
        )?.expanded;
        // Aucune écriture permise pendant une expérience (garde d'écriture active).
        this.writeGuard.during(
          undefined,
          'workflow-recovery',
          `workflow recovery: ${action.kind} ${action.role} "${action.name}"`,
        );
        const error = await this.flowSteps.perform(page, located, { kind: action.kind }, 3000);
        this.actionsExecuted += 1;
        if (error) return { status: 'FAILED', detail: error, appeared: [] };
        await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
        const after = await this.observer.observe(page);
        const appeared = [...keys(after)].filter((key) => !keysBefore.has(key));
        const again = async (kind: 'click' | 'uncheck'): Promise<boolean> => {
          const found = await this.flowSteps.locate(page, target, 1000);
          return (
            typeof found !== 'string' &&
            (await this.flowSteps.perform(page, found, { kind }, 2000)) === undefined
          );
        };
        const undo =
          pathOf(after.url) !== routeBefore
            ? async (): Promise<boolean> => {
                await page.goBack({ timeout: 5000 }).catch(() => undefined);
                return pathOf(page.url()) === routeBefore;
              }
            : action.kind === 'check'
              ? (): Promise<boolean> => again('uncheck')
              : expandedBefore === false
                ? (): Promise<boolean> => again('click')
                : undefined;
        return { status: 'DONE', appeared, ...(undo ? { undo } : {}) };
      },
    };
  }

  private async predicateHolds(page: Page, predicate: GoalPredicate): Promise<boolean> {
    if (predicate.kind === 'ROUTE') return routeMatches(predicate.value, pathOf(page.url()));
    // Un champ sans nom accessible (css, test id) se vérifie par son localisateur enregistré :
    // existe, visible, utilisable — jamais par un « libellé » qui serait un sélecteur.
    const target: FlowTarget = predicate.target
      ? predicate.target
      : predicate.kind === 'VISIBLE_FIELD'
        ? { strategy: 'label', value: predicate.value }
        : predicate.role
          ? { strategy: 'role', role: predicate.role, name: predicate.value }
          : { strategy: 'text', value: predicate.value };
    const found = await this.flowSteps.locate(page, target, predicate.kind === 'ABSENT_CONTROL' ? 150 : 400);
    if (predicate.kind === 'ABSENT_CONTROL') return typeof found === 'string';
    if (typeof found === 'string') return false;
    if (predicate.kind === 'CONTROL_AVAILABLE' || (predicate.kind === 'VISIBLE_FIELD' && predicate.target))
      return found.isEnabled().catch(() => false);
    return true;
  }

  /** DIAGNOSE : le localisateur enregistré désigne-t-il un élément présent, visible, lisible ? (rien n'est cliqué) */
  private async probeTarget(page: Page, target: FlowTarget): Promise<TargetProbe> {
    try {
      const locator = toLocator(page, {
        strategy: target.strategy,
        ...(target.role !== undefined ? { role: target.role } : {}),
        ...(target.name !== undefined ? { name: target.name } : {}),
        ...(target.value !== undefined ? { value: target.value } : {}),
        ...(target.exact !== undefined ? { exact: target.exact } : {}),
      }).first();
      const attached = (await locator.count().catch(() => 0)) > 0;
      if (!attached) return { attached: false, visible: false, readable: false };
      const visible = await locator.isVisible().catch(() => false);
      const observed = await readTarget(locator);
      const enabled = visible ? await locator.isEnabled().catch(() => false) : false;
      return { attached, visible, readable: observed.tag !== undefined, enabled };
    } catch {
      return { attached: false, visible: false, readable: false };
    }
  }

  /** Ce que le graphe causal sait de ce qui révèle la cible (des hypothèses tant que le runtime ne confirme pas). */
  private revealersOf(label: string, role?: string): KnownRevealer[] {
    const causal = this.cognitive?.causal;
    if (!causal || !label) return [];
    const keys = [role ?? 'textbox', 'textbox', 'combobox', 'button']
      .filter((candidate, index, list) => list.indexOf(candidate) === index)
      .map((candidate) => `${candidate}:${normalizeControl(label)}`);
    return keys.flatMap((key) =>
      causal
        .causesOf(key)
        .filter((link) => link.hypothesis.status !== 'CONTRADICTED' && link.hypothesis.status !== 'REJECTED')
        .map((link): KnownRevealer => {
          const [kind = 'click', ...rest] = link.cause.split(' ');
          return {
            role: kind === 'check' ? 'checkbox' : 'button',
            name: rest.join(' '),
            source: 'CAUSAL',
            status: link.hypothesis.status,
            detail: `${link.cause} ${link.relation} ${link.effect} (${link.hypothesis.status})`,
          };
        }),
    );
  }

  private learnRecovery(input: RecoveryInput): void {
    const options = this.config.replay.intelligentRecovery;
    if (input.result === 'SUCCESS' && !options.learnSuccessfulRecovery) return;
    this.knowledge.recordRecovery(input);
    this.emitHealing(
      'RECOVERY_KNOWLEDGE_LEARNED',
      `${input.result}: "${input.originalTarget}" → ${input.actions.map((action) => `${action.kind} ${action.role}:${action.name}`).join(' → ')} (${input.goal})`,
    );
  }

  private emitHealing(event: HealingEvent, message: string): void {
    const record: HealingEventRecord = { at: new Date().toISOString(), event, message: redactText(message) };
    if (this.healingEvents.length < 1000) this.healingEvents.push(record);
    this.listener.onHealing?.(record);
  }

  /**
   * ORIGINAL → RECOVERED → SUGGESTED : suggested-flows/<flow>.flow.yaml et .feature.
   * Le flow d'origine n'est jamais réécrit (replay.intelligentRecovery.autoUpdateFlow: false).
   */
  private async writeSuggestedFlow(flow: FlowConfig, report: FlowRunReport): Promise<string[]> {
    const directory = path.join(this.config.output.reportsDir, 'suggested-flows');
    await mkdir(directory, { recursive: true });
    const slug =
      flow.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'flow';
    const graph = buildRecoveredFlow(flow, report.steps);
    const header = [
      `Suggested update of flow "${flow.name}" (${report.drift?.classification ?? 'drift'}, ${report.drift?.result ?? ''})`,
      'Built from a replay with workflow recovery: review before use. The original flow is unchanged.',
    ];
    const yamlFile = path.join(directory, `${slug}.flow.yaml`);
    const featureFile = path.join(directory, `${slug}.feature`);
    await writeFile(yamlFile, suggestedFlowYaml(graph, header), 'utf8');
    await writeFile(
      featureFile,
      suggestedFeature(graph, { language: this.config.report.language, header }),
      'utf8',
    );
    return [yamlFile, featureFile];
  }

  /** Classement d'un élément que l'observateur ne liste pas (texte simple, conteneur…). */
  /**
   * `{ testData: clé }` (un flow enregistré) : une valeur valide pour CE champ, choisie par le
   * TestDataProvider à l'exécution ; testData.fields[clé] si la mission la donne. Jamais pour
   * un champ sensible (le TestDataProvider ne les remplit pas).
   */
  private testDataValue(action: DiscoveredAction, key: string, flow: FlowConfig): ResolvedTestData {
    // testData.fields de la mission : « Branch-Code » vaut pour la clé branchCode (casse et ponctuation ignorées).
    // Une configuration explicite l'emporte sur toute inférence (et sur le jeu enregistré).
    const compact = (text: string): string =>
      text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toLowerCase();
    const leaf = key.split('.').at(-1) ?? key;
    const fields = this.config.testData.fields;
    const configured =
      fields[key] ??
      Object.entries(fields).find(([name]) => compact(name) === compact(key))?.[1] ??
      (leaf !== key
        ? Object.entries(fields).find(([name]) => compact(name) === compact(leaf))?.[1]
        : undefined);
    if (configured !== undefined)
      return { kind: 'value', value: configured, strategy: 'RECORDED_LITERAL', generated: false };
    // Une valeur valide pour CE champ (ou pour un générateur nommé), choisie par le TestDataProvider du run.
    const provide = (name: string, typed?: string): string | undefined => {
      const field = {
        ...(action.field ?? { inputType: 'text', required: false, name }),
        ...(typed ? { inputType: typed, name, label: name } : {}),
        hasValue: false,
      };
      const instruction = this.testData.instructionFor({
        ...action,
        type: 'fill',
        ...(action.label && !typed ? {} : { label: name }),
        field,
      });
      return instruction.kind === 'fill' ? instruction.value : undefined;
    };
    const resolved = this.testDataRun.resolve(key, [flow.testData, this.config.testData.set], {
      fallback: () => provide(leaf),
      generate: (generator) =>
        generator === 'unique'
          ? `QA-CRAWLER-${this.runId}`
          : provide(generator, GENERATOR_TYPES[generator] ?? 'text'),
    });
    if (resolved.kind === 'value' && resolved.strategy === 'RECORDED_LITERAL') this.flowRecordedKeys.add(key);
    return resolved;
  }

  private syntheticAction(
    stateId: string,
    step: Extract<FlowStep, { target: unknown }>,
    text: string,
  ): DiscoveredAction {
    const type =
      step.kind === 'fill' || step.kind === 'select' || step.kind === 'check' || step.kind === 'uncheck'
        ? step.kind
        : 'click';
    const label = step.target.name ?? step.target.value ?? '';
    const classification = this.safety.classify({ type, category: 'other', text: text || label });
    return {
      id: `flow-target:${stateId}:${step.kind}:${label}`,
      stateId,
      type,
      category: 'other',
      elementType: 'element',
      ...(text ? { text } : {}),
      disabled: false,
      visible: true,
      ...classification,
      locator: {
        strategy: step.target.strategy === 'role' ? 'role' : step.target.strategy,
        ...(step.target.role ? { role: step.target.role } : {}),
        ...(step.target.name !== undefined ? { name: step.target.name } : {}),
        ...(step.target.value !== undefined ? { value: step.target.value } : {}),
      },
    };
  }

  /** Une anomalie FLOW pour une étape échouée ou bloquée (ERROR, WARNING pour les étapes optionnelles), avec une capture. */
  private async flowIssue(
    flow: FlowConfig,
    step: FlowStepReport | undefined,
    reason: string,
    optional: boolean,
    page: Page,
    context?: PageContext,
  ): Promise<void> {
    const where = step
      ? `step ${step.index} "${step.description}" ${step.status.toLowerCase()}`
      : 'could not start';
    const issue = this.collector.add({
      type: 'FLOW',
      severity: SeverityRules.flowStep(optional),
      message: `Flow "${flow.name}" — ${where}: ${reason}`,
      pageUrl: context?.url ?? (page.isClosed() ? this.startUrl : page.url()),
      ...(context ? { stateId: context.stateId, flow: this.graph.flowTo(context.stateId) } : {}),
    });
    if (context) this.graph.attachIssues(context.stateId, [issue.id]);
    if (!step || page.isClosed() || !(this.config.checks.screenshotOnError || this.config.checks.screenshots))
      return;
    const file = await this.screenshots.captureState(
      page,
      this.graph.nodeCount,
      `${flow.name}-step-${step.index}`,
      step.status === 'BLOCKED' ? 'blocked' : 'failed',
    );
    if (file) {
      issue.screenshot ??= file;
      step.screenshot ??= file;
    }
  }

  // ---------------------------------------------------------------- navigation

  private pushState(context: PageContext): void {
    const index = this.stack.findIndex((entry) => entry.stateId === context.stateId);
    if (index >= 0) {
      // De retour sur un état déjà dans le chemin (cycle) : le chemin se réduit jusqu'à lui.
      this.stack = this.stack.slice(0, index + 1);
    } else {
      this.stack.push({ stateId: context.stateId, url: context.url });
    }
  }

  /**
   * RETOUR ARRIÈRE : revenir à l'ancêtre le plus proche qui a encore quelque chose à
   * explorer ; quand tout le chemin est épuisé, sauter vers n'importe quel état connu
   * avec des actions inexplorées. Ne renvoie aucun contexte quand il ne reste rien.
   */
  private async backtrack(
    page: Page,
    browser: BrowserManager,
    observers: PageObserver[],
    allowJump = true,
  ): Promise<{ page: Page; context?: PageContext }> {
    const from = this.stack[this.stack.length - 1]?.stateId ?? '';
    while (this.stack.length > 1) {
      this.stack.pop();
      const target = this.stack[this.stack.length - 1];
      if (!target || this.exhausted.has(target.stateId) || this.unreachable.has(target.stateId)) continue;
      // Plus rien d'intéressant là-bas : inutile d'y retourner, le chemin continue de se réduire.
      if (!(await this.hasWorkLeft(target.stateId))) {
        this.exhausted.add(target.stateId);
        continue;
      }
      if (!/^https?:/.test(page.url()) || page.isClosed())
        page = await this.recyclePage(browser, page, observers);
      const context = await this.restore(page, target.stateId, true);
      if (context) {
        this.backtracks += 1;
        return { page, context };
      }
      this.unreachable.add(target.stateId);
    }

    // Le chemin courant est épuisé : chercher un autre état avec des actions inexplorées.
    for (const node of allowJump ? this.graph.allNodes() : []) {
      if (this.exhausted.has(node.id) || this.unreachable.has(node.id)) continue;
      if (this.graph.getUnexploredActions(node.id).length === 0 || !(await this.hasWorkLeft(node.id))) {
        this.exhausted.add(node.id);
        continue;
      }
      if (!/^https?:/.test(page.url()) || page.isClosed())
        page = await this.recyclePage(browser, page, observers);
      const context = await this.restore(page, node.id);
      if (context) {
        this.backtracks += 1;
        this.stack = this.graph.flowTo(context.stateId).map((stateId) => ({
          stateId,
          url: this.graph.getNode(stateId)?.url ?? this.startUrl,
        }));
        this.listener.onBacktrack?.(from, context.stateId, 'jump to a state with unexplored actions');
        return { page, context };
      }
      this.unreachable.add(node.id);
    }
    this.listener.onBacktrack?.(from, undefined, this.nothingLeftReason());
    return { page };
  }

  /**
   * « Plus rien à explorer », avec les écrans abandonnés faute d'avoir pu y revenir : leurs
   * actions n'ont pas été essayées, et le log dit lesquelles plutôt que de se taire.
   */
  private nothingLeftReason(): string {
    const lost = [...this.unreachable]
      .map((stateId) => ({ stateId, left: this.untriedActions(stateId) }))
      .filter((entry) => entry.left.length > 0);
    if (lost.length === 0) return 'nothing left to explore';
    const list = lost
      .slice(0, 5)
      .map(
        ({ stateId, left }) =>
          `${stateId}: ${left
            .slice(0, 3)
            .map((action) => `"${actionLabel(action)}"`)
            .join(', ')}${left.length > 3 ? '…' : ''}`,
      )
      .join('; ');
    return `nothing left to explore; ${lost.length} screen(s) could not be reached again, actions not tried: ${list}`;
  }

  /** Les actions visibles et actives d'un état qui n'y ont jamais été tentées (ni sur son jumeau). */
  private untriedActions(stateId: string): DiscoveredAction[] {
    return (this.details.get(stateId)?.actions ?? []).filter(
      (action) =>
        action.visible &&
        !action.disabled &&
        action.type !== 'fill' &&
        !this.graph.hasTransition(stateId, action.id) &&
        !this.triedOnTwin.has(`${stateId}::${action.id}`),
    );
  }

  /**
   * ÉCRAN JUMEAU : en revenant sur un écran, la page montre le même écran avec un autre id —
   * un bouton apparu ou disparu depuis (une page cassée, une réservation, une bannière). C'est le
   * même écran quand tout sauf les contrôles est identique (route, titre, titres, fenêtres,
   * onglets, champs présents), que ses contrôles se ressemblent (au moins TWIN_SIMILARITY
   * en commun) et que ce qu'il restait à y faire y est.
   */
  private isTwinOf(originalId: string, context: PageContext): boolean {
    if (context.stateId === originalId) return false;
    const frame = this.frames.get(originalId);
    if (!frame || frame !== this.frames.get(context.stateId)) return false;
    const signatures = new Set((this.details.get(originalId)?.actions ?? []).map(actionSignature));
    const observed = new Set(context.actions.map(actionSignature));
    const shared = [...signatures].filter((signature) => observed.has(signature)).length;
    const union = new Set([...signatures, ...observed]).size;
    if (union === 0 || shared / union < TWIN_SIMILARITY) return false;
    return this.untriedActions(originalId).some((action) => observed.has(actionSignature(action)));
  }

  /** Le jumeau reprend le travail de l'écran : ce qui y a été tenté l'est aussi ici, le reste continue ici. */
  private adoptTwin(originalId: string, twin: PageContext): void {
    const actions = this.details.get(originalId)?.actions ?? [];
    const tried = new Set(
      actions
        .filter(
          (action) =>
            this.graph.hasTransition(originalId, action.id) ||
            this.triedOnTwin.has(`${originalId}::${action.id}`),
        )
        .map(actionSignature),
    );
    for (const action of twin.actions)
      if (tried.has(actionSignature(action))) this.triedOnTwin.add(`${twin.stateId}::${action.id}`);
    this.exhausted.add(originalId);
    this.frontier.removeState(originalId);
    // Le chemin de retour passe désormais par le jumeau.
    this.stack = this.stack.map((entry) =>
      entry.stateId === originalId ? { stateId: twin.stateId, url: twin.url } : entry,
    );
    // Le candidat qui justifiait le retour est exécuté sur le jumeau.
    const pending = this.pendingCandidate;
    if (pending?.stateId === originalId) {
      const wanted = actions.find((action) => action.id === pending.actionId);
      const same =
        wanted && twin.actions.find((action) => actionSignature(action) === actionSignature(wanted));
      this.pendingCandidate = same ? { stateId: twin.stateId, actionId: same.id } : undefined;
    }
  }

  /**
   * DÉCISION : le moteur classe les actions de l'écran (ActionScorer V2, chaque point
   * expliqué), elles rejoignent la frontière d'exploration, et la stratégie choisit —
   * best-first : le meilleur candidat où qu'il soit (en quittant l'écran seulement pour
   * nettement mieux) ; depth-first : l'écran courant d'abord. Chaque décision est tracée.
   */
  private async chooseNext(
    context: PageContext,
    allowJump: boolean,
  ): Promise<{ decision: ActionDecision; jumpTo?: string }> {
    const at = new Date().toISOString();
    const engine = this.decisionEngine instanceof RuleBasedDecisionEngine ? this.decisionEngine : undefined;
    if (!engine || context.metadata.depth >= this.config.exploration.maxDepth) {
      const decision = await this.decisionEngine.decide(context, this.graph);
      this.traces.record({
        at,
        stateId: context.stateId,
        strategy: engine ? this.strategy.name : this.decisionEngine.name,
        candidates: [],
        ...(decision.actionId ? { selectedActionId: decision.actionId } : {}),
        decision: decision.decision,
        reasons: [decision.reason],
      });
      return { decision };
    }
    const { ranked, excluded } = engine.rankWithExclusions(context, this.graph);
    // La frontière garde les candidats de chaque écran visité ; ceux de cet écran sont rescorés.
    this.frontier.removeState(context.stateId);
    for (const entry of ranked)
      this.frontier.add({
        stateId: context.stateId,
        actionId: entry.action.id,
        score: entry.score,
        depth: context.metadata.depth,
        discoveredAt: at,
        label: actionLabel(entry.action),
        ...(entry.breakdown ? { breakdown: entry.breakdown } : {}),
      });
    const pending = this.pendingCandidate;
    this.pendingCandidate = undefined;
    const bestFirst = this.strategy.name === 'best-first' && allowJump;
    let chosen =
      pending?.stateId === context.stateId ? this.frontier.get(context.stateId, pending.actionId) : undefined;
    chosen ??= bestFirst
      ? (this.frontier.next(this.strategy, {
          currentStateId: context.stateId,
          agingBonus: this.config.exploration.agingBonus,
          switchMargin: this.config.exploration.switchMargin,
          travelCost: (stateId) => 15 + 5 * this.graph.flowTo(stateId).length,
          isAllowed: (candidate) =>
            candidate.stateId === context.stateId ||
            (!this.exhausted.has(candidate.stateId) &&
              !this.unreachable.has(candidate.stateId) &&
              candidate.attempts < 2 &&
              !this.graph.hasTransition(candidate.stateId, candidate.actionId) &&
              (this.graph.getNode(candidate.stateId)?.depth ?? 0) < this.config.exploration.maxDepth),
          ...(this.config.exploration.seed !== undefined ? { seed: this.config.exploration.seed } : {}),
        }) ?? undefined)
      : this.frontier.get(context.stateId, ranked[0]?.action.id ?? '');
    this.frontier.tick(chosen);
    const trace = (decision: ActionDecision): void => {
      const own = ranked.slice(0, 40).map((entry) => ({
        stateId: context.stateId,
        actionId: entry.action.id,
        label: actionLabel(entry.action),
        score: entry.score,
        ...(entry.breakdown ? { breakdown: entry.breakdown } : {}),
      }));
      const elsewhere =
        chosen && chosen.stateId !== context.stateId
          ? [
              {
                stateId: chosen.stateId,
                actionId: chosen.actionId,
                label: chosen.label ?? chosen.actionId,
                score: chosen.score,
                ...(chosen.breakdown ? { breakdown: chosen.breakdown } : {}),
              },
            ]
          : [];
      this.traces.record({
        at,
        stateId: context.stateId,
        strategy: this.strategy.name,
        candidates: [
          ...own,
          ...elsewhere,
          ...excluded.slice(0, 20).map((entry) => ({
            stateId: context.stateId,
            actionId: entry.action.id,
            label: actionLabel(entry.action),
            score: 0,
            excluded: entry.reason,
          })),
        ],
        ...(decision.actionId ? { selectedActionId: decision.actionId } : {}),
        ...(chosen ? { selectedStateId: chosen.stateId } : {}),
        decision: decision.decision,
        reasons: chosen?.breakdown?.reasons ?? [decision.reason],
      });
    };
    if (!chosen) {
      const decision: ActionDecision = {
        decision: 'BACKTRACK',
        reason:
          ranked.length === 0
            ? 'no unexplored action worth trying on this state'
            : 'nothing better to do here',
      };
      trace(decision);
      return { decision };
    }
    const decision: ActionDecision = {
      decision: 'EXECUTE',
      actionId: chosen.actionId,
      reason:
        chosen.stateId === context.stateId
          ? `score ${chosen.score}: ${(chosen.breakdown?.reasons ?? []).join(', ')}`
          : `best-first: "${chosen.label ?? chosen.actionId}" (score ${chosen.score}) on another screen`,
      score: chosen.score,
      ...(chosen.breakdown ? { breakdown: chosen.breakdown } : {}),
    };
    trace(decision);
    if (chosen.stateId === context.stateId) return { decision };
    chosen.attempts += 1;
    this.pendingCandidate = { stateId: chosen.stateId, actionId: chosen.actionId };
    return { decision, jumpTo: chosen.stateId };
  }

  /** Va sur l'état du meilleur candidat (la méthode la moins coûteuse d'abord), ou le déclare injoignable. */
  private async jumpTo(
    page: Page,
    browser: BrowserManager,
    observers: PageObserver[],
    from: string,
    stateId: string,
  ): Promise<{ page: Page; context?: PageContext }> {
    if (!/^https?:/.test(page.url()) || page.isClosed())
      page = await this.recyclePage(browser, page, observers);
    // Comme un saut du retour arrière : fermer le calque, l'URL, puis le chemin rejoué (jamais l'historique,
    // qui peut ramener sur une page de connexion ou une étape périmée).
    const context = await this.restore(page, stateId);
    if (!context) {
      this.unreachable.add(stateId);
      this.frontier.removeState(stateId);
      this.coverage.stateUnreachable(stateId);
      this.pendingCandidate = undefined;
      return { page };
    }
    this.backtracks += 1;
    this.stuck?.reset();
    this.stack = this.graph
      .flowTo(context.stateId)
      .map((id) => ({ stateId: id, url: this.graph.getNode(id)?.url ?? this.startUrl }));
    this.listener.onBacktrack?.(from, context.stateId, 'best-first: better candidate on this screen');
    return { page, context };
  }

  /**
   * Le moteur de décision exécuterait-il encore quelque chose sur cet état ? Demandé
   * avec la dernière observation de l'état, avant de payer le retour vers lui.
   * Inconnu (aucune observation gardée) : on suppose que oui.
   */
  private async hasWorkLeft(stateId: string): Promise<boolean> {
    const node = this.graph.getNode(stateId);
    const detail = this.details.get(stateId);
    if (!node || !detail) return true;
    const context: PageContext = {
      url: node.url,
      title: node.title ?? '',
      stateId,
      stateLabel: node.label,
      route: node.route,
      headings: node.headings,
      dialogs: [],
      actions: detail.actions,
      forms: detail.forms,
      errors: [],
      metadata: { depth: node.depth, timestamp: new Date().toISOString(), flow: [] },
    };
    const decision = await this.decisionEngine.decide(context, this.graph).catch(() => undefined);
    return decision?.decision === 'EXECUTE';
  }

  /**
   * Ramène la page à un état connu, la méthode la moins coûteuse d'abord : fermer le
   * calque du dessus, historique du navigateur (goBack), puis son URL, puis rejouer
   * le chemin enregistré depuis l'état de départ (pour les états sans URL propre :
   * étapes d'assistant, onglets, fenêtres). Chaque tentative est vérifiée en comparant les id d'état.
   */
  private async restore(page: Page, stateId: string, tryHistory = false): Promise<PageContext | undefined> {
    const steps = this.restoreSteps(page, stateId);
    if (!steps) return undefined;
    this.attribution = {};
    for (const step of [steps.dismiss, ...(tryHistory ? [steps.back] : []), steps.url, steps.replay]) {
      const context = await step();
      if (context) return context;
    }
    return undefined;
  }

  /** Les façons d'atteindre à nouveau un état connu ; chacune ne renvoie l'état que si c'est celui attendu. */
  private restoreSteps(
    page: Page,
    stateId: string,
  ):
    | Record<'dismiss' | 'escape' | 'back' | 'url' | 'replay', () => Promise<PageContext | undefined>>
    | undefined {
    const node = this.graph.getNode(stateId);
    if (!node) return undefined;
    const depth = node.depth;
    const matches = async (method: string): Promise<PageContext | undefined> => {
      if (!this.isExplorablePage(page)) return undefined;
      // Retombé sur la page de connexion (session expirée) : ce n'est pas un écran de l'application.
      if (this.onLoginPage(page) && !this.isLoginUrl(node.url)) return undefined;
      try {
        const context = await this.observeState(page, depth);
        if (context.stateId === stateId) {
          this.listener.onBacktrack?.(this.stack[this.stack.length - 1]?.stateId ?? '', stateId, method);
          return context;
        }
        // Le même écran, retrouvé avec un autre id (un contrôle apparu ou disparu depuis) : il le remplace.
        if (this.isTwinOf(stateId, context)) {
          this.adoptTwin(stateId, context);
          this.listener.onBacktrack?.(
            this.stack[this.stack.length - 1]?.stateId ?? '',
            context.stateId,
            `${method}, same screen as ${stateId}`,
          );
          return context;
        }
      } catch {
        // la page a navigué pendant l'observation
      }
      return undefined;
    };
    const settle = async (): Promise<void> => {
      await page.waitForTimeout(this.config.exploration.settleTimeMs).catch(() => undefined);
      await waitForScreenReady(page, this.config.exploration.readyTimeoutMs);
    };

    return {
      // Une fenêtre, un calendrier… : fermer d'abord le calque du dessus, l'écran dessous reste tel quel.
      dismiss: async () => ((await this.closeTopLayer(page)) ? matches('top layer closed') : undefined),
      escape: async () => {
        if (!this.isExplorablePage(page)) return undefined;
        await page.keyboard.press('Escape').catch(() => undefined);
        await settle();
        return matches('escape');
      },
      back: async () => {
        const before = page.url();
        // goBack renvoie null aussi pour un retour DANS la page (history.pushState d'une application
        // monopage) : c'est l'adresse qui dit si le navigateur est revenu en arrière.
        const moved = await page
          .goBack({
            waitUntil: this.config.exploration.waitUntil,
            timeout: this.config.exploration.navigationTimeoutMs,
          })
          .then(() => page.url() !== before)
          .catch(() => false);
        if (!moved) return undefined;
        await settle();
        return matches('history back');
      },
      url: async () => ((await this.goto(page, node.url)) ? matches('url') : undefined),
      replay: () => this.replayPath(page, stateId),
    };
  }

  /** Rejoue les transitions enregistrées depuis l'état de départ. */
  private async replayPath(page: Page, stateId: string): Promise<PageContext | undefined> {
    const path = this.graph.pathTo(stateId);
    if (
      path.length === 0 ||
      // Une transition qui échoue sans cesse n'est plus rejouée.
      path.some((edge) => this.breaker?.isOpen(edge.from, edge.actionId)) ||
      !(await this.goto(page, this.graph.getNode(this.graph.rootId ?? '')?.url ?? this.startUrl))
    ) {
      return undefined;
    }
    let context = await this.observeState(page, 0).catch(() => undefined);
    for (const edge of path) {
      if (!context || context.stateId !== edge.from) return undefined;
      const form = this.formActions.get(edge.actionId);
      if (form !== undefined) {
        // Un formulaire rempli : le remplir à nouveau (mêmes données de test), sans le signaler deux fois.
        await this.forms.fill(page, context, form);
        context = await this.observeState(page, this.graph.getNode(edge.to)?.depth ?? 0).catch(
          () => undefined,
        );
        continue;
      }
      const action = context.actions.find((candidate) => candidate.id === edge.actionId);
      if (!action || this.safety.evaluate(action).verdict === 'BLOCK') return undefined;
      // Revenir à un écran ne doit jamais créer, modifier ni supprimer une seconde fois.
      if (this.safety.changesData(action)) return undefined;
      const result = await this.execute(page, context, action);
      if (result.status === 'FAILED') return undefined;
      context = await this.observeState(page, this.graph.getNode(edge.to)?.depth ?? 0).catch(() => undefined);
    }
    if (context?.stateId === stateId) {
      this.listener.onBacktrack?.(
        this.stack[this.stack.length - 1]?.stateId ?? '',
        stateId,
        `replay of ${path.length} step(s)`,
      );
      return context;
    }
    return undefined;
  }

  /**
   * Ferme ce qui est devant l'écran (calendrier, menu, fenêtre) avec Escape, sinon
   * avec son bouton « Close »/« Fermer » quand il est SAFE. Indique si quelque chose
   * était devant.
   */
  private async closeTopLayer(page: Page): Promise<boolean> {
    const snapshot = this.lastSnapshot;
    if (!snapshot?.elements.some((element) => element.foreground) || !this.isExplorablePage(page))
      return false;
    const before = await this.observer.observe(page).catch(() => undefined);
    if (!before?.elements.some((element) => element.foreground)) return false;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(this.config.exploration.settleTimeMs).catch(() => undefined);
    const after = await this.observer.observe(page).catch(() => undefined);
    // Escape l'a fermé : terminé. Sinon, son bouton « Fermer ».
    if (!after || this.stateDetector.detect(after).stateId !== this.stateDetector.detect(before).stateId)
      return true;
    const close = this.discovery
      .discover(after, 'close')
      .find(
        (action) =>
          action.foreground === true &&
          action.type === 'click' &&
          action.classification === 'SAFE' &&
          CLOSE_LABEL.test((action.text ?? action.label ?? '').trim()) &&
          this.safety.evaluate(action).verdict !== 'BLOCK',
      );
    if (close) await this.executor.execute(page, close);
    return true;
  }

  private async goto(page: Page, url: string, relogged = false): Promise<boolean> {
    const { exploration } = this.config;
    try {
      await page.goto(url, { waitUntil: exploration.waitUntil, timeout: exploration.navigationTimeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Une redirection lancée par la page elle-même (garde d'authentification, connexion unique…) n'est
      // pas un échec : selon le moment, Chromium la signale « interrupted by another navigation » ou
      // « net::ERR_ABORTED ». Le garde de navigation classe les deux de la même façon.
      if (
        classifyPlaywrightError(error).kind !== 'NAVIGATION_INTERRUPTED' ||
        /chrome-error:/i.test(message)
      ) {
        const kind = /timeout/i.test(message)
          ? 'timeout'
          : /TOO_MANY_REDIRECTS/i.test(message)
            ? 'redirect-loop'
            : 'other';
        this.collector.add({
          type: 'NAVIGATION',
          severity: SeverityRules.navigationFailure(kind),
          message: `Navigation to ${url} failed: ${(message.split('\n')[0] ?? message).trim()}`,
          pageUrl: url,
          requestUrl: url,
        });
        return false;
      }
      await page.waitForLoadState('load').catch(() => undefined);
    }
    if (exploration.settleTimeMs > 0)
      await page.waitForTimeout(exploration.settleTimeMs).catch(() => undefined);
    await waitForScreenReady(page, exploration.readyTimeoutMs);
    if (!relogged && this.onLoginPage(page) && !this.isLoginUrl(url)) {
      // Renvoyé vers la page de connexion : la session a expiré. Se reconnecter (dans une limite), puis y retourner.
      const renewed = await this.reauthenticate(page);
      this.recovery.record(
        { stateId: this.attribution.stateId ?? '', kind: 'session-expired', message: 'session expired' },
        'reauthenticate',
        renewed,
      );
      this.emitRecovery();
      if (renewed) return this.goto(page, url, true);
    }
    return this.isExplorablePage(page);
  }

  private isExplorablePage(page: Page): boolean {
    if (page.isClosed()) return false;
    try {
      const url = new URL(page.url());
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        this.safety.navigation.isAllowedHost(url.hostname)
      );
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- utilitaires

  /** Le budget central (états, actions, durée) : toutes les stratégies s'arrêtent au même endroit. */
  private limitReached(): StopReason | undefined {
    this.budget.set('states', this.graph.nodeCount);
    this.budget.set('actions', this.actionsExecuted);
    this.budget.set('mutations', this.safety.mutationCount);
    return this.budget.exhausted();
  }

  private createObservers(): { all: PageObserver[]; pageErrors: PageErrorObserver } {
    const observation: ObservationContext = {
      currentPageUrl: () => this.currentUrl,
      currentAttribution: () => this.attribution,
      collector: this.collector,
      config: this.config,
    };
    const pageErrors = new PageErrorObserver(observation);
    const tracing = [...(this.config.network.trace ? [this.networkTrace] : []), this.formNetwork];
    if (!this.config.goals.detectErrors) return { all: tracing, pageErrors };
    return {
      all: [new NetworkObserver(observation), new ConsoleObserver(observation), pageErrors, ...tracing],
      pageErrors,
    };
  }

  private async openPage(browser: BrowserManager, observers: PageObserver[]): Promise<Page> {
    if (!this.config.browserInteractions.enabled) {
      const page = await browser.newPage();
      page.setDefaultTimeout(this.config.exploration.actionTimeoutMs);
      // Interactions du navigateur désactivées : les dialogues sont refusés et les nouvelles fenêtres fermées, rien n'est enregistré.
      page.on('dialog', (dialog) => {
        void dialog.dismiss().catch(() => undefined);
      });
      page.on('popup', (popup) => {
        void popup.close().catch(() => undefined);
      });
      for (const observer of observers) observer.attach(page);
      this.navigation.watch(page);
      return page;
    }
    const page = await this.browserEvents.openOwnPage(() => browser.newPage());
    this.navigation.watch(page);
    page.setDefaultTimeout(this.config.exploration.actionTimeoutMs);
    // Dialogues, téléchargements, sélecteurs de fichier, fenêtre de connexion native… : BrowserEventDiscovery → BrowserInteractionManager.
    await this.browserEvents.attachPage(page);
    for (const observer of observers) observer.attach(page);
    return page;
  }

  // ---------------------------------------------------------------- interactions du navigateur

  /** auth.type: http — l'interaction HTTP_AUTH enregistrée dit si la connexion a réussi. */
  private assertHttpLogin(mark: number): void {
    const blocking = this.interactions.blockingSince(mark).find((result) => result.type === 'HTTP_AUTH');
    if (!blocking) return;
    const profile = blocking.credentialProfile ?? this.config.browserInteractions.httpAuth.credentialProfile;
    const missing = profile ? this.credentials.missingVariables(profile) : [];
    const detail =
      blocking.outcome === 'AUTH_REQUIRED' && missing.length > 0
        ? `missing environment variable(s) ${missing.join(', ')}`
        : (blocking.reason ?? '');
    const hint =
      blocking.outcome === 'CREDENTIALS_NOT_ALLOWED'
        ? ' — set auth.origin to the server of the sign-in dialog'
        : '';
    throw new AuthError(
      `HTTP authentication ${blocking.outcome ?? blocking.status} at ${blocking.origin ?? blocking.sourceUrl}: ${detail}${hint}`,
    );
  }

  /** Chaque résultat d'interaction : graphe des flows (enregistré sans secret), transitions de popup, anomalies, listener. */
  private onInteractionResult(result: BrowserInteractionResult): void {
    this.graph.recordInteraction(result);
    if (result.targetStateId && result.stateId && (result.type === 'POPUP' || result.type === 'NEW_TAB')) {
      // CLIC « Voir le document » → POPUP → nouvelle page : la relation reste dans le graphe des flows.
      this.graph.addEdge({
        from: result.stateId,
        to: result.targetStateId,
        actionId: `${result.actionId ?? result.id}#${result.type.toLowerCase()}`,
        action: {
          type: 'navigate',
          category: 'navigation',
          classification: 'SAFE',
          text: result.type,
          ...(result.targetUrl ? { href: result.targetUrl } : {}),
        },
        result: 'SUCCESS',
        interaction: { id: result.id, type: result.type, status: result.status },
      });
    }
    const severity = SeverityRules.browserInteraction(result);
    if (severity) {
      this.collector.add({
        type: 'BROWSER_INTERACTION',
        severity,
        message: `${result.type} ${result.outcome ?? result.status}${result.origin ? ` (${result.origin})` : ''}: ${result.reason ?? ''}`,
        pageUrl: result.sourceUrl || this.currentUrl,
        ...(result.stateId ? { stateId: result.stateId } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
      });
    }
    this.listener.onInteraction?.(result);
  }

  /** Une popup / un nouvel onglet sur une origine autorisée devient un état du graphe (un contexte d'exploration atteignable par URL). */
  private async inspectNewPage(page: Page): Promise<string | undefined> {
    if (!/^https?:/.test(page.url())) return undefined;
    const snapshot = await this.observer.observe(page);
    const state = this.stateDetector.detect(snapshot);
    this.frames.set(state.stateId, frameOf(state.signature));
    const actions = this.discovery.discover(snapshot, state.stateId);
    const sourceDepth = this.currentAction?.stateId
      ? (this.graph.getNode(this.currentAction.stateId)?.depth ?? 0)
      : 0;
    const isNew = this.graph.addNode({
      id: state.stateId,
      label: state.label,
      url: redactUrl(snapshot.url),
      route: state.route,
      title: snapshot.title,
      headings: snapshot.headings,
      ...(stateSubtitle(snapshot) ? { subtitle: stateSubtitle(snapshot) } : {}),
      depth: sourceDepth + 1,
      actions,
    });
    this.details.set(state.stateId, { actions, forms: snapshot.forms });
    if (isNew) {
      this.recordRefusedActions(state.stateId, actions);
      if (this.config.checks.screenshots) {
        const file = await this.screenshots.captureState(page, this.graph.nodeCount, state.label, 'popup');
        if (file) this.graph.setScreenshot(state.stateId, file);
      }
    }
    return state.stateId;
  }

  /** Remplace une page plantée ou bloquée sur une page d'erreur (navigation d'erreur en attente). */
  private async recyclePage(browser: BrowserManager, page: Page, observers: PageObserver[]): Promise<Page> {
    for (const observer of observers) observer.detach(page);
    await page.close().catch(() => undefined);
    return this.openPage(browser, observers);
  }

  private async captureErrorScreenshot(page: Page, context: PageContext, issueIds: string[]): Promise<void> {
    if (!this.config.checks.screenshotOnError || page.isClosed()) return;
    const serious = this.collector
      .all()
      .filter(
        (issue) => issueIds.includes(issue.id) && isAtLeast(issue.severity, 'ERROR') && !issue.screenshot,
      );
    if (serious.length === 0) return;
    const file = await this.screenshots.captureState(
      page,
      this.graph.nodeCount,
      context.stateLabel,
      `error-${serious[0]?.id ?? ''}`,
    );
    if (!file) return;
    for (const issue of serious) issue.screenshot = file;
  }

  private outcome(stopReason: StopReason): ExplorationOutcome {
    this.goals?.finalize(stopReason);
    this.explainUnreachedGoals(stopReason);
    return {
      graph: this.graph,
      issues: this.collector.all(),
      details: this.details,
      flows: this.flowReports,
      interactions: this.interactions.results(),
      stopReason,
      startedAt: this.startedAt,
      finishedAt: new Date(),
      actionsExecuted: this.actionsExecuted,
      backtracks: this.backtracks,
      decisionEngine: this.decisionEngine.name,
      startUrl: redactUrl(this.startUrl),
      runId: this.runId,
      forms: this.formReports,
      recovery: {
        events: this.recovery.events(),
        stuck: this.stuck?.all() ?? [],
        circuits: this.breaker?.circuits() ?? [],
        reauthentications: this.recovery.reauthenticationCount,
        ...(this.navigationEvents.length > 0 ? { navigation: [...this.navigationEvents] } : {}),
      },
      mutations: {
        enabled: this.config.safety.mutations.enabled,
        executed: this.safety.mutationCount,
        ...(this.config.safety.mutations.enabled
          ? { maxPerRun: this.config.safety.mutations.maxPerRun }
          : {}),
      },
      createdData: this.createdData.all(),
      ...(this.verification ? { verification: this.verification } : {}),
      goals: this.goals ? [...this.goals.goals] : [],
      patterns: Object.fromEntries(this.patternsByState),
      coverage: this.coverage.map(),
      decisions: this.traces.selections(),
      ...(this.config.logging.decisionTrace ? { decisionTraces: this.traces.all() } : {}),
      strategy: this.strategy.name,
      blockedWrites: this.writeGuard.all(),
      invariants: this.invariantOracle?.evaluations() ?? [],
      budget: this.budget.usage(),
      ...(this.config.staticAnalysis.enabled ? { staticAnalysis: this.staticSummary() } : {}),
      ...this.formRulesSummary(),
      ...(this.functional ? { functional: this.functional.summary() } : {}),
      ...(this.cognitive ? { cognitive: this.cognitive.summary() } : {}),
      ...(this.ai ? { ai: this.ai.summary() } : {}),
    };
  }

  /** Avant / après une action, sa fenêtre réseau : l'intelligence fonctionnelle en tire ses constats (avant les oracles). */
  private async observeFunctional(
    action: DiscoveredAction,
    before: UiSnapshot | undefined,
    after: UiSnapshot | undefined,
    beforeRoute: string,
    route: string,
  ): Promise<void> {
    const functional = this.functional;
    if (!functional) return;
    const exchanges = await this.formNetwork.stopFunctional(`action-${action.id}`);
    const observation: FunctionalActionObservation = {
      actionId: action.id,
      label: actionLabel(action),
      type: action.type,
      ...(before ? { before: screenFactsOf(before, beforeRoute) } : {}),
      ...(after ? { after: screenFactsOf(after, route) } : {}),
      exchanges,
    };
    functional.afterAction(observation);
  }

  /** FlowGraph : étapes vers un état CONNU de cette route (le planificateur ne parcourt rien lui-même). */
  private knownPathTo(route: string): number | undefined {
    const template = route.replace(/^\//, '').split('/');
    for (const node of this.graph.allNodes()) {
      const actual = node.route.replace(/^\//, '').split('?')[0]?.split('/') ?? [];
      if (actual.length !== template.length) continue;
      if (!template.every((segment, index) => /^[:{]/.test(segment) || segment === actual[index])) continue;
      return this.graph.pathTo(node.id).length;
    }
    return undefined;
  }

  /** Les scénarios déclarés (flows, Gherkin) : leur nom appuie un workflow. */
  private declaredScenarios(): { name: string; source: 'GHERKIN' | 'FLOW_YAML' }[] {
    return this.config.flows.map((flow) => ({ name: flow.name, source: 'FLOW_YAML' as const }));
  }

  /** La valeur saisie par la dernière action (posée par execute()). */
  private executedValue(): { value?: string } {
    return this.lastExecutedValue !== undefined ? { value: this.lastExecutedValue } : {};
  }

  /** Présent seulement quand il y a quelque chose à dire (règles activées, champs analysés, dépendances). */
  private formRulesSummary(): { formRules?: FormRulesSummary } {
    const summary = this.coordinator.summary();
    const useful =
      this.config.rules.enabled || summary.fieldStates.length > 0 || summary.dependencies.length > 0;
    return useful ? { formRules: { ...summary, rulesEnabled: this.config.rules.enabled } } : {};
  }

  private staticSummary(): StaticAnalysisSummary {
    const knowledge = this.staticKnowledge;
    if (!knowledge)
      return {
        status: this.staticLoading ? 'UNAVAILABLE' : 'NOT_NEEDED',
        confirmedFields: [],
        confirmedRoutes: [],
        warnings: [...this.staticWarnings],
        ...(this.staticDiscovery ? { discovery: this.staticDiscovery.summary() } : {}),
      };
    const { graph } = knowledge;
    return {
      status: 'USED',
      mode: graph.mode,
      framework: graph.framework,
      coverage: graph.coverage,
      ...(this.staticCache ? { cache: this.staticCache } : {}),
      files: graph.stats.files,
      durationMs: graph.stats.durationMs,
      routes: graph.routes.length,
      forms: graph.forms.length,
      fields: graph.fields.length,
      apiCalls: graph.apiCalls.length,
      dataFlows: {
        resolved: graph.dataFlows.filter((flow) => flow.status === 'RESOLVED').length,
        unresolved: graph.dataFlows.filter((flow) => flow.status === 'UNRESOLVED_DATA_FLOW').length,
      },
      confirmedFields: knowledge.confirmedFields(),
      confirmedRoutes: graph.routes
        .filter((route) => route.truth === 'RUNTIME_CONFIRMED')
        .map((route) => route.path),
      warnings: [...graph.warnings, ...this.staticWarnings].slice(0, 20),
      ...(this.staticDiscovery ? { discovery: this.staticDiscovery.summary() } : {}),
    };
  }

  // ---------------------------------------------------------------- verify

  /**
   * VERIFY : chaque transition apprise par la baseline est rejouée — son état de
   * départ est atteint à nouveau (par son URL, sinon par le chemin connu depuis le
   * départ), son action exécutée, et l'état atteint comparé à celui enregistré par la
   * baseline. Les observations construisent le graphe courant, comparé ensuite à la
   * baseline (FlowDiffEngine).
   */
  private async verifyKnownTransitions(
    page: Page,
    browser: BrowserManager,
    observers: { all: PageObserver[]; pageErrors: PageErrorObserver },
    baseline: FlowGraphData,
  ): Promise<{ page: Page; stopReason: StopReason }> {
    const reference = FlowGraph.fromJSON(baseline);
    const labelOf = (id: string): string => reference.getNode(id)?.label ?? id;
    const depthOf = (id: string): number => reference.getNode(id)?.depth ?? 0;
    // Transitions autonomes seulement : les flows imposés s'exécutent de toute façon, les formulaires remplis et les popups sont rejoués avec elles.
    const known = new Map<string, FlowEdge>();
    for (const edge of baseline.edges) {
      if (edge.result !== 'SUCCESS' || edge.flow || edge.interaction || edge.actionId.startsWith('form-'))
        continue;
      known.set(`${edge.from}::${edge.actionId}`, edge);
    }
    const queue = [...known.values()].sort((a, b) => depthOf(a.from) - depthOf(b.from));
    const results: VerifiedTransition[] = [];
    const record = (
      edge: FlowEdge,
      status: VerificationStatus,
      extra: Partial<VerifiedTransition> = {},
    ): void => {
      results.push({
        from: edge.from,
        fromLabel: labelOf(edge.from),
        actionId: edge.actionId,
        action: {
          type: edge.action.type,
          ...(edge.action.text ? { text: edge.action.text } : {}),
          ...(edge.action.href ? { href: edge.action.href } : {}),
        },
        expectedTo: edge.to,
        expectedToLabel: labelOf(edge.to),
        status,
        ...extra,
      });
    };

    let stopReason: StopReason = 'exhausted';
    let current: PageContext | undefined;
    for (const [position, edge] of queue.entries()) {
      const limit = this.limitReached();
      if (limit) {
        stopReason = limit;
        for (const skipped of queue.slice(position))
          record(skipped, 'SKIPPED', { reason: `mission limit reached (${limit})` });
        break;
      }
      if (!/^https?:/.test(page.url()) || page.isClosed()) {
        page = await this.recyclePage(browser, page, observers.all);
        current = undefined;
      }
      if (current?.stateId !== edge.from) {
        const reached = await this.reachKnownState(page, reference, edge.from);
        if (typeof reached === 'string') {
          record(edge, 'UNREACHABLE', { reason: reached });
          current = undefined;
          continue;
        }
        current = reached;
      }
      const action = this.findKnownAction(current, edge);
      if (!action) {
        record(edge, 'ACTION_MISSING', { reason: 'the action is no longer on this state' });
        continue;
      }
      const verdict = this.safety.evaluate(action);
      if (verdict.verdict === 'BLOCK') {
        record(edge, 'BLOCKED', { reason: verdict.reason });
        continue;
      }

      // Exécuter et observer, comme l'exploration : anomalies et réseau sont attribués à l'action.
      const from = current;
      const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
      this.attribution = { actionId: action.id };
      this.currentAction = { stateId: from.stateId, actionId: action.id };
      this.networkTrace.start(action.id);
      this.actionClock = Date.now();
      this.actionClock = Date.now();
      const result = await this.execute(page, from, action);
      this.actionsExecuted += 1;
      this.currentAction = undefined;
      const failed = result.status === 'FAILED' || !this.isExplorablePage(page);
      const after = failed
        ? undefined
        : await this.observeState(page, from.metadata.depth + 1).catch(() => undefined);
      const ids = this.collector
        .all()
        .filter((issue) => !issuesBefore.has(issue.id))
        .map((issue) => issue.id);
      const network = this.networkOf(action.id);
      this.collector.assignState(ids, after?.stateId ?? from.stateId, from.metadata.flow);
      const edgeRecorded = this.graph.addEdge({
        from: from.stateId,
        to: after?.stateId ?? from.stateId,
        // L'id de la baseline : c'est la même transition, quel que soit l'enregistrement sur lequel elle a été rejouée.
        actionId: edge.actionId,
        action: summaryOf(action),
        ...network,
        result: after ? 'SUCCESS' : 'FAILED',
        ...(after ? {} : { reason: result.error ?? 'left the allowed hosts or the page crashed' }),
        durationMs: result.durationMs,
        issueIds: ids,
      });
      this.listener.onTransition?.(edgeRecorded, action);
      if (!after) {
        record(edge, 'FAILED', {
          reason: edgeRecorded.reason ?? 'failed',
          ...(network.network ? { network: network.network } : {}),
        });
        current = undefined;
        continue;
      }
      record(edge, after.stateId === edge.to ? 'PASSED' : 'CHANGED', {
        actualTo: after.stateId,
        actualToLabel: after.stateLabel,
        ...(after.stateId === edge.to ? {} : { reason: `now leads to ${after.stateLabel}` }),
        ...(network.network ? { network: network.network } : {}),
      });
      current = after;
    }

    const summary = Object.fromEntries(VERIFICATION_STATUSES.map((status) => [status, 0])) as Record<
      VerificationStatus,
      number
    >;
    for (const verified of results) summary[verified.status] += 1;
    this.verification = {
      ...(this.baselineRunId ? { baselineRunId: this.baselineRunId } : {}),
      transitions: results,
      summary,
      regressions: results.filter((verified) => REGRESSION_STATUSES.includes(verified.status)).length,
    };
    return { page, stopReason };
  }

  /**
   * L'action d'une transition connue sur l'écran courant : même id, sinon le même
   * contrôle (type + texte) vers le même genre de cible — un autre enregistrement
   * (/users/1 appris, /users/2 atteint) ou un autre environnement (appris en QA,
   * vérifié sur l'environnement d'une PR).
   */
  private findKnownAction(context: PageContext, edge: FlowEdge): DiscoveredAction | undefined {
    const mode = this.config.exploration.queryParams.mode;
    const sameTarget = (href: string | undefined): boolean => {
      if (href === edge.action.href) return true;
      if (href === undefined || edge.action.href === undefined) return false;
      try {
        return routeKey(href, mode) === routeKey(edge.action.href, mode);
      } catch {
        return false;
      }
    };
    return (
      context.actions.find((candidate) => candidate.id === edge.actionId) ??
      context.actions.find(
        (candidate) =>
          candidate.type === edge.action.type &&
          candidate.text === edge.action.text &&
          sameTarget(candidate.href),
      )
    );
  }

  /** Une URL de la baseline, sur la cible de ce run (la baseline peut venir d'un autre environnement). */
  private rebase(url: string, reference: FlowGraph): string {
    try {
      const learned = new URL(reference.getNode(reference.rootId ?? '')?.url ?? url);
      const target = new URL(this.startUrl);
      const parsed = new URL(url);
      if (parsed.origin !== learned.origin || learned.origin === target.origin) return url;
      return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, target.origin).toString();
    } catch {
      return url;
    }
  }

  /**
   * Atteint un état de la baseline : par sa propre URL d'abord, sinon en rejouant le
   * chemin de la baseline depuis la page de départ. Renvoie le contexte observé, ou
   * la raison pour laquelle il n'a pas pu être atteint.
   */
  private async reachKnownState(
    page: Page,
    reference: FlowGraph,
    stateId: string,
  ): Promise<PageContext | string> {
    const node = reference.getNode(stateId);
    if (!node) return 'unknown state';
    if (await this.goto(page, this.rebase(node.url, reference))) {
      const context = await this.observeState(page, node.depth).catch(() => undefined);
      if (context?.stateId === stateId) return context;
    }
    const root = reference.getNode(reference.rootId ?? '');
    if (!(await this.goto(page, root ? this.rebase(root.url, reference) : this.startUrl)))
      return 'start page unreachable';
    let context = await this.observeState(page, 0).catch(() => undefined);
    for (const step of reference.pathTo(stateId)) {
      if (!context) return 'page could not be observed';
      if (context.stateId !== step.from)
        return `path broken: expected ${reference.getNode(step.from)?.label ?? step.from}, found ${context.stateLabel}`;
      const action = this.findKnownAction(context, step);
      if (!action)
        return `path broken: "${step.action.text ?? step.action.href ?? step.actionId}" missing on ${context.stateLabel}`;
      if (this.safety.evaluate(action).verdict === 'BLOCK') return 'path blocked by the safety policy';
      const result = await this.execute(page, context, action);
      if (result.status === 'FAILED') return `path broken: "${step.action.text ?? step.actionId}" failed`;
      context = await this.observeState(page, reference.getNode(step.to)?.depth ?? 0).catch(() => undefined);
    }
    if (context?.stateId === stateId) return context;
    return `reached ${context?.stateLabel ?? 'nothing'} instead`;
  }
}

/** Court, lisible, assez unique : le temps en base 36 (par exemple "mg3k2x1a"). */
function newRunId(): string {
  return Date.now().toString(36);
}

function skippedStep(step: FlowStep, index: number, reason: string): FlowStepReport {
  return {
    index,
    kind: step.kind,
    description: describeStep(step),
    status: 'SKIPPED',
    optional: step.optional,
    reason,
    durationMs: 0,
  };
}

/** Raison d'une transition bloquée par des interactions du navigateur (par exemple "HTTP_AUTH AUTH_REQUIRED: …"). */
/** Boutons qui ferment un calque (fenêtre, calendrier, panneau). */
const CLOSE_LABEL =
  /^(close|fermer|close calendar|fermer le calendrier|close dialog|fermer la fen[eê]tre|[×✕✖x])$/i;

/** Nom d'un champ de formulaire dans les rapports : son libellé, le libellé de son groupe, sinon son name. */
function fieldName(action: DiscoveredAction): string {
  const field = action.field;
  const own = field?.label ?? action.label ?? action.text ?? field?.name ?? '?';
  const name = field?.groupLabel && field.choiceGroup !== undefined ? field.groupLabel : own;
  return name.replace(/^\*\s*|\s*\*$/g, ''); // marque d'obligation
}

/** `form "Nouveau dossier": field "Code agence" (value "12345"): Ce champ est obligatoire` */
function validationMessage(run: FormRun, field: FormRun['fields'][number], message: string): string {
  const value =
    field.value !== undefined ? `value "${field.value}"` : field.skipped ? 'left empty' : 'filled';
  return `form "${run.name}": field "${fieldName(field.action)}" (${value}): ${message}`;
}

function blockingReason(results: readonly BrowserInteractionResult[]): string {
  return results
    .map(
      (result) =>
        `${result.type} ${result.outcome ?? result.status}${result.reason ? `: ${result.reason}` : ''}`,
    )
    .join('; ');
}

/** « AMBIGUOUS_FIELD », « ACTION_NOT_FOUND »… : le code d'une résolution qui n'aboutit pas. */
function failureCode(intent: GherkinIntent, status: string): string {
  const kind =
    intent.kind === 'FILL' || intent.kind === 'SELECT' || intent.kind === 'CHECK' || intent.kind === 'UPLOAD'
      ? 'FIELD'
      : intent.kind === 'NAVIGATE'
        ? 'PAGE'
        : intent.kind === 'FILL_FORM'
          ? 'FORM'
          : 'ACTION';
  if (status === 'AMBIGUOUS') return `AMBIGUOUS_${kind}`;
  if (status === 'BLOCKED') return `${kind}_BLOCKED`;
  return `${kind}_NOT_FOUND`;
}

/** Où une application affiche ses messages : alertes, statuts, zones live, notifications. */
const MESSAGE_SELECTOR = [
  '[role="alert"]',
  '[role="status"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '.toast',
  '.snackbar',
  '.mat-mdc-snack-bar-container',
  '.alert',
  '.notification',
].join(', ');

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Le contexte fonctionnel d'un écran observé : route, onglets sélectionnés, sections ouvertes, dialogue. */
function functionalContextOf(snapshot: UiSnapshot | undefined): FunctionalStepContext | undefined {
  if (!snapshot) return undefined;
  const visible = snapshot.elements.filter((element) => element.visible);
  const dialog = visible.find((element) => element.dialogName)?.dialogName;
  return {
    route: pathOf(snapshot.url),
    selectedTabs: visible
      .filter((element) => element.role === 'tab' && element.selected === true)
      .map((element) => element.name),
    expandedSections: visible.filter((element) => element.expanded === true).map((element) => element.name),
    ...(dialog ? { dialog } : {}),
  };
}
