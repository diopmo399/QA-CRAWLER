import { createHash, randomBytes } from 'node:crypto';
import { assertObjectKey, type ObjectStore } from './object-store.js';

/**
 * L'accès au dépôt : un jeton d'accès (Authorization: Bearer), ou un utilisateur et son mot de passe
 * (ou sa clé d'identité) en Basic. Toujours lus dans l'environnement.
 */
export type ArtifactoryAuth = { token: string } | { username: string; password: string };

export interface ArtifactoryStoreOptions {
  /** L'adresse d'Artifactory, contexte compris : https://artifactory.example.test/artifactory */
  url: string;
  /** La clé d'un dépôt local GÉNÉRIQUE (« qa-crawler-objects »). */
  repository: string;
  /** Préfixe de toutes les clés (« qa-crawler/ »). */
  prefix?: string;
  auth: ArtifactoryAuth;
  timeoutMs?: number;
  /** Remplaçable pour les tests. */
  fetch?: typeof fetch;
}

/**
 * JFrog Artifactory comme stockage objet : un dépôt local générique, par l'API REST de déploiement
 * (PUT avec empreintes SHA-1 et SHA-256, qu'Artifactory vérifie), de téléchargement (GET) et de
 * suppression (DELETE). Il faut les droits Lire, Déployer et Supprimer sur le dépôt : le contrôle au
 * démarrage les vérifie tous les trois.
 */
export class ArtifactoryStore implements ObjectStore {
  readonly kind = 'artifactory' as const;
  private readonly options: ArtifactoryStoreOptions;
  private readonly base: string;

  constructor(options: ArtifactoryStoreOptions) {
    if (!options.repository || !/^[A-Za-z0-9._-]{1,64}$/.test(options.repository))
      throw new Error('the Artifactory repository key is missing or invalid');
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('the Artifactory URL must be http(s)');
    this.options = options;
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  describe(): string {
    return `${this.base}/${this.options.repository}/${this.options.prefix ?? ''}`;
  }

  private path(key: string): string {
    const full = `${this.options.prefix ?? ''}${key}`;
    assertObjectKey(full);
    return full.split('/').map(encodeURIComponent).join('/');
  }

  private url(key: string): string {
    return `${this.base}/${encodeURIComponent(this.options.repository)}/${this.path(key)}`;
  }

  private authorization(): string {
    const auth = this.options.auth;
    return 'token' in auth
      ? `Bearer ${auth.token}`
      : `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
  }

  private async send(
    method: string,
    url: string,
    body?: Buffer,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(url, {
      method,
      headers: { authorization: this.authorization(), ...extra },
      ...(body ? { body: Uint8Array.from(body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
  }

  /** L'erreur d'Artifactory (`{ errors: [{ status, message }] }`), sans aucun en-tête ni secret. */
  private async failure(action: string, response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { errors?: { message?: unknown }[] };
      const message = parsed.errors?.[0]?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {
      detail = undefined;
    }
    return new Error(
      `Artifactory ${action} failed: HTTP ${String(response.status)}${detail ? ` (${detail})` : ''}`,
    );
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const response = await this.send('PUT', this.url(key), body, {
      'content-type': contentType,
      // Artifactory vérifie les empreintes envoyées : un contenu altéré en route est refusé.
      'x-checksum-sha1': createHash('sha1').update(body).digest('hex'),
      'x-checksum-sha256': createHash('sha256').update(body).digest('hex'),
    });
    if (!response.ok) throw await this.failure('deploy', response);
    await response.arrayBuffer();
  }

  async get(key: string): Promise<Buffer | undefined> {
    const response = await this.send('GET', this.url(key));
    if (response.status === 404) {
      await response.arrayBuffer();
      return undefined;
    }
    if (!response.ok) throw await this.failure('download', response);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.url(key));
    if (!response.ok && response.status !== 404) throw await this.failure('delete', response);
    await response.arrayBuffer();
  }

  /**
   * Le dépôt existe et les trois droits sont accordés : lecture (informations du dépôt), déploiement et
   * suppression (un petit fichier de contrôle, aussitôt retiré). Sans le droit de supprimer, les objets
   * qui ne servent plus ne pourraient jamais être retirés.
   */
  async healthCheck(): Promise<void> {
    const info = await this.send(
      'GET',
      `${this.base}/api/storage/${encodeURIComponent(this.options.repository)}`,
    );
    if (!info.ok) throw await this.failure(`repository ${this.options.repository}`, info);
    await info.arrayBuffer();
    const probe = `.probe/${randomBytes(8).toString('hex')}`;
    await this.put(probe, Buffer.from('ok'), 'text/plain');
    await this.delete(probe);
  }
}
