import { sanitizeText } from '../../persistence/sanitize.js';
import {
  loadCopilotSdk,
  type CopilotClientLike,
  type CopilotModelInfo,
  type CopilotSdkModule,
  type CopilotSessionConfig,
  type CopilotSessionLike,
} from './sdk.js';

export interface CopilotClientManagerOptions {
  /** Dossier de données du runtime Copilot (sessions, état) : propre à QA-Crawler, hors du dépôt. */
  baseDirectory: string;
  /** Nom de la variable d'environnement qui porte un jeton (jamais sa valeur dans la configuration). */
  tokenEnv?: string;
  env: NodeJS.ProcessEnv;
  /** Le chargement du SDK (remplaçable par les tests). */
  loadSdk?: () => Promise<CopilotSdkModule>;
  /** Délai maximal de démarrage et de vérification d'authentification. */
  startTimeoutMs: number;
}

/**
 * COPILOT CLIENT MANAGER (§14) : le cycle de vie du client, PARESSEUX et isolé.
 *
 * - rien n'est chargé ni démarré avant le premier besoin (jamais en mode OFF) ;
 * - mode `empty` du SDK : aucun outil ambiant, aucune instruction ni configuration découverte ;
 * - authentification par les mécanismes officiels du SDK : l'utilisateur déjà connecté, ou un
 *   jeton lu dans la variable nommée par `tokenEnv` — jamais écrit, jamais journalisé, jamais
 *   envoyé au modèle ;
 * - une erreur (SDK absent, runtime introuvable, non authentifié) rend le fournisseur
 *   « indisponible » avec une raison lisible ; elle ne fait jamais planter le crawler.
 */
export class CopilotClientManager {
  private client: CopilotClientLike | undefined;
  private starting: Promise<CopilotClientLike> | undefined;
  private session: CopilotSessionLike | undefined;
  private models: CopilotModelInfo[] | undefined;
  private reason: string | undefined;
  /** Combien de clients ont été créés (0 en mode OFF : vérifié par les tests). */
  clientsCreated = 0;

  constructor(private readonly options: CopilotClientManagerOptions) {}

  get unavailableReason(): string | undefined {
    return this.reason;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.ensureStarted();
      const auth = await withTimeout(
        client.getAuthStatus(),
        this.options.startTimeoutMs,
        'authentication check',
      );
      if (!auth.isAuthenticated) {
        this.reason =
          'not authenticated with GitHub Copilot (sign in, or set the token variable named by ai.copilot.tokenEnv)';
        return false;
      }
      return true;
    } catch (error) {
      this.reason = describe(error);
      return false;
    }
  }

  /** Les modèles disponibles (mécanisme officiel du SDK), mis en cache pour le run. */
  async listModels(): Promise<CopilotModelInfo[]> {
    if (this.models) return this.models;
    const client = await this.ensureStarted();
    this.models = await client.listModels().catch(() => []);
    return this.models;
  }

  /** Une session : réutilisée si demandé, sinon une nouvelle à chaque fois. */
  async sessionFor(
    config: CopilotSessionConfig,
    reuse: boolean,
  ): Promise<{ session: CopilotSessionLike; created: boolean }> {
    if (reuse && this.session) return { session: this.session, created: false };
    const client = await this.ensureStarted();
    const session = await client.createSession(config);
    if (reuse) this.session = session;
    return { session, created: true };
  }

  async release(session: CopilotSessionLike): Promise<void> {
    if (session === this.session) return;
    await session.disconnect().catch(() => undefined);
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.disconnect().catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    await client?.stop().catch(() => undefined);
  }

  private ensureStarted(): Promise<CopilotClientLike> {
    if (this.client) return Promise.resolve(this.client);
    this.starting ??= (async () => {
      const sdk = await (this.options.loadSdk ?? loadCopilotSdk)();
      const token = this.options.tokenEnv ? this.options.env[this.options.tokenEnv]?.trim() : undefined;
      const client = new sdk.CopilotClient({
        mode: 'empty',
        baseDirectory: this.options.baseDirectory,
        logLevel: 'error',
        ...(token ? { gitHubToken: token, useLoggedInUser: false } : { useLoggedInUser: true }),
      });
      this.clientsCreated += 1;
      await withTimeout(client.start(), this.options.startTimeoutMs, 'runtime start');
      this.client = client;
      return client;
    })();
    return this.starting.catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message))
    return '@github/copilot-sdk is not installed (optional dependency)';
  // Jamais de jeton dans une raison d'indisponibilité.
  return sanitizeText(message)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '[REDACTED]')
    .slice(0, 200);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} timed out after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
