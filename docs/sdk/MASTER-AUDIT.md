# SDK embarquable : audit, base de référence et architecture cible

Ce document est la phase 0 du plan du SDK complet. Il dit ce qui existe, ce qui est prouvé par un
test, ce qui manque, et dans quel ordre le reste est construit. Une capacité n'est classée
« existante » que si un module la réalise **et** qu'un test l'exerce ; un nom de fichier ne suffit pas.

États utilisés :

| État                      | Sens                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `EXISTANT_ET_TESTÉ`       | réalisé dans le code, couvert par un test unitaire ou d'intégration qui passe                       |
| `EXISTANT_MAIS_INCOMPLET` | réalisé en partie (moteur sans exposition SDK, API sans écran, cas non couverts)                    |
| `ABSENT`                  | aucun code                                                                                          |
| `À_VALIDER`               | du code existe mais rien ne prouve le comportement annoncé dans l'environnement visé (voir colonne) |

## 1. Le dépôt

| Sujet                 | Constat                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Langage, outils       | TypeScript strict (ESM), `tsc -p tsconfig.build.json` vers `packages/core/dist`, ESLint, Prettier, Vitest (projets `unit`, `integration`)                                                                   |
| Paquet                | `@qa-crawler/core` (moteur + CLI), exports `./sdk`, `./sdk/ui`, `./sdk/server` ; rien n'est publié sur un registre                                                                                          |
| Frontend existant     | aucun framework : les fenêtres (recorder, Knowledge Center, assistant SDK) sont du HTML/CSS/JS servi par `node:http`                                                                                        |
| Navigateur du moteur  | Playwright Chromium, côté Node seulement                                                                                                                                                                    |
| Choix du SDK UI       | Web Components + Shadow DOM, sans framework (déjà retenu pour l'assistant) : s'intègre à Angular, React, Vue ou une page simple                                                                             |
| Dépendances Node-only | Playwright, `node:fs`, `node:http`, fournisseurs de persistance (pg, mssql, sqlite) : elles restent dans `src/sdk/server` et le moteur ; `src/sdk/core` et `src/sdk/ui` n'importent que des types et le DOM |

Points d'entrée réutilisés par le SDK :

| Capacité                  | Point d'entrée du moteur                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Projet → mission          | `projectConfigSchema`, `loadProjectMission(project, { command, missionName }, overrides, env)`                                           |
| Exploration               | `runMission(config, { listener, env, onProgress })`                                                                                      |
| Enregistrement            | `runRecording(RecordRequest)`, `HumanFlowRecorder.requestStop('api')`                                                                    |
| Revue d'un enregistrement | `src/recording/recording-workspace.ts` (propositions, groupes, génération, réécriture des fichiers du flow)                              |
| Groupes et dépendances    | `src/recording/step-groups.ts` : `stepDependencies`, `dependencyViolations`, `GroupView.data`, `runnableAlone`                           |
| Données de test           | `src/recording/test-data-binding.ts` : `availableVariables`, `stepDataBinding`, `applyTestDataBinding`, `dataLineage`                    |
| Assertions                | `src/quality/assertion-engine.ts` (statuts `PASS`, `FAIL`, `BLOCKED`, `INCONCLUSIVE`, `UNVERIFIABLE`), `assertion-proposals.ts`          |
| Traçabilité               | `src/quality/traceability.ts` (`buildTraceability`, historique), résultat dans `quality-verification.json`                               |
| Régressions               | `src/regression/*` (cycle de vie des anomalies, évolution des flows), `src/platform/regression-analysis.ts` → `regression-analysis.json` |
| Comparaison de structure  | `src/diff/flow-diff.ts` (`FlowDiffEngine`), `src/baseline/baseline-store.ts` (baselines versionnées)                                     |
| Comparaison visuelle      | `src/platform/visual-analysis.ts` (seuils, baseline par flow et étape) → `visual-analysis.json`                                          |
| Générateurs               | `src/platform/playwright-test-generator.ts`, `gherkin-feature-generator.ts`, `java-junit-playwright-generator.ts`                        |
| Rapport de résultats      | `src/reporting/junit-reporter.ts` (JUnit XML, distinct du générateur Java)                                                               |

## 2. Inventaire des capacités

### A. Assistant de création de projet

| Élément                                                     | État                | Preuve / écart                                                                                             |
| ----------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Étapes projet, environnement, exploration, récapitulatif    | `EXISTANT_ET_TESTÉ` | `tests/unit/sdk-view.test.ts`, `sdk-project.test.ts`, `tests/integration/sdk-wizard.test.ts` (moteur réel) |
| Validation par le moteur côté serveur                       | `EXISTANT_ET_TESTÉ` | `tests/unit/sdk-server.test.ts` (schéma, mission dérivée)                                                  |
| Identifiants par noms de variables `QA_*`, jamais de valeur | `EXISTANT_ET_TESTÉ` | idem                                                                                                       |
| Lancement réel et suivi (SSE numérotés, reprise `after`)    | `EXISTANT_ET_TESTÉ` | `sdk-wizard.test.ts`                                                                                       |
| Type « Salesforce Lightning » (profil de plateforme)        | `EXISTANT_ET_TESTÉ` | `tests/integration/salesforce-lightning.test.ts` sur une imitation ; **jamais** sur une vraie organisation |
| Annulation d'une exploration                                | `ABSENT`            | `runMission` ne prend pas de signal ; le statut `CANCELLED` reste réservé                                  |

### B. Flow Studio et graphe

| Élément                                                                                                        | État                      | Preuve / écart                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| Graphe d'exploration (écrans, transitions) en données                                                          | `EXISTANT_ET_TESTÉ`       | `GraphView` via `/api/explorations/:id/graph`, `tests/integration/sdk-extensions.test.ts`           |
| Graphe statique dans les rapports HTML                                                                         | `EXISTANT_ET_TESTÉ`       | `src/reporting/flow-diagram.ts` (SVG sans script)                                                   |
| Opérations de groupes (créer, renommer, décrire, affecter, détacher, réordonner, déplacer, replier, supprimer) | `EXISTANT_ET_TESTÉ`       | moteur `step-groups.ts` + API `/groups`, `tests/unit/step-groups.test.ts`, `sdk-extensions.test.ts` |
| Refus d'un déplacement qui casse une dépendance de données                                                     | `EXISTANT_ET_TESTÉ`       | `dependencyViolations`, réponse `{ error, violations }`                                             |
| « Jouable seul » d'un groupe                                                                                   | `EXISTANT_MAIS_INCOMPLET` | calculé (`runnableAlone`) ; **jouer** un groupe seul depuis le SDK n'existe pas                     |
| Dépendances par étape exposées au SDK                                                                          | `ABSENT`                  | `stepDependencies` n'est pas servi ; `FlowView.steps` n'a pas les clés produites / consommées       |
| Chemin réellement exécuté                                                                                      | `EXISTANT_MAIS_INCOMPLET` | `recording-validation.json` (rejeu `--validate`) existe ; non exposé au SDK                         |
| Graphe interactif (zoom, déplacement, nœuds, groupes, recherche, ajustement, panneau)                          | `ABSENT`                  | aucun composant                                                                                     |
| Éditeur de groupes visuel                                                                                      | `ABSENT`                  | l'API existe, pas l'écran                                                                           |
| Anciens enregistrements sans groupes                                                                           | `EXISTANT_ET_TESTÉ`       | « a flow without groups is unchanged » (`tests/unit/step-groups.test.ts`)                           |

### C. Assertions métier

| Élément                                                                             | État                | Preuve / écart                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Propositions à partir des observations (DOM, réseau, données)                       | `EXISTANT_ET_TESTÉ` | `tests/unit/assertion-proposals.test.ts`                                                                                                       |
| Accepter, modifier, désactiver, rejeter                                             | `EXISTANT_ET_TESTÉ` | API `/assertions/:pid`, `sdk-extensions.test.ts`                                                                                               |
| Moteur d'assertions au rejeu, preuves, statuts                                      | `EXISTANT_ET_TESTÉ` | `tests/unit/business-assertions.test.ts`                                                                                                       |
| Vocabulaire `VERIFIED_PASS / VERIFIED_FAIL / BLOCKED / INCONCLUSIVE / NOT_EXECUTED` | `ABSENT`            | le moteur dit `PASS / FAIL / BLOCKED / INCONCLUSIVE / UNVERIFIABLE` ; aucune correspondance publiée, et « non exécutée » n'est pas représentée |
| Éditeur d'assertions visuel                                                         | `ABSENT`            |                                                                                                                                                |

### D. Données de test dynamiques

| Élément                                                          | État                      | Preuve / écart                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture, généralisation, valeurs `FIXED / GENERATED / REFERENCE` | `EXISTANT_ET_TESTÉ`       | `tests/unit/test-data-binding.test.ts`, `tests/integration/recording-test-data-binding.test.ts`                                                                           |
| Lignée (productrice, consommatrices, provenance)                 | `EXISTANT_ET_TESTÉ`       | `dataLineage`, même tests                                                                                                                                                 |
| Masquage des valeurs sensibles                                   | `EXISTANT_ET_TESTÉ`       | `tests/unit/redactor.test.ts`, `security-artifacts.test.ts`                                                                                                               |
| Donnée requise absente au rejeu                                  | `EXISTANT_MAIS_INCOMPLET` | une clé absente du jeu reçoit une valeur du `TestDataProvider` (comportement historique, `tests/unit/recorded-test-data.test.ts`) ; rien ne le signale **avant** le rejeu |
| Exposition au SDK (lister, lier une valeur produite à un champ)  | `ABSENT`                  | rien n'est servi                                                                                                                                                          |
| Éditeur visuel de liaison                                        | `ABSENT`                  | seule la fenêtre du recorder le propose                                                                                                                                   |

### E. Génération multi-format

| Élément                                        | État                | Preuve / écart                                                                                                                                                           |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Représentation commune + plan de génération    | `EXISTANT_ET_TESTÉ` | `tests/unit/generation-plan.test.ts`, `assertion-translation.test.ts`                                                                                                    |
| Playwright Test TypeScript                     | `EXISTANT_ET_TESTÉ` | phase 5 : `playwright.config.ts` généré (JUnit XML) ; `tests/integration/sdk-generated-execution.test.ts` lance `playwright test` sur la sortie d'un enregistrement réel |
| Gherkin `.feature`                             | `EXISTANT_ET_TESTÉ` | exécutable par le moteur (`flows: gherkin`), `gherkin-glue.test.ts` ; phase 5 : mission générée à côté du `.feature`, jouée dans `sdk-generated-execution.test.ts`       |
| Définitions de steps pour un exécuteur externe | `ABSENT` (choix)    | QA-CRAWLER est l'exécuteur Gherkin : ses phrases intégrées sont les définitions ; aucune n'est produite pour un autre exécuteur                                          |
| Java JUnit 5 + Playwright Java (Maven)         | `EXISTANT_ET_TESTÉ` | `tests/integration/java-generated-tests.test.ts` lance `mvn test` quand Java et Maven sont présents (ils le sont ici)                                                    |
| JUnit XML (rapport de résultats)               | `EXISTANT_ET_TESTÉ` | `tests/unit/junit-reporter.test.ts`, `tests/integration/junit-report.test.ts`                                                                                            |
| Génération depuis le SDK                       | `EXISTANT_ET_TESTÉ` | API `/generation`, `sdk-extensions.test.ts` ; statut `STATICALLY_VALIDATED`, jamais « exécuté »                                                                          |

### F. Comparaison et régressions

| Élément                                                                | État                | Preuve / écart                                                               |
| ---------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| Différence de structure entre deux graphes                             | `EXISTANT_ET_TESTÉ` | `tests/unit/flow-diff.test.ts`, `baseline-store.test.ts`                     |
| Cycle de vie des anomalies (nouvelle, persistante, corrigée, instable) | `EXISTANT_ET_TESTÉ` | `regression-lot-c.test.ts`, `tests/integration/regression-evolution.test.ts` |
| Comparaison visuelle à seuil                                           | `EXISTANT_ET_TESTÉ` | `qa-platform-visual-regression.test.ts`                                      |
| Écart avec le run précédent (étapes, temps)                            | `EXISTANT_ET_TESTÉ` | `run-analysis.test.ts`                                                       |
| Comparaison de deux exécutions choisies, exposée au SDK                | `ABSENT`            |                                                                              |
| Vue de comparaison                                                     | `ABSENT`            |                                                                              |

### G. Traçabilité

| Élément                                                  | État                | Preuve / écart                                                     |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Sept statuts de couverture, liens explicites, historique | `EXISTANT_ET_TESTÉ` | `tests/unit/traceability.test.ts` ; jamais par ressemblance de nom |
| Exposition au SDK et vue de couverture                   | `ABSENT`            | `quality-verification.json` est écrit, rien ne le sert             |

### H. Run Monitor

| Élément                                                       | État                      | Preuve / écart                                                                                   |
| ------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| Événements réels numérotés (exploration, enregistrement)      | `EXISTANT_ET_TESTÉ`       | `sdk-server.test.ts`, `sdk-wizard.test.ts`                                                       |
| Reprise après coupure, doublons ignorés                       | `EXISTANT_MAIS_INCOMPLET` | le serveur rejoue à partir de `after` ; le client ne se reconnecte pas seul et ne déduplique pas |
| Écran de suivi avec sélection par groupe, étape, statut, type | `ABSENT`                  | l'assistant montre seulement des compteurs                                                       |

### I. API publique

| Élément                                                                                                                       | État                      | Preuve / écart                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| `createQaCrawler` typé : projets, explorations, enregistrements, groupes, assertions, génération, graphe, rapports, `dispose` | `EXISTANT_ET_TESTÉ`       | `tests/unit/sdk-core.test.ts`                      |
| Version du contrat (`apiVersion`) vérifiée par le client                                                                      | `EXISTANT_MAIS_INCOMPLET` | le serveur l'annonce ; le client ne la vérifie pas |
| Tests de compatibilité des contrats (formes figées)                                                                           | `ABSENT`                  |                                                    |

### J. Intégration visuelle

| Élément                                                                                             | État                      | Preuve / écart                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| Modes autonome / embarqué, styles isolés, couleur, nom, logo, langue, valeurs initiales, événements | `EXISTANT_ET_TESTÉ`       | `sdk-wizard.test.ts` (hôte embarqué)                             |
| Thème sombre                                                                                        | `ABSENT`                  | jetons `--qa-*` en clair seulement                               |
| Navigation clavier, états de chargement et d'erreur annoncés                                        | `EXISTANT_MAIS_INCOMPLET` | assistant seulement ; aucun contrôle automatique d'accessibilité |

### K. Sécurité et gouvernance

| Élément                                                                     | État                | Preuve                                                          |
| --------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| Jeton Bearer, origines listées, CORS restreint                              | `EXISTANT_ET_TESTÉ` | `sdk-server.test.ts`, origine refusée dans `sdk-wizard.test.ts` |
| SafetyPolicy et garde d'écriture appliquées par le moteur (jamais par l'UI) | `EXISTANT_ET_TESTÉ` | tests de la garde, `salesforce-lightning.test.ts`               |
| Rapports par ticket court, CSP `sandbox`, chemins contenus                  | `EXISTANT_ET_TESTÉ` | `sdk-server.test.ts` (`a%2Fb`, `../../etc`)                     |
| Aucun secret dans les événements, journaux, récapitulatifs                  | `EXISTANT_ET_TESTÉ` | idem                                                            |

### L. Extension

| Élément                                                        | État                  | Constat                                                                        |
| -------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| Fournisseurs de persistance, d'IA (facultatifs)                | `EXISTANT_ET_TESTÉ`   | contrats et tests de contrat du moteur ; le SDK n'exige aucun fournisseur d'IA |
| Profils de plateforme                                          | `EXISTANT_ET_TESTÉ`   | `PLATFORMS`, `readOnlyPostOf`                                                  |
| Capacités annoncées par le serveur (`capabilities.extensions`) | `EXISTANT_ET_TESTÉ`   | le client sait ce qui est branché                                              |
| Système de greffons                                            | `ABSENT` (volontaire) | non construit : les points d'extension restent des contrats simples            |

## 3. Base de référence

Mesurée sur `fb45939` (branche `feat/salesforce-lightning`, arbre propre, aucun changement local) :

| Contrôle                                                                      | Résultat                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run lint`, `typecheck`, `format:check`, `build`                          | sans erreur                                                     |
| `vitest --project unit`                                                       | 1695 / 1695                                                     |
| `vitest --project integration`                                                | 631 réussis, 1 échec connu et instable sous charge (passe seul) |
| CI GitHub (build, 3 lots d'intégration, paquet Linux et Windows, persistance) | verte sur les PR empilées #136, #137, #138                      |

Tests instables connus sous pleine charge parallèle (passent seuls) : `recording-deterministic`
TEST 9 et 10, `recording-intent-review`, `recording-sources` TEST 9. Ils ne sont ni désactivés ni
modifiés.

## 4. Architecture cible

Le SDK reste dans `src/sdk/` du paquet `@qa-crawler/core` : un monorepo multi-paquets n'apporterait
rien tant qu'un seul paquet est construit et testé (même décision que dans `AUDIT.md`). Le moteur
n'est pas déplacé.

```
src/sdk/core     contrats, client HTTP/SSE, cycle de vie, correspondances de statuts — sans DOM
src/sdk/ui       Web Components (Shadow DOM) : assistant, Flow Studio, Run Monitor, vues
                 résultats / comparaison / traçabilité — n'importent que le Core
src/sdk/server   adaptateur de confiance : appelle le moteur, applique jeton, origines, chemins
src/<moteur>     inchangé ; seules des fonctions pures existantes sont réutilisées
examples/sdk-host  page hôte réelle
```

Règles :

1. **Une seule implémentation** : chaque écran appelle une route qui appelle un module du moteur. Le
   SDK ne recalcule ni graphe, ni dépendance, ni verdict.
2. **Lecture des artefacts** pour les résultats (comparaison, traçabilité, chemin exécuté) : le
   serveur lit les fichiers JSON que le moteur écrit déjà ; une valeur absente est dite absente.
3. **Statuts publics** : une table de correspondance publiée, testée, du vocabulaire du moteur vers
   celui du SDK (`PASS → VERIFIED_PASS`, …). `NOT_EXECUTED` ne vient que d'une absence de résultat.
4. **Compatibilité** : `apiVersion` vérifiée par le client ; ajouts seulement (jamais de champ
   retiré ou renommé) ; un test fige les formes publiques.
5. **Sécurité** : tout contrôle reste dans `src/sdk/server` ou le moteur ; l'UI n'en est jamais la
   seule barrière.

## 5. Risques

| Risque                                                          | Parade                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Le graphe devient illisible avec beaucoup d'étapes              | hiérarchie groupes → étapes, groupes repliables, recherche, ajustement de vue ; mesure sur un flow de 150 étapes    |
| Un déplacement de nœud passe pour une modification du parcours  | la position est une préférence d'affichage ; l'ordre ne change que par une commande de groupe validée par le moteur |
| Définitions de steps Gherkin sans exécuteur disponible          | ne déclarer « exécutable » que si un test a joué la sortie dans ce dépôt                                            |
| Lancement de `playwright test` sur la sortie générée lent en CI | un seul échantillon, sur l'application de test locale                                                               |
| Instabilité des tests d'intégration sous charge                 | nouveaux tests sur des fixtures locales, attentes sur des événements, jamais sur du temps                           |
| Contrats cassés pour les hôtes existants                        | ajouts seulement, test de formes                                                                                    |

## 6. Plan

| Phase | Contenu                                                                                                                                                                                                      | État au moment de l'audit                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 0     | ce document                                                                                                                                                                                                  | fait                                                                 |
| 1     | Core : vérification d'`apiVersion`, reconnexion SSE avec reprise `after` et déduplication par `seq`, test de formes des contrats (correspondance des statuts d'assertion : phase 4)                          | fait                                                                 |
| 2     | Assistant : déjà livré (PR #136, #138) ; rien d'autre que les écarts de la phase 1                                                                                                                           | fait                                                                 |
| 3     | Flow Studio : routes dépendances et chemin exécuté ; `<qa-crawler-flow-studio>` (graphe SVG interactif, groupes, panneau, recherche, ajustement, erreurs et dépendances, chemin exécuté, éditeur de groupes) | fait (sauf : jouer un groupe seul)                                   |
| 4     | Données (routes de lignée et de liaison, éditeur) ; assertions (verdicts publics, éditeur dans le Studio)                                                                                                    | fait                                                                 |
| 5     | Générateurs : mission qui joue le `.feature`, configuration Playwright (JUnit XML), exécution réelle des deux sorties ; correctifs trouvés en les exécutant (première correspondance, gabarit de route)      | fait (sauf : définitions de steps pour un exécuteur Gherkin externe) |
| 6     | Comparaison de deux exécutions et traçabilité : routes et vues                                                                                                                                               | à faire                                                              |
| 7     | Thème sombre, accessibilité, Run Monitor, exemple hôte complet, documentation, rapport final                                                                                                                 | à faire                                                              |
