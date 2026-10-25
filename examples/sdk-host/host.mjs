// Exemple d'application hôte qui embarque l'assistant QA-CRAWLER (mode `embedded`).
//
//   npm run build                     # compile @qa-crawler/core (dist/), SDK compris
//   node examples/sdk-host/host.mjs   # puis ouvrir l'adresse affichée
//
// Deux serveurs : le serveur SDK (moteur, API, module de l'élément) et le serveur de l'hôte
// (« Acme Portail », une application fictive). Le jeton de l'API ne figure jamais dans le code de
// la page : le back-end de l'hôte le remet à sa propre page, sur sa propre origine.
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
  body{margin:0;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;background:#F3F6F4;color:#0F3D2E}
  nav{width:220px;background:#0F3D2E;color:#D7EDE3;padding:24px 16px;display:flex;flex-direction:column;gap:6px}
  nav b{color:#fff;font-size:16px;margin-bottom:18px}
  nav a{color:inherit;text-decoration:none;padding:10px 12px;border-radius:10px}
  nav a.on{background:#1B5A43;color:#fff;font-weight:600}
  main{flex:1;min-width:0;display:flex;flex-direction:column}
  header{height:64px;background:#fff;border-bottom:1px solid #DDE6E1;display:flex;align-items:center;padding:0 28px;font-weight:600}
  section{padding:24px 28px}
  qa-crawler-project-wizard{
    --qa-color-primary:#10B981;--qa-color-primary-2:#059669;--qa-radius:16px;
    --qa-font-family:Inter,system-ui,sans-serif;
  }
  #log{margin-top:16px;font:12px/1.5 ui-monospace,monospace;color:#4C6A5C}
</style></head>
<body>
<nav><b>Acme Portail</b><a href="#">Accueil</a><a href="#">Clients</a><a href="#">Commandes</a><a class="on" href="#">Qualité</a><a href="#">Paramètres</a></nav>
<main><header>Qualité › Nouveau projet de test</header>
<section>
  <qa-crawler-project-wizard mode="embedded" locale="fr" endpoint="${sdkUrl}/api"></qa-crawler-project-wizard>
  <div id="log" aria-live="polite"></div>
</section></main>
<script type="module">
  import '${sdkUrl}/sdk/ui/index.js';
  const wizard = document.querySelector('qa-crawler-project-wizard');
  // Le back-end de l'hôte remet le jeton à sa page (même origine), à la demande.
  wizard.token = (await (await fetch('/host-api/qa-crawler-token')).json()).token;
  wizard.initialValues = { project: { name: 'Portail — recette' } };
  const log = (line) => { document.getElementById('log').textContent = line; };
  wizard.addEventListener('qa-project-created', (e) => log('Projet créé : ' + e.detail.project.id));
  wizard.addEventListener('qa-exploration-started', (e) => log('Exploration lancée : ' + e.detail.exploration.id));
  wizard.addEventListener('qa-exploration-completed', (e) => log('Exploration terminée : ' + e.detail.summary.stats.states + ' écrans'));
  wizard.addEventListener('qa-exploration-failed', (e) => log('Exploration échouée : ' + e.detail.error));
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
