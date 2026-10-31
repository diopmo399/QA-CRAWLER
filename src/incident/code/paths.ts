import type { CodeEndpoint, CodeIndex, CodeLayer } from '../model.js';

/**
 * Les chemins HTTP pour la comparaison : hôte, requête et fragment retirés, paramètres
 * (`${id}`, `{id}`, `:id`) ramenés à `{}`, barres obliques normalisées.
 */
export function normalizePath(path: string): string {
  let p = path.trim();
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  p = p.replace(/^\/\/[^/?#]*/, '');
  p = p.replace(/\$\{[^}]*\}/g, '{}');
  p = p.replace(/\{[^}]*\}/g, '{}');
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  const segments = p
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (/^:[A-Za-z_$][\w$]*$/.test(s) ? '{}' : s));
  return '/' + segments.join('/');
}

/** Joint des morceaux de chemin (préfixe de classe + chemin de méthode). */
export function joinPaths(...parts: string[]): string {
  const joined = parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('/');
  const segments = joined.split('/').filter((s) => s !== '');
  return '/' + segments.join('/');
}

/** Le chemin d'une URL (absolue ou relative), sans requête ni fragment ; paramètres gardés tels qu'écrits. */
export function urlPath(url: string): string {
  let p = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (p === '') return '/';
  return joinPaths(p);
}

function segmentMatches(pattern: string, value: string): number {
  if (pattern === value) return 3;
  if (pattern === '{}') return value === '' ? 0 : 1;
  if (pattern.includes('{}')) {
    const regex = new RegExp(
      '^' +
        pattern
          .split('{}')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]+') +
        '$',
    );
    return regex.test(value) ? 2 : 0;
  }
  return 0;
}

/**
 * L'endpoint servi qui répond à `method path` : gabarits (`/api/books/{id}` contre `/api/books/12`),
 * barre finale ignorée, méthode `*` (`@RequestMapping` sans méthode) acceptée en dernier recours.
 * Le chemin le plus littéral l'emporte.
 */
export function matchEndpoint(
  index: Pick<CodeIndex, 'endpoints'>,
  method: string,
  path: string,
  layer?: CodeLayer,
): CodeEndpoint | undefined {
  const target = normalizePath(path).split('/');
  const verb = method.toUpperCase();
  let best: CodeEndpoint | undefined;
  let bestScore = -1;
  for (const endpoint of index.endpoints) {
    if (layer && endpoint.layer !== layer) continue;
    const anyMethod = endpoint.method === '*';
    if (!anyMethod && endpoint.method.toUpperCase() !== verb) continue;
    const segments = normalizePath(endpoint.path).split('/');
    if (segments.length !== target.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const s = segmentMatches(segments[i] ?? '', target[i] ?? '');
      if (s === 0 && !(segments[i] === '' && target[i] === '')) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    if (!anyMethod) score += 1;
    if (score > bestScore) {
      best = endpoint;
      bestScore = score;
    }
  }
  return best;
}
