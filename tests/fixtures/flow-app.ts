import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Mini application de back-office qui sert à prouver que le FlowExplorer découvre
 * seul les écrans et les flows :
 *
 *   Tableau de bord
 *   ├── Utilisateurs ── Utilisateur N (onglets Profil / Historique)
 *   ├── Dossiers ── Nouveau dossier : assistant, 3 étapes sur la MÊME URL
 *   ├── Paramètres (onglets Général / Notifications / Sécurité, sans changement d'URL)
 *   └── Administration ── Journal
 *
 * Les points d'accès destructifs (/logout, /api/danger/*) enregistrent chaque appel
 * pour que les tests prouvent qu'ils n'ont jamais été atteints.
 */
export interface FlowApp {
  url: string;
  requests: string[];
  dangerousHits: string[];
  close(): Promise<void>;
}

const layout = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title} — Back-office</title>
<style>
  body{font-family:sans-serif;margin:0} nav{background:#1e293b;padding:10px} nav a{color:#fff;margin-right:14px}
  main{padding:20px} [role=tabpanel][hidden], .step[hidden]{display:none} .error{color:#b91c1c}
  [role=tab][aria-selected=true]{font-weight:bold;border-bottom:2px solid #2563eb}
</style></head>
<body>
<nav aria-label="Menu principal">
  <a href="/">Tableau de bord</a>
  <a href="/users">Utilisateurs</a>
  <a href="/dossiers">Dossiers</a>
  <a href="/settings">Paramètres</a>
  <a href="/admin">Administration</a>
  <a href="/logout">Déconnexion</a>
</nav>
<main>
<h1>${title}</h1>
${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;

/** Comportement générique des onglets : cliquer sur un [role=tab] affiche son panneau. */
const TABS_SCRIPT = `
document.querySelectorAll('[role=tab]').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach((other) => other.setAttribute('aria-selected', String(other === tab)));
  document.querySelectorAll('[role=tabpanel]').forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute('aria-controls'); });
}));`;

const tabs = (items: [string, string][]): string => `
<div role="tablist">${items
  .map(
    ([id, name], index) =>
      `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${index === 0}">${name}</button>`,
  )
  .join('')}</div>`;

const USERS = [
  'Awa Diop',
  'Moussa Ba',
  'Fatou Sow',
  'Ibrahima Fall',
  'Aminata Ndiaye',
  'Ousmane Sy',
  'Khady Gueye',
  'Cheikh Mbaye',
];

const pages: Record<string, (url: URL) => string> = {
  '/': () =>
    layout(
      'Tableau de bord',
      `<p>Bienvenue sur le back-office.</p>
       <ul><li><a href="/users">Gérer les utilisateurs</a></li><li><a href="/dossiers">Suivre les dossiers</a></li></ul>`,
    ),
  '/users': () =>
    layout(
      'Utilisateurs',
      `<button type="button" onclick="fetch('/api/danger/create-user',{method:'POST'})">Nouvel utilisateur</button>
       <table><tbody>${USERS.map((name, index) => `<tr><td>${name}</td><td><a href="/users/${index + 1}">Voir</a></td></tr>`).join('')}</tbody></table>`,
    ),
  '/dossiers': () =>
    layout('Dossiers', `<a href="/dossiers/create">Nouveau dossier</a><p>Aucun dossier en cours.</p>`),
  '/dossiers/create': () =>
    layout(
      'Nouveau dossier',
      `<form id="wizard" onsubmit="return false">
        <section class="step" data-step="1">
          <h2>Étape 1 — Informations</h2>
          <label for="titre">Titre</label><input id="titre" name="titre" required minlength="3">
          <label for="email">Email du demandeur</label><input id="email" name="email" type="email" required>
          <p class="error" hidden>Champs obligatoires manquants</p>
          <button type="button" data-next>Suivant</button>
        </section>
        <section class="step" data-step="2" hidden>
          <h2>Étape 2 — Détails</h2>
          <label for="montant">Montant</label><input id="montant" name="montant" type="number" min="1" max="1000" required>
          <label for="categorie">Catégorie</label><select id="categorie" name="categorie" required><option value="">-- Choisir --</option><option>Subvention</option><option>Équipement</option></select>
          <label for="carte">Numéro de carte bancaire</label><input id="carte" name="carte" autocomplete="cc-number">
          <label><input type="checkbox" name="cgu" required> J'accepte les conditions</label>
          <p class="error" hidden>Champs obligatoires manquants</p>
          <button type="button" data-prev>Précédent</button>
          <button type="button" data-next>Suivant</button>
        </section>
        <section class="step" data-step="3" hidden>
          <h2>Étape 3 — Confirmation</h2>
          <p>Vérifiez les informations avant l'enregistrement.</p>
          <button type="button" data-prev>Précédent</button>
          <button type="button" onclick="fetch('/api/danger/save-dossier',{method:'POST'})">Enregistrer le dossier</button>
        </section>
      </form>`,
      `
const steps = [...document.querySelectorAll('.step')];
const show = (n) => steps.forEach((step) => { step.hidden = step.dataset.step !== String(n); });
steps.forEach((step, index) => {
  step.querySelector('[data-next]')?.addEventListener('click', () => {
    const fields = [...step.querySelectorAll('input,select')];
    const invalid = fields.some((field) => !field.checkValidity());
    step.querySelector('.error').hidden = !invalid;
    if (!invalid) show(index + 2);
  });
  step.querySelector('[data-prev]')?.addEventListener('click', () => show(index));
});
show(1);`,
    ),
  '/settings': () =>
    layout(
      'Paramètres',
      `${tabs([
        ['general', 'Général'],
        ['notifications', 'Notifications'],
        ['securite', 'Sécurité'],
      ])}
      <div role="tabpanel" id="panel-general"><label for="langue">Langue</label><select id="langue"><option>Français</option><option>English</option></select>
        <button type="button" onclick="fetch('/api/danger/save-settings',{method:'POST'})">Enregistrer</button></div>
      <div role="tabpanel" id="panel-notifications" hidden><label><input type="checkbox" id="notif-email"> Recevoir les emails</label></div>
      <div role="tabpanel" id="panel-securite" hidden><button type="button" onclick="fetch('/api/danger/reset-password',{method:'POST'})">Réinitialiser le mot de passe</button></div>`,
      TABS_SCRIPT,
    ),
  '/admin': () =>
    layout(
      'Administration',
      `<a href="/admin/logs">Journal</a>
       <button type="button" onclick="fetch('/api/danger/purge',{method:'POST'})">Vider le cache</button>
       <a href="https://external.example.com/docs">Documentation externe</a>`,
    ),
  // Pas relié au menu : atteint seulement par les flows imposés.
  '/login': () =>
    layout(
      'Connexion',
      `<form onsubmit="return false">
        <label for="identifiant">Identifiant</label><input id="identifiant" name="identifiant">
        <label for="mdp">Mot de passe</label><input id="mdp" name="mdp" type="password">
        <button type="button" id="connexion">Se connecter</button>
        <p id="message"></p>
      </form>`,
      "document.querySelector('#connexion').addEventListener('click', () => { const ok = document.querySelector('#mdp').value.length > 0; document.querySelector('#message').textContent = ok ? 'Bienvenue ' + document.querySelector('#identifiant').value : 'Mot de passe requis'; });",
    ),
  // Un champ de la page avec le même libellé qu'un champ de la fenêtre modale ouverte.
  '/equipe': () =>
    layout(
      'Équipe',
      `<label for="filtre-nom">Nom</label><input id="filtre-nom">
       <div role="dialog" aria-modal="true" aria-label="Nouveau membre" style="position:fixed;inset:60px;background:#fff;border:1px solid #333;padding:20px">
         <label for="membre-nom">Nom</label><input id="membre-nom">
         <p id="apercu"></p>
       </div>`,
      "document.querySelector('#membre-nom').addEventListener('input', (e) => { document.querySelector('#apercu').textContent = 'Aperçu : ' + e.target.value; });",
    ),
  '/admin/logs': () =>
    layout(
      'Journal',
      '<p>Chargement…</p>',
      "fetch('/api/logs').then(r => { document.querySelector('p').textContent = 'HTTP ' + r.status; });",
    ),
};

function handle(req: IncomingMessage, res: ServerResponse, app: FlowApp): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  app.requests.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;

  if (path.startsWith('/api/danger') || path === '/logout') {
    app.dangerousHits.push(`${req.method ?? 'GET'} ${path}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('should never be reached');
    return;
  }
  if (path === '/api/logs') {
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"logs unavailable"}');
    return;
  }
  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const userMatch = /^\/users\/(\d+)$/.exec(path);
  if (userMatch) {
    const name = USERS[Number(userMatch[1]) - 1];
    if (!name) {
      res.writeHead(404, { 'content-type': 'text/html' }).end(layout('Introuvable', '<p>404</p>'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      layout(
        `Utilisateur ${userMatch[1] ?? ''}`,
        `<p>${name}</p>${tabs([
          ['profil', 'Profil'],
          ['historique', 'Historique'],
        ])}
        <div role="tabpanel" id="panel-profil"><p>Email : ${name.split(' ')[0]?.toLowerCase() ?? ''}@example.test</p></div>
        <div role="tabpanel" id="panel-historique" hidden><p>Aucune activité.</p></div>
        <a href="/users">Retour à la liste</a>
        <button type="button" onclick="fetch('/api/danger/delete-user',{method:'POST'})">Supprimer l'utilisateur</button>`,
        TABS_SCRIPT,
      ),
    );
    return;
  }
  const render = pages[path];
  if (!render) {
    res.writeHead(404, { 'content-type': 'text/html' }).end(layout('Introuvable', '<p>404</p>'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(render(url));
}

export async function startFlowApp(port = 0): Promise<FlowApp> {
  const app: FlowApp = { url: '', requests: [], dangerousHits: [], close: () => Promise.resolve() };
  const server: Server = createServer((req, res) => {
    handle(req, res, app);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  app.url = `http://localhost:${(server.address() as AddressInfo).port}`;
  app.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  return app;
}
