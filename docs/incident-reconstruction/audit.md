# Audit : Investigation Workspace (Incident Reconstruction)

Audit fait avant toute modification, sur la branche `feat/incident-reconstruction` (worktree
`qa-crawler-incident`, base `1e6d471`), avec le module Incident Reconstruction **non commité** dans
l'arbre de travail. Il établit ce qui existe, ce qui peut être réutilisé, ce qui manque et les risques
pour construire un « Investigation Workspace » interactif (graphe Frontend → BFF → Backend, trace
frontend, chronologie unifiée, requêtes HTTP, explorateur de code, hypothèses → non-régression,
sélection synchronisée, LOCAL / REMOTE / ARO, thème sombre, responsive, accessibilité).

Référence au départ : `npx vitest run --project unit tests/unit/incident- tests/unit/sdk-dashboard-incidents.test.ts tests/unit/sdk-contract.test.ts tests/unit/network-capture-bodies.test.ts`
→ **16 fichiers, 213 tests, 0 échec**.

## 1. Architecture réelle du dépôt

| Couche                | Où                                                                                                  | Rôle                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Moteur                | `src/explorer/flow-explorer.ts`, `src/observers/*`, `src/browser/browser-manager.ts`, `src/model/*` | Playwright : exploration, rejeu des flows, observation (réseau, console, anomalies), `result.json` par run                   |
| Incident (Node)       | `src/incident/**`                                                                                   | service, stockage, périmètre et Scope Policy Engine, preuves, index de code, corrélateur, hypothèses, vérifications, rapport |
| SDK core (navigateur) | `src/sdk/core/` (`client.ts`, `contracts.ts`, `incident-contracts.ts`, `lifecycle.ts`…)             | contrats et client HTTP, sans dépendance Node                                                                                |
| SDK server (Node)     | `src/sdk/server/` (`server.ts`, `incidents.ts`, `access.ts`, `platform.ts`, `page.ts`…)             | API `/api/…`, pages HTML, service des modules navigateur                                                                     |
| SDK ui (navigateur)   | `src/sdk/ui/` (Web Components : wizard, studio, runs, monitor, dashboard)                           | rendu HTML en chaînes, contrôleurs                                                                                           |
| SDK editor            | `src/sdk/editor/` (`flow-document.ts`, `gherkin-document.ts`, `code-outline.ts`)                    | modèles purs embarqués **uniquement** dans le kit regroupé `editor-kit.js`                                                   |
| Contrat partagé       | `src/incident/model.ts` = `export * from '../sdk/core/incident-contracts.js'`                       | le moteur importe le contrat depuis le côté navigateur                                                                       |

### 1.1 Service des modules navigateur (`serveModule`)

`src/sdk/server/server.ts:4104-4136` ; aiguillage `server.ts:446` (`/sdk/…`).

- Seuls `GET` / `HEAD` ; chemin **exactement** `/sdk/<core|ui>/<nom>.js` : `parts.length === 2`,
  dossier `core` ou `ui`, nom conforme à `/^[a-z0-9-]+\.js$/` (`server.ts:4108-4109`). **Aucun
  sous-dossier n'est servi** : un fichier `src/sdk/ui/workspace/x.ts` serait introuvable dans le
  navigateur. Nouveaux fichiers : à plat, en minuscules et tirets (`dashboard-workspace-graph.ts`…).
- Ordre de résolution : cache mémoire `MODULE_CACHE` (`server.ts:4082`), cas dédié
  `ui/editor-kit.js` (`editorKitModule`, `server.ts:4090-4101` : le `.js` compilé portant le marqueur
  `/* qa-crawler editor kit: bundled */`, sinon regroupement esbuild à la demande par
  `scripts/editor-kit-bundle.mjs`), puis le `.js` compilé, sinon le `.ts` transpilé par
  `ts.transpileModule` (ES2022, **sans réécriture des imports** : chemins relatifs `./x.js`
  obligatoires).
- En-têtes : `access-control-allow-origin: *`, `cache-control: no-cache` ; le cache serveur n'est
  jamais invalidé pendant la vie du serveur (un module modifié demande un redémarrage en
  développement).

### 1.2 Règle des imports (`tests/unit/sdk-contract.test.ts`)

- `:158-177` : tout fichier `.ts` de `src/sdk/core` et `src/sdk/ui` (sauf `ui/editor-kit.ts`) n'importe
  **à l'exécution** que `src/sdk/core` ou `src/sdk/ui` (les `import type …;` sont retirés avant
  l'analyse). Aucun module Node, aucun Playwright, rien de `src/incident`, `src/reporting`,
  `src/sdk/editor` ni `src/sdk/server`.
- `:179-198` : `ui/editor-kit.ts` et `src/sdk/editor/*` n'importent que des chemins relatifs sous
  `src/sdk`, `@codemirror/*`, `@lezer/*`, `@cucumber/gherkin|messages`, `yaml`.
- Conséquence : le code du Workspace côté navigateur vit dans `src/sdk/ui` (rendu, modèles purs) ou
  `src/sdk/core` (contrats, client) ; tout ce qui lit le disque ou le code des dépôts reste dans
  `src/incident` / `src/sdk/server`.

### 1.3 Page `/dashboard` et CSP

`src/sdk/server/page.ts:136-166` (`dashboardPage`) ; en-têtes `server.ts:458-461`.

- La page lit `?theme=` et `?days=` seulement (`page.ts:157`) ; aucune route du Dashboard n'est reprise
  de l'URL.
- CSP : `script-src 'self' 'nonce-…'`, `style-src 'unsafe-inline' https://fonts.googleapis.com`,
  **`img-src data:`**, `connect-src 'self'`. Une capture d'écran ne peut pas être affichée par
  `<img src="/reports/…">` : il faut une `data:` URL, ou l'ouverture dans un onglet par un lien à
  ticket (`serveReport`, `server.ts:4158-4189`, sans type `.zip` : `trace.zip` n'y est pas servi).

## 2. Frontend : le Dashboard (Web Component, rendu en chaînes, sans React)

### 2.1 Modèle de rendu

| Élément               | Où                                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classe                | `QaCrawlerDashboard` (`src/sdk/ui/dashboard.ts:86`), Shadow DOM ouvert (`:117`), `defineDashboard` (`:2997`) ; attributs observés `endpoint`, `locale`, `days`, `sign-in` (`:87-89`) ; `theme` n'est pas observé (le CSS le lit directement)                                                                          |
| État                  | `DashboardState` (`src/sdk/ui/dashboard-view.ts:138-207`), un seul objet ; incidents : `state.inc?: IncidentsUi` (`dashboard-incidents.ts:117-142`)                                                                                                                                                                   |
| Rendu                 | `paint()` (`dashboard.ts:2934-2990`) : `root.innerHTML = <style>DASHBOARD_CSS</style> + renderDashboard(state)` ; **tout le Shadow DOM est réécrit** à chaque appel                                                                                                                                                   |
| Fonctions pures       | `renderDashboard` (`dashboard-view.ts:263`) → `body()` (`:301`) → `incidentsView` / `incidentView` (`dashboard-incidents.ts:458`, `:564`) ; échappement par `esc()` (`src/sdk/ui/view.ts:69`)                                                                                                                         |
| Événements            | délégation sur le Shadow root (`dashboard.ts:191-298`) : `click` → `onClick` (`:2284`) lit `[data-action]` et passe la main par préfixe (`inc-` → `IncidentsController.click`, `:2302`) ; `submit` (`form[data-action^="inc-"]`, `:208`) ; `input` (`data-inc`, `:213`) ; `change` (`:2694`) ; `keydown` (`:276-290`) |
| Contrôleurs           | `EditorController`, `PublishController`, `LibraryController`, `IncidentsController`, chacun avec un hôte `{ root, api(), paint(), navigate(), refresh(), state }` (`dashboard.ts:140-189`)                                                                                                                            |
| Montage persistant    | seul l'éditeur garde des nœuds vivants entre deux dessins : `editor.beforePaint()` / `afterPaint()` (`dashboard.ts:2961-2964`, `dashboard-editor-controller.ts:1303-1375`) qui réinsère la vue CodeMirror par `attach(host)` ; même idée pour la console (`dashboard-console-controller.ts:278`, `:356`)              |
| Restauration du focus | `paint()` mémorise `data-action` / `data-bind` / `data-field` / `data-req` / `data-lib` / `data-ed-field` / `data-ed-add` / `data-ed` / `data-inc`, la valeur, le jumeau (`data-block`, `data-index`, `data-direction`) et le curseur, puis refocalise (`:2966-2989`) ; saisies protégées : `KEEP_TYPING` (`:2993`)   |
| Chargement            | `load()` (`dashboard.ts:1593`) numéroté par `generation` (réponse périmée ignorée) ; incidents : `incidents.load(api, route, current)` (`:1700`) puis `afterLoad()` (`:1725`)                                                                                                                                         |
| Suivi                 | `IncidentsController.poll()` (`dashboard-incidents-controller.ts:208-237`) : relit **l'incident entier** toutes les 1,5 s (`INCIDENT_POLL_MS`, `:48`) tant que `needsPolling` (`dashboard-incidents.ts:345`) ; arrêt par `leave()` (`:114`) et `dispose()`                                                            |
| Droits                | `can(state, right)` (`dashboard-access.ts:31`) ; vrai si `state.me` est absent (jeton de service). Droits : `RIGHTS` (`src/sdk/core/contracts.ts:1966`), rôles `ROLE_RIGHTS` (`:1982`)                                                                                                                                |

### 2.2 Routes et navigation

- `DashboardRoute` (`dashboard-view.ts:68-99`) : incidents = `{ view: 'incidents'; projectId; create? }`
  et `{ view: 'incident'; projectId; incidentId; tab?: IncidentTab }` (`:89-91`).
- `NAV` (`:217-234`) : sections `pilot`, `incidents` (entrée `incidents`), `requirements`, `measure`,
  `admin` ; `activeNav` (`:240-261`).
- `navigate()` (`dashboard.ts:1540-1585`) remet à zéro des morceaux d'état, émet
  `qa-dashboard-navigate { route }` puis recharge. **Aucune synchronisation avec l'URL** (pas de
  `location.hash`, pas de `history.pushState`) : un lien profond passe par `open(route)` (`:311`)
  appelé par l'hôte.

### 2.3 Icônes et pièces (`src/sdk/ui/dashboard-parts.ts`)

`TONE` + `pill(raw, text)` (`:9-39`), `ICONS` (`:41-95` : overview, projects, executions, back, play,
stop, pause, undo, refresh, alert, menu, close, plus, edit, check, history, requirements, traceability,
sources, indicators, trends, recordings, access, download, library, editor, tests, scenarios,
explorations, environments, cross, search, info, up, down, right, copy, trash, grip, data, save, code,
sliders, maximize, minimize, eye), `icon(name)` (`:97`, SVG 24×24 `class="ico"`), `formatTime` (`:101`),
`formatDate` (`:107`), `header(title, { sub, actions, back })` (`:117`), `executionTable` (`:127`).
Icône du menu Incidents : `incidentIcon()` (`dashboard-incidents.ts:363`).

### 2.4 i18n (`src/sdk/ui/dashboard-i18n.ts`, 4 892 lignes)

Deux objets `fr` (`:2`) et `en` (`:2530`) ; `DashboardStrings = typeof fr` (`:2528`) : l'anglais est
vérifié par le compilateur. Section incidents : `fr.inc` (`:1908`), `en.inc` (`:4309`).
`dashboardStrings(locale)` (`:4890`). Vocabulaire déjà employé pour les critères d'affichage de la
console : « Critères d'affichage du journal », « Critères », « Tout afficher » (`:1785-1797`).

### 2.5 Styles, jetons, thème sombre, points de rupture

- `DASHBOARD_CSS` (`dashboard-styles.ts:10`) ; jetons `--qa-color-*` (`:11-23` : primary, primary-2,
  background, surface, surface-2, text, muted, faint, border, border-strong, panel, panel-2, success,
  warning, danger et leurs `-soft`), `--qa-radius`, `--qa-font-family(-mono)` (IBM Plex) ;
  `container-type:inline-size` sur `:host`.
- Thème sombre : `darkThemeCss()` (`src/sdk/ui/theme.ts`) ajouté en fin de feuille (`:1205`).
  `:host([theme="dark"])` et `:host([theme="auto"])` sous `@media (prefers-color-scheme:dark)` ne
  changent que les jetons (plus `--qa-color-data`, `color-scheme:dark`). La page passe
  `?theme=dark|auto` en attribut (`page.ts:157-160`) ; le fond de la page suit seulement
  `prefers-color-scheme` (`page.ts:149`).
- Points de rupture par **requêtes de conteneur** : `1100px` (indicateurs), `960px` (menu replié,
  `:703-710`), `600px` (une colonne) ; d'autres locaux (`900`, `820`, `560`, `520`, `1240px`) ;
  `@media (pointer:coarse)` (`:340`), `@media (prefers-reduced-motion:reduce)` (`:113`).
- Styles incidents : `:1141-1204` (graphe `.inc-graph`, `.gn`, `.edge.e-obs|e-stat|e-inf|e-unk`,
  marqueurs `.mk`, `.inc-timeline`, `.inc-pre`…).

### 2.6 Classes et aides réutilisables

| Usage à l'écran            | Existant                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut                     | `tag(raw, text)` local aux incidents (`dashboard-incidents.ts:409`, tons `TONES` `:368-407`), `pill()` commun                                        |
| Bouton d'opération         | `actionButton(ui, action, text, opts)` (`dashboard-incidents.ts:445`) : masqué sans droit par l'appelant, désactivé pendant `ui.busy`, `aria-busy`   |
| Tableaux                   | `.tw` (défilement, `:137`) + `.tbl` (`:139-141`), `caption.sr` pour l'accessibilité                                                                  |
| Cartes et grilles          | `.card`, `.card-h`, `.wide`, `.split` / `.col`, `.tiles` / `.tile(.ko/.ok)`, `.kpis`                                                                 |
| Messages                   | `.note` (+ `.warn`), `.err`, `.err-box`, zone `aria-live` `messages()` (`dashboard-incidents.ts:424`)                                                |
| Confirmation dans la page  | `.confirm` `role="group"` (annulation : `dashboard-incidents.ts:579`), approbation d'effets de bord `.inc-approve`                                   |
| Onglets                    | `.tabs` + `role="tablist"`, `tabindex` itinérant, flèches / Début / Fin (`dashboard-incidents-controller.ts:841-875`)                                |
| Listes                     | `.steps` (étapes numérotées), `.checks`, `.plain.tight`, `dl.inc-dl`                                                                                 |
| Journal à critères         | console de l'éditeur : `ConsoleFilters` + `matches()` (`dashboard-console.ts:34`, `:123`), barre `filterBar` (`:378`), « plus de critères » (`:367`) |
| Panneaux redimensionnables | éditeur : explorateur / inspecteur et poignée (`dashboard-editor-controller.ts`, `pointerDown`)                                                      |

## 3. Composants SVG existants (graphes, zoom, déplacement)

| Composant                     | Où                                                                                              | Interaction                                                                                                                                                                                                                                    | Réutilisable pour le graphe full-stack                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Graphe d'investigation actuel | `dashboard-incidents.ts:921-1095` (`columnOf`, `graphLayout`, `graphSvg`, `legend`, `graphTab`) | **aucune** : SVG statique dans `.inc-graph` (défilement natif), nœuds `<g>` avec `<title>`, non focalisables ni cliquables ; table des relations en alternative                                                                                | base de disposition par colonnes (7) et classes d'arêtes par statut ; disposition naïve (rang = ordre)        |
| Flow Studio                   | `src/sdk/ui/studio.ts`, `studio-layout.ts`                                                      | zoom molette (`studio.ts:678`), boutons `zoom-in/out/fit` (`:740-747`), déplacement par glisser (`:113-130`, `:589-651`), clavier `+ - 0` et flèches (`:899-925`), `paintParts()` partiel (`:304`), `applyViewport()` par `transform` (`:338`) | **réutilisable** : `Viewport`, `clampZoom`, `fitView`, `zoomAt`, `centerOn` purs (`studio-layout.ts:245-282`) |
| Carte du wizard               | `layoutMap` (`src/sdk/ui/view.ts:618`)                                                          | aucune                                                                                                                                                                                                                                         | algorithme de couches simple                                                                                  |
| Carte des flows du rapport    | `src/reporting/flow-diagram.ts` (`FLOW_MAP_SCRIPT`, `:384`)                                     | zoom, ajustement, sélection, mise en avant par statut                                                                                                                                                                                          | **non importable** (`src/reporting`, script en chaîne pour la page de rapport) : modèle d'interaction seul    |
| Carte des explorations        | `dashboard-ops.ts:333-360`                                                                      | cartes HTML, pas de SVG                                                                                                                                                                                                                        | non                                                                                                           |

## 4. Kit d'éditeur CodeMirror

- Entrée : `src/sdk/ui/editor-kit.ts` ; regroupement esbuild `scripts/editor-kit-bundle.mjs`
  (ESM, navigateur, ES2022, minifié, licences listées) appelé par `scripts/bundle-editor.mjs` au build
  (`npm run build` → `packages/core/dist/sdk/ui/editor-kit.js`) ou à la demande par le serveur en
  développement (`server.ts:4090`).
- Chargement : `import('./editor-kit.js')` dans `EditorController.ensureKit()`
  (`dashboard-editor-controller.ts:162-176`), état `ui.kit = 'loading' | 'ready' | 'error'`.
- Langages (`editor-kit.ts:187-201`) : `yaml` (`@codemirror/lang-yaml`), `gherkin` et `xml` (legacy
  modes), `typescript` = `javascript({ typescript: true })` **sans `jsx`**, `java`
  (`@codemirror/lang-java`), `text`. Choix par extension : `languageOf(path)` (`dashboard-editor.ts:134`)
  ne connaît que `.yml/.yaml`, `.feature`, `.ts`, `.java`, `.xml` (ni `.tsx`, `.js`, `.jsx`, `.vue`,
  `.properties`).
- Lecture seule : `createCodeEditor({ readOnly })` (`:242`, compartiment `EditorState.readOnly` +
  `EditorView.editable`), `setReadOnly()` (`:321`) ; `createDiff` est toujours en lecture seule
  (`:346`).
- Socle (`base`, `:204-219`) : numéros de ligne, gouttière active, repli, correspondance des
  parenthèses, ligne active, retour à la ligne, surlignage des occurrences, coloration aux jetons du
  Dashboard (`highlight`, `:72` ; `theme`, `:98`, donc thème sombre automatique), phrases françaises.
- Mise en évidence de lignes **existante** : seulement `setDiagnostics()` (`:299`, soulignement
  ondulé du lint) et `goTo(line, column)` (`:316`, sélection + défilement centré + focus). **Aucune
  décoration de ligne** (`Decoration.line`, `StateField`) n'existe. Navigation dans un fichier de
  code : `codeOutline()` (`src/sdk/editor/code-outline.ts`, tests Playwright / JUnit seulement).
- Garde du focus : `editorHadFocus` et `pendingGoTo` (`dashboard-editor-controller.ts:53`, `:1345-1348`).

## 5. Preuves Playwright disponibles par run

Modèle : `FlowRunReport` / `FlowStepReport` (`src/model/flow-run.ts:22-82`, `:211-238`),
`ExplorationResult` (`src/model/exploration-result.ts:74`), `Issue` (`src/model/issue.ts:65-96`),
`StepRequestReport` (`flow-run.ts:84-98`). Une reproduction d'incident active
`network.captureBodies` et `browser.playwrightTrace` (`server.ts:3369-3370`).

### 5.1 Capturé

| Donnée                      | Source                                                                                                                                                       | Remarque                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Étape                       | `index`, `kind`, `description` (cible décrite : « click button "Enregistrer" »), `status`, `reason`, `url`, `durationMs`, `screenshot`                       | `FlowStepReport` ; plus riche dans `result.json` : `effect.locator`, `effect.targetMatch`, `resolution`, `cssResolution`, `timing` (`actionMs`, `transitionMs`…), `synchronization`, `onScreen`   |
| Requêtes de l'étape         | `method`, `path` (sans hôte ni requête), `status`, `durationMs`, `failure`, `resourceType`                                                                   | types `document`, `xhr`, `fetch` (`config.ts:1270`), 50 au plus par action (`:1271`)                                                                                                              |
| Avec `captureBodies`        | `startedAt` (ISO) de chaque échange ; `requestBody` (écritures xhr/fetch, et toute requête dont la réponse est ≥ 400) ; `responseBody` (≥ 400 ou écritures)  | `network-trace-recorder.ts:111-167` ; JSON / texte seulement (`isTextualContentType`, `:46`), clés sensibles masquées (`SENSITIVE_BODY_KEY`, `:41`), tronqué à 8 Kio (`MAX_CAPTURED_BODY`, `:38`) |
| Anomalies                   | `Issue` : `timestamp`, `type`, `message`, `pageUrl`, `requestUrl`, `method`, `status`, `details.source` (url, ligne, colonne), `details.stack`, `screenshot` | id séquentiel par run `ISSUE-0001` (`src/anomaly/issue-collector.ts:41`)                                                                                                                          |
| Trace Playwright            | `<run>/trace.zip` (`browser-manager.ts:58-61`, `:95-103`, `flow-explorer.ts:1322`)                                                                           | captures + instantanés DOM ; non servie par le serveur (pas de type `.zip`)                                                                                                                       |
| Fenêtre réseau d'une action | `FlowEdge.networkWindow { startedAt, finishedAt }` (`src/model/flow.ts:63`, `flow-explorer.ts:2288-2297`)                                                    | sur les **transitions** de l'exploration, pas sur `FlowStepReport`                                                                                                                                |

### 5.2 Non capturé

| Donnée                                     | Constat                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Heure de début d'une étape                 | absente de `FlowStepReport` ; `evidence.ts:73-85` (`stepWindows`) l'**estime** depuis `flow.startedAt` + durées cumulées, corrigée par le `startedAt` des requêtes                         |
| En-têtes HTTP                              | jamais gardés (`src/model/network.ts:1-7`) ; seul `content-type` est lu en interne pour décider de garder un corps (`network-trace-recorder.ts:145`, `:155`)                               |
| URL complète, hôte, requête                | `StepRequestReport.path` seulement ; `HttpExchange.url` d'une requête d'étape **vaut le chemin** (`evidence.ts:171`) ; seule une requête issue d'une anomalie garde l'URL masquée (`:254`) |
| Corps des GET réussis, binaires, multipart | jamais gardés                                                                                                                                                                              |
| Élément DOM ciblé                          | ni balise, ni attributs, ni `outerHTML`, ni boîte : seulement la description et, dans `result.json`, le localisateur utilisé ; les instantanés DOM ne sont que dans `trace.zip`            |
| Identifiant de corrélation                 | aucun `traceparent` / `X-Request-Id` : aucun lien observé BFF → backend                                                                                                                    |
| Texte d'erreur affiché                     | seulement indirect : `reason` d'un `expect` échoué, anomalies `UI_ERROR` / `CONSOLE`, corps de réponse                                                                                     |

## 6. Bibliothèque de scénarios et flows

- `listScenarios(projectDir)` (`src/sdk/server/platform.ts:227`) : un scénario par flow YAML nommé
  (`flows:` ou document à `steps:`), un par `.feature` ; ignore `*test-data*` ; `ScenarioView`
  (`contracts.ts:1388-1404` : `name`, `file`, `format`, `steps`, `reusable`, `uses`, `revision`).
- Dossier : `flowsDirOf` (`platform.ts:221`, `paths.flows` de `qa-crawler.config.yaml`).
- Client : `client.scenarios.list(projectId)` (`client.ts:816`) ; le Dashboard reçoit aussi
  `project.scenarios` (`ProjectDetail`). Le formulaire d'incident propose les scénarios non
  réutilisables (`incidentScenarios`, `dashboard-incidents.ts:188`).
- Lecture du texte d'un scénario : **interne** seulement (`IncidentHost.scenarioYaml`,
  `server.ts:3323-3330`) ; aucune route ne renvoie le YAML d'un scénario au navigateur.
- Le test de non-régression accepté est écrit sous `incidents/<nom>/<nom>.flow.yaml`
  (`server.ts:3331-3348`, `flag: 'wx'`).

## 7. Module incident existant

### 7.1 Contrats (`src/sdk/core/incident-contracts.ts`)

Énumérations : `SCOPE_MODES` (`:15`), `EXECUTION_TARGETS` LOCAL/REMOTE/ARO (`:19`), `INCIDENT_STATES`
(`:22`), `RELATION_STATUSES` (`:39`), `LAYERS` (`:52`), `EVIDENCE_KINDS` (`:215`), `CODE_SYMBOL_KINDS`
(`:306`), `GRAPH_NODE_KINDS` (`:394`), `EXPERIMENT_KINDS` (`:438`). Structures : `Evidence` (`:231`),
`HttpExchange` (`:247`), `ActionEvidence` (`:267`), `ReproductionRun` (`:280`), `CodeSymbol` (`:329`),
`CodeIndex` (`:380`), `GraphNode` / `GraphEdge` (`:410-434`), `Hypothesis` (`:456`), `Experiment`
(`:483`), `Diagnosis` (`:502`), `RegressionTestProposal` (`:512`), `Incident` (`:577`),
`InvestigationReport` (`:614`, chronologie `:625`). Exportés en types par `src/sdk/core/index.ts`.

### 7.2 Service, routes, droits

- `IncidentService` (`src/incident/service.ts:84`) : `incident`, `list`, `create`, `update`
  (révision), `validateScope`, `requestExtension`, `decideExtension`, `capabilities`, `reproduce`
  (`:181`, arrière-plan), `analyze` (`:305` : index, graphe, hypothèses), `planExperiment`,
  `runExperiment` (`:372`), `diagnose` (`:490`), `report` / `reportMarkdown`, `proposeRegression`,
  `runRegression`, `acceptRegression`, `rejectRegression`, `cancel`, `resume`.
- Stockage : un JSON par incident `<projet>/incidents/<id>.json` (`incident-store.ts:21`, `:291`),
  id `inc_` + 12 caractères (`:238-241`), transitions `INCIDENT_TRANSITIONS` (`:60-71`).
- Routes `handleIncidentRoutes` (`src/sdk/server/incidents.ts:38-193`) : `GET` liste, incident,
  `capabilities`, `report?format=json|markdown` ; `POST` `update`, `scope/validate`,
  `scope/extensions[/:id/decision]`, `reproduce`, `analyze`, `experiments[/:id/run]`, `diagnose`,
  `regression[/run|accept|reject]`, `cancel`, `resume`. Branchement `server.ts:3154-3184`.
- Droits (`src/sdk/server/access.ts`) : **tout `GET` = `VIEW`** (`:243`, avant le cas incidents) ;
  `incidentRight` (`:299-305`) : `DECIDE` pour décider une extension ou rejeter le test, `PUBLISH` pour
  l'accepter, `RUN` sinon ; `RUN_WRITES` en plus pour jouer l'application sur un environnement qui
  permet les écritures (`server.ts:3162-3172`) et pour approuver une vérification à effets de bord
  (`incidents.ts:160-165`). Mots de journal : `KEYWORDS` (`access.ts:307`).

### 7.3 Index de code (`src/incident/code/*`)

`analyzeCode(scope, files)` (`code/index.ts:28`) : chaque application du périmètre, fichiers listés et
lus par `GuardedFiles` (`src/incident/guarded-fs.ts:35`, passage par le Scope Policy Engine, budgets
`maxFiles` / `maxFileBytes`) ; frontend `.ts .tsx .js .jsx .vue`, Java `.java` + configuration Spring ;
`resolveCalls` (`code/resolve.ts:14`) relie les appels aux imports ; endpoints ciblés marqués
`detail.targeted`.

Symboles frontend (`code/frontend.ts`, AST du compilateur TypeScript, jamais exécuté) :

| Symbole                        | Identification                                                                                                                                   | Clés `detail`                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPONENT`                    | fonction qui rend du JSX, classe React, `@Component` Angular, `defineComponent` / SFC Vue                                                        | `framework`, `exported`, `exportDefault`, `declaration`, `decorators`, `extends`, `selector`, `fields`, `imports`, `handlers`                                                           |
| `EVENT_HANDLER`                | prop JSX `onX={…}` (`visitJsxHandler`, `:596`), méthodes `on*` / `handle*`, gestionnaire inline qui appelle du code connu (`Composant.tag.prop`) | **`triggers`** : libellé `<form onSubmit> « Enregistrer »` (`triggerLabel`, `:643` : texte des boutons `submit` d'un formulaire, sinon texte de l'élément), `inline`, `async`, `params` |
| `FUNCTION`, `HTTP_CLIENT_CALL` | fonctions métier ; devient `HTTP_CLIENT_CALL` quand elle contient `fetch` / axios / HttpClient (`onCall`, `:696-712`)                            | `http` (`MÉTHODE chemin`), `throws`, `imports`                                                                                                                                          |
| `VALIDATION`                   | `validate*`, `isValid*`, schémas zod / yup                                                                                                       | `checks`, `messages`, `schema`, `fields`, `validations`, `requiredFields`, `optionalFields`                                                                                             |
| `PAYLOAD_TRANSFORM`            | `to*Payload`, `map*`, `serialize*`, `build*Request`                                                                                              | `fields`, `conditionalFields`                                                                                                                                                           |
| `ERROR_HANDLER`                | `catch` / `.catch(` (`errorHandler`, `:567`), nom `Parent.catch`                                                                                 | `calls` (ex. `setMessage`), `messages`, `rethrows`, `style`                                                                                                                             |

Relations : `CodeCall { from, to?, text, status, file, line }` (handler → service, résolues
`STATICALLY_RESOLVED` / `INFERRED` par `resolveCalls`) et `OutgoingHttpCall { symbolId, method, path,
status }` (littéral : `STATICALLY_RESOLVED`, base constante : `INFERRED`, dynamique : `UNKNOWN`).
Identifiant stable : `${applicationId}:${file}#${nom}` (ex.
`web:frontend/src/books/BookForm.tsx#BookForm.onSave`). Une seule ligne par symbole : **ni ligne de
fin, ni colonne**. Java (`code/java.ts`, analyseur maison) : controllers, endpoints (`requestBody`,
`pathVariables`, `responseStatus`…), DTO, services, mappers, clients HTTP (`httpClient`, `feignName`),
dépôts (`sql`, `nativeQuery`, `modifying`), transactions, exceptions et handlers (`handles`).

### 7.4 Corrélateur (`src/incident/correlator.ts`)

`buildGraph` (`:290-475`) sur **la** reproduction de l'incident et l'index :

| Nœud                               | Identifiant                                                     | Ligne                  |
| ---------------------------------- | --------------------------------------------------------------- | ---------------------- |
| `INCIDENT`                         | `incident:<incidentId>`                                         | `:302`                 |
| `SCENARIO`                         | `scenario:<nom>`                                                | `:313`                 |
| `ACTION`                           | `action:<rep_N>:<index>`                                        | `:340`                 |
| `REQUEST`                          | `request:<rep_N>:req-<étape>-<rang>` (ou `req-x-<n>`)           | `:363`                 |
| `FRONTEND_CODE`                    | `code:<symbolId>` du symbole qui émet l'appel HTTP              | `:406`                 |
| `BFF_*`, `BACKEND_*`, `REPOSITORY` | `code:<symbolId>` (`nodeKindOf`, `:231`)                        | `:277-288`             |
| `BACKEND_CALL`                     | `outgoing:<symbolId>:<ligne>`                                   | `:571`                 |
| `EXCEPTION`                        | `exception:code:<id>` ou `exception:observed:<requestId>:<nom>` | `:521`, `:669`         |
| manquant                           | `unknown:<…>` (étiquette `? …`)                                 | `:428`, `:457`, `:596` |

Arêtes : scénario → action (`OBSERVED`), action → requête (corrélation de la requête), code frontend →
requête (au mieux `STATICALLY_RESOLVED`, `:396-425`), requête → endpoint (`matchEndpoint`), puis
`walk` (`:500-557`) : appels de méthode bornés par `scope.depth`, appels sortants → endpoint suivant,
exceptions ; exceptions nommées par un corps de réponse (`OBSERVED`) et déréférencements
(`INFERRED`). **Absent** : aucune arête action → `EVENT_HANDLER` / `COMPONENT` ; `triggers`,
`COMPONENT` et `EVENT_HANDLER` ne sont lus nulle part dans `src/incident/*.ts` ; les appels frontend
(handler → service) ne sont pas parcourus. Le graphe n'a ni positions ni groupes.

### 7.5 Identifiants des preuves (`src/incident/evidence.ts`)

| Objet        | Format                                                                                                                                   | Stabilité / unicité                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduction | `rep_<N>` avec N = nombre de reproductions + 1 (`service.ts:210`, `:469`)                                                                | unique dans un incident **en séquence** ; calculé depuis la longueur : un rejeu de vérification et une reproduction concurrents peuvent prendre le même N ; `rep_1` existe dans chaque incident |
| Requête      | `<rep>:req-<étape>-<rang>` (`:166`), `<rep>:req-x-<n>` (`:252`)                                                                          | stable pour une reproduction donnée ; change d'une reproduction à l'autre                                                                                                                       |
| Preuve       | `<rep>:ev-action-<i>`, `ev-assertion-<i>`, `ev-page-<n>`, `ev-screenshot-<i>`, `ev-trace` (`:157`), `<rep>:ev-issue-ISSUE-0001` (`:304`) | idem                                                                                                                                                                                            |
| Vérification | `exp_<horodatage base36><aléa>` (`experiments.ts:64`), preuves `<exp>:ev<n>` (`:285`)                                                    | unique                                                                                                                                                                                          |
| Hypothèse    | `hyp-<règle>` (`hypotheses.ts:224`)                                                                                                      | stable d'une analyse à l'autre (une par règle)                                                                                                                                                  |
| Extension    | `ext_<aléa>` (`scope.ts:315`)                                                                                                            | unique                                                                                                                                                                                          |

La reproduction de référence est `incidentReproduction()` (`evidence.ts:413-421`) : dernier run
`COMPLETED` du scénario de l'incident. L'écran Reproduction affiche, lui, `reproductions.at(-1)`
(`dashboard-incidents.ts:359`, `:830`), qui peut être un rejeu de vérification d'un autre scénario.

### 7.6 Chronologie du rapport (`src/incident/report.ts`)

`timelineOf` (`:22-73`) : actions (heure estimée), requêtes (`startedAt` si capturé), preuves non
`ACTION` ; tri par heure, sinon heure de l'étape, puis étape, sorte, ordre d'origine. Entrée :
`{ at?, step?, kind, summary, ref }`. Construite seulement pour la reproduction de référence, dans
`buildReport` (`:182`) ; ni historique (`incident.history`), ni vérifications, ni décisions de
périmètre. `limitationsOf` (`:75-136`) dit ce qui manque.

### 7.7 Interface actuelle

- Onglets `INCIDENT_TABS` (`dashboard-incidents.ts:44-56`) : scope, environment, reproduction,
  timeline, graph, code, hypotheses, experiments, diagnosis, report, regression ; page
  `incidentView` (`:564-603`).
- Graphe (`:921-1095`) : 7 colonnes fixes (`NODE_W` 156, `COL_W` 196, `ROW_H` 56), bandes Incident /
  Frontend / BFF / Backend, arêtes par statut, `role="img"` + `figcaption` ; aucune sélection,
  aucun zoom, aucun lien vers le code.
- Code (`codeTab`, `:1105`) : tableaux de symboles par couche (200 au plus), endpoints, appels
  sortants, refus ; **aucun contenu de fichier**.
- Reproduction (`:825`) : actions, tableau des requêtes avec corps de réponse en `<details>`, preuves,
  chemins de captures en texte. Chronologie (`:894`) : `report.timeline` + historique.
- Contrôleur (`dashboard-incidents-controller.ts`) : `load` / `loadTab` (`:140-192`, rapport chargé
  pour Chronologie et Rapport), `receive` (`:194`), `poll` (`:208`), `op` (une opération à la fois,
  409 relu), `selectTab` (`:380`), `click` (`:403-692`), `submit`, `input`, `change`, `keydown`. Pas
  de `beforePaint` / `afterPaint` : rien ne survit au redessin.
- Droits à l'écran : boutons masqués sans `RUN` / `DECIDE` / `PUBLISH` / `RUN_WRITES` ; mention
  « Lecture seule » pour un lecteur (`:476`, `:600`).

## 8. Environnements

| Notion                               | Où                                                                                                                                            | Contenu                                                                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Environnement cible du projet (SDK)  | `EnvironmentInput` / `Environment` (`contracts.ts:1356-1376`), `ENVIRONMENT_KINDS` DEVELOPMENT / TEST / CERTIFICATION / PREPRODUCTION / OTHER | URL de base, domaines permis, variables, `secretEnv`, limites, écritures ; choisi par `incident.environmentId` (défaut : le premier, `server.ts:3312-3322`)                                                                          |
| Cible d'exécution de l'investigation | `ExecutionEnvironmentConfig` (`incident-contracts.ts:187-200`), `EnvironmentCapabilities` (`:202-211`)                                        | où tournent QA-CRAWLER et Playwright : LOCAL (défaut), REMOTE (`remote.openshift`), ARO (`aro.namespace`, `serviceAccount`, `image`, `repositoriesMount`)                                                                            |
| Adaptateur                           | `src/incident/environments.ts:293-462`, `environmentAdapter` (`:465`)                                                                         | `capabilities()` sonde le PATH (mvn, gradle, npm, oc), le pod, le montage (`:321-378`) ; `files()` (`:381`) monte les chemins sous `repositoriesMount` en ARO (`mountedFiles`, `:268`) ; `runTest`, `readLogs` (fichiers, `oc logs`) |

Constats : la cible est choisie à la déclaration (`createForm`, `dashboard-incidents.ts:552`) et
affichée en lecture seule (`environmentTab`, `:792`) ; le serveur accepte pourtant `execution` dans
`update` (`incident-store.ts:406-408`). Le rejeu passe toujours par `launchReplay` dans le programme du
serveur (`server.ts:3258`) : ARO décrit où ce serveur est déployé, il ne déporte rien.
`investigationJobManifest` (`environments.ts:482`) est exporté mais appelé nulle part. Les capacités
ne se lisent que pour la cible enregistrée (pas de sondage d'une cible candidate).

## 9. Tests et conventions

| Sujet                    | Constat                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests unitaires de rendu | `tests/unit/sdk-dashboard*.test.ts` (Node, sans DOM) : état construit à la main (`base(route, inc, extra)`, `sdk-dashboard-incidents.test.ts:268`), `renderDashboard(state)` comparé par chaînes ; contrôleur avec hôte factice (`setup`, `:938`) et `vi.useFakeTimers()` ; client par `fetch` simulé                                                    |
| Tests Chromium           | `tests/integration/sdk-dashboard*.test.ts` : `startSdkServer`, `createQaCrawler`, `chromium.launch()`, `page.goto(server.url + '/dashboard')`, `page.locator('qa-crawler-dashboard')` (Playwright traverse le Shadow DOM) ; incidents dans Chromium : `incident-reconstruction.test.ts:268-294`                                                          |
| Lancer l'intégration     | `PLAYWRIGHT_BROWSERS_PATH=<dossier des navigateurs> npx vitest run --project integration <fichier>` (Chromium 1194 présent) ; délais 120 s / 240 s (`vitest.config.ts`)                                                                                                                                                                                  |
| Commandes                | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`), `npm run lint` (`eslint .`), `npm run format:check` / `npm run format` (Prettier : `singleQuote`, `trailingComma: all`, `printWidth: 110`), `npm test` (unit), `npm run test:integration`, `npm run build` (avec le kit regroupé)                                                                 |
| CHANGELOG                | `## Unreleased` puis `### Sécurité`, `### Ajouté`, `### Modifié`, `### Corrigé` ; entrée en français, nom en gras, document cité, sous-puces (`CHANGELOG.md:5-60`)                                                                                                                                                                                       |
| Vocabulaire              | une liste de mots français est proscrite dans le code et la documentation (voir la consigne du projet) ; préférer « nécessaire », « mettre en œuvre », « critères d'affichage », « positions ». Aucun outil ne le vérifie ; le module incident actuel est conforme. Libellés de remplacement déjà en usage : « Critères d'affichage », « Tout afficher » |
| Contrat public           | `tests/unit/sdk-contract.test.ts` : exports et espaces de noms du client conservés (ajouts permis) ; `SDK_API_VERSION` = 1                                                                                                                                                                                                                               |

## 10. Écarts et recommandations

### 10.1 Écarts

| #   | Écart                                      | Constat                                                                                                                                        | Recommandation                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lecture d'un fichier source                | aucune route ; `GuardedFiles.readText` (`guarded-fs.ts:49`) et `adapter.files(policy)` existent côté serveur                                   | `GET /api/projects/:p/incidents/:id/source?application=<id>&file=<relatif>` → `IncidentService.source()` : application du périmètre, chemin résolu sous sa racine, `readText` (Scope Policy, `maxFileBytes`), texte masqué par `redactText` (une configuration Spring est lisible et peut contenir des mots de passe), langage, nombre de lignes, empreinte ; client `incidents.source()`            |
| 2   | Droit de lecture du code                   | tout `GET` = `VIEW` (`access.ts:243`)                                                                                                          | décider explicitement : `VIEW` (lecteur voit le code du périmètre) ou `RUN` ; ajouter le mot de route à `KEYWORDS`                                                                                                                                                                                                                                                                                   |
| 3   | Trace frontend étape → composant → handler | aucune arête action → `EVENT_HANDLER` ; `detail.triggers` inutilisé ; appels frontend non parcourus                                            | dans `correlator.ts` : rapprocher la description de l'étape (rôle + nom accessible) du libellé `triggers` (`INFERRED`, raison écrite), relier composant → handler (`parent`), handler → service (`code.calls`), service → requête (existant), requête → `ERROR_HANDLER` du même handler (`INFERRED`) ; nouveaux genres de nœuds (`FRONTEND_COMPONENT`, `FRONTEND_HANDLER`) ou `GraphNode.symbolKind` |
| 4   | Erreur affichée                            | pas de texte d'écran capturé                                                                                                                   | relier `ERROR_HANDLER.detail.messages` / `HTTP_CLIENT_CALL.detail.throws` aux preuves `UI_ERROR`, `ASSERTION` (raison) ; à terme, capturer le texte d'un `role="alert"` après l'étape (moteur)                                                                                                                                                                                                       |
| 5   | Chronologie unifiée                        | `report.timeline` = dernière reproduction ; heures d'action estimées ; historique à part                                                       | contrat `InvestigationTimelineEvent { id, at?, atEstimated, source: reproduction / experiment / history, kind, layer, step?, severity, relation?, refs: { evidence[], graphNodes[], symbols[] } }`, construit côté serveur (`report.ts`) ou par une fonction pure dans `src/sdk/ui` ; critères d'affichage sur le modèle de `ConsoleFilters`                                                         |
| 6   | Heure réelle de début d'étape              | non enregistrée (`evidence.ts:73`)                                                                                                             | ajouter `startedAt` à `FlowStepReport` dans `flow-explorer.ts` (ou reprendre `networkWindow`) ; marquer `atEstimated` tant que l'ancien format est lu                                                                                                                                                                                                                                                |
| 7   | Vue des requêtes                           | ni hôte, ni requête, ni en-têtes ; `url` = chemin                                                                                              | moteur : liste blanche d'en-têtes (`content-type`, `accept`, `content-length`, `location`, `x-request-id`, `traceparent`…) sous `captureBodies`, valeurs masquées ; garder l'origine (hôte) masquée ; contrat `HttpExchange.requestHeaders` / `responseHeaders` / `origin` ; jamais `authorization`, `cookie`, `set-cookie`                                                                          |
| 8   | Sélection synchronisée et liens            | aucune sélection dans l'état ; route sans sélection ; pas de synchro URL                                                                       | `IncidentsUi.selection { kind: 'node' / 'request' / 'evidence' / 'symbol' / 'event', id }` partagée par les panneaux ; route `{ view: 'incident', tab: 'workspace', select? }` émise par `qa-dashboard-navigate` ; référence complète `incidentId` + `rep_N` + id (les ids ne sont uniques que dans un incident)                                                                                     |
| 9   | Graphe interactif                          | SVG statique, disposition naïve, redessiné en entier toutes les 1,5 s pendant un suivi                                                         | réutiliser `fitView` / `zoomAt` / `centerOn` (`studio-layout.ts`), viewport dans l'état, `transform` posé après dessin ; contrôleur avec `beforePaint` / `afterPaint` branchés dans `paint()` (`dashboard.ts:2961`) ; nœuds focalisables (`<g tabindex="0" role="button" aria-pressed>`), flèches entre voisins, table des relations conservée comme alternative                                     |
| 10  | Explorateur de code                        | lecture seule et `goTo` existent ; pas de décoration de lignes ; `.tsx`, `.js`, `.vue`, `.properties` non reconnus ; symbole sans ligne de fin | `editor-kit.ts` : `highlightLines(ranges)` par `StateField` + `Decoration.line`, `javascript({ typescript: true, jsx: true })`, `properties` (legacy modes) ; navigation par symbole depuis `CodeIndex` (`symbols`, `calls.to`) ; ajouter `endLine` à `CodeSymbol` (le parseur TypeScript la connaît)                                                                                                |
| 11  | Fichiers d'une hypothèse                   | `Hypothesis.files`, `Diagnosis.rootCause.files` : chemins relatifs sans application                                                            | ajouter `applicationId` (ou `symbolId`) pour ouvrir le bon dépôt                                                                                                                                                                                                                                                                                                                                     |
| 12  | Captures et trace                          | CSP `img-src data:` ; `.zip` non servi ; chemins de captures affichés en texte                                                                 | route qui renvoie une capture de la reproduction en `data:` (taille bornée), ou lien à ticket ; trace : téléchargement (lien à ticket avec type `application/zip`)                                                                                                                                                                                                                                   |
| 13  | Choix LOCAL / REMOTE / ARO                 | choisi à la création seulement ; capacités de la seule cible enregistrée                                                                       | sélecteur dans le Workspace via `update(revision, { execution })` ; `GET …/capabilities?target=` pour sonder une cible candidate                                                                                                                                                                                                                                                                     |
| 14  | Cohérence de la reproduction affichée      | écran : `reproductions.at(-1)` ; serveur : `incidentReproduction()`                                                                            | une seule règle (exporter un équivalent pur dans `src/sdk/ui` ou renvoyer `referenceReproductionId` dans l'incident)                                                                                                                                                                                                                                                                                 |
| 15  | Unicité de `rep_N`                         | calculé depuis la longueur, sans exclusion                                                                                                     | id aléatoire ou compteur persistant, ou refuser une reproduction pendant un rejeu de vérification                                                                                                                                                                                                                                                                                                    |
| 16  | Contenu du scénario                        | aucune route publique pour le YAML                                                                                                             | exposer le texte (ou les étapes) du scénario de l'incident pour relier étape et ligne YAML                                                                                                                                                                                                                                                                                                           |

### 10.2 Risques

- **Redessin complet** : chaque `paint()` réécrit le Shadow DOM ; viewport, défilement du code,
  sélection et éditeur CodeMirror doivent vivre dans l'état ou dans des nœuds remontés après dessin,
  sinon ils sautent à chaque relecture (1,5 s pendant une reproduction).
- **Poids des relectures** : `GET` incident renvoie l'index de code complet et toutes les
  reproductions (corps compris) à chaque relecture ; prévoir une relecture légère (révision seule) ou
  un incident sans `code` pendant le suivi.
- **Taille des fichiers** : `dashboard.ts` (3 000 lignes), `dashboard-i18n.ts` (4 892),
  `dashboard-incidents.ts` (1 370) ; le Workspace gagne à vivre dans de nouveaux fichiers à plat
  (`dashboard-workspace.ts`, `-graph.ts`, `-timeline.ts`, `-code.ts`, `-controller.ts`) et une section
  `inc.ws` des deux langues.
- **Sous-dossiers interdits** côté navigateur (`serveModule`) et imports limités à `core` / `ui`
  (`sdk-contract.test.ts`) : aucun import de `src/incident` ni de `src/reporting` dans le Workspace.
- **Honnêteté des relations** : toute relation nouvelle (étape → handler, réponse → erreur affichée)
  est `INFERRED` ou `STATICALLY_RESOLVED`, jamais `OBSERVED` ; une heure estimée doit le dire.
- **Données sensibles** : code source et configuration affichés, en-têtes nouvellement gardés, corps
  de requêtes : tout passe par le masquage serveur ; rien n'est reconstitué dans le navigateur.
- **Kit de l'éditeur** : une modification de `editor-kit.ts` exige le regroupement (`npm run build`)
  et le redémarrage du serveur en développement (cache `MODULE_CACHE`).
- **Thème et contraste** : les arêtes utilisent `primary` / `success` / `warning` / `danger` ;
  vérifier le contraste des traits pointillés en sombre et ne pas porter le statut par la seule
  couleur (motif de trait déjà distinct : plein, tirets, pointillés).
- **Vocabulaire** : libellés de critères d'affichage sans les mots proscrits (« Critères », « Afficher
  seulement », « Tout afficher »).
