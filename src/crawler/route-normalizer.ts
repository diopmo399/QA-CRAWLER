import type { QueryParamMode } from '../config/config.js';
import { effectivePath } from './url-normalizer.js';

/**
 * Turns concrete URLs into route patterns so that /users/1, /users/2 … are
 * recognised as the same kind of page (/users/:id). The crawler then visits
 * only a few URLs per pattern instead of every record in the database.
 *
 * Deliberately simple heuristics, applied per path segment.
 */
const SEGMENT_RULES: readonly [RegExp, string][] = [
  [/^\d+$/, ':id'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':uuid'],
  // MongoDB ObjectId, hashes, hex ids
  [/^(?=.*\d)[0-9a-f]{12,}$/i, ':hash'],
  [/^\d{4}-\d{2}-\d{2}([t_ ]\d{2}[:-]\d{2}([:-]\d{2})?)?$/i, ':date'],
  // Long opaque tokens mixing letters and digits (slugs with ids, base64 ids…)
  [/^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{20,}$/i, ':token'],
  // "123-product-name" style slugs
  [/^\d+-[a-z0-9-]+$/i, ':id-slug'],
];

export function normalizeSegment(segment: string): string {
  if (segment === '') return segment;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  for (const [pattern, replacement] of SEGMENT_RULES) {
    if (pattern.test(decoded)) return replacement;
  }
  return decoded.toLowerCase();
}

export function routePattern(path: string): string {
  const pattern = path
    .split('/')
    .map((segment) => normalizeSegment(segment))
    .join('/');
  return pattern === '' ? '/' : pattern;
}

/**
 * Route key of a (normalized) URL. In `pattern` mode query parameter *names*
 * are part of the key but not their values, so ?page=1 … ?page=500 share a
 * key and are capped by `maxUrlsPerRoute`.
 */
export function routeKey(url: URL | string, queryParamMode: QueryParamMode): string {
  const parsed = new URL(url.toString());
  const path = routePattern(effectivePath(parsed));
  if (queryParamMode !== 'pattern') {
    return queryParamMode === 'keep' && parsed.search ? `${path}${parsed.search}` : path;
  }
  const hashQuery = /^#!?\//.test(parsed.hash) ? (parsed.hash.split('?')[1] ?? '') : '';
  const names = new Set([...parsed.searchParams.keys(), ...new URLSearchParams(hashQuery).keys()]);
  return names.size > 0 ? `${path}?${[...names].sort().join('&')}` : path;
}
