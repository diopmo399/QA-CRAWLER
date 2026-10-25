// Exemple d'application hôte qui embarque les composants QA-CRAWLER.
//
//   npm run build                     # compile @qa-crawler/core (dist/), SDK compris
//   node examples/sdk-host/host.mjs   # puis ouvrir l'adresse affichée
//
// Deux serveurs : le serveur SDK (moteur, API, modules des éléments) et le serveur de l'hôte
// (« Acme Portail », une application fictive). Le jeton de l'API ne figure jamais dans le code de
// la page : le back-end de l'hôte le remet à sa propre page, sur sa propre origine.
//
// La page montre les quatre composants, avec le même thème et le même jeton :
//   Nouveau projet  <qa-crawler-project-wizard mode="embedded">
//   Suivi           <qa-crawler-run-monitor>   (l'exploration lancée par l'assistant)
//   Comparaison     <qa-crawler-run-compare>   (les explorations du projet créé)
//   Studio          <qa-crawler-flow-studio>   (un enregistrement du projet, par son nom)
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSdkServer } from '@qa-crawler/core/sdk/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostPort = Number(process.env.HOST_PORT ?? 4320);
const hostOrigin = `http://127.0.0.1:${String(hostPort)}`;
const workspace = path.resolve(process.env.SDK_WORKSPACE ?? path.join(here, '.workspace'));
await mkdir(workspace, { recursive: true });

const sdk = await startSdkServer({
  workspace,
  port: Number(process.env.SDK_PORT ?? 4310),
  allowedOrigins: [hostOrigin],
  language: 'fr',
});

const page = (sdkUrl) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acme Portail — Qualité</title>
<style>
  :root{color-scheme:light;--bg:#F3F6F4;--fg:#0F3D2E;--bar:#fff;--line:#DDE6E1}
  :root[data-theme="dark"]{color-scheme:dark;--bg:#0B1512;--fg:#D7EDE3;--bar:#10201A;--line:#21362D}
  body{margin:0;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;background:var(--bg);color:var(--fg)}
  nav{width:220px;background:#0F3D2E;color:#D7EDE3;padding:24px 16px;display:flex;flex-direction:column;gap:6px}
  nav b{color:#fff;font-size:16px;margin-bottom:18px}
  nav a{color:inherit;text-decoration:none;padding:10px 12px;border-radius:10px}
  nav a[aria-current="page"]{background:#1B5A43;color:#fff;font-weight:600}
  main{flex:1;min-width:0;display:flex;flex-direction:column}
  header{height:64px;background:var(--bar);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;padding:0 28px;font-weight:600}
  header .sp{flex:1}
  section{padding:24px 28px}
  section[hidden]{display:none}
  .qa{
    --qa-color-primary:#10B981;--qa-color-primary-2:#059669;--qa-radius:16px;
    --qa-font-family:Inter,system-ui,sans-serif;
  }
  qa-crawler-flow-studio{height:620px}
  label{font-size:13px;font-weight:500}
  input,select{font:inherit}
  #log{margin-top:16px;font:12px/1.5 ui-monospace,monospace;opacity:.8}
</style></head>
<body>
<nav aria-label="Portail">
  <b>Acme Portail</b>
  <a href="#nouveau" data-view="nouveau">Nouveau projet</a>
  <a href="#suivi" data-view="suivi">Suivi</a>
  <a href="#comparaison" data-view="comparaison">Comparaison</a>
  <a href="#studio" data-view="studio">Studio</a>
</nav>
<main>
  <header>Qualité<span class="sp"></span>
    <label>Thème <select id="theme"><option value="auto">Système</option><option value="light">Clair</option><option value="dark">Sombre</option></select></label>
  </header>
  <section id="nouveau">
    <qa-crawler-project-wizard class="qa" mode="embedded" locale="fr" endpoint="${sdkUrl}/api"></qa-crawler-project-wizard>
    <div id="log" aria-live="polite"></div>
  </section>
  <section id="suivi" hidden><qa-crawler-run-monitor class="qa" locale="fr" endpoint="${sdkUrl}/api"></qa-crawler-run-monitor></section>
  <section id="comparaison" hidden><qa-crawler-run-compare class="qa" locale="fr" endpoint="${sdkUrl}/api"></qa-crawler-run-compare></section>
  <section id="studio" hidden>
    <p><label>Enregistrement du projet <input id="recording" placeholder="nom-de-l-enregistrement"></label></p>
    <qa-crawler-flow-studio class="qa" locale="fr" endpoint="${sdkUrl}/api"></qa-crawler-flow-studio>
  </section>
</main>
<script type="module">
  import '${sdkUrl}/sdk/ui/index.js';
  const $ = (selector) => document.querySelector(selector);
  const wizard = $('qa-crawler-project-wizard');
  const monitor = $('qa-crawler-run-monitor');
  const compare = $('qa-crawler-run-compare');
  const studio = $('qa-crawler-flow-studio');
  const components = [wizard, monitor, compare, studio];
  // Le back-end de l'hôte remet le jeton à sa page (même origine), à la demande.
  const token = (await (await fetch('/host-api/qa-crawler-token')).json()).token;
  for (const element of components) element.token = token;
  wizard.initialValues = { project: { name: 'Portail — recette' } };

  // Un seul thème pour l'hôte et les quatre composants.
  const applyTheme = (value) => {
    for (const element of components) element.setAttribute('theme', value);
    const dark = value === 'dark' || (value === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  $('#theme').addEventListener('change', (event) => applyTheme(event.target.value));
  applyTheme('auto');

  // Navigation de l'hôte : une section à la fois.
  const show = () => {
    const view = location.hash.slice(1) || 'nouveau';
    for (const section of document.querySelectorAll('main section')) section.hidden = section.id !== view;
    for (const link of document.querySelectorAll('nav a')) {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };
  addEventListener('hashchange', show);
  show();

  const log = (line) => { $('#log').textContent = line; };
  wizard.addEventListener('qa-project-created', (e) => {
    log('Projet créé : ' + e.detail.project.id);
    compare.setAttribute('project', e.detail.project.id);
    studio.setAttribute('project', e.detail.project.id);
  });
  wizard.addEventListener('qa-exploration-started', (e) => {
    log('Exploration lancée : ' + e.detail.exploration.id);
    monitor.setAttribute('exploration', e.detail.exploration.id);
  });
  wizard.addEventListener('qa-exploration-completed', (e) => {
    log('Exploration terminée : ' + e.detail.summary.stats.states + ' écrans');
    compare.reload();
  });
  wizard.addEventListener('qa-exploration-failed', (e) => log('Exploration échouée : ' + e.detail.error));
  $('#recording').addEventListener('change', (event) => studio.setAttribute('recording', event.target.value.trim()));
  monitor.addEventListener('qa-monitor-connection', (e) => {
    if (e.detail.state === 'lost') log('Suivi : flux interrompu');
  });
</script>
</body></html>`;

const host = createServer((request, response) => {
  if (request.url === '/host-api/qa-crawler-token') {
    // Ici, l'hôte vérifie SA session utilisateur avant de remettre le jeton.
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ token: sdk.token }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page(sdk.url));
});
await new Promise((resolve) => host.listen(hostPort, '127.0.0.1', resolve));

console.log(`SDK server : ${sdk.url}`);
console.log(`Hôte       : ${hostOrigin}   (Ctrl+C pour arrêter)`);
const stop = async () => {
  host.close();
  await sdk.close();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
