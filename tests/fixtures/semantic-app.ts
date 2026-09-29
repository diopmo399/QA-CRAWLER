import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Application de la résolution sémantique : les attributs du DOM ne ressemblent PAS aux
 * mots des scénarios (givenName, familyName, electronicMail, accountType…). Le scénario
 * n'a ni sélecteur, ni XPath, ni id : seulement des intentions.
 *
 *   Tableau de bord
 *   ├── Utilisateurs : liste, « Créer un utilisateur »
 *   │   └── Nouvel utilisateur : texte, courriel, date, nombre, liste, liste personnalisée,
 *   │       radios, case à cocher, zone de texte, Annuler, Créer (envoi natif)
 *   └── Inscription : étape 1 (Ville, Précédent, Suivant) → étape 2
 */
export interface SemanticApp {
  url: string;
  /** Les utilisateurs créés, tels que le serveur les a reçus. */
  created: Record<string, string>[];
  close(): Promise<void>;
}

const layout = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title} — Admin</title>
<style>
  body{font-family:sans-serif;margin:0} nav.main{background:#1e293b;padding:10px} nav.main a{color:#fff;margin-right:14px}
  main{padding:20px} label{display:block;margin-top:8px} [role=listbox]{border:1px solid #94a3b8;max-width:240px}
  [role=option]{padding:4px;cursor:pointer} [hidden]{display:none} [role=combobox]{border:1px solid #64748b;padding:4px;width:200px;cursor:pointer}
</style></head>
<body>
<nav class="main" aria-label="Menu principal">
  <a href="/">Tableau de bord</a>
  <a href="/users">Utilisateurs</a>
  <a href="/signup">Inscription</a>
</nav>
<main>${body}</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;

const escape = (text: string): string =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );

const FORM_SCRIPT = `
const combo = document.getElementById('lang');
const list = document.getElementById('lang-options');
combo.addEventListener('click', () => {
  list.hidden = !list.hidden;
  combo.setAttribute('aria-expanded', String(!list.hidden));
});
for (const option of list.querySelectorAll('[role=option]')) {
  option.addEventListener('click', () => {
    combo.textContent = option.textContent;
    document.getElementById('preferredLocale').value = option.dataset.value;
    list.hidden = true;
    combo.setAttribute('aria-expanded', 'false');
  });
}
document.getElementById('cancel').addEventListener('click', () => { location.href = '/users'; });
document.getElementById('user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  if (response.ok) location.href = '/users?created=1';
  else document.getElementById('errors').textContent = 'Erreur : création impossible';
});`;

export async function startSemanticApp(port = 0): Promise<SemanticApp> {
  const created: Record<string, string>[] = [];
  const pages: Record<string, (url: URL) => string> = {
    '/': () => layout('Tableau de bord', '<h1>Tableau de bord</h1><p>Bienvenue.</p>'),
    '/users': (url) =>
      layout(
        'Utilisateurs',
        `<h1>Utilisateurs</h1>
         ${url.searchParams.get('created') === '1' ? '<div role="status">Utilisateur créé avec succès</div>' : ''}
         <button type="button" onclick="location.href='/users/new'">Créer un utilisateur</button>
         <table><thead><tr><th>Nom</th><th>Rôle</th></tr></thead><tbody>
           <tr><td>Alice Martin</td><td>Utilisateur</td></tr>
           ${created.map((user) => `<tr><td>${escape(`${user.givenName ?? ''} ${user.familyName ?? ''}`)}</td><td>${escape(user.accountType ?? '')}</td></tr>`).join('')}
         </tbody></table>`,
      ),
    '/users/new': () =>
      layout(
        'Nouvel utilisateur',
        `<h1>Nouvel utilisateur</h1>
         <form id="user-form">
           <label for="u1">Prénom</label><input id="u1" name="givenName">
           <label for="u2">Nom</label><input id="u2" name="familyName">
           <label for="u3">Adresse électronique</label><input id="u3" type="email" name="electronicMail">
           <label for="u4">Rôle</label>
           <select id="u4" name="accountType">
             <option value="">-- Choisir --</option><option value="USER">Utilisateur</option>
             <option value="VOLUNTEER">Bénévole</option><option value="ADMIN">Administrateur</option>
           </select>
           <label for="u5">Date de naissance</label><input id="u5" type="date" name="dob">
           <label for="u6">Nombre d'enfants</label><input id="u6" type="number" name="kids" min="0" max="20">
           <span id="lang-label">Langue</span>
           <div id="lang" role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="lang-label" aria-controls="lang-options">Choisir…</div>
           <ul id="lang-options" role="listbox" hidden>
             <li role="option" data-value="fr">Français</li><li role="option" data-value="en">English</li>
           </ul>
           <input type="hidden" id="preferredLocale" name="preferredLocale">
           <fieldset><legend>Fréquence de contact</legend>
             <label><input type="radio" name="contactFrequency" value="monthly"> Mensuel</label>
             <label><input type="radio" name="contactFrequency" value="yearly"> Annuel</label>
           </fieldset>
           <label><input type="checkbox" name="isActive" value="yes"> Compte actif</label>
           <label for="u9">Commentaire</label><textarea id="u9" name="remarks"></textarea>
           <p id="errors" role="alert"></p>
           <button type="button" id="cancel">Annuler</button>
           <button type="submit">Créer</button>
         </form>`,
        FORM_SCRIPT,
      ),
    '/signup': () =>
      layout(
        'Inscription',
        `<h1>Inscription</h1><p>Étape 1 sur 2</p>
         <form id="signup" onsubmit="event.preventDefault()">
           <label for="c1">Ville</label><input id="c1" name="locality">
           <button type="button" onclick="location.href='/'">Précédent</button>
           <button type="button" onclick="location.href='/signup/2'">Suivant</button>
         </form>`,
      ),
    '/signup/2': () => layout('Étape 2', '<h1>Étape 2</h1><p>Presque fini.</p>'),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/users') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        created.push(JSON.parse(body) as Record<string, string>);
        res.writeHead(201, { 'content-type': 'application/json' }).end('{"id":1}');
      });
      return;
    }
    const html = pages[url.pathname]?.(url);
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Introuvable</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    created,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
