# Changelog

Versions selon [SemVer](https://semver.org). `@qa-crawler/core` et `@qa-crawler/cli` partagent le même numéro.

## Unreleased

### Ajouté

- **Restauration du contexte à la reprise d'un rejeu corrigé** (`src/replay/context-checkpoint.ts`,
  `src/replay/context-capture.ts`, session de correction, fenêtre du recorder ; `docs/CONTEXT_RECOVERY.md`).
  Un checkpoint de contexte est pris devant chaque étape de la session (URL complète, route, cadres, onglets,
  dialogue, champs, défilement, contrôles, données du run, étapes à effet métier, préconditions). Après une
  correction validée, **Reprendre ici** compare la page tenue au checkpoint et décide : REVALIDATE (préconditions
  dures vérifiées), RESTORE (les étapes qui remplissent les champs perdus), REBUILD (les étapes précédentes avec
  les mêmes données du run) ou MANUAL_RECOVERY (session expirée, création qui serait répétée, précondition non
  satisfaite). L'étape corrigée et la suite sont rejouées dans la même session ; un échec suivant garde la page
  devant l'étape en échec. `TestDataRunContext.seed()`, `replay.contextRecovery`, `replay-checkpoints.json`
  (empreintes), événements `REPLAY_CONTEXT_RECOVERY`, `REPLAY_RESUMED`, `REPLAY_RESUME_BLOCKED`. Tests unitaires
  (17) et d'intégration `recording-context-recovery`.
- **Bloc de correction redessiné** (fenêtre du recorder). Cartes Avant / Après lisibles (rôle, nom de l'élément,
  ligne du tableau sur sa propre ligne, donnée du run en pastille ; la cible brute reste en infobulle), façons
  d'identifier la ligne en cartes à choisir (« Recommandé », « Propre à ce run »), avertissements en encarts,
  ordre de résolution sur une ligne, traits techniques repliés dans « Détails techniques », Tester / Annuler /
  Valider sur une seule ligne, en-tête de l'action masqué pendant la correction. L'historique d'une correction
  utilise les mêmes cartes.
- **Ligne de tableau : liaison plus robuste et liaison manuelle.** Une cellule qui contient la donnée du run (accents, casse,
  espaces, suffixe ignorés) est liée avec un critère « contient » ; sinon la fenêtre le dit et propose **Lier une colonne à
  une donnée du run** (colonnes de la ligne et données du run avec leur valeur ; `RowBinding`, commande `correct-apply`
  avec `column` et `variable`). La colonne des détails ne déborde plus (titre de la correction qui passe à la ligne, cible
  JSON et CSS longs coupés, « Copier » entier).
- **Correction manager** (`src/recording/target-correction.ts`, fenêtre du recorder, script de capture) :
  corriger la cible d'une action **dans le navigateur**. Mode sélection dans la page (bandeau, élément
  survolé encadré avec rôle · nom · test id, clic jamais transmis à l'application, Échap annule) ; dans la
  fenêtre : ancienne cible → nouvelle cible, traits de l'élément, ordre de résolution au rejeu (le résolveur
  de l'enregistrement, jamais un second moteur), Tester / Annuler / Valider, historique et « Restaurer
  l'original ». Pendant l'enregistrement : la correction est posée sur les événements bruts
  (`userCorrection`) et le flow généré la porte (`userDecision: TARGET_CORRECTED_BY_USER`,
  `corrections`). En revue (carte « Replay interrompu », détails d'une étape) : une **session de correction**
  (`src/recording/correction-session.ts`) suit le même chemin — les étapes précédentes sont rejouées par le
  moteur de la mission (connexion, SafetyPolicy, données du run), puis la page reste ouverte dans cet état en
  mode sélection seul ; un chemin arrêté avant l'étape est signalé. L'étape du flow est réécrite et les fichiers
  régénérés. `DryRunDriver.page()`. Événements `TARGET_CORRECTED`, `RECORDING_TARGET_CORRECTED` ; commandes `correct-*` de la fenêtre.
  **Ligne de tableau liée à la donnée du run** : quand l'élément désigné est dans une ligne dont une cellule
  porte une valeur connue du run (saisie, donnée du jeu, donnée produite par le rejeu de la session —
  `DryRunDriver.testDataValues()`, `TestDataRunContext.values()`), la fenêtre propose « Identifier la ligne
  par : la donnée du run » (`row: { colonne: ${testData:clé} }`, par défaut) ou « la clé lue dans le tableau »,
  marquée « propre à ce run » quand l'ancienne cible visait la même colonne avec une autre valeur
  (`CorrectionProposal.rowOptions`, `PickedElement.rowCells`, commande `correct-apply` avec `option`).
  **Fenêtre sur écran de portable** (largeur ≤ 1400 px ou hauteur ≤ 820 px) : moins d'espace et moins de
  défilement — barre d'état sur une ligne, une ligne par action (statut à droite), détail et parcours qui
  défilent chacun pour soi (le détail passe avant l'aperçu), carte « Replay interrompu » sur une ligne avec ses
  actions, bouton « Corriger dans le navigateur » sur la ligne du titre, Tester / Annuler / Valider collés en
  bas du détail pendant que la correction défile.
- **Dock dans la page** (`recording.panelLayout: docked`, script de capture, console) : une seule fenêtre
  Chromium pendant l'enregistrement. Le bandeau de l'application devient le mini-dock (compteurs ✓ ⚠ ✕, les
  trois dernières actions et leur statut en direct, Pause / Annuler / Arrêter, repli en pastille, coin au
  choix) ; « Résoudre » sur une action ambiguë et « ▣ Fenêtre » ouvrent le cockpit à la demande (fermé : le
  dock reste) ; la revue ouvre la fenêtre d'elle-même. Node pousse l'état (`HumanFlowRecorder.showDock`),
  le dock envoie les commandes (`control: window`) ; `RecordingConsole` ouvre la fenêtre à la demande ;
  `PanelState.focus` amène l'étape demandée à l'écran. Test d'intégration `recording-dock`.
- **Vue d'ensemble** (`reports/overview.html`, `src/reporting/overview-*.ts`) : une page autonome par run —
  indicateurs (actions validées, intentions CONFIRMED / PROBABLE contre UNKNOWN, durée et durées par étape),
  parcours détecté (une carte par étape, ton validé / avertissement / échec / inconnu, étape d'arrêt, écritures
  HTTP, liens « réutilise la même valeur » tirés de `testDataReport`), détails du run (preuve métier, confiance,
  dérive), timeline avec recherche, dépliable, lignée des données de test (source, réutilisations, citations ; seule
  une valeur générée est affichée). Thème clair / sombre, recherche, choix du flow, lien depuis `index.html`.
  Configuration `output.overviewHtml` (par défaut `true`).
- **Thème QA-CRAWLER partagé** (`src/reporting/theme.ts`) : la vue d'ensemble, `index.html`, `flow-graph.html`,
  le rapport d'enregistrement, le rapport de dry-run et la fenêtre du recorder utilisent les mêmes jetons de
  couleur, le même logo et un bouton clair / sombre (clair par défaut, choix gardé pour toutes les pages).
- **Rejeu piloté par intention et état** (`src/replay/`) : `ReplayStateMachine` (position fonctionnelle,
  checkpoints confirmés, dernière action commise, divergence localisée entre le dernier checkpoint
  confirmé et le premier manquant), checkpoints fonctionnels dérivés des effets enregistrés, de
  l'intention, des `expect` et de l'étape suivante ; préconditions (`TARGET_PRESENT`, `FIELD_FILLED`,
  `ROUTE`, `DIALOG_OPEN`, `NO_OVERLAY`, `CHECKPOINT`, `TEST_DATA`) et dépendances entre étapes
  (`FILLS_FIELD`, `REVEALS_TARGET`, `OPENS_DIALOG`, `REACHES_ROUTE`, `PRODUCES_DATA`) avec l'explication
  jusqu'à l'étape racine ; `ReplayPlanner` (RECORDED / HISTORICAL / SEMANTIC / AMBIGUOUS, jamais un
  champ, SafetyPolicy puis effet) ; verdict transactionnel par étape (execution ≠ target ≠ effect ≠
  functional state) et confiance combinée (`REPLAY_LOW_CONFIDENCE` sous le seuil) ; mémoire des
  résolutions (`KnowledgeBase.recordTargetResolution`, apprises d'une récupération confirmée ou d'un
  plan confirmé, proposées d'abord ensuite). `FlowStepReport.replay`, `FlowRunReport.replay`, bloc
  « Intent-driven replay » du rapport HTML, configuration `replay.intentDriven`, événements
  `REPLAY_*`, `CHECKPOINT_*`, `PRECONDITION_*`, `RESOLUTION_*`.
- **Intention fonctionnelle** (`src/intent/`) : element + contexte + action humaine + état → intention à
  trois niveaux (geste, interface, opération × entité) pour chaque action enregistrée, avec preuves typées
  (libellé, rôle, contexte structurel, actions voisines, effets, réseau, cycle de vie des entités, décision
  humaine, bibliothèque, contrat), candidats classés, contradictions et statut CONFIRMED / PROBABLE /
  AMBIGUOUS / UNKNOWN. Écrite à côté de l'action, jamais à sa place : `functionalIntent:` dans le YAML,
  `functional-intents.json`, rapport d'enregistrement, modèle de l'application ; le self-healing la lit
  avant l'heuristique du libellé. Arbitre IA sur AMBIGUOUS seulement (choix parmi les candidats),
  bibliothèque d'intentions dans la connaissance fonctionnelle. Configuration `recording.intent`.
- `Issue.details` : nom de l'erreur, source (`fichier:ligne:colonne`), pile d'appels complète
  (`PAGE_ERROR`), texte complet d'un message console sur plusieurs lignes (`CONSOLE`), type de
  ressource et en-têtes de diagnostic d'une réponse en échec (`HTTP`, `BROKEN_LINK`,
  `REQUEST_FAILED`). Masqués et bornés par le collecteur comme le message.
- Rapport HTML : bloc « Détails » dépliable sous le message de chaque anomalie (source,
  informations clé → valeur, pile d'appels, texte complet).
- **Réconciliation sémantique du Dry Run** (`src/dry-run/semantic-reconciliation.ts`) : après
  l'alignement brut, une étape attendue restée `MISSING` / `POSSIBLY_OBSOLETE` / `UNREACHABLE` et une
  étape observée restée `INSERTED` qui désignent le même événement fonctionnel forment une seule
  entrée, jamais `MISSING` + `INSERTED`. Score par dimension (cible, intention, entité, contexte,
  séquence, effet) et total pondéré ; statuts `MATCHED_WITH_TARGET_CHANGE`, `MATCHED_SEMANTICALLY`,
  `MATCHED_WITH_CONTEXT_CHANGE`, `MATCHED_AFTER_INSERTION`, `DUPLICATE_CANDIDATE` (deux candidats
  aussi plausibles : rien n'est choisi, scénario `INCONCLUSIVE`). Un libellé d'abandon, un champ, une
  vérification ou une adresse ne sont jamais appariés. `ReconciliationEntry.pairing` (détail du score,
  autres candidats), résumé `matchedWithVariation` / `duplicateCandidate`, événement `FLOW_STEP_PAIRED`,
  rapport HTML et CLI, configuration `dryRun.semanticPairing` (`minScore` 0.7, `ambiguityMargin` 0.1).

### Modifié

- Fenêtre d'enregistrement : nouvelle apparence, alignée sur la maquette QA-CRAWLER — palette indigo
  (clair et sombre), cartes arrondies, étapes plus aérées avec la sélection cerclée, statuts en texte
  coloré, carte « Replay interrompu » blanche à bord rouge avec ses détails en bloc, barre de résumé et
  boutons plus grands. Aucune ressource réseau : police système.
- Tests d'intégration plus rapides : un worker vitest par cœur (8 au plus, `QA_TEST_WORKERS` pour
  régler), tests concurrents à l'intérieur des fichiers longs (chacun dans son propre dossier de
  rapports), et job CI `integration` découpé en trois shards parallèles (le job `build` ne lance
  plus l'intégration). Sur une machine à 4 cœurs : de 1 250 s à environ 600 s.

### Corrigé

- Fenêtre d'enregistrement : le pictogramme du geste de chaque étape (clic, saisie, case…) affichait
  « undefined » pour une saisie et rien pour un clic — deux tables `SVG` du même script se
  masquaient. Table des gestes à part (`KIND_SVG`), test unitaire et assertion E2E.
- Écriture atomique (`writeFileAtomic`) : deux écritures du même fichier en vol dans le même processus
  (par exemple la base de connaissances de deux missions concurrentes) n'ont plus le même fichier
  temporaire ; le renommage de la seconde n'échoue plus en `ENOENT`.
- Windows, Git Bash et WSL : les scripts npm `build`, `clean` et `pack` passent par Node
  (`scripts/clean.mjs`, `scripts/pack.mjs`) au lieu de `rm -rf` / `mkdir -p` ; le test
  d'installation (`test:packaging`) lance `npm.cmd` et `qa-crawler.cmd` sous Windows ;
  `.gitattributes` force les fins de ligne LF ; job CI `packaging-windows` (build, tarballs,
  installation des tarballs, tests unitaires sur `windows-latest`) ; section README
  « Windows, Git Bash et WSL » et lignes de dépannage.

## 0.2.0 — 2026-10-12

### Ajouté

- Paquets installables `@qa-crawler/core` (moteurs + API publique `index.ts`) et `@qa-crawler/cli`
  (façade `qa-crawler`), workspaces npm, build dans `packages/core/dist`, `npm run pack:check`,
  `npm run test:packaging`, `npm run release`.
- Commandes de projet : `init`, `replay`, `explore`, `analyze`, `test-api`, `reproduce`,
  `generate-tests`, `record` (dans un projet), `--version`, `--help` ; options `--cwd`, `-c`,
  `--base-url`, `--headless/--headed`, `--playwright-config`, `--reports-dir`, `--flow`, `--force`,
  `--no-example`, `--out` ; codes de sortie 0 / 1 / 2 / 3.
- `qa-crawler.config.yaml` (`qaCrawler:`) traduit en mission (`qa-crawler/.derived/`), flows
  découverts dans `qa-crawler/flows/` (YAML et `.feature`), priorité CLI > env > fichier > défauts.
- Détection de projet (Angular, React, Vue, TypeScript, Playwright, OpenAPI, source maps, Git,
  GitHub, CI, Docker, Kubernetes) et réutilisation du `playwright.config` du projet
  (`baseURL`, `headless`, `viewport`, `storageState`).
- Métadonnées d'outil dans chaque résultat : `tool: { coreVersion, cliVersion, projectVersion, node }`.
- Fixtures de packaging (Angular, React, générique, OpenAPI), job CI `packaging`, Dockerfile basé sur
  le bin du paquet, `docs/MIGRATION_TO_PACKAGE.md`, exemples de pipelines consommateurs sans base de
  données (`examples/ci/`, mémoire restaurée et sauvegardée dans un dépôt générique Artifactory).

### Inchangé

- Toutes les commandes historiques (`learn`, `verify`, `explore <mission>`, `dry-run`, `record`,
  `sources`, `k8s-manifest`), le format des missions, flows, Gherkin, données de test, baselines,
  enregistrements, bases de connaissances et providers de persistance.
