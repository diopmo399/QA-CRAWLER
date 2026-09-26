import type { ScenarioConfig } from '../config/config.js';
import { hostMatches } from '../config/config-loader.js';
import { effectivePath } from '../crawler/url-normalizer.js';
import type { SafetyPolicy } from './safety-policy.js';

export type SkipReason =
  | 'external-host'
  | 'ignored-path'
  | 'dangerous-url'
  | 'non-html-resource'
  | 'unsupported-scheme'
  | 'max-depth'
  | 'route-limit'
  | 'already-seen';

export type NavigationDecision = { allowed: true } | { allowed: false; reason: SkipReason; detail: string };

/** File types that are downloads/assets rather than pages to crawl. */
const NON_HTML_EXTENSION =
  /\.(pdf|zip|gz|tgz|rar|7z|tar|exe|dmg|msi|apk|iso|csv|xlsx?|docx?|pptx?|odt|ods|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|woff2?|ttf|eot|css|js|mjs|map|json|xml|txt)$/i;

/**
 * Decides whether a URL may be visited: same allowed host, http(s) only,
 * not an ignored or dangerous path, not a file download. Depth and
 * per-route limits are enforced by the crawl engine and queue.
 */
export class NavigationPolicy {
  private readonly allowedHosts: readonly string[];
  private readonly ignoredPaths: readonly RegExp[];

  constructor(
    safety: ScenarioConfig['safety'],
    private readonly safetyPolicy: SafetyPolicy,
  ) {
    this.allowedHosts = safety.allowedHosts;
    this.ignoredPaths = safety.ignoredPaths.map((pattern) => pathPatternToRegex(pattern));
  }

  evaluate(url: URL): NavigationDecision {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { allowed: false, reason: 'unsupported-scheme', detail: url.protocol };
    }
    if (!this.isAllowedHost(url.hostname)) {
      return { allowed: false, reason: 'external-host', detail: url.hostname };
    }
    const path = effectivePath(url);
    const ignored = this.ignoredPaths.find((regex) => regex.test(path) || regex.test(url.pathname));
    if (ignored) {
      return { allowed: false, reason: 'ignored-path', detail: path };
    }
    const risk = this.safetyPolicy.classifyUrl(url.toString());
    if (risk.classification === 'DANGEROUS') {
      return { allowed: false, reason: 'dangerous-url', detail: risk.reason };
    }
    if (NON_HTML_EXTENSION.test(url.pathname)) {
      return { allowed: false, reason: 'non-html-resource', detail: url.pathname };
    }
    return { allowed: true };
  }

  isAllowedHost(hostname: string): boolean {
    return this.allowedHosts.some((pattern) => hostMatches(hostname, pattern));
  }
}

/**
 * `/logout` matches /logout, /logout/ and /logout/anything (prefix on a segment boundary).
 * `*` matches within a segment, `**` across segments: /admin/*\/delete, /api/**.
 */
export function pathPatternToRegex(pattern: string): RegExp {
  const normalized = pattern.startsWith('/') ? pattern : `/${pattern}`;
  const body = normalized
    .replace(/\/+$/, '')
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}(/.*)?$`, 'i');
}
