import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Application locale des tests d'acceptation :
 *
 * Login
 *  ↓
 * Dashboard
 *  ├── Users ── liste, formulaire de création (POST /api/users), détail
 *  ├── Wizard ── étape 1 → étape 2 → confirmation
 *  ├── Dialog
 *  ├── Broken API (HTTP 500 au chargement et au rafraîchissement)
 *  ├── History (une branche cassée : la page elle-même répond 500)
 *  ├── Pages (pagination sans fin : une boucle à éviter)
 *  └── Settings (un bouton qui lève une erreur JavaScript)
 *
 * Simule : API qui réussit, HTTP 400, HTTP 500, erreur JS, expiration de session,
 * fenêtre, validation de formulaire, assistant. `variant: 'B'` change l'écran de
 * détail d'un utilisateur (une différence avec une baseline apprise sur 'A').
 */
export interface AcceptanceApp {
  url: string;
  /** Corps des requêtes POST reçues, dans l'ordre. */
  posts: { path: string; body: string }[];
  /** Connexions réussies (la première, puis une par expiration de session). */
  logins: () => number;
  setVariant(variant: 'A' | 'B'): void;
  close(): Promise<void>;
}

export const ACCEPTANCE_USER = 'qa-tester';
export const ACCEPTANCE_PASSWORD = 'acc-pw-5b1c9e';

const LOGIN = `<h1>Sign in</h1><form method="post" action="/login">
  <label for="user">User</label><input id="user" name="user">
  <label for="pass">Password</label><input id="pass" name="pass" type="password">
  <button id="go">Sign in</button></form>`;

const NAV = `<nav><a href="/">Dashboard</a> <a href="/users">Users</a> <a href="/wizard">Wizard</a> <a href="/dialog">Dialog</a>
  <a href="/broken">Broken API</a> <a href="/history">History</a> <a href="/pages?page=1">Pages</a> <a href="/settings">Settings</a></nav>`;

const USERS = [
  { id: 1, name: 'Alice Martin' },
  { id: 2, name: 'Bruno Petit' },
];

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acceptance app</title></head><body>${NAV}<main>${body}</main></body></html>`;
}

function screens(variant: 'A' | 'B'): Record<string, string> {
  return {
    '/': '<h1>Dashboard</h1><p>Welcome.</p>',
    '/users': `<h1>Users</h1>
      <a href="/users/new">Create user</a>
      <ul>${USERS.map((user) => `<li><a href="/users/${user.id}">${user.name}</a></li>`).join('')}</ul>
      <button id="filter" onclick="fetch('/api/users?filter=%7Bbad').then((r) => { document.getElementById('msg').textContent = r.ok ? '' : 'Invalid filter'; })">Apply filter</button>
      <button id="flaky" onmouseover="this.style.display='none'">Refresh list</button>
      <p id="msg" role="status"></p>`,
    '/users/new': `<h1>Create user</h1>
      <form id="create" onsubmit="event.preventDefault();
        fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ firstName: firstName.value, lastName: lastName.value, email: email.value, role: role.value }) })
          .then((r) => { document.getElementById('result').textContent = r.ok ? 'User created' : 'Error: user not created'; });">
        <label for="firstName">First name</label><input id="firstName" name="firstName" required maxlength="40">
        <label for="lastName">Last name</label><input id="lastName" name="lastName" required maxlength="40">
        <label for="email">Email</label><input id="email" name="email" type="email" required>
        <label for="role">Role</label><select id="role" name="role"><option value="">-- Choose --</option><option>Reader</option><option>Editor</option></select>
        <button type="submit">Create</button>
      </form>
      <p id="result" role="status"></p>`,
    ...Object.fromEntries(
      USERS.map((user) => [
        `/users/${user.id}`,
        variant === 'A'
          ? `<h1>User detail</h1><p>${user.name}</p><button>Delete user</button>`
          : `<h1>User profile</h1><p>${user.name}</p><p>Profile moved</p><button>Delete user</button>`,
      ]),
    ),
    '/wizard': `<h1>New project</h1>
      <form id="wizard" onsubmit="event.preventDefault()">
        <section id="s1"><h2>Step 1 - Project</h2>
          <label for="project">Project name</label><input id="project" name="project" required>
          <label for="owner">Owner</label><input id="owner" name="owner" required>
          <button type="button" onclick="if (!project.value || !owner.value) return; s1.hidden = true; s2.hidden = false;">Next</button>
        </section>
        <section id="s2" hidden><h2>Step 2 - Plan</h2>
          <label><input type="radio" name="plan" value="basic"> Basic</label>
          <label><input type="radio" name="plan" value="pro"> Pro</label>
          <button type="button" onclick="s2.hidden = true; s3.hidden = false;">Next</button>
        </section>
        <section id="s3" hidden><h2>Confirmation</h2><p>Project ready.</p></section>
      </form>`,
    '/dialog': `<h1>Dialog</h1>
      <button onclick="document.getElementById('d').hidden = false">Open details</button>
      <div id="d" role="dialog" aria-label="Details" hidden><h2>Details</h2><p>Some details.</p>
        <button onclick="document.getElementById('d').hidden = true">Close</button></div>`,
    '/broken': `<h1>Statistics</h1><p id="stats" role="alert"></p>
      <button onclick="fetch('/api/stats').then((r) => { if (!r.ok) document.getElementById('stats').textContent = 'Error: statistics unavailable'; })">Refresh statistics</button>
      <script>fetch('/api/stats');</script>`,
    '/settings': `<h1>Settings</h1>
      <button onclick="throw new Error('settings widget crashed')">Show advanced</button>
      <details><summary>Preferences</summary><p>Nothing to change.</p></details>`,
  };
}

/** Chargements de page qu'une session permet avant d'expirer (ensuite : retour à la page de connexion). */
const PAGES_PER_SESSION = 25;

export async function startAcceptanceApp(): Promise<AcceptanceApp> {
  let variant: 'A' | 'B' = 'A';
  let logins = 0;
  const sessions = new Map<string, number>();
  const posts: AcceptanceApp['posts'] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://app.local');
    const html = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = (then: (body: string) => void): void => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        then(body);
      });
    };

    if (url.pathname === '/login' && req.method === 'POST') {
      readBody((body) => {
        const form = new URLSearchParams(body);
        if (form.get('user') !== ACCEPTANCE_USER || form.get('pass') !== ACCEPTANCE_PASSWORD) {
          html(401, `<!doctype html><html><body>${LOGIN}</body></html>`);
          return;
        }
        logins += 1;
        sessions.set(`s${logins}`, PAGES_PER_SESSION);
        res.writeHead(302, { location: '/', 'set-cookie': `sid=s${logins}; Path=/; HttpOnly` });
        res.end();
      });
      return;
    }
    if (url.pathname === '/login') {
      html(200, `<!doctype html><html><head><title>Sign in</title></head><body>${LOGIN}</body></html>`);
      return;
    }
    const sid = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const left = sessions.get(sid);
    if (left === undefined || left <= 0) {
      if (url.pathname.startsWith('/api/')) json(401, { error: 'session expired' });
      else {
        res.writeHead(302, { location: '/login' });
        res.end();
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/users' && req.method === 'POST') {
        readBody((body) => {
          posts.push({ path: url.pathname, body });
          const user = JSON.parse(body || '{}') as { email?: string };
          if (!user.email) json(400, { error: 'email required' });
          else json(201, { id: 3 });
        });
        return;
      }
      if (url.pathname === '/api/users') {
        json(
          url.searchParams.has('filter') ? 400 : 200,
          url.searchParams.has('filter') ? { error: 'bad filter' } : USERS,
        );
        return;
      }
      if (url.pathname === '/api/stats') {
        json(500, { error: 'statistics service down' });
        return;
      }
      json(404, { error: 'unknown' });
      return;
    }

    // Un chargement de page consomme la session.
    sessions.set(sid, left - 1);
    if (url.pathname === '/history') {
      html(500, page('<h1>Server error</h1><p>The history is broken.</p>'));
      return;
    }
    if (url.pathname === '/pages') {
      const current = Number(url.searchParams.get('page') ?? '1');
      html(
        200,
        page(`<h1>Pages</h1><p>Page ${current}</p><a href="/pages?page=${current + 1}">Next page</a>`),
      );
      return;
    }
    const body = screens(variant)[url.pathname];
    html(body ? 200 : 404, page(body ?? '<h1>Not found</h1>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    logins: () => logins,
    setVariant: (value) => {
      variant = value;
    },
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
