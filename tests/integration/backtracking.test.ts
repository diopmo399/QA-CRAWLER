import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Dashboard
 * ├── Users
 * │   ├── Detail  (une fenêtre ouverte sur place : pas d'URL propre)
 * │   └── Create
 * ├── Settings
 * └── Reports
 */
const PAGES: Record<string, string> = {
  '/': '<h1>Dashboard</h1><a href="/users">Users</a> <a href="/settings">Settings</a> <a href="/reports">Reports</a>',
  '/users': `<h1>Users</h1><a href="/users/new">Create</a>
    <button onclick="document.getElementById('d').style.display='block'">Detail</button>
    <div id="d" role="dialog" aria-label="User detail" style="display:none"><h2>User detail</h2></div>`,
  '/users/new': '<h1>Create user</h1>',
  '/settings': '<h1>Settings</h1>',
  '/reports': '<h1>Reports</h1>',
};

describe('backtracking explores every branch of the tree', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = PAGES[req.url ?? ''];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body ?? 'Not found'}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-tree-'));
    const { config } = parseConfig(
      `
mission: { name: tree }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 30, actionTimeoutMs: 3000, settleTimeMs: 50 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    result = (await runMission(config)).result;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reaches every screen, the in-place dialog included, then stops', () => {
    const names = result.states.map((state) => state.label).sort();
    expect(names).toEqual(['create-user', 'dashboard', 'reports', 'settings', 'users', 'users-user-detail']);
    expect(result.stopReason).toBe('exhausted');
    expect(result.stats.actionsFailed).toBe(0);
  });

  it('goes back only to screens that still have something to explore', () => {
    // 5 transitions ; après chaque feuille, un retour à l'état le plus proche qui a encore du travail.
    expect(result.stats.transitions).toBe(5);
    expect(result.stats.backtracks).toBeLessThanOrEqual(4);
  });
});
