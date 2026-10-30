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

/* Accès : connexion, droits, membres, jeton affiché une fois, journal. */
.signin{max-width:460px;margin:8vh auto 0;width:100%}
.signin h1{margin:0;font-size:24px}
.signin form{display:flex;flex-direction:column;gap:12px}
.signin form .btn{align-self:flex-start}
.rights th[scope="row"]{font-weight:400;min-width:220px}
.rights td{text-align:center;position:relative}
.rights td.yes{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));font-weight:600}
.rights td.no{color:var(--qa-color-faint)}
.members{display:flex;flex-direction:column;gap:10px}
.member{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 0;border-top:1px solid var(--qa-color-border)}
.member:first-child{border-top:0}
.member.off{opacity:.6}
.avatar{width:36px;height:36px;border-radius:999px;background:var(--qa-color-primary);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex:none}
.m-name{flex:1 1 160px;min-width:0;overflow-wrap:anywhere}
.member-form{gap:12px;margin-top:8px}
.member-form select,.member select{min-height:40px;border-radius:10px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-text);padding:0 8px}
.token-box{display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:12px;background:var(--qa-color-warning-soft);margin-bottom:12px}
.token-box p{margin:0}
.tok{display:block;overflow-wrap:anywhere;user-select:all;font-size:13px;padding:8px 10px;border-radius:8px;background:var(--qa-color-surface)}
.path code{overflow-wrap:anywhere}
.foot .who{color:#fff;font-weight:600}
.foot .out{color:#C7C5F4;align-self:flex-start;min-height:32px}

/*
 * Densité et contrôles. Sur ordinateur, des contrôles compacts (36 px, 30 px pour les petits) ;
 * sur écran tactile (pointeur grossier), 44 px, la taille d'une cible au doigt. Une seule
 * apparence pour toutes les listes déroulantes : bordure, rayon, flèche dessinée avec les jetons
 * (elle suit donc le thème clair ou sombre).
 */
:host{--qa-control:36px;--qa-control-sm:30px}
@media (pointer:coarse){:host{--qa-control:44px;--qa-control-sm:40px}}
.btn{min-height:var(--qa-control);padding:0 14px;border-radius:8px;font-size:14px;line-height:1.2;white-space:nowrap}
.btn .ico{width:16px;height:16px}
.btn.small{min-height:var(--qa-control-sm);padding:0 10px;font-size:13px}
.btn.icon-only{width:var(--qa-control);min-width:var(--qa-control)}
.btn.ghost:hover{background:var(--qa-color-surface-2);color:var(--qa-color-text)}
.btn:focus-visible,.chip:focus-visible,.tabs button:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.card>.btn,.card>form>.btn,.signin form .btn{align-self:flex-start}
.chip{min-height:var(--qa-control-sm);padding:0 12px}
.tabs button{min-height:40px}
.chk,.row-chk{min-height:var(--qa-control)}
.field{font-size:13px}
.field input,.field textarea{min-height:var(--qa-control);padding:6px 10px;border-radius:8px;font-size:14px}
.field input:focus-visible,.field textarea:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px;border-color:var(--qa-color-primary)}
.dash select{-webkit-appearance:none;appearance:none;min-height:var(--qa-control);padding:0 32px 0 10px;border:1px solid var(--qa-color-border-strong);border-radius:8px;background-color:var(--qa-color-surface);color:var(--qa-color-text);font-size:14px;font-weight:400;cursor:pointer;max-width:100%;background-image:linear-gradient(45deg,transparent 50%,var(--qa-color-muted) 50%),linear-gradient(135deg,var(--qa-color-muted) 50%,transparent 50%);background-position:calc(100% - 16px) 50%,calc(100% - 11px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.dash select:hover{border-color:var(--qa-color-primary)}
.dash select:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.dash select[disabled]{opacity:.55;cursor:not-allowed}
.dash .ctx select{background-color:#2A2765;border-color:#3F3C85;color:#fff;background-image:linear-gradient(45deg,transparent 50%,#C7C8EE 50%),linear-gradient(135deg,#C7C8EE 50%,transparent 50%)}
.dash .ctx select:hover{border-color:#8B8BFF}
/* La liste d'une sélection : un menu dessiné par le Dashboard là où le navigateur le permet (sinon, celle du système). */
@supports (appearance:base-select){
  .dash select,.dash select::picker(select){-webkit-appearance:base-select;appearance:base-select}
  .dash select{display:inline-flex;align-items:center;gap:8px;padding:0 10px;background-image:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dash select::picker-icon{content:"";width:6px;height:6px;margin:0 2px 3px auto;border:solid var(--qa-color-muted);border-width:0 1.6px 1.6px 0;transform:rotate(45deg);transition:transform .15s ease,margin .15s ease}
  .dash select:open::picker-icon{transform:rotate(225deg);margin-bottom:-3px}
  .dash select::picker(select){margin:4px 0;padding:4px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);color:var(--qa-color-text);box-shadow:0 14px 34px -10px rgb(15 23 42 / .32),0 2px 6px rgb(15 23 42 / .08);max-height:min(360px,60vh);overflow-y:auto;min-width:anchor-size(width)}
  .dash option{display:flex;align-items:center;gap:10px;min-height:32px;padding:6px 10px;border-radius:6px;font-size:13px;line-height:1.3;white-space:nowrap;cursor:pointer}
  .dash option::checkmark{order:1;margin-left:auto;color:var(--qa-color-primary);font-weight:700}
  .dash option:hover,.dash option:focus-visible{background:var(--qa-color-surface-2);outline:none}
  .dash option:checked{color:var(--qa-color-primary);font-weight:600;background:color-mix(in srgb,var(--qa-color-primary) 9%,transparent)}
  .dash option:disabled{color:var(--qa-color-faint);cursor:default}
  .dash .ctx select{background-image:none}
  .dash .ctx select::picker-icon{border-color:#C7C8EE}
  .dash .ctx select::picker(select){background:#24215C;border-color:#3F3C85;color:#E8E7FD;box-shadow:0 16px 36px -10px rgb(0 0 0 / .6)}
  .dash .ctx option:hover,.dash .ctx option:focus-visible{background:rgb(255 255 255 / .08)}
  .dash .ctx option:checked{color:#fff;background:rgb(99 102 241 / .38)}
  .dash .ctx option::checkmark{color:#C7D2FE}
}
.pick{font-size:13px}
.pick select{min-width:150px}
.inline select,.member select{min-height:var(--qa-control-sm);font-size:13px}
.lk .row-acts{margin-left:auto}
.lk .row-acts .btn{min-height:var(--qa-control-sm);padding:0 8px;font-size:13px}

/* Choix d'un fichier : un bouton du Dashboard, le champ natif reste accessible (clavier, lecteur d'écran). */
.file-pick{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-weight:400}
.file-pick label{position:relative;overflow:hidden}
.file-pick input[type="file"]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}
.file-pick label:focus-within{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.field input[inputmode="numeric"]{max-width:180px}

/* Enregistrements : formulaire, session en direct. */
.rec-form{gap:12px}
.live-rec{border-color:color-mix(in srgb,var(--qa-color-primary) 45%,var(--qa-color-border))}
.rec-events{display:flex;flex-direction:column;gap:4px;font-size:13px;overflow-wrap:anywhere}
.row-acts a.btn{text-decoration:none}
.rec-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.rec-bar .danger{margin-left:auto}
.rec-check{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.rec-check .field{flex:1 1 260px;min-width:0}
.live-steps{display:flex;flex-direction:column;gap:0;border:1px solid var(--qa-color-border);border-radius:12px;overflow:hidden}
.live-step{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:start;padding:10px 12px;border-top:1px solid var(--qa-color-border);background:var(--qa-color-surface)}
.live-step:first-child{border-top:0}
.live-step .n{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.live-step .ls-main{min-width:0;overflow-wrap:anywhere}
.live-step .ls-main b{font-weight:600}
.amb{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--qa-color-warning-soft);display:flex;flex-direction:column;gap:6px}
.amb .row-acts{display:flex;flex-wrap:wrap;gap:6px}
.rec-phases{display:flex;flex-direction:column;gap:8px}
.rec-phases li{display:flex;align-items:center;gap:8px}
.rec-phases li.done{color:var(--qa-color-muted)}
.rec-phases li.done .ico{color:var(--qa-color-success)}
.rec-phases li .spin{width:14px;height:14px;border-width:2px}
.prog{height:6px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden}
.prog span{display:block;height:100%;background:var(--qa-color-primary);transition:width .3s}
.rec-notes{font-size:13px}
/* Revue d'un enregistrement : rejeu, parcours en groupes, assertions, données, tests générés. */
.replay-card .row-line,.row-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rv-flow{gap:14px}
.rv-group{border:1px solid var(--qa-color-border);border-radius:12px;overflow:hidden;background:var(--qa-color-surface)}
.rv-group.loose{border-style:dashed}
.rv-group-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 12px;background:var(--qa-color-surface-2);border-bottom:1px solid var(--qa-color-border)}
.rv-group-h .row-acts{margin-left:auto;display:flex;flex-wrap:wrap;gap:4px}
.rv-rename{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rv-rename input{min-height:var(--qa-control-sm);padding:0 10px;border:1px solid var(--qa-color-border-strong);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text)}
.rv-steps{display:flex;flex-direction:column}
.rv-step{display:grid;grid-template-columns:22px 26px minmax(0,1fr) auto;gap:10px;align-items:start;padding:9px 12px;border-top:1px solid var(--qa-color-border)}
.rv-step:first-child{border-top:0}
.rv-step.is-check{background:color-mix(in srgb,var(--qa-color-surface-2) 60%,transparent)}
.rv-step.chosen{background:color-mix(in srgb,var(--qa-color-primary) 8%,var(--qa-color-surface))}
.rv-step .pickbox{width:18px;height:18px;margin-top:3px;accent-color:var(--qa-color-primary)}
.rv-step .n{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.rv-step.is-check .n{color:var(--qa-color-success);background:var(--qa-color-success-soft);border-color:transparent}
.rv-main{min-width:0;display:flex;flex-direction:column;gap:3px;overflow-wrap:anywhere}
.rv-side{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.rv-side .row-acts{display:flex;flex-wrap:nowrap;gap:2px}
a.btn{text-decoration:none}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.tag.prod{border-color:color-mix(in srgb,var(--qa-color-primary) 35%,var(--qa-color-border))}
.tag code{font-size:11px;padding:0 3px}
.rv-selbar{position:sticky;bottom:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:var(--qa-color-panel);color:#fff;box-shadow:0 6px 24px rgb(0 0 0 / .18)}
.rv-selbar .rv-new{display:flex;flex-wrap:wrap;gap:6px}
.rv-selbar input,.rv-selbar select{min-height:var(--qa-control-sm);padding:0 10px;border-radius:8px;border:1px solid transparent;background:var(--qa-color-surface);color:var(--qa-color-text)}
.rv-selbar .btn.ghost{color:#E8E7FD}
.rv-checks li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--qa-color-border)}
.rv-checks li:first-child{border-top:0}
.rv-asserts,.rv-inputs,.rv-files{display:flex;flex-direction:column}
.rv-assert,.rv-inputs>li,.rv-files>li{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid var(--qa-color-border)}
.rv-assert:first-child,.rv-inputs>li:first-child,.rv-files>li:first-child{border-top:0;padding-top:4px}
.rv-what{margin:0;font-weight:500}
.rv-assert .row-acts{display:flex;flex-wrap:wrap;gap:6px}
.rv-src{display:flex;flex-wrap:wrap;gap:6px 16px;border:0;padding:0;margin:0}
.chips-row{display:flex;flex-wrap:wrap;gap:6px 16px}
.rv-gen fieldset{border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}
.rv-gen legend{font-weight:600;margin-bottom:4px}
pre.code{margin:6px 0 0;max-height:320px;overflow:auto;padding:10px 12px;border-radius:10px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.warn-card{border-color:color-mix(in srgb,var(--qa-color-warning) 45%,var(--qa-color-border));background:var(--qa-color-warning-soft)}
.rv-links{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;font-size:13px}
.rv-links .lnk{min-height:24px;font-size:13px}
.rv-links>span{color:var(--qa-color-faint)}
.correction-card{border-color:color-mix(in srgb,var(--qa-color-primary) 45%,var(--qa-color-border))}
.correction-card dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:0}
.correction-card dl.kv dt{color:var(--qa-color-muted)}
.correction-card dl.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.rv-intent .fields{max-width:640px}
.notice.ok{display:flex;gap:8px;align-items:flex-start}
form.col[data-action^="lib-"]{display:flex;flex-direction:column;gap:12px}
.lib-intro{margin:0;max-width:900px}
.lib-bar{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:flex-end}
.lib-bar .field{font-size:12.5px;gap:4px}
.lib-search{flex:1 1 240px;min-width:0}
.lib-crit{flex:1 1 140px;min-width:130px;max-width:200px}
.lib-shown{margin-left:auto;padding-bottom:10px}
.lib-jump{align-self:flex-start}
.lib-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}
.lib-catalog{min-width:0}
.lib-cards{display:flex;flex-direction:column;gap:10px}
.lib-card{border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-width:0}
.lib-card.open{border-color:color-mix(in srgb,var(--qa-color-primary) 40%,var(--qa-color-border))}
.lib-card p{margin:0}
.lib-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lib-card-h h3{margin:0;font-size:15px;font-weight:650;overflow-wrap:anywhere}
.lib-ver{font-size:12px;font-weight:600;color:var(--qa-color-muted);border:1px solid var(--qa-color-border);border-radius:999px;padding:0 7px;font-variant-numeric:tabular-nums}
.lib-state{font-size:12px;font-weight:600;border-radius:999px;padding:1px 8px}
.lib-card-h .lib-state{margin-left:auto}
.lib-state.ok{color:color-mix(in srgb,var(--qa-color-success) 80%,var(--qa-color-text));background:var(--qa-color-success-soft)}
.lib-state.warn{color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.lib-state.ko{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text));background:var(--qa-color-danger-soft)}
.lib-meta{font-size:13px;color:var(--qa-color-muted)}
.lib-ios{display:flex;flex-wrap:wrap;gap:4px 18px}
.lib-io{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:12.5px;min-width:0}
.lib-io-l{color:var(--qa-color-muted);font-weight:600;margin-right:2px}
.lib-key{font-size:12px;padding:1px 6px;border-radius:6px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow-wrap:anywhere}
.lib-key.opt{border-style:dashed}
.lib-card-f{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}
.lib-file{font-size:11.5px;color:var(--qa-color-muted);overflow-wrap:anywhere;min-width:0}
.lib-acts{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.lib-count{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--qa-color-surface);color:var(--qa-color-primary);font-size:11px;font-weight:700}
.lib-details{border-top:1px solid var(--qa-color-border);margin-top:4px;padding-top:10px;display:flex;flex-direction:column;gap:12px}
.lib-dgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 18px}
.lib-dgrid section{min-width:0;display:flex;flex-direction:column;gap:4px}
.lib-details h4{margin:0 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.lib-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;margin:0;font-size:13px}
.lib-dl dt{color:var(--qa-color-muted)}
.lib-dl dd{margin:0;overflow-wrap:anywhere}
.lib-cond,.lib-history{font-size:13px}
.lib-problems{border:1px solid color-mix(in srgb,var(--qa-color-warning) 45%,var(--qa-color-border));background:var(--qa-color-warning-soft);border-radius:10px;padding:8px 12px;display:flex;flex-direction:column;gap:6px;font-size:13px}
.lib-contract{border-top:1px dashed var(--qa-color-border);padding-top:10px}
.lib-composer{display:flex;flex-direction:column;gap:12px;min-width:0}
.lib-composer h2{margin:0}
.lib-steps{display:flex;flex-direction:column;gap:6px}
.lib-step{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.lib-step.ko{border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border))}
.lib-step .n{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border)}
.lib-step-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.lib-step-h{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.lib-step-h b{overflow-wrap:anywhere}
.lib-links{font-size:12.5px;display:flex;flex-direction:column;gap:1px}
.lib-src{color:color-mix(in srgb,var(--qa-color-success) 80%,var(--qa-color-text))}
.lib-miss{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text));font-weight:600}
.lib-gives{margin:0;font-size:12.5px}
.lib-step-a{flex:none;display:flex;gap:2px}
.lib-empty{margin:0;padding:16px;border:1px dashed var(--qa-color-border-strong);border-radius:10px;text-align:center}
.lib-check{border-radius:10px;padding:10px 12px;border:1px solid var(--qa-color-border);display:flex;flex-direction:column;gap:6px;font-size:13px}
.lib-check.ok{border-color:color-mix(in srgb,var(--qa-color-success) 40%,var(--qa-color-border));background:var(--qa-color-success-soft)}
.lib-check.ko{border-color:color-mix(in srgb,var(--qa-color-danger) 35%,var(--qa-color-border));background:var(--qa-color-danger-soft)}
.lib-check p{margin:0}
.lib-check-h{display:flex;gap:6px;align-items:center}
.lib-sum b{display:block;font-size:12.5px;margin-bottom:2px}
.lib-sum.inline ul{display:flex;flex-direction:row;flex-wrap:wrap;gap:4px}
.lib-sum.ko li{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text))}
.warn-t{color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.lib-blank{padding:28px 16px;border:1px dashed var(--qa-color-border-strong);border-radius:12px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px}
.lib-blank p{margin:0}
/* Revue : la barre des faits de l'enregistrement, et l'onglet Publier (groupes, détail, barre d'action, aperçu). */
.rv-facts{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:10px 14px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface)}
.rv-facts dl{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0}
.rv-fact{display:flex;flex-direction:column;gap:2px;min-width:0}
.rv-fact dt{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--qa-color-muted)}
.rv-fact dd{margin:0;font-size:13.5px;font-weight:500}
.pub-intro{margin:0;max-width:85ch}
.pub-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.pub-bar-l{display:inline-flex;gap:4px}
.pub-nav{font-size:13px}
.pub-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,360px);gap:14px;align-items:start}
.pub-groups{display:flex;flex-direction:column;gap:8px;margin:0;padding:0}
.pub-group{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:4px 10px;align-items:start;padding:10px 12px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);transition:border-color .15s ease,background-color .15s ease}
.pub-group.on{border-color:color-mix(in srgb,var(--qa-color-primary) 55%,var(--qa-color-border));background:color-mix(in srgb,var(--qa-color-primary) 5%,var(--qa-color-surface))}
.pub-group.focus{box-shadow:inset 3px 0 0 var(--qa-color-primary)}
.pub-check{padding-top:3px}
.pub-check input{width:16px;height:16px;accent-color:var(--qa-color-primary);margin:0;cursor:pointer}
.pub-n{font:600 11px/1 var(--qa-font-family-mono);color:var(--qa-color-muted);padding-top:6px;min-width:16px;text-align:right}
.pub-main{display:flex;flex-direction:column;gap:3px;min-width:0;border:0;background:none;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer}
.pub-main:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:3px;border-radius:4px}
.pub-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.pub-name b{font-size:14px}
.pub-meta{font-size:12.5px;color:var(--qa-color-muted)}
.pub-acts{font-size:12.5px;color:var(--qa-color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.pub-data{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.pub-key{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;padding:1px 6px 1px 4px;border-radius:6px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2)}
.pub-key .ico{width:11px;height:11px}
.pub-key.out .ico{color:color-mix(in srgb,var(--qa-color-success) 75%,var(--qa-color-text))}
.pub-key.in .ico{color:var(--qa-color-primary)}
.pub-key code{background:none;border:0;padding:0;font-size:11.5px}
.pub-warn{grid-column:3;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:4px 0 0;font-size:12.5px;color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.pub-warn .ico{width:14px;height:14px;flex:none}
.pub-warn-t{flex:1 1 0;min-width:min(240px,100%)}
.pub-tag{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.pub-tag .ico{width:12px;height:12px}
.pub-tag.ok{color:color-mix(in srgb,var(--qa-color-success) 75%,var(--qa-color-text));border-color:color-mix(in srgb,var(--qa-color-success) 40%,var(--qa-color-border))}
.pub-tag.warn{color:color-mix(in srgb,var(--qa-color-warning) 72%,var(--qa-color-text));border-color:color-mix(in srgb,var(--qa-color-warning) 40%,var(--qa-color-border))}
.pub-tag.ko{color:color-mix(in srgb,var(--qa-color-danger) 78%,var(--qa-color-text));border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border));background:var(--qa-color-danger-soft)}
.pub-side{position:sticky;top:12px;display:flex;flex-direction:column;gap:10px;max-height:calc(100dvh - 140px);overflow:auto}
.pub-side-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px}
.pub-side h3{margin:0;font-size:15px}
.pub-side h4{margin:4px 0 0;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--qa-color-muted)}
.pub-side p{margin:0}
.pub-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;margin:0;font-size:13px}
.pub-dl dt{color:var(--qa-color-muted)}
.pub-dl dd{margin:0}
.pub-steps{display:flex;flex-direction:column;gap:2px;margin:0;padding:0}
.pub-step{display:flex;align-items:baseline;gap:8px;font-size:13px;padding:3px 4px;border-radius:6px}
.pub-step.is-check{color:var(--qa-color-muted);padding-left:22px}
.pub-step input{margin:0;accent-color:var(--qa-color-primary);flex:none;align-self:center}
.pub-pos{font:600 11px/1 var(--qa-font-family-mono);color:var(--qa-color-faint);min-width:18px;text-align:right;flex:none}
.pub-mini{font-size:11px;padding:0 5px;border-radius:5px}
.pub-mini.out{color:color-mix(in srgb,var(--qa-color-success) 75%,var(--qa-color-text))}
.pub-mini.in{color:var(--qa-color-primary)}
.pub-io{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pub-diag{font-size:12.5px;display:flex;flex-direction:column;gap:3px}
.pub-diag .ko{color:color-mix(in srgb,var(--qa-color-danger) 78%,var(--qa-color-text))}
.pub-diag .warn{color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.pub-foot{position:sticky;bottom:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:10px 14px;border:1px solid var(--qa-color-border);border-radius:12px;background:color-mix(in srgb,var(--qa-color-surface) 94%,transparent);backdrop-filter:blur(6px);box-shadow:0 -6px 20px -14px rgb(15 23 42 / .35);font-size:13px}
.pub-foot>span:not(.pub-foot-a){display:inline-flex;flex-wrap:wrap;gap:4px 14px;align-items:center}
.pub-foot-a{display:inline-flex;gap:6px;margin-left:auto}
.pub-sheet{width:min(640px,100vw)}
.pub-blocks{display:flex;flex-direction:column;gap:12px;margin:0;padding:0}
.pub-block{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--qa-color-border);border-radius:10px}
.pub-block.ko{border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border))}
.pub-block-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px}
.pub-deps{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}
.pub-dep{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px;font-size:12.5px;padding:6px 8px;border-radius:8px;background:var(--qa-color-surface-2)}
.pub-dep.warn{border-left:3px solid var(--qa-color-warning)}
.pub-dep.ok{border-left:3px solid var(--qa-color-success)}
.pub-dep-a{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.pub-provide{display:inline-flex;gap:4px;align-items:center}
.pub-provide input{min-height:28px;font:inherit;font-size:12.5px;padding:0 8px;border:1px solid var(--qa-color-border-strong);border-radius:6px;background:var(--qa-color-surface);color:var(--qa-color-text);width:160px}
.pub-more summary{cursor:pointer;font-size:12.5px;color:var(--qa-color-muted)}
.pub-sheet-f{position:sticky;bottom:-18px;background:var(--qa-color-surface);padding:10px 0 4px;border-top:1px solid var(--qa-color-border);align-items:center}
.pub-empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
@container (max-width:900px){
  .pub-layout{grid-template-columns:minmax(0,1fr)}
  .pub-side{position:static;max-height:none}
  .pub-io{grid-template-columns:minmax(0,1fr)}
}
.lib-sheet-bg{position:fixed;inset:0;background:color-mix(in srgb,var(--qa-color-text) 30%,transparent);z-index:40}
.lib-sheet{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);background:var(--qa-color-surface);border-left:1px solid var(--qa-color-border);z-index:41;padding:18px 20px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.lib-sheet p{margin:0}
.lib-sheet-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
.lib-sheet-h h2{margin:0;font-size:18px}
.lib-preview{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;background:var(--qa-color-surface-2);display:flex;flex-direction:column;gap:5px;font-size:13px}
.lib-drift{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid color-mix(in srgb,var(--qa-color-warning) 45%,var(--qa-color-border));background:var(--qa-color-warning-soft);border-radius:10px;font-size:13px}
.lib-drift > div{display:flex;flex-direction:column;gap:6px}
.lib-catalog .err,.lib-layout + .err{margin:0}
.small{font-size:12px}
@media (min-width:1100px){
  .lib-layout{grid-template-columns:minmax(0,1fr) minmax(340px,400px)}
  .lib-composer{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto}
  .lib-jump{display:none}
}
.rv-lib{flex-basis:100%}
.lib-insert{border-top:1px solid var(--qa-color-border);padding-top:12px}
details.tech summary{cursor:pointer;color:var(--qa-color-muted);font-size:13px}
details.tech[open] summary{margin-bottom:6px}

/* Responsive : 1 100 px, 960 px (menu replié), 600 px (une colonne). */
@container (max-width:600px){.correction-card dl.kv{grid-template-columns:minmax(0,1fr)}.rv-step{grid-template-columns:22px 26px minmax(0,1fr)}.rv-side{grid-column:3;justify-content:flex-start}.rv-group-h .row-acts{margin-left:0}}
@container (max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:960px){
  .dash{grid-template-columns:minmax(0,1fr);gap:12px}
  .side{padding:12px 14px;gap:12px}
  .menu-btn{display:inline-flex}
  .dash[data-menu="closed"] .drawer{display:none}
  .drawer{gap:16px}
  .foot{margin-top:0}
}
.tst-intro{margin:0;max-width:75ch}
.tst-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.tst-pick,.tst-env{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--qa-color-muted);min-width:0}
.tst-pick select{min-width:min(320px,100%)}
.tst-gen form{display:flex;flex-direction:column;gap:24px;margin:0}
.tst-gen form>.tst-go{padding-top:20px;border-top:1px solid var(--qa-color-border)}
.tst-gen .tst-confirm{margin-top:8px}
.tst-fmt .tst-go{padding-top:8px}
.tst-gen fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;min-width:0}
.tst-gen legend{padding:0;margin-bottom:8px;font-size:13px}
.tst-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.tst-check{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;cursor:pointer;min-width:0}
.tst-check:has(input:checked){border-color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 6%,var(--qa-color-surface))}
.tst-check input{margin-top:3px;flex:none}
.tst-check span{display:flex;flex-direction:column;gap:2px;min-width:0}
.tst-check small{color:var(--qa-color-muted)}
.tst-go{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:auto}
.tst-fmts{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.tst-fmt{border:1px solid var(--qa-color-border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;min-width:0;background:var(--qa-color-surface)}
.tst-fmt header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.tst-fmt h3{margin:0;font-size:15px;font-weight:650}
.tst-fmt p{margin:0}
.tst-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0;font-size:13px}
.tst-kv dt{color:var(--qa-color-muted)}
.tst-kv dd{margin:0;overflow-wrap:anywhere}
.tst-safety{display:flex;gap:6px;align-items:flex-start;font-size:13px;border-radius:8px;padding:8px 10px}
.tst-safety .ico{flex:none;width:16px;height:16px;margin-top:1px}
.tst-safety.ok{background:var(--qa-color-success-soft);color:var(--qa-color-text)}
.tst-safety.warn{background:var(--qa-color-warning-soft);color:var(--qa-color-text)}
.tst-last{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;color:var(--qa-color-muted)}
.tst-files,.tst-runs,.tst-cases,.tst-msgs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.tst-msgs{gap:4px;font-size:13px}
.tst-msgs li{padding-left:12px;border-left:2px solid var(--qa-color-border)}
.tst-msgs.warn li{border-left-color:var(--qa-color-warning)}
.tst-file,.tst-run{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.tst-file-h,.tst-run-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.tst-file-h code{overflow-wrap:anywhere;min-width:0}
.tst-file-h .lnk,.tst-run-h .lnk{margin-left:auto}
.tst-file-b,.tst-run-b{display:flex;flex-direction:column;gap:8px;min-width:0}
.tst-file-b p,.tst-run-b p{margin:0}
.tst-run-b h4{margin:4px 0 0;font-size:13px}
.tst-run-b>.btn{align-self:flex-start}
.tst-run[data-status="FAILED"],.tst-run[data-status="ERROR"]{border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border))}
.tst-cases li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.tst-case-n{overflow-wrap:anywhere;min-width:0}
.tst-case-m{flex-basis:100%;margin:0;font-size:13px;color:var(--qa-color-danger);overflow-wrap:anywhere}
.tst-code{margin:0;max-height:360px;overflow:auto;font-family:var(--qa-font-family-mono);font-size:12px;line-height:1.5;background:var(--qa-color-background);color:var(--qa-color-text);border:1px solid var(--qa-color-border);border-radius:8px;padding:10px 12px;white-space:pre}
.tst-editor{display:flex;flex-direction:column;gap:8px;min-width:0}
.tst-editor label{font-size:13px}
.tst-area{width:100%;box-sizing:border-box;resize:vertical;min-height:200px;white-space:pre;tab-size:2}
.tst-area:focus{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.tst-confirm{display:flex;flex-direction:column;gap:8px;border:1px solid var(--qa-color-warning);background:var(--qa-color-warning-soft);border-radius:10px;padding:10px 12px}
.tst-confirm p{margin:0}
.tst-pills{display:flex;flex-wrap:wrap;gap:6px}
.tst-file.edited{border-color:color-mix(in srgb,var(--qa-color-warning) 55%,var(--qa-color-border))}
.tst-out summary{cursor:pointer;font-size:13px;color:var(--qa-color-muted)}
.tst-out[open] summary{margin-bottom:6px}
/* ── Éditeur des tests générés ── */
/* L'espace de travail tient dans la fenêtre : chaque colonne défile en elle-même, la page ne s'allonge pas. */
.ed{display:flex;flex-direction:column;gap:10px;min-width:0;height:max(620px,calc(100dvh - 88px))}
.ed-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:12px;padding:10px 14px}
.ed-id{display:flex;flex-direction:column;gap:4px;min-width:0}
.ed-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;color:var(--qa-color-muted);min-width:0}
.ed-crumbs .lnk{min-height:24px;font-size:13px}
.ed-crumbs b{color:var(--qa-color-text);font-size:15px;overflow-wrap:anywhere}
.ed-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ed-fmt{font:600 11px/1 var(--qa-font-family-mono);letter-spacing:.04em;padding:4px 6px;border-radius:5px;border:1px solid var(--qa-color-border-strong);color:var(--qa-color-muted)}
.ed-chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;padding:3px 8px;border-radius:999px;border:1px solid var(--qa-color-border);color:var(--qa-color-muted);background:var(--qa-color-surface)}
.ed-chip .ico{width:13px;height:13px}
.ed-chip i{font-style:normal;font-size:10px}
.ed-chip.ok{color:color-mix(in srgb,var(--qa-color-success) 80%,var(--qa-color-text));border-color:color-mix(in srgb,var(--qa-color-success) 40%,var(--qa-color-border))}
.ed-chip.ko{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text));border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border));background:var(--qa-color-danger-soft)}
.ed-chip.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));border-color:color-mix(in srgb,var(--qa-color-warning) 45%,var(--qa-color-border));background:var(--qa-color-warning-soft)}
.ed-chip.live{color:var(--qa-color-primary);border-color:color-mix(in srgb,var(--qa-color-primary) 40%,var(--qa-color-border))}
.ed-chip.add{color:color-mix(in srgb,var(--qa-color-success) 80%,var(--qa-color-text))}
.ed-chip.del{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text))}
.ed-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
/* « Navigateur visible » : un interrupteur (la case couvre l'étiquette) et, coché, le ralenti. */
.vb{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.vb-tog{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 12px;border:1px solid var(--qa-color-border-strong);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font-size:13px;font-weight:500;cursor:pointer;user-select:none}
.vb-tog input{-webkit-appearance:none;appearance:none;position:absolute;inset:0;margin:0;border-radius:8px;cursor:pointer;background:none}
.vb-tog .ico{width:16px;height:16px;position:relative;pointer-events:none}
.vb-tog span{position:relative;pointer-events:none}
.vb-tog:hover:not(.off){border-color:var(--qa-color-primary)}
.vb-tog:has(input:checked){color:var(--qa-color-primary);border-color:color-mix(in srgb,var(--qa-color-primary) 55%,transparent);background:color-mix(in srgb,var(--qa-color-primary) 9%,var(--qa-color-surface));font-weight:600}
.vb-tog:has(input:focus-visible){outline:2px solid var(--qa-color-primary);outline-offset:2px}
.vb-tog.off{opacity:.55;cursor:not-allowed}
.vb-tog.off input{cursor:not-allowed}
.dash .vb-slow select{min-height:34px;font-size:13px}
.ed-actions .btn{min-height:34px;padding:0 12px;font-size:13px}
.ed-actions kbd{font:500 10px/1 var(--qa-font-family-mono);padding:3px 4px;border-radius:4px;background:color-mix(in srgb,currentColor 18%,transparent)}
.ed-note,.ed-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;border-radius:10px;padding:8px 12px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);font-size:13px}
.ed-note p,.ed-confirm p{margin:0;flex:1 1 240px}
.ed-note ul{margin:0;padding-left:18px;flex-basis:100%}
.ed-note.ok{border-color:color-mix(in srgb,var(--qa-color-success) 45%,var(--qa-color-border));background:var(--qa-color-success-soft)}
.ed-note.err{border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border));background:var(--qa-color-danger-soft)}
.ed-note.info{border-color:color-mix(in srgb,var(--qa-color-primary) 35%,var(--qa-color-border))}
.ed-confirm{border-color:var(--qa-color-warning);background:var(--qa-color-warning-soft)}
.ed-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ed-ib{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:6px;background:none;color:var(--qa-color-muted);cursor:pointer;flex:none}
.ed-ib:hover:not(:disabled){background:var(--qa-color-surface-2);color:var(--qa-color-text);border-color:var(--qa-color-border)}
.ed-ib:disabled{opacity:.35;cursor:default}
.ed-ib .ico{width:15px;height:15px}
.ed-body{display:grid;grid-template-columns:240px minmax(0,1fr) 300px;grid-template-rows:minmax(0,1fr);gap:10px;flex:1 1 0;min-height:420px;align-items:stretch}
.ed-body[data-con="open"]{grid-template-rows:minmax(200px,1fr) var(--con-h,44%)}
.ed-body[data-con="closed"]{grid-template-rows:minmax(0,1fr) auto}
.ed-body[data-con="max"]>:not(.ed-con){display:none}
.ed[data-explorer="closed"] .ed-body{grid-template-columns:minmax(0,1fr) 300px}
.ed[data-inspector="closed"] .ed-body{grid-template-columns:240px minmax(0,1fr)}
.ed[data-explorer="closed"][data-inspector="closed"] .ed-body{grid-template-columns:minmax(0,1fr)}
.ed-explorer,.ed-inspector,.ed-center{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:12px;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.ed-ph{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px 6px 12px;border-bottom:1px solid var(--qa-color-border)}
.ed-ph h2{margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ed-search{display:flex;align-items:center;gap:6px;margin:8px 10px;padding:0 8px;border:1px solid var(--qa-color-border);border-radius:8px;color:var(--qa-color-muted)}
.ed-search .ico{width:14px;height:14px;flex:none}
.ed-search input{border:0;outline:0;background:none;min-height:30px;font:inherit;font-size:13px;color:var(--qa-color-text);width:100%;min-width:0}
.ed-search:focus-within{border-color:var(--qa-color-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--qa-color-primary) 20%,transparent)}
.ed-tree{list-style:none;margin:0;padding:2px 6px 10px;overflow:auto;flex:1;font-size:13px}
.ed-ti>button{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:2px 6px 2px calc(6px + (var(--lv) - 1) * 12px);border:0;border-radius:6px;background:none;color:var(--qa-color-text);text-align:left;cursor:pointer;font:inherit;font-size:13px}
.ed-ti[aria-level="1"]>button{font-weight:600;color:var(--qa-color-muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.ed-ti>button:hover{background:var(--qa-color-surface-2)}
.ed-ti.cur>button{background:color-mix(in srgb,var(--qa-color-primary) 10%,transparent);color:var(--qa-color-text);font-weight:600}
.ed-ti>button:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ed-tl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ed-ft{font:600 9px/1 var(--qa-font-family-mono);padding:3px 4px;border-radius:4px;background:var(--qa-color-surface-2);color:var(--qa-color-muted);border:1px solid var(--qa-color-border);flex:none}
.ed-flag{display:inline-flex;align-items:center;font-size:11px;font-weight:600;color:var(--qa-color-muted);flex:none}
.ed-flag .ico{width:12px;height:12px}
.ed-flag.ko{color:var(--qa-color-danger)}
.ed-flag.warn{color:var(--qa-color-warning)}
.ed-empty{padding:12px;margin:0;font-size:13px}
.ed-explorer,.ed-inspector,.ed-center{min-height:0}
.ed-tabs{display:flex;gap:2px;padding:6px 6px 0;border-bottom:1px solid var(--qa-color-border);overflow-x:auto;flex:none}
.ed-tab{display:flex;align-items:center;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;background:var(--qa-color-surface-2);flex:none}
.ed-tab.on{background:var(--qa-color-surface);border-color:var(--qa-color-border);margin-bottom:-1px}
.ed-tab>button[role="tab"]{display:flex;align-items:center;gap:6px;border:0;background:none;padding:6px 4px 6px 10px;font:inherit;font-size:13px;color:var(--qa-color-muted);cursor:pointer;white-space:nowrap}
.ed-tab.on>button[role="tab"]{color:var(--qa-color-text);font-weight:600}
.ed-dot{font-style:normal;color:var(--qa-color-warning);font-size:10px}
.ed-viewbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 10px;border-bottom:1px solid var(--qa-color-border);flex:none}
.ed-seg{display:inline-flex;border:1px solid var(--qa-color-border-strong);border-radius:8px;overflow:hidden}
.ed-seg button{border:0;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;font-size:13px;padding:5px 12px;cursor:pointer;min-height:30px}
.ed-seg button+button{border-left:1px solid var(--qa-color-border-strong)}
.ed-seg button[aria-checked="true"]{background:var(--qa-color-primary);color:#fff;font-weight:600}
.ed-seg button:disabled{color:var(--qa-color-faint);cursor:not-allowed}
.ed-seg button:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ed-hint{font-size:12px;color:var(--qa-color-muted);flex:1;min-width:160px}
.ed-stage{flex:1 1 0;min-height:120px;display:flex;flex-direction:column;min-width:0;position:relative;overflow:hidden}
.ed-cm{flex:1 1 0;min-height:0;display:flex;flex-direction:column;min-width:0}
.ed-cm>.cm-editor{flex:1 1 0;min-height:0}
.ed-visual{padding:12px 14px;overflow:auto;flex:1 1 0;min-height:0;display:flex;flex-direction:column;gap:12px}
.ed-vh{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px}
.ed-vh h3{margin:0;font-size:16px}
.ed-group{border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.ed-group>header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;border-bottom:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);border-radius:10px 10px 0 0}
.ed-gh{display:inline-flex;align-items:center;gap:8px;border:0;background:none;font:inherit;font-size:13px;color:var(--qa-color-text);cursor:pointer;padding:2px 0;min-width:0}
.ed-gh .ico{width:14px;height:14px}
.ed-gd{margin:6px 10px 0;font-size:13px}
.ed-steps{list-style:none;margin:0;padding:4px;display:flex;flex-direction:column;gap:2px}
.ed-step{display:flex;align-items:center;gap:4px;border-radius:8px;padding:0 4px;min-width:0}
.ed-step:hover{background:var(--qa-color-surface-2)}
.ed-step.sel{background:color-mix(in srgb,var(--qa-color-primary) 9%,transparent);box-shadow:inset 3px 0 0 var(--qa-color-primary)}
.ed-grip{color:var(--qa-color-faint);cursor:grab;display:inline-flex}
.ed-grip .ico{width:14px;height:14px}
.ed-sm{display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;background:none;padding:7px 4px;font:inherit;font-size:13px;color:var(--qa-color-text);text-align:left;cursor:pointer;border-radius:6px}
.ed-sm:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ed-num{font:600 11px/1 var(--qa-font-family-mono);color:var(--qa-color-muted);min-width:22px;text-align:right}
.ed-act,.ed-kw{font:600 11px/1 var(--qa-font-family-mono);padding:3px 6px;border-radius:5px;background:color-mix(in srgb,var(--qa-color-primary) 9%,transparent);color:var(--qa-color-primary);flex:none}
.ed-kw{font-family:var(--qa-font-family);font-size:12px}
.ed-lab{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ed-dep{display:inline-flex;color:var(--qa-color-muted)}
.ed-dep .ico{width:13px;height:13px}
.ed-st{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;padding:2px 6px;border-radius:999px;flex:none;border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.ed-st .ico{width:11px;height:11px}
.ed-st.ok{color:color-mix(in srgb,var(--qa-color-success) 80%,var(--qa-color-text));background:var(--qa-color-success-soft);border-color:transparent}
.ed-st.ko{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text));background:var(--qa-color-danger-soft);border-color:transparent}
.ed-st.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft);border-color:transparent}
.ed-st.live{color:var(--qa-color-primary);border-color:color-mix(in srgb,var(--qa-color-primary) 45%,transparent);background:color-mix(in srgb,var(--qa-color-primary) 7%,transparent)}
.ed-tools{display:flex;gap:1px;opacity:.55}
.ed-step:hover .ed-tools,.ed-step.sel .ed-tools,.ed-step:focus-within .ed-tools{opacity:1}
.ed-help{margin:0;font-size:12px}
.ed-add{border-top:1px dashed var(--qa-color-border);padding:10px;display:flex;flex-direction:column;gap:8px}
.ed-add h4{margin:0;font-size:13px}
.ed-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.ed-fields label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qa-color-muted);min-width:0}
.ed-fields .wide{grid-column:1/-1}
.ed-fields input,.ed-fields select,.ed-f input,.ed-f select{font:inherit;font-size:13px;min-height:30px;border:1px solid var(--qa-color-border-strong);border-radius:6px;padding:0 8px;background:var(--qa-color-surface);color:var(--qa-color-text);min-width:0}
.ed-fields input:focus,.ed-f input:focus,.ed-f select:focus,.ed-fields select:focus{outline:2px solid var(--qa-color-primary);outline-offset:0;border-color:var(--qa-color-primary)}
.ed-compare{display:flex;flex-direction:column;flex:1;min-height:0}
.ed-ch{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;padding:8px 10px;border-bottom:1px solid var(--qa-color-border)}
.ed-ch label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qa-color-muted)}
.ed-ch select{font:inherit;font-size:13px;min-height:30px;border:1px solid var(--qa-color-border-strong);border-radius:6px;padding:0 8px;background:var(--qa-color-surface);color:var(--qa-color-text)}
.ed-sum{display:flex;align-items:center;gap:6px;font-size:12px}
.ed-ch .ed-row{margin-left:auto}
.ed-diff{flex:1 1 0;min-height:0;overflow:auto}
.ed-diff .cm-mergeView{min-height:100%}
.ed-diff .cm-mergeViewEditors{display:flex}
.ed-diff .cm-mergeViewEditor{flex:1;min-width:0}
.ed-panel{border-top:1px solid var(--qa-color-border);display:flex;flex-direction:column;max-height:240px;flex:none}
.ed-group .lnk{display:inline-flex;align-items:center;gap:4px;font-size:13px;min-height:28px}
.ed-group .lnk .ico{width:14px;height:14px}
.ed-ptabs{display:flex;gap:4px;padding:6px 8px 0;border-bottom:1px solid var(--qa-color-border)}
.ed-ptabs button{border:0;border-bottom:2px solid transparent;background:none;font:inherit;font-size:13px;padding:6px 8px;color:var(--qa-color-muted);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ed-ptabs button[aria-selected="true"]{color:var(--qa-color-text);border-bottom-color:var(--qa-color-primary);font-weight:600}
.ed-count{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border)}
.ed-pbody{overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:10px}
.ed-dcat h4,.ed-res h4{margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--qa-color-muted)}
.ed-res p{margin:4px 0}
/* La console : sous les colonnes, sur toute la largeur, à la hauteur choisie avec sa poignée (ou tout l'espace, agrandie). */
.ed-panel.ed-con{grid-column:1/-1;position:relative;min-height:0;max-height:none;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface)}
.ed-con.sizing{user-select:none}
.ed-con-split{position:absolute;top:-10px;left:0;right:0;height:10px;cursor:row-resize;touch-action:none;z-index:2}
.ed-con-split::after{content:"";position:absolute;top:3px;left:50%;width:40px;height:4px;border-radius:2px;background:var(--qa-color-border-strong);transform:translateX(-50%)}
.ed-con-split:hover::after,.ed-con.sizing .ed-con-split::after{background:var(--qa-color-primary);width:64px}
.ed-con-split:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ed-con .ed-pbody{flex:1;min-height:0;position:relative;gap:6px;padding:6px 10px 8px}
.ed-con .ed-pbody:has(> .ed-log-frame){overflow:hidden}
.ed-con-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px;flex:none}
.ed-con-dl{display:inline-flex;align-items:center;height:28px;padding-left:6px;margin:0 2px;border:1px solid var(--qa-color-border);border-radius:6px;color:var(--qa-color-muted);overflow:hidden}
.ed-con-dl .ico{width:14px;height:14px;margin-right:2px}
.ed-con-dl button{border:0;border-left:1px solid var(--qa-color-border);background:none;font:inherit;font-size:11.5px;font-weight:600;padding:0 8px;height:100%;cursor:pointer;color:var(--qa-color-text)}
.ed-con-dl button:hover:not(:disabled){background:var(--qa-color-surface-2)}
.ed-con-dl button:disabled{opacity:.4;cursor:default}
.ed-con-dl button:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ed-con-more{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:12px;padding:6px 8px;border:1px dashed var(--qa-color-border-strong);border-radius:8px}
/* Les niveaux : des pastilles (un point plein quand le niveau est affiché, jamais la couleur seule : le mot reste). */
.ed-lvl{--lv:var(--qa-color-primary);display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:0 9px 0 7px;border-radius:999px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);color:var(--qa-color-muted);font-size:12px;cursor:pointer;user-select:none}
.ed-lvl.lv-DEBUG{--lv:var(--qa-color-faint)}
.ed-lvl.lv-WARN{--lv:var(--qa-color-warning)}
.ed-lvl.lv-ERROR{--lv:var(--qa-color-danger)}
.ed-lvl input{-webkit-appearance:none;appearance:none;margin:0;width:10px;height:10px;border-radius:50%;border:1.5px solid var(--lv);background:transparent;cursor:pointer;flex:none}
.ed-lvl input:checked{background:var(--lv)}
.ed-lvl:has(input:checked){color:var(--qa-color-text);font-weight:500;border-color:color-mix(in srgb,var(--lv) 45%,var(--qa-color-border));background:color-mix(in srgb,var(--lv) 9%,var(--qa-color-surface))}
.ed-lvl:hover{border-color:color-mix(in srgb,var(--lv) 60%,var(--qa-color-border))}
.ed-lvl:has(input:focus-visible){outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ed-tog{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid transparent;color:var(--qa-color-muted);flex:none}
.ed-tog input{-webkit-appearance:none;appearance:none;position:absolute;inset:0;margin:0;border-radius:6px;cursor:pointer;background:none}
.ed-tog .ico{width:15px;height:15px;position:relative;pointer-events:none}
.ed-tog:hover{background:var(--qa-color-surface-2);color:var(--qa-color-text)}
.ed-tog:has(input:checked),.ed-con-tools .ed-ib[aria-pressed="true"],.ed-con-head .ed-ib[aria-pressed="true"]{color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 10%,transparent);border-color:color-mix(in srgb,var(--qa-color-primary) 30%,transparent)}
.ed-tog:has(input:focus-visible){outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ed-con .ed-ptabs{justify-content:space-between;align-items:flex-end;flex-wrap:wrap;row-gap:4px}
.ed-ptabs [role="tablist"]{display:flex;gap:2px;flex-wrap:wrap}
.ed-con-head{display:flex;align-items:center;gap:8px;padding-bottom:4px;min-width:0}
.ed-con-head .ed-ib{width:30px;height:30px}
.ed-con-now{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;color:var(--qa-color-primary)}
.ed-con-now .ico{width:12px;height:12px}
.ed-con-run select,.ed-con-f select,.ed-con-f input{font:inherit;font-size:12px;min-height:28px;padding:0 6px;border:1px solid var(--qa-color-border-strong);border-radius:6px;background:var(--qa-color-surface);color:var(--qa-color-text);max-width:100%}
.ed-con-run select{max-width:360px}
.btn.btn-s{min-height:30px;padding:0 10px;font-size:12px;border-radius:7px;gap:6px}
.btn.btn-s .ico{width:14px;height:14px}
.ed-con-tools{display:flex;flex-wrap:wrap;gap:2px;align-items:center}
.ed-con-tools>.btn-s{margin-right:4px}
.ed-con-sep{width:1px;height:20px;background:var(--qa-color-border)}
.ed-chk{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:var(--qa-color-text)}
.ed-chk input{margin:0;accent-color:var(--qa-color-primary)}
.ed-con-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;flex:1 1 440px;min-width:0}
.ed-con-levels{display:inline-flex;flex-wrap:wrap;gap:4px}
.ed-con-crit .ed-count{padding:0 5px;font-size:10px}
.ed-con-f{display:inline-flex;align-items:center;gap:4px;color:var(--qa-color-muted)}
.ed-con-search{flex:1 1 140px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--qa-color-border-strong);border-radius:7px;padding:0 8px;background:var(--qa-color-surface);min-height:28px;min-width:120px}
.ed-con-search:focus-within{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ed-con-search input{flex:1;min-width:0;border:0;background:none;font:inherit;font-size:12px;color:var(--qa-color-text);outline:none;min-height:26px}
.ed-con-search .ico{width:14px;height:14px;color:var(--qa-color-muted)}
/* Le journal et, sous lui, sa barre d'état (le flux, ce qui est conservé, ce qui est affiché). */
.ed-log-frame{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--qa-color-panel);border-radius:8px;overflow:hidden}
.ed-con-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 10px;padding:3px 10px;min-height:26px;border-top:1px solid rgb(255 255 255 / .1);flex:none}
.ed-con-state{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:2px 12px;font-size:11.5px;color:#A3A1D8;min-width:0}
.ed-con-state .lnk{min-height:22px;font-size:11.5px;color:#C7D2FE}
.ed-con-state .err{color:#FCA5A5}
.ed-con-state .warn{color:#FCD34D}
.ed-con-conn{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#E8E7FD}
.ed-con-conn::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--qa-color-faint)}
.ed-con-conn.cn-live::before{background:var(--qa-color-success)}
.ed-con-conn.cn-connecting::before,.ed-con-conn.cn-reconnecting::before{background:var(--qa-color-warning)}
.ed-con-conn.cn-interrupted::before{background:var(--qa-color-danger)}
.ed-log-host{flex:1;min-height:0;display:flex}
.ed-log-wrap{container-type:inline-size;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.ed-log-older{margin:0;padding:4px 12px;font-size:12px;color:#C9C7F2;border-bottom:1px solid rgb(255 255 255 / .1)}
.ed-log-older .lnk{color:#C7D2FE;min-height:24px;font-size:12px}
.ed-log{list-style:none;margin:0;padding:4px 0;font:12px/1.6 var(--qa-font-family-mono);color:#E8E7FD}
.ed-log-wrap .ed-log{flex:1;min-height:0;overflow:auto}
.ed-log-static{background:var(--qa-color-panel);border-radius:8px;max-height:100%;overflow:auto}
.ed-log:focus-visible{outline:2px solid #A5B4FC;outline-offset:-2px}
.ev{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 10px;padding:1px 12px 1px 9px;border-left:3px solid transparent}
.ev:hover{background:rgb(255 255 255 / .05)}
.ev.sel{background:rgb(165 180 252 / .16)}
.ev.lv-WARN{border-left-color:#FBBF24}
.ev.lv-ERROR{border-left-color:#F87171;background:rgb(248 113 113 / .09)}
.ev.lv-DEBUG{color:#B4B2DE}
.ev-main{display:inline-flex;align-items:baseline;gap:10px;border:0;background:none;color:inherit;font:inherit;padding:0;cursor:pointer;text-align:left}
.ev-main:focus-visible,.ev-at:focus-visible{outline:2px solid #A5B4FC;outline-offset:1px;border-radius:3px}
.ev time{color:#A3A1D8;font-variant-numeric:tabular-nums}
.ev-lv{min-width:5ch;font-weight:600}
.lv-INFO .ev-lv{color:#93C5FD}
.lv-WARN .ev-lv{color:#FCD34D}
.lv-ERROR .ev-lv{color:#FCA5A5}
.lv-DEBUG .ev-lv{color:#A3A1D8}
.ev-cat{color:#C4B5FD;min-width:10ch}
.ev-type{color:#A3A1D8}
.ev-msg{flex:1 1 32ch;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.ev-dur{color:#A3A1D8}
.ev-at{border:0;background:rgb(255 255 255 / .1);color:#C7D2FE;font:inherit;font-size:11px;border-radius:4px;padding:0 6px;cursor:pointer;white-space:nowrap}
.ev-st{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;border-radius:4px;padding:0 6px;white-space:nowrap;border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.ev-st .ico{width:11px;height:11px}
.ev-st.st-CONFIRMED,.ev-st.st-PASSED{color:color-mix(in srgb,var(--qa-color-success) 80%,var(--qa-color-text));background:var(--qa-color-success-soft);border-color:transparent}
.ev-st.st-FAILED{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text));background:var(--qa-color-danger-soft);border-color:transparent}
.ev-st.st-BLOCKED,.ev-st.st-UNFINISHED{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft);border-color:transparent}
.ev-st.st-RUNNING{color:var(--qa-color-primary);border-color:color-mix(in srgb,var(--qa-color-primary) 40%,transparent)}
.ed-log .ev-st{border-color:rgb(255 255 255 / .18);background:none;color:#C9C7F2}
.ed-log .ev-st.st-CONFIRMED{color:#6EE7B7;border-color:rgb(110 231 183 / .4)}
.ed-log .ev-st.st-EXECUTED{color:#93C5FD;border-color:rgb(147 197 253 / .4)}
.ed-log .ev-st.st-FAILED{color:#FCA5A5;border-color:rgb(252 165 165 / .5)}
.ed-log .ev-st.st-BLOCKED,.ed-log .ev-st.st-UNFINISHED{color:#FCD34D;border-color:rgb(252 211 77 / .45)}
.ed-log .ev-st.st-RUNNING{color:#C4B5FD;border-color:rgb(196 181 253 / .45)}
.ev-detail{flex-basis:100%;margin:4px 0 8px;padding:8px 12px;border-radius:6px;background:var(--qa-color-surface-2);color:var(--qa-color-text);font:13px/1.5 var(--qa-font-family);display:flex;flex-direction:column;gap:6px}
.ed-log .ev-detail{background:rgb(255 255 255 / .07);color:#E8E7FD}
.ed-log .ev-detail .lnk{color:#C7D2FE}
.ed-log .ev-detail dt{color:#A3A1D8}
.ev-full{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ev-hint{margin:0;display:flex;gap:6px;align-items:flex-start;color:inherit;opacity:.9}
.ev-hint .ico{width:14px;height:14px;flex:none;margin-top:3px}
.ev-detail .ed-dl{margin:0}
.ev-kind{display:inline-flex;align-items:center;gap:5px;font-weight:600;color:var(--qa-color-danger)}
.ev-kind .ico{width:14px;height:14px}
.ev-err{font-size:11px;color:var(--qa-color-danger);font-weight:600}
.ed-con-new{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:999px;padding:2px 10px;background:var(--qa-color-primary);color:#fff;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;flex:none}
.ed-con-new .ico{width:13px;height:13px}
.ed-con-new:focus-visible{outline:2px solid #fff;outline-offset:-4px}
.ed-con-table{width:100%;border-collapse:collapse;font-size:12px}
.ed-con-table th{text-align:left;font-weight:600;color:var(--qa-color-muted);padding:4px 8px;border-bottom:1px solid var(--qa-color-border)}
.ed-con-table td{padding:4px 8px;border-bottom:1px solid var(--qa-color-border);vertical-align:top}
.ed-con-table tr.ko td{background:var(--qa-color-danger-soft)}
.ed-con-table tr[aria-current="step"] td{background:color-mix(in srgb,var(--qa-color-primary) 9%,transparent)}
.ed-con-table .ev-at{background:var(--qa-color-surface-2);color:var(--qa-color-primary);border:1px solid var(--qa-color-border)}
.ed-con-errors{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.ed-con-errors>li{border:1px solid var(--qa-color-border);border-left:3px solid var(--qa-color-danger);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.ed-con-errors .ev-at,.ed-con-stats+p .ev-at{background:var(--qa-color-surface-2);color:var(--qa-color-primary);border:1px solid var(--qa-color-border)}
.ed-con-errors time{font:12px var(--qa-font-family-mono);color:var(--qa-color-muted)}
@container (max-width:820px){.ev-type{display:none}.ev-cat{min-width:0}}
@container (max-width:520px){.ev-cat{display:none}}
.ed-con-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:0}
.ed-con-stat{border:1px solid var(--qa-color-border);border-radius:8px;padding:6px 10px;background:var(--qa-color-surface)}
.ed-con-stat dt{font-size:11px;color:var(--qa-color-muted);text-transform:uppercase;letter-spacing:.04em}
.ed-con-stat dd{margin:0;font-weight:600}
.ed-dlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ed-dlist button{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;width:100%;border:0;border-left:3px solid var(--qa-color-border);background:none;padding:5px 8px;font:inherit;font-size:13px;color:var(--qa-color-text);text-align:left;cursor:pointer;border-radius:0 6px 6px 0}
.ed-dlist button:hover{background:var(--qa-color-surface-2)}
.ed-dlist button:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ed-dlist li.error button{border-left-color:var(--qa-color-danger)}
.ed-dlist li.warning button{border-left-color:var(--qa-color-warning)}
.ed-dlist li.info button{border-left-color:var(--qa-color-primary)}
.ed-sev{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;flex:none}
.ed-sev .ico{width:13px;height:13px}
li.error .ed-sev{color:var(--qa-color-danger)}
li.warning .ed-sev{color:color-mix(in srgb,var(--qa-color-warning) 80%,var(--qa-color-text))}
li.info .ed-sev{color:var(--qa-color-primary)}
.ed-msg{flex:1 1 260px;min-width:0;overflow-wrap:anywhere}
.ed-where{font-size:12px;color:var(--qa-color-muted)}
.ed-inspector{max-height:calc(100vh - 160px)}
.ed-ib-body{overflow:auto;padding:4px 12px 12px;display:flex;flex-direction:column;gap:6px}
.ed-ih h3{margin:8px 0 2px;font-size:15px}
.ed-ih p{margin:0;font-size:13px;overflow-wrap:anywhere}
.ed-inspector details{border-top:1px solid var(--qa-color-border);padding:8px 0}
.ed-inspector summary{cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--qa-color-muted);list-style-position:outside}
.ed-inspector summary:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ed-f{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qa-color-muted);margin-top:8px;min-width:0}
.ed-f output{font-size:13px;color:var(--qa-color-text)}
.ed-f input[type="checkbox"]{min-height:auto;width:16px;height:16px;align-self:flex-start}
.ed-inline{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:end}
.ed-allow{border:0;margin:8px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px}
.ed-allow legend{font-size:12px;color:var(--qa-color-muted);padding:0;margin-bottom:4px}
.ed-allow label{display:inline-flex;align-items:center;gap:4px}
.ed-allow small{flex-basis:100%}
.ed-keys{margin:6px 0 0;padding-left:18px;font-size:13px}
.ed-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:8px 0 0;font-size:13px}
.ed-dl dt{color:var(--qa-color-muted)}
.ed-dl dd{margin:0;min-width:0}
.ed-wrap{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
@container (max-width:1240px){
  .ed-body,.ed[data-explorer="closed"] .ed-body{grid-template-columns:220px minmax(0,1fr)}
  .ed[data-explorer="closed"] .ed-body{grid-template-columns:minmax(0,1fr)}
  /* Plus étroit : la page défile ; le code, puis la console, puis l'inspecteur. */
  .ed{height:auto}
  .ed-body,.ed-body[data-con]{flex:none;min-height:0;grid-template-rows:none}
  .ed-center,.ed-explorer{height:clamp(380px,calc(100dvh - 380px),900px)}
  .ed-con{order:1;height:var(--con-h,360px)}
  .ed-con.closed{height:auto}
  .ed-body[data-con="max"] .ed-con{height:calc(100dvh - 190px)}
  .ed-inspector{grid-column:1/-1;max-height:none;order:2}
}
@container (max-width:820px){
  .ed-body,.ed[data-explorer="closed"] .ed-body,.ed[data-inspector="closed"] .ed-body{grid-template-columns:minmax(0,1fr)}
  .ed-explorer{max-height:260px}
  .ed-actions{width:100%}
  .ed-actions .btn{flex:1 1 auto}
  .ed-actions kbd{display:none}
  .ed-tools{opacity:1}
  .ed-hint{flex-basis:100%}
  .ed-diff .cm-mergeViewEditors{min-width:640px}
}
@container (max-width:560px){
  .ed-con-head{width:100%;justify-content:flex-end}
  .ed-con-run{flex:1;min-width:0}
  .ed-con-run select{max-width:100%;width:100%}
  /* Sur un téléphone : la console prend la hauteur de l'écran, la barre se resserre. */
  .ed-body .ed-con{height:var(--con-h,min(640px,82dvh))}
  .ed-lvl{min-height:24px;padding:0 7px 0 6px;font-size:11px;gap:4px}
  .ed-con-crit>span:not(.ed-count){display:none}
  .ed-con-search{flex-basis:100%;order:-1}
  .ed-con-tools{width:100%}
  .ed-con-tools>.btn-s{margin-right:auto}
  .ed-con-dl{padding-left:0}
  .ed-con-dl .ico{display:none}
  .ed-con-dl button:first-of-type{border-left:0}
  .ev-cat,.ev-type{display:none}
  .ed-step{flex-wrap:wrap;padding-bottom:4px}
  .ed-sm{flex-wrap:wrap;flex-basis:calc(100% - 24px)}
  .ed-sm .ed-lab{order:9;flex:1 1 100%;white-space:normal;overflow:visible}
  .ed-tools{margin-left:auto}
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
