# Knowledge Center — documentation technique

Le Knowledge Center est le tableau de bord de la mémoire de QA-CRAWLER : il montre, explique et permet
de gérer ce que l'outil a appris d'une application (transitions, actions, règles, hypothèses, flows,
variables des enregistrements), à partir des **données réelles** du projet. Il ne calcule rien que le
moteur ne sache déjà, n'invente aucune valeur (ce qui manque est affiché « Non disponible ») et ne change
jamais les décisions du moteur.

Le diagnostic qui a précédé l'implémentation est dans [knowledge-center-audit.md](knowledge-center-audit.md).

## 1. Lancer

```bash
# dans un projet initialisé (qa-crawler.config.yaml cherché vers le haut)
npx qa-crawler knowledge-center
# sur un fichier de mission (usage historique)
npm run qa -- knowledge-center -c scenarios/persistence-file.yaml
# consultation seule, autre port, langue anglaise
npx qa-crawler knowledge-center --read-only --port 4191 --language en
```

| Option                | Effet                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `-c, --config <f>`    | fichier de mission ; sinon la configuration du projet (`qa-crawler.config.yaml`)          |
| `--cwd <dir>`         | dossier du projet (défaut : dossier courant)                                              |
| `--reports-dir <dir>` | dossier des rapports de la mission (les enregistrements sont lus sous `<dir>/recordings`) |
| `--host <adresse>`    | adresse d'écoute (défaut `127.0.0.1` ; une autre adresse expose le tableau de bord)       |
| `--port <n>`          | port (défaut `4190` ; `0` : un port libre)                                                |
| `--read-only`         | aucune décision, import, sauvegarde ni restauration                                       |
| `--stale-days <n>`    | une connaissance non revue depuis plus de n jours est `STALE` (défaut 90)                 |
| `--limit <n>`         | lignes lues au plus par table (défaut 20 000)                                             |
| `--language <fr\|en>` | langue de la page (défaut : `report.language` de la mission)                              |
| `--token <valeur>`    | jeton de session des opérations d'écriture (défaut : généré et affiché)                   |
| `--quiet`             | seulement l'adresse                                                                       |

Codes de sortie : `0` arrêt normal (Ctrl+C), `2` erreur d'arguments ou de configuration, `3` persistance
indisponible (`failureMode: fail`) ou port occupé.

La persistance est ouverte **exactement comme un run l'ouvre** (`openPersistence` : `persistence.enabled`,
provider, repli). La configuration `memory` est lue et affichée, jamais modifiée : le tableau de bord
n'active ni la mémoire ni la persistance.

## 2. Architecture

```
src/cli/knowledge-center-command.ts   commande CLI (arguments, configuration effective, serveur, signaux)
src/knowledge-center/
  model.ts         types partagés serveur ↔ page (KnowledgeItem, Metric, DTO des vues, export)
  reliability.ts   statuts de fiabilité calculés à partir des compteurs (règles ci-dessous)
  sources.ts       lecteurs des quatre lieux de la Knowledge → KnowledgeItem (identifiant stable)
  recordings.ts    enregistrements : flows, jeu de données, lignée des variables (dataLineage)
  review-ledger.ts registre des décisions humaines et des opérations (ajout seul, versions)
  context.ts       ouverture : persistance, identité de l'application, dossiers, registre
  service.ts       KnowledgeCenterService : vues, recherche paginée, décisions (cache 5 s)
  exchange.ts      export versionné, aperçu / import, sauvegardes, restauration
  server.ts        serveur node:http : page + API JSON, autorisation, limites
  page.ts          la page (HTML + CSS + JS vanilla, thème QA-CRAWLER, routage par #)
```

Couches : la page ne parle qu'à l'API JSON ; l'API ne parle qu'au service ; le service lit les
repositories du `PersistenceProvider` et les fichiers par leurs modules existants (`migrateKnowledge`,
`FunctionalKnowledgeStore`, `RuleKnowledgeStore`, `parseTestDataSet`, `dataLineage`). Aucun repository
ni provider n'est dupliqué. Le moteur (orchestrateur, explorer, mémoire de travail) n'importe rien de
`src/knowledge-center/` et ne lit pas le registre des décisions.

### Les quatre lieux lus

| Lieu                                                                                                                                   | Types produits                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| persistance (`transition_knowledge`, `flow_evolution`, `anomaly_lifecycle`, `flow_memory`, `crawl_run`, `run_state`, `run_transition`) | `TRANSITION`, `EVOLUTION`, `ANOMALY`, `FLOW_MEMORY` ; runs, états, transitions des vues Flows                                 |
| `knowledge/knowledge-base.json`                                                                                                        | `ACTION`, `TRANSITION`, `API`, `PERFORMANCE`, `HINT`, `RECOVERY`, `TARGET_RESOLUTION`, `HYPOTHESIS`, `INVARIANT`, `FLOW_RUN`  |
| `knowledge/functional/functional-<hash>.json`                                                                                          | `FUNCTIONAL`, `LEARNED_WORKFLOW`, `LEARNED_STATE`, `LEARNED_TRANSITION`, `FIELD_MAPPING`, `INTENT_DECISION`, `INTENT_PATTERN` |
| `knowledge/rules/rules-<hash>.json`                                                                                                    | `RULE`                                                                                                                        |
| `<reportsDir>/recordings/<nom>/`                                                                                                       | flows enregistrés, variables (`test-data.yaml`), liaisons humaines (`human-review.json`)                                      |

Chaque connaissance reçoit un identifiant stable `<type>-<sha256(source, type, application, environnement, clé réelle)>`
: la même ligne garde le même identifiant d'un démarrage à l'autre, ce qui permet au registre des
décisions de la retrouver.

### Ajout au modèle existant

- `PersistenceProvider.inventory?: InventoryRepository` (facultatif) : `applications()` donne les
  applications connues et leurs comptages par table. Implémenté par les providers mémoire / fichier
  (comptage des tables) et base de données (`GROUP BY application_id`). Un provider sans inventaire
  affiche « Non disponible ». Aucun schéma de base ni fichier de connaissance existant n'est modifié.
- `functionalKnowledgeFile()` et `ruleKnowledgeFile()` exportés par les stores (le chemin que le moteur
  utilise, calculé par le même code).

## 3. Les vues

| Vue                 | Contenu                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vue d'ensemble      | métriques avec leur formule (infobulle), état de la mémoire et de la persistance, derniers runs, dernières connaissances, connaissances à vérifier, avertissements                                |
| Knowledge Explorer  | recherche texte, type, statut, origine, source, décision ; tri ; pagination côté serveur ; détail (preuves, provenance, historique, exécutions des derniers runs) ; valider / invalider / annoter |
| Flows & transitions | flows (enregistrements + mémoire de flow), runs, états, transitions ; graphe SVG interactif (zoom, déplacement, clic → détail)                                                                    |
| Variables           | variables des enregistrements : producteur, consommateurs, liaisons de champ ; problèmes détectés (jamais corrigés automatiquement)                                                               |
| Qualité             | répartition par statut de fiabilité, signaux (définition écrite à côté de chaque chiffre)                                                                                                         |
| Historique          | journal des opérations (décisions, sauvegardes, imports, restaurations), versions des connaissances                                                                                               |
| Persistance         | état réel du provider (santé mesurée au chargement), comptages par table, schéma, export, import (aperçu puis import), sauvegardes, restauration                                                  |

### Formules de la vue d'ensemble

| Métrique                      | Formule                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Connaissances                 | toutes les lignes lues : tables de persistance + fichier de connaissance + fichier fonctionnel + règles |
| Flows                         | noms de flow distincts : enregistrements + flows rejoués (mémoire de flow)                              |
| États                         | signatures d'écran distinctes des transitions (origine et destination)                                  |
| Transitions                   | lignes de connaissance de transition (persistance + fichier)                                            |
| Validées / invalidées         | lignes portant une décision humaine `VALIDATED` / `INVALIDATED` dans le registre                        |
| À vérifier                    | lignes `FRAGILE`, `CONTRADICTED`, `HYPOTHESIS` ou `UNVERIFIED` sans décision humaine                    |
| Obsolètes                     | lignes non revues depuis plus de `--stale-days` jours                                                   |
| Runs persistés                | lignes de `crawl_run` de l'application (inventaire du provider)                                         |
| Taux de réutilisation         | transitions vues au moins deux fois / toutes les transitions, en pourcentage                            |
| Dernière persistance          | `lastSeenAt` le plus récent des lignes persistées                                                       |
| Dernier apprentissage         | `updatedAt` (ou `createdAt`) le plus récent de toutes les lignes                                        |
| Erreurs de persistance        | opérations du registre (import, restauration) ayant signalé des erreurs                                 |
| Runs ayant utilisé la mémoire | **Non disponible** : le provider n'enregistre pas si un run a lu la mémoire                             |

### Statuts de fiabilité (`reliability.ts`)

Calculés à partir des compteurs réels de chaque ligne (`seen`, `executions`, `failures`, `blocked`,
`confirmations`, `contradictions`, dernière date), dans cet ordre ; `minObservations` est celui de la
mission (`knowledge.minObservations`).

| Statut         | Règle                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `HYPOTHESIS`   | produite par une analyse (hypothèse du moteur cognitif), jamais confirmée par une exécution                 |
| `CONTRADICTED` | `contradictions > 0` et `contradictions ≥ confirmations` ; ou au moins 2 exécutions avec ≥ 50 % d'échecs    |
| `STALE`        | dernière vue il y a plus de `staleAfterDays` jours                                                          |
| `CONFIRMED`    | `executions ≥ minObservations` et ≤ 10 % d'échecs ; ou `confirmations ≥ minObservations` sans contradiction |
| `FRAGILE`      | au moins une exécution et au moins un échec (entre 10 % et 50 %) ; ou bloquée plus souvent qu'exécutée      |
| `OBSERVED`     | vue, exécutée ou confirmée au moins une fois, sans atteindre `minObservations`                              |
| `UNVERIFIED`   | aucune preuve utilisable                                                                                    |

Aucune propriété `confidence` n'est ajoutée au modèle ; une décision humaine est une **annotation** qui
ne change pas le statut calculé (les deux sont affichés).

### Signaux de qualité

| Signal                           | Définition                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `FAILING_SELECTORS`              | lignes `TARGET_RESOLUTION` et `RECOVERY` avec au moins autant d'échecs que de succès                              |
| `BROKEN_TRANSITIONS`             | lignes `TRANSITION` `FRAGILE` ou `CONTRADICTED`                                                                   |
| `CONTRADICTORY_MAPPINGS`         | la même étiquette de champ liée à des propriétés différentes                                                      |
| `STALE`                          | lignes non revues depuis plus de `staleAfterDays` jours                                                           |
| `CHANGED_RULES`                  | lignes `RULE` contredites à l'exécution (`RUNTIME_CONTRADICTED` ou contradictions > 0)                            |
| `FROM_FAILED_RUNS`               | lignes dont les runs appartiennent à des runs `FAILED` (50 derniers runs persistés)                               |
| `INCONSISTENT_WITH_OBSERVATIONS` | lignes `API` avec autant d'erreurs (4xx / 5xx) que de succès, invariants avec contre-exemples, règles contredites |

### Problèmes des variables (`recordings.ts`)

`NEVER_CONSUMED` (produite, jamais citée), `NO_PRODUCER` (citée `${testData:…}` sans clé dans le jeu de
données), `AMBIGUOUS_MAPPING` (un champ lié à plusieurs propriétés), `STATIC_REUSED` (une valeur
statique reprise par plusieurs étapes), `BROKEN_DEPENDENCY` (une étape dépend d'une clé absente). Ils
sont **détectés et affichés**, jamais corrigés : les enregistrements ne sont pas modifiés.

## 4. API JSON (`server.ts`)

Toutes les routes sont sous `/api` ; `:app` est l'identifiant `application@environnement` encodé.

| Méthode | Route                                                                                  | Réponse                                                                                                       |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET     | `/`                                                                                    | la page                                                                                                       |
| GET     | `/api/meta`                                                                            | mission, applications, options, version, vocabulaire                                                          |
| GET     | `/api/apps/:app/overview`                                                              | `OverviewDto`                                                                                                 |
| GET     | `/api/apps/:app/items?…`                                                               | `Page<KnowledgeItem>` (`q`, `type`, `status`, `origin`, `source`, `review`, `sort`, `page`, `pageSize ≤ 200`) |
| GET     | `/api/apps/:app/items/:id`                                                             | détail : item, historique, exécutions des 20 derniers runs                                                    |
| GET     | `/api/apps/:app/flows` · `graph` · `variables` · `quality` · `history` · `persistence` | les DTO des vues                                                                                              |
| GET     | `/api/apps/:app/export`                                                                | export versionné (`Content-Disposition: attachment`)                                                          |
| GET     | `/api/backups`                                                                         | sauvegardes disponibles                                                                                       |
| POST    | `/api/refresh`                                                                         | vide le cache                                                                                                 |
| POST    | `/api/apps/:app/items/:id/decision`                                                    | `{ operation: VALIDATE \| INVALIDATE \| RESET, note?, expectedVersion }` → `409` si la version a changé       |
| POST    | `/api/apps/:app/import/preview`                                                        | aperçu d'un export : nouveaux, identiques, conflits, hors application                                         |
| POST    | `/api/apps/:app/import/apply`                                                          | import selon la politique (`replaceable`, `files`, `backupFirst`)                                             |
| POST    | `/api/apps/:app/backups`                                                               | sauvegarde maintenant                                                                                         |
| POST    | `/api/backups/:id/restore`                                                             | restauration (sauvegarde de l'état courant d'abord)                                                           |

Codes : `400` corps invalide (message zod), `401` jeton absent ou faux, `403` en-tête absent, origine
étrangère ou `--read-only`, `404` application ou connaissance inconnue, `409` modification concurrente,
`413` corps > 64 Mo, `415` type de contenu autre que JSON.

### Sécurité

- Serveur lié à `127.0.0.1` par défaut.
- Toute écriture (`POST`) exige : l'en-tête `X-QA-Knowledge-Center: 1`, `Authorization: Bearer <jeton>`
  (jeton généré au démarrage, affiché dans le terminal, porté par la page) et une origine égale à celle du
  serveur quand le navigateur l'envoie. `--read-only` refuse toute écriture (`403`), même avec le jeton.
- Validation côté serveur de tout corps (zod) ; la page ne peut rien contourner (les règles vivent dans le
  service et le serveur, pas dans le JavaScript).
- Modifications concurrentes : chaque connaissance a une version dans le registre ; une décision portant
  une version périmée est refusée (`409`) et la page recharge le détail.
- Politique de sécurité du contenu sur la page (scripts inline de la page seulement, aucune ressource
  réseau) ; les messages d'erreur sont passés par la redaction (`redactText`) ; aucun identifiant de base,
  aucune variable d'environnement n'est lu ni renvoyé : la vue Persistance montre le provider, le
  dialecte, l'emplacement (chemin ou hôte) tels que la configuration les expose, jamais un secret.

## 5. Registre des décisions et des opérations

`<knowledge>/knowledge-center/review-ledger.json` : ajout seul, écriture atomique, sérialisée.

- `VALIDATE` / `INVALIDATE` / `RESET` : décision humaine sur une connaissance (`itemId`, `itemTitle`,
  `before`, `after` = `{ status, note?, at, version }`). L'état courant est le repli des entrées ; la
  version d'une connaissance est le nombre de décisions la concernant ; `RESET` retire la décision.
- `EXPORT`, `BACKUP`, `IMPORT`, `RESTORE` : opérations, avec `details` (ce qui a été fait) et `errors`.

Le moteur ne lit jamais ce registre : les décisions sont montrées, exportées et historisées, elles
n'influencent aucun choix de l'agent (vérifié par le test d'intégration : les décisions d'un troisième
run sont identiques après des validations dans le tableau de bord).

## 6. Export, import, sauvegarde, restauration (`exchange.ts`)

Format `qa-crawler-knowledge-export`, version `1`, validé par zod à l'import (`incompatible knowledge
export: …` sinon) :

```json
{
  "format": "qa-crawler-knowledge-export",
  "version": 1,
  "exportedAt": "…",
  "crawlerVersion": "…",
  "application": {
    "id": "app@env",
    "application": "app",
    "environment": "env",
    "functionalApplication": "…"
  },
  "persistence": {
    "provider": "file",
    "schemaVersion": 5,
    "runs": [],
    "states": [],
    "transitions": [],
    "knowledge": [],
    "evolution": [],
    "anomalies": [],
    "memory": []
  },
  "knowledgeFile": { "schemaVersion": 1, "key": "app@env", "data": {} },
  "functional": { "content": {} },
  "rules": { "content": {} },
  "review": []
}
```

Les sections `persistence`, `knowledgeFile`, `functional` et `rules` sont facultatives : un export ne
contient que ce qui existe réellement (pas de persistance → pas de section `persistence`).

- **Aperçu** avant tout import : compatibilité (format, version, application cible), puis par section
  `total`, `added` (nouveaux), `identical`, `conflicts` (même clé, contenu différent), `skipped`, ce que la
  politique fera des conflits (`skip`, `replace`, `never-replaced`) et des exemples de clés.
- **Import** : `runs`, `states`, `transitions` et `knowledge` seulement si la clé est absente (le
  repository `knowledge.record` ne sait qu'ajouter : rien n'est recompté ni écrasé) ; `evolution`,
  `anomalies`, `memory` remplacés seulement si `replaceable: replace` ; fichiers de connaissance remplacés
  seulement si `files: replace` ; `backupFirst` (défaut) écrit une sauvegarde avant. Le résultat dit
  exactement ce qui a été écrit, ignoré et en erreur, et entre au registre.
- **Sauvegarde** : un export écrit dans `<knowledge>/knowledge-center/backups/<horodatage>-<aléa>-<application>.json`.
- **Restauration** : sauvegarde de l'état courant, puis import de la sauvegarde choisie avec remplacement
  ; confirmation explicite dans la page ; le résultat liste ce qui a été restauré et ce qui n'a pas pu
  l'être (une ligne de `transition_knowledge` déjà présente n'est pas réécrite : c'est dit).

Aucune suppression de données de production n'existe dans le Knowledge Center.

## 7. Tests

```bash
npx vitest run tests/unit/knowledge-center.test.ts tests/unit/knowledge-center-cli.test.ts   # 30 tests
npx vitest run --project integration tests/integration/knowledge-center.test.ts               # 4 tests, Chromium
```

- unitaires : statuts de fiabilité (chaque règle), registre (versions, conflit `409`, ajout seul),
  service sur une persistance mémoire remplie par le vrai `JsonKnowledgeBase`, un fichier fonctionnel, un
  fichier de règles et un enregistrement (métriques, recherche, critères, tri, pagination, détail,
  variables et leurs problèmes, qualité, historique), configurations mémoire désactivée et persistance
  désactivée, lecture seule, export / aperçu / import / sauvegarde / restauration, sécurité du serveur
  (jeton, en-tête, origine, taille, type), inventaire des providers, fichiers du moteur intacts ;
- CLI : arguments, aide, configuration projet / mission, serveur réel (`/api/meta`, refus en lecture seule) ;
- intégration : deux runs réels avec la persistance fichier et la mémoire historique, page lue dans
  Chromium (vue d'ensemble, flows, graphe, explorateur, détail, validation, historique, persistance,
  sauvegarde, export), puis un troisième run dont les décisions sont identiques.

## 8. Limites connues

- Les lignes de `transition_knowledge` ne se corrigent ni ne se suppriment (le repository n'a que
  `record`) : une connaissance fausse se **invalide** (annotation) ; le moteur continue de la compter.
- « Runs ayant utilisé la mémoire » : Non disponible (le provider ne l'enregistre pas).
- Providers MySQL, HTTP ou gRPC : non implémentés dans QA-CRAWLER, donc absents (la vue ne liste que les
  providers réels : mémoire, fichier, SQLite, PostgreSQL, SQL Server).
- Les fichiers fonctionnel et de règles d'une application autre que celle de la mission sont lus au mieux
  (leur nom dépend du nom de mission) ; les enregistrements sont ceux du `reportsDir` de la mission.
- Les formules et définitions techniques (infobulles) sont en anglais, comme les rapports JSON.
- Un seul utilisateur à la fois est attendu (jeton de session unique, serveur local).
