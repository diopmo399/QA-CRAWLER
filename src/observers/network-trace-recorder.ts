import type { Page, Request, Response } from 'playwright';
import type { ActionNetworkTrace, NetworkExchange } from '../model/network.js';
import { redactUrl } from '../security/redactor.js';
import type { PageObserver } from './observer.js';

export interface NetworkTraceOptions {
  /** Types de ressources gardés (document, xhr, fetch…) ; images, polices et styles n'ajoutent que du bruit. */
  resourceTypes: readonly string[];
  /** Plafond par action (interrogations périodiques, statistiques…). */
  maxRequestsPerAction: number;
}

interface Pending {
  exchange: NetworkExchange;
  startedAt: number;
}

/**
 * Ouvre une fenêtre réseau autour de chaque action : ACTION → RÉSEAU → ÉTAT.
 * L'explorateur appelle `start(actionId)` juste avant d'exécuter une action et
 * `stop()` une fois l'état suivant observé ; les échanges vus entre les deux sont
 * attachés à la transition (FlowEdge.network).
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

  /** Ouvre la fenêtre d'une action (ferme la précédente si elle est restée ouverte). */
  start(actionId: string): void {
    this.current = { actionId, startedAt: new Date(), pending: new Map(), order: [] };
  }

  /** Ferme la fenêtre ; la trace, si elle appartient à `actionId` (ou à n'importe quelle action quand il est omis). */
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
