/**
 * LA FENÊTRE « QA-CRAWLER Recorder » : une page autonome (aucune dépendance, aucun réseau), rendue
 * dans un contexte de navigateur SÉPARÉ de l'application enregistrée (jamais capturée, jamais
 * observée). Node lui envoie l'état (window.__qaPanelRender) ; elle renvoie des commandes
 * (window.__qaPanelCommand). Elle n'enregistre rien elle-même et ne décide de rien.
 *
 * Accessible : vrais boutons, aria-label, focus visible, onglets clavier, statuts dits en texte
 * (jamais par la couleur seule), annonces aria-live. Responsive : une colonne sur une fenêtre étroite,
 * la timeline et les détails côte à côte sur une large.
 */
export function recorderPanelHtml(language: 'fr' | 'en'): string {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER Recorder</title>
<style>${CSS}</style>
</head>
<body>
<header class="head" id="head">
  <div class="brand">QA-CRAWLER Recorder</div>
  <div class="title-row">
    <h1 id="state" class="state" aria-live="polite"></h1>
    <span class="timer" id="timer" aria-label=""></span>
    <span class="count" id="count"></span>
  </div>
  <div class="controls" id="controls" role="toolbar"></div>
  <div class="progress" id="progress" hidden><div class="bar"><span></span></div><p></p></div>
</header>
<nav class="tabs" role="tablist" aria-label="">
  <button role="tab" id="tab-recording" aria-controls="panel-recording" aria-selected="true"></button>
  <button role="tab" id="tab-analysis" aria-controls="panel-analysis" aria-selected="false" tabindex="-1"></button>
  <span class="spacer"></span>
  <div class="mode" role="group" id="mode">
    <button type="button" data-mode="user" aria-pressed="true"></button>
    <button type="button" data-mode="dev" aria-pressed="false"></button>
  </div>
</nav>
<main>
  <section id="panel-recording" role="tabpanel" aria-labelledby="tab-recording">
    <div id="review"></div>
    <div id="summary" class="summary"></div>
    <div class="columns">
      <div class="timeline-col">
        <h2 id="timeline-title"></h2>
        <ol id="timeline" class="timeline"></ol>
        <div id="checks"></div>
      </div>
      <aside id="details" class="details" aria-live="polite" hidden></aside>
    </div>
    <details id="quality" class="quality"></details>
  </section>
  <section id="panel-analysis" role="tabpanel" aria-labelledby="tab-analysis" hidden></section>
</main>
<div id="live" class="sr-only" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root{
  --bg:#f4f5f7;--surface:#ffffff;--surface-2:#f8f9fb;--fg:#0f172a;--muted:#64748b;--line:#e5e7eb;--line-strong:#d4d8de;
  --accent:#4f46e5;--accent-soft:#eef2ff;--accent-fg:#ffffff;
  --ok:#059669;--ok-soft:#ecfdf5;--warn:#b45309;--warn-soft:#fffbeb;--bad:#e11d48;--bad-soft:#fff1f2;--run:#2563eb;--run-soft:#eff6ff;--idle:#94a3b8;
  --head:#0b1020;--head-fg:#f8fafc;--head-muted:#94a3b8;--head-line:rgba(255,255,255,.08);
  --radius:14px;--radius-sm:10px;--shadow:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.06);--focus:#6366f1;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0b0f17;--surface:#121826;--surface-2:#161e2e;--fg:#e5e9f0;--muted:#94a3b8;--line:#232c3d;--line-strong:#2f3a4f;
  --accent:#818cf8;--accent-soft:rgba(129,140,248,.14);--accent-fg:#0b0f17;
  --ok:#34d399;--ok-soft:rgba(52,211,153,.12);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.12);--bad:#fb7185;--bad-soft:rgba(251,113,133,.12);--run:#60a5fa;--run-soft:rgba(96,165,250,.12);--idle:#64748b;
  --head:#05070c;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);--focus:#a5b4fc;
}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
button{font:inherit;cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);border-radius:999px;padding:7px 14px;min-height:34px;font-weight:550;transition:background .15s,border-color .15s,box-shadow .15s,transform .05s}
button:hover:not(:disabled){border-color:var(--muted);box-shadow:0 1px 4px rgba(15,23,42,.08)}
button:active:not(:disabled){transform:translateY(1px)}
button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,[tabindex]:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button.primary:hover:not(:disabled){filter:brightness(1.07)}
button.danger{background:var(--bad);border-color:var(--bad);color:#fff}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.head{position:sticky;top:0;z-index:3;background:var(--head);color:var(--head-fg);padding:14px 18px 12px;border-bottom:1px solid var(--head-line)}
.brand{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--head-muted);font-weight:700;margin-bottom:6px}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.state{font-size:16px;font-weight:700;margin:0;display:inline-flex;align-items:center;gap:8px}
.state::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--head-muted);flex:none}
.state.rec::before{background:#ef4444;box-shadow:0 0 0 0 rgba(239,68,68,.6);animation:pulse 1.6s infinite}
.state.paused::before{background:#f59e0b}
.state.done::before{display:none}
.state.working::before{background:#60a5fa}
.timer{margin-left:auto;font:600 22px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.count{font-size:12px;font-weight:600;color:var(--head-fg);background:rgba(255,255,255,.08);border-radius:999px;padding:3px 10px}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.controls:empty{display:none}
.controls button{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.14);color:var(--head-fg)}
.controls button:hover:not(:disabled){background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3)}
.controls button.primary{background:#6366f1;border-color:#6366f1;color:#fff}
.controls button.danger{background:#e11d48;border-color:#e11d48;color:#fff;margin-left:auto}
.controls .note{flex-basis:100%;margin:2px 0 0;color:#fcd34d;font-size:13px}
.progress{margin-top:12px}
.progress .bar{height:4px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}
.progress .bar span{display:block;height:100%;background:linear-gradient(90deg,#6366f1,#22d3ee);width:0;transition:width .3s}
.progress.indeterminate .bar span{width:30%;animation:slide 1.2s ease-in-out infinite}
.progress p{margin:6px 0 0;color:var(--head-muted);font-size:12px}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(330%)}}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}70%{box-shadow:0 0 0 8px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.tabs{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:10px 18px;background:var(--surface);border-bottom:1px solid var(--line)}
.tabs [role=tab]{border:0;border-radius:999px;background:none;padding:6px 14px;min-height:32px;font-weight:600;color:var(--muted)}
.tabs [role=tab]:hover{background:var(--surface-2);box-shadow:none}
.tabs [role=tab][aria-selected=true]{color:var(--accent);background:var(--accent-soft)}
.spacer{flex:1}
.mode{display:flex;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:2px}
.mode button{border:0;border-radius:999px;padding:4px 12px;min-height:28px;font-size:12px;background:none;color:var(--muted);box-shadow:none}
.mode button[aria-pressed=true]{background:var(--surface);color:var(--fg);box-shadow:0 1px 3px rgba(15,23,42,.12)}
main{padding:16px 18px 40px;max-width:1200px;margin:0 auto}
h2{font-size:12px;margin:18px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700}
.sub{display:block;color:var(--muted);font-size:13px;font-weight:400}
.empty{color:var(--muted);font-style:italic}
.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:6px}
.summary .status{grid-column:1/-1;display:flex;align-items:center;gap:8px;border-radius:var(--radius-sm);padding:9px 12px;font-weight:600;background:var(--surface);border:1px solid var(--line)}
.summary.ok .status{background:var(--ok-soft);border-color:transparent;color:var(--ok)}
.summary.warn .status{background:var(--warn-soft);border-color:transparent;color:var(--warn)}
.summary.run .status{background:var(--run-soft);border-color:transparent;color:var(--run)}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;box-shadow:var(--shadow)}
.tile b{display:block;font-size:22px;line-height:1.1;font-variant-numeric:tabular-nums}
.tile span{font-size:12px;color:var(--muted)}
.tile.ok b{color:var(--ok)} .tile.warn b{color:var(--warn)}
.columns{display:grid;grid-template-columns:1fr;gap:16px}
@media (min-width:860px){.columns{grid-template-columns:minmax(0,1fr) 360px}}
.timeline{list-style:none;margin:0;padding:0;position:relative}
.timeline>li{position:relative;padding:0 0 10px 38px}
.timeline>li::before{content:"";position:absolute;left:13px;top:30px;bottom:-2px;width:2px;background:var(--line)}
.timeline>li:last-child::before{display:none}
.item{position:relative;display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:11px 14px;box-shadow:var(--shadow);font-weight:400}
.item:hover:not(:disabled){border-color:var(--line-strong);box-shadow:0 2px 10px rgba(15,23,42,.08)}
.item[aria-current=true]{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.icon{position:absolute;left:-38px;top:9px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:800;color:#fff;background:var(--idle);box-shadow:0 0 0 4px var(--bg)}
.CONFIRMED .icon{background:var(--ok)} .PENDING .icon{background:var(--run)} .AMBIGUOUS .icon{background:var(--warn)} .FAILED .icon{background:var(--bad)} .UNVERIFIED .icon{background:var(--idle)}
.PENDING .icon{animation:breathe 1.4s ease-in-out infinite}
@keyframes breathe{50%{opacity:.55}}
.num{color:var(--muted);font:600 12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;min-width:18px}
.desc{flex:1;min-width:0;font-weight:600;word-break:break-word}
.desc .sub{margin-top:2px}
.chip{flex:none;font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px;background:var(--surface-2);color:var(--muted);border:1px solid var(--line);white-space:nowrap}
.CONFIRMED .chip{background:var(--ok-soft);color:var(--ok);border-color:transparent}
.PENDING .chip{background:var(--run-soft);color:var(--run);border-color:transparent}
.AMBIGUOUS .chip{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.FAILED .chip{background:var(--bad-soft);color:var(--bad);border-color:transparent}
.tech{display:block;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:pre-wrap;margin-top:6px;background:var(--surface-2);border-radius:8px;padding:8px 10px;font-weight:400}
.attention{margin:8px 0 0;padding:12px 14px;border:1px solid transparent;border-radius:var(--radius);background:var(--warn-soft)}
.attention p{margin:0 0 8px}
.attention .row,.row{display:flex;gap:8px;flex-wrap:wrap}
.attention fieldset{border:0;padding:0;margin:6px 0 10px}
.attention legend{font-weight:600;margin-bottom:6px}
.attention label{display:flex;gap:8px;align-items:center;padding:8px 10px;margin-bottom:6px;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--line);cursor:pointer}
.attention label:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.attention .error{color:var(--bad);margin-top:8px;font-weight:600}
.remove{margin:6px 0 0}
.remove button{color:var(--bad);border-color:var(--bad-soft);background:var(--bad-soft)}
.details{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:16px;align-self:start;position:sticky;top:140px;box-shadow:var(--shadow)}
.details h3{margin:0 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.details .title{font-size:15px;font-weight:700;margin:0 0 12px}
.details dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:13px}
.details dt{color:var(--muted)} .details dd{margin:0;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.details dd.plain{font-family:inherit;font-size:13px;font-weight:600}
.details .found{margin:14px 0;padding:8px 10px;border-radius:var(--radius-sm);font-weight:600;font-size:13px}
.found.ok{background:var(--ok-soft);color:var(--ok)} .found.warn{background:var(--warn-soft);color:var(--warn)}
.quality{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:12px 16px;margin-top:16px;box-shadow:var(--shadow)}
.quality summary{font-weight:700;cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none}
.quality summary::-webkit-details-marker{display:none}
.ring{--p:0;width:34px;height:34px;border-radius:50%;background:conic-gradient(var(--ok) calc(var(--p)*1%),var(--line) 0);display:grid;place-items:center;flex:none}
.ring::after{content:"";width:24px;height:24px;border-radius:50%;background:var(--surface)}
.quality .score{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ok)}
.quality ul{list-style:none;padding:0;margin:12px 0 2px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}
.quality li{padding:6px 10px;border-radius:var(--radius-sm);background:var(--surface-2);font-size:13px}
.quality li.ok{color:var(--ok)} .quality li.warn{color:var(--warn);background:var(--warn-soft)}
.review{border:1px solid var(--line);border-radius:18px;background:var(--surface);padding:22px 18px;margin-bottom:16px;text-align:center;box-shadow:var(--shadow)}
.review .hero{width:48px;height:48px;border-radius:50%;margin:0 auto 10px;display:grid;place-items:center;background:var(--ok-soft);color:var(--ok);font-size:24px;font-weight:800}
.review h2{color:var(--fg);text-transform:none;letter-spacing:0;font-size:19px;margin:0 0 14px}
.review .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 16px}
.review .stats span{background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 6px;font-size:12px;color:var(--muted)}
.review .stats b{display:block;color:var(--fg);font-size:18px;font-variant-numeric:tabular-nums}
.review .actions,.result .actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.review .actions button.primary{padding:9px 22px;font-size:15px}
.review .hint{margin:12px 0 0;color:var(--muted);font-size:13px}
.result{border-radius:var(--radius);padding:14px 16px;margin-top:14px;text-align:left}
.result.ok{background:var(--ok-soft)} .result.bad{background:var(--bad-soft)}
.result.ok>b{color:var(--ok)} .result.bad>b{color:var(--bad)}
.result ul{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:4px}
.result p{margin:8px 0}
.result details{margin:6px 0 10px}
.result .actions{justify-content:flex-start}
.checks{margin-top:6px;margin-left:38px}
.checks summary{cursor:pointer;color:var(--muted);font-weight:600}
.checks ul{margin:6px 0 0;padding-left:18px;color:var(--muted)}
.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:14px 16px;margin-bottom:10px;box-shadow:var(--shadow)}
.card .meta{color:var(--muted);font-size:12px;margin-top:2px}
.card .tag{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;background:var(--accent-soft);color:var(--accent);margin-right:6px}
.notice{background:var(--accent-soft);color:var(--fg);border-radius:var(--radius-sm);padding:10px 12px;font-size:13px}
@media (max-width:520px){.tabs{padding:8px 12px}.tabs [role=tab]{padding:6px 10px}.mode button{padding:4px 9px}main{padding:14px 12px 32px}.head{padding:12px 14px 10px}.summary{grid-template-columns:repeat(3,minmax(0,1fr))}.review .stats{grid-template-columns:repeat(2,minmax(0,1fr))}.timer{font-size:18px}}
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
  var ICON = { CONFIRMED: '✓', PENDING: '●', AMBIGUOUS: '⚠', FAILED: '✕', UNVERIFIED: '○' };
  var state = null, selected = null, resolving = null, dev = false, editing = false, tab = 'recording', lastCount = -1;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var send = function (cmd) { try { window.__qaPanelCommand(cmd); } catch (e) { /* hors QA-CRAWLER */ } };
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  var clock = function (ms) { var s = Math.max(0, Math.floor(ms / 1000)); return two(Math.floor(s / 60)) + ':' + two(s % 60); };
  var announce = function (text) { $('live').textContent = text; };

  function button(label, attrs) {
    var a = attrs || {};
    return '<button type="button"' + (a.cls ? ' class="' + a.cls + '"' : '') + (a.cmd ? ' data-cmd="' + a.cmd + '"' : '') + (a.id ? ' data-id="' + esc(a.id) + '"' : '') + (a.aria ? ' aria-label="' + esc(a.aria) + '"' : '') + (a.disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }

  function renderHead() {
    var p = state.phase, st = $('state');
    st.className = 'state ' + (p === 'RECORDING' ? 'rec' : p === 'PAUSED' ? 'paused' : p === 'REVIEW' ? 'done' : 'working');
    // Le point (animé en enregistrement) et le texte disent l'état : jamais la couleur seule.
    st.textContent = (p === 'RECORDING' ? T.recording : p === 'PAUSED' ? '⏸ ' + T.paused : p === 'FINALIZING' ? T.finalizing : '✓ ' + T.review);
    $('count').textContent = T.actions(state.summary.actions);
    var recording = p === 'RECORDING' || p === 'PAUSED';
    var c = '';
    if (recording) {
      c += p === 'PAUSED' ? button(T.resume, { cmd: 'resume', cls: 'primary', aria: T.resumeLabel }) : button(T.pause, { cmd: 'pause', aria: T.pauseLabel });
      c += button(T.undo, { cmd: 'undo', aria: T.undoLabel, disabled: state.actions.length <= 1 });
      c += button(T.stop, { cmd: 'stop', cls: 'danger', aria: T.stopLabel });
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
    var end = state.endedAt || Date.now();
    var text = clock(end - state.startedAt);
    $('timer').textContent = text;
    $('timer').setAttribute('aria-label', T.duration + ' ' + text);
  }

  function renderSummary() {
    var s = state.summary, el = $('summary');
    // La revue a ses propres chiffres : le résumé n'est pas répété.
    el.hidden = state.phase === 'REVIEW';
    if (s.actions === 0) { el.className = 'summary'; el.innerHTML = '<div class="status"><span class="empty">' + esc(T.empty) + '</span></div>'; return; }
    var problems = s.attention > 0;
    el.className = 'summary ' + (problems ? 'warn' : s.pending > 0 ? 'run' : 'ok');
    var status = problems ? '⚠ ' + T.needsCheck + ' — ' + T.attention(s.attention) : s.pending > 0 ? '● ' + T.pendingN(s.pending) : '✓ ' + T.valid + ' — ' + T.allConfirmed(s.confirmed);
    var lines = [];
    if (s.ambiguous) lines.push(T.ambiguousN(s.ambiguous));
    if (s.failed) lines.push(T.failedN(s.failed));
    el.innerHTML = '<div class="tile"><b>' + s.actions + '</b><span>' + esc(T.actions(s.actions).replace(/^\\d+\\s*/, '')) + '</span></div>' +
      '<div class="tile ok"><b>' + s.confirmed + '</b><span>' + esc(T.confirmedN(s.confirmed).replace(/^\\d+\\s*/, '')) + '</span></div>' +
      '<div class="tile' + (problems ? ' warn' : '') + '"><b>' + s.attention + '</b><span>' + esc(T.toReview) + '</span></div>' +
      '<div class="status" role="status">' + esc(status) + (lines.length ? ' · ' + esc(lines.join(' · ')) : '') + '</div>';
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
      h += '<span class="icon" aria-hidden="true">' + ICON[step.status] + '</span><span class="num">' + step.index + '</span><span class="desc">';
      if (dev) h += esc(step.technical.event || step.technical.kind || '') + '<span class="tech">' + esc(techLines(step)) + '</span>';
      else h += esc(step.description) + (step.detail ? '<span class="sub">' + esc(step.detail) + '</span>' : '') + '<span class="sub">' + esc(step.statusText) + '</span>';
      h += '</span><span class="chip" aria-hidden="true">' + esc(T.status[step.status]) + '</span></button>';
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

  function renderDetails() {
    var box = $('details');
    var step = state.actions.find(function (s) { return s.id === selected; });
    if (!step) { box.hidden = true; return; }
    box.hidden = false;
    var keys = Object.keys(step.technical);
    var h = '<h3>' + esc(T.detailsTitle) + '</h3><p class="title">' + esc(step.description) + '</p><dl>';
    h += '<dt>' + esc(T.field.validation) + '</dt><dd class="plain">' + ICON[step.status] + ' ' + esc(step.statusText) + '</dd>';
    keys.forEach(function (k) { if (k !== 'validation') h += '<dt>' + esc(T.field[k] || k) + '</dt><dd>' + esc(step.technical[k]) + '</dd>'; });
    h += '</dl>';
    if (state.highlight && state.highlight.actionId === step.id) {
      var r = state.highlight.result;
      h += '<p class="found ' + (r === 'NOT_FOUND' ? 'warn' : 'ok') + '" role="status">' + esc(T.found[r]) + '</p>';
    }
    h += button(T.close, { cmd: 'deselect' });
    box.innerHTML = h;
  }

  function renderQuality() {
    var q = state.quality, el = $('quality');
    var open = el.open;
    var h = '<summary><span class="ring" style="--p:' + (q.score || 0) + '" aria-hidden="true"></span>' + esc(T.quality) + (q.score !== undefined ? '<span class="score">' + q.score + ' %</span>' : '') + '</summary>';
    if (q.score === undefined) h += '<p class="empty">' + esc(T.noQuality) + '</p>';
    else {
      h += '<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + q.score + '" aria-label="' + esc(T.quality) + '"><span style="width:' + q.score + '%"></span></div><ul>';
      q.checks.forEach(function (c) { if (c.total > 0) h += '<li class="' + (c.ok ? 'ok' : 'warn') + '">' + (c.ok ? '✓ ' : '⚠ ') + esc(T.checksQ[c.id]) + (c.ok ? '' : ' (' + c.passed + ' / ' + c.total + ')') + '</li>'; });
      h += '</ul>';
    }
    el.innerHTML = h; el.open = open;
  }

  function renderReview() {
    var el = $('review');
    if (state.phase !== 'REVIEW') { el.innerHTML = ''; return; }
    var s = state.summary, r = state.replay;
    var h = '<div class="review" role="region" aria-label="' + esc(T.done) + '"><div class="hero" aria-hidden="true">✓</div><h2>' + esc(T.done) + '</h2><div class="stats"><span>' + T.recorded(s.actions) + '</span><span>' + T.confirmedS(s.confirmed) + '</span><span>' + T.ambS(s.ambiguous) + '</span><span><b>' + clock((state.endedAt || Date.now()) - state.startedAt) + '</b>' + esc(T.duration) + '</span></div>';
    var running = r && r.status === 'RUNNING';
    h += '<div class="actions">';
    h += button(T.replay, { cmd: 'replay', cls: 'primary', disabled: running });
    h += button(editing ? T.editing : T.edit, { cmd: 'edit', disabled: running });
    h += button(r && r.status === 'PASSED' ? T.saveFlow : T.save, { cmd: 'save', disabled: running });
    h += button(T.finish, { cmd: 'finish', disabled: running });
    h += '</div>';
    if (!r && !state.saved) h += '<p class="hint">' + esc(T.recommend) + '</p>';
    if (r && r.status === 'PASSED') {
      h += '<div class="result ok" role="status"><b>' + esc(T.replayOk) + '</b><ul><li>✓ ' + esc(T.executed(r.executed, r.total)) + '</li>' + (r.checks || []).map(function (c) { return '<li>' + (c.ok ? '✓ ' : '⚠ ') + esc(c.text) + '</li>'; }).join('') + '</ul></div>';
    }
    if (r && r.status === 'FAILED' && r.failure) {
      var f = r.failure;
      h += '<div class="result bad" role="alert"><b>' + esc(T.replayBad) + '</b><p>' + esc(T.stepOf(f.index, r.total)) + '<br><b>' + esc(f.description) + '</b><br>' + esc(T.cause) + ' : ' + esc(f.cause) + '</p>';
      h += '<details><summary>' + esc(T.seeDetails) + '</summary><ul>' + f.details.map(function (d) { return '<li class="tech">' + esc(d) + '</li>'; }).join('') + '</ul></details>';
      h += '<div class="actions">' + button(T.editStep, { cmd: 'edit-step', id: f.stepId || '' }) + button(T.restart, { cmd: 'replay' }) + '</div></div>';
    }
    if (state.saved) h += '<div class="result ok" role="status"><b>' + esc(T.saved) + '</b><p class="sub">' + esc(state.saved.directory) + '</p></div>';
    el.innerHTML = h + '</div>';
  }

  function renderAnalysis() {
    var a = state.analysis, el = $('panel-analysis');
    var h = '<h2>' + esc(T.analysisTitle) + '</h2><p class="notice">' + esc(T.analysisNote) + '</p>';
    if (!a.available) { el.innerHTML = h + '<p class="empty">' + esc(T.analysisWaiting) + '</p>'; return; }
    h += '<h2>' + esc(T.intents) + '</h2>';
    h += a.intents.length ? a.intents.map(function (i) {
      return '<div class="card"><b>' + esc(i.label) + '</b>' + (i.detail ? '<div class="meta">' + esc(i.detail) + '</div>' : '') + (i.confidence !== undefined ? '<div class="meta">' + esc(T.confidence) + ' : ' + Math.round(i.confidence * 100) + ' %</div>' : '') + (i.evidence.length ? '<details><summary>' + esc(T.why) + '</summary><ul>' + i.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></details>' : '') + '</div>';
    }).join('') : '<p class="empty">' + esc(T.noIntent) + '</p>';
    h += '<h2>' + esc(T.findings) + '</h2>';
    h += a.findings.length ? a.findings.map(function (f) {
      return '<div class="card"><span class="tag">' + esc(f.severity) + '</span><b>' + esc(f.message) + '</b><div class="meta">' + esc(T.origin[f.origin] || f.origin) + '</div>' + (f.suggestion ? '<div>' + esc(f.suggestion) + '</div>' : '') + '</div>';
    }).join('') : '<p class="empty">' + esc(T.noFinding) + '</p>';
    if (a.aiCandidates > 0) h += '<p class="sub">' + esc(T.ai(a.aiCandidates)) + '</p>';
    el.innerHTML = h;
  }

  function render() {
    if (!state) return;
    renderHead(); tickTimer(); renderReview(); renderSummary(); renderTimeline(); renderDetails(); renderQuality(); renderAnalysis();
  }

  function selectTab(name) {
    tab = name;
    ['recording', 'analysis'].forEach(function (n) {
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
    var cmd = target.getAttribute('data-cmd'), id = target.getAttribute('data-id');
    var mode = target.getAttribute('data-mode');
    if (mode) { dev = mode === 'dev'; document.querySelectorAll('[data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode)); }); render(); return; }
    if (target.getAttribute('role') === 'tab') { selectTab(target.id === 'tab-analysis' ? 'analysis' : 'recording'); return; }
    if (!cmd) return;
    if (cmd === 'select') { selected = id; render(); send({ type: 'select', id: id }); return; }
    if (cmd === 'deselect') { selected = null; render(); return; }
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

  document.querySelector('.tabs').addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    var next = tab === 'recording' ? 'analysis' : 'recording';
    selectTab(next); $('tab-' + next).focus();
  });

  $('tab-recording').textContent = T.tabRecording; $('tab-analysis').textContent = T.tabAnalysis;
  document.querySelector('.tabs').setAttribute('aria-label', T.tabs);
  document.querySelector('[data-mode="user"]').textContent = T.user; document.querySelector('[data-mode="dev"]').textContent = T.dev;
  $('mode').setAttribute('aria-label', T.user + ' / ' + T.dev);
  setInterval(tickTimer, 1000);
})();
`;
