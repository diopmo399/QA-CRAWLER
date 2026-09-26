import type { Page, Request, Response } from 'playwright';
import { SeverityRules } from '../anomaly/severity-rules.js';
import type { ObservationContext, PageObserver } from './observer.js';

/**
 * Reports HTTP responses with status >= http.failOnStatus and failed
 * requests. Only URL, method and status are kept — never headers, cookies
 * or bodies. The main document of a visited page is handled by the crawl
 * engine (as a broken link), not here.
 */
export class NetworkObserver implements PageObserver {
  private readonly onResponse = (response: Response): void => {
    this.handleResponse(response);
  };
  private readonly onRequestFailed = (request: Request): void => {
    this.handleRequestFailed(request);
  };

  constructor(private readonly context: ObservationContext) {}

  attach(page: Page): void {
    page.on('response', this.onResponse);
    page.on('requestfailed', this.onRequestFailed);
  }

  detach(page: Page): void {
    page.off('response', this.onResponse);
    page.off('requestfailed', this.onRequestFailed);
  }

  private handleResponse(response: Response): void {
    const { config, collector } = this.context;
    if (!config.checks.httpErrors) return;
    const request = response.request();
    if (isMainFrameNavigation(request)) return;

    const status = response.status();
    if (status < config.http.failOnStatus || config.http.ignoreStatus.includes(status)) return;
    if (this.isIgnoredUrl(request.url())) return;

    collector.add({
      type: 'HTTP',
      severity: SeverityRules.httpResponse(status),
      message:
        `${request.method()} ${stripQuery(request.url())} -> ${status} ${response.statusText()}`.trim(),
      pageUrl: this.context.currentPageUrl(),
      requestUrl: request.url(),
      method: request.method(),
      status,
    });
  }

  private handleRequestFailed(request: Request): void {
    const { config, collector } = this.context;
    if (!config.checks.requestFailures) return;
    if (isMainFrameNavigation(request)) return;
    const failure = request.failure()?.errorText ?? 'unknown error';
    // Aborted requests are normal: navigation away, cancelled XHR, lazy images.
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
    if (this.isIgnoredUrl(request.url())) return;

    collector.add({
      type: 'REQUEST_FAILED',
      severity: SeverityRules.requestFailed(request.resourceType() === 'document'),
      message: `${request.method()} ${stripQuery(request.url())} failed: ${failure}`,
      pageUrl: this.context.currentPageUrl(),
      requestUrl: request.url(),
      method: request.method(),
    });
  }

  private isIgnoredUrl(url: string): boolean {
    return this.context.config.http.ignoreUrlPatterns.some((pattern) => url.includes(pattern));
  }
}

function isMainFrameNavigation(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    // frame() throws for service worker requests
    return false;
  }
}

function stripQuery(url: string): string {
  const index = url.search(/[?#]/);
  return index >= 0 ? url.slice(0, index) : url;
}
