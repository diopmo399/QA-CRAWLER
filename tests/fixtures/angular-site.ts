import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * L'APPLICATION « DOSSIERS », en vrai : la page « Nouveau dossier » livrée telle que la décrit le code de
 * tests/fixtures/angular-app (mêmes libellés, mêmes gestionnaires, même indicateur d'occupation partagé).
 * Le défaut contrôlé : vider « Code », ouvrir puis fermer le dialogue « Notes » sans rien écrire, puis
 * « Enregistrer » : le gestionnaire pose l'indicateur d'occupation, lève une TypeError en déduisant le code du
 * brouillon vide, et ne relâche jamais l'indicateur. Ensuite aucun bouton ne réagit plus (ni validation, ni
 * chargement, ni requête) ; les champs restent modifiables ; un rechargement remet tout en état et perd la saisie.
 * `site.flaky = true` : une page sur deux (servie en alternance) est saine, pour le cas intermittent.
 * Le site garde chaque requête de l'API pour que les tests vérifient ce qui a été joué.
 */
export interface AngularSite {
  url: string;
  calls: { method: string; path: string; body: string }[];
  pageLoads: number;
  /** Une page sur deux est saine : le défaut devient intermittent. */
  flaky: boolean;
  close(): Promise<void>;
}

const APP_SCRIPT = `
const busy = { locked: false, lock() { this.locked = true; render(); }, unlock() { this.locked = false; render(); } };
const notes = { etat: undefined, ouvrir() { document.getElementById('notes-dialog').showModal(); }, fermer(brouillon) { this.etat = { brouillon, fermeA: Date.now() }; document.getElementById('notes-dialog').close(); }, dernierBrouillon() { return this.etat; } };
const form = document.querySelector('form');
const statut = document.getElementById('statut');
const erreur = document.getElementById('erreur');
const spinner = document.getElementById('spinner');
function render() { spinner.hidden = !busy.locked; spinner.setAttribute('aria-busy', String(busy.locked)); }
function enregistrer() {
  if (busy.locked) return;
  busy.lock();
  const code = form.elements.code.value.trim();
  const dernier = notes.dernierBrouillon();
  if (!code && !dernier) { busy.unlock(); erreur.textContent = 'Le code est requis'; erreur.hidden = false; return; }
  const libelle = code || dernier.brouillon.match(/^[A-Za-z0-9-]+/)[0];
  erreur.hidden = true;
  statut.textContent = 'Enregistrement…';
  fetch('/api/dossiers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: libelle, titre: form.elements.titre.value, categorie: form.elements.categorie.value, urgent: form.elements.urgent.checked }) })
    .then((response) => { if (!response.ok) throw new Error('HTTP ' + response.status); statut.textContent = 'Dossier créé'; })
    .catch(() => { erreur.textContent = "Le dossier n'a pas été enregistré"; erreur.hidden = false; })
    .finally(() => busy.unlock());
}
function actualiser() {
  if (busy.locked) return;
  busy.lock();
  fetch('/api/dossiers/recents').then((response) => response.json()).then((dossiers) => { statut.textContent = dossiers.length + ' dossier(s) récent(s)'; }).finally(() => busy.unlock());
}
form.addEventListener('submit', (event) => { event.preventDefault(); enregistrer(); });
document.getElementById('actualiser').addEventListener('click', actualiser);
document.getElementById('notes').addEventListener('click', () => { if (busy.locked) return; notes.ouvrir(); });
document.getElementById('notes-fermer').addEventListener('click', () => notes.fermer(document.getElementById('brouillon').value));
document.getElementById('aide').addEventListener('click', () => document.getElementById('aide-dialog').showModal());
document.getElementById('aide-fermer').addEventListener('click', () => document.getElementById('aide-dialog').close());
render();
`;

const HEALTHY_PATCH = `notes.dernierBrouillon = function () { const etat = this.etat; return etat && etat.brouillon.trim() ? etat : undefined; };`;

const page = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>dialog::backdrop{background:rgba(0,0,0,.3)} .spinner{width:16px;height:16px;border:2px solid #999;border-radius:50%}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

const NEW_DOSSIER = (healthy: boolean): string =>
  page(
    'Nouveau dossier',
    `<h1>Nouveau dossier</h1>
<nav><a href="/dossiers">Liste des dossiers</a></nav>
<form>
  <label>Code <input name="code"></label>
  <label>Titre <input name="titre"></label>
  <label>Catégorie <select name="categorie"><option value="courant">Courant</option><option value="prioritaire">Prioritaire</option><option value="archive">Archive</option></select></label>
  <label><input type="checkbox" name="urgent"> Urgent</label>
  <p id="erreur" class="mat-error" role="alert" hidden></p>
  <button type="submit">Enregistrer</button>
  <button type="button" id="actualiser">Actualiser</button>
  <button type="button" id="notes">Notes</button>
  <button type="button" id="aide">Aide</button>
</form>
<p id="statut" role="status" aria-live="polite"></p>
<div id="spinner" class="spinner" hidden></div>
<dialog id="notes-dialog" aria-labelledby="notes-titre"><h2 id="notes-titre">Notes</h2><label>Notes <textarea id="brouillon" rows="4"></textarea></label><button type="button" id="notes-fermer">Fermer</button></dialog>
<dialog id="aide-dialog"><h2>Aide</h2><p>Renseignez le code puis enregistrez.</p><button type="button" id="aide-fermer">Fermer</button></dialog>`,
    APP_SCRIPT + (healthy ? HEALTHY_PATCH : ''),
  );

const LIST = page(
  'Dossiers',
  '<h1>Dossiers</h1><a href="/dossiers/nouveau">Nouveau dossier</a><p>0 dossier(s)</p>',
);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').slice(0, 10_000);
}

async function handle(request: IncomingMessage, response: ServerResponse, site: AngularSite): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/dossiers' && request.method === 'POST') {
    const body = await readBody(request);
    site.calls.push({ method: 'POST', path: url.pathname, body });
    response
      .writeHead(201, { 'content-type': 'application/json' })
      .end(JSON.stringify({ id: site.calls.length }));
    return;
  }
  if (url.pathname === '/api/dossiers/recents' && request.method === 'GET') {
    site.calls.push({ method: 'GET', path: url.pathname, body: '' });
    response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === '/dossiers/nouveau' || url.pathname === '/') {
    site.pageLoads += 1;
    const healthy = site.flaky && site.pageLoads % 2 === 0;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(NEW_DOSSIER(healthy));
    return;
  }
  if (url.pathname === '/dossiers') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LIST);
    return;
  }
  response
    .writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    .end(page('Introuvable', '<p>404</p>'));
}

export async function startAngularSite(): Promise<AngularSite> {
  const site: AngularSite = {
    url: '',
    calls: [],
    pageLoads: 0,
    flaky: false,
    close: () => Promise.resolve(),
  };
  const server = createServer((request, response) => {
    handle(request, response, site).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site.url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
  site.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  return site;
}
