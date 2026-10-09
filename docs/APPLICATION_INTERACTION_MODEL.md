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

## Limites connues

- Les **actions à l'intérieur d'une iframe** ne sont pas encore enregistrées (le script de capture
  ne s'installe que dans la page principale, et le rejeu ne cible pas les cadres) : l'iframe est vue
  comme contexte, son contenu non.
- Le modèle est construit et écrit ; le rejeu, la validation et le crawler ne le consomment pas
  encore (`buildApplicationModel()` est pure et prête à l'être).
