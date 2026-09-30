import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { IssueCollector } from '../anomaly/issue-collector.js';
import { SeverityRules } from '../anomaly/severity-rules.js';
import { AuthError, createAuthenticator, type Authenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { ScreenshotService } from '../browser/screenshot-service.js';
import type { ScenarioConfig } from '../config/config.js';
import {
  describeExpectation,
  describeStep,
  describeTarget,
  type FlowConfig,
  type FlowExpectation,
  type FlowStep,
  type FlowTarget,
} from '../config/flow-schema.js';
import { findByName, planAutoStep } from '../flows/gherkin/auto-step.js';
import { normalizeText } from '../policies/keywords.js';
import { DefaultTestDataProvider, type TestDataProvider } from '../data/test-data-provider.js';
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
import { FlowStepExecutor, type FlowElementAction } from '../flows/flow-step-executor.js';
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
  FlowStepReport,
  SemanticResolutionReport,
} from '../model/flow-run.js';
import { isAtLeast, type Issue, type IssueType, type Severity } from '../model/issue.js';
import type { NetworkExchange } from '../model/network.js';
import type { PageContext } from '../model/page-context.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { StateDetector, stateSubtitle } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
import { waitForScreenReady } from '../observation/screen-ready.js';
import { fieldLabel, formFieldsFor } from '../forms/form-fields.js';
import { StaticApplicationAnalyzer, type StaticAnalysisEvent } from '../static-analysis/static-analyzer.js';
import { StaticKnowledge, annotateStaticFields } from '../static-analysis/static-knowledge.js';
import { isScriptResponse, playwrightFetcher, runtimeScriptUrls } from '../static-analysis/bundle.js';
import {
  RepositorySourceProvider,
  RuntimeBundleSourceProvider,
} from '../static-analysis/sources/source-providers.js';
import { StaticSourceDiscovery } from '../static-analysis/sources/source-discovery.js';
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
import { semanticsOf, type Semantics } from '../semantics/domain-packs.js';

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
}

export interface FlowExplorerOptions {
  memory: FlowMemory;
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
  private readonly screenshots: ScreenshotService;
  private readonly authenticator: Authenticator;
  private readonly listener: ExplorationListener;
  private readonly memory: FlowMemory;
  private readonly startUrl: string;
  private readonly flowSteps: FlowStepExecutor;
  /** Interactions du navigateur hors du DOM (fenêtre de connexion native, dialogues JS, popups, téléchargements…). */
  private readonly interactions: BrowserInteractionManager;
  private readonly browserEvents: BrowserEventDiscovery;
  private readonly credentials: EnvironmentCredentialProvider;
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

  constructor(
    private readonly config: ScenarioConfig,
    options: FlowExplorerOptions,
  ) {
    const { exploration, goals } = config;
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
    this.observer = options.observer?.(this.navigation) ?? new UIObserver(400, this.navigation);
    this.executor = new PlaywrightActionExecutor(
      exploration.actionTimeoutMs,
      exploration.settleTimeMs,
      this.navigation,
      exploration.readyTimeoutMs,
    );
    this.flowSteps = new FlowStepExecutor(exploration.settleTimeMs, exploration.readyTimeoutMs);
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
    this.browserEvents = new BrowserEventDiscovery(this.interactions, {
      origins,
      httpAuth: config.browserInteractions.enabled,
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
    this.memory = options.memory;
    this.startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
    this.currentUrl = this.startUrl;
    this.collector.onIssue((issue, isNew) => this.listener.onIssue?.(issue, isNew));
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
      const context = await browser.start(this.authenticator.contextOptions());
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
          (this.dryRunHook !== undefined && this.config.staticAnalysis.dryRun.useStaticKnowledge))
      )
        await this.ensureStaticKnowledge(page);
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
      await this.browserEvents
        .settle(
          Math.max(
            5_000,
            2 * popupLoad + exploration.actionTimeoutMs + browserInteractions.popups.closeAfterMs,
          ),
        )
        .catch(() => undefined);
      await browser.close();
    }
    await this.memory.save(this.graph);
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
    // Les anomalies levées à partir de maintenant sont causées par cette action ; leur état est connu après l'observation.
    this.attribution = { actionId: action.id };
    this.currentAction = { stateId: from.stateId, actionId: action.id };
    this.writeGuard.during(from.stateId, action.id, `${action.type} "${actionLabel(action)}"`);
    this.frontier.remove(from.stateId, action.id);
    const interactionMark = this.interactions.mark();

    this.networkTrace.start(action.id);
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
    const value =
      instruction?.kind === 'fill'
        ? instruction.value
        : instruction?.kind === 'select'
          ? instruction.label
          : undefined;
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
    this.flowNetwork = [];
    this.scenario = { values: [] };
    this.listener.onFlowStart?.(flow);
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

      const outcome = await this.runFlowStep(page, browser, observers, flow, step, index, context);
      page = outcome.page;
      context = outcome.context ?? context;
      report.steps.push(outcome.report);
      this.listener.onFlowStep?.(flow, outcome.report);
      if (outcome.report.stateId && report.states[report.states.length - 1] !== outcome.report.stateId) {
        report.states.push(outcome.report.stateId);
      }
      if (outcome.report.status === 'FAILED' || outcome.report.status === 'BLOCKED') {
        await this.flowIssue(flow, outcome.report, outcome.report.reason ?? '', step.optional, page, context);
        if (!step.optional) {
          report.status = outcome.report.status;
          stopped = `step ${index} ${outcome.report.status.toLowerCase()}`;
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
    }
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
    const analyzer = new StaticApplicationAnalyzer({
      applicationId: this.config.mission.name,
      ...((settings.version ?? this.env.QA_VERSION)
        ? { version: settings.version ?? this.env.QA_VERSION }
        : {}),
      ...((settings.commit ?? this.env.QA_COMMIT) ? { commit: settings.commit ?? this.env.QA_COMMIT } : {}),
      features: settings.features,
      analyzers: settings.analyzers,
      budgets: settings.budgets,
      ...(settings.cache.enabled
        ? {
            cacheDirectory:
              settings.cache.directory ??
              path.join(path.dirname(path.resolve(this.config.output.reportsDir)), 'knowledge', 'static'),
          }
        : {}),
      onEvent: (event, message) => {
        this.emitStatic(event, message);
      },
    });
    this.staticAnalyzer = analyzer;
    const root = settings.source.enabled ? settings.source.root : undefined;
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
            isAllowedUrl: (url) => this.safety.navigation.isAllowedHost(new URL(url).hostname),
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
    return new StaticKnowledge(outcome.graph, (text) => vocabulary.conceptOf(text)?.concept, this.contract);
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
      ...(intent.kind === 'FILL' && typeof intent.value !== 'string' ? { sensitiveValue: true } : {}),
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
        return finish(outcome);
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
    // « Où est-il ? »
    const located = await this.flowSteps.locate(page, step.target, timeout);
    if (typeof located === 'string') {
      // Chercher à l'écran ce que le YAML voulait probablement dire, et indiquer comment l'écrire.
      const found = await suggestTargets(page, step).catch(() => undefined);
      return {
        page,
        report: done('FAILED', {
          reason: located,
          stateId: context.stateId,
          url: context.url,
          ...(found && found.suggestions.length > 0 ? { suggestions: found.suggestions } : {}),
          ...(found && found.onScreen.length > 0 ? { onScreen: found.onScreen } : {}),
        }),
      };
    }

    // « Qu'est-ce que c'est ? » — la même observation et le même classement que l'exploration autonome.
    let before: PageContext;
    let action: DiscoveredAction | undefined;
    try {
      await this.flowSteps.mark(located);
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
      const text = ((await located.innerText({ timeout }).catch(() => '')) || '')
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
      return {
        page,
        report: done('FAILED', {
          reason: 'element is disabled',
          stateId: before.stateId,
          url: before.url,
          classification: action.classification,
        }),
      };
    }

    // « Ai-je le droit ? » — avant Playwright, quoi que dise le YAML.
    const value = step.kind === 'fill' ? step.value : undefined;
    const verdict = evaluateFlowAction(this.safety, action, {
      allow: step.allow,
      valueFromEnv: value !== undefined && typeof value !== 'string',
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
      const resolved = typeof step.value === 'string' ? step.value : this.env[step.value.env];
      if (resolved === undefined) {
        const name = typeof step.value === 'string' ? '' : step.value.env;
        return {
          page,
          context: before,
          report: done('FAILED', {
            reason: `environment variable ${name} is not set`,
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
    this.writeGuard.during(before.stateId, action.id, `flow "${flow.name}" step "${actionLabel(action)}"`);
    // Une étape qui a le droit de modifier des données (allow), ou l'écran de connexion d'un flow, peut écrire.
    const mayWrite =
      step.allow.some((allowed) => allowed === 'MUTATION' || allowed === 'DANGEROUS') ||
      (this.patternsByState.get(before.stateId) ?? []).some((pattern) => pattern.type === 'LOGIN');
    const perform = (): Promise<string | undefined> =>
      this.flowSteps.perform(page, located, elementAction, timeout);
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

    // « Que s'est-il passé ? »
    const after = await this.observeState(page, before.metadata.depth + 1);
    const ids = newIssues();
    const edge = this.graph.addEdge({
      from: before.stateId,
      to: after.stateId,
      actionId: action.id,
      action: summaryOf(action),
      ...this.networkOf(action.id),
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
    return {
      page,
      context: after,
      report: done('PASSED', {
        stateId: after.stateId,
        url: after.url,
        classification: action.classification,
      }),
    };
  }

  /** Classement d'un élément que l'observateur ne liste pas (texte simple, conteneur…). */
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
    const tracing = this.config.network.trace ? [this.networkTrace] : [];
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
    };
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
