# Changelog

Versions selon [SemVer](https://semver.org). `@qa-crawler/core` et `@qa-crawler/cli` partagent le même numéro.

## Unreleased

### Ajouté

- **Vue d'ensemble** (`reports/overview.html`, `src/reporting/overview-*.ts`) : une page autonome par run —
  indicateurs (actions validées, intentions CONFIRMED / PROBABLE contre UNKNOWN, durée et durées par étape),
  parcours détecté (une carte par étape, ton validé / avertissement / échec / inconnu, étape d'arrêt, écritures
  HTTP, liens « réutilise la même valeur » tirés de `testDataReport`), détails du run (preuve métier, confiance,
  dérive), timeline filtrable et dépliable, lignée des données de test (source, réutilisations, citations ; seule
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

### Corrigé

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
