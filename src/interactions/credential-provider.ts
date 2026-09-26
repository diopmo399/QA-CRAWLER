import { inspect } from 'node:util';

/** What is being asked for, without any secret: lets a provider choose the right credentials. */
export interface AuthContext {
  type: 'HTTP_AUTH';
  /** Logical profile chosen by the policy (e.g. "qa-default"). */
  profile: string;
  origin?: string;
  realm?: string;
  scheme?: string;
}

/**
 * A username/password pair that cannot leak by accident: JSON.stringify,
 * console.log and template strings only show the profile name.
 */
export class Credentials {
  readonly #username: string;
  readonly #password: string;

  constructor(
    readonly profile: string,
    username: string,
    password: string,
  ) {
    this.#username = username;
    this.#password = password;
  }

  get username(): string {
    return this.#username;
  }

  get password(): string {
    return this.#password;
  }

  toJSON(): { profile: string } {
    return { profile: this.profile };
  }

  toString(): string {
    return `Credentials(${this.profile})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * Source of secrets. The crawler asks, never invents: `undefined` means no
 * authorized credentials, and the interaction is recorded as AUTH_REQUIRED.
 * Implementations can read environment variables (CI secrets, Kubernetes
 * secrets mounted as env), a vault, a secret manager…
 */
export interface CredentialProvider {
  readonly name: string;
  resolve(context: AuthContext): Promise<Credentials | undefined>;
}

/** Names of the environment variables of a profile — never the values. */
export interface EnvironmentProfile {
  usernameEnv: string;
  passwordEnv: string;
}

/** Reads each profile from environment variables (GitHub Secrets, Kubernetes env, .env loaded by the shell…). */
export class EnvironmentCredentialProvider implements CredentialProvider {
  readonly name = 'environment';

  constructor(
    private readonly profiles: Readonly<Record<string, EnvironmentProfile>>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  resolve(context: AuthContext): Promise<Credentials | undefined> {
    const profile = this.profiles[context.profile];
    if (!profile) return Promise.resolve(undefined);
    const username = this.env[profile.usernameEnv];
    const password = this.env[profile.passwordEnv];
    if (!username || !password) return Promise.resolve(undefined);
    return Promise.resolve(new Credentials(context.profile, username, password));
  }

  /** Environment variables a profile needs and that are not set (for clear messages). */
  missingVariables(profileName: string): string[] {
    const profile = this.profiles[profileName];
    if (!profile) return [];
    return [profile.usernameEnv, profile.passwordEnv].filter((name) => !this.env[name]);
  }
}
