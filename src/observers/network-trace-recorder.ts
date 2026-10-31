import type { Page, Request, Response } from 'playwright';
import type { ActionNetworkTrace, NetworkExchange } from '../model/network.js';
import { REDACTED, redactText, redactUrl } from '../security/redactor.js';
import type { PageObserver } from './observer.js';

export interface NetworkTraceOptions {
  /** Types de ressources gardés (document, xhr, fetch…) ; images, polices et styles n'ajoutent que du bruit. */
  resourceTypes: readonly string[];
  /** Plafond par action (interrogations périodiques, statistiques…). */
  maxRequestsPerAction: number;
  /** network.captureBodies : heure de départ et corps (erreurs, écritures xhr/fetch), masqués et tronqués. */
  captureBodies?: boolean;
}

/** Un échange avec ce que network.captureBodies ajoute (absent sinon). */
export interface CapturedNetworkExchange extends NetworkExchange {
  /** Heure de départ (ISO). */
  startedAt?: string;
  /** Corps de la requête, JSON/texte seulement, masqué et tronqué. */
  requestBody?: string;
  /** Corps de la réponse, JSON/texte seulement, masqué et tronqué. */
  responseBody?: string;
}

/** Ce que network.captureBodies a gardé d'un échange (rien quand l'option est désactivée). */
export function capturedFieldsOf(
  exchange: NetworkExchange,
): Pick<CapturedNetworkExchange, 'startedAt' | 'requestBody' | 'responseBody'> {
  const captured: CapturedNetworkExchange = exchange;
  return {
    ...(captured.startedAt !== undefined ? { startedAt: captured.startedAt } : {}),
    ...(captured.requestBody !== undefined ? { requestBody: captured.requestBody } : {}),
    ...(captured.responseBody !== undefined ? { responseBody: captured.responseBody } : {}),
  };
}

/** Taille maximale d'un corps gardé (8 Kio). */
export const MAX_CAPTURED_BODY = 8 * 1024;
/** Au-delà, le corps n'est pas analysé (JSON) : il est masqué comme du texte puis tronqué. */
const MAX_PARSED_BODY = 256 * 1024;
const SENSITIVE_BODY_KEY =
  /password|passwd|secret|token|authorization|cookie|session|apikey|api_key|credential|private/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** JSON ou texte (le reste — images, binaire, multipart — n'est jamais gardé). */
export function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'application/problem+json' ||
    type === 'application/xml' ||
    type.endsWith('+xml')
  );
}

function maskKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_BODY_KEY.test(key) ? REDACTED : maskKeys(entry),
      ]),
    );
  return typeof value === 'string' ? redactText(value) : value;
}

/**
 * Un corps prêt pour le rapport : clés JSON sensibles masquées (à toute profondeur), paramètres de
 * formulaire sensibles masqués, jetons et secrets du texte masqués, puis tronqué à `max` caractères.
 */
export function redactBody(text: string, contentType?: string, max = MAX_CAPTURED_BODY): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  let result: string | undefined;
  if (text.length <= MAX_PARSED_BODY && (type.includes('json') || /^\s*[[{]/.test(text))) {
    try {
      result = JSON.stringify(maskKeys(JSON.parse(text)));
    } catch {
      // Pas du JSON : masqué comme du texte.
    }
  }
  if (result === undefined && type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(text);
    for (const key of [...new Set(params.keys())])
      if (SENSITIVE_BODY_KEY.test(key)) params.set(key, REDACTED);
    result = params.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  }
  result ??= redactText(text);
  return result.length > max ? `${result.slice(0, max)}…[truncated]` : result;
}

interface Pending {
  exchange: CapturedNetworkExchange;
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
    if (this.options.captureBodies) {
      pending.exchange.startedAt = new Date(pending.startedAt).toISOString();
      if (this.isWrite(request)) this.captureRequestBody(request, pending.exchange);
    }
    window.pending.set(request, pending);
    window.order.push(pending);
  };

  /** Les copies rapportées par stop() : un corps lu plus tard les complète aussi. */
  private readonly reported = new WeakMap<Pending, CapturedNetworkExchange>();

  private isWrite(request: Request): boolean {
    return (
      WRITE_METHODS.has(request.method().toUpperCase()) &&
      (request.resourceType() === 'xhr' || request.resourceType() === 'fetch')
    );
  }

  private captureRequestBody(request: Request, exchange: CapturedNetworkExchange): void {
    if (exchange.requestBody !== undefined) return;
    const body = request.postData();
    if (body === null || body === '') return;
    const type = request.headers()['content-type'];
    // Sans type déclaré, un corps qui ressemble à du JSON est gardé (fetch sans en-tête).
    if (!isTextualContentType(type) && !(type === undefined && /^\s*[[{]/.test(body))) return;
    exchange.requestBody = redactBody(body, type);
  }

  private captureResponseBody(response: Response, pending: Pending): void {
    const request = response.request();
    if (response.status() < 400 && !this.isWrite(request)) return;
    if (response.status() >= 400) this.captureRequestBody(request, pending.exchange);
    const type = response.headers()['content-type'];
    if (!isTextualContentType(type)) return;
    response.text().then(
      (text) => {
        if (text === '') return;
        const body = redactBody(text, type);
        pending.exchange.responseBody = body;
        const copy = this.reported.get(pending);
        if (copy) copy.responseBody = body;
      },
      () => undefined,
    );
  }
  /**
   * Requêtes encore sans réponse quand leur fenêtre s'est fermée (un envoi lent) : leur réponse
   * complète l'échange déjà rapporté, pour qu'une attente `expect.response` la voie arriver.
   */
  private readonly late = new Map<Request, Pending>();

  private pendingOf(request: Request): Pending | undefined {
    return this.current?.pending.get(request) ?? this.late.get(request);
  }

  private readonly onResponse = (response: Response): void => {
    const pending = this.pendingOf(response.request());
    if (!pending) return;
    pending.exchange.status = response.status();
    if (this.options.captureBodies) this.captureResponseBody(response, pending);
  };
  private readonly onFinished = (request: Request): void => {
    const pending = this.pendingOf(request);
    if (pending) pending.exchange.durationMs = Date.now() - pending.startedAt;
    this.late.delete(request);
  };
  private readonly onFailed = (request: Request): void => {
    const pending = this.pendingOf(request);
    this.late.delete(request);
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

  /**
   * L'activité réseau CORRÉLÉE à l'action en cours, sans fermer la fenêtre : les requêtes parties
   * dans les `correlationMs` après l'action (une interrogation périodique plus tardive n'en est pas),
   * et, parmi elles, celles encore en attente depuis moins de `pendingCapMs` (une connexion
   * persistante ne bloque jamais la stabilité). Jamais « networkidle ».
   */
  activity(
    actionId: string,
    options: { correlationMs: number; pendingCapMs: number },
  ): {
    started: number;
    pending: number;
    completed: number;
    lastStarted?: string;
    lastCompleted?: string;
    /** Chaque requête terminée : « MÉTHODE /chemin statut ». */
    completedRequests?: string[];
  } {
    const window = this.current;
    if (window?.actionId !== actionId) return { started: 0, pending: 0, completed: 0 };
    const origin = window.startedAt.getTime();
    const now = Date.now();
    const related = window.order.filter((pending) => pending.startedAt - origin <= options.correlationMs);
    const label = (pending: Pending): string => {
      let path = pending.exchange.url;
      try {
        path = new URL(pending.exchange.url).pathname;
      } catch {
        // URL relative ou masquée : telle quelle.
      }
      return `${pending.exchange.method.toUpperCase()} ${path}${pending.exchange.status !== undefined ? ` ${String(pending.exchange.status)}` : ''}`;
    };
    const done = related.filter(
      (pending) => pending.exchange.status !== undefined || pending.exchange.failure !== undefined,
    );
    const waiting = related.filter(
      (pending) =>
        pending.exchange.status === undefined &&
        pending.exchange.failure === undefined &&
        now - pending.startedAt < options.pendingCapMs,
    );
    const lastStarted = related.at(-1);
    const lastCompleted = done.at(-1);
    return {
      started: related.length,
      pending: waiting.length,
      completed: done.length,
      ...(lastStarted ? { lastStarted: label(lastStarted) } : {}),
      ...(lastCompleted ? { lastCompleted: label(lastCompleted) } : {}),
      ...(done.length > 0 ? { completedRequests: done.map(label) } : {}),
    };
  }

  /** Ferme la fenêtre ; la trace, si elle appartient à `actionId` (ou à n'importe quelle action quand il est omis). */
  stop(actionId?: string): ActionNetworkTrace | undefined {
    const window = this.current;
    if (!window || (actionId !== undefined && window.actionId !== actionId)) return undefined;
    this.current = undefined;
    const requests = window.order.map((pending) => {
      const copy = { ...pending.exchange };
      // Un corps de réponse lu après la fermeture de la fenêtre complète la copie rapportée.
      if (this.options.captureBodies) this.reported.set(pending, copy);
      return copy;
    });
    // Les requêtes encore en cours : leur réponse viendra compléter la copie rapportée.
    for (const [request, pending] of window.pending) {
      const index = window.order.indexOf(pending);
      const copy = requests[index];
      if (!copy || pending.exchange.status !== undefined || pending.exchange.failure !== undefined) continue;
      if (this.late.size >= 200) this.late.clear();
      this.late.set(request, { exchange: copy, startedAt: pending.startedAt });
    }
    return {
      actionId: window.actionId,
      startedAt: window.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      requests,
    };
  }
}
