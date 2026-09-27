import type { QueryParamMode } from '../config/config.js';

const NON_NAVIGABLE_SCHEMES = /^(mailto|tel|sms|javascript|data|blob|file|ftp|about|chrome|intent):/i;

/**
 * Résout un href trouvé dans une page par rapport à l'URL de la page.
 * Renvoie undefined pour tout ce qui n'est pas une cible de navigation http(s)
 * (mailto:, javascript:, liens vides ou réduits à un fragment, URL mal formées).
 */
export function resolveUrl(href: string, baseUrl: string): URL | undefined {
  const trimmed = href.trim();
  if (trimmed === '' || NON_NAVIGABLE_SCHEMES.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url;
}

export interface NormalizeOptions {
  queryParamMode: QueryParamMode;
  /** Noms de paramètres retirés avant la comparaison ; joker `*` accepté (utm_*). */
  ignoredParams: readonly string[];
}

/**
 * Forme canonique qui sert à décider si deux URL sont la même page :
 * - schéma et hôte en minuscules, ports par défaut retirés ;
 * - fragment retiré, sauf les routes par hash (#/users, #!/users) des SPA ;
 * - barres obliques doublées fusionnées, barre finale retirée (sauf la racine) ;
 * - paramètres ignorés ou de suivi retirés, les autres triés
 *   (ou tous retirés en mode `ignore`).
 */
export function normalizeUrl(input: URL | string, options: NormalizeOptions): string {
  const url = new URL(input.toString());
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  url.pathname = normalizePath(url.pathname);

  const isHashRoute = /^#!?\//.test(url.hash);
  if (isHashRoute) {
    const [hashPath = '', hashQuery] = url.hash.replace(/^#!?/, '').split('?', 2);
    const query = hashQuery === undefined ? '' : filterQuery(new URLSearchParams(hashQuery), options);
    url.hash = `#${normalizePath(hashPath)}${query ? `?${query}` : ''}`;
  } else {
    url.hash = '';
  }

  url.search = filterQuery(url.searchParams, options);
  return url.toString();
}

function normalizePath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path === '' ? '/' : path;
}

function filterQuery(params: URLSearchParams, options: NormalizeOptions): string {
  if (options.queryParamMode === 'ignore') return '';
  const kept = [...params.entries()].filter(([key]) => !isIgnoredParam(key, options.ignoredParams));
  kept.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return new URLSearchParams(kept).toString();
}

export function isIgnoredParam(name: string, ignored: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return ignored.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? lower.startsWith(p.slice(0, -1)) : lower === p;
  });
}

/** Chemin affiché dans les logs et comparé aux ignoredPaths : la route par hash pour les SPA qui en utilisent. */
export function effectivePath(url: URL | string): string {
  const parsed = new URL(url.toString());
  if (/^#!?\//.test(parsed.hash)) {
    return parsed.hash.replace(/^#!?/, '').split('?')[0] ?? '/';
  }
  return parsed.pathname;
}
