# QA Crawler

Deterministic, container-ready QA crawler for web applications.

Give it a URL and a YAML scenario: it explores the application with a real
headless Chromium (Playwright), and reports broken pages, failing API calls,
JavaScript errors and console errors. It also inventories every link, button
and form it finds, and classifies each one by risk. It **never** triggers
destructive actions on its own.

No AI, no LLM, no API token, no GPU: same input, same crawl.

- **Stack:** Node.js 20+ · TypeScript (strict) · Playwright 1.56 · Chromium headless · YAML · Docker
- **Designed for:** CI/CD pipelines, Kubernetes / OpenShift (ARO), Angular and other single-page applications

---

## Contents

- [Quick start](#quick-start)
- [Command line](#command-line)
- [Docker](#docker)
- [Scenario configuration (YAML)](#scenario-configuration-yaml)
- [Safety](#safety)
- [What gets detected](#what-gets-detected)
- [Reports](#reports)
- [Architecture](#architecture)
- [Authentication](#authentication)
- [Kubernetes / OpenShift](#kubernetes--openshift)
- [CI/CD](#cicd)
- [Development](#development)
- [Limitations of this version](#limitations-of-this-version)
- [Roadmap](#roadmap)

---

## Quick start

```bash
npm install
npx playwright install chromium        # once: downloads the matching Chromium

npm run qa -- scenarios/smoke.yaml     # crawl http://localhost:4200 (edit the scenario or use --base-url)
```

Try it against the bundled demo site, which contains deliberate bugs and traps:

```bash
npm run demo:server                    # terminal 1: http://localhost:4173
npm run qa -- scenarios/demo.yaml      # terminal 2
open reports/index.html
```

## Command line

```bash
npm run qa -- scenarios/smoke.yaml
npm run qa -- --config scenarios/smoke.yaml
npm run qa -- --config scenarios/smoke.yaml --base-url https://pr-42.example.com --max-pages 20
npm run qa -- --help
```

| Option                               | Description                                            |
| ------------------------------------ | ------------------------------------------------------ |
| `-c, --config <file>`                | Scenario file (or pass it as the first argument)       |
| `--base-url <url>`                   | Overrides `target.baseUrl` (also `QA_BASE_URL`)        |
| `--max-pages <n>`                    | Overrides `exploration.maxPages`                       |
| `--headed`                           | Visible browser, for local debugging (needs a display) |
| `--reports-dir`, `--screenshots-dir` | Output locations                                       |
| `-q, --quiet`                        | Summary only                                           |

The CLI prints:

- the scenario and target URL;
- the progress, page by page;
- each new anomaly as it is found;
- a final summary with the location of the reports.

After the build (`npm run build`) the same CLI is available as `node dist/main.js` (or `qa-crawler`).

**Exit codes** — usable directly as a CI gate:

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| 0    | No issue at or above `report.failOnSeverity` (default `ERROR`) |
| 1    | Failing issues found                                           |
| 2    | Invalid usage or invalid scenario                              |
| 3    | Runtime failure (Chromium could not start, login failed…)      |

## Docker

The image is based on the official Playwright image
(`mcr.microsoft.com/playwright:v1.56.1-noble`), which bundles Chromium and its
system libraries. It runs as the non-root `pwuser` and needs no GPU, no
display, no extra capability and no `privileged` mode.

```bash
docker build -t qa-crawler .

# Crawl an application reachable from the container, keep the reports on the host
docker run --rm \
  -e QA_BASE_URL=https://staging.example.com \
  -v "$PWD/reports:/app/reports" -v "$PWD/screenshots:/app/screenshots" \
  qa-crawler --config scenarios/smoke.yaml

# Use your own scenario
docker run --rm -v "$PWD/my-scenarios:/app/my-scenarios:ro" -v "$PWD/reports:/app/reports" \
  qa-crawler --config my-scenarios/app.yaml

# Application running on the host
docker run --rm --add-host=host.docker.internal:host-gateway \
  qa-crawler --config scenarios/smoke.yaml --base-url http://host.docker.internal:4200
```

> Keep the `playwright` version in `package.json` and the image tag in the
> `Dockerfile` identical: Playwright only drives the Chromium build it was released with.

## Scenario configuration (YAML)

Only `target.baseUrl` is required. [`scenarios/example.yaml`](scenarios/example.yaml)
documents every key with its default value.

```yaml
name: smoke-test

target:
  baseUrl: http://localhost:4200
  startAt: /

browser:
  headless: true

exploration:
  maxPages: 50
  maxDepth: 5
  navigationTimeoutMs: 15000

checks:
  consoleErrors: true
  pageErrors: true
  httpErrors: true
  brokenLinks: true
  screenshots: true

http:
  failOnStatus: 400

safety:
  allowedHosts:
    - localhost
  ignoredPaths:
    - /logout
    - /payment
    - /delete
```

| Section       | Key                                 | Default                     | Role                                                      |
| ------------- | ----------------------------------- | --------------------------- | --------------------------------------------------------- |
| `target`      | `baseUrl`                           | — (required)                | Application URL. `--base-url` / `QA_BASE_URL` override it |
|               | `startAt`                           | `/`                         | First page                                                |
| `browser`     | `headless`                          | `true`                      | Headless Chromium                                         |
|               | `viewport`, `locale`, `userAgent`   | 1366×768                    | Browser context                                           |
|               | `ignoreHttpsErrors`                 | `false`                     | Self-signed certificates on test environments             |
|               | `args`                              | `[--disable-dev-shm-usage]` | Extra Chromium flags                                      |
| `exploration` | `maxPages`                          | `50`                        | Hard cap on visited pages                                 |
|               | `maxDepth`                          | `5`                         | Link distance from the start page                         |
|               | `navigationTimeoutMs`               | `15000`                     | Per navigation                                            |
|               | `waitUntil`                         | `load`                      | `load`, `domcontentloaded`, `networkidle`, `commit`       |
|               | `settleTimeMs`                      | `500`                       | Extra wait so SPAs render and call their APIs             |
|               | `maxUrlsPerRoute`                   | `2`                         | URLs visited per route pattern (`/users/:id`, `?page=`)   |
|               | `queryParams.mode`                  | `pattern`                   | `pattern` / `ignore` / `keep` (see below)                 |
|               | `queryParams.ignored`               | `utm_*`, `fbclid`…          | Params removed before comparing URLs                      |
|               | `followRouterLinks`                 | `true`                      | Follow Angular `[routerLink]` on non-anchor elements      |
|               | `clickSafeActions`                  | `false`                     | Let the decision engine click SAFE buttons                |
|               | `maxActionsPerPage`                 | `5`                         | Click budget per page                                     |
| `checks`      | `consoleErrors`, `consoleWarnings`  | `true`, `false`             | Console messages                                          |
|               | `pageErrors`                        | `true`                      | Uncaught exceptions                                       |
|               | `httpErrors`                        | `true`                      | Responses ≥ `http.failOnStatus`                           |
|               | `requestFailures`                   | `true`                      | DNS / connection / CORS failures                          |
|               | `brokenLinks`                       | `true`                      | Visited pages answering ≥ `failOnStatus`                  |
|               | `screenshots`                       | `true`                      | Screenshot every page                                     |
|               | `screenshotOnError`                 | `true`                      | Always screenshot pages with ERROR/CRITICAL issues        |
| `http`        | `failOnStatus`                      | `400`                       | Status threshold                                          |
|               | `ignoreStatus`, `ignoreUrlPatterns` | `[]`                        | Noise filters                                             |
| `safety`      | `allowedHosts`                      | host of `baseUrl`           | Only these hosts are crawled (`*.example.com` allowed)    |
|               | `ignoredPaths`                      | `/logout`, `/signout`…      | Never visited (prefix, `*`, `**`)                         |
|               | `allowedActionClasses`              | `[SAFE]`                    | Action classes that may be executed                       |
|               | `keywords.safe/mutation/dangerous`  | `[]`                        | Extra classification vocabulary                           |
| `auth`        | `type`                              | `none`                      | `none` or `form` (see [Authentication](#authentication))  |
| `output`      | `reportsDir`, `screenshotsDir`      | `reports`, `screenshots`    | Output folders                                            |
| `report`      | `failOnSeverity`                    | `ERROR`                     | Exit code threshold (`NONE` disables)                     |

Unknown keys are rejected, so a typo like `explorations:` fails instead of being silently ignored.

**Query parameters.**

- In `pattern` mode (the default), URLs are grouped by parameter _names_, so `?page=1`, `?page=2`… count as one route, capped by `maxUrlsPerRoute`.
- `ignore` drops all parameters.
- `keep` treats every query string as a distinct page, bounded only by `maxPages`.

## Safety

The crawler is designed to be pointed at real environments without breaking them.

**1. Every action is classified** by `SafetyPolicy` (`src/policies/safety-policy.ts`),
using a French/English vocabulary. Matching is on whole words, without accents,
and camelCase identifiers are split: `deleteUserButton` is matched as "delete user button".

| Class       | Examples                                                                                        | Executed automatically?          |
| ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| `SAFE`      | navigation links, pagination, tabs, filters, search                                             | only if `clickSafeActions: true` |
| `MUTATION`  | create, save, edit, update, _Enregistrer_, _Nouvelle inscription_, any non-search form submit   | **never** by default             |
| `DANGEROUS` | delete, _supprimer_, pay, _paiement_, checkout, send email/message, reset, logout, irreversible | **never** by default             |
| `UNKNOWN`   | a button the rules cannot interpret (icon-only, unlabeled)                                      | **never**                        |

The rules and their precedence:

- DANGEROUS takes precedence over MUTATION, which takes precedence over SAFE.
- An unrecognised button is `UNKNOWN`, not `SAFE`: when in doubt, the crawler does not click.
- `allowedActionClasses` controls what may be executed (default `[SAFE]`). Adding `MUTATION` or `DANGEROUS` prints a warning. It is meant for disposable environments only.
- Right before a click, the element's live label is checked again. If it changed, the action is re-classified and refused unless it is still allowed.

**2. Navigation is restricted** by `NavigationPolicy`. It never visits:

- another host than `allowedHosts`;
- `ignoredPaths`;
- URLs containing a dangerous word (`/users/3/delete`, `/checkout`);
- downloads (`.pdf`, `.zip`, …);
- non-http schemes (`mailto:`, `javascript:`).

**3. Forms are never submitted** (search forms excepted when `clickSafeActions` is on).
Their structure is recorded instead.

**4. No secrets in the output.** A redaction layer (`src/security/redactor.ts`) masks sensitive values in every log line, issue and report:

- password, token and API key values;
- `Authorization` headers and `Bearer` tokens;
- JWTs and cookies;
- sensitive query parameters and `user:password@` in URLs.

Request and response headers and bodies are never stored, and form field values are never read.

## What gets detected

| Issue type       | Source                                                            | Default severity                         |
| ---------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `HTTP`           | API/resource response ≥ `failOnStatus`                            | 5xx → ERROR, 4xx → WARNING               |
| `BROKEN_LINK`    | a visited page answers ≥ `failOnStatus` (with the referring page) | 404/410/5xx → ERROR, other 4xx → WARNING |
| `REQUEST_FAILED` | network failure (DNS, refused, CORS)                              | WARNING (ERROR for documents)            |
| `CONSOLE`        | `console.error` (and `console.warn` if enabled)                   | ERROR (WARNING)                          |
| `PAGE_ERROR`     | uncaught JavaScript exception                                     | ERROR                                    |
| `PAGE_CRASH`     | renderer crash                                                    | CRITICAL                                 |
| `NAVIGATION`     | timeout, redirect loop, redirect to another host                  | ERROR (external redirect: WARNING)       |

- All severity rules are in one place: `src/anomaly/severity-rules.ts`.
- Identical anomalies are merged into one issue. The issue records its number of occurrences and the pages it was seen on.
- Chrome's own "Failed to load resource" console echo is not reported a second time.

**Loop protection:**

- a visited set of normalized URLs;
- `maxDepth` and `maxPages`;
- route patterns: `/users/1`, `/users/2` become `/users/:id`; UUIDs, hashes, dates and tokens are normalized the same way;
- a per-route budget;
- removal of tracking parameters;
- Chromium's redirect limit, which catches redirect loops.

## Reports

| File                                 | Content                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports/result.json`                | Machine-readable result: summary, statistics, issues, visited pages with their actions and forms, route patterns, effective settings (without secrets)        |
| `reports/index.html`                 | Static report (no JavaScript, no external assets): summary cards, HTTP errors, JS errors, navigation problems, pages, discovered actions, screenshots, routes |
| `screenshots/NNN-<path>[-error].png` | One per visited page (if `checks.screenshots`), always for pages with ERROR/CRITICAL issues                                                                   |

Each discovered action is stored in `result.json`, for example:

```json
{ "type": "button", "text": "Nouvelle inscription", "classification": "MUTATION", "reason": "matches mutation keyword \"inscription\"" }
{ "type": "link", "text": "Utilisateurs", "href": "https://app.example.com/users", "classification": "SAFE", "reason": "navigation link" }
```

Each form field is stored with its constraints (`type`, `required`, `min`, `max`,
`minlength`, `maxlength`, `pattern`, select options). This is the input for the
future form-validation tests.

## Architecture

```
                 Scenario YAML
                       |
                       v
         Config loader (zod schema, defaults, overrides)
                       |
                       v
                QA Orchestrator ─────────────────────────────┐
                       |                                      |
          +------------+-------------+                        |
          |                          |                        |
          v                          v                        |
     Crawl Engine  <────────  Safety Policy                   |
  (BFS queue, visited,        Navigation Policy               |
   route budget, depth)       Decision Engine (rule-based)    |
          |                                                   |
          v                                                   |
  Link / Action / Form discovery                              |
          |                                                   |
          v                                                   |
   Playwright → Chromium headless → Web application           |
          |                                                   |
     +----+-----------+-------------+                         |
     v                v             v                         |
  Network        Console       Page errors                    |
  observer       observer      observer                       |
     +----+-----------+-------------+                         |
          v                                                   |
   Issue collector (severity rules, dedupe, redaction)        |
          |                                                   v
          +──────────────────────────────────────────>  Reporters
                                                        /       \
                                                     JSON       HTML
```

```
src/
├── main.ts                     entry point (node dist/main.js)
├── orchestrator.ts             scenario → crawl → reports → verdict
├── cli/                        argument parsing, console output, exit codes
├── config/                     zod schema with defaults, YAML loader, overrides
├── crawler/
│   ├── crawler.ts              BFS crawl engine
│   ├── queue.ts                frontier, visited set, per-route budget
│   ├── url-normalizer.ts       URL resolution and canonical form
│   ├── route-normalizer.ts     /users/1 → /users/:id, ?page=N grouping
│   └── action-executor.ts      executes a decided action with a last safety check
├── discovery/                  links (incl. routerLink), actions, forms — read-only DOM inspection
├── browser/                    Chromium lifecycle, screenshots
├── observers/                  network, console, pageerror/crash → issues
├── policies/                   SafetyPolicy (action risk), NavigationPolicy (where to go)
├── decision/                   DecisionEngine interface + RuleBasedDecisionEngine
├── anomaly/                    severity rules, issue collector (dedupe)
├── security/                   redaction of secrets
├── auth/                       authenticators (none, form)
├── reporting/                  Reporter interface, JSON and HTML reporters
└── model/                      Issue, PageResult, DiscoveredAction, CrawlResult
```

### Decision engine (extension point for AI later)

In-page interactions go through a `DecisionEngine`:

```ts
interface DecisionEngine {
  nextAction(context: PageContext): Promise<Decision>; // { kind: 'click', action } | { kind: 'stop' }
}
```

The `PageContext` passed to the engine is plain, serializable data:

- the page URL and route;
- the classified actions and the forms;
- the actions already executed and the remaining budget.

This version ships `RuleBasedDecisionEngine`, which is fully deterministic. When `clickSafeActions` is enabled, it clicks allowed buttons and routerLink elements in document order, once each; this is how routes reachable only by clicking in a SPA get discovered.

A `LocalLLMDecisionEngine` or `CloudLLMDecisionEngine` can be added later behind the same interface. Whatever the engine, the crawl engine keeps enforcing `SafetyPolicy` on every decision, so an engine can only choose among allowed actions. This version contains no LLM code or dependency.

## Authentication

Credentials are never written in the scenario. The loader rejects keys such as `password:`. Credentials are read from environment variables:

```yaml
auth:
  type: form
  loginUrl: /login
  usernameSelector: 'input[name="username"]'
  passwordSelector: 'input[type="password"]'
  submitSelector: 'button[type="submit"]'
  usernameEnv: QA_USERNAME # default
  passwordEnv: QA_PASSWORD # default
  successSelector: 'nav .user-menu' # and/or successUrlContains: /dashboard
```

```bash
QA_USERNAME=qa-bot QA_PASSWORD=... npm run qa -- scenarios/app.yaml
```

- The login runs once, before the crawl.
- The session (cookies, storage) is then shared by every page.
- Add `/logout` to `ignoredPaths` (it is there by default) so the crawler does not end its own session.
- The `Authenticator` interface is where SSO/OIDC, token injection and multi-role runs will plug in.

## Kubernetes / OpenShift

The image is ready to run as a `Job` or `CronJob`. No manifests are included yet. Points to plan:

- **Resources:** one headless Chromium tab.
  - Requests: `cpu: 500m`, `memory: 1Gi`.
  - Limits: `cpu: 1–2`, `memory: 2Gi`.
  - Memory grows with heavy SPAs and full-page screenshots.
- **Headless only:** no GPU, no X server, no `privileged`, no added capability. Chromium runs without its own sandbox, which is Playwright's default. That is what allows an unprivileged, arbitrary UID.
- **Arbitrary UID (OpenShift):**
  - The image runs as `pwuser`.
  - `/app/reports` and `/app/screenshots` are group-0 writable.
  - `HOME=/tmp`, so a random UID works under the `restricted-v2` SCC.
- **Shared memory:** `--disable-dev-shm-usage` is on by default, so the small default `/dev/shm` is fine. Alternatively, mount an `emptyDir` with `medium: Memory` on `/dev/shm`.
- **Network:** the pod needs:
  - egress to the target application (and to its identity provider if you authenticate);
  - no other egress: nothing is downloaded at runtime.
- **Outputs:** write reports to a mounted volume (PVC or `emptyDir` copied out by a sidecar or next step). Override the paths with `--reports-dir` / `--screenshots-dir` if needed.
- **Configuration:** mount scenarios from a `ConfigMap`. Pass the URL through `QA_BASE_URL`, and credentials through a `Secret` exposed as `QA_USERNAME` / `QA_PASSWORD`.
- **Exit code:** 0 or 1 tells the pipeline whether the environment passed.

| Variable                     | Purpose                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `QA_BASE_URL`                | Target URL (overrides the scenario)                                     |
| `QA_USERNAME`, `QA_PASSWORD` | Default credential variables for `auth.type: form` (names configurable) |
| `PLAYWRIGHT_BROWSERS_PATH`   | Chromium location (set by the Playwright image)                         |
| `NO_COLOR`                   | Disable colored output (set in the image)                               |

## CI/CD

`.github/workflows/qa-crawler.yml` runs on every push and pull request, in this order:

1. checkout
2. `npm ci`
3. typecheck
4. lint
5. format check
6. unit tests
7. build
8. Chromium install and integration tests against the bundled local test site

A second job crawls a real environment, and uploads `reports/` and `screenshots/` as an artifact. It runs only when a target exists:

- the repository variable `TARGET_URL`, or
- a manual run with the `target_url` input.

## Development

```bash
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # ESLint, typescript-eslint strict type-checked
npm run format:check     # Prettier
npm test                 # unit tests (Vitest), no browser needed
npm run test:integration # real Chromium against tests/fixtures/test-site.ts
npm run build            # dist/
```

The test site (`tests/fixtures/test-site.ts`) is a small HTTP server full of traps:

- a 404 page, a 500 page and an API call that fails;
- a JavaScript exception and a `console.error` containing a token;
- a redirect loop and a JavaScript redirect;
- infinite pagination and `/users/:id` pages;
- logout and delete links;
- _Supprimer_ and _Enregistrer_ buttons that call "dangerous" endpoints;
- forms with constraints, a routerLink element and a SPA-style `pushState` button.

The integration test checks that every trap is detected, and that no dangerous endpoint is ever reached.

## Limitations of this version

- One browser tab: pages are crawled sequentially.
- Only one form of authentication, a single role and a single login.
- In-page clicks are limited to SAFE buttons/routerLinks, and only when `clickSafeActions` is on. Links are followed through the queue.
- Only the `href` values present in the DOM are checked, so links beyond `maxPages`/`maxDepth` are not validated.
- Route normalization is heuristic: numeric ids, UUIDs, hashes, dates and long tokens. Custom route patterns are not configurable yet.
- Keyword-based classification cannot know what an unlabeled icon button does. Such buttons are `UNKNOWN`, and therefore not clicked.
- Shadow DOM and iframes are not explored.

## Roadmap

- Multi-role authentication (one crawl per role, SSO/OIDC, stored session state)
- Automatic form testing: required fields, invalid email, min/max and boundary values, auto-fill
- Permission tests (what a role must _not_ reach)
- OpenAPI import and API testing
- Visual comparison between runs
- Generation of Playwright tests from the discovered routes and actions
- Decision engines: an optional local LLM, behind the `DecisionEngine` interface
- Runs against per-pull-request environments
- Automatic pull request comment with the report summary
- Configurable route patterns, parallel pages, Kubernetes `Job` manifests
