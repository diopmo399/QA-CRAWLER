# Analyse métier des requêtes HTTP (Recording)

Pendant un enregistrement, le Recorder comprend **ce que fait l'application** à partir de ses
requêtes HTTP : quel geste a déclenché quelle requête, quelle opération métier elle porte
(recherche, liste, lecture, création, modification, suppression), avec quels critères, groupes
logiques, tri, pagination et options, et quel champ de l'interface correspond à quelle propriété
technique. La même analyse tourne **en direct** (pendant l'enregistrement) et **après l'arrêt**
(consolidation), avec le même moteur, le même modèle et les mêmes règles.

Principe : **OBSERVER → STRUCTURER → CORRÉLER → INTERPRÉTER → CONFIRMER**. Aucune signification
n'est tirée du nom d'un champ, de la méthode HTTP, de l'URL ou de l'endpoint seuls : un `POST`
n'est pas une création, un champ `id` n'est pas un rôle.

## Architecture

```
navigateur ──► FormKnowledgeObserver (collecteur réseau EXISTANT, aucun collecteur parallèle)
                 │  journalRequest() : analyzeHttpRequest() → structure masquée
                 ▼
          journal réseau chronologique (NetworkObservation n1, n2, …)
                 │                                   événements bruts du Recorder (r1, r2, …)
                 └───────────────┬───────────────────────────┘
                                 ▼
                analyzeRecording({ mode: LIVE | CONSOLIDATED, events, network, previous? })
                   1. requêtes périodiques (polling) → indépendantes
                   2. corrélation geste → requêtes (score, candidats, ambiguïté)
                   3. opérations métier (preuves : réponse, critères, identité nouvelle…)
                   4. FieldMapping libellé ↔ propriété (par écran, API, opération)
                   5. relations création ↔ recherche, incohérences
                   6. révisions par rapport à l'analyse précédente
                                 │
          ┌──────────────────────┼─────────────────────────────┐
          ▼                      ▼                             ▼
   fenêtre du Recorder    http-analysis.json /          FunctionalKnowledgeStore
   (compteurs en direct,  network-journal.json          (fieldMappings VALIDATED,
    carte « Analyse HTTP») (journal re-masqué)            si recording.knowledge)
```

## Composants

| Fichier                                                                          | Rôle                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/functional/http-structure.ts` (nouveau)                                     | Analyseur **structurel** générique : parcourt query string + corps JSON, reconnaît groupes logiques (jeton logique + tableau d'objets), critères (référence de propriété + opérateur), tri (propriété + direction), pagination (taille dans une liste de tailles usuelles + index du même parent), options (booléens), contexte. Masque toute valeur sauf les jetons de structure. |
| `src/forms/state/form-knowledge-observer.ts`                                     | Le collecteur réseau existant tient en plus le **journal** (`startJournal`, `journalSnapshot`) : horodatage, durée, statut, échec de transport, résumé de réponse (taille de liste, enregistrements en empreintes, identité nouvelle, code d'erreur), fenêtres d'action ouvertes.                                                                                                  |
| `src/functional/model.ts`                                                        | `NetworkObservation` ; `FunctionalExchange.observationId` relie l'échange existant à l'entrée du journal.                                                                                                                                                                                                                                                                          |
| `src/recording/analysis/recording-analysis.ts` (nouveau)                         | Le moteur unique `analyzeRecording`, `redactJournal`, les poids `ANALYSIS_WEIGHTS`. Ne lève jamais : une erreur donne `status: FAILED` et laisse événements et journal intacts.                                                                                                                                                                                                    |
| `src/recording/human-flow-recorder.ts`                                           | Mode **LIVE** : démarre le journal, relance l'analyse (anti-rebond `liveDebounceMs`) à chaque capture, émet `HTTP_ANALYSIS_UPDATED`.                                                                                                                                                                                                                                               |
| `src/recording/process-recording.ts`                                             | Mode **CONSOLIDATED** après l'arrêt (avec les corrélations d'entités déjà détectées), émet `HTTP_ANALYSIS_CONSOLIDATED`.                                                                                                                                                                                                                                                           |
| `src/recording/record-orchestrator.ts`                                           | Écrit les fichiers, passe optionnelle d'IA sur les opérations inconnues, mémorisation des correspondances validées.                                                                                                                                                                                                                                                                |
| `src/knowledge/functional-knowledge-store.ts`                                    | `rememberFieldMappings` / `fieldMappings` (par application, dédoublonnées, plafonnées).                                                                                                                                                                                                                                                                                            |
| `src/recording/recording-console.ts`, `panel-state.ts`, `recorder-panel-html.ts` | Compteurs en direct dans l'en-tête, carte « Analyse HTTP » à l'arrêt.                                                                                                                                                                                                                                                                                                              |
| `src/recording/capture-script.ts`                                                | Empreinte « repliée » des saisies (sans accents, minuscules, espaces réduits) pour les correspondances NORMALIZED.                                                                                                                                                                                                                                                                 |

## Les deux modes

- **LIVE** — pendant l'enregistrement, après chaque geste capturé (anti-rebond 700 ms ; jusqu'à 5
  relances tant que des réponses sont en attente). Le résultat est **provisoire** : une requête sans
  réponse ne donne qu'une hypothèse (`PROVISIONAL`). Jamais bloquant : un échec n'interrompt pas
  l'enregistrement.
- **CONSOLIDATED** — après l'arrêt, sur le journal complet. L'analyse reprend la dernière analyse
  LIVE comme `previous` et trace chaque changement d'état dans `revisions` (`from`, `to`, raison).
  Les événements bruts et le journal ne sont **jamais** réécrits. À preuves égales, les deux modes
  convergent (test dédié).

## États de connaissance

| État          | Signification                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBSERVED`    | Vu tel quel (journal, événement).                                                                                                                              |
| `INFERRED`    | Déduit de preuves convergentes, non confirmé.                                                                                                                  |
| `PROVISIONAL` | Hypothèse : réponse en attente, lien candidat ou ambigu, proposition de l'IA, conflit.                                                                         |
| `VALIDATED`   | Confirmé : geste + fenêtre ouverte + réponse ; correspondance vue au moins 2 fois de façon cohérente.                                                          |
| `SUPERSEDED`  | Hypothèse du direct que le journal complet ne soutient plus (révision tracée).                                                                                 |
| `REJECTED`    | Réservé à un rejet explicite (humain) ; jamais produit automatiquement aujourd'hui. Une hypothèse `REJECTED` n'est jamais reprise par une proposition de l'IA. |

## Corrélation geste → requêtes

Score par requête (`ANALYSIS_WEIGHTS`) : écart de démarrage (≤ 300 ms 0.55, ≤ 1 s 0.45, ≤ 3 s 0.3,
≤ 10 s 0.1) + fenêtre de l'action ouverte (+0.35) + dernière action avant la requête (+0.05).

- `TRIGGERED` (≥ 0.75), `CANDIDATE` (≥ 0.4), `AMBIGUOUS` (une autre action à moins de 0.15).
- Plusieurs requêtes par geste ; une requête plus faible dans la même fenêtre reste un lien
  **secondaire** (`secondary`), jamais une preuve, et ne rend pas le déclenchement ambigu.
- **Indépendantes** : polling (même API, intervalle régulier ±25 %, au moins un tick hors de toute
  fenêtre ou ≥ 5 ticks), chargement de page, requête à plus de 10 s du dernier geste.
- Le démarrage compte, pas la réponse : une réponse tardive reste liée à son geste.

## Opérations métier (preuves, jamais la méthode seule)

| Opération                    | Preuves                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEARCH`                     | Une **structure de critères** (propriété · opérateur · valeur, groupe logique) : 0.85 avec une réponse en liste, 0.75 avec une autre réponse, 0.5 en attente. Un `POST` de critères est une recherche ; un chemin « technique » ne l'empêche pas. |
| `LIST`                       | Réponse en liste sans critère, pagination ni tri (0.75).                                                                                                                                                                                          |
| `CREATE`                     | Identité nouvelle dans la réponse (0.85) ; `POST` 2xx sur une collection sans autre preuve (0.55, à confirmer).                                                                                                                                   |
| `UPDATE` / `DELETE` / `READ` | `PUT`/`PATCH` sur un chemin d'identité, `DELETE`, `GET` d'une ressource.                                                                                                                                                                          |
| `TECHNICAL`                  | Jeton, découverte OIDC, clés, télémétrie, santé, configuration, statique, **sans structure de critères** : jamais une opération métier.                                                                                                           |
| `UNKNOWN`                    | Pas assez de preuves ; l'IA peut proposer (hypothèse `PROVISIONAL`).                                                                                                                                                                              |

## Critères de recherche métier (`SearchCriterion`)

Classification technique et interprétation métier sont **deux dimensions** : une requête garde sa
classification technique (`technical`, par exemple un chemin de configuration) **et** peut être
une `SEARCH` avec ses critères (`searchCriteria`). L'une ne remplace jamais l'autre.

### Où le critère se perdait (diagnostic)

1. **Classification** : `technicalCategoryOf(path)` passait avant toute preuve. Un chemin de
   protocole ou de configuration rendait `TECHNICAL` et la structure de la requête était ignorée.
   Une recherche dont la réponse n'est pas lue comme une liste devenait même `CREATE` (« `POST` 2xx
   sans identité »).
2. **Analyseur structurel** : la valeur comparée était la _première_ autre clé du critère. Un
   drapeau booléen voisin était pris pour la valeur, et la vraie valeur partait en critère implicite.
3. **Tri** : un nom de propriété en kebab-case (`item-title`) n'était pas reconnu comme nom. Le tri
   était perdu et sa propriété devenait un « critère implicite ».
4. **Propriété d'un seul mot** (`name`, `status`) : non reconnue comme nom, donc pas de critère.
5. **Paramètres d'URL** : un identifiant de contexte (utilisateur, tenant) devenait un critère
   implicite.
6. **Fenêtre** : « Intents métier » ne lisait que l'intention d'écriture
   (`flow.intent.workflow`), jamais l'analyse HTTP.

### Reconnaissance (structure, jamais un nom connu)

- **Critère** : un objet avec un opérateur de comparaison (vocabulaire de protocole, ou code en
  capitales à côté d'un nom composé) ou placé dans un groupe logique, une chaîne qui a la **forme
  d'un nom** (la propriété) et une valeur comparée.
  - Les booléens voisins sont des **drapeaux du critère** (`CRITERION_FLAG`), jamais sa valeur.
  - Quand propriété et valeur ont toutes deux la forme d'un nom (`swappable`), la **saisie** de
    l'humain départage : la chaîne saisie est la valeur.
  - Des indices anglais génériques de protocole (`field`, `property`, `value`, `input`…) ne servent
    qu'à départager deux lectures, jamais à décider seuls.
- **Tri** : un nom et une direction (`asc`, `DESC`…) **sans** opérateur, ou `{ nom: "DESC" }`.
  Jamais un critère.
- **Paramètres** (`parameters`) :
  - `PAGINATION` : deux petits entiers dont une taille usuelle ;
  - `SORT` ;
  - `OPTION` : un booléen hors critère ;
  - `CRITERION_FLAG` ;
  - `CONTEXT` : une valeur libre qu'**aucune saisie n'explique**, par exemple un identifiant
    d'utilisateur.

### Le modèle

`SearchCriterion` porte :

- `propertyPath`, `propertyName`, `operator`, `value` (masquée), `valueType` ;
- `logicalGroup` (`AND`/`OR` et son chemin), `sourceRequest`, `sourceJsonPath` ;
- `ui` : le **champ d'interface** dont la saisie est envoyée (libellé, action, écran, `EXACT` ou
  `NORMALIZED`) ;
- `testData` : `${testData.<clé>}`, ce qui rend la valeur dynamique ;
- `fromCreation` : la valeur vient d'une création du même enregistrement ;
- `confidence`, `state`, `evidence`.

La phrase `interpretation` dit la recherche sans valeur en clair, par exemple :
`search where companyName CONTAINS the value typed in "Search companies" (${testData.…}), sorted by companyName ASC`.

### Corrélation UI → HTTP

Les saisies prises en compte sont celles qui précèdent le geste déclencheur, depuis la requête
métier précédente. Une saisie dont l'empreinte salée (exacte ou repliée) égale celle de la valeur
envoyée relie le **libellé** à la **propriété**. C'est une observation datée, avec sa preuve : le
libellé et le nom technique ne sont jamais supposés identiques, et aucune règle globale
« libellé = propriété » n'est créée. La correspondance n'entre dans la mémoire de l'application que
si elle est `VALIDATED` (vue au moins 2 fois).

### États

- Requête en attente (direct) : `PROVISIONAL`.
- Critère structuré rattaché à une saisie, réponse reçue : `VALIDATED`.
- Rattaché à une saisie ou confiance ≥ 0.6 : `INFERRED`.
- Sinon : `PROVISIONAL`.

La consolidation révise le direct, et la révision est tracée.

### Affichage

- **Fenêtre, onglet Analyse**, section « Intents métier » : Recherche, puis pour chaque critère le
  libellé, l'API, l'opérateur et la valeur (la donnée de test déjà écrite dans `test-data.yaml`,
  sinon « (typed) »). Puis la logique, le tri, les paramètres techniques, la classification
  technique à part, la confiance et les preuves.
- **Section « Analyse HTTP »** : les recherches reconnues, une phrase chacune.
- **En direct** : la dernière recherche reconnue s'affiche dans l'en-tête, en provisoire.
- **Rapport HTML** : section « Search », sans aucune valeur.

## Correspondances champ ↔ propriété (FieldMapping)

Une saisie (empreinte salée) retrouvée comme valeur d'un critère relie le **libellé de l'interface**
à la **propriété technique**, dans un contexte (écran, API, opération). `EXACT` ou `NORMALIZED`
(accents, casse, espaces). Une fois : `INFERRED` ; deux fois de façon cohérente : `VALIDATED` ;
deux propriétés pour un même libellé : `PROVISIONAL` + incohérence `MAPPING_CONFLICT`.

## Création ↔ recherche

Après une création, une recherche dont les critères portent les données créées donne la relation
`SEARCH_AFTER_CREATE` (critères supplémentaires listés) ; un résultat qui porte ces données,
`RESULT_MATCHES_CREATE`. Les corrélations d'entités déjà établies (`EntityCorrelation`) sont
reprises (`ENTITY_CORRELATION`). Une recherche vide après une création est **expliquée**
(`NO_RESULT_AFTER_CREATE` : indexation différée, critères supplémentaires, droits…), jamais déclarée
défaut d'office.

## Incohérences

`HTTP_ERROR`, `TRANSPORT_FAILURE`, `MISSING_RESPONSE`, `NO_RESULT_AFTER_CREATE`,
`MAPPING_CONFLICT`, `AMBIGUOUS_CORRELATION` — chacune avec ses références (`r…`, `n…`).

## Confidentialité

- Toute valeur est masquée (empreinte salée exacte + repliée), sauf les jetons de structure
  (opérateurs, logique, direction, jeton en capitales, référence de propriété, petits entiers,
  booléens, `null`) ; une clé sensible (mot de passe, jeton, cookie…) est masquée **sans** empreinte.
- Une saisie de l'humain restée lisible (un nom en capitales) est **re-masquée** (`USER_INPUT`)
  avant toute écriture (`redactJournal`) et dans l'analyse.
- La mémoire ne garde que des libellés, propriétés et chemins — jamais une valeur.

## Fichiers

- `network-journal.json` — `{ requests: NetworkObservation[] }`, la source chronologique.
- `http-analysis.json` — `{ journal, consolidated, live?: { mode, summary } }` ; `consolidated`
  contient `correlations`, `independent`, `business`, `fieldMappings`, `inconsistencies`,
  `revisions`, `summary`.
- Connaissance : `knowledge/functional/functional-<application>.json` → `fieldMappings`
  (VALIDATED seulement, si `recording.knowledge`).

## Configuration

```yaml
recording:
  knowledge: true # mémorise les correspondances validées
  business:
    http:
      enabled: true # journal + analyse
      live: true # analyse en direct
      liveDebounceMs: 700
      maxJournal: 2000 # entrées gardées au plus
      ai: true # opérations inconnues soumises à l'IA (si ai.mode ≠ OFF)
      maxAiCalls: 3 # par enregistrement, jamais une par événement
```

Sans base de données, sans IA, ou mémoire désactivée : l'analyse est complète (déterministe) ; si
elle échoue, l'enregistrement et ses fichiers habituels sont produits normalement.

## IA (optionnelle)

L'IA ne reçoit que les opérations `UNKNOWN` liées à un geste (au plus `maxAiCalls`), en un lot par
opération, avec des preuves déjà masquées. Elle **choisit** parmi `PROPOSABLE_OPERATIONS` ; sa
réponse est validée (doit appartenir à la liste) et devient une hypothèse `PROVISIONAL`, jamais
`VALIDATED`. Elle ne clique jamais et ne modifie aucun événement.

## Limites

- Correspondances par empreintes exactes ou repliées : une correspondance **partielle** (préfixe,
  sous-chaîne) ou transformée autrement (format de date, code ↔ libellé) n'est pas reconnue.
- Seuls les corps JSON et la query string sont lus ; les corps form-urlencoded, multipart, GraphQL
  ou binaires ne sont pas structurés.
- Les requêtes parties avant l'attachement de l'observateur (premier chargement) peuvent manquer.
- Le crochet `meaningProposals` (sens d'une correspondance proposé par l'IA) existe dans le moteur
  mais n'est pas encore branché sur la passerelle ; seules les propositions d'opération le sont.
- Le polling irrégulier (backoff, ticks manqués d'un onglet en arrière-plan) n'est pas reconnu comme
  périodique : il reste « indépendant » ou candidat faible selon sa distance aux gestes.
- L'état `REJECTED` n'a pas encore de geste dans la fenêtre pour le poser.
- Critères : un critère encodé dans une seule chaîne (`?q=name:acme`, `$filter=name eq 'x'`,
  RSQL…) n'est pas décomposé ; seul le JSON structuré et les paires clé → valeur le sont.
- Un critère dont propriété et valeur ont toutes deux la forme d'un nom garde le nom comparé lisible
  dans le journal tant qu'aucune saisie ne le désigne comme valeur. S'il s'agit d'une saisie, il est
  re-masqué avant l'écriture.
- Une valeur transformée par l'application (date reformatée, libellé → code) ne se relie pas à la
  saisie : le critère reste reconnu, sans champ d'interface.
- Un seul identifiant de libellé par saisie : deux champs portant le même libellé sur un même écran
  partagent une clé de correspondance.

## Décisions à valider humainement

1. Les seuils (`ANALYSIS_WEIGHTS`) : 0.75 pour `TRIGGERED`, 0.15 de marge d'ambiguïté, 2 occurrences
   pour `VALIDATED`.
2. La règle du polling (±25 %, au moins un tick hors fenêtre ou ≥ 5 ticks).
3. `POST` 2xx sur une collection sans identité nouvelle = `CREATE` à 0.55 (`INFERRED` au mieux) :
   faut-il le laisser `UNKNOWN` ?
4. Mémoriser automatiquement les correspondances `VALIDATED` (par défaut : activé si
   `recording.knowledge`), ou demander une confirmation dans la fenêtre.
5. L'activation par défaut de l'IA (`ai: true`, `maxAiCalls: 3`) sur les opérations inconnues.
