import type { BrowserContext, Route } from 'playwright';
import { redactUrl } from '../security/redactor.js';
import { pathPatternToRegex } from './navigation-policy.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Échanges d'authentification (OIDC, OAuth 2, SAML, SSO, connexion) : jamais bloqués.
 * Ils arrivent en arrière-plan — pendant la fenêtre SSO, au renouvellement du jeton —
 * et sans eux l'application reste non connectée (401 partout).
 */
const AUTH_PATH =
  /\/(oauth2?|oidc|openid|openid-connect|saml2?|sso|auth|authorize|token|introspect|login|logon|signin|sign-in|session|connect)(\/|$|\.)/i;
/** Corps d'une requête d'authentification (lu localement, jamais conservé). */
const AUTH_BODY = /(^|&)(grant_type|client_assertion|SAMLRequest|SAMLResponse|refresh_token)=/;

/** Une requête d'écriture annulée : méthode, URL (sans secret), et l'action en cours. */
export interface BlockedWrite {
  method: string;
  url: string;
  at: string;
  stateId?: string;
  actionId?: string;
  /** Libellé de l'action en cours (« fill "N° dossier" »), ou la phase (« exploration »). */
  during: string;
}

export interface WriteGuardOptions {
  enabled: boolean;
  /** Requêtes toujours permises : « POST /api/search », « /graphql », « * /api/*\/query ». */
  allow: readonly string[];
  /** Hôtes gardés : ceux que la mission explore (les autres ne sont jamais visités). */
  isGuardedHost(hostname: string): boolean;
}

/**
 * GARDE D'ÉCRITURE : pendant l'exploration, toute requête POST, PUT, PATCH ou DELETE
 * vers un hôte de l'application est annulée, sauf quand l'action en cours a le droit
 * de modifier des données (MUTATION/DANGEROUS permise par la SafetyPolicy, étape de
 * flow avec `allow`), pendant la connexion, ou quand la requête est listée dans `allow`.
 *
 * Pourquoi : la SafetyPolicy classe les CLICS, pas ce que l'application envoie d'elle-
 * même. Remplir un champ de recherche peut déclencher un PUT (effet de bord d'une
 * saisie) ; la garde l'annule et le signale. Les échanges d'authentification (jeton
 * OIDC/OAuth, SAML, SSO, session) ne sont jamais bloqués.
 */
export class WriteGuard {
  private permission: { reason: string } | undefined;
  private current: { stateId?: string; actionId?: string; during: string } = { during: 'exploration' };
  private readonly blocked: BlockedWrite[] = [];
  private readonly allow: { method: string; path: RegExp }[];
  private onBlocked: ((write: BlockedWrite) => void) | undefined;

  constructor(private readonly options: WriteGuardOptions) {
    this.allow = options.allow.map((entry) => {
      const [first, ...rest] = entry.trim().split(/\s+/);
      const method = rest.length > 0 ? (first ?? '*').toUpperCase() : '*';
      return { method, path: pathPatternToRegex(rest.length > 0 ? rest.join(' ') : (first ?? '/')) };
    });
  }

  /** Installe la garde sur le contexte du navigateur (toutes les pages, popups comprises). */
  async attach(context: BrowserContext, onBlocked?: (write: BlockedWrite) => void): Promise<void> {
    if (!this.options.enabled) return;
    this.onBlocked = onBlocked;
    await context.route('**/*', (route) => this.handle(route));
  }

  /**
   * Autorise les écritures pendant `work` (connexion, action MUTATION permise, étape de
   * flow avec allow). Les autorisations imbriquées gardent la plus externe.
   */
  async permit<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const previous = this.permission;
    this.permission ??= { reason };
    try {
      return await work();
    } finally {
      this.permission = previous;
    }
  }

  /** L'action en cours, pour expliquer une requête bloquée. */
  during(stateId: string | undefined, actionId: string | undefined, label: string): void {
    this.current = { ...(stateId ? { stateId } : {}), ...(actionId ? { actionId } : {}), during: label };
  }

  idle(): void {
    this.current = { during: 'exploration' };
  }

  all(): BlockedWrite[] {
    return [...this.blocked];
  }

  /** Décide pour une requête (exposé pour les tests). */
  decide(method: string, url: string, body?: string | null): 'continue' | 'block' {
    if (!this.options.enabled || !WRITE_METHODS.has(method.toUpperCase()) || this.permission)
      return 'continue';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'continue';
    }
    if (!/^https?:$/.test(parsed.protocol) || !this.options.isGuardedHost(parsed.hostname)) return 'continue';
    // L'authentification n'écrit pas de données métier : jeton, session, SSO passent toujours.
    if (AUTH_PATH.test(parsed.pathname) || (body && AUTH_BODY.test(body))) return 'continue';
    const upper = method.toUpperCase();
    if (
      this.allow.some(
        (rule) => (rule.method === '*' || rule.method === upper) && rule.path.test(parsed.pathname),
      )
    )
      return 'continue';
    return 'block';
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const body = WRITE_METHODS.has(request.method().toUpperCase()) ? request.postData() : null;
    if (this.decide(request.method(), request.url(), body) === 'continue') {
      await route.fallback().catch(() => undefined);
      return;
    }
    const write: BlockedWrite = {
      method: request.method().toUpperCase(),
      url: redactUrl(request.url()),
      at: new Date().toISOString(),
      ...this.current,
    };
    this.blocked.push(write);
    this.onBlocked?.(write);
    await route.abort('blockedbyclient').catch(() => undefined);
  }
}

/**
 * Le modèle d'une requête d'écriture, pour regrouper celles d'une même saisie
 * (/api/users/draft/C, /api/users/draft/Cr… → /api/users/draft/*).
 */
export function writePattern(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // déjà un chemin
  }
  const segments = path.split('/');
  if (segments.length > 2) segments[segments.length - 1] = '*';
  return segments.join('/').replace(/\/\d+(?=\/|$)/g, '/:id');
}
