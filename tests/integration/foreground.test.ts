import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { runMission } from '../../src/orchestrator.js';

const page = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Accueil</title></head><body>${body}</body></html>`;

/** An overlay without any ARIA role: a fixed backdrop covering the page, with a box in the middle. */
const OVERLAY = `
<div id="layer" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10">
  <div style="margin:30vh auto;width:320px;background:#fff;padding:16px">
    <h2>Choisir un compte</h2>
    <a href="/compte">Compte courant</a>
    <button onclick="document.getElementById('layer').style.display='none'">Fermer</button>
  </div>
</div>`;

const HOME = page(`
<h1>Accueil</h1>
<a href="/derriere">Lien derrière</a>
<button onclick="document.getElementById('layer').style.display='block'">Ouvrir le choix</button>
${OVERLAY}`);

describe('what is in front of the screen', () => {
  let browser: Browser;
  const observer = new UIObserver();

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('marks the elements of a modal layer as foreground and the page behind as obscured', async () => {
    const tab = await browser.newPage();
    await tab.setContent(HOME);
    await tab.getByRole('button', { name: 'Ouvrir le choix' }).click();
    const snapshot = await observer.observe(tab);
    const byName = (name: string) => snapshot.elements.find((element) => element.name === name);
    expect(snapshot.overlay).toBe('Choisir un compte');
    expect(byName('Compte courant')).toMatchObject({ foreground: true });
    expect(byName('Fermer')).toMatchObject({ foreground: true });
    expect(byName('Lien derrière')).toMatchObject({ obscured: true });
    expect(byName('Lien derrière')?.foreground).toBeUndefined();
    await tab.close();
  });

  it('keeps the page behind usable next to a non-modal layer (cookie banner, open menu)', async () => {
    const tab = await browser.newPage();
    await tab.setContent(
      page(`
<nav role="menu"><a role="menuitem" href="/a">Menu latéral</a></nav>
<a href="/b">Contenu</a>
<div role="dialog" aria-label="Cookies" style="position:fixed;bottom:0;left:0;right:0;height:60px;background:#eee">
  <button>Accepter</button>
</div>`),
    );
    const snapshot = await observer.observe(tab);
    const byName = (name: string) => snapshot.elements.find((element) => element.name === name);
    expect(snapshot.overlay).toBeUndefined();
    expect(byName('Accepter')).toMatchObject({ foreground: true });
    expect(byName('Contenu')?.obscured).toBeUndefined();
    // A menu that is part of the page (not floating) is not "in front".
    expect(byName('Menu latéral')?.foreground).toBeUndefined();
    await tab.close();
  });

  it('keeps foreground elements beyond maxElements', async () => {
    const tab = await browser.newPage();
    const many = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join('');
    await tab.setContent(page(`${many}${OVERLAY}`));
    await tab.evaluate(() => {
      (document.getElementById('layer') as HTMLElement).style.display = 'block';
    });
    const snapshot = await new UIObserver(5).observe(tab);
    expect(snapshot.elements.map((element) => element.name)).toContain('Compte courant');
    await tab.close();
  });
});

describe('exploration with an overlay open', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/' ? HOME : page(`<h1>${req.url ?? ''}</h1><a href="/">Retour</a>`));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-foreground-'));
    const { config } = parseConfig(
      `
mission: { name: foreground }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 20, actionTimeoutMs: 3000, settleTimeMs: 100 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
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

  it('explores the overlay first and never clicks what it covers', () => {
    const overlayState = result.states.find((state) => state.actionsDetail.some((a) => a.foreground));
    expect(overlayState).toBeDefined();
    const fromOverlay = result.transitions.filter((edge) => edge.from === overlayState?.id);
    expect(fromOverlay.length).toBeGreaterThan(0);
    expect(fromOverlay[0]?.action.text).toMatch(/Compte courant|Fermer/);
    expect(fromOverlay.map((edge) => edge.action.text)).not.toContain('Lien derrière');
    expect(fromOverlay.every((edge) => edge.result !== 'FAILED')).toBe(true);
  });
});
