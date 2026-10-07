/**
 * LA FENÊTRE « QA-CRAWLER Recorder » : une page autonome (aucune dépendance, aucun réseau), rendue
 * dans un contexte de navigateur SÉPARÉ de l'application enregistrée (jamais capturée, jamais
 * observée). Node lui envoie l'état (window.__qaPanelRender) ; elle renvoie des commandes
 * (window.__qaPanelCommand). Elle n'enregistre rien elle-même et ne décide de rien.
 *
 * Disposition : en-tête (marque, mode développeur) · barre d'état (enregistrement, durée, actions,
 * Pause / Reprendre / Arrêter / Annuler) · onglets Enregistrement / Analyse / Aperçu · trois colonnes
 * (parcours enregistré · aperçu de l'application avec l'élément surligné · détails de l'action) ·
 * barre de résumé (chiffres, Rejouer le parcours, Sauvegarder le flow).
 *
 * Accessible : vrais boutons, aria-label, focus visible, onglets clavier, statuts dits en texte
 * (jamais par la couleur seule), annonces aria-live. Responsive : trois colonnes sur un grand écran,
 * deux puis une sur une fenêtre plus étroite (l'aperçu passe alors dans son onglet).
 */
export function recorderPanelHtml(language: 'fr' | 'en', mode: 'main' | 'preview' = 'main'): string {
  // LA FENÊTRE DÉTACHÉE : l'aperçu seul, plein écran possible ; la fenêtre principale garde le reste.
  if (mode === 'preview')
    return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER Recorder — ${language === 'fr' ? 'Aperçu' : 'Preview'}</title>
<style>${CSS}</style>
</head>
<body data-mode="preview">
<header class="topbar">
  <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 3.5v17l16-8.5z" fill="currentColor"/></svg></span>
  <span class="brand">QA-CRAWLER</span>
  <span class="subtitle" id="subtitle"></span>
  <span class="state small" id="state" aria-live="polite"></span>
  <span class="spacer"></span>
  <span class="actions-top" id="detached-actions"></span>
</header>
<main class="detached-main"><section class="card preview detached" id="preview-detached" aria-live="polite"></section></main>
<div id="live" class="sr-only" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER Recorder</title>
<style>${CSS}</style>
</head>
<body data-mode="main">
<header class="topbar">
  <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 3.5v17l16-8.5z" fill="currentColor"/></svg></span>
  <span class="brand">QA-CRAWLER</span>
  <span class="subtitle" id="subtitle"></span>
  <span class="spacer"></span>
  <button type="button" class="devtoggle" id="devtoggle" aria-pressed="false"></button>
</header>
<section class="statusbar" id="head" aria-label="">
  <h1 id="state" class="state" aria-live="polite"></h1>
  <span class="live" id="livepill"></span>
  <span class="sep" aria-hidden="true"></span>
  <span class="timer" id="timer" aria-label=""></span>
  <span class="count" id="count"></span>
  <span class="spacer"></span>
  <div class="controls" id="controls" role="toolbar"></div>
</section>
<div class="progress" id="progress" hidden><div class="bar"><span></span></div><p></p></div>
<nav class="tabs" role="tablist" aria-label="">
  <button role="tab" id="tab-recording" aria-controls="panel-recording" aria-selected="true"></button>
  <button role="tab" id="tab-analysis" aria-controls="panel-analysis" aria-selected="false" tabindex="-1"></button>
  <button role="tab" id="tab-preview" aria-controls="panel-preview" aria-selected="false" tabindex="-1"></button>
</nav>
<main>
  <section id="panel-recording" role="tabpanel" aria-labelledby="tab-recording">
    <div id="review"></div>
    <div id="detached-note"></div>
    <div class="grid" id="grid">
      <div class="col-left">
        <section class="card journey" aria-labelledby="timeline-title">
          <header class="card-head"><h2 id="timeline-title"></h2><span class="badge" id="journey-count"></span></header>
          <p class="status-line" id="summary" role="status"></p>
          <ol id="timeline" class="timeline"></ol>
          <div id="checks"></div>
        </section>
        <section class="card quality" id="quality"></section>
      </div>
      <section class="card preview col-mid" id="preview-card"></section>
      <aside class="card details col-right" id="details" aria-live="polite"></aside>
    </div>
  </section>
  <section id="panel-analysis" role="tabpanel" aria-labelledby="tab-analysis" hidden></section>
  <section id="panel-preview" role="tabpanel" aria-labelledby="tab-preview" hidden><div class="card preview" id="preview-full"></div></section>
</main>
<footer class="summarybar" id="summarybar"></footer>
<div id="live" class="sr-only" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root{
  --bg:#f5f7fb;--surface:#ffffff;--surface-2:#f8fafc;--fg:#0f172a;--muted:#64748b;--line:#e6e9ef;--line-strong:#d5dae3;
  --accent:#2563eb;--accent-soft:#eff4ff;--accent-fg:#ffffff;
  --ok:#16a34a;--ok-soft:#ecfdf3;--warn:#d97706;--warn-soft:#fff7e6;--bad:#dc2626;--bad-soft:#fef2f2;--run:#2563eb;--run-soft:#eff4ff;--idle:#94a3b8;--idle-soft:#f1f5f9;
  --violet:#7c3aed;--violet-soft:#f3efff;--teal:#0d9488;--teal-soft:#e9fbf8;--orange:#ea580c;--orange-soft:#fff3eb;--pink:#db2777;--pink-soft:#fdf0f7;
  --radius:12px;--shadow:0 1px 2px rgba(15,23,42,.04),0 2px 10px rgba(15,23,42,.05);--focus:#2563eb;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0b0f17;--surface:#121826;--surface-2:#161e2e;--fg:#e5e9f0;--muted:#94a3b8;--line:#222b3b;--line-strong:#2d384b;
  --accent:#60a5fa;--accent-soft:rgba(96,165,250,.14);--accent-fg:#0b0f17;
  --ok:#4ade80;--ok-soft:rgba(74,222,128,.12);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.12);--bad:#f87171;--bad-soft:rgba(248,113,113,.12);--run:#60a5fa;--run-soft:rgba(96,165,250,.12);--idle:#64748b;--idle-soft:rgba(100,116,139,.14);
  --violet:#a78bfa;--violet-soft:rgba(167,139,250,.14);--teal:#2dd4bf;--teal-soft:rgba(45,212,191,.12);--orange:#fb923c;--orange-soft:rgba(251,146,60,.12);--pink:#f472b6;--pink-soft:rgba(244,114,182,.12);
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.25);--focus:#93c5fd;
}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;min-height:100vh}
button{font:inherit;cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);border-radius:8px;padding:6px 12px;min-height:32px;font-weight:600;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,box-shadow .15s}
button:hover:not(:disabled){border-color:var(--muted)}
button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,[tabindex]:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button.success{background:var(--ok);border-color:var(--ok);color:#fff}
button.danger{background:var(--bad);border-color:var(--bad);color:#fff}
button.outline-accent{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
button.ghost{border-color:transparent;background:none;color:var(--muted)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.spacer{flex:1}
.topbar{display:flex;align-items:center;gap:10px;padding:10px 18px;background:var(--surface);border-bottom:1px solid var(--line)}
.logo{color:var(--accent);display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--accent-soft)}
.brand{font-weight:800;font-size:16px;letter-spacing:.02em}
.subtitle{color:var(--muted);padding-left:10px;border-left:1px solid var(--line)}
.devtoggle{border-radius:8px;font-size:12px;color:var(--muted)}
.devtoggle[aria-pressed=true]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.statusbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 18px 0;padding:10px 14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.state{font-size:15px;font-weight:700;margin:0;display:inline-flex;align-items:center;gap:8px}
.state::before{content:"";width:12px;height:12px;border-radius:50%;background:var(--idle);flex:none}
.state.rec{color:var(--bad)} .state.rec::before{background:var(--bad);animation:pulse 1.6s infinite}
.state.paused{color:var(--warn)} .state.paused::before{background:var(--warn)}
.state.done{color:var(--ok)} .state.done::before{display:none}
.state.working{color:var(--run)} .state.working::before{background:var(--run)}
.live{font-size:12px;font-weight:600;color:var(--ok);display:inline-flex;align-items:center;gap:5px}
.live::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.live.off{color:var(--muted)}
.live:empty{display:none}
.sep{width:1px;height:22px;background:var(--line)}
.timer{font:700 18px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.count{font-size:12px;color:var(--muted)}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.controls:empty{display:none}
.controls .note{flex-basis:100%;margin:0;color:var(--warn);font-size:12px}
.progress{margin:10px 18px 0}
.progress .bar{height:4px;border-radius:999px;background:var(--line);overflow:hidden}
.progress .bar span{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#22d3ee);width:0;transition:width .3s}
.progress.indeterminate .bar span{width:30%;animation:slide 1.2s ease-in-out infinite}
.progress p{margin:6px 0 0;color:var(--muted);font-size:12px}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(330%)}}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,.5)}70%{box-shadow:0 0 0 7px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}
@keyframes spin{to{transform:rotate(360deg)}}
.tabs{display:flex;gap:2px;margin:12px 18px 0;border-bottom:1px solid var(--line)}
.tabs [role=tab]{border:0;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:none;padding:8px 16px;min-height:36px;color:var(--muted);font-weight:600}
.tabs [role=tab]:hover{background:var(--surface)}
.tabs [role=tab][aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent);background:var(--surface)}
main{flex:1;padding:12px 18px 18px;min-height:0}
.grid{display:grid;grid-template-columns:1fr;gap:12px;align-items:start}
.col-mid{display:none}
@media (min-width:780px){.grid{grid-template-columns:minmax(280px,340px) minmax(0,1fr)}}
@media (min-width:1180px){.grid{grid-template-columns:minmax(280px,320px) minmax(0,1fr) minmax(280px,340px)}.col-mid{display:block}}
.col-left{display:grid;gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 14px}
.card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.card-head h2,.card h2{margin:0;font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px}
.card-head .actions{margin-left:auto;display:flex;gap:6px}
.badge{margin-left:auto;font-size:11px;font-weight:700;border-radius:6px;padding:2px 8px;background:var(--ok-soft);color:var(--ok)}
.status-line{margin:0 0 10px;font-size:12px;font-weight:600;border-radius:8px;padding:6px 10px;background:var(--surface-2);color:var(--muted)}
.status-line.ok{background:var(--ok-soft);color:var(--ok)} .status-line.warn{background:var(--warn-soft);color:var(--warn)} .status-line.run{background:var(--run-soft);color:var(--run)}
.timeline{list-style:none;margin:0;padding:0}
.timeline>li{position:relative;padding:0 0 8px 30px}
.timeline>li::before{content:"";position:absolute;left:10px;top:24px;bottom:-4px;width:2px;background:var(--line)}
.timeline>li:last-child::before{display:none}
.item{position:relative;display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-weight:400}
.item:hover:not(:disabled){border-color:var(--line-strong);background:var(--surface-2)}
.item[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.dot{position:absolute;left:-30px;top:8px;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;color:#fff;background:var(--idle);box-shadow:0 0 0 3px var(--bg)}
.CONFIRMED .dot{background:var(--ok)} .PENDING .dot{background:var(--run)} .AMBIGUOUS .dot{background:var(--warn)} .FAILED .dot{background:var(--bad)} .UNVERIFIED .dot{background:var(--surface);color:var(--idle);border:2px solid var(--idle)}
.num{color:var(--muted);font:600 11px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace;min-width:14px}
.kind{flex:none;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.kind svg{width:18px;height:18px}
.kind.k-fill{background:var(--teal-soft);color:var(--teal)} .kind.k-check,.kind.k-uncheck,.kind.k-choose{background:var(--violet-soft);color:var(--violet)}
.kind.k-click{background:var(--orange-soft);color:var(--orange)} .kind.k-select,.kind.k-key{background:var(--pink-soft);color:var(--pink)}
.desc{flex:1;min-width:0;font-weight:700;word-break:break-word}
.desc .sub{display:block;color:var(--muted);font-weight:400;font-size:12px}
.pill{display:inline-flex;align-items:center;gap:4px;margin-top:5px;font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--idle-soft);color:var(--muted)}
.CONFIRMED .pill{background:var(--ok-soft);color:var(--ok)} .PENDING .pill{background:var(--run-soft);color:var(--run)} .AMBIGUOUS .pill{background:var(--warn-soft);color:var(--warn)} .FAILED .pill{background:var(--bad-soft);color:var(--bad)}
.PENDING .pill::after{content:"";width:9px;height:9px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
.chev{color:var(--muted);align-self:center;font-size:16px}
.tech{display:block;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:pre-wrap;margin-top:6px;background:var(--surface-2);border-radius:6px;padding:6px 8px;font-weight:400}
.attention{margin:8px 0 0;padding:10px 12px;border-radius:10px;background:var(--warn-soft)}
.attention p{margin:0 0 8px}
.attention .row,.row{display:flex;gap:8px;flex-wrap:wrap}
.attention fieldset{border:0;padding:0;margin:6px 0 10px}
.attention legend{font-weight:700;margin-bottom:6px}
.attention label{display:flex;gap:8px;align-items:center;padding:8px 10px;margin-bottom:6px;border-radius:8px;background:var(--surface);border:1px solid var(--line);cursor:pointer}
.attention label:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.attention .error{color:var(--bad);margin-top:8px;font-weight:600}
.remove{margin:6px 0 0}
.remove button{color:var(--bad);border-color:transparent;background:var(--bad-soft)}
.checks{margin-top:4px;margin-left:30px}
.checks summary{cursor:pointer;color:var(--muted);font-weight:600}
.checks ul{margin:6px 0 0;padding-left:18px;color:var(--muted)}
.quality .qbody{display:flex;gap:14px;align-items:center}
.ring{--p:0;width:86px;height:86px;border-radius:50%;background:conic-gradient(var(--ok) calc(var(--p)*1%),var(--line) 0);display:grid;place-items:center;flex:none}
.ring>div{width:68px;height:68px;border-radius:50%;background:var(--surface);display:grid;place-items:center;text-align:center;line-height:1.1}
.ring b{font-size:19px} .ring span{font-size:11px;color:var(--muted)}
.quality ul{list-style:none;padding:0;margin:0;display:grid;gap:4px;flex:1;font-size:12px}
.quality li{display:flex;gap:6px}
.quality li .v{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.quality li.ok .i{color:var(--ok)} .quality li.warn .i{color:var(--warn)}
.preview .toolbar{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.preview .url{display:flex;align-items:center;gap:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--muted);margin-bottom:10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.preview .nav{color:var(--idle);letter-spacing:4px}
.viewport{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface-2)}
.viewport img{display:block;width:100%;height:auto}
.viewport .hl{position:absolute;border:2px dashed var(--ok);border-radius:8px;box-shadow:0 0 0 4px rgba(22,163,74,.18);pointer-events:none}
.viewport .hl span.above{top:auto;bottom:calc(100% + 4px)}
.viewport .hl span{position:absolute;left:-2px;top:calc(100% + 4px);background:var(--ok);color:#fff;font-size:11px;font-weight:700;padding:1px 8px;border-radius:6px;white-space:nowrap}
.viewport .placeholder{padding:60px 20px;text-align:center;color:var(--muted)}
.selnote{display:flex;gap:10px;align-items:center;margin-top:10px;border-radius:10px;padding:10px 12px;background:var(--ok-soft);color:var(--fg)}
.selnote .i{width:26px;height:26px;border-radius:50%;background:var(--ok);color:#fff;display:grid;place-items:center;font-weight:800;flex:none}
.selnote b{display:block;color:var(--ok)}
.selnote.warn{background:var(--warn-soft)} .selnote.warn .i{background:var(--warn)} .selnote.warn b{color:var(--warn)}
.details .step{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:2px 8px;background:var(--accent-soft);color:var(--accent);margin-bottom:8px}
.details .hero{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:12px}
.details .hero b{display:block;font-size:14px}
.details .hero span{color:var(--muted);font-size:12px}
.details h3{margin:12px 0 6px;font-size:12px;font-weight:700}
.details dl{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;margin:0;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.details dt{color:var(--muted)} .details dd{margin:0;word-break:break-word;display:flex;align-items:center;gap:6px}
.details dd code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.details dd .chip{font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--accent-soft);color:var(--accent)}
.details .copy{margin-left:auto;min-height:24px;padding:2px 8px;font-size:11px}
.vlist{list-style:none;margin:0;padding:8px 10px;border:1px solid var(--line);border-radius:10px;display:grid;gap:5px;font-size:12px}
.vlist li{display:flex;gap:8px;align-items:center}
.vlist .i{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:800;color:#fff;background:var(--ok);flex:none}
.vlist li.no .i{background:var(--warn)}
.vlist li:first-child.yes{color:var(--ok);font-weight:700}
.details .found{margin:10px 0 0;padding:8px 10px;border-radius:8px;font-weight:600;font-size:12px}
.found.ok{background:var(--ok-soft);color:var(--ok)} .found.warn{background:var(--warn-soft);color:var(--warn)}
.details .logs{margin-top:10px}
.details .logs summary{cursor:pointer;color:var(--muted);font-weight:600}
.details .empty-details{color:var(--muted);text-align:center;padding:30px 10px}
.review{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)}
.review h2{margin:0 0 4px;font-size:16px;color:var(--ok)}
.review .hint{margin:0;color:var(--muted)}
.result{border-radius:10px;padding:12px 14px;margin-top:10px}
.result.ok{background:var(--ok-soft)} .result.bad{background:var(--bad-soft)}
.result.ok>b{color:var(--ok)} .result.bad>b{color:var(--bad)}
.result ul{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:3px}
.result p{margin:6px 0}
.result details{margin:6px 0 10px}
.result .actions{display:flex;gap:8px;flex-wrap:wrap}
.summarybar{position:sticky;bottom:0;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 18px;background:var(--surface);border-top:1px solid var(--line);box-shadow:0 -2px 10px rgba(15,23,42,.04)}
.summarybar h2{margin:0;font-size:13px;font-weight:700;width:100%}
.stat{display:flex;align-items:center;gap:8px;padding-right:14px;border-right:1px solid var(--line)}
.stat:last-of-type{border-right:0}
.stat .i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff}
.stat b{display:block;font-size:15px;line-height:1.1;font-variant-numeric:tabular-nums}
.stat span{font-size:11px;color:var(--muted)}
.i-actions{background:var(--ok)} .i-ok{background:var(--ok)} .i-amb{background:var(--warn)} .i-bad{background:var(--bad)} .i-time{background:var(--idle)}
.summarybar .buttons{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.card-plain{margin-bottom:10px}
.card .meta{color:var(--muted);font-size:12px;margin-top:2px}
.card .tag{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--accent-soft);color:var(--accent);margin-right:6px}
.notice{background:var(--accent-soft);border-radius:8px;padding:10px 12px;font-size:12px}
.empty{color:var(--muted);font-style:italic}
.sub{color:var(--muted);font-size:12px}
@media (max-width:640px){.subtitle{display:none}.statusbar,.tabs,.progress{margin-left:12px;margin-right:12px}main{padding:12px}.stat{padding-right:8px}.summarybar{padding:10px 12px}}
@media (min-width:780px){.grid.detached{grid-template-columns:minmax(300px,440px) minmax(0,1fr)}}
.grid.detached .col-mid{display:none!important}
.detached-note{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 14px;border-radius:10px;background:var(--accent-soft);color:var(--fg);font-weight:600}
.detached-note button{margin-left:auto}
.preview:fullscreen{overflow:auto;padding:20px;background:var(--surface)}
.preview:fullscreen .viewport img{max-height:calc(100vh - 160px);width:auto;max-width:100%;margin:0 auto}
body[data-mode=preview]{background:var(--bg)}
.detached-main{flex:1;padding:16px;display:flex;flex-direction:column}
.preview.detached{flex:1;display:flex;flex-direction:column}
.preview.detached .viewport{flex:1;display:flex;align-items:flex-start;justify-content:center;background:var(--surface-2)}
.preview.detached .viewport img{max-height:calc(100vh - 230px);width:auto;max-width:100%}
.preview.detached .viewport .frame{position:relative;display:inline-block;max-width:100%}
.state.small{font-size:13px}
.actions-top{display:flex;gap:8px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const SCRIPT = `
(function () {
  var lang = document.documentElement.lang === 'fr' ? 'fr' : 'en';
  var T = {
    fr: {
      recording: 'Enregistrement en cours', paused: 'Enregistrement en pause', finalizing: 'Finalisation…', review: 'Enregistrement terminé',
      pause: '⏸ Pause', resume: '▶ Reprendre', stop: '■ Arrêter', undo: '↶ Annuler',
      pauseLabel: "Mettre l'enregistrement en pause", resumeLabel: "Reprendre l'enregistrement", stopLabel: "Arrêter l'enregistrement", undoLabel: 'Retirer la dernière action du recording',
      pausedNote: 'Les actions ne sont plus enregistrées. La page reste utilisable.',
      actions: function (n) { return n + ' action' + (n > 1 ? 's' : ''); },
      tabRecording: 'Enregistrement', tabAnalysis: 'Analyse', tabs: 'Vues', user: 'Utilisateur', dev: 'Développeur',
      timeline: 'Parcours enregistré', empty: "Aucune action pour l'instant : utilisez l'application.",
      status: { CONFIRMED: 'confirmée', PENDING: 'en cours de validation', AMBIGUOUS: 'ambiguë', FAILED: 'échec', UNVERIFIED: 'non vérifiable' },
      valid: 'Recording valide', allConfirmed: function (n) { return n + ' action' + (n > 1 ? 's' : '') + ' confirmée' + (n > 1 ? 's' : ''); },
      needsCheck: 'Recording nécessite une vérification', confirmedN: function (n) { return n + ' confirmée' + (n > 1 ? 's' : ''); },
      ambiguousN: function (n) { return n + ' action' + (n > 1 ? 's' : '') + ' ambiguë' + (n > 1 ? 's' : ''); },
      failedN: function (n) { return n + ' cible' + (n > 1 ? 's' : '') + ' non retrouvée' + (n > 1 ? 's' : ''); },
      pendingN: function (n) { return n + ' en cours de validation'; },
      attention: function (n) { return n + ' nécessite' + (n > 1 ? 'nt' : '') + ' votre attention'; },
      ambiguousTitle: '⚠ Action ambiguë', matches: function (n) { return n + ' éléments correspondent.'; },
      resolve: 'Résoudre', ignore: 'Ignorer', confirm: 'Confirmer', cancel: 'Annuler',
      which: 'Quel élément voulez-vous enregistrer ?',
      notTouched: "Ce n'est pas l'élément que vous avez touché : annulez l'action (↶) et refaites-la sur le bon élément.",
      ignored: 'Laissée telle quelle : elle sera vérifiée au rejeu.',
      detailsTitle: "Détails de l'action", close: 'Fermer',
      field: { event: 'Action', kind: 'Action', name: 'Élément', label: 'Libellé', text: 'Texte', role: 'Rôle', tag: 'Type', selector: 'Sélecteur', page: 'Page', section: 'Section', matches: 'Correspondances', validation: 'Validation', frame: 'Cadre', rawEventId: 'Événement', target: 'Cible', provenance: 'Provenance', locator: 'Localisateur', raw: 'Événements bruts', step: 'Étape', decision: 'Décision', resolution: 'Résolution', shadowDom: 'Shadow DOM', field: 'Champ', sensitive: 'Sensible' },
      found: { ORIGINAL: "✓ Élément mis en évidence dans la page", SELECTOR: '✓ Élément retrouvé par son sélecteur et mis en évidence', NOT_FOUND: '⚠ Élément introuvable sur la page actuelle' },
      quality: 'Qualité du recording', checksQ: { confirmed: 'Actions confirmées', stable: 'Sélecteurs stables', unique: 'Cibles uniques', rerender: 'Aucun élément retrouvé après un nouveau rendu', duplicates: 'Aucun doublon', errors: 'Aucune erreur' },
      noQuality: 'La qualité se calcule dès la première action validée.',
      done: 'Enregistrement terminé ✓', recorded: function (n) { return '<b>' + n + '</b> action' + (n > 1 ? 's' : '') + ' enregistrée' + (n > 1 ? 's' : ''); },
      confirmedS: function (n) { return '<b>' + n + '</b> confirmée' + (n > 1 ? 's' : ''); }, ambS: function (n) { return '<b>' + n + '</b> ambiguïté' + (n > 1 ? 's' : ''); },
      duration: 'Durée', replay: '▶ Rejouer', edit: '✎ Modifier', editing: '✓ Terminer les modifications', save: '💾 Sauvegarder', saveFlow: '💾 Sauvegarder le flow', finish: 'Fermer', restart: '↻ Recommencer',
      recommend: 'Conseillé : rejouez le flow avant de le sauvegarder.',
      replaying: function (a, b) { return 'Rejeu en cours… étape ' + a + ' sur ' + b; },
      replayOk: '✓ Replay réussi', executed: function (a, b) { return a + ' / ' + b + ' actions exécutées'; },
      replayBad: '✕ Replay interrompu', stepOf: function (a, b) { return 'Étape ' + a + ' sur ' + b; }, cause: 'Cause', seeDetails: 'Voir les détails', editStep: "Modifier l'étape",
      saved: '✓ Flow sauvegardé', remove: '✕ Retirer cette étape', removeLabel: function (d) { return "Retirer l'étape « " + d + ' » du flow'; },
      checks: function (n) { return 'Vérifications ajoutées au flow (' + n + ')'; }, checksNote: 'Déduites des résultats observés : ce ne sont pas des actions enregistrées.',
      analysisTitle: 'Analyse', analysisNote: "L'analyse ne modifie jamais le recording. Elle est disponible après l'arrêt.", analysisWaiting: "L'analyse sera disponible après l'arrêt de l'enregistrement.",
      intents: 'Intents détectés', noIntent: 'Aucun intent détecté.', confidence: 'Confiance', why: 'Voir pourquoi', findings: 'Constats et suggestions', noFinding: 'Aucun constat.', ai: function (n) { return n + ' suggestion(s) de connaissance proposée(s) par l’IA (à revoir).'; },
      origin: { DETERMINISTIC: 'Analyse déterministe', AI_PROPOSAL: 'Proposition IA' },
      announceAdded: 'Action ajoutée : ', announceUndo: 'Dernière action retirée.', toReview: 'à vérifier'
    },
    en: {
      recording: 'Recording', paused: 'Recording paused', finalizing: 'Finalizing…', review: 'Recording finished',
      pause: '⏸ Pause', resume: '▶ Resume', stop: '■ Stop', undo: '↶ Undo',
      pauseLabel: 'Pause the recording', resumeLabel: 'Resume the recording', stopLabel: 'Stop the recording', undoLabel: 'Remove the last action from the recording',
      pausedNote: 'Actions are not recorded. The page stays usable.',
      actions: function (n) { return n + ' action' + (n === 1 ? '' : 's'); },
      tabRecording: 'Recording', tabAnalysis: 'Analysis', tabs: 'Views', user: 'User', dev: 'Developer',
      timeline: 'Recorded journey', empty: 'No action yet: use the application.',
      status: { CONFIRMED: 'confirmed', PENDING: 'being validated', AMBIGUOUS: 'ambiguous', FAILED: 'failed', UNVERIFIED: 'not verifiable' },
      valid: 'Recording valid', allConfirmed: function (n) { return n + ' action' + (n === 1 ? '' : 's') + ' confirmed'; },
      needsCheck: 'Recording needs a check', confirmedN: function (n) { return n + ' confirmed'; },
      ambiguousN: function (n) { return n + ' ambiguous action' + (n === 1 ? '' : 's'); },
      failedN: function (n) { return n + ' target' + (n === 1 ? '' : 's') + ' not found again'; },
      pendingN: function (n) { return n + ' being validated'; },
      attention: function (n) { return n + ' need' + (n === 1 ? 's' : '') + ' your attention'; },
      ambiguousTitle: '⚠ Ambiguous action', matches: function (n) { return n + ' elements match.'; },
      resolve: 'Resolve', ignore: 'Ignore', confirm: 'Confirm', cancel: 'Cancel',
      which: 'Which element do you want to record?',
      notTouched: 'This is not the element you touched: undo the action (↶) and do it again on the right element.',
      ignored: 'Left as is: it will be checked at replay.',
      detailsTitle: 'Action details', close: 'Close',
      field: { event: 'Action', kind: 'Action', name: 'Element', label: 'Label', text: 'Text', role: 'Role', tag: 'Type', selector: 'Selector', page: 'Page', section: 'Section', matches: 'Matches', validation: 'Validation', frame: 'Frame', rawEventId: 'Event', target: 'Target', provenance: 'Provenance', locator: 'Locator', raw: 'Raw events', step: 'Step', decision: 'Decision', resolution: 'Resolution', shadowDom: 'Shadow DOM', field: 'Field', sensitive: 'Sensitive' },
      found: { ORIGINAL: '✓ Element highlighted in the page', SELECTOR: '✓ Element found by its selector and highlighted', NOT_FOUND: '⚠ Element not found on the current page' },
      quality: 'Recording quality', checksQ: { confirmed: 'Actions confirmed', stable: 'Stable selectors', unique: 'Unique targets', rerender: 'No element found again after a re-render', duplicates: 'No duplicate', errors: 'No error' },
      noQuality: 'Quality is computed from the first validated action.',
      done: 'Recording finished ✓', recorded: function (n) { return '<b>' + n + '</b> action' + (n === 1 ? '' : 's') + ' recorded'; },
      confirmedS: function (n) { return '<b>' + n + '</b> confirmed'; }, ambS: function (n) { return '<b>' + n + '</b> ambiguit' + (n === 1 ? 'y' : 'ies'); },
      duration: 'Duration', replay: '▶ Replay', edit: '✎ Edit', editing: '✓ Done editing', save: '💾 Save', saveFlow: '💾 Save the flow', finish: 'Close', restart: '↻ Try again',
      recommend: 'Recommended: replay the flow before saving it.',
      replaying: function (a, b) { return 'Replaying… step ' + a + ' of ' + b; },
      replayOk: '✓ Replay passed', executed: function (a, b) { return a + ' / ' + b + ' actions executed'; },
      replayBad: '✕ Replay stopped', stepOf: function (a, b) { return 'Step ' + a + ' of ' + b; }, cause: 'Cause', seeDetails: 'See the details', editStep: 'Edit the step',
      saved: '✓ Flow saved', remove: '✕ Remove this step', removeLabel: function (d) { return 'Remove the step "' + d + '" from the flow'; },
      checks: function (n) { return 'Checks added to the flow (' + n + ')'; }, checksNote: 'Inferred from the observed results: these are not recorded actions.',
      analysisTitle: 'Analysis', analysisNote: 'The analysis never changes the recording. It is available after Stop.', analysisWaiting: 'The analysis will be available once the recording is stopped.',
      intents: 'Detected intents', noIntent: 'No intent detected.', confidence: 'Confidence', why: 'See why', findings: 'Findings and suggestions', noFinding: 'No finding.', ai: function (n) { return n + ' knowledge suggestion(s) proposed by the AI (to review).'; },
      origin: { DETERMINISTIC: 'Deterministic analysis', AI_PROPOSAL: 'AI proposal' },
      announceAdded: 'Action added: ', announceUndo: 'Last action removed.', toReview: 'to review'
    }
  }[lang];

  var X = {
    fr: {
      subtitle: 'Enregistrement de parcours', devMode: 'Mode développeur', active: 'Actif', inactive: 'En pause',
      tabPreview: 'Aperçu', previewTitle: "Aperçu de l'application", refresh: 'Actualiser', noPreview: "L'aperçu de la page apparaît après la première action.",
      selected: 'Élément sélectionné dans la page', isHighlighted: function (l) { return '« ' + l + ' » est surligné'; }, notFoundShort: 'Introuvable sur la page actuelle',
      stepOf2: function (a, b) { return 'Étape ' + a + ' sur ' + b; }, general: 'Informations générales', selectors: 'Sélecteurs et attributs', validation: 'Validation', logs: 'Voir les logs techniques', copy: 'Copier', copied: 'Copié',
      pick: 'Sélectionnez une action pour voir ses détails.', hideDetails: 'Masquer les détails',
      summaryTitle: 'Résumé du recording', sActions: 'Actions', sConfirmed: 'Confirmées', sAmbiguous: 'Ambiguës', sFailed: 'Échecs', sDuration: 'Durée',
      replayFlow: '▶ Rejouer le parcours', saveFlow2: '💾 Sauvegarder le flow', afterStop: "Disponible après l'arrêt de l'enregistrement",
      pill: { CONFIRMED: 'Confirmée', PENDING: 'En cours', AMBIGUOUS: 'Ambiguë', FAILED: 'Échec', UNVERIFIED: 'Non vérifiable' },
      kindName: { open: 'Navigation', navigate: 'Navigation', click: 'Click', fill: 'Saisie', check: 'Case à cocher', uncheck: 'Case à cocher', choose: 'Choix', select: 'Sélection', key: 'Touche', drag: 'Glisser-déposer', upload: 'Fichier', dialog: 'Dialogue', goto: 'Navigation', dragAndDrop: 'Glisser-déposer', manual: 'Manuel' },
      qualityShort: 'Qualité', seeDetail: 'Voir le détail',
      fullscreen: 'Plein écran', detach: 'Détacher', detachLabel: "Détacher l'aperçu dans sa propre fenêtre", attach: 'Rattacher', attachLabel: "Rattacher l'aperçu à la fenêtre principale",
      detachedNote: "L'aperçu de l'application est ouvert dans sa propre fenêtre (plein écran possible)."
    },
    en: {
      subtitle: 'Journey recording', devMode: 'Developer mode', active: 'Active', inactive: 'Paused',
      tabPreview: 'Preview', previewTitle: 'Application preview', refresh: 'Refresh', noPreview: 'The page preview appears after the first action.',
      selected: 'Element selected in the page', isHighlighted: function (l) { return '"' + l + '" is highlighted'; }, notFoundShort: 'Not found on the current page',
      stepOf2: function (a, b) { return 'Step ' + a + ' of ' + b; }, general: 'General information', selectors: 'Selectors and attributes', validation: 'Validation', logs: 'See the technical logs', copy: 'Copy', copied: 'Copied',
      pick: 'Select an action to see its details.', hideDetails: 'Hide the details',
      summaryTitle: 'Recording summary', sActions: 'Actions', sConfirmed: 'Confirmed', sAmbiguous: 'Ambiguous', sFailed: 'Failed', sDuration: 'Duration',
      replayFlow: '▶ Replay the journey', saveFlow2: '💾 Save the flow', afterStop: 'Available once the recording is stopped',
      pill: { CONFIRMED: 'Confirmed', PENDING: 'In progress', AMBIGUOUS: 'Ambiguous', FAILED: 'Failed', UNVERIFIED: 'Not verifiable' },
      kindName: { open: 'Navigation', navigate: 'Navigation', click: 'Click', fill: 'Typing', check: 'Checkbox', uncheck: 'Checkbox', choose: 'Choice', select: 'Select', key: 'Key', drag: 'Drag and drop', upload: 'File', dialog: 'Dialog', goto: 'Navigation', dragAndDrop: 'Drag and drop', manual: 'Manual' },
      qualityShort: 'Quality', seeDetail: 'See the detail',
      fullscreen: 'Full screen', detach: 'Detach', detachLabel: 'Detach the preview into its own window', attach: 'Reattach', attachLabel: 'Reattach the preview to the main window',
      detachedNote: 'The application preview is open in its own window (full screen available).'
    }
  }[lang];
  Object.keys(X).forEach(function (k) { T[k] = X[k]; });

  var ICON = { CONFIRMED: '✓', PENDING: '●', AMBIGUOUS: '!', FAILED: '✕', UNVERIFIED: '' };
  var SVG = {
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 6h14M12 6v13"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg>',
    cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 3l14 7-6 2-2 6z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>'
  };
  var KIND_ICON = { open: 'link', navigate: 'link', goto: 'link', click: 'cursor', fill: 'text', check: 'check', uncheck: 'check', choose: 'check', select: 'list', key: 'hash', drag: 'move', dragAndDrop: 'move', upload: 'clip', manual: 'hash', dialog: 'list' };
  var state = null, selected = null, resolving = null, dev = false, editing = false, tab = 'recording';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var send = function (cmd) { try { window.__qaPanelCommand(cmd); } catch (e) { /* hors QA-CRAWLER */ } };
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  var clock = function (ms) { var s = Math.max(0, Math.floor(ms / 1000)); var h = Math.floor(s / 3600); return (h ? two(h) + ':' : '') + two(Math.floor((s % 3600) / 60)) + ':' + two(s % 60); };
  var announce = function (text) { $('live').textContent = text; };
  var DETACHED = document.body.getAttribute('data-mode') === 'preview';
  var fullscreen = function (el) {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (el && el.requestFullscreen) void el.requestFullscreen();
    } catch (e) { /* plein écran refusé par le navigateur */ }
  };
  var short = function (text, n) { return text.length > n ? text.slice(0, n - 1) + '…' : text; };
  var recordingPhase = function () { return state && (state.phase === 'RECORDING' || state.phase === 'PAUSED'); };

  function button(label, attrs) {
    var a = attrs || {};
    return '<button type="button"' + (a.cls ? ' class="' + a.cls + '"' : '') + (a.cmd ? ' data-cmd="' + a.cmd + '"' : '') + (a.id ? ' data-id="' + esc(a.id) + '"' : '') + (a.aria ? ' aria-label="' + esc(a.aria) + '"' : '') + (a.title ? ' title="' + esc(a.title) + '"' : '') + (a.disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }

  function renderHead() {
    var p = state.phase, st = $('state');
    st.className = 'state ' + (p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working');
    st.textContent = (p === 'RECORDING' ? T.recording : p === 'PAUSED' ? '⏸ ' + T.paused : p === 'FINALIZING' ? T.finalizing : '✓ ' + T.review);
    var pill = $('livepill');
    pill.textContent = p === 'RECORDING' ? T.active : p === 'PAUSED' ? T.inactive : '';
    pill.className = 'live' + (p === 'PAUSED' ? ' off' : '');
    $('count').textContent = T.actions(state.summary.actions);
    var c = '';
    if (recordingPhase()) {
      c += button(T.pause, { cmd: 'pause', cls: p === 'RECORDING' ? 'outline-accent' : '', aria: T.pauseLabel, disabled: p === 'PAUSED' });
      c += button(T.resume, { cmd: 'resume', cls: p === 'PAUSED' ? 'primary' : '', aria: T.resumeLabel, disabled: p !== 'PAUSED' });
      c += button(T.stop, { cmd: 'stop', cls: 'danger', aria: T.stopLabel });
      c += button(T.undo, { cmd: 'undo', aria: T.undoLabel, disabled: state.actions.length <= 1 });
      if (p === 'PAUSED') c += '<p class="note" role="note">' + esc(T.pausedNote) + '</p>';
    }
    $('controls').innerHTML = c;
    var pr = $('progress');
    if (state.progress && p === 'FINALIZING') {
      pr.hidden = false;
      var pct = state.progress.total > 0 ? Math.round((Math.min(state.progress.step, state.progress.total) / state.progress.total) * 100) : 0;
      pr.className = 'progress' + (state.progress.total > 0 ? '' : ' indeterminate');
      pr.querySelector('span').style.width = (state.progress.total > 0 ? pct : 30) + '%';
      pr.querySelector('p').textContent = state.progress.label + (state.progress.detail ? ' — ' + state.progress.detail : '');
    } else if (state.replay && state.replay.status === 'RUNNING') {
      pr.hidden = false; pr.className = 'progress';
      var r = state.replay;
      pr.querySelector('span').style.width = (r.total ? Math.round((r.executed / r.total) * 100) : 0) + '%';
      pr.querySelector('p').textContent = T.replaying(Math.min(r.executed + 1, r.total), r.total);
    } else pr.hidden = true;
  }

  function tickTimer() {
    if (!state) return;
    var text = clock((state.endedAt || Date.now()) - state.startedAt);
    $('timer').textContent = text;
    $('timer').setAttribute('aria-label', T.duration + ' ' + text);
    var d = document.querySelector('[data-stat="duration"]');
    if (d) d.textContent = text;
  }

  function renderSummary() {
    var s = state.summary, el = $('summary');
    $('journey-count').textContent = s.confirmed + ' / ' + s.actions;
    if (s.actions === 0) { el.className = 'status-line'; el.textContent = T.empty; return; }
    var problems = s.attention > 0;
    el.className = 'status-line ' + (problems ? 'warn' : s.pending > 0 ? 'run' : 'ok');
    var lines = [];
    if (s.ambiguous) lines.push(T.ambiguousN(s.ambiguous));
    if (s.failed) lines.push(T.failedN(s.failed));
    el.textContent = problems ? '⚠ ' + T.needsCheck + ' — ' + T.attention(s.attention) + (lines.length ? ' · ' + lines.join(' · ') : '') : s.pending > 0 ? '● ' + T.pendingN(s.pending) : '✓ ' + T.valid + ' — ' + T.allConfirmed(s.confirmed);
  }

  function techLines(step) {
    return Object.keys(step.technical).map(function (k) { return k + '=' + step.technical[k]; }).join('\\n');
  }

  function renderTimeline() {
    $('timeline-title').textContent = T.timeline;
    var html = state.actions.map(function (step) {
      var current = selected === step.id;
      var h = '<li data-step="' + esc(step.id) + '">';
      h += '<button type="button" class="item ' + step.status + '" data-cmd="select" data-id="' + esc(step.id) + '" aria-current="' + current + '" aria-label="' + esc(step.index + '. ' + step.description + ' — ' + T.status[step.status]) + '">';
      h += '<span class="dot" aria-hidden="true">' + ICON[step.status] + '</span><span class="num">' + step.index + '</span>';
      h += '<span class="kind k-' + esc(step.kind) + '" aria-hidden="true">' + (SVG[KIND_ICON[step.kind] || 'hash']) + '</span><span class="desc">';
      if (dev) h += esc(step.technical.event || step.technical.kind || step.kind) + '<span class="tech">' + esc(techLines(step)) + '</span>';
      else {
        h += esc(step.description);
        if (step.detail) h += '<span class="sub">' + esc(step.detail) + '</span>';
        if (step.resolution || (step.status !== 'CONFIRMED' && step.status !== 'PENDING')) h += '<span class="sub">' + esc(step.statusText) + '</span>';
      }
      h += '<span class="pill" aria-hidden="true">' + esc(T.pill[step.status]) + '</span>';
      h += '</span><span class="chev" aria-hidden="true">›</span></button>';
      if (step.status === 'AMBIGUOUS' && step.resolution !== 'IGNORED' && state.phase !== 'REVIEW') {
        h += '<div class="attention" role="group" aria-label="' + esc(T.ambiguousTitle) + '"><p><b>' + esc(T.ambiguousTitle) + '</b><br>' + esc(step.description) + '<br>' + esc(T.matches(Math.max((step.candidates || []).length, 2))) + '</p>';
        if (resolving === step.id && step.candidates) {
          h += '<fieldset><legend>' + esc(T.which) + '</legend>' + step.candidates.map(function (c) {
            return '<label><input type="radio" name="cand-' + esc(step.id) + '" value="' + c.index + '"' + (c.original ? ' checked' : '') + '> ' + esc(c.label) + '</label>';
          }).join('') + '</fieldset><div class="row">' + button(T.confirm, { cmd: 'confirm-resolve', id: step.id, cls: 'primary' }) + button(T.cancel, { cmd: 'cancel-resolve', id: step.id }) + '</div>';
        } else h += '<div class="row">' + button(T.resolve, { cmd: 'open-resolve', id: step.id, cls: 'primary' }) + button(T.ignore, { cmd: 'ignore', id: step.id }) + '</div>';
        if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message === 'NOT_TOUCHED' ? T.notTouched : state.notice.message) + '</p>';
        h += '</div>';
      }
      if (editing && step.removable) h += '<div class="remove">' + button(T.remove, { cmd: 'remove', id: step.id, aria: T.removeLabel(step.description) }) + '</div>';
      return h + '</li>';
    }).join('');
    $('timeline').innerHTML = html || '<li class="empty">' + esc(T.empty) + '</li>';
    var checks = state.checks || [];
    $('checks').innerHTML = checks.length ? '<details class="checks"><summary>' + esc(T.checks(checks.length)) + '</summary><p class="sub">' + esc(T.checksNote) + '</p><ul>' + checks.map(function (c) { return '<li>' + esc(c.description) + '</li>'; }).join('') + '</ul></details>' : '';
  }

  var GENERAL = ['kind', 'event', 'name', 'label', 'text', 'role', 'tag', 'page', 'section', 'field', 'provenance', 'locator', 'decision', 'resolution'];
  var SELECTORS = ['selector', 'target', 'frame', 'matches', 'rawEventId', 'raw', 'step', 'shadowDom', 'sensitive'];

  function renderDetails() {
    var box = $('details');
    var step = state.actions.find(function (s) { return s.id === selected; });
    if (!step) { box.innerHTML = '<header class="card-head"><h2>' + esc(T.detailsTitle) + '</h2></header><p class="empty-details">' + esc(T.pick) + '</p>'; return; }
    var t = step.technical;
    var h = '<header class="card-head"><h2>' + esc(T.detailsTitle) + '</h2><span class="actions">' + button('✕', { cmd: 'deselect', cls: 'ghost', aria: T.hideDetails }) + '</span></header>';
    h += '<span class="step">' + esc(T.stepOf2(step.index, state.actions.length)) + '</span>';
    h += '<div class="hero"><span class="kind k-' + esc(step.kind) + '" aria-hidden="true">' + (SVG[KIND_ICON[step.kind] || 'hash']) + '</span><div><b>' + esc(step.description) + '</b><span>' + esc(step.detail || step.statusText) + '</span></div></div>';
    h += '<h3>' + esc(T.general) + '</h3><dl>';
    h += '<dt>' + esc(T.field.kind) + '</dt><dd><span class="chip">' + esc(T.kindName[step.kind] || step.kind) + '</span></dd>';
    GENERAL.forEach(function (k) { if (t[k] !== undefined && k !== 'kind' && k !== 'event') h += '<dt>' + esc(T.field[k] || k) + '</dt><dd>' + (k === 'role' ? '<span class="chip">' + esc(t[k]) + '</span>' : esc(t[k])) + '</dd>'; });
    h += '</dl>';
    var sel = SELECTORS.filter(function (k) { return t[k] !== undefined; });
    if (sel.length) {
      h += '<h3>' + esc(T.selectors) + '</h3><dl>';
      sel.forEach(function (k) { h += '<dt>' + esc(T.field[k] || k) + '</dt><dd><code>' + esc(t[k]) + '</code>' + (k === 'selector' || k === 'target' ? button(T.copy, { cmd: 'copy', cls: 'copy', id: t[k] }) : '') + '</dd>'; });
      h += '</dl>';
    }
    h += '<h3>' + esc(T.validation) + '</h3><ul class="vlist">';
    (step.checks.length ? step.checks : [{ ok: step.status === 'CONFIRMED', text: step.statusText }]).forEach(function (c) {
      h += '<li class="' + (c.ok ? 'yes' : 'no') + '"><span class="i" aria-hidden="true">' + (c.ok ? '✓' : '!') + '</span>' + esc(c.text) + '</li>';
    });
    h += '</ul>';
    if (state.highlight && state.highlight.actionId === step.id) {
      var r = state.highlight.result;
      h += '<p class="found ' + (r === 'NOT_FOUND' ? 'warn' : 'ok') + '" role="status">' + esc(T.found[r]) + '</p>';
    }
    h += '<details class="logs"><summary>' + esc(T.logs) + '</summary><span class="tech">' + esc(techLines(step)) + '</span></details>';
    box.innerHTML = h;
  }

  function renderQuality() {
    var q = state.quality, el = $('quality');
    var h = '<header class="card-head"><h2>' + esc(T.quality) + '</h2></header>';
    if (q.score === undefined) { el.innerHTML = h + '<p class="empty">' + esc(T.noQuality) + '</p>'; return; }
    h += '<div class="qbody"><div class="ring" style="--p:' + q.score + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + q.score + '" aria-label="' + esc(T.quality) + '"><div><span><b>' + q.score + '%</b><br>' + esc(T.qualityShort) + '</span></div></div><ul>';
    q.checks.forEach(function (c) { if (c.total > 0) h += '<li class="' + (c.ok ? 'ok' : 'warn') + '"><span class="i" aria-hidden="true">' + (c.ok ? '✓' : '⚠') + '</span>' + esc(T.checksQ[c.id]) + '<span class="v">' + c.passed + '/' + c.total + '</span></li>'; });
    el.innerHTML = h + '</ul></div>';
  }

  function previewHtml() {
    var pv = state.preview;
    var h = '<header class="card-head"><h2>' + esc(T.previewTitle) + '</h2><span class="actions">' + button('↻', { cmd: 'refresh-preview', cls: 'ghost', aria: T.refresh, title: T.refresh }) + (DETACHED ? '' : button('⛶', { cmd: 'fullscreen', cls: 'ghost', aria: T.fullscreen, title: T.fullscreen }) + button('⧉ ' + T.detach, { cmd: 'detach', aria: T.detachLabel, title: T.detachLabel })) + '</span></header>';
    h += '<div class="url"><span class="nav" aria-hidden="true">← →</span><span aria-hidden="true">🔒</span>' + esc(pv ? pv.url : '') + '</div>';
    h += '<div class="viewport">' + (DETACHED ? '<div class="frame">' : '');
    if (!pv) h += '<p class="placeholder">' + esc(T.noPreview) + '</p>';
    else {
      h += '<img alt="' + esc(T.previewTitle) + '" src="' + pv.image + '">';
      var hl = pv.highlight;
      // Détachée, la fenêtre suit la sélection faite dans la fenêtre principale.
      if (hl && (DETACHED || hl.actionId === selected)) {
        var sx = 100 / pv.width, sy = 100 / pv.height;
        h += '<div class="hl" style="left:' + (hl.x * sx) + '%;top:' + (hl.y * sy) + '%;width:' + (hl.width * sx) + '%;height:' + (hl.height * sy) + '%"><span' + (hl.y / pv.height > 0.75 ? ' class="above"' : '') + '>' + esc(short(hl.label || '', 36)) + '</span></div>';
      }
    }
    h += (DETACHED ? '</div>' : '') + '</div>';
    var hlState = state.highlight && (DETACHED || state.highlight.actionId === selected) ? state.highlight.result : null;
    if (hlState && hlState !== 'NOT_FOUND' && pv && pv.highlight) h += '<div class="selnote" role="status"><span class="i" aria-hidden="true">✓</span><div><b>' + esc(T.selected) + '</b>' + esc(T.isHighlighted(pv.highlight.label || '')) + '</div></div>';
    else if (hlState === 'NOT_FOUND') h += '<div class="selnote warn" role="status"><span class="i" aria-hidden="true">!</span><div><b>' + esc(T.notFoundShort) + '</b></div></div>';
    return h;
  }

  function renderPreview() {
    var detached = state.previewDetached === true;
    var grid = $('grid');
    grid.classList.toggle('detached', detached);
    var note = detached ? '<div class="detached-note" role="status">⧉ ' + esc(T.detachedNote) + button('↩ ' + T.attach, { cmd: 'attach', aria: T.attachLabel }) + '</div>' : '';
    $('detached-note').innerHTML = note;
    $('preview-card').innerHTML = detached ? '' : previewHtml();
    $('preview-full').innerHTML = detached ? note : previewHtml();
  }

  /** La fenêtre détachée : l'aperçu seul, l'état de l'enregistrement, Plein écran et Rattacher. */
  function renderDetached() {
    var p = state.phase, st = $('state');
    st.className = 'state small ' + (p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working');
    st.textContent = (p === 'RECORDING' ? T.recording : p === 'PAUSED' ? '⏸ ' + T.paused : p === 'FINALIZING' ? T.finalizing : '✓ ' + T.review) + ' · ' + T.actions(state.summary.actions);
    $('preview-detached').innerHTML = previewHtml();
  }

  function renderReview() {
    var el = $('review');
    if (state.phase !== 'REVIEW') { el.innerHTML = ''; return; }
    var r = state.replay;
    var h = '<div class="review" role="region" aria-label="' + esc(T.done) + '"><h2>' + esc(T.done) + '</h2>';
    if (!r && !state.saved) h += '<p class="hint">' + esc(T.recommend) + '</p>';
    if (r && r.status === 'PASSED') h += '<div class="result ok" role="status"><b>' + esc(T.replayOk) + '</b><ul><li>✓ ' + esc(T.executed(r.executed, r.total)) + '</li>' + (r.checks || []).map(function (c) { return '<li>' + (c.ok ? '✓ ' : '⚠ ') + esc(c.text) + '</li>'; }).join('') + '</ul></div>';
    if (r && r.status === 'FAILED' && r.failure) {
      var f = r.failure;
      h += '<div class="result bad" role="alert"><b>' + esc(T.replayBad) + '</b><p>' + esc(T.stepOf(f.index, r.total)) + '<br><b>' + esc(f.description) + '</b><br>' + esc(T.cause) + ' : ' + esc(f.cause) + '</p>';
      h += '<details><summary>' + esc(T.seeDetails) + '</summary><ul>' + f.details.map(function (d) { return '<li class="tech">' + esc(d) + '</li>'; }).join('') + '</ul></details>';
      h += '<div class="actions">' + button(T.editStep, { cmd: 'edit-step', id: f.stepId || '' }) + button(T.restart, { cmd: 'replay' }) + '</div></div>';
    }
    if (state.saved) h += '<div class="result ok" role="status"><b>' + esc(T.saved) + '</b><p class="sub">' + esc(state.saved.directory) + '</p></div>';
    el.innerHTML = h + '</div>';
  }

  function renderFooter() {
    var s = state.summary, review = state.phase === 'REVIEW', r = state.replay, running = r && r.status === 'RUNNING';
    var stat = function (cls, icon, value, label, key) { return '<div class="stat"><span class="i ' + cls + '" aria-hidden="true">' + icon + '</span><div><b' + (key ? ' data-stat="' + key + '"' : '') + '>' + esc(value) + '</b><span>' + esc(label) + '</span></div></div>'; };
    var h = '<h2>' + esc(T.summaryTitle) + '</h2>';
    h += stat('i-actions', '▶', s.actions, T.sActions) + stat('i-ok', '✓', s.confirmed, T.sConfirmed) + stat('i-amb', '!', s.ambiguous, T.sAmbiguous) + stat('i-bad', '✕', s.failed, T.sFailed) + stat('i-time', '◷', clock((state.endedAt || Date.now()) - state.startedAt), T.sDuration, 'duration');
    h += '<div class="buttons">';
    h += button(T.replayFlow, { cmd: 'replay', cls: 'primary', disabled: !review || running, title: review ? '' : T.afterStop });
    if (review) h += button(editing ? T.editing : T.edit, { cmd: 'edit', disabled: running });
    h += button(T.saveFlow2, { cmd: 'save', cls: 'success', disabled: !review || running, title: review ? '' : T.afterStop });
    if (review) h += button(T.finish, { cmd: 'finish', disabled: running });
    h += '</div>';
    $('summarybar').innerHTML = h;
  }

  function renderAnalysis() {
    var a = state.analysis, el = $('panel-analysis');
    var h = '<div class="card card-plain"><h2>' + esc(T.analysisTitle) + '</h2><p class="notice">' + esc(T.analysisNote) + '</p>';
    if (!a.available) { el.innerHTML = h + '<p class="empty">' + esc(T.analysisWaiting) + '</p></div>'; return; }
    h += '</div><div class="card card-plain"><h2>' + esc(T.intents) + '</h2>';
    h += a.intents.length ? a.intents.map(function (i) {
      return '<div><b>' + esc(i.label) + '</b>' + (i.detail ? '<div class="meta">' + esc(i.detail) + '</div>' : '') + (i.confidence !== undefined ? '<div class="meta">' + esc(T.confidence) + ' : ' + Math.round(i.confidence * 100) + ' %</div>' : '') + (i.evidence.length ? '<details><summary>' + esc(T.why) + '</summary><ul>' + i.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></details>' : '') + '</div>';
    }).join('') : '<p class="empty">' + esc(T.noIntent) + '</p>';
    h += '</div><div class="card card-plain"><h2>' + esc(T.findings) + '</h2>';
    h += a.findings.length ? a.findings.map(function (f) {
      return '<p><span class="tag">' + esc(f.severity) + '</span><b>' + esc(f.message) + '</b><br><span class="meta">' + esc(T.origin[f.origin] || f.origin) + '</span>' + (f.suggestion ? '<br>' + esc(f.suggestion) : '') + '</p>';
    }).join('') : '<p class="empty">' + esc(T.noFinding) + '</p>';
    if (a.aiCandidates > 0) h += '<p class="sub">' + esc(T.ai(a.aiCandidates)) + '</p>';
    el.innerHTML = h + '</div>';
  }

  function render() {
    if (!state) return;
    if (DETACHED) { renderDetached(); return; }
    renderHead(); renderReview(); renderSummary(); renderTimeline(); renderDetails(); renderQuality(); renderPreview(); renderFooter(); renderAnalysis(); tickTimer();
  }

  var TABS = ['recording', 'analysis', 'preview'];
  function selectTab(name) {
    tab = name;
    TABS.forEach(function (n) {
      var t = $('tab-' + n), p = $('panel-' + n), on = n === name;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; p.hidden = !on;
    });
  }

  window.__qaPanelRender = function (next) {
    var added = state && next.summary.actions > state.summary.actions && next.phase === 'RECORDING';
    var removed = state && next.summary.actions < state.summary.actions && next.phase !== 'REVIEW';
    state = next;
    if (selected && !state.actions.some(function (s) { return s.id === selected; })) selected = null;
    render();
    if (added) { var last = state.actions[state.actions.length - 1]; if (last) announce(T.announceAdded + last.description); }
    if (removed) announce(T.announceUndo);
  };

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.id === 'devtoggle') { dev = !dev; target.setAttribute('aria-pressed', String(dev)); render(); return; }
    if (target.getAttribute('role') === 'tab') { selectTab(target.id.replace('tab-', '')); return; }
    var cmd = target.getAttribute('data-cmd'), id = target.getAttribute('data-id');
    if (!cmd) return;
    if (cmd === 'select') { selected = id; render(); send({ type: 'select', id: id }); return; }
    if (cmd === 'deselect') { selected = null; render(); return; }
    if (cmd === 'copy') { try { navigator.clipboard.writeText(id || ''); target.textContent = T.copied; } catch (e) { /* presse-papiers indisponible */ } return; }
    if (cmd === 'refresh-preview') { send({ type: 'refresh' }); return; }
    if (cmd === 'fullscreen') { fullscreen(DETACHED ? document.documentElement : $('preview-card')); return; }
    if (cmd === 'open-resolve') { resolving = id; render(); return; }
    if (cmd === 'cancel-resolve') { resolving = null; render(); return; }
    if (cmd === 'confirm-resolve') {
      var picked = document.querySelector('input[name="cand-' + id + '"]:checked');
      send({ type: 'resolve', id: id, candidate: picked ? Number(picked.value) : -1 });
      resolving = null; return;
    }
    if (cmd === 'edit') { editing = !editing; render(); return; }
    if (cmd === 'edit-step') { editing = true; selected = id || selected; render(); var row = document.querySelector('[data-step="' + id + '"]'); if (row) row.scrollIntoView({ block: 'center' }); return; }
    send({ type: cmd, id: id });
  });

  if (!DETACHED) document.querySelector('.tabs').addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    var i = TABS.indexOf(tab), next = TABS[(i + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next); $('tab-' + next).focus();
  });

  if (DETACHED) {
    $('subtitle').textContent = T.previewTitle;
    $('detached-actions').innerHTML = button('⛶ ' + T.fullscreen, { cmd: 'fullscreen', cls: 'primary', aria: T.fullscreen }) + button('↩ ' + T.attach, { cmd: 'attach', aria: T.attachLabel });
    return;
  }
  $('subtitle').textContent = T.subtitle;
  $('devtoggle').textContent = '</> ' + T.devMode;
  $('tab-recording').textContent = T.tabRecording; $('tab-analysis').textContent = T.tabAnalysis; $('tab-preview').textContent = T.tabPreview;
  document.querySelector('.tabs').setAttribute('aria-label', T.tabs);
  $('head').setAttribute('aria-label', T.recording);
  setInterval(tickTimer, 1000);
})();
`;
