import type { Page, Response } from 'playwright';
import { valueDigest } from './value-digest.js';

/**
 * Les valeurs VUES pendant le run, gardées en empreintes seulement :
 *
 * - ResponseValueIndex : les valeurs scalaires des réponses JSON (GET /api/profile →
 *   email) — un champ prérempli dont l'empreinte correspond vient de cette réponse ;
 * - CrawlerValueMemory : ce que le crawler a saisi (ses propres données de test) — une
 *   valeur retrouvée sur un autre écran a été reportée d'une étape précédente.
 *
 * Aucune valeur en clair n'est gardée ; tout reste en mémoire et disparaît avec le run.
 */

export interface ResponseValueMatch {
  /** GET /api/profile (chemin sans paramètres). */
  api: string;
  /** email, address.city */
  property: string;
}

export interface ResponseIndexLimits {
  maxResponses: number;
  maxLeavesPerResponse: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: ResponseIndexLimits = {
  maxResponses: 60,
  maxLeavesPerResponse: 400,
  maxBytes: 512_000,
};

export class ResponseValueIndex {
  private readonly byDigest = new Map<string, ResponseValueMatch[]>();
  private responses = 0;

  constructor(
    private readonly salt: string,
    private readonly limits: ResponseIndexLimits = DEFAULT_LIMITS,
  ) {}

  /** Une réponse JSON : chaque valeur scalaire devient une empreinte → (api, propriété). */
  record(method: string, url: string, body: unknown): void {
    if (this.responses >= this.limits.maxResponses) return;
    this.responses += 1;
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.split('?')[0] ?? url;
    }
    const api = `${method.toUpperCase()} ${path}`;
    let leaves = 0;
    const visit = (value: unknown, property: string, depth: number): void => {
      if (leaves >= this.limits.maxLeavesPerResponse || depth > 6) return;
      if (value === null || value === undefined) return;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const text = String(value);
        if (text.trim() === '' || text.length > 200) return;
        leaves += 1;
        const digest = valueDigest(text, this.salt);
        const matches = this.byDigest.get(digest) ?? [];
        if (!matches.some((match) => match.api === api && match.property === property))
          this.byDigest.set(digest, [...matches, { api, property }].slice(-5));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 20)) visit(item, property, depth + 1);
        return;
      }
      if (typeof value === 'object')
        for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100))
          visit(item, property ? `${property}.${key}` : key, depth + 1);
    };
    visit(body, '', 0);
  }

  lookup(digest: string | undefined): ResponseValueMatch[] {
    return digest ? (this.byDigest.get(digest) ?? []) : [];
  }

  /**
   * Suit les réponses JSON (xhr / fetch) des hôtes autorisés. Les corps sont lus, réduits
   * en empreintes, puis oubliés.
   */
  attach(page: Page, isAllowedUrl: (url: string) => boolean): void {
    page.on('response', (response) => {
      void this.consume(response, isAllowedUrl);
    });
  }

  private async consume(response: Response, isAllowedUrl: (url: string) => boolean): Promise<void> {
    try {
      const type = response.request().resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      if (!response.ok() || !isAllowedUrl(response.url())) return;
      if (!/json/i.test(response.headers()['content-type'] ?? '')) return;
      const length = Number(response.headers()['content-length']);
      if (Number.isFinite(length) && length > this.limits.maxBytes) return;
      const body = await response.body();
      if (body.byteLength > this.limits.maxBytes) return;
      this.record(response.request().method(), response.url(), JSON.parse(body.toString('utf8')) as unknown);
    } catch {
      // Corps illisible, page fermée : rien à indexer.
    }
  }
}

export interface CrawlerValue {
  fieldId: string;
  stateId: string;
  /** Pour comparer une condition de règle (x > 1000) : seulement les données de test du crawler, jamais une donnée lue. */
  value: string;
}

/** Ce que le crawler a saisi (ses données de test à lui), par empreinte. */
export class CrawlerValueMemory {
  private readonly byDigest = new Map<string, CrawlerValue[]>();
  private readonly byField = new Map<string, CrawlerValue>();

  constructor(private readonly salt: string) {}

  record(entry: CrawlerValue): void {
    const digest = valueDigest(entry.value, this.salt);
    this.byDigest.set(digest, [...(this.byDigest.get(digest) ?? []), entry].slice(-10));
    this.byField.set(`${entry.stateId}|${entry.fieldId}`, entry);
  }

  lookup(digest: string | undefined): CrawlerValue[] {
    return digest ? (this.byDigest.get(digest) ?? []) : [];
  }

  /** La valeur que le crawler a mise dans ce champ sur cet écran. */
  filledHere(stateId: string, fieldId: string): CrawlerValue | undefined {
    return this.byField.get(`${stateId}|${fieldId}`);
  }
}
