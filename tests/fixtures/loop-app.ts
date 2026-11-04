import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * UNE APPLICATION POUR LES BOUCLES ET LE SCÉNARIO D'ACCEPTATION (SPA, aucune navigation ne recharge la page) :
 *   - créer une société (nom) : POST /api/companies → { id } ; la confirmation n'apparaît qu'après un délai,
 *     puis l'adresse devient /companies/<id> et l'identifiant est affiché (#company-id) ;
 *   - créer un dossier pour une société EXISTANTE (le serveur refuse un nom inconnu, 422) :
 *     POST /api/requests → { id, status: DRAFT } ; l'adresse devient /requests/<id> ;
 *   - ajouter des personnes au dossier : POST /api/requests/<id>/persons → { id } ; la ligne n'apparaît qu'après
 *     un délai ; le statut passe à COMPLETE à la troisième personne ;
 *   - une file d'éléments à traiter (/queue) : « Process one » en retire un (WHILE), et un bandeau qui ne
 *     disparaît jamais (protection contre la boucle infinie) ;
 *   - un compteur (/counter) : « Increment » (REPEAT).
 */
const page =
  (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requests</title></head>
<body>
<nav>
  <button type="button" id="nav-company">New company</button>
  <button type="button" id="nav-queue">Queue</button>
  <button type="button" id="nav-counter">Counter</button>
</nav>
<main id="view"></main>
<p id="toast" role="status"></p>
<script>
  const DELAY = window.__delay ?? 700;
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const go = (path) => { history.pushState({}, '', path); render(); };
  const json = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  async function render() {
    const path = location.pathname;
    toast.textContent = '';
    if (path === '/companies/new') {
      view.innerHTML = '<h1>New company</h1><label>Company name <input id="name" autocomplete="off"></label> <button type="button" id="create-company">Create company</button>';
      document.getElementById('create-company').addEventListener('click', async () => {
        const response = await json('/api/companies', { name: document.getElementById('name').value });
        if (!response.ok) { toast.textContent = 'Refused: ' + (await response.text()); return; }
        const created = await response.json();
        toast.textContent = 'Creating…';
        setTimeout(() => go('/companies/' + created.id), DELAY);
      });
    } else if (/^\\/companies\\/\\d+$/.test(path)) {
      const id = path.split('/').pop();
      const company = await fetch('/api/companies/' + id).then((r) => r.json());
      view.innerHTML = '<h1>' + escape(company.name) + '</h1><p class="confirmation">Company created</p><p>Company id <span id="company-id">' + company.id + '</span></p><button type="button" id="new-request">New request</button>';
      document.getElementById('new-request').addEventListener('click', () => go('/requests/new'));
    } else if (path === '/requests/new') {
      view.innerHTML = '<h1>New request</h1><label>Request title <input id="title" autocomplete="off"></label> <label>Company <input id="company" autocomplete="off"></label> <button type="button" id="create-request">Create request</button>';
      document.getElementById('create-request').addEventListener('click', async () => {
        const response = await json('/api/requests', { title: document.getElementById('title').value, company: document.getElementById('company').value });
        if (!response.ok) { toast.textContent = 'Refused: ' + (await response.text()); return; }
        const created = await response.json();
        go('/requests/' + created.id);
      });
    } else if (/^\\/requests\\/\\d+$/.test(path)) {
      const id = path.split('/').pop();
      const request = await fetch('/api/requests/' + id).then((r) => r.json());
      view.innerHTML = '<h1>Request ' + request.id + '</h1><p>Company: <span id="request-company">' + escape(request.company) + '</span></p><p>Status <strong id="request-status">' + request.status + '</strong></p>'
        + '<ul id="persons">' + request.persons.map((p) => '<li data-id="' + p.id + '">' + escape(p.firstName + ' ' + p.lastName) + ' #' + p.id + '</li>').join('') + '</ul>'
        + '<label>First name <input id="first" autocomplete="off"></label> <label>Last name <input id="last" autocomplete="off"></label> <label>Email <input id="email" autocomplete="off"></label> <button type="button" id="add-person">Add person</button>';
      document.getElementById('add-person').addEventListener('click', async () => {
        const response = await json('/api/requests/' + id + '/persons', { firstName: document.getElementById('first').value, lastName: document.getElementById('last').value, email: document.getElementById('email').value });
        if (!response.ok) { toast.textContent = 'Refused: ' + (await response.text()); return; }
        toast.textContent = 'Adding…';
        setTimeout(() => { render(); }, DELAY);
      });
    } else if (path === '/queue') {
      const queue = await fetch('/api/queue').then((r) => r.json());
      view.innerHTML = '<h1>Queue</h1><p class="banner">Always visible banner</p><ul id="queue">' + queue.items.map((item) => '<li class="pending-item">' + escape(item) + '</li>').join('') + '</ul><p id="processed">Processed ' + queue.processed + '</p><button type="button" id="process">Process one</button>';
      document.getElementById('process').addEventListener('click', async () => {
        await json('/api/queue/process', {});
        render();
      });
    } else if (path === '/counter') {
      const counter = await fetch('/api/counter').then((r) => r.json());
      view.innerHTML = '<h1>Counter</h1><p>Count <span id="count">' + counter.value + '</span></p><button type="button" id="increment">Increment</button>';
      document.getElementById('increment').addEventListener('click', async () => {
        await json('/api/counter/increment', {});
        render();
      });
    } else view.innerHTML = '<h1>Home</h1>';
  }
  document.getElementById('nav-company').addEventListener('click', () => go('/companies/new'));
  document.getElementById('nav-queue').addEventListener('click', () => go('/queue'));
  document.getElementById('nav-counter').addEventListener('click', () => go('/counter'));
  window.addEventListener('popstate', render);
  render();
</script>
</body></html>`;

export interface LoopPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface LoopRequest {
  id: string;
  title: string;
  company: string;
  status: 'DRAFT' | 'COMPLETE';
  persons: LoopPerson[];
}

export interface LoopApp {
  url: string;
  companies: () => { id: string; name: string }[];
  requests: () => LoopRequest[];
  counter: () => number;
  /** Remplit la file (/queue) avec ces éléments. */
  fillQueue: (items: string[]) => void;
  reset: () => void;
  close: () => Promise<void>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export async function startLoopApp(): Promise<LoopApp> {
  const state = {
    next: 100,
    companies: [] as { id: string; name: string }[],
    requests: [] as LoopRequest[],
    queue: [] as string[],
    processed: 0,
    counter: 0,
  };
  const reset = (): void => {
    state.companies = [];
    state.requests = [];
    state.queue = [];
    state.processed = 0;
    state.counter = 0;
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const refuse = (status: number, message: string): void => {
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end(message);
      };
      const id = (): string => {
        state.next += 1;
        return String(state.next);
      };
      if (request.method === 'POST' && url.pathname === '/api/companies') {
        const name = text((await body(request)).name);
        if (name === '') {
          refuse(422, 'a company needs a name');
          return;
        }
        if (state.companies.some((company) => company.name === name)) {
          refuse(409, 'this company exists');
          return;
        }
        const company = { id: id(), name };
        state.companies.push(company);
        send(201, company);
        return;
      }
      const company = /^\/api\/companies\/(\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && company) {
        const found = state.companies.find((entry) => entry.id === company[1]);
        if (found) send(200, found);
        else refuse(404, 'no such company');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/requests') {
        const payload = await body(request);
        const owner = text(payload.company);
        if (!state.companies.some((entry) => entry.name === owner)) {
          refuse(422, `no company named "${owner}"`);
          return;
        }
        const created: LoopRequest = {
          id: id(),
          title: text(payload.title),
          company: owner,
          status: 'DRAFT',
          persons: [],
        };
        state.requests.push(created);
        send(201, { id: created.id, status: created.status });
        return;
      }
      const requestMatch = /^\/api\/requests\/(\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && requestMatch) {
        const found = state.requests.find((entry) => entry.id === requestMatch[1]);
        if (found) send(200, found);
        else refuse(404, 'no such request');
        return;
      }
      const persons = /^\/api\/requests\/(\d+)\/persons$/.exec(url.pathname);
      if (request.method === 'POST' && persons) {
        const found = state.requests.find((entry) => entry.id === persons[1]);
        if (!found) {
          refuse(404, 'no such request');
          return;
        }
        const payload = await body(request);
        const person: LoopPerson = {
          id: id(),
          firstName: text(payload.firstName),
          lastName: text(payload.lastName),
          email: text(payload.email),
        };
        if (person.firstName === '' || person.lastName === '') {
          refuse(422, 'a person needs a name');
          return;
        }
        if (found.persons.some((entry) => entry.email !== '' && entry.email === person.email)) {
          refuse(409, 'this email is already in the request');
          return;
        }
        found.persons.push(person);
        if (found.persons.length >= 3) found.status = 'COMPLETE';
        send(201, { id: person.id });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/queue') {
        send(200, { items: state.queue, processed: state.processed });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/queue/process') {
        if (state.queue.shift() !== undefined) state.processed += 1;
        send(200, { items: state.queue, processed: state.processed });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/counter') {
        send(200, { value: state.counter });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/counter/increment') {
        state.counter += 1;
        send(200, { value: state.counter });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        refuse(404, 'unknown');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page());
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    companies: () => state.companies.map((entry) => ({ ...entry })),
    requests: () => state.requests.map((entry) => ({ ...entry, persons: [...entry.persons] })),
    counter: () => state.counter,
    fillQueue: (items) => {
      state.queue = [...items];
      state.processed = 0;
    },
    reset,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
