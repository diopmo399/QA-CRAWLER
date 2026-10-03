import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Une petite SPA lente : chaque action UI déclenche une transition qui prend du temps, sur la même
 * URL. Variantes (`?variant=`) :
 *  - `dialog`  : « Filter » ouvre une fenêtre 800 ms plus tard (champ « Value », bouton « Apply ») ;
 *  - `stale`   : « Views » remplace la liste par la vue après 1 s (états intermédiaires). L'ancienne liste
 *                a AUSSI un bouton « Edit » : un localisateur résolu trop tôt vise l'ancien DOM ;
 *  - `loader`  : « Load » affiche un indicateur 1 s, puis « Continue » ;
 *  - `network` : « Search » appelle /api/search (700 ms), puis affiche « Open result » ;
 *  - `polling` : une interrogation de fond toutes les 150 ms (jamais « networkidle »), « Show » ;
 *  - `rerender`: « Show » affiche le champ « Notes », recréé 300 ms plus tard (nouveau nœud) ;
 *  - `tab`     : l'onglet « Details » remplace le panneau 400 ms plus tard (même URL) ;
 *  - `nothing` : « Filter » ne fait rien (l'effet attendu n'arrive jamais) ;
 *  - `debounce`: une saisie dans « Title » re-rend, 700 ms plus tard, le champ suivant (« Draft » devient
 *                « Notes », nouveau nœud, même id) : lu trop tôt, c'est l'ancien nœud.
 */
export interface TransitionApp {
  url: string;
  close(): Promise<void>;
}

const SCRIPT: Record<string, string> = {
  dialog: `
  document.getElementById('go').textContent = 'Filter';
  document.getElementById('go').addEventListener('click', () => {
    setTimeout(() => {
      stage.innerHTML = '<div role="dialog" aria-label="Filter"><label>Value <input id="value"></label><button type="button" id="apply">Apply</button></div>';
      document.getElementById('apply').addEventListener('click', () => {
        result.textContent = 'Filtered by ' + document.getElementById('value').value;
      });
    }, 800);
  });`,
  stale: `
  document.getElementById('go').textContent = 'Views';
  document.getElementById('go').addEventListener('click', () => {
    setTimeout(() => { list.setAttribute('aria-busy', 'false'); list.querySelector('h2').textContent = 'List (refreshing)'; }, 200);
    setTimeout(() => { list.querySelector('h2').textContent = 'List'; }, 500);
    setTimeout(() => {
      list.remove();
      stage.innerHTML = '<section aria-label="Views"><h2>Views</h2><button type="button" id="edit">Edit</button></section>';
      document.getElementById('edit').addEventListener('click', () => { result.textContent = 'Editing view'; });
    }, 1000);
  });`,
  loader: `
  document.getElementById('go').textContent = 'Load';
  document.getElementById('go').addEventListener('click', () => {
    stage.innerHTML = '<div class="spinner" role="progressbar">Loading</div>';
    setTimeout(() => {
      stage.innerHTML = '<button type="button" id="continue">Continue</button>';
      document.getElementById('continue').addEventListener('click', () => { result.textContent = 'Continued'; });
    }, 1000);
  });`,
  network: `
  document.getElementById('go').textContent = 'Search';
  document.getElementById('go').addEventListener('click', async () => {
    const response = await fetch('/api/search');
    const body = await response.json();
    stage.innerHTML = '<button type="button" id="open">Open result</button>';
    document.getElementById('open').addEventListener('click', () => { result.textContent = 'Opened ' + body.name; });
  });`,
  polling: `
  setInterval(() => { fetch('/api/poll').catch(() => undefined); }, 150);
  document.getElementById('go').textContent = 'Show';
  document.getElementById('go').addEventListener('click', () => {
    setTimeout(() => {
      stage.innerHTML = '<button type="button" id="done">Done</button>';
      document.getElementById('done').addEventListener('click', () => { result.textContent = 'Done'; });
    }, 300);
  });`,
  rerender: `
  document.getElementById('go').textContent = 'Show';
  document.getElementById('go').addEventListener('click', () => {
    stage.innerHTML = '<label>Notes <input id="notes"></label>';
    setTimeout(() => { stage.innerHTML = '<label>Notes <input id="notes"></label><button type="button" id="save">Save</button>';
      document.getElementById('save').addEventListener('click', () => { result.textContent = 'Saved ' + document.getElementById('notes').value; });
    }, 300);
  });`,
  tab: `
  document.getElementById('go').textContent = 'Details';
  document.getElementById('go').setAttribute('role', 'tab');
  document.getElementById('go').addEventListener('click', () => {
    stage.innerHTML = '<p>Loading details</p>';
    setTimeout(() => {
      stage.innerHTML = '<div role="tabpanel" aria-label="Details"><label>Comment <input id="comment"></label><button type="button" id="keep">Keep</button></div>';
      document.getElementById('keep').addEventListener('click', () => { result.textContent = 'Kept ' + document.getElementById('comment').value; });
    }, 400);
  });`,
  debounce: `
  document.getElementById('go').textContent = 'Title';
  stage.innerHTML = '<label>Title <input id="title"></label><div id="box"><label>Draft <input id="notes"></label></div>';
  let timer;
  document.getElementById('title').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      document.getElementById('box').innerHTML = '<label>Notes <input id="notes"></label><button type="button" id="save">Save</button>';
      document.getElementById('save').addEventListener('click', () => { result.textContent = 'Saved ' + document.getElementById('notes').value; });
    }, 700);
  });`,
  nothing: `
  document.getElementById('go').textContent = 'Filter';`,
};

const page = (
  variant: string,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requests</title>
<style>.spinner{display:inline-block;width:20px;height:20px}</style></head><body><main>
<h1>Requests</h1>
<section aria-label="List" id="list"><h2>List</h2><button type="button" id="edit-old">Edit</button></section>
<button type="button" id="go">Go</button>
<div id="stage"></div>
<p id="result"></p>
</main><script>
  const stage = document.getElementById('stage');
  const result = document.getElementById('result');
  const list = document.getElementById('list');
  document.getElementById('edit-old').addEventListener('click', () => { result.textContent = 'Editing list'; });
  ${SCRIPT[variant] ?? ''}
</script></body></html>`;

export async function startTransitionApp(): Promise<TransitionApp> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/api/search') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ name: 'alpha' }));
      }, 700);
      return;
    }
    if (url.pathname === '/api/poll') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(url.searchParams.get('variant') ?? 'dialog'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
