import type { Page } from 'playwright';
import { IssueCollector } from '../anomaly/issue-collector.js';
import { SeverityRules } from '../anomaly/severity-rules.js';
import { createAuthenticator, type Authenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { ScreenshotService } from '../browser/screenshot-service.js';
import type { ScenarioConfig } from '../config/config.js';
import { DefaultTestDataProvider, type TestDataProvider } from '../data/test-data-provider.js';
import type { ActionDecision, DecisionEngine } from '../decision/decision-engine.js';
import { RuleBasedDecisionEngine } from '../decision/rule-based-decision-engine.js';
import { ActionDiscovery } from '../discovery/action-discovery.js';
import {
  PlaywrightActionExecutor,
  type ActionExecutionResult,
} from '../execution/playwright-action-executor.js';
import { FlowGraph, summaryOf } from '../graph/flow-graph.js';
import type { FlowMemory } from '../memory/flow-memory.js';
import { actionLabel, type DiscoveredAction, type DiscoveredForm } from '../model/discovered-action.js';
import type { StopReason } from '../model/exploration-result.js';
import type { FlowEdge } from '../model/flow.js';
import { isAtLeast, type Issue } from '../model/issue.js';
import type { PageContext } from '../model/page-context.js';
import { StateDetector, stateSubtitle } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
import { ConsoleObserver } from '../observers/console-observer.js';
import { NetworkObserver } from '../observers/network-observer.js';
import type { IssueAttribution, ObservationContext, PageObserver } from '../observers/observer.js';
import { PageErrorObserver } from '../observers/page-error-observer.js';
import { SafetyPolicy } from '../policies/safety-policy.js';
import { redactUrl } from '../security/redactor.js';

/** Progress notifications (CLI output, tests). */
export interface ExplorationListener {
  onAuthenticated?(description: string): void;
  onState?(context: PageContext, isNew: boolean): void;
  onDecision?(context: PageContext, decision: ActionDecision): void;
  onBlocked?(context: PageContext, action: DiscoveredAction, reason: string): void;
  onTransition?(edge: FlowEdge, action: DiscoveredAction): void;
  onBacktrack?(from: string, to: string | undefined, method: string): void;
  onIssue?(issue: Issue, isNew: boolean): void;
}

export interface FlowExplorerOptions {
  memory: FlowMemory;
  decisionEngine?: DecisionEngine;
  testData?: TestDataProvider;
  listener?: ExplorationListener;
  env?: NodeJS.ProcessEnv;
}

/** What the explorer knows after one run; the reporters turn it into files. */
export interface ExplorationOutcome {
  graph: FlowGraph;
  issues: Issue[];
  /** Latest full observation of each state (actions with locators, forms). */
  details: Map<string, { actions: DiscoveredAction[]; forms: DiscoveredForm[] }>;
  stopReason: StopReason;
  startedAt: Date;
  finishedAt: Date;
  actionsExecuted: number;
  backtracks: number;
  decisionEngine: string;
  startUrl: string;
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

  private graph = new FlowGraph();
  private readonly details = new Map<string, { actions: DiscoveredAction[]; forms: DiscoveredForm[] }>();
  private stack: StackEntry[] = [];
  /** States where the engine found nothing left to do. */
  private readonly exhausted = new Set<string>();
  /** States the explorer could not return to. */
  private readonly unreachable = new Set<string>();
  private currentUrl: string;
  private attribution: IssueAttribution = {};
  private actionsExecuted = 0;
  private backtracks = 0;
  private startedAt = new Date();

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
        goals,
        maxDepth: exploration.maxDepth,
        maxStatesPerRoute: exploration.maxStatesPerRoute,
        queryParamMode: exploration.queryParams.mode,
      });
    this.executor = new PlaywrightActionExecutor(exploration.actionTimeoutMs, exploration.settleTimeMs);
    this.testData = options.testData ?? new DefaultTestDataProvider();
    this.screenshots = new ScreenshotService(config.output.screenshotsDir, config.checks.fullPageScreenshots);
    this.authenticator = createAuthenticator(config.auth, config.target.baseUrl, options.env);
    this.listener = options.listener ?? {};
    this.memory = options.memory;
    this.startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
    this.currentUrl = this.startUrl;
    this.collector.onIssue((issue, isNew) => this.listener.onIssue?.(issue, isNew));
  }

  async explore(): Promise<ExplorationOutcome> {
    this.startedAt = new Date();
    if (this.config.memory.resume) this.graph = await this.memory.load();
    if (this.config.checks.screenshots || this.config.checks.screenshotOnError)
      await this.screenshots.prepare();

    const browser = new BrowserManager(this.config.browser);
    const observers = this.createObservers();
    let stopReason: StopReason = 'exhausted';
    try {
      const context = await browser.start();
      // Never follow new windows: the exploration stays in one tab.
      context.on('page', (opened) => {
        void opened
          .opener()
          .then((opener) => (opener ? opened.close() : undefined))
          .catch(() => undefined);
      });
      let page = await this.openPage(browser, observers.all);

      await this.authenticator.login(page);
      if (this.config.auth.type !== 'none') this.listener.onAuthenticated?.(this.authenticator.description);

      if (!(await this.goto(page, this.startUrl))) {
        page = await this.recyclePage(browser, page, observers.all);
        if (!(await this.goto(page, this.startUrl))) {
          return this.outcome('unreachable-start');
        }
      }

      let current = await this.observeState(page, 0);
      this.stack = [{ stateId: current.stateId, url: current.url }];

      for (;;) {
        const limit = this.limitReached();
        if (limit) {
          stopReason = limit;
          break;
        }

        const decision = await this.decisionEngine.decide(current, this.graph);
        this.listener.onDecision?.(current, decision);

        if (decision.decision === 'STOP') {
          stopReason = 'engine-stop';
          break;
        }
        if (decision.decision === 'BACKTRACK') {
          this.exhausted.add(current.stateId);
          const restored = await this.backtrack(page, browser, observers.all);
          page = restored.page;
          if (!restored.context) break; // nothing left anywhere
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
      }
    } finally {
      await browser.close();
    }
    await this.memory.save(this.graph);
    return this.outcome(stopReason);
  }

  // ---------------------------------------------------------------- loop steps

  /** OBSERVE → STATE → DISCOVER → record the node. */
  private async observeState(page: Page, depth: number): Promise<PageContext> {
    const snapshot = await this.observer.observe(page);
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

    if (isNew) this.recordRefusedActions(state.stateId, actions);

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
  ): Promise<{ page: Page; context: PageContext }> {
    const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
    // Anomalies raised from now on are caused by this action; their state is known after observation.
    this.attribution = { actionId: action.id };

    const result = await this.execute(page, from, action);
    this.actionsExecuted += 1;
    const newIssues = (): string[] =>
      this.collector
        .all()
        .filter((issue) => !issuesBefore.has(issue.id))
        .map((issue) => issue.id);

    const leftAllowedHosts = !this.isExplorablePage(page);
    if (result.status === 'FAILED' || leftAllowedHosts || observers.pageErrors.consumeCrash()) {
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
        result: 'FAILED',
        reason:
          result.error ??
          (leftAllowedHosts ? 'left the allowed hosts or the page failed to load' : 'page crashed'),
        durationMs: result.durationMs,
        issueIds: ids,
      });
      this.graph.attachIssues(from.stateId, ids);
      this.listener.onTransition?.(edge, action);
      await this.captureErrorScreenshot(page, from, ids);
      // Come back to where we were, on a fresh page if the current one is broken.
      if (!/^https?:/.test(page.url()) || page.isClosed()) {
        page = await this.recyclePage(browser, page, observers.all);
      }
      const restored = await this.restore(page, from.stateId);
      if (restored) return { page, context: restored };
      const fallback = await this.backtrack(page, browser, observers.all);
      if (fallback.context) return { page: fallback.page, context: fallback.context };
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
      result: 'SUCCESS',
      durationMs: result.durationMs,
      issueIds: ids,
    });
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
  ): Promise<{ page: Page; context?: PageContext }> {
    const from = this.stack[this.stack.length - 1]?.stateId ?? '';
    while (this.stack.length > 1) {
      this.stack.pop();
      const target = this.stack[this.stack.length - 1];
      if (!target || this.exhausted.has(target.stateId) || this.unreachable.has(target.stateId)) continue;
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
    for (const node of this.graph.allNodes()) {
      if (this.exhausted.has(node.id) || this.unreachable.has(node.id)) continue;
      if (this.graph.getUnexploredActions(node.id).length === 0) {
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
   * Brings the page back to a known state, cheapest method first:
   * browser history (goBack), then its URL, then replaying the recorded path
   * from the start state (for states without their own URL: wizard steps,
   * tabs, dialogs). Each attempt is verified by comparing state ids.
   */
  private async restore(page: Page, stateId: string, tryHistory = false): Promise<PageContext | undefined> {
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

    this.attribution = {};
    if (tryHistory) {
      const back = await page
        .goBack({
          waitUntil: this.config.exploration.waitUntil,
          timeout: this.config.exploration.navigationTimeoutMs,
        })
        .catch(() => null);
      if (back !== null) {
        await page.waitForTimeout(this.config.exploration.settleTimeMs).catch(() => undefined);
        const context = await matches('history back');
        if (context) return context;
      }
    }

    if (await this.goto(page, node.url)) {
      const context = await matches('url');
      if (context) return context;
    }

    // Replay the recorded transitions from the start state.
    const path = this.graph.pathTo(stateId);
    if (
      path.length === 0 ||
      !(await this.goto(page, this.graph.getNode(this.graph.rootId ?? '')?.url ?? this.startUrl))
    ) {
      return undefined;
    }
    let context = await this.observeState(page, 0).catch(() => undefined);
    for (const edge of path) {
      if (!context || context.stateId !== edge.from) return undefined;
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

  private async goto(page: Page, url: string): Promise<boolean> {
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
    if (!this.config.goals.detectErrors) return { all: [], pageErrors };
    return {
      all: [new NetworkObserver(observation), new ConsoleObserver(observation), pageErrors],
      pageErrors,
    };
  }

  private async openPage(browser: BrowserManager, observers: PageObserver[]): Promise<Page> {
    const page = await browser.newPage();
    page.setDefaultTimeout(this.config.exploration.actionTimeoutMs);
    // alert/confirm/prompt: always dismissed ("Cancel"), so a confirmation never goes through.
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    for (const observer of observers) observer.attach(page);
    return page;
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
      stopReason,
      startedAt: this.startedAt,
      finishedAt: new Date(),
      actionsExecuted: this.actionsExecuted,
      backtracks: this.backtracks,
      decisionEngine: this.decisionEngine.name,
      startUrl: redactUrl(this.startUrl),
    };
  }
}
