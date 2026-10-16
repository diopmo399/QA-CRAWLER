# Changelog

Versions selon [SemVer](https://semver.org). `@qa-crawler/core` et `@qa-crawler/cli` partagent le même numéro.

## Unreleased

### Ajouté

- **Fournisseur IA Anthropic** (`ai.provider: anthropic`, `--ai-provider anthropic`) : un modèle de
  l'API Anthropic comme conseiller de raisonnement, par le SDK officiel `@anthropic-ai/sdk`
  (dépendance optionnelle, chargée dynamiquement). Même circuit que Copilot : requête nettoyée,
  proposition au schéma (sorties structurées, contraintes non prises en charge retirées puis
  revérifiées par le validateur), validation, SafetyPolicy, exécution, vérification au runtime.
  Aucun modèle fixé dans le code : `ai.anthropic.model` ou `--ai-model` est obligatoire.
  Raisonnement adaptatif, effort configurable (`ai.anthropic.effort`), instructions mises en
  cache, repli côté serveur sur refus en option (`serverSideFallback`), signalé quand il sert ; un
  refus devient une abstention `INCONCLUSIVE`, une réponse coupée est invalide. Clé lue dans
  `ANTHROPIC_API_KEY` (ou `ai.anthropic.apiKeyEnv`), jamais écrite. Tests : faux SDK (unitaires)
  et vrai SDK contre un point d'accès Messages local (intégration).
- **Démo Orbit Desk** (`tests/fixtures/orbit-desk-app.ts`, `scenarios/demo-orbit.yaml`, `npm run
demo:server` sur le port 4180) : un back-office de demandes moderne et fictif pour les démonstrations.
  Création réelle (POST → 201 + `Location`, référence propre à chaque création), liste par session,
  actions qui modifient ou détruisent, écran Rapports en panne (HTTP 500). La mission livrée produit un
  rapport, un Gherkin et des tests Playwright en français, avec des données de test générées (`testData.
defaults`). Test d'intégration : flows passés, panne détectée, écritures bloquées, aucune création.
- **Ligne de tableau : toutes les colonnes, valeurs modifiables** (`src/recording/target-correction.ts`,
  fenêtre du recorder ; `docs/HUMAN_FLOW_RECORDER.md`). Les cellules de la ligne cliquée sont gardées dès
  l'enregistrement (`RecordedElement.rowCells`), plus seulement la clé de ligne. **Choisir les colonnes de la
  ligne** (correction dans le navigateur) et **Modifier la ligne** (revue, sans navigateur) montrent toutes les
  colonnes : on en combine plusieurs et chacune prend sa valeur d'une source — valeur lue, valeur modifiée dans
  la fenêtre, donnée du run, ou nouvelle donnée de test ajoutée à `test-data.yaml` — avec un critère « égale » ou
  « contient ». **Aperçu dans la page** compte les lignes qui correspondent (`scanTableRows`, rien n'est
  cliqué). `rowOfColumns`, `editFlowRow`, `recordedRowCells`, `addRowVariables`, commandes `row-preview` et
  `row-edit`, option `columns` de `correct-apply`. Remplace « Lier une colonne à une donnée du run » (l'option
  `manual` reste acceptée). Tests unitaires `row-columns`, intégration `recording-row-columns` et aperçu dans
  `recording-row-correction`.
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
  utilise les mêmes cartes. Grand écran (≥ 1400 px) : la colonne du détail grandit avec l'écran (34 %, de 440 à
  760 px), une action du parcours tient sur une ligne, le titre « Enregistrement terminé » en double disparaît ;
  Valider n'est jamais coupé ; un replay réussi liste ses coches sur une ligne.
- **Ligne liée à une donnée du run : le lien répété n'est plus une ambiguïté.** Le contrôle de corrélation compte la cible
  dans la ligne qui porte la donnée (et non tous les liens identiques de l'écran) : une ligne `~${testData:clé}` trouvée
  seule passe ; plusieurs lignes qui portent la donnée restent refusées (rien n'est exécuté, quel que soit `rowPick`).
  Test d'intégration `table-row`.
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

- **Rapport HTML en français : la section « Intelligence IA » entièrement traduite.** Précondition
  manquante, contexte fonctionnel (objectif, progression, manquant, bloqué), sélection et découverte des
  modèles, en-têtes des tableaux de modèles et d'efficacité, validation, runtime, apport à la
  connaissance et contrôle des compteurs suivent `report.language` ; seuls les codes (statuts,
  déclencheurs) restent tels quels.
- **Rapport HTML : des tableaux qui tiennent dans leur carte.** Décisions IA en quatre colonnes (décision,
  proposition, contrôles, résultat) au lieu de treize, le contexte fonctionnel sur sa propre ligne ; anomalies
  du run en cinq colonnes (la gravité rejoint la catégorie, régression · source · confiance deviennent des
  indices) ; hypothèses du moteur cognitif en six colonnes (preuves pour / contre et horodatages regroupés).
  Les mots restent entiers (plus de « Paramètre|s ») ; seuls les longs jetons (URL, identifiants,
  localisateurs) se coupent ; les tableaux imbriqués sont plus compacts. Vérifié en navigateur : une fois
  tout déplié, aucun tableau ne dépasse sa carte à 1366 et 1920 px (`ai-blocked-goal`).
- **Une violation d'invariant n'est plus classée « autorisation ».** « Aucune erreur serveur » et les autres
  invariants d'écran sont des `FUNCTIONAL_FAILURE` ; seuls les invariants d'accès (`ISSUE-INV-…`, « l'acteur
  X n'accède pas à… ») restent des `AUTHORIZATION_FAILURE`.
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
