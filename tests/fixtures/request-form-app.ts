import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un formulaire de demande (rendu par le serveur, envoyé en JSON) :
 *
 *   /requests/new   Title, Description, Request type (liste : INCIDENT / QUESTION),
 *                   Contact e-mail, « Urgent » (case), « Submit »
 *                   → POST /api/requests → 201 « Request saved »
 *                   → 409 EMAIL_ALREADY_EXISTS si l'e-mail de contact est déjà connu
 */
export interface RequestFormApp {
  url: string;
  created: {
    title?: string;
    description?: string;
    requestType?: string;
    contactEmail?: string;
    urgent?: boolean;
  }[];
  conflicts: number;
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>New request</title></head>
<body><main>
<h1>New request</h1>
<form id="f" novalidate>
  <div><label for="title">Title</label><input id="title" name="title"></div>
  <div><label for="description">Description</label><textarea id="description" name="description"></textarea></div>
  <div><label for="requestType">Request type</label><select id="requestType" name="requestType">
    <option value="">--</option><option value="INCIDENT">Incident</option><option value="QUESTION">Question</option></select></div>
  <div><label for="contactEmail">Contact e-mail</label><input id="contactEmail" name="contactEmail" type="email"></div>
  <div><label><input type="checkbox" name="urgent"> Urgent</label></div>
  <button type="submit">Submit</button>
</form>
<p id="result" role="status"></p>
</main>
<script>
  document.getElementById('f').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = {
      title: form.title.value,
      description: form.description.value,
      requestType: form.requestType.value,
      contactEmail: form.contactEmail.value,
      urgent: form.urgent.checked,
    };
    const response = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const answer = await response.json();
    document.getElementById('result').textContent = response.status === 201 ? 'Request saved' : 'Error: ' + answer.error;
  });
</script></body></html>`;

export async function startRequestFormApp(): Promise<RequestFormApp> {
  const app: Omit<RequestFormApp, 'url' | 'close'> = { created: [], conflicts: 0 };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/requests' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as RequestFormApp['created'][number];
        response.setHeader('content-type', 'application/json');
        if (body.contactEmail && app.created.some((item) => item.contactEmail === body.contactEmail)) {
          app.conflicts += 1;
          response.writeHead(409);
          response.end(JSON.stringify({ error: 'EMAIL_ALREADY_EXISTS' }));
          return;
        }
        app.created.push(body);
        response.writeHead(201);
        response.end(JSON.stringify({ id: app.created.length, status: 'OPEN' }));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    get created() {
      return app.created;
    },
    get conflicts() {
      return app.conflicts;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
