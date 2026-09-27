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

async function serve(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

async function explore(url: string, exploration: string): Promise<ExplorationResult> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-fixes-'));
  const { config } = parseConfig(
    `
mission: { name: fixes }
target: { baseUrl: ${url} }
exploration: { ${exploration} }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
    {},
    {},
  );
  return (await runMission(config)).result;
}

describe('only real actions are read from the screen', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('ignores a title or a text block that only takes the focus', async () => {
    const tab = await browser.newPage();
    await tab.setContent(
      page(`<div role="dialog"><h2 tabindex="0">Nouveau dossier</h2>
      <div tabindex="0">Texte informatif</div>
      <div tabindex="0" style="cursor:pointer">Carte cliquable</div>
      <div tabindex="0" role="button">Bouton ARIA</div></div>`),
    );
    const names = (await new UIObserver().observe(tab)).elements.map((element) => element.name);
    expect(names).toEqual(['Carte cliquable', 'Bouton ARIA']);
    await tab.close();
  });
});

describe('a click taken by another element fails fast, with the culprit', () => {
  let app: Awaited<ReturnType<typeof serve>>;
  let result: ExplorationResult;

  beforeAll(async () => {
    app = await serve(
      page(`<div style="position:relative;display:inline-block">
        <button>Consulter</button><div class="voile" style="position:absolute;inset:0"></div></div>`),
    );
    result = await explore(app.url, 'maxActions: 3, actionTimeoutMs: 10000, settleTimeMs: 50');
  });
  afterAll(async () => {
    await app.close();
  });

  it('says which element took the click, well before the action timeout', () => {
    const edge = result.transitions.find((candidate) => candidate.action.text === 'Consulter');
    expect(edge?.result).toBe('FAILED');
    expect(edge?.reason).toMatch(
      /^click intercepted by <div class="voile".*another layer covers the element$/,
    );
    expect(edge?.durationMs).toBeLessThan(6000);
  });
});

describe('leaving a date picker keeps the dialog under it', () => {
  let app: Awaited<ReturnType<typeof serve>>;
  let result: ExplorationResult;

  beforeAll(async () => {
    // La fenêtre ne s'ouvre qu'une fois : recharger la page la perdrait pour de bon.
    app = await serve(
      page(`<h1>Dossiers</h1>
<button id="open" onclick="localStorage.setItem('opened','1');document.getElementById('dlg').style.display='block'">Afficher le dossier</button>
<div id="dlg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.3)">
  <div role="dialog" aria-modal="true" aria-label="Dossier" style="margin:10vh auto;width:500px;background:#fff;padding:12px">
    <button onclick="openPicker()">Ouvrir le calendrier</button>
    <button onclick="document.getElementById('info').textContent='Dossier 42'">Détails du dossier</button>
    <p id="info"></p>
  </div>
</div>
<script>
  if (localStorage.getItem('opened')) document.getElementById('open').remove();
  function closePicker() { document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-pane').forEach((el) => el.remove()); }
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePicker(); });
  function openPicker() {
    const backdrop = document.createElement('div');
    backdrop.className = 'cdk-overlay-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:20';
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    pane.style.cssText = 'position:absolute;top:10px;right:10px;z-index:21;background:#eee';
    pane.innerHTML = '<button>Mois précédent</button><button>Mois suivant</button>';
    document.body.append(backdrop, pane);
  }
</script>`),
    );
    result = await explore(app.url, 'maxActions: 10, actionTimeoutMs: 3000, settleTimeMs: 100');
  });
  afterAll(async () => {
    await app.close();
  });

  it('closes the picker (Escape) and goes on in the dialog', () => {
    const picker = result.transitions.filter((edge) => /Mois/.test(edge.action.text ?? ''));
    expect(picker.map((edge) => edge.result)).toEqual(['SUCCESS', 'SUCCESS']);
    const details = result.transitions.find((edge) => edge.action.text === 'Détails du dossier');
    expect(details?.result).toBe('SUCCESS');
  });
});
