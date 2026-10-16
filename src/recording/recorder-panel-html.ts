import { THEME_BASE_CSS, THEME_BOOT_SCRIPT, THEME_TOGGLE_SCRIPT, themeToggle } from '../reporting/theme.js';
import { recorderFontFaces } from './recorder-fonts.js';

/** La loupe de la marque (monochrome, elle suit la couleur du texte). */
const MARK =
  '<svg class="mark" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/></svg>';
const SEARCH_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

/**
 * LA FENÊTRE « QA-CRAWLER Recorder » : une page autonome (aucune dépendance, aucun réseau : les
 * polices sont intégrées), rendue dans un contexte de navigateur SÉPARÉ de l'application enregistrée
 * (jamais capturée, jamais observée). Node lui envoie l'état (window.__qaPanelRender) ; elle renvoie
 * des commandes (window.__qaPanelCommand). Elle n'enregistre rien elle-même et ne décide de rien.
 *
 * Disposition : un en-tête unique (marque et nom du flow, état et durée, chiffres clés, actions de la
 * phase : Annuler / Pause / Arrêter pendant l'enregistrement, Fermer / Rejouer / Sauvegarder en revue)
 * · des onglets soulignés (Parcours, Réseau, Données de test, Analyse) · le parcours enregistré à
 * gauche · l'aperçu de l'application et l'inspecteur de l'action à droite.
 *
 * Accessible : vrais boutons, aria-label, focus visible, onglets clavier, statuts dits en texte
 * (jamais par la couleur seule), annonces aria-live. Responsive : deux colonnes sur un grand écran,
 * une seule sur une fenêtre étroite (l'aperçu passe alors dans son onglet).
 */
export function recorderPanelHtml(language: 'fr' | 'en', mode: 'main' | 'preview' = 'main'): string {
  const style = `<style>${recorderFontFaces()}\n${CSS}</style>`;
  // LA FENÊTRE DÉTACHÉE : l'aperçu seul, plein écran possible ; la fenêtre principale garde le reste.
  if (mode === 'preview')
    return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER Recorder — ${language === 'fr' ? 'Aperçu' : 'Preview'}</title>
${THEME_BOOT_SCRIPT}
${style}
</head>
<body data-mode="preview">
<header class="topbar">
  <div class="crumb">${MARK}<span class="brand">QA-CRAWLER</span><span class="slash" aria-hidden="true">/</span><span class="subtitle" id="subtitle"></span></div>
  <div class="statepill"><span class="state small" id="state" aria-live="polite"></span></div>
  <span class="spacer"></span>
  <span class="actions-top" id="detached-actions"></span>
  <div class="tools">${themeToggle(language)}</div>
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
${style}
</head>
<body data-mode="main">
<header class="topbar" id="head" aria-label="">
  <div class="crumb">${MARK}<span class="brand">QA-CRAWLER</span><span class="slash" aria-hidden="true">/</span><span class="subtitle" id="subtitle"></span></div>
  <div class="statepill" id="statepill"><h1 id="state" class="state" aria-live="polite"></h1><span class="timer" id="timer" aria-label=""></span></div>
  <div class="stats" id="count"></div>
  <span class="spacer"></span>
  <div class="controls" id="controls" role="toolbar"></div>
  <div class="tools"><button type="button" class="tool" id="layouttoggle" aria-pressed="false"></button><button type="button" class="tool" id="devtoggle" aria-pressed="false"></button>${themeToggle(language)}</div>
</header>
<p class="pausenote" id="pausenote" role="note" hidden></p>
<div class="progress" id="progress" hidden><div class="bar"><span></span></div><p></p></div>
<nav class="tabs" role="tablist" aria-label="">
  <button role="tab" id="tab-recording" aria-controls="panel-recording" aria-selected="true"></button>
  <button role="tab" id="tab-network" aria-controls="panel-network" aria-selected="false" tabindex="-1"></button>
  <button role="tab" id="tab-data" aria-controls="panel-data" aria-selected="false" tabindex="-1" hidden></button>
  <button role="tab" id="tab-analysis" aria-controls="panel-analysis" aria-selected="false" tabindex="-1"></button>
  <button role="tab" id="tab-preview" class="narrow-only" aria-controls="panel-preview" aria-selected="false" tabindex="-1"></button>
</nav>
<main>
  <section id="panel-recording" role="tabpanel" aria-labelledby="tab-recording">
    <div id="review"></div>
    <div id="detached-note"></div>
    <div class="grid" id="grid">
      <div class="col-left">
        <section class="card journey" aria-labelledby="timeline-title">
          <header class="card-head"><h2 id="timeline-title"></h2><span class="label" id="journey-hint"></span><div class="tl-tools" id="tltools"><label class="tl-search">${SEARCH_ICON}<span class="sr-only" id="tlsearch-label"></span><input type="search" id="tlsearch" aria-labelledby="tlsearch-label"></label><button type="button" class="small" id="tlattention" aria-pressed="false"></button></div></header>
          <p class="livesearch" id="livesearch" role="status" hidden></p>
          <p class="status-line" id="summary" role="status"></p>
          <ol id="timeline" class="timeline"></ol>
          <div id="checks"></div>
        </section>
      </div>
      <div class="col-side">
        <section class="card preview col-mid" id="preview-card"></section>
        <aside class="card details col-right" id="details" aria-live="polite"></aside>
      </div>
    </div>
  </section>
  <section id="panel-network" role="tabpanel" aria-labelledby="tab-network" hidden></section>
  <section id="panel-data" role="tabpanel" aria-labelledby="tab-data" hidden></section>
  <section id="panel-analysis" role="tabpanel" aria-labelledby="tab-analysis" hidden></section>
  <section id="panel-preview" role="tabpanel" aria-labelledby="tab-preview" hidden><div class="card preview" id="preview-full"></div></section>
</main>
<div id="live" class="sr-only" aria-live="polite"></div>
<script>${SCRIPT}</script>
${THEME_TOGGLE_SCRIPT}
</body>
</html>`;
}

/** Les couleurs du thème sombre : celles du thème sombre choisi ET du mini-dock (toujours sombre). */
const DARK_TOKENS = `--bg:#0F1115;--surface:#171A21;--surface-2:#1C2028;--sunken:#12151B;--chip:#232833;--line:#2A2F3A;--line-soft:#22262F;--line-strong:#363C48;
  --fg:#E7E9EE;--fg-2:#B4BAC6;--muted:#8B93A3;--faint:#4A5161;
  --accent:#5B7BF0;--accent-fg:#FFFFFF;--accent-text:#93A9FF;--accent-soft:#1A2238;--accent-chip:#24315C;--accent-line:#34478A;--accent-wash:#1A2033;--var-bg:#1E2A4D;--var-fg:#A9BDFF;
  --ok:#3FB96B;--ok-text:#7FD69E;--ok-soft:#14281D;--ok-line:#21452F;--ok-wash:#13231A;--ok-ink:#A7D9B8;
  --bad:#E5484D;--bad-text:#FF9B95;--bad-soft:#2C1517;--bad-line:#4E2326;--bad-wash:#251315;--bad-ink:#F1C1BC;--rec:#F2555A;
  --warn:#E2A03F;--warn-text:#F3C77D;--warn-soft:#2A2113;--warn-line:#4A3A1C;
  --shadow:none;--focus:#93A9FF;--text:var(--fg);--text-2:var(--fg-2);--nav-hover:var(--chip)`;

const CSS = `
:root{color-scheme:light;
  --bg:#F5F6F8;--surface:#FFFFFF;--surface-2:#F7F8FA;--sunken:#EEF0F4;--chip:#F1F3F7;--line:#E3E6EB;--line-soft:#EEF0F3;--line-strong:#D9DCE3;
  --fg:#15171C;--fg-2:#4A5161;--muted:#6B7280;--faint:#C3C7D0;
  --accent:#2B50D8;--accent-fg:#FFFFFF;--accent-text:#2B50D8;--accent-soft:#F6F8FE;--accent-chip:#E6ECFD;--accent-line:#BFCCF6;--accent-wash:#F7F9FF;--var-bg:#EAF0FE;--var-fg:#1F3FAE;
  --ok:#15803D;--ok-text:#166534;--ok-soft:#EDF7F0;--ok-line:#CBE8D4;--ok-wash:#F7FBF8;--ok-ink:#2F5D3E;
  --bad:#C42B1F;--bad-text:#A1271C;--bad-soft:#FDF0EF;--bad-line:#F3D4D0;--bad-wash:#FEF7F6;--bad-ink:#5B2A24;--rec:#D2261B;
  --warn:#B45309;--warn-text:#92400E;--warn-soft:#FEF6E7;--warn-line:#F5DDB0;
  --shadow:0 1px 2px rgba(16,24,40,.04);--focus:#2B50D8;--text:var(--fg);--text-2:var(--fg-2);--nav-hover:var(--chip);
  --sans:'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,"Segoe UI","Helvetica Neue",sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
:root[data-theme="dark"]{color-scheme:dark;${DARK_TOKENS}}
${THEME_BASE_CSS}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;font:400 14px/1.45 var(--sans);background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;min-height:100vh}
code,kbd,.mono{font-family:var(--mono)}
b,strong{font-weight:600}
h1,h2,h3{font-weight:600}
/* BOUTONS : 36 px, rayon 8, texte 500 13 px ; primaire bleu, danger rouge, fantôme transparent. */
button{font:500 13px/20px var(--sans);cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);border-radius:8px;padding:7px 14px;min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:background .15s,border-color .15s,color .15s}
button:hover:not(:disabled){background:var(--surface-2);border-color:var(--faint)}
button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,[tabindex]:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button svg{width:15px;height:15px;flex:none}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button.primary:hover:not(:disabled){background:var(--accent);border-color:var(--accent);filter:brightness(1.08)}
button.danger{background:var(--bad);border-color:var(--bad);color:#FFFFFF}
button.danger:hover:not(:disabled){background:var(--bad);border-color:var(--bad);filter:brightness(1.08)}
button.ghost{border-color:transparent;background:transparent;color:var(--fg-2)}
button.ghost:hover:not(:disabled){background:var(--chip);border-color:transparent;color:var(--fg)}
button.link{border-color:transparent;background:transparent;color:var(--accent-text);min-height:28px;padding:4px 8px}
button.link:hover:not(:disabled){background:var(--accent-soft);border-color:transparent}
button.remove{border-color:transparent;background:transparent;color:var(--bad-text)}
button.remove:hover:not(:disabled){background:var(--bad-soft);border-color:transparent}
button.confirm{color:var(--ok-text)}
button.small{min-height:30px;padding:4px 10px;font-size:12.5px}
button.icon{width:36px;padding:0}
button.icon.small{width:30px}
input[type=text],input[type=search],select,textarea{font:400 13px/1.4 var(--sans);color:var(--fg);background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;padding:6px 10px;min-height:34px;max-width:100%}
select{padding:4px 8px;min-height:30px;font-size:12.5px;border-radius:7px}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:15px;height:15px;margin:0;flex:none}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.spacer{flex:1}
.label{font-size:12px;color:var(--muted);font-weight:400}
.val{font:400 12.5px/1.5 var(--mono);background:var(--chip);border-radius:5px;padding:1px 6px;color:var(--fg);overflow-wrap:anywhere}
.var{font:400 12px/1.5 var(--mono);background:var(--var-bg);color:var(--var-fg);border-radius:5px;padding:1px 6px;overflow-wrap:anywhere}
/* Les guillemets d'une valeur restent dans le texte (copier, lecteurs d'écran) mais la puce les remplace à l'œil. */
.q{font-size:0}
.dotc{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;background:var(--muted)}
.st{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-2);white-space:nowrap}
.st.ok .dotc{background:var(--ok)} .st.bad{color:var(--bad-text)} .st.bad .dotc{background:var(--bad)}
.st.warn{color:var(--warn-text)} .st.warn .dotc{background:var(--warn)} .st.run{color:var(--accent-text)} .st.run .dotc{background:var(--accent)}
.st.idle{color:var(--muted)} .st.idle .dotc{background:var(--faint)}
.spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(330%)}}
@keyframes halo{0%{box-shadow:0 0 0 0 rgba(210,38,27,.35)}70%{box-shadow:0 0 0 6px rgba(210,38,27,0)}100%{box-shadow:0 0 0 0 rgba(210,38,27,0)}}
/* EN-TÊTE UNIQUE (60 px) : marque / flow · état et durée · chiffres · actions de la phase · outils. */
.topbar{min-height:60px;display:flex;align-items:center;gap:16px;padding:8px 20px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:wrap}
.crumb{display:flex;align-items:center;gap:10px;min-width:0}
.mark{flex:none;color:var(--fg)}
.brand{font-weight:600;letter-spacing:.2px}
.slash{color:var(--faint)}
.subtitle{color:var(--fg-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.statepill{display:inline-flex;align-items:center;gap:10px;margin-left:12px;padding:6px 12px;border-radius:999px;background:var(--chip);white-space:nowrap}
.statepill:has(.state:empty){display:none}
.state{margin:0;font:600 13px/1.2 var(--sans);display:inline-flex;align-items:center;gap:8px;color:var(--fg-2)}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.state svg{width:14px;height:14px;flex:none}
.statepill.rec{background:var(--bad-soft)} .state.rec{color:var(--bad-text)} .state.rec::before{background:var(--rec);box-shadow:0 0 0 4px rgba(210,38,27,.15);animation:halo 1.6s infinite}
.statepill.paused{background:var(--warn-soft)} .state.paused{color:var(--warn-text)} .state.paused::before{background:var(--warn)}
.statepill.done{background:var(--ok-soft)} .state.done{color:var(--ok-text)} .state.done::before,.state.failed::before{display:none}
.statepill.failed{background:var(--bad-soft)} .state.failed{color:var(--bad-text)}
.statepill.working{background:var(--accent-soft)} .state.working{color:var(--accent-text)} .state.working::before{background:var(--accent)}
.state.small{font-size:12.5px}
.timer{font:400 13px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--fg)}
.timer:empty{display:none}
.stats{display:flex;align-items:center;gap:18px;margin-left:8px;font-size:13px;color:var(--fg-2);flex-wrap:wrap}
.stats:empty{display:none}
.stats span{white-space:nowrap}
.stats b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
.stats b.good{color:var(--ok)} .stats b.low{color:var(--warn)} .stats b.bad{color:var(--bad-text)}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.controls:empty{display:none}
.tools{display:flex;align-items:center;gap:2px;padding-left:10px;border-left:1px solid var(--line)}
.tools .tool{min-height:32px;padding:4px 8px;border-color:transparent;background:transparent;color:var(--muted);font-size:12px}
.tools .tool:hover:not(:disabled){background:var(--chip);color:var(--fg)}
.tools .tool[aria-pressed=true]{background:var(--accent-soft);color:var(--accent-text)}
.tools .qa-theme-toggle{width:32px;height:32px;min-height:0;border-radius:8px;color:var(--muted)}
.tools .qa-theme-toggle svg{width:17px;height:17px}
.pausenote{margin:0;padding:8px 20px;background:var(--warn-soft);color:var(--warn-text);font-size:13px;border-bottom:1px solid var(--warn-line)}
.progress{padding:8px 20px 6px;background:var(--surface);border-bottom:1px solid var(--line)}
.progress .bar{height:3px;border-radius:999px;background:var(--line-soft);overflow:hidden}
.progress .bar span{display:block;height:100%;background:var(--accent);width:0;transition:width .3s}
.progress.indeterminate .bar span{width:30%;animation:slide 1.2s ease-in-out infinite}
.progress p{margin:6px 0 0;color:var(--fg-2);font-size:12px}
/* ONGLETS SOULIGNÉS (40 px) : l'actif en noir, souligné de 2 px ; un compte dans une pastille. */
.tabs{display:flex;gap:28px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.tabs [role=tab]{height:40px;min-height:0;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:0 2px;color:var(--fg-2);font:500 14px/1 var(--sans);gap:8px}
.tabs [role=tab]:hover:not(:disabled){background:none;color:var(--fg)}
.tabs [role=tab][aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg)}
.count{font:500 11px/1.5 var(--sans);background:var(--sunken);color:var(--fg-2);border-radius:10px;padding:0 7px;font-variant-numeric:tabular-nums}
.count:empty{display:none}
main{flex:1;padding:20px;min-height:0}
.grid{display:grid;grid-template-columns:1fr;gap:20px;align-items:start}
.col-left{display:grid;gap:20px;min-width:0}
.col-mid{display:none}
@media (min-width:780px){
  .grid{grid-template-columns:minmax(0,1fr) minmax(360px,440px)}
  .grid>.col-left{grid-column:1}
  .grid>.col-side{grid-column:2;display:flex;flex-direction:column;gap:20px;min-height:0}
  .col-mid{display:block}
  .narrow-only{display:none!important}
}
/* En revue (et pendant une correction), l'inspecteur passe devant l'aperçu et s'élargit. */
body[data-phase=REVIEW] .col-side>.col-right{order:-1}
@media (min-width:1200px){body[data-phase=REVIEW] .grid{grid-template-columns:minmax(0,1fr) minmax(380px,520px)}}
/* Grand écran : une application (en-tête fixe, chaque colonne défile pour elle-même). */
@media (min-width:780px) and (min-height:560px){
  body[data-mode=main]{height:100vh;overflow:hidden}
  body[data-mode=main] main{overflow:hidden;display:flex;flex-direction:column}
  body[data-mode=main] main>[role=tabpanel]{flex:1;min-height:0;overflow:auto}
  body[data-mode=main] #panel-recording{display:flex;flex-direction:column;overflow:hidden}
  body[data-mode=main] #review{flex:none;max-height:45%;overflow:auto}
  body[data-mode=main] .grid{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}
  body[data-mode=main] .grid>.col-left{min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;align-content:start}
  body[data-mode=main] .grid>.col-side{max-height:100%}
  body[data-mode=main] .col-side>.col-right{flex:0 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
  body[data-mode=main] .col-side>.col-mid{flex:0 50 auto;min-height:52px;overflow:auto}
}
/* CARTES : rayon 12, bordure 1 px, aucun dégradé. */
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);min-width:0}
.card-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.card-head h2,.card h2{margin:0;font-size:15px;font-weight:600;color:var(--fg)}
.card-head .actions{margin-left:auto;display:flex;gap:4px;align-items:center}
.card-plain{padding:16px;margin-bottom:20px}
.card-plain>h2{margin-bottom:6px}
.card h3{margin:16px 0 8px;font-size:13px;font-weight:600;color:var(--fg)}
.card .meta{color:var(--muted);font-size:12px;margin-top:2px}
.card .tag{display:inline-block;font-size:11px;font-weight:500;border-radius:5px;padding:1px 7px;background:var(--chip);color:var(--fg-2);margin-right:6px}
.sub{color:var(--muted);font-size:12px}
.empty{color:var(--muted)}
.notice{background:var(--sunken);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--fg-2);margin:8px 0 0}
.notice.running::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;border:2px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px}
details>summary{cursor:pointer;font-size:13px;color:var(--fg-2)}
details>summary:hover{color:var(--fg)}
/* LE PARCOURS : recherche dans l'en-tête de la carte, groupes par écran, une ligne par action. */
.journey{overflow:hidden}
.journey .card-head h2{flex:none}
.journey #journey-hint:empty{display:none}
.tl-tools{display:flex;gap:8px;align-items:center;margin-left:auto}
.tl-search{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1px solid var(--line-strong);border-radius:8px;width:220px;color:var(--muted);background:var(--surface)}
.tl-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-chip)}
.tl-search input{border:0;outline:0;padding:0;min-height:0;font-size:13px;width:100%;background:transparent;color:var(--fg)}
.tl-search input:focus-visible{outline:0}
#tlattention{border-color:transparent;background:transparent;color:var(--fg-2)}
#tlattention:hover:not(:disabled){background:var(--chip)}
#tlattention[aria-pressed=true]{background:var(--warn-soft);color:var(--warn-text)}
.livesearch{margin:0;padding:8px 16px;font-size:12.5px;color:var(--accent-text);background:var(--accent-soft);border-bottom:1px solid var(--line-soft);overflow-wrap:anywhere}
.status-line{margin:0;padding:8px 16px;font-size:12.5px;border-bottom:1px solid var(--line-soft);color:var(--fg-2)}
.status-line:empty{display:none}
.status-line.warn{background:var(--warn-soft);color:var(--warn-text)}
.timeline{list-style:none;margin:0;padding:0}
.timeline>li{border-top:1px solid var(--line-soft)}
.timeline>li:first-child{border-top:0}
.timeline>li.group{display:flex;align-items:baseline;gap:10px;padding:14px 16px 6px;border-top:0}
.timeline>li.group .gname{font-size:12px;font-weight:600;color:var(--fg-2)}
.timeline>li.group .groute{font:400 12px/1.4 var(--mono);color:var(--muted)}
.timeline>li.group+li{border-top:0}
/* L'en-tête d'une étape métier (revue) : cercle numéroté, titre, preuve, confiance. */
.timeline>li.bhead{display:flex;align-items:center;gap:12px;padding:16px;flex-wrap:wrap;border-top:1px solid var(--line-soft)}
.timeline>li.bhead:first-child{border-top:0}
.bhead .n{width:26px;height:26px;border-radius:50%;background:var(--fg);color:var(--surface);display:grid;place-items:center;font-size:12px;font-weight:600;flex:none}
.bhead .bt{display:grid;gap:2px;min-width:0}
.bhead .bt b{font-size:15px;font-weight:600}
.bhead .pill{margin-left:auto}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;border-radius:999px;padding:2px 10px;background:var(--chip);color:var(--fg-2);white-space:nowrap}
.pill.CONFIRMED{background:var(--ok-soft);color:var(--ok-text)} .pill.CONFIRMED .dotc{background:var(--ok)}
.pill.PROBABLE{background:var(--accent-soft);color:var(--accent-text)} .pill.PROBABLE .dotc{background:var(--accent)}
.pill.AMBIGUOUS{background:var(--warn-soft);color:var(--warn-text)} .pill.AMBIGUOUS .dotc{background:var(--warn)}
.item{display:grid;grid-template-columns:28px 28px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-height:46px;padding:8px 14px;text-align:left;border:0;border-radius:0;background:transparent;font:400 14px/1.45 var(--sans);color:var(--fg)}
.item:hover:not(:disabled){background:var(--surface-2);border:0}
.item[aria-current=true],.item.follow{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.item .num{color:var(--muted);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.item[aria-current=true] .num,.item.follow .num{color:var(--accent-text);font-weight:600}
.kind{width:28px;height:28px;border-radius:7px;background:var(--chip);color:var(--fg-2);display:grid;place-items:center;flex:none}
.kind svg{width:15px;height:15px}
.item[aria-current=true] .kind,.item.follow .kind{background:var(--accent-chip);color:var(--accent-text)}
.desc{min-width:0;overflow-wrap:anywhere}
.desc .fname{font-weight:500}
.desc .sub{display:block;margin-top:1px}
.desc .route{margin-left:6px}
.item.skipped .desc{color:var(--muted)}
.tech{display:block;font:400 11.5px/1.55 var(--mono);color:var(--fg-2);white-space:pre-wrap;margin-top:6px;background:var(--surface-2);border-radius:6px;padding:6px 8px}
.timeline>li.waiting{display:flex;align-items:center;gap:10px;padding:14px 16px;color:var(--muted);font-size:13px}
.timeline>li.waiting .dotc{background:var(--rec)}
.timeline>li.empty{padding:28px 16px;color:var(--muted);text-align:center;font-size:13px}
/* Une action ambiguë (pendant l'enregistrement) : le choix tout de suite, sous la ligne. */
.attention{margin:0 14px 12px 54px;padding:12px 14px;border-radius:10px;background:var(--warn-soft);border:1px solid var(--warn-line);font-size:13px}
.attention p{margin:0 0 8px}
.attention .atitle{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--warn-text)}
.attention .atitle svg{width:15px;height:15px}
.attention fieldset{border:0;padding:0;margin:6px 0 10px}
.attention legend{font-weight:600;margin-bottom:6px}
.attention label{display:flex;gap:10px;align-items:center;padding:8px 10px;margin-bottom:6px;border-radius:8px;background:var(--surface);border:1px solid var(--line);cursor:pointer}
.attention label:has(input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.attention label span{flex:1;min-width:0;overflow-wrap:anywhere}
.attention label em{font-style:normal;font-size:11px;font-weight:500;border-radius:999px;padding:1px 8px;background:var(--ok-soft);color:var(--ok-text);flex:none}
.attention .sub{margin:0 0 6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.error{color:var(--bad-text);margin:8px 0 0;font-weight:500;font-size:13px}
.checks{border-top:1px solid var(--line-soft);padding:12px 16px}
.checks ul{margin:8px 0 0;padding-left:18px;color:var(--fg-2);font-size:13px}
.checks .sub{margin:6px 0 0}
/* LE BANDEAU DE RÉSULTAT (revue) : sous les onglets, vert ou rouge, une ligne si elle tient. */
#review{display:grid;gap:12px}
#review:empty{display:none}
#review:not(:empty){margin-bottom:20px}
.result{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:var(--surface);margin:0}
.result>svg{width:18px;height:18px;flex:none}
.result .rtitle{font-weight:600}
.result .rmeta{font-size:13px;margin:0}
.result .rside{margin-left:auto}
.result.ok{background:var(--ok-soft);border-color:var(--ok-line)} .result.ok .rtitle{color:var(--ok-text)} .result.ok .rmeta{color:var(--ok-ink)} .result.ok>svg{color:var(--ok)}
.result.bad{background:var(--bad-wash);border-color:var(--bad-line);align-items:flex-start;flex-direction:column}
.result.bad .rhead{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;width:100%}
.result.bad .rhead>svg{width:18px;height:18px;color:var(--bad);flex:none}
.result.bad .rtitle{color:var(--bad-text)} .result.bad .rmeta{color:var(--bad-ink);flex:1 1 260px}
.result.bad .actions{margin-left:auto}
.result.resume{background:var(--accent-wash);border-color:var(--accent-line);flex-direction:column;align-items:flex-start}
.result.resume .rhead{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;width:100%}
.result.resume .rtitle{color:var(--accent-text)}
.result .recov{margin:0;font-size:13px;font-weight:500}
.result .actions{display:flex;gap:8px;flex-wrap:wrap}
.result ul{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:2px 18px;font-size:13px;color:var(--ok-ink)}
.result details{width:100%;border-top:1px solid var(--bad-line);padding-top:8px}
.result details ul{display:grid;gap:2px;margin-top:6px;color:var(--fg-2)}
.result details .tech{background:transparent;padding:0;margin:0}
.result.saved{background:var(--surface)} .result.saved .rtitle{color:var(--ok-text)} .result.saved>svg{color:var(--ok)}
/* L'APERÇU EN DIRECT : une vignette posée sur un fond gris, l'élément sélectionné encadré. */
.preview{overflow:hidden}
.preview .card-head{padding:10px 10px 10px 14px}
.preview .card-head h2{font-size:14px}
.preview .purl{font:400 12px/1.4 var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.preview .card-head .actions button{min-height:30px;padding:4px 8px}
.preview .stage{background:var(--sunken);padding:16px}
.viewport{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface)}
.viewport img{display:block;width:100%;height:auto}
.viewport .hl{position:absolute;border:2px solid var(--accent);border-radius:5px;box-shadow:0 0 0 3px rgba(43,80,216,.15);pointer-events:none}
.viewport .hl span{position:absolute;left:-2px;top:calc(100% + 4px);background:var(--accent);color:#FFFFFF;font:500 11px/1.5 var(--sans);padding:1px 7px;border-radius:5px;white-space:nowrap}
.viewport .hl span.above{top:auto;bottom:calc(100% + 4px)}
.viewport .placeholder{padding:48px 20px;text-align:center;color:var(--muted);margin:0;font-size:13px}
.selnote{display:flex;gap:8px;align-items:center;margin:12px 0 0;font-size:12.5px;color:var(--ok-text)}
.selnote svg{width:15px;height:15px;flex:none}
.selnote.warn{color:var(--warn-text)}
.pickbadge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--accent-text)}
.pickbadge::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
.detached-note{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:10px 14px;border-radius:10px;background:var(--accent-wash);border:1px solid var(--accent-line);color:var(--fg);font-size:13px}
.detached-note:empty{display:none}
.detached-note button{margin-left:auto}
.preview:fullscreen{overflow:auto;padding:20px;background:var(--surface)}
.preview:fullscreen .viewport img{max-height:calc(100vh - 160px);width:auto;max-width:100%;margin:0 auto}
body[data-mode=preview]{background:var(--bg)}
.detached-main{flex:1;padding:20px;display:flex;flex-direction:column}
.preview.detached{flex:1;display:flex;flex-direction:column}
.preview.detached .stage{flex:1;display:flex;align-items:flex-start;justify-content:center}
.preview.detached .viewport{display:inline-block;max-width:100%}
.preview.detached .viewport img{max-height:calc(100vh - 230px);width:auto;max-width:100%}
.preview.detached .viewport .frame{position:relative;display:inline-block;max-width:100%}
.actions-top{display:flex;gap:8px}
/* L'INSPECTEUR : libellé, titre, sous-onglets, clés-valeurs en mots humains. */
.details{overflow:hidden}
.ihead{padding:16px 16px 0;display:grid;gap:10px}
.ihead .itop{display:flex;align-items:center;gap:8px;min-height:28px}
.ihead .itop .st{margin-left:auto}
.ihead .itop button{min-height:28px;padding:0 6px}
.ihead .itop .st+button{margin-left:4px}
.ititle{font-size:16px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.subtabs{display:flex;gap:22px;border-bottom:1px solid var(--line);margin:0 -16px;padding:0 16px}
.subtabs [role=tab]{height:36px;min-height:0;padding:0 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--fg-2);font:500 13px/1 var(--sans)}
.subtabs [role=tab]:hover:not(:disabled){background:none;color:var(--fg)}
.subtabs [role=tab][aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg)}
.ibody{padding:16px;display:grid;gap:18px;min-width:0}
.ibody>*{margin:0}
.ibody.flat{padding-top:14px}
.kv{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 12px;font-size:13px;margin:0}
.kv dt{color:var(--muted);font-size:12px;line-height:1.6}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.kv dd code{font-size:12px;overflow-wrap:anywhere;word-break:break-word}
.kv dd .copy{margin-left:auto;min-height:24px;padding:0 8px;font-size:11.5px}
.kv dd .chip{font-size:11.5px;font-weight:500;border-radius:5px;padding:0 7px;background:var(--chip);color:var(--fg-2)}
.empty-details{color:var(--muted);text-align:center;padding:36px 16px;margin:0;font-size:13px}
.found{margin:0;display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ok-text)}
.found.warn{color:var(--warn-text)}
.found svg{width:15px;height:15px;flex:none}
.box{border:1px solid var(--line);border-radius:10px;padding:14px;display:grid;gap:10px;min-width:0}
.box .bhd{display:flex;align-items:center;gap:8px;min-height:28px}
.box .bhd b{font-size:13px;font-weight:600}
.box .bhd button{margin-left:auto}
.box .bline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--fg-2)}
.iactions{display:flex;gap:8px;flex-wrap:wrap}
.techd{border-top:1px solid var(--line-soft);padding-top:12px}
.techd[open]>summary{margin-bottom:10px}
.techd h4{margin:12px 0 6px;font-size:12px;font-weight:600;color:var(--fg-2)}
.vlist{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:13px}
.vlist li{display:flex;gap:8px;align-items:center}
.vlist li .dotc{background:var(--ok)}
.vlist li.no .dotc{background:var(--warn)}
.netcard{border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:4px;font-size:13px}
.netcard+.netcard{margin-top:8px}
.netcard code{font-size:12.5px;overflow-wrap:anywhere}
.netcard .crit{border-radius:6px;padding:4px 8px;background:var(--accent-soft);color:var(--fg);font-size:12.5px;overflow-wrap:anywhere}
/* LA SOURCE DE LA VALEUR (revue) : l'éditeur s'ouvre par « Modifier ». */
.iedit{border-radius:8px;background:var(--surface-2);padding:12px;margin-top:4px}
.iedit fieldset{border:0;padding:0;margin:0 0 8px;display:flex;flex-wrap:wrap;gap:6px}
.iedit legend{font-weight:600;font-size:13px;margin-bottom:6px;width:100%}
.iedit label.choice{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line-strong);border-radius:8px;padding:5px 10px;background:var(--surface);cursor:pointer;font-size:12.5px}
.iedit label.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.iedit textarea{width:100%;min-height:54px}
.databind{background:transparent;padding:0;margin:0}
.databind input[type=text],.databind select{width:100%;margin:2px 0 8px}
.databind .dsub{display:block;font-size:12px;color:var(--fg-2);margin:6px 0 2px}
.databind .dref{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.databind .dref label.choice{justify-content:flex-start;width:100%}
.databind .dref label.choice small{display:block;color:var(--muted)}
.databind .dnote{font-size:12px;color:var(--fg-2);margin:4px 0 8px}
.databind .dnote.manual{color:var(--accent-text)}
/* LA CORRECTION D'UNE ÉTAPE : avant / après côte à côte, la ligne par colonnes, le pied d'actions. */
.correction{display:grid;gap:14px;min-width:0}
.correction:empty{display:none}
.correction h3{margin:0;font-size:13px;font-weight:600}
.cpanel .chead{padding:16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.cpanel .chead h2{margin:0;font-size:16px;font-weight:500}
.cpanel .chead>div{display:grid;gap:2px}
.cpanel .chead .st{margin-left:auto;white-space:normal}
.cpanel .cbody{padding:16px;display:grid;gap:16px;min-width:0}
.cpanel .cbody>*{margin:0}
.cfoot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid var(--line-soft);padding-top:14px}
.cfoot .lead{margin-right:auto}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tcard{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:6px;min-width:0;align-content:start}
.tcard .thead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.tcard .thead b{font-size:12px;font-weight:400;color:var(--muted)}
.tcard .thead span{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tcard .tname{font-size:13px;overflow-wrap:anywhere}
.tcard .tname b{font-weight:500}
.tcard .trow,.tcard .tmeta{font-size:12.5px;color:var(--fg-2);overflow-wrap:anywhere}
.tcard .tmeta{color:var(--muted);font-size:12px}
.tcard .k{color:var(--fg-2)}
.tcard code{font-size:12px;overflow-wrap:anywhere}
.tcard code.fixed{text-decoration:line-through;color:var(--bad-text)}
.tcard .col{font-weight:500}
.tcard .traw{font-size:11.5px}
.tcard.new{border-color:var(--accent-line);background:var(--accent-wash)} .tcard.new .thead b{color:var(--accent-text)}
.dvar{font:400 12px/1.5 var(--mono);background:var(--var-bg);color:var(--var-fg);border-radius:5px;padding:1px 6px;overflow-wrap:anywhere}
/* « Identifier la ligne par » : une boîte, les façons de faire, puis les colonnes une par ligne. */
.rowbox{border:1px solid var(--line);border-radius:10px;overflow:hidden;min-width:0}
.rowbox .rbhead{padding:12px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.rowbox .rbhead b{font-size:13px;font-weight:600}
.rowopts{border:0;padding:0;margin:0;min-width:0}
.rowopts legend{padding:0}
.ropt{border-top:1px solid var(--line-soft);padding:10px 12px;min-width:0}
.ropt.on{background:var(--accent-wash)}
.ropt label.choice{display:grid;grid-template-columns:20px minmax(0,1fr);gap:0 10px;align-items:start;cursor:pointer;font-size:13px;min-width:0}
.ropt label.choice input{margin-top:3px}
.ropt .otitle{font-weight:500}
.ropt small{display:block;font:400 11.5px/1.5 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.ropt.fixed small{color:var(--bad-text)}
.ropt .ohelp,.ropt .callout{margin:6px 0 0 30px}
.obadge{display:inline-block;margin-left:8px;font:500 11px/1.5 var(--sans);padding:0 7px;border-radius:999px;vertical-align:1px;white-space:nowrap}
.obadge.rec{background:var(--ok-soft);color:var(--ok-text)}
.obadge.run{background:var(--bad-soft);color:var(--bad-text)}
.roweditor{min-width:0}
.roweditor .ohelp{padding:0 12px 10px;margin:0}
.rcol{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:6px 10px;align-items:center;padding:10px 12px;border-top:1px solid var(--line-soft);min-width:0}
.rcol:not(.on){color:var(--muted)}
.rcol .rname{display:grid;gap:2px;min-width:0}
.rcol .rname b{font-size:13px;font-weight:500;color:var(--fg)}
.rcol:not(.on) .rname b{color:var(--fg-2)}
.rcol .rsel{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.rcol .rmore{grid-column:2/4;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px}
.rcol .rmore label{display:grid;gap:2px;font-size:11.5px;color:var(--fg-2);min-width:0}
.rcol .rmore input,.rcol .rmore select{width:100%}
.rcol .rmore .ohelp{grid-column:1/-1;padding:0;margin:0}
.rband{padding:10px 12px;border-top:1px solid var(--line-soft);display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface-2)}
.rband:has(.rpreview.found){background:var(--ok-wash)}
.rband button{margin-left:auto}
.rpreview{margin:0;display:inline-flex;align-items:center;gap:8px;font-size:13px}
.rpreview svg{width:16px;height:16px;flex:none}
.rpreview.found{color:var(--ok-text)}
.rpreview.ambiguous,.rpreview.none,.rpreview.invalid,.rpreview.unavailable{color:var(--warn-text)}
.ohelp{font-size:12px;color:var(--fg-2);margin:0;line-height:1.45}
.callout{display:flex;gap:8px;align-items:flex-start;margin:0;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.45;background:var(--surface-2);color:var(--fg-2)}
.callout.warn{background:var(--warn-soft);color:var(--warn-text)}
.ctech{border-top:1px solid var(--line-soft);padding-top:12px}
.ctech[open]>summary{margin-bottom:10px}
.ctech .order{margin:0 0 10px;font-size:12.5px;color:var(--fg-2)}
.ctech .order ol{margin:4px 0 0;padding-left:18px}
.chist{font-size:12px;color:var(--muted);margin:0}
.warnnote{margin:0;font-size:13px;color:var(--warn-text);font-weight:500}
/* ANALYSE, RÉSEAU, DONNÉES : des cartes simples, des badges discrets. */
.qrow{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.qscore{font:600 28px/1 var(--sans);color:var(--ok);font-variant-numeric:tabular-nums}
.qscore.low{color:var(--warn)}
.qlist{list-style:none;padding:0;margin:0;display:grid;gap:4px;flex:1;font-size:13px;min-width:240px}
.qlist li{display:flex;gap:8px;align-items:center}
.qlist li .dotc{background:var(--ok)} .qlist li.warn .dotc{background:var(--warn)}
.qlist li .v{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.netstep{display:grid;gap:8px}
.netstep+.netstep{margin-top:18px}
.netstep>b{font-size:13px;font-weight:500}
.bflow{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:8px}
.bstep{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--surface)}
.bhead2{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bref{margin-top:4px;font:400 12px/1.5 var(--mono);color:var(--fg)}
.bbadge,.ibadge,.bprov{font-size:11.5px;font-weight:500;border-radius:999px;padding:1px 9px;background:var(--chip);color:var(--fg-2);white-space:nowrap}
.bbadge.CONFIRMED,.ibadge.CONFIRMED,.bprov.CREATED_DURING_RECORDING{background:var(--ok-soft);color:var(--ok-text)}
.bbadge.PROBABLE,.ibadge.OBSERVED,.bprov.DISCOVERED_DURING_RECORDING,.bprov.CONFIRMED_EXISTING{background:var(--accent-soft);color:var(--accent-text)}
.bbadge.AMBIGUOUS,.ibadge.UNCERTAIN,.bprov.AMBIGUOUS{background:var(--warn-soft);color:var(--warn-text)}
.bprov{margin-left:6px}
.barrow{text-align:center;color:var(--muted)}
.atree,.atree ul{list-style:none;margin:6px 0 0;padding:0 0 0 16px;border-left:1px solid var(--line)} .atree{padding-left:0;border-left:0}
.atree li{margin:6px 0} .atree .anode{display:flex;flex-wrap:wrap;align-items:center;gap:6px} .atree .anode b{font-size:13px}
.bent{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:8px} .bent li{border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.bstep details{margin-top:4px}
.bunres{padding-left:18px}
.stable{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}
.stable th{text-align:left;font-size:12px;color:var(--muted);font-weight:500;padding:4px 8px}
.stable td{padding:8px;border-top:1px solid var(--line-soft);vertical-align:top}
.stable code{font-size:12px}
.meter{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:500}
.meter .track{width:110px;height:6px;border-radius:999px;background:var(--line-soft);overflow:hidden}
.meter .track span{display:block;height:100%;background:var(--ok)}
.tokens{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.tokens span{font-size:12px;border-radius:6px;padding:3px 9px;background:var(--surface-2);border:1px solid var(--line)}
.tokens span.from{background:var(--warn-soft);color:var(--warn-text);border-color:transparent}
.search{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.search .shead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.search .shead .meter{margin-left:auto}
#intent-review>.sub{color:var(--fg-2);font-size:13px;line-height:1.6;margin:0 0 14px}
.irow{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px;display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:4px 14px;background:var(--surface)}
.irow>*{grid-column:2}
.irow .iico{grid-column:1;grid-row:1/3;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:var(--chip);color:var(--fg-2)}
.irow .iico svg{width:16px;height:16px}
.irow.HUMAN_CORRECTED{box-shadow:inset 3px 0 0 var(--accent)} .irow.HUMAN_CONFIRMED{box-shadow:inset 3px 0 0 var(--ok)}
.irow .ilabel{font-weight:500;font-size:14px;color:var(--fg)}
.irow .iline{font-size:13px;color:var(--fg-2);margin:2px 0}
.irow .iintent{font:500 12.5px var(--mono);color:var(--fg)}
.irow .iconf{color:var(--ok-text);font-weight:500}
.irow .imeta{color:var(--muted);font-size:12px}
.irow .iactions{grid-row:1/3;grid-column:3;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}
.irow .full{grid-column:2/4}
.isrc{font-size:11px;font-weight:500;border-radius:999px;padding:1px 9px;background:var(--chip);color:var(--fg-2)}
.isrc.HUMAN_CORRECTED{background:var(--accent-soft);color:var(--accent-text)} .isrc.HUMAN_CONFIRMED{background:var(--ok-soft);color:var(--ok-text)}
.irow .iedit{grid-column:2/4}
.lineage{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.lineage>li{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--surface);font-size:13px}
.lineage code{font-weight:500;color:var(--fg)}
.lineage .uses{list-style:disc;margin:6px 0 0 18px;padding:0;color:var(--fg-2);font-size:12px}
.note{color:var(--warn-text);font-size:13px}
/* E · MINI-DOCK : une fenêtre étroite et sombre pendant l'enregistrement (la revue reste complète). */
body.compact{${DARK_TOKENS}}
body.compact .tabs,body.compact .col-side,body.compact .col-mid,body.compact .col-right,body.compact .stats,body.compact #devtoggle,body.compact #tltools,body.compact #checks,body.compact .slash,body.compact .subtitle,body.compact #journey-hint{display:none!important}
body.compact .grid{grid-template-columns:1fr!important}
body.compact .topbar{padding:8px 12px;gap:10px}
body.compact .statepill{margin-left:0}
body.compact main{padding:10px}
body.compact .timeline>li:not(.group):not(.waiting):nth-last-child(n+7),body.compact .timeline>li.group{display:none}
body.compact .controls{flex-basis:100%}
/* FENÊTRE ÉTROITE : tout passe sur une colonne, les marges se resserrent. */
@media (max-width:640px){
  .topbar{padding:8px 12px;gap:10px}.subtitle{display:none}.slash{display:none}.statepill{margin-left:0}
  .stats{margin-left:0;gap:12px}.controls{flex-basis:100%}.tools{border-left:0;padding-left:0}
  .tabs{gap:18px;padding:0 12px;overflow-x:auto}.tabs [role=tab]{white-space:nowrap}
  main{padding:12px}
  .tl-tools{margin-left:0;flex-basis:100%}.tl-search{flex:1;width:auto}
  .attention{margin-left:14px}
  .kv{grid-template-columns:1fr}.kv dt{font-weight:500}
  .irow{grid-template-columns:32px minmax(0,1fr);padding:12px}.irow .iactions{grid-column:2;grid-row:auto;justify-content:flex-start}.irow .full,.irow .iedit{grid-column:2}
}
/* ÉCRAN DE PORTABLE (peu haut, mise à l'échelle Windows 125–150 %) : la même fenêtre, un peu plus dense. */
@media (max-height:820px){
  .topbar{min-height:52px;padding:6px 16px}
  .tabs [role=tab]{height:36px}
  main{padding:14px 16px}
  .grid,.grid>.col-side{gap:14px}
  .item{min-height:40px;padding:5px 14px}
  .card-head{padding:10px 14px}
  .ihead{padding:12px 14px 0}.ibody{padding:14px;gap:14px}
  .preview .stage{padding:12px}
  #review:not(:empty){margin-bottom:14px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const SCRIPT = `
(function () {
  var lang = document.documentElement.lang === 'fr' ? 'fr' : 'en';
  var T = {
    fr: {
      recording: 'Enregistrement', paused: 'Enregistrement en pause', finalizing: 'Finalisation…', review: 'Enregistrement terminé',
      pause: 'Pause', resume: 'Reprendre', stop: 'Arrêter', undo: 'Annuler la dernière',
      pauseLabel: "Mettre l'enregistrement en pause", resumeLabel: "Reprendre l'enregistrement", stopLabel: "Arrêter l'enregistrement", undoLabel: 'Retirer la dernière action du recording',
      pausedNote: 'Les actions ne sont plus enregistrées. La page reste utilisable.',
      actions: function (n) { return n + ' action' + (n > 1 ? 's' : ''); },
      tabRecording: 'Parcours', tabAnalysis: 'Analyse', tabs: 'Vues', user: 'Utilisateur', dev: 'Développeur',
      timeline: 'Parcours enregistré', empty: "Aucune action pour l'instant : utilisez l'application.",
      status: { CONFIRMED: 'confirmée', PENDING: 'en cours de validation', AMBIGUOUS: 'ambiguë', FAILED: 'échec', UNVERIFIED: 'non vérifiable' },
      valid: 'Recording valide', allConfirmed: function (n) { return n + ' action' + (n > 1 ? 's' : '') + ' confirmée' + (n > 1 ? 's' : ''); },
      needsCheck: 'Recording nécessite une vérification', confirmedN: function (n) { return n + ' confirmée' + (n > 1 ? 's' : ''); },
      ambiguousN: function (n) { return n + ' action' + (n > 1 ? 's' : '') + ' ambiguë' + (n > 1 ? 's' : ''); },
      failedN: function (n) { return n + ' cible' + (n > 1 ? 's' : '') + ' non retrouvée' + (n > 1 ? 's' : ''); },
      pendingN: function (n) { return n + ' en cours de validation'; },
      attention: function (n) { return n + ' nécessite' + (n > 1 ? 'nt' : '') + ' votre attention'; },
      toCheck: function (n) { return n + ' action' + (n > 1 ? 's' : '') + ' à vérifier avant le rejeu'; },
      ambiguousTitle: 'Action ambiguë', matches: function (n) { return n + ' éléments correspondent.'; },
      resolve: 'Résoudre', ignore: 'Ignorer', confirm: 'Confirmer', cancel: 'Annuler',
      validate: 'Valider cet élément', show: 'Montrer dans la page', touchedTag: 'touché',
      ambHelp: "Le rejeu pourrait viser un autre élément. Vérifiez dans la page l'élément mis en évidence, puis validez-le.",
      which: 'Quel élément voulez-vous enregistrer ?',
      notTouched: "Ce n'est pas l'élément que vous avez touché : annulez l'action (↶) et refaites-la sur le bon élément.",
      ignored: 'Laissée telle quelle : elle sera vérifiée au rejeu.',
      detailsTitle: "Détails de l'action", close: 'Fermer',
      compact: 'Compact', full: 'Complet', layoutLabel: 'Basculer entre la fenêtre complète et le mini-dock',
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
      done: 'Enregistrement terminé', recorded: function (n) { return '<b>' + n + '</b> action' + (n > 1 ? 's' : '') + ' enregistrée' + (n > 1 ? 's' : ''); },
      confirmedS: function (n) { return '<b>' + n + '</b> confirmée' + (n > 1 ? 's' : ''); }, ambS: function (n) { return '<b>' + n + '</b> ambiguïté' + (n > 1 ? 's' : ''); },
      duration: 'Durée', finish: 'Fermer', restart: 'Recommencer',
      recommend: 'Conseillé : rejouez le flow avant de le sauvegarder.',
      replaying: function (a, b) { return 'Rejeu en cours… étape ' + a + ' sur ' + b; },
      replayOk: 'Rejeu réussi', executed: function (a, b) { return a + ' / ' + b + ' actions exécutées'; },
      replayBad: 'Rejeu interrompu', stepOf: function (a, b) { return 'Étape ' + a + ' sur ' + b; }, cause: 'Cause', seeDetails: 'Voir les détails', editStep: "Modifier l'étape",
      resumeTitle: function (n, d) { return 'Contexte gardé devant l’étape ' + n + ' · ' + d; }, resumeHelp: "La page de l'application est restée dans l'état de cette étape (même run, mêmes données). Reprendre vérifie le contexte, puis rejoue l'étape corrigée et la suite.",
      resumeHere: 'Reprendre ici', restartFromStart: 'Rejouer depuis le début', resumedAt: function (n, s) { return 'Repris à l’étape ' + n + ' · ' + s; }, resumeBlocked: function (n, s) { return 'Reprise bloquée à l’étape ' + n + ' · ' + s; },
      strategy: { REVALIDATE: 'contexte vérifié', RESTORE: 'champs restaurés', REBUILD: 'contexte reconstruit', MANUAL_RECOVERY: 'reprise manuelle requise' },
      recoveredSteps: function (l) { return 'Étapes rejouées pour le contexte : ' + l; },
      saved: 'Flow sauvegardé', remove: "Retirer l'étape", removeLabel: function (d) { return "Retirer l'étape « " + d + ' » du flow'; },
      checks: function (n) { return n + ' vérification' + (n > 1 ? 's' : '') + ' ajoutée' + (n > 1 ? 's' : '') + ' automatiquement'; }, checksNote: 'Déduites des résultats observés : ce ne sont pas des actions enregistrées.',
      analysisTitle: 'Analyse', analysisNote: "L'analyse ne modifie jamais le recording. Elle est disponible après l'arrêt.", analysisWaiting: "L'analyse sera disponible après l'arrêt de l'enregistrement.",
      business: 'Interprétation métier', businessNote: "Déduite du parcours enregistré : jamais une étape ajoutée au flow.", noBusiness: 'Aucune interprétation métier sûre.', recordedActions: 'Actions enregistrées', observed: 'Observé', deduced: 'Déduit', uncertain: 'Incertain (jamais une vérité métier)', candidatesL: 'Possibles', bstatus: { CONFIRMED: 'Confirmé', PROBABLE: 'Probable', AMBIGUOUS: 'Ambigu', UNKNOWN: 'Inconnu' }, aiChoice: 'choix de l’IA parmi les candidats observés', referenceL: 'référence', baction: { create: 'CRÉER', search: 'RECHERCHER', retrieve: 'RETROUVER', correlate: 'CORRÉLER', open: 'OUVRIR', update: 'MODIFIER', save: 'ENREGISTRER', delete: 'SUPPRIMER' }, entitiesL: 'Entités observées', applicationL: 'Application', applicationNote: 'Ce que le Recorder comprend de l’application (contextes, tasks, entités, relations). Les actions techniques restent dans le parcours.', evidenceL: 'Preuves', istatus: { OBSERVED: 'Observé', DEDUCED: 'Déduit', CONFIRMED: 'Confirmé', UNCERTAIN: 'Incertain' }, actionLevels: function (c) { return c.recorded + ' actions enregistrées · ' + c.validated + ' validées · ' + c.interpreted + ' interprétées · ' + c.uninterpreted + ' non interprétées (UNKNOWN, normal pour une application inconnue)'; }, provenanceL: { CREATED_DURING_RECORDING: 'créée pendant l’enregistrement', CONFIRMED_EXISTING: 'existait déjà (écran de départ)', DISCOVERED_DURING_RECORDING: 'découverte (origine inconnue)', UNKNOWN: 'provenance inconnue', AMBIGUOUS: 'provenance ambiguë' },
      httpLive: function (h) { return h.network + ' requêtes · ' + h.correlated + ' reliées · ' + h.hypotheses + ' hypothèses' + (h.inconsistencies ? ' · ' + h.inconsistencies + ' incohérences' : '') + (h.failed ? ' · analyse en erreur' : '') + ' (provisoire)'; }, httpL: 'Analyse HTTP', httpNote: 'Requêtes, corrélations et correspondances : consolidées après l’arrêt (un « VALIDATED » exige des preuves suffisantes ; le reste est une hypothèse).', httpFailed: 'L’analyse différée a échoué : les événements bruts et le journal réseau sont conservés.', httpCounts: function (c) { return c.events + ' événements · ' + c.network + ' requêtes · ' + c.correlated + ' reliées · ' + c.independent + ' indépendantes · ' + c.hypotheses + ' hypothèses à confirmer · ' + c.inconsistencies + ' incohérences · ' + c.revisions + ' révisions du direct'; }, httpMappings: 'Champ ↔ propriété', httpIncons: 'Incohérences', httpRevisions: 'Révisions', intents: 'Intents métier', noIntent: 'Aucun intent métier (aucune écriture ni recherche métier corrélée).', searchL: 'Recherche', critL: 'Critères détectés', apiL: 'API', opL: 'Opérateur', valL: 'Valeur', logicL: 'Logique', sortL: 'Tri', paramsL: 'Paramètres techniques', techL: 'Classification technique (distincte)', fromCreateL: 'valeur issue de la création', searchesL: 'Recherches reconnues', roles: { PAGINATION: 'pagination', OPTION: 'options d’inclusion', CONTEXT: 'contexte', CRITERION_FLAG: 'indicateurs de critère' }, liveSearch: 'recherche détectée', technicalIntents: 'Intents techniques (jamais métier)', possibleCreate: 'création possible, non prouvée', confidence: 'Confiance', why: 'Voir pourquoi', findings: 'Constats et suggestions', noFinding: 'Aucun constat.', ai: function (n) { return n + ' suggestion(s) de connaissance proposée(s) par l’IA (à revoir).'; },
      origin: { DETERMINISTIC: 'Analyse déterministe', AI_PROPOSAL: 'Proposition IA' },
      announceAdded: 'Action ajoutée : ', announceUndo: 'Dernière action retirée.', toReview: 'à vérifier'
    },
    en: {
      recording: 'Recording', paused: 'Recording paused', finalizing: 'Finalizing…', review: 'Recording finished',
      pause: 'Pause', resume: 'Resume', stop: 'Stop', undo: 'Undo the last one',
      pauseLabel: 'Pause the recording', resumeLabel: 'Resume the recording', stopLabel: 'Stop the recording', undoLabel: 'Remove the last action from the recording',
      pausedNote: 'Actions are not recorded. The page stays usable.',
      actions: function (n) { return n + ' action' + (n === 1 ? '' : 's'); },
      tabRecording: 'Journey', tabAnalysis: 'Analysis', tabs: 'Views', user: 'User', dev: 'Developer',
      timeline: 'Recorded journey', empty: 'No action yet: use the application.',
      status: { CONFIRMED: 'confirmed', PENDING: 'being validated', AMBIGUOUS: 'ambiguous', FAILED: 'failed', UNVERIFIED: 'not verifiable' },
      valid: 'Recording valid', allConfirmed: function (n) { return n + ' action' + (n === 1 ? '' : 's') + ' confirmed'; },
      needsCheck: 'Recording needs a check', confirmedN: function (n) { return n + ' confirmed'; },
      ambiguousN: function (n) { return n + ' ambiguous action' + (n === 1 ? '' : 's'); },
      failedN: function (n) { return n + ' target' + (n === 1 ? '' : 's') + ' not found again'; },
      pendingN: function (n) { return n + ' being validated'; },
      attention: function (n) { return n + ' need' + (n === 1 ? 's' : '') + ' your attention'; },
      toCheck: function (n) { return n + ' action' + (n === 1 ? '' : 's') + ' to check before the replay'; },
      ambiguousTitle: 'Ambiguous action', matches: function (n) { return n + ' elements match.'; },
      resolve: 'Resolve', ignore: 'Ignore', confirm: 'Confirm', cancel: 'Cancel',
      validate: 'Validate this element', show: 'Show in the page', touchedTag: 'touched',
      ambHelp: 'The replay could aim at another element. Check the highlighted element in the page, then validate it.',
      which: 'Which element do you want to record?',
      notTouched: 'This is not the element you touched: undo the action (↶) and do it again on the right element.',
      ignored: 'Left as is: it will be checked at replay.',
      detailsTitle: 'Action details', close: 'Close',
      compact: 'Compact', full: 'Full', layoutLabel: 'Switch between the full window and the mini dock',
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
      done: 'Recording finished', recorded: function (n) { return '<b>' + n + '</b> action' + (n === 1 ? '' : 's') + ' recorded'; },
      confirmedS: function (n) { return '<b>' + n + '</b> confirmed'; }, ambS: function (n) { return '<b>' + n + '</b> ambiguit' + (n === 1 ? 'y' : 'ies'); },
      duration: 'Duration', finish: 'Close', restart: 'Try again',
      recommend: 'Recommended: replay the flow before saving it.',
      replaying: function (a, b) { return 'Replaying… step ' + a + ' of ' + b; },
      replayOk: 'Replay passed', executed: function (a, b) { return a + ' / ' + b + ' actions executed'; },
      replayBad: 'Replay stopped', stepOf: function (a, b) { return 'Step ' + a + ' of ' + b; }, cause: 'Cause', seeDetails: 'See the details', editStep: 'Edit the step',
      resumeTitle: function (n, d) { return 'Context kept before step ' + n + ' · ' + d; }, resumeHelp: 'The application page stayed in the state of this step (same run, same data). Resuming checks the context, then replays the corrected step and the rest.',
      resumeHere: 'Resume here', restartFromStart: 'Replay from the start', resumedAt: function (n, s) { return 'Resumed at step ' + n + ' · ' + s; }, resumeBlocked: function (n, s) { return 'Resume blocked at step ' + n + ' · ' + s; },
      strategy: { REVALIDATE: 'context verified', RESTORE: 'fields restored', REBUILD: 'context rebuilt', MANUAL_RECOVERY: 'manual resume required' },
      recoveredSteps: function (l) { return 'Steps replayed for the context: ' + l; },
      saved: 'Flow saved', remove: 'Remove the step', removeLabel: function (d) { return 'Remove the step "' + d + '" from the flow'; },
      checks: function (n) { return n + ' check' + (n === 1 ? '' : 's') + ' added automatically'; }, checksNote: 'Inferred from the observed results: these are not recorded actions.',
      analysisTitle: 'Analysis', analysisNote: 'The analysis never changes the recording. It is available after Stop.', analysisWaiting: 'The analysis will be available once the recording is stopped.',
      business: 'Business interpretation', businessNote: 'Deduced from the recorded journey: never a step added to the flow.', noBusiness: 'No reliable business interpretation.', recordedActions: 'Recorded actions', observed: 'Observed', deduced: 'Deduced', uncertain: 'Uncertain (never a business fact)', candidatesL: 'Possible', bstatus: { CONFIRMED: 'Confirmed', PROBABLE: 'Probable', AMBIGUOUS: 'Ambiguous', UNKNOWN: 'Unknown' }, aiChoice: 'AI choice among the observed candidates', referenceL: 'reference', baction: { create: 'CREATE', search: 'SEARCH', retrieve: 'RETRIEVE', correlate: 'CORRELATE', open: 'OPEN', update: 'UPDATE', save: 'SAVE', delete: 'DELETE' }, entitiesL: 'Observed entities', applicationL: 'Application', applicationNote: 'What the Recorder understands of the application (contexts, tasks, entities, relations). The technical actions stay in the journey.', evidenceL: 'Evidence', istatus: { OBSERVED: 'Observed', DEDUCED: 'Deduced', CONFIRMED: 'Confirmed', UNCERTAIN: 'Uncertain' }, actionLevels: function (c) { return c.recorded + ' recorded actions · ' + c.validated + ' validated · ' + c.interpreted + ' interpreted · ' + c.uninterpreted + ' not interpreted (UNKNOWN, normal for an unknown application)'; }, provenanceL: { CREATED_DURING_RECORDING: 'created during the recording', CONFIRMED_EXISTING: 'already existed (starting screen)', DISCOVERED_DURING_RECORDING: 'discovered (origin unknown)', UNKNOWN: 'unknown provenance', AMBIGUOUS: 'ambiguous provenance' },
      httpLive: function (h) { return h.network + ' requests · ' + h.correlated + ' linked · ' + h.hypotheses + ' hypotheses' + (h.inconsistencies ? ' · ' + h.inconsistencies + ' inconsistencies' : '') + (h.failed ? ' · analysis error' : '') + ' (provisional)'; }, httpL: 'HTTP analysis', httpNote: 'Requests, correlations and mappings: consolidated after the stop (VALIDATED needs sufficient evidence; the rest is a hypothesis).', httpFailed: 'The deferred analysis failed: the raw events and the network journal are kept.', httpCounts: function (c) { return c.events + ' events · ' + c.network + ' requests · ' + c.correlated + ' linked · ' + c.independent + ' independent · ' + c.hypotheses + ' hypotheses to confirm · ' + c.inconsistencies + ' inconsistencies · ' + c.revisions + ' revisions of the live analysis'; }, httpMappings: 'Field ↔ property', httpIncons: 'Inconsistencies', httpRevisions: 'Revisions', intents: 'Business intents', noIntent: 'No business intent (no correlated business write or search).', searchL: 'Search', critL: 'Detected criteria', apiL: 'API', opL: 'Operator', valL: 'Value', logicL: 'Logic', sortL: 'Sort', paramsL: 'Technical parameters', techL: 'Technical classification (separate)', fromCreateL: 'value from the creation', searchesL: 'Recognised searches', roles: { PAGINATION: 'pagination', OPTION: 'inclusion options', CONTEXT: 'context', CRITERION_FLAG: 'criterion flags' }, liveSearch: 'search detected', technicalIntents: 'Technical intents (never business)', possibleCreate: 'possible creation, not proven', confidence: 'Confidence', why: 'See why', findings: 'Findings and suggestions', noFinding: 'No finding.', ai: function (n) { return n + ' knowledge suggestion(s) proposed by the AI (to review).'; },
      origin: { DETERMINISTIC: 'Deterministic analysis', AI_PROPOSAL: 'AI proposal' },
      announceAdded: 'Action added: ', announceUndo: 'Last action removed.', toReview: 'to review'
    }
  }[lang];

  var X = {
    fr: {
      replayShort: 'Rejouer', tabNetwork: 'Réseau', tabData: 'Données de test',
      sActions: function (n) { return '<b>' + n + '</b> action' + (n > 1 ? 's' : ''); }, sLinked: function (n) { return '<b>' + n + '</b> requête' + (n > 1 ? 's' : '') + ' reliée' + (n > 1 ? 's' : ''); }, sToCheck: function (n) { return '<b>' + n + '</b> à vérifier'; }, sQuality: 'Qualité',
      journeyHint: 'Les actions apparaissent dès que vous les faites', waiting: "En attente de la prochaine action dans l'application",
      replayed: 'Rejouée', failedStep: 'Échec', notReplayed: 'Non rejouée', replayingStep: 'Rejeu…', queued: 'En attente', replayRunning: 'Rejeu en cours', failedAt: function (n) { return "Rejeu interrompu à l'étape " + n; },
      kElement: 'Élément', kPlace: 'Emplacement', kLocate: 'Repérage', kData: 'Donnée', kStable: 'stable', kFragile: 'fragile', kUnique: 'unique',
      strategyName: { role: 'Rôle et nom accessible', label: 'Libellé du champ', testId: 'Identifiant de test', text: 'Texte visible', placeholder: 'Texte indicatif', altText: 'Texte alternatif', title: 'Info-bulle', css: 'Sélecteur CSS', xpath: 'XPath' },
      roleName: { button: 'Bouton', link: 'Lien', textbox: 'Champ texte', searchbox: 'Champ de recherche', combobox: 'Liste déroulante', listbox: 'Liste', option: 'Option', checkbox: 'Case à cocher', radio: 'Bouton radio', switch: 'Interrupteur', tab: 'Onglet', menuitem: 'Élément de menu', row: 'Ligne', cell: 'Cellule', spinbutton: 'Champ numérique', heading: 'Titre', img: 'Image', label: 'Champ', placeholder: 'Champ', text: 'Texte', testId: 'Élément', css: 'Élément' },
      kindElement: { fill: 'Champ', select: 'Liste déroulante', check: 'Case à cocher', uncheck: 'Case à cocher', choose: 'Option', click: 'Élément', upload: 'Champ de fichier', drag: 'Élément' },
      proofL: 'Preuve', closeData: 'Fermer l’éditeur de la source',
      dataFixed: 'Valeur fixe', dataGenerated: 'générée à chaque rejeu', dataReused: 'réutilisée d’une étape précédente', dataRecorded: function (v) { return 'Valeur enregistrée : ' + v; }, dataSecret: 'Valeur secrète (variable d’environnement)', modify: 'Modifier', modifyData: 'Modifier la source de la valeur',
      stepN: function (n) { return 'Étape ' + n; }, actionN: function (n) { return 'Action ' + n; },
      subDetails: 'Détails', subTarget: 'Cible', subNetwork: 'Réseau', subTabs: 'Sections du détail', techDetails: 'Détails techniques',
      cFix: 'Corriger la cible', cPicked: 'Élément désigné dans la page', cRowAll: 'toutes les colonnes cochées doivent correspondre', cOrderTech: 'Ordre de résolution et détails techniques',
      rRead: function (v) { return 'Lu : ' + v; }, rCompare: 'Comparaison', rEquals: 'égale', rContainsS: 'contient',
      netTitle: 'Requêtes reliées aux actions', netNone: 'Aucune requête métier reliée pour l’instant.', netLive: 'En direct (provisoire)',
      qualityTitle: 'Qualité du recording',
      subtitle: 'Enregistrement de parcours', devMode: 'Mode développeur', active: 'Actif', inactive: 'En pause',
      tabPreview: 'Aperçu', previewTitle: 'Aperçu en direct', refresh: 'Actualiser', noPreview: "L'aperçu de la page apparaît après la première action.",
      selected: 'Élément sélectionné dans la page', isHighlighted: function (l) { return '« ' + l + ' » est surligné'; }, notFoundShort: 'Introuvable sur la page actuelle',
      stepOf2: function (a, b) { return 'Étape ' + a + ' sur ' + b; }, general: 'Informations générales', selectors: 'Sélecteurs et attributs', validation: 'Validation', logs: 'Voir les logs techniques', copy: 'Copier', copied: 'Copié',
      pick: 'Sélectionnez une action pour voir ses détails.', hideDetails: 'Masquer les détails',
      replayFlow: 'Rejouer le parcours', saveFlow2: 'Sauvegarder le flow', afterStop: "Disponible après l'arrêt de l'enregistrement",
      pill: { CONFIRMED: 'Confirmée', PENDING: 'Vérification…', AMBIGUOUS: 'Ambiguë', FAILED: 'Échec', UNVERIFIED: 'Non vérifiable' },
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
      cOld: 'Avant', cNew: 'Après', cCorrected: 'Corrigée', cRole: 'Rôle', cName: 'Nom accessible', cText: 'Texte', cTestId: 'testId', cCss: 'CSS de repli', cContext: 'Contexte',
      cOrder: 'Ordre de résolution au rejeu', cTest: "Tester l'étape", cCancel: 'Annuler', cApply: 'Valider la correction', cAmbiguous: 'Plusieurs éléments correspondent encore : la section ou le contexte départagera au rejeu.',
      cRowTitle: 'Identifier la ligne par', cRowBound: function (v) { return 'La donnée du run « ' + v + ' »'; }, cRowBoundHelp: 'La ligne créée pendant le run est retrouvée à chaque rejeu, quelle que soit sa clé.',
      cRowKey: 'La clé lue dans le tableau', cRowFixed: 'Clé propre à ce run : le prochain rejeu crée une autre ligne et ne la retrouvera pas.',
      cRowContains: 'la cellule contient la donnée', cRowVariable: 'Donnée du run', rContains: 'La cellule contient la valeur (sinon : égale)',
      cRowNoMatch: "Aucune cellule de cette ligne n'est égale à une donnée du run : liez une colonne vous-même.", cRowNoData: "Aucune donnée du run n'est connue avant cette étape : seule la clé du tableau peut identifier la ligne.",
      cHistory: 'Historique des corrections', cOriginal: 'Original', cCorrection: 'Correction', cBy: 'Corrigé par', cUser: 'Utilisateur', cDate: 'Date', cRestore: "Restaurer l'original", cUnknown: 'non retrouvée', cCurrent: 'Cible actuelle',
      cRowL: 'Ligne', cContainsW: 'contient', cRecommended: 'Recommandé', cRunOnly: 'Propre à ce run', cTech: 'Détails techniques',
      cRowColumns: 'Choisir les colonnes de la ligne', rEdit: 'Modifier la ligne', rApply: 'Valider la ligne',
      rHelp: 'Cochez les colonnes qui identifient la ligne : au rejeu, toutes doivent correspondre.', rRecorded: 'valeur lue',
      rSource: 'Source de la valeur', rSrcRecorded: 'Valeur lue (fixe)', rSrcValue: 'Valeur modifiée (fixe)', rSrcVariable: 'Donnée du run', rSrcNew: 'Nouvelle donnée de test',
      rValue: 'Valeur', rNewKey: 'Nom de la donnée', rNewHelp: 'Ajoutée à test-data.yaml : modifiez-y la valeur sans toucher au flow.', rPreviewBtn: 'Aperçu dans la page',
      rPreview: function (p) { return p.status === 'FOUND' ? '1 ligne correspond dans la page ouverte.' : p.status === 'AMBIGUOUS' ? p.matches + ' lignes correspondent : ajoutez une colonne.' : p.status === 'NONE' ? 'Aucune ligne ne correspond dans la page ouverte.' : p.status === 'UNAVAILABLE' ? "Aperçu indisponible : aucune page de l'application n'est ouverte (« Corriger dans le navigateur » l'ouvre)." : (p.message || ''); }
    },
    en: {
      replayShort: 'Replay', tabNetwork: 'Network', tabData: 'Test data',
      sActions: function (n) { return '<b>' + n + '</b> action' + (n === 1 ? '' : 's'); }, sLinked: function (n) { return '<b>' + n + '</b> linked request' + (n === 1 ? '' : 's'); }, sToCheck: function (n) { return '<b>' + n + '</b> to check'; }, sQuality: 'Quality',
      journeyHint: 'Actions appear as soon as you do them', waiting: 'Waiting for the next action in the application',
      replayed: 'Replayed', failedStep: 'Failed', notReplayed: 'Not replayed', replayingStep: 'Replaying…', queued: 'Waiting', replayRunning: 'Replay running', failedAt: function (n) { return 'Replay stopped at step ' + n; },
      kElement: 'Element', kPlace: 'Location', kLocate: 'Located by', kData: 'Data', kStable: 'stable', kFragile: 'fragile', kUnique: 'unique',
      strategyName: { role: 'Role and accessible name', label: 'Field label', testId: 'Test id', text: 'Visible text', placeholder: 'Placeholder', altText: 'Alternative text', title: 'Tooltip', css: 'CSS selector', xpath: 'XPath' },
      roleName: { button: 'Button', link: 'Link', textbox: 'Text field', searchbox: 'Search field', combobox: 'Drop-down list', listbox: 'List', option: 'Option', checkbox: 'Checkbox', radio: 'Radio button', switch: 'Switch', tab: 'Tab', menuitem: 'Menu item', row: 'Row', cell: 'Cell', spinbutton: 'Number field', heading: 'Heading', img: 'Image', label: 'Field', placeholder: 'Field', text: 'Text', testId: 'Element', css: 'Element' },
      kindElement: { fill: 'Field', select: 'Drop-down list', check: 'Checkbox', uncheck: 'Checkbox', choose: 'Option', click: 'Element', upload: 'File field', drag: 'Element' },
      proofL: 'Evidence', closeData: 'Close the source editor',
      dataFixed: 'Fixed value', dataGenerated: 'generated at every replay', dataReused: 'reused from an earlier step', dataRecorded: function (v) { return 'Recorded value: ' + v; }, dataSecret: 'Secret value (environment variable)', modify: 'Edit', modifyData: 'Edit the value source',
      stepN: function (n) { return 'Step ' + n; }, actionN: function (n) { return 'Action ' + n; },
      subDetails: 'Details', subTarget: 'Target', subNetwork: 'Network', subTabs: 'Detail sections', techDetails: 'Technical details',
      cFix: 'Correct the target', cPicked: 'Element designated in the page', cRowAll: 'every ticked column must match', cOrderTech: 'Resolution order and technical details',
      rRead: function (v) { return 'Read: ' + v; }, rCompare: 'Comparison', rEquals: 'equals', rContainsS: 'contains',
      netTitle: 'Requests linked to the actions', netNone: 'No business request linked yet.', netLive: 'Live (provisional)',
      qualityTitle: 'Recording quality',
      subtitle: 'Journey recording', devMode: 'Developer mode', active: 'Active', inactive: 'Paused',
      tabPreview: 'Preview', previewTitle: 'Live preview', refresh: 'Refresh', noPreview: 'The page preview appears after the first action.',
      selected: 'Element selected in the page', isHighlighted: function (l) { return '"' + l + '" is highlighted'; }, notFoundShort: 'Not found on the current page',
      stepOf2: function (a, b) { return 'Step ' + a + ' of ' + b; }, general: 'General information', selectors: 'Selectors and attributes', validation: 'Validation', logs: 'See the technical logs', copy: 'Copy', copied: 'Copied',
      pick: 'Select an action to see its details.', hideDetails: 'Hide the details',
      replayFlow: 'Replay the journey', saveFlow2: 'Save the flow', afterStop: 'Available once the recording is stopped',
      pill: { CONFIRMED: 'Confirmed', PENDING: 'Checking…', AMBIGUOUS: 'Ambiguous', FAILED: 'Failed', UNVERIFIED: 'Not verifiable' },
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
      cOld: 'Before', cNew: 'After', cCorrected: 'Corrected', cRole: 'Role', cName: 'Accessible name', cText: 'Text', cTestId: 'testId', cCss: 'Fallback CSS', cContext: 'Context',
      cOrder: 'Resolution order at replay', cTest: 'Test the step', cCancel: 'Cancel', cApply: 'Confirm the correction', cAmbiguous: 'Several elements still match: the section or the context decides at replay.',
      cRowTitle: 'Identify the row by', cRowBound: function (v) { return 'The run value "' + v + '"'; }, cRowBoundHelp: 'The row created during the run is found at every replay, whatever its key.',
      cRowKey: 'The key read in the table', cRowFixed: 'Key specific to this run: the next replay creates another row and will not find it.',
      cRowContains: 'the cell contains the value', cRowVariable: 'Run value', rContains: 'The cell contains the value (otherwise: equals)',
      cRowNoMatch: 'No cell of this row equals a run value: bind a column yourself.', cRowNoData: 'No run value is known before this step: only the table key can identify the row.',
      cHistory: 'Correction history', cOriginal: 'Original', cCorrection: 'Correction', cBy: 'Corrected by', cUser: 'User', cDate: 'Date', cRestore: 'Restore the original', cUnknown: 'not found', cCurrent: 'Current target',
      cRowL: 'Row', cContainsW: 'contains', cRecommended: 'Recommended', cRunOnly: 'This run only', cTech: 'Technical details',
      cRowColumns: 'Choose the columns of the row', rEdit: 'Edit the row', rApply: 'Confirm the row',
      rHelp: 'Tick the columns that identify the row: at replay, all of them must match.', rRecorded: 'value read',
      rSource: 'Value source', rSrcRecorded: 'Value read (fixed)', rSrcValue: 'Edited value (fixed)', rSrcVariable: 'Run value', rSrcNew: 'New test data',
      rValue: 'Value', rNewKey: 'Data name', rNewHelp: 'Added to test-data.yaml: change the value there without touching the flow.', rPreviewBtn: 'Preview in the page',
      rPreview: function (p) { return p.status === 'FOUND' ? '1 row matches in the open page.' : p.status === 'AMBIGUOUS' ? p.matches + ' rows match: add a column.' : p.status === 'NONE' ? 'No row matches in the open page.' : p.status === 'UNAVAILABLE' ? 'Preview unavailable: no application page is open ("Correct in the browser" opens one).' : (p.message || ''); }
    }
  }[lang];
  Object.keys(X).forEach(function (k) { T[k] = X[k]; });

  var ICON = { CONFIRMED: '✓', PENDING: '●', AMBIGUOUS: '!', FAILED: '✕', UNVERIFIED: '' };
  // Pictogrammes des gestes (SVG complets) : une table à part, jamais la même que celle des boutons (SVG).
  var KIND_SVG = {
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 6h14M12 6v13"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg>',
    cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 3l14 7-6 2-2 6z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>'
  };
  var KIND_ICON = { open: 'arrow', navigate: 'arrow', goto: 'arrow', click: 'cursor', fill: 'text', check: 'check', uncheck: 'check', choose: 'check', select: 'list', key: 'hash', drag: 'move', dragAndDrop: 'move', upload: 'clip', manual: 'hash', dialog: 'list' };
  var state = null, selected = null, choice = {}, dev = false, tab = 'recording';
  // L'inspecteur : le sous-onglet ouvert (Détails, Cible, Réseau) et l'étape pour laquelle il l'est.
  var inspTab = 'details', inspFor = null;
  // L'éditeur de la source de la valeur, ouvert ou non par étape (« Modifier »).
  var dataOpen = {};
  var focused = null, scrolledTo = null;
  // L'option de ligne choisie pour une correction (bound, key), par étape : gardée entre deux rendus.
  var rowChoice = {};
  // Le choix des colonnes de la ligne, par étape : { colonne: { on, source, value, key, newKey, match } }.
  var rowDraft = {};
  // « Modifier la ligne » (revue, sans navigateur) ouvert, par étape : la cible au moment de l'ouverture.
  var rowEditOpen = {};
  // « Détails techniques » d'une correction ouverts ou non, par étape : gardé entre deux rendus.
  var techOpen = {};
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
    dot: '<circle cx="12" cy="12" r="4"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
    okCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 10"/>',
    badCircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
    attach: '<path d="M10 14L4 20M4 14v6h6"/><rect x="11" y="4" width="9" height="9" rx="1"/>',
    layout: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M14 4v16"/>'
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

  /** La phase affichée dans la pastille d'état : l'enregistrement, puis le dernier rejeu s'il a échoué. */
  function renderHead() {
    var p = state.phase, st = $('state'), pill = $('statepill'), r = state.replay;
    document.body.setAttribute('data-phase', p);
    $('subtitle').textContent = state.name || T.subtitle;
    var cls = p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working';
    var label = p === 'RECORDING' ? T.recording : p === 'PAUSED' ? T.paused : p === 'FINALIZING' ? T.finalizing : T.review;
    var icon = p === 'REVIEW' ? svg('check') : '';
    if (p === 'REVIEW' && r && r.status === 'RUNNING') { cls = 'working'; label = T.replayRunning; icon = ''; }
    else if (p === 'REVIEW' && r && r.status === 'FAILED' && r.failure) { cls = 'failed'; label = T.failedAt(r.failure.index); icon = svg('close'); }
    st.className = 'state ' + cls;
    setHtml(st, icon + esc(label));
    pill.className = 'statepill ' + cls;
    // Les chiffres clés : actions, requêtes reliées (ou à vérifier en revue), qualité.
    var s = state.summary, q = state.quality, review = p === 'REVIEW';
    var stats = '<span>' + T.sActions(s.actions) + '</span>';
    stats += review ? '<span>' + T.sToCheck(s.attention) + '</span>' : '<span>' + T.sLinked(linkedCount()) + '</span>';
    if (q && q.score !== undefined) stats += '<span>' + esc(T.sQuality) + ' <b class="' + (q.score >= 90 ? 'good' : 'low') + '">' + q.score + ' %</b></span>';
    setHtml($('count'), stats);
    var ls = $('livesearch'), search = state.http && recordingPhase() ? state.http.search : '';
    ls.hidden = !search;
    ls.textContent = search ? T.liveSearch + ' : ' + search : '';
    // E · la disposition : le choix de l'humain (gardé), sinon recording.panelLayout ; la revue est complète.
    if (layout === null) layout = storedLayout() || state.layout || 'full';
    var compact = layout === 'compact' && p !== 'REVIEW' && p !== 'FINALIZING';
    document.body.classList.toggle('compact', compact);
    var lt = $('layouttoggle');
    lt.innerHTML = svg(layout === 'compact' ? 'expand' : 'layout');
    lt.setAttribute('title', layout === 'compact' ? T.full : T.compact);
    lt.setAttribute('aria-pressed', String(layout === 'compact'));
    lt.hidden = p === 'REVIEW' || p === 'FINALIZING';
    var c = '', running = r && r.status === 'RUNNING';
    if (recordingPhase()) {
      c += button(T.undo, { cmd: 'undo', cls: 'ghost', icon: 'undo', aria: T.undoLabel, disabled: state.actions.length <= 1 });
      c += p === 'PAUSED'
        ? button(T.resume, { cmd: 'resume', cls: 'primary', icon: 'play', aria: T.resumeLabel })
        : button(T.pause, { cmd: 'pause', icon: 'pause', aria: T.pauseLabel });
      c += button(T.stop, { cmd: 'stop', cls: 'danger', icon: 'stop', aria: T.stopLabel });
    } else if (review) {
      c += button(T.finish, { cmd: 'finish', cls: 'ghost', disabled: running });
      c += button(T.replayShort, { cmd: 'replay', icon: 'play', aria: T.replayFlow, disabled: running });
      c += button(T.saveFlow2, { cmd: 'save', cls: 'primary', icon: 'disk', disabled: running || (r && r.status === 'FAILED') });
    }
    setHtml($('controls'), c);
    var note = $('pausenote');
    note.hidden = p !== 'PAUSED';
    note.textContent = p === 'PAUSED' ? T.pausedNote : '';
    var pr = $('progress');
    if (state.progress && p === 'FINALIZING') {
      pr.hidden = false;
      var pct = state.progress.total > 0 ? Math.round((Math.min(state.progress.step, state.progress.total) / state.progress.total) * 100) : 0;
      pr.className = 'progress' + (state.progress.total > 0 ? '' : ' indeterminate');
      pr.querySelector('span').style.width = (state.progress.total > 0 ? pct : 30) + '%';
      pr.querySelector('p').textContent = state.progress.label + (state.progress.detail ? ' — ' + state.progress.detail : '');
    } else if (running) {
      pr.hidden = false; pr.className = 'progress';
      pr.querySelector('span').style.width = (r.total ? Math.round((r.executed / r.total) * 100) : 0) + '%';
      pr.querySelector('p').textContent = T.replaying(Math.min(r.executed + 1, r.total), r.total);
    } else pr.hidden = true;
    renderTabs();
  }

  /** Les requêtes métier reliées aux actions (en direct : le compteur provisoire de l'analyse HTTP). */
  function linkedCount() {
    var n = 0;
    state.actions.forEach(function (a) { n += a.network ? a.network.length : 0; });
    return n || (state.http ? state.http.correlated : 0);
  }

  /** Les onglets et leurs comptes ; « Données de test » n'existe qu'en revue, quand une donnée est liée. */
  function renderTabs() {
    var count = function (n) { return n ? ' <span class="count">' + n + '</span>' : ''; };
    var lines = state.analysis && state.analysis.dataLineage ? state.analysis.dataLineage.length : 0;
    setHtml($('tab-recording'), esc(T.tabRecording) + count(state.actions.length));
    setHtml($('tab-network'), esc(T.tabNetwork) + count(linkedCount()));
    var data = $('tab-data');
    data.hidden = !(state.phase === 'REVIEW' && lines > 0);
    setHtml(data, esc(T.tabData) + count(lines));
    if (data.hidden && tab === 'data') selectTab('recording');
  }

  function tickTimer() {
    if (!state) return;
    var text = clock((state.endedAt || Date.now()) - state.startedAt);
    $('timer').textContent = text;
    $('timer').setAttribute('aria-label', T.duration + ' ' + text);
  }

  /** Une ligne d'état seulement s'il y a quelque chose à vérifier (sinon le parcours parle de lui-même). */
  function renderSummary() {
    var s = state.summary, el = $('summary');
    $('journey-hint').textContent = recordingPhase() ? T.journeyHint : '';
    if (s.actions === 0 || s.attention === 0) { el.className = 'status-line'; el.textContent = ''; return; }
    var lines = [];
    if (s.ambiguous) lines.push(T.ambiguousN(s.ambiguous));
    if (s.failed) lines.push(T.failedN(s.failed));
    el.className = 'status-line warn';
    el.textContent = T.needsCheck + ' — ' + T.attention(s.attention) + (lines.length ? ' · ' + lines.join(' · ') : '');
  }

  function techLines(step) {
    return Object.keys(step.technical).map(function (k) { return k + '=' + step.technical[k]; }).join('\\n');
  }

  /**
   * Une phrase du parcours, lisible : la valeur dans une puce (une donnée de test en bleu), le nom du
   * champ en gras. Les guillemets restent dans le texte (copie, lecteurs d'écran), cachés à l'œil.
   */
  function phrase(text) {
    var parts = String(text || '').split('"');
    if (parts.length < 3 || parts.length % 2 === 0) return esc(text);
    var quoted = (parts.length - 1) / 2, out = '';
    parts.forEach(function (part, i) {
      if (i % 2 === 0) { out += esc(part); return; }
      var q = '<span class="q">"</span>', open = '\${testData:';
      // Deux citations : la valeur puis le champ ; une seule : la cible (bouton, lien, option).
      if (quoted === 2 && i === 3) out += q + '<b class="fname">' + esc(part) + '</b>' + q;
      else if (part.indexOf(open) === 0 && part.charAt(part.length - 1) === '}') out += q + '<span class="var">' + esc(part.slice(open.length, -1)) + '</span>' + q;
      else out += '<span class="val">' + q + esc(part) + q + '</span>';
    });
    return out;
  }

  /** Le statut d'une ligne : celui du dernier rejeu s'il y en a un, sinon celui de la validation de la cible. */
  function rowStatus(step) {
    var r = state.phase === 'REVIEW' ? state.replay : null;
    if (r && (r.status === 'PASSED' || r.status === 'FAILED' || r.status === 'RUNNING')) {
      var at = state.actions.indexOf(step);
      if (r.status === 'PASSED') return { cls: 'ok', text: T.replayed };
      if (r.status === 'RUNNING') return at < r.executed ? { cls: 'ok', text: T.replayed } : at === r.executed ? { cls: 'run', text: T.replayingStep, spin: true } : { cls: 'idle', text: T.queued };
      var failed = r.failure && r.failure.stepId ? state.actions.findIndex(function (a) { return a.id === r.failure.stepId; }) : -1;
      if (failed >= 0) return at < failed ? { cls: 'ok', text: T.replayed } : at === failed ? { cls: 'bad', text: T.failedStep } : { cls: 'idle', text: T.notReplayed, skipped: true };
    }
    var s = step.status;
    return s === 'CONFIRMED' ? { cls: 'ok', text: T.pill[s] } : s === 'PENDING' ? { cls: 'run', text: T.pill[s], spin: true } : s === 'AMBIGUOUS' ? { cls: 'warn', text: T.pill[s] } : s === 'FAILED' ? { cls: 'bad', text: T.pill[s] } : { cls: 'idle', text: T.pill[s] };
  }
  function statusHtml(rs) {
    return '<span class="st ' + rs.cls + '">' + (rs.spin ? '<span class="spin" aria-hidden="true"></span>' : '<span class="dotc" aria-hidden="true"></span>') + esc(rs.text) + '</span>';
  }

  /** L'étape métier d'un groupe du parcours (revue), si l'analyse en a reconnu une. */
  function businessOf(group) {
    var b = state.analysis && state.analysis.business;
    if (!b || !group) return null;
    for (var i = 0; i < b.steps.length; i += 1) {
      var st = b.steps[i];
      if ((String(st.action).toLowerCase() + ' ' + st.entity).trim() === group) return { step: st, index: i };
    }
    return null;
  }
  function businessHead(found) {
    var st = found.step;
    var title = businessTitle(st);
    var proof = st.observed.length ? st.observed[0] : st.reference ? T.referenceL + ' = ' + st.reference : '';
    return '<li class="group bhead"><span class="n" aria-hidden="true">' + (found.index + 1) + '</span><div class="bt"><b>' + esc(title) + '</b>' + (proof ? '<span class="label">' + esc(T.proofL) + ' : <span class="mono">' + esc(proof) + '</span></span>' : '') + '</div><span class="pill ' + st.status + '"><span class="dotc" aria-hidden="true"></span>' + esc(T.bstatus[st.status]) + ' · ' + Math.round(st.confidence * 100) + ' %</span></li>';
  }
  function groupHead(group) {
    var found = state.phase === 'REVIEW' ? businessOf(group) : null;
    if (found) return businessHead(found);
    var route = group.charAt(0) === '/';
    return '<li class="group">' + (route ? '<span class="groute">' + esc(group) + '</span>' : '<span class="gname">' + esc(group.charAt(0).toUpperCase() + group.slice(1)) + '</span>') + '</li>';
  }

  function renderTimeline() {
    var business = state.phase === 'REVIEW' && state.analysis && state.analysis.business && state.analysis.business.steps.length;
    $('timeline-title').textContent = business ? T.storyTitle : T.timeline;
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
      if (step.group && step.group !== lastGroup && !needle && !onlyAttention) head = groupHead(step.group);
      lastGroup = step.group || lastGroup;
      return head + stepHtml(step);
    }).join('');
    if (!html && state.actions.length) html = '<li class="empty">' + esc(T.noMatch) + '</li>';
    if (!html) html = '<li class="empty">' + esc(T.empty) + '</li>';
    if (state.phase === 'RECORDING' && !needle && !onlyAttention) html += '<li class="waiting"><span class="dotc" aria-hidden="true"></span>' + esc(T.waiting) + '</li>';
    setHtml($('timeline'), html);
    var checks = state.checks || [];
    setHtml($('checks'), checks.length ? '<details class="checks"><summary>' + esc(T.checks(checks.length)) + '</summary><p class="sub">' + esc(T.checksNote) + '</p><ul>' + checks.map(function (c) { return '<li>' + esc(c.description) + '</li>'; }).join('') + '</ul></details>' : '');
  }

  /**
   * L'étape montrée dans l'inspecteur : la sélection ; sinon la dernière action (pendant l'enregistrement)
   * ou l'étape où le rejeu s'est arrêté (revue).
   */
  function shownStep() {
    var step = state.actions.find(function (s) { return s.id === selected; });
    if (step) return { step: step, follow: false };
    if (recordingPhase() && state.actions.length) return { step: state.actions[state.actions.length - 1], follow: true };
    var r = state.phase === 'REVIEW' ? state.replay : null;
    var failed = r && r.status === 'FAILED' && r.failure && r.failure.stepId ? state.actions.find(function (s) { return s.id === r.failure.stepId; }) : null;
    return failed ? { step: failed, follow: true } : null;
  }

  function stepHtml(step) {
    var current = selected === step.id, shown = shownStep(), follow = !!(shown && shown.follow && shown.step.id === step.id);
    var rs = rowStatus(step);
    var h = '<li data-step="' + esc(step.id) + '">';
    h += '<button type="button" class="item ' + step.status + (follow ? ' follow' : '') + (rs.skipped ? ' skipped' : '') + '" data-cmd="select" data-id="' + esc(step.id) + '" aria-current="' + current + '" aria-label="' + esc(step.index + '. ' + step.description + ' — ' + rs.text) + '">';
    h += '<span class="num">' + step.index + '</span>';
    h += '<span class="kind k-' + esc(step.kind) + '" aria-hidden="true">' + kindSvg(step.kind) + '</span><span class="desc">';
    if (dev) h += esc(step.technical.event || step.technical.kind || step.kind) + '<span class="tech">' + esc(techLines(step)) + '</span>';
    else {
      h += phrase(step.description);
      if (step.detail) h += ' <span class="label route">' + esc(step.detail) + '</span>';
      if (step.resolution || (step.status !== 'CONFIRMED' && step.status !== 'PENDING')) h += '<span class="sub">' + esc(step.statusText) + '</span>';
    }
    h += '</span>' + statusHtml(rs) + '</button>';
    if (step.status === 'AMBIGUOUS' && step.resolution !== 'IGNORED' && state.phase !== 'REVIEW') {
      h += '<div class="attention" role="group" aria-label="' + esc(T.ambiguousTitle) + '"><p class="atitle">' + svg('alert') + esc(T.ambiguousTitle) + '</p><p>' + phrase(step.description) + ' · ' + esc(T.matches(Math.max((step.candidates || []).length, 2))) + '</p>';
      // Le choix est là tout de suite : l'élément touché (présélectionné), les autres correspondances.
      var cands = step.candidates && step.candidates.length ? step.candidates : [{ index: -1, original: true, label: T.touchedTag }];
      h += '<p class="sub">' + esc(T.ambHelp) + '</p><fieldset><legend>' + esc(T.which) + '</legend>' + cands.map(function (c) {
        return '<label class="cand' + (c.original ? ' touched' : '') + '"><input type="radio" name="cand-' + esc(step.id) + '" value="' + c.index + '"' + ((choice[step.id] !== undefined ? choice[step.id] === c.index : c.original) ? ' checked' : '') + '><span>' + esc(c.label) + '</span>' + (c.original ? '<em>' + esc(T.touchedTag) + '</em>' : '') + '</label>';
      }).join('') + '</fieldset><div class="row">' + button(T.validate, { cmd: 'confirm-resolve', id: step.id, cls: 'primary', icon: 'check' }) + button(T.show, { cmd: 'show', id: step.id }) + button(T.ignore, { cmd: 'ignore', id: step.id, cls: 'ghost' }) + '</div>';
      if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message === 'NOT_TOUCHED' ? T.notTouched : state.notice.message) + '</p>';
      h += '</div>';
    }
    return h + '</li>';
  }

  var SELECTORS = ['selector', 'target', 'frame', 'matches', 'rawEventId', 'raw', 'step', 'shadowDom', 'sensitive', 'provenance', 'locator', 'validation', 'decision', 'resolution'];

  /** La cible enregistrée d'une étape de revue (JSON du flow), lue sans jamais échouer. */
  function targetOf(step) {
    try { return step.technical.target ? JSON.parse(step.technical.target) : null; } catch (e) { return null; }
  }

  /** Les clés-valeurs humaines de l'inspecteur : l'élément, son emplacement, son repérage, la donnée. */
  function kvHtml(step) {
    var t = step.technical, tg = targetOf(step) || {};
    var role = t.role || tg.role || '', name = t.label || t.name || t.text || t.field || tg.name || tg.value || '';
    var roleWord = T.roleName[role] || T.kindElement[step.kind] || T.kindName[step.kind] || role;
    var rows = [];
    if (name || roleWord) rows.push([T.kElement, esc(roleWord) + (name ? ' « ' + esc(name) + ' »' : '')]);
    var section = t.section || (Array.isArray(tg.section) ? tg.section.join(' › ') : tg.section);
    // L'emplacement : l'écran et la section (le chemin de l'écran seulement s'il n'y a pas de section).
    var route = t.page || (step.group && step.group.charAt(0) === '/' ? step.group : '');
    var place = section ? [String(section).split(' > ').join(' › ')] : route ? [route] : [];
    if (place.length) rows.push([T.kPlace, esc(place.join(' › '))]);
    var stable = step.checks.filter(function (c) { return c.text === 'Sélecteur stable' || c.text === 'Stable selector'; }).length > 0;
    var fragile = step.checks.filter(function (c) { return c.text === 'Sélecteur fragile' || c.text === 'Fragile selector'; }).length > 0;
    var how = tg.strategy ? (T.strategyName[tg.strategy] || tg.strategy) : t.selector ? T.strategyName.css : '';
    if (how || stable || fragile) rows.push([T.kLocate, esc(how || '—') + (stable || fragile ? ' <span class="label">· ' + esc(stable ? T.kStable : T.kFragile) + '</span>' : '')]);
    var d = step.data;
    if (d) {
      var dv = d.source === 'SENSITIVE' ? esc(T.dataSecret) : d.source === 'GENERATED' ? '<span class="var">' + esc(d.key || '') + '</span> <span class="label">' + esc(T.dataGenerated) + '</span>' : d.source === 'REFERENCE' ? '<span class="var">' + esc(d.reference || '') + '</span> <span class="label">' + esc(T.dataReused) + '</span>' : esc(T.dataFixed) + (d.recordedValue ? ' <span class="val">' + esc(d.recordedValue) + '</span>' : '');
      rows.push([T.kData, dv]);
    }
    return rows.length ? '<dl class="kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' : '';
  }

  /** La source de la valeur (revue) : un résumé, « Modifier » ouvre l'éditeur. */
  function dataBox(step) {
    var d = step.data;
    if (!d || state.phase !== 'REVIEW') return '';
    if (d.source === 'SENSITIVE') return '<div class="box"><div class="bhd"><b>' + esc(T.dataTitle) + '</b></div><p class="sub">' + esc(T.sensitiveData) + '</p></div>';
    var open = dataOpen[step.id];
    var line = d.source === 'GENERATED' ? '<span class="var">' + esc(d.key || '') + '</span><span>' + esc(T.dataGenerated) + '</span>' : d.source === 'REFERENCE' ? '<span class="var">' + esc(d.reference || '') + '</span><span>' + esc(T.dataReused) + '</span>' : '<span>' + esc(T.dataFixed) + '</span>' + (d.recordedValue ? '<span class="val">' + esc(d.recordedValue) + '</span>' : '');
    var h = '<div class="box"><div class="bhd"><b>' + esc(T.dataTitle) + '</b>' + button(open ? T.close : T.modify, { cmd: 'data-toggle', id: step.id, cls: 'link', aria: open ? T.closeData : T.modifyData }) + '</div>';
    if (!open) {
      h += '<div class="bline">' + line + '</div>';
      if (d.recordedValue && d.source !== 'FIXED') h += '<span class="label">' + esc(T.dataRecorded(d.recordedValue)) + '</span>';
      if (d.manual) h += '<span class="label">' + esc(T.manualL) + '</span>';
      else if (d.suggestion) h += '<span class="label">' + esc(T.suggestedL(d.suggestion)) + '</span>';
    } else h += dataBlock(step);
    return h + '</div>';
  }

  /** Les sections techniques (Cible) : les sélecteurs, la validation pas à pas. */
  function targetHtml(step) {
    var t = step.technical, h = '';
    var corr = step.correction;
    if (corr && corr.current) h += '<div class="pair">' + targetCard('cur', T.cCurrent, '', corr.current) + '</div>';
    var sel = SELECTORS.filter(function (k) { return t[k] !== undefined; });
    if (sel.length) {
      h += '<dl class="kv">';
      sel.forEach(function (k) { h += '<dt>' + esc(T.field[k] || k) + '</dt><dd><code>' + esc(t[k]) + '</code>' + (k === 'selector' || k === 'target' ? button(T.copy, { cmd: 'copy', cls: 'copy ghost', id: t[k] }) : '') + '</dd>'; });
      h += '</dl>';
    }
    h += '<div><h3>' + esc(T.validation) + '</h3><ul class="vlist">';
    (step.checks.length ? step.checks : [{ ok: step.status === 'CONFIRMED', text: step.statusText }]).forEach(function (c) {
      h += '<li class="' + (c.ok ? 'yes' : 'no') + '"><span class="dotc" aria-hidden="true"></span>' + esc(c.text) + '</li>';
    });
    return h + '</ul></div>';
  }

  /** Les requêtes métier reliées à l'action. */
  function networkHtml(step) {
    return '<div><h3>' + esc(T.linked) + '</h3>' + (step.network && step.network.length ? step.network.map(netCard).join('') : '<p class="sub">' + esc(T.linkedNone) + '</p>') + '</div>';
  }
  function netCard(n) {
    return '<div class="netcard"><code>' + esc(n.api) + (n.status !== undefined ? ' · ' + n.status : '') + '</code><span class="sub">' + esc(n.operation + ' · ' + n.link) + '</span>' + n.criteria.map(function (c) { return '<span class="crit">' + esc(c) + '</span>'; }).join('') + (n.extras.length ? '<span class="sub">' + esc(n.extras.join(' · ')) + '</span>' : '') + '</div>';
  }

  function renderDetails() {
    var box = $('details');
    var shown = shownStep();
    if (!shown) { setHtml(box, '<div class="ihead"><div class="itop"><span class="label">' + esc(T.detailsTitle) + '</span></div></div><p class="empty-details">' + esc(T.pick) + '</p>'); return; }
    var step = shown.step;
    if (inspFor !== step.id) { inspFor = step.id; inspTab = 'details'; }
    box.setAttribute('aria-label', T.detailsTitle);
    // Pendant une correction, l'inspecteur devient la carte de correction (l'action reste surlignée).
    var pk = state.pick && state.pick.stepId === step.id ? state.pick : null;
    if (pk && (pk.status === 'PREPARING' || pk.status === 'PICKING' || pk.status === 'PICKED')) { setHtml(box, correctionPanel(step, pk)); return; }
    var review = state.phase === 'REVIEW', rs = rowStatus(step);
    var eyebrow = review ? T.stepN(step.index) + (step.group ? ' · ' + (businessOf(step.group) ? businessTitle(businessOf(step.group).step) : step.group) : '') : T.actionN(step.index);
    var h = '<div class="ihead"><div class="itop"><span class="label">' + esc(eyebrow) + '</span>' + statusHtml(rs) + (shown.follow ? '' : button('', { cmd: 'deselect', cls: 'ghost icon small', icon: 'close', aria: T.hideDetails })) + '</div>';
    h += '<div class="ititle">' + phrase(step.description) + '</div>';
    if (review) {
      var tabsDef = [['details', T.subDetails], ['target', T.subTarget], ['network', T.subNetwork + (step.network && step.network.length ? ' · ' + step.network.length : '')]];
      h += '<nav class="subtabs" role="tablist" aria-label="' + esc(T.subTabs) + '">' + tabsDef.map(function (d) { return '<button type="button" role="tab" data-subtab="' + d[0] + '" aria-selected="' + (inspTab === d[0]) + '"' + (inspTab === d[0] ? '' : ' tabindex="-1"') + '>' + esc(d[1]) + '</button>'; }).join('') + '</nav>';
    }
    h += '</div><div class="ibody">';
    if (review && inspTab === 'target') h += targetHtml(step);
    else if (review && inspTab === 'network') h += networkHtml(step);
    else {
      h += kvHtml(step);
      if (state.highlight && state.highlight.actionId === step.id) {
        var r = state.highlight.result;
        h += '<p class="found ' + (r === 'NOT_FOUND' ? 'warn' : 'ok') + '" role="status">' + svg(r === 'NOT_FOUND' ? 'alert' : 'okCircle') + esc(T.found[r].replace(/^[✓⚠] /, '')) + '</p>';
      }
      h += dataBox(step);
      h += correctionBlock(step);
      var act = '';
      if (step.correctable && state.phase !== 'FINALIZING') act += button(T.cInBrowser, { cmd: 'correct-pick', id: step.id, icon: 'cursor', disabled: state.replay && state.replay.status === 'RUNNING' });
      if (review && step.rowEdit && rowEditOpen[step.id] === undefined) act += button(T.rEdit, { cmd: 'row-edit-open', id: step.id, icon: 'pencil', disabled: state.replay && state.replay.status === 'RUNNING' });
      if (review && step.removable) act += button(T.remove, { cmd: 'remove', id: step.id, cls: 'remove', aria: T.removeLabel(step.description) });
      if (act) h += '<div class="iactions">' + act + '</div>';
      // Pendant l'enregistrement : le technique replié (sélecteurs, validation, requêtes) ; en revue : les sous-onglets.
      h += '<details class="techd"><summary>' + esc(T.techDetails) + '</summary>' + (review ? '' : targetHtml(step) + networkHtml(step)) + '<h4>' + esc(T.logs) + '</h4><span class="tech">' + esc(techLines(step)) + '</span></details>';
    }
    setHtml(box, h + '</div>');
  }

  function businessTitle(st) {
    var verb = T.baction[st.action] || st.action;
    return verb.charAt(0) + verb.slice(1).toLowerCase() + ' ' + st.entity;
  }

  /**
   * CORRECTION MANAGER : corriger la cible d'une étape dans le navigateur. Au repos : le bouton et, si la
   * cible a déjà été corrigée, l'historique (Restaurer l'original). En mode sélection : le badge actif.
   * Élément désigné : ancienne cible → nouvelle cible, ses traits, l'ordre de résolution, Tester / Annuler / Valider.
   */
  /**
   * Une cible décrite (« link "Nom" (section X, row 3024, #2) ») en morceaux : le type, le nom, la ligne,
   * les autres précisions. null si la description n'a pas cette forme (elle est alors montrée brute).
   */
  function targetParts(raw) {
    var text = String(raw || ''), q = text.indexOf(' "');
    if (q < 1) return null;
    var rest = text.slice(q + 2), end = rest.lastIndexOf('"');
    if (end < 0) return null;
    var tail = rest.slice(end + 1).trim(), extras = [];
    if (tail) {
      if (tail.charAt(0) !== '(' || tail.charAt(tail.length - 1) !== ')') return null;
      extras = tail.slice(1, -1).split(', ');
    }
    var row = null, other = [];
    for (var i = 0; i < extras.length; i += 1) {
      if (extras[i].indexOf('row ') === 0) row = extras[i].slice(4); else other.push(extras[i]);
    }
    return { kind: text.slice(0, q), name: rest.slice(0, end), row: row, extras: other };
  }

  /** La ligne d'un tableau lisible : « Colonne contient [donnée] », « Colonne = 3026 » ou la valeur seule. */
  function rowHtml(row, fixed) {
    var text = String(row), col = '', val = text, contains = false;
    var eq = text.indexOf(' = '), has = text.indexOf(' ∋ ');
    if (has > 0 && (eq < 0 || has < eq)) { col = text.slice(0, has); val = text.slice(has + 3); contains = true; }
    else if (eq > 0) { col = text.slice(0, eq); val = text.slice(eq + 3); }
    if (val.charAt(0) === '~') { contains = true; val = val.slice(1); }
    var open = '\${testData:', isVar = val.indexOf(open) === 0 && val.charAt(val.length - 1) === '}';
    var shown = isVar ? '<span class="dvar" title="' + esc(T.cRowVariable) + '">' + esc(val.slice(open.length, -1)) + '</span>' : '<code' + (fixed ? ' class="fixed"' : '') + '>' + esc(val) + '</code>';
    var op = contains ? T.cContainsW : '=';
    return (col ? '<span class="col">' + esc(col) + '</span> ' + esc(op) + ' ' : contains ? esc(op) + ' ' : '') + shown;
  }

  /** Une carte de cible : son rôle, son nom, sa ligne (si elle en a une), le reste en petit ; la cible brute en infobulle. */
  function targetCard(cls, label, status, raw, row, fixed) {
    var p = targetParts(raw);
    var h = '<div class="tcard ' + cls + '" title="' + esc(raw) + '"><div class="thead"><b>' + esc(label) + '</b>' + (status ? '<span>' + esc(status) + '</span>' : '') + '</div>';
    if (!p) return h + '<code class="traw">' + esc(raw || '—') + '</code></div>';
    h += '<div class="tname">' + esc(T.roleName[p.kind] || p.kind) + ' <b>' + esc(p.name) + '</b></div>';
    var r = row !== undefined && row !== null ? row : p.row;
    if (r) h += '<div class="trow"><span class="k">' + esc(T.cRowL) + ' :</span> ' + rowHtml(r, fixed) + '</div>';
    if (p.extras.length) h += '<div class="tmeta">' + esc(p.extras.join(' · ')) + '</div>';
    return h + '</div>';
  }

  /** Un nom de donnée proposé pour une colonne : « row. » + ses lettres et chiffres (sans accents). */
  function keyOfColumn(column) {
    var plain = String(column).normalize('NFD'), out = '';
    for (var i = 0; i < plain.length; i += 1) {
      var ch = plain.charAt(i).toLowerCase();
      if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
    }
    return 'row.' + (out && !(out.charAt(0) >= '0' && out.charAt(0) <= '9') ? out : 'value');
  }

  /** Le brouillon des colonnes : la ligne actuelle (ou proposée), chaque colonne avec la source de sa valeur. */
  function rowDraftOf(id, cells, vars, current) {
    if (rowDraft[id]) return rowDraft[id];
    var d = {}, cur = current || {}, open = '\${testData:';
    cells.forEach(function (c) {
      var v = cur[c.column], e = { on: v !== undefined, source: 'recorded', cell: c.value, value: c.value, key: vars[0] ? vars[0].key : '', newKey: keyOfColumn(c.column), match: 'exact' };
      if (e.on) {
        v = String(v);
        if (v.charAt(0) === '~') { e.match = 'contains'; v = v.slice(1); }
        var cited = v.indexOf(open) === 0 && v.charAt(v.length - 1) === '}' ? v.slice(open.length, -1) : null;
        if (cited !== null && vars.some(function (x) { return x.key === cited; })) { e.source = 'variable'; e.key = cited; }
        else if (cited === null && v !== c.value) { e.source = 'value'; e.value = v; }
      }
      d[c.column] = e;
    });
    return (rowDraft[id] = d);
  }

  /** Les colonnes cochées, telles que Node les vérifie (colonne, source, valeur ou donnée, contient). */
  function rowColumns(id) {
    var d = rowDraft[id] || {}, out = [];
    Object.keys(d).forEach(function (col) {
      var e = d[col];
      if (!e.on) return;
      var c = { column: col, source: e.source, match: e.match };
      if (e.source === 'value') c.value = e.value;
      if (e.source === 'variable') c.key = e.key;
      if (e.source === 'new-variable') { c.key = e.newKey; c.value = e.value; }
      out.push(c);
    });
    return out;
  }

  /** La ligne choisie, lisible : « Colonne = valeur, Colonne ∋ donnée ». */
  function rowSaid(id) {
    return rowColumns(id).map(function (c) {
      var v = c.source === 'variable' || c.source === 'new-variable' ? '\${testData:' + c.key + '}' : c.source === 'value' ? c.value : rowDraft[id][c.column].cell;
      return c.column + (c.match === 'contains' ? ' ∋ ' : ' = ') + v;
    }).join(', ');
  }

  /**
   * L'ÉDITEUR DE LA LIGNE : une colonne par rangée — cochée ou non, ce qui a été lu, la source de la
   * valeur au rejeu et la comparaison ; l'aperçu compte les lignes qui correspondent dans la page.
   */
  function rowEditor(id, cells, vars, canCreate, current) {
    var d = rowDraftOf(id, cells, vars, current);
    var h = '<div class="roweditor" data-rowedit="' + esc(id) + '"><p class="ohelp">' + esc(T.rHelp) + '</p>';
    cells.forEach(function (c, i) {
      var e = d[c.column], cid = 'rc-' + id + '-' + i;
      var at = ' data-step-id="' + esc(id) + '" data-column="' + esc(c.column) + '"';
      h += '<div class="rcol' + (e.on ? ' on' : '') + '"><input type="checkbox" id="' + esc(cid) + '" data-rowcol="on"' + at + (e.on ? ' checked' : '') + '><label class="rname" for="' + esc(cid) + '"><b>' + esc(c.column) + '</b><span class="label">' + esc(T.rRead(c.value)) + '</span></label>';
      if (e.on) {
        var opt = function (v, l) { return '<option value="' + v + '"' + (e.source === v ? ' selected' : '') + '>' + esc(l) + '</option>'; };
        h += '<div class="rsel"><select data-rowcol="source"' + at + ' aria-label="' + esc(T.rSource + ' · ' + c.column) + '">' + opt('recorded', T.rSrcRecorded) + opt('value', T.rSrcValue) + (vars.length ? opt('variable', T.rSrcVariable) : '') + (canCreate ? opt('new-variable', T.rSrcNew) : '') + '</select>';
        h += '<select data-rowcol="match"' + at + ' aria-label="' + esc(T.rCompare + ' · ' + c.column) + '"><option value="exact"' + (e.match === 'contains' ? '' : ' selected') + '>' + esc(T.rEquals) + '</option><option value="contains"' + (e.match === 'contains' ? ' selected' : '') + '>' + esc(T.rContainsS) + '</option></select></div>';
        var more = '';
        if (e.source === 'value') more += '<label>' + esc(T.rValue) + '<input type="text" data-rowcol="value"' + at + ' value="' + esc(e.value) + '"></label>';
        if (e.source === 'variable') more += '<label>' + esc(T.cRowVariable) + '<select data-rowcol="key"' + at + '>' + vars.map(function (v) { return '<option value="' + esc(v.key) + '"' + (v.key === e.key ? ' selected' : '') + '>' + esc(v.value ? v.key + ' — ' + v.value : v.key) + '</option>'; }).join('') + '</select></label>';
        if (e.source === 'new-variable') more += '<label>' + esc(T.rNewKey) + '<input type="text" data-rowcol="newKey"' + at + ' value="' + esc(e.newKey) + '"></label><label>' + esc(T.rValue) + '<input type="text" data-rowcol="value"' + at + ' value="' + esc(e.value) + '"></label><p class="ohelp">' + esc(T.rNewHelp) + '</p>';
        if (more) h += '<div class="rmore">' + more + '</div>';
      } else h += '<span></span>';
      h += '</div>';
    });
    var pv = state.rowPreview && state.rowPreview.stepId === id ? state.rowPreview : null;
    h += '<div class="rband">' + (pv ? '<p class="rpreview ' + esc(pv.status.toLowerCase()) + '" role="status">' + svg(pv.status === 'FOUND' ? 'check' : 'alert') + esc(T.rPreview(pv)) + '</p>' : '') + button(T.rPreviewBtn, { cmd: 'row-preview', id: id, cls: 'link' }) + '</div>';
    return h + '</div>';
  }

  /** « Identifier la ligne par » : les façons de faire (la recommandée en tête) puis, si choisi, les colonnes. */
  function rowBox(step, pr, ropts, ropt, cells, vars) {
    var h = '<div class="rowbox"><div class="rbhead"><b>' + esc(T.cRowTitle) + '</b><span class="label">' + esc(T.cRowAll) + '</span></div>';
    h += '<fieldset class="rowopts"><legend class="sr-only">' + esc(T.cRowTitle) + '</legend>';
    for (var rj = 0; rj < ropts.length; rj += 1) {
      var o = ropts[rj], on = ropt && ropt.id === o.id;
      var said = o.id === 'bound' ? T.cRowBound(o.via || '') + (o.match === 'contains' ? ' · ' + T.cRowContains : '') : o.id === 'columns' ? T.cRowColumns : T.cRowKey;
      var badge = o.id === 'bound' ? '<span class="obadge rec">' + esc(T.cRecommended) + '</span>' : o.fixed ? '<span class="obadge run">' + esc(T.cRunOnly) + '</span>' : '';
      h += '<div class="ropt' + (on ? ' on' : '') + (o.fixed ? ' fixed' : '') + '"><label class="choice"><input type="radio" name="rowopt-' + esc(step.id) + '" value="' + esc(o.id) + '"' + (on ? ' checked' : '') + '><span><span class="otitle">' + esc(said) + '</span>' + badge + (o.id === 'columns' ? '' : '<small>' + esc(o.row) + '</small>') + '</span></label>';
      if (on && o.id === 'bound') h += '<p class="ohelp">' + esc(T.cRowBoundHelp) + '</p>';
      if (on && o.fixed) h += '<p class="callout warn">' + esc(T.cRowFixed) + '</p>';
      h += '</div>';
      if (on && o.id === 'columns') h += rowEditor(step.id, cells, vars, !!pr.canCreate, pr.row);
    }
    h += '</fieldset>';
    if (!ropts.some(function (o) { return o.id === 'bound'; })) h += '<p class="callout" style="margin:0 12px 12px">' + esc(vars.length ? T.cRowNoMatch : T.cRowNoData) + '</p>';
    return h + '</div>';
  }

  /**
   * LA CARTE DE CORRECTION (l'inspecteur pendant une correction) : l'étape, ce qui se passe, puis
   * Avant / Après côte à côte, la ligne, l'ordre de résolution replié et le pied d'actions.
   */
  function correctionPanel(step, pk) {
    var status = pk.status === 'PICKED' ? T.cPicked : pk.status === 'PICKING' ? T.cPickActive : T.cPreparing((pk.progress || { executed: 0 }).executed, (pk.progress || { total: 0 }).total);
    var h = '<section class="correction cpanel" aria-label="' + esc(T.cTitle(step.index)) + '"><div class="chead"><div><span class="label">' + esc(T.stepN(step.index)) + '</span><h2>' + esc(T.cFix) + '</h2></div><span class="st run"><span class="dotc" aria-hidden="true"></span><span class="pickbadge-text" role="status">' + esc(status) + '</span></span></div><div class="cbody">';
    if (pk.status === 'PREPARING') {
      h += '<p class="ohelp">' + esc(T.cPreparingHelp) + '</p><div class="cfoot">' + button(T.cCancel, { cmd: 'correct-cancel', id: step.id, cls: 'ghost' }) + '</div>';
      return h + '</div></section>';
    }
    if (pk.status === 'PICKING') {
      h += '<p class="ohelp">' + esc(T.cPickHelp) + '</p><div class="cfoot">' + button(T.cCancel, { cmd: 'correct-cancel', id: step.id, cls: 'ghost' }) + '</div>';
      return h + '</div></section>';
    }
    var corr = step.correction, pr = pk.proposal;
    if (!pr) return h + '</div></section>';
    var tr = pr.traits;
    var ropts = (pr.rowOptions || []).slice(), ropt = null;
    var cells = pr.rowCells || [], vars = pr.variables || [];
    // Les colonnes de la ligne : offertes dès que ses cellules sont connues (valeur lue, modifiée, donnée du run).
    if (cells.length) {
      rowDraftOf(step.id, cells, vars, pr.row);
      var chosenRow = rowSaid(step.id);
      ropts.push({ id: 'columns', target: (pr.baseTarget || pr.target) + (chosenRow ? ' (row ' + chosenRow + ')' : ''), row: chosenRow });
    }
    for (var ri = 0; ri < ropts.length; ri += 1) if (ropts[ri].id === rowChoice[step.id]) ropt = ropts[ri];
    if (!ropt && ropts.length) ropt = ropts[0];
    h += '<div class="pair">' + targetCard('old', T.cOld, step.status === 'FAILED' ? T.cUnknown : step.statusText, pk.previous || corr && corr.current || '');
    h += targetCard('new', T.cNew, pr.quality, ropt ? ropt.target : pr.target, ropt ? ropt.row : null, ropt && ropt.fixed) + '</div>';
    if (ropts.length) h += rowBox(step, pr, ropts, ropt, cells, vars);
    if (pr.ambiguous) h += '<p class="callout warn">' + esc(T.cAmbiguous) + '</p>';
    h += '<details class="ctech" data-tech="' + esc(step.id) + '"' + (techOpen[step.id] ? ' open' : '') + '><summary>' + esc(T.cOrderTech) + '</summary>';
    if (pr.order.length) h += '<div class="order"><b>' + esc(T.cOrder) + '</b><ol>' + pr.order.map(function (o) { return '<li>' + esc(o) + '</li>'; }).join('') + '</ol></div>';
    h += '<dl class="kv">';
    h += '<dt>' + esc(T.cRole) + '</dt><dd><span class="chip">' + esc(tr.role || tr.tag) + '</span></dd>';
    if (tr.name) h += '<dt>' + esc(T.cName) + '</dt><dd>' + esc(tr.name) + '</dd>';
    if (tr.label && tr.label !== tr.name) h += '<dt>' + esc(T.field.label) + '</dt><dd>' + esc(tr.label) + '</dd>';
    if (tr.text && tr.text !== tr.name) h += '<dt>' + esc(T.cText) + '</dt><dd>' + esc(tr.text) + '</dd>';
    if (tr.testId) h += '<dt>' + esc(T.cTestId) + '</dt><dd><code>' + esc(tr.testId) + '</code></dd>';
    h += '<dt>' + esc(T.cCss) + '</dt><dd><code>' + esc(tr.css) + '</code></dd>';
    if (tr.section) h += '<dt>' + esc(T.cContext) + '</dt><dd>' + esc(tr.section) + '</dd>';
    h += '</dl></details>';
    if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message) + '</p>';
    h += '<div class="cfoot">' + button(T.cTest, { cmd: 'correct-test', id: step.id, cls: 'lead' }) + button(T.cCancel, { cmd: 'correct-cancel', id: step.id, cls: 'ghost' }) + button(T.cApply, { cmd: 'correct-apply', id: step.id, cls: 'primary', icon: 'check' }) + '</div>';
    return h + '</div></section>';
  }

  /**
   * LA CORRECTION AU REPOS (onglet Détails) : ce qui reste d'une tentative (annulée, indisponible,
   * chemin interrompu), « Modifier la ligne » sans navigateur, et l'historique (Restaurer l'original).
   */
  function correctionBlock(step) {
    if (!step.correctable || state.phase === 'FINALIZING') return '';
    var pk = state.pick && state.pick.stepId === step.id ? state.pick : null;
    var running = state.replay && state.replay.status === 'RUNNING';
    var corr = step.correction;
    var corrected = corr && corr.corrected;
    var h = '';
    if (pk && pk.status === 'CANCELLED') h += '<p class="sub">' + esc(T.cCancelled) + '</p>';
    if (pk && pk.status === 'UNAVAILABLE') h += '<p class="sub">' + esc(T.cUnavailable) + (pk.reason ? ' (' + esc(pk.reason) + ')' : '') + '</p>';
    if (pk && pk.status === 'UNREACHABLE' && pk.stoppedAt) h += '<p class="warnnote">' + esc(T.cUnreachable(pk.stoppedAt.index, pk.stoppedAt.label)) + '</p><p class="sub">' + esc(pk.stoppedAt.reason) + '<br>' + esc(T.cUnreachableHelp) + '</p>';
    // LA LIGNE, SANS NAVIGATEUR (revue) : les colonnes lues à l'enregistrement, chacune avec sa source.
    var re = state.phase === 'REVIEW' ? step.rowEdit : null;
    if (re && rowEditOpen[step.id] !== undefined && rowEditOpen[step.id] !== (corr && corr.current)) { delete rowEditOpen[step.id]; delete rowDraft[step.id]; }
    if (re && rowEditOpen[step.id] !== undefined) {
      h += '<div class="rowbox"><div class="rbhead"><b>' + esc(T.rEdit) + '</b><span class="label">' + esc(T.cRowAll) + '</span></div>' + rowEditor(step.id, re.cells, re.variables, re.canCreate, re.current) + '</div>';
      h += '<div class="cfoot">' + button(T.cCancel, { cmd: 'row-edit-close', id: step.id, cls: 'ghost' }) + button(T.rApply, { cmd: 'row-edit', id: step.id, cls: 'primary', icon: 'check', disabled: running }) + '</div>';
      if (state.notice && state.notice.actionId === step.id) h += '<p class="error" role="alert">' + esc(state.notice.message) + '</p>';
    }
    if (corrected && corr) {
      var last = corr.history.length ? corr.history[corr.history.length - 1] : null;
      h += '<div class="row"><h3>' + esc(T.cHistory) + '</h3><span class="pill CONFIRMED"><span class="dotc" aria-hidden="true"></span>' + esc(T.cCorrected) + '</span></div><div class="pair">' + targetCard('old', T.cOriginal, '', corr.original || '') + targetCard('new', T.cCorrection, '', corr.current) + '</div>';
      h += '<p class="chist">' + esc(T.cBy) + ' : ' + esc(T.cUser) + (last ? ' · ' + esc(new Date(last.at).toLocaleString()) : '') + '</p>';
      h += '<div class="row">' + button(T.cRestore, { cmd: 'correct-restore', id: step.id, icon: 'undo', disabled: running }) + '</div>';
    }
    return '<section class="correction" aria-label="' + esc(T.cTitle(step.index)) + '">' + h + '</section>';
  }

  /** LA SOURCE DE LA VALEUR d'une saisie (revue) : valeur enregistrée, générée, ou réutilisée d'une étape antérieure. */
  function dataBlock(step) {
    var d = step.data;
    if (!d || state.phase !== 'REVIEW' || d.source === 'SENSITIVE') return '';
    var h = '';
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
    else if (d.suggestion) h += '<p class="dnote">' + esc(T.suggestedL(d.suggestion)) + '</p>';
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

  /** La qualité du recording (onglet Analyse) : le score, puis chaque vérification. */
  function qualityCard() {
    var q = state.quality;
    var h = '<div class="card card-plain"><h2>' + esc(T.qualityTitle) + '</h2>';
    if (q.score === undefined) return h + '<p class="empty">' + esc(T.noQuality) + '</p></div>';
    h += '<div class="qrow"><span class="qscore' + (q.score >= 90 ? '' : ' low') + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + q.score + '" aria-label="' + esc(T.quality) + '">' + q.score + ' %</span><ul class="qlist">';
    q.checks.forEach(function (c) { if (c.total > 0) h += '<li class="' + (c.ok ? 'ok' : 'warn') + '"><span class="dotc" aria-hidden="true"></span>' + esc(T.checksQ[c.id]) + '<span class="v">' + c.passed + '/' + c.total + '</span></li>'; });
    return h + '</ul></div></div>';
  }

  function previewHtml() {
    var pv = state.preview;
    var picking = state.pick && (state.pick.status === 'PICKING' || state.pick.status === 'PREPARING');
    var h = '<header class="card-head"><h2>' + esc(T.previewTitle) + '</h2><span class="purl">' + esc(pv ? routeOf(pv.url) : '') + '</span>' + (picking ? '<span class="pickbadge" role="status">' + esc(T.cPickActive) + '</span>' : '') + '<span class="actions">' + button('', { cmd: 'refresh-preview', cls: 'ghost icon small', icon: 'refresh', aria: T.refresh, title: T.refresh }) + (DETACHED ? '' : button('', { cmd: 'fullscreen', cls: 'ghost icon small', icon: 'expand', aria: T.fullscreen, title: T.fullscreen }) + button('', { cmd: 'detach', cls: 'ghost icon small', icon: 'external', aria: T.detachLabel, title: T.detachLabel })) + '</span></header>';
    h += '<div class="stage"><div class="viewport">' + (DETACHED ? '<div class="frame">' : '');
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
    if (hlState && hlState !== 'NOT_FOUND' && pv && pv.highlight) h += '<p class="selnote" role="status">' + svg('okCircle') + esc(T.isHighlighted(pv.highlight.label || '')) + '</p>';
    else if (hlState === 'NOT_FOUND') h += '<p class="selnote warn" role="status">' + svg('alert') + esc(T.notFoundShort) + '</p>';
    return h + '</div>';
  }

  /** Le chemin d'une adresse (l'hôte de l'application n'apporte rien à l'aperçu). */
  function routeOf(url) {
    try { var u = new URL(url); return u.pathname + u.search + u.hash; } catch (e) { return String(url || ''); }
  }

  function renderPreview() {
    var detached = state.previewDetached === true;
    var grid = $('grid');
    grid.classList.toggle('detached', detached);
    var note = detached ? '<div class="detached-note" role="status">' + esc(T.detachedNote) + button(T.attach, { cmd: 'attach', icon: 'attach', aria: T.attachLabel }) + '</div>' : '';
    setHtml($('detached-note'), note);
    var preview = previewHtml();
    $('preview-card').hidden = detached;
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
    st.parentNode.className = 'statepill ' + (p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working');
    st.textContent = (p === 'RECORDING' ? T.recording : p === 'PAUSED' ? T.paused : p === 'FINALIZING' ? T.finalizing : T.review) + ' · ' + T.actions(state.summary.actions);
    setHtml($('preview-detached'), previewHtml());
  }

  /** LE BANDEAU DE LA REVUE : la reprise possible, le résultat du rejeu, la sauvegarde. */
  function renderReview() {
    var el = $('review');
    if (state.phase !== 'REVIEW') { setHtml(el, ''); return; }
    var r = state.replay;
    var h = '';
    // LA REPRISE : la page tenue devant l'étape corrigée (contexte gardé).
    var rs = state.resume;
    if (rs) {
      h += '<div class="result resume" role="status"><div class="rhead"><span class="rtitle">' + esc(T.resumeTitle(rs.index, rs.description)) + '</span><div class="actions" style="margin-left:auto">' + button(T.resumeHere, { cmd: 'resume-replay', id: rs.stepId, cls: 'primary', icon: 'check', disabled: rs.running }) + button(T.restartFromStart, { cmd: 'replay', disabled: rs.running }) + '</div></div><p class="sub">' + esc(T.resumeHelp) + '</p></div>';
    }
    var rec = r && r.recovery ? '<p class="recov">' + esc((r.recovery.strategy === 'MANUAL_RECOVERY' ? T.resumeBlocked : T.resumedAt)(r.recovery.from, T.strategy[r.recovery.strategy] || r.recovery.strategy)) + (r.recovery.recovered && r.recovery.recovered.length ? ' · ' + esc(T.recoveredSteps(r.recovery.recovered.join(', '))) : '') + '</p>' : '';
    if (r && r.status === 'PASSED') {
      h += '<div class="result ok" role="status">' + svg('okCircle') + '<span class="rtitle">' + esc(T.replayOk) + '</span><ul><li>' + esc(T.executed(r.executed, r.total)) + '</li>' + (r.checks || []).map(function (c) { return '<li>' + (c.ok ? '' : '⚠ ') + esc(c.text) + '</li>'; }).join('') + '</ul>' + rec + '</div>';
    }
    if (r && r.status === 'FAILED' && r.failure) {
      var f = r.failure;
      // Une ligne : le verdict, l'étape et la cause, puis les actions ; les détails techniques repliés.
      h += '<div class="result bad" role="alert"><div class="rhead">' + svg('badCircle') + '<span class="rtitle">' + esc(T.replayBad) + '</span><p class="rmeta">' + esc(T.stepOf(f.index, r.total)) + ' · ' + phrase(f.description) + ' · ' + esc(T.cause) + ' : ' + esc(f.cause) + '</p>';
      h += '<div class="actions">' + (f.stepId ? button(T.cInBrowser, { cmd: 'correct-pick', id: f.stepId, icon: 'cursor' }) : '') + button(T.editStep, { cmd: 'edit-step', id: f.stepId || '', cls: 'ghost' }) + button(T.restart, { cmd: 'replay', cls: 'ghost', icon: 'refresh' }) + '</div></div>';
      h += rec + '<details><summary>' + esc(T.seeDetails) + '</summary><ul>' + f.details.map(function (d) { return '<li class="tech">' + esc(d) + '</li>'; }).join('') + '</ul></details></div>';
    }
    if (state.saved) h += '<div class="result saved" role="status">' + svg('okCircle') + '<span class="rtitle">' + esc(T.saved) + '</span><span class="sub mono">' + esc(state.saved.directory) + '</span></div>';
    if (!r && !state.saved && !rs) h += '<p class="sub" style="margin:0">' + esc(T.recommend) + '</p>';
    setHtml(el, h);
  }

  /** L'ONGLET RÉSEAU : les requêtes métier reliées, étape par étape (en direct : le compteur provisoire). */
  function renderNetwork() {
    var el = $('panel-network');
    var steps = state.actions.filter(function (a) { return a.network && a.network.length; });
    var h = '<div class="card card-plain"><h2>' + esc(T.netTitle) + '</h2>';
    if (state.http && recordingPhase()) h += '<p class="sub">' + esc(T.netLive) + ' · ' + esc(T.httpLive(state.http)) + '</p>';
    h += steps.length ? steps.map(function (a) { return '<div class="netstep"><b>' + esc(T.stepN(a.index)) + ' · ' + phrase(a.description) + '</b>' + a.network.map(netCard).join('') + '</div>'; }).join('') : '<p class="empty">' + esc(T.netNone) + '</p>';
    setHtml(el, h + '</div>');
  }

  /** L'ONGLET DONNÉES DE TEST (revue) : la lignée des variables. */
  function renderData() {
    setHtml($('panel-data'), state.analysis ? lineageCard(state.analysis) : '');
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
    if (!a.available) { setHtml(el, h + '<p class="empty">' + esc(T.analysisWaiting) + '</p></div>' + qualityCard()); return; }
    if (a.running) h += '<p class="notice running" role="status">' + esc(T.analysisRunning) + '</p>';
    // La suite (application, interprétation, HTTP) ouvre ses propres cartes : un simple conteneur ici.
    h += '</div>' + qualityCard() + intentsCard(a) + reviewCard(a) + '<div>';
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
    renderHead(); renderReview(); renderSummary(); renderTimeline(); renderDetails(); renderPreview(); renderNetwork(); renderData(); renderAnalysis(); tickTimer();
  }

  var TABS = ['recording', 'network', 'data', 'analysis', 'preview'];
  /** Les onglets visibles, dans l'ordre (le clavier passe de l'un à l'autre). */
  function visibleTabs() { return TABS.filter(function (n) { var t = $('tab-' + n); return t && !t.hidden && t.offsetParent !== null; }); }
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
    if (target.hasAttribute('data-subtab')) { inspTab = target.getAttribute('data-subtab'); renderDetails(); var again = document.querySelector('[data-subtab="' + inspTab + '"]'); if (again) again.focus(); return; }
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
    if (cmd === 'data-toggle') { if (dataOpen[id]) { delete dataOpen[id]; delete dataDraft[id]; } else dataOpen[id] = true; render(); return; }
    if (cmd === 'intent-edit') { editingIntent = editingIntent === id ? null : id; render(); return; }
    if (cmd === 'intent-cancel') { editingIntent = null; render(); return; }
    if (cmd === 'data-save') {
      var draft = dataDraft[id];
      if (!draft) return;
      delete dataDraft[id];
      delete dataOpen[id];
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
    if (cmd === 'correct-pick') { selected = id || selected; delete rowDraft[id]; delete rowEditOpen[id]; send({ type: cmd, id: id }); render(); return; }
    if (cmd === 'correct-apply') {
      var ropt = document.querySelector('input[name="rowopt-' + id + '"]:checked');
      send(ropt ? (ropt.value === 'columns' ? { type: cmd, id: id, option: 'columns', columns: rowColumns(id) } : { type: cmd, id: id, option: ropt.value }) : { type: cmd, id: id });
      return;
    }
    if (cmd === 'row-edit-open') {
      var st = state.actions.filter(function (a) { return a.id === id; })[0];
      delete rowDraft[id];
      rowEditOpen[id] = st && st.correction ? st.correction.current : null;
      render();
      return;
    }
    if (cmd === 'row-edit-close') { delete rowEditOpen[id]; delete rowDraft[id]; render(); return; }
    if (cmd === 'row-preview' || cmd === 'row-edit') { send({ type: cmd, id: id, columns: rowColumns(id) }); return; }
    if (cmd === 'edit-step') { selected = id || selected; inspTab = 'details'; inspFor = selected; render(); var row = document.querySelector('[data-step="' + id + '"]'); if (row) row.scrollIntoView({ block: 'center' }); return; }
    send({ type: cmd, id: id });
  });

  if (!DETACHED) $('tlsearch').addEventListener('input', function (event) { filterText = event.target.value || ''; renderTimeline(); });

  // Le choix d'un élément survit aux mises à jour du panneau (chaque action reconstruit la liste).
  // Les détails techniques d'une correction restent ouverts d'un rendu à l'autre (toggle ne remonte pas : capture).
  document.addEventListener('toggle', function (event) {
    var d = event.target;
    if (d instanceof HTMLDetailsElement && d.hasAttribute('data-tech')) techOpen[d.getAttribute('data-tech')] = d.open;
  }, true);
  document.addEventListener('change', function (event) {
    var input = event.target;
    if (input instanceof HTMLInputElement && input.name.indexOf('cand-') === 0) choice[input.name.slice(5)] = Number(input.value);
    if (input instanceof HTMLInputElement && input.name.indexOf('rowopt-') === 0) { rowChoice[input.name.slice(7)] = input.value; render(); return; }
    var rc = input && input.getAttribute ? input.getAttribute('data-rowcol') : null;
    if (rc) {
      var entry = (rowDraft[input.getAttribute('data-step-id')] || {})[input.getAttribute('data-column')];
      if (!entry) return;
      if (rc === 'on') entry.on = input.checked;
      else if (rc === 'contains') entry.match = input.checked ? 'contains' : 'exact';
      else if (rc === 'match') entry.match = input.value === 'contains' ? 'contains' : 'exact';
      else entry[rc] = input.value;
      render();
      return;
    }
    var field = input && input.getAttribute ? input.getAttribute('data-bind-field') : null;
    if (field) {
      var draft = dataDraft[input.getAttribute('data-step-id')];
      if (draft) { draft[field] = input.value; if (field === 'source') render(); }
    }
  });
  // La saisie d'une variable ou d'une valeur fixe : gardée dans le brouillon (aucun rendu, le curseur reste).
  document.addEventListener('input', function (event) {
    var input = event.target;
    // La valeur d'une colonne ou le nom d'une nouvelle donnée : gardés dans le brouillon (aucun rendu).
    var rcol = input && input.getAttribute ? input.getAttribute('data-rowcol') : null;
    if (rcol === 'value' || rcol === 'newKey') {
      var draftCol = (rowDraft[input.getAttribute('data-step-id')] || {})[input.getAttribute('data-column')];
      if (draftCol) draftCol[rcol] = input.value;
      return;
    }
    var field = input && input.getAttribute ? input.getAttribute('data-bind-field') : null;
    if (!field || field === 'source') return;
    var draft = dataDraft[input.getAttribute('data-step-id')];
    if (draft) draft[field] = input.value;
  });

  if (!DETACHED) document.querySelector('.tabs').addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    var shown = visibleTabs(), i = shown.indexOf(tab), next = shown[(i + (event.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length];
    if (!next) return;
    selectTab(next); $('tab-' + next).focus();
  });
  // Les sous-onglets de l'inspecteur : flèches gauche / droite.
  if (!DETACHED) $('details').addEventListener('keydown', function (event) {
    if ((event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') || !(event.target instanceof Element) || !event.target.hasAttribute('data-subtab')) return;
    var subs = ['details', 'target', 'network'], i = subs.indexOf(inspTab);
    inspTab = subs[(i + (event.key === 'ArrowRight' ? 1 : subs.length - 1)) % subs.length];
    renderDetails();
    var el = document.querySelector('[data-subtab="' + inspTab + '"]'); if (el) el.focus();
  });

  if (DETACHED) {
    $('subtitle').textContent = T.previewTitle;
    $('detached-actions').innerHTML = button(T.fullscreen, { cmd: 'fullscreen', cls: 'primary', icon: 'expand', aria: T.fullscreen }) + button(T.attach, { cmd: 'attach', icon: 'attach', aria: T.attachLabel });
    return;
  }
  $('subtitle').textContent = T.subtitle;
  $('devtoggle').innerHTML = svg('code');
  $('devtoggle').setAttribute('aria-label', T.devMode); $('devtoggle').setAttribute('title', T.devMode);
  $('layouttoggle').setAttribute('aria-label', T.layoutLabel);
  $('tab-recording').textContent = T.tabRecording; $('tab-network').textContent = T.tabNetwork; $('tab-data').textContent = T.tabData; $('tab-analysis').textContent = T.tabAnalysis; $('tab-preview').textContent = T.tabPreview;
  document.querySelector('.tabs').setAttribute('aria-label', T.tabs);
  $('head').setAttribute('aria-label', T.recording);
  setInterval(tickTimer, 1000);
})();
`;
