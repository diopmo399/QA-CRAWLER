import {
  brandLogo,
  THEME_BASE_CSS,
  THEME_BOOT_SCRIPT,
  THEME_TOGGLE_SCRIPT,
  themeToggle,
} from '../reporting/theme.js';

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
${THEME_BOOT_SCRIPT}
<style>${CSS}</style>
</head>
<body data-mode="preview">
<header class="topbar">
  ${brandLogo(30)}
  <span class="brand">QA-CRAWLER</span>
  <span class="subtitle" id="subtitle"></span>
  <span class="state small" id="state" aria-live="polite"></span>
  <span class="spacer"></span>
  <span class="actions-top" id="detached-actions"></span>
  ${themeToggle(language)}
</header>
<main class="detached-main"><section class="card preview detached" id="preview-detached" aria-live="polite"></section></main>
<div id="live" class="sr-only" aria-live="polite"></div>
<script>${SCRIPT}</script>
${THEME_TOGGLE_SCRIPT}
</body>
</html>`;
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER Recorder</title>
${THEME_BOOT_SCRIPT}
<style>${CSS}</style>
</head>
<body data-mode="main">
<header class="topbar">
  ${brandLogo(30)}
  <span class="brand">QA-CRAWLER</span>
  <span class="subtitle" id="subtitle"></span>
  <span class="spacer"></span>
  <button type="button" class="devtoggle" id="layouttoggle" aria-pressed="false"></button>
  <button type="button" class="devtoggle" id="devtoggle" aria-pressed="false"></button>
  ${themeToggle(language)}
</header>
<section class="statusbar" id="head" aria-label="">
  <h1 id="state" class="state" aria-live="polite"></h1>
  <span class="live" id="livepill"></span>
  <span class="sep" aria-hidden="true"></span>
  <span class="timer" id="timer" aria-label=""></span>
  <span class="count" id="count"></span>
  <span class="livesearch" id="livesearch" role="status" hidden></span>
  <span class="spacer"></span>
  <span class="alert" id="headalert" role="status" hidden></span>
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
    <div id="story"></div>
    <div id="detached-note"></div>
    <div class="grid" id="grid">
      <div class="col-left">
        <section class="card journey" aria-labelledby="timeline-title">
          <header class="card-head"><h2 id="timeline-title"></h2><span class="badge" id="journey-count"></span><div class="tl-tools" id="tltools"><label class="tl-search"><span class="sr-only" id="tlsearch-label"></span><input type="search" id="tlsearch" aria-labelledby="tlsearch-label"></label><button type="button" id="tlattention" aria-pressed="false"></button></div></header>
          <p class="status-line" id="summary" role="status"></p>
          <ol id="timeline" class="timeline"></ol>
          <div id="checks"></div>
        </section>
        <section class="card quality" id="quality"></section>
      </div>
      <div class="col-side">
        <aside class="card details col-right" id="details" aria-live="polite"></aside>
        <section class="card preview col-mid" id="preview-card"></section>
      </div>
    </div>
  </section>
  <section id="panel-analysis" role="tabpanel" aria-labelledby="tab-analysis" hidden></section>
  <section id="panel-preview" role="tabpanel" aria-labelledby="tab-preview" hidden><div class="card preview" id="preview-full"></div></section>
</main>
<footer class="summarybar" id="summarybar"></footer>
<div id="live" class="sr-only" aria-live="polite"></div>
<script>${SCRIPT}</script>
${THEME_TOGGLE_SCRIPT}
</body>
</html>`;
}

const CSS = `
:root{color-scheme:light;
  --bg:#F3F4F8;--surface:#FFFFFF;--surface-2:#F7F7FB;--fg:#111827;--muted:#5B6478;--line:#E4E7EF;--line-strong:#D6DAE4;
  --accent:#4F46E5;--accent-soft:#EEF2FF;--accent-fg:#FFFFFF;--title:#4338CA;--ok-fg:#FFFFFF;--muted-strong:#374151;--chip-bg:#F1F2F8;--chip-fg:#374151;--ok-text:#15803D;
  --ok:#15803D;--ok-soft:#F0FDF4;--warn:#B45309;--warn-soft:#FFFBEB;--bad:#B91C1C;--bad-soft:#FEF2F2;--run:#4F46E5;--run-soft:#EEF2FF;--idle:#C7CCD8;--idle-soft:#F1F2F8;
  --violet:#6D28D9;--violet-soft:#F3EEFF;--teal:#0F766E;--teal-soft:#E6FAF7;--orange:#4338CA;--orange-soft:#EEF2FF;--pink:#1D4ED8;--pink-soft:#E8F0FE;
  --radius:14px;--shadow:0 1px 2px rgba(16,24,40,.05);--focus:#4F46E5;--ring:#E0E7FF;--bad-line:#FECACA;--ok-line:#BBF7D0;
  --accent-2:#7C3AED;--text:var(--fg);--text-2:var(--muted-strong);--nav-hover:#F1F2F8;
}
:root[data-theme="dark"]{color-scheme:dark;
  --bg:#0B0E17;--surface:#111726;--surface-2:#161C2D;--fg:#E6E9F2;--muted:#9AA3B8;--line:#1F2638;--line-strong:#2A3248;
  --accent:#6366F1;--accent-soft:#1C1A4A;--accent-fg:#FFFFFF;--title:#C7D2FE;--ok-fg:#052E16;--muted-strong:#C9CFDD;--chip-bg:#1A2133;--chip-fg:#C9CFDD;--ok-text:#4ADE80;
  --ok:#22C55E;--ok-soft:#0E3B22;--warn:#F59E0B;--warn-soft:#2A1F0C;--bad:#EF4444;--bad-soft:#2A1215;--run:#818CF8;--run-soft:#1C1A4A;--idle:#64748B;--idle-soft:#1A2133;
  --violet:#A78BFA;--violet-soft:#2E1F6B;--teal:#5EEAD4;--teal-soft:#0E3B33;--orange:#A5B4FC;--orange-soft:#1C1A4A;--pink:#93C5FD;--pink-soft:#0F1B3A;
  --shadow:none;--focus:#A5B4FC;--ring:#2E2A7A;--bad-line:#7F1D1D;--ok-line:#14532D;
  --accent-2:#8B5CF6;--nav-hover:#161C2D;
}
${THEME_BASE_CSS}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI","Helvetica Neue",sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;min-height:100vh}
button{font:inherit;cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);border-radius:10px;padding:6px 14px;min-height:36px;font-weight:600;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,box-shadow .15s}
button:hover:not(:disabled){border-color:var(--muted)}
button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,[tabindex]:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button.success{background:var(--ok);border-color:var(--ok);color:var(--ok-fg)}
button.danger{background:var(--bad);border-color:var(--bad);color:#fff}
button.outline-accent{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
button.ghost{border-color:transparent;background:none;color:var(--muted)}
button svg{width:15px;height:15px;flex:none}
button.primary,button.success,button.confirm{box-shadow:none}
button.confirm{background-color:var(--ok);border-color:var(--ok);color:var(--ok-fg)}
button.soft{background:var(--accent-soft);border-color:transparent;color:var(--title)}
button.soft:hover:not(:disabled){border-color:var(--accent)}
button.neutral{background:var(--idle-soft);border-color:transparent}
button.subtle{background:var(--surface-2);border-color:var(--line-strong);color:var(--fg)}
button.primary:hover:not(:disabled),button.success:hover:not(:disabled),button.confirm:hover:not(:disabled){filter:brightness(1.05)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.spacer{flex:1}
.topbar{display:flex;align-items:center;gap:14px;padding:10px 24px;background:var(--surface);border-bottom:1px solid var(--line)}
.logo{display:block;flex:none}
.brand{font-weight:700;font-size:17px;letter-spacing:.02em}
.topbar .qa-theme-toggle{width:38px;height:38px;min-height:0}
.subtitle{color:var(--muted);padding-left:10px;border-left:1px solid var(--line)}
.devtoggle{border-radius:8px;font-size:12px;color:var(--muted)}
.devtoggle[aria-pressed=true]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.statusbar{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin:16px 24px 0;padding:14px 24px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.state{font-size:18px;font-weight:700;margin:0;display:inline-flex;align-items:center;gap:8px}
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
.alert{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px;background:var(--warn-soft);border:1px solid var(--warn);color:var(--warn);font-size:13px;font-weight:600}
.timer{font:500 20px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.count{font-size:13px;color:var(--muted)}
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
.tabs{display:flex;gap:4px;margin:14px 24px 0;border-bottom:1px solid var(--line)}
.tabs [role=tab]{border:0;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:none;padding:8px 14px;min-height:40px;color:var(--muted);font-weight:600;font-size:14px}
.tabs [role=tab]:hover{color:var(--fg)}
.tabs [role=tab][aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent)}
main{flex:1;padding:16px 24px 24px;min-height:0}
.grid{display:grid;grid-template-columns:1fr;gap:20px;align-items:start}
.col-mid{display:none}
/* Grand écran : une application (en-tête et résumé fixes, la zone centrale défile) ; le détail et
   l'aperçu restent visibles pendant qu'on fait défiler un long parcours. */
@media (min-width:780px) and (min-height:560px){
  body[data-mode=main]{height:100vh;overflow:hidden}
  /* Chaque colonne défile pour elle-même : un long détail (correction) ne pousse plus le parcours,
     et le parcours se parcourt sans perdre le détail de vue. */
  body[data-mode=main] main{overflow:hidden;display:flex;flex-direction:column}
  body[data-mode=main] main>[role=tabpanel]{flex:1;min-height:0;overflow:auto}
  body[data-mode=main] #panel-recording{display:flex;flex-direction:column;overflow:hidden}
  body[data-mode=main] #review{flex:none;max-height:45%;overflow:auto}
  body[data-mode=main] .grid{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}
  body[data-mode=main] .grid>.col-left{min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;align-content:start}
  body[data-mode=main] .grid>.col-side{max-height:100%}
  /* Le détail passe en premier (il garde sa hauteur, défile s'il est très long) ; l'aperçu prend le reste. */
  body[data-mode=main] .col-side>.col-right{flex:0 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
  body[data-mode=main] .col-side>.col-mid{flex:1 1 0;min-height:52px;overflow:auto}
}
@media (min-width:780px){
  .grid{grid-template-columns:minmax(0,1fr) minmax(320px,400px)}
  .grid>.col-left{grid-column:1}
  .grid>.col-side{grid-column:2;display:flex;flex-direction:column;gap:12px;min-height:0}
  .col-mid{display:block}
}
.col-left{display:grid;gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px}
.card-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.card-head h2,.card h2{margin:0;font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.card-head .actions{margin-left:auto;display:flex;gap:6px}
.badge{font-size:12px;font-weight:700;border-radius:6px;padding:2px 8px;background:var(--accent-soft);color:var(--title);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.status-line{margin:0 0 12px;font-size:12px;font-weight:600;border-radius:8px;padding:6px 10px;background:var(--surface-2);color:var(--muted)}
.status-line.ok{background:var(--ok-soft);color:var(--ok)} .status-line.warn{background:var(--warn-soft);color:var(--warn)} .status-line.run{background:var(--run-soft);color:var(--run)}
.timeline{list-style:none;margin:0;padding:0}
.timeline>li{position:relative;padding:0 0 8px 0}
.timeline>li::before{display:none}
.timeline>li:last-child::before{display:none}
.item{position:relative;display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-weight:400}
.item:hover:not(:disabled){border-color:var(--line-strong);background:var(--surface-2)}
.item[aria-current=true]{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
.dot{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;background:var(--idle)}
.CONFIRMED .dot{background:var(--ok)} .PENDING .dot{background:var(--run)} .AMBIGUOUS .dot{background:var(--warn)} .FAILED .dot{background:var(--bad)} .UNVERIFIED .dot{background:var(--surface);color:transparent;border:2px solid var(--idle)}
.num{color:var(--muted);font:500 12px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace;min-width:22px}
.kind{flex:none;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.kind svg{width:18px;height:18px}
.kind.k-fill{background:var(--teal-soft);color:var(--teal)} .kind.k-check,.kind.k-uncheck,.kind.k-choose{background:var(--violet-soft);color:var(--violet)}
.kind.k-click{background:var(--orange-soft);color:var(--orange)} .kind.k-select,.kind.k-key{background:var(--pink-soft);color:var(--pink)}
.desc{flex:1;min-width:0;font-weight:600;word-break:break-word}
.desc .sub{display:block;color:var(--muted);font-weight:400;font-size:12px}
.pill{display:flex;width:max-content;align-items:center;gap:4px;margin-top:4px;font-size:12px;font-weight:600;border-radius:6px;padding:0;background:transparent;color:var(--muted)}
.CONFIRMED .pill{color:var(--ok)} .PENDING .pill{color:var(--run)} .AMBIGUOUS .pill{color:var(--warn)} .FAILED .pill{color:var(--bad)}
.PENDING .pill::after{content:"";width:9px;height:9px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
.chev{color:var(--idle);align-self:center;font-size:18px}
.tech{display:block;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:pre-wrap;margin-top:6px;background:var(--surface-2);border-radius:6px;padding:6px 8px;font-weight:400}
.attention{margin:8px 0 0;padding:10px 12px;border-radius:10px;background:var(--warn-soft)}
.attention p{margin:0 0 8px}
.attention .row,.row{display:flex;gap:8px;flex-wrap:wrap}
.attention fieldset{border:0;padding:0;margin:6px 0 10px}
.attention legend{font-weight:700;margin-bottom:6px}
.attention label{display:flex;gap:8px;align-items:center;padding:8px 10px;margin-bottom:6px;border-radius:8px;background:var(--surface);border:1px solid var(--line);cursor:pointer}
.attention label:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.attention label span{flex:1;min-width:0;word-break:break-word}
.attention label em{font-style:normal;font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--ok-soft);color:var(--ok);flex:none}
.attention .sub{margin:0 0 6px}
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
.details .step{display:inline-block;font:500 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin-bottom:10px}
.details .hero{display:flex;gap:12px;align-items:center;padding:12px;border:0;border-radius:10px;background:var(--surface-2);margin-bottom:14px}
.details .hero b{display:block;font-size:14px}
.details .hero span{color:var(--muted);font-size:12px}
.details h3{margin:14px 0 8px;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.02em}
.details dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 12px;margin:0;font-size:13px;border:0;padding:0}
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
.review{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:12px 16px;margin-bottom:12px;box-shadow:var(--shadow)}
.review h2{margin:0;font-size:16px;color:var(--ok)}
.review .hint{margin:0;color:var(--muted)}
.result{flex:1 1 420px;border-radius:12px;padding:10px 14px;margin:0;border:1px solid var(--line)}
.result .rhead{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}
.result .rmeta{flex:1 1 260px;margin:0!important}
.result .rhead .actions{margin-left:auto}
.result.resume{background:var(--accent-soft);border-color:var(--accent)} .result.resume .sub{margin:4px 0 0}
.result .recov{margin:4px 0 0;font-weight:600}
.result details{margin-bottom:0}
.result.ok{background:var(--ok-soft);border-color:var(--ok-soft)} .result.bad{background:var(--surface);border-color:var(--bad-line);border-left:4px solid var(--bad)}
/* CORRECTION MANAGER : ancienne cible → nouvelle cible, ordre de résolution, mode sélection. */
.correction{margin-top:14px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--surface)}
.correction .chead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.correction .chead h3{margin:0;font-size:14px;font-weight:700;color:var(--fg);letter-spacing:0}
.cbadge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;background:var(--warn-soft);color:var(--warn);white-space:nowrap}
.cbadge.done{background:var(--ok-soft);color:var(--ok)}
.pickbadge{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:8px;background:var(--accent-soft);color:var(--title);font-size:12px;font-weight:700}
.pickbadge::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none;animation:pulse 1.6s infinite}
.pair{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);gap:10px;align-items:stretch;margin:10px 0}
.tbox{border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}
.tbox b{display:block;font-size:11px;font-weight:700;margin-bottom:4px;letter-spacing:.04em}
.tbox code{display:block;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:var(--fg)}
.tbox span{display:block;font-size:12px;color:var(--muted);margin-top:4px}
.tbox.old{border-color:var(--bad-line);background:var(--bad-soft)} .tbox.old b{color:var(--bad)}
.tbox.new{border-color:var(--ok-line);background:var(--ok-soft)} .tbox.new b{color:var(--ok)}
.pair .arrow{display:grid;place-items:center;color:var(--muted);font-size:18px}
.correction .order{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--surface-2);font-size:12px;margin:10px 0}
.correction .order b{display:block;margin-bottom:6px}
.correction .order ol{margin:0;padding-left:18px;display:grid;gap:2px;color:var(--muted-strong)}
.correction .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.correction .row .grow{flex:1;justify-content:center}
/* Tester / Annuler / Valider restent visibles pendant que le détail de la correction défile. */
.correction .row.cta{position:sticky;bottom:-18px;margin:10px -2px 0;padding:8px 2px;background:var(--surface);border-top:1px solid var(--line)}
.correction .warnnote{margin:6px 0 0;font-size:12px;color:var(--warn);font-weight:600}
.rowopts{border:1px solid var(--line);border-radius:10px;padding:8px 12px 10px;margin:10px 0 0;display:grid;gap:6px;background:var(--surface-2)}
.rowopts legend{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--muted-strong);padding:0 4px}
.rowopts label.choice{display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:12px}
.rowopts label.choice input{margin-top:2px}
.rowopts label.choice span{display:grid;gap:1px} .rowopts label.choice small{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere}
.rowopts label.fixed small{color:var(--warn)}
.chist{display:grid;grid-template-columns:90px minmax(0,1fr);gap:5px 10px;font-size:12px;margin:8px 0}
.chist .k{color:var(--muted)} .chist code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.correction dl{margin:0}
.result.ok>b{color:var(--ok)} .result.bad>b{color:var(--bad);font-size:16px}
.result ul{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:3px}
.result p{margin:6px 0}
.result details{margin:8px 0 12px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--surface-2)} .result details summary{cursor:pointer;font-weight:600} .result details ul{list-style:none;margin:6px 0 0;padding:0} .result details .tech{background:transparent;padding:2px 0;margin:0}
.result .actions{display:flex;gap:8px;flex-wrap:wrap}
.summarybar{position:sticky;bottom:0;display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:14px 24px;background:var(--surface);border-top:1px solid var(--line);box-shadow:0 -2px 10px rgba(15,23,42,.04)}
.summarybar h2{margin:0;font-size:12px;font-weight:700;color:var(--muted-strong);width:100%}
.stat{display:flex;align-items:center;gap:9px;padding-right:14px;border-right:1px solid var(--line)}
.stat:last-of-type{border-right:0}
.stat .i{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff;box-shadow:0 0 0 3px var(--surface),0 1px 3px rgba(15,23,42,.18)}
.stat b{display:block;font-size:16px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.stat span{font-size:12px;color:var(--muted-strong)}
.i-actions{background:var(--ok)} .i-ok{background:var(--ok)} .i-amb{background:var(--warn)} .i-bad{background:var(--bad)} .i-time{background:var(--muted-strong)}
.summarybar .buttons{margin-left:auto;display:flex;gap:10px;flex-wrap:wrap}
.summarybar .buttons button{min-height:42px;padding:8px 16px;font-size:14px}
.card-plain{margin-bottom:10px}
.card .meta{color:var(--muted);font-size:12px;margin-top:2px}
.card .tag{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--accent-soft);color:var(--accent);margin-right:6px}
.notice.running::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;border:2px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px}
.notice{background:var(--accent-soft);border-radius:8px;padding:10px 12px;font-size:12px}
.empty{color:var(--muted);font-style:italic}
.bflow{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.bstep{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--surface)}
.bstep.CONFIRMED{border-left:4px solid var(--ok)} .bstep.PROBABLE{border-left:4px solid var(--run)}
.bhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bref{margin-top:4px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.bbadge{font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--idle-soft);color:var(--muted)}
.bbadge.CONFIRMED{background:var(--ok-soft);color:var(--ok)} .bbadge.PROBABLE{background:var(--run-soft);color:var(--run)} .bbadge.AMBIGUOUS{background:var(--warn-soft);color:var(--warn)}
.barrow{text-align:center;color:var(--muted)}
.bprov{font-size:11px;font-weight:600;border-radius:6px;padding:1px 8px;margin-left:6px;background:var(--idle-soft);color:var(--muted)}
.bprov.CREATED_DURING_RECORDING{background:var(--ok-soft);color:var(--ok)} .bprov.DISCOVERED_DURING_RECORDING,.bprov.CONFIRMED_EXISTING{background:var(--run-soft);color:var(--run)} .bprov.AMBIGUOUS{background:var(--warn-soft);color:var(--warn)}
.atree,.atree ul{list-style:none;margin:6px 0 0;padding:0 0 0 16px;border-left:1px dashed var(--line)} .atree{padding-left:0;border-left:0}
.atree li{margin:6px 0} .atree .anode{display:flex;flex-wrap:wrap;align-items:center;gap:6px} .atree .anode b{font-size:13px}
.ibadge{font-size:11px;font-weight:700;border-radius:6px;padding:1px 8px;background:var(--idle-soft);color:var(--muted)}
.ibadge.CONFIRMED{background:var(--ok-soft);color:var(--ok)} .ibadge.OBSERVED{background:var(--run-soft);color:var(--run)} .ibadge.UNCERTAIN{background:var(--warn-soft);color:var(--warn)}
.bent{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px} .bent li{border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.bstep details{margin-top:4px} .bstep summary{cursor:pointer;color:var(--muted);font-size:12px}
.bunres{padding-left:18px}
.sub{color:var(--muted);font-size:12px}
@media (max-width:640px){
  .subtitle{display:none}.topbar{padding:8px 12px}
  .statusbar,.tabs,.progress{margin-left:12px;margin-right:12px}.statusbar{padding:12px 14px}.state{font-size:16px}.alert{flex-basis:100%}
  .tl-tools{margin-left:0;flex-basis:100%}.tl-search input{width:auto}
  .statusbar{gap:8px}.statusbar .sep{display:none}.controls{flex-basis:100%}
  .tabs{overflow-x:auto}.tabs [role=tab]{padding:8px 10px;white-space:nowrap}
  main{padding:12px}
  /* Le résumé reste en bas, compact : les nombres et les boutons, les libellés pour les lecteurs d'écran. */
  .summarybar{padding:8px 12px;gap:8px}.summarybar h2{display:none}
  .stat{padding-right:8px;gap:5px}.stat .i{width:20px;height:20px;font-size:10px}.stat b{font-size:13px}
  .stat div span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .summarybar .buttons{margin-left:0;width:100%}.summarybar .buttons button{flex:1;justify-content:center}
  .quality .qbody{flex-direction:column;align-items:stretch}.ring{margin:0 auto}
  .details dl{grid-template-columns:1fr}.details dt{font-weight:700}
}
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
/* A · COCKPIT : la recherche reconnue en direct, les groupes (écran, étape métier), la recherche dans le parcours et « À vérifier seulement ». */
.livesearch{display:inline-flex;align-items:center;gap:6px;max-width:520px;font-size:12px;font-weight:600;border-radius:8px;padding:4px 10px;background:var(--run-soft);color:var(--run);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.livesearch::before{content:"⌕";font-size:14px}
.timeline>li.group{padding:10px 0 4px 0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.timeline>li.group::before{display:none}
.tl-tools{display:flex;gap:8px;align-items:center;margin-left:auto}
.tl-search{flex:1;display:flex}
.tl-search input{flex:1;min-width:0;width:200px;min-height:36px;font:inherit;font-size:13px;border:1px solid var(--line-strong);border-radius:8px;padding:6px 12px;background:var(--surface);color:var(--fg)}
#tlattention[aria-pressed=true]{background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
/* B · ÉTAPES MÉTIER (revue) : des cartes numérotées au-dessus du détail des actions. */
.story{display:grid;gap:10px;margin-bottom:12px}
.story h2{margin:0;font-size:14px}
.scard{display:grid;grid-template-columns:auto 1fr auto;gap:6px 12px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 14px}
.scard .n{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--fg);color:var(--surface);font-weight:800}
.scard b{font-size:14px}
.scard .chips{grid-column:2/4;display:flex;flex-wrap:wrap;gap:6px}
.scard .chips span{font-size:12px;border-radius:6px;padding:2px 8px;background:var(--surface-2);border:1px solid var(--line)}
.scard .obs{grid-column:2/4;color:var(--muted);font-size:12px}
/* C · INSPECTEUR : la requête reliée à l'action. */
.netcard{border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:grid;gap:4px;font-size:12px;margin-bottom:6px}
.netcard code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.netcard .crit{border-radius:6px;padding:4px 8px;background:var(--accent-soft)}
/* D · ANALYSE : la recherche en tableau, une jauge de confiance, des jetons. */
.stable{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}
.stable th{text-align:left;font-size:11px;color:var(--muted);font-weight:700;padding:4px 8px}
.stable td{padding:8px;border-top:1px solid var(--line);vertical-align:top}
.stable code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.meter{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700}
.meter .track{width:110px;height:7px;border-radius:999px;background:var(--line);overflow:hidden}
.meter .track span{display:block;height:100%;background:var(--ok)}
.tokens{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.tokens span{font-size:12px;border-radius:6px;padding:3px 9px;background:var(--surface-2);border:1px solid var(--line)}
.tokens span.from{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.search{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px}
.search .shead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.search .shead .meter{margin-left:auto}
/* REVUE DES INTENTIONS : l'intention finale, sa provenance, l'original, la correction, l'historique. */
#intent-review>h2{color:var(--fg);font-size:18px;font-weight:800;letter-spacing:-.01em;margin-bottom:4px}
#intent-review>.sub{color:var(--muted-strong);font-size:13px;line-height:1.65;margin:0 0 14px}
.irow{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:10px;display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:4px 14px;background:var(--surface);box-shadow:0 1px 2px rgba(15,23,42,.05),0 2px 8px rgba(15,23,42,.04)}
.irow>*{grid-column:2}
.irow .iico{grid-column:1;grid-row:1/3;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.irow .iico svg{width:18px;height:18px}
.irow.HUMAN_CORRECTED{border-left:4px solid var(--violet)} .irow.HUMAN_CONFIRMED{border-left:4px solid var(--ok)}
.irow .ilabel{font-weight:700;font-size:14px;color:var(--fg)}
.irow .iline{font-size:13px;color:var(--muted-strong);margin:2px 0}
.irow .iintent{font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.irow .iconf{color:var(--ok-text);font-weight:600}
.irow .imeta{color:var(--muted);font-size:12px}
.irow .iactions{grid-row:1/3;grid-column:3;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}
.irow .full{grid-column:2/4}
.isrc{font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px;background:var(--chip-bg);color:var(--chip-fg)}
.isrc.HUMAN_CORRECTED{background:var(--violet-soft);color:var(--violet)} .isrc.HUMAN_CONFIRMED{background:var(--ok-soft);color:var(--ok)}
.iedit{grid-column:2/4;border-radius:8px;background:var(--surface-2);padding:10px;margin-top:4px}
.iedit fieldset{border:0;padding:0;margin:0 0 8px;display:flex;flex-wrap:wrap;gap:6px}
.iedit legend{font-weight:700;margin-bottom:6px;width:100%}
.iedit label.choice{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line-strong);border-radius:8px;padding:4px 10px;background:var(--surface);cursor:pointer;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace}
.iedit label.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.iedit textarea{width:100%;min-height:54px;font:inherit;border:1px solid var(--line-strong);border-radius:8px;padding:6px 8px;background:var(--surface);color:var(--fg)}
.databind input[type=text],.databind select{width:100%;font:inherit;border:1px solid var(--line-strong);border-radius:8px;padding:6px 8px;background:var(--surface);color:var(--fg);margin:2px 0 8px}
.databind .dsub{display:block;font-size:12px;color:var(--muted-strong);margin:6px 0 2px}
.databind .dref{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.databind .dref label.choice{justify-content:flex-start;font-family:inherit;font-weight:600}
.databind .dref label.choice small{display:block;font-weight:400;color:var(--muted-strong)}
.databind .dnote{font-size:12px;color:var(--muted-strong);margin:4px 0 8px}
.databind .dnote.manual{color:var(--violet)}
.lineage{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.lineage>li{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--surface)}
.lineage code{font-weight:700;color:var(--fg)}
.lineage .uses{list-style:disc;margin:6px 0 0 18px;padding:0;color:var(--muted-strong);font-size:12px}
@media (max-width:640px){.irow{grid-template-columns:32px minmax(0,1fr);padding:12px}.irow .iico{width:32px;height:32px;grid-row:1}.irow .iactions{grid-column:2;grid-row:auto;justify-content:flex-start}.irow .full,.iedit{grid-column:2}}
/* E · MINI-DOCK : une fenêtre étroite et sombre pendant l'enregistrement (la revue reste complète). */
body.compact{--title:#C7D2FE;--ok-fg:#052E16;--muted-strong:#C9CFDD;--chip-bg:#1A2133;--chip-fg:#C9CFDD;--ok-text:#4ADE80;--bg:#0B0E17;--surface:#111726;--surface-2:#161C2D;--fg:#E6E9F2;--muted:#9AA3B8;--line:#1F2638;--line-strong:#2A3248;--accent:#6366F1;--accent-soft:#1C1A4A;--accent-fg:#FFFFFF;--ok:#22C55E;--ok-soft:#0E3B22;--warn:#F59E0B;--warn-soft:#2A1F0C;--bad:#EF4444;--bad-soft:#2A1215;--run:#818CF8;--run-soft:#1C1A4A;--teal:#5EEAD4;--teal-soft:#0E3B33;--violet:#DDD6FE;--violet-soft:#2E1F6B;--orange:#A5B4FC;--orange-soft:#1C1A4A;--shadow:none;--ring:#2E2A7A;--text:var(--fg);--text-2:var(--muted-strong);--nav-hover:#161C2D}
body.compact .tabs,body.compact .col-side,body.compact .col-mid,body.compact .col-right,body.compact #quality,body.compact .subtitle,body.compact #devtoggle,body.compact .summarybar,body.compact #tltools,body.compact #checks,body.compact .sep,body.compact #livepill{display:none!important}
body.compact .grid{grid-template-columns:1fr!important}
body.compact .statusbar{margin:8px 10px 0}
body.compact main{padding:8px 10px}
body.compact .livesearch{max-width:100%;flex-basis:100%;white-space:normal}
body.compact .timeline>li:not(.group):nth-last-child(n+6),body.compact .timeline>li.group{display:none}
body.compact .controls{flex-basis:100%}
/* ÉCRAN DE PORTABLE (étroit ou peu haut, mise à l'échelle Windows 125–150 %) : la même fenêtre, plus
   dense — en-tête, barre d'état, onglets, cartes et résumé prennent moins de hauteur ; le parcours garde la place. */
@media (max-width:1400px),(max-height:820px){
  /* ÉCRAN DE PORTABLE (échelle Windows 125–150 %) : tout est plus serré, le parcours tient sur une
     ligne par action, le détail reste lisible sans défiler. */
  .topbar{padding:4px 14px;gap:8px}.brand{font-size:14px}.topbar .logo{width:22px;height:22px}.subtitle{font-size:12px}.devtoggle{min-height:28px;padding:3px 9px;font-size:11px}.topbar .qa-theme-toggle{width:30px;height:30px}
  .statusbar{margin:6px 14px 0;padding:4px 12px;gap:10px;flex-wrap:nowrap}.state{font-size:14px}.state::before{width:9px;height:9px}.timer{font-size:15px}.alert{padding:2px 8px;font-size:11px}
  .statusbar .count{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.statusbar .spacer{display:none}
  .controls{flex:none;gap:6px}.controls button{min-height:28px;padding:2px 10px;font-size:13px}.controls .note{flex-basis:auto}
  .progress{margin:6px 14px 0}
  .tabs{margin:4px 14px 0}.tabs [role=tab]{padding:3px 10px;min-height:28px;font-size:13px}
  main{padding:6px 14px 6px}.grid{gap:10px}.col-left{gap:8px}.grid>.col-side{gap:10px}.card{padding:9px 11px;border-radius:10px}.card-head{margin-bottom:6px;gap:8px}.card-head h2,.card h2{font-size:14px}
  .tl-search input{min-height:28px;width:150px;padding:3px 10px;font-size:12px}#tlattention{min-height:28px;padding:3px 10px;font-size:12px}
  .status-line{margin-bottom:6px;padding:3px 8px;font-size:11px}.timeline>li{padding-bottom:4px}
  .item{padding:4px 9px;gap:7px;border-radius:9px}.dot{width:20px;height:20px;font-size:10px}.num{min-width:14px;font-size:11px}.kind{width:26px;height:26px;border-radius:7px}.kind svg{width:14px;height:14px}
  .desc{font-size:13px;display:flex;flex-wrap:wrap;align-items:baseline;column-gap:8px;row-gap:0}.desc .sub{display:inline;font-size:11px}.desc .tech{flex-basis:100%}
  .pill{margin:0 0 0 auto;font-size:11px}.chev{font-size:15px}
  .attention{margin-top:6px;padding:8px 10px}.attention label{padding:5px 8px;margin-bottom:4px}.checks{margin-top:2px}
  .quality .qbody{gap:10px}.ring{width:64px;height:64px}.ring>div{width:50px;height:50px}.ring b{font-size:15px}.ring span{font-size:10px}.quality ul{gap:2px;font-size:11px}
  .review{padding:6px 12px;margin-bottom:6px;gap:6px 12px}.review h2{font-size:14px}.review:has(.result)>h2,.review:has(.result)>.hint{display:none}.result{padding:5px 10px}.result.bad .rhead>b{font-size:13px}.result p{margin:3px 0}.result ul{margin-top:3px}.result details{margin:3px 0 0;padding:3px 9px}.result .actions{gap:6px}.result .actions button{min-height:26px;padding:2px 9px;font-size:12px}
  .preview .card-head{flex-wrap:nowrap}.preview .card-head .actions button{min-height:26px;padding:2px 8px;font-size:12px}
  .correction .chead h3,.correction .chead button{white-space:nowrap}.correction .chead button{flex:none;min-height:24px;padding:2px 7px;font-size:11px}.correction .chead button svg{display:none}.correction .row.cta{bottom:-9px;margin-top:6px;padding:6px 2px;gap:5px}.correction .row.cta button{white-space:nowrap;padding:3px 8px;font-size:12px}
  .details .step{display:none}.details .hero{padding:6px 9px;margin-bottom:8px;gap:8px}.details .hero b{font-size:13px}.details .hero span{font-size:11px}
  .details h3{margin:8px 0 4px;font-size:11px}.details dl{gap:3px 10px;font-size:12px;grid-template-columns:96px minmax(0,1fr)}.vlist{padding:6px 8px;gap:3px;font-size:11px}.details .found{margin-top:6px;padding:5px 8px}.details .logs{margin-top:6px}
  .correction{padding:7px 10px;margin-top:8px;border-radius:10px}.correction .chead{margin-bottom:5px;gap:8px}.correction .chead h3{font-size:12px}.correction .chead button{min-height:26px;padding:2px 9px;font-size:12px}
  .pair{gap:6px;margin:6px 0}.tbox{padding:6px 8px;border-radius:8px}.tbox code{font-size:11px}.tbox span{font-size:11px;margin-top:2px}
  .correction .order{padding:6px 9px;margin:6px 0;font-size:11px}.correction .order ol{gap:0}.correction .row{margin-top:6px;gap:6px}.correction .row button{min-height:28px;padding:3px 10px;font-size:12px}
  .correction .warnnote,.correction .sub{font-size:11px;margin-top:4px}.rowopts{padding:5px 9px 7px;margin-top:6px;gap:3px}.rowopts label.choice{font-size:11px}.rowopts label.choice small{font-size:10px}.chist{gap:2px 8px;font-size:11px;margin:5px 0}
  .pickbadge{padding:3px 9px;font-size:11px}.cbadge{font-size:10px}
  .summarybar{padding:4px 14px;gap:10px}.summarybar h2{display:none}.stat{gap:5px;padding-right:9px}.stat .i{width:20px;height:20px;font-size:10px;box-shadow:0 0 0 2px var(--surface)}.stat b{font-size:12px}.stat span{font-size:10px}
  .summarybar .buttons{gap:6px}.summarybar .buttons button{min-height:30px;padding:3px 10px;font-size:12px}
  .selnote{margin-top:6px;padding:6px 9px}.preview .url{padding:3px 8px;margin-bottom:6px}
}
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
      toCheck: function (n) { return n + ' action' + (n > 1 ? 's' : '') + ' à vérifier avant le rejeu'; },
      ambiguousTitle: '⚠ Action ambiguë', matches: function (n) { return n + ' éléments correspondent.'; },
      resolve: 'Résoudre', ignore: 'Ignorer', confirm: 'Confirmer', cancel: 'Annuler',
      validate: '✓ Valider cet élément', show: '👁 Montrer dans la page', touchedTag: 'touché',
      ambHelp: "Le rejeu pourrait viser un autre élément. Vérifiez dans la page l'élément mis en évidence, puis validez-le.",
      which: 'Quel élément voulez-vous enregistrer ?',
      notTouched: "Ce n'est pas l'élément que vous avez touché : annulez l'action (↶) et refaites-la sur le bon élément.",
      ignored: 'Laissée telle quelle : elle sera vérifiée au rejeu.',
      detailsTitle: "Détails de l'action", close: 'Fermer',
      compact: '▭ Compact', full: '▣ Complet', layoutLabel: 'Basculer entre la fenêtre complète et le mini-dock',
      tlSearch: 'Chercher une action', onlyAttention: 'À vérifier seulement', noMatch: 'Aucune action ne correspond.',
      storyTitle: 'Le parcours en étapes métier', linked: 'Requête liée', linkedNone: 'Aucune requête métier reliée à cette action.',
      fieldL: 'Champ de l’écran', propL: 'Propriété API', stateL: 'État',
      dataTitle: 'Source de la valeur', srcFixed: 'Valeur enregistrée', srcGenerated: 'Générer une nouvelle valeur', srcReference: 'Réutiliser une donnée existante', variableL: 'Variable', generatorL: 'Générateur', fixedValueL: 'Valeur', reuseFrom: 'Réutiliser depuis', noData: 'Aucune donnée de test disponible.', stepWord: 'Étape', suggestedL: function (k) { return 'Détecté automatiquement : réutilise ' + k + ' (une proposition, modifiable).'; }, manualL: 'Choix explicite : il l’emporte sur la détection automatique.', dataSave: 'Enregistrer la source', sensitiveData: 'Valeur secrète : lue depuis une variable d’environnement, jamais liée à une donnée.', lineageTitle: 'Données de test', lineageNote: 'Chaque variable, l’étape qui la produit et celles qui la réutilisent (au rejeu : une seule valeur par run).', producedL: 'produite à l’étape', usedL: 'utilisée par', strategyL: { GENERATE_AT_REPLAY: 'générée', TEMPLATE: 'modèle', RECORDED_LITERAL: 'valeur enregistrée', BUSINESS_LITERAL: 'valeur fixe', REFERENCE: 'référence', PRESERVE_EXISTING: 'gardée' },
      reviewTitle: 'Actions et intentions', reviewNote: 'L’intention est une interprétation : la corriger ne change ni l’action enregistrée, ni sa cible, ni le flow rejoué.',
      intentL: 'Intention', sourceL: 'Source', originalL: 'Original', initialConf: 'Confiance initiale', correctionL: 'Correction', proposalL: 'Proposition de l’analyse (non appliquée)',
      src: { INFERRED: 'SYSTEM', HUMAN_CORRECTED: '👤 HUMAN', HUMAN_CONFIRMED: '👤 HUMAN CONFIRMED' },
      modifyIntent: 'Modifier l’intention', confirmIntent: 'Confirmer', resetIntent: 'Réinitialiser l’interprétation', applyIntent: 'Confirmer', cancelIntent: 'Annuler',
      newIntent: 'Nouvelle intention', justification: 'Justification (facultative)', historyL: 'Historique',
      field: { event: 'Action', kind: 'Action', name: 'Élément', label: 'Libellé', text: 'Texte', role: 'Rôle', tag: 'Type', selector: 'Sélecteur', page: 'Page', section: 'Section', matches: 'Correspondances', validation: 'Validation', frame: 'Cadre', rawEventId: 'Événement', target: 'Cible', provenance: 'Provenance', locator: 'Localisateur', raw: 'Événements bruts', step: 'Étape', decision: 'Décision', resolution: 'Résolution', shadowDom: 'Shadow DOM', field: 'Champ', sensitive: 'Sensible' },
      found: { ORIGINAL: "✓ Élément mis en évidence dans la page", SELECTOR: '✓ Élément retrouvé par son sélecteur et mis en évidence', NOT_FOUND: '⚠ Élément introuvable sur la page actuelle' },
      quality: 'Qualité du recording', checksQ: { confirmed: 'Actions confirmées', stable: 'Sélecteurs stables', unique: 'Cibles uniques', rerender: 'Aucun élément retrouvé après un nouveau rendu', duplicates: 'Aucun doublon', errors: 'Aucune erreur' },
      noQuality: 'La qualité se calcule dès la première action validée.',
      done: 'Enregistrement terminé ✓', recorded: function (n) { return '<b>' + n + '</b> action' + (n > 1 ? 's' : '') + ' enregistrée' + (n > 1 ? 's' : ''); },
      confirmedS: function (n) { return '<b>' + n + '</b> confirmée' + (n > 1 ? 's' : ''); }, ambS: function (n) { return '<b>' + n + '</b> ambiguïté' + (n > 1 ? 's' : ''); },
      duration: 'Durée', replay: '▶ Rejouer', edit: 'Modifier', editing: 'Terminer les modifications', save: '💾 Sauvegarder', saveFlow: '💾 Sauvegarder le flow', finish: 'Fermer', restart: '↻ Recommencer',
      recommend: 'Conseillé : rejouez le flow avant de le sauvegarder.',
      replaying: function (a, b) { return 'Rejeu en cours… étape ' + a + ' sur ' + b; },
      replayOk: '✓ Replay réussi', executed: function (a, b) { return a + ' / ' + b + ' actions exécutées'; },
      replayBad: '✕ Replay interrompu', stepOf: function (a, b) { return 'Étape ' + a + ' sur ' + b; }, cause: 'Cause', seeDetails: 'Voir les détails', editStep: "Modifier l'étape",
      resumeTitle: function (n, d) { return 'Contexte gardé devant l’étape ' + n + ' · ' + d; }, resumeHelp: "La page de l'application est restée dans l'état de cette étape (même run, mêmes données). Reprendre vérifie le contexte, puis rejoue l'étape corrigée et la suite.",
      resumeHere: 'Reprendre ici', restartFromStart: 'Rejouer depuis le début', resumedAt: function (n, s) { return 'Repris à l’étape ' + n + ' · ' + s; }, resumeBlocked: function (n, s) { return 'Reprise bloquée à l’étape ' + n + ' · ' + s; },
      strategy: { REVALIDATE: 'contexte vérifié', RESTORE: 'champs restaurés', REBUILD: 'contexte reconstruit', MANUAL_RECOVERY: 'reprise manuelle requise' },
      recoveredSteps: function (l) { return 'Étapes rejouées pour le contexte : ' + l; },
      saved: '✓ Flow sauvegardé', remove: '✕ Retirer cette étape', removeLabel: function (d) { return "Retirer l'étape « " + d + ' » du flow'; },
      checks: function (n) { return 'Vérifications ajoutées au flow (' + n + ')'; }, checksNote: 'Déduites des résultats observés : ce ne sont pas des actions enregistrées.',
      analysisTitle: 'Analyse', analysisNote: "L'analyse ne modifie jamais le recording. Elle est disponible après l'arrêt.", analysisWaiting: "L'analyse sera disponible après l'arrêt de l'enregistrement.",
      business: 'Interprétation métier', businessNote: "Déduite du parcours enregistré : jamais une étape ajoutée au flow.", noBusiness: 'Aucune interprétation métier sûre.', recordedActions: 'Actions enregistrées', observed: 'Observé', deduced: 'Déduit', uncertain: 'Incertain (jamais une vérité métier)', candidatesL: 'Possibles', bstatus: { CONFIRMED: 'Confirmé', PROBABLE: 'Probable', AMBIGUOUS: 'Ambigu', UNKNOWN: 'Inconnu' }, aiChoice: 'choix de l’IA parmi les candidats observés', referenceL: 'référence', baction: { create: 'CRÉER', search: 'RECHERCHER', retrieve: 'RETROUVER', correlate: 'CORRÉLER', open: 'OUVRIR', update: 'MODIFIER', save: 'ENREGISTRER', delete: 'SUPPRIMER' }, entitiesL: 'Entités observées', applicationL: 'Application', applicationNote: 'Ce que le Recorder comprend de l’application (contextes, tasks, entités, relations). Les actions techniques restent dans le parcours.', evidenceL: 'Preuves', istatus: { OBSERVED: 'Observé', DEDUCED: 'Déduit', CONFIRMED: 'Confirmé', UNCERTAIN: 'Incertain' }, actionLevels: function (c) { return c.recorded + ' actions enregistrées · ' + c.validated + ' validées · ' + c.interpreted + ' interprétées · ' + c.uninterpreted + ' non interprétées (UNKNOWN, normal pour une application inconnue)'; }, provenanceL: { CREATED_DURING_RECORDING: 'créée pendant l’enregistrement', CONFIRMED_EXISTING: 'existait déjà (écran de départ)', DISCOVERED_DURING_RECORDING: 'découverte (origine inconnue)', UNKNOWN: 'provenance inconnue', AMBIGUOUS: 'provenance ambiguë' },
      httpLive: function (h) { return h.network + ' requêtes · ' + h.correlated + ' reliées · ' + h.hypotheses + ' hypothèses' + (h.inconsistencies ? ' · ' + h.inconsistencies + ' incohérences' : '') + (h.failed ? ' · analyse en erreur' : '') + ' (provisoire)'; }, httpL: 'Analyse HTTP', httpNote: 'Requêtes, corrélations et correspondances : consolidées après l’arrêt (un « VALIDATED » exige des preuves suffisantes ; le reste est une hypothèse).', httpFailed: 'L’analyse différée a échoué : les événements bruts et le journal réseau sont conservés.', httpCounts: function (c) { return c.events + ' événements · ' + c.network + ' requêtes · ' + c.correlated + ' reliées · ' + c.independent + ' indépendantes · ' + c.hypotheses + ' hypothèses à confirmer · ' + c.inconsistencies + ' incohérences · ' + c.revisions + ' révisions du direct'; }, httpMappings: 'Champ ↔ propriété', httpIncons: 'Incohérences', httpRevisions: 'Révisions', intents: 'Intents métier', noIntent: 'Aucun intent métier (aucune écriture ni recherche métier corrélée).', searchL: 'Recherche', critL: 'Critères détectés', apiL: 'API', opL: 'Opérateur', valL: 'Valeur', logicL: 'Logique', sortL: 'Tri', paramsL: 'Paramètres techniques', techL: 'Classification technique (distincte)', fromCreateL: 'valeur issue de la création', searchesL: 'Recherches reconnues', roles: { PAGINATION: 'pagination', OPTION: 'options d’inclusion', CONTEXT: 'contexte', CRITERION_FLAG: 'indicateurs de critère' }, liveSearch: 'recherche détectée', technicalIntents: 'Intents techniques (jamais métier)', possibleCreate: 'création possible, non prouvée', confidence: 'Confiance', why: 'Voir pourquoi', findings: 'Constats et suggestions', noFinding: 'Aucun constat.', ai: function (n) { return n + ' suggestion(s) de connaissance proposée(s) par l’IA (à revoir).'; },
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
      toCheck: function (n) { return n + ' action' + (n === 1 ? '' : 's') + ' to check before the replay'; },
      ambiguousTitle: '⚠ Ambiguous action', matches: function (n) { return n + ' elements match.'; },
      resolve: 'Resolve', ignore: 'Ignore', confirm: 'Confirm', cancel: 'Cancel',
      validate: '✓ Validate this element', show: '👁 Show in the page', touchedTag: 'touched',
      ambHelp: 'The replay could aim at another element. Check the highlighted element in the page, then validate it.',
      which: 'Which element do you want to record?',
      notTouched: 'This is not the element you touched: undo the action (↶) and do it again on the right element.',
      ignored: 'Left as is: it will be checked at replay.',
      detailsTitle: 'Action details', close: 'Close',
      compact: '▭ Compact', full: '▣ Full', layoutLabel: 'Switch between the full window and the mini dock',
      tlSearch: 'Find an action', onlyAttention: 'To check only', noMatch: 'No action matches.',
      storyTitle: 'The journey as business steps', linked: 'Linked request', linkedNone: 'No business request linked to this action.',
      fieldL: 'Screen field', propL: 'API property', stateL: 'State',
      dataTitle: 'Value source', srcFixed: 'Recorded value', srcGenerated: 'Generate a new value', srcReference: 'Reuse an existing data', variableL: 'Variable', generatorL: 'Generator', fixedValueL: 'Value', reuseFrom: 'Reuse from', noData: 'No test data available.', stepWord: 'Step', suggestedL: function (k) { return 'Detected automatically: reuses ' + k + ' (a suggestion, editable).'; }, manualL: 'Explicit choice: it wins over the automatic detection.', dataSave: 'Save the source', sensitiveData: 'Secret value: read from an environment variable, never bound to test data.', lineageTitle: 'Test data', lineageNote: 'Each variable, the step producing it and the steps reusing it (at replay: one value per run).', producedL: 'produced at step', usedL: 'used by', strategyL: { GENERATE_AT_REPLAY: 'generated', TEMPLATE: 'template', RECORDED_LITERAL: 'recorded value', BUSINESS_LITERAL: 'fixed value', REFERENCE: 'reference', PRESERVE_EXISTING: 'kept' },
      reviewTitle: 'Actions and intents', reviewNote: 'The intent is an interpretation: correcting it changes neither the recorded action, nor its target, nor the replayed flow.',
      intentL: 'Intent', sourceL: 'Source', originalL: 'Original', initialConf: 'Initial confidence', correctionL: 'Correction', proposalL: 'Analysis proposal (not applied)',
      src: { INFERRED: 'SYSTEM', HUMAN_CORRECTED: '👤 HUMAN', HUMAN_CONFIRMED: '👤 HUMAN CONFIRMED' },
      modifyIntent: 'Modify the intent', confirmIntent: 'Confirm', resetIntent: 'Reset the interpretation', applyIntent: 'Confirm', cancelIntent: 'Cancel',
      newIntent: 'New intent', justification: 'Justification (optional)', historyL: 'History',
      field: { event: 'Action', kind: 'Action', name: 'Element', label: 'Label', text: 'Text', role: 'Role', tag: 'Type', selector: 'Selector', page: 'Page', section: 'Section', matches: 'Matches', validation: 'Validation', frame: 'Frame', rawEventId: 'Event', target: 'Target', provenance: 'Provenance', locator: 'Locator', raw: 'Raw events', step: 'Step', decision: 'Decision', resolution: 'Resolution', shadowDom: 'Shadow DOM', field: 'Field', sensitive: 'Sensitive' },
      found: { ORIGINAL: '✓ Element highlighted in the page', SELECTOR: '✓ Element found by its selector and highlighted', NOT_FOUND: '⚠ Element not found on the current page' },
      quality: 'Recording quality', checksQ: { confirmed: 'Actions confirmed', stable: 'Stable selectors', unique: 'Unique targets', rerender: 'No element found again after a re-render', duplicates: 'No duplicate', errors: 'No error' },
      noQuality: 'Quality is computed from the first validated action.',
      done: 'Recording finished ✓', recorded: function (n) { return '<b>' + n + '</b> action' + (n === 1 ? '' : 's') + ' recorded'; },
      confirmedS: function (n) { return '<b>' + n + '</b> confirmed'; }, ambS: function (n) { return '<b>' + n + '</b> ambiguit' + (n === 1 ? 'y' : 'ies'); },
      duration: 'Duration', replay: '▶ Replay', edit: 'Edit', editing: 'Done editing', save: '💾 Save', saveFlow: '💾 Save the flow', finish: 'Close', restart: '↻ Try again',
      recommend: 'Recommended: replay the flow before saving it.',
      replaying: function (a, b) { return 'Replaying… step ' + a + ' of ' + b; },
      replayOk: '✓ Replay passed', executed: function (a, b) { return a + ' / ' + b + ' actions executed'; },
      replayBad: '✕ Replay stopped', stepOf: function (a, b) { return 'Step ' + a + ' of ' + b; }, cause: 'Cause', seeDetails: 'See the details', editStep: 'Edit the step',
      resumeTitle: function (n, d) { return 'Context kept before step ' + n + ' · ' + d; }, resumeHelp: 'The application page stayed in the state of this step (same run, same data). Resuming checks the context, then replays the corrected step and the rest.',
      resumeHere: 'Resume here', restartFromStart: 'Replay from the start', resumedAt: function (n, s) { return 'Resumed at step ' + n + ' · ' + s; }, resumeBlocked: function (n, s) { return 'Resume blocked at step ' + n + ' · ' + s; },
      strategy: { REVALIDATE: 'context verified', RESTORE: 'fields restored', REBUILD: 'context rebuilt', MANUAL_RECOVERY: 'manual resume required' },
      recoveredSteps: function (l) { return 'Steps replayed for the context: ' + l; },
      saved: '✓ Flow saved', remove: '✕ Remove this step', removeLabel: function (d) { return 'Remove the step "' + d + '" from the flow'; },
      checks: function (n) { return 'Checks added to the flow (' + n + ')'; }, checksNote: 'Inferred from the observed results: these are not recorded actions.',
      analysisTitle: 'Analysis', analysisNote: 'The analysis never changes the recording. It is available after Stop.', analysisWaiting: 'The analysis will be available once the recording is stopped.',
      business: 'Business interpretation', businessNote: 'Deduced from the recorded journey: never a step added to the flow.', noBusiness: 'No reliable business interpretation.', recordedActions: 'Recorded actions', observed: 'Observed', deduced: 'Deduced', uncertain: 'Uncertain (never a business fact)', candidatesL: 'Possible', bstatus: { CONFIRMED: 'Confirmed', PROBABLE: 'Probable', AMBIGUOUS: 'Ambiguous', UNKNOWN: 'Unknown' }, aiChoice: 'AI choice among the observed candidates', referenceL: 'reference', baction: { create: 'CREATE', search: 'SEARCH', retrieve: 'RETRIEVE', correlate: 'CORRELATE', open: 'OPEN', update: 'UPDATE', save: 'SAVE', delete: 'DELETE' }, entitiesL: 'Observed entities', applicationL: 'Application', applicationNote: 'What the Recorder understands of the application (contexts, tasks, entities, relations). The technical actions stay in the journey.', evidenceL: 'Evidence', istatus: { OBSERVED: 'Observed', DEDUCED: 'Deduced', CONFIRMED: 'Confirmed', UNCERTAIN: 'Uncertain' }, actionLevels: function (c) { return c.recorded + ' recorded actions · ' + c.validated + ' validated · ' + c.interpreted + ' interpreted · ' + c.uninterpreted + ' not interpreted (UNKNOWN, normal for an unknown application)'; }, provenanceL: { CREATED_DURING_RECORDING: 'created during the recording', CONFIRMED_EXISTING: 'already existed (starting screen)', DISCOVERED_DURING_RECORDING: 'discovered (origin unknown)', UNKNOWN: 'unknown provenance', AMBIGUOUS: 'ambiguous provenance' },
      httpLive: function (h) { return h.network + ' requests · ' + h.correlated + ' linked · ' + h.hypotheses + ' hypotheses' + (h.inconsistencies ? ' · ' + h.inconsistencies + ' inconsistencies' : '') + (h.failed ? ' · analysis error' : '') + ' (provisional)'; }, httpL: 'HTTP analysis', httpNote: 'Requests, correlations and mappings: consolidated after the stop (VALIDATED needs sufficient evidence; the rest is a hypothesis).', httpFailed: 'The deferred analysis failed: the raw events and the network journal are kept.', httpCounts: function (c) { return c.events + ' events · ' + c.network + ' requests · ' + c.correlated + ' linked · ' + c.independent + ' independent · ' + c.hypotheses + ' hypotheses to confirm · ' + c.inconsistencies + ' inconsistencies · ' + c.revisions + ' revisions of the live analysis'; }, httpMappings: 'Field ↔ property', httpIncons: 'Inconsistencies', httpRevisions: 'Revisions', intents: 'Business intents', noIntent: 'No business intent (no correlated business write or search).', searchL: 'Search', critL: 'Detected criteria', apiL: 'API', opL: 'Operator', valL: 'Value', logicL: 'Logic', sortL: 'Sort', paramsL: 'Technical parameters', techL: 'Technical classification (separate)', fromCreateL: 'value from the creation', searchesL: 'Recognised searches', roles: { PAGINATION: 'pagination', OPTION: 'inclusion options', CONTEXT: 'context', CRITERION_FLAG: 'criterion flags' }, liveSearch: 'search detected', technicalIntents: 'Technical intents (never business)', possibleCreate: 'possible creation, not proven', confidence: 'Confidence', why: 'See why', findings: 'Findings and suggestions', noFinding: 'No finding.', ai: function (n) { return n + ' knowledge suggestion(s) proposed by the AI (to review).'; },
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
      replayFlow: 'Rejouer le parcours', saveFlow2: 'Sauvegarder le flow', afterStop: "Disponible après l'arrêt de l'enregistrement",
      pill: { CONFIRMED: 'Confirmée', PENDING: 'En cours', AMBIGUOUS: 'Ambiguë', FAILED: 'Échec', UNVERIFIED: 'Non vérifiable' },
      kindName: { open: 'Navigation', navigate: 'Navigation', click: 'Click', fill: 'Saisie', check: 'Case à cocher', uncheck: 'Case à cocher', choose: 'Choix', select: 'Sélection', key: 'Touche', drag: 'Glisser-déposer', upload: 'Fichier', dialog: 'Dialogue', goto: 'Navigation', dragAndDrop: 'Glisser-déposer', manual: 'Manuel' },
      qualityShort: 'Qualité', seeDetail: 'Voir le détail',
      analysisRunning: "Analyse par l'intelligence en cours, en arrière-plan : vous pouvez déjà rejouer et sauvegarder.",
      fullscreen: 'Plein écran', detach: 'Détacher', detachLabel: "Détacher l'aperçu dans sa propre fenêtre", attach: 'Rattacher', attachLabel: "Rattacher l'aperçu à la fenêtre principale",
      detachedNote: "L'aperçu de l'application est ouvert dans sa propre fenêtre (plein écran possible).",
      cTitle: function (n) { return "Correction de l'étape " + n; }, cInBrowser: 'Corriger dans le navigateur', cPickActive: 'Mode sélection actif · Échap pour quitter',
      cPickHelp: "Dans la fenêtre de l'application : survolez pour encadrer, cliquez pour choisir. Le clic n'est pas transmis à l'application.",
      cCancelled: 'Sélection annulée : la cible ne change pas.', cUnavailable: "La page de l'application n'est pas disponible pour la sélection.",
      cPreparing: function (a, b) { return 'Rejeu des étapes précédentes… ' + a + ' sur ' + b; }, cPreparingHelp: "Le même chemin est suivi par le moteur de rejeu (connexion, données du run) jusqu'à l'étape à corriger ; la page reste ouverte ensuite.",
      cUnreachable: function (i, l) { return "Le chemin s'arrête avant cette étape : l'étape " + i + ' « ' + l + " » n'a pas pu être rejouée."; }, cUnreachableHelp: "Corrigez d'abord cette étape-là, puis revenez à celle-ci.",
      cOld: 'ANCIENNE CIBLE', cNew: 'NOUVELLE CIBLE', cProposed: 'PROPOSÉE', cCorrected: 'CORRIGÉE', cRole: 'Rôle', cName: 'Nom accessible', cText: 'Texte', cTestId: 'testId', cCss: 'CSS de repli', cContext: 'Contexte',
      cOrder: 'Ordre de résolution au rejeu', cTest: "Tester l'étape", cCancel: 'Annuler', cApply: 'Valider la correction', cAmbiguous: 'Plusieurs éléments correspondent encore : la section ou le contexte départagera au rejeu.',
      cRowTitle: 'Identifier la ligne par', cRowBound: function (v) { return 'La donnée du run « ' + v + ' »'; }, cRowBoundHelp: 'La ligne créée pendant le run est retrouvée à chaque rejeu, quelle que soit sa clé.',
      cRowKey: 'La clé lue dans le tableau', cRowFixed: 'Clé propre à ce run : le prochain rejeu crée une autre ligne et ne la retrouvera pas.',
      cHistory: 'Historique des corrections', cOriginal: 'Original', cCorrection: 'Correction', cBy: 'Corrigé par', cUser: 'Utilisateur', cDate: 'Date', cRestore: "Restaurer l'original", cUnknown: 'non retrouvée', cCurrent: 'Cible actuelle'
    },
    en: {
      subtitle: 'Journey recording', devMode: 'Developer mode', active: 'Active', inactive: 'Paused',
      tabPreview: 'Preview', previewTitle: 'Application preview', refresh: 'Refresh', noPreview: 'The page preview appears after the first action.',
      selected: 'Element selected in the page', isHighlighted: function (l) { return '"' + l + '" is highlighted'; }, notFoundShort: 'Not found on the current page',
      stepOf2: function (a, b) { return 'Step ' + a + ' of ' + b; }, general: 'General information', selectors: 'Selectors and attributes', validation: 'Validation', logs: 'See the technical logs', copy: 'Copy', copied: 'Copied',
      pick: 'Select an action to see its details.', hideDetails: 'Hide the details',
      summaryTitle: 'Recording summary', sActions: 'Actions', sConfirmed: 'Confirmed', sAmbiguous: 'Ambiguous', sFailed: 'Failed', sDuration: 'Duration',
      replayFlow: 'Replay the journey', saveFlow2: 'Save the flow', afterStop: 'Available once the recording is stopped',
      pill: { CONFIRMED: 'Confirmed', PENDING: 'In progress', AMBIGUOUS: 'Ambiguous', FAILED: 'Failed', UNVERIFIED: 'Not verifiable' },
      kindName: { open: 'Navigation', navigate: 'Navigation', click: 'Click', fill: 'Typing', check: 'Checkbox', uncheck: 'Checkbox', choose: 'Choice', select: 'Select', key: 'Key', drag: 'Drag and drop', upload: 'File', dialog: 'Dialog', goto: 'Navigation', dragAndDrop: 'Drag and drop', manual: 'Manual' },
      qualityShort: 'Quality', seeDetail: 'See the detail',
      analysisRunning: 'Intelligence analysis running in the background: you can already replay and save.',
      fullscreen: 'Full screen', detach: 'Detach', detachLabel: 'Detach the preview into its own window', attach: 'Reattach', attachLabel: 'Reattach the preview to the main window',
      detachedNote: 'The application preview is open in its own window (full screen available).',
      cTitle: function (n) { return 'Correction of step ' + n; }, cInBrowser: 'Correct in the browser', cPickActive: 'Selection mode on · Esc to quit',
      cPickHelp: 'In the application window: hover to frame, click to choose. The click is not passed to the application.',
      cCancelled: 'Selection cancelled: the target does not change.', cUnavailable: 'The application page is not available for the selection.',
      cPreparing: function (a, b) { return 'Replaying the previous steps… ' + a + ' of ' + b; }, cPreparingHelp: 'The same path is followed by the replay engine (login, run data) up to the step to correct; the page then stays open.',
      cUnreachable: function (i, l) { return 'The path stops before this step: step ' + i + ' "' + l + '" could not be replayed.'; }, cUnreachableHelp: 'Correct that step first, then come back to this one.',
      cOld: 'OLD TARGET', cNew: 'NEW TARGET', cProposed: 'PROPOSED', cCorrected: 'CORRECTED', cRole: 'Role', cName: 'Accessible name', cText: 'Text', cTestId: 'testId', cCss: 'Fallback CSS', cContext: 'Context',
      cOrder: 'Resolution order at replay', cTest: 'Test the step', cCancel: 'Cancel', cApply: 'Confirm the correction', cAmbiguous: 'Several elements still match: the section or the context decides at replay.',
      cRowTitle: 'Identify the row by', cRowBound: function (v) { return 'The run value "' + v + '"'; }, cRowBoundHelp: 'The row created during the run is found at every replay, whatever its key.',
      cRowKey: 'The key read in the table', cRowFixed: 'Key specific to this run: the next replay creates another row and will not find it.',
      cHistory: 'Correction history', cOriginal: 'Original', cCorrection: 'Correction', cBy: 'Corrected by', cUser: 'User', cDate: 'Date', cRestore: 'Restore the original', cUnknown: 'not found', cCurrent: 'Current target'
    }
  }[lang];
  Object.keys(X).forEach(function (k) { T[k] = X[k]; });

  var ICON = { CONFIRMED: '✓', PENDING: '●', AMBIGUOUS: '!', FAILED: '✕', UNVERIFIED: '' };
  // Pictogrammes des gestes (SVG complets) : une table à part, jamais la même que celle des boutons (SVG).
  var KIND_SVG = {
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
  var state = null, selected = null, choice = {}, dev = false, editing = false, tab = 'recording';
  var focused = null, scrolledTo = null;
  // L'option de ligne choisie pour une correction (bound, key), par étape : gardée entre deux rendus.
  var rowChoice = {};
  // Le brouillon de la source de chaque saisie (revue) : gardé entre deux rendus de la fenêtre.
  var dataDraft = {};
  var filterText = '', onlyAttention = false, layout = null, editingIntent = null;
  var storedLayout = function () { try { return window.localStorage.getItem('qa-recorder-layout'); } catch (e) { return null; } };
  var storeLayout = function (v) { try { window.localStorage.setItem('qa-recorder-layout', v); } catch (e) { /* stockage indisponible */ } };
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

  // Pictogrammes fixes (jamais une donnée de l'application) : décoratifs, le libellé reste le nom du bouton.
  var SVG = {
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    play: '<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>',
    disk: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    cursor: '<path d="M6 3l12 9-5.5 1.2L10 19z"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    drag: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    dot: '<circle cx="12" cy="12" r="4"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (SVG[name] || SVG.dot) + '</svg>'; }
  function kindSvg(kind) { return KIND_SVG[KIND_ICON[kind]] || KIND_SVG.hash; }
  function kindIcon(kind) {
    var k = String(kind || '').toUpperCase();
    return k.indexOf('NAVIGAT') >= 0 || k === 'GOTO' ? 'arrow' : k.indexOf('DRAG') >= 0 ? 'drag' : k.indexOf('SELECT') >= 0 || k.indexOf('CHECK') >= 0 ? 'list' : k.indexOf('TYPE') >= 0 || k.indexOf('FILL') >= 0 || k.indexOf('PRESS') >= 0 ? 'keyboard' : k.indexOf('CLICK') >= 0 ? 'cursor' : 'dot';
  }

  function button(label, attrs) {
    var a = attrs || {};
    return '<button type="button"' + (a.cls ? ' class="' + a.cls + '"' : '') + (a.cmd ? ' data-cmd="' + a.cmd + '"' : '') + (a.id ? ' data-id="' + esc(a.id) + '"' : '') + (a.aria ? ' aria-label="' + esc(a.aria) + '"' : '') + (a.title ? ' title="' + esc(a.title) + '"' : '') + (a.disabled ? ' disabled' : '') + '>' + (a.icon ? svg(a.icon) : '') + esc(label) + '</button>';
  }

  function renderHead() {
    var p = state.phase, st = $('state');
    st.className = 'state ' + (p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working');
    st.textContent = (p === 'RECORDING' ? T.recording : p === 'PAUSED' ? '⏸ ' + T.paused : p === 'FINALIZING' ? T.finalizing : '✓ ' + T.review);
    var pill = $('livepill');
    pill.textContent = p === 'RECORDING' ? T.active : p === 'PAUSED' ? T.inactive : '';
    pill.className = 'live' + (p === 'PAUSED' ? ' off' : '');
    $('count').textContent = T.actions(state.summary.actions) + (state.http && recordingPhase() ? ' · ' + T.httpLive(state.http) : '');
    var ls = $('livesearch'), search = state.http && recordingPhase() ? state.http.search : '';
    ls.hidden = !search;
    ls.textContent = search ? T.liveSearch + ' : ' + search : '';
    // E · la disposition : le choix de l'humain (gardé), sinon recording.panelLayout ; la revue est complète.
    if (layout === null) layout = storedLayout() || state.layout || 'full';
    var compact = layout === 'compact' && p !== 'REVIEW' && p !== 'FINALIZING';
    document.body.classList.toggle('compact', compact);
    var lt = $('layouttoggle');
    lt.textContent = layout === 'compact' ? T.full : T.compact;
    lt.setAttribute('aria-pressed', String(layout === 'compact'));
    lt.hidden = p === 'REVIEW' || p === 'FINALIZING';
    var c = '';
    if (recordingPhase()) {
      c += button(T.pause, { cmd: 'pause', cls: p === 'RECORDING' ? 'outline-accent' : '', aria: T.pauseLabel, disabled: p === 'PAUSED' });
      c += button(T.resume, { cmd: 'resume', cls: p === 'PAUSED' ? 'primary' : '', aria: T.resumeLabel, disabled: p !== 'PAUSED' });
      c += button(T.stop, { cmd: 'stop', cls: 'danger', aria: T.stopLabel });
      c += button(T.undo, { cmd: 'undo', aria: T.undoLabel, disabled: state.actions.length <= 1 });
      if (p === 'PAUSED') c += '<p class="note" role="note">' + esc(T.pausedNote) + '</p>';
    }
    setHtml($('controls'), c);
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
    var alert = $('headalert');
    alert.hidden = !(s.attention > 0 && state.phase === 'REVIEW');
    alert.textContent = s.attention > 0 ? '⚠ ' + T.toCheck(s.attention) : '';
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
    $('tlsearch-label').textContent = T.tlSearch;
    $('tlsearch').setAttribute('placeholder', T.tlSearch);
    var att = $('tlattention');
    att.textContent = T.onlyAttention; att.setAttribute('aria-pressed', String(onlyAttention));
    var needle = filterText.trim().toLowerCase();
    var visible = state.actions.filter(function (step) {
      if (onlyAttention && step.status !== 'AMBIGUOUS' && step.status !== 'FAILED') return false;
      return !needle || (step.description + ' ' + (step.detail || '')).toLowerCase().indexOf(needle) >= 0;
    });
    var lastGroup = null;
    var html = visible.map(function (step) {
      var head = '';
      if (step.group && step.group !== lastGroup && !needle && !onlyAttention) head = '<li class="group">' + esc(step.group) + '</li>';
      lastGroup = step.group || lastGroup;
      return head + stepHtml(step);
    }).join('');
    if (!html && state.actions.length) html = '<li class="empty">' + esc(T.noMatch) + '</li>';
    setHtml($('timeline'), html || '<li class="empty">' + esc(T.empty) + '</li>');
    var checks = state.checks || [];
    setHtml($('checks'), checks.length ? '<details class="checks"><summary>' + esc(T.checks(checks.length)) + '</summary><p class="sub">' + esc(T.checksNote) + '</p><ul>' + checks.map(function (c) { return '<li>' + esc(c.description) + '</li>'; }).join('') + '</ul></details>' : '');
  }

  function stepHtml(step) {
    {
      var current = selected === step.id;
      var h = '<li data-step="' + esc(step.id) + '">';
      h += '<button type="button" class="item ' + step.status + '" data-cmd="select" data-id="' + esc(step.id) + '" aria-current="' + current + '" aria-label="' + esc(step.index + '. ' + step.description + ' — ' + T.status[step.status]) + '">';
      h += '<span class="dot" aria-hidden="true">' + ICON[step.status] + '</span><span class="num">' + step.index + '</span>';
      h += '<span class="kind k-' + esc(step.kind) + '" aria-hidden="true">' + kindSvg(step.kind) + '</span><span class="desc">';
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
        // Le choix est là tout de suite : l'élément touché (présélectionné), les autres correspondances.
        var cands = step.candidates && step.candidates.length ? step.candidates : [{ index: -1, original: true, label: T.touchedTag }];
        h += '<p class="sub">' + esc(T.ambHelp) + '</p><fieldset><legend>' + esc(T.which) + '</legend>' + cands.map(function (c) {
          return '<label class="cand' + (c.original ? ' touched' : '') + '"><input type="radio" name="cand-' + esc(step.id) + '" value="' + c.index + '"' + ((choice[step.id] !== undefined ? choice[step.id] === c.index : c.original) ? ' checked' : '') + '><span>' + esc(c.label) + '</span>' + (c.original ? '<em>' + esc(T.touchedTag) + '</em>' : '') + '</label>';
        }).join('') + '</fieldset><div class="row">' + button(T.validate, { cmd: 'confirm-resolve', id: step.id, cls: 'primary' }) + button(T.show, { cmd: 'show', id: step.id }) + button(T.ignore, { cmd: 'ignore', id: step.id, cls: 'ghost' }) + '</div>';
        if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message === 'NOT_TOUCHED' ? T.notTouched : state.notice.message) + '</p>';
        h += '</div>';
      }
      if (editing && step.removable) h += '<div class="remove">' + button(T.remove, { cmd: 'remove', id: step.id, aria: T.removeLabel(step.description) }) + '</div>';
      return h + '</li>';
    }
  }

  /** B · les étapes métier de la revue, en cartes numérotées (le détail des actions reste dessous). */
  function renderStory() {
    var el = $('story'), b = state.analysis && state.analysis.business;
    if (state.phase !== 'REVIEW' || !b || !b.steps.length) { setHtml(el, ''); return; }
    var h = '<section class="story" aria-label="' + esc(T.storyTitle) + '"><h2>' + esc(T.storyTitle) + '</h2>';
    h += b.steps.map(function (st, i) {
      return '<article class="scard"><span class="n" aria-hidden="true">' + (i + 1) + '</span><b>' + esc((T.baction[st.action] || st.action) + ' ' + st.entity) + '</b><span class="bbadge ' + st.status + '">' + esc(T.bstatus[st.status]) + ' · ' + Math.round(st.confidence * 100) + ' %</span>'
        + (st.recorded.length ? '<div class="chips">' + st.recorded.map(function (r) { return '<span>' + esc(short(r, 48)) + '</span>'; }).join('') + '</div>' : '')
        + (st.observed.length ? '<div class="obs">' + esc(T.observed) + ' : ' + esc(st.observed[0]) + '</div>' : '') + '</article>';
    }).join('');
    setHtml(el, h + '</section>');
  }

  var GENERAL = ['kind', 'event', 'name', 'label', 'text', 'role', 'tag', 'page', 'section', 'field', 'provenance', 'locator', 'decision', 'resolution'];
  var SELECTORS = ['selector', 'target', 'frame', 'matches', 'rawEventId', 'raw', 'step', 'shadowDom', 'sensitive'];

  function renderDetails() {
    var box = $('details');
    var step = state.actions.find(function (s) { return s.id === selected; });
    if (!step) { setHtml(box, '<header class="card-head"><h2>' + esc(T.detailsTitle) + '</h2></header><p class="empty-details">' + esc(T.pick) + '</p>'); return; }
    var t = step.technical;
    var h = '<header class="card-head"><h2>' + esc(T.detailsTitle) + '</h2><span class="actions">' + button('✕', { cmd: 'deselect', cls: 'ghost', aria: T.hideDetails }) + '</span></header>';
    h += '<span class="step">' + esc(T.stepOf2(step.index, state.actions.length)) + '</span>';
    h += '<div class="hero"><span class="kind k-' + esc(step.kind) + '" aria-hidden="true">' + kindSvg(step.kind) + '</span><div><b>' + esc(step.description) + '</b><span>' + esc(step.detail || step.statusText) + '</span></div></div>';
    h += correctionBlock(step);
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
    h += dataBlock(step);
    h += '<h3>' + esc(T.linked) + '</h3>';
    h += step.network && step.network.length ? step.network.map(function (n) {
      return '<div class="netcard"><code>' + esc(n.api) + (n.status !== undefined ? ' · ' + n.status : '') + '</code><span class="sub">' + esc(n.operation + ' · ' + n.link) + '</span>' + n.criteria.map(function (c) { return '<span class="crit">' + esc(c) + '</span>'; }).join('') + (n.extras.length ? '<span class="sub">' + esc(n.extras.join(' · ')) + '</span>' : '') + '</div>';
    }).join('') : '<p class="sub">' + esc(T.linkedNone) + '</p>';
    h += '<details class="logs"><summary>' + esc(T.logs) + '</summary><span class="tech">' + esc(techLines(step)) + '</span></details>';
    setHtml(box, h);
  }

  /**
   * CORRECTION MANAGER : corriger la cible d'une étape dans le navigateur. Au repos : le bouton et, si la
   * cible a déjà été corrigée, l'historique (Restaurer l'original). En mode sélection : le badge actif.
   * Élément désigné : ancienne cible → nouvelle cible, ses traits, l'ordre de résolution, Tester / Annuler / Valider.
   */
  function correctionBlock(step) {
    if (!step.correctable || state.phase === 'FINALIZING') return '';
    var pk = state.pick && state.pick.stepId === step.id ? state.pick : null;
    var running = state.replay && state.replay.status === 'RUNNING';
    var corr = step.correction;
    var corrected = corr && corr.corrected;
    var busy = pk && (pk.status === 'PREPARING' || pk.status === 'PICKING' || pk.status === 'PICKED');
    var h = '<section class="correction" aria-label="' + esc(T.cTitle(step.index)) + '"><div class="chead"><h3>' + esc(T.cTitle(step.index)) + '</h3>';
    if (pk && pk.status === 'PICKED') h += '<span class="cbadge">' + esc(T.cProposed) + '</span>';
    else if (corrected) h += '<span class="cbadge done">' + esc(T.cCorrected) + '</span>';
    // Au repos, le bouton tient sur la ligne du titre (pas une rangée de plus).
    if (!busy) h += '<span class="spacer"></span>' + button(T.cInBrowser, { cmd: 'correct-pick', id: step.id, cls: 'soft', icon: 'cursor', disabled: running });
    h += '</div>';
    if (pk && pk.status === 'PREPARING') {
      var pg = pk.progress || { executed: 0, total: 0 };
      h += '<div class="pickbadge" role="status">' + esc(T.cPreparing(pg.executed, pg.total)) + '</div><p class="sub">' + esc(T.cPreparingHelp) + '</p>';
      h += '<div class="row">' + button(T.cCancel, { cmd: 'correct-cancel', id: step.id }) + '</div>';
      return h + '</section>';
    }
    if (pk && pk.status === 'PICKING') {
      h += '<div class="pickbadge" role="status">' + esc(T.cPickActive) + '</div><p class="sub">' + esc(T.cPickHelp) + '</p>';
      h += '<div class="row">' + button(T.cCancel, { cmd: 'correct-cancel', id: step.id }) + '</div>';
      return h + '</section>';
    }
    if (pk && pk.status === 'PICKED' && pk.proposal) {
      var pr = pk.proposal, tr = pr.traits;
      var ropts = pr.rowOptions || [], ropt = null;
      for (var ri = 0; ri < ropts.length; ri += 1) if (ropts[ri].id === rowChoice[step.id]) ropt = ropts[ri];
      if (!ropt && ropts.length) ropt = ropts[0];
      h += '<div class="pair"><div class="tbox old"><b>' + esc(T.cOld) + '</b><code>' + esc(pk.previous || corr && corr.current || '—') + '</code><span>' + esc(step.status === 'FAILED' ? T.cUnknown : step.statusText) + '</span></div>';
      h += '<span class="arrow" aria-hidden="true">→</span>';
      h += '<div class="tbox new"><b>' + esc(T.cNew) + '</b><code>' + esc(ropt ? ropt.target : pr.target) + '</code><span>' + esc(pr.quality) + '</span></div></div>';
      if (ropts.length) {
        h += '<fieldset class="rowopts"><legend>' + esc(T.cRowTitle) + '</legend>';
        for (var rj = 0; rj < ropts.length; rj += 1) {
          var o = ropts[rj];
          h += '<label class="choice' + (o.fixed ? ' fixed' : '') + '"><input type="radio" name="rowopt-' + esc(step.id) + '" value="' + esc(o.id) + '"' + (ropt && ropt.id === o.id ? ' checked' : '') + '><span>' + esc(o.id === 'bound' ? T.cRowBound(o.via || '') : T.cRowKey) + '<small>' + esc(o.row) + '</small></span></label>';
        }
        h += '</fieldset>';
        if (ropt && ropt.id === 'bound') h += '<p class="sub">' + esc(T.cRowBoundHelp) + '</p>';
        if (ropt && ropt.fixed) h += '<p class="warnnote">' + esc(T.cRowFixed) + '</p>';
      }
      h += '<dl>';
      h += '<dt>' + esc(T.cRole) + '</dt><dd><span class="chip">' + esc(tr.role || tr.tag) + '</span></dd>';
      if (tr.name) h += '<dt>' + esc(T.cName) + '</dt><dd>' + esc(tr.name) + '</dd>';
      if (tr.label && tr.label !== tr.name) h += '<dt>' + esc(T.field.label) + '</dt><dd>' + esc(tr.label) + '</dd>';
      if (tr.text && tr.text !== tr.name) h += '<dt>' + esc(T.cText) + '</dt><dd>' + esc(tr.text) + '</dd>';
      if (tr.testId) h += '<dt>' + esc(T.cTestId) + '</dt><dd><code>' + esc(tr.testId) + '</code></dd>';
      h += '<dt>' + esc(T.cCss) + '</dt><dd><code>' + esc(tr.css) + '</code></dd>';
      if (tr.section) h += '<dt>' + esc(T.cContext) + '</dt><dd>' + esc(tr.section) + '</dd>';
      h += '</dl>';
      if (pr.order.length) h += '<div class="order"><b>' + esc(T.cOrder) + '</b><ol>' + pr.order.map(function (o) { return '<li>' + esc(o) + '</li>'; }).join('') + '</ol></div>';
      if (pr.ambiguous) h += '<p class="warnnote">' + esc(T.cAmbiguous) + '</p>';
      h += '<div class="row cta">' + button(T.cTest, { cmd: 'correct-test', id: step.id }) + button(T.cCancel, { cmd: 'correct-cancel', id: step.id }) + button(T.cApply, { cmd: 'correct-apply', id: step.id, cls: 'primary grow', icon: 'check' }) + '</div>';
      if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message) + '</p>';
      return h + '</section>';
    }
    if (pk && pk.status === 'CANCELLED') h += '<p class="sub">' + esc(T.cCancelled) + '</p>';
    if (pk && pk.status === 'UNAVAILABLE') h += '<p class="sub">' + esc(T.cUnavailable) + (pk.reason ? ' (' + esc(pk.reason) + ')' : '') + '</p>';
    if (pk && pk.status === 'UNREACHABLE' && pk.stoppedAt) h += '<p class="warnnote">' + esc(T.cUnreachable(pk.stoppedAt.index, pk.stoppedAt.label)) + '</p><p class="sub">' + esc(pk.stoppedAt.reason) + '<br>' + esc(T.cUnreachableHelp) + '</p>';
    if (corr && corr.current && !corrected) h += '<dl><dt>' + esc(T.cCurrent) + '</dt><dd><code>' + esc(corr.current) + '</code></dd></dl>';
    if (corrected && corr) {
      var last = corr.history.length ? corr.history[corr.history.length - 1] : null;
      h += '<h3>' + esc(T.cHistory) + '</h3><div class="chist">';
      h += '<span class="k">' + esc(T.cOriginal) + '</span><code>' + esc(corr.original || '—') + '</code>';
      h += '<span class="k">' + esc(T.cCorrection) + '</span><code>' + esc(corr.current) + '</code>';
      h += '<span class="k">' + esc(T.cBy) + '</span><span>' + esc(T.cUser) + '</span>';
      if (last) h += '<span class="k">' + esc(T.cDate) + '</span><span>' + esc(new Date(last.at).toLocaleString()) + '</span>';
      h += '</div><div class="row">' + button(T.cRestore, { cmd: 'correct-restore', id: step.id, icon: 'undo', disabled: running }) + '</div>';
    }
    return h + '</section>';
  }

  /** LA SOURCE DE LA VALEUR d'une saisie (revue) : valeur enregistrée, générée, ou réutilisée d'une étape antérieure. */
  function dataBlock(step) {
    var d = step.data;
    if (!d || state.phase !== 'REVIEW') return '';
    var h = '<h3>' + esc(T.dataTitle) + '</h3>';
    if (d.source === 'SENSITIVE') return h + '<p class="sub">' + esc(T.sensitiveData) + '</p>';
    var draft = dataDraft[step.id];
    if (!draft) draft = dataDraft[step.id] = {
      source: d.source,
      variable: d.source === 'GENERATED' ? (d.key || '') : '',
      generator: d.generator || 'text',
      reference: d.reference || (d.options[0] ? d.options[0].key : ''),
      value: d.recordedValue || ''
    };
    var radio = function (value, label) {
      return '<label class="choice"><input type="radio" name="dsrc-' + esc(step.id) + '" value="' + value + '" data-bind-field="source" data-step-id="' + esc(step.id) + '"' + (draft.source === value ? ' checked' : '') + '>' + esc(label) + '</label>';
    };
    h += '<div class="iedit databind" data-binding="' + esc(step.id) + '"><fieldset><legend class="sr-only">' + esc(T.dataTitle) + '</legend>';
    h += radio('FIXED', T.srcFixed) + radio('GENERATED', T.srcGenerated) + radio('REFERENCE', T.srcReference) + '</fieldset>';
    if (draft.source === 'FIXED') {
      h += '<label class="dsub" for="dval-' + esc(step.id) + '">' + esc(T.fixedValueL) + '</label><input type="text" id="dval-' + esc(step.id) + '" data-bind-field="value" data-step-id="' + esc(step.id) + '" value="' + esc(draft.value) + '">';
    } else if (draft.source === 'GENERATED') {
      h += '<label class="dsub" for="dvar-' + esc(step.id) + '">' + esc(T.variableL) + '</label><input type="text" id="dvar-' + esc(step.id) + '" data-bind-field="variable" data-step-id="' + esc(step.id) + '" value="' + esc(draft.variable) + '" placeholder="' + esc(d.key || 'company.name') + '">';
      h += '<label class="dsub" for="dgen-' + esc(step.id) + '">' + esc(T.generatorL) + '</label><select id="dgen-' + esc(step.id) + '" data-bind-field="generator" data-step-id="' + esc(step.id) + '">' + d.generators.map(function (g) { return '<option' + (g === draft.generator ? ' selected' : '') + '>' + esc(g) + '</option>'; }).join('') + '</select>';
    } else {
      h += '<span class="dsub">' + esc(T.reuseFrom) + '</span>';
      h += d.options.length
        ? '<div class="dref">' + d.options.map(function (o) {
            return '<label class="choice"><input type="radio" name="dref-' + esc(step.id) + '" value="' + esc(o.key) + '" data-bind-field="reference" data-step-id="' + esc(step.id) + '"' + (draft.reference === o.key ? ' checked' : '') + '><span><code>' + esc(o.key) + '</code><small>' + esc(T.stepWord + ' ' + o.stepIndex + ' — ' + o.label) + '</small></span></label>';
          }).join('') + '</div>'
        : '<p class="dnote">' + esc(T.noData) + '</p>';
    }
    if (d.manual) h += '<p class="dnote manual">' + esc(T.manualL) + '</p>';
    else if (d.suggestion) h += '<p class="dnote">🔗 ' + esc(T.suggestedL(d.suggestion)) + '</p>';
    if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message) + '</p>';
    var blocked = draft.source === 'REFERENCE' && !d.options.length;
    h += '<div class="row">' + button(T.dataSave, { cmd: 'data-save', id: step.id, cls: 'primary', icon: 'check', disabled: blocked }) + '</div></div>';
    return h;
  }

  /** LA LIGNÉE DES DONNÉES (revue) : chaque variable, qui la produit, qui la réutilise. */
  function lineageCard(a) {
    var lines = a.dataLineage;
    if (!lines || !lines.length) return '';
    var h = '<div class="card card-plain" id="data-lineage"><h2>' + esc(T.lineageTitle) + '</h2><p class="sub">' + esc(T.lineageNote) + '</p><ul class="lineage">';
    lines.forEach(function (l) {
      h += '<li><code>' + esc(l.key) + '</code> · ' + esc((T.strategyL[l.strategy] || l.strategy) + (l.generator ? ' (' + l.generator + ')' : ''));
      if (l.producedBy) h += '<div class="sub">' + esc(T.producedL + ' ' + l.producedBy) + '</div>';
      if (l.uses.length) h += '<ul class="uses">' + l.uses.map(function (u) { return '<li>' + esc(T.usedL + ' ' + T.stepWord.toLowerCase() + ' ' + u) + '</li>'; }).join('') + '</ul>';
      h += '</li>';
    });
    return h + '</ul></div>';
  }

  function renderQuality() {
    var q = state.quality, el = $('quality');
    var h = '<header class="card-head"><h2>' + esc(T.quality) + '</h2></header>';
    if (q.score === undefined) { setHtml(el, h + '<p class="empty">' + esc(T.noQuality) + '</p>'); return; }
    h += '<div class="qbody"><div class="ring" style="--p:' + q.score + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + q.score + '" aria-label="' + esc(T.quality) + '"><div><span><b>' + q.score + '%</b><br>' + esc(T.qualityShort) + '</span></div></div><ul>';
    q.checks.forEach(function (c) { if (c.total > 0) h += '<li class="' + (c.ok ? 'ok' : 'warn') + '"><span class="i" aria-hidden="true">' + (c.ok ? '✓' : '⚠') + '</span>' + esc(T.checksQ[c.id]) + '<span class="v">' + c.passed + '/' + c.total + '</span></li>'; });
    setHtml(el, h + '</ul></div>');
  }

  function previewHtml() {
    var pv = state.preview;
    var picking = state.pick && (state.pick.status === 'PICKING' || state.pick.status === 'PREPARING');
    var h = '<header class="card-head"><h2>' + esc(T.previewTitle) + '</h2>' + (picking ? '<span class="pickbadge" role="status">' + esc(T.cPickActive) + '</span>' : '') + '<span class="actions">' + button('↻', { cmd: 'refresh-preview', cls: 'ghost', aria: T.refresh, title: T.refresh }) + (DETACHED ? '' : button('⛶', { cmd: 'fullscreen', cls: 'ghost', aria: T.fullscreen, title: T.fullscreen }) + button('⧉ ' + T.detach, { cmd: 'detach', aria: T.detachLabel, title: T.detachLabel })) + '</span></header>';
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
    setHtml($('detached-note'), note);
    var preview = previewHtml();
    setHtml($('preview-card'), detached ? '' : preview);
    setHtml($('preview-full'), detached ? note : preview);
  }

  /** Réécrit un bloc seulement s'il a changé : l'image d'aperçu n'est jamais recréée pour rien (pas de clignotement). */
  function setHtml(el, html) {
    if (el.__html === html) return;
    el.__html = html;
    el.innerHTML = html;
  }

  /** La fenêtre détachée : l'aperçu seul, l'état de l'enregistrement, Plein écran et Rattacher. */
  function renderDetached() {
    var p = state.phase, st = $('state');
    st.className = 'state small ' + (p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working');
    st.textContent = (p === 'RECORDING' ? T.recording : p === 'PAUSED' ? '⏸ ' + T.paused : p === 'FINALIZING' ? T.finalizing : '✓ ' + T.review) + ' · ' + T.actions(state.summary.actions);
    setHtml($('preview-detached'), previewHtml());
  }

  function renderReview() {
    var el = $('review');
    if (state.phase !== 'REVIEW') { setHtml(el, ''); return; }
    var r = state.replay;
    var h = '<div class="review" role="region" aria-label="' + esc(T.done) + '"><h2>' + esc(T.done) + '</h2>';
    // LA REPRISE : la page tenue devant l'étape corrigée (contexte gardé).
    var rs = state.resume;
    if (rs) {
      h += '<div class="result resume" role="status"><div class="rhead"><b>' + esc(T.resumeTitle(rs.index, rs.description)) + '</b><div class="actions">' + button(T.resumeHere, { cmd: 'resume-replay', id: rs.stepId, cls: 'primary', icon: 'check', disabled: rs.running }) + button(T.restartFromStart, { cmd: 'replay', disabled: rs.running }) + '</div></div><p class="sub">' + esc(T.resumeHelp) + '</p></div>';
    }
    if (!r && !state.saved && !rs) h += '<p class="hint">' + esc(T.recommend) + '</p>';
    var rec = r && r.recovery ? '<p class="sub recov">' + esc((r.recovery.strategy === 'MANUAL_RECOVERY' ? T.resumeBlocked : T.resumedAt)(r.recovery.from, T.strategy[r.recovery.strategy] || r.recovery.strategy)) + (r.recovery.recovered && r.recovery.recovered.length ? ' · ' + esc(T.recoveredSteps(r.recovery.recovered.join(', '))) : '') + '</p>' : '';
    if (r && r.status === 'PASSED') h += '<div class="result ok" role="status"><b>' + esc(T.replayOk) + '</b>' + rec + '<ul><li>✓ ' + esc(T.executed(r.executed, r.total)) + '</li>' + (r.checks || []).map(function (c) { return '<li>' + (c.ok ? '✓ ' : '⚠ ') + esc(c.text) + '</li>'; }).join('') + '</ul></div>';
    if (r && r.status === 'FAILED' && r.failure) {
      var f = r.failure;
      // Une ligne : le verdict, l'étape et la cause, puis les actions ; les détails techniques repliés.
      h += '<div class="result bad" role="alert"><div class="rhead"><b>' + esc(T.replayBad) + '</b><p class="rmeta">' + esc(T.stepOf(f.index, r.total)) + ' · <b>' + esc(f.description) + '</b> · ' + esc(T.cause) + ' : ' + esc(f.cause) + '</p>';
      h += '<div class="actions">' + (f.stepId ? button(T.cInBrowser, { cmd: 'correct-pick', id: f.stepId, cls: 'soft', icon: 'cursor' }) : '') + button(T.editStep, { cmd: 'edit-step', id: f.stepId || '' }) + button(T.restart, { cmd: 'replay' }) + '</div></div>';
      h += rec + '<details><summary>' + esc(T.seeDetails) + '</summary><ul>' + f.details.map(function (d) { return '<li class="tech">' + esc(d) + '</li>'; }).join('') + '</ul></details></div>';
    }
    if (state.saved) h += '<div class="result ok" role="status"><b>' + esc(T.saved) + '</b><p class="sub">' + esc(state.saved.directory) + '</p></div>';
    setHtml(el, h + '</div>');
  }

  function renderFooter() {
    var s = state.summary, review = state.phase === 'REVIEW', r = state.replay, running = r && r.status === 'RUNNING';
    var stat = function (cls, icon, value, label, key) { return '<div class="stat"><span class="i ' + cls + '" aria-hidden="true">' + icon + '</span><div><b' + (key ? ' data-stat="' + key + '"' : '') + '>' + esc(value) + '</b><span>' + esc(label) + '</span></div></div>'; };
    var h = '<h2>' + esc(T.summaryTitle) + '</h2>';
    h += stat('i-actions', '▶', s.actions, T.sActions) + stat('i-ok', '✓', s.confirmed, T.sConfirmed) + stat('i-amb', '!', s.ambiguous, T.sAmbiguous) + stat('i-bad', '✕', s.failed, T.sFailed) + stat('i-time', '◷', clock((state.endedAt || Date.now()) - state.startedAt), T.sDuration, 'duration');
    h += '<div class="buttons">';
    h += button(T.replayFlow, { cmd: 'replay', cls: 'primary', icon: 'play', disabled: !review || running, title: review ? '' : T.afterStop });
    if (review) h += button(editing ? T.editing : T.edit, { cmd: 'edit', cls: 'subtle', icon: editing ? 'check' : 'pencil', disabled: running });
    h += button(T.saveFlow2, { cmd: 'save', cls: 'success', icon: 'disk', disabled: !review || running, title: review ? '' : T.afterStop });
    if (review) h += button(T.finish, { cmd: 'finish', cls: 'neutral', icon: 'close', disabled: running });
    h += '</div>';
    setHtml($('summarybar'), h);
  }

  /** D · les intents métier (recherches, écritures) EN TÊTE de l'analyse ; le technique reste replié dessous. */
  function intentsCard(a) {
    var h = '<div class="card card-plain"><h2>' + esc(T.intents) + '</h2>';
    var qs = a.searchIntents || [];
    h += qs.map(function (q) {
      var badge = function (st) { return '<span class="bbadge ' + (st === 'VALIDATED' ? 'CONFIRMED' : st === 'INFERRED' ? 'PROBABLE' : 'UNKNOWN') + '">' + esc(st) + '</span>'; };
      var pct = Math.round(q.confidence * 100);
      // D · la recherche en tableau : champ de l'écran, propriété API, opérateur, valeur, état.
      var r = '<div class="search"><div class="shead"><b>' + esc(T.searchL) + '</b><code class="sub">' + esc(q.api) + '</code>' + badge(q.state)
        + '<span class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="' + esc(T.confidence) + '"><span class="track"><span style="width:' + pct + '%"></span></span>' + esc(T.confidence) + ' : ' + pct + ' %</span></div>';
      if (q.technical) r += '<div class="meta">' + esc(T.techL) + ' : ' + esc(q.technical) + '</div>';
      r += '<h3>' + esc(T.critL) + '</h3><table class="stable"><thead><tr><th scope="col">' + esc(T.fieldL) + '</th><th scope="col">' + esc(T.propL) + '</th><th scope="col">' + esc(T.opL) + '</th><th scope="col">' + esc(T.valL) + '</th><th scope="col">' + esc(T.stateL) + '</th></tr></thead><tbody>'
        + q.criteria.map(function (c) {
          return '<tr><td><b>' + esc(c.label || '—') + '</b></td><td><code>' + esc(c.property) + '</code></td><td><code>' + esc(c.operator || '=') + '</code></td><td>' + esc(c.value) + (c.testData ? ' <code class="sub">' + esc(c.testData) + '</code>' : '') + '</td><td>' + badge(c.state) + '</td></tr>';
        }).join('') + '</tbody></table>';
      var tokens = [];
      if (q.logic) tokens.push('<span>' + esc(T.logicL) + ' : ' + esc(q.logic) + '</span>');
      if (q.sort.length) tokens.push('<span>' + esc(T.sortL) + ' : ' + esc(q.sort.join(', ')) + '</span>');
      if (q.parameters.length) tokens.push('<span>' + esc(T.paramsL) + ' : ' + esc(q.parameters.map(function (p) { return (T.roles[p.role] || p.role) + ' (' + p.paths.join(', ') + ')'; }).join(' · ')) + '</span>');
      if (q.criteria.some(function (c) { return c.fromCreation; })) tokens.push('<span class="from">' + esc(T.fromCreateL) + '</span>');
      if (tokens.length) r += '<div class="tokens">' + tokens.join('') + '</div>';
      if (q.evidence.length) r += '<details><summary>' + esc(T.why) + ' (' + q.evidence.length + ')</summary><ol>' + q.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ol></details>';
      return r + '</div>';
    }).join('');
    h += a.intents.length ? a.intents.map(function (i) {
      return '<div><b>' + esc(i.label) + '</b>' + (i.detail ? '<div class="meta">' + esc(i.detail) + '</div>' : '') + (i.confidence !== undefined ? '<div class="meta">' + esc(T.confidence) + ' : ' + Math.round(i.confidence * 100) + ' %</div>' : '') + (i.evidence.length ? '<details><summary>' + esc(T.why) + '</summary><ul>' + i.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></details>' : '') + '</div>';
    }).join('') : qs.length ? '' : '<p class="empty">' + esc(T.noIntent) + '</p>';
    if (a.technicalIntents && a.technicalIntents.length) h += '<h3>' + esc(T.technicalIntents) + '</h3><ul class="bunres">' + a.technicalIntents.map(function (i) {
      return '<li><b>' + esc(i.label) + '</b>' + (i.detail ? '<div class="meta">' + esc(i.detail) + '</div>' : '') + (i.evidence.length ? '<div class="meta">' + esc(i.evidence.join(' · ')) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
    return h + '</div>';
  }

  /** LA REVUE DES INTENTIONS : modifier, confirmer, réinitialiser — l'action enregistrée ne change jamais. */
  function reviewCard(a) {
    var r = a.intentReview;
    if (!r || !r.rows.length) return '';
    var pct = function (v) { return v === undefined ? '—' : Math.round(v * 100) + ' %'; };
    var h = '<div class="card card-plain" id="intent-review"><h2>' + esc(T.reviewTitle) + '</h2><p class="sub">' + esc(T.reviewNote) + '</p>';
    h += r.rows.map(function (row) {
      var x = '<div class="irow ' + row.status + '" data-intent-row="' + esc(row.actionId) + '">';
      x += '<span class="iico" aria-hidden="true">' + svg(kindIcon(row.kind)) + '</span>';
      x += '<div><div class="ilabel">' + esc(row.label) + '</div><div class="iline">' + esc(T.intentL) + ' : <span class="iintent">' + esc(row.intent) + '</span></div></div>';
      x += '<div class="imeta">' + esc(T.sourceL) + ' : <span class="isrc ' + row.status + '">' + esc(T.src[row.status]) + '</span> · ' + esc(T.confidence) + ' : ' + (row.confidence === undefined ? '—' : '<span class="iconf">' + pct(row.confidence) + '</span>') + '</div>';
      x += '<div class="iactions">' + button(T.modifyIntent, { cmd: 'intent-edit', id: row.actionId, cls: 'soft', icon: 'pencil' })
        + (row.source === 'HUMAN' ? button(T.resetIntent, { cmd: 'intent-reset', id: row.actionId, cls: 'ghost', icon: 'undo' }) : button(T.confirmIntent, { cmd: 'intent-confirm', id: row.actionId, cls: 'confirm', icon: 'check' })) + '</div>';
      if (row.original !== undefined) x += '<div class="imeta full">' + esc(T.originalL) + ' : <b>' + esc(row.original) + '</b> · ' + esc(T.initialConf) + ' : ' + pct(row.originalConfidence) + '</div>';
      if (row.reason) x += '<div class="imeta full">' + esc(T.correctionL) + ' : « ' + esc(row.reason) + ' »</div>';
      if (row.proposal) x += '<div class="imeta full">' + esc(T.proposalL) + ' : ' + esc(row.proposal) + '</div>';
      if (state.notice && state.notice.actionId === row.actionId) x += '<p class="error full" role="alert">' + esc(state.notice.message) + '</p>';
      if (editingIntent === row.actionId) {
        x += '<div class="iedit"><fieldset><legend>' + esc(T.newIntent) + '</legend>' + r.choices.map(function (c) {
          return '<label class="choice"><input type="radio" name="intent-' + esc(row.actionId) + '" value="' + esc(c) + '"' + (c === row.intent ? ' checked' : '') + '>' + esc(c) + '</label>';
        }).join('') + '</fieldset><label class="sub" for="reason-' + esc(row.actionId) + '">' + esc(T.justification) + '</label><textarea id="reason-' + esc(row.actionId) + '"></textarea>'
          + '<div class="row">' + button(T.applyIntent, { cmd: 'intent-apply', id: row.actionId, cls: 'primary', icon: 'check' }) + button(T.cancelIntent, { cmd: 'intent-cancel', id: row.actionId }) + '</div></div>';
      }
      if (row.history.length) x += '<details class="full"><summary>' + esc(T.historyL) + ' (' + row.history.length + ')</summary><ul>' + row.history.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></details>';
      return x + '</div>';
    }).join('');
    return h + '</div>';
  }

  function renderAnalysis() {
    var a = state.analysis, el = $('panel-analysis');
    var h = '<div class="card card-plain"><h2>' + esc(T.analysisTitle) + '</h2><p class="notice">' + esc(T.analysisNote) + '</p>';
    if (!a.available) { setHtml(el, h + '<p class="empty">' + esc(T.analysisWaiting) + '</p></div>'); return; }
    if (a.running) h += '<p class="notice running" role="status">' + esc(T.analysisRunning) + '</p>';
    // La suite (application, interprétation, HTTP) ouvre ses propres cartes : un simple conteneur ici.
    h += '</div>' + intentsCard(a) + reviewCard(a) + lineageCard(a) + '<div>';
    if (a.application && a.application.tree.length) {
      var treeHtml = function (nodes) {
        return '<ul>' + nodes.map(function (n) {
          var x = '<li><div class="anode"><b>' + esc(n.label) + '</b>' + (n.status ? '<span class="ibadge ' + n.status + '">' + esc(T.istatus[n.status] || n.status) + (n.confidence !== undefined ? ' · ' + Math.round(n.confidence * 100) + ' %' : '') + '</span>' : '') + '</div>';
          if (n.detail) x += '<div class="meta">' + esc(n.detail) + '</div>';
          if (n.recorded.length) x += '<details><summary>' + esc(T.recordedActions) + ' (' + n.recorded.length + ')</summary><ul>' + n.recorded.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
          if (n.evidence.length) x += '<details><summary>' + esc(T.evidenceL) + ' (' + n.evidence.length + ')</summary><ul>' + n.evidence.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
          if (n.children.length) x += treeHtml(n.children);
          return x + '</li>';
        }).join('') + '</ul>';
      };
      h += '</div><div class="card card-plain application"><h2>' + esc(T.applicationL) + '</h2><p class="sub">' + esc(T.applicationNote) + '</p>' + (a.application.counts ? '<p class="meta">' + esc(T.actionLevels(a.application.counts)) + '</p>' : '') + '<div class="atree">' + treeHtml(a.application.tree) + '</div>';
    }
    if (a.business) {
      var b = a.business;
      h += '</div><div class="card card-plain business"><h2>' + esc(T.business) + '</h2><p class="sub">' + esc(T.businessNote) + '</p>';
      h += b.steps.length ? '<ol class="bflow">' + b.steps.map(function (st) {
        var line = st.output ? st.output + (st.outputValue !== undefined ? ' = ' + st.outputValue : '') : st.reference ? T.referenceL + ' = ' + st.reference : '';
        var x = '<li class="bstep ' + st.status + '"><div class="bhead"><b>' + esc((T.baction[st.action] || st.action) + ' ' + st.entity.toUpperCase()) + '</b><span class="bbadge ' + st.status + '">' + esc(T.bstatus[st.status]) + ' · ' + Math.round(st.confidence * 100) + ' %</span>' + (st.provenance ? '<span class="bprov ' + st.provenance + '">' + esc(T.provenanceL[st.provenance] || st.provenance) + '</span>' : '') + '</div>';
        if (line) x += '<div class="bref">↳ ' + esc(line) + '</div>';
        if (st.ai) x += '<div class="meta">' + esc(T.aiChoice) + '</div>';
        x += '<details><summary>' + esc(T.recordedActions) + ' (' + st.recorded.length + ')</summary><ul>' + st.recorded.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
        if (st.observed.length) x += '<details><summary>' + esc(T.observed) + '</summary><ul>' + st.observed.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
        if (st.deduced.length) x += '<details><summary>' + esc(T.deduced) + '</summary><ul>' + st.deduced.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
        return x + '</li>';
      }).join('<li class="barrow" aria-hidden="true">↓</li>') + '</ol>' : '<p class="empty">' + esc(T.noBusiness) + '</p>';
      if (b.entities && b.entities.length) h += '<h3>' + esc(T.entitiesL) + '</h3><ul class="bent">' + b.entities.map(function (e) {
        return '<li><b>' + esc(e.name + (e.identity !== undefined ? ' ' + e.identity : '')) + '</b><span class="bprov ' + e.provenance + '">' + esc(T.provenanceL[e.provenance] || e.provenance) + ' · ' + Math.round(e.confidence * 100) + ' %</span>' + (e.lifecycle.length ? '<div class="meta">' + esc(e.lifecycle.join(' → ')) + '</div>' : '') + '<div class="meta">' + esc(e.reason) + '</div>' + (e.contradictions ? '<ul>' + e.contradictions.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' : '') + '</li>';
      }).join('') + '</ul>';
      if (b.unresolved.length) h += '<h3>' + esc(T.uncertain) + '</h3><ul class="bunres">' + b.unresolved.map(function (u) {
        return '<li><span class="bbadge ' + u.status + '">' + esc(T.bstatus[u.status] || u.status) + '</span> ' + esc(u.type === 'POSSIBLE_CREATE' ? 'POSSIBLE_CREATE (' + T.possibleCreate + ')' : u.type) + (u.candidates ? ' — ' + esc(T.candidatesL) + ' : ' + esc(u.candidates.join(', ')) : '') + (u.recorded.length ? '<div class="meta">' + esc(u.recorded.join(' · ')) + '</div>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    if (a.http) {
      var x = a.http;
      h += '</div><div class="card card-plain"><h2>' + esc(T.httpL) + '</h2><p class="sub">' + esc(T.httpNote) + '</p>';
      if (x.status === 'FAILED') h += '<p class="note" role="note">' + esc(T.httpFailed + ' ' + x.errors.join('; ')) + '</p>';
      h += '<p class="meta">' + esc(T.httpCounts(x.counts)) + '</p>';
      if (x.operations.length) h += '<p class="meta">' + esc(x.operations.join(' · ')) + '</p>';
      if (x.mappings.length) h += '<h3>' + esc(T.httpMappings) + '</h3><ul class="bent">' + x.mappings.map(function (m) { return '<li><b>' + esc(m.label) + '</b> → ' + esc(m.property) + ' <span class="bbadge ' + (m.state === 'VALIDATED' ? 'CONFIRMED' : m.state === 'INFERRED' ? 'PROBABLE' : 'UNKNOWN') + '">' + esc(m.state + (m.transformation === 'NORMALIZED' ? ' · ≈' : '')) + '</span></li>'; }).join('') + '</ul>';
      if (x.searches && x.searches.length) h += '<h3>' + esc(T.searchesL) + '</h3><ul class="bent">' + x.searches.map(function (q) { return '<li><b>' + esc(q.api) + '</b><div class="meta">' + esc(q.interpretation || '') + '</div></li>'; }).join('') + '</ul>';
      if (x.inconsistencies.length) h += '<h3>' + esc(T.httpIncons) + '</h3><ul class="bunres">' + x.inconsistencies.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
      if (x.revisions.length) h += '<details><summary>' + esc(T.httpRevisions) + ' (' + x.revisions.length + ')</summary><ul>' + x.revisions.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
    }
    h += '</div><div class="card card-plain"><h2>' + esc(T.findings) + '</h2>';
    h += a.findings.length ? a.findings.map(function (f) {
      return '<p><span class="tag">' + esc(f.severity) + '</span><b>' + esc(f.message) + '</b><br><span class="meta">' + esc(T.origin[f.origin] || f.origin) + '</span>' + (f.suggestion ? '<br>' + esc(f.suggestion) : '') + '</p>';
    }).join('') : '<p class="empty">' + esc(T.noFinding) + '</p>';
    if (a.aiCandidates > 0) h += '<p class="sub">' + esc(T.ai(a.aiCandidates)) + '</p>';
    setHtml(el, h + '</div>');
  }

  function render() {
    if (!state) return;
    if (DETACHED) { renderDetached(); return; }
    renderHead(); renderReview(); renderStory(); renderSummary(); renderTimeline(); renderDetails(); renderQuality(); renderPreview(); renderFooter(); renderAnalysis(); tickTimer();
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
    // Ouverte depuis le dock pour une étape : elle est sélectionnée et amenée à l'écran, une fois.
    if (state.focus && state.focus !== focused) { focused = state.focus; selected = state.focus; }
    render();
    if (state.focus === focused && focused && !scrolledTo) { scrolledTo = focused; var row = document.querySelector('[data-step="' + focused + '"]'); if (row) row.scrollIntoView({ block: 'center' }); }
    if (added) { var last = state.actions[state.actions.length - 1]; if (last) announce(T.announceAdded + last.description); }
    if (removed) announce(T.announceUndo);
  };

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.id === 'devtoggle') { dev = !dev; target.setAttribute('aria-pressed', String(dev)); render(); return; }
    if (target.id === 'layouttoggle') { layout = layout === 'compact' ? 'full' : 'compact'; storeLayout(layout); render(); return; }
    if (target.id === 'tlattention') { onlyAttention = !onlyAttention; render(); return; }
    if (target.getAttribute('role') === 'tab') { selectTab(target.id.replace('tab-', '')); return; }
    var cmd = target.getAttribute('data-cmd'), id = target.getAttribute('data-id');
    if (!cmd) return;
    if (cmd === 'select') { selected = id; render(); send({ type: 'select', id: id }); return; }
    if (cmd === 'deselect') { selected = null; render(); return; }
    if (cmd === 'copy') { try { navigator.clipboard.writeText(id || ''); target.textContent = T.copied; } catch (e) { /* presse-papiers indisponible */ } return; }
    if (cmd === 'refresh-preview') { send({ type: 'refresh' }); return; }
    if (cmd === 'fullscreen') { fullscreen(DETACHED ? document.documentElement : $('preview-card')); return; }
    if (cmd === 'show') { selected = id; render(); send({ type: 'select', id: id }); return; }
    if (cmd === 'confirm-resolve') {
      var picked = document.querySelector('input[name="cand-' + id + '"]:checked');
      send({ type: 'resolve', id: id, candidate: picked ? Number(picked.value) : -1 });
      return;
    }
    if (cmd === 'edit') { editing = !editing; render(); return; }
    if (cmd === 'intent-edit') { editingIntent = editingIntent === id ? null : id; render(); return; }
    if (cmd === 'intent-cancel') { editingIntent = null; render(); return; }
    if (cmd === 'data-save') {
      var draft = dataDraft[id];
      if (!draft) return;
      delete dataDraft[id];
      send({
        type: 'data-bind', id: id, source: draft.source,
        variable: draft.source === 'REFERENCE' ? draft.reference : draft.variable,
        generator: draft.generator,
        value: draft.source === 'FIXED' ? draft.value : undefined
      });
      return;
    }
    if (cmd === 'intent-apply') {
      var chosen = document.querySelector('input[name="intent-' + id + '"]:checked');
      var why = document.getElementById('reason-' + id);
      editingIntent = null;
      send({ type: 'intent-correct', id: id, intent: chosen ? chosen.value : '', reason: why ? why.value : '' });
      render();
      return;
    }
    if (cmd === 'correct-pick') { selected = id || selected; send({ type: cmd, id: id }); render(); return; }
    if (cmd === 'correct-apply') {
      var ropt = document.querySelector('input[name="rowopt-' + id + '"]:checked');
      send(ropt ? { type: cmd, id: id, option: ropt.value } : { type: cmd, id: id });
      return;
    }
    if (cmd === 'edit-step') { editing = true; selected = id || selected; render(); var row = document.querySelector('[data-step="' + id + '"]'); if (row) row.scrollIntoView({ block: 'center' }); return; }
    send({ type: cmd, id: id });
  });

  if (!DETACHED) $('tlsearch').addEventListener('input', function (event) { filterText = event.target.value || ''; renderTimeline(); });

  // Le choix d'un élément survit aux mises à jour du panneau (chaque action reconstruit la liste).
  document.addEventListener('change', function (event) {
    var input = event.target;
    if (input instanceof HTMLInputElement && input.name.indexOf('cand-') === 0) choice[input.name.slice(5)] = Number(input.value);
    if (input instanceof HTMLInputElement && input.name.indexOf('rowopt-') === 0) { rowChoice[input.name.slice(7)] = input.value; render(); return; }
    var field = input && input.getAttribute ? input.getAttribute('data-bind-field') : null;
    if (field) {
      var draft = dataDraft[input.getAttribute('data-step-id')];
      if (draft) { draft[field] = input.value; if (field === 'source') render(); }
    }
  });
  // La saisie d'une variable ou d'une valeur fixe : gardée dans le brouillon (aucun rendu, le curseur reste).
  document.addEventListener('input', function (event) {
    var input = event.target;
    var field = input && input.getAttribute ? input.getAttribute('data-bind-field') : null;
    if (!field || field === 'source') return;
    var draft = dataDraft[input.getAttribute('data-step-id')];
    if (draft) draft[field] = input.value;
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
  $('layouttoggle').setAttribute('aria-label', T.layoutLabel);
  $('tab-recording').textContent = T.tabRecording; $('tab-analysis').textContent = T.tabAnalysis; $('tab-preview').textContent = T.tabPreview;
  document.querySelector('.tabs').setAttribute('aria-label', T.tabs);
  $('head').setAttribute('aria-label', T.recording);
  setInterval(tickTimer, 1000);
})();
`;
