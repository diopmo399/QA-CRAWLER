# SDK central, CLI, Dashboard, traçabilité métier, génération : audit et plan

Ce document complète [PLATFORM-AUDIT.md](PLATFORM-AUDIT.md) pour le prompt maître : un SDK central,
une CLI de premier rang et un Dashboard qui partagent le même moteur et les mêmes contrats, plus un
module de traçabilité métier. Il dit ce qui existe, ce qui est prouvé, ce qui manque et dans quel
ordre le reste est construit. Une capacité n'est `EXISTANT_ET_TESTÉ` que si un module la réalise
**et** qu'un test nommé l'exerce.

| État                      | Sens                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- |
| `EXISTANT_ET_TESTÉ`       | réalisé, couvert par un test qui passe (nommé dans la colonne Preuve)        |
| `EXISTANT_MAIS_INCOMPLET` | réalisé en partie ; l'écart est dit                                          |
| `EXISTANT_NON_VÉRIFIÉ`    | du code existe, aucun test ne prouve le comportement annoncé                 |
| `ABSENT`                  | aucun code                                                                   |
| `À_CLARIFIER`             | une décision est attendue avant de construire (la question est posée en § 5) |

## 1. État Git

| Branche             | Contenu                                                                     | État                           |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| `main`              | recorder (revue organisée), SDK embarquable (composants, Flow Studio, runs) | CI verte                       |
| `feat/sdk-platform` | plateforme : projets, environnements, scénarios, exécutions, vue d'ensemble | PR #141, CI verte, à fusionner |
| `feat/sdk-cli`      | sur `feat/sdk-platform` : annulation, SDK dans Node, CLI de la plateforme   | ce lot                         |

Aucune modification locale n'est écrasée : chaque lot est une branche, chaque PR est empilée sur la
précédente, la fusion attend une CI verte et une décision explicite.

## 2. Cartographie

### 2.1 SDK central

| Capacité                                                | État                      | Preuve / écart                                                                     |
| ------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| Contrat versionné (`SDK_API_VERSION = 1`, ajouts seuls) | `EXISTANT_ET_TESTÉ`       | `tests/unit/sdk-contract.test.ts`                                                  |
| Client sans dépendance (navigateur et Node)             | `EXISTANT_ET_TESTÉ`       | `sdk-core.test.ts` (flux, reprise, reconnexion), `sdk-node-example.test.ts`        |
| Service local : jeton, origines, CORS, CSP              | `EXISTANT_ET_TESTÉ`       | `sdk-server.test.ts`                                                               |
| SDK dans un programme Node (`openQaCrawler`)            | `EXISTANT_ET_TESTÉ`       | `sdk-cancellation.test.ts` (unitaire), `sdk-node-example.test.ts` (vrai moteur)    |
| Projets, environnements, scénarios, exécutions          | `EXISTANT_ET_TESTÉ`       | `sdk-platform.test.ts` (unitaire et vrai moteur)                                   |
| Annulation contrôlée                                    | `EXISTANT_ET_TESTÉ`       | `sdk-cancellation.test.ts` (unitaire et vrai moteur)                               |
| Suspension, reprise d'une exécution                     | `ABSENT`                  | le moteur ne suspend pas une mission                                               |
| Suivi après redémarrage du service                      | `EXISTANT_MAIS_INCOMPLET` | l'état vivant est en mémoire ; les runs terminés restent lisibles sur disque       |
| Identité des utilisateurs, rôles, journal d'audit       | `ABSENT` · `À_CLARIFIER`  | un jeton unique par service ; aucune notion d'utilisateur ni de rôle (question Q1) |

### 2.2 CLI

| Capacité                                                               | État                      | Preuve / écart                                                                                              |
| ---------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Mission (`learn`, `verify`, `explore <mission.yaml>`)                  | `EXISTANT_ET_TESTÉ`       | `cli-cancellation.test.ts`, suites d'intégration du moteur                                                  |
| Commandes de projet (`init`, `replay`, `explore`, `generate-tests`…)   | `EXISTANT_ET_TESTÉ`       | `tests/unit/project/project-cli.test.ts`, job `packaging` de la CI                                          |
| `dry-run`, `knowledge-center`, `k8s-manifest`, `sdk-server`            | `EXISTANT_ET_TESTÉ`       | `dry-run-cli.test.ts`, `knowledge-center-cli.test.ts`, `qa-platform-delivery.test.ts`, `sdk-server.test.ts` |
| Plateforme : `project`, `env`, `scenario`, `run`, `overview`, `doctor` | `EXISTANT_ET_TESTÉ`       | `cli-platform.test.ts` (unitaire, local et distant ; vrai moteur)                                           |
| Sortie `--json`                                                        | `EXISTANT_MAIS_INCOMPLET` | commandes de la plateforme seulement ; la CLI de mission écrit `result.json`                                |
| Codes de sortie `0`, `1`, `2`, `3`, `130`                              | `EXISTANT_ET_TESTÉ`       | `cli-platform.test.ts`, `cli-interrupt.test.ts`, `cli-cancellation.test.ts`                                 |
| JUnit XML (format de résultat)                                         | `EXISTANT_ET_TESTÉ`       | `junit-reporter.test.ts`, `run start --junit` dans `cli-platform.test.ts`                                   |
| Commandes de traçabilité (`trace …`)                                   | `ABSENT`                  | viendront avec le module (phase 4)                                                                          |

### 2.3 Traçabilité métier

Le moteur trace déjà exigence → règle métier → flow → assertion → résultat → preuve
(`src/quality/traceability.ts`). Son statut unique mêle couverture et vérification ; le prompt
maître sépare **trois dimensions** (implémentation, couverture, vérification).

| Entité ou capacité du prompt                                          | État                      | Preuve / écart                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Requirement, BusinessRule (déclarés dans la mission)                  | `EXISTANT_ET_TESTÉ`       | `traceability.test.ts`, `business-verification.test.ts`                                                                          |
| TestCase (flow), Assertion, TestRun, Evidence                         | `EXISTANT_ET_TESTÉ`       | idem ; preuves dans `quality-verification.json`                                                                                  |
| TraceabilityLink avec provenance (`YAML`, `GHERKIN`, `OPENAPI`)       | `EXISTANT_ET_TESTÉ`       | `traceability.test.ts`                                                                                                           |
| Lien : confiance, confirmation humaine                                | `ABSENT`                  | un lien déclaré est tenu pour vrai                                                                                               |
| AcceptanceCriterion                                                   | `ABSENT`                  |                                                                                                                                  |
| TestStep relié à une exigence                                         | `EXISTANT_MAIS_INCOMPLET` | les étapes sont dans le rapport du flow, sans lien direct à une exigence                                                         |
| ImplementationReference et états d'implémentation                     | `ABSENT` · `À_CLARIFIER`  | l'analyse statique des sources existe (`sources`, `static-git-source.test.ts`) ; la preuve d'implémentation reste à définir (Q2) |
| Vérification : PASS, FAIL, NOT_EXECUTED, BLOCKED, INCONCLUSIVE, STALE | `EXISTANT_ET_TESTÉ`       | `VERIFIED_PASS`, `VERIFIED_FAIL`, `COVERED_NOT_EXECUTED`, `BLOCKED`, `INCONCLUSIVE`, `STALE_EVIDENCE` ; `NEEDS_REVIEW` absent    |
| Couverture : LINKED, NOT_LINKED, PARTIALLY_COVERED, UNKNOWN           | `EXISTANT_MAIS_INCOMPLET` | `NOT_COVERED` seul ; la couverture partielle (par critère) suppose les critères d'acceptation                                    |
| Indicateurs (numérateur, dénominateur, périmètre, exclusions)         | `EXISTANT_MAIS_INCOMPLET` | comptes par statut ; le taux de réussite dit son périmètre en texte, pas en champs structurés                                    |
| Historique des preuves                                                | `EXISTANT_ET_TESTÉ`       | `traceability.test.ts` (cas 5 : preuve trop vieille → `STALE_EVIDENCE`)                                                          |
| Vue SDK de la traçabilité d'un run                                    | `EXISTANT_ET_TESTÉ`       | `reports.traceability`, `sdk-runs.test.ts`                                                                                       |

### 2.4 Génération, dry run, persistance, CI

| Capacité                                                                 | État                   | Preuve / écart                                                                              |
| ------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------- |
| Générateurs : YAML, Gherkin, Playwright TS, Java JUnit                   | `EXISTANT_ET_TESTÉ`    | `sdk-generated-execution.test.ts` (exécutés), `java-generated-tests.test.ts` (`mvn test`)   |
| Génération depuis la traçabilité (un test par critère)                   | `ABSENT`               | dépend des critères d'acceptation (phase 5)                                                 |
| Aperçu d'une génération sans écriture                                    | `ABSENT`               | la génération écrit ses fichiers ; un aperçu est prévu (phase 5)                            |
| Dry run d'un flow (rapprochement sans écriture)                          | `EXISTANT_ET_TESTÉ`    | `dry-run-engine.test.ts`, `dry-run-cli.test.ts`, `static-dry-run.test.ts`                   |
| Dry run exposé par le SDK et la CLI de la plateforme                     | `ABSENT`               | phase 5                                                                                     |
| Persistance du moteur : fichier, mémoire, SQLite, PostgreSQL, SQL Server | `EXISTANT_ET_TESTÉ`    | `persistence-*.test.ts` ; PostgreSQL et SQL Server réels dans le job `persistence` de la CI |
| Persistance du SDK (fichiers JSON, écriture atomique)                    | `EXISTANT_ET_TESTÉ`    | `sdk-platform.test.ts` ; écritures concurrentes de plusieurs services : risque R2           |
| Exemples de CI consommatrice (GitHub Actions, GitLab)                    | `EXISTANT_NON_VÉRIFIÉ` | `examples/ci/*.yml` ne sont exécutés par aucune CI de ce dépôt                              |

### 2.5 Dashboard

| Capacité                                                             | État                      | Preuve / écart                                                                 |
| -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| Composants : assistant, Run Monitor, comparaison, Flow Studio        | `EXISTANT_ET_TESTÉ`       | `sdk-wizard`, `sdk-monitor`, `sdk-runs`, `sdk-studio` (Chromium)               |
| Page Dashboard (projets, environnements, exécutions, vue d'ensemble) | `ABSENT`                  | phase 3                                                                        |
| Bouton « Annuler » dans le suivi                                     | `ABSENT`                  | l'API existe ; l'écran viendra avec le Dashboard                               |
| Libellés des phases du moteur traduits                               | `EXISTANT_MAIS_INCOMPLET` | le Run Monitor en français affiche les phases du moteur en anglais (défaut D1) |

### 2.6 Sécurité

| Capacité                                                                         | État                     | Preuve / écart                                                                 |
| -------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| Secrets par nom de variable, jamais renvoyés ni écrits                           | `EXISTANT_ET_TESTÉ`      | `sdk-platform.test.ts`, `cli-platform.test.ts`, `persistence-security.test.ts` |
| SafetyPolicy (écritures bornées par environnement, actions dangereuses bloquées) | `EXISTANT_ET_TESTÉ`      | `sdk-platform.test.ts` (une seule instance écrite), suites du moteur           |
| Règles vérifiées par le serveur, pas par l’écran                                 | `EXISTANT_ET_TESTÉ`      | même refus par l'API, la CLI et les composants (`409`, `422`)                  |
| IA optionnelle, jamais décisionnaire seule                                       | `EXISTANT_ET_TESTÉ`      | `ai-decision-lifecycle.test.ts`                                                |
| Coffre de secrets, exports protégés                                              | `ABSENT` · `À_CLARIFIER` | les secrets restent dans l'environnement d'exécution (Q3)                      |

## 3. Dépendances

```
SDK central (contrats, service, client)
 ├── CLI de la plateforme ──────────────┐
 ├── Dashboard (composants + page) ─────┤── mêmes routes, mêmes refus
 └── Traçabilité métier
       ├── critères d'acceptation ── couverture partielle, génération par critère
       ├── références d'implémentation ── analyse statique des sources (existante)
       └── indicateurs structurés ── vue d'ensemble, Dashboard, CLI (--json)
```

## 4. Risques

| Id  | Risque                                                                  | Mesure                                                                              |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| R1  | Deux modèles de traçabilité (moteur et module) qui divergent            | le module lit les résultats du moteur et n'en recalcule aucun                       |
| R2  | Deux services sur le même espace de travail écrivent le même fichier    | écriture atomique ; une exclusion entre services est à décider avec le Dashboard    |
| R3  | Un lien proposé (par l'analyse ou l'IA) pris pour un lien confirmé      | confiance et confirmation humaine dans le contrat ; un lien proposé ne vérifie rien |
| R4  | Une exécution annulée lue comme un échec ou une réussite                | verdict `CANCELLED`, hors du taux de réussite (fait)                                |
| R5  | Un flow coupé par une limite affiché `PASSED` avec des étapes `SKIPPED` | comportement du moteur, documenté ; le verdict de l'exécution fait foi              |

## 5. Questions ouvertes (`À_CLARIFIER`)

- **Q1 — Utilisateurs et rôles.** Le service n'a qu'un jeton. Un Dashboard partagé suppose une
  identité (fournisseur d'identité de l'hôte ?) et des rôles (lecture, exécution, administration).
  En attendant, toute opération sensible reste protégée par le serveur, jamais par l'écran seul.
- **Q2 — Preuve d'implémentation.** Qu'est-ce qui confirme qu'une exigence est implémentée : un
  symbole du code, une route d'API (OpenAPI), un commit cité ? Proposition : l'analyse statique ne
  produit que des `IMPLEMENTATION_CANDIDATE` ; seule une confirmation humaine donne
  `IMPLEMENTATION_CONFIRMED`.
- **Q3 — Stockage des secrets.** Les secrets restent des variables d'environnement lues par le
  serveur. Un coffre (Vault, gestionnaire du nuage) et le chiffrement des exports sont à choisir.

## 6. Plan

| Phase | Contenu                                                                                                                                                                  | État           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 0     | Audit, cartographie, plan                                                                                                                                                | fait           |
| 1     | Plateforme SDK : projets, environnements, scénarios, exécutions, vue d'ensemble                                                                                          | fait (PR #141) |
| 2     | Annulation contrôlée ; SDK dans un programme Node ; CLI de la plateforme                                                                                                 | fait (ce lot)  |
| 3     | Dashboard (thème clair, accent violet) sur le SDK : vue d'ensemble, projets, environnements, exécutions, annulation                                                      | à faire        |
| 4     | Traçabilité métier : critères d'acceptation, liens (provenance, confiance, confirmation), trois dimensions d'états, indicateurs structurés ; SDK, CLI `trace`, Dashboard | à faire        |
| 5     | Génération par critère, aperçu sans écriture, dry run exposé par le SDK et la CLI                                                                                        | à faire        |
| 6     | Références d'implémentation (selon Q2), exports protégés (selon Q3)                                                                                                      | à faire        |
| 7     | Stabilisation : bout en bout, accessibilité, performance, rapport final                                                                                                  | à faire        |

Les décisions d'architecture sont dans [adr/0001-sdk-central.md](adr/0001-sdk-central.md).
