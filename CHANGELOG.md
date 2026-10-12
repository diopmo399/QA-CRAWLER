# Changelog

Versions selon [SemVer](https://semver.org). `@qa-crawler/core` et `@qa-crawler/cli` partagent le même numéro.

## Unreleased

### Ajouté

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
