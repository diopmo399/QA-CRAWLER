import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Petit site déterministe plein de pièges pour le crawler : liens cassés, appels
 * d'API en échec, erreurs JS, boucle de redirection, pagination infinie, routes
 * /users/:id, liens et boutons destructifs, formulaires et navigation façon SPA. Il
 * enregistre chaque requête pour que les tests prouvent que les points d'accès
 * dangereux n'ont jamais été appelés.
 */
export interface TestSite {
  url: string;
  /** Chemins demandés, dans l'ordre. */
  requests: string[];
  /** Requêtes arrivées sur un point d'accès que seule une action destructive pouvait déclencher. */
  dangerousHits: string[];
  close(): Promise<void>;
}

const layout = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:24px} nav a{margin-right:12px}</style></head>
<body>
<nav>
  <a href="/">Accueil</a>
  <a href="/users">Utilisateurs</a>
  <a href="/products?page=1&amp;utm_source=newsletter">Produits</a>
  <a href="/logout">Déconnexion</a>
</nav>
<h1>${title}</h1>
${body}
${script ? `<script>${script}</script>` : ''}
</body></html>`;

const pages: Record<string, (url: URL) => string> = {
  '/': () =>
    layout(
      'Accueil',
      `<ul>
        <li><a href="about/">À propos (lien relatif)</a></li>
        <li><a href="/about#team">Équipe (fragment)</a></li>
        <li><a href="#top">Haut de page</a></li>
        <li><a href="/broken-page">Page cassée</a></li>
        <li><a href="/server-error-page">Page en erreur</a></li>
        <li><a href="/redirect-loop">Boucle de redirection</a></li>
        <li><a href="/js-error">Erreur JS</a></li>
        <li><a href="/console-error">Erreur console</a></li>
        <li><a href="/api-fail">Appel API en échec</a></li>
        <li><a href="/forms">Formulaires</a></li>
        <li><a href="/guarded">Page protégée (redirection JS)</a></li>
        <li><a href="/spa">Application SPA</a></li>
        <li><a href="/users/550e8400-e29b-41d4-a716-446655440000">Profil UUID</a></li>
        <li><a href="/users/3/delete">Supprimer l'utilisateur 3</a></li>
        <li><a href="/files/report.pdf">Rapport PDF</a></li>
        <li><a href="https://external.example.com/page">Site externe</a></li>
        <li><a href="mailto:contact@example.com">Contact</a></li>
        <li><a href="javascript:void(0)">Lien JS</a></li>
      </ul>`,
    ),
  '/about': () => layout('À propos', '<p id="team">Notre équipe.</p><a href="/">Retour</a>'),
  '/users': () =>
    layout(
      'Utilisateurs',
      `<button type="button">Nouvelle inscription</button>
       <button type="button" onclick="fetch('/api/danger/delete-all', {method: 'POST'})">Supprimer</button>
       <ul>${Array.from({ length: 10 }, (_, i) => `<li><a href="/users/${i + 1}">Utilisateur ${i + 1}</a></li>`).join('')}</ul>`,
    ),
  '/products': (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    return layout(
      `Produits — page ${page}`,
      `<p>Pagination infinie.</p><a href="/products?page=${page + 1}">Suivant</a>`,
    );
  },
  '/js-error': () =>
    layout('Erreur JS', '<p>Cette page lance une exception.</p>', 'window.undefinedFunction();'),
  '/console-error': () =>
    layout(
      'Erreur console',
      '<p>Cette page écrit une erreur dans la console.</p>',
      "console.error('Payment widget failed, token=abc123supersecret');",
    ),
  '/api-fail': () =>
    layout(
      'Appel API',
      '<p id="out">Chargement…</p>',
      "fetch('/api/users?access_token=SECRETTOKEN123').then(r => { document.getElementById('out').textContent = 'HTTP ' + r.status; });",
    ),
  '/forms': () =>
    layout(
      'Formulaires',
      `<form role="search" method="get" action="/search"><input type="search" name="q" placeholder="Rechercher"><button type="submit">Rechercher</button></form>
       <form id="signup" method="post" action="/api/danger/signup">
         <label for="email">Email</label><input id="email" name="email" type="email" required maxlength="80">
         <label>Âge <input name="age" type="number" min="18" max="99"></label>
         <label>Mot de passe <input name="password" type="password" required minlength="8"></label>
         <textarea name="bio" maxlength="500"></textarea>
         <select name="country"><option>France</option><option>Canada</option></select>
         <label><input type="checkbox" name="terms" required> CGU</label>
         <label><input type="radio" name="plan" value="free"> Gratuit</label>
         <button type="submit">Créer mon compte</button>
       </form>`,
    ),
  '/spa': () =>
    layout(
      'SPA',
      `<button type="button" id="details">Voir les détails</button>
       <div routerlink="/spa/routed" role="link">Section routée</div>
       <button type="button" onclick="fetch('/api/danger/save', {method: 'POST'})">Enregistrer</button>
       <button type="button" onclick="fetch('/api/danger/wipe', {method: 'POST'})">Supprimer tout</button>
       <button type="button" onclick="fetch('/api/danger/unknown', {method: 'POST'})">⚙</button>`,
      "document.getElementById('details').addEventListener('click', () => { history.pushState({}, '', '/spa/details'); document.querySelector('h1').textContent = 'Détails'; });",
    ),
  '/search': (url) =>
    layout(
      'Recherche',
      `<p>Résultats pour « ${(url.searchParams.get('q') ?? '').replace(/[<>&"]/g, '')} ».</p>`,
    ),
  '/guarded': () => layout('Protégée', '<p>Redirection…</p>', "location.replace('/about?from=guard');"),
  '/spa/details': () => layout('Détails SPA', '<p>Vue détails.</p>'),
  '/spa/routed': () => layout('Section routée', '<p>Atteinte via routerLink.</p>'),
};

function handle(req: IncomingMessage, res: ServerResponse, site: TestSite): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  site.requests.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;

  if (path.startsWith('/api/danger') || path === '/logout' || path.endsWith('/delete')) {
    site.dangerousHits.push(`${req.method ?? 'GET'} ${path}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('this should never be reached');
    return;
  }
  if (path === '/api/users') {
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    return;
  }
  if (path === '/redirect-loop' || path === '/redirect-loop-2') {
    res.writeHead(302, { location: path === '/redirect-loop' ? '/redirect-loop-2' : '/redirect-loop' }).end();
    return;
  }
  if (path === '/server-error-page') {
    res.writeHead(500, { 'content-type': 'text/html' }).end(layout('Erreur serveur', '<p>Erreur 500.</p>'));
    return;
  }
  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  const userMatch = /^\/users\/([^/]+)$/.exec(path);
  const render = userMatch
    ? () =>
        layout(
          `Utilisateur ${userMatch[1] ?? ''}`,
          `<a href="/users">Retour à la liste</a> <a href="/users/${userMatch[1] ?? ''}/edit">Modifier</a>`,
        )
    : /^\/users\/[^/]+\/edit$/.test(path)
      ? () =>
          layout(
            'Modifier',
            '<form method="post"><input name="name" required><button>Enregistrer</button></form>',
          )
      : pages[path];

  if (!render) {
    res.writeHead(404, { 'content-type': 'text/html' }).end(layout('Introuvable', '<p>404</p>'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(render(url));
}

export async function startTestSite(port = 0): Promise<TestSite> {
  const site: TestSite = {
    url: '',
    requests: [],
    dangerousHits: [],
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    handle(req, res, site);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  site.url = `http://localhost:${address.port}`;
  site.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  return site;
}
