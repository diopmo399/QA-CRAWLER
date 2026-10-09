import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * UNE APPLICATION INCONNUE À MICRO-FRONTENDS : un shell, une liste de tasks servie par un BFF
 * (/bff/tasks), des micro-frontends (éléments personnalisés <items-create>, <items-detail>,
 * <items-search>, et un dans une iframe), des « items » identifiés par une clé métier (ABC123).
 * Une SPA : aucune navigation ne recharge la page.
 *
 *   variant « mfe »    : chaque vue est un élément personnalisé dans <app-shell>
 *   variant « plain »  : les mêmes vues dans de simples <div> (seules les routes changent)
 *
 * Tasks au départ : 456 (créer un item), 457 (traiter l'item existant ABC777), 458 (revue, dans une
 * iframe). Une création ajoute une task de suivi 900 qui porte la nouvelle clé : l'identifiant de
 * la task n'est pas celui de l'item.
 */
export type WorkspaceVariant = 'mfe' | 'plain';

const page = (
  variant: WorkspaceVariant,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Workspace</title>
<style>${variant === 'mfe' ? 'app-shell,task-list,items-create,items-detail,items-search,home-view' : '.view,.shell'}{display:block;min-height:260px;width:100%;box-sizing:border-box;padding:8px}</style></head>
<body>
<${variant === 'mfe' ? 'app-shell' : 'div class="shell"'} id="shell">
  <nav><button type="button" id="tasks">Tasks</button> <button type="button" id="search">Search items</button></nav>
  <main id="view"></main>
  <p id="toast" role="status"></p>
</${variant === 'mfe' ? 'app-shell' : 'div'}>
<script>
  const MFE = ${JSON.stringify(variant === 'mfe')};
  for (const tag of ['app-shell', 'task-list', 'items-create', 'items-detail', 'items-search', 'home-view'])
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {});
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const go = (path) => { history.pushState({}, '', path); render(); };
  const mount = (tag, html) => {
    view.innerHTML = MFE ? '<' + tag + '>' + html + '</' + tag + '>' : '<div class="view">' + html + '</div>';
  };
  function render() {
    const path = location.pathname;
    if (toast.dataset.keep !== path) toast.textContent = '';
    if (path === '/tasks') {
      mount('task-list', '<h1>Tasks</h1><table><tbody id="rows"></tbody></table><div id="frame"></div>');
      // Bruit technique d'une vraie application : découverte OpenID et profil OIDC (jamais du métier).
      fetch('/.well-known/openid-configuration').then((r) => r.json()).then(() => fetch('/oidc/client-app-shell/userinfo'));
      fetch('/bff/tasks').then((r) => r.json()).then((tasks) => {
        document.getElementById('rows').innerHTML = tasks.map((t) =>
          '<tr><td><button type="button" class="task" data-id="' + t.taskId + '" data-type="' + t.type + '" data-key="' + (t.businessKey || '') + '">Task ' + t.taskId + '</button></td><td>' + t.type + '</td><td>' + (t.businessKey || '') + '</td></tr>').join('');
        for (const button of document.querySelectorAll('button.task'))
          button.addEventListener('click', () => {
            const type = button.dataset.type;
            if (type === 'CREATE') go('/items/new');
            else if (type === 'REVIEW_FRAME')
              document.getElementById('frame').innerHTML = '<iframe title="Review" src="/mfe/review" style="width:600px;height:260px;border:1px solid #888"></iframe>';
            else go('/items/' + button.dataset.key);
          });
      });
    } else if (path === '/items/new') {
      mount('items-create', '<h1>New item</h1><label>Name <input id="name" autocomplete="off"></label> <button type="button" id="create">Create</button>');
      document.getElementById('create').addEventListener('click', async () => {
        const created = await fetch('/bff/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value }) }).then((r) => r.json());
        toast.dataset.keep = '/items/' + created.businessKey;
        toast.textContent = 'Item ' + created.businessKey + ' created';
        go('/items/' + created.businessKey);
      });
    } else if (path === '/items/search') {
      mount('items-search', '<h1>Search items</h1><label>Business key <input id="q" autocomplete="off"></label> <button type="button" id="run">Search</button><ul id="results"></ul>');
      document.getElementById('run').addEventListener('click', async () => {
        const q = document.getElementById('q').value;
        const found = await fetch('/bff/items?q=' + encodeURIComponent(q)).then((r) => r.json());
        document.getElementById('results').innerHTML = found.items.map((i) => '<li><a href="/items/' + i.businessKey + '" class="item">Item ' + i.businessKey + '</a></li>').join('');
        for (const a of document.querySelectorAll('a.item'))
          a.addEventListener('click', (event) => { event.preventDefault(); go(a.getAttribute('href')); });
      });
    } else if (/^\\/items\\/[A-Z]+\\d+$/.test(path)) {
      const key = path.split('/').pop();
      mount('items-detail', '<h1>Loading…</h1>');
      fetch('/bff/items/' + key).then((r) => r.json()).then((item) => {
        mount('items-detail', '<h1>Item ' + item.businessKey + '</h1><label>Description <input id="description" autocomplete="off"></label> <button type="button" id="save">Save</button>');
        document.getElementById('save').addEventListener('click', async () => {
          await fetch('/bff/items/' + key, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: document.getElementById('description').value }) });
          toast.textContent = 'Saved';
        });
      });
    } else mount('home-view', '<h1>Home</h1>');
  }
  document.getElementById('tasks').addEventListener('click', () => go('/tasks'));
  document.getElementById('search').addEventListener('click', () => go('/items/search'));
  window.addEventListener('popstate', render);
  render();
</script>
</body></html>`;

const REVIEW = `<!doctype html><html><head><meta charset="utf-8"><title>Review</title></head><body><h1>Review</h1><button type="button">Approve</button></body></html>`;

export interface WorkspaceRecordingApp {
  url: string;
  variant: WorkspaceVariant;
  reset: () => void;
  close: () => Promise<void>;
}

export async function startWorkspaceRecordingApp(): Promise<WorkspaceRecordingApp> {
  const state = {
    variant: 'mfe' as WorkspaceVariant,
    tasks: [] as { taskId: string; type: string; businessKey?: string }[],
    items: [] as string[],
    next: 123,
  };
  const reset = (): void => {
    state.tasks = [
      { taskId: '456', type: 'CREATE' },
      { taskId: '457', type: 'UPDATE', businessKey: 'ABC777' },
      { taskId: '458', type: 'REVIEW_FRAME' },
    ];
    state.items = ['ABC777'];
    state.next = 123;
  };
  reset();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer: 'http://idp.test',
        authorization_endpoint: 'http://idp.test/authorize',
        jwks_uri: 'http://idp.test/jwks',
      });
      return;
    }
    if (url.pathname === '/oidc/client-app-shell/userinfo') {
      json(200, { sub: 'user-1', name: 'Alex' });
      return;
    }
    if (url.pathname === '/bff/tasks') {
      json(200, state.tasks);
      return;
    }
    if (url.pathname === '/bff/items' && request.method === 'POST') {
      request.resume();
      const key = `ABC${String(state.next)}`;
      state.next += 1;
      state.items.push(key);
      state.tasks.push({ taskId: '900', type: 'REVIEW', businessKey: key });
      json(201, { businessKey: key, status: 'NEW' });
      return;
    }
    if (url.pathname === '/bff/items') {
      const q = url.searchParams.get('q') ?? '';
      json(200, {
        items: state.items.filter((key) => key === q).map((key) => ({ id: 99, businessKey: key })),
      });
      return;
    }
    const match = /^\/bff\/items\/([A-Z]+\d+)$/.exec(url.pathname);
    if (match) {
      request.resume();
      json(200, { businessKey: match[1] });
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(url.pathname === '/mfe/review' ? REVIEW : page(state.variant));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    get variant() {
      return state.variant;
    },
    set variant(value: WorkspaceVariant) {
      state.variant = value;
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
