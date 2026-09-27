import type { Page, Request, Response } from 'playwright';
import type { ActionNetworkTrace, NetworkExchange } from '../model/network.js';
import { redactUrl } from '../security/redactor.js';
import type { PageObserver } from './observer.js';

export interface NetworkTraceOptions {
  /** Resource types kept (document, xhr, fetch…); images, fonts and styles only add noise. */
  resourceTypes: readonly string[];
  /** Cap per action (polling, analytics…). */
  maxRequestsPerAction: number;
}

interface Pending {
  exchange: NetworkExchange;
  startedAt: number;
}

/**
 * Opens a network window around each action: ACTION → NETWORK → STATE.
 * The explorer calls `start(actionId)` just before executing an action and
 * `stop()` once the next state is observed; the exchanges seen in between
 * are attached to the transition (FlowEdge.network).
 */
export class NetworkTraceRecorder implements PageObserver {
  private current:
    { actionId: string; startedAt: Date; pending: Map<Request, Pending>; order: Pending[] } | undefined;

  private readonly onRequest = (request: Request): void => {
    const window = this.current;
    if (!window || window.order.length >= this.options.maxRequestsPerAction) return;
    if (!this.options.resourceTypes.includes(request.resourceType())) return;
    const pending: Pending = {
      exchange: {
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
      },
      startedAt: Date.now(),
    };
    window.pending.set(request, pending);
    window.order.push(pending);
  };
  private readonly onResponse = (response: Response): void => {
    const pending = this.current?.pending.get(response.request());
    if (pending) pending.exchange.status = response.status();
  };
  private readonly onFinished = (request: Request): void => {
    const pending = this.current?.pending.get(request);
    if (pending) pending.exchange.durationMs = Date.now() - pending.startedAt;
  };
  private readonly onFailed = (request: Request): void => {
    const pending = this.current?.pending.get(request);
    if (!pending) return;
    pending.exchange.durationMs = Date.now() - pending.startedAt;
    pending.exchange.failure = request.failure()?.errorText ?? 'failed';
  };

  constructor(private readonly options: NetworkTraceOptions) {}

  attach(page: Page): void {
    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('requestfinished', this.onFinished);
    page.on('requestfailed', this.onFailed);
  }

  detach(page: Page): void {
    page.off('request', this.onRequest);
    page.off('response', this.onResponse);
    page.off('requestfinished', this.onFinished);
    page.off('requestfailed', this.onFailed);
  }

  /** Opens the window of an action (closes the previous one, if left open). */
  start(actionId: string): void {
    this.current = { actionId, startedAt: new Date(), pending: new Map(), order: [] };
  }

  /** Closes the window; the trace, if it belongs to `actionId` (or to any action when omitted). */
  stop(actionId?: string): ActionNetworkTrace | undefined {
    const window = this.current;
    if (!window || (actionId !== undefined && window.actionId !== actionId)) return undefined;
    this.current = undefined;
    return {
      actionId: window.actionId,
      startedAt: window.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      requests: window.order.map((pending) => ({ ...pending.exchange })),
    };
  }
}
