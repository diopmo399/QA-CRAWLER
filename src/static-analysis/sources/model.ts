/**
 * SOURCES DE L'ANALYSE STATIQUE : d'où viennent les fichiers que l'analyseur lit.
 * L'analyseur (graph-builder) ne change pas ; seules ses ENTRÉES s'enrichissent :
 *
 *   REPOSITORY  le dépôt de l'application (staticAnalysis.source.root)
 *   SOURCE_MAP  les sources d'origine publiées par les source maps (sourcesContent)
 *   BUNDLE      les scripts chargés par le navigateur, minifiés (dernier recours)
 *
 * Une source map est une donnée NON FIABLE : ses chemins sont normalisés et bornés,
 * son contenu n'est jamais exécuté, jamais écrit sur disque, jamais recopié dans un
 * rapport, un journal ou result.json (seuls chemins et empreintes le sont).
 */

export type StaticSourceOrigin = 'REPOSITORY' | 'SOURCE_MAP' | 'BUNDLE';

export type StaticSourceLanguage = 'typescript' | 'javascript' | 'html' | 'json';

/** D'où vient un fichier du workspace : sans son contenu, affichable sans risque. */
export interface StaticSourceProvenance {
  /** Chemin dans le workspace (celui que citent les SourceLocation du graphe). */
  path: string;
  origin: StaticSourceOrigin;
  /** Empreinte sha256 du contenu. */
  contentHash: string;
  /** Script qui porte ce fichier (adresse sans paramètres). */
  bundleUrl?: string;
  bundleHash?: string;
  /** Source map qui l'a livré (adresse sans paramètres, ou « inline »). */
  sourceMapUrl?: string;
  mapHash?: string;
  /** Le chemin tel qu'écrit dans la source map (webpack:///./src/…), borné. */
  originalPath?: string;
}

export function languageOf(file: string): StaticSourceLanguage | undefined {
  if (/\.(ts|tsx|mts|cts)$/.test(file)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(file)) return 'javascript';
  if (/\.html?$/.test(file)) return 'html';
  if (/(^|\/)package\.json$/.test(file)) return 'json';
  return undefined;
}

/**
 * Une adresse telle qu'elle peut apparaître dans un rapport : sans paramètres ni
 * fragment (un jeton y voyage parfois), jamais une URL data: complète.
 */
export function displayUrl(url: string): string {
  if (url.startsWith('data:')) return 'inline';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0]?.slice(0, 200) ?? '';
  }
}

/** Événements de la découverte des sources (journal, sans contenu). */
export type SourceDiscoveryEvent =
  | 'BUNDLE_DISCOVERED'
  | 'SOURCE_MAP_REFERENCE_DISCOVERED'
  | 'SOURCE_MAP_LOADING_STARTED'
  | 'SOURCE_MAP_LOADED'
  | 'SOURCE_MAP_REJECTED'
  | 'SOURCE_MAP_PARTIAL'
  | 'SOURCE_EXTRACTED'
  | 'SOURCE_CONTENT_CONFLICT'
  | 'VIRTUAL_WORKSPACE_CREATED'
  | 'VIRTUAL_WORKSPACE_ENRICHED'
  | 'LAZY_BUNDLE_DISCOVERED'
  | 'SOURCE_BUILD_MISMATCH'
  | 'BUNDLE_FALLBACK_STARTED';

export type SourceDiscoverySink = (event: SourceDiscoveryEvent, message: string) => void;

/** Ce que la découverte des sources a trouvé, pour le rapport (jamais de contenu). */
export interface StaticSourceDiscoverySummary {
  /** Stratégie configurée : auto, source, source-map, bundle, hybrid. */
  strategy: string;
  origins: StaticSourceOrigin[];
  bundles: number;
  lazyBundles: number;
  sourceMaps: { referenced: number; loaded: number; partial: number; rejected: number };
  extractedSources: number;
  bundleOnly: number;
  conflicts: string[];
  mismatches: string[];
  bundleSetHash?: string;
  /** Un bundle par ligne (au plus 30) : adresse, source map, ce qui en a été tiré. */
  entries: {
    url: string;
    status: string;
    lazy: boolean;
    sourceMap?: string;
    extracted: number;
    reason?: string;
  }[];
}
