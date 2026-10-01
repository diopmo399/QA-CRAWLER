import path from 'node:path';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { playwrightFetcher } from '../../src/static-analysis/bundle.js';
import { buildGraphOffThread } from '../../src/static-analysis/graph-runner.js';
import { collectSources, sourceSetOf } from '../../src/static-analysis/source-set.js';
import { RuntimeBundleSourceProvider } from '../../src/static-analysis/sources/source-providers.js';
import { staticAnalyzerOptions } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/registrations');

const buildOptions = {
  applicationId: 'fixture',
  mode: 'SOURCE' as const,
  features: staticAnalyzerOptions().features,
  analyzers: { angular: true, genericJs: true },
  maxAstNodes: 50_000_000,
  maxDurationMs: 120_000,
};

describe('static analysis off the main thread', () => {
  it('builds the same graph in a worker thread as on the main thread', async () => {
    const sources = await collectSources(FIXTURE, staticAnalyzerOptions().budgets);
    const worker = await buildGraphOffThread(sources, buildOptions);
    const main = await buildGraphOffThread(sources, buildOptions, { worker: false });
    expect('graph' in worker && worker.thread).toBe('worker');
    expect('graph' in main && main.thread).toBe('main');
    if (!('graph' in worker) || !('graph' in main)) throw new Error('no graph');
    const strip = (graph: typeof worker.graph) => ({
      ...graph,
      generatedAt: '',
      stats: { ...graph.stats, durationMs: 0 },
    });
    expect(strip(worker.graph)).toEqual(strip(main.graph));
  });

  it('keeps the event loop free while a large bundle is analysed (SSO, popups still served)', async () => {
    // Un bundle de plusieurs Mo, comme un main.js de dev non minifié.
    const body = Array.from(
      { length: 40_000 },
      (_, index) =>
        `function handler${String(index)}(event) { if (event.status === 'PENDING') { return fetch('/api/items/' + event.id, { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED' }) }); } return null; }`,
    ).join('\n');
    const sources = sourceSetOf('bundle', [
      { path: 'package.json', text: '{"dependencies":{"@angular/core":"17.0.0"}}' },
      { path: 'main.js', text: body },
    ]);
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    const result = await buildGraphOffThread(sources, { ...buildOptions, mode: 'BUNDLE' });
    // Le dernier intervalle compte aussi (une boucle bloquée jusqu'à la fin ne rappelle plus le minuteur).
    worst = Math.max(worst, Date.now() - last);
    clearInterval(timer);
    expect('graph' in result && result.thread).toBe('worker');
    // Sur le fil principal, ce parsing bloque la boucle plus d'une seconde (mesuré : ~1,7 s pour 7,5 Mo).
    expect(worst).toBeLessThan(500);
    if ('graph' in result) expect(result.graph.stats.bytes).toBeGreaterThan(5_000_000);
  }, 120_000);
});

describe('why a bundle was not read', () => {
  const page = (
    response: { status: number; headers?: Record<string, string>; body?: string } | Error,
  ): Page =>
    ({
      request: {
        get: () =>
          response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve({
                status: () => response.status,
                ok: () => response.status >= 200 && response.status < 300,
                headers: () => response.headers ?? {},
                body: () => Promise.resolve(Buffer.from(response.body ?? '')),
              }),
      },
    }) as unknown as Page;

  it('says too large, redirected, HTTP status or timeout instead of "not readable or too large"', async () => {
    const big = playwrightFetcher(page({ status: 200, headers: { 'content-length': '6400000' } }));
    expect(await big('https://app.example.test/main.js', 2_000_000)).toEqual({
      failure:
        'too large (6.4 MB > limit 2.0 MB: raise staticAnalysis.budgets.maxFileSizeBytes or maxSourceMapBytes)',
    });
    const redirected = playwrightFetcher(page({ status: 302 }));
    expect(await redirected('https://app.example.test/main.js', 2_000_000)).toEqual({
      failure: 'redirected (HTTP 302): redirects are not followed',
    });
    expect(await playwrightFetcher(page({ status: 401 }))('https://app.example.test/main.js', 10)).toEqual({
      failure: 'HTTP 401',
    });
    expect(
      await playwrightFetcher(page(new Error('Timeout 10000ms exceeded')))(
        'https://app.example.test/main.js',
        10,
      ),
    ).toEqual({ failure: 'timed out (10 s)' });
  });

  it('records the reason in the bundle inventory (report « Découverte des sources »)', async () => {
    const runtime = new RuntimeBundleSourceProvider({
      fetch: () => Promise.resolve({ failure: 'too large (6.4 MB > limit 2.0 MB)' }),
      isAllowedUrl: () => true,
      sourceMaps: { enabled: true, inline: true, external: true },
      bundleFallback: true,
      budgets: { maxBundles: 5, maxSourceMaps: 5, maxSourceMapBytes: 5_000_000, maxFileSizeBytes: 2_000_000 },
    });
    runtime.observe('https://app.example.test/main.js');
    await runtime.inventoryPending();
    expect(runtime.inventory.all()[0]).toMatchObject({
      status: 'SKIPPED',
      reason: 'too large (6.4 MB > limit 2.0 MB)',
    });
  });
});
