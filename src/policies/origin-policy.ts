import type { OriginClass } from '../interactions/types.js';
import type { NavigationPolicy } from './navigation-policy.js';

/**
 * Où se situe une URL par rapport à la mission, à partir des hôtes autorisés de la
 * NavigationPolicy :
 * - SAME_ORIGIN : l'origine de l'application cible ;
 * - ALLOWED_ORIGIN : une autre origine sur un hôte autorisé (API, SSO déclaré dans allowedHosts…) ;
 * - EXTERNAL_ORIGIN : tout le reste ;
 * - BLOCKED_ORIGIN : bloquée explicitement par la mission (browserInteractions.blockedOrigins).
 */
export class AllowedOriginPolicy {
  private readonly blocked: ReadonlySet<string>;

  constructor(
    private readonly targetOrigin: string,
    private readonly navigation: NavigationPolicy,
    blockedOrigins: readonly string[] = [],
  ) {
    this.blocked = new Set(blockedOrigins.map((origin) => originOf(origin) ?? origin));
  }

  classify(url: string): OriginClass | undefined {
    const origin = originOf(url);
    if (!origin) return undefined; // about:blank, data:, chrome-error:…
    if (this.blocked.has(origin)) return 'BLOCKED_ORIGIN';
    if (origin === this.targetOrigin) return 'SAME_ORIGIN';
    return this.navigation.isAllowedHost(new URL(url).hostname) ? 'ALLOWED_ORIGIN' : 'EXTERNAL_ORIGIN';
  }

  isAllowed(url: string): boolean {
    const origin = this.classify(url);
    return origin === 'SAME_ORIGIN' || origin === 'ALLOWED_ORIGIN';
  }
}

/** Origine d'une URL http(s) ; undefined pour tout le reste. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
