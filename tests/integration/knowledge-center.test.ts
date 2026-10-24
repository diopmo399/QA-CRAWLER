import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { openKnowledgeCenter, type KnowledgeCenterContext } from '../../src/knowledge-center/context.js';
import { startKnowledgeCenterServer, type RunningServer } from '../../src/knowledge-center/server.js';
import { KnowledgeCenterService } from '../../src/knowledge-center/service.js';

/**
 * KNOWLEDGE CENTER, de bout en bout : deux runs réels avec la persistance fichier et la mémoire
 * historique, puis le tableau de bord lu dans Chromium (navigation, recherche, détail, décision),
 * et la preuve que le dashboard n'altère pas les décisions du moteur : un troisième run, lancé après
 * des décisions humaines dans le Knowledge Center, prend exactement les mêmes décisions.
 */
const PAGES: Record<string, string> = {
  '/': '<h1>Dashboard</h1><a href="/requests">Requests</a> <a href="/reports">Reports</a>',
  '/requests':
    '<h1>Requests</h1><a href="/requests/new">Create</a> <button>Delete</button> <a href="/">Home</a>',
  '/requests/new':
    '<h1>Create request</h1><form><label>Title <input name="title"></label><button type="submit">Save</button></form>',
  '/reports': '<h1>Reports</h1><a href="/">Home</a>',
};

describe('knowledge center, end to end', () => {
  let app: Server;
  let url: string;
  let root: string;
  let context: KnowledgeCenterContext;
  let running: RunningServer;
  let browser: Browser;
  let config: ReturnType<typeof parseConfig>['config'];
  const decisions = (result: ExplorationResult): string[] =>
    result.transitions.map(
      (edge) => `${edge.from} --${edge.action.text ?? edge.actionId}--> ${edge.to} ${edge.result}`,
    );
  let firstDecisions: string[] = [];

  beforeAll(async () => {
    app = createServer((request, response) => {
      const body = PAGES[request.url ?? ''];
      response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body ?? 'Not found'}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((app.address() as AddressInfo).port)}`;
    root = await mkdtemp(path.join(tmpdir(), 'qa-knowledge-center-'));
    ({ config } = parseConfig(
      `
mission: { name: knowledge-center }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 30, actionTimeoutMs: 3000, settleTimeMs: 50 }
knowledge: { file: ${path.join(root, 'knowledge', 'knowledge-base.json')}, application: demo-app, environment: test }
persistence: { enabled: true, provider: file, file: { directory: ${path.join(root, 'memory')} }, flushEvery: 2 }
memory: { enabled: true }
output: { reportsDir: ${path.join(root, 'reports')}, screenshotsDir: ${path.join(root, 'shots')} }
`,
      {},
      {},
    ));
    firstDecisions = decisions((await runMission(config, { env: {}, onWarning: () => undefined })).result);
    await runMission(config, { env: {}, onWarning: () => undefined });
    context = await openKnowledgeCenter(config, { language: 'fr' }, {});
    running = await startKnowledgeCenterServer(new KnowledgeCenterService(context), {
      host: '127.0.0.1',
      port: 0,
    });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
    await running.close();
    await context.close();
    await new Promise((resolve) => app.close(resolve));
  });

  it('shows the real persisted knowledge: metrics, transitions, runs, graph', async () => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/#/overview`);
    await expect.poll(() => page.locator('.card').count()).toBeGreaterThan(5);
    const cards = await page.locator('.card').allInnerTexts();
    const card = (label: string): string => cards.find((text) => text.startsWith(label)) ?? '';
    expect(card('Runs persistés')).toContain('2');
    expect(card('Transitions')).toMatch(/\n\d+\n/);
    expect(card('Runs ayant utilisé la mémoire')).toContain('Non disponible');
    expect(await page.locator('#memory-text').innerText()).toContain('historique préchargé');

    await page.click('a[href="#/flows"]');
    await page.getByRole('tab', { name: /Runs/ }).click();
    await expect.poll(() => page.locator('#flows-body tbody tr').count()).toBe(2);
    await page.getByRole('tab', { name: /Graphe/ }).click();
    await expect.poll(() => page.locator('#graph .node').count()).toBeGreaterThan(2);
    expect(await page.locator('#graph .edge').count()).toBeGreaterThan(2);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('explorer: search, filter, open the detail with its executions, validate, and the ledger is written', async () => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.goto(`${running.url}/#/explorer?type=TRANSITION`);
    await expect.poll(() => page.locator('tr.row').count()).toBeGreaterThan(3);
    await page.fill('#q-text', 'delete');
    await page.press('#q-text', 'Enter');
    await expect.poll(() => page.locator('tr.row').count()).toBe(1);
    await page.locator('tr.row').first().click();
    await expect.poll(() => page.locator('#drawer').getAttribute('data-open')).toBe('true');
    const drawer = await page.locator('#drawer-body').innerText();
    expect(drawer).toContain('transition_knowledge');
    expect(drawer).toContain('EXÉCUTIONS DES DERNIERS RUNS');
    expect(await page.locator('#drawer-body tbody tr').count()).toBeGreaterThanOrEqual(2);
    await page.fill('#d-note', 'bloquée par la politique de sécurité, normal');
    await page.click('[data-decision="VALIDATE"]');
    await expect.poll(() => page.locator('#drawer-body').innerText()).toContain('validée');
    await expect.poll(() => page.locator('tr.row .st.VALIDATED').count()).toBe(1);
    const ledger = JSON.parse(
      await readFile(path.join(root, 'knowledge', 'knowledge-center', 'review-ledger.json'), 'utf8'),
    ) as { entries: { operation: string; after?: { note?: string } }[] };
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      operation: 'VALIDATE',
      after: { note: 'bloquée par la politique de sécurité, normal' },
    });
    await page.goto(`${running.url}/#/history`);
    await expect.poll(() => page.locator('#history-body tbody tr').count()).toBe(1);
    await page.close();
  });

  it('persistence page: real state, counts, export, backup', async () => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.goto(`${running.url}/#/persistence`);
    await expect.poll(() => page.locator('#backup-btn').count()).toBe(1);
    const text = await page.locator('#content').innerText();
    expect(text).toContain('CONNECTED');
    expect(text).toContain(path.join(root, 'memory'));
    expect(text).toMatch(/runs\s*2/);
    await page.click('#backup-btn');
    await expect.poll(() => page.locator('[data-restore]').count()).toBe(1);
    const exported = await page.request.get(
      `${running.url}/api/apps/${encodeURIComponent('demo-app@test')}/export`,
    );
    expect(exported.headers()['content-disposition']).toContain('attachment');
    expect(((await exported.json()) as { persistence: { runs: unknown[] } }).persistence.runs).toHaveLength(
      2,
    );
    await page.close();
  });

  it('the engine decisions are the same after the human decisions and the backup: the dashboard changes nothing', async () => {
    const third = await runMission(config, { env: {}, onWarning: () => undefined });
    expect(decisions(third.result)).toEqual(firstDecisions);
    expect(third.result.persistence?.memory.mode).toBe('historical');
  });
});
