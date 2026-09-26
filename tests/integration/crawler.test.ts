import { access, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { CrawlResult } from '../../src/model/crawl-result.js';
import { runScenario, type RunOutcome } from '../../src/orchestrator.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * End-to-end: real Chromium (headless) crawling the local trap site.
 * Requires Chromium: `npx playwright install chromium`.
 */
describe('crawl of the test site', () => {
  let site: TestSite;
  let outcome: RunOutcome;
  let result: CrawlResult;
  let outputDir: string;

  beforeAll(async () => {
    site = await startTestSite();
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-crawler-it-'));
    const { config } = parseConfig(
      `
name: integration
target:
  baseUrl: ${site.url}
exploration:
  maxPages: 40
  maxDepth: 4
  navigationTimeoutMs: 10000
  settleTimeMs: 200
  clickSafeActions: true
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    outcome = await runScenario(config);
    result = outcome.result;
  });

  afterAll(async () => {
    await site.close();
  });

  const visitedPaths = (): string[] =>
    result.pages.map((page) => new URL(page.url).pathname + new URL(page.url).search);

  it('explores internal pages breadth-first from the start page', () => {
    expect(result.pages[0]?.url).toBe(`${site.url}/`);
    expect(result.pages[0]?.depth).toBe(0);
    expect(visitedPaths()).toEqual(
      expect.arrayContaining(['/', '/users', '/about', '/forms', '/spa', '/users/1']),
    );
    const depths = result.pages.map((page) => page.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  it('follows client-side redirects instead of failing', () => {
    const guarded = result.pages.find((page) => page.url.endsWith('/guarded'));
    expect(guarded?.failed).toBe(false);
    expect(guarded?.finalUrl).toContain('/about?from=guard');
  });

  it('never visits external, ignored, dangerous or download URLs', () => {
    const urls = result.pages.map((page) => page.url);
    expect(urls.some((url) => url.includes('external.example.com'))).toBe(false);
    expect(urls.some((url) => /logout|delete|\.pdf/.test(url))).toBe(false);
    expect(result.stats.linksSkipped).toMatchObject({
      'external-host': expect.any(Number) as number,
      'ignored-path': expect.any(Number) as number,
      'dangerous-url': expect.any(Number) as number,
      'non-html-resource': expect.any(Number) as number,
    });
  });

  it('never triggers destructive endpoints', () => {
    expect(site.dangerousHits).toEqual([]);
    expect(site.requests.some((request) => /logout|delete/.test(request))).toBe(false);
  });

  it('bounds dynamic routes and pagination', () => {
    const userIdPages = result.pages.filter((page) => page.route === '/users/:id');
    expect(userIdPages.length).toBeLessThanOrEqual(2);
    const productPages = result.pages.filter((page) => page.route.startsWith('/products'));
    expect(productPages.length).toBeLessThanOrEqual(2);
    expect(productPages.every((page) => !page.url.includes('utm_source'))).toBe(true);
    expect(result.stats.linksSkipped['route-limit']).toBeGreaterThan(0);
  });

  it('detects the planted anomalies with the expected severity', () => {
    const find = (predicate: (issue: CrawlResult['issues'][number]) => boolean) =>
      result.issues.find(predicate);
    expect(find((issue) => issue.type === 'BROKEN_LINK' && issue.status === 404)).toMatchObject({
      severity: 'ERROR',
    });
    expect(find((issue) => issue.type === 'BROKEN_LINK' && issue.status === 500)).toMatchObject({
      severity: 'ERROR',
    });
    expect(find((issue) => issue.type === 'HTTP' && issue.status === 500)).toMatchObject({
      severity: 'ERROR',
      method: 'GET',
    });
    expect(find((issue) => issue.type === 'PAGE_ERROR')?.message).toContain('undefinedFunction');
    expect(find((issue) => issue.type === 'CONSOLE')?.message).toContain('Payment widget failed');
    expect(find((issue) => issue.type === 'NAVIGATION')?.message).toMatch(/redirect/i);
    expect(outcome.passed).toBe(false);
  });

  it('does not leak secrets into reports', async () => {
    const json = await readFile(result.artifacts.json ?? '', 'utf8');
    const html = await readFile(result.artifacts.html ?? '', 'utf8');
    for (const secret of ['SECRETTOKEN123', 'abc123supersecret']) {
      expect(json).not.toContain(secret);
      expect(html).not.toContain(secret);
    }
    expect(json).toContain('[REDACTED]');
  });

  it('discovers and classifies actions without executing unsafe ones', () => {
    const actions = result.pages.flatMap((page) => page.actions);
    const byText = (text: string) => actions.find((action) => action.text === text);
    expect(byText('Supprimer')?.classification).toBe('DANGEROUS');
    expect(byText('Supprimer tout')?.classification).toBe('DANGEROUS');
    expect(byText('Nouvelle inscription')?.classification).toBe('MUTATION');
    expect(byText('Enregistrer')?.classification).toBe('MUTATION');
    expect(byText('Utilisateurs')).toMatchObject({ type: 'link', classification: 'SAFE' });
    expect(byText('Section routée')).toMatchObject({ type: 'router-link', routerLink: '/spa/routed' });
  });

  it('finds SPA routes through routerLink and SAFE clicks', () => {
    expect(visitedPaths()).toEqual(expect.arrayContaining(['/spa/routed', '/spa/details']));
    expect(result.stats.actionsExecuted).toBeGreaterThan(0);
  });

  it('records form fields and their constraints', () => {
    const signup = result.pages.flatMap((page) => page.forms).find((form) => form.elementId === 'signup');
    expect(signup?.method).toBe('post');
    const field = (name: string) => signup?.fields.find((candidate) => candidate.name === name);
    expect(field('email')).toMatchObject({ type: 'email', required: true, maxLength: 80 });
    expect(field('age')).toMatchObject({ type: 'number', min: '18', max: '99' });
    expect(field('password')).toMatchObject({ type: 'password', required: true, minLength: 8 });
    expect(field('terms')).toMatchObject({ type: 'checkbox', required: true });
    expect(field('plan')?.type).toBe('radio');
    expect(field('country')?.options).toEqual(['France', 'Canada']);
    const search = result.pages.flatMap((page) => page.forms).find((form) => form.isSearchForm);
    expect(search).toBeDefined();
  });

  it('writes the JSON and HTML reports and screenshots', async () => {
    await access(path.join(outputDir, 'reports', 'result.json'));
    await access(path.join(outputDir, 'reports', 'index.html'));
    const json = JSON.parse(
      await readFile(path.join(outputDir, 'reports', 'result.json'), 'utf8'),
    ) as CrawlResult;
    expect(json.scenario).toBe('integration');
    expect(json.pagesVisited).toBe(result.pages.length);
    expect(json.durationMs).toBeGreaterThan(0);

    const shots = await readdir(path.join(outputDir, 'screenshots'));
    expect(shots).toContain('001-home.png');
    expect(shots.some((file) => file.endsWith('-error.png'))).toBe(true);
    for (const file of shots) expect(file).toMatch(/^\d{3}-[a-z0-9-]+\.png$/);

    const html = await readFile(path.join(outputDir, 'reports', 'index.html'), 'utf8');
    expect(html).toContain('integration');
    expect(html).toContain('../screenshots/001-home.png');
  });
});
