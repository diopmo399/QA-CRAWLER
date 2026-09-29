import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Une connexion unique renvoie de page en page par JavaScript avant d'arriver sur
 * l'application : la page navigue pendant que le crawler la lit. La mission doit
 * attendre la page d'arrivée, pas s'arrêter (« Execution context was destroyed »).
 */
describe('a chain of client-side redirects, as after a single sign-on', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    const hop = (to: string): string =>
      `<!doctype html><title>Connexion</title><p>Redirection…</p><script>setTimeout(() => location.replace('${to}'), 30)</script>`;
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/') res.end(hop('/relais-1'));
      else if (req.url === '/relais-1') res.end(hop('/relais-2'));
      else if (req.url === '/relais-2') res.end(hop('/accueil'));
      else res.end('<!doctype html><title>Accueil</title><h1>Liste de tâches</h1><button>Filtre</button>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-redirects-'));
    const { config } = parseConfig(
      `
mission: { name: redirections }
target: { baseUrl: ${url} }
exploration: { autonomous: false, settleTimeMs: 0, actionTimeoutMs: 5000 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
flows:
  - name: arrivée
    steps:
      - expect: { text: Liste de tâches }
      - click: { role: button, name: Filtre }
`,
      {},
      {},
    );
    ({ result } = await runMission(config));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('waits for the landing page and runs the flow', () => {
    expect(result.flows[0]?.status).toBe('PASSED');
  });
});
