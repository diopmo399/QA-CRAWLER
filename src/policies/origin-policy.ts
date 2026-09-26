import type { OriginClass } from '../interactions/types.js';
import type { NavigationPolicy } from './navigation-policy.js';

/**
 * Where a URL stands compared to the mission, reusing the NavigationPolicy's
 * allowed hosts:
 * - SAME_ORIGIN: the target application's origin;
 * - ALLOWED_ORIGIN: another origin on an allowed host (API, SSO declared in allowedHosts…);
 * - EXTERNAL_ORIGIN: anything else;
 * - BLOCKED_ORIGIN: explicitly blocked by the mission (browserInteractions.blockedOrigins).
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

/** Origin of an http(s) URL; undefined for anything else. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
