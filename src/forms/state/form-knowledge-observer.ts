import type { Page, Request, Response } from 'playwright';
import {
  isStateCode,
  isStateKey,
  type ExchangeIdentifier,
  type FieldShape,
  type FunctionalExchange,
  type StateCode,
} from '../../functional/model.js';
import type { NetworkExchange } from '../../model/network.js';
import type { PageObserver } from '../../observers/observer.js';
import { redactUrl } from '../../security/redactor.js';
import { apiOfExchange } from './field-dependencies.js';
import { valueDigest } from './value-digest.js';
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
  /** Fenêtres de l'intelligence fonctionnelle : FORME des corps (clés, types), statut, code d'erreur. */
  private readonly functional = new Map<string, FunctionalExchange[]>();
  private readonly pending = new Map<Request, FunctionalExchange>();
  private readonly reading = new Set<Promise<void>>();

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
    if (this.functional.size > 0 && this.salt !== undefined) {
      const entry: FunctionalExchange = { method: request.method(), path: pathOf(request.url()) };
      const pathId = pathIdentifierOf(entry.path, this.salt);
      if (pathId) entry.identifiers = [pathId];
      if (entry.method !== 'GET' && entry.method !== 'HEAD') {
        const body = parseJson(safePostData(request));
        const fields = shapeOf(body, this.salt);
        if (fields) entry.requestFields = fields;
        const state = stateCodeOf(body);
        if (state) entry.requestState = state;
      }
      this.pending.set(request, entry);
      for (const window of this.functional.values()) if (window.length < 30) window.push(entry);
    }
  };

  private readonly onResponse = (response: Response): void => {
    const entry = this.pending.get(response.request());
    if (!entry) return;
    this.pending.delete(response.request());
    entry.status = response.status();
    const salt = this.salt;
    // L'identifiant d'une création donné par l'en-tête Location (/api/demandes/12345).
    const location = response.headers().location;
    if (salt !== undefined && location && entry.status < 400) {
      const fromLocation = pathIdentifierOf(pathOf(new URL(location, response.url()).href), salt);
      if (fromLocation)
        entry.identifiers = [
          ...(entry.identifiers ?? []),
          { ...fromLocation, field: '(location)', source: 'location' },
        ];
    }
    // Le corps n'est lu que pour sa forme (jamais gardé) ; d'une lecture (GET), seulement le code d'état.
    if (!/json/i.test(response.headers()['content-type'] ?? '')) return;
    const read = response
      .text()
      .then((text) => {
        if (text.length > 1_000_000) return;
        const body = parseJson(text);
        const state = stateCodeOf(body);
        if (state) entry.responseState = state;
        if (entry.method === 'GET' && (entry.status ?? 0) < 400) return;
        if (text.length > 200_000) return;
        const fields = shapeOf(body);
        if (fields) entry.responseFields = fields;
        // L'écriture acceptée : ses identifiants (une création renvoie l'id de l'entité).
        if (salt !== undefined && (entry.status ?? 0) < 400) {
          const found = identifiersOf(body, salt);
          if (found.length > 0) entry.identifiers = [...(entry.identifiers ?? []), ...found];
        }
        const code = errorCodeOf(body);
        if (code && entry.status !== undefined && entry.status >= 400) entry.errorCode = code;
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading.delete(read);
      });
    this.reading.add(read);
  };

  constructor(
    private readonly isAllowedUrl: (url: string) => boolean,
    private readonly responses?: ResponseValueIndex,
    /** Sel du run : une chaîne envoyée n'est gardée qu'en empreinte (comparée aux énumérations du contrat). */
    private readonly salt?: string,
  ) {}

  attach(page: Page): void {
    page.on('request', this.onRequest);
    if (this.salt !== undefined) page.on('response', this.onResponse);
    this.responses?.attach(page, this.isAllowedUrl);
  }

  detach(page: Page): void {
    page.off('request', this.onRequest);
    page.off('response', this.onResponse);
  }

  /** Fenêtre fonctionnelle d'une action (intelligence fonctionnelle activée seulement). */
  startFunctional(id: string): void {
    if (this.salt !== undefined) this.functional.set(id, []);
  }

  /** Ferme la fenêtre, après la lecture des corps de réponse en cours (1 s au plus). */
  async stopFunctional(id: string): Promise<FunctionalExchange[]> {
    if (this.reading.size > 0)
      await Promise.race([
        Promise.all([...this.reading]),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    const window = this.functional.get(id) ?? [];
    this.functional.delete(id);
    // Une réponse lente (après la fermeture de la fenêtre) complète encore l'échange déjà rapporté : seulement borner.
    if (this.functional.size === 0 && this.pending.size > 200) this.pending.clear();
    return window;
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

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function safePostData(request: Request): string | undefined {
  try {
    return request.postData() ?? undefined;
  } catch {
    return undefined;
  }
}

function parseJson(text: string | undefined): unknown {
  if (!text || text.length > 200_000) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * La FORME d'un objet JSON : ses clés de premier niveau et leurs types, jamais les
 * valeurs. Une chaîne courte n'est gardée qu'en empreinte salée (comparée à une
 * énumération du contrat), et seulement quand un sel est donné.
 */
export function shapeOf(body: unknown, salt?: string): Record<string, FieldShape> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const shape: Record<string, FieldShape> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>).slice(0, 60)) {
    if (value === null) shape[key] = { type: 'null' };
    else if (Array.isArray(value)) shape[key] = { type: 'array' };
    else if (typeof value === 'string')
      shape[key] = {
        type: 'string',
        ...(salt !== undefined && value.length <= 64 ? { digest: valueDigest(value, salt) } : {}),
      };
    else if (typeof value === 'number') shape[key] = { type: 'number' };
    else if (typeof value === 'boolean') shape[key] = { type: 'boolean' };
    else if (typeof value === 'object') shape[key] = { type: 'object' };
  }
  return shape;
}

/** Un code d'erreur métier (EMAIL_ALREADY_EXISTS) : un identifiant en capitales, jamais un message libre. */
export function errorCodeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : {};
  for (const candidate of [record.code, record.errorCode, record.error, nested.code])
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(candidate)) return candidate;
  return undefined;
}

/**
 * Le code d'état métier d'un objet JSON (status: 'PENDING') : seulement une clé d'état et
 * une valeur en capitales — un identifiant de l'application, jamais une saisie.
 */
export function stateCodeOf(body: unknown): StateCode | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  for (const [key, value] of Object.entries(body as Record<string, unknown>).slice(0, 80))
    if (isStateKey(key) && isStateCode(value)) return { field: key, code: value };
  return undefined;
}

/** Les clés qui portent un identifiant (id, uuid, reference, numero, demandeId, requestNumber…). */
const IDENTIFIER_KEY = /^(id|uuid|guid|ref|reference|numero|number|no|code|key)$/i;
const IDENTIFIER_SUFFIX = /[a-z](Id|ID|Uuid|Ref|Reference|Number|Numero|No)$/;
/** Jamais un identifiant : un secret, un jeton, une session. */
const SENSITIVE_KEY = /(token|secret|password|pass|pwd|session|auth|otp|cookie|signature|key$)/i;
/** La forme d'un identifiant affichable : nombre, code court (DEM-2026-001), uuid. */
const IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9_\-./#]{0,39}$/;

/**
 * Les identifiants d'un corps JSON : au premier niveau et dans un objet enveloppe (data, result,
 * item, entity, payload). Seules leurs empreintes sont sûres ; la valeur n'est gardée que si elle a
 * la forme d'un identifiant.
 */
export function identifiersOf(body: unknown, salt: string): ExchangeIdentifier[] {
  const found: ExchangeIdentifier[] = [];
  const visit = (value: unknown, prefix: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, field] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      if (prefix === '' && /^(data|result|item|entity|payload|content)$/i.test(key)) visit(field, `${key}.`);
      if (SENSITIVE_KEY.test(key) && !/^(id|key)$/i.test(key)) continue;
      if (!IDENTIFIER_KEY.test(key) && !IDENTIFIER_SUFFIX.test(key)) continue;
      if (typeof field !== 'string' && typeof field !== 'number') continue;
      const text = String(field).trim();
      if (text === '' || text.length > 64) continue;
      found.push({
        field: `${prefix}${key}`,
        digest: valueDigest(text, salt),
        ...(IDENTIFIER_VALUE.test(text) ? { value: text } : {}),
        source: 'response',
      });
      if (found.length >= 8) return;
    }
  };
  visit(body, '');
  return found;
}

/** /api/demandes/12345 → l'identifiant 12345 (le dernier segment numérique, uuid ou code). */
export function pathIdentifierOf(path: string, salt: string): ExchangeIdentifier | undefined {
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (!last || segments.length < 2) return undefined;
  const id =
    /^\d+$/.test(last) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(last) || /^[A-Z]{2,}-[A-Z0-9-]+$/.test(last);
  if (!id) return undefined;
  return { field: '(path)', digest: valueDigest(last, salt), value: last, source: 'path' };
}
