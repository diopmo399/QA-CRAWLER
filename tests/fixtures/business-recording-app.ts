import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * L'application du PARCOURS MÉTIER : une SPA (changements d'URL sans rechargement) qui crée une
 * demande, la recherche par son numéro, puis l'ouvre. `variant` choisit d'où vient le numéro :
 *
 *   full          réponse POST /api/demandes {"id":"12345"} + message affiché + route /demandes/12345
 *   network-only  le numéro n'est que dans la réponse réseau (message sans numéro, pas de route)
 *   dom-only      la réponse ne dit rien (204) ; le numéro n'est que dans le message affiché
 *   ambiguous     POST /api/dossiers alors que l'écran parle d'une « demande » : deux entités possibles
 *
 * Deux champs « Commentaire » identiques (sections Demandeur / Bénéficiaire) éprouvent le contexte.
 */
export type BusinessVariant = 'full' | 'network-only' | 'dom-only' | 'ambiguous';

const page = (
  variant: BusinessVariant,
): string => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Demandes</title></head>
<body>
<nav>
  <button type="button" id="new">Nouvelle demande</button>
  <button type="button" id="find">Rechercher une demande</button>
</nav>
<main id="view"><h1>Accueil</h1></main>
<p id="toast" role="status"></p>
<script>
  const VARIANT = ${JSON.stringify(variant)};
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const go = (path) => { history.pushState({}, '', path); render(); };
  function render() {
    const path = location.pathname;
    toast.textContent = toast.dataset.keep === path ? toast.textContent : '';
    if (path === '/demandes/nouvelle') {
      view.innerHTML = '<h1>Nouvelle demande</h1><form id="form" onsubmit="return false">' +
        '<label>Nom <input name="nom" autocomplete="off"></label>' +
        '<label>Description <input name="description" autocomplete="off"></label>' +
        '<section aria-label="Demandeur"><h2>Demandeur</h2><label>Commentaire <input class="comment" autocomplete="off"></label></section>' +
        '<section aria-label="Bénéficiaire"><h2>Bénéficiaire</h2><label>Commentaire <input class="comment" autocomplete="off"></label></section>' +
        '<button type="button" id="create">Créer</button></form>';
      document.getElementById('create').addEventListener('click', create);
    } else if (path === '/recherche') {
      view.innerHTML = '<h1>Rechercher une demande</h1><label>Numéro de demande <input id="q" autocomplete="off"></label>' +
        '<button type="button" id="run">Rechercher</button><ul id="results"></ul>';
      document.getElementById('run').addEventListener('click', search);
    } else if (/^\\/demandes\\/\\d+$/.test(path)) {
      const id = path.split('/').pop();
      fetch('/api/demandes/' + id).then((r) => r.json()).then((d) => {
        view.innerHTML = '<h1>Demande ' + d.id + '</h1><p>Statut : ' + d.status + '</p>';
      });
      view.innerHTML = '<h1>Chargement…</h1>';
    } else view.innerHTML = '<h1>Accueil</h1>';
  }
  async function create() {
    const body = JSON.stringify({ nom: 'x' });
    const url = VARIANT === 'ambiguous' ? '/api/dossiers' : '/api/demandes';
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const created = response.status === 204 ? { id: '12345' } : await response.json();
    if (VARIANT === 'network-only') { toast.textContent = 'Demande créée'; return; }
    toast.textContent = 'Demande ' + created.id + ' créée';
    if (VARIANT === 'full') { toast.dataset.keep = '/demandes/' + created.id; go('/demandes/' + created.id); }
  }
  async function search() {
    const q = document.getElementById('q').value;
    const found = await fetch('/api/demandes?q=' + encodeURIComponent(q)).then((r) => r.json());
    document.getElementById('results').innerHTML = found.map((d) => '<li><a href="/demandes/' + d.id + '" class="result">Demande ' + d.id + ' — ' + d.nom + '</a></li>').join('');
    for (const link of document.querySelectorAll('a.result'))
      link.addEventListener('click', (event) => { event.preventDefault(); go(link.getAttribute('href')); });
  }
  document.getElementById('new').addEventListener('click', () => go('/demandes/nouvelle'));
  document.getElementById('find').addEventListener('click', () => go('/recherche'));
  window.addEventListener('popstate', render);
  window.__loads = (window.__loads || 0) + 1;
  render();
</script>
</body></html>`;

export interface BusinessRecordingApp {
  url: string;
  variant: BusinessVariant;
  close: () => Promise<void>;
}

export async function startBusinessRecordingApp(): Promise<BusinessRecordingApp> {
  const state: { variant: BusinessVariant } = { variant: 'full' };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if ((url.pathname === '/api/demandes' || url.pathname === '/api/dossiers') && request.method === 'POST') {
      request.resume();
      if (state.variant === 'dom-only') {
        response.statusCode = 204;
        response.end();
        return;
      }
      json(201, { id: '12345', status: 'NOUVELLE', token: 'never-an-identifier' });
      return;
    }
    if (url.pathname === '/api/demandes' && request.method === 'GET') {
      json(200, url.searchParams.get('q') === '12345' ? [{ id: '12345', nom: 'Martin' }] : []);
      return;
    }
    if (/^\/api\/demandes\/\d+$/.test(url.pathname)) {
      json(200, { id: url.pathname.split('/').pop(), status: 'NOUVELLE' });
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page(state.variant));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const app: BusinessRecordingApp = {
    url: `http://127.0.0.1:${String(port)}`,
    get variant() {
      return state.variant;
    },
    set variant(value: BusinessVariant) {
      state.variant = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  return app;
}
