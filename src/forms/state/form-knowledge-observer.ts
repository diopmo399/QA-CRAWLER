import type { Page, Request } from 'playwright';
import type { NetworkExchange } from '../../model/network.js';
import type { PageObserver } from '../../observers/observer.js';
import { redactUrl } from '../../security/redactor.js';
import { apiOfExchange } from './field-dependencies.js';
import type { ResponseValueIndex } from './value-sources.js';

/**
 * Ce que l'état des formulaires et les règles ont besoin de voir du réseau, sans
 * dépendre de network.trace : les appels XHR/fetch (GET /api/provinces), une fenêtre
 * pour ce qu'une valeur posée déclenche, et les réponses JSON réduites en empreintes
 * (provenance API_RESPONSE). Seulement les hôtes autorisés ; jamais un en-tête, jamais
 * un corps gardé.
 */
export class FormKnowledgeObserver implements PageObserver {
  /** GET /api/provinces — chemins sans paramètres. */
  readonly apisSeen = new Set<string>();
  private readonly windows = new Map<string, NetworkExchange[]>();

  private readonly onRequest = (request: Request): void => {
    const type = request.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    let allowed = false;
    try {
      allowed = this.isAllowedUrl(request.url());
    } catch {
      allowed = false;
    }
    if (!allowed) return;
    const exchange: NetworkExchange = {
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: type,
    };
    if (this.apisSeen.size < 500) this.apisSeen.add(apiOfExchange(exchange));
    for (const window of this.windows.values()) if (window.length < 50) window.push(exchange);
  };

  constructor(
    private readonly isAllowedUrl: (url: string) => boolean,
    private readonly responses?: ResponseValueIndex,
  ) {}

  attach(page: Page): void {
    page.on('request', this.onRequest);
    this.responses?.attach(page, this.isAllowedUrl);
  }

  detach(page: Page): void {
    page.off('request', this.onRequest);
  }

  start(id: string): void {
    this.windows.set(id, []);
  }

  stop(id: string): NetworkExchange[] {
    const window = this.windows.get(id) ?? [];
    this.windows.delete(id);
    return window;
  }
}
