# Intention fonctionnelle : element + contexte + action humaine + état

L'intention d'une action enregistrée n'est plus déduite du seul élément (`<button>Search</button>` → `CLICK`).
Elle est résolue à partir de **tout ce que l'enregistrement sait** de l'action : le libellé et le rôle,
le contexte structurel (formulaire, section, dialogue, onglet, ligne), les actions voisines (les
champs remplis juste avant, ce que la suite rend disponible), les effets observés (lignes qui
changent, dialogue ouvert, route, contrôles apparus, case cochée), le réseau (lecture d'une
collection, écriture, changement d'état métier), le cycle de vie des entités de la couche métier, les
décisions humaines mémorisées et la bibliothèque d'intentions apprise.

```
RawAction → SemanticRecordedAction
    ↓
IntentEvidenceEngine      (src/intent/evidence.ts)   preuves typées, chacune dit qui elle soutient / contredit
    ↓
FunctionalIntentResolver  (src/intent/resolver.ts)   candidats → score → contradictions → statut
    ↓
FunctionalIntent          (src/intent/model.ts)      3 niveaux + preuves + candidats + statut
    ↓
Humain (revue)  ·  IA (arbitre, AMBIGUOUS seulement)  ·  bibliothèque (connaissance)
```

## Trois niveaux, toujours ensemble

| Niveau      | Vocabulaire                                                                                                                                                                                                                                                                                        | Exemple       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Physique    | CLICK, FILL, CLEAR, SELECT, CHECK, UNCHECK, SUBMIT, NAVIGATE, UPLOAD, DRAG_AND_DROP, CONFIRM, CANCEL                                                                                                                                                                                               | `CLICK`       |
| Interface   | OPEN_SECTION, CLOSE_SECTION, OPEN_MENU, SELECT_TAB, OPEN_DIALOG, CLOSE_DIALOG, CONFIRM, CANCEL, SEARCH, FILTER, SORT, PAGINATE, ADD, REMOVE, EDIT, SAVE, SUBMIT, NEXT, BACK, SELECT_ITEM, DESELECT_ITEM, OPEN_ITEM, ENTER_VALUE, CHOOSE_OPTION, TOGGLE, NAVIGATE, UPLOAD, MOVE_ITEM, LOGIN, LOGOUT | `SEARCH`      |
| Fonctionnel | opération × entité : CREATE, SEARCH, FILTER, OPEN, SELECT, UPDATE, SAVE, SUBMIT, DELETE, TRANSITION, NAVIGATE, AUTHENTICATE × l'entité que l'application nomme (ressource d'API, route)                                                                                                            | `SEARCH_ITEM` |

Le niveau fonctionnel est un **couple opération × entité**, jamais un nom métier codé en dur : les
opérations sont le seul vocabulaire fixe, l'entité vient de l'application (`/api/items` → `item`).
Sans entité nommée, l'intention est `SEARCH_ENTITY`. La forme générale (`genericOf`) sert à la
bibliothèque : ce que l'outil a appris sur une recherche d'items vaut comme indice pour une recherche
de clients.

## Les preuves (IntentEvidenceEngine)

Chaque preuve a un type, une confiance propre et le **plafond de confiance de sa source** (le même
que le moteur cognitif : RUNTIME 1, DOM / NETWORK 0,95, ACCESSIBILITY 0,85, HUMAN_RECORDING 0,8,
STATIC / OPENAPI 0,6, HISTORICAL 0,5, LLM 0,2). Elle liste les candidats qu'elle soutient (le premier
est son candidat principal, les suivants pèsent 55 %) et ceux qu'elle contredit. Aucune valeur saisie
n'y entre : des libellés, des rôles, des formes de requête (`GET /api/items`), des comptes.

| Type                                                                                          | Source                 | Ce qu'il dit                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LABEL, ROLE, INPUT_TYPE                                                                       | l'élément              | « Search » → SEARCH (et contre SAVE, CANCEL) ; `tab` → SELECT_TAB                                                                                           |
| FORM_CONTEXT, SECTION, DIALOG, TAB, ROW                                                       | le contexte structurel | dans un formulaire → SUBMIT / SAVE / SEARCH ; dans une ligne → OPEN / SELECT_ITEM                                                                           |
| FILLED_CRITERIA, PREVIOUS_ACTION, NEXT_ACTION                                                 | les actions voisines   | 1-2 champs posés avant → SEARCH / FILTER ; ≥ 3 → SUBMIT / CREATE ; la suite choisit dans une liste → SEARCH                                                 |
| EFFECT_ROWS, EFFECT_DIALOG, EFFECT_ROUTE, EFFECT_APPEARS, EFFECT_DISAPPEARS, EFFECT_SELECTION | l'état avant / après   | la liste change → SEARCH / FILTER ; un dialogue s'ouvre → OPEN_DIALOG ; route avec id → OPEN_ITEM                                                           |
| NETWORK_LIST, NETWORK_READ, NETWORK_WRITE, NETWORK_STATE                                      | le réseau              | GET collection → SEARCH × ressource ; POST sans id → CREATE ; PUT → UPDATE ; état DRAFT → SUBMITTED → SUBMIT / TRANSITION ; authentification → AUTHENTICATE |
| BUSINESS_LIFECYCLE                                                                            | la couche métier       | le cycle de vie d'une entité attribué à l'action (CREATE prouvé, SEARCH, OPEN…)                                                                             |
| OPENAPI_OPERATION                                                                             | le contrat             | `operationId: searchItems` → SEARCH (suggère)                                                                                                               |
| HUMAN_DECISION                                                                                | la revue humaine       | la décision prise sur **ce même écran et ce même élément** (jamais une règle globale)                                                                       |
| HISTORY                                                                                       | la bibliothèque        | « geste + libellé + forme des requêtes » déjà confirmé N fois                                                                                               |
| SAFETY_CLASSIFICATION                                                                         | la SafetyPolicy        | MUTATION → SUBMIT / SAVE ; DANGEROUS → REMOVE / DELETE                                                                                                      |

## Le résolveur

1. Les candidats (`ui:SEARCH`, `op:SEARCH:item`) reçoivent la combinaison « noisy-or » de leurs preuves
   pour, diminuée des preuves contre ; une opération par entité hérite des preuves de l'opération générique.
2. Les candidats incompatibles avec le geste sont écartés (une saisie n'est jamais un SEARCH).
3. **Rivaux** : même groupe exclusif (SEARCH / FILTER / SORT / PAGINATE), groupes opposés (lire vs
   écrire vs renoncer, ouvrir vs naviguer), ou preuves croisées. Deux rivaux à moins de `margin` →
   **AMBIGUOUS**, quelle que soit la confiance. Deux intentions compatibles (OPEN_DIALOG et EDIT) ne se
   disputent pas : la meilleure gagne, l'autre reste une alternative.
4. **Contradictions** : deux candidats UI forts, chacun contredit par les preuves de l'autre (le libellé dit
   « Cancel », le réseau a créé une entité) ; une contradiction empêche CONFIRMED.
5. Statut : CONFIRMED ≥ 0,85, PROBABLE ≥ 0,6, sinon AMBIGUOUS (des candidats) ou UNKNOWN (aucune preuve).
   Un 0,51 n'est jamais « SEARCH » : c'est AMBIGUOUS avec `SEARCH 0,51 · SUBMIT 0,42 · CONFIRM 0,07`.

Déterministe : les mêmes preuves donnent toujours la même intention. Seuils : `recording.intent.thresholds`.

## À côté de l'action brute, jamais à sa place

- `recorded-flow.json` : chaque étape porte `functionalIntent` (nom, statut, confiance, niveaux, alternatives,
  contexte, effets attendus).
- `generated.flow.yaml` : l'étape garde sa cible et sa valeur ; elle porte en plus `functionalIntent:`
  (informatif, jamais exécuté, jamais une raison d'échec) et un commentaire `functionalIntent SEARCH_ITEM CONFIRMED 0.85`.
  Le `.feature` garde le même commentaire ; les deux fichiers rejouent les mêmes étapes.
- `functional-intents.json` : toutes les intentions avec leurs preuves, candidats et contradictions.
- `application-model.json` : chaque vue d'action porte `functionalIntent` ; `summary.actions.intentOnly`
  compte les actions UNKNOWN pour l'interprétation métier mais résolues ici.
- `index.html` (rapport d'enregistrement) : section « Functional intents », une ligne par action.
- Self-healing : `WorkflowContext.businessIntent` lit d'abord l'intention enregistrée (ses preuves),
  l'heuristique du libellé (`OPEN_<libellé>`) ne sert que sans elle.

```yaml
- click: { role: button, name: Search }
  functionalIntent:
    name: SEARCH_ITEM
    status: CONFIRMED
    confidence: 0.85
    ui: SEARCH
    operation: SEARCH
    entity: item
    alternatives: [SEARCH_ENTITY, SEARCH, FILTER]
    context: { route: /items, form: item-search, section: Search, entity: item }
    expectedEffects: [RESULTS_UPDATED, ROWS_CHANGED, NETWORK_REQUEST]
```

## Humain, IA, apprentissage

- **Revue humaine** : les décisions existantes (`human-review.json`, connaissance fonctionnelle) deviennent
  des preuves HUMAN_DECISION pour le même écran et le même élément.
- **Arbitre IA** (`recording.intent.ai`, `ai.mode ≠ OFF`) : pour une intention **AMBIGUOUS** seulement, le
  conseiller reçoit les candidats et toutes les preuves (`A1..An` sont des candidats, pas des actions) et
  en choisit **un** ; la réponse passe par la validation existante (schéma, identifiants, preuves citées).
  Il ne crée jamais d'intention et ne touche ni au flow enregistré ni au YAML (qui gardent l'intention
  déterministe : un enregistrement est identique avec ou sans IA) : l'arbitrage vit dans
  `functional-intents.json` et le rapport. Audit : `functional-intent-decisions.json`, événement
  `FUNCTIONAL_INTENT_ARBITRATED`. Sans réponse valable, l'intention reste AMBIGUOUS.
- **Bibliothèque** (`recording.knowledge`) : les intentions CONFIRMED / PROBABLE entrent dans la connaissance
  fonctionnelle (`intentPatterns`, clé « geste | libellé | forme des requêtes », forme générale
  `SEARCH_ENTITY`) et reviennent comme preuves HISTORY (plafond 0,5, croissant avec les confirmations).
  Une autre intention pour la même clé repart de 1 : jamais une règle gravée.

## Configuration

```yaml
recording:
  intent:
    enabled: true # false : aucune intention fonctionnelle (le flow est inchangé)
    ai: true # une intention AMBIGUOUS peut être soumise au conseiller (ai.mode ≠ OFF)
    thresholds: { confirmed: 0.85, probable: 0.6, margin: 0.12 }
```

## API

```ts
import { resolveRecordingIntents, resolveFunctionalIntent, collectIntentEvidence } from '@qa-crawler/core';
const { intents, summary } = resolveRecordingIntents({ kept, states, entities, decisions, history });
```

## Limites

- Les entités viennent des ressources d'API et des routes : une application sans API lisible (ou aux
  chemins opaques) donne des intentions d'interface (niveau 2) et `*_ENTITY` au niveau 3.
- Les mots des libellés sont ceux des listes de mots-clés existantes (FR / EN) ; un vocabulaire métier
  propre passe par les décisions humaines et la bibliothèque, pas par une liste codée.
- L'arbitre IA ne tranche qu'entre candidats déterministes : s'ils sont tous faux, l'intention reste fausse
  et visible comme telle (ses preuves sont dans le rapport).
