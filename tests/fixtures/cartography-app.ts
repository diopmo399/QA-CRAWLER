import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * L'APPLICATION JOUÉE PAR LES SCÉNARIOS DE LA CARTOGRAPHIE : l'écran `/requests/new` du mini-projet
 * (tests/fixtures/cartography/front), servi tel que son gabarit le décrit — « Company name » (libellé
 * relié par `for`), « Contact email » — et l'appel `POST /api/requests` : 201 avec un nom, 400 sans.
 * Aucun contrôle côté navigateur : le refus vient du serveur, comme le BFF de la fixture (@NotBlank).
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requests</title></head>
<body>
<main id="view"></main>
<p id="toast" role="status"></p>
<script>
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  function render() {
    if (location.pathname === '/requests/new') {
      view.innerHTML = '<h1>New request</h1><form id="form"><label for="companyName">Company name</label> <input id="companyName" type="text"> <label>Contact email <input type="email" id="contactEmail"></label> <button type="submit">Save</button></form>';
      document.getElementById('form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const response = await fetch('/api/requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ companyName: document.getElementById('companyName').value, contactEmail: document.getElementById('contactEmail').value }),
        });
        toast.textContent = response.status === 201 ? 'Saved' : 'Refused';
      });
    } else view.innerHTML = '<h1>Home</h1>';
  }
  render();
</script>
</body></html>`;

export interface CartographyApp {
  url: string;
  /** Les demandes acceptées (nom seulement : aucune autre valeur n'est gardée). */
  accepted(): string[];
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startCartographyApp(): Promise<CartographyApp> {
  const accepted: string[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/requests' && request.method === 'POST') {
        const input = await body(request);
        const name = typeof input.companyName === 'string' ? input.companyName.trim() : '';
        if (!name) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'companyName is required' }));
          return;
        }
        accepted.push(name);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: accepted.length }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    accepted: () => [...accepted],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
