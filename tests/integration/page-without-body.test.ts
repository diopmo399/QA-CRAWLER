import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import { UIObserver } from '../../src/observation/ui-observer.js';

/**
 * Un document sans <body> : réponse XML, page intermédiaire d'authentification, ou
 * document encore en cours d'écriture juste après une connexion. La lecture de l'écran
 * ne doit jamais échouer (« Cannot read properties of null (reading 'innerText') »).
 */
describe('a document without <body> never stops the exploration', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/status.xml') {
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end('<?xml version="1.0"?><status><state>ready</state></status>');
      } else if (request.url === '/no-body') {
        // La page retire son <body> (comme une page intermédiaire qui réécrit le document).
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<!doctype html><html><head><title>Intermédiaire</title></head><body><p>…</p><script>document.body.remove()</script></body></html>',
        );
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<!doctype html><html><body><h1>Accueil</h1><a href="/status.xml">État</a></body></html>',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('UIObserver reads an XML document and a page whose body was removed, without error', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${url}/status.xml`);
      const xml = await new UIObserver().observe(page);
      expect(xml.textExcerpt).toContain('ready');
      await page.goto(`${url}/no-body`);
      const bodiless = await new UIObserver().observe(page);
      expect(bodiless.elements).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it('an exploration that starts on such a page finishes instead of failing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-no-body-'));
    const { config } = parseConfig(
      `
mission: { name: no-body }
target: { baseUrl: ${url}, startAt: /no-body }
exploration: { maxStates: 3, maxActions: 5, actionTimeoutMs: 2000, settleTimeMs: 50 }
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(dir, 'reports')}
  screenshotsDir: ${path.join(dir, 'screenshots')}
`,
      {},
      {},
    );
    const { result } = await runMission(config);
    expect(result.states.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
