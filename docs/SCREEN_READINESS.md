# Screen readiness (before an action)

`ScreenReadinessService.waitUntilReady(page, { target, kind, network, onState })`
(`src/observation/screen-readiness.ts`) answers one question: **can the action be done on this
target now?** It waits for what really prevents acting, and only for that.

## Rules

- **Waiting is not judging.** Past `timeoutMs` the result is `status: 'TIMEOUT'` with its reasons and
  `proceed: true`: the caller logs it (`readinessSummary`) and performs the action anyway. The action
  and the verification of its effect decide a failure. Only a closed page gives `proceed: false`.
- **A control is never covered by its own skin.** A native radio or checkbox hidden under a styled
  element, its associated `<label>`, a Material / ARIA wrapper (`mat-radio-button`, `[role=radio]`…)
  or the smallest common ancestor of the input and its label that holds a single control: advisory
  `covered_by_own_control`. An in-flow layout element over the target: advisory
  `covered_by_in_flow_element`.
- **Real layers block** (`target_covered`, `obstruction.coveringKind: 'OVERLAY'`): a modal that does
  not contain the target (`obstruction.modal`), a backdrop, a loader, a fixed or sticky element on
  top. A dialog that contains the target is not an obstacle.
- **Loaders**: only a loader overlapping the target, an `aria-busy` ancestor, or a full-screen loader
  (≥ 50 % of the viewport). A small spinner elsewhere does not delay the action; a determinate bar
  at its maximum is not loading.
- **Screens that never stop moving**: mutations in timers, `aria-live` regions, canvas / svg / video,
  progress bars and busy regions are ignored; any other DOM change or a moving target delays the
  action at most `maxDomMutationWaitMs` (advisories `dom_unstable_ignored`,
  `target_unstable_ignored`).
- **Target checks by action kind**: `fill` needs an editable field; `expect` only needs the target
  visible (a disabled control can be verified); `navigate` or no target: screen-level checks only.
  After an action (no target) an open dialog is a normal state.
- A target below the fold is scrolled into view once (`target_scrolled_into_view`).
- Critical requests are waited for only with a `network` observer; without one the advisory
  `network_not_observed` is recorded (never an exception).
- Its own DOM probe (`__qaReadiness`): it never touches the transition synchronization probe.

## Settings

`timeoutMs` (10 000), `stabilityWindowMs` (200), `maxDomMutationWaitMs` (3 000),
`waitForCriticalNetwork`, `detectLoadingIndicators`, `detectOverlays`, `loadingSelector`,
`pollIntervalMs` (100; the wait wakes up early on the next DOM mutation).

Tests: `tests/integration/screen-readiness.test.ts` (17 real-browser cases).

## Clic robuste : le contrôle de la cible n'est jamais un obstacle

**Le problème :** Playwright refuse un clic tant qu'un autre élément reçoit le pointeur au point visé (« … intercepts pointer events »), et réessaie jusqu'au délai (20 s). C'est correct pour un vrai obstacle. C'est faux quand cet élément est **le contrôle de la cible**. Exemple : l'input natif invisible d'un radio, posé en `position: fixed` sur son libellé « No ».

**Le clic (`click` d'un flow) procède en trois temps :**

1. **Essai** (`trial`) : si la cible est actionnable, clic normal.
2. **Sinon, diagnostic au centre de la cible.** L'élément reçu est classé :
   - `SELF` : la cible elle-même ;
   - `OWN_CONTROL` : le contrôle de la cible (`label.control`, ou l'unique champ de son enveloppe) ;
   - `FOREIGN` : un autre élément ;
   - `NONE` : rien.
3. **Selon le diagnostic :**
   - `OWN_CONTROL` : clic au **même endroit** (force), comme un humain. Si l'option d'un libellé de radio ou de case est encore non cochée, son contrôle est cliqué.
   - `FOREIGN` : **jamais forcé**. Le clic normal attend la disparition de l'obstacle jusqu'au délai. L'erreur dit ce qui recouvre la cible, par exemple `— on top of the target: <div> (FOREIGN)`.

## Journal de débogage

```bash
QA_DEBUG=1 npm run qa -- explore mission.yaml       # Windows : set QA_DEBUG=1
```

Avec `QA_DEBUG=1`, ou `logging: { level: debug }` dans la mission, le terminal affiche chaque décision de clic :

```
[debug click] click: not actionable after 1503 ms — target <label> "No", on top <input[type=radio] name=g> (OWN_CONTROL), own control <input[type=radio] name=g>
[debug click] click: playwright: - <input type="radio" …> intercepts pointer events
[debug click] click: the element on top is the target’s own control — clicking at the same point (force)
```

Les mêmes lignes sont écrites dans `engine-log.jsonl` (événement `EXECUTION_DEBUG`, niveau DEBUG).
