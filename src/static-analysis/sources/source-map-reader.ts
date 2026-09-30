/**
 * SOURCE MAP READER : trouve la référence d'une source map (commentaire
 * sourceMappingURL, en-tête SourceMap, data URI inline) et lit sa partie utile —
 * sources, sourcesContent, sourceRoot. Les mappings ne sont pas décodés : l'analyseur
 * lit les sources d'origine, il n'a pas besoin de remonter du minifié aux lignes.
 *
 * Une source map est une donnée NON FIABLE : taille bornée avant tout décodage,
 * structure validée, jamais évaluée. Aucune adresse n'est devinée (pas de « .map »
 * essayé au hasard) : seule une référence publiée par le script ou le serveur est suivie.
 */

export type SourceMapReference =
  { kind: 'EXTERNAL'; url: string } | { kind: 'HEADER'; url: string } | { kind: 'INLINE'; dataUri: string };

/** Une entrée de la source map, avant normalisation de son chemin. */
export interface SourceMapEntry {
  source: string;
  content: string | undefined;
}

export type SourceMapReadResult =
  | { status: 'OK'; entries: SourceMapEntry[]; sourceRoot?: string; notes: string[] }
  | { status: 'REJECTED'; reason: string };

/** Le commentaire est cherché à la fin du script : c'est là que les bundlers l'écrivent. */
const TAIL = 4096;

/**
 * La référence de source map d'un script : l'en-tête HTTP (SourceMap, X-SourceMap)
 * passe devant le commentaire, comme dans les navigateurs. Le dernier commentaire du
 * script gagne (un bundle peut en contenir d'autres, recopiés de dépendances).
 */
export function findSourceMapReference(
  script: string,
  scriptUrl: string,
  headers: Readonly<Record<string, string>> = {},
): SourceMapReference | undefined {
  const header = headers.sourcemap ?? headers['x-sourcemap'];
  if (header) {
    const url = resolveUrl(header.trim(), scriptUrl);
    if (url) return { kind: 'HEADER', url };
  }
  const tail = script.length > TAIL ? script.slice(-TAIL) : script;
  let value = lastReference(tail);
  if (value === undefined && script.length > TAIL) {
    // Une source map inline dépasse souvent 4 Ko : son commentaire commence plus haut.
    const start = script.lastIndexOf('sourceMappingURL=data:');
    if (start >= 0) value = lastReference(script.slice(Math.max(0, start - 4)));
  }
  if (!value) return undefined;
  if (/^data:/i.test(value)) return { kind: 'INLINE', dataUri: value };
  const url = resolveUrl(value, scriptUrl);
  return url ? { kind: 'EXTERNAL', url } : undefined;
}

function lastReference(text: string): string | undefined {
  const pattern = /(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s'"*]+)[ \t]*(?:\*\/)?[ \t]*$/gm;
  let last: string | undefined;
  for (const match of text.matchAll(pattern)) last = match[1];
  return last;
}

function resolveUrl(reference: string, base: string): string | undefined {
  try {
    const url = new URL(reference, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Décode une source map inline (data:application/json;base64,…), taille bornée AVANT décodage. */
export function decodeInlineSourceMap(
  dataUri: string,
  maxBytes: number,
): { text: string } | { rejected: string } {
  const comma = dataUri.indexOf(',');
  if (comma < 0) return { rejected: 'malformed data URI' };
  const meta = dataUri.slice(5, comma).toLowerCase();
  const payload = dataUri.slice(comma + 1);
  if (!meta.startsWith('application/json') && meta !== ';base64' && meta !== '')
    return { rejected: `unexpected media type ${meta.split(';')[0] ?? ''}` };
  const base64 = meta.split(';').includes('base64');
  const estimated = base64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  if (estimated > maxBytes) return { rejected: 'source map larger than the budget' };
  try {
    return {
      text: base64 ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload),
    };
  } catch {
    return { rejected: 'undecodable data URI' };
  }
}

interface RawSourceMap {
  version?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: unknown;
  sections?: unknown;
}

/**
 * Lit une source map (v3, ou index map à sections inline). Rejetée si elle n'est pas du
 * JSON, pas une v3, ou si sources/sourcesContent n'ont pas la forme attendue : le run
 * continue alors avec le bundle (BUNDLE_FALLBACK).
 */
export function readSourceMap(text: string, maxBytes: number): SourceMapReadResult {
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    return { status: 'REJECTED', reason: 'source map larger than the budget' };
  // Préfixe anti-XSSI qu'autorise la spécification.
  const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { status: 'REJECTED', reason: 'not valid JSON' };
  }
  return readParsed(raw, 0);
}

function readParsed(raw: unknown, depth: number): SourceMapReadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { status: 'REJECTED', reason: 'not a source map object' };
  const map = raw as RawSourceMap;
  if (map.version !== 3) return { status: 'REJECTED', reason: 'unsupported source map version' };
  if (Array.isArray(map.sections)) {
    if (depth > 0) return { status: 'REJECTED', reason: 'nested index map' };
    const entries: SourceMapEntry[] = [];
    const notes: string[] = [];
    for (const section of map.sections as unknown[]) {
      const inner = (section as { map?: unknown; url?: unknown } | null)?.map;
      if (inner === undefined) {
        notes.push('index map section by URL not followed');
        continue;
      }
      const read = readParsed(inner, depth + 1);
      if (read.status === 'REJECTED') {
        notes.push(`index map section rejected: ${read.reason}`);
        continue;
      }
      entries.push(
        ...read.entries.map((entry) => ({
          ...entry,
          source: read.sourceRoot ? joinRoot(read.sourceRoot, entry.source) : entry.source,
        })),
      );
      notes.push(...read.notes);
    }
    return { status: 'OK', entries, notes };
  }
  if (!Array.isArray(map.sources)) return { status: 'REJECTED', reason: 'no sources array' };
  if (map.sourcesContent !== undefined && !Array.isArray(map.sourcesContent))
    return { status: 'REJECTED', reason: 'sourcesContent is not an array' };
  const contents = (map.sourcesContent ?? []) as unknown[];
  const entries: SourceMapEntry[] = [];
  const notes: string[] = [];
  (map.sources as unknown[]).forEach((source, index) => {
    if (typeof source !== 'string') {
      notes.push('non-string source entry ignored');
      return;
    }
    const content = contents[index];
    entries.push({ source, content: typeof content === 'string' ? content : undefined });
  });
  return {
    status: 'OK',
    entries,
    ...(typeof map.sourceRoot === 'string' && map.sourceRoot ? { sourceRoot: map.sourceRoot } : {}),
    notes,
  };
}

function joinRoot(root: string, source: string): string {
  return /^[a-z][a-z0-9+.-]*:|^\//i.test(source) ? source : `${root.replace(/\/+$/, '')}/${source}`;
}
