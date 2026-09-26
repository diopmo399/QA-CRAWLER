import type { Page } from 'playwright';
import type { AuthConfig, FormAuthConfig } from '../config/config.js';

/** Authentication failure. Messages never contain credentials. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Logs the browser context in before the crawl starts; cookies/storage are then shared by every page. */
export interface Authenticator {
  readonly description: string;
  login(page: Page): Promise<void>;
}

class NoAuthenticator implements Authenticator {
  readonly description = 'none';
  async login(): Promise<void> {
    // nothing to do
  }
}

/**
 * Fills a login form with credentials read from environment variables
 * (never from the scenario file) and waits for a success signal.
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

  async login(page: Page): Promise<void> {
    const username = this.env[this.config.usernameEnv];
    const password = this.env[this.config.passwordEnv];
    const missing = [
      username ? undefined : this.config.usernameEnv,
      password ? undefined : this.config.passwordEnv,
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0 || !username || !password) {
      throw new AuthError(`Missing environment variable(s) for authentication: ${missing.join(', ')}`);
    }

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
      // Playwright messages may echo selectors and URLs, never the filled values.
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new AuthError(`Form login failed: ${reason}`);
    }
  }
}

export function createAuthenticator(
  auth: AuthConfig,
  baseUrl: string,
  env?: NodeJS.ProcessEnv,
): Authenticator {
  switch (auth.type) {
    case 'none':
      return new NoAuthenticator();
    case 'form':
      return new FormAuthenticator(auth, baseUrl, env);
  }
}
