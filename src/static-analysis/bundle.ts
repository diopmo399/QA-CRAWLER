import type { Page } from 'playwright';
import { sourceSetOf, type SourceSet } from './source-set.js';

export interface BundleOptions {
  /** Lire les source maps publiées (sourcesContent) quand il y en a. */
  sourceMaps: boolean;
  maxFiles: number;
  maxFileSizeBytes: number;
  /** Seuls les scripts des hôtes autorisés par la mission sont lus. */
  isAllowedUrl: (url: string) => boolean;
}

interface SourceMapJson {
  sources?: string[];
  sourcesContent?: (string | null)[];
}

/**
 * BUNDLE_MODE : quand le dépôt n'est pas disponible, les scripts que le navigateur a
 * chargés sont lus (jamais exécutés une seconde fois, jamais évalués ici). Si le serveur
 * publie les source maps, les sources d'origine qu'elles contiennent sont préférées ;
 * sinon, le bundle lui-même est analysé — minifié, sans noms d'origine : précision
 * LIMITED, jamais promise égale à celle des sources.
 */
export async function collectBundle(page: Page, options: BundleOptions): Promise<SourceSet> {
  const urls = await page
    .evaluate(() => [
      ...new Set([
        ...Array.from(document.scripts)
          .map((script) => script.src)
          .filter(Boolean),
        ...performance
          .getEntriesByType('resource')
          .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script')
          .map((entry) => entry.name),
      ]),
    ])
    .catch(() => [] as string[]);
  const entries: { path: string; text: string }[] = [];
  for (const url of urls) {
    if (entries.length >= options.maxFiles) break;
    let allowed = false;
    try {
      allowed = /^https?:/.test(url) && options.isAllowedUrl(url);
    } catch {
      allowed = false;
    }
    if (!allowed) continue;
    const script = await fetchText(page, url, options.maxFileSizeBytes);
    if (script === undefined) continue;
    const originals = options.sourceMaps ? await originalSources(page, url, script, options) : [];
    if (originals.length > 0) entries.push(...originals.slice(0, options.maxFiles - entries.length));
    else entries.push({ path: `bundle/${new URL(url).pathname.replace(/^\//, '')}`, text: script });
  }
  return sourceSetOf('bundle', entries);
}

async function fetchText(page: Page, url: string, maxBytes: number): Promise<string | undefined> {
  try {
    // La session du navigateur (cookies) : les mêmes scripts que ceux que l'utilisateur reçoit.
    const response = await page.request.get(url, { timeout: 10_000, maxRedirects: 0 });
    if (!response.ok()) return undefined;
    const body = await response.body();
    if (body.byteLength > maxBytes) return undefined;
    return body.toString('utf8');
  } catch {
    return undefined;
  }
}

async function originalSources(
  page: Page,
  scriptUrl: string,
  script: string,
  options: BundleOptions,
): Promise<{ path: string; text: string }[]> {
  const reference = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(script)?.[1];
  if (!reference || reference.startsWith('data:')) return [];
  let mapUrl: string;
  try {
    mapUrl = new URL(reference, scriptUrl).toString();
  } catch {
    return [];
  }
  if (!options.isAllowedUrl(mapUrl)) return [];
  const text = await fetchText(page, mapUrl, options.maxFileSizeBytes * 4);
  if (!text) return [];
  let map: SourceMapJson;
  try {
    map = JSON.parse(text) as SourceMapJson;
  } catch {
    return [];
  }
  const sources: { path: string; text: string }[] = [];
  (map.sources ?? []).forEach((source, index) => {
    const content = map.sourcesContent?.[index];
    if (!content || /node_modules|webpack\/runtime|\(webpack\)/.test(source)) return;
    const clean = source.replace(/^webpack:\/\/\/?/, '').replace(/^(\.\/|\.\.\/)+/, '');
    if (!/\.(ts|tsx|js|jsx|mjs|html)$/.test(clean)) return;
    sources.push({ path: `sourcemap/${clean}`, text: content });
  });
  return sources;
}
