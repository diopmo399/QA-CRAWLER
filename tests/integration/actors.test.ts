import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const ADMIN_PASSWORD = 'adm-secret-71x';
const READER_PASSWORD = 'rdr-secret-42y';
const USERS: Record<string, { password: string; role: 'admin' | 'reader' }> = {
  root: { password: ADMIN_PASSWORD, role: 'admin' },
  ann: { password: READER_PASSWORD, role: 'reader' },
};
const LOGIN = `<h1>Sign in</h1><form method="post" action="/login">
  <input id="user" name="user"><input id="pass" name="pass" type="password"><button id="go">Sign in</button></form>`;
const MENU =
  '<a href="/reports">Reports</a> <a href="/team">Team</a> <a href="/admin/users">Admin users</a> <a href="/admin/audit">Admin audit</a>';

describe('multiple actors: who reaches what', () => {
  let server: Server;
  let result: ExplorationResult;
  let outputDir = '';

  beforeAll(async () => {
    const sessions = new Map<string, 'admin' | 'reader'>();
    server = createServer((req, res) => {
      const html = (status: number, body: string): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>`,
        );
      };
      const redirect = (location: string, cookie?: string): void => {
        res.writeHead(302, { location, ...(cookie ? { 'set-cookie': cookie } : {}) });
        res.end();
      };
      const url = req.url ?? '/';
      if (url === '/login' && req.method === 'POST') {
        let form = '';
        req.on('data', (chunk: Buffer) => (form += chunk.toString()));
        req.on('end', () => {
          const values = new URLSearchParams(form);
          const user = USERS[values.get('user') ?? ''];
          if (!user || user.password !== values.get('pass')) {
            html(401, LOGIN);
            return;
          }
          const sid = `s${sessions.size + 1}`;
          sessions.set(sid, user.role);
          redirect('/', `sid=${sid}; Path=/; HttpOnly`);
        });
        return;
      }
      if (url === '/login') {
        html(200, LOGIN);
        return;
      }
      const role = sessions.get(/sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? '');
      if (!role) {
        redirect('/login');
        return;
      }
      if (url === '/') html(200, `<h1>Home</h1>${MENU}`);
      else if (url === '/reports') html(200, '<h1>Reports</h1>');
      else if (url === '/team') html(200, '<h1>Team</h1>');
      else if (url === '/admin/users') {
        if (role === 'admin') html(200, '<h1>Admin users</h1>');
        else html(403, '<h1>Forbidden</h1>');
      } else if (url === '/admin/audit') {
        if (role === 'admin') html(200, '<h1>Admin audit</h1>');
        else redirect('/'); // refused by sending back home
      } else html(404, 'Not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-actors-'));
    const login = (userEnv: string, passwordEnv: string): string =>
      `{ type: form, loginUrl: /login, usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go', successUrlContains: /, usernameEnv: ${userEnv}, passwordEnv: ${passwordEnv} }`;
    const { config } = parseConfig(
      `
mission: { name: actors }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 30, actionTimeoutMs: 2000, settleTimeMs: 50 }
auth: ${login('QA_ADMIN_USER', 'QA_ADMIN_PASSWORD')}
actors:
  - name: reader
    auth: ${login('QA_READER_USER', 'QA_READER_PASSWORD')}
  - name: guest
    auth: { type: none }
authorization:
  primaryActor: admin
  rules:
    - { actor: reader, path: /admin/*, expect: denied }
    - { actor: reader, path: /reports, expect: allowed }
    - { actor: reader, path: /team, expect: denied }
    - { actor: guest, path: /reports, expect: denied }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    ({ result } = await runMission(config, {
      env: {
        QA_ADMIN_USER: 'root',
        QA_ADMIN_PASSWORD: ADMIN_PASSWORD,
        QA_READER_USER: 'ann',
        QA_READER_PASSWORD: READER_PASSWORD,
      },
    }));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const access = (actor: string, label: string): string | undefined =>
    result.authorization?.observations.find(
      (observation) => observation.actor === actor && observation.label === label,
    )?.access;

  it('opens every screen as each actor and records what it reaches', () => {
    expect(result.authorization?.actors).toEqual(['admin', 'reader', 'guest']);
    expect(access('admin', 'admin-users')).toBe('ALLOWED');
    expect(access('reader', 'admin-users')).toBe('DENIED'); // HTTP 403
    expect(access('reader', 'admin-audit')).toBe('DENIED'); // sent back home
    expect(access('reader', 'reports')).toBe('ALLOWED');
    expect(access('guest', 'reports')).toBe('DENIED'); // no session: sent to the login page
    expect(result.authorization?.errors).toEqual([]);
  });

  it('reports the access differences between actors', () => {
    const difference = result.authorization?.differences.find((entry) => entry.label === 'admin-users');
    expect(difference?.access).toMatchObject({ admin: 'ALLOWED', reader: 'DENIED' });
    expect(difference?.message).toContain('ACCESS DIFFERENCE');
  });

  it('checks the rules: PASS, FAIL with an AUTHORIZATION issue', () => {
    const status = (actor: string, rulePath: string): string | undefined =>
      result.authorization?.rules.find((rule) => rule.actor === actor && rule.path === rulePath)?.status;
    expect(status('reader', '/admin/*')).toBe('PASS');
    expect(status('reader', '/reports')).toBe('PASS');
    expect(status('reader', '/team')).toBe('FAIL');
    const issues = result.issues.filter((issue) => issue.type === 'AUTHORIZATION');
    expect(status('guest', '/reports')).toBe('PASS');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('reader must be denied on /team');
    expect(issues[0]?.severity).toBe('ERROR');
  });

  it('never writes a password in any file', async () => {
    const files = await readdir(outputDir, { recursive: true, withFileTypes: true });
    const texts = await Promise.all(
      files
        .filter((entry) => entry.isFile() && !entry.name.endsWith('.png'))
        .map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
    );
    const all = texts.join('\n') + JSON.stringify(result);
    expect(all).not.toContain(ADMIN_PASSWORD);
    expect(all).not.toContain(READER_PASSWORD);
  });
});
