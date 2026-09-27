import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { EngineLogEntry } from '../../src/logging/engine-log.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const SEND = (endpoint: string, fields: string[]): string =>
  `event.preventDefault(); fetch('${endpoint}', { method: 'POST', headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ ${fields.map((field) => `${field}: document.getElementById('${field}').value`).join(', ')} }) })
     .then(() => { document.getElementById('done').textContent = 'Saved'; });`;

const PAGES: Record<string, string> = {
  '/': `<h1>Dashboard</h1>
    <a href="/users/new"><img src="/logo.png" width="20" height="20"></a>
    <a href="/users/new">New user</a> <a href="/trap">Keyboard</a>
    <div onclick="this.textContent='clicked'">Open details</div>`,
  '/users/new': `<h1>New user</h1>
    <form onsubmit="${SEND('/api/users', ['firstName', 'email'])}">
      <label for="firstName">First name</label><input id="firstName" name="firstName" required>
      <label for="email">Email</label><input id="email" name="email" type="email" required>
      <button type="submit">Create user</button>
    </form>
    <form onsubmit="${SEND('/api/teams', ['team', 'code'])}">
      <label for="team">Team name</label><input id="team" name="team" required>
      <label for="code">Team code</label><input id="code" name="code" required>
      <button type="submit">Create team</button>
    </form>
    <p id="done"></p>`,
  '/trap': `<h1>Keyboard</h1>
    <input id="stuck" aria-label="Stuck field" onkeydown="if (event.key === 'Tab') event.preventDefault()">
    <a href="/">Back home</a>`,
};

describe('accessibility checks, mutation budget, created data, engine log', () => {
  let server: Server;
  let result: ExplorationResult;
  let reportsDir = '';
  const posts: { url: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          posts.push({ url, body });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end('{"id":1}');
        });
        return;
      }
      if (url === '/logo.png') {
        res.writeHead(404);
        res.end();
        return;
      }
      const page = PAGES[url];
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${page ?? 'Not found'}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-safety-a11y-'));
    reportsDir = path.join(outputDir, 'reports');
    const { config } = parseConfig(
      `
mission: { name: safety-a11y }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 40, actionTimeoutMs: 2000, settleTimeMs: 50 }
safety:
  mutations: { enabled: true, maxPerRun: 1 }
accessibility: { keyboardNavigation: true, maxTabs: 6 }
testData: { runId: acc1 }
logging: { level: debug }
output:
  reportsDir: ${reportsDir}
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

  it('reports basic accessibility problems of each screen', () => {
    const messages = result.issues
      .filter((issue) => issue.type === 'ACCESSIBILITY')
      .map((issue) => issue.message);
    expect(messages.some((message) => message.includes('link(s) showing only an image'))).toBe(true);
    expect(messages.some((message) => message.includes('not reachable with the keyboard'))).toBe(true);
    expect(messages.some((message) => message.includes('keyboard focus stays stuck'))).toBe(true);
  });

  it('sends at most maxPerRun forms, with data tagged by the run', () => {
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.toLowerCase()).toContain('qa-crawler-acc1');
    expect(result.mutations).toEqual({ enabled: true, executed: 1, maxPerRun: 1 });
  });

  it('lists what the run created, without deleting it', () => {
    expect(result.createdData).toHaveLength(1);
    expect(result.createdData?.[0]).toMatchObject({ tag: 'QA-CRAWLER-acc1', runId: 'acc1' });
    expect(result.createdData?.[0]?.requests[0]).toMatchObject({ method: 'POST', status: 201 });
    expect(result.cleanup).toMatchObject({ cleaner: 'manual', cleaned: 0 });
    expect(result.cleanup?.pending).toHaveLength(1);
    // Les valeurs envoyées ne sont jamais enregistrées.
    expect(JSON.stringify(result.createdData)).not.toContain('@example.test');
  });

  it('writes a structured engine log, without the values typed', async () => {
    const text = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    const entries = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EngineLogEntry);
    const events = new Set(entries.map((entry) => entry.event));
    for (const event of ['FLOW_STATE_DISCOVERED', 'ACTION_SELECTED', 'ACTION_EXECUTED', 'ORACLE_VERDICT'])
      expect(events).toContain(event);
    expect(entries.every((entry) => ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(entry.level))).toBe(true);
    expect(text).not.toContain('@example.test');
    expect(result.artifacts.engineLog).toBe(path.join(reportsDir, 'engine-log.jsonl'));
  });
});
