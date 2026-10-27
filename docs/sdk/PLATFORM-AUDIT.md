# Plateforme QA-CRAWLER : audit du SDK central et du dashboard

Point de départ : `main` au commit `be37a8c` (PR #140 fusionnée), branche de travail `feat/sdk-platform`.
Cet audit complète `docs/sdk/MASTER-AUDIT.md` (phases 0 à 7 du SDK embarquable) : il ne répète pas
ce qui y est établi. Il part de ce que le code fait aujourd'hui, avec une preuve pour chaque statut.

Statuts :

- `EXISTANT_ET_TESTÉ` : le code existe et un test exécuté couvre ce comportement ;
- `EXISTANT_MAIS_INCOMPLET` : une partie existe, le reste manque (dit ci-dessous) ;
- `ABSENT` : rien dans le code ;
- `À_VALIDER` : du code existe, mais aucun test ne prouve encore le comportement demandé.

## 1. Le dépôt

| Élément             | Constat                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Langage, build      | TypeScript (Node ≥ 20), `tsc -p tsconfig.build.json` vers `packages/core/dist`, deux paquets (`@qa-crawler/core`, `@qa-crawler/cli`), Vitest (projets `unit`, `integration`, `packaging`). |
| Moteur              | `runMission` (`src/orchestrator.ts`) : exploration, flows imposés (rejeu), analyses, rapports ; Playwright Chromium (`src/browser/browser-manager.ts`).                                    |
| Enregistrement      | `runRecording` (`src/recording/record-orchestrator.ts`), fenêtre du recorder, normalisation, données de test, assertions proposées, groupes métier.                                        |
| Projets             | Format `qa-crawler.config.yaml` (`src/project/project-config.ts`) ; `loadProjectMission(project, { command })` construit la mission d'un projet (`explore`, `replay`, `record`…).          |
| CLI                 | `qa-crawler init / record / replay / explore / analyze / test-api / reproduce / generate-tests / knowledge-center / sdk-server` (`src/cli/`).                                              |
| SDK                 | `src/sdk/core` (client navigateur, contrats, `SDK_API_VERSION = 1`), `src/sdk/server` (serveur HTTP local, jeton, origines), `src/sdk/ui` (Web Components sans framework).                 |
| Interfaces web      | Composants SDK (assistant, Flow Studio, comparaison, Run Monitor) ; Knowledge Center (`src/knowledge-center`, serveur et pages propres).                                                   |
| Persistance moteur  | `src/persistence` : off, memory, file, sqlite, postgres, sqlserver (connaissance, mémoire des flows, historique).                                                                          |
| Persistance du SDK  | Fichiers par projet dans l'espace de travail : `<workspace>/<id>/qa-crawler.config.yaml`, `sdk-project.json`, `qa-reports/` (runs, enregistrements).                                       |
| Sécurité            | `src/policies` (SafetyPolicy, write guard, origines, champs sensibles), `src/security/redactor.ts` ; le serveur SDK exige un jeton et une origine autorisée.                               |
| IA                  | Optionnelle (`ai.mode: OFF` par défaut) ; toute proposition passe par la SafetyPolicy et la validation déterministe.                                                                       |
| Interface existante | Aucun framework front : les composants sont des Web Components en TypeScript compilé, avec rendu par fonctions pures. Le dashboard suivra la même technologie.                             |
| État Git            | Arbre propre, aucune PR ouverte. Le travail local non poussé d'un poste (vu sur captures) n'est pas visible ici : il n'est ni lu ni écrasé.                                                |

## 2. Base de référence (commandes exécutées)

- `npm run -s lint`, `npx tsc --noEmit`, `npm run -s format:check`, `npm run -s build` : OK.
- `npx vitest run --project unit` : 1760/1760 (174 fichiers), sur le même arbre que `main`.
- Intégration du recorder (25 fichiers, un par un) : tous verts lors de la PR #140.
- Intégration SDK et plateforme (`sdk-*`, `knowledge-center`, `qa-platform`, `java-generated-tests`) :
  relancée pour cet audit ; le résultat est consigné dans le rapport de phase.
- CI GitHub de `main` : verte jusqu'à `6fb5888` ; celle de `be37a8c` est en cours au moment de l'audit.

## 3. Cartographie des capacités

### 3.1 Projets

| Capacité                                    | Statut                    | Preuve / manque                                                                                     |
| ------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| Créer un projet (validé par le moteur)      | `EXISTANT_ET_TESTÉ`       | `POST /api/projects`, `validateDraft` ; `tests/unit/sdk-project.test.ts`, `sdk-wizard.test.ts`.     |
| Valider un brouillon (URL, variables, auth) | `EXISTANT_ET_TESTÉ`       | `POST /api/projects/validate`, `POST /api/checks/url                                                | env`. |
| Obtenir un projet                           | `EXISTANT_ET_TESTÉ`       | `GET /api/projects/:id`.                                                                            |
| Lister les projets                          | `ABSENT`                  | aucune route ; les projets sont des dossiers de l'espace de travail.                                |
| Modifier la configuration                   | `ABSENT`                  | le brouillon est écrit une fois, à la création.                                                     |
| Dupliquer sans secret                       | `ABSENT`                  | (le brouillon ne contient que des noms de variables : une copie est sans secret par construction).  |
| Archiver                                    | `ABSENT`                  | —                                                                                                   |
| Scénarios, exécutions, rapports d'un projet | `EXISTANT_MAIS_INCOMPLET` | `reports.list` liste runs et enregistrements ; pas de vue « projet » qui les réunit avec compteurs. |

### 3.2 Environnements

| Capacité                                                   | Statut                    | Preuve / manque                                                                                       |
| ---------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| URL de base, départ, authentification du projet            | `EXISTANT_ET_TESTÉ`       | brouillon de l'assistant → `application.*`, `auth` (noms de variables seulement).                     |
| Plusieurs environnements nommés (dev, test, cert, préprod) | `ABSENT`                  | un projet n'a qu'une cible.                                                                           |
| Domaines autorisés                                         | `EXISTANT_MAIS_INCOMPLET` | moteur : `safety.allowedHosts` validé par `config-loader` ; non exposé par le SDK.                    |
| Délais et limites                                          | `EXISTANT_MAIS_INCOMPLET` | budget d'exploration dans le brouillon ; pas par environnement.                                       |
| Variables non secrètes                                     | `ABSENT`                  | —                                                                                                     |
| Secrets                                                    | `EXISTANT_ET_TESTÉ`       | seulement des noms de variables d'environnement, lues côté serveur (`ENV_MISSING`), jamais renvoyées. |

### 3.3 Exploration

| Capacité                                    | Statut                    | Preuve / manque                                                                   |
| ------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Lancer, suivre (SSE avec reprise), résultat | `EXISTANT_ET_TESTÉ`       | `ExplorationManager`, `sdk-wizard.test.ts`, `sdk-monitor.test.ts`.                |
| Écrans, anomalies, graphe, rapports         | `EXISTANT_ET_TESTÉ`       | `summary`, `graph.exploration`, `reports.link`.                                   |
| Arrêter (annulation contrôlée)              | `EXISTANT_ET_TESTÉ`       | ajouté depuis l'audit : `explorations.cancel`, signal du moteur.                  |
| Suspendre, reprendre                        | `ABSENT`                  | le moteur ne suspend pas une mission.                                             |
| Suivi après redémarrage du serveur          | `EXISTANT_MAIS_INCOMPLET` | l'état vivant est en mémoire ; les résultats restent sur disque (`reports.list`). |

### 3.4 Enregistrements et Flow Studio

| Capacité                                             | Statut                    | Preuve / manque                                                                                |
| ---------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| Enregistrer, lister, flow, Studio, groupes, liaisons | `EXISTANT_ET_TESTÉ`       | `sdk-extensions.test.ts`, `sdk-studio.test.ts`.                                                |
| Groupes proposés, vérification de groupe             | `EXISTANT_ET_TESTÉ`       | moteur + fenêtre du recorder (PR #140) ; pas encore exposés par le SDK.                        |
| Valider les cibles sans agir                         | `EXISTANT_MAIS_INCOMPLET` | moteur : validation à sec des cibles pendant l'enregistrement ; pas d'appel SDK hors session.  |
| Conditions et branches                               | `ABSENT`                  | le format des flows est séquentiel.                                                            |
| Versions des parcours                                | `ABSENT`                  | les fichiers sont réécrits ; la mémoire des flows du moteur garde l'historique des exécutions. |
| Transformer en scénario exploitable                  | `EXISTANT_MAIS_INCOMPLET` | `generated.flow.yaml` ; pas de promotion vers `qa-crawler/flows/` par le SDK.                  |

### 3.5 Exécutions (rejeu)

| Capacité                           | Statut                    | Preuve / manque                                                                            |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Rejouer les flows d'un projet      | `EXISTANT_ET_TESTÉ`       | moteur : `qa-crawler replay` = `loadProjectMission({ command: 'replay' })` + `runMission`. |
| Lancer un rejeu depuis le SDK      | `ABSENT`                  | le SDK ne rejoue qu'en enregistrant (`validate`).                                          |
| Lister et consulter les exécutions | `EXISTANT_MAIS_INCOMPLET` | `reports.list` (runs) ; pas de vue des flows, étapes, assertions et preuves d'un run.      |
| Annuler                            | `EXISTANT_ET_TESTÉ`       | ajouté depuis l'audit, comme l'exploration.                                                |
| Comparer deux exécutions           | `EXISTANT_ET_TESTÉ`       | `reports.compare` (`sdk-runs.test.ts`).                                                    |

### 3.6 Données, assertions, traçabilité, régressions

| Capacité                                          | Statut              | Preuve                                                                                 |
| ------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| Lignée des données, liaison entre étapes          | `EXISTANT_ET_TESTÉ` | `data.get`, `data.bind` ; rejeu avec la valeur du run (`recording-test-data-binding`). |
| Propositions d'assertions et décisions            | `EXISTANT_ET_TESTÉ` | `assertions.list/decide`, verdicts du dernier rejeu.                                   |
| Assertions métier exécutées sur le réseau observé | `EXISTANT_ET_TESTÉ` | `BusinessAssertionEngine` ; `NOT_EXECUTED` sans exécution.                             |
| Traçabilité (`NOT_COVERED` … `STALE_EVIDENCE`)    | `EXISTANT_ET_TESTÉ` | `reports.traceability`.                                                                |
| Régression d'un run                               | `EXISTANT_ET_TESTÉ` | `reports.regression`.                                                                  |

### 3.7 Génération et rapports

| Capacité                                         | Statut              | Preuve                                                                                   |
| ------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------- |
| Playwright TS, Gherkin, YAML, Java (plan commun) | `EXISTANT_ET_TESTÉ` | `generation-plan.ts`, `sdk-generated-execution.test.ts`, `java-generated-tests.test.ts`. |
| JUnit XML (rapport)                              | `EXISTANT_ET_TESTÉ` | `junit-reporter.ts`.                                                                     |
| Rapports HTML/JSON par run                       | `EXISTANT_ET_TESTÉ` | `reports.link`.                                                                          |

### 3.8 Vue d'ensemble et dashboard

| Capacité                                        | Statut              | Manque                                                                             |
| ----------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| Indicateurs calculés (projets, runs, réussite…) | `ABSENT`            | aucune agrégation multi-projets.                                                   |
| Dashboard autonome (navigation, sections)       | `ABSENT`            | le serveur SDK sert l'assistant (`/`), le Studio, la comparaison, le Run Monitor.  |
| Knowledge Center                                | `EXISTANT_ET_TESTÉ` | autre serveur, autre périmètre (connaissance du moteur) ; à relier, pas à refaire. |

## 4. Décisions d'architecture

1. **Le SDK reste celui de `src/sdk`** : même contrat (`SDK_API_VERSION = 1`, ajouts seulement), même
   serveur, même jeton. Aucun second SDK.
2. **L'adaptateur, c'est `src/sdk/server`** : il appelle `loadProjectMission`, `runMission`,
   `runRecording` et les modules de lecture des artefacts. Le SDK ne recalcule rien que le moteur
   fournit déjà.
3. **Une exécution est une mission du moteur** : le rejeu réutilise la mécanique des explorations
   (`Exploration` : file d'attente, événements numérotés, SSE avec reprise). Seule la mission change
   (`command: 'replay'`).
4. **Le dashboard est un Web Component** (`<qa-crawler-dashboard>`), comme les autres composants, qui
   n'utilise que le client SDK et réutilise l'assistant, le Studio, la comparaison et le Run Monitor.
5. **Persistance** : fichiers de l'espace de travail, comme aujourd'hui. Les environnements vont dans
   la fiche du projet ; un run lancé par le SDK reçoit une fiche `sdk-execution.json`.
6. **Pas d'identité ni de permissions** : le serveur protège par jeton et origine. Aucun système de
   rôles n'est prétendu.

## 5. Plan

| Phase | Contenu                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | SDK : liste, modification, duplication, archivage des projets ; environnements (validés, appliqués aux runs) ; exécutions (rejeu par le moteur, suivi, détail) ; vue d'ensemble calculée. |
| 2     | Dashboard clair : navigation, vue d'ensemble, projets, environnements, assistant de création réutilisé.                                                                                   |
| 3     | Exploration (lancement, suivi, résultats) et enregistrements / Flow Studio dans le dashboard ; promotion d'un enregistrement en scénario ; rejeu.                                         |
| 4     | Données, assertions, traçabilité, régressions dans le dashboard (réutilise la comparaison et la traçabilité).                                                                             |
| 5     | Génération et rapports dans le dashboard ; exports réels.                                                                                                                                 |
| 6     | Exemple hôte mis à jour (dashboard embarqué), documentation d'intégration.                                                                                                                |
| 7     | Stabilisation : bout en bout, accessibilité, performance, bilan.                                                                                                                          |

Hors d'atteinte sans travail moteur : l'**annulation** d'une mission (le moteur n'avait pas d'arrêt
à la demande) et les **branches conditionnelles** dans les flows. L'annulation a depuis été ajoutée
au moteur (`RunOptions.signal`, `stopReason: cancelled`) ; les branches conditionnelles restent
`ABSENT`.

## 6. Phase 1 — livré

| Capacité                                                              | Statut après la phase 1 | Preuve                                                                                                            |
| --------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lister, détailler, modifier, dupliquer, archiver, restaurer un projet | `EXISTANT_ET_TESTÉ`     | `tests/unit/sdk-platform.test.ts` ; archivage refusé à l'exécution dans `tests/integration/sdk-platform.test.ts`. |
| Environnements nommés, validés, appliqués à la mission                | `EXISTANT_ET_TESTÉ`     | unitaire (règles, secrets, isolation) ; intégration (deux instances, une seule écrite).                           |
| Écritures permises par environnement                                  | `EXISTANT_ET_TESTÉ`     | intégration : `mutations.enabled` permet la création, bornée par run.                                             |
| Scénarios du projet, promotion d'un enregistrement                    | `EXISTANT_ET_TESTÉ`     | unitaire (fichiers copiés, origine gardée).                                                                       |
| Lancer un rejeu, le suivre, lire son détail                           | `EXISTANT_ET_TESTÉ`     | intégration : vrai moteur, événements `flow` / `flow-step`, verdict, assertion `PASS` puis `FAIL`.                |
| Vue d'ensemble calculée                                               | `EXISTANT_ET_TESTÉ`     | unitaire (périmètre du taux, alertes) ; intégration (2 rejeux, 50 %).                                             |
| Annuler une exécution (ajouté ensuite, voir ci-dessous)               | `EXISTANT_ET_TESTÉ`     | `explorations.cancel` → signal du moteur ; unitaire, intégration (vrai moteur, SDK et CLI Ctrl+C → 130).          |
| Authentification propre à un environnement                            | `ABSENT`                | l'environnement change la cible, pas l'authentification du projet.                                                |
| Dashboard                                                             | `ABSENT`                | phase 2.                                                                                                          |

La suite (SDK central, CLI, Dashboard, traçabilité métier, génération) : [MASTER-PLAN.md](MASTER-PLAN.md)
et [adr/0001-sdk-central.md](adr/0001-sdk-central.md).
