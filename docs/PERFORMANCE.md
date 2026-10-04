# Performance : mesurer, puis FAST PATH / DEEP PATH

Le rejeu était lent sans être faux. Avant d'optimiser quoi que ce soit, le pipeline a été **instrumenté**
et **mesuré** ; l'optimisation a été choisie d'après les mesures, sans réduire un seul délai, sans
retirer une seule vérification.

## 1. Instrumentation (`src/performance/performance-tracer.ts`)

- **PerformanceTracer** : une étape de flow = une `ActionPerformanceTrace` (phases, attentes, chemin
  FAST/DEEP et ses raisons, cache, IA, récupération, avertissements). Les méthodes EXISTANTES du pipeline
  sont mesurées par `instrumentMethods` (aucun changement de leur code ni de leur ordre) : localisation,
  exécution, attente de transition, sonde de la cible suivante, observation d'état, vérification d'effet
  et de valeur, résolution fonctionnelle, healing, récupération, observation fonctionnelle et cognitive,
  capture d'écran, IA, assertion.
- La phase **parente** suit le fil asynchrone (`AsyncLocalStorage`) : des observations concurrentes ne
  deviennent jamais l'une le parent de l'autre ; le résumé ne compte que les phases de premier niveau
  (une phase imbriquée n'est pas comptée deux fois).
- **WaitTrace** : chaque attente de transition, avec `terminationReason` (`CONDITION_MET`, `NO_PROGRESS`,
  `MAX_TIMEOUT`), ses signaux horodatés, et le partage du temps :
  - `usefulWaitMs` : jusqu'à la dernière preuve (le dernier signal de progrès) ;
  - `confirmationWaitMs` : le calme exigé APRÈS cette preuve ;
  - `wastedWaitMs` : une attente terminée sans sa condition, au-delà de la dernière preuve.
- **Sorties** (`performance.tracing.enabled`, par défaut) : `performance.json` (résumé, actions lentes,
  waterfalls, traces), `performance-summary.txt`, et dans `engine-log.jsonl` : `PERFORMANCE_SUMMARY`,
  `SLOW_ACTION_DETECTED` (phase dominante, cause `SLOW_TRANSITION` / `SLOW_TARGET_RESOLUTION` /
  `SLOW_RECOVERY`… / `UNKNOWN_SLOWDOWN`, preuves), `PERFORMANCE_REGRESSION` (baseline).
- **Baseline** (`performance.baseline.file`) : absente, elle est créée ; présente, le run lui est
  comparé — régression au-delà de `tolerance` (×1,3) ET de 500 ms.

## 2. Ce que la mesure a montré

Banc : `tests/integration/performance-benchmark.test.ts` — deux parcours représentatifs d'une liste de
demandes (ouvrir le panneau Filter, choisir champ et opérateur, saisir la valeur, Apply, ouvrir la
demande trouvée ; un dossier client à onglets, section repliable, case à cocher, deux dialogues ouverts
avec chacun son « Apply »), enregistrés par un humain simulé puis rejoués avec la **configuration par
défaut**. `QA_PERF_OUT=<dossier>` copie les rapports.

Avant : chaque action durait ~560 ms, dont **~420 ms d'attente de transition** ; la preuve décisive
(dialogue ouvert, effet enregistré, cible suivante prête) arrivait **en ~40 ms** — le reste (~380 ms par
action, ~90 % de l'attente) était la fenêtre de stabilité complète (400 ms de DOM calme) exigée **après**
que la condition était déjà confirmée. Le reste du pipeline (résolution de cible, exécution, vérifications,
observations) pesait moins de 15 %. Les chiffres détaillés : `docs/performance/`.

## 3. FAST PATH / DEEP PATH (`src/performance/fast-path.ts`)

`evaluateFastPath` (pur) choisit le chemin juste avant l'action. **FAST_PATH** seulement si AUCUNE raison
de prendre le chemin profond :

| Raison DEEP_PATH            | Situation                                                         |
| --------------------------- | ----------------------------------------------------------------- |
| `FAST_PATH_DISABLED`        | `performance.fastPath.enabled: false`                             |
| `UNKNOWN_STEP`              | étape sans empreinte ni effets enregistrés (flow écrit à la main) |
| `LOCATOR_HEALED`            | localisateur réparé                                               |
| `FUNCTIONAL_RESOLUTION`     | cible résolue par la résolution fonctionnelle                     |
| `CONTEXTUAL_RESOLUTION`     | localisateur non unique départagé par le contexte                 |
| `REACQUIRED_AFTER_RERENDER` | cible ré-acquise après un re-rendu                                |
| `RECOVERY_IN_PROGRESS`      | étape rejouée à l'intérieur d'une récupération                    |
| `PREVIOUS_STEP_NOT_PASSED`  | l'étape précédente n'a pas réussi                                 |
| `DANGEROUS_ACTION`          | action DANGEROUS                                                  |

Le choix est journalisé (`FAST_PATH_SELECTED` / `DEEP_PATH_SELECTED` avec ses raisons) et porté par la trace.

## 4. L'attente conduite par la condition (`TransitionTracker`)

En FAST_PATH, une **preuve positive** — l'effet enregistré observé, la requête enregistrée terminée avec
succès (2xx/3xx), la cible de l'étape suivante prête (résolue sur le DOM frais, empreinte, actionnable) —
n'exige plus que `confirmationQuietMs` (150 ms) de calme au lieu de `stabilityWindowMs` (400 ms) :

- le calme reste complet : DOM sans mutation, **aucune requête en vol, aucun indicateur de chargement** ;
- jamais avant `confirmationQuietMs` depuis l'action (une réaction tardive a le temps de commencer) ;
- le signal `CONDITION_CONFIRMED` le dit ;
- **sans preuve positive, rien ne change** : fenêtre complète, `NO_PROGRESS`, borne `transitionTimeoutMs`
  — un effet absent reste un échec (jamais une divergence transformée en PASS) ;
- en DEEP_PATH : le comportement complet, inchangé.

Aucun délai n'a été réduit : `transitionTimeoutMs`, `stabilityWindowMs`, `noProgressTimeoutMs`,
`actionTimeoutMs`, `effectTimeoutMs` gardent leurs valeurs. Aucune vérification n'est retirée :
ActionEffectVerifier (effets, valeurs saisies, état des cases), SafetyPolicy, garde d'écriture et
vérification de la cible suivante s'exécutent pareil sur les deux chemins. Aucune action n'est rejouée
(aucune double mutation possible).

## 5. Configuration

```yaml
performance:
  fastPath:
    enabled: true # false : toujours DEEP_PATH (le comportement d'avant)
    confirmationQuietMs: 150 # calme exigé après une preuve positive (FAST_PATH)
  tracing:
    enabled: true # performance.json, performance-summary.txt, événements
    slowActionThresholdMs: 2000 # SLOW_ACTION_DETECTED au-delà
  baseline:
    file: performance-baseline.json # créé s'il manque, comparé sinon
    tolerance: 1.3
```

## 6. Risques et limites

- Une application qui réagit **plus de 150 ms** après une preuve positive, sans requête ni chargement
  visibles pendant ce temps (minuterie pure), peut voir l'étape suivante commencer plus tôt qu'avant. La
  cible suivante est néanmoins résolue sur le DOM frais et vérifiée par son empreinte, et
  l'ActionEffectVerifier juge toujours l'effet attendu (borné, sur condition). `confirmationQuietMs` se
  règle ; `fastPath.enabled: false` revient au comportement d'avant.
- Une saisie dont l'enregistrement n'a observé aucun effet est confirmée plus tôt : une autocomplétion
  avec un délai long non vue à l'enregistrement n'est pas attendue (si l'enregistrement l'a vue, elle est
  un effet déclaré et elle est attendue).
- Restent hors du chemin chaud mais non optimisés (mesurés faibles sur le banc) : la première localisation
  d'une page (~200 ms, mise en route du moteur de sélecteurs), deux sondes pré-action de la cible suivante
  (10–30 ms chacune), l'observation d'état après l'action (10–70 ms). Les caches de localisateurs, la
  politique de captures, la récupération et l'analyse statique paresseuses n'ont pas été modifiés : la
  mesure ne les désigne pas comme cause sur ces parcours.
