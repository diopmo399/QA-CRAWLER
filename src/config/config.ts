import { z } from 'zod';
import { ACTION_CLASSIFICATIONS } from '../model/discovered-action.js';
import { SEVERITIES } from '../model/issue.js';

/**
 * Scenario configuration. Every behaviour of the crawler is driven from here;
 * all sections except `target.baseUrl` have defaults so a minimal scenario is
 * just a name and a URL.
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
     * - keep: treat every distinct query string as a new page (bounded only by maxPages).
     */
    mode: z.enum(['pattern', 'ignore', 'keep']).default('pattern'),
    /** Params always removed before comparing URLs (tracking, cache busters). `*` wildcard allowed. */
    ignored: z.array(nonEmpty).default(['utm_*', 'fbclid', 'gclid', '_', 'ts', 'timestamp', 'cachebuster']),
  })
  .strict();

const explorationSchema = z
  .object({
    maxPages: z.number().int().positive().default(50),
    maxDepth: z.number().int().min(0).default(5),
    navigationTimeoutMs: z.number().int().positive().default(15_000),
    /** Playwright load state awaited after each navigation. */
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('load'),
    /** Extra wait after load so SPAs (Angular…) can render and fire their API calls. */
    settleTimeMs: z.number().int().min(0).default(500),
    /** Max concrete URLs visited per normalized route (/users/:id → only N users). */
    maxUrlsPerRoute: z.number().int().positive().default(2),
    queryParams: queryParamsSchema.default({}),
    /** Follow Angular [routerLink] attributes found on non-anchor elements. */
    followRouterLinks: z.boolean().default(true),
    /** Let the decision engine click SAFE buttons to discover SPA routes. Off by default. */
    clickSafeActions: z.boolean().default(false),
    maxActionsPerPage: z.number().int().min(0).default(5),
    /** Cap on actions recorded per page in the report. */
    maxRecordedActions: z.number().int().positive().default(200),
  })
  .strict();

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
  })
  .strict();

const reportSchema = z
  .object({
    /** The CLI exits with code 1 when an issue at or above this severity is found. NONE disables it. */
    failOnSeverity: z.enum([...SEVERITIES, 'NONE']).default('ERROR'),
  })
  .strict();

export const scenarioSchema = z
  .object({
    name: nonEmpty.default('qa-crawl'),
    description: z.string().optional(),
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
    checks: checksSchema.default({}),
    http: httpSchema.default({}),
    safety: safetySchema.default({}),
    auth: authSchema.default({ type: 'none' }),
    output: outputSchema.default({}),
    report: reportSchema.default({}),
  })
  .strict();

/** Scenario as written in YAML (defaults not applied yet). */
export type ScenarioInput = z.input<typeof scenarioSchema>;
/** Fully resolved scenario with defaults applied. */
export type ScenarioConfig = z.output<typeof scenarioSchema>;
export type FormAuthConfig = z.output<typeof formAuthSchema>;
export type AuthConfig = ScenarioConfig['auth'];
export type QueryParamMode = ScenarioConfig['exploration']['queryParams']['mode'];
