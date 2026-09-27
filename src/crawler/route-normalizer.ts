import type { QueryParamMode } from '../config/config.js';
import { effectivePath } from './url-normalizer.js';

/**
 * Transforme des URL concrètes en modèles de route pour que /users/1, /users/2 …
 * soient reconnues comme le même genre de page (/users/:id). Le crawler ne visite
 * alors que quelques URL par modèle au lieu de chaque enregistrement de la base.
 *
 * Heuristiques volontairement simples, appliquées segment par segment.
 */
const SEGMENT_RULES: readonly [RegExp, string][] = [
  [/^\d+$/, ':id'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':uuid'],
  // ObjectId MongoDB, empreintes, id hexadécimaux
  [/^(?=.*\d)[0-9a-f]{12,}$/i, ':hash'],
  [/^\d{4}-\d{2}-\d{2}([t_ ]\d{2}[:-]\d{2}([:-]\d{2})?)?$/i, ':date'],
  // Longs jetons opaques mêlant lettres et chiffres (slugs avec id, id en base64…)
  [/^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{20,}$/i, ':token'],
  // Slugs du genre « 123-nom-du-produit »
  [/^\d+-[a-z0-9-]+$/i, ':id-slug'],
];

export function normalizeSegment(segment: string): string {
  if (segment === '') return segment;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // garder le segment tel quel
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
 * Clé de route d'une URL (normalisée). En mode `pattern`, les *noms* des
 * paramètres de requête font partie de la clé mais pas leurs valeurs : ?page=1 …
 * ?page=500 partagent une clé et sont limités par `maxUrlsPerRoute`.
 */
export function routeKey(url: URL | string, queryParamMode: QueryParamMode): string {
  const parsed = new URL(url.toString());
  const rawPath = effectivePath(parsed);
  const path = routePattern(rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath);
  if (queryParamMode !== 'pattern') {
    return queryParamMode === 'keep' && parsed.search ? `${path}${parsed.search}` : path;
  }
  const hashQuery = /^#!?\//.test(parsed.hash) ? (parsed.hash.split('?')[1] ?? '') : '';
  const names = new Set([...parsed.searchParams.keys(), ...new URLSearchParams(hashQuery).keys()]);
  return names.size > 0 ? `${path}?${[...names].sort().join('&')}` : path;
}
