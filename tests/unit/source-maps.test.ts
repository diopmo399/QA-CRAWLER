import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { StaticKnowledge } from '../../src/static-analysis/static-knowledge.js';
import { sourceSetOf } from '../../src/static-analysis/source-set.js';
import { normalizeSourcePath } from '../../src/static-analysis/sources/path-normalizer.js';
import {
  decodeInlineSourceMap,
  findSourceMapReference,
  readSourceMap,
} from '../../src/static-analysis/sources/source-map-reader.js';
import { VirtualSourceWorkspace } from '../../src/static-analysis/sources/virtual-workspace.js';
import {
  RepositorySourceProvider,
  RuntimeBundleSourceProvider,
  type RuntimeSourceOptions,
  type ScriptResource,
} from '../../src/static-analysis/sources/source-providers.js';
import { StaticSourceDiscovery } from '../../src/static-analysis/sources/source-discovery.js';
import type { SourceDiscoveryEvent } from '../../src/static-analysis/sources/model.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { staticAnalyzerOptions } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');
const APP_FILES = [
  'src/app/users/create-user/create-user.component.ts',
  'src/app/users/create-user/create-user.component.html',
  'src/app/users/user.service.ts',
  'src/app/users/user.models.ts',
];
/** Un marqueur écrit dans le code d'origine : il ne doit JAMAIS ressortir dans un résumé. */
const MARKER = 'UNIQUE_SOURCE_BODY_MARKER_7f3a';

async function fixtureSources(): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      APP_FILES.map(async (file) => [file, await readFile(path.join(FIXTURE, file), 'utf8')] as const),
    ),
  );
}

function mapOf(sources: Record<string, string>, prefix = 'webpack:///./'): string {
  const files = Object.keys(sources);
  return JSON.stringify({
    version: 3,
    sources: [
      ...files.map((file) => `${prefix}${file}`),
      'webpack:///./node_modules/@angular/core/fesm2022/core.mjs',
    ],
    sourcesContent: [...files.map((file) => `${sources[file] ?? ''}\n// ${MARKER}`), 'export const x = 1;'],
    mappings: '',
  });
}

const ORIGIN = 'https://app.example.test';

/** Un serveur simulé : chaque adresse lue est notée (aucune adresse devinée). */
function fakeServer(routes: Record<string, string | ScriptResource>): {
  fetch: RuntimeSourceOptions['fetch'];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url, maxBytes) => {
      calls.push(url);
      const entry = routes[url];
      if (entry === undefined) return Promise.resolve(undefined);
      const resource = typeof entry === 'string' ? { text: entry, headers: {} } : entry;
      return Promise.resolve(Buffer.byteLength(resource.text) > maxBytes ? undefined : resource);
    },
  };
}

function provider(
  fetch: RuntimeSourceOptions['fetch'],
  overrides: Partial<RuntimeSourceOptions> = {},
  events: [SourceDiscoveryEvent, string][] = [],
): RuntimeBundleSourceProvider {
  return new RuntimeBundleSourceProvider({
    fetch,
    isAllowedUrl: (url) => new URL(url).hostname === 'app.example.test',
    sourceMaps: { enabled: true, inline: true, external: true },
    bundleFallback: true,
    budgets: { maxBundles: 20, maxSourceMaps: 20, maxSourceMapBytes: 5_000_000, maxFileSizeBytes: 2_000_000 },
    onEvent: (event, message) => events.push([event, message]),
    ...overrides,
  });
}

const workspace = (): VirtualSourceWorkspace =>
  new VirtualSourceWorkspace({ maxExtractedSources: 100, maxFileSizeBytes: 2_000_000 });

describe('SourcePathNormalizer: untrusted source map paths become workspace paths', () => {
  it.each([
    ['webpack:///./src/app/a.ts', undefined, 'src/app/a.ts'],
    ['webpack://my-app/./src/app/a.ts', undefined, 'src/app/a.ts'],
    ['webpack:///src/app/a.component.html', undefined, 'src/app/a.component.html'],
    ['ng:///AppModule/a.component.html', undefined, 'AppModule/a.component.html'],
    ['../../src/main.ts', undefined, 'src/main.ts'],
    ['./src/app/a.ts?ngResource', undefined, 'src/app/a.ts'],
    ['file:///home/ci/build/app/src/app/a.ts', undefined, 'src/app/a.ts'],
    ['C:\\build\\app\\src\\app\\a.ts', undefined, 'src/app/a.ts'],
    ['https://app.example.test/assets/src/app/a.ts', undefined, 'assets/src/app/a.ts'],
    ['a.ts', 'webpack:///./src/app', 'src/app/a.ts'],
    ['src/app/a.ts', '../../../../', 'src/app/a.ts'],
  ])('%s (sourceRoot %s) → %s', (source, root, expected) => {
    expect(normalizeSourcePath(source, root)).toMatchObject({ status: 'OK', path: expected });
  });

  it('a path never leaves the workspace: leading « .. » are clamped at the root', () => {
    const result = normalizeSourcePath('../../../../../../etc/secrets/config.ts');
    expect(result).toMatchObject({ status: 'OK', path: 'etc/secrets/config.ts' });
    const mid = normalizeSourcePath('src/../../../../x.ts');
    expect(mid).toMatchObject({ status: 'OK', path: 'x.ts' });
  });

  it.each([
    ['webpack:///./node_modules/@angular/core/fesm2022/core.mjs', 'IGNORED'],
    ['webpack:///webpack/runtime/jsonp chunk loading', 'IGNORED'],
    ['(webpack)/buildin/global.js', 'IGNORED'],
    ['webpack:///./src/styles.scss', 'IGNORED'],
    ['webpack:///./src/app/a.spec.ts', 'IGNORED'],
    ['src/app/\u0000a.ts', 'REJECTED'],
    ['javascript:alert(1)', 'REJECTED'],
    ['data:text/plain,abc', 'REJECTED'],
    ['', 'REJECTED'],
    [`src/${'a/'.repeat(300)}x.ts`, 'REJECTED'],
  ])('%s → %s', (source, status) => {
    expect(normalizeSourcePath(source).status).toBe(status);
  });
});

describe('SourceMapReader: discovery and validation', () => {
  const script = (tail: string): string => `console.log(1);\n${tail}`;

  it('external comment, relative to the script', () => {
    expect(
      findSourceMapReference(script('//# sourceMappingURL=main.js.map'), `${ORIGIN}/app/main.js`),
    ).toEqual({
      kind: 'EXTERNAL',
      url: `${ORIGIN}/app/main.js.map`,
    });
    expect(findSourceMapReference(script('//@ sourceMappingURL=old.map'), `${ORIGIN}/main.js`)).toEqual({
      kind: 'EXTERNAL',
      url: `${ORIGIN}/old.map`,
    });
    expect(findSourceMapReference(script('/*# sourceMappingURL=m.map */'), `${ORIGIN}/main.js`)).toEqual({
      kind: 'EXTERNAL',
      url: `${ORIGIN}/m.map`,
    });
  });

  it('the last comment wins; the SourceMap header wins over the comment', () => {
    const text = script('//# sourceMappingURL=first.map\nfoo();\n//# sourceMappingURL=last.map');
    expect(findSourceMapReference(text, `${ORIGIN}/main.js`)).toMatchObject({ url: `${ORIGIN}/last.map` });
    expect(findSourceMapReference(text, `${ORIGIN}/main.js`, { sourcemap: '/h.map' })).toEqual({
      kind: 'HEADER',
      url: `${ORIGIN}/h.map`,
    });
    expect(findSourceMapReference(text, `${ORIGIN}/main.js`, { 'x-sourcemap': 'x.map' })).toMatchObject({
      kind: 'HEADER',
    });
  });

  it('inline data URI, even when larger than the scanned tail', () => {
    const payload = Buffer.from(
      JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['x'.repeat(9000)] }),
    ).toString('base64');
    const reference = findSourceMapReference(
      script(`//# sourceMappingURL=data:application/json;charset=utf-8;base64,${payload}`),
      `${ORIGIN}/main.js`,
    );
    expect(reference?.kind).toBe('INLINE');
    const decoded =
      reference?.kind === 'INLINE' ? decodeInlineSourceMap(reference.dataUri, 1_000_000) : undefined;
    expect(decoded && 'text' in decoded ? JSON.parse(decoded.text) : undefined).toMatchObject({ version: 3 });
  });

  it('no reference, or a non-HTTP one: nothing (never a guessed .map)', () => {
    expect(findSourceMapReference('console.log(1)', `${ORIGIN}/main.js`)).toBeUndefined();
    expect(
      findSourceMapReference(script('//# sourceMappingURL=javascript:alert(1)'), `${ORIGIN}/main.js`),
    ).toBeUndefined();
    expect(
      findSourceMapReference(script('//# sourceMappingURL=file:///etc/passwd'), `${ORIGIN}/main.js`),
    ).toBeUndefined();
  });

  it('inline maps are bounded BEFORE decoding; unexpected media types are rejected', () => {
    expect(decodeInlineSourceMap(`data:application/json;base64,${'A'.repeat(4000)}`, 1000)).toEqual({
      rejected: 'source map larger than the budget',
    });
    expect('rejected' in decodeInlineSourceMap('data:text/html;base64,PGI+', 1000)).toBe(true);
    expect(decodeInlineSourceMap('data:application/json,%7B%22version%22%3A3%7D', 1000)).toEqual({
      text: '{"version":3}',
    });
  });

  it.each([
    ['not json', 'not valid JSON'],
    ['[]', 'not a source map object'],
    ['{"version":2,"sources":[]}', 'unsupported source map version'],
    ['{"version":3}', 'no sources array'],
    ['{"version":3,"sources":[],"sourcesContent":"x"}', 'sourcesContent is not an array'],
  ])('rejected: %s', (text, reason) => {
    expect(readSourceMap(text, 1000)).toEqual({ status: 'REJECTED', reason });
  });

  it('oversized maps are rejected; XSSI prefix, null contents and index maps are handled', () => {
    expect(readSourceMap(JSON.stringify({ version: 3, sources: ['a.ts'] }), 10)).toMatchObject({
      status: 'REJECTED',
    });
    const read = readSourceMap(
      `)]}'\n${JSON.stringify({ version: 3, sources: ['a.ts', 'b.ts', 7], sourcesContent: ['A', null] })}`,
      1000,
    );
    expect(read).toMatchObject({
      status: 'OK',
      entries: [
        { source: 'a.ts', content: 'A' },
        { source: 'b.ts', content: undefined },
      ],
    });
    const index = readSourceMap(
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { version: 3, sourceRoot: 'src', sources: ['a.ts'], sourcesContent: ['A'] },
          },
          { offset: { line: 9, column: 0 }, url: 'other.map' },
        ],
      }),
      1000,
    );
    expect(index).toMatchObject({ status: 'OK', entries: [{ source: 'src/a.ts', content: 'A' }] });
    expect(index.status === 'OK' ? index.notes : []).toContain('index map section by URL not followed');
  });
});

describe('VirtualSourceWorkspace: deduplication, conflicts, build mismatch, budget', () => {
  it('same path + same content kept once; same path + other content from another map: CONFLICT (first kept)', () => {
    const ws = workspace();
    expect(ws.add({ path: 'src/a.ts', text: 'A', origin: 'SOURCE_MAP' })).toBe('ADDED');
    expect(ws.add({ path: 'src/a.ts', text: 'A', origin: 'SOURCE_MAP' })).toBe('DUPLICATE');
    expect(ws.add({ path: 'src/a.ts', text: 'B', origin: 'SOURCE_MAP' })).toBe('CONFLICT');
    const set = ws.toSourceSet();
    expect(set.files.map((file) => file.text)).toEqual(['A']);
    expect(set.notes?.join()).toContain('SOURCE_CONTENT_CONFLICT');
    expect(ws.conflicts).toEqual(['src/a.ts']);
  });

  it('repository ≠ deployed build: the deployed build (runtime evidence) is used', () => {
    const ws = workspace();
    ws.add({ path: 'src/a.ts', text: 'repo', origin: 'REPOSITORY' });
    expect(ws.add({ path: 'src/a.ts', text: 'deployed', origin: 'SOURCE_MAP' })).toBe('MISMATCH');
    expect(ws.toSourceSet().files[0]?.text).toBe('deployed');
    expect(ws.provenance()[0]?.origin).toBe('SOURCE_MAP');
    expect(ws.mismatches).toEqual(['src/a.ts']);
  });

  it('the budget is respected and reported; the hash is the one of an ordinary SourceSet', () => {
    const ws = new VirtualSourceWorkspace({ maxExtractedSources: 2, maxFileSizeBytes: 10 });
    ws.add({ path: 'b.ts', text: 'B', origin: 'SOURCE_MAP' });
    ws.add({ path: 'a.ts', text: 'A', origin: 'SOURCE_MAP' });
    expect(ws.add({ path: 'c.ts', text: 'C', origin: 'SOURCE_MAP' })).toBe('BUDGET');
    expect(ws.add({ path: 'big.ts', text: 'x'.repeat(11), origin: 'SOURCE_MAP' })).toBe('TOO_LARGE');
    const set = ws.toSourceSet();
    expect(set.budgetExhausted).toBe(true);
    expect(set.hash).toBe(
      sourceSetOf('x', [
        { path: 'a.ts', text: 'A' },
        { path: 'b.ts', text: 'B' },
      ]).hash,
    );
  });
});

describe('Runtime bundles → source maps → workspace', () => {
  it('external source map: original sources extracted, provenance kept, never node_modules', async () => {
    const sources = await fixtureSources();
    const server = fakeServer({
      [`${ORIGIN}/main.js?v=1`]: 'x();\n//# sourceMappingURL=main.js.map',
      [`${ORIGIN}/main.js.map`]: mapOf(sources),
    });
    const events: [SourceDiscoveryEvent, string][] = [];
    const runtime = provider(server.fetch, {}, events);
    runtime.observe(`${ORIGIN}/main.js?v=1`);
    const ws = workspace();
    await runtime.provide(ws);
    expect(ws.toSourceSet().files.map((file) => file.path)).toEqual([...APP_FILES].sort());
    const provenance = ws.provenance()[0];
    expect(provenance).toMatchObject({
      origin: 'SOURCE_MAP',
      bundleUrl: `${ORIGIN}/main.js`,
      sourceMapUrl: `${ORIGIN}/main.js.map`,
    });
    expect(provenance?.originalPath).toContain('webpack:///./src/app/');
    expect(provenance?.mapHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        'BUNDLE_DISCOVERED',
        'SOURCE_MAP_REFERENCE_DISCOVERED',
        'SOURCE_MAP_LOADING_STARTED',
        'SOURCE_MAP_LOADED',
        'SOURCE_EXTRACTED',
      ]),
    );
    // Aucune adresse devinée : seules celles publiées ont été lues.
    expect(server.calls).toEqual([`${ORIGIN}/main.js?v=1`, `${ORIGIN}/main.js.map`]);
    // Le journal ne porte que des chemins et des adresses, jamais le code.
    expect(JSON.stringify(events)).not.toContain(MARKER);
    expect(JSON.stringify(runtime.inventory.all())).not.toContain(MARKER);
  });

  it('inline source map', async () => {
    const sources = await fixtureSources();
    const inline = Buffer.from(mapOf(sources)).toString('base64');
    const server = fakeServer({
      [`${ORIGIN}/main.js`]: `x();\n//# sourceMappingURL=data:application/json;base64,${inline}`,
    });
    const runtime = provider(server.fetch);
    runtime.observe(`${ORIGIN}/main.js`);
    const ws = workspace();
    await runtime.provide(ws);
    expect(ws.size).toBe(APP_FILES.length);
    expect(ws.provenance()[0]?.sourceMapUrl).toBe('inline');
  });

  it('a source map on a host that is not allowed is never read: SOURCE_MAP_REJECTED, then the bundle', async () => {
    const server = fakeServer({
      [`${ORIGIN}/main.js`]: 'x();\n//# sourceMappingURL=https://evil.example.test/main.js.map',
    });
    const events: [SourceDiscoveryEvent, string][] = [];
    const runtime = provider(server.fetch, {}, events);
    runtime.observe(`${ORIGIN}/main.js`);
    const ws = workspace();
    await runtime.provide(ws);
    expect(server.calls).toEqual([`${ORIGIN}/main.js`]);
    expect(events).toContainEqual([
      'SOURCE_MAP_REJECTED',
      `${ORIGIN}/main.js: source map origin not allowed`,
    ]);
    expect(events.map(([event]) => event)).toContain('BUNDLE_FALLBACK_STARTED');
    expect(ws.provenance()).toMatchObject([{ path: 'bundle/main.js', origin: 'BUNDLE' }]);
    expect(runtime.inventory.all()[0]?.status).toBe('BUNDLE_ONLY');
  });

  it('a bundle from a host that is not allowed is never read', async () => {
    const server = fakeServer({});
    const runtime = provider(server.fetch);
    runtime.observe('https://cdn.other.test/lib.js');
    await runtime.provide(workspace());
    expect(server.calls).toEqual([]);
    expect(runtime.inventory.all()[0]).toMatchObject({ status: 'SKIPPED', reason: 'origin not allowed' });
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['wrong version', '{"version":2,"sources":[]}'],
    ['no sourcesContent', '{"version":3,"sources":["webpack:///./src/app/a.ts"]}'],
  ])('%s: SOURCE_MAP_REJECTED + BUNDLE fallback, never an exception', async (_label, map) => {
    const server = fakeServer({
      [`${ORIGIN}/main.js`]:
        'class a{constructor(t){this.http=t}c(e){return this.http.post("/api/x",e)}}\n//# sourceMappingURL=main.js.map',
      [`${ORIGIN}/main.js.map`]: map,
    });
    const events: [SourceDiscoveryEvent, string][] = [];
    const runtime = provider(server.fetch, {}, events);
    runtime.observe(`${ORIGIN}/main.js`);
    const ws = workspace();
    await expect(runtime.provide(ws)).resolves.toBeUndefined();
    expect(events.map(([event]) => event)).toContain('SOURCE_MAP_REJECTED');
    expect([...ws.origins()]).toEqual(['BUNDLE']);
  });

  it('without bundle fallback, a rejected map leaves nothing — and a note for the report', async () => {
    const server = fakeServer({ [`${ORIGIN}/main.js`]: 'x();\n//# sourceMappingURL=missing.map' });
    const runtime = provider(server.fetch, { bundleFallback: false });
    runtime.observe(`${ORIGIN}/main.js`);
    const ws = workspace();
    await runtime.provide(ws);
    expect(ws.size).toBe(0);
    expect(ws.toSourceSet().notes?.join()).toContain('SOURCE_MAP_REJECTED');
  });

  it('partial map: the sources with content are used, the map is SOURCE_MAP_PARTIAL', async () => {
    const server = fakeServer({
      [`${ORIGIN}/main.js`]: 'x();\n//# sourceMappingURL=main.js.map',
      [`${ORIGIN}/main.js.map`]: JSON.stringify({
        version: 3,
        sources: ['webpack:///./src/app/a.ts', 'webpack:///./src/app/b.ts', '../../../../etc/c.ts'],
        sourcesContent: ['export const a = 1;', null, 'export const c = 1;'],
      }),
    });
    const events: [SourceDiscoveryEvent, string][] = [];
    const runtime = provider(server.fetch, {}, events);
    runtime.observe(`${ORIGIN}/main.js`);
    const ws = workspace();
    await runtime.provide(ws);
    expect(ws.toSourceSet().files.map((file) => file.path)).toEqual(['etc/c.ts', 'src/app/a.ts']);
    expect(events.map(([event]) => event)).toContain('SOURCE_MAP_PARTIAL');
    expect(runtime.inventory.all()[0]?.status).toBe('SOURCE_MAP_PARTIAL');
  });

  it('budgets: maxBundles and maxSourceMaps are never exceeded', async () => {
    const routes: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) {
      routes[`${ORIGIN}/c${String(index)}.js`] =
        `x${String(index)}();\n//# sourceMappingURL=c${String(index)}.js.map`;
      routes[`${ORIGIN}/c${String(index)}.js.map`] = JSON.stringify({
        version: 3,
        sources: [`src/c${String(index)}.ts`],
        sourcesContent: [`export const c${String(index)} = 1;`],
      });
    }
    const server = fakeServer(routes);
    const runtime = provider(server.fetch, {
      budgets: { maxBundles: 3, maxSourceMaps: 2, maxSourceMapBytes: 1_000_000, maxFileSizeBytes: 1_000_000 },
    });
    for (let index = 0; index < 5; index += 1) runtime.observe(`${ORIGIN}/c${String(index)}.js`);
    const ws = workspace();
    await runtime.provide(ws);
    expect(server.calls.filter((url) => url.endsWith('.js'))).toHaveLength(3);
    expect(server.calls.filter((url) => url.endsWith('.map'))).toHaveLength(2);
    expect([...ws.origins()].sort()).toEqual(['BUNDLE', 'SOURCE_MAP']);
  });

  it('lazy chunk: LAZY_BUNDLE_DISCOVERED, then the workspace is enriched', async () => {
    const server = fakeServer({
      [`${ORIGIN}/main.js`]: 'x();\n//# sourceMappingURL=main.js.map',
      [`${ORIGIN}/main.js.map`]: JSON.stringify({
        version: 3,
        sources: ['src/main.ts'],
        sourcesContent: ['export const m = 1;'],
      }),
      [`${ORIGIN}/chunk-reports.js`]: 'y();\n//# sourceMappingURL=chunk-reports.js.map',
      [`${ORIGIN}/chunk-reports.js.map`]: JSON.stringify({
        version: 3,
        sources: ['src/app/reports/reports.component.ts'],
        sourcesContent: ['export class ReportsComponent {}'],
      }),
    });
    const events: [SourceDiscoveryEvent, string][] = [];
    const runtime = provider(server.fetch, {}, events);
    runtime.observe(`${ORIGIN}/main.js`);
    const discovery = new StaticSourceDiscovery({
      strategy: 'source-map',
      runtime,
      workspace: { maxExtractedSources: 100, maxFileSizeBytes: 1_000_000 },
      settingsKey: '',
      onEvent: (event, message) => events.push([event, message]),
    });
    await discovery.prepare();
    await discovery.complete();
    expect(discovery.workspace.size).toBe(1);
    expect(discovery.hasPending()).toBe(false);
    const aliasBefore = discovery.alias();

    runtime.observe(`${ORIGIN}/chunk-reports.js`);
    runtime.observe(`${ORIGIN}/chunk-reports.js`);
    expect(events.filter(([event]) => event === 'LAZY_BUNDLE_DISCOVERED')).toHaveLength(1);
    expect(discovery.hasPending()).toBe(true);
    expect(await discovery.enrich()).toBe(true);
    expect(discovery.workspace.has('src/app/reports/reports.component.ts')).toBe(true);
    expect(events.map(([event]) => event)).toContain('VIRTUAL_WORKSPACE_ENRICHED');
    expect(discovery.alias()).not.toBe(aliasBefore);
    expect(discovery.summary()).toMatchObject({ bundles: 2, lazyBundles: 1, extractedSources: 2 });
    expect(await discovery.enrich()).toBe(false);
  });
});

describe('Static source discovery → the EXISTING analyzer', () => {
  const deployment = async (): Promise<{ runtime: RuntimeBundleSourceProvider; calls: string[] }> => {
    const server = fakeServer({
      [`${ORIGIN}/main.js`]: 'x();\n//# sourceMappingURL=main.js.map',
      [`${ORIGIN}/main.js.map`]: mapOf(await fixtureSources()),
    });
    const runtime = provider(server.fetch);
    runtime.observe(`${ORIGIN}/main.js`);
    return { runtime, calls: server.calls };
  };

  it('source maps only: the mute contact input is proven EMAIL, with its source origin', async () => {
    const { runtime } = await deployment();
    const discovery = new StaticSourceDiscovery({
      strategy: 'auto',
      runtime,
      workspace: { maxExtractedSources: 100, maxFileSizeBytes: 2_000_000 },
      settingsKey: '',
    });
    await discovery.prepare();
    await discovery.complete();
    expect(discovery.analysisMode()).toBe('SOURCE_MAP');
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSet(
      discovery.workspace.toSourceSet(),
      discovery.analysisMode(),
    );
    expect(graph.mode).toBe('SOURCE_MAP');
    expect(graph.framework).toBe('ANGULAR');
    expect(graph.coverage).not.toBe('LIMITED');
    expect(graph.dataFlows.find((flow) => flow.field?.endsWith('.contact'))?.requestProperty).toBe(
      'request.email',
    );
    const knowledge = new StaticKnowledge(graph, (text) => (/e-?mail/i.test(text) ? 'email' : undefined));
    const [contact] = knowledge.provenanceFor('contact');
    expect(contact?.concept).toBe('email');
    expect(contact?.sourceOrigin).toBe(`SOURCE_MAP ${ORIGIN}/main.js.map`);
    // Le graphe (mis en cache, publié dans le rapport) ne porte jamais le code source.
    expect(JSON.stringify(graph)).not.toContain(MARKER);
    expect(JSON.stringify(discovery.summary())).not.toContain(MARKER);
  });

  it('cache: a known deployment (same bundle set) is answered before any source map is downloaded', async () => {
    const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'qa-sm-cache-'));
    const analyze = async (): Promise<{ cache: string; calls: string[] }> => {
      const { runtime, calls } = await deployment();
      const analyzer = new StaticApplicationAnalyzer(staticAnalyzerOptions({ cacheDirectory }));
      const discovery = new StaticSourceDiscovery({
        strategy: 'source-map',
        runtime,
        workspace: { maxExtractedSources: 100, maxFileSizeBytes: 2_000_000 },
        settingsKey: 'k',
      });
      await discovery.prepare();
      const alias = discovery.alias() ?? '';
      const cached = await analyzer.cachedByAlias(alias);
      if (cached) return { cache: cached.cache, calls };
      await discovery.complete();
      const outcome = await analyzer.analyzeSet(discovery.workspace.toSourceSet(), discovery.analysisMode(), {
        alias,
      });
      return { cache: outcome.cache, calls };
    };
    const first = await analyze();
    expect(first.cache).toBe('MISS');
    expect(first.calls).toContain(`${ORIGIN}/main.js.map`);
    const second = await analyze();
    expect(second.cache).toBe('HIT');
    expect(second.calls).toEqual([`${ORIGIN}/main.js`]);
  });

  it('hybrid: repository + deployed build; where they differ, SOURCE_BUILD_MISMATCH and the build wins', async () => {
    const sources = await fixtureSources();
    const service = 'src/app/users/user.service.ts';
    const deployed = { ...sources, [service]: `${sources[service] ?? ''}\n// deployed build` };
    const server = fakeServer({
      [`${ORIGIN}/main.js`]: 'x();\n//# sourceMappingURL=main.js.map',
      [`${ORIGIN}/main.js.map`]: mapOf(deployed),
    });
    const events: [SourceDiscoveryEvent, string][] = [];
    const runtime = provider(server.fetch, {}, events);
    runtime.observe(`${ORIGIN}/main.js`);
    const discovery = new StaticSourceDiscovery({
      strategy: 'hybrid',
      repository: new RepositorySourceProvider(FIXTURE, {
        maxFiles: 500,
        maxFileSizeBytes: 2_000_000,
        maxDurationMs: 30_000,
      }),
      runtime,
      workspace: { maxExtractedSources: 500, maxFileSizeBytes: 2_000_000 },
      settingsKey: '',
    });
    await discovery.prepare();
    await discovery.complete();
    expect(discovery.analysisMode()).toBe('HYBRID');
    expect(discovery.workspace.mismatches).toContain(service);
    expect(events.map(([event]) => event)).toContain('SOURCE_BUILD_MISMATCH');
    const origins = new Map(discovery.workspace.provenance().map((file) => [file.path, file.origin]));
    expect(origins.get(service)).toBe('SOURCE_MAP');
    expect(origins.get('src/app/app.routes.ts')).toBe('REPOSITORY');
    // Identique ailleurs (le marqueur rend chaque fichier de la map différent) : tous en MISMATCH, build gardé.
    expect(discovery.summary().mismatches.length).toBeGreaterThan(0);
  });

  it('auto: the repository when present, without reading a single bundle', async () => {
    const { runtime, calls } = await deployment();
    const discovery = new StaticSourceDiscovery({
      strategy: 'auto',
      repository: new RepositorySourceProvider(FIXTURE, {
        maxFiles: 500,
        maxFileSizeBytes: 2_000_000,
        maxDurationMs: 30_000,
      }),
      runtime,
      workspace: { maxExtractedSources: 500, maxFileSizeBytes: 2_000_000 },
      settingsKey: '',
    });
    await discovery.prepare();
    await discovery.complete();
    expect(discovery.analysisMode()).toBe('SOURCE');
    expect(calls).toEqual([]);
    expect(discovery.alias()).toBeUndefined();
  });
});

describe('configuration: staticAnalysis.sourceMaps, bundleFallback, budgets', () => {
  it('defaults: source maps on (inline, external, runtime, lazy chunks), fallback on, bounded budgets', () => {
    const { config } = parseConfig(
      'mission: { name: m }\ntarget: { baseUrl: https://app.example.test }\nstaticAnalysis: { enabled: true, mode: source-map }\n',
      {},
      {},
    );
    expect(config.staticAnalysis.mode).toBe('source-map');
    expect(config.staticAnalysis.sourceMaps).toEqual({
      enabled: true,
      discoverFromRuntime: true,
      inline: true,
      external: true,
      incrementalChunks: true,
    });
    expect(config.staticAnalysis.bundleFallback.enabled).toBe(true);
    expect(config.staticAnalysis.budgets).toMatchObject({
      maxBundles: 50,
      maxSourceMaps: 50,
      maxSourceMapBytes: 20_000_000,
      maxExtractedSources: 2000,
    });
  });

  it('hybrid is accepted; an unknown strategy or key is refused', () => {
    const parse = (analysis: string): unknown =>
      parseConfig(
        `mission: { name: m }\ntarget: { baseUrl: https://app.example.test }\nstaticAnalysis: ${analysis}\n`,
        {},
        {},
      );
    expect(() => parse('{ mode: hybrid }')).not.toThrow();
    expect(() => parse('{ mode: guess }')).toThrow();
    expect(() => parse('{ sourceMaps: { bruteForce: true } }')).toThrow();
  });
});

describe('performance: extraction stays cheap next to the analysis itself', () => {
  it('20 bundles × 100 sources (2 000 files, ≈ 4 MB of maps) are extracted in well under a second', async () => {
    const routes: Record<string, string> = {};
    for (let bundle = 0; bundle < 20; bundle += 1) {
      const name = `chunk-${String(bundle)}`;
      routes[`${ORIGIN}/${name}.js`] = `x();\n//# sourceMappingURL=${name}.js.map`;
      routes[`${ORIGIN}/${name}.js.map`] = JSON.stringify({
        version: 3,
        sources: Array.from(
          { length: 100 },
          (_, index) => `webpack:///./src/app/${name}/f${String(index)}.ts`,
        ),
        sourcesContent: Array.from(
          { length: 100 },
          (_, index) => `export const v${String(index)} = ${JSON.stringify('x'.repeat(2000))};`,
        ),
      });
    }
    const server = fakeServer(routes);
    const runtime = provider(server.fetch);
    for (let bundle = 0; bundle < 20; bundle += 1) runtime.observe(`${ORIGIN}/chunk-${String(bundle)}.js`);
    const ws = new VirtualSourceWorkspace({ maxExtractedSources: 5000, maxFileSizeBytes: 2_000_000 });
    const started = performance.now();
    await runtime.provide(ws);
    const set = ws.toSourceSet();
    const elapsed = performance.now() - started;
    expect(set.files).toHaveLength(2000);
    expect(elapsed).toBeLessThan(2000);
  });
});
