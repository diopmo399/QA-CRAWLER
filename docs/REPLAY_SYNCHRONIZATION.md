# Synchronisation des transitions au rejeu

```
ACTION_EXECUTED ≠ TRANSITION_COMPLETED ≠ UI_STABLE ≠ EFFECT_CONFIRMED
```

Un `locator.click()` qui retourne prouve seulement que l'action a été **techniquement exécutée**.
Une SPA continue ensuite : elle change de vue, re-rend, ouvre ou ferme un dialogue, charge des
données, active un contrôle, traite une requête. Valider à ce moment-là produisait de faux échecs
(`TARGET_MISMATCH`, `TARGET_FUNCTIONAL_MISMATCH`, `TARGET_NOT_FOUND`, `WORKFLOW_DRIFT`).

## Audit : où la validation démarrait trop tôt

Dans `FlowExplorer.runFlowElementStep` :

1. **Exécution.** `FlowStepExecutor.perform` appelle `locator.click()` (ou `fill`, `selectOption`,
   `check`).
2. **« Terminé ».** Juste après, `settle()` attend `domcontentloaded`, puis un **sommeil fixe**
   (`settleTimeMs`). Pour un clic seulement, il attend aussi `waitForScreenReady`.
3. **Ce que mesurait `waitForScreenReady`.** 200 ms sans changement du **nombre** d'éléments, et
   aucun indicateur de chargement visible. Il ignorait :
   - le réseau ;
   - la route ;
   - les dialogues ;
   - les mutations qui ne changent pas le nombre d'éléments (texte, attributs, nœud remplacé).
4. **Validation.** `observeState()` capture l'écran « après ». `verifyEffects`
   (ActionEffectVerifier) juge l'effet. `waitForEffect` n'intervient que si l'effet manque.
   - Pour une saisie, un choix ou une case, rien n'attendait l'écran.
5. **Étape suivante.** `locate(N+1)` part tout de suite. Il retient le premier élément **attaché**,
   qui peut appartenir à l'**ancien DOM**. L'empreinte n'est lue qu'une fois. Une cible résolue
   pendant le rendu devenait un mismatch, puis une résolution fonctionnelle, voire une divergence.

Le manque était entre (2–4) et (5). Il n'y avait aucune notion de transition attendue, aucun
réseau corrélé à l'action, et aucune préparation de l'action suivante.
`replay.uiStabilization` existait dans la configuration, mais rien ne l'utilisait.

## Le pipeline

```
avant      : sonde posée (MutationObserver, route, dialogues), cible N+1 déjà prête ?
exécution  : PlaywrightActionExecutor / FlowStepExecutor.perform        → ACTION_EXECUTED
transition : UITransitionWaiter                                          → TRANSITION_*
               ├─ mutations du DOM (attributs internes data-qa-crawler-* ignorés)
               ├─ route / URL (une transition valide peut garder la même URL)
               ├─ dialogues / overlays (role=dialog, aria-modal, .cdk-overlay-pane…)
               ├─ indicateurs de chargement (BUSY_SELECTOR de screen-ready, opportuniste)
               ├─ réseau CORRÉLÉ (NetworkTraceRecorder.activity — jamais « networkidle »)
               ├─ effets enregistrés (ActionExpectedEffects : contrôle apparu, route)
               └─ préparation de l'action suivante (NextActionReadiness)
stabilité  : aucune mutation pertinente pendant stabilityWindowMs, ni chargement, ni requête
après      : observeState() sur le DOM frais
effet      : ActionEffectVerifier (inchangé) → CONFIRMED / NO_EFFECT / WRONG_EFFECT / AMBIGUOUS
suite      : résolution de N+1 sur le DOM frais, empreinte vérifiée, relue après re-rendu
```

Le waiter **observe** ; l'ActionEffectVerifier **décide** du sens fonctionnel. Un DOM qui change
n'est pas un effet confirmé (`transitionDetected ≠ expectedEffectConfirmed`).

### Signaux

| Famille    | Signaux                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| Écran      | `DOM_CHANGED`, `URL_CHANGED`, `ROUTE_CHANGED`, `DIALOG_OPENED`, `DIALOG_CLOSED`            |
| Chargement | `LOADER_APPEARED`, `LOADER_DISAPPEARED`                                                    |
| Réseau     | `NETWORK_ACTIVITY_STARTED <méthode> <chemin>`, `NETWORK_ACTIVITY_COMPLETED … <statut>`     |
| Intention  | `EXPECTED_EFFECT_OBSERVED`, `NEXT_ACTION_TARGET_AVAILABLE`, `NEXT_ACTION_TARGET_NOT_READY` |
| Stabilité  | `UI_STABLE <durée>`                                                                        |

### Résultat de l'attente

| Statut                     | Sens                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `NEXT_ACTION_READY`        | la cible de l'étape suivante est prête et l'interface stable             |
| `TRANSITION_CONFIRMED`     | un signal fort (route, dialogue, effet, réseau terminé, chargement fini) |
| `STABLE_WITH_LOCAL_EFFECT` | seul le DOM a changé, puis s'est stabilisé                               |
| `NO_TRANSITION_EXPECTED`   | saisie sans effet enregistré : seulement une courte stabilité            |
| `AMBIGUOUS`                | rien observé, rien de précis attendu (après `graceMs`, pas la borne)     |
| `TIMEOUT`                  | la borne est atteinte : ce qui manquait est listé (`missing`)            |

**Points de contrôle.** Un effet enregistré, ou une cible suivante **absente avant** l'action,
est un point de contrôle : l'attente ne conclut pas avant que l'un des deux soit atteint, ou que
la borne arrive.

Cas particulier : la cible suivante est présente, mais son empreinte diffère. Une fois l'écran
durablement stable (2 × la fenêtre), l'attente s'arrête, et c'est la résolution de cible de
l'étape suivante qui juge.

### Préparation de l'action suivante

`nextReadiness` résout la cible de N+1 avec le **résolveur existant** (sémantique, contextuel par
section). Elle exige ensuite :

- un élément visible et actif ;
- une empreinte qui correspond (`matchFingerprint`).

Un élément trouvé par le localisateur brut dans l'ancien DOM n'est **pas** « prêt ».

La cible de N+1 n'est jamais résolue d'avance pour être réutilisée. Elle l'est de nouveau sur le
DOM frais, au début de l'étape N+1.

### Re-rendu

Quand l'empreinte de la cible courante ne correspond pas, l'explorateur ne conclut pas tout de
suite (`reacquireAfterRerender`) :

1. il attend la stabilité, sans aucune action ;
2. il re-résout la cible sur le DOM frais ;
3. il relit son empreinte.

Si elle correspond, le résultat est `TARGET_REACQUIRED_AFTER_RERENDER` (journal, rapport). La
résolution fonctionnelle, et le conseiller IA, n'interviennent qu'**ensuite**.

### Temps ≠ divergence

Une borne atteinte n'est jamais présentée comme un mismatch.

- **L'action elle-même échoue, l'écran ne s'est jamais stabilisé** :
  `TRANSITION_TIMEOUT (this action: the screen never settled …) — ACTION_NOT_CONFIRMED …`.
- **L'action elle-même échoue, l'écran est stable mais l'effet n'est pas venu** : c'est une vraie
  absence d'effet. La raison reste `ACTION_NOT_CONFIRMED (NO_EFFECT) …`, complétée par
  `(transition TIMEOUT after … ms, screen stable …)`.
- **La cible de l'étape suivante est introuvable juste après une transition en TIMEOUT** :
  `TRANSITION_TIMEOUT (the previous step: …) — …`.

Deux formulations distinguent les causes :

- « the screen never settled » : DOM, chargement ou requête encore actifs ;
- « the expected transition never came » : écran stable, mais sans l'effet attendu.

Après synchronisation, une vraie divergence **reste** une divergence : la récupération
(`intelligentRecovery`) prend le relais comme avant.

Quand la synchronisation a déjà atteint sa borne, `waitForEffect` n'attend pas une seconde fois.

## Effets attendus : rôle respecté, apparition réelle

L'ActionEffectVerifier applique deux règles :

- **Rôle compatible.** Un effet `appears: dialog:Filter` n'est jamais satisfait par un _bouton_
  « Filter ». Le nom seul ne suffit que pour un rôle de la même famille, car un re-rendu peut
  changer le rôle lu :
  - bouton / lien / élément de menu ;
  - textbox / combobox / searchbox ;
  - dialog / alertdialog ;
  - etc.
- **Apparition réelle.** Un `appears` exige un contrôle **absent avant** l'action. Un contrôle déjà
  à l'écran n'est pas l'effet de l'action.

## Ce qui ne change pas

- **Pas de sommeil fixe.** Avec la synchronisation active, le sommeil `settleTimeMs` après
  `perform` est remplacé par l'attente sur conditions. L'échantillonnage (50 ms) est un intervalle
  de lecture, jamais une condition de succès.
- **Le réseau n'est jamais « networkidle ».** Seules comptent les requêtes parties dans
  `networkCorrelationMs` après l'action. Une requête corrélée encore ouverte au-delà de
  `networkPendingCapMs` ne bloque plus la stabilité (interrogations périodiques, SSE, analytics).
- **Rien n'est rejoué pendant une synchronisation.** Le waiter n'agit jamais. La SafetyPolicy reste
  prioritaire. Une action MUTATION/DANGEROUS n'est jamais retentée (`retryMutations: false`).
- **L'IA n'est pas consultée parce que le rendu est lent.** Elle n'intervient qu'après l'attente, la
  stabilisation, l'observation fraîche, la relecture de la cible et la vérification de l'effet.
  Elle reçoit alors `transitionSignalsObserved` : statut, signaux, manques, stabilité, assainis.
- **L'enregistrement n'est pas modifié.** La validation à sec du recording (RECORDING TARGET
  VALIDATION) est distincte de la synchronisation du rejeu. Une cible validée pendant
  l'enregistrement peut être temporairement indisponible au rejeu : c'est l'attente qui le gère.

## Journal et rapport

Événements (journal du moteur) :

- `ACTION_EXECUTED`, `TRANSITION_WAIT`, `TRANSITION_SIGNAL`, `UI_STABLE` ;
- `TRANSITION_CONFIRMED` / `NEXT_ACTION_READY` / `TRANSITION_TIMEOUT` ;
- `EFFECT_VERIFY` ;
- `TARGET_REACQUIRED_AFTER_RERENDER`.

Terminal, sous chaque étape :

```
[TRANSITION_WAIT] NEXT_ACTION_READY in 1432 ms · UI_STABLE 411 ms · next READY · DOM_CHANGED · NEXT_ACTION_TARGET_NOT_READY … · NEXT_ACTION_TARGET_AVAILABLE · UI_STABLE 411 ms
```

ou, à la borne :

```
[TRANSITION_WAIT] result=TRANSITION_TIMEOUT after 2517 ms
  signals=…
  expected=EXPECTED_EFFECT_OBSERVED, NEXT_ACTION_TARGET_AVAILABLE (not on the screen yet)
```

Le rapport HTML affiche, pour chaque étape :

- `execution` / `transition` ;
- `stability` / `next action` ;
- `signals`, `missing`, `reacquired after rerender`.

Ce bloc permet de distinguer un problème de localisateur, de transition, d'effet fonctionnel, ou une
régression.

## Configuration

```yaml
replay:
  uiStabilization: true # interrupteur général (existant)
  synchronization:
    enabled: true
    transitionTimeoutMs: 10000 # BORNE, jamais la condition de succès
    stabilityWindowMs: 400 # calme requis (DOM, chargement, requêtes corrélées)
    noTransitionCapMs: 1500 # saisie sans effet attendu : borne de la stabilité
    graceMs: 1000 # rien observé, rien de précis attendu : conclure sans attendre la borne
    networkCorrelationMs: 1500
    networkPendingCapMs: 5000
    observeDomChanges: true
    observeRouteChanges: true
    observeNetwork: true
    observeDialogs: true
    observeLoaders: true
    useExpectedEffects: true
    useNextActionAsCheckpoint: true
    reacquireAfterRerender: true
```

`replay.uiStabilization: false` ou `synchronization.enabled: false` rétablit l'ancien comportement :
sommeil `settleTimeMs`, puis `waitForScreenReady` pour un clic.

## Tests

`tests/unit/transition-waiter.test.ts` teste la décision pure, sans navigateur :

- dialogue retardé ;
- cible suivante retardée ;
- même URL ;
- loader ;
- réseau ;
- polling ;
- saisie sans transition ;
- vraie borne ;
- localisateur périmé ;
- ambiguïté ;
- route ;
- empreinte différente.

`tests/integration/transition-synchronization.test.ts` teste en vrai navigateur, avec
`tests/fixtures/transition-app.ts` :

- le problème réel, avant (échec) et après (PASS) ;
- dialogue retardé de 800 ms ;
- onglet sur la même URL ;
- re-rendu ;
- relecture après re-rendu d'une saisie ;
- loader ;
- réseau de 700 ms ;
- polling permanent ;
- borne réelle (`NO_EFFECT` honnête sur l'action quand l'écran est stable, `TRANSITION_TIMEOUT` sur l'étape suivante).
