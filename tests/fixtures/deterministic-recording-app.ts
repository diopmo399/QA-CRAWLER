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
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request</title></head>
<body>
<h1>Request</h1>
<nav aria-label="Toolbar">${Array.from({ length: 20 }, (_, index) => `<button type="button" onclick="document.getElementById('last').textContent='Action ${String(index + 1)} done'">${broken && index === 6 ? 'Renamed' : 'Action'} ${String(index + 1)}</button>`).join('')}</nav>
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

const DONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title></head>
<body><h1>Done</h1><p>All set.</p></body></html>`;

export interface DeterministicRecordingApp {
  url: string;
  /** true : « Action 7 » devient « Renamed 7 » (un rejeu qui ne retrouve plus la cible). */
  broken: boolean;
  close: () => Promise<void>;
}

export async function startDeterministicRecordingApp(): Promise<DeterministicRecordingApp> {
  const state = { broken: false };
  const server: Server = createServer((request, response) => {
    const route = (request.url ?? '/').split('?')[0];
    if (route === '/api/items' && request.method === 'POST') {
      request.resume();
      response.statusCode = 201;
      response.setHeader('content-type', 'application/json');
      response.end('{"id":1,"status":"CREATED"}');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(route === '/done' ? DONE : form(state.broken));
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
