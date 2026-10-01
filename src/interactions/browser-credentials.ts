import type { BrowserContextOptions } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';

export interface BrowserHttpCredentials {
  /** Options du contexte : Chromium répond lui-même à la fenêtre de connexion de cette origine. */
  options: Pick<BrowserContextOptions, 'httpCredentials'>;
  origin: string;
  profile: string;
}

/**
 * CONNEXION HTTP CONFIÉE AU NAVIGATEUR. Une popup de connexion (SiteMinder, NTLM) commence à
 * se charger avant que le crawler puisse s'y attacher : quand le défi arrive dans cet
 * intervalle, la fenêtre native « Se connecter » reste à l'écran (une course, donc des runs
 * qui passent et d'autres non). Donnés au contexte dès son ouverture, les identifiants sont
 * fournis par Chromium à chaque défi, dans toutes les pages et popups, sans course.
 *
 * Sur demande (httpAuth.answerByBrowser: true), avec un profil (httpAuth.credentialProfile) et UNE origine
 * de connexion déclarée (httpAuth.origins) : les identifiants ne partent que vers elle, et
 * seulement en réponse à un défi (jamais envoyés d'avance). Valeurs lues dans
 * l'environnement, jamais journalisées.
 */
export function browserHttpCredentials(
  config: ScenarioConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserHttpCredentials | undefined {
  const { browserInteractions } = config;
  if (!browserInteractions.enabled || !browserInteractions.httpAuth.answerByBrowser) return undefined;
  const profile = browserInteractions.httpAuth.credentialProfile;
  const [origin, ...others] = browserInteractions.httpAuth.origins;
  if (!profile || origin === undefined || others.length > 0) return undefined;
  if (browserInteractions.blockedOrigins.includes(origin)) return undefined;
  const names = config.credentials[profile];
  if (!names) return undefined;
  const username = env[names.usernameEnv];
  const password = env[names.passwordEnv];
  if (!username || !password) return undefined;
  return {
    options: { httpCredentials: { username, password, origin, send: 'unauthorized' } },
    origin,
    profile,
  };
}
