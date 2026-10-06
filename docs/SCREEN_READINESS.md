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
