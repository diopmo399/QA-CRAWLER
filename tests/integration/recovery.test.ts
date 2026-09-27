import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const PASSWORD = 'pw-never-in-reports-9f3';

/** Pages served to a valid session; a session only lasts a few page loads. */
const PAGES: Record<string, string> = {
  '/': '<h1>Dashboard</h1><a href="/users">Users</a> <a href="/settings">Settings</a> <a href="/reports">Reports</a> <a href="/audit">Audit</a>',
  '/users': `<h1>Users</h1><a href="/users/new">Create</a>
    <button id="flaky" onmouseover="this.style.display='none'">Refresh list</button>`,
  '/users/new': '<h1>Create user</h1>',
  '/settings': '<h1>Settings</h1>',
  '/reports': '<h1>Reports</h1>',
  '/audit': '<h1>Audit</h1>',
};
const LOGIN = `<h1>Sign in</h1><form method="post" action="/login">
  <input id="user" name="user"><input id="pass" name="pass" type="password"><button id="go">Sign in</button></form>`;
const PAGES_PER_SESSION = 4;

describe('recovery: expired session, failing action', () => {
  let server: Server;
  let result: ExplorationResult;
  let logins = 0;
  let reportText = '';

  beforeAll(async () => {
    const sessions = new Map<string, number>();
    server = createServer((req, res) => {
      const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>`,
        );
      };
      const url = req.url ?? '/';
      if (url === '/login' && req.method === 'POST') {
        let form = '';
        req.on('data', (chunk: Buffer) => (form += chunk.toString()));
        req.on('end', () => {
          const values = new URLSearchParams(form);
          if (values.get('user') !== 'tester' || values.get('pass') !== PASSWORD) {
            send(401, LOGIN);
            return;
          }
          logins += 1;
          const sid = `s${logins}`;
          sessions.set(sid, PAGES_PER_SESSION);
          res.writeHead(302, { location: '/', 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
          res.end();
        });
        return;
      }
      if (url === '/login') {
        send(200, LOGIN);
        return;
      }
      const body = PAGES[url];
      if (!body) {
        send(404, 'Not found');
        return;
      }
      const sid = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
      const left = sid ? (sessions.get(sid) ?? 0) : 0;
      if (!sid || left <= 0) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      sessions.set(sid, left - 1);
      send(200, body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-recovery-'));
    const { config } = parseConfig(
      `
mission: { name: recovery }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 30, actionTimeoutMs: 1500, settleTimeMs: 50 }
auth:
  type: form
  loginUrl: /login
  usernameSelector: '#user'
  passwordSelector: '#pass'
  submitSelector: '#go'
  successUrlContains: /
recovery: { maxReauthentications: 5 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    ({ result } = await runMission(config, { env: { QA_USERNAME: 'tester', QA_PASSWORD: PASSWORD } }));
    // Every file written (JSON, HTML, flow graph…), to look for the secret in all of them.
    const files = await readdir(outputDir, { recursive: true, withFileTypes: true });
    const texts = await Promise.all(
      files
        .filter((entry) => entry.isFile() && !entry.name.endsWith('.png'))
        .map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
    );
    expect(texts.length).toBeGreaterThan(1);
    reportText = texts.join('\n');
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('logs in again when the session expires and goes on exploring', () => {
    const labels = result.states.map((state) => state.label);
    for (const screen of ['dashboard', 'users', 'settings', 'reports', 'audit'])
      expect(labels).toContain(screen);
    expect(labels).not.toContain('sign-in');
    expect(logins).toBeGreaterThan(1);
    expect(result.recovery?.reauthentications).toBe(logins - 1);
    expect(
      result.recovery?.events.some((event) => event.strategy === 'reauthenticate' && event.success),
    ).toBe(true);
  });

  it('comes back after a failed action and reports how', () => {
    const failed = result.transitions.find((edge) => edge.result === 'FAILED');
    expect(failed?.action.text).toBe('Refresh list');
    const recovered = result.recovery?.events.filter(
      (event) => event.actionId === failed?.actionId && event.success,
    );
    expect(recovered?.length).toBeGreaterThan(0);
  });

  it('never writes the password in any report', () => {
    expect(reportText).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
});
