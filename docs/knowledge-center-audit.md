# Knowledge Center — audit de l'existant (avant implémentation)

Diagnostic bref de l'architecture de QA-CRAWLER telle qu'elle est sur `main`, fait avant d'écrire la
première ligne du Knowledge Center. Il dit ce qui existe, ce qui manque, et les décisions prises.

## 1. Les surfaces d'interface existantes

| Surface              | Technologie                                                                                             | Où                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Ligne de commande    | TypeScript (Node ≥ 20), `node:util.parseArgs`, codes de sortie 0 / 1 / 2 / 3                            | `src/cli/*`, façade `packages/cli`         |
| Rapports HTML        | HTML statique généré en TypeScript, thème commun (`theme.ts` : jetons CSS clair / sombre, logo, bouton) | `src/reporting/*`                          |
| Fenêtre du recorder  | Page Playwright (`page.setContent`), HTML + CSS + JS inline dans un gabarit TypeScript, thème commun    | `src/recording/recorder-panel-html.ts`     |
| Applications de démo | `node:http` (`createServer`), sans framework                                                            | `tests/fixtures/*-app.ts`, `serve-demo.ts` |

**Il n'y a ni application frontend (pas d'Angular, pas de React), ni serveur HTTP dans `src/`, ni
mécanisme d'authentification d'interface.** Les conventions graphiques sont celles du thème QA-CRAWLER
(`THEME_TOKENS_CSS`, `brandBlock`, `themeToggle`) et des rapports (`BASE_CSS` : cartes, tableaux,
pastilles, sections). Les seules bibliothèques de production sont Playwright, zod, yaml et Gherkin.

Conséquence : « intégrer le dashboard à l'application existante » signifie ici **une nouvelle commande
de la CLI qui sert, avec `node:http` (déjà utilisé par les fixtures, aucune dépendance nouvelle), une page
construite comme la fenêtre du recorder et les rapports** (même thème, même technique), et une API JSON
locale branchée sur les services réels. Un framework frontend serait une technologie concurrente de
l'existant : écarté.

## 2. Où vit la Knowledge (quatre lieux, tous réels)

| Lieu                                                                                              | Contenu                                                                                                                                                                                                                                                                                                            | Accès                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Persistance** (`persistence.enabled`) : mémoire, fichier JSON, SQLite, PostgreSQL, SQL Server   | 7 tables : `crawl_run`, `run_state`, `run_transition`, `transition_knowledge` (mémoire historique : une ligne par écran + action + destination, compteurs vu / succès / échec / bloqué, durée moyenne, dates, dernier contexte), `flow_evolution`, `anomaly_lifecycle`, `flow_memory` (une ligne par sorte et clé) | `PersistenceProvider` → repositories `runs`, `states`, `transitions`, `knowledge`, `evolution`, `anomalies`, `memory` |
| **Base de connaissances fichier** `knowledge/knowledge-base.json` (`JsonKnowledgeBase`, schéma 1) | par application + environnement : `actions`, `transitions`, `api`, `performance`, `hints`, `recoveries`, `cognitive` (hypothèses, preuves, invariants, échecs), `flowRuns`, `actorAccess`, `performanceHistory`, `targetResolutions`                                                                               | lecture par `migrateKnowledge` (migration v0 → v1), écriture atomique                                                 |
| **Connaissance fonctionnelle** `knowledge/functional/functional-<hash>.json`                      | `entries` (transitions, workflows, invariants, chemins d'erreur, objectifs : confirmations / échecs), `learned` (workflows, états, transitions appris du réseau), `fieldMappings` (champ ↔ propriété, validés par un enregistrement), `intentDecisions` (décisions humaines, par contexte), `intentPatterns`       | `FunctionalKnowledgeStore` (un fichier par application + environnement)                                               |
| **Règles** `knowledge/rules/rules-<hash>.json`, cache statique `knowledge/static/`                | règles et leurs vérifications (confirmations / contradictions) ; analyses statiques par empreinte                                                                                                                                                                                                                  | `RuleKnowledgeStore`                                                                                                  |
| **Enregistrements** `recordings/<nom>/`                                                           | `recorded-flow.json` (étapes, `{ testData: clé }`, citations `${testData:…}`), `test-data.yaml` (jeu de données : stratégie, générateur, référence, sensibilité), `human-review.json` (liaisons décidées par l'humain)                                                                                             | `dataLineage` / `availableVariables` (`test-data-binding.ts`) : producteur, consommateurs                             |

Les modes de mémoire sont tranchés par l'orchestrateur (`memoryModeOf`) : `legacy` (pas de
`memory.enabled` : la base fichier, comme toujours), `isolated` (`memory.enabled: false` : rien d'ancien),
`current-run`, `historical` (l'historique du provider préchargé dans la mémoire de travail, dans un
budget). Le moteur ne lit **jamais** la base directement : il lit la mémoire de travail (RAM).

## 3. Ce que l'existant sait faire, et ce qu'il ne sait pas

| Attente du Knowledge Center                | Existant                                                                                                                              | Manque                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Lister les connaissances d'une application | `knowledge.load(applicationId, limit)`, `runs.list`, `evolution.load`, `anomalies.load`, `memory.search`                              | **aucune liste des applications** connues du provider ; aucun comptage ; pas de recherche texte côté stockage                   |
| Détail, provenance, preuves                | compteurs, dates, dernier contexte, `runId` des runs ; fichiers par application                                                       | pas d'identifiant stable commun à toutes les connaissances                                                                      |
| Statut de validation, confiance            | `confirmations` / `contradictions` (fonctionnel, règles), `successCount` / `failureCount` (transitions, actions), `Hypothesis.status` | **aucun statut de validation humaine**, aucune mesure de confiance unifiée (celle des hypothèses est propre au moteur cognitif) |
| Historique des modifications               | `flowRuns`, `performanceHistory`, `flow_evolution` (par run), dates de première / dernière vue                                        | **aucun journal des opérations** de gestion (validation, import, restauration)                                                  |
| Import / export / sauvegarde               | le provider fichier écrit un JSON par table ; `knowledge-base.json` est un fichier versionné                                          | aucune opération d'export versionné, d'import validé, de sauvegarde ni de restauration                                          |
| Modifier / supprimer une connaissance      | `record` (incréments), `save` (remplacement par clé) pour `evolution`, `anomalies`, `memory`                                          | `KnowledgeRepository` n'a ni suppression ni remplacement : une ligne de `transition_knowledge` ne se corrige pas                |
| Sécurité                                   | redaction de tout texte persisté (`sanitize.ts`), identifiants de base jamais dans le YAML                                            | rien pour une interface (pas de session, pas de jeton)                                                                          |

## 4. Décisions

1. **Pas de seconde Knowledge.** Le Knowledge Center lit les quatre lieux ci-dessus par leurs modules
   existants (`openPersistence`, `migrateKnowledge`, `FunctionalKnowledgeStore`, `RuleKnowledgeStore`,
   `dataLineage`) et présente chaque connaissance sous une **forme unifiée** (`KnowledgeItem` : identifiant
   stable dérivé de la clé réelle, type, application, environnement, dates, origine, preuves, source).
2. **Inventaire des applications** : une capacité facultative ajoutée au `PersistenceProvider`
   (`inventory?: { applications(), counts(applicationId) }`), implémentée pour les providers mémoire / fichier
   (tables) et base de données (`GROUP BY application_id`). Facultative : un provider externe qui ne l'a pas
   affiche « Non disponible ».
3. **Statuts de fiabilité calculés, jamais inventés** : `OBSERVED`, `CONFIRMED`, `FRAGILE`, `CONTRADICTED`,
   `STALE`, `HYPOTHESIS`, avec des formules écrites dans la documentation, à partir des compteurs réels. Pas
   de propriété `confidence` ajoutée au modèle.
4. **Décisions humaines dans un registre à part** (`<knowledge>/knowledge-center/review-ledger.json`,
   ajout seul, écriture atomique, version par connaissance pour les modifications concurrentes) : validation,
   invalidation, note. Elles ne changent **rien** aux décisions du moteur (qui ne lit pas ce registre) ;
   elles sont montrées, exportées et historisées. Évolution maîtrisée : aucun schéma de base modifié.
5. **Import / export versionnés** (`format: qa-crawler-knowledge-export`, `version: 1`) avec validation
   zod, aperçu (nouveaux / identiques / conflits) avant application, et une politique explicite : les lignes
   de `transition_knowledge` ne sont importées que si la clé est absente (`record` ne sait qu'ajouter) ;
   les lignes remplaçables (`evolution`, `anomalies`, `memory`) le sont seulement sur choix explicite.
   Sauvegarde = export écrit sur disque avant toute restauration ; restauration = import d'une sauvegarde,
   et le résultat dit exactement ce qui a été restauré et ce qui ne l'a pas été.
6. **Lecture seule par défaut pour tout ce qui touche la configuration** : le Knowledge Center affiche la
   configuration effective (`persistence`, `memory`) et ne l'active jamais. Modifier la configuration reste
   l'affaire des fichiers YAML et des options de la CLI (comme aujourd'hui).
7. **Sécurité** : serveur lié à `127.0.0.1` ; les opérations d'écriture exigent un jeton généré au
   démarrage (porté par la page, demandé en en-tête) et un en-tête personnalisé ; `--read-only` les
   désactive toutes ; l'origine des requêtes est vérifiée ; aucun secret (identifiants de base, variables
   d'environnement) n'est jamais lu ni affiché.

## 5. Ce que l'implémentation n'essaie pas de faire

- Modifier les compteurs d'une connaissance (ils sont des observations) ni supprimer une ligne de
  `transition_knowledge` : non supporté par les repositories ; dit tel quel dans l'interface.
- Reconstituer une connaissance absente : une donnée qui manque est affichée « Non disponible ».
- Un service distant HTTP / gRPC : le dashboard lit un `PersistenceProvider` ; un adaptateur distant serait
  un provider de plus (point d'extension existant), pas une dépendance du dashboard.
