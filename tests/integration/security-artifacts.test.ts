import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';

/** Chaque secret que l'application distribue, de toutes les façons dont il peut atteindre le crawler. */
const SECRETS = {
  password: 'login-pw-3e8a1f',
  cookie: 'cookie-val-9d2c7b',
  bearer: 'bearer-tok-5f1e0a',
  urlToken: 'url-tok-7a3b9c',
  consoleSecret: 'console-sec-2b8d4e',
  prefilled: 'prefilled-pw-6c0f2d',
  apiKey: 'api-key-8e4a7d',
};

const HOME = `<h1>Home</h1>
  <a href="/account">Account</a>
  <a href="/reset?token=${SECRETS.urlToken}">Reset access</a>
  <button onclick="fetch('/api/me', { headers: { Authorization: 'Bearer ${SECRETS.bearer}', 'X-Api-Key': '${SECRETS.apiKey}' } })
    .then(() => console.error('refresh failed, Authorization: Bearer ${SECRETS.bearer} token=${SECRETS.consoleSecret}'))">Refresh profile</button>`;
const ACCOUNT = `<h1>Account</h1><form onsubmit="event.preventDefault()">
  <label for="nick">Nickname</label><input id="nick" name="nick">
  <label for="city">City</label><input id="city" name="city">
  <label for="pw">Current password</label><input id="pw" name="pw" type="password" value="${SECRETS.prefilled}">
  <button type="button">Check</button></form>`;
const LOGIN = `<h1>Sign in</h1><form method="post" action="/login">
  <input id="user" name="user"><input id="pass" name="pass" type="password"><button id="go">Sign in</button></form>`;

describe('no secret in any artifact', () => {
  let server: Server;
  let outputDir = '';
  let artifacts: { name: string; text: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const html = (status: number, body: string, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>`,
        );
      };
      if (url.pathname === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          const ok = new URLSearchParams(body).get('pass') === SECRETS.password;
          if (!ok) {
            html(401, LOGIN);
            return;
          }
          res.writeHead(302, { location: '/', 'set-cookie': `session=${SECRETS.cookie}; Path=/; HttpOnly` });
          res.end();
        });
        return;
      }
      if (url.pathname === '/login') {
        html(200, LOGIN);
        return;
      }
      if (!(req.headers.cookie ?? '').includes(SECRETS.cookie)) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      if (url.pathname === '/api/me') {
        // Le corps d'erreur renvoie ce qu'il a reçu : cela ne doit pas atteindre les rapports.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `bad ${req.headers.authorization ?? ''}` }));
        return;
      }
      if (url.pathname === '/') html(200, HOME);
      else if (url.pathname === '/account') html(200, ACCOUNT);
      else if (url.pathname === '/reset') html(200, '<h1>Reset</h1>');
      else html(404, 'Not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-security-'));
    const { config } = parseConfig(
      `
mission: { name: security }
target: { baseUrl: ${url} }
exploration: { maxStates: 15, maxActions: 30, actionTimeoutMs: 2000, settleTimeMs: 50 }
auth: { type: form, loginUrl: /login, usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go', successUrlContains: / }
checks: { screenshots: true }
logging: { level: trace }
forms: { validationTesting: true }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    const run = await runMission(config, { env: { QA_USERNAME: 'tester', QA_PASSWORD: SECRETS.password } });
    const files = await readdir(outputDir, { recursive: true, withFileTypes: true });
    artifacts = await Promise.all(
      files
        .filter((entry) => entry.isFile() && !entry.name.endsWith('.png'))
        .map(async (entry) => ({
          name: entry.name,
          text: await readFile(path.join(entry.parentPath, entry.name), 'utf8'),
        })),
    );
    artifacts.push({ name: 'in-memory result', text: JSON.stringify(run.result) });
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('produces every artifact (result.json, flow-graph.json, HTML report, engine log)', () => {
    const names = artifacts.map((artifact) => artifact.name);
    for (const name of [
      'result.json',
      'flow-graph.json',
      'flow-graph.html',
      'index.html',
      'engine-log.jsonl',
    ])
      expect(names).toContain(name);
    // Les pièges ont été atteints : l'erreur console et l'appel en échec ont été observés.
    const result = artifacts.find((artifact) => artifact.name === 'result.json')?.text ?? '';
    expect(result).toContain('/api/me');
    expect(result).toContain('refresh failed');
  });

  for (const [kind, secret] of Object.entries(SECRETS)) {
    it(`never writes the ${kind}`, () => {
      const leaking = artifacts
        .filter((artifact) => artifact.text.includes(secret))
        .map((artifact) => artifact.name);
      expect(leaking).toEqual([]);
    });
  }
});
