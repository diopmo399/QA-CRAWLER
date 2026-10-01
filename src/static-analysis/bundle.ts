import type { Page, Response } from 'playwright';
import type { ScriptFetcher } from './sources/source-providers.js';

/**
 * Adaptateurs Playwright de la découverte des sources : quels scripts le navigateur a
 * chargés, et comment les relire. Rien n'est exécuté ni évalué ici : les scripts sont
 * relus comme du texte, avec la session du navigateur (cookies), sans suivre de
 * redirection — une redirection pourrait sortir des hôtes autorisés.
 */

/** Les scripts de la page : balises <script src> et ressources de type script déjà chargées. */
export async function runtimeScriptUrls(page: Page): Promise<string[]> {
  return page
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
}

/** Un script reçu par le navigateur (chunk chargé à la demande compris). */
export function isScriptResponse(response: Response): boolean {
  return response.request().resourceType() === 'script' && /^https?:/i.test(response.url());
}

export function playwrightFetcher(page: Page): ScriptFetcher {
  return async (url, maxBytes) => {
    try {
      const response = await page.request.get(url, { timeout: 10_000, maxRedirects: 0 });
      const status = response.status();
      if (status >= 300 && status < 400)
        return { failure: `redirected (HTTP ${String(status)}): redirects are not followed` };
      if (!response.ok()) return { failure: `HTTP ${String(status)}` };
      const declared = Number(response.headers()['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) return { failure: tooLarge(declared, maxBytes) };
      const body = await response.body();
      if (body.byteLength > maxBytes) return { failure: tooLarge(body.byteLength, maxBytes) };
      return { text: body.toString('utf8'), headers: response.headers() };
    } catch (error) {
      const message = (error as Error).message;
      return { failure: /timeout/i.test(message) ? 'timed out (10 s)' : 'network error' };
    }
  };
}

/** « too large (6.4 MB > limit 2.0 MB: staticAnalysis.budgets) » */
function tooLarge(bytes: number, limit: number): string {
  const mb = (value: number): string => `${(value / 1_000_000).toFixed(1)} MB`;
  return `too large (${mb(bytes)} > limit ${mb(limit)}: raise staticAnalysis.budgets.maxFileSizeBytes or maxSourceMapBytes)`;
}
