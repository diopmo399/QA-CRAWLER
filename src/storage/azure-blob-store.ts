import { createHmac } from 'node:crypto';
import { assertObjectKey, type ObjectStore } from './object-store.js';
import { encodeRfc3986 } from './s3-object-store.js';

/** L'accès au conteneur : un jeton SAS, ou le nom et la clé du compte (Shared Key). Lus dans l'environnement. */
export type AzureBlobAuth = { sas: string } | { accountName: string; accountKey: string };

export interface AzureBlobStoreOptions {
  /**
   * L'adresse du service Blob : https://<compte>.blob.core.windows.net, ou un émulateur
   * (Azurite : http://127.0.0.1:10000/devstoreaccount1).
   */
  accountUrl: string;
  container: string;
  /** Préfixe de toutes les clés (« qa-crawler/ »). */
  prefix?: string;
  auth: AzureBlobAuth;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const API_VERSION = '2021-08-06';

/**
 * La signature Shared Key du service Blob : la chaîne canonique (verbe, en-têtes standard, en-têtes x-ms-*,
 * ressource) signée en HMAC-SHA256 avec la clé du compte. Le chemin de la ressource contient le nom du compte,
 * deux fois avec l'émulateur (adressage par chemin).
 */
export function sharedKeyAuthorization(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  accountName: string;
  accountKey: string;
}): string {
  const header = (name: string): string => {
    const value = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
    return name === 'content-length' && value === '0' ? '' : value;
  };
  const msHeaders = Object.entries(input.headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .filter(([key]) => key.startsWith('x-ms-'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
  const params = new Map<string, string[]>();
  for (const [key, value] of input.url.searchParams.entries()) {
    const name = key.toLowerCase();
    params.set(name, [...(params.get(name) ?? []), value]);
  }
  const resource =
    `/${input.accountName}${input.url.pathname}` +
    [...params.keys()]
      .sort()
      .map((name) => `\n${name}:${(params.get(name) ?? []).sort().join(',')}`)
      .join('');
  const stringToSign = [
    input.method,
    header('content-encoding'),
    header('content-language'),
    header('content-length'),
    header('content-md5'),
    header('content-type'),
    header('date'),
    header('if-modified-since'),
    header('if-match'),
    header('if-none-match'),
    header('if-unmodified-since'),
    header('range'),
    `${msHeaders}${resource}`,
  ].join('\n');
  const signature = createHmac('sha256', Buffer.from(input.accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return `SharedKey ${input.accountName}:${signature}`;
}

/** Azure Blob Storage (blobs de bloc), par requêtes HTTP, sans SDK. */
export class AzureBlobStore implements ObjectStore {
  readonly kind = 'azure-blob' as const;
  private readonly options: AzureBlobStoreOptions;
  private readonly base: string;

  constructor(options: AzureBlobStoreOptions) {
    if (!options.container) throw new Error('the Azure Blob container is missing');
    const url = new URL(options.accountUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('the Azure Blob account URL must be http(s)');
    this.options = options;
    this.base = `${url.origin}${url.pathname.replace(/\/$/, '')}/${encodeRfc3986(options.container)}`;
  }

  describe(): string {
    return `${this.base}/${this.options.prefix ?? ''}`;
  }

  private url(key?: string, query = ''): URL {
    let href = this.base;
    if (key !== undefined) {
      const full = `${this.options.prefix ?? ''}${key}`;
      assertObjectKey(full);
      href += `/${full.split('/').map(encodeRfc3986).join('/')}`;
    }
    const auth = this.options.auth;
    const sas = 'sas' in auth ? auth.sas.replace(/^\?/, '') : '';
    const parts = [query, sas].filter((part) => part !== '').join('&');
    return new URL(parts ? `${href}?${parts}` : href);
  }

  private async send(
    method: string,
    url: URL,
    body?: Buffer,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'x-ms-date': (this.options.now?.() ?? new Date()).toUTCString(),
      'x-ms-version': API_VERSION,
      ...extra,
      ...(body ? { 'content-length': String(body.length) } : {}),
    };
    const auth = this.options.auth;
    if (!('sas' in auth))
      headers.authorization = sharedKeyAuthorization({
        method,
        url,
        headers,
        accountName: auth.accountName,
        accountKey: auth.accountKey,
      });
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(url, {
      method,
      headers,
      ...(body ? { body: Uint8Array.from(body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
  }

  private async failure(action: string, response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    const code = response.headers.get('x-ms-error-code') ?? /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    return new Error(`Azure Blob ${action} failed: HTTP ${String(response.status)}${code ? ` ${code}` : ''}`);
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const response = await this.send('PUT', this.url(key), body, {
      'content-type': contentType,
      'x-ms-blob-type': 'BlockBlob',
    });
    if (!response.ok) throw await this.failure('PUT', response);
    await response.arrayBuffer();
  }

  async get(key: string): Promise<Buffer | undefined> {
    const response = await this.send('GET', this.url(key));
    if (response.status === 404) {
      await response.arrayBuffer();
      return undefined;
    }
    if (!response.ok) throw await this.failure('GET', response);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.url(key));
    if (!response.ok && response.status !== 404) throw await this.failure('DELETE', response);
    await response.arrayBuffer();
  }

  async healthCheck(): Promise<void> {
    const response = await this.send('GET', this.url(undefined, 'restype=container'));
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw await this.failure(`container ${this.options.container}`, response);
  }
}
