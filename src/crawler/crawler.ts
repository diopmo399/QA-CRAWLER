import type { Page, Response } from 'playwright';
import { IssueCollector } from '../anomaly/issue-collector.js';
import { SeverityRules } from '../anomaly/severity-rules.js';
import { createAuthenticator, type Authenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { ScreenshotService } from '../browser/screenshot-service.js';
import type { ScenarioConfig } from '../config/config.js';
import { actionKey, type DecisionEngine } from '../decision/decision-engine.js';
import { RuleBasedDecisionEngine } from '../decision/rule-based-decision-engine.js';
import { ActionDiscovery } from '../discovery/action-discovery.js';
import { discoverForms } from '../discovery/form-discovery.js';
import { discoverLinks } from '../discovery/link-discovery.js';
import { ACTION_CLASSIFICATIONS, type ActionClassification } from '../model/discovered-action.js';
import type { CrawlResult, RouteSummary } from '../model/crawl-result.js';
import { ISSUE_TYPES, isAtLeast, type Issue, type IssueType } from '../model/issue.js';
import type { LinkStats, PageResult } from '../model/page-result.js';
import type { ObservationContext, PageObserver } from '../observers/observer.js';
import { ConsoleObserver } from '../observers/console-observer.js';
import { NetworkObserver } from '../observers/network-observer.js';
import { PageErrorObserver } from '../observers/page-error-observer.js';
import { NavigationPolicy, type SkipReason } from '../policies/navigation-policy.js';
import { SafetyPolicy } from '../policies/safety-policy.js';
import { redactUrl } from '../security/redactor.js';
import { ActionExecutor } from './action-executor.js';
import { CrawlQueue, type QueueItem } from './queue.js';
import { routeKey } from './route-normalizer.js';
import { normalizeUrl, resolveUrl, type NormalizeOptions } from './url-normalizer.js';

/** Progress notifications, used by the CLI (and by tests). */
export interface CrawlListener {
  onAuthenticated?(description: string): void;
  onPageStart?(item: QueueItem, sequence: number, queued: number): void;
  onPageDone?(page: PageResult, newIssues: Issue[]): void;
  onIssue?(issue: Issue, isNew: boolean): void;
  onActionExecuted?(pageUrl: string, label: string, outcome: string): void;
}

export interface CrawlEngineOptions {
  listener?: CrawlListener;
  decisionEngine?: DecisionEngine;
  env?: NodeJS.ProcessEnv;
}

/**
 * Breadth-first crawl of a web application:
 *
 *   queue(start URL) → visit → observe (network, console, JS errors)
 *     → discover links/actions/forms → classify (SafetyPolicy)
 *     → optionally execute allowed actions (DecisionEngine) → enqueue new URLs
 *
 * Loop protection: visited set on normalized URLs, maxDepth, maxPages,
 * a per-route budget (/users/:id, ?page=N) and Chromium's redirect limit.
 */
export class CrawlEngine {
  private readonly collector = new IssueCollector();
  private readonly safetyPolicy: SafetyPolicy;
  private readonly navigationPolicy: NavigationPolicy;
  private readonly actionDiscovery: ActionDiscovery;
  private readonly decisionEngine: DecisionEngine;
  private readonly executor: ActionExecutor;
  private readonly screenshots: ScreenshotService;
  private readonly authenticator: Authenticator;
  private readonly queue: CrawlQueue;
  private readonly normalizeOptions: NormalizeOptions;
  private readonly listener: CrawlListener;
  private readonly startUrl: string;

  private currentPageUrl: string;
  private readonly pages: PageResult[] = [];
  private readonly linksSkipped: Record<string, number> = {};
  private actionsExecuted = 0;

  constructor(
    private readonly config: ScenarioConfig,
    options: CrawlEngineOptions = {},
  ) {
    this.safetyPolicy = new SafetyPolicy(config.safety);
    this.navigationPolicy = new NavigationPolicy(config.safety, this.safetyPolicy);
    this.actionDiscovery = new ActionDiscovery(this.safetyPolicy, config.exploration.maxRecordedActions);
    this.decisionEngine =
      options.decisionEngine ??
      new RuleBasedDecisionEngine(this.safetyPolicy, config.exploration.clickSafeActions);
    this.executor = new ActionExecutor(this.safetyPolicy, 5_000, config.exploration.settleTimeMs);
    this.screenshots = new ScreenshotService(config.output.screenshotsDir, config.checks.fullPageScreenshots);
    this.authenticator = createAuthenticator(config.auth, config.target.baseUrl, options.env);
    this.queue = new CrawlQueue(config.exploration.maxUrlsPerRoute);
    this.normalizeOptions = {
      queryParamMode: config.exploration.queryParams.mode,
      ignoredParams: config.exploration.queryParams.ignored,
    };
    this.listener = options.listener ?? {};
    this.startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
    this.currentPageUrl = this.startUrl;
    this.collector.onIssue((issue, isNew) => this.listener.onIssue?.(issue, isNew));
  }

  async run(): Promise<CrawlResult> {
    const startedAt = new Date();
    const browser = new BrowserManager(this.config.browser);
    const observation: ObservationContext = {
      currentPageUrl: () => this.currentPageUrl,
      collector: this.collector,
      config: this.config,
    };
    const pageErrors = new PageErrorObserver(observation);
    const observers: PageObserver[] = [
      new NetworkObserver(observation),
      new ConsoleObserver(observation),
      pageErrors,
    ];

    if (this.config.checks.screenshots || this.config.checks.screenshotOnError) {
      await this.screenshots.prepare();
    }

    try {
      await browser.start();
      let page = await this.openObservedPage(browser, observers);

      await this.authenticator.login(page);
      if (this.config.auth.type !== 'none') this.listener.onAuthenticated?.(this.authenticator.description);

      const start = this.toQueueItem(this.startUrl, 0);
      this.queue.enqueue(start);

      while (this.pages.length < this.config.exploration.maxPages) {
        const item = this.queue.dequeue();
        if (!item) break;
        const sequence = this.pages.length + 1;
        this.listener.onPageStart?.(item, sequence, this.queue.size);

        const issuesBefore = new Set(this.collector.all().map((issue) => issue.id));
        const result = await this.visit(page, item, sequence);
        this.pages.push(result);

        // A crash or a failed navigation leaves the page in an unknown state (pending
        // error-page navigation, dead renderer): continue on a fresh page.
        if (pageErrors.consumeCrash() || result.failed) {
          observers.forEach((observer) => {
            observer.detach(page);
          });
          await page.close().catch(() => undefined);
          page = await this.openObservedPage(browser, observers);
        }
        const newIssues = this.collector.all().filter((issue) => !issuesBefore.has(issue.id));
        this.listener.onPageDone?.(result, newIssues);
      }
    } finally {
      await browser.close();
    }

    const finishedAt = new Date();
    return this.buildResult(startedAt, finishedAt);
  }

  private async openObservedPage(browser: BrowserManager, observers: PageObserver[]): Promise<Page> {
    const page = await browser.newPage();
    page.setDefaultTimeout(this.config.exploration.navigationTimeoutMs);
    observers.forEach((observer) => {
      observer.attach(page);
    });
    return page;
  }

  private async visit(page: Page, item: QueueItem, sequence: number): Promise<PageResult> {
    const { exploration, checks } = this.config;
    this.currentPageUrl = item.url;
    const visitedAt = new Date().toISOString();
    const startTime = Date.now();
    const result: PageResult = {
      sequence,
      url: redactUrl(item.url),
      route: item.route,
      depth: item.depth,
      ...(item.referrerUrl ? { referrerUrl: redactUrl(item.referrerUrl) } : {}),
      loadTimeMs: 0,
      failed: false,
      links: { found: 0, queued: 0, skipped: {} },
      actions: [],
      forms: [],
      issueIds: [],
      visitedAt,
    };

    let response: Response | null = null;
    try {
      response = await page.goto(item.url, {
        waitUntil: exploration.waitUntil,
        timeout: exploration.navigationTimeoutMs,
      });
    } catch (error) {
      if (isClientSideRedirect(error)) {
        // The page redirected itself while loading (e.g. an auth guard): follow it like a redirect.
        await page
          .waitForLoadState(exploration.waitUntil === 'commit' ? 'load' : exploration.waitUntil)
          .catch(() => undefined);
      } else {
        this.recordNavigationFailure(item, result, error);
      }
    }
    result.loadTimeMs = Date.now() - startTime;

    if (!result.failed) {
      if (exploration.settleTimeMs > 0) await page.waitForTimeout(exploration.settleTimeMs);
      await this.inspectLoadedPage(page, item, result, response);
    }

    const pageIssues = this.collector.forPage(item.url);
    const hasSeriousIssue = pageIssues.some((issue) => isAtLeast(issue.severity, 'ERROR'));
    const wantScreenshot = checks.screenshots || (checks.screenshotOnError && hasSeriousIssue);
    // After a failed navigation the browser still shows the previous page: a screenshot would be misleading.
    if (wantScreenshot && !page.isClosed() && this.showsPage(page, item)) {
      const shot = await this.screenshots.capture(
        page,
        sequence,
        item.url,
        hasSeriousIssue ? 'error' : undefined,
      );
      if (shot) result.screenshot = shot;
    }
    for (const issue of pageIssues) {
      if (result.screenshot && !issue.screenshot && isAtLeast(issue.severity, 'ERROR'))
        issue.screenshot = result.screenshot;
    }
    result.issueIds = pageIssues.map((issue) => issue.id);
    return result;
  }

  /** True when the browser displays this item (or the page it redirected to), not a previous page. */
  private showsPage(page: Page, item: QueueItem): boolean {
    const current = resolveUrl(page.url(), item.url);
    if (!current) return false;
    const normalized = normalizeUrl(current, this.normalizeOptions);
    return normalized === item.url || !this.pages.some((visited) => visited.url === redactUrl(normalized));
  }

  private async inspectLoadedPage(
    page: Page,
    item: QueueItem,
    result: PageResult,
    response: Response | null,
  ): Promise<void> {
    const { checks, http, exploration } = this.config;
    const status = response?.status();
    if (status !== undefined) result.status = status;

    if (
      status !== undefined &&
      status >= http.failOnStatus &&
      !http.ignoreStatus.includes(status) &&
      checks.brokenLinks
    ) {
      this.collector.add({
        type: 'BROKEN_LINK',
        severity: SeverityRules.pageResponse(status),
        message: `Page responded ${status}${item.referrerUrl ? ` (linked from ${item.referrerUrl})` : ''}`,
        pageUrl: item.url,
        requestUrl: item.url,
        method: 'GET',
        status,
        ...(item.referrerUrl ? { referrerUrl: item.referrerUrl } : {}),
      });
    }

    // Redirects: remember the final URL and stay on allowed hosts.
    const finalUrl = page.url();
    const finalParsed = resolveUrl(finalUrl, item.url);
    if (finalParsed) {
      const finalNormalized = normalizeUrl(finalParsed, this.normalizeOptions);
      if (finalNormalized !== item.url) {
        result.finalUrl = redactUrl(finalNormalized);
        this.queue.markSeen(finalNormalized);
      }
      if (!this.navigationPolicy.isAllowedHost(finalParsed.hostname)) {
        this.collector.add({
          type: 'NAVIGATION',
          severity: SeverityRules.navigationFailure('external-redirect'),
          message: `Redirected outside allowed hosts to ${finalParsed.origin}; page not explored`,
          pageUrl: item.url,
          requestUrl: finalParsed.toString(),
        });
        return;
      }
    }

    result.title = (await page.title().catch(() => '')) || undefined;
    try {
      const links = await discoverLinks(page, exploration.followRouterLinks);
      result.links = this.enqueueLinks(
        links.map((link) => link.href),
        finalUrl || item.url,
        item.depth,
      );
      result.actions = await this.actionDiscovery.discover(page);
      result.forms = await discoverForms(page);
    } catch (error) {
      // The page navigated away or crashed while being inspected: keep what we have.
      result.error = `Inspection incomplete: ${errorMessage(error)}`;
    }

    await this.runDecisionEngine(page, item, result);
  }

  private enqueueLinks(hrefs: string[], pageUrl: string, depth: number): LinkStats {
    const stats: LinkStats = { found: hrefs.length, queued: 0, skipped: {} };
    const skip = (reason: SkipReason): void => {
      stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
      this.linksSkipped[reason] = (this.linksSkipped[reason] ?? 0) + 1;
    };
    for (const href of hrefs) {
      const outcome = this.tryEnqueue(href, pageUrl, depth + 1);
      if (outcome === 'queued') stats.queued += 1;
      else if (outcome !== 'invalid') skip(outcome);
    }
    return stats;
  }

  private tryEnqueue(href: string, referrer: string, depth: number): 'queued' | 'invalid' | SkipReason {
    const resolved = resolveUrl(href, referrer);
    if (!resolved) return 'invalid';
    const normalized = normalizeUrl(resolved, this.normalizeOptions);
    if (this.queue.hasSeen(normalized)) return 'already-seen';
    const decision = this.navigationPolicy.evaluate(new URL(normalized));
    if (!decision.allowed) return decision.reason;
    if (depth > this.config.exploration.maxDepth) return 'max-depth';
    const refused = this.queue.enqueue(this.toQueueItem(normalized, depth, referrer));
    return refused ?? 'queued';
  }

  private async runDecisionEngine(page: Page, item: QueueItem, result: PageResult): Promise<void> {
    const executed = new Set<string>();
    let budget = this.config.exploration.maxActionsPerPage;
    while (budget > 0) {
      const decision = await this.decisionEngine.nextAction({
        url: redactUrl(item.url),
        route: item.route,
        depth: item.depth,
        ...(result.title ? { title: result.title } : {}),
        actions: result.actions,
        forms: result.forms,
        executedActions: executed,
        remainingBudget: budget,
      });
      if (decision.kind === 'stop') return;
      budget -= 1;
      executed.add(actionKey(decision.action));

      // Every action starts from the page as it was discovered.
      if (normalizeUrl(page.url(), this.normalizeOptions) !== item.url) {
        const back = await page
          .goto(item.url, { waitUntil: this.config.exploration.waitUntil })
          .catch(() => null);
        if (!back) return;
      }
      const outcome = await this.executor.execute(page, decision.action);
      this.currentPageUrl = item.url;
      if (!outcome.executed) {
        this.listener.onActionExecuted?.(item.url, decision.action.text, `skipped: ${outcome.reason}`);
        continue;
      }
      this.actionsExecuted += 1;
      const queued = this.tryEnqueue(outcome.urlAfter, item.url, item.depth + 1);
      this.listener.onActionExecuted?.(
        item.url,
        decision.action.text,
        queued === 'queued' ? `navigated to ${redactUrl(outcome.urlAfter)} (queued)` : 'executed',
      );
    }
  }

  private recordNavigationFailure(item: QueueItem, result: PageResult, error: unknown): void {
    const message = errorMessage(error);
    const kind = /timeout/i.test(message)
      ? 'timeout'
      : /ERR_TOO_MANY_REDIRECTS|redirect/i.test(message)
        ? 'redirect-loop'
        : 'other';
    result.failed = true;
    result.error = message;
    const label = {
      timeout: 'Navigation timeout',
      'redirect-loop': 'Redirect loop',
      other: 'Navigation failed',
    }[kind];
    this.collector.add({
      type: 'NAVIGATION',
      severity: SeverityRules.navigationFailure(kind),
      message: `${label}: ${message}`,
      pageUrl: item.url,
      requestUrl: item.url,
      ...(item.referrerUrl ? { referrerUrl: item.referrerUrl } : {}),
    });
  }

  private toQueueItem(url: string, depth: number, referrerUrl?: string): QueueItem {
    const normalized = normalizeUrl(url, this.normalizeOptions);
    return {
      url: normalized,
      depth,
      route: routeKey(normalized, this.normalizeOptions.queryParamMode),
      ...(referrerUrl ? { referrerUrl } : {}),
    };
  }

  private buildResult(startedAt: Date, finishedAt: Date): CrawlResult {
    const issues = this.collector.all();
    const issuesByType = Object.fromEntries(ISSUE_TYPES.map((type) => [type, 0])) as Record<
      IssueType,
      number
    >;
    for (const issue of issues) issuesByType[issue.type] += 1;
    const actionsByClassification = Object.fromEntries(
      ACTION_CLASSIFICATIONS.map((classification) => [classification, 0]),
    ) as Record<ActionClassification, number>;
    for (const page of this.pages) {
      for (const action of page.actions) actionsByClassification[action.classification] += 1;
    }
    const routes = new Map<string, number>();
    for (const page of this.pages) routes.set(page.route, (routes.get(page.route) ?? 0) + 1);
    const routeSummaries: RouteSummary[] = [...routes.entries()].map(([route, visited]) => ({
      route,
      visited,
    }));

    const { exploration, checks, http, safety, browser, auth, report } = this.config;
    return {
      scenario: this.config.name,
      ...(this.config.description ? { description: this.config.description } : {}),
      target: { baseUrl: redactUrl(this.config.target.baseUrl), startUrl: redactUrl(this.startUrl) },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      pagesVisited: this.pages.length,
      maxPagesReached: this.pages.length >= exploration.maxPages && this.queue.size > 0,
      pendingUrls: this.queue.size,
      stats: {
        pagesVisited: this.pages.length,
        pagesFailed: this.pages.filter((page) => page.failed).length,
        issuesBySeverity: this.collector.countBySeverity(),
        issuesByType,
        actionsByClassification,
        formsFound: this.pages.reduce(
          (total, page) => total + page.forms.filter((form) => form.index >= 0).length,
          0,
        ),
        actionsExecuted: this.actionsExecuted,
        linksSkipped: { ...this.linksSkipped },
      },
      routes: routeSummaries,
      pages: this.pages,
      issues,
      settings: {
        exploration,
        checks,
        http,
        safety: { ...safety },
        browser: { headless: browser.headless, viewport: browser.viewport },
        auth: { type: auth.type },
        decisionEngine: this.decisionEngine.name,
        failOnSeverity: report.failOnSeverity,
      },
      artifacts: {},
    };
  }
}

/** goto() interrupted by a navigation the page started itself (not by Chromium's error page). */
function isClientSideRedirect(error: unknown): boolean {
  const message = errorMessage(error);
  return /interrupted by another navigation to/i.test(message) && !/chrome-error:/i.test(message);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright appends a multi-line call log; the first line is the useful part.
  return (message.split('\n')[0] ?? message).trim();
}
