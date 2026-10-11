# Application Interaction Model (shell, liste de tasks, BFF, micro-frontends)

Le Recorder reste d'abord un **recorder Playwright** : les actions, sélecteurs, la validation et la
réparation des cibles, le rejeu sont inchangés. Au-dessus, il construit progressivement un modèle
**générique** de l'application observée : contextes applicatifs, espace de travail (liste de
tasks), tasks, micro-frontends, entités, identités, relations, actions métier. Aucun nom
d'entité, de route, d'API ou de bouton n'est codé : les noms observés sont des **indices**, jamais
des règles. Toute interprétation pointe vers ses preuves et vers les actions techniques d'origine.

## A. Architecture actuelle

| Rôle                | Où                                                                                                                  | Ce qu'il fait                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Recorder            | `recording/human-flow-recorder.ts`                                                                                  | attache le script de capture, observe l'écran après chaque action, corrèle le réseau                                         |
| Capture des actions | `recording/capture-script.ts` (page) → `RawRecordedEvent`                                                           | clic, saisie, sélection, glisser, navigation ; **page principale seulement** (pas les iframes)                               |
| Capture DOM         | `observation/dom-snapshot.ts` → `RecordedState`                                                                     | titres, alertes, statuts, contrôles visibles, lignes de tableau ; contexte de l'élément (ligne, clé de ligne, section, hôte) |
| Réseau              | `forms/state/form-knowledge-observer.ts` → `FunctionalExchange`                                                     | méthode, chemin, statut ; identifiants des **écritures** (réponse, chemin, `Location`) ; d'une lecture : le statut seulement |
| Navigation          | `human-flow-recorder.ts` (`framenavigated` du cadre principal, `navigatedWithinDocument`) + `action-correlation.ts` | routes causées par une action, `gotoReason` (initiale, URL tapée, retour…)                                                   |
| Flow                | `process-recording.ts` → normaliseur → `recorded-flow.ts`                                                           | `recorded-flow.json`, `generated.flow.yaml`                                                                                  |
| Couche métier       | `recording/business/*`                                                                                              | preuves d'entités → identités → provenance → événements métier → `business-flow.json`                                        |
| Mémoire             | `business/entity-memory.ts`                                                                                         | créations prouvées (`$created`) + entités observées (provenance)                                                             |
| Persistance         | `record-orchestrator.ts`                                                                                            | fichiers du recording, base de connaissance                                                                                  |
| Rejeu               | `flows/flow-step-executor.ts`                                                                                       | exécute le flow enregistré (Playwright)                                                                                      |
| Validation          | `target-validator.ts`, `validation-mode.ts`, `flows/action-effect-verifier.ts`                                      | cible, effet, but                                                                                                            |
| Gateway IA          | `ai/gateway.ts`                                                                                                     | consultations facultatives, validées, jamais exécutantes                                                                     |
| Reporter / UI       | `recording-report.ts`, `recorder-panel-html.ts`, `recording-console.ts`                                             | rapport, fenêtre du recorder (parcours, détails, analyse)                                                                    |

## B. Limites actuelles

1. **Pas de notion de contexte applicatif** : l'écran est identifié (StateDetector), mais rien ne
   dit qu'on passe d'une liste de tasks à un micro-frontend de création.
2. **Les lectures ne sont pas lues** : une liste servie par un BFF (`GET …/tasks`) ne laisse que
   son statut — ses tasks et leurs clés sont invisibles.
3. **Pas de task** : un élément sélectionné dans une liste n'est qu'un clic.
4. **Pas de relation** autre que « même entité » : rien ne relie une task à l'entité qu'elle
   référence, ni une entité au micro-frontend qui l'a créée.
5. **Cadres** : les iframes ne sont ni enregistrés (actions) ni vus comme contextes.
6. Identités : une clé alphanumérique (`ABC123`) n'était pas reconnue comme identifiant ; un champ
   `…Key` était exclu comme « secret ».

## C. Architecture cible (incrémentale)

```
RECORDER (inchangé) ─ DOM ─ NETWORK ─ ACTIONS
        │
        ▼
EVIDENCE COLLECTOR          business/entity-evidence.ts (existant) + preuves d'interaction (nouveau)
        │
        ▼
APPLICATION CONTEXT         application/context-detector.ts     contextes : route, hôte, cadre
        │
  TASKS ─ MFEs ─ ENTITIES   application/collection-observer.ts  collections lues (BFF), sélections
        │                   business/entity-tracker.ts (existant) entités, identités, provenance
        ▼
RELATIONSHIP ENGINE         application/relationship-engine.ts  relations avec preuves et confiance
        │
        ▼
LIFECYCLE + BUSINESS FLOW   application/application-model.ts    actions métier → actions Playwright
        │
        ▼
application-model.json  ·  fenêtre du recorder (arbre)  ·  réutilisable : rejeu, validation, crawler
```

## D. Ajouts

- `application/model.ts` : `ApplicationInteractionModel`, `ApplicationContext`, `TaskWorkspace`,
  `Task`, `WorkCollection`, `IdentityCandidate`, `Relationship`, `BusinessAction`,
  `InteractionEvidence`.
- `application/context-detector.ts` : signature de contexte d'un écran, changements de contexte.
- `application/collection-observer.ts` : collections lues (réseau) ou affichées (lignes du DOM),
  sélection d'un enregistrement, types d'identité candidats.
- `application/relationship-engine.ts` : relations (`CONTAINS`, `DISPLAYS`, `REFERENCES`,
  `RETRIEVED_BY`, `CREATED_BY`, `OPENED_BY`, `SEARCHED_BY`, `UPDATED_BY`, `NAVIGATES_TO`,
  `CORRELATES_WITH`, `RESULTS_IN`, `DERIVED_FROM`, `CREATE_RESULT` — extensible).
- `application/application-model.ts` : `buildApplicationModel()` (fonction pure).

## E. Modifications (minimales)

- `dom-snapshot.ts` / `RecordedState` : `hosts` (éléments personnalisés de grande taille) et
  `frames` (iframes visibles) — indices de contexte.
- `form-knowledge-observer.ts` / `FunctionalExchange.records` : les identifiants des
  enregistrements d'une lecture réussie (50 au plus ; empreinte salée, valeur seulement si elle a
  la forme d'un identifiant) ; `…Key` / `…Code` reconnus, clés d'API / de chiffrement exclues.
- `business/signals.ts` : clés alphanumériques (`ABC123`) reconnues dans une URL ou un texte.
- `process-recording.ts`, `record-orchestrator.ts` : construire et écrire `application-model.json`.
- Fenêtre du recorder : l'arbre Workspace → Task → MFE → Entity → actions, avec observé / déduit /
  confirmé / incertain, la confiance et les preuves.

## F. Modèle de données

```jsonc
{
  "application": { "origin": "…", "shell": ["app-shell"] },
  "contexts": [
    {
      "key": "host:items-create",
      "kind": "HOST",
      "role": "MICROFRONTEND",
      "name": "items-create",
      "route": "/items/new",
    },
  ],
  "collections": [
    {
      "key": "collection:GET /bff/tasks",
      "source": { "type": "NETWORK", "path": "/bff/tasks" },
      "records": [{ "identityCandidates": [{ "type": "TASK_ID", "field": "taskId", "value": "456" }] }],
    },
  ],
  "workspaces": [
    {
      "key": "workspace:…",
      "type": "TASK_WORKSPACE",
      "source": {
        "type": "NETWORK",
        "path": "/bff/tasks",
        "bffCandidate": { "confidence": 0.7, "reasons": ["…"] },
      },
    },
  ],
  "tasks": [
    {
      "key": "task:…:456",
      "identityCandidates": [
        { "type": "TASK_ID", "value": "456" },
        { "type": "BUSINESS_KEY", "value": "ABC123" },
      ],
    },
  ],
  "entities": [
    {
      "key": "entity:item:ABC123",
      "identity": { "type": "BUSINESS_KEY", "value": "ABC123" },
      "provenance": { "classification": "CREATED_DURING_RECORDING" },
      "tasks": ["task:…"],
      "contexts": ["host:items-create"],
    },
  ],
  "relationships": [
    {
      "type": "REFERENCES",
      "source": "task:…",
      "target": "entity:item:ABC123",
      "confidence": 0.9,
      "status": "DEDUCED",
      "evidenceIds": ["x7"],
    },
  ],
  "businessActions": [{ "kind": "SELECT_TASK", "subject": "task:…", "actionIds": ["a3"], "stepIds": ["s3"] }],
  "evidence": [
    {
      "id": "x7",
      "source": "NETWORK",
      "description": "GET /bff/tasks → record #0 taskId=456",
      "actionIds": ["a1"],
    },
  ],
}
```

Chaque interprétation porte `status` : **OBSERVED** (vu tel quel : un changement de contexte, un
enregistrement lu), **DEDUCED** (une règle l'infère), **CONFIRMED** (≥ 0,85 avec plusieurs
preuves), **UNCERTAIN** (< 0,6, ou plusieurs cibles possibles) — et `confidence`, `reason`,
`evidenceIds`, `actionIds`.

## G. Stratégie de corrélation

- **Contexte** : signature d'écran = cadre visible (iframe), sinon éléments personnalisés de
  grande taille hors shell (présents sur tous les écrans = shell), sinon motif de route (les
  identifiants remplacés par `:id`, deux segments au plus). Une action qui change la signature est
  un `SWITCH_CONTEXT` (observé).
- **Collection** : une lecture réussie qui sert des enregistrements identifiables, ou des lignes
  affichées (DOM). Ses champs sont des **candidats d'identité** typés par leur forme et leur nom
  (indice) : `TASK_ID` (identifiant principal d'un élément de travail), `BUSINESS_KEY`,
  `REFERENCE`, `FOREIGN_ID`, `ID`, `UUID`. `taskId ≠ businessKey` : deux identités distinctes.
- **Sélection** : un clic dont l'élément (texte, clé de ligne, lien) porte la valeur d'un
  enregistrement lu juste avant.
- **Task** : l'enregistrement sélectionné ouvre un autre contexte ET n'est pas une simple
  représentation de l'entité ouverte (même ressource, ou liste issue d'une recherche) : c'est un
  élément de travail. Sa liste devient un `TASK_WORKSPACE` ; un BFF n'est qu'un **candidat**
  (raisons listées), jamais supposé.
- **Relations par valeur** : même valeur (ou même empreinte salée) entre un champ d'un
  enregistrement, une identité d'entité (réponse, route, écran, saisie) — quels que soient les noms
  des champs. Une valeur qui désigne plusieurs entités donne une relation **incertaine** avec ses
  candidats, jamais un choix.
- **Relations causales** : entité créée dans le contexte ouvert par une task (`RESULTS_IN`),
  enregistrement lu **après** une création qui porte la nouvelle identité (`CREATE_RESULT`, retour
  à la liste de tasks) — l'identifiant de la task n'a pas à être le même.
- **IA facultative** : seulement pour une relation incertaine, elle choisit parmi les candidats ;
  le runtime revalide, plafonne la confiance à 0,7, garde les candidats.

## H. Stratégie de provenance

Inchangée et réutilisée (`business/provenance-resolver.ts`) : une première découverte n'est jamais
une création ; `CREATED_DURING_RECORDING` exige une identité **produite** par une action de
création (réponse, `Location`, message, page de la nouvelle ressource) ; recherche, liste, task,
URL → `DISCOVERED_DURING_RECORDING` ; écran de départ → `CONFIRMED_EXISTING` ; contradictions →
`AMBIGUOUS`. Une task qui **référence** une entité ne dit rien de sa provenance.

## I. Tests

Entité fictive « item », application générique (shell + liste de tasks servie par un BFF +
micro-frontends) :

- A : task → MFE de création → création (clé `ABC123`) → ouverture : `Task → Item`, `CREATE → OPEN`.
- B : recherche `ABC123` → ouverture : `SEARCH → OPEN`, aucune création, aucune task.
- C : task existante → MFE → modification → enregistrement : `SELECT_TASK → OPEN → UPDATE → SAVE`.
- D : création → retour à la liste → BFF → task portant `ABC123` : `CREATE_RESULT` vers la task.
- E : même clé dans plusieurs contextes : relations expliquées (preuves, contextes).
- F : aucun réseau exploitable : flow technique intact, interprétation du DOM seule, rien d'inventé.
- G : informations contradictoires : `AMBIGUOUS`.
- H : MFE sans iframe (éléments personnalisés) · I : MFE dans une iframe · J : SPA, route sans
  rechargement.

## Classification : observer n'est pas une entité métier

**Principe** : OBSERVE → CLASSIFY → CORRELATE → INTERPRET. Un élément vu dans le DOM, une URL, le
réseau, un script ou une configuration n'est pas une entité métier : il est d'abord observé, puis
**classé** (`business/entity-classifier.ts`), puis éventuellement corrélé.

| Classification                           | Exemples                                                                        | Où                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `BUSINESS_ENTITY`                        | un item créé, recherché, ouvert, modifié                                        | `entities`, `businessContext`             |
| `APPLICATION_ENTITY`                     | une task, un espace de travail                                                  | `tasks`, `workspaces`                     |
| `APPLICATION_CONTEXT`                    | un micro-frontend, le shell                                                     | `contexts`                                |
| `TECHNICAL_ENTITY` / `TECHNICAL_CONTEXT` | ressource statique, configuration, nom de composant                             | `technicalContext`                        |
| `INFRASTRUCTURE_ENTITY`                  | découverte OpenID (`.well-known`), OIDC/OAuth, auth redirect, santé, télémétrie | `technicalContext`                        |
| `UNKNOWN`                                | preuves insuffisantes : un résultat normal                                      | `entities`, `businessContext.unknownKeys` |

- **Identifiants stricts** : un identifiant est un nombre, un uuid ou un code qui contient au moins
  un chiffre (`DEM-2026-001`, `ABC123`). `openid-configuration`, `auth-redirect`, un nom de client
  OIDC ou de composant sont des **noms**, jamais des identités.
- **Signaux** (conventions de protocole et de forme, jamais un nom métier) : chemins standards
  (`/.well-known/*`, OpenID configuration, JWKS, `authorize` / `token` / `callback` / `logout`,
  santé, métriques, télémétrie), fichiers statiques et configuration, noms techniques.
- **Métier** seulement si des indices convergent (poids fixes `CLASSIFICATION_WEIGHTS`) : base 0,2 +
  geste de l'utilisateur 0,35 + écriture 0,3 + ressource structurelle 0,15 + création 0,1 ; sous 0,6 :
  `UNKNOWN`. Chaque décision porte `classification`, `confidence`, `reason`, `signals`, preuves.
- Une entité technique ou d'infrastructure ne produit **aucun** événement ni étape métier, aucune
  relation métier ; elle reste une observation dans `technicalContext` (avec ses preuves), tout
  comme les appels réseau et les navigations techniques. Un écran d'authentification est un
  `TECHNICAL_CONTEXT` : jamais un `SWITCH_CONTEXT` du parcours.
- **IA facultative** : elle peut seulement choisir parmi les candidats d'un `UNKNOWN` (plafond 0,7) ;
  jamais promouvoir en métier un élément classé technique ou infrastructure.
- **Trois niveaux par action** (`actions[]`) : `recorded` (toujours), `validation` (`VALIDATED`,
  `AMBIGUOUS`, `FAILED`, `UNVERIFIED`), `interpretation` (actions métier, sinon `UNKNOWN`). Une
  action n'est jamais retirée parce que sa validation ou son interprétation échoue ; la fenêtre
  affiche « N enregistrées · V validées · I interprétées · U non interprétées ».
- **Identités multiples** : chaque entité garde ses candidats (`ENTITY_ID`, `BUSINESS_KEY`,
  `REFERENCE`, `UUID`, `CODE`…) avec source, confiance et preuves.

## Critères de la liste de tasks : `FILTER`, jamais une entité

Sur une vraie application, la liste de tasks est souvent lue par un **POST** (les critères dans le
corps), et l'humain saisit un nom dans les critères avant de choisir une task.

- **Une liste lue par un POST est une lecture** (`isListRead`) : la réponse est une liste et ne porte
  aucun identifiant de réponse ni `Location`. Ses enregistrements sont gardés comme pour un GET ; la
  collection (`collection:POST …`) peut devenir l'espace de travail réseau ; elle ne produit ni
  création, ni intention, ni assertion d'écriture.
- **Une saisie n'est une identité que si elle en a la forme** : un nombre, ou un code qui contient un
  chiffre (fait `hasDigit`, la valeur n'est jamais écrite). Un nom saisi en capitales n'en est pas
  une.
- **Noms versionnés** (`icon-v4-4-0`) : des noms de composants, jamais des identifiants
  (`TECHNICAL_ENTITY`).
- **Jeton / authentification** : un POST vers un chemin d'authentification (`…/token`) n'est ni une
  création, ni une intention (`CREATE:TOKEN` disparaît), ni une assertion retenue : il reste dans le
  Technical Context.
- **`FILTER`** (structurel, sans aucun libellé connu) : dans le contexte de l'espace de travail, des
  critères (`FILL`, `SELECT`, `CHECK`, `UNCHECK`) puis un geste qui, **sans changer de contexte**, fait
  relire la même liste (quelle que soit la méthode ; confiance 0,8), ou, pour un clic, change le
  nombre de lignes affichées (0,6). Une saisie seule ne compte que si elle fait relire la liste : la
  liste peut encore finir de se charger pendant qu'on tape. L'action `FILTER` pointe vers toutes ces
  actions enregistrées et ne garde que les libellés des champs, jamais les valeurs. Sans relecture ni
  changement de lignes, les critères restent `UNKNOWN`.

## Trois contextes, deux sortes d'intents, une création prouvée

**Principe** : OBSERVE → CLASSIFY → CORRELATE → INTERPRET → CONFIRM. Aucune entité métier n'est
inventée ; une authentification n'est jamais une création métier.

- **Observé ≠ métier** : seule une entité `BUSINESS_ENTITY` (preuves fonctionnelles convergentes)
  porte des actions métier (`CREATE`, `OPEN`, `SEARCH`, `UPDATE`, `SAVE`…) et entre dans le Business
  Context.
  - Une entité `UNKNOWN` est gardée avec ses preuves (`businessContext.unknownKeys`, nœud
    « OBSERVED · NOT CLASSIFIED » de la fenêtre), sans action métier.
  - Un item vu seulement par une route et une lecture, après une task, reste une observation : la
    task ouvre le MFE, rien de plus.
- **Règle générale** (`isTechnicalOperation`, appliquée dans `intentOf` pour tous ses appelants) :
  les opérations suivantes ne sont jamais un intent ni une création métier :
  - authentification, OIDC / OAuth, jeton ;
  - JWKS, découverte OpenID ;
  - télémétrie, santé, configuration ;
  - ressources statiques.
- **Opération et intent technique** (`technicalCategoryOf`) :

  | Chemin (convention de protocole) | Opération                                | Intent technique                       |
  | -------------------------------- | ---------------------------------------- | -------------------------------------- |
  | `…/token`, `introspect`          | `TOKEN_ACQUISITION`                      | `ACQUIRE_TOKEN`                        |
  | `authorize`                      | `AUTHORIZATION`                          | `AUTHORIZE`                            |
  | `userinfo`                       | `USER_INFO`                              | `READ_USER_INFO`                       |
  | `callback`, `auth-redirect`…     | `AUTH_REDIRECT`                          | `AUTHENTICATE`                         |
  | `.well-known`, OpenID config     | `OPENID_DISCOVERY`                       | `DISCOVER_PROVIDER`                    |
  | `jwks`                           | `KEY_SET`                                | `READ_KEYS`                            |
  | santé / télémétrie               | `HEALTH_CHECK` / `TELEMETRY`             | `CHECK_HEALTH` / `REPORT_TELEMETRY`    |
  | configuration / statique         | `CONFIGURATION_READ` / `STATIC_RESOURCE` | `LOAD_CONFIGURATION` / `LOAD_RESOURCE` |

  Ces intents techniques sont dans `semantic-intents.json` (`technicalIntents`), séparés des
  intents métier (`intents`), et dans le Technical Context (`operation`, `intent`).

- **Intent métier corrélé** : un `CREATE:…` déduit d'une écriture acceptée n'est qu'une écriture
  observée tant que la couche métier n'a pas prouvé la création (la fenêtre l'indique).
- **`POSSIBLE_CREATE` ≠ `ENTITY_CREATED`** (voir `HUMAN_FLOW_RECORDER.md`) ; dans le modèle, un
  `CREATE` exige la provenance `CREATED_DURING_RECORDING`. Une première observation n'est jamais une
  création (`firstSeen ≠ created`). Les provenances sont inchangées : `CREATED_DURING_RECORDING`,
  `CONFIRMED_EXISTING`, `DISCOVERED_DURING_RECORDING`, `UNKNOWN`, `AMBIGUOUS`.
- **Fenêtre** :

  ```
  APPLICATION CONTEXT
  └── TASK WORKSPACE · POST /…
      └── Task #…
          └── MFE …            (entités métier seulement si démontrées)
  BUSINESS CONTEXT             (seulement si une entité métier est démontrée)
  OBSERVED · NOT CLASSIFIED    (UNKNOWN : gardées, jamais métier)
  TECHNICAL CONTEXT            (AUTHENTICATION / DISCOVERY / … → opération · intent technique)
  ```

## Méthode HTTP ≠ intention, nom de champ ≠ rôle, identité découverte après coup

**Principe** : le sens métier ne se déduit jamais d'un nom de champ, d'une méthode HTTP, d'une URL,
d'un nom d'endpoint ni de la présence d'un « id ». Il se déduit de l'ensemble des observations :
action de l'utilisateur, DOM, réseau, corps envoyés, réponses, contexte, valeurs (en empreintes),
ordre dans le temps et navigation.

### Une recherche par POST est une recherche (`queryEvidenceOf`)

Un échange est une **requête** (recherche, liste par critères) quand les preuves convergent, quelle que
soit sa méthode :

- la réponse est une **collection**, même sans identifiant reconnaissable (`listSize`) ;
- aucune **nouvelle identité** n'est servie (ni identifiant de réponse hors liste, ni `Location`) ;
- des indices s'ajoutent : critères envoyés, conteneur de critères, pagination, tri, GET.

Chaque décision garde ses raisons. « POST ⇒ CREATE » n'est jamais une règle.

### Ce qui est capturé, toujours en empreintes salées (jamais la valeur)

- `requestCriteria` : les valeurs envoyées (corps JSON d'une écriture, paramètres d'URL), avec le
  chemin du champ (`filters.companyName`).
- `ExchangeRecord.attributes` : toutes les valeurs simples de chaque enregistrement d'une réponse.

Ne sont pas capturés : les clés sensibles, les codes d'état, les valeurs d'un caractère, les petits
nombres (pagination). Le sel est le même que celui des saisies, ce qui permet de comparer une
saisie, un corps envoyé et une réponse.

### Le rôle d'une identité (`identity-role.ts`)

Chaque candidat d'identité porte `value`, `field` (le nom du champ, gardé pour lecture),
`semanticRole`, `roleConfidence` et `roleEvidence` (dans l'ordre du parcours : le rôle évolue).

| Rôle           | Preuve                                                                | Confiance |
| -------------- | --------------------------------------------------------------------- | --------- |
| `REFERENCE`    | la valeur est l'identité d'une autre entité observée                  | 0,8       |
| `BUSINESS_KEY` | l'utilisateur l'a saisie (0,75), ou l'application l'a affichée (0,65) |           |
| `TECHNICAL_ID` | seulement dans le réseau (réponse, chemin d'API), jamais affichée     | 0,6       |
| `EXTERNAL_ID`  | jamais supposé : aucune preuve automatique                            | —         |
| `UNKNOWN`      | une URL d'écran seule, un nom de champ seul                           | 0,55      |

Un champ `id` peut donc être une clé métier, et un `businessKey` un identifiant technique. La place
(`type`) ne vient plus du nom non plus :

- `TASK_ID` est la valeur affichée par l'élément cliqué ;
- `REFERENCE` est l'identité d'une autre entité ;
- sinon le type vient de la forme : `UUID`, `ID`, `CODE`.

### EntityCorrelation : CREATE → SEARCH → RESULT → OPEN (`entity-correlation.ts`)

Une entité créée peut être retrouvée par ses **données métier**, sans qu'aucun identifiant n'ait été
visible ni renvoyé à la création :

- la **création** porte des données : les saisies du formulaire et le corps envoyé ;
- la **recherche** suivante envoie des critères ;
- le **résultat** est l'enregistrement dont les attributs portent ces mêmes empreintes ;
- l'**ouverture** est une lecture ou une route qui porte son identité.

Poids fixes (`CORRELATION_WEIGHTS`) :

- une donnée commune : 0,5 ; deux : 0,65 ; trois ou plus : 0,78 ;
- recherche faite avec les données de la création : +0,1 ; résultat unique : +0,05 ; résultat
  ouvert : +0,05 ;
- même identifiant que celui servi à la création : 0,95.

Statuts : `CONFIRMED` ≥ 0,85, `PROBABLE` ≥ 0,6, sinon `UNCERTAIN`.

- **Homonymes** : quand plusieurs résultats portent autant de données, la corrélation est
  `AMBIGUOUS` et aucun n'est choisi. Quand une donnée de plus (l'adresse) départage, le résultat qui
  porte le plus de données est retenu et les autres sont nommés homonymes dans les preuves.
- **Déjà vu avant la création** : un homonyme existant possible, donc `AMBIGUOUS`.
- **Identité découverte après coup** : l'identité du résultat (`id = 123456`) est rattachée à la
  création par les preuves `CORRELATED_CREATION` et `SEARCH_RESULT`.
- **Provenance R10** : « créée, puis retrouvée par ses données métier » donne
  `CREATED_DURING_RECORDING`, même sans identifiant à la création. Sans création dans
  l'enregistrement, une recherche suivie d'une ouverture reste `DISCOVERED_DURING_RECORDING`.
- **Cycle de vie** `CREATE → RETRIEVE → OPEN`. Événements : `ENTITY_CREATED` →
  `ENTITY_RETRIEVED` → `ENTITY_CORRELATED` → `ENTITY_OPENED`. Relation `SEARCH_MATCH`. Le tout est
  écrit dans `correlations` (`application-model.json`, `business-flow.json`).

**Limites** :

- la comparaison est exacte, valeur rognée et sensible à la casse ;
- un terme partiel (« ABC » pour « Société ABC ») ne se corrèle pas à la création : la recherche
  reste une recherche et l'ouverture du résultat garde sa provenance `DISCOVERED` ;
- un corps envoyé qui n'est pas du JSON (formulaire encodé) n'est pas lu.

## Revue humaine

L'interprétation d'une action (`ActionView.interpretation`) n'est jamais modifiée par une décision
humaine : la décision est rangée dans `ActionView.review` et devient une preuve `HUMAN`. Voir
[HUMAN_INTENT_REVIEW.md](HUMAN_INTENT_REVIEW.md).

## Limites connues

- Les **actions à l'intérieur d'une iframe** ne sont pas encore enregistrées (le script de capture
  ne s'installe que dans la page principale, et le rejeu ne cible pas les cadres) : l'iframe est vue
  comme contexte, son contenu non.
- Le modèle est construit et écrit ; le rejeu, la validation et le crawler ne le consomment pas
  encore (`buildApplicationModel()` est pure et prête à l'être).
