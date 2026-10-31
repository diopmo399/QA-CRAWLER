import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * L'INCIDENT CONNU, en vrai : le catalogue de livres dont le code est dans tests/fixtures/incident-app.
 * La page « Nouveau livre » envoie POST /api/books ; sans éditeur, le formulaire omet `publisherId`
 * (le défaut de toCreateBookPayload) et l'API répond 500 avec l'erreur du backend propagée par le BFF
 * (NullPointerException sur CatalogBook.getPublisher()). Avec un éditeur : 201, « Livre créé ».
 * Le site garde chaque requête de l'API (méthode, chemin, corps) pour que les tests vérifient ce qui a été joué.
 */
export interface IncidentSite {
  url: string;
  calls: { method: string; path: string; body: string }[];
  close(): Promise<void>;
}

const BACKEND_ERROR = JSON.stringify({
  status: 500,
  error: 'Internal Server Error',
  exception: 'java.lang.NullPointerException',
  message:
    'Cannot invoke "org.example.catalog.books.Publisher.getName()" because the return value of "org.example.catalog.books.CatalogBook.getPublisher()" is null',
  path: '/catalog/books',
});

const page = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head>
<body><nav><a href="/books">Livres</a></nav><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

// Le même comportement que frontend/src/books/payload.ts : l'éditeur vide est omis au lieu d'être refusé.
const FORM_SCRIPT = `
document.querySelector('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = { title: form.get('title'), isbn: form.get('isbn') };
  const publisherId = form.get('publisherId');
  if (publisherId) payload.publisherId = Number(publisherId);
  const status = document.getElementById('status');
  status.textContent = 'Enregistrement…';
  try {
    const response = await fetch('/api/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const book = await response.json();
    status.textContent = 'Livre créé : ' + book.title;
  } catch (error) {
    status.setAttribute('role', 'alert');
    status.textContent = 'Erreur ' + error.message + ' : le livre n’a pas été enregistré.';
  }
});`;

const PAGES: Record<string, () => string> = {
  '/books': () => page('Livres', '<p>Catalogue</p><a href="/books/new">Nouveau livre</a>'),
  '/books/new': () =>
    page(
      'Nouveau livre',
      `<form>
        <label>Titre <input name="title" required></label>
        <label>ISBN <input name="isbn"></label>
        <label>Éditeur <select name="publisherId"><option value="">—</option><option value="1">Éditions du Nord</option><option value="2">Maison Lumière</option></select></label>
        <button type="submit">Enregistrer</button>
      </form><p id="status" aria-live="polite"></p>`,
      FORM_SCRIPT,
    ),
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').slice(0, 10_000);
}

async function handle(request: IncomingMessage, response: ServerResponse, site: IncidentSite): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/books' && request.method === 'POST') {
    const body = await readBody(request);
    site.calls.push({ method: 'POST', path: url.pathname, body });
    let payload: { title?: unknown; publisherId?: unknown } = {};
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      response
        .writeHead(400, { 'content-type': 'application/json' })
        .end('{"status":400,"error":"Bad Request"}');
      return;
    }
    if (typeof payload.publisherId !== 'number') {
      response.writeHead(500, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          status: 500,
          error: 'Internal Server Error',
          path: '/api/books',
          message: `Catalog error: 500 : "${BACKEND_ERROR}"`,
        }),
      );
      return;
    }
    response.writeHead(201, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: site.calls.length,
        title: typeof payload.title === 'string' ? payload.title : '',
      }),
    );
    return;
  }
  const render = PAGES[url.pathname === '/' ? '/books' : url.pathname];
  if (!render || request.method !== 'GET') {
    response
      .writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      .end(page('Introuvable', '<p>404</p>'));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(render());
}

export async function startIncidentSite(): Promise<IncidentSite> {
  const site: IncidentSite = { url: '', calls: [], close: () => Promise.resolve() };
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
