# QA Crawler — Autonomous QA Flow Explorer

Deterministic, container-ready explorer that tests a web application **by using it**.

Give it a URL and a mission in YAML. On each screen it runs the same loop:

1. observes the screen and discovers every possible user action;
2. decides what to try, then has the safety policy validate that choice;
3. executes the action with Playwright and observes the new screen;
4. records the transition in a **flow graph** of the application;
5. backtracks to explore the other branches, until the mission's limits are reached.

Along the way it reports broken pages, failing API calls and JavaScript errors. Each anomaly records the screen, the action and the path that reproduce it.

The YAML never lists the buttons to click. The explorer finds the screens, tabs, dialogs and wizard steps by itself.

No AI, no LLM, no API token, no GPU: same application, same exploration.

- **Stack:** Node.js 20+ · TypeScript (strict) · Playwright 1.56 · Chromium headless · YAML · Docker
- **Designed for:** CI/CD pipelines, Kubernetes / OpenShift (ARO), Angular and other single-page applications

---

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Mission (YAML)](#mission-yaml)
- [Imposed flows](#imposed-flows)
- [Safety](#safety)
- [State detection and loop protection](#state-detection-and-loop-protection)
- [Forms](#forms)
- [What gets detected](#what-gets-detected)
- [Reports](#reports)
- [Command line](#command-line)
- [Docker](#docker)
- [Kubernetes / OpenShift](#kubernetes--openshift)
- [CI/CD](#cicd)
- [Architecture](#architecture)
- [Development](#development)
- [Limitations of this version](#limitations-of-this-version)
- [Roadmap](#roadmap)

---

## Quick start

```bash
npm install
npx playwright install chromium            # once: downloads the matching Chromium

npm run qa -- scenarios/smoke.yaml --base-url http://localhost:4200
```

Try it on the bundled demo applications:

```bash
npm run demo:server                        # terminal 1: back-office on :4174, trap site on :4173
npm run qa -- scenarios/demo.yaml          # terminal 2: discovers the back-office flows
npm run qa -- scenarios/demo-traps.yaml    #             bug traps (404, 500, JS errors, loops…)
open reports/index.html reports/flow-graph.html
```

Example output on the demo back-office. It found the structure by itself, including the three steps of a wizard that never changes URL:

```
Tableau de bord
├── Utilisateurs  ⟵ navigate "Gérer les utilisateurs"
│   └── Utilisateur 1 › Profil  ⟵ navigate "Voir"
│       └── Utilisateur 1 › Historique  ⟵ click "Historique"
├── Dossiers  ⟵ navigate "Dossiers"
│   └── Nouveau dossier › Étape 1 — Informations  ⟵ navigate "Nouveau dossier"
│       └── Nouveau dossier › Étape 2 — Détails  ⟵ click "Suivant"          (same URL)
│           └── Nouveau dossier › Étape 3 — Confirmation  ⟵ click "Suivant" (same URL)
├── Paramètres › Général  ⟵ navigate "Paramètres"
│   ├── Paramètres › Notifications  ⟵ click "Notifications"                 (tab)
│   └── Paramètres › Sécurité  ⟵ click "Sécurité"                           (tab)
└── Administration  ⟵ navigate "Administration"
    └── Journal  ⟵ navigate "Journal"
```

## How it works

The fundamental loop:

```
OBSERVE → DISCOVER ACTIONS → DECIDE → SAFETY CHECK → EXECUTE WITH PLAYWRIGHT
   ↑                                                              ↓
REPEAT ← STORE TRANSITION ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ OBSERVE NEW STATE
```

Each question is answered by exactly one component:

| Question               | Component                                    | Notes                                                                                                                                                                             |
| ---------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Where am I?"          | `UIObserver` + `StateDetector`               | DOM, ARIA roles and accessible names, headings, dialogs, selected tabs, forms. Produces a `PageContext` and a stable `stateId`                                                    |
| "What can I do?"       | `ActionDiscovery`                            | Links, buttons, `[role=button]`, `[routerLink]`, tabs, menus, inputs, textareas, selects, checkboxes, radios. Each action gets a serializable `LocatorDescriptor` and a stable id |
| "What should I try?"   | `DecisionEngine` → `RuleBasedDecisionEngine` | Returns `EXECUTE`, `BACKTRACK` or `STOP`                                                                                                                                          |
| "Is it allowed?"       | `SafetyPolicy.evaluate()`                    | Runs **after** the decision and **before** Playwright, whatever the engine                                                                                                        |
| "Execute it."          | `PlaywrightActionExecutor`                   | Translates the descriptor into `getByRole(...).click()`, `fill`, `selectOption`, `setChecked`. It makes no decisions                                                              |
| "What went wrong?"     | Network, console and page-error observers    | Every anomaly is tagged with `stateId`, `actionId` and the flow path                                                                                                              |
| "What have I learned?" | `FlowGraph` + `FlowMemory`                   | States, transitions, what was tried. Persisted in `reports/flow-graph.json`                                                                                                       |

`FlowExplorer` only sequences these components, keeps the navigation stack, backtracks and enforces the limits.

**Backtracking.** When a screen has nothing left to explore, the explorer returns to the previous state. It tries the cheapest method first, and checks each attempt against the expected `stateId`:

1. browser history (`goBack`);
2. then the state's URL;
3. then a **replay** of the recorded path from the start state. This is needed for states without their own URL: wizard steps, tabs, dialogs.

When the whole path is exhausted, it jumps to any known state that still has unexplored actions.

## Mission (YAML)

The YAML describes a **mission**: a goal and limits. Only `target.baseUrl` is required. To make the explorer follow precise steps as well, add [imposed flows](#imposed-flows).
[`scenarios/example.yaml`](scenarios/example.yaml) documents every key with its default value.

```yaml
mission:
  name: explore-application

target:
  baseUrl: http://localhost:4200
  startAt: /

exploration:
  maxStates: 100
  maxActions: 500
  maxDepth: 10
  maxDurationMinutes: 15
  actionTimeoutMs: 10000

goals:
  discoverNavigation: true # follow links and routerLinks
  discoverForms: true # fill forms with fake data before clicking their step buttons
  discoverFlows: true # click tabs, menus, details, toggles, wizard steps
  detectErrors: true # network / console / JavaScript observers

safety:
  allow: [navigation, search, filter, pagination, tabs] # kinds of SAFE actions allowed
  block: [delete, payment, external-navigation] # risks always refused
```

| Key                                                                            | Default                        | Role                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `exploration.maxStates`                                                        | 100                            | Distinct functional states discovered                                                                                                 |
| `exploration.maxActions`                                                       | 500                            | Actions executed                                                                                                                      |
| `exploration.maxDepth`                                                         | 10                             | Transitions away from the start state                                                                                                 |
| `exploration.maxDurationMinutes`                                               | 15                             | Wall-clock limit                                                                                                                      |
| `exploration.actionTimeoutMs`                                                  | 10000                          | Locating and executing one action                                                                                                     |
| `exploration.maxStatesPerRoute`                                                | 3                              | Samples per route pattern (`/users/:id`)                                                                                              |
| `exploration.settleTimeMs`                                                     | 400                            | Wait after each action (SPA rendering, API calls)                                                                                     |
| `exploration.queryParams.mode`                                                 | `pattern`                      | `?page=1..N` count as one route (`ignore` / `keep`)                                                                                   |
| `goals.*`                                                                      | all `true`                     | What to explore (see above)                                                                                                           |
| `safety.allowedActionClasses`                                                  | `[SAFE]`                       | Classes that may run: `SAFE`, `MUTATION`, `DANGEROUS`, `UNKNOWN`                                                                      |
| `safety.allow`                                                                 | all kinds                      | `navigation`, `tabs`, `menus`, `details`, `pagination`, `search`, `filter`, `forms`, `other`                                          |
| `safety.block`                                                                 | see below                      | `delete`, `payment`, `send`, `logout`, `irreversible`, `sensitive-data`, `external-navigation`, `form-submit`, `mutation`, `download` |
| `safety.allowedHosts` / `ignoredPaths`                                         | host of `baseUrl` / `/logout`… | Where the explorer may go                                                                                                             |
| `exploration.autonomous`                                                       | `true`                         | Explore autonomously after the flows; `false` runs only the flows                                                                     |
| `flows`                                                                        | `[]`                           | [Imposed flows](#imposed-flows), run before the autonomous exploration                                                                |
| `memory.resume`                                                                | `false`                        | Continue from the previous `flow-graph.json`, skipping actions already tried                                                          |
| `checks.*`, `http.*`, `browser.*`, `auth`, `output.*`, `report.failOnSeverity` |                                | As in the example file                                                                                                                |

Unknown keys are rejected, so a typo like `explorations:` fails instead of being ignored.

Scenarios written for the first version (`name`, `maxPages`, `maxUrlsPerRoute`, `clickSafeActions`) still load, with a deprecation warning.

## Imposed flows

The autonomous explorer decides by itself what to click. When a test must follow a precise path (log in, create a record through a wizard, check the confirmation), list the steps in `flows`. [`scenarios/demo-flows.yaml`](scenarios/demo-flows.yaml) is a complete example.

```yaml
flows:
  - name: creer-un-devoir
    description: Create a homework through the 2-step dialog
    startAt: /app/admin/devoirs # page loaded before the first step (default: target.startAt)
    thenExplore: false # true: explore the last screen (and pages below it) right after the flow
    steps:
      - click: { role: button, name: Nouveau devoir }
      - fill: { label: Titre, value: Devoir QA }
      - select: { label: Classe, option: N1 10-12 Dimanche }
      - click: { role: button, name: Suivant }
      - expect: { text: Étape 2 }
      - screenshot: etape-2
      - click: { role: button, name: Enregistrer }
        allow: MUTATION # explicit permission, for this step only
      - expect: { text: Devoir créé }
```

**Steps.** Each step has exactly one action.

| Step         | Example                                            | What it does                                                                            |
| ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `goto`       | `goto: /dossiers`                                  | Loads a page (relative to `target.baseUrl`)                                             |
| `click`      | `click: { role: button, name: Suivant }`           | Clicks the element                                                                      |
| `fill`       | `fill: { label: Titre, value: Dossier QA }`        | Types a value; `value: { env: NAME }` reads it from an environment variable             |
| `select`     | `select: { label: Catégorie, option: Subvention }` | Native `<select>`, or a custom one (Angular Material): opens it and clicks the option   |
| `check`      | `check: { label: J'accepte les conditions }`       | Checks a checkbox (`uncheck` unchecks it)                                               |
| `expect`     | `expect: { text: Étape 2, url: /create }`          | Waits until it holds: `text`, `url` (contains), `visible: <target>`, `hidden: <target>` |
| `screenshot` | `screenshot: confirmation`                         | Named screenshot, linked in the report                                                  |

**Targets** use one strategy, as in Playwright: `role` (+ `name`), `label`, `text`, `testId` or `css`. Add `exact: true` for an exact match and `nth: 2` to pick the third match. Without `nth`, when several elements match, the one inside an open dialog wins (the page behind a modal cannot be clicked).

**Common options** on any step: `name` (label in reports), `allow`, `optional: true` (a failure only warns and the flow goes on), `timeoutMs`.

**Safety still applies.** The YAML chooses the element, but the `SafetyPolicy` classifies it exactly as during autonomous exploration and decides:

| Target                                                                 | Runs?                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `SAFE` (navigation, tab, "Suivant", non-sensitive field…)              | yes                                                                     |
| `MUTATION` (créer, enregistrer, submit…)                               | only with `allow: MUTATION` on the step                                 |
| `UNKNOWN` (icon-only control)                                          | only with `allow: UNKNOWN` on the step                                  |
| `DANGEROUS` (supprimer, payer, envoyer, déconnexion…)                  | **never**                                                               |
| Password, OTP, secret field                                            | only with `value: { env: NAME }`; the value never appears in the output |
| Payment field (card, CVV, IBAN)                                        | **never**                                                               |
| Link or `goto` outside `allowedHosts`, to an ignored or dangerous path | **never**                                                               |

**Run order.**

1. Log in (`auth`) and load `target.startAt`.
2. Run each flow in order, each from a freshly loaded `startAt`. A failed or blocked step stops its flow; the next steps are `SKIPPED`.
3. With `thenExplore: true`, explore the flow's last screen right after the flow, even when `exploration.autonomous` is `false`. This exploration stays in that screen's section: in-page controls (tabs, buttons, details) and links to pages below its path (`/admin/fideles` → `/admin/fideles/12`). The global menu and other pages are left to step 4.
4. With `exploration.autonomous: true` (default), explore the application from `target.startAt`.

**Results.**

- Each flow is `PASSED`, `FAILED`, `BLOCKED` or `SKIPPED`; each step records its status, classification, reason, state and duration.
- A failed or blocked step raises a `FLOW` issue (`ERROR`, or `WARNING` for an optional step) with a screenshot, so the run fails in CI like any other error.
- Flow transitions are stored in the flow graph, tagged with the flow name.
- `index.html` has an _Imposed flows_ section; `result.json` has a `flows` array.

## Safety

The explorer is meant to be pointed at real environments without breaking them.

**1. Every action is classified** by `SafetyPolicy`:

- a French/English vocabulary, matched on whole words without accents;
- the element's label, its link target, its `routerLink`, and the dialog it belongs to ("Confirmer" inside "Supprimer l'utilisateur ?" is DANGEROUS).

| Class       | Examples                                                                                                         | Executed?                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `SAFE`      | navigation, tabs, menus, details, pagination, search, filters, wizard "Suivant", filling a (non-sensitive) field | yes, if its kind is in `safety.allow` |
| `MUTATION`  | créer, enregistrer, modifier, update, submit (form submission), oui/ok/confirmer                                 | **never** by default                  |
| `DANGEROUS` | supprimer/delete, payer/payment, checkout, envoyer/send, réinitialiser, déconnexion/logout, sensitive fields     | **never** by default                  |
| `UNKNOWN`   | controls without a readable label (`⚙`, `×`, icon-only)                                                          | **never**                             |

**2. The gate is enforced after the decision and before execution.** `SafetyPolicy.evaluate()` blocks an action in these cases:

- it is disabled or hidden;
- it carries a blocked risk;
- it navigates outside the allowed hosts, to an ignored path or to a download;
- its class is not allowed;
- its kind is not in `safety.allow`.

A future decision engine, whether a local or a cloud LLM, cannot bypass it.

**3. Blocked actions are recorded** in the flow graph (`BLOCKED` transitions, with the reason) and shown in the reports.

**4. Sensitive data is never filled automatically**, whatever the configuration:

- passwords;
- payment cards (`autocomplete="cc-*"`, card number, CVV, IBAN);
- OTP codes, secrets, social security numbers.

An [imposed flow](#imposed-flows) may fill a password or secret field only with a value read from an environment variable (`value: { env: NAME }`). Payment fields are never filled.

**5. Browser dialogs** (`confirm`, `alert`, `prompt`) are always dismissed. New windows are closed.

**6. No secrets in the output.** Tokens, passwords, `Authorization` headers, cookies, JWTs and sensitive query parameters are redacted in logs and reports. Headers, bodies and field values are never stored.

## State detection and loop protection

A state is not a URL:

- `/dossiers/create` can show steps 1, 2 and 3;
- a tab or a dialog changes the screen without changing the route.

`StateDetector` fingerprints each observation from several signals:

- the route pattern;
- the title and headings;
- open dialogs, selected tabs and `aria-current` items;
- the visible controls (role and name), excluding data links and menus;
- the form fields.

Numbers are masked, so `/users/1` and `/users/2` ("Utilisateur 1/2") are one state.

The result is a readable, stable `stateId` such as `parametres-securite-f3a0baba`.

**Loop protection:**

- every action tried from a state is remembered in the graph and never retried;
- `maxStatesPerRoute` caps both the states and the navigations per route pattern, including UUIDs, hashes, dates and `?page=N`;
- selected tabs and tabs already opened from a sibling state are skipped, and nothing is unchecked;
- a link already followed from another state is not followed again;
- reaching a state already in the current path shrinks the path, which handles circular navigation;
- redirect loops are detected;
- all mission limits apply.

## Forms

- **Discovery.** Every field is discovered with its constraints: `type`, `required`, `min`, `max`, `step`, `minlength`, `maxlength`, `pattern`, and select options.
- **Filling.** When the engine decides to click a button inside a form (a wizard "Suivant", a search), the explorer first fills that form through the `TestDataProvider`. Each field goes through the `SafetyPolicy` first.
- **`DefaultTestDataProvider`.** Its values are deterministic and obviously fake:
  - emails `qa-crawler@example.test`, text `QA Test`;
  - numbers within min/max/step, dates within bounds;
  - required checkboxes checked, first real option of a select.
- **Never filled:** sensitive fields. Mutating submissions stay blocked unless explicitly allowed.

## What gets detected

| Issue type       | Source                                                           | Default severity           |
| ---------------- | ---------------------------------------------------------------- | -------------------------- |
| `HTTP`           | API/resource response ≥ `http.failOnStatus`                      | 5xx → ERROR, 4xx → WARNING |
| `BROKEN_LINK`    | a screen whose document answers ≥ `failOnStatus`                 | 404/410/5xx → ERROR        |
| `REQUEST_FAILED` | network failure (DNS, refused, CORS)                             | WARNING                    |
| `CONSOLE`        | `console.error` (and `console.warn` if enabled)                  | ERROR (WARNING)            |
| `PAGE_ERROR`     | uncaught JavaScript exception                                    | ERROR                      |
| `PAGE_CRASH`     | renderer crash                                                   | CRITICAL                   |
| `NAVIGATION`     | redirect loop, timeout, action leading outside the allowed hosts | ERROR (WARNING)            |

Each issue is attributed so it can be reproduced:

```json
{
  "type": "HTTP",
  "severity": "ERROR",
  "status": 500,
  "requestUrl": "http://localhost:4174/api/logs",
  "stateId": "journal-fd0e3d2c",
  "actionId": "a-3f81c2d9e0",
  "flow": ["tableau-de-bord-e511f0f8", "administration-316d9318", "journal-fd0e3d2c"]
}
```

Identical anomalies are merged into one issue, which counts its occurrences and lists every state where it was seen.

## Reports

| File                                   | Content                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports/result.json`                  | Mission summary and statistics. States with their full actions (locators, classification) and forms, transitions, attributed issues, effective settings     |
| `reports/index.html`                   | Static report: summary cards, discovered flow tree, HTTP/JS/navigation anomalies (state · action · flow), states, executed and blocked actions, screenshots |
| `reports/flow-graph.json`              | The flow graph, used as the explorer's memory (resumable with `memory.resume`)                                                                              |
| `reports/flow-graph.html`              | Application map: collapsible tree, text tree, transitions between states, other attempts                                                                    |
| `screenshots/NNN-<state>[-error…].png` | One per discovered state, plus one per ERROR/CRITICAL anomaly                                                                                               |

The reports use no JavaScript, framework or external asset.

**French reports.** Set `report.language: fr` to get `index.html` and `flow-graph.html` in French: titles, columns, statuses (`RÉUSSI`, `ÉCHOUÉ`, `BLOQUÉ`, `IGNORÉ`), classes, severities and the safety policy's reasons. `result.json` and `flow-graph.json` always stay in English, so tools and CI read the same keys and values.

```yaml
report:
  language: fr # en (default) | fr
```

## Command line

```bash
npm run qa -- scenarios/demo.yaml
npm run qa -- --config scenarios/smoke.yaml --base-url https://pr-42.example.com --max-states 30 --max-actions 100
npm run qa -- --help
```

The CLI prints:

- the mission, target, goals, limits and safety rules;
- every new state, action (with its result), blocked action and backtrack;
- the anomalies as they are found;
- the discovered flow tree;
- the summary and the location of the reports.

**Exit codes:** `0` no issue at or above `report.failOnSeverity`, `1` failing issues, `2` invalid usage or mission, `3` runtime failure.

## Docker

The image is based on the official Playwright image (`mcr.microsoft.com/playwright:v1.56.1-noble`). It runs as the non-root `pwuser`, with no GPU, no display and no special privileges.

```bash
docker build -t qa-crawler .

docker run --rm \
  -e QA_BASE_URL=https://staging.example.com \
  -v "$PWD/reports:/app/reports" -v "$PWD/screenshots:/app/screenshots" \
  qa-crawler --config scenarios/smoke.yaml
```

> Keep the `playwright` version in `package.json` and the image tag in the `Dockerfile` identical.

## Kubernetes / OpenShift

The image is ready for a `Job` or `CronJob`:

- **Resources:**
  - Requests: `cpu: 500m`, `memory: 1Gi`.
  - Limits: `cpu: 1–2`, `memory: 2Gi`.
  - Memory grows with heavy SPAs and full-page screenshots.
- **Headless only:** no GPU, X server, `privileged` or added capability. Chromium runs without its own sandbox (Playwright's default), which allows an arbitrary UID.
- **Arbitrary UID (OpenShift):** outputs are group-0 writable and `HOME=/tmp`, so the image works under `restricted-v2`.
- **Shared memory:** `--disable-dev-shm-usage` is on by default. Alternatively, mount an `emptyDir` (`medium: Memory`) on `/dev/shm`.
- **Network:** egress to the target application (and its identity provider when authenticating) only.
- **Outputs:** write `reports/` and `screenshots/` to a mounted volume. Use `--reports-dir` / `--screenshots-dir` to change the paths.
- **Configuration:**
  - missions from a `ConfigMap`;
  - the URL through `QA_BASE_URL`;
  - credentials from a `Secret` exposed as `QA_USERNAME` / `QA_PASSWORD`.

| Variable                     | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `QA_BASE_URL`                | Target URL (overrides the mission)                 |
| `QA_USERNAME`, `QA_PASSWORD` | Default credential variables for `auth.type: form` |
| `PLAYWRIGHT_BROWSERS_PATH`   | Chromium location (set by the Playwright image)    |
| `NO_COLOR`                   | Plain output (set in the image)                    |

## CI/CD

`.github/workflows/qa-crawler.yml` runs on every push and pull request, in this order:

1. `npm ci`
2. typecheck
3. lint
4. format check
5. unit tests
6. build
7. Chromium install and integration tests against the two bundled applications

An optional job explores a real environment and uploads the reports. It runs when the repository variable `TARGET_URL` is set, or on a manual run.

## Architecture

```
                         Mission YAML
                              |
                              v
                      QA Orchestrator
                              |
               +--------------+--------------+
               v                             v
          Flow Explorer                 Safety Policy
               |
               v
          UI Observation  (DOM · accessibility · URL/state)
               |
               v
          Page Context ──> State Detector
               |
               v
        Action Discovery  (link · button · tab · routerLink · input · select · checkbox…)
               |
               v
        Decision Engine ──> Selected Action ──> Safety Policy ──> BLOCK (recorded)
                                                     |
                                                   ALLOW
                                                     v
                                    Playwright Action Executor ──> Chromium ──> Application
                                                                                    |
                                                          Network · Console · Page errors
                                                                                    |
                                                                          Anomaly collector
                                                                                    |
                                                                  State Detector (new state)
                                                                                    |
                                                                              Flow Graph
                                                                              /        \
                                                                     Flow Memory     Reporters
                                                                (flow-graph.json)  JSON · HTML · Graph
```

```
src/
├── main.ts, orchestrator.ts      entry point; mission → explorer → reports → verdict
├── cli/                          arguments, console output, exit codes
├── config/                       mission schema (zod) with defaults, YAML loader, V1 migration
├── explorer/flow-explorer.ts     the loop, navigation stack, backtracking, limits
├── observation/                  UIObserver (DOM snapshot script), StateDetector
├── discovery/                    ActionDiscovery (pure), locator builder
├── decision/                     DecisionEngine interface, RuleBasedDecisionEngine
├── policies/                     SafetyPolicy, NavigationPolicy, vocabulary
├── execution/                    PlaywrightActionExecutor, locator resolver
├── data/                         TestDataProvider, DefaultTestDataProvider
├── graph/                        FlowGraph
├── memory/                       FlowMemory interface, JsonFlowMemory
├── observers/                    network, console, page errors (with attribution)
├── anomaly/                      severity rules, issue collector
├── crawler/                      URL and route normalization
├── browser/                      Chromium lifecycle, screenshots
├── auth/                         form authentication (credentials from env)
├── reporting/                    result builder, JSON, HTML, flow graph HTML, flow tree
├── security/                     redaction
└── model/                        PageContext, DiscoveredAction, LocatorDescriptor, FlowNode/Edge, Issue…
```

### Replacing the decision engine

```ts
interface DecisionEngine {
  readonly name: string;
  decide(context: PageContext, graph: FlowGraph): Promise<ActionDecision>; // EXECUTE | BACKTRACK | STOP
}
```

The engine receives only plain, serializable data:

- the `PageContext`: URL, state, headings, text excerpt, classified actions with their locators, forms, known errors;
- the `FlowGraph`.

A `LocalLLMDecisionEngine` or `CloudLLMDecisionEngine` can be passed to `runMission(config, { decisionEngine })`. Nothing else changes: the explorer, the safety gate, the executor and the observers stay as they are.

This version contains **no LLM code or dependency**.

## Development

```bash
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # ESLint, typescript-eslint strict type-checked
npm run format:check     # Prettier
npm test                 # unit tests (Vitest), no browser needed
npm run test:integration # real Chromium against the two bundled applications
npm run build            # dist/
```

**Unit tests** cover:

- `ActionDiscovery`, locator descriptors and their Playwright translation;
- `StateDetector`, `FlowGraph` and `JsonFlowMemory`;
- `SafetyPolicy`, `NavigationPolicy` and `RuleBasedDecisionEngine`;
- `TestDataProvider` and route and URL normalization;
- the config loader, redaction, the flow tree and the CLI arguments.

**Integration tests** explore two bundled applications:

- `tests/fixtures/flow-app.ts`, a mini back-office. The test asserts that the explorer discovers:
  - the screens;
  - the tabs and the 3 wizard steps on one URL;
  - the transitions, with backtracking;
  - the expected tree.

  It also checks that no destructive endpoint is ever reached and that the card field is never filled.

- `tests/fixtures/test-site.ts`, a site full of bugs and traps. The test checks that every anomaly is detected and attributed, and that no secret leaks.

## Limitations of this version

- One browser tab: exploration is sequential.
- The state fingerprint is heuristic: very dynamic screens can produce more states than expected (bounded by `maxStatesPerRoute`).
- The rule-based engine cannot know what an unlabelled icon does, so icons are never clicked.
- Mutating actions (create/save/submit) are never executed. Their effects are not explored unless explicitly allowed on a disposable environment.
- Backtracking by replay needs the path to be deterministic; states that can't be restored are skipped.
- Only one form of authentication, and a single role.
- Shadow DOM and iframes are not explored.

## Roadmap

- Multi-role authentication (one exploration per role, SSO/OIDC, stored sessions)
- Automatic form testing with the `TestDataProvider`: required fields, invalid email, min/max and boundary values
- Permission tests (what a role must not reach)
- OpenAPI import and API testing
- Visual comparison between runs (screenshots per state)
- Generation of Playwright tests from the recorded flows (locators are already serializable)
- Decision engines behind the `DecisionEngine` interface, including an optional local LLM
- Runs against per-pull-request environments, with an automatic PR comment
- Parallel exploration, SQLite/PostgreSQL `FlowMemory`, Kubernetes `Job` manifests
