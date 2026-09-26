import { z } from 'zod';
import { ACTION_CLASSIFICATIONS, RISK_KINDS } from '../model/discovered-action.js';
import { SEVERITIES } from '../model/issue.js';
import { REPORT_LANGUAGES } from '../reporting/i18n.js';
import { flowsSchema } from './flow-schema.js';

/**
 * Mission configuration. The YAML describes *what to explore and within which
 * limits*: the explorer discovers the screens and transitions by itself.
 * Optional `flows` impose ordered test steps on top of that (still checked by
 * the SafetyPolicy). Every section except `target.baseUrl` has defaults, so a
 * minimal mission is just a URL.
 */

const nonEmpty = z.string().trim().min(1);

const browserSchema = z
  .object({
    headless: z.boolean().default(true),
    viewport: z
      .object({
        width: z.number().int().positive().default(1366),
        height: z.number().int().positive().default(768),
      })
      .strict()
      .default({}),
    locale: nonEmpty.optional(),
    userAgent: nonEmpty.optional(),
    ignoreHttpsErrors: z.boolean().default(false),
    /** Extra Chromium flags. `--disable-dev-shm-usage` avoids crashes with the small /dev/shm of containers. */
    args: z.array(nonEmpty).default(['--disable-dev-shm-usage']),
    slowMoMs: z.number().int().min(0).default(0),
  })
  .strict();

const queryParamsSchema = z
  .object({
    /**
     * - pattern: keep query params, but group URLs by param *names* for the per-route budget
     *   (?page=1, ?page=2 … count as the same route).
     * - ignore: drop every query param (each path is visited once).
     * - keep: treat every distinct query string as a new page (bounded only by maxStates).
     */
    mode: z.enum(['pattern', 'ignore', 'keep']).default('pattern'),
    /** Params always removed before comparing URLs (tracking, cache busters). `*` wildcard allowed. */
    ignored: z.array(nonEmpty).default(['utm_*', 'fbclid', 'gclid', '_', 'ts', 'timestamp', 'cachebuster']),
  })
  .strict();

const explorationSchema = z
  .object({
    /** Distinct functional states (screens, steps, tabs) to discover at most. */
    maxStates: z.number().int().positive().default(100),
    /** Actions executed at most (clicks, navigations, fills). */
    maxActions: z.number().int().positive().default(500),
    /** Transitions away from the start state at most. */
    maxDepth: z.number().int().min(0).default(10),
    maxDurationMinutes: z.number().positive().default(15),
    /** Timeout of a single action (locating + executing the element). */
    actionTimeoutMs: z.number().int().positive().default(10_000),
    navigationTimeoutMs: z.number().int().positive().default(15_000),
    /** Playwright load state awaited after each navigation. */
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('load'),
    /** Extra wait after each action so SPAs (Angular…) can render and fire their API calls. */
    settleTimeMs: z.number().int().min(0).default(400),
    /** Distinct states explored per route pattern (/users/:id → only N users). */
    maxStatesPerRoute: z.number().int().positive().default(3),
    queryParams: queryParamsSchema.default({}),
    /** Cap on actions recorded per state. */
    maxRecordedActions: z.number().int().positive().default(200),
    /**
     * Explore the application autonomously from target.startAt. Set to false
     * to run only the imposed `flows`.
     */
    autonomous: z.boolean().default(true),
  })
  .strict();

const goalsSchema = z
  .object({
    /** Follow links and routerLinks. */
    discoverNavigation: z.boolean().default(true),
    /** Fill fields with test data (never sensitive ones) to explore forms and wizard steps. */
    discoverForms: z.boolean().default(true),
    /** Click in-page controls (tabs, menus, details, toggles, wizard steps). */
    discoverFlows: z.boolean().default(true),
    /** Report HTTP, JavaScript and navigation anomalies. */
    detectErrors: z.boolean().default(true),
  })
  .strict();

/** Categories of SAFE actions a mission can allow. */
export const SAFE_ACTION_GROUPS = [
  'navigation',
  'tabs',
  'menus',
  'details',
  'pagination',
  'search',
  'filter',
  'forms',
  'other',
] as const;
export type SafeActionGroup = (typeof SAFE_ACTION_GROUPS)[number];

const checksSchema = z
  .object({
    consoleErrors: z.boolean().default(true),
    consoleWarnings: z.boolean().default(false),
    pageErrors: z.boolean().default(true),
    httpErrors: z.boolean().default(true),
    requestFailures: z.boolean().default(true),
    brokenLinks: z.boolean().default(true),
    /** Screenshot every visited page. */
    screenshots: z.boolean().default(true),
    /** Screenshot pages with ERROR/CRITICAL issues even when `screenshots` is false. */
    screenshotOnError: z.boolean().default(true),
    fullPageScreenshots: z.boolean().default(false),
  })
  .strict();

const httpSchema = z
  .object({
    /** Responses with a status >= this value are reported. */
    failOnStatus: z.number().int().min(100).max(599).default(400),
    /** Statuses never reported (e.g. 401 on an optional session check). */
    ignoreStatus: z.array(z.number().int().min(100).max(599)).default([]),
    /** Request URLs containing one of these substrings are never reported. */
    ignoreUrlPatterns: z.array(nonEmpty).default([]),
  })
  .strict();

const safetySchema = z
  .object({
    /** Hostnames the crawler may visit. Defaults to the host of target.baseUrl. `*.example.com` allowed. */
    allowedHosts: z.array(nonEmpty).default([]),
    /** Paths never visited. Prefix match; `*` wildcard allowed (e.g. /admin/*\/delete). */
    ignoredPaths: z.array(nonEmpty).default(['/logout', '/signout', '/sign-out', '/deconnexion']),
    /** Action classes the crawler may execute automatically. */
    allowedActionClasses: z.array(z.enum(ACTION_CLASSIFICATIONS)).default(['SAFE']),
    /** Kinds of SAFE actions the mission may execute. Default: all of them. */
    allow: z.array(z.enum(SAFE_ACTION_GROUPS)).default([...SAFE_ACTION_GROUPS]),
    /**
     * Risks that always block an action, whatever its class. `sensitive-data`
     * (passwords, card numbers, secrets) is blocked even if omitted here.
     */
    block: z
      .array(z.enum(RISK_KINDS))
      .default([
        'delete',
        'payment',
        'send',
        'logout',
        'irreversible',
        'sensitive-data',
        'external-navigation',
        'form-submit',
        'download',
      ]),
    /** Extra keywords (any language) added to the built-in classification rules. */
    keywords: z
      .object({
        safe: z.array(nonEmpty).default([]),
        mutation: z.array(nonEmpty).default([]),
        dangerous: z.array(nonEmpty).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

const formAuthSchema = z
  .object({
    type: z.literal('form'),
    /** Login page, absolute or relative to target.baseUrl. */
    loginUrl: nonEmpty,
    usernameSelector: nonEmpty,
    passwordSelector: nonEmpty,
    submitSelector: nonEmpty,
    /** Names of the environment variables holding the credentials — never the credentials themselves. */
    usernameEnv: nonEmpty.default('QA_USERNAME'),
    passwordEnv: nonEmpty.default('QA_PASSWORD'),
    /** Login succeeded when this selector appears… */
    successSelector: nonEmpty.optional(),
    /** …or when the URL contains this string. */
    successUrlContains: nonEmpty.optional(),
    timeoutMs: z.number().int().positive().default(15_000),
  })
  .strict();

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  formAuthSchema,
]);

const outputSchema = z
  .object({
    reportsDir: nonEmpty.default('reports'),
    screenshotsDir: nonEmpty.default('screenshots'),
    json: z.boolean().default(true),
    html: z.boolean().default(true),
    /** reports/flow-graph.html */
    flowGraphHtml: z.boolean().default(true),
  })
  .strict();

const memorySchema = z
  .object({
    /** Where the flow graph is persisted. Default: <reportsDir>/flow-graph.json. */
    file: nonEmpty.optional(),
    /** Start from the graph of a previous run: actions already tried are not tried again. */
    resume: z.boolean().default(false),
  })
  .strict();

const reportSchema = z
  .object({
    /** The CLI exits with code 1 when an issue at or above this severity is found. NONE disables it. */
    failOnSeverity: z.enum([...SEVERITIES, 'NONE']).default('ERROR'),
    /** Language of the HTML reports (index.html, flow-graph.html). result.json stays in English. */
    language: z.enum(REPORT_LANGUAGES).default('en'),
  })
  .strict();

export const scenarioSchema = z
  .object({
    mission: z
      .object({
        name: nonEmpty.default('explore-application'),
        description: z.string().optional(),
      })
      .strict()
      .default({}),
    target: z
      .object({
        baseUrl: z
          .string()
          .url()
          .refine((value) => /^https?:\/\//i.test(value), 'baseUrl must use http or https'),
        startAt: z.string().default('/'),
      })
      .strict(),
    browser: browserSchema.default({}),
    exploration: explorationSchema.default({}),
    goals: goalsSchema.default({}),
    checks: checksSchema.default({}),
    http: httpSchema.default({}),
    safety: safetySchema.default({}),
    auth: authSchema.default({ type: 'none' }),
    output: outputSchema.default({}),
    memory: memorySchema.default({}),
    report: reportSchema.default({}),
    /** Imposed test flows, run before the autonomous exploration. */
    flows: flowsSchema,
  })
  .strict();

/** Scenario as written in YAML (defaults not applied yet). */
export type ScenarioInput = z.input<typeof scenarioSchema>;
/** Fully resolved scenario with defaults applied. */
export type ScenarioConfig = z.output<typeof scenarioSchema>;
export type FormAuthConfig = z.output<typeof formAuthSchema>;
export type AuthConfig = ScenarioConfig['auth'];
export type QueryParamMode = ScenarioConfig['exploration']['queryParams']['mode'];
