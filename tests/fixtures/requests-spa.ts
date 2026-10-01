import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Une application monopage façon Angular (routes par history.pushState, pas de rechargement) :
 *
 *   /                    Tableau de bord : une tuile « Demandes » (un <div> cliquable, sans lien,
 *                        comme un (click)="router.navigate(...)") et un lien routerLink « Aide »
 *   /demandes            Liste : bouton « Créer nouvelle demande » qui charge des données
 *                        (GET lent) puis navigue — la route change bien après le clic
 *   /demandes/create     Description, Type (liste), « Urgent » (case), « Soumettre » :
 *                        POST /api/demandes (lent) → 201 → /demandes/{id}
 *   /demandes/{id}       Détail
 *   /protected           Redirige aussitôt vers /login (garde de route)
 */
export interface RequestsSpa {
  url: string;
  created: { description: boolean; type: string; inbound: boolean }[];
  close(): Promise<void>;
}

const SHELL = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Demandes</title>
<style>.tile{cursor:pointer;border:1px solid #888;padding:8px;display:inline-block} .tile span{pointer-events:auto}</style></head>
<body><main id="app"></main>
<script>
  const app = document.getElementById('app');
  const go = (path) => { history.pushState({}, '', path); render(); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.addEventListener('popstate', () => render());
  function render() {
    const path = location.pathname;
    if (path === '/') {
      app.innerHTML = '<h1>Tableau de bord</h1><div class="tile" id="tile-demandes"><span>Demandes</span></div> <a href="/aide" routerlink="/aide" id="aide">Aide</a> <div class="tile" id="tile-protected"><span>Espace protégé</span></div>';
      document.getElementById('tile-demandes').addEventListener('click', () => go('/demandes'));
      document.getElementById('tile-protected').addEventListener('click', () => { go('/protected'); });
      document.getElementById('aide').addEventListener('click', (event) => { event.preventDefault(); go('/aide'); });
    } else if (path === '/demandes') {
      app.innerHTML = '<h1>Demandes</h1><button type="button" id="create">Créer nouvelle demande</button>';
      document.getElementById('create').addEventListener('click', async () => {
        await fetch('/api/reference-data?slow=1');
        go('/demandes/create');
      });
    } else if (path === '/demandes/create') {
      app.innerHTML = '<h1>Nouvelle demande</h1><form id="f" novalidate>' +
        '<div><label for="d">Description</label><textarea id="d" name="description"></textarea></div>' +
        '<div><label for="t">Type</label><select id="t" name="type"><option value="">--</option><option value="INFO">Information</option><option value="CLAIM">Réclamation</option></select></div>' +
        '<div><label><input type="checkbox" name="inbound"> Urgent</label></div>' +
        '<button type="submit">Soumettre</button></form>';
      document.getElementById('f').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const response = await fetch('/api/demandes', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description: form.description.value, type: form.type.value, inbound: form.inbound.checked }) });
        const body = await response.json();
        await wait(400);
        go('/demandes/' + body.id);
      });
    } else if (path === '/protected') {
      go('/login');
    } else if (path === '/login') {
      app.innerHTML = '<h1>Connexion</h1>';
    } else if (path === '/aide') {
      app.innerHTML = '<h1>Aide</h1>';
    } else if (path.startsWith('/demandes/')) {
      app.innerHTML = '<h1>Demande enregistrée</h1><p role="status">Statut : SOUMISE</p>';
    } else {
      app.innerHTML = '<h1>Introuvable</h1>';
    }
  }
  render();
</script></body></html>`;

export async function startRequestsSpa(): Promise<RequestsSpa> {
  const created: RequestsSpa['created'] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/reference-data') {
      // Des données lentes à charger : la route change bien après le clic (plus de 2,5 s).
      setTimeout(() => {
        json(200, { types: ['INFO', 'CLAIM'] });
      }, 3000);
      return;
    }
    if (url.pathname === '/api/demandes' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as { description?: string; type?: string; inbound?: boolean };
        created.push({
          description: Boolean(body.description),
          type: body.type ?? '',
          inbound: body.inbound === true,
        });
        setTimeout(() => {
          json(201, { id: 100 + created.length, status: 'SUBMITTED' });
        }, 1500);
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(SHELL);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    created,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
