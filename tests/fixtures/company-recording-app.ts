import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * UNE APPLICATION OÙ L'IDENTIFIANT N'EST JAMAIS MONTRÉ : on crée une société (nom, adresse), le
 * serveur génère un identifiant qu'il ne renvoie pas (204), l'écran revient à la liste des tasks ;
 * on la retrouve par une RECHERCHE envoyée en POST avec un JSON de critères (pagination comprise), et
 * on ouvre le résultat. L'identifiant n'apparaît que dans la réponse de la recherche et l'URL du détail.
 *
 * Une SPA : aucune navigation ne recharge la page.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Companies</title></head>
<body>
<nav><button type="button" id="tasks">Tasks</button> <button type="button" id="new">New company</button></nav>
<main id="view"></main>
<p id="toast" role="status"></p>
<script>
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const go = (path) => { history.pushState({}, '', path); render(); };
  function render() {
    const path = location.pathname;
    if (path === '/companies/new') {
      toast.textContent = '';
      view.innerHTML = '<h1>New company</h1><label>Company name <input id="name" autocomplete="off"></label> <label>Address <input id="address" autocomplete="off"></label> <button type="button" id="save">Save</button>';
      document.getElementById('save').addEventListener('click', async () => {
        await fetch('/api/companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyName: document.getElementById('name').value, address: document.getElementById('address').value }) });
        go('/tasks');
        toast.textContent = 'Saved';
      });
    } else if (path === '/tasks') {
      view.innerHTML = '<h1>Tasks</h1><label>Search companies <input id="q" autocomplete="off"></label> <button type="button" id="run">Search</button><ul id="results"></ul>';
      document.getElementById('run').addEventListener('click', async () => {
        const found = await fetch('/api/companies/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filters: { companyName: document.getElementById('q').value }, page: 0, size: 20 }) }).then((r) => r.json());
        document.getElementById('results').innerHTML = found.items.map((c) => '<li><button type="button" class="result" data-id="' + c.id + '">' + c.companyName + '</button></li>').join('');
        for (const button of document.querySelectorAll('button.result'))
          button.addEventListener('click', () => go('/companies/' + button.dataset.id));
      });
    } else if (/^\\/companies\\/\\d+$/.test(path)) {
      const id = path.split('/').pop();
      view.innerHTML = '<h1>Loading…</h1>';
      fetch('/api/companies/' + id).then((r) => r.json()).then((c) => {
        view.innerHTML = '<h1>' + c.companyName + '</h1><p>' + c.address + '</p>';
      });
    } else view.innerHTML = '<h1>Home</h1>';
  }
  document.getElementById('tasks').addEventListener('click', () => go('/tasks'));
  document.getElementById('new').addEventListener('click', () => go('/companies/new'));
  window.addEventListener('popstate', render);
  render();
</script>
</body></html>`;

export interface CompanyRecordingApp {
  url: string;
  /** Une société homonyme qui existait déjà avant l'enregistrement. */
  seedHomonym: boolean;
  reset: () => void;
  close: () => Promise<void>;
}

interface Company {
  id: string;
  companyName: string;
  address: string;
}

export async function startCompanyRecordingApp(): Promise<CompanyRecordingApp> {
  const state = { companies: [] as Company[], next: 123456, seedHomonym: false };
  const reset = (): void => {
    state.companies = state.seedHomonym
      ? [{ id: '777001', companyName: 'Company Test QA', address: '9 Old Road' }]
      : [];
    state.next = 123456;
  };
  reset();
  const body = (request: IncomingMessage): Promise<Record<string, string | undefined>> =>
    new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString()));
      request.on('end', () => {
        try {
          resolve(text ? (JSON.parse(text) as Record<string, string | undefined>) : {});
        } catch {
          resolve({});
        }
      });
    });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, payload: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === '/api/companies' && request.method === 'POST') {
      void body(request).then((data) => {
        // L'identifiant est généré côté serveur, mais JAMAIS renvoyé : 204, aucun corps.
        state.companies.push({
          id: String(state.next),
          companyName: data.companyName ?? '',
          address: data.address ?? '',
        });
        state.next += 1;
        response.statusCode = 204;
        response.end();
      });
      return;
    }
    if (url.pathname === '/api/companies/search' && request.method === 'POST') {
      void body(request).then((data) => {
        const filters = (data.filters ?? {}) as unknown as { companyName?: string };
        const items = state.companies.filter((company) => company.companyName === filters.companyName);
        json(200, { items, total: items.length, page: 0 });
      });
      return;
    }
    const detail = /^\/api\/companies\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const found = state.companies.find((company) => company.id === detail[1]);
      json(found ? 200 : 404, found ?? {});
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    get seedHomonym() {
      return state.seedHomonym;
    },
    set seedHomonym(value: boolean) {
      state.seedHomonym = value;
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
