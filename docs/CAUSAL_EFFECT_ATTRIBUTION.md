# Attribution causale des effets enregistrés

```
TIME DOES NOT PROVE CAUSALITY.                  UI STABILITY DOES NOT PROVE EFFECT OWNERSHIP.
THE NEXT HUMAN ACTION CREATES A STRONG CAUSAL BOUNDARY.
NETWORK CORRELATION IS STRONGER THAN TEMPORAL PROXIMITY.
RUNTIME IS TRUTH. RECORDING IS EVIDENCE. EXPECTED EFFECTS MUST BE EXPLAINABLE.
```

## Audit du chemin (avant correction)

```
HUMAN ACTION → EVENT CAPTURE → OBSERVATION WINDOW → EFFECT CORRELATION → EXPECTED EFFECT
→ YAML → REPLAY → EFFECT VERIFICATION → WRONG_EFFECT → RECOVERY
```

| Étape                  | Où                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Capture                | `capture-script.ts` (page) → `HumanFlowRecorder.record()`                                              |
| Fenêtre réseau         | `openWindow()` / `assign()` / `closeWindow()` (`FormKnowledgeObserver.startFunctional/stopFunctional`) |
| Observation de l'écran | `HumanFlowRecorder.schedule()` → `observe()`                                                           |
| Navigations            | `ActionCorrelationEngine` (décisions `causedBy`) → `SemanticRecordedAction.navigation`                 |
| Effets attendus        | `attributeEffects()` → `learnExpectedEffects()` (`human-journey.ts`)                                   |
| YAML                   | `recorded-flow.ts` : `effects: action.expectedEffects`                                                 |
| Rejeu                  | `FlowExplorer.runFlowElementStep` → `verifyEffects()` (ActionEffectVerifier)                           |
| Échec → récupération   | `diverged()` → `healDivergence()` (RecoveryEngine, expérimentations bornées)                           |

1. **Début de la fenêtre d'observation.** À la réception de l'événement brut (`record()`). La
   fenêtre réseau s'ouvre (`openWindow`), et l'observation de l'écran est programmée `settleMs`
   (600 ms) après la **première** action en attente (`schedule`).
2. **Fin de la fenêtre.**
   - **Réseau** : quand l'action suivante ouvre sa propre fenêtre, ou quand l'écran observé est
     donné à l'action.
   - **Écran** : le minuteur n'est jamais repoussé. `observe()` attend jusqu'à 2 s de
     `networkidle`, puis prend **une** capture.
3. **Horodatage.** Les événements bruts en ont un (`at`, horloge de la page). Les observations
   d'écran (`RecordedState`) **n'en avaient pas**. Les échanges réseau n'ont pas d'horodatage
   propre ; ils sont rattachés par la fenêtre ouverte.
4. **Identifiant d'action.** Oui pour le réseau : la fenêtre porte l'id de l'événement
   (`startFunctional(event.id)`). Non pour l'écran : `stateAfter` est donné à la liste des
   événements en attente, sans preuve de cause.
5. **Nouvelle action avant la fin de la fenêtre précédente.**
   - **Réseau** : la fenêtre précédente est fermée (`assign(previous)`), ce qui est correct.
   - **Écran** : la nouvelle action **rejoint la même attente**. Une seule capture, prise **après**
     ses propres effets, est donnée aux **deux** actions :
     `for (const event of waiting) event.stateAfter = kept.id`.
6. **Navigation tardive rattachée à l'action précédente.**
   - Par l'`ActionCorrelationEngine`, non : il donne un `causedBy` au clic qui la précède.
   - Par l'écran partagé, **oui** : la route de l'écran capté devient `effects.route` du
     **premier** geste du groupe.
7. **Mutation tardive rattachée à l'action précédente.** **Oui**, par la même observation
   partagée : contrôles apparus et disparus.
8. **Corrélation du réseau.** Oui, par fenêtre et par identité de requête. Une réponse arrivée
   après la fermeture de la fenêtre complète l'échange déjà rapporté. Une requête vue dans deux
   fenêtres revient à la plus récente (`dedupeNetwork`).
9. **Construction de `expectedEffects`.** `attributeEffects()` regroupe les actions qui partagent
   `stateAfter`. Il prend l'écran d'avant le groupe et l'écran capté, puis donne à
   `learnExpectedEffects()` :
   - les contrôles apparus et disparus ;
   - la route si elle change ;
   - la première requête d'écriture (sinon la première requête).
10. **Effet de l'action N+1 dans les attentes de N.** **Oui** (points 5 à 7).
11. **Pourquoi « Apply » attend des effets de la suite.** L'humain clique sur l'action
    suivante avant la capture (moins de `settleMs`, plus le `networkidle` d'« Apply »). Les
    deux clics partagent donc la capture prise **après** la navigation du second. Le groupe donne
    les effets au **premier** geste capable de les produire : « Apply ». Celui-ci attend alors
    la route et les contrôles du nouvel écran. Au rejeu, ce n'est pas le cas :
    WRONG_EFFECT → EXPECTED_EFFECT_CHANGED → récupération → RECOVERY_BUDGET_EXHAUSTED.
12. **La ligne fautive.** `human-journey.ts`, `attributeEffects()` :
    `const owner = enablers[0] ?? group.at(-1);`. L'écran partagé vient de
    `human-flow-recorder.ts`, `observe()` : `for (const event of waiting) event.stateAfter = kept.id`.
    Les deux ensemble attachent l'effet futur à « Apply ».

## Correction (la source de vérité : l'enregistrement)

1. **Frontière forte à l'enregistrement.** Une nouvelle action humaine **ferme** l'observation des
   actions encore en attente : l'écran est capté pour elles **à ce moment**, avant les effets de la
   nouvelle action.
   - Événements : `RECORDING_ACTION_WINDOW_OPENED` / `RECORDING_ACTION_WINDOW_CLOSED`.
   - Chaque observation est horodatée (`observedAt`).
   - Une capture impossible à la frontière (page en navigation) laisse l'action **sans** écran
     d'après, au lieu de la fusionner avec la suivante.
   - Chaque capture porte une identité (`observationId`). Seuls les gestes d'une **même** capture
     partagent un écran : deux captures successives d'un écran inchangé (même `stateAfter`) ne
     sont plus confondues. Les anciennes données sans `observationId` sont regroupées par
     `stateAfter`.
2. **Attribution causale** (`effect-causality.ts`). Chaque effet candidat reçoit :
   - une classification : `DIRECT`, `STRONGLY_CORRELATED`, `POSSIBLY_CORRELATED`,
     `TEMPORAL_ONLY`, `BELONGS_TO_NEXT_ACTION`, `BACKGROUND` ou `AMBIGUOUS` ;
   - un propriétaire (`ownerActionId`) ;
   - une confiance et ses preuves.

   Les règles d'attribution :
   - La requête de la fenêtre de l'action et la navigation corrélée (`causedBy`) sont `DIRECT`.
   - Un écran partagé par plusieurs gestes revient au **dernier** geste, le plus récent avant la
     capture. Pour les gestes précédents, ses effets sont `BELONGS_TO_NEXT_ACTION`.
   - Une capture de frontière prise **après** la navigation de l'action suivante (sa route est
     celle que la corrélation donne à cette action) appartient tout entière à l'action suivante :
     `BELONGS_TO_NEXT_ACTION`, même pour le dernier geste.
   - Une route que la corrélation donne à l'action suivante n'est jamais un effet de celle-ci.
   - Seuls `DIRECT` et `STRONGLY_CORRELATED` deviennent des attentes **obligatoires**.
   - `POSSIBLY_CORRELATED` devient une attente **facultative** (`optional`).
   - Le reste est écarté. Il est consigné dans la provenance et dans la validation.

3. **Provenance dans le YAML.** `effects.provenance` contient le propriétaire et, pour chaque
   effet, sa causalité et sa confiance. `effects.optional` liste les effets facultatifs. Un
   ancien YAML reste valide.
4. **RecordingConsistencyValidator.** Il écrit `recording-validation.json` :
   - statut par action : `CLEAN` / `POSSIBLY_CONTAMINATED` / `CONTAMINATED` / `AMBIGUOUS` ;
   - problèmes détectés :
     - `FUTURE_ACTION_EFFECT_CONTAMINATION` (écarté ou restant) ;
     - `OWNERSHIP_CONFLICT` ;
     - `ROUTE_OWNED_BY_ANOTHER_ACTION` ;
     - `LOW_CONFIDENCE_REQUIRED_EFFECT` ;
   - la **chronologie** de l'enregistrement : actions, observations, navigations, effets retenus
     et écartés par action.

## Défense au rejeu (anciens enregistrements)

Le **WrongEffectAnalyzer** intervient **avant** toute récupération. Classifications :
`APPLICATION_REGRESSION`, `RECORDED_EXPECTATION_CONTAMINATED`, `EXPECTED_EFFECT_MISSING`,
`UNEXPECTED_EFFECT` / `EXPECTED_EFFECT_CHANGED` et `INCONCLUSIVE`.

`RECORDED_EXPECTATION_CONTAMINATED` exige **toutes** les conditions suivantes :

- chaque effet attendu non observé est expliqué par la **suite** du parcours :
  - le contrôle attendu est la cible d'une étape ultérieure (N+2 et au-delà) ;
  - ou la route attendue n'est pas atteinte alors que la cible de l'étape suivante est là ;
- **aucune** écriture refusée (4xx, 5xx) ;
- une preuve runtime que l'action a fonctionné : une requête de l'action réussie, ou un
  changement observé ;
- la cible de l'étape suivante est disponible (le parcours peut continuer).

Dans ce cas :

- **Aucune récupération n'est lancée** : pas d'expérimentation sur le bouton, pas de budget épuisé.
- L'étape continue avec :
  - `effect.status = EXPECTATION_SUSPECT` ;
  - la raison `REPLAY_INCONCLUSIVE_EXPECTATION_DRIFT: RECORDED_EXPECTATION_CONTAMINATED …`.
- La divergence est **conservée** dans `recordingModelDivergence` du rapport de l'étape, séparée de
  la divergence applicative (`FIRST_FUNCTIONAL_DIVERGENCE` n'est pas déplacée).
- Les étapes suivantes vérifient la suite : une vraie régression y échouera.

Événements : `WRONG_EFFECT_ANALYZED`, `REPLAY_EXPECTATION_SUSPECTED`,
`REPLAY_RECORDING_MODEL_DIVERGENCE`.

Une route **prouvée** à l'enregistrement (provenance `DIRECT`) n'est jamais considérée comme
suspecte. Les fichiers utilisateurs ne sont jamais réécrits : `futureEffectsOf` signale seulement
les attentes d'une étape qui désignent la suite du parcours.

Une écriture refusée, une cible suivante absente ou un effet attendu sans lien avec la suite
restent un échec : aucune vraie régression n'est masquée.
