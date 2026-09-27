import type { Page, Request, Response } from 'playwright';
import { SeverityRules } from '../anomaly/severity-rules.js';
import { attributionOf, type ObservationContext, type PageObserver } from './observer.js';

/**
 * Signale les réponses HTTP de statut >= http.failOnStatus, les requêtes en échec,
 * les pages cassées (document principal >= failOnStatus) et les navigations en échec
 * (boucles de redirection, DNS…). Seuls l'URL, la méthode et le statut sont gardés —
 * jamais les en-têtes, cookies ou corps.
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
    const status = response.status();
    if (isMainFrameNavigation(request)) {
      this.handleDocument(response, status);
      return;
    }

    if (status < config.http.failOnStatus || config.http.ignoreStatus.includes(status)) return;
    if (this.isIgnoredUrl(request.url())) return;

    collector.add({
      type: 'HTTP',
      severity: SeverityRules.httpResponse(status),
      message:
        `${request.method()} ${stripQuery(request.url())} -> ${status} ${response.statusText()}`.trim(),
      pageUrl: this.context.currentPageUrl(),
      ...attributionOf(this.context),
      requestUrl: request.url(),
      method: request.method(),
      status,
    });
  }

  /** Document principal d'un écran atteint par navigation : un statut en échec veut dire une page / un lien cassé. */
  private handleDocument(response: Response, status: number): void {
    const { config, collector } = this.context;
    if (!config.checks.brokenLinks) return;
    if (status < config.http.failOnStatus || config.http.ignoreStatus.includes(status)) return;
    const referrer = this.context.currentPageUrl();
    collector.add({
      type: 'BROKEN_LINK',
      severity: SeverityRules.pageResponse(status),
      message: `Page responded ${status} ${response.statusText()}`.trim(),
      pageUrl: response.url(),
      requestUrl: response.url(),
      method: response.request().method(),
      status,
      ...(referrer !== response.url() ? { referrerUrl: referrer } : {}),
      ...attributionOf(this.context),
    });
  }

  private handleRequestFailed(request: Request): void {
    const { config, collector } = this.context;
    if (!config.checks.requestFailures && !isMainFrameNavigation(request)) return;
    const failure = request.failure()?.errorText ?? 'unknown error';
    if (isMainFrameNavigation(request) && !/ERR_ABORTED|cancelled/i.test(failure)) {
      const loop = /TOO_MANY_REDIRECTS/i.test(failure);
      collector.add({
        type: 'NAVIGATION',
        severity: SeverityRules.navigationFailure(loop ? 'redirect-loop' : 'other'),
        message: `${loop ? 'Redirect loop' : 'Navigation failed'}: ${request.url()} (${failure})`,
        pageUrl: this.context.currentPageUrl(),
        requestUrl: request.url(),
        method: request.method(),
        ...attributionOf(this.context),
      });
      return;
    }
    // Les requêtes annulées sont normales : départ de la page, XHR annulé, images chargées à la demande.
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
    if (this.isIgnoredUrl(request.url())) return;

    collector.add({
      type: 'REQUEST_FAILED',
      severity: SeverityRules.requestFailed(request.resourceType() === 'document'),
      message: `${request.method()} ${stripQuery(request.url())} failed: ${failure}`,
      pageUrl: this.context.currentPageUrl(),
      ...attributionOf(this.context),
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
    // frame() lève une exception pour les requêtes des service workers
    return false;
  }
}

function stripQuery(url: string): string {
  const index = url.search(/[?#]/);
  return index >= 0 ? url.slice(0, index) : url;
}
