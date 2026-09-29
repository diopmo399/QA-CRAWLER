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
 * Un nouvel onglet ouvert à la dernière étape, dont le serveur tarde à répondre (comme
 * sur une machine lente) : Playwright ne l'annonce qu'après sa première réponse, bien
 * après la fin du flow. Il doit quand même être enregistré avant que le navigateur ferme.
 */
describe('a new tab that answers late, opened by the last step', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = (body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (req.url === '/aide') {
        setTimeout(() => {
          html('<!doctype html><title>Aide</title><h1>Centre d’aide</h1>');
        }, 1500);
        return;
      }
      html(
        '<!doctype html><title>Accueil</title><h1>Accueil</h1><a href="/aide" target="_blank" rel="noopener">Aide</a>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-slow-tab-'));
    const { config } = parseConfig(
      `
mission: { name: slow-tab }
target: { baseUrl: ${url} }
exploration: { autonomous: false, settleTimeMs: 100, actionTimeoutMs: 5000 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
flows:
  - name: aide
    steps:
      - click: { role: link, name: Aide }
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

  it('is recorded as NEW_TAB and observed, not lost when the browser closes', () => {
    const tabs = result.browserInteractions.filter((interaction) => interaction.type === 'NEW_TAB');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      status: 'HANDLED',
      outcome: 'POPUP_OBSERVED',
      details: { opener: false },
    });
    expect(result.states.some((state) => state.headings.includes('Centre d’aide'))).toBe(true);
  });
});
