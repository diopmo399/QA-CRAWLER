import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Application de démonstration du moteur de décision (libellés en français) :
 *
 *   Tableau de bord (cartes)
 *   ├── Utilisateurs : tableau, recherche, pagination, « Nouvel utilisateur »
 *   │   ├── Recherche, pagination
 *   │   ├── Nouvel utilisateur : formulaire (nom, âge 18..65, agence à suggestions) ;
 *   │   │   chaque frappe dans « Nom » envoie un PUT (effet de bord à bloquer)
 *   │   └── Utilisateur N : fiche (fil d'Ariane, Modifier, Retour)
 *   ├── Paramètres : questions Oui / Non (« Oui » affiche une question de plus)
 *   ├── Rapports : liste vide (« Aucun résultat »)
 *   └── Flux cassé : l'API répond 500
 *
 * Les écritures reçues (PUT, POST, DELETE) sont enregistrées : le test prouve que la
 * garde d'écriture n'en laisse passer aucune.
 */
export interface DecisionApp {
  url: string;
  writes: string[];
  close(): Promise<void>;
}

const layout = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title} — Gestion</title>
<style>
  body{font-family:sans-serif;margin:0} nav.main{background:#1e293b;padding:10px} nav.main a{color:#fff;margin-right:14px}
  main{padding:20px} .card{display:inline-block;border:1px solid #cbd5e1;padding:12px;margin:6px}
  [role=listbox]{border:1px solid #94a3b8;max-width:240px} [role=option]{padding:4px;cursor:pointer}
  [hidden]{display:none}
</style></head>
<body>
<nav class="main" aria-label="Menu principal">
  <a href="/">Tableau de bord</a>
  <a href="/users">Utilisateurs</a>
  <a href="/settings">Paramètres</a>
  <a href="/reports">Rapports</a>
  <a href="/broken">Flux cassé</a>
</nav>
<main>${body}</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;

const USERS = ['Alice Martin', 'Bruno Roy', 'Chloé Tremblay'];

const pages: Record<string, () => string> = {
  '/': () =>
    layout(
      'Tableau de bord',
      `<h1>Tableau de bord</h1>
       <section aria-label="Indicateurs">
         <div class="card">3 utilisateurs</div><div class="card">2 agences</div><div class="card">0 rapport</div>
       </section>`,
    ),
  '/users': () =>
    layout(
      'Utilisateurs',
      `<h1>Utilisateurs</h1>
       <form role="search" onsubmit="return false"><input type="search" name="q" aria-label="Rechercher un utilisateur"></form>
       <a href="/users/new">Nouvel utilisateur</a>
       <table><thead><tr><th>Nom</th><th>Rôle</th><th></th></tr></thead><tbody>
       ${USERS.map((name, index) => `<tr><td>${name}</td><td>Lecteur</td><td><a href="/users/${index + 1}">Voir</a></td></tr>`).join('')}
       </tbody></table>
       <nav aria-label="pagination"><span>Page 1 sur 1</span></nav>`,
      // Chaque frappe enregistre la recherche côté serveur : un PUT que rien ne devrait envoyer pendant l'exploration.
      `document.querySelector('input[name=q]').addEventListener('input', (event) => {
         fetch('/api/users/search-history/' + encodeURIComponent(event.target.value), { method: 'PUT' }).catch(() => {});
       });`,
    ),
  '/users/new': () =>
    layout(
      'Nouvel utilisateur',
      `<h1>Nouvel utilisateur</h1>
       <form method="post" action="/api/users" onsubmit="return false">
         <label>Nom <input id="name" name="name" required minlength="2" maxlength="30"></label><br>
         <label>Âge <input name="age" type="number" min="18" max="65"></label><br>
         <label for="agency">Agence</label>
         <input id="agency" name="agency" role="combobox" aria-autocomplete="list" aria-controls="agencies" aria-expanded="false" autocomplete="off">
         <div id="agencies" role="listbox" hidden></div><br>
         <label>Nom de l'agence <input id="agency-name" name="agencyName" readonly></label><br>
         <button type="submit">Enregistrer</button>
       </form>`,
      // Brouillon enregistré côté serveur à chaque frappe dans « Nom » : un PUT, effet de bord d'une saisie.
      `document.getElementById('name').addEventListener('input', (event) => {
         fetch('/api/users/draft/' + encodeURIComponent(event.target.value), { method: 'PUT' }).catch(() => {});
       });
       const input = document.getElementById('agency');
       const list = document.getElementById('agencies');
       const agencies = { '10001': 'Agence Nord', '10002': 'Agence Sud' };
       const show = (typed) => {
         const matches = Object.entries(agencies).filter(([code]) => typed === '*' || (typed && code.startsWith(typed)));
         list.innerHTML = matches.map(([code, name]) => '<div role="option" data-code="' + code + '">' + code + ' — ' + name + '</div>').join('');
         list.hidden = matches.length === 0;
         input.setAttribute('aria-expanded', String(matches.length > 0));
       };
       input.addEventListener('input', () => show(input.value.trim()));
       // ↓ sur le champ vide : toute la liste.
       input.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' && !input.value) show('*'); });
       list.addEventListener('click', (event) => {
         const option = event.target.closest('[role=option]');
         if (!option) return;
         input.value = option.dataset.code;
         document.getElementById('agency-name').value = agencies[option.dataset.code];
         list.hidden = true;
       });`,
    ),
  '/settings': () =>
    layout(
      'Paramètres',
      `<h1>Paramètres</h1>
       <fieldset><legend>Recevoir les notifications par courriel ?</legend>
         <label><input type="radio" name="notify" value="oui"> Oui</label>
         <label><input type="radio" name="notify" value="non"> Non</label>
       </fieldset>
       <div id="more" hidden><fieldset><legend>Aussi le résumé hebdomadaire ?</legend>
         <label><input type="radio" name="weekly" value="oui"> Oui</label>
         <label><input type="radio" name="weekly" value="non"> Non</label>
       </fieldset></div>`,
      `document.querySelectorAll('input[name=notify]').forEach((radio) => radio.addEventListener('change', () => {
         document.getElementById('more').hidden = radio.value !== 'oui';
       }));`,
    ),
  '/reports': () =>
    layout(
      'Rapports',
      `<h1>Rapports</h1><table><thead><tr><th>Rapport</th><th>Date</th></tr></thead><tbody></tbody></table>
       <p class="empty-state">Aucun résultat</p>`,
    ),
  '/broken': () =>
    layout(
      'Flux cassé',
      `<h1>Flux cassé</h1><p id="state">Chargement…</p>`,
      `fetch('/api/broken').then((response) => {
       document.getElementById('state').textContent = response.ok ? 'OK' : 'Erreur ' + response.status;
     });`,
    ),
};

export async function startDecisionApp(port = 0): Promise<DecisionApp> {
  const writes: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      writes.push(`${method} ${url.pathname}`);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/broken') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      return;
    }
    const detail = /^\/users\/(\d+)$/.exec(url.pathname);
    const html = detail
      ? layout(
          `Utilisateur ${detail[1]}`,
          `<nav aria-label="Fil d'Ariane"><a href="/">Accueil</a> › <a href="/users">Utilisateurs</a> › <span>Utilisateur ${detail[1]}</span></nav>
           <h1>Utilisateur ${detail[1]}</h1><p>Rôle : Lecteur</p>
           <button type="button">Modifier</button> <a href="/users">Retour</a>`,
        )
      : pages[url.pathname]?.();
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Introuvable</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    writes,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
