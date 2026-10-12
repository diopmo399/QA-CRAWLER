import type { BrowserContextOptions, Page } from 'playwright';
import type { AuthConfig, FormAuthConfig, HttpAuthConfig, SsoAuthConfig } from '../config/config.js';
import { AuthenticationSessionProvider, type SessionReport } from './session-provider.js';

/** Échec d'authentification. Les messages ne contiennent jamais d'identifiants. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Connecte le contexte du navigateur avant l'exploration ; cookies et stockage sont ensuite partagés par toutes les pages. */
export interface Authenticator {
  readonly description: string;
  /** Options du contexte du navigateur, fixées avant l'ouverture de toute page (identifiants HTTP). */
  contextOptions(): BrowserContextOptions;
  login(page: Page): Promise<void>;
  /** Session réutilisable (storageState) : les options à poser avant l'ouverture du contexte. */
  sessionOptions?(): Promise<BrowserContextOptions>;
  /** Le sort de la session (réutilisée, enregistrée, expirée), quand la réutilisation est configurée. */
  sessionReport?(): SessionReport | undefined;
}

/** L'URL est-elle une page de connexion (la nôtre, ou celle d'un fournisseur d'identité) ? */
export function looksLikeLogin(url: string, loginUrls: readonly string[]): boolean {
  return loginUrls.some((candidate) => {
    try {
      const expected = new URL(candidate);
      const actual = new URL(url);
      return (
        actual.origin === expected.origin &&
        (expected.pathname === '/' || actual.pathname.startsWith(expected.pathname))
      );
    } catch {
      return url.includes(candidate);
    }
  });
}

/**
 * SESSION-AWARE AUTHENTICATOR : enveloppe un authentificateur pour réutiliser la session d'un run
 * précédent (auth.session.reuse). Quand la session rechargée est refusée (l'application renvoie
 * vers la connexion), elle est marquée expirée et la connexion normale est faite, puis enregistrée.
 */
export class SessionAwareAuthenticator implements Authenticator {
  readonly description: string;

  constructor(
    private readonly inner: Authenticator,
    private readonly sessions: AuthenticationSessionProvider,
    private readonly startUrl: string,
    /** Les pages qui signalent une session refusée (page de connexion, fournisseur d'identité). */
    private readonly loginUrls: readonly string[],
    private readonly timeoutMs: number,
  ) {
    this.description = `${inner.description}, session ${sessions.file}`;
  }

  contextOptions(): BrowserContextOptions {
    return this.inner.contextOptions();
  }

  sessionOptions(): Promise<BrowserContextOptions> {
    return this.sessions.contextOptions();
  }

  async login(page: Page): Promise<void> {
    if (this.sessions.canReuse) {
      try {
        await page.goto(this.startUrl, { waitUntil: 'load', timeout: this.timeoutMs });
      } catch {
        // la page de départ est rechargée par l'explorateur : la session est jugée sur l'URL atteinte
      }
      if (!looksLikeLogin(page.url(), this.loginUrls)) return;
      this.sessions.markExpired('the application redirected the stored session to the sign-in page');
    }
    await this.inner.login(page);
    await this.sessions.save(page);
  }

  sessionReport(): SessionReport {
    return this.sessions.report();
  }
}

/**
 * SSO / OIDC : la page de départ renvoie vers le fournisseur d'identité ; les identifiants ne sont
 * saisis que sur son origine ; le retour sur l'application marque la réussite.
 */
export class SsoAuthenticator implements Authenticator {
  readonly description: string;

  constructor(
    private readonly config: SsoAuthConfig,
    private readonly baseUrl: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.description = `SSO login via ${config.identityProviderOrigin} (credentials from $${config.usernameEnv} / $${config.passwordEnv})`;
  }

  contextOptions(): BrowserContextOptions {
    return {};
  }

  async login(page: Page): Promise<void> {
    const { username, password } = readCredentials(
      this.env,
      this.config.usernameEnv,
      this.config.passwordEnv,
    );
    const { timeoutMs } = this.config;
    const start = new URL(this.config.startUrl ?? '/', this.baseUrl).toString();
    const appOrigin = new URL(this.baseUrl).origin;
    try {
      await page.goto(start, { waitUntil: 'load', timeout: timeoutMs });
      if (new URL(page.url()).origin !== this.config.identityProviderOrigin)
        await page.waitForURL((url) => url.origin === this.config.identityProviderOrigin, {
          timeout: timeoutMs,
        });
      // Les identifiants ne quittent jamais l'origine du fournisseur d'identité.
      if (new URL(page.url()).origin !== this.config.identityProviderOrigin)
        throw new Error('the identity provider was not reached');
      await page.locator(this.config.usernameSelector).first().fill(username, { timeout: timeoutMs });
      if (this.config.nextSelector)
        await page.locator(this.config.nextSelector).first().click({ timeout: timeoutMs });
      await page.locator(this.config.passwordSelector).first().fill(password, { timeout: timeoutMs });
      await page.locator(this.config.submitSelector).first().click({ timeout: timeoutMs });
      const expected = this.config.successUrlContains;
      await page.waitForURL(
        (url) => (expected ? url.toString().includes(expected) : url.origin === appOrigin),
        { timeout: timeoutMs },
      );
      if (this.config.successSelector)
        await page
          .locator(this.config.successSelector)
          .first()
          .waitFor({ state: 'visible', timeout: timeoutMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new AuthError(`SSO login failed: ${reason}`);
    }
  }
}

class NoAuthenticator implements Authenticator {
  readonly description = 'none';
  contextOptions(): BrowserContextOptions {
    return {};
  }
  async login(): Promise<void> {
    // rien à faire
  }
}

function readCredentials(
  env: NodeJS.ProcessEnv,
  usernameEnv: string,
  passwordEnv: string,
): { username: string; password: string } {
  const username = env[usernameEnv];
  const password = env[passwordEnv];
  const missing = [username ? undefined : usernameEnv, password ? undefined : passwordEnv].filter(
    (name): name is string => name !== undefined,
  );
  if (missing.length > 0 || !username || !password) {
    throw new AuthError(`Missing environment variable(s) for authentication: ${missing.join(', ')}`);
  }
  return { username, password };
}

/**
 * Remplit un formulaire de connexion avec des identifiants lus dans des
 * variables d'environnement (jamais dans le fichier de scénario) et attend un signal de réussite.
 */
export class FormAuthenticator implements Authenticator {
  readonly description: string;

  constructor(
    private readonly config: FormAuthConfig,
    private readonly baseUrl: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.description = `form login at ${config.loginUrl} (credentials from $${config.usernameEnv} / $${config.passwordEnv})`;
  }

  contextOptions(): BrowserContextOptions {
    return {};
  }

  async login(page: Page): Promise<void> {
    const { username, password } = readCredentials(
      this.env,
      this.config.usernameEnv,
      this.config.passwordEnv,
    );

    const { timeoutMs } = this.config;
    const loginUrl = new URL(this.config.loginUrl, this.baseUrl).toString();
    try {
      await page.goto(loginUrl, { waitUntil: 'load', timeout: timeoutMs });
      await page.locator(this.config.usernameSelector).first().fill(username, { timeout: timeoutMs });
      await page.locator(this.config.passwordSelector).first().fill(password, { timeout: timeoutMs });
      await page.locator(this.config.submitSelector).first().click({ timeout: timeoutMs });

      if (this.config.successSelector) {
        await page
          .locator(this.config.successSelector)
          .first()
          .waitFor({ state: 'visible', timeout: timeoutMs });
      }
      if (this.config.successUrlContains) {
        const expected = this.config.successUrlContains;
        await page.waitForURL((url) => url.toString().includes(expected), { timeout: timeoutMs });
      }
      if (!this.config.successSelector && !this.config.successUrlContains) {
        await page.waitForLoadState('load', { timeout: timeoutMs });
      }
    } catch (error) {
      // Les messages de Playwright peuvent reprendre des sélecteurs et des URL, jamais les valeurs saisies.
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new AuthError(`Form login failed: ${reason}`);
    }
  }
}

/**
 * Authentification HTTP : la fenêtre de connexion du navigateur lui-même. Elle
 * reçoit sa réponse du HttpAuthHandler du BrowserInteractionManager (auth.type:
 * http est traduit en profil d'identifiants par le chargeur de configuration) ;
 * cet authentificateur ouvre seulement la page qui déclenche le défi. Le moteur
 * vérifie ensuite l'interaction enregistrée (AUTHENTICATED, AUTH_REQUIRED, AUTH_FAILED…).
 */
export class HttpAuthenticator implements Authenticator {
  readonly description: string;

  constructor(
    private readonly config: HttpAuthConfig,
    private readonly startUrl: string,
  ) {
    this.description = `HTTP authentication${config.origin ? ` for ${config.origin}` : ''} (credentials from $${config.usernameEnv} / $${config.passwordEnv})`;
  }

  contextOptions(): BrowserContextOptions {
    return {};
  }

  async login(page: Page): Promise<void> {
    const checkUrl = new URL(this.config.checkUrl ?? this.startUrl, this.startUrl).toString();
    try {
      await page.goto(checkUrl, { waitUntil: 'load', timeout: this.config.timeoutMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new AuthError(`HTTP authentication failed: ${reason}`);
    }
  }
}

export function createAuthenticator(
  auth: AuthConfig,
  baseUrl: string,
  env?: NodeJS.ProcessEnv,
  startUrl?: string,
  /** Nom de l'acteur : le fichier de session par défaut en dépend. */
  actor = 'primary',
): Authenticator {
  const inner = ((): Authenticator => {
    switch (auth.type) {
      case 'none':
        return new NoAuthenticator();
      case 'form':
        return new FormAuthenticator(auth, baseUrl, env);
      case 'http':
        return new HttpAuthenticator(auth, startUrl ?? baseUrl);
      case 'sso':
        return new SsoAuthenticator(auth, baseUrl, env);
    }
  })();
  if (auth.type === 'none' || !auth.session.reuse) return inner;
  const loginUrls =
    auth.type === 'form'
      ? [new URL(auth.loginUrl, baseUrl).toString()]
      : auth.type === 'sso'
        ? [auth.identityProviderOrigin]
        : [];
  return new SessionAwareAuthenticator(
    inner,
    new AuthenticationSessionProvider(auth.session, actor),
    startUrl ?? baseUrl,
    loginUrls,
    auth.timeoutMs,
  );
}
