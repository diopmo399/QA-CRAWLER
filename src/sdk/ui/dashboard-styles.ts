import { darkThemeCss } from './theme.js';

/**
 * LE STYLE DU DASHBOARD, enfermé dans le Shadow DOM : la maquette « Dashboard QA-CRAWLER complet » —
 * panneau de navigation indigo par sections, contenu sur fond clair en cartes blanches, accent indigo,
 * IBM Plex Sans. Mêmes variables publiques `--qa-*` que les autres composants : l'hôte les habille
 * d'un seul jeu de valeurs. Responsive par requêtes de conteneur : sous 960 px le menu se replie
 * derrière un bouton, sous 600 px tout passe sur une colonne (les tableaux défilent dans leur cadre).
 */
export const DASHBOARD_CSS = `
:host{
  --qa-color-primary:#4F46E5;--qa-color-primary-2:#4338CA;
  --qa-color-background:#F5F6FB;
  --qa-color-surface:#FFFFFF;--qa-color-surface-2:#F7F8FC;
  --qa-color-text:#161733;--qa-color-muted:#50547A;--qa-color-faint:#9AA0B8;
  --qa-color-border:#DEE1EF;--qa-color-border-strong:#CDD0E4;
  --qa-color-panel:#1E1B4B;--qa-color-panel-2:#312E81;
  --qa-color-success:#0FA88B;--qa-color-success-soft:#E3F7F2;
  --qa-color-warning:#C77700;--qa-color-warning-soft:#FFF4DF;
  --qa-color-danger:#E5484D;--qa-color-danger-soft:#FDECEC;
  --qa-radius:14px;
  --qa-font-family:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --qa-font-family-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:block;color:var(--qa-color-text);font:14px/1.5 var(--qa-font-family);-webkit-font-smoothing:antialiased;container-type:inline-size;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,select,input{font:inherit;color:inherit}
code,.mono{font-family:var(--qa-font-family-mono);font-size:.9em}
code{background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:6px;padding:0 5px;overflow-wrap:anywhere}
.mu{color:var(--qa-color-muted)}
.block{display:block}
.err{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));margin:0}
:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}
.ico{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

/* La coquille : menu et contenu côte à côte, chacun dans son cadre arrondi. */
.dash{display:grid;grid-template-columns:240px minmax(0,1fr);gap:16px;align-items:stretch;min-height:640px}
.side{background:var(--qa-color-panel);color:#E8E7FD;border-radius:16px;padding:22px 14px;display:flex;flex-direction:column;gap:18px;min-width:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.brand{display:flex;align-items:center;gap:12px;padding:0 6px;min-width:0}
.brand b{display:block;font-weight:600;font-size:16px;letter-spacing:.02em;color:#fff}
.brand small{display:block;color:#C7C8EE;font-size:12px}
.logo{width:36px;height:36px;border-radius:10px;background:#6366F1;color:#fff;display:grid;place-items:center;font-weight:600;flex:none}
.menu-btn{display:none;align-items:center;gap:8px;min-height:44px;padding:0 14px;border-radius:10px;border:1px solid #3F3C85;background:#2A2765;color:#fff;font-weight:500;cursor:pointer}
.drawer{display:flex;flex-direction:column;gap:20px;flex:1}
.ctx{display:flex;flex-direction:column;gap:6px;padding:0 6px}
.ctx span{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#C7C8EE}
.ctx select{min-height:40px;border-radius:10px;border:1px solid #3F3C85;background:#2A2765;color:#fff;padding:0 10px;max-width:100%}
.sec{display:flex;flex-direction:column;gap:4px}
.sec-t{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#A5A7DC;padding:0 12px 4px}
.side a{display:flex;align-items:center;gap:10px;padding:0 12px;min-height:44px;border-radius:10px;color:#E8E7FD;text-decoration:none}
.side a:hover{background:rgba(255,255,255,.07);color:#fff}
.side a[aria-current="page"]{background:var(--qa-color-panel-2);color:#fff;font-weight:600}
.foot{margin-top:auto;border-top:1px solid #3F3C85;padding:14px 12px 0;font-size:12px;color:#C7C8EE;display:flex;flex-direction:column;gap:4px}
.foot span{display:flex;align-items:center;gap:8px}
.foot .on{width:8px;height:8px;border-radius:50%;background:#34D399;display:inline-block}
.main{min-width:0;background:var(--qa-color-background);border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:20px}

/* En-tête d'écran. */
.hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.hd-t{display:flex;flex-direction:column;gap:4px;min-width:0}
.hd h1{margin:0;font-weight:600;font-size:28px;line-height:1.2;letter-spacing:-.01em;display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.hd h1 code{font-size:13px;font-weight:500;background:var(--qa-color-surface)}
.sub{margin:0;color:var(--qa-color-muted);font-size:14px;overflow-wrap:anywhere}
.acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.back{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0;border:0;background:none;color:var(--qa-color-primary);font-weight:500;cursor:pointer;align-self:flex-start}
.back:hover{text-decoration:underline}
.notice{margin:0;padding:10px 14px;border-radius:12px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border)}

/* Boutons et champs. */
.btn{min-height:44px;border-radius:10px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:500;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);cursor:pointer;color:var(--qa-color-text)}
.btn:hover{border-color:var(--qa-color-primary)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.primary{border:0;background:var(--qa-color-primary);color:#fff;font-weight:600}
.btn.primary:hover{background:var(--qa-color-primary-2)}
.btn.danger{border-color:color-mix(in srgb,var(--qa-color-danger) 55%,transparent);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));font-weight:600}
.btn.ghost{border-color:transparent;background:transparent;color:var(--qa-color-muted)}
.btn.small{min-height:40px;padding:0 12px;font-size:13px;align-self:flex-start}
.btn.icon-only{width:44px;padding:0}
.lnk{border:0;background:none;padding:0;color:var(--qa-color-primary);font-weight:500;cursor:pointer;text-align:left;min-height:32px}
.lnk:hover{text-decoration:underline}
.pick{display:inline-flex;align-items:center;gap:8px;color:var(--qa-color-muted);font-size:14px}
.pick select,.field select{min-height:44px;padding:0 12px;border:1px solid var(--qa-color-border-strong);border-radius:10px;background:var(--qa-color-surface);color:var(--qa-color-text);max-width:100%}
.chk{display:inline-flex;align-items:center;gap:8px;min-height:44px}
.chk input,.row-chk input{width:18px;height:18px;accent-color:var(--qa-color-primary);flex:none}

/* Indicateurs. */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.kpi{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:18px;display:flex;flex-direction:column;gap:6px;min-width:0}
.kpi>span{font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;color:var(--qa-color-muted)}
.kpi .big{font-weight:600;font-size:34px;line-height:1.15;letter-spacing:-.02em}
.kpi .mid{font-weight:600;font-size:22px;line-height:1.25;overflow-wrap:anywhere}
.kpi small{color:var(--qa-color-muted);font-size:13px}
.kpi.accent{border-color:color-mix(in srgb,var(--qa-color-primary) 35%,var(--qa-color-border));background:color-mix(in srgb,var(--qa-color-primary) 4%,var(--qa-color-surface))}
.kpi .scope{margin:6px 0 0;padding:0 0 0 16px;line-height:1.45;font-size:13px;color:var(--qa-color-muted)}

/* Cartes et grilles. */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.split{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.split>*{flex:2 1 460px;min-width:0}
.split>.col{display:flex;flex-direction:column;gap:16px}
.split>.col.narrow,.split>form+.col{flex:1 1 300px}
.card{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:20px;display:flex;flex-direction:column;gap:12px;min-width:0}
.card h2{margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.card h2.fl{text-transform:none;letter-spacing:0;font-size:16px;color:var(--qa-color-text)}
.card h3{margin:6px 0 0;font-size:14px;font-weight:600}
.card-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.wide{grid-column:1 / -1}
.msg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 24px;text-align:center;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius)}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--qa-color-border);border-top-color:var(--qa-color-primary);animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin,.dot{animation:none!important}}

/* Graphique des rejeux par jour. */
.bars{display:flex;align-items:flex-end;gap:8px;height:170px;padding-top:6px;overflow-x:auto}
.bar{flex:1 0 22px;height:100%;display:flex;flex-direction:column-reverse;align-items:stretch;gap:2px;position:relative;padding-bottom:20px}
.bar span{display:block;border-radius:4px;min-height:0}
.bar .p{background:var(--qa-color-success)}
.bar .f{background:var(--qa-color-danger)}
.bar small{position:absolute;bottom:0;left:50%;transform:translateX(-50%);font-size:12px;color:var(--qa-color-muted);white-space:nowrap}
.legend{margin:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--qa-color-muted);flex-wrap:wrap}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.legend i.p{background:var(--qa-color-success)}.legend i.f{background:var(--qa-color-danger);margin-left:10px}

/* Alertes. */
.alerts,.plain,.checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.alerts li{display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:10px;flex-wrap:wrap}
.alerts li.ko{background:var(--qa-color-danger-soft)}
.alerts li.warn{background:var(--qa-color-warning-soft)}
.alerts .tag{font-size:12px;font-weight:600;background:var(--qa-color-surface);border-radius:6px;padding:2px 8px}
.alerts li.ko .tag{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.alerts li.warn .tag{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text))}
.alerts .txt{flex:1 1 220px;min-width:0}

/* Tableaux. */
.tw{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:14px;min-width:620px}
.tbl th,.tbl td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--qa-color-border);vertical-align:middle}
.tbl tbody tr:last-child td{border-bottom:0}
.tbl thead th{font-size:12px;color:var(--qa-color-muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em}

/* Pastilles de statut. */
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.ok{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));background:var(--qa-color-success-soft)}
.pill.ko{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));background:var(--qa-color-danger-soft)}
.pill.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.pill.live{color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface))}
.pill.mu{color:var(--qa-color-muted);background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border)}

/* Projets. */
.cards{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.pcard{width:100%;text-align:left;cursor:pointer;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:18px;display:flex;flex-direction:column;gap:6px;min-height:44px}
.pcard:hover{border-color:var(--qa-color-primary)}
.pt{display:flex;align-items:center;gap:8px;justify-content:space-between}
.pt b{font-weight:600;font-size:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.url{overflow-wrap:anywhere;margin:0}
.last{font-size:13px}
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--qa-color-border)}
.tabs button{min-height:44px;padding:0 14px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--qa-color-muted);cursor:pointer;margin-bottom:-1px}
.tabs button[aria-selected="true"]{border-bottom-color:var(--qa-color-primary);color:var(--qa-color-text);font-weight:600}
.note{margin:0;padding:12px 14px;border-radius:10px;background:var(--qa-color-warning-soft);display:flex;gap:10px;align-items:flex-start}
.note .ico{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));margin-top:1px}
.confirm{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:12px;background:var(--qa-color-danger-soft)}

/* Lancement. */
.launch{gap:16px}
.launch fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}
.launch legend{font-size:14px;font-weight:600;margin-bottom:8px;padding:0}
.kinds{flex-direction:row!important;flex-wrap:wrap}
.choice{flex:1 1 200px;display:flex;gap:10px;align-items:flex-start;border:1px solid var(--qa-color-border-strong);border-radius:12px;padding:14px;cursor:pointer}
.choice.on{border:2px solid var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 6%,var(--qa-color-surface))}
.choice input{margin-top:3px;accent-color:var(--qa-color-primary)}
.choice b{display:block}
.choice small{display:block;color:var(--qa-color-muted);font-size:13px}
.field{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
.field select{font-weight:400}
.field select[disabled]{opacity:.6}
.row-chk{display:flex;gap:10px;align-items:center;min-height:44px;padding:0 12px;border:1px solid var(--qa-color-border);border-radius:10px;flex-wrap:wrap}
.row-chk .nm{flex:1;font-family:var(--qa-font-family-mono);font-size:13px;min-width:0;overflow-wrap:anywhere}
.form-acts{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}

/* Environnements. */
.env{border:1px solid var(--qa-color-border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.env+.env{margin-top:2px}
.env-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
.env .url{font-size:12px}
.env-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.env-grid .env{background:var(--qa-color-surface)}
.checks li{display:flex;gap:8px;align-items:flex-start;font-size:13px}
.checks li.ok .ico{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.checks li.ko{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.checks .ico{width:16px;height:16px;margin-top:2px}

/* Politique de sécurité. */
.policy{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;font-size:14px}
.policy>div{background:var(--qa-color-background);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}

/* Exécution. */
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.steps li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:10px 0;border-top:1px solid var(--qa-color-border)}
.steps li:first-child{border-top:0}
.steps li span{overflow-wrap:anywhere}
.steps .why{grid-column:2 / -1;color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.live h2 .dot{width:8px;height:8px;border-radius:50%;background:var(--qa-color-primary);box-shadow:0 0 0 4px color-mix(in srgb,var(--qa-color-primary) 22%,transparent);animation:pl 1.4s ease-in-out infinite}
@keyframes pl{50%{opacity:.35}}

/* Historique et comparaison. */
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.cell-chk{display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center;cursor:pointer}
.cell-chk input{width:18px;height:18px;accent-color:var(--qa-color-primary)}
.tbl tr.sel td{background:color-mix(in srgb,var(--qa-color-primary) 6%,var(--qa-color-surface))}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.tile{background:var(--qa-color-background);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:2px}
.tile b{font-size:28px;font-weight:600;line-height:1.2}
.tile.ko{background:var(--qa-color-danger-soft)}.tile.ko b{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.tile.ok{background:var(--qa-color-success-soft)}.tile.ok b{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.plain.tight{gap:2px;font-size:13px}
.form-acts.start{justify-content:flex-start}

/* Scénarios. */
.scard{width:100%;text-align:left;cursor:pointer;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:16px;display:flex;flex-direction:column;gap:8px;min-height:44px}
.scard.on{border:2px solid var(--qa-color-primary)}
.scard:hover{border-color:var(--qa-color-primary)}
.row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;min-width:0;width:100%}
.push{margin-left:auto}
.strip{display:inline-flex;gap:3px;align-items:center}
.strip i{width:10px;height:18px;border-radius:3px;display:inline-block;background:var(--qa-color-border)}
.strip i.ok{background:var(--qa-color-success)}.strip i.ko{background:var(--qa-color-danger)}
.rec{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 0;border-top:1px solid var(--qa-color-border)}
.rec:first-of-type{border-top:0}
.big-name{font-size:17px}

/* Édition d'un environnement. */
.env.on{border:2px solid var(--qa-color-primary)}
.section-t{margin:8px 0 0;font-size:20px;font-weight:600}
.env-form{gap:16px}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.field input,.field textarea{min-height:44px;border-radius:10px;border:1px solid var(--qa-color-border-strong);padding:10px 12px;background:var(--qa-color-surface);color:var(--qa-color-text);font-weight:400;width:100%}
.field input[disabled]{opacity:.55}
.field textarea{resize:vertical;font-size:13px}

/* Exploration : carte des écrans et anomalies. */
.map{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.node{border:1px solid var(--qa-color-border);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.node.root{border:2px solid var(--qa-color-primary)}
.node.has-issue{border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border));background:color-mix(in srgb,var(--qa-color-danger-soft) 50%,var(--qa-color-surface))}
.node code{font-size:12px;align-self:flex-start}
.tag-s{font-size:12px;font-weight:600;color:var(--qa-color-primary)}
.ko-t{font-size:13px;font-weight:600;color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{min-height:40px;padding:0 12px;border-radius:999px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);cursor:pointer;font-size:13px;font-weight:500}
.chip[aria-pressed="true"]{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:#fff}
.issue{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--qa-color-border);border-radius:10px}
.issue span{min-width:0;overflow-wrap:anywhere}

/* Exigences : sources, validation, référentiel, matrice, indicateurs, tendances. */
.badge{margin-left:auto;min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:var(--qa-color-primary);color:#fff;font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}
.conn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.conn h3{margin:0;font-size:15px}
.conn details{font-size:13px}
.conn summary{cursor:pointer;color:var(--qa-color-muted);min-height:32px;display:flex;align-items:center}
.req-form{gap:14px}
.req-form select,.link-form select{min-height:44px;border-radius:10px;border:1px solid var(--qa-color-border-strong);padding:0 10px;background:var(--qa-color-surface);color:var(--qa-color-text);width:100%}
.note.warn{background:var(--qa-color-danger-soft)}
.cands{display:flex;flex-direction:column;gap:12px}
.info-list{margin-top:12px;font-size:13px}
.info-list summary{cursor:pointer;color:var(--qa-color-muted);min-height:32px;display:flex;align-items:center}
.cand{border:1px solid var(--qa-color-border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:6px;min-width:0}
.cand[data-decided="ACCEPT"],.cand[data-decided="MERGE"]{border-left:4px solid var(--qa-color-success)}
.cand[data-decided="REJECT"]{border-left:4px solid var(--qa-color-faint)}
.cand-h{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;font-size:13px}
.cand-t{overflow-wrap:anywhere}
.cand p,.cand small{overflow-wrap:anywhere}
.tag-k{font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--qa-color-primary)}
.row-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.row-acts .btn[aria-pressed="true"]{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.inline{display:inline-flex;gap:6px;align-items:center;font-size:13px}
.inline select{min-height:40px;border-radius:10px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-text)}
.ok-t{margin:0;font-size:13px;font-weight:600;color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.ents{display:flex;flex-direction:column;gap:6px}
.ent{width:100%;min-height:44px;text-align:left;cursor:pointer;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:10px 12px;border-radius:10px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);color:var(--qa-color-text)}
.ent:hover,.ent.sel{border-color:var(--qa-color-primary)}
.ent.sel{background:color-mix(in srgb,var(--qa-color-primary) 8%,var(--qa-color-surface))}
.ent-t{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}
.split>.wide-aside{flex:1 1 380px}
.lk{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 0}
.lk code{overflow-wrap:anywhere}
.just{font-size:13px;padding:0 0 8px;overflow-wrap:anywhere}
.mtx th[scope="row"]{font-weight:400;min-width:180px}
.mtx tr.sel{background:color-mix(in srgb,var(--qa-color-primary) 7%,var(--qa-color-surface))}
.mx code{white-space:nowrap}
.mx{display:inline-flex;padding:2px 6px;border-radius:6px;margin:2px 0;font-size:12px;border:1px solid var(--qa-color-border)}
.mx.on{background:var(--qa-color-success-soft);border-color:transparent}
.mx.prop{background:var(--qa-color-warning-soft);border-color:transparent}
.mx.off{text-decoration:line-through;color:var(--qa-color-muted)}
.ind-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}
.ind-v{display:flex;align-items:baseline;gap:10px}
.ind-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;margin:0;font-size:13px}
.ind-dl dt{color:var(--qa-color-muted)}
.ind-dl dd{margin:0;overflow-wrap:anywhere}
.tile.warn{background:var(--qa-color-warning-soft)}
.tile.warn b{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text))}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:16px}
.bars.wk .p{background:var(--qa-color-primary)}
.bar .none{height:2px;background:var(--qa-color-border)}
.bar .v{font-size:11px;font-weight:600;text-align:center;color:var(--qa-color-muted);white-space:nowrap}

/* Responsive : 1 100 px, 960 px (menu replié), 600 px (une colonne). */
@container (max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:960px){
  .dash{grid-template-columns:minmax(0,1fr);gap:12px}
  .side{padding:12px 14px;gap:12px}
  .menu-btn{display:inline-flex}
  .dash[data-menu="closed"] .drawer{display:none}
  .drawer{gap:16px}
  .foot{margin-top:0}
}
@container (max-width:600px){
  .main{padding:16px;gap:16px}
  .kpis{grid-template-columns:minmax(0,1fr)}
  .hd h1{font-size:22px}
  .hd .acts{width:100%}
  .grid{grid-template-columns:minmax(0,1fr)}
  .split>*{flex-basis:100%}
  .ind-dl{grid-template-columns:minmax(0,1fr)}
  .menu-btn span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
}
${darkThemeCss()}`;
