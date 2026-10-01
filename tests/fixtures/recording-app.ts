import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Petite application pour le HUMAN FLOW RECORDER :
 *
 *   /login           Nom d'utilisateur + mot de passe → POST /api/login → /users
 *   /users           liste (tableau), bouton « Add user », onglets Users / Reports (détours)
 *   /users/new       First name, Last name, Email, Country (pré-rempli), Account type (select),
 *                    Newsletter (case), Save → POST /api/users (201, ou 400 sans email) → /users
 *   /reports         une page sans rapport avec le flow (détour)
 *
 * Les écritures reçues sont gardées (méthode, chemin, statut, clés du corps) : les tests
 * prouvent ce que le rejeu a envoyé, jamais les valeurs.
 */
export interface RecordingApp {
  url: string;
  writes: { method: string; path: string; status: number; keys: string[]; accountType?: string }[];
  users: { firstName: string; email: string; accountType: string }[];
  close(): Promise<void>;
}

const page = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif} .error{color:#b91c1c} nav a{margin-right:12px}</style></head>
<body>
<nav aria-label="Main">
  <a href="/users" role="tab">Users</a>
  <a href="/reports" role="tab">Reports</a>
</nav>
<main><h1>${title}</h1>${body}</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;

export async function startRecordingApp(): Promise<RecordingApp> {
  const writes: RecordingApp['writes'] = [];
  const users: RecordingApp['users'] = [
    { firstName: 'Existing', email: 'existing@example.test', accountType: 'PERSONAL' },
  ];

  const usersPage = (): string =>
    page(
      'Users',
      `<button id="add" type="button" onclick="location.href='/users/new'">Add user</button>
       <table><thead><tr><th>First name</th><th>Type</th></tr></thead><tbody>${users
         .map((user) => `<tr><td>${escapeHtml(user.firstName)}</td><td>${user.accountType}</td></tr>`)
         .join('')}</tbody></table>`,
    );

  const newUserPage = page(
    'New user',
    `<form id="user-form" novalidate>
       <div><label for="mat-input-23">First name</label><input id="mat-input-23" formcontrolname="firstName"></div>
       <div><label for="mat-input-24">Last name</label><input id="mat-input-24" formcontrolname="lastName"></div>
       <div><label for="mat-input-25">Email</label><input id="mat-input-25" type="email" formcontrolname="email"></div>
       <div class="field"><span>Branch code</span><input id="mat-input-26"></div>
       <div><input id="mat-input-27" data-qa="Reference_input" aria-describedby="nothing"></div>
       <div><label for="country">Country</label><input id="country" name="country" value="Canada"></div>
       <div><label for="type">Account type</label>
         <select id="type" name="accountType"><option value="PERSONAL">Personal</option><option value="BUSINESS">Business</option></select></div>
       <div><label><input type="checkbox" name="newsletter"> Newsletter</label></div>
       <div id="errors" role="alert" class="error"></div>
       <button type="submit">Save</button>
     </form>`,
    `document.getElementById('user-form').addEventListener('submit', async (event) => {
       event.preventDefault();
       const form = event.target;
       const body = {
         firstName: form.querySelector('[formcontrolname=firstName]').value,
         lastName: form.querySelector('[formcontrolname=lastName]').value,
         email: form.querySelector('[formcontrolname=email]').value,
         country: form.country.value,
         accountType: form.accountType.value,
         newsletter: form.newsletter.checked,
         status: 'ACTIVE',
       };
       const errors = document.getElementById('errors');
       const email = form.querySelector('[formcontrolname=email]');
       const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
       if (response.status === 201) { location.href = '/users'; return; }
       email.setAttribute('aria-invalid', 'true');
       errors.textContent = 'Email is required';
     });`,
  );

  const loginPage = page(
    'Sign in',
    `<form id="login">
       <div><label for="u">Username</label><input id="u" name="username" autocomplete="username"></div>
       <div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password"></div>
       <button type="submit">Sign in</button>
     </form>`,
    `document.getElementById('login').addEventListener('submit', async (event) => {
       event.preventDefault();
       const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: event.target.username.value, password: event.target.password.value }) });
       if (response.ok) location.href = '/users';
     });`,
  );

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status: number, body: string, type = 'text/html'): void => {
      response.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
      response.end(body);
    };
    if (request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || '{}') as Record<string, unknown>;
        } catch {
          body = {};
        }
        if (url.pathname === '/api/users') {
          const email = typeof body.email === 'string' ? body.email : '';
          const ok = email.includes('@');
          writes.push({
            method: 'POST',
            path: url.pathname,
            status: ok ? 201 : 400,
            keys: Object.keys(body).sort(),
            ...(typeof body.accountType === 'string' ? { accountType: body.accountType } : {}),
          });
          if (!ok) {
            send(400, JSON.stringify({ code: 'EMAIL_REQUIRED' }), 'application/json');
            return;
          }
          users.push({
            firstName: typeof body.firstName === 'string' ? body.firstName : '',
            email,
            accountType: typeof body.accountType === 'string' ? body.accountType : '',
          });
          send(201, JSON.stringify({ id: users.length, status: 'ACTIVE' }), 'application/json');
          return;
        }
        if (url.pathname === '/api/login') {
          writes.push({ method: 'POST', path: url.pathname, status: 200, keys: Object.keys(body).sort() });
          send(200, JSON.stringify({ ok: true }), 'application/json');
          return;
        }
        send(404, '{}', 'application/json');
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/users') {
      send(200, usersPage());
      return;
    }
    if (url.pathname === '/users/new') {
      send(200, newUserPage);
      return;
    }
    if (url.pathname === '/login') {
      send(200, loginPage);
      return;
    }
    if (url.pathname === '/reports') {
      send(200, page('Reports', '<p>Nothing to report.</p>'));
      return;
    }
    send(404, page('Not found', ''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    writes,
    users,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );
}
