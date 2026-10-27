import {
  ConnectorError,
  type ConnectorDescription,
  type ExtractionContext,
  type SourceConnector,
} from '../connector.js';
import type { ExtractedDocument } from '../document.js';
import { fingerprint } from '../fingerprint.js';
import type { ImportIssue } from '../model.js';
import { storageToBlocks } from './confluence-storage.js';

/**
 * LE CONNECTEUR CONFLUENCE (décision D4) : une page lue par l'API REST officielle, au format
 * « storage », convertie en blocs. Il n'accède qu'à ce que le compte peut lire : les permissions de
 * Confluence s'appliquent, rien n'est contourné.
 *
 *   Cloud         GET {base}/wiki/api/v2/pages/{id}?body-format=storage    courriel + jeton d'API (Basic)
 *   Data Center   GET {base}/rest/api/content/{id}?expand=body.storage,version,space    jeton personnel (Bearer)
 *
 * Les identifiants sont lus dans des variables d'environnement NOMMÉES (QA_*), jamais passés en
 * argument, jamais écrits dans un journal, un lot ou un message d'erreur. Les redirections ne sont pas
 * suivies (l'en-tête d'autorisation ne part jamais vers un autre hôte).
 *
 * VALIDATION : testé contre un serveur simulé qui reproduit les réponses documentées des deux
 * variantes ; pas encore contre un Confluence réel (docs/requirements/AUDIT-ET-CONCEPTION.md, Q2).
 */
export type ConfluenceVariant = 'cloud' | 'datacenter';

export interface ConfluenceInput {
  /** L'adresse du site : https://example.atlassian.net (Cloud) ou https://confluence.example.org (Data Center). */
  baseUrl: string;
  /** L'identifiant de la page, ou son URL (…/pages/123/…, …?pageId=123). */
  page: string;
  /** Défaut : `cloud` pour un hôte *.atlassian.net, `datacenter` sinon. */
  variant?: ConfluenceVariant;
  auth: {
    /** Cloud : la variable qui contient le courriel du compte ; Data Center : facultative (Basic au lieu de Bearer). */
    userEnv?: string;
    /** La variable qui contient le jeton d'API (Cloud) ou le jeton d'accès personnel (Data Center). */
    tokenEnv: string;
  };
  timeoutMs?: number;
  maxBytes?: number;
  /** Réessais après une limitation (429), en respectant Retry-After (borné). */
  maxRetries?: number;
}

const ENV_NAME = /^QA_[A-Z0-9_]+$/;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_MS = 30_000;

export function variantOf(input: Pick<ConfluenceInput, 'baseUrl' | 'variant'>): ConfluenceVariant {
  if (input.variant) return input.variant;
  try {
    return new URL(input.baseUrl).hostname.endsWith('.atlassian.net') ? 'cloud' : 'datacenter';
  } catch {
    return 'datacenter';
  }
}

/** L'identifiant d'une page, à partir de son identifiant ou de son URL. */
export function pageIdOf(page: string): string | undefined {
  const trimmed = page.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const query = url.searchParams.get('pageId');
  if (query && /^\d+$/.test(query)) return query;
  const path = /\/pages\/(\d+)(?:\/|$)/.exec(url.pathname);
  return path?.[1];
}

const loopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

export class ConfluenceConnector implements SourceConnector<ConfluenceInput> {
  readonly kind = 'CONFLUENCE';

  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  describe(): ConnectorDescription {
    return {
      kind: this.kind,
      label: 'Confluence (Cloud, Data Center)',
      formats: [
        'cloud: REST API v2, body-format=storage',
        'datacenter: REST API content, expand=body.storage',
      ],
      maxBytes: DEFAULT_MAX_BYTES,
      capabilities: {
        headings: true,
        lists: true,
        tables: true,
        pages: false,
        versions: true,
        refresh: true,
        ocr: false,
      },
      limits: [
        'one page per import (several pages: one import each)',
        'include and excerpt-include macros are not expanded: the read is marked partial',
        'images and attachments are not read',
        'validated against a simulated server only, not yet against a real Confluence',
      ],
    };
  }

  validate(input: ConfluenceInput, context: ExtractionContext): ImportIssue[] {
    const issues: ImportIssue[] = [];
    const error = (code: string, message: string): void => {
      issues.push({ severity: 'ERROR', code, message });
    };
    let base: URL | undefined;
    try {
      base = new URL(input.baseUrl);
    } catch {
      error('INVALID_INPUT', 'baseUrl is not a URL');
    }
    if (base && base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback(base.hostname)))
      error('INVALID_INPUT', 'baseUrl must use https (http only on this machine)');
    if (base && (base.username || base.password))
      error('INVALID_INPUT', 'baseUrl must not carry credentials');
    if (!pageIdOf(input.page))
      error('INVALID_INPUT', 'page must be a page identifier or a page URL (…/pages/123/… or ?pageId=123)');
    const variant = variantOf(input);
    for (const name of [input.auth.tokenEnv, ...(input.auth.userEnv ? [input.auth.userEnv] : [])]) {
      if (!ENV_NAME.test(name))
        error('INVALID_INPUT', `${name}: credentials are read from QA_* environment variables only`);
      else if (!context.env[name]) error('AUTHENTICATION', `${name} is not defined on the server`);
    }
    if (variant === 'cloud' && !input.auth.userEnv)
      error('INVALID_INPUT', 'Confluence Cloud needs the account email (auth.userEnv) with the API token');
    return issues;
  }

  async extract(input: ConfluenceInput, context: ExtractionContext): Promise<ExtractedDocument> {
    const variant = variantOf(input);
    const pageId = pageIdOf(input.page);
    if (!pageId) throw new ConnectorError('INVALID_INPUT', 'no page identifier');
    const base = input.baseUrl.replace(/\/+$/, '');
    const url =
      variant === 'cloud'
        ? `${base}/wiki/api/v2/pages/${pageId}?body-format=storage`
        : `${base}/rest/api/content/${pageId}?expand=body.storage,version,space`;
    const token = context.env[input.auth.tokenEnv] ?? '';
    const user = input.auth.userEnv ? (context.env[input.auth.userEnv] ?? '') : undefined;
    const authorization =
      user !== undefined ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` : `Bearer ${token}`;
    const body = await this.request(url, authorization, input, context);
    let page: ConfluencePage;
    try {
      page = JSON.parse(body) as ConfluencePage;
    } catch {
      throw new ConnectorError('CORRUPTED', 'the Confluence answer is not JSON');
    }
    const storage = page.body?.storage?.value;
    if (typeof storage !== 'string')
      throw new ConnectorError('CORRUPTED', 'the Confluence answer has no storage body (body.storage.value)');
    const converted = storageToBlocks(storage);
    const host = new URL(base).host;
    const webui = page._links?.webui;
    const linkBase = page._links?.base ?? (variant === 'cloud' ? `${base}/wiki` : base);
    const metadata: Record<string, string> = { variant };
    if (page.space?.key) metadata.space = page.space.key;
    if (page.spaceId) metadata.spaceId = String(page.spaceId);
    const version = page.version?.number;
    const modifiedAt = page.version?.createdAt ?? page.version?.when;
    return {
      source: {
        kind: this.kind,
        sourceId: `confluence:${host}:${pageId}`,
        title: page.title ?? `page ${pageId}`,
        ...(webui ? { uri: `${linkBase}${webui}` } : {}),
        ...(version !== undefined ? { version: String(version) } : {}),
        ...(modifiedAt ? { modifiedAt } : {}),
        documentFingerprint: fingerprint(storage),
      },
      blocks: converted.blocks,
      metadata,
      links: converted.links,
      issues: converted.issues,
      completeness: converted.blocks.length === 0 ? 'EMPTY' : converted.partial ? 'PARTIAL' : 'COMPLETE',
    };
  }

  private async request(
    url: string,
    authorization: string,
    input: ConfluenceInput,
    context: ExtractionContext,
  ): Promise<string> {
    const retries = Math.max(0, input.maxRetries ?? 3);
    for (let attempt = 0; ; attempt += 1) {
      if (context.signal?.aborted) throw new ConnectorError('CANCELLED', 'import cancelled');
      const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: { authorization, accept: 'application/json' },
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (context.signal?.aborted) throw new ConnectorError('CANCELLED', 'import cancelled');
        if (timeout.aborted)
          throw new ConnectorError(
            'TIMEOUT',
            `Confluence did not answer within ${String(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)} ms`,
          );
        throw new ConnectorError(
          'NETWORK',
          `Confluence unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 429 && attempt < retries) {
        const wait = Math.min(
          MAX_RETRY_WAIT_MS,
          Math.max(0, Number(response.headers.get('retry-after') ?? '1') * 1000),
        );
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (response.ok) return readLimited(response, input.maxBytes ?? DEFAULT_MAX_BYTES);
      await response.body?.cancel();
      throw statusError(response.status, response.headers.get('location'));
    }
  }
}

function statusError(status: number, location: string | null): ConnectorError {
  if (status >= 300 && status < 400)
    return new ConnectorError(
      'UNSUPPORTED',
      `Confluence redirected the request${location ? ` to ${new URL(location, 'http://x').pathname}` : ''}: not followed (check baseUrl and the variant)`,
    );
  if (status === 401) return new ConnectorError('AUTHENTICATION', 'Confluence refused the credentials (401)');
  if (status === 403) return new ConnectorError('PERMISSION', 'this account may not read the page (403)');
  if (status === 404)
    return new ConnectorError('NOT_FOUND', 'page not found, or not visible to this account (404)');
  if (status === 429)
    return new ConnectorError('RATE_LIMITED', 'Confluence limits the requests (429): retry later');
  return new ConnectorError('NETWORK', `Confluence answered ${String(status)}`);
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ConnectorError('TOO_LARGE', `the page is larger than ${String(maxBytes)} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ConnectorError('TOO_LARGE', `the page is larger than ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Les champs lus dans la réponse (Cloud v2 et Data Center), rien d'autre. */
interface ConfluencePage {
  id?: string;
  title?: string;
  spaceId?: string | number;
  space?: { key?: string };
  version?: { number?: number; createdAt?: string; when?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}
