import type { BrowserContextOptions, Page } from 'playwright';
import type { AuthConfig, FormAuthConfig, HttpAuthConfig } from '../config/config.js';

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
): Authenticator {
  switch (auth.type) {
    case 'none':
      return new NoAuthenticator();
    case 'form':
      return new FormAuthenticator(auth, baseUrl, env);
    case 'http':
      return new HttpAuthenticator(auth, startUrl ?? baseUrl);
  }
}
