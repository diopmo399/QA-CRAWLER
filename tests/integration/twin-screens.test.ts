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
 * « Open request » laisse une trace (une réservation, une reprise…) : au retour, l'écran montre
 * un bouton de plus, « Resume request ». C'est le même écran avec un autre id. Explorer le
 * dernier écran d'un flow (thenExplore) ne saute jamais vers d'autres états : sans jumeau,
 * l'écran d'origine était déclaré injoignable et l'exploration s'arrêtait là.
 */
const REQUESTS = `<h1>Requests</h1>
  <a href="/requests/open">Open request</a>
  <a href="/requests/help">Help</a> <a href="/requests/contacts">Contacts</a> <a href="/requests/about">About</a>
  <span id="resume"></span>
  <script>
    if (localStorage.getItem('opened')) {
      document.getElementById('resume').innerHTML = '<button id="resume-button">Resume request</button>';
      document.getElementById('resume-button').onclick = () => (location.href = '/requests/open');
    }
  </script>`;
const PAGES: Record<string, string> = {
  '/': '<h1>Home</h1><a href="/requests">Requests</a>',
  '/requests': REQUESTS,
  '/requests/open': `<h1>Request</h1><p role="alert">Failed to load the request</p>
    <script>localStorage.setItem('opened', '1')</script>`,
  '/requests/help': '<h1>Help</h1>',
  '/requests/contacts': '<h1>Contacts</h1>',
  '/requests/about': '<h1>About</h1>',
};

describe('a screen found again with another id (twin) keeps its work', () => {
  let server: Server;
  let result: ExplorationResult;
  const methods: string[] = [];

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
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-twin-'));
    const { config } = parseConfig(
      `
mission: { name: twin }
target: { baseUrl: ${url} }
goals: { keywords: [open] }
exploration: { autonomous: false, maxStates: 20, maxActions: 30, actionTimeoutMs: 3000, settleTimeMs: 50 }
flows:
  - name: requests
    thenExplore: true
    steps:
      - click: { role: link, name: Requests }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    result = (
      await runMission(config, {
        listener: { onBacktrack: (_from, _to, method) => methods.push(method) },
      })
    ).result;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('continues on the twin: every other link of the screen is explored, then stops', () => {
    const labels = result.states.map((state) => state.label);
    expect(labels).toEqual(expect.arrayContaining(['help', 'contacts', 'about', 'request']));
    expect(methods.some((method) => /same screen as requests-/.test(method))).toBe(true);
    // Aucun écran abandonné en route : le message de fin ne liste rien.
    expect(methods.at(-1)).toBe('nothing left to explore');
  });

  it('what was tried on the original screen is not tried again on its twin', () => {
    const opened = result.transitions.filter(
      (edge) => (edge.action.text ?? edge.action.label) === 'Open request',
    );
    expect(opened).toHaveLength(1);
  });
});
