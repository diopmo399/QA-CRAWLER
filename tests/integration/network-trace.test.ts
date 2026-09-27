import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const HOME = `<!doctype html><html><head><meta charset="utf-8"><title>Users</title></head><body>
<h1>Users</h1>
<button onclick="openForm()">Nouvel utilisateur</button>
<div id="form" role="dialog" aria-label="Create user" style="display:none"><h2>Create user</h2></div>
<script>
  async function openForm() {
    await fetch('/api/roles?access_token=s3cr3t', { headers: { Authorization: 'Bearer top-secret-token' } });
    await fetch('/api/users/42');
    new Image().src = '/logo.png';
    document.getElementById('form').style.display = 'block';
  }
</script></body></html>`;

describe('ACTION → NETWORK → STATE', () => {
  let server: Server;
  let result: ExplorationResult;
  let graphFile: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/')) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }, 30);
        return;
      }
      res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/' ? HOME : '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-network-'));
    const { config } = parseConfig(
      `
mission: { name: network }
target: { baseUrl: ${url} }
safety: { allowedActionClasses: [SAFE, MUTATION] }
exploration: { maxActions: 5, actionTimeoutMs: 3000, settleTimeMs: 200 }
http: { failOnStatus: 500 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    result = (await runMission(config)).result;
    graphFile = path.join(outputDir, 'reports', 'flow-graph.json');
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('attaches the HTTP exchanges of an action to its transition', () => {
    const edge = result.transitions.find((candidate) => candidate.action.text === 'Nouvel utilisateur');
    expect(edge?.result).toBe('SUCCESS');
    expect(edge?.to).not.toBe(edge?.from);
    const calls = edge?.network?.map((exchange) => ({
      method: exchange.method,
      path: new URL(exchange.url).pathname,
      status: exchange.status,
      resourceType: exchange.resourceType,
    }));
    expect(calls).toEqual([
      { method: 'GET', path: '/api/roles', status: 200, resourceType: 'fetch' },
      { method: 'GET', path: '/api/users/42', status: 200, resourceType: 'fetch' },
    ]);
    expect(edge?.network?.[0]?.durationMs).toBeGreaterThanOrEqual(20);
    expect(edge?.networkWindow?.startedAt).toBeDefined();
  });

  it('never keeps secrets: tokens in URLs are redacted, headers are never read', async () => {
    const edge = result.transitions.find((candidate) => candidate.action.text === 'Nouvel utilisateur');
    expect(edge?.network?.[0]?.url).not.toContain('s3cr3t');
    const stored = await readFile(graphFile, 'utf8');
    expect(stored).toContain('/api/roles');
    for (const secret of ['s3cr3t', 'top-secret-token', 'Bearer', 'Authorization']) {
      expect(stored).not.toContain(secret);
    }
  });
});
