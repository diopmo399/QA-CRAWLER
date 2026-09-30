import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runDryRun } from '../../src/dry-run/dry-run-orchestrator.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Une application monopage (history.pushState) : l'accueil propose trois écrans, le
 * texte attendu n'est que sur le troisième. Le serveur compte les chargements complets
 * de la page : revenir à l'accueil entre deux essais doit passer par l'historique du
 * navigateur (popstate), pas par un rechargement qui perdrait l'état de l'application.
 */
const PAGE = `<!doctype html><html><body><div id="app"></div>
<script>
  const app = document.getElementById('app');
  const screens = {
    '/': '<h1>Accueil</h1><nav><button data-to="/alpha">Alpha</button> <button data-to="/beta">Beta</button> <button data-to="/gamma">Gamma</button></nav>',
    '/alpha': '<h1>Alpha</h1><p>Rien ici</p>',
    '/beta': '<h1>Beta</h1><p>Rien ici non plus</p>',
    '/gamma': '<h1>Gamma</h1><p>Écran cible</p>',
  };
  const render = () => {
    app.innerHTML = screens[location.pathname] ?? screens['/'];
    app.querySelectorAll('button[data-to]').forEach((button) =>
      button.addEventListener('click', () => { history.pushState({}, '', button.dataset.to); render(); }));
  };
  window.addEventListener('popstate', render);
  render();
</script></body></html>`;

/**
 * Tout en mémoire, à la même adresse : « Créer un dossier » envoie un POST, puis l'écran
 * « Dossier créé » propose deux détails. Revenir à « Dossier créé » après le premier
 * détail ne peut se faire ni par l'historique ni par l'adresse : il faudrait rejouer la
 * création. Un retour en arrière ne crée jamais une seconde fois.
 */
const MEMORY = `<!doctype html><html><body><div id="app"></div>
<script>
  const app = document.getElementById('app');
  const home = () => {
    app.innerHTML = '<h1>Accueil</h1><button id="create">Créer un dossier</button>';
    document.getElementById('create').addEventListener('click', async () => {
      await fetch('/api/dossiers', { method: 'POST' });
      created();
    });
  };
  const created = () => {
    app.innerHTML = '<h1>Dossier créé</h1><button>Détail A</button> <button>Détail B</button>';
    app.querySelectorAll('button').forEach((button) =>
      button.addEventListener('click', () => { app.innerHTML = '<h1>' + button.textContent + '</h1><p>Lecture seule</p>'; }));
  };
  home();
</script></body></html>`;

describe('single-page application: going back without reloading the page', () => {
  let server: Server;
  let url: string;
  let documentLoads = 0;
  let posts = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/favicon.ico') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === 'POST') {
        posts += 1;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      documentLoads += 1;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(request.url?.startsWith('/memoire') ? MEMORY : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('dry run: the guided exploration comes back through the history, never by reloading', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-spa-restore-'));
    await writeFile(
      path.join(dir, 'cible.flow.yaml'),
      `name: Trouver la cible
steps:
  - goto: /
  - expect: { text: Écran cible }
`,
    );
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: spa-restore }
target: { baseUrl: ${url}, startAt: / }
exploration: { actionTimeoutMs: 3000, settleTimeMs: 50 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'reports')} }
`,
    );
    const before = documentLoads;
    const result = await runDryRun({
      scenarioFile: path.join(dir, 'cible.flow.yaml'),
      missionFile: path.join(dir, 'mission.yaml'),
    });
    const rows = (result.flows[0]?.reconciliation.entries ?? []).map(
      (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
    );
    expect(rows).toContain('Écran cible MATCHED');
    expect(rows).toContain('Gamma INSERTED');
    // Alpha et Beta ont été essayés avant Gamma : deux retours à l'accueil par l'historique.
    // Seuls chargements : l'ouverture par la mission et le « goto: / » du scénario.
    const loads = documentLoads - before;
    expect(loads).toBeLessThanOrEqual(2);
  }, 120_000);

  it('exploration: coming back to a screen never replays an action that changes data', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-spa-replay-'));
    const { config } = parseConfig(
      `
mission: { name: no-replay }
target: { baseUrl: ${url}, startAt: /memoire }
exploration: { maxStates: 10, maxActions: 15, actionTimeoutMs: 3000, settleTimeMs: 50 }
forms: { exercise: false }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
  allowedActionClasses: [SAFE, MUTATION]
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(dir, 'reports')}
  screenshotsDir: ${path.join(dir, 'screenshots')}
`,
      {},
      {},
    );
    posts = 0;
    await runMission(config);
    expect(posts).toBe(1);
  }, 120_000);
});
