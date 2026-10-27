import { darkThemeCss } from './theme.js';

/**
 * LE STYLE DU DASHBOARD, enfermé dans le Shadow DOM : le langage de l'assistant (proposition B) —
 * fond clair, cartes blanches arrondies, accent violet, panneau de navigation sombre. Mêmes variables
 * publiques `--qa-*` que les autres composants : l'hôte les habille d'un seul jeu de valeurs.
 */
export const DASHBOARD_CSS = `
:host{
  --qa-color-primary:#5B5BF6;--qa-color-primary-2:#7C4DFF;
  --qa-color-background:#F5F6FB;
  --qa-color-surface:#FFFFFF;--qa-color-surface-2:#F7F8FC;
  --qa-color-text:#141833;--qa-color-muted:#5F6680;--qa-color-faint:#9AA0B8;
  --qa-color-border:#E6E8F2;--qa-color-border-strong:#D5D9E8;
  --qa-color-panel:#171A45;--qa-color-panel-2:#2A2370;
  --qa-color-success:#0FA88B;--qa-color-success-soft:#E3F7F2;
  --qa-color-warning:#C77700;--qa-color-warning-soft:#FFF4DF;
  --qa-color-danger:#E5484D;--qa-color-danger-soft:#FDECEC;
  --qa-radius:18px;
  --qa-font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --qa-font-family-heading:"Plus Jakarta Sans",Inter,ui-sans-serif,system-ui,sans-serif;
  --qa-font-family-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:block;color:var(--qa-color-text);font:14px/1.5 var(--qa-font-family);-webkit-font-smoothing:antialiased;container-type:inline-size;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,select,input{font:inherit;color:inherit}
code{font-family:var(--qa-font-family-mono);font-size:.86em;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:6px;padding:0 5px;overflow-wrap:anywhere}
.mu{color:var(--qa-color-muted)}
.err{color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text));margin:0}
:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}
.ico{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.dash{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:640px;background:var(--qa-color-background);border-radius:var(--qa-radius);overflow:hidden;border:1px solid var(--qa-color-border)}
.side{background:radial-gradient(320px 240px at 0% 0%,rgba(124,77,255,.45),rgba(124,77,255,0) 70%),linear-gradient(170deg,var(--qa-color-panel),var(--qa-color-panel-2));color:#E9EAFB;padding:22px 14px;display:flex;flex-direction:column;gap:6px}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px 18px}
.brand b{display:block;font:800 15px/1.2 var(--qa-font-family-heading);letter-spacing:.01em;color:#fff}
.brand small{color:#B9BCEB;font-size:12px}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--qa-color-primary),var(--qa-color-primary-2));display:grid;place-items:center;box-shadow:0 6px 16px rgba(91,91,246,.35);flex:none}
.logo i{width:11px;height:11px;border:2.6px solid #fff;border-radius:50%}
.side a{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;color:#C9CBEF;text-decoration:none;font-weight:600;min-height:44px}
.side a:hover{background:rgba(255,255,255,.06);color:#fff}
.side a[aria-current="page"]{background:rgba(255,255,255,.12);color:#fff;box-shadow:inset 3px 0 0 #A99BFF}
.main{min-width:0;padding:24px 28px 32px;display:flex;flex-direction:column;gap:18px}
.hd{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hd h1{margin:0;font:800 24px/1.2 var(--qa-font-family-heading);letter-spacing:-.01em;display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.hd .sp{flex:1}
.acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.notice{margin:0;padding:10px 14px;border-radius:12px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border)}
.btn{min-height:40px;border-radius:12px;padding:0 16px;display:inline-flex;align-items:center;gap:8px;font-weight:600;border:1.5px solid var(--qa-color-border-strong);background:var(--qa-color-surface);cursor:pointer}
.btn:hover{border-color:var(--qa-color-primary)}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.btn.primary{border:0;background:linear-gradient(135deg,var(--qa-color-primary),var(--qa-color-primary-2));color:#fff;box-shadow:0 10px 22px -10px rgba(91,91,246,.6)}
.btn.danger{border-color:color-mix(in srgb,var(--qa-color-danger) 55%,transparent);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.btn.ghost{border-color:transparent;background:transparent;color:var(--qa-color-muted)}
.lnk{border:0;background:none;padding:0;color:var(--qa-color-primary);font-weight:600;cursor:pointer;text-align:left}
.lnk:hover{text-decoration:underline}
.pick{display:inline-flex;align-items:center;gap:8px;color:var(--qa-color-muted);font-size:13px}
.pick select{height:38px;padding:0 10px;border:1.5px solid var(--qa-color-border-strong);border-radius:10px;background:var(--qa-color-surface);color:var(--qa-color-text);max-width:100%}
.chk{display:inline-flex;align-items:center;gap:8px;min-height:32px}
.chk input{width:18px;height:18px;accent-color:var(--qa-color-primary)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.kpi{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:16px 18px;display:flex;flex-direction:column;gap:4px;min-width:0}
.kpi>span{font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:var(--qa-color-muted)}
.kpi .big{font:800 30px/1.15 var(--qa-font-family-heading);letter-spacing:-.02em}
.kpi .mid{font:800 20px/1.25 var(--qa-font-family-heading)}
.kpi small{color:var(--qa-color-muted);font-size:12.5px}
.kpi.accent{background:linear-gradient(180deg,color-mix(in srgb,var(--qa-color-primary) 7%,var(--qa-color-surface)),var(--qa-color-surface));border-color:color-mix(in srgb,var(--qa-color-primary) 30%,var(--qa-color-border))}
.kpi .scope{margin:6px 0 0;padding:0 0 0 16px;line-height:1.4;font-size:12.5px;color:var(--qa-color-muted)}
.kpi ul.scope li+li{margin-top:2px}
.card h2.fl{text-transform:none;letter-spacing:0;font-size:16px;color:var(--qa-color-text)}
.hd h1 code{font-size:14px;font-weight:500}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.card{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:16px 18px;display:flex;flex-direction:column;gap:10px;min-width:0}
.card h2{margin:0;font-size:12.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.card h3{margin:6px 0 0;font-size:14px}
.msg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 24px;text-align:center;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius)}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--qa-color-border);border-top-color:var(--qa-color-primary);animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin,.dot{animation:none!important}}
.bars{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:6px;overflow-x:auto}
.bar{flex:1 0 18px;height:100%;display:flex;flex-direction:column-reverse;align-items:stretch;gap:2px;position:relative;padding-bottom:18px}
.bar span{display:block;border-radius:4px 4px 0 0;min-height:0}
.bar .p{background:var(--qa-color-success)}
.bar .f{background:var(--qa-color-danger)}
.bar small{position:absolute;bottom:0;left:50%;transform:translateX(-50%);font-size:10.5px;color:var(--qa-color-muted);white-space:nowrap}
.legend{margin:0;display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--qa-color-muted)}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.legend i.p{background:var(--qa-color-success)}.legend i.f{background:var(--qa-color-danger);margin-left:10px}
.alerts,.plain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.alerts li{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;background:var(--qa-color-danger-soft)}
.alerts .ico{color:var(--qa-color-danger);margin-top:2px}
.alerts span{flex:1;min-width:0}
.tw{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th,.tbl td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--qa-color-border);vertical-align:middle}
.tbl thead th{font-size:12px;color:var(--qa-color-muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap;border:1px solid currentColor}
.pill.ok{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));background:var(--qa-color-success-soft);border-color:transparent}
.pill.ko{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));background:var(--qa-color-danger-soft);border-color:transparent}
.pill.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft);border-color:transparent}
.pill.live{color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));border-color:transparent}
.pill.mu{color:var(--qa-color-muted)}
.cards{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.pcard{width:100%;text-align:left;cursor:pointer;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:16px 18px;display:flex;flex-direction:column;gap:6px;min-height:44px}
.pcard:hover{border-color:var(--qa-color-primary);box-shadow:0 10px 24px -14px rgba(91,91,246,.45)}
.pt{display:flex;align-items:center;gap:8px;justify-content:space-between}
.pt b{font:700 16px/1.3 var(--qa-font-family-heading);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.url{overflow-wrap:anywhere;margin:0}
.last{font-size:13px}
.launch{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.launch fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.launch legend{font-size:13px;color:var(--qa-color-muted);margin-bottom:4px}
.note{margin:0;padding:10px 12px;border-radius:12px;background:var(--qa-color-warning-soft)}
.confirm{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:12px;background:var(--qa-color-danger-soft)}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.steps li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:7px 0;border-top:1px solid var(--qa-color-border)}
.steps li:first-child{border-top:0}
.steps li span{overflow-wrap:anywhere}
.steps .why{grid-column:2 / -1;color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text))}
.live h2 .dot{width:8px;height:8px;border-radius:50%;background:var(--qa-color-primary);box-shadow:0 0 0 4px color-mix(in srgb,var(--qa-color-primary) 22%,transparent);animation:pl 1.4s ease-in-out infinite}
@keyframes pl{50%{opacity:.35}}
.wide{grid-column:1 / -1}
@container (max-width:980px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:minmax(0,1fr)}}
@container (max-width:720px){
  .dash{grid-template-columns:minmax(0,1fr)}
  .side{flex-direction:row;align-items:center;flex-wrap:wrap;padding:10px 12px}
  .brand{padding:0 8px 0 0}
  .main{padding:16px}
  .kpis{grid-template-columns:minmax(0,1fr)}
}
${darkThemeCss([
  ['.side a', 'color:#C9CBEF'],
  ['.pill.ok,.pill.ko,.pill.warn', 'border-color:transparent'],
])}`;
