import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/authenticator.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Site protected by HTTP Basic authentication: the browser shows its grey
 * "Sign in" dialog (SiteMinder Basic scheme, intranet servers…).
 */
const USER = 'agent.qa';
const PASSWORD = 'Basic-S3cret!';

describe('HTTP authentication (browser sign-in dialog)', () => {
  let server: Server;
  let url = '';
  let outputDir = '';
  const authorized: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const header = req.headers.authorization ?? '';
      const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
      if (header !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="SiteMinder"', 'content-type': 'text/html' });
        res.end('<h1>Authentification requise</h1>');
        return;
      }
      authorized.push(req.url ?? '/');
      const page = (title: string, body: string): string =>
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        req.url === '/rapports'
          ? page('Rapports', '<a href="/">Accueil</a>')
          : page('Intranet', '<a href="/rapports">Rapports</a>'),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-http-auth-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const mission = (name: string, auth: string) =>
    parseConfig(
      `
mission:
  name: ${name}
target:
  baseUrl: ${url}
exploration:
  maxStates: 10
  maxDurationMinutes: 1
  settleTimeMs: 50
auth:
${auth}
output:
  reportsDir: ${path.join(outputDir, name, 'reports')}
  screenshotsDir: ${path.join(outputDir, name, 'screenshots')}
`,
      {},
      {},
    ).config;

  it('answers the sign-in dialog with credentials from the environment', async () => {
    const { result } = await runMission(mission('ok', `  type: http\n  origin: ${url}`), {
      env: { QA_USERNAME: USER, QA_PASSWORD: PASSWORD },
    });
    const headings = result.states.flatMap((state) => state.headings);
    expect(headings).toEqual(expect.arrayContaining(['Intranet', 'Rapports']));
    expect(authorized).toContain('/rapports');
    expect(result.settings.auth).toEqual({ type: 'http' });
    for (const file of ['result.json', 'index.html', 'flow-graph.html']) {
      const text = await readFile(path.join(outputDir, 'ok', 'reports', file), 'utf8');
      expect(text, file).not.toContain(PASSWORD);
      expect(text, file).not.toContain(Buffer.from(`${USER}:${PASSWORD}`).toString('base64'));
    }
  });

  it('fails clearly with wrong credentials', async () => {
    await expect(
      runMission(mission('wrong', '  type: http'), { env: { QA_USERNAME: USER, QA_PASSWORD: 'nope' } }),
    ).rejects.toThrowError(/HTTP authentication refused \(401\)/);
  });

  it('never sends the credentials to another origin', async () => {
    await expect(
      runMission(mission('other-origin', '  type: http\n  origin: https://sso.example.com'), {
        env: { QA_USERNAME: USER, QA_PASSWORD: PASSWORD },
      }),
    ).rejects.toThrowError(/refused \(401\).*auth\.origin/);
  });

  it('requires the environment variables', async () => {
    const run = runMission(mission('missing', '  type: http'), { env: {} });
    await expect(run).rejects.toBeInstanceOf(AuthError);
    await expect(runMission(mission('missing', '  type: http'), { env: {} })).rejects.toThrowError(
      /QA_USERNAME, QA_PASSWORD/,
    );
  });
});
