/**
 * « Orbit Desk » : back-office de demandes fictif, moderne, pour les démonstrations et les tests
 * (npm run demo:server, scenarios/demo-orbit.yaml). Ce qu'il met à l'épreuve :
 * - une création réelle (POST /api/demandes → 201 + Location) et une référence propre à chaque
 *   création (DEM-3024, 3025…) : au rejeu, la ligne enregistrée n'existe plus ;
 * - une liste par session (cookie) : chaque navigateur voit les exemples et ses propres créations ;
 * - des actions qui modifient (« M'assigner le dossier ») ou détruisent (« Supprimer ») ;
 * - un écran en panne : Rapports appelle GET /api/statistiques, qui répond 500.
 * Données fictives ; aucune ressource réseau externe.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);

const CSS = `
:root{--bg:#f4f6fb;--surface:#fff;--ink:#0f172a;--muted:#64748b;--line:#e5e9f2;--side:#05261c;--side-ink:#c9f0dd;
--accent:#059669;--accent-2:#34d399;--accent-soft:#e6f7ef;--ok:#16a34a;--ok-soft:#e8f8ee;--warn:#d97706;--warn-soft:#fff5e6;
--bad:#dc2626;--bad-soft:#fdecec;--info:#2563eb;--info-soft:#e8f0fe;--r:14px;--shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:14px/1.5 "Segoe UI","DejaVu Sans",system-ui,sans-serif;color:var(--ink);background:var(--bg);display:grid;grid-template-columns:232px 1fr}
aside{background:linear-gradient(180deg,#05261c,#0b3a2b);color:var(--side-ink);padding:20px 14px;display:flex;flex-direction:column;gap:6px;min-height:100vh}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:#fff;padding:4px 8px 18px}
.logo{width:34px;height:34px;border-radius:10px;background:conic-gradient(from 200deg,var(--accent),var(--accent-2),var(--accent));display:grid;place-items:center;box-shadow:0 6px 18px rgba(5,150,105,.45)}
.logo i{width:12px;height:12px;border-radius:50%;background:#fff}
nav a{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;color:var(--side-ink);text-decoration:none;font-weight:600}
nav a:hover{background:rgba(255,255,255,.06)}nav a.on{background:rgba(52,211,153,.2);color:#fff;box-shadow:inset 3px 0 0 var(--accent)}
nav svg{width:18px;height:18px;flex:none}
.side-foot{margin-top:auto;padding:14px;border-radius:12px;background:rgba(255,255,255,.05);font-size:12px}
.side-foot b{display:block;color:#fff;font-size:13px}
main{min-width:0;display:flex;flex-direction:column}
header.top{height:64px;background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;padding:0 28px}
.search{flex:1;max-width:420px;display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 12px;color:var(--muted)}
.search input{border:0;background:transparent;outline:0;font:inherit;flex:1}
.who{margin-left:auto;display:flex;align-items:center;gap:10px;font-weight:600}
.avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800}
.page{padding:26px 28px;display:grid;gap:22px}
h1{margin:0;font-size:24px;letter-spacing:-.01em}.sub{color:var(--muted);margin:2px 0 0}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.kpi{padding:18px;display:grid;gap:6px}.kpi span{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.kpi b{font-size:28px;letter-spacing:-.02em}.kpi small{font-weight:700}.up{color:var(--ok)}.down{color:var(--bad)}
.bars{display:flex;align-items:flex-end;gap:6px;height:44px}.bars i{flex:1;border-radius:6px 6px 2px 2px;background:linear-gradient(180deg,var(--accent),#6ee7b7)}
.grid2{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
.card h2{margin:0;font-size:15px}.card .ch{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--line)}
.btn{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:10px;padding:10px 16px;font:600 14px/1 inherit;font-family:inherit;cursor:pointer;text-decoration:none}
.btn.primary{background:linear-gradient(135deg,var(--accent),#10b981);color:#fff;box-shadow:0 6px 16px rgba(5,150,105,.35)}
.btn.ghost{background:var(--surface);color:var(--ink);border:1px solid var(--line)}
.btn.danger{background:var(--bad-soft);color:var(--bad)}
form.new{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px;align-items:end;padding:22px}form.new .btn{grid-column:1/-1;justify-self:end}.card.narrow{max-width:780px}
label{display:grid;gap:6px;font-weight:600;font-size:12px;color:var(--muted)}
input,select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid #d6dbe8;border-radius:10px;padding:10px 12px;outline:0}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:12px 18px;background:#fafbfe;border-bottom:1px solid var(--line)}
td{padding:13px 18px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fafaff}
.ref{font-family:"DejaVu Sans Mono",ui-monospace,monospace;font-weight:700;color:var(--accent)}
.person{display:flex;align-items:center;gap:10px;font-weight:600}.person i{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:12px;font-weight:800;color:#fff}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.c-new{background:var(--accent-soft);color:var(--accent)}.c-run{background:var(--info-soft);color:var(--info)}.c-ok{background:var(--ok-soft);color:var(--ok)}.c-warn{background:var(--warn-soft);color:var(--warn)}.c-bad{background:var(--bad-soft);color:var(--bad)}
a.open{color:var(--accent);font-weight:700;text-decoration:none;display:inline-flex;gap:6px;align-items:center}a.open:hover{text-decoration:underline}
.toast{position:fixed;right:24px;bottom:24px;background:#0f172a;color:#fff;padding:12px 16px;border-radius:12px;box-shadow:var(--shadow);display:flex;gap:10px;align-items:center;font-weight:600;animation:t 3.2s forwards}
.toast i{width:22px;height:22px;border-radius:50%;background:var(--ok);display:grid;place-items:center;font-style:normal}
@keyframes t{0%{opacity:0;transform:translateY(10px)}10%,80%{opacity:1;transform:none}100%{opacity:0}}
.feed{list-style:none;margin:0;padding:8px 18px 14px;display:grid;gap:12px}.feed li{display:flex;gap:10px}.feed b{font-weight:600}.feed span{color:var(--muted);font-size:12px;display:block}
.dot{width:10px;height:10px;border-radius:50%;margin-top:6px;flex:none}
.detail{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}
.info{display:grid;grid-template-columns:140px 1fr;gap:12px 16px;padding:18px}.info dt{color:var(--muted);font-weight:600}.info dd{margin:0;font-weight:600}
.steps{list-style:none;margin:0;padding:18px;display:grid;gap:14px}.steps li{display:flex;gap:12px;align-items:center}.steps i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-weight:800;font-size:12px}
.done i{background:var(--ok);color:#fff}.cur i{background:var(--accent);color:#fff;box-shadow:0 0 0 5px var(--accent-soft)}.todo i{background:var(--line);color:var(--muted)}
.tabs{display:flex;gap:6px;padding:6px;background:var(--surface);border:1px solid var(--line);border-radius:12px;width:max-content}
.tabs button{border:0;background:transparent;font:600 14px inherit;font-family:inherit;padding:8px 14px;border-radius:8px;color:var(--muted);cursor:pointer}
.tabs button[aria-selected=true]{background:var(--accent-soft);color:var(--accent)}
.toggle{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line)}
.sw{width:42px;height:24px;border-radius:999px;background:var(--accent);position:relative}.sw::after{content:"";position:absolute;right:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff}
.sw.off{background:#cbd5e1}.sw.off::after{right:auto;left:3px}
.clients{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.client{padding:18px;display:grid;gap:8px}
.alert{display:flex;gap:12px;align-items:flex-start;padding:16px 18px;border-radius:12px;background:var(--bad-soft);color:var(--bad);font-weight:600}
main{overflow-x:hidden}.page>*{min-width:0}.card{overflow:hidden}.chip,.person,.ref,a.open{white-space:nowrap}
@media (max-width:1180px){
body{grid-template-columns:196px 1fr}aside{padding:18px 10px}.brand{font-size:16px}
.page{padding:20px;gap:18px}header.top{padding:0 20px}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2,.detail{grid-template-columns:1fr}

th,td{padding:10px 12px}td{font-size:13px}.c-type,.c-date{display:none}.clients{grid-template-columns:repeat(2,minmax(0,1fr))}
}
`;

const ICON: Record<string, string> = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users:
    '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  chart: '<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>',
  gear: '<path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
};
const svg = (n: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;

const layout = (
  title: string,
  active: string,
  body: string,
  toast = '',
) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title} · Orbit Desk</title><style>${CSS}</style></head>
<body><aside><div class="brand"><span class="logo"><i></i></span>Orbit Desk</div>
<nav aria-label="Navigation principale">${[
  ['/', 'home', 'Tableau de bord'],
  ['/demandes', 'list', 'Demandes'],
  ['/clients', 'users', 'Clients'],
  ['/rapports', 'chart', 'Rapports'],
  ['/parametres', 'gear', 'Paramètres'],
]
  .map(
    ([href, ic, label]) =>
      `<a href="${href}"${active === href ? ' class="on" aria-current="page"' : ''}>${svg(ic ?? '')}${label}</a>`,
  )
  .join('')}</nav>
<div class="side-foot"><b>Espace de démonstration</b>Données fictives, régénérées à chaque démarrage.</div></aside>
<main><header class="top"><label class="search" aria-label="Rechercher"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input placeholder="Rechercher une demande, un client…" aria-label="Rechercher"></label>
<div class="who"><span class="avatar">AD</span>Agent démo</div></header>
<div class="page">${body}</div></main>${toast}</body></html>`;

const COLORS = ['#059669', '#0ea5e9', '#f97316', '#0d9488', '#e11d48', '#65a30d', '#7c3aed'];
const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
interface Demande {
  id: number;
  name: string;
  type: string;
  priority: string;
  status: string;
  date: string;
}
const STATUS: Record<string, string> = {
  Nouvelle: 'c-new',
  'En cours': 'c-run',
  Résolue: 'c-ok',
  'En attente': 'c-warn',
};
const PRIO: Record<string, string> = { Haute: 'c-bad', Normale: 'c-run', Basse: 'c-ok' };

/** Une couleur stable par nom (somme des codes de caractères). */
const color = (name: string) => {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum += name.charCodeAt(i);
  return COLORS[sum % COLORS.length] ?? '#059669';
};

const person = (name: string, _i: number) =>
  `<span class="person"><i style="background:${color(name)}">${esc(initials(name))}</i>${esc(name)}</span>`;

const dashboard = (items: Demande[]) =>
  layout(
    'Tableau de bord',
    '/',
    `
<div class="head"><div><h1>Bonjour 👋</h1><p class="sub">Voici l'activité du service aujourd'hui.</p></div><a class="btn primary" href="/demandes">+ Nouvelle demande</a></div>
<section class="kpis">
<div class="card kpi"><span>Demandes ouvertes</span><b>${String(items.filter((d) => d.status !== 'Résolue').length + 38)}</b><small class="up">▲ 12 % cette semaine</small></div>
<div class="card kpi"><span>Délai moyen</span><b>2,4 j</b><small class="up">▼ 0,6 j</small></div>
<div class="card kpi"><span>Résolues ce mois</span><b>214</b><div class="bars">${[30, 52, 41, 66, 58, 74, 90].map((h) => `<i style="height:${h}%"></i>`).join('')}</div></div>
<div class="card kpi"><span>Satisfaction</span><b>94 %</b><small class="down">▼ 1 pt</small></div>
</section>
<div class="grid2"><section class="card"><div class="ch"><h2>Dernières demandes</h2><a class="open" href="/demandes">Tout voir →</a></div>${table(items.slice(0, 4), false)}</section>
<section class="card"><div class="ch"><h2>Activité récente</h2></div><ul class="feed">
<li><span class="dot" style="background:var(--ok)"></span><div><b>DEM-3021 résolue</b><span>il y a 12 min · Ibrahima Fall</span></div></li>
<li><span class="dot" style="background:var(--accent)"></span><div><b>Nouvelle demande DEM-3023</b><span>il y a 40 min · Aminata Ndiaye</span></div></li>
<li><span class="dot" style="background:var(--warn)"></span><div><b>DEM-3020 en attente de pièce</b><span>il y a 2 h · Fatou Sow</span></div></li>
<li><span class="dot" style="background:var(--info)"></span><div><b>Rapport hebdomadaire prêt</b><span>hier · Système</span></div></li></ul></section></div>`,
  );

const table = (
  items: Demande[],
  withActions = true,
) => `<table aria-label="Demandes"><thead><tr><th>Référence</th><th>Demandeur</th><th class="c-type">Type</th><th>Priorité</th><th>Statut</th><th class="c-date">Créée le</th>${withActions ? '<th>Actions</th>' : ''}</tr></thead><tbody>
${items.map((d, i) => `<tr><td class="ref">DEM-${String(d.id)}</td><td>${person(d.name, d.id + i)}</td><td class="c-type">${esc(d.type)}</td><td><span class="chip ${PRIO[d.priority] ?? 'c-run'}">${esc(d.priority)}</span></td><td><span class="chip ${STATUS[d.status] ?? 'c-new'}">${esc(d.status)}</span></td><td class="c-date">${esc(d.date)}</td>${withActions ? `<td><a class="open" href="/demandes/${String(d.id)}">Ouvrir le dossier →</a></td>` : ''}</tr>`).join('')}
</tbody></table>`;

const demandes = (items: Demande[], created: boolean) =>
  layout(
    'Demandes',
    '/demandes',
    `
<div class="head"><div><h1>Demandes</h1><p class="sub">${String(items.length)} demandes · mises à jour en temps réel</p></div><a class="btn primary" href="/demandes/nouvelle">+ Nouvelle demande</a></div>
<section class="card"><div class="ch"><h2>Toutes les demandes</h2><span class="chip c-new">${String(items.filter((d) => d.status === 'Nouvelle').length)} nouvelles</span></div>${table(items)}</section>
`,
    created ? '<div class="toast" role="status"><i>✓</i>Demande créée</div>' : '',
  );

const nouvelle = () =>
  layout(
    'Nouvelle demande',
    '/demandes',
    `
<div class="head"><div><p class="sub"><a class="open" href="/demandes">← Demandes</a></p><h1>Nouvelle demande</h1><p class="sub">Le dossier est créé immédiatement et apparaît en tête de liste.</p></div></div>
<section class="card narrow"><div class="ch"><h2>Demandeur et demande</h2></div>
<form class="new" onsubmit="event.preventDefault();creer()">
<label>Prénom<input name="firstName" autocomplete="off" required></label>
<label>Nom<input name="lastName" autocomplete="off"></label>
<label>Type<select name="type"><option>Assistance</option><option>Réclamation</option><option>Information</option></select></label>
<label>Priorité<select name="priority"><option>Normale</option><option>Haute</option><option>Basse</option></select></label>
<button class="btn primary" type="submit" id="create">Créer la demande</button></form></section>
<script>function creer(){var f=document.querySelector('form.new');fetch('/api/demandes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({firstName:f.firstName.value,lastName:f.lastName.value,type:f.type.value,priority:f.priority.value})}).then(function(){location.href='/demandes?cree=1'})}</script>`,
  );

const detail = (d: Demande | undefined) =>
  layout(
    'Dossier',
    '/demandes',
    d
      ? `
<div class="head"><div><p class="sub"><a class="open" href="/demandes">← Demandes</a></p><h1>Dossier DEM-${String(d.id)}</h1><p class="sub">${esc(d.type)} · créée le ${esc(d.date)}</p></div>
<div style="display:flex;gap:10px"><button class="btn ghost" type="button" onclick="this.textContent='Dossier assigné ✓'">M'assigner le dossier</button><button class="btn danger" type="button">Supprimer</button></div></div>
<div class="detail"><section class="card"><div class="ch"><h2>Informations</h2><span class="chip ${STATUS[d.status] ?? 'c-new'}">${esc(d.status)}</span></div>
<dl class="info"><dt>Demandeur</dt><dd id="name">${esc(d.name)}</dd><dt>Type</dt><dd>${esc(d.type)}</dd><dt>Priorité</dt><dd><span class="chip ${PRIO[d.priority] ?? 'c-run'}">${esc(d.priority)}</span></dd><dt>Canal</dt><dd>Portail web</dd><dt>Agent</dt><dd>Agent démo</dd></dl></section>
<section class="card"><div class="ch"><h2>Suivi</h2></div><ol class="steps"><li class="done"><i>✓</i>Demande reçue</li><li class="cur"><i>2</i>Analyse en cours</li><li class="todo"><i>3</i>Réponse envoyée</li><li class="todo"><i>4</i>Dossier clos</li></ol></section></div>`
      : '<h1>Dossier introuvable</h1>',
  );

const clients = () =>
  layout(
    'Clients',
    '/clients',
    `<div class="head"><div><h1>Clients</h1><p class="sub">Portefeuille de démonstration</p></div></div>
<div class="clients">${['Aïssatou Ba', 'Moussa Sarr', 'Fatou Sow', 'Cheikh Mbaye', 'Khady Gueye', 'Ibrahima Fall'].map((n, i) => `<div class="card client">${person(n, i)}<span class="sub">${String(3 + i)} demandes · client depuis ${String(2019 + (i % 5))}</span><span class="chip ${i % 3 === 0 ? 'c-ok' : 'c-run'}">${i % 3 === 0 ? 'Fidèle' : 'Actif'}</span></div>`).join('')}</div>`,
  );

const rapports = () =>
  layout(
    'Rapports',
    '/rapports',
    `<div class="head"><div><h1>Rapports</h1><p class="sub">Indicateurs consolidés</p></div></div>
<div id="zone" class="card" style="padding:18px">Chargement des indicateurs…</div>
<script>fetch('/api/statistiques').then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(){document.getElementById('zone').textContent='Indicateurs à jour.'}).catch(function(){document.getElementById('zone').outerHTML='<div class="alert" role="alert">⚠ Impossible de charger les indicateurs (erreur serveur). Réessayez plus tard.</div>'})</script>`,
  );

const parametres = () =>
  layout(
    'Paramètres',
    '/parametres',
    `<div class="head"><div><h1>Paramètres</h1><p class="sub">Préférences de l'espace</p></div></div>
<div class="tabs" role="tablist"><button role="tab" aria-selected="true" id="t1" onclick="sel(this)">Général</button><button role="tab" aria-selected="false" id="t2" onclick="sel(this)">Notifications</button><button role="tab" aria-selected="false" id="t3" onclick="sel(this)">Sécurité</button></div>
<section class="card" role="tabpanel" id="panel"><div class="toggle"><span>Langue de l'interface : français</span><span class="sw"></span></div><div class="toggle"><span>Thème clair</span><span class="sw"></span></div><div class="toggle"><span>Afficher les références complètes</span><span class="sw off"></span></div></section>
<script>function sel(b){document.querySelectorAll('[role=tab]').forEach(function(x){x.setAttribute('aria-selected',String(x===b))});document.getElementById('panel').querySelector('span').textContent=b.textContent+' : préférences enregistrées'}</script>`,
  );

export interface OrbitApp {
  url: string;
  close: () => Promise<void>;
  readonly created: number;
}

export async function startOrbitApp(port = 0): Promise<OrbitApp> {
  let nextId = 3024;
  let created = 0;
  const seeds: Demande[] = [
    {
      id: 3023,
      name: 'Aminata Ndiaye',
      type: 'Information',
      priority: 'Basse',
      status: 'En cours',
      date: '14/10/2026',
    },
    {
      id: 3022,
      name: 'Moussa Sarr',
      type: 'Réclamation',
      priority: 'Haute',
      status: 'En attente',
      date: '13/10/2026',
    },
    {
      id: 3021,
      name: 'Ibrahima Fall',
      type: 'Assistance',
      priority: 'Normale',
      status: 'Résolue',
      date: '12/10/2026',
    },
    {
      id: 3020,
      name: 'Fatou Sow',
      type: 'Assistance',
      priority: 'Normale',
      status: 'En attente',
      date: '11/10/2026',
    },
  ];
  // Chaque session (cookie) voit les exemples et ses propres créations, comme « mes demandes ».
  const sessions = new Map<string, Demande[]>();
  let nextSession = 1;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = url.pathname;
    let sid = /(?:^|;\s*)orbit=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sid || !sessions.has(sid)) {
      sid = `s${String(nextSession++)}`;
      sessions.set(sid, []);
      res.setHeader('set-cookie', `orbit=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    const mine = sessions.get(sid) ?? [];
    const items = [...mine, ...seeds];
    if (route === '/api/demandes' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        let p: Record<string, string> = {};
        try {
          p = JSON.parse(body || '{}') as Record<string, string>;
        } catch {
          p = {};
        }
        const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/[<>&]/g, '').slice(0, 40) : '');
        const name = `${clean(p.firstName)} ${clean(p.lastName)}`.trim() || 'Sans nom';
        const d: Demande = {
          id: nextId++,
          name,
          type: clean(p.type) || 'Assistance',
          priority: clean(p.priority) || 'Normale',
          status: 'Nouvelle',
          date: '15/10/2026',
        };
        mine.unshift(d);
        created += 1;
        res.statusCode = 201;
        res.setHeader('location', `/api/demandes/${String(d.id)}`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: d.id, reference: `DEM-${String(d.id)}`, status: 'CREATED' }));
      });
      return;
    }
    if (route === '/api/statistiques') {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"internal"}');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const m = route.match(/^\/demandes\/(\d+)$/);
    if (route === '/') res.end(dashboard(items));
    else if (route === '/demandes') res.end(demandes(items, url.searchParams.has('cree')));
    else if (route === '/demandes/nouvelle') res.end(nouvelle());
    else if (m) res.end(detail(items.find((d) => d.id === Number(m[1]))));
    else if (route === '/clients') res.end(clients());
    else if (route === '/rapports') res.end(rapports());
    else if (route === '/parametres') res.end(parametres());
    else {
      res.statusCode = 404;
      res.end(layout('Introuvable', '', '<h1>Page introuvable</h1>'));
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    get created() {
      return created;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}
