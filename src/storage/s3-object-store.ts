import { createHash, createHmac } from 'node:crypto';
import { assertObjectKey, type ObjectStore } from './object-store.js';

/** Les identifiants S3, toujours lus dans l'environnement (jamais dans un fichier de configuration). */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Identifiants temporaires (STS, rôle) : le jeton de session. */
  sessionToken?: string;
}

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  /**
   * Un point d'accès compatible S3 (MinIO, Ceph, stockage objet d'un nuage privé) : https://minio.interne:9000.
   * Absent : AWS S3 dans `region`.
   */
  endpoint?: string;
  /** Adressage par chemin (https://hôte/bucket/clé) ; par défaut avec un `endpoint`, sinon par sous-domaine. */
  pathStyle?: boolean;
  /** Préfixe de toutes les clés (« qa-crawler/ »). */
  prefix?: string;
  credentials: S3Credentials;
  timeoutMs?: number;
  /** Remplaçable pour les tests. */
  fetch?: typeof fetch;
  /** Remplaçable pour les tests (signature déterministe). */
  now?: () => Date;
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** Encodage RFC 3986 des segments d'URL, tel que l'exige la signature v4 (S3 n'encode pas deux fois). */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SigV4Request {
  method: string;
  url: URL;
  /** Les en-têtes à signer (le Host est déduit de l'URL). */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  credentials: S3Credentials;
  date: Date;
}

/**
 * Signature AWS Signature Version 4 : renvoie les en-têtes à ajouter à la requête (x-amz-date,
 * x-amz-content-sha256, jeton de session, Authorization). Vérifiée sur les exemples publiés par AWS
 * (tests/unit/storage-object-stores.test.ts).
 */
export function signV4(request: SigV4Request): Record<string, string> {
  const amzDate = request.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: request.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
    ...(request.credentials.sessionToken ? { 'x-amz-security-token': request.credentials.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalUri =
    request.url.pathname
      .split('/')
      .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
      .join('/') || '/';
  const query = [...request.url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    request.method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join('\n');
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${request.credentials.secretAccessKey}`, day), request.region), request.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const added: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (request.credentials.sessionToken) added['x-amz-security-token'] = request.credentials.sessionToken;
  return added;
}

/** S3 et les stockages compatibles (MinIO…), par requêtes HTTP signées (v4), sans SDK. */
export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const;
  private readonly options: S3ObjectStoreOptions;
  private readonly base: URL;
  private readonly pathStyle: boolean;

  constructor(options: S3ObjectStoreOptions) {
    if (!options.bucket) throw new Error('the S3 bucket is missing');
    if (!options.region) throw new Error('the S3 region is missing');
    this.options = options;
    this.pathStyle = options.pathStyle ?? options.endpoint !== undefined;
    const endpoint = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
      throw new Error('the S3 endpoint must be http(s)');
    this.base = this.pathStyle
      ? new URL(`${endpoint.origin}/${encodeRfc3986(options.bucket)}/`)
      : new URL(`${endpoint.protocol}//${options.bucket}.${endpoint.host}/`);
  }

  describe(): string {
    return `s3://${this.options.bucket}/${this.options.prefix ?? ''} (${this.base.origin})`;
  }

  private url(key?: string): URL {
    if (key === undefined) return new URL(this.base.href.replace(/\/$/, this.pathStyle ? '' : '/'));
    const full = `${this.options.prefix ?? ''}${key}`;
    assertObjectKey(full);
    return new URL(full.split('/').map(encodeRfc3986).join('/'), this.base);
  }

  private async send(
    method: string,
    url: URL,
    body?: Buffer,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const payloadHash = body ? createHash('sha256').update(body).digest('hex') : EMPTY_SHA256;
    const signed = signV4({
      method,
      url,
      headers: {},
      payloadHash,
      region: this.options.region,
      service: 's3',
      credentials: this.options.credentials,
      date: this.options.now?.() ?? new Date(),
    });
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(url, {
      method,
      headers: { ...extra, ...signed },
      ...(body ? { body: Uint8Array.from(body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
  }

  private async failure(action: string, response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    return new Error(`S3 ${action} failed: HTTP ${String(response.status)}${code ? ` ${code}` : ''}`);
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const response = await this.send('PUT', this.url(key), body, { 'content-type': contentType });
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
    const response = await this.send('HEAD', this.url());
    if (!response.ok) throw await this.failure(`bucket ${this.options.bucket}`, response);
  }
}
