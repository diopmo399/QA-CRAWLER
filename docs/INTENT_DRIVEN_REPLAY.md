# Rejeu piloté par intention et état

Le rejeu d'un flow n'est plus « rejouer une liste de clics » mais **rejouer un objectif** :

```
Step 12
  ↓ INTENTION         SUBMIT_REQUEST (enregistrée avec l'action, jamais à sa place)
  ↓ PRÉCONDITIONS     « Can I execute this action? » champs soumis encore remplis, cible activée, route, dialogue, overlay
  ↓ PLANIFICATEUR     la cible enregistrée est là ? sinon une résolution apprise, sinon un candidat sémantique
  ↓ EXÉCUTION         Playwright (SafetyPolicy d'abord, écriture gardée)
  ↓ EFFET             ActionEffectVerifier : EXECUTED ≠ CONFIRMED
  ↓ ÉTAT FONCTIONNEL  checkpoint : « résultats affichés », « demande créée »
  ↓ CONFIANCE         cible × intention × préconditions × effet × état
  ↓ COMMIT / ROLLBACK position fonctionnelle mise à jour, divergence localisée, résolution apprise
Step 13
```

Le problème que cela résout : un clic « vert » dont l'écran ne réagit pas, une saisie dans le mauvais
champ, une étape suivante qui attend en vain — parce que le rejeu raisonnait en **actions** alors que
le parcours se joue en **états**.

Tout le raisonnement est dans `src/replay/` (pur, testable sans navigateur) ; l'explorateur fournit
l'observation et l'exécution. Les vérificateurs existants (effets, résolution de cible, self-healing)
décident toujours du statut d'une étape : le rejeu piloté par intention **sait** où en est le parcours
et l'écrit dans le rapport ; il n'exécute jamais rien que la SafetyPolicy n'ait jugé.

## 1. ReplayStateMachine : où le parcours en est

`src/replay/state-machine.ts`. Pour chaque flow, le rejeu tient une **position fonctionnelle**
(`ReplayPosition`) :

```yaml
flowId: company
stepIndex: 8
confirmedCheckpoints: [CP1_GOTO_ITEMS, CP2_ENTER_VALUE, CP3_SEARCH_ITEM]
currentIntent: { name: SELECT_ITEM, status: CONFIRMED, confidence: 0.91 }
expectedState: { route: /items, controls: [link:Item 42] }
observedState: { route: /items, controls: [button:Search] }
lastConfirmedAction: 3
lastConfirmedCheckpoint: CP3_SEARCH_ITEM
divergence: { stepIndex: 8, window: { from: CP3_SEARCH_ITEM, to: CP4_RESULTS_SHOWN }, rootStep: 3 }
```

Une étape est **commise** quand son verdict transactionnel tient ; sinon la position ne progresse pas
(`ROLLED_BACK`). Quand une étape échoue, la divergence est localisée **entre le dernier checkpoint
confirmé et le premier qui manque**, avec l'étape racine d'après les dépendances. Événement :
`REPLAY_POSITION` à chaque étape.

## 2. Checkpoints fonctionnels : ce qui est réellement confirmé

`src/replay/checkpoints.ts`. Au lieu de vérifier seulement chaque action, le rejeu dérive du flow
les **états** qui doivent tenir après chaque étape :

| Source                | Prédicats                                                                  |
| --------------------- | -------------------------------------------------------------------------- |
| `effects` enregistrés | contrôles apparus / disparus, route, requête (`GET /api/items`)            |
| `functionalIntent`    | le nom du checkpoint (`CP3_SEARCH_ITEM`) et sa force                       |
| étape `expect`        | texte, URL, élément visible / caché, réponse d'API                         |
| étape suivante        | la cible de la prochaine action doit être disponible (`CONTROL_AVAILABLE`) |

Un checkpoint est `STRONG` (effets enregistrés requis, `expect`, ou deux sources) ou `WEAK` (une seule
source heuristique : il ne fait jamais échouer le parcours). Après chaque étape, l'état observé
(contrôles, route, requêtes de la fenêtre, texte, dialogue — jamais une valeur saisie) donne
`CONFIRMED`, `FAILED` (aucun prédicat, checkpoint fort), `INCONCLUSIVE` ou `SKIPPED`.

```
CP1 search screen loaded ✔   CP2 criteria entered ✔   CP3 search executed ✔
CP4 results shown ✘          CP5 item selected –      CP6 request created –
```

Si l'étape 8 échoue alors que CP4 manque, la divergence est **entre CP3 et CP4**, pas à l'étape 8.
Événements : `CHECKPOINT_CONFIRMED`, `CHECKPOINT_FAILED`, `CHECKPOINT_INCONCLUSIVE`.

## 3. Préconditions et dépendances : pourquoi l'étape suivante ne peut pas marcher

`src/replay/preconditions.ts`. Les **dépendances** sont dérivées du flow seul :

```
fill Name (2) ─FILLS_FIELD─▶ click Search (3) ─REVEALS_TARGET─▶ click Item 42 (4)
goto /items (1) ─REACHES_ROUTE─▶ …    click Edit (5) ─OPENS_DIALOG─▶ fill Description (6)
```

Avant chaque action, ses **préconditions** sont lues à l'écran :

| Précondition     | Sévérité | Ce qui est vérifié                                                       |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `TARGET_PRESENT` | HARD     | la cible parmi les contrôles visibles (le localisateur reste juge)       |
| `TARGET_ENABLED` | SOFT     | un contrôle désactivé ne prend pas l'action                              |
| `FIELD_FILLED`   | HARD     | un champ saisi plus tôt, soumis par cette action, tient encore sa valeur |
| `ROUTE`          | SOFT     | la route atteinte par le `goto` précédent                                |
| `DIALOG_OPEN`    | SOFT     | le dialogue qui contenait la cible à l'enregistrement                    |
| `NO_OVERLAY`     | SOFT     | aucun calque bloquant                                                    |
| `CHECKPOINT`     | SOFT     | le dernier checkpoint fort précédent est confirmé                        |
| `TEST_DATA`      | HARD     | la donnée citée a été produite dans ce run                               |

Une précondition non satisfaite est **expliquée** en remontant la chaîne : « `click Item 42` requires
`click Search` (3) requires `fill Name` (2) » jusqu'à l'étape la plus en amont qui n'a pas tenu
(`PRECONDITION_ROOT_LOCATED`). Trois modes (`replay.intentDriven.preconditions`) :

- `advise` (défaut) : vérifiées, signalées (`PRECONDITION_NOT_MET`), expliquées, versées au rapport et à
  la confiance ; l'action s'exécute (une valeur retirée par un flow peut être voulue).
- `enforce` : une saisie perdue avant une soumission est **rétablie une fois** (la valeur de ce run,
  relue ensuite) ; une précondition HARD toujours insatisfaite n'est **pas exécutée**
  (`PRECONDITION_NOT_MET … not executed`, avec l'étape racine).
- `off`.

## 4. ReplayPlanner : rejouer vers une intention, pas vers un sélecteur

`src/replay/planner.ts`. Quand la cible enregistrée manque (après l'empreinte, le contexte et le
healing), le planificateur demande : **quelle action à l'écran permet l'objectif ?**

```
Goal:            SEARCH_ITEM
Current state:   /items, criteria entered
Available:       button Run search · button Cancel · textbox Name · button Delete
Planner:         RECORDED ? non · HISTORICAL « Run search » (learned 2 success) → proposé
```

- `RECORDED` : la cible enregistrée est là → elle, rien d'autre.
- `HISTORICAL` : une résolution apprise dans ce contexte, présente à l'écran → proposée d'abord
  (`RESOLUTION_PROPOSED`). Exécutée par le planificateur.
- `SEMANTIC` : même genre de contrôle, libellé proche ou qui dit la même intention UI (SEARCH, SAVE,
  OPEN_DIALOG…) ; un libellé d'annulation contredit l'intention ; un champ n'est jamais candidat. Calculé
  et rapporté ; exécuté seulement avec `semanticCandidates: true` — par défaut la récupération par
  objectif (bornée, vérifiée par la progression de l'objectif) reste la voie des renommages.
- `NONE` / `AMBIGUOUS` : deux candidats aussi plausibles → rien n'est choisi arbitrairement.

Le candidat retenu est jugé par la SafetyPolicy, localisé strictement, puis **confirmé par l'effet
seulement** (`targetMatch: PLANNED`). Événements : `REPLAY_PLAN`, `REPLAY_PLAN_AMBIGUOUS`.

## 5. Mémoire des résolutions : apprendre des réparations

`src/replay/resolution-memory.ts`, `KnowledgeBase.recordTargetResolution`. Une résolution confirmée est
mémorisée **par action et par écran** (`click|button|search|/items/{id}`) :

```json
{
  "original": "Search",
  "kind": "click",
  "route": "/items/{id}",
  "resolutions": {
    "button:Run search": { "how": "GOAL_RECOVERY", "successes": 2, "failures": 0, "lastSuccessAt": "…" }
  }
}
```

Elle vient d'une récupération par objectif confirmée par la suite du parcours (un seul remplacement)
ou d'un plan dont l'effet a été confirmé. Au rejeu suivant elle est **proposée** (`HISTORICAL`), avec un
poids = échantillon(succès) × part de succès × récence × version — jamais une vérité : le runtime
confirme, et un échec est appris aussi (deux échecs sans succès : évitée). Événement :
`RESOLUTION_LEARNED`.

## 6. Verdict transactionnel et confiance

Chaque étape porte un verdict à cinq phases (`FlowStepReport.replay.verdict`) :

```json
{
  "preconditions": "SATISFIED",
  "execution": "SUCCESS",
  "target": "CORRECT",
  "effect": "FAILED",
  "functionalState": "UNCHANGED",
  "outcome": "ROLLED_BACK"
}
```

`execution: SUCCESS` avec `effect: FAILED` est un **échec**, quoi que dise Playwright. Puis une confiance
par dimension et combinée (moyenne géométrique pondérée : une dimension faible tire tout vers le bas) :

```
target 0.98 · intent 0.95 · preconditions 1.00 · effect 0.95 · state 1.00 → 0.97
target 0.92 · intent 0.54 · effect 0.30                              → 0.52 : REPLAY_LOW_CONFIDENCE
```

Sous `replay.intentDriven.minConfidence` (0,6), une étape — même `PASSED` — n'est jamais continuée en
silence : `REPLAY_LOW_CONFIDENCE`, `lowConfidenceSteps` dans le rapport du flow.

## 7. Rapport

- `FlowStepReport.replay` : position, préconditions (et l'explication racine), dépendances de l'étape,
  plan, verdict, confiance, résultats des checkpoints.
- `FlowRunReport.replay` : tous les checkpoints avec leur statut, les dépendances, la position finale,
  la fenêtre de divergence, les étapes peu sûres, la confiance moyenne, les résolutions apprises.
- HTML : bloc « Intent-driven replay » repliable par flow (checkpoints ✔ ✘ ? –, position, divergence,
  apprentissages) et une ligne par étape (verdict, confiance, préconditions, plan, checkpoints).
- `engine-log.jsonl` : les événements ci-dessus.

## Configuration

```yaml
replay:
  intentDriven:
    enabled: true # false : le rejeu d'avant, à l'identique
    checkpoints: true
    preconditions: advise # off | advise | enforce
    planner: true
    semanticCandidates: false # true : le planificateur exécute aussi un candidat sémantique
    learnResolutions: true
    minConfidence: 0.6
    semanticThreshold: 0.6
    ambiguityMargin: 0.12
```

## Règles

1. L'intention est rejouée ; l'action enregistrée reste la première candidate, jamais remplacée sans preuve.
2. Un clic réussi n'est jamais un succès : effet et état fonctionnel décident.
3. Une précondition manquante remonte à sa cause ; le symptôme n'est pas réparé à sa place.
4. Le planificateur propose ; la SafetyPolicy juge ; l'effet confirme ; la mémoire retient.
5. L'historique suggère, jamais ne prouve ; un échec s'apprend autant qu'un succès.
6. Sous le seuil de confiance, rien ne continue en silence.
7. Le flow d'origine n'est jamais modifié.
