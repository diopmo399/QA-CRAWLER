import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * « Requests » : une application de démonstration DÉTERMINISTE pour la vérification métier. Une API
 * REST en mémoire (création, détail, recherche) et des écrans simples :
 *
 *   /            « New request », « Search requests »
 *   /new         « Title » + « Save » → POST /api/requests → /requests/<id>
 *   /requests/ID le détail (titre, statut, propriétaire), relu par GET /api/requests/<id>
 *   /search      « Search » → GET /api/requests?q=… → la liste des résultats
 *
 * Défauts activables (`bugs`) : le serveur enregistre un autre titre (`wrongTitle`), crée deux fois
 * (`duplicate`), rattache un autre propriétaire (`wrongOwner`), garde le statut PENDING un moment
 * avant OPEN (`asyncStatusMs`). /api/private/… répond toujours 403 (une lecture non autorisée).
 */
export interface QualityAppBugs {
  wrongTitle?: boolean;
  duplicate?: boolean;
  wrongOwner?: boolean;
  asyncStatusMs?: number;
}

export interface QualityApp {
  url: string;
  bugs: QualityAppBugs;
  records(): { id: string; title: string; ownerId: string }[];
  reset(): void;
  close(): Promise<void>;
}

interface StoredRequest {
  id: string;
  number: string;
  title: string;
  ownerId: string;
  createdAt: number;
}

const DEFAULT_OWNER = 'USR-2001';

const layout = (title: string, body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main><script>${script}</script></body></html>`;

const HOME = layout(
  'Requests',
  `<h1>Requests</h1>
<button type="button" id="new" onclick="location.href='/new'">New request</button>
<button type="button" id="find" onclick="location.href='/search'">Search requests</button>`,
);

const NEW = layout(
  'New request',
  `<h1>New request</h1>
<form onsubmit="return false">
  <label for="title">Title</label> <input id="title" name="title" autocomplete="off">
  <button type="button" id="save">Save</button>
</form>
<p id="out" role="status"></p>`,
  `document.getElementById('save').addEventListener('click', async () => {
    const title = document.getElementById('title').value;
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, kind: 'printer' }),
    });
    if (response.status !== 201) { document.getElementById('out').textContent = 'Error ' + response.status; return; }
    const created = await response.json();
    location.href = '/requests/' + encodeURIComponent(created.id);
  });`,
);

const DETAIL = layout(
  'Request',
  `<h1 id="title">Loading…</h1>
<p>Status: <span id="status"></span></p>
<p>Owner: <span id="owner"></span></p>
<button type="button" id="find" onclick="location.href='/search'">Search requests</button>`,
  `(async () => {
    const id = decodeURIComponent(location.pathname.split('/').pop());
    const response = await fetch('/api/requests/' + encodeURIComponent(id));
    const request = await response.json();
    document.getElementById('title').textContent = request.title;
    document.getElementById('status').textContent = request.status;
    document.getElementById('owner').textContent = request.ownerId;
  })();`,
);

const SEARCH = layout(
  'Search requests',
  `<h1>Search requests</h1>
<form onsubmit="return false">
  <label for="q">Search</label> <input id="q" name="q" autocomplete="off">
  <button type="button" id="go">Search</button>
</form>
<ul id="results"></ul>`,
  `document.getElementById('go').addEventListener('click', async () => {
    const q = document.getElementById('q').value;
    const response = await fetch('/api/requests?q=' + encodeURIComponent(q));
    const body = await response.json();
    const list = document.getElementById('results');
    list.innerHTML = '';
    for (const item of body.items) {
      const li = document.createElement('li');
      li.textContent = item.number + ' — ' + item.title + ' (' + item.status + ')';
      list.appendChild(li);
    }
    const count = document.createElement('li');
    count.textContent = body.items.length + ' result(s)';
    list.appendChild(count);
  });`,
);

export async function startQualityApp(): Promise<QualityApp> {
  const store: StoredRequest[] = [];
  const bugs: QualityAppBugs = {};
  let sequence = 1000;
  const view = (request: StoredRequest): Record<string, unknown> => ({
    id: request.id,
    number: request.number,
    title: request.title,
    ownerId: request.ownerId,
    status:
      bugs.asyncStatusMs !== undefined && Date.now() - request.createdAt < bugs.asyncStatusMs
        ? 'PENDING'
        : 'OPEN',
  });
  const create = (title: string): StoredRequest => {
    sequence += 1;
    const request: StoredRequest = {
      id: `REQ-${String(sequence)}`,
      number: `N-${String(sequence)}`,
      title: bugs.wrongTitle ? `${title} (draft)` : title,
      ownerId: bugs.wrongOwner ? 'USR-9999' : DEFAULT_OWNER,
      createdAt: Date.now(),
    };
    store.push(request);
    return request;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const html = (body: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (url.pathname.startsWith('/api/private/')) {
      json(403, { error: 'forbidden' });
      return;
    }
    if (url.pathname === '/api/requests' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { title?: string };
        const title = (body.title ?? '').trim();
        if (title === '') {
          json(400, { error: 'title is required' });
          return;
        }
        const created = create(title);
        if (bugs.duplicate) {
          const copy = create(title);
          copy.number = created.number;
        }
        json(201, view(created));
      });
      return;
    }
    if (url.pathname === '/api/requests' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      json(200, {
        items: store.filter((request) => request.title.toLowerCase().includes(q)).map(view),
        total: store.length,
      });
      return;
    }
    const detail = /^\/api\/requests\/([^/]+)$/.exec(url.pathname);
    if (detail && req.method === 'GET') {
      const found = store.find((request) => request.id === decodeURIComponent(detail[1] ?? ''));
      if (found) json(200, view(found));
      else json(404, { error: 'not found' });
      return;
    }
    if (url.pathname === '/') {
      html(HOME);
      return;
    }
    if (url.pathname === '/new') {
      html(NEW);
      return;
    }
    if (url.pathname === '/search') {
      html(SEARCH);
      return;
    }
    if (url.pathname.startsWith('/requests/')) {
      html(DETAIL);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    bugs,
    records: () => store.map(({ id, title, ownerId }) => ({ id, title, ownerId })),
    reset: () => {
      store.length = 0;
      bugs.wrongTitle = undefined;
      bugs.duplicate = undefined;
      bugs.wrongOwner = undefined;
      bugs.asyncStatusMs = undefined;
    },
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
