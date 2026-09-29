import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * APPLICATION FIXTURE du Dry Run : le vrai parcours est plus long que le scénario.
 *
 *   Connexion → Tableau de bord → Administration → Utilisateurs → Créer un utilisateur
 *   → Informations personnelles → Choix du rôle → Confirmation → Utilisateurs (« Utilisateur créé »)
 *
 * Le tableau de bord n'a pas de lien direct vers les utilisateurs ; « Se déconnecter »
 * (DANGEROUS) ne doit jamais être suivi. Chaque requête est enregistrée.
 */
export interface DryRunApp {
  url: string;
  /** Utilisateurs créés (le POST final). */
  created: { firstName: string; role: string }[];
  /** Méthode et chemin de chaque requête. */
  requests: string[];
  close(): Promise<void>;
}

export async function startDryRunApp(): Promise<DryRunApp> {
  const created: DryRunApp['created'] = [];
  const requests: string[] = [];
  const drafts = new Map<string, Record<string, string>>();
  const page = (title: string, body: string, nav = true): string =>
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body>${
      nav
        ? '<nav aria-label="Principal"><a href="/dashboard">Tableau de bord</a> <a href="/reports">Rapports</a> <a href="/admin">Administration</a> <a href="/logout">Se déconnecter</a></nav>'
        : ''
    }<main><h1>${title}</h1>${body}</main></body></html>`;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${req.method ?? 'GET'} ${url.pathname}`);
    const session = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    const send = (body: string, status = 200, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const redirect = (location: string, headers: Record<string, string> = {}): void => {
      send('', 303, { location, ...headers });
    };
    const form = (then: (fields: Record<string, string>) => void): void => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        then(Object.fromEntries(new URLSearchParams(raw)));
      });
    };

    if (url.pathname === '/login' && req.method === 'POST') {
      form(() => {
        redirect('/dashboard', { 'set-cookie': 'sid=abc123; Path=/' });
      });
      return;
    }
    if (url.pathname === '/login' || url.pathname === '/') {
      send(
        page(
          'Connexion',
          `<form method="post" action="/login">
  <label for="u">Identifiant</label><input id="u" name="username" autocomplete="username">
  <label for="p">Mot de passe</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit">Se connecter</button></form>`,
          false,
        ),
      );
      return;
    }
    if (!session) {
      redirect('/login');
      return;
    }
    if (url.pathname === '/logout') {
      redirect('/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      return;
    }
    if (url.pathname === '/dashboard') {
      send(page('Tableau de bord', '<p>Bienvenue.</p>'));
      return;
    }
    if (url.pathname === '/reports') {
      send(page('Rapports', '<p>Aucun rapport.</p>'));
      return;
    }
    if (url.pathname === '/admin') {
      send(
        page(
          'Administration',
          '<ul><li><a href="/admin/users">Utilisateurs</a></li><li><a href="/admin/settings">Paramètres</a></li></ul>',
        ),
      );
      return;
    }
    if (url.pathname === '/admin/settings') {
      send(page('Paramètres', '<p>Rien à régler.</p>'));
      return;
    }
    if (url.pathname === '/admin/users') {
      const message = url.searchParams.get('created') ? '<p role="status">Utilisateur créé</p>' : '';
      const rows = created.map((user) => `<li>${user.firstName} (${user.role})</li>`).join('');
      send(
        page('Utilisateurs', `${message}<ul>${rows}</ul><a href="/admin/users/new">Créer un utilisateur</a>`),
      );
      return;
    }
    const draft = drafts.get(session) ?? {};
    if (url.pathname === '/admin/users/new' && req.method === 'POST') {
      form((fields) => {
        drafts.set(session, { ...draft, ...fields });
        redirect('/admin/users/new/role');
      });
      return;
    }
    if (url.pathname === '/admin/users/new') {
      send(
        page(
          'Informations personnelles',
          `<form method="post" action="/admin/users/new">
  <label for="f">Prénom</label><input id="f" name="firstName" required autocomplete="given-name">
  <label for="l">Nom</label><input id="l" name="lastName" required autocomplete="family-name">
  <label for="e">Courriel</label><input id="e" name="email" type="email" required>
  <button type="submit">Suivant</button></form>`,
        ),
      );
      return;
    }
    if (url.pathname === '/admin/users/new/role' && req.method === 'POST') {
      form((fields) => {
        drafts.set(session, { ...draft, ...fields });
        redirect('/admin/users/new/confirm');
      });
      return;
    }
    if (url.pathname === '/admin/users/new/role') {
      send(
        page(
          'Choix du rôle',
          `<form method="post" action="/admin/users/new/role">
  <label for="r">Rôle</label><select id="r" name="role" required><option value="">—</option><option>Lecteur</option><option>Administrateur</option></select>
  <button type="submit">Suivant</button></form>`,
        ),
      );
      return;
    }
    if (url.pathname === '/admin/users/new/confirm' && req.method === 'POST') {
      created.push({ firstName: draft.firstName ?? '?', role: draft.role ?? '?' });
      drafts.delete(session);
      redirect('/admin/users?created=1');
      return;
    }
    if (url.pathname === '/admin/users/new/confirm') {
      send(
        page(
          'Confirmation',
          `<p>Prénom : ${draft.firstName ?? '—'} · Rôle : ${draft.role ?? '—'}</p>
<form method="post" action="/admin/users/new/confirm"><button type="submit">Confirmer la création</button></form>`,
        ),
      );
      return;
    }
    send(page('Introuvable', '<p>404</p>'), 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${String(port)}`,
    created,
    requests,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
