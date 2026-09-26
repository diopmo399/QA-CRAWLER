import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission, type RunOutcome } from '../../src/orchestrator.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/** Error detection and safety on a site full of deliberate bugs and traps. */
describe('FlowExplorer on the trap site', () => {
  let site: TestSite;
  let outcome: RunOutcome;
  let result: ExplorationResult;

  beforeAll(async () => {
    site = await startTestSite();
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-traps-'));
    const { config } = parseConfig(
      `
mission: { name: traps }
target: { baseUrl: ${site.url} }
exploration: { maxStates: 40, maxActions: 120, maxDurationMinutes: 3, actionTimeoutMs: 5000, settleTimeMs: 150 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    outcome = await runMission(config);
    result = outcome.result;
  });

  afterAll(async () => {
    await site.close();
  });

  it('detects every planted anomaly with its severity', () => {
    const find = (predicate: (issue: ExplorationResult['issues'][number]) => boolean) =>
      result.issues.find(predicate);
    expect(find((issue) => issue.type === 'BROKEN_LINK' && issue.status === 404)?.severity).toBe('ERROR');
    expect(find((issue) => issue.type === 'BROKEN_LINK' && issue.status === 500)?.severity).toBe('ERROR');
    expect(find((issue) => issue.type === 'HTTP' && issue.status === 500)).toMatchObject({
      severity: 'ERROR',
      method: 'GET',
    });
    expect(find((issue) => issue.type === 'PAGE_ERROR')?.message).toContain('undefinedFunction');
    expect(find((issue) => issue.type === 'CONSOLE')?.message).toContain('Payment widget failed');
    expect(find((issue) => issue.type === 'NAVIGATION')?.message).toMatch(/redirect loop/i);
    expect(outcome.passed).toBe(false);
  });

  it('attributes each anomaly to a state, the action that triggered it and the flow', () => {
    for (const issue of result.issues) {
      expect(issue.stateId, issue.message).toBeDefined();
      expect(issue.flow?.length, issue.message).toBeGreaterThan(0);
    }
    const api = result.issues.find((issue) => issue.type === 'HTTP');
    expect(api?.actionId).toBeDefined();
    expect(result.transitions.find((edge) => edge.actionId === api?.actionId)?.action.text).toBe(
      'Appel API en échec',
    );
  });

  it('never reaches destructive endpoints, external sites or downloads', () => {
    expect(site.dangerousHits).toEqual([]);
    expect(site.requests.some((request) => /logout|delete|\.pdf/.test(request))).toBe(false);
    expect(result.states.some((state) => state.url.includes('external.example.com'))).toBe(false);
    const blocked = result.transitions
      .filter((edge) => edge.result === 'BLOCKED')
      .map((edge) => edge.action.text);
    expect(blocked).toEqual(
      expect.arrayContaining([
        'Supprimer',
        'Supprimer tout',
        'Enregistrer',
        'Site externe',
        'Rapport PDF',
        '⚙',
      ]),
    );
  });

  it('follows client-side redirects and SPA navigation', () => {
    expect(result.states.some((state) => state.url.includes('/about?from=guard'))).toBe(true);
    expect(result.states.some((state) => state.url.endsWith('/spa/details'))).toBe(true);
  });

  it('bounds dynamic routes and pagination', () => {
    expect(result.states.filter((state) => state.route === '/users/:id').length).toBeLessThanOrEqual(3);
    expect(result.states.filter((state) => state.route.startsWith('/products')).length).toBeLessThanOrEqual(
      3,
    );
  });

  it('records form fields and their constraints', () => {
    const signup = result.states.flatMap((state) => state.forms).find((form) => form.elementId === 'signup');
    const field = (name: string) => signup?.fields.find((candidate) => candidate.name === name);
    expect(field('email')).toMatchObject({ type: 'email', required: true, maxLength: 80 });
    expect(field('age')).toMatchObject({ type: 'number', min: '18', max: '99' });
    expect(field('password')).toMatchObject({ type: 'password', required: true, minLength: 8 });
  });

  it('keeps secrets out of the reports', async () => {
    for (const file of [result.artifacts.json, result.artifacts.html, result.artifacts.flowGraph]) {
      const text = await readFile(file ?? '', 'utf8');
      expect(text).not.toContain('SECRETTOKEN123');
      expect(text).not.toContain('abc123supersecret');
    }
  });
});
