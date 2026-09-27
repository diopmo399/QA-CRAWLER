import { inspect } from 'node:util';

/** Ce qui est demandé, sans aucun secret : permet à un fournisseur de choisir les bons identifiants. */
export interface AuthContext {
  type: 'HTTP_AUTH';
  /** Profil logique choisi par la politique (par exemple "qa-default"). */
  profile: string;
  origin?: string;
  realm?: string;
  scheme?: string;
}

/**
 * Une paire identifiant/mot de passe qui ne peut pas fuir par accident :
 * JSON.stringify, console.log et les gabarits de chaîne ne montrent que le nom du profil.
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
 * Source des secrets. Le crawler demande, n'invente jamais : `undefined` veut dire
 * aucun identifiant autorisé, et l'interaction est enregistrée AUTH_REQUIRED. Les
 * implémentations peuvent lire des variables d'environnement (secrets de CI, secrets
 * Kubernetes montés en variables), un coffre, un gestionnaire de secrets…
 */
export interface CredentialProvider {
  readonly name: string;
  resolve(context: AuthContext): Promise<Credentials | undefined>;
}

/** Noms des variables d'environnement d'un profil — jamais les valeurs. */
export interface EnvironmentProfile {
  usernameEnv: string;
  passwordEnv: string;
}

/** Lit chaque profil dans les variables d'environnement (GitHub Secrets, env Kubernetes, .env chargé par le shell…). */
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

  /** Variables d'environnement dont un profil a besoin et qui ne sont pas définies (pour des messages clairs). */
  missingVariables(profileName: string): string[] {
    const profile = this.profiles[profileName];
    if (!profile) return [];
    return [profile.usernameEnv, profile.passwordEnv].filter((name) => !this.env[name]);
  }
}
