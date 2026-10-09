import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * UNE APPLICATION INCONNUE, générique : des « items » (aucun nom de domaine). Une SPA :
 *
 *   /items              la liste (l'item 123 existe déjà)
 *   /items/search       une recherche par numéro
 *   /items/new          une création : POST /api/items → 201 {"id": "<nouvel id>"}
 *   /items/<id>         le détail (GET /api/items/<id>), une description modifiable, « Save » (PUT)
 *
 * Rien n'y dit « créé » pour une simple ouverture : la provenance doit venir des preuves.
 */
const page =
  (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Items</title></head>
<body>
<nav>
  <button type="button" id="list">Items</button>
  <button type="button" id="find">Search items</button>
  <button type="button" id="new">New item</button>
</nav>
<main id="view"></main>
<p id="toast" role="status"></p>
<script>
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const go = (path) => { history.pushState({}, '', path); render(); };
  const link = (id) => '<a href="/items/' + id + '" class="item">item ' + id + '</a>';
  const wire = () => {
    for (const a of document.querySelectorAll('a.item'))
      a.addEventListener('click', (event) => { event.preventDefault(); go(a.getAttribute('href')); });
  };
  function render() {
    const path = location.pathname;
    if (toast.dataset.keep !== path) toast.textContent = '';
    if (path === '/items') {
      fetch('/api/items').then((r) => r.json()).then((items) => {
        view.innerHTML = '<h1>Items</h1><ul>' + items.map((i) => '<li>' + link(i.id) + '</li>').join('') + '</ul>';
        wire();
      });
    } else if (path === '/items/search') {
      view.innerHTML = '<h1>Search items</h1><label>Number <input id="q" autocomplete="off"></label>' +
        '<button type="button" id="run">Search</button><ul id="results"></ul>';
      document.getElementById('run').addEventListener('click', async () => {
        const q = document.getElementById('q').value;
        const found = await fetch('/api/items?q=' + encodeURIComponent(q)).then((r) => r.json());
        document.getElementById('results').innerHTML = found.map((i) => '<li>' + link(i.id) + '</li>').join('');
        wire();
      });
    } else if (path === '/items/new') {
      view.innerHTML = '<h1>New item</h1><label>Name <input id="name" autocomplete="off"></label>' +
        '<button type="button" id="create">Create</button>';
      document.getElementById('create').addEventListener('click', async () => {
        const response = await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value }) });
        const created = await response.json();
        toast.dataset.keep = '/items/' + created.id;
        toast.textContent = 'item ' + created.id + ' created';
        go('/items/' + created.id);
      });
    } else if (/^\\/items\\/\\d+$/.test(path)) {
      const id = path.split('/').pop();
      view.innerHTML = '<h1>Loading…</h1>';
      fetch('/api/items/' + id).then((r) => r.json()).then((item) => {
        view.innerHTML = '<h1>item ' + item.id + '</h1><label>Description <input id="description" autocomplete="off"></label>' +
          '<button type="button" id="save">Save</button>';
        document.getElementById('save').addEventListener('click', async () => {
          await fetch('/api/items/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: document.getElementById('description').value }) });
        });
      });
    } else view.innerHTML = '<h1>Home</h1>';
  }
  document.getElementById('list').addEventListener('click', () => go('/items'));
  document.getElementById('find').addEventListener('click', () => go('/items/search'));
  document.getElementById('new').addEventListener('click', () => go('/items/new'));
  window.addEventListener('popstate', render);
  render();
</script>
</body></html>`;

export interface ItemRecordingApp {
  url: string;
  /** Remet l'application à zéro : seul l'item 123 existe. */
  reset: () => void;
  close: () => Promise<void>;
}

export async function startItemRecordingApp(): Promise<ItemRecordingApp> {
  let items: string[] = ['123'];
  let next = 456;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/items' && request.method === 'POST') {
      request.resume();
      const id = String(next);
      next += 1;
      items.push(id);
      json(201, { id, name: 'x' });
      return;
    }
    if (url.pathname === '/api/items' && request.method === 'GET') {
      const q = url.searchParams.get('q');
      json(
        200,
        items.filter((id) => q === null || id === q).map((id) => ({ id })),
      );
      return;
    }
    const match = /^\/api\/items\/(\d+)$/.exec(url.pathname);
    if (match) {
      request.resume();
      const id = match[1] ?? '';
      if (!items.includes(id)) {
        json(404, { error: 'not found' });
        return;
      }
      json(200, { id });
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    reset: () => {
      items = ['123'];
      next = 456;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
