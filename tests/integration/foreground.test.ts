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

/** Un calque sans aucun rôle ARIA : un fond fixe qui couvre la page, avec une boîte au milieu. */
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
    // Un menu qui fait partie de la page (qui ne flotte pas) n'est pas « devant ».
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

/** Un calendrier ouvert depuis une fenêtre modale : son fond transparent recouvre la fenêtre. */
const STACKED = page(`
<h1>Demandes</h1>
<button onclick="document.getElementById('dlg').style.display='block'">Afficher le formulaire</button>
<div id="dlg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10">
  <div role="dialog" aria-modal="true" aria-label="Création" style="margin:10vh auto;width:600px;background:#fff;padding:16px">
    <h2>Création</h2>
    <button onclick="openPicker()">Ouvrir le calendrier</button>
    <button style="margin-top:200px" onclick="document.getElementById('dlg').style.display='none'">Annuler</button>
  </div>
</div>
<script>
  function closePicker() { document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-pane').forEach((el) => el.remove()); }
  function openPicker() {
    const backdrop = document.createElement('div');
    backdrop.className = 'cdk-overlay-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:20';
    backdrop.onclick = closePicker;
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    pane.style.cssText = 'position:absolute;top:10px;right:10px;z-index:21;background:#eee;padding:8px';
    pane.innerHTML = '<button aria-label="2026-09-01" onclick="closePicker()">1</button><button aria-label="2026-09-02" onclick="closePicker()">2</button>';
    document.body.append(backdrop, pane);
  }
</script>`);

describe('stacked layers (date picker over a dialog)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('only the top layer is in front; the dialog under the backdrop is covered', async () => {
    const tab = await browser.newPage();
    await tab.setContent(STACKED);
    await tab.getByRole('button', { name: 'Afficher le formulaire' }).click();
    await tab.getByRole('button', { name: 'Ouvrir le calendrier' }).click();
    const snapshot = await new UIObserver().observe(tab);
    const byName = (name: string) => snapshot.elements.find((element) => element.name === name);
    expect(byName('2026-09-01')).toMatchObject({ foreground: true });
    expect(byName('Annuler')).toMatchObject({ obscured: true });
    expect(byName('Annuler')?.foreground).toBeUndefined();
    expect(byName('Afficher le formulaire')).toMatchObject({ obscured: true });
    await tab.close();
  });
});

describe('exploration of a date picker inside a dialog', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(STACKED);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-stacked-'));
    const { config } = parseConfig(
      `
mission: { name: stacked }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 15, actionTimeoutMs: 2000, settleTimeMs: 100 }
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

  it('picks a day before touching the dialog behind, and no click is intercepted', () => {
    const opened = result.transitions.find((edge) => edge.action.text === 'Ouvrir le calendrier');
    expect(opened?.result).toBe('SUCCESS');
    // Actions exécutées seulement (les BLOCKED sont listées, jamais exécutées).
    const next = result.transitions.find((edge) => edge.from === opened?.to && edge.result !== 'BLOCKED');
    expect(next?.action.text).toMatch(/^[12]$/);
    expect(result.transitions.filter((edge) => edge.result === 'FAILED')).toEqual([]);
  });
});

describe('after a failure the state cannot be restored', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    // La fenêtre ne s'ouvre qu'une fois (comme une demande qui ne peut être créée qu'une fois) ; dedans, le premier
    // bouton est recouvert par un petit élément qui prend le clic : l'action échoue.
    const html = page(`
<h1>Accueil</h1>
<a href="/aide">Aide</a>
<button id="open" onclick="localStorage.setItem('done','1');document.getElementById('dlg').style.display='block'">Ouvrir</button>
<div id="dlg" role="dialog" aria-label="Demande" style="display:none;position:fixed;top:40px;left:40px;width:400px;height:300px;background:#fff">
  <div style="position:relative">
    <button>Piège</button>
    <div style="position:absolute;inset:0;z-index:5"></div>
  </div>
  <button>Autre</button>
</div>
<script>if (localStorage.getItem('done')) document.getElementById('open').remove();</script>`);
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/' ? html : page('<h1>Aide</h1><a href="/">Accueil</a>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-stale-'));
    const { config } = parseConfig(
      `
mission: { name: stale }
target: { baseUrl: ${url} }
exploration: { autonomous: false, maxStates: 10, maxActions: 10, actionTimeoutMs: 1000, settleTimeMs: 100 }
flows:
  # Explores the dialog right after the flow: no jump to other states in this scope.
  - name: demande
    thenExplore: true
    steps:
      - click: { role: button, name: Ouvrir }
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

  it('goes on from what is on screen, not from the actions of the lost state', () => {
    const trap = result.transitions.find((edge) => edge.action.text === 'Piège');
    expect(trap?.result).toBe('FAILED');
    // La fenêtre a disparu après le rechargement : aucune de ses autres actions n'est essayée sur une page qui ne la montre plus.
    const failed = result.transitions.filter((edge) => edge.result === 'FAILED');
    expect(failed.map((edge) => edge.action.text)).toEqual(['Piège']);
  });
});
