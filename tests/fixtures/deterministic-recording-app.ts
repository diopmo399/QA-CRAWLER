import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * L'application de l'ENREGISTREMENT DÉTERMINISTE : 20 actions visibles (une seule cliquée), une case à
 * cocher et une case déjà cochée, deux champs `#valueInput` (même id, même libellé, deux sections),
 * un champ nommé seulement par le texte qui le précède, un interrupteur joignable seulement par son
 * data-testid (deux cibles que l'ancien enregistreur changeait en `intent:`), un panneau re-rendu
 * (comme Angular : nouveaux nœuds), un bouton qui écrit (POST /api/items → un intent métier), un
 * mot de passe, un lien qui navigue ; `broken` renomme « Action 7 » (rejeu en échec).
 */
const form = (
  broken: boolean,
  /** Le numéro d'une action renommée « Renamed N » (le correction manager la re-désigne). */
  renamed?: number,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request</title></head>
<body>
<h1>Request</h1>
<nav aria-label="Toolbar">${Array.from({ length: 20 }, (_, index) => `<button type="button" onclick="document.getElementById('last').textContent='Action ${String(index + 1)} done'">${(broken && index === 6) || renamed === index + 1 ? 'Renamed' : 'Action'} ${String(index + 1)}</button>`).join('')}</nav>
<p id="last" role="status"></p>
<form onsubmit="return false">
  <label>First name <input name="firstName" autocomplete="off"></label>
  <label>Password <input type="password" name="secret" autocomplete="off"></label>
  <label><input type="checkbox" name="terms"> Accept terms</label>
  <label><input type="checkbox" name="news" checked> Receive news</label>
  <section aria-label="Primary"><h2>Primary</h2><label>Value <input id="valueInput" autocomplete="off"></label></section>
  <section aria-label="Secondary"><h2>Secondary</h2><label>Value <input id="valueInput" autocomplete="off"></label></section>
  <div class="row"><span>Branch code</span> <div><input autocomplete="off"></div></div>
</form>
<div role="switch" aria-checked="false" aria-label="Dark mode" data-testid="dark-mode" tabindex="0"
  onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))">◐</div>
<div id="panel"><button type="button" id="reload">Reload panel</button></div>
<button type="button" id="create" onclick="fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => { document.getElementById('last').textContent = 'Item created'; })">Create item</button>
<a href="/done">Continue</a>
<script>
  // Un re-rendu « framework » : tout le panneau est remplacé (les anciens nœuds disparaissent).
  document.getElementById('reload').addEventListener('click', () => {
    setTimeout(() => {
      document.getElementById('panel').innerHTML =
        '<p>Panel reloaded</p><button type="button" onclick="this.textContent=\\'Confirmed\\'">Confirm</button>';
    }, 120);
  });
</script>
</body></html>`;

/**
 * LA VARIANTE « LISTE » (correction manager, ligne de tableau) : la création renvoie un numéro propre au
 * run (il augmente à chaque création) ; la ligne créée est la seule montrée, avec le nom saisi et un lien
 * « Open ». Au rejeu, le numéro enregistré n'existe plus : seule la ligne liée à la donnée du run se retrouve.
 */
const list = (
  item: { id: number; name: string } | undefined,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requests</title></head>
<body>
<h1>Requests</h1>
<form onsubmit="return false"><label>First name <input name="firstName" autocomplete="off"></label></form>
<button type="button" id="create" onclick="fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('[name=firstName]').value }) }).then(() => { location.href = '/form'; })">Create item</button>
<table id="items" aria-label="Requests"><thead><tr><th>N°</th><th>Name</th><th>Created</th><th>Actions</th></tr></thead><tbody>
${item ? `<tr><td>${String(item.id)}</td><td>${item.name}</td><td>2026-01-02</td><td><a href="/item">Open</a></td></tr>` : ''}
</tbody></table>
</body></html>`;

const ITEM = (
  item: { id: number; name: string } | undefined,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Item</title></head>
<body><h1>Item</h1><p id="name">${item?.name ?? ''}</p></body></html>`;

const DONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title></head>
<body><h1>Done</h1><p>All set.</p></body></html>`;

export interface DeterministicRecordingApp {
  url: string;
  /** true : « Action 7 » devient « Renamed 7 » (un rejeu qui ne retrouve plus la cible). */
  broken: boolean;
  /** N : « Action N » devient « Renamed N » (une cible à corriger dans le navigateur). */
  renamed: number | undefined;
  /** true : la variante « liste » (création → ligne de tableau numérotée → lien « Open »). */
  table: boolean;
  /** Le nombre de créations reçues par le serveur (une reprise ne doit jamais en répéter une). */
  readonly created: number;
  /** Le dernier élément créé (numéro, nom saisi). */
  readonly lastItem: { id: number; name: string } | undefined;
  close: () => Promise<void>;
}

export async function startDeterministicRecordingApp(): Promise<DeterministicRecordingApp> {
  const state: {
    broken: boolean;
    renamed: number | undefined;
    table: boolean;
    nextId: number;
    item: { id: number; name: string } | undefined;
  } = { broken: false, renamed: undefined, table: false, nextId: 3024, item: undefined };
  const server: Server = createServer((request, response) => {
    const route = (request.url ?? '/').split('?')[0];
    if (route === '/api/items' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        let name = '';
        try {
          const parsed = JSON.parse(body || '{}') as { name?: unknown };
          name = typeof parsed.name === 'string' ? parsed.name.replace(/[<>&]/g, '') : '';
        } catch {
          name = '';
        }
        const id = state.nextId;
        state.nextId += 1;
        state.item = { id, name };
        response.statusCode = 201;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id, status: 'CREATED' }));
      });
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (route === '/done') response.end(DONE);
    else if (state.table) response.end(route === '/item' ? ITEM(state.item) : list(state.item));
    else response.end(form(state.broken, state.renamed));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    get broken() {
      return state.broken;
    },
    set broken(value: boolean) {
      state.broken = value;
    },
    get renamed() {
      return state.renamed;
    },
    set renamed(value: number | undefined) {
      state.renamed = value;
    },
    get table() {
      return state.table;
    },
    get created() {
      return state.nextId - 3024;
    },
    get lastItem() {
      return state.item;
    },
    set table(value: boolean) {
      state.table = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
