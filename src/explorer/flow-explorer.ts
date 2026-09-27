import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { IssueCollector } from '../anomaly/issue-collector.js';
import { SeverityRules } from '../anomaly/severity-rules.js';
import { AuthError, createAuthenticator, type Authenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { ScreenshotService } from '../browser/screenshot-service.js';
import type { ScenarioConfig } from '../config/config.js';
import { describeStep, type FlowConfig, type FlowStep } from '../config/flow-schema.js';
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
import { FormExerciser, type FormRun } from '../forms/form-exerciser.js';
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
import type { FlowRunReport, FlowStatus, FlowStepReport } from '../model/flow-run.js';
import { isAtLeast, type Issue, type IssueType } from '../model/issue.js';
import type { PageContext } from '../model/page-context.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { StateDetector, stateSubtitle } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
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
import { SafetyPolicy } from '../policies/safety-policy.js';
import { redactUrl } from '../security/redactor.js';
import { CircuitBreaker } from '../recovery/circuit-breaker.js';
import { RecoveryEngine, type RecoveryActions } from '../recovery/recovery-engine.js';
import type { FailureKind, RecoveryEvent, RecoverySummary, StuckEvent } from '../recovery/recovery-model.js';
import { StuckDetector } from '../recovery/stuck-detector.js';
import { AccessibilityChecker } from '../accessibility/accessibility-checker.js';
import { CreatedDataRegistry, type CreatedDataRecord } from '../data/created-data.js';
import { routeKey } from '../crawler/route-normalizer.js';

/** Progress notifications (CLI output, tests). */
export interface ExplorationListener {
  onAuthenticated?(description: string): void;
  onState?(context: PageContext, isNew: boolean): void;
  onDecision?(context: PageContext, decision: ActionDecision): void;
  onBlocked?(context: PageContext, action: DiscoveredAction, reason: string): void;
  onTransition?(edge: FlowEdge, action: DiscoveredAction): void;
  /** The test oracles judged an executed action. */
  onOracle?(edge: FlowEdge, verdict: OracleVerdict): void;
  onBacktrack?(from: string, to: string | undefined, method: string): void;
  /** A recovery strategy was tried after a failure. */
  onRecovery?(event: RecoveryEvent): void;
  /** The exploration turned in circles on a branch and left it. */
  onStuck?(event: StuckEvent): void;
  onIssue?(issue: Issue, isNew: boolean): void;
  onFlowStart?(flow: FlowConfig): void;
  onFlowStep?(flow: FlowConfig, step: FlowStepReport): void;
  onFlowEnd?(report: FlowRunReport): void;
  /** A browser interaction outside the DOM was handled (or refused). */
  onInteraction?(result: BrowserInteractionResult): void;
  /** Structured log line of a browser interaction (no secret). */
  onInteractionLog?(line: string): void;
}

export interface FlowExplorerOptions {
  memory: FlowMemory;
  decisionEngine?: DecisionEngine;
  testData?: TestDataProvider;
  listener?: ExplorationListener;
  env?: NodeJS.ProcessEnv;
  /** `stateId::actionId` known from the baseline (explore mode): tried after new ground. */
  knownActions?: ReadonlySet<string>;
  /** Id of the run (default: testData.runId, else generated). */
  runId?: string;
  /** Known transitions (the baseline), for the BaselineOracle. */
  baseline?: FlowGraphData;
  /** API contract (OpenAPI), for the ContractOracle and the form fields. */
  contract?: ApiContract;
  /** verify: the known transitions of this baseline are replayed instead of exploring. */
  verifyBaseline?: FlowGraphData;
  /** Id of the baseline run being verified (reports). */
  baselineRunId?: string;
}

/** What the explorer knows after one run; the reporters turn it into files. */
export interface ExplorationOutcome {
  graph: FlowGraph;
  issues: Issue[];
  /** Latest full observation of each state (actions with locators, forms). */
  details: Map<string, { actions: DiscoveredAction[]; forms: FormSummary[] }>;
  /** Imposed flows, in mission order. */
  flows: FlowRunReport[];
  /** Browser interactions outside the DOM, in order. */
  interactions: BrowserInteractionResult[];
  stopReason: StopReason;
  startedAt: Date;
  finishedAt: Date;
  actionsExecuted: number;
  backtracks: number;
  decisionEngine: string;
  startUrl: string;
  /** Id of the run, carried by the data it created (QA-CRAWLER-<runId>). */
  runId: string;
  /** Forms found and filled. */
  forms: FormReport[];
  /** Recovery attempts, abandoned branches and open circuits. */
  recovery: RecoverySummary;
  /** Actions changing data: executed, and the budget (safety.mutations). */
  mutations: { enabled: boolean; executed: number; maxPerRun?: number };
  /** Data the run probably created (to clean up), never the values sent. */
  createdData: CreatedDataRecord[];
  /** verify mode: every known transition of the baseline, replayed. */
  verification?: VerificationReport;
}

interface StackEntry {
  stateId: string;
  url: string;
}

/**
 * Orchestrates the exploration loop. Each responsibility belongs to one component:
 *
 *   UIObserver + StateDetector   "Where am I?"
 *   ActionDiscovery              "What can I do?"
 *   DecisionEngine               "What should I try?"
 *   SafetyPolicy                 "Is it allowed?"
 *   PlaywrightActionExecutor     "Execute it."
 *   Observers                    "What went wrong?"
 *   FlowGraph + FlowMemory       "What have I learned?"
 *
 * The explorer only sequences them, keeps the navigation stack, backtracks,
 * and enforces the mission's limits.
 */
export class FlowExplorer {
  private readonly collector = new IssueCollector();
  private readonly safety: SafetyPolicy;
  private readonly observer = new UIObserver();
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
  /** Browser interactions outside the DOM (native sign-in dialog, JS dialogs, popups, downloads…). */
  private readonly interactions: BrowserInteractionManager;
  private readonly browserEvents: BrowserEventDiscovery;
  private readonly credentials: EnvironmentCredentialProvider;
  /** Action being executed, for interaction attribution and loop detection. */
  private currentAction: InteractionContext | undefined;
  private readonly env: NodeJS.ProcessEnv;

  private graph = new FlowGraph();
  private readonly details = new Map<string, { actions: DiscoveredAction[]; forms: FormSummary[] }>();
  private stack: StackEntry[] = [];
  /** States where the engine found nothing left to do. */
  private readonly exhausted = new Set<string>();
  /** States the explorer could not return to. */
  private readonly unreachable = new Set<string>();
  private currentUrl: string;
  private attribution: IssueAttribution = {};
  /** False while exploring below a flow's last screen (thenExplore). */
  private allowJump = true;
  private actionsExecuted = 0;
  private backtracks = 0;
  private startedAt = new Date();
  private readonly flowReports: FlowRunReport[] = [];
  /** Last raw observation (lets flow steps find the element they target). */
  private lastSnapshot: UiSnapshot | undefined;
  private readonly forms: FormExerciser;
  /** Network window of each action (FlowEdge.network). */
  private readonly networkTrace: NetworkTraceRecorder;
  /** Id of this run, carried by the data it creates (QA-CRAWLER-<runId>). */
  readonly runId: string;
  private readonly verifyBaseline: FlowGraphData | undefined;
  private readonly baselineRunId: string | undefined;
  private verification: VerificationReport | undefined;
  /** Judges each executed action (undefined when oracles.enabled is false). */
  private readonly oracle: CompositeTestOracle | undefined;
  /** Forms already filled, per state (`stateId|group`). */
  private readonly formsExercised = new Set<string>();
  /** Transitions that filled a form: id → form, to fill it again when a path is replayed. */
  private readonly formActions = new Map<string, string>();
  /** Every form filled, for the report (never a sensitive value). */
  private readonly formReports: FormReport[] = [];
  private readonly recovery: RecoveryEngine;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly stuck: StuckDetector | undefined;
  /** The last action left the branch stuck: the loop leaves it. */
  private pendingStuck: StuckEvent | undefined;
  private readonly accessibility: AccessibilityChecker | undefined;
  private readonly createdData: CreatedDataRegistry;

  constructor(
    private readonly config: ScenarioConfig,
    options: FlowExplorerOptions,
  ) {
    const { exploration, goals } = config;
    this.safety = new SafetyPolicy(config.safety);
    this.stateDetector = new StateDetector(exploration.queryParams.mode, exploration.queryParams.ignored);
    this.discovery = new ActionDiscovery(this.safety, exploration.maxRecordedActions);
    this.decisionEngine =
      options.decisionEngine ??
      new RuleBasedDecisionEngine(this.safety, {
        maxSimilarActions: config.exploration.maxSimilarActions,
        missionName: config.mission.name,
        keywords: goals.keywords,
        weights: scoringWeights(config.scoring.weights),
        ...(options.knownActions ? { knownActions: options.knownActions } : {}),
        goals,
        maxDepth: exploration.maxDepth,
        maxStatesPerRoute: exploration.maxStatesPerRoute,
        queryParamMode: exploration.queryParams.mode,
      });
    this.executor = new PlaywrightActionExecutor(exploration.actionTimeoutMs, exploration.settleTimeMs);
    this.flowSteps = new FlowStepExecutor(exploration.settleTimeMs);
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
      });
    this.forms = new FormExerciser(
      this.executor,
      this.testData,
      this.safety,
      this.runId,
      undefined,
      options.contract,
    );
    const { oracles } = config;
    this.oracle = oracles.enabled
      ? new CompositeTestOracle([
          new TechnicalOracle({ api404: oracles.technical.api404 }),
          ...(oracles.ui.enabled ? [new UIOracle([...DEFAULT_ERROR_TEXTS, ...oracles.ui.errorTexts])] : []),
          ...(oracles.baseline.enabled ? [new BaselineOracle(options.baseline)] : []),
          new ContractOracle(options.contract),
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
      // Browser interactions outside the DOM (new windows, dialogs, sign-in dialog…) go through the manager.
      if (this.config.browserInteractions.enabled) await this.browserEvents.attachContext(context);
      const { grant } = this.config.browserInteractions.permissions;
      if (grant.length > 0) await context.grantPermissions(grant, { origin: new URL(this.startUrl).origin });
      let page = await this.openPage(browser, observers.all);

      const loginMark = this.interactions.mark();
      await this.authenticator.login(page);
      if (this.config.auth.type === 'http') this.assertHttpLogin(loginMark);
      if (this.config.auth.type !== 'none') this.listener.onAuthenticated?.(this.authenticator.description);

      const startMark = this.interactions.mark();
      const started = await this.goto(page, this.startUrl);
      if (started && this.interactions.blockingSince(startMark).length > 0) {
        // e.g. AUTH_REQUIRED on the start page: recorded, nothing else can be explored.
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
      // The start state is the root of the flow graph, whatever the flows visit first.
      let current = await this.observeState(page, 0);

      // 1. Imposed flows, in mission order.
      let flowsStop: StopReason | undefined;
      if (this.config.flows.length > 0) {
        const flows = await this.runFlows(page, browser, observers);
        page = flows.page;
        flowsStop = flows.stopReason;
      }

      // 2. verify: replay the known transitions of the baseline. Otherwise, autonomous exploration.
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
      await browser.close();
    }
    await this.memory.save(this.graph);
    return this.outcome(stopReason);
  }

  /**
   * OBSERVE → DECIDE → SAFETY CHECK → EXECUTE → OBSERVE → STORE, from `current`
   * until the engine stops, a limit is reached or nothing is left. With a
   * `scope` (exploration of a flow's last screen, `thenExplore`), only
   * in-page controls and links to pages below that screen are considered,
   * the global menu is ignored, a screen outside the scope is left at once,
   * and the exploration never jumps to other states.
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
        // An in-page control led elsewhere: go back without exploring that screen here.
        const restored = await this.backtrack(page, browser, observers.all, false);
        page = restored.page;
        if (!restored.context) return { page, stopReason: 'exhausted' };
        current = restored.context;
        continue;
      }

      // Forms first: a screen with fields (a dialog "Nouveau dossier"…) is filled, then checked.
      const form = this.formToExercise(current);
      if (form) {
        const step = await this.exerciseForm(page, current, form);
        page = step.page;
        current = step.context;
        continue;
      }

      // The engine only sees what the scope allows; other actions stay unexplored for later.
      const candidates = scope ? { ...current, actions: actionsInScope(scope, current.actions) } : current;
      const decision = await this.decisionEngine.decide(candidates, this.graph);
      this.listener.onDecision?.(current, decision);

      if (decision.decision === 'STOP') return { page, stopReason: 'engine-stop' };
      if (decision.decision === 'BACKTRACK') {
        this.exhausted.add(current.stateId);
        const restored = await this.backtrack(page, browser, observers.all, allowJump);
        page = restored.page;
        if (!restored.context) return { page, stopReason: 'exhausted' }; // nothing left anywhere
        current = restored.context;
        continue;
      }

      const action = current.actions.find((candidate) => candidate.id === decision.actionId);
      if (!action) {
        // The engine proposed something that is not on screen: never retry it.
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

      // "Is it allowed?" — after the decision, before Playwright, whatever the engine.
      const verdict = this.safety.evaluate(action);
      if (verdict.verdict === 'BLOCK') {
        this.graph.recordBlocked(current.stateId, action, verdict.reason);
        this.listener.onBlocked?.(current, action, verdict.reason);
        continue;
      }

      const step = await this.executeAndObserve(page, browser, observers, current, action);
      page = step.page;
      current = step.context;
      await this.memory.save(this.graph);

      const stuck = this.pendingStuck;
      if (stuck) {
        // Turning in circles: this branch is left, the exploration goes on elsewhere.
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

  // ---------------------------------------------------------------- loop steps

  /** OBSERVE → STATE → DISCOVER → record the node. */
  private async observeState(page: Page, depth: number): Promise<PageContext> {
    const snapshot = await this.observer.observe(page);
    this.lastSnapshot = snapshot;
    const state = this.stateDetector.detect(snapshot);
    const actions = this.discovery.discover(snapshot, state.stateId);
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
    // Issues raised while reaching this state belong to it.
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
      dialogs: snapshot.dialogs,
      actions,
      forms: snapshot.forms,
      errors,
      metadata: { depth: node?.depth ?? depth, timestamp: new Date().toISOString(), flow },
    };
    this.attribution = { stateId: state.stateId, flow };
    this.listener.onState?.(context, isNew);
    return context;
  }

  /** EXECUTE → OBSERVE NEW STATE → STORE TRANSITION. */
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
    // Anomalies raised from now on are caused by this action; their state is known after observation.
    this.attribution = { actionId: action.id };
    this.currentAction = { stateId: from.stateId, actionId: action.id };
    const interactionMark = this.interactions.mark();

    this.networkTrace.start(action.id);
    let result = await this.execute(page, from, action);
    this.actionsExecuted += 1;
    // RETRY: a transient Playwright error (element re-rendered under the click), never an action sending data.
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

    // SESSION EXPIRED: the action landed on the login page. Log in again (bounded), come back, try once more.
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
        // A browser interaction that could not be completed (e.g. AUTH_REQUIRED) blocks the transition.
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
      this.graph.attachIssues(from.stateId, ids);
      this.listener.onTransition?.(edge, action);
      await this.captureErrorScreenshot(page, from, ids);
      // Come back to where we were, on a fresh page if the current one is broken.
      if (!/^https?:/.test(page.url()) || page.isClosed()) {
        page = await this.recyclePage(browser, page, observers.all);
      }
      const recovered = await this.recoverFrom(page, browser, observers.all, from, {
        stateId: from.stateId,
        actionId: action.id,
        kind,
        message: edge.reason ?? 'failed',
        navigated: page.url() !== urlBefore,
        // A blocked interaction (AUTH_REQUIRED…) is not a failure of the action itself.
        countFailure: blocking.length === 0,
      });
      if (recovered.context) return { page: recovered.page, context: recovered.context };
      const fallback = { page: recovered.page };
      // The page is no longer in the state the action started from (e.g. a dialog closed by the
      // reload): go on from what is really on screen, not from the stale list of actions.
      if (this.isExplorablePage(fallback.page)) {
        const current = await this.observeState(fallback.page, from.metadata.depth).catch(() => undefined);
        if (current) return { page: fallback.page, context: current };
      }
      return { page: fallback.page, context: from };
    }

    // Global menu entries are reachable from the start state: one step deep, wherever they were clicked.
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
      requests: edge.network?.length ?? 0,
      busy: this.lastSnapshot?.signals?.busy ?? false,
    });
    if (stuck) {
      this.pendingStuck = stuck;
      this.listener.onStuck?.(stuck);
    }
    // Issues of the new state now know which action and path led to them.
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
   * RECOVERY after a failed action: the configured strategies in order
   * (top layer, Escape, history, URL, replayed path, new login, another
   * branch). A failure that keeps coming back opens the circuit: the action,
   * or the whole state, is not tried again.
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
            // Only when a dialog, menu or picker was in front.
            ...(this.lastSnapshot?.elements.some((element) => element.foreground)
              ? { 'dismiss-dialog': steps.dismiss }
              : {}),
            // Nothing moved: Escape and a new look are enough. It moved: history first.
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

  /** ACCESSIBILITY: basic checks on a new screen, reported as anomalies of that state. */
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

  /** Recovery events not yet given to the listener. */
  private recoveryEmitted = 0;
  private emitRecovery(): void {
    const events = this.recovery.events();
    for (const event of events.slice(this.recoveryEmitted)) this.listener.onRecovery?.(event);
    this.recoveryEmitted = events.length;
  }

  /** Did the session expire? With a form login: the page shows the login page it did not ask for. */
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

  /** Logs in again after a session expiry, within the configured limit. */
  private async reauthenticate(page: Page): Promise<boolean> {
    if (!this.recovery.mayReauthenticate()) return false;
    return this.authenticator
      .login(page)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * TEST ORACLE: judges an executed action from what was observed (network,
   * anomalies, screen) and attaches the verdict to its transition. Warnings of
   * the UI, baseline and contract oracles become anomalies (the technical
   * failures already are: HTTP, JavaScript errors…).
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
      },
    );
    edge.oracle = verdict;
    const anomaly: Record<string, IssueType | undefined> = {
      ui: 'UI_ERROR',
      baseline: 'REGRESSION',
      contract: 'CONTRACT',
    };
    for (const opinion of verdict.results) {
      const type = anomaly[opinion.oracle];
      if (!type || (opinion.status !== 'WARNING' && opinion.status !== 'FAIL')) continue;
      for (const reason of opinion.reasons) {
        const issue = this.collector.add({
          type,
          severity: opinion.status === 'FAIL' ? 'ERROR' : 'WARNING',
          message: `"${actionLabel(action)}": ${reason.message}`,
          pageUrl: from.url,
          actionId: action.id,
          stateId: after?.stateId ?? from.stateId,
        });
        if (!edge.issueIds.includes(issue.id)) edge.issueIds.push(issue.id);
      }
    }
    this.listener.onOracle?.(edge, verdict);
  }

  /** Closes the network window of an action: what to spread into its FlowEdge. */
  private networkOf(actionId: string): Pick<FlowEdge, 'network' | 'networkWindow'> {
    const trace = this.networkTrace.stop(actionId);
    if (!trace) return {};
    return {
      network: trace.requests,
      networkWindow: { startedAt: trace.startedAt, finishedAt: trace.finishedAt },
    };
  }

  /** Next form of this state to fill, if the mission explores forms. */
  private formToExercise(context: PageContext): string | undefined {
    if (!this.config.forms.exercise || !this.config.goals.discoverForms) return undefined;
    return this.forms
      .groupsOf(context)
      .find((group) => !this.formsExercised.has(`${context.stateId}|${group}`));
  }

  /**
   * FILL A FORM → CHECK ITS VALIDATION → STORE THE TRANSITION. Nothing is
   * sent: the button that sends the form is an action like any other, under
   * the SafetyPolicy (forms.submit / safety.block).
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
    const run = await this.forms.fill(page, from, group);
    run.problems = await this.forms.validate(page, run);
    const { forms } = this.config;
    if (forms.validationTesting) {
      run.validationCases = await this.forms.testValidation(page, from, run, {
        maxCasesPerField: forms.maxValidationCasesPerField,
        maxCasesPerForm: forms.maxValidationCasesPerForm,
      });
    }
    this.formReports.push(formReportOf(run, from.stateId, actionId));
    // Its fields were handled with the form: not tried again one by one.
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

  /** Prepares the form if needed, then lets the executor act. */
  private async execute(
    page: Page,
    context: PageContext,
    action: DiscoveredAction,
  ): Promise<ActionExecutionResult> {
    if (action.type === 'click' && action.formIndex !== undefined && this.config.goals.discoverForms) {
      await this.prepareForm(page, context, action.formIndex);
    }
    const instruction =
      action.type === 'fill' || action.type === 'select' ? this.testData.instructionFor(action) : undefined;
    const value =
      instruction?.kind === 'fill'
        ? instruction.value
        : instruction?.kind === 'select'
          ? instruction.label
          : undefined;
    // Counted before it runs: an action that fails half-way may still have changed data.
    this.safety.recordExecuted(action);
    return this.executor.execute(page, action, value !== undefined ? { value } : {});
  }

  /**
   * Fills a form with test data before clicking one of its buttons (wizard
   * "Suivant", search…). Each field goes through the SafetyPolicy: sensitive
   * fields (passwords, payment data, secrets) are never filled.
   */
  private async prepareForm(page: Page, context: PageContext, formIndex: number): Promise<void> {
    const fields = context.actions.filter(
      (candidate) =>
        candidate.formIndex === formIndex &&
        (candidate.type === 'fill' || candidate.type === 'select' || candidate.type === 'check'),
    );
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
   * Risky actions refused by the SafetyPolicy are recorded as BLOCKED right
   * away, so reports show them and no engine proposes them again.
   */
  private recordRefusedActions(stateId: string, actions: readonly DiscoveredAction[]): void {
    for (const action of actions) {
      if (action.disabled || !action.visible) continue;
      const verdict = this.safety.evaluate(action);
      if (verdict.verdict === 'BLOCK' && !this.graph.hasTransition(stateId, action.id)) {
        this.graph.recordBlocked(stateId, action, verdict.reason);
      }
    }
  }

  // ---------------------------------------------------------------- imposed flows

  /** Runs every imposed flow in order. Returns a stop reason when a mission limit ended the run. */
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

  /** Reports every flow not run yet as SKIPPED. */
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
    this.listener.onFlowStart?.(flow);
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    const knownStates = new Set(this.graph.allNodes().map((node) => node.id));
    let stopReason: StopReason | undefined;

    // Every flow starts from a freshly loaded page.
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

    // Explore the flow's last screen (often reachable only through the flow).
    if (report.status === 'PASSED' && flow.thenExplore && context && !stopReason) {
      report.explored = true;
      this.stack = [{ stateId: context.stateId, url: context.url }];
      const exhaustedBefore = new Set(this.exhausted);
      const loop = await this.explorationLoop(page, browser, observers, context, scopeOf(context.url));
      page = loop.page;
      this.allowJump = true;
      // "Nothing left" meant "nothing left in the scope": the autonomous exploration may still go further.
      for (const stateId of [...this.exhausted])
        if (!exhaustedBefore.has(stateId)) this.exhausted.delete(stateId);
      if (loop.stopReason !== 'exhausted' && loop.stopReason !== 'engine-stop') stopReason = loop.stopReason;
    } else if (!flow.thenExplore) {
      // States only the flow reaches are not explored autonomously later.
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

  /** One step: locate → classify → SafetyPolicy → execute → observe → store. */
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
        const failure = await this.flowSteps.expect(page, step.expect, timeout);
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
      case 'click':
      case 'check':
      case 'uncheck':
      case 'fill':
      case 'select':
        return this.runFlowElementStep(page, browser, observers, flow, step, context, timeout, done);
    }
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
    // "Where is it?"
    const located = await this.flowSteps.locate(page, step.target, timeout);
    if (typeof located === 'string') {
      // Look at the screen for what the YAML probably meant, and say how to write it.
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

    // "What is it?" — the same observation and classification as autonomous exploration.
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
      // Not an interactive element (plain text, div…): classified from its visible text.
      const text = ((await located.innerText({ timeout }).catch(() => '')) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      action = this.syntheticAction(before.stateId, step, text);
    }
    if (action.risks.includes('sensitive-data')) {
      // Never show what is typed in a sensitive field, even a literal value from the mission.
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

    // "Is it allowed?" — before Playwright, whatever the YAML says.
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

    // "Execute it."
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    this.attribution = { actionId: action.id };
    this.currentAction = { stateId: before.stateId, actionId: action.id, flow: flow.name };
    const interactionMark = this.interactions.mark();
    this.networkTrace.start(action.id);
    const error = await this.flowSteps.perform(page, located, elementAction, timeout);
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

    // "What happened?"
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

  /** Classification of an element the observer does not list (plain text, container…). */
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

  /** A FLOW issue for a failed or blocked step (ERROR, WARNING for optional steps), with a screenshot. */
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
      // Back on a state already in the path (cycle): the path shrinks to it.
      this.stack = this.stack.slice(0, index + 1);
    } else {
      this.stack.push({ stateId: context.stateId, url: context.url });
    }
  }

  /**
   * BACKTRACK: return to the closest ancestor that still has something to
   * explore; when the whole path is exhausted, jump to any known state with
   * unexplored actions. Returns no context when there is nothing left.
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
      // Nothing interesting left there: no need to go back to it, the path goes on shrinking.
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

    // The current path is exhausted: look for any other state with unexplored actions.
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
        this.stack = this.graph.flowTo(node.id).map((stateId) => ({
          stateId,
          url: this.graph.getNode(stateId)?.url ?? this.startUrl,
        }));
        this.listener.onBacktrack?.(from, node.id, 'jump to a state with unexplored actions');
        return { page, context };
      }
      this.unreachable.add(node.id);
    }
    this.listener.onBacktrack?.(from, undefined, 'nothing left to explore');
    return { page };
  }

  /**
   * Would the decision engine still execute something on this state? Asked
   * with the state's last observation, before paying for going back to it.
   * Unknown (no observation kept): assume yes.
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
   * Brings the page back to a known state, cheapest method first: close the
   * top layer, browser history (goBack), then its URL, then replaying the
   * recorded path from the start state (for states without their own URL:
   * wizard steps, tabs, dialogs). Each attempt is verified by comparing state ids.
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

  /** The ways of reaching a known state again; each returns the state only when it is the expected one. */
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
      try {
        const context = await this.observeState(page, depth);
        if (context.stateId === stateId) {
          this.listener.onBacktrack?.(this.stack[this.stack.length - 1]?.stateId ?? '', stateId, method);
          return context;
        }
      } catch {
        // page navigated while being observed
      }
      return undefined;
    };
    const settle = (): Promise<void> =>
      page.waitForTimeout(this.config.exploration.settleTimeMs).catch(() => undefined);

    return {
      // A dialog, a date picker…: close the top layer first, the screen under it stays as it is.
      dismiss: async () => ((await this.closeTopLayer(page)) ? matches('top layer closed') : undefined),
      escape: async () => {
        if (!this.isExplorablePage(page)) return undefined;
        await page.keyboard.press('Escape').catch(() => undefined);
        await settle();
        return matches('escape');
      },
      back: async () => {
        const back = await page
          .goBack({
            waitUntil: this.config.exploration.waitUntil,
            timeout: this.config.exploration.navigationTimeoutMs,
          })
          .catch(() => null);
        if (back === null) return undefined;
        await settle();
        return matches('history back');
      },
      url: async () => ((await this.goto(page, node.url)) ? matches('url') : undefined),
      replay: () => this.replayPath(page, stateId),
    };
  }

  /** Replays the recorded transitions from the start state. */
  private async replayPath(page: Page, stateId: string): Promise<PageContext | undefined> {
    const path = this.graph.pathTo(stateId);
    if (
      path.length === 0 ||
      // A transition that keeps failing is not replayed again.
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
        // A filled form: fill it again (same test data), without reporting it twice.
        await this.forms.fill(page, context, form);
        context = await this.observeState(page, this.graph.getNode(edge.to)?.depth ?? 0).catch(
          () => undefined,
        );
        continue;
      }
      const action = context.actions.find((candidate) => candidate.id === edge.actionId);
      if (!action || this.safety.evaluate(action).verdict === 'BLOCK') return undefined;
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
   * Closes what is in front of the screen (date picker, menu, dialog) with
   * Escape, else with its "Close"/"Fermer" button when it is SAFE. Returns
   * whether something was in front.
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
    // Escape closed it: done. Otherwise, its "Close" button.
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
      // A redirect started by the page itself (auth guard…) is not a failure.
      if (!/interrupted by another navigation to/i.test(message) || /chrome-error:/i.test(message)) {
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
    if (!relogged && this.onLoginPage(page) && !this.isLoginUrl(url)) {
      // Sent to the login page: the session expired. Log in again (bounded), then go there again.
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

  // ---------------------------------------------------------------- helpers

  private limitReached(): StopReason | undefined {
    const { exploration } = this.config;
    if (this.graph.nodeCount >= exploration.maxStates) return 'max-states';
    if (this.actionsExecuted >= exploration.maxActions) return 'max-actions';
    if (Date.now() - this.startedAt.getTime() >= exploration.maxDurationMinutes * 60_000)
      return 'max-duration';
    return undefined;
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
      // Browser interactions disabled: dialogs are dismissed and new windows closed, nothing is recorded.
      page.on('dialog', (dialog) => {
        void dialog.dismiss().catch(() => undefined);
      });
      page.on('popup', (popup) => {
        void popup.close().catch(() => undefined);
      });
      for (const observer of observers) observer.attach(page);
      return page;
    }
    const page = await this.browserEvents.openOwnPage(() => browser.newPage());
    page.setDefaultTimeout(this.config.exploration.actionTimeoutMs);
    // Dialogs, downloads, file choosers, the native sign-in dialog…: BrowserEventDiscovery → BrowserInteractionManager.
    await this.browserEvents.attachPage(page);
    for (const observer of observers) observer.attach(page);
    return page;
  }

  // ---------------------------------------------------------------- browser interactions

  /** auth.type: http — the recorded HTTP_AUTH interaction tells whether the login worked. */
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

  /** Every interaction result: flow graph (persisted without secrets), popup transitions, issues, listener. */
  private onInteractionResult(result: BrowserInteractionResult): void {
    this.graph.recordInteraction(result);
    if (result.targetStateId && result.stateId && (result.type === 'POPUP' || result.type === 'NEW_TAB')) {
      // CLICK "Voir le document" → POPUP → new page: the relation stays in the flow graph.
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

  /** A popup / new tab on an allowed origin becomes a state of the graph (a crawl context reachable by URL). */
  private async inspectNewPage(page: Page): Promise<string | undefined> {
    if (!/^https?:/.test(page.url())) return undefined;
    const snapshot = await this.observer.observe(page);
    const state = this.stateDetector.detect(snapshot);
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

  /** Replaces a crashed page or one stuck on an error page (pending error navigation). */
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
    };
  }

  // ---------------------------------------------------------------- verify

  /**
   * VERIFY: every transition the baseline learned is replayed — its start
   * state is reached again (by its URL, else by the known path from the
   * start), its action executed, and the state reached compared with the
   * one the baseline recorded. The observations build the current graph,
   * compared with the baseline afterwards (FlowDiffEngine).
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
    // Autonomous transitions only: imposed flows run anyway, filled forms and popups are replayed with them.
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

      // Execute and observe, like the exploration: anomalies and network are attributed to the action.
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
        // The baseline's id: the transition is the same one, whatever record it was replayed on.
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
   * The action of a known transition on the current screen: same id, else
   * the same control (type + text) towards the same kind of target — another
   * record (/users/1 learned, /users/2 reached) or another environment
   * (learned on QA, verified on a PR environment).
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

  /** A URL of the baseline, on the target of this run (the baseline may come from another environment). */
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
   * Reaches a state of the baseline: by its own URL first, else by replaying
   * the baseline's path from the start page. Returns the observed context, or
   * why it could not be reached.
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

/** Short, readable, unique enough: base-36 time (e.g. "mg3k2x1a"). */
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

/** Reason of a transition blocked by browser interactions (e.g. "HTTP_AUTH AUTH_REQUIRED: …"). */
/** Buttons that close a layer (dialog, date picker, panel). */
const CLOSE_LABEL =
  /^(close|fermer|close calendar|fermer le calendrier|close dialog|fermer la fen[eê]tre|[×✕✖x])$/i;

/** Name of a form field in reports: its label, the label of its group, else its name. */
function fieldName(action: DiscoveredAction): string {
  const field = action.field;
  const own = field?.label ?? action.label ?? action.text ?? field?.name ?? '?';
  const name = field?.groupLabel && field.choiceGroup !== undefined ? field.groupLabel : own;
  return name.replace(/^\*\s*|\s*\*$/g, ''); // required marker
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
