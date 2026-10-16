import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import {
  ConfigError,
  parseConfig,
  type ConfigOverrides,
  type LoadedConfig,
} from '../config/config-loader.js';

/**
 * PROJECT CONFIGURATION (`qa-crawler.config.yaml`) : la configuration d'un projet CONSOMMATEUR du
 * package, écrite par `qa-crawler init`. Elle est traduite en une MISSION (ScenarioConfig) par
 * `projectMission`, puis validée par le chargeur de missions existant : aucune option de mission
 * n'est perdue — `qaCrawler.mission` accepte toute clé d'une mission et l'emporte sur la traduction.
 *
 * Priorité : options de la ligne de commande > variables d'environnement (QA_BASE_URL,
 * QA_INTELLIGENCE_MODE, …, appliquées par le chargeur) > qa-crawler.config.yaml > valeurs par défaut.
 *
 * Disposition d'un projet :
 *   qa-crawler.config.yaml
 *   qa-crawler/flows/        flows YAML et .feature (un fichier = un flow, ou `flows:` une liste)
 *   qa-crawler/actors/       sessions réutilisables des acteurs (storageState, jamais commis)
 *   qa-crawler/test-data/    jeux de données
 *   qa-crawler/baselines/    baselines (graphe, visuel, performance)
 *   qa-crawler/recordings/   enregistrements
 *   qa-crawler/knowledge/    base de connaissances
 *   qa-crawler/memory/       persistance fichier
 *   qa-reports/              rapports et artefacts
 */
export const PROJECT_CONFIG_FILES = ['qa-crawler.config.yaml', 'qa-crawler.config.yml'] as const;
export const PROJECT_DIR = 'qa-crawler';
export const REPORTS_DIR = 'qa-reports';

const nonEmpty = z.string().trim().min(1);

const actorAuthSchema = z
  .object({
    /** none, form, http, sso ; `oidc` est un alias de `sso`. */
    type: z.enum(['none', 'form', 'http', 'sso', 'oidc']).default('none'),
    /** Session réutilisable (storageState) : par défaut qa-crawler/actors/<nom>.json quand `reuseSession`. */
    storageState: nonEmpty.optional(),
    reuseSession: z.boolean().default(true),
  })
  .passthrough();

export const projectConfigSchema = z
  .object({
    application: z
      .object({
        baseUrl: nonEmpty.default('http://localhost:4200'),
        startAt: nonEmpty.default('/'),
        name: nonEmpty.optional(),
        /** angular, react, vue, other : informatif (détecté par init). */
        framework: nonEmpty.optional(),
      })
      .passthrough()
      .default({}),
    browser: z
      .object({
        browser: z.enum(['chromium']).default('chromium'),
        headless: z.boolean().default(true),
      })
      .passthrough()
      .default({}),
    playwright: z
      .object({
        /** playwright.config.ts|js du projet : baseURL, headless, viewport, storageState sont repris. */
        config: nonEmpty.optional(),
      })
      .passthrough()
      .default({}),
    recording: z
      .object({ enabled: z.boolean().default(true) })
      .passthrough()
      .default({}),
    replay: z
      .object({ enabled: z.boolean().default(true) })
      .passthrough()
      .default({}),
    exploration: z
      .object({ enabled: z.boolean().default(true) })
      .passthrough()
      .default({}),
    analysis: z
      .object({ enabled: z.boolean().default(true) })
      .passthrough()
      .default({}),
    api: z
      .object({
        openapi: nonEmpty.optional(),
        testing: z.boolean().default(true),
      })
      .passthrough()
      .default({}),
    visual: z
      .object({ enabled: z.boolean().default(false) })
      .passthrough()
      .default({}),
    staticAnalysis: z
      .object({ enabled: z.boolean().default(false), source: nonEmpty.optional() })
      .passthrough()
      .default({}),
    actors: z
      .array(
        z
          .object({
            name: nonEmpty,
            description: z.string().optional(),
            primary: z.boolean().default(false),
            auth: actorAuthSchema.default({}),
            profile: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .default([]),
    intelligence: z
      .object({
        enabled: z.boolean().default(false),
        mode: z.enum(['OFF', 'ASSIST', 'HYBRID']).default('OFF'),
        provider: z.enum(['copilot', 'anthropic', 'deterministic']).default('copilot'),
      })
      .passthrough()
      .default({}),
    persistence: z
      .object({
        enabled: z.boolean().default(true),
        provider: z.enum(['memory', 'file', 'database']).default('file'),
      })
      .passthrough()
      .default({}),
    reporting: z
      .object({
        format: z.array(z.enum(['html', 'json'])).default(['html', 'json']),
        language: z.enum(['en', 'fr']).default('en'),
        failOnSeverity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL', 'NONE']).default('ERROR'),
        dir: nonEmpty.default(REPORTS_DIR),
      })
      .passthrough()
      .default({}),
    paths: z
      .object({
        flows: nonEmpty.default(`${PROJECT_DIR}/flows`),
        actors: nonEmpty.default(`${PROJECT_DIR}/actors`),
        testData: nonEmpty.default(`${PROJECT_DIR}/test-data`),
        baselines: nonEmpty.default(`${PROJECT_DIR}/baselines`),
        recordings: nonEmpty.default(`${PROJECT_DIR}/recordings`),
        knowledge: nonEmpty.default(`${PROJECT_DIR}/knowledge`),
        memory: nonEmpty.default(`${PROJECT_DIR}/memory`),
      })
      .strict()
      .default({}),
    /** Toute clé d'une mission (safety, goals, oracles, gherkin, …) : fusionnée en dernier, elle l'emporte. */
    mission: z.record(z.unknown()).default({}),
  })
  .passthrough();

export type ProjectConfig = z.output<typeof projectConfigSchema>;

export interface ProjectConfigFile {
  file: string;
  /** Dossier du projet (celui du fichier). */
  root: string;
  config: ProjectConfig;
}

/** Cherche qa-crawler.config.yaml dans `cwd`, puis dans ses parents. */
export async function findProjectConfigFile(cwd: string): Promise<string | undefined> {
  let directory = path.resolve(cwd);
  for (;;) {
    for (const name of PROJECT_CONFIG_FILES) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function loadProjectConfig(file: string): Promise<ProjectConfigFile> {
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const section = raw !== null && typeof raw === 'object' && 'qaCrawler' in raw ? raw.qaCrawler : raw;
  const parsed = projectConfigSchema.safeParse(section ?? {});
  if (!parsed.success)
    throw new ConfigError(
      `Invalid ${file}`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  return { file, root: path.dirname(path.resolve(file)), config: parsed.data };
}

export interface MissionOptions {
  /** replay : flows seulement ; explore : exploration autonome ; analyze/test-api : flows + analyses. */
  command: 'record' | 'replay' | 'explore' | 'analyze' | 'test-api' | 'reproduce' | 'generate-tests';
  /** Les flows à garder (noms) ; absent : tous. */
  flows?: string[];
  /** Un flow ajouté (reproduction). */
  extraFlows?: Record<string, unknown>[];
  missionName?: string;
  /** Fragments de mission fusionnés avant `mission` (ex. viewport repris du playwright.config). */
  missionOverlay?: Record<string, unknown>;
}

type Raw = Record<string, unknown>;

/** Les flows du dossier `paths.flows` : fichiers YAML (un flow ou `flows:`), fichiers .feature (Gherkin). */
export async function discoverFlows(flowsDir: string): Promise<{ flows: Raw[]; files: string[] }> {
  const flows: Raw[] = [];
  const files: string[] = [];
  if (!(await exists(flowsDir))) return { flows, files };
  const entries = (await readdir(flowsDir, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  for (const file of entries) {
    if (file.endsWith('.feature')) {
      flows.push({ gherkin: file });
      files.push(file);
      continue;
    }
    if (!/\.ya?ml$/.test(file)) continue;
    const parsed = parseYaml(await readFile(file, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') continue;
    const document = parsed as Raw;
    const list = Array.isArray(document.flows)
      ? (document.flows as Raw[])
      : 'steps' in document
        ? [document]
        : [];
    for (const flow of list) flows.push(relativeFlowPaths(flow, path.dirname(file)));
    if (list.length > 0) files.push(file);
  }
  return { flows, files };
}

/** Les chemins d'un flow (testData, gherkin) rendus absolus depuis son fichier. */
function relativeFlowPaths(flow: Raw, directory: string): Raw {
  const resolved: Raw = { ...flow };
  for (const key of ['testData', 'gherkin'] as const) {
    const value = resolved[key];
    if (typeof value === 'string' && !path.isAbsolute(value) && /\.(ya?ml|feature)$/.test(value))
      resolved[key] = path.resolve(directory, value);
  }
  return resolved;
}

function deepMerge(base: Raw, extra: Raw): Raw {
  const out: Raw = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
        ? deepMerge(current as Raw, value as Raw)
        : value;
  }
  return out;
}

function actorAuthOf(actor: ProjectConfig['actors'][number], root: string, actorsDir: string): Raw {
  const { type, storageState, reuseSession, ...rest } = actor.auth;
  if (type === 'none') return { type: 'none' };
  const session = reuseSession
    ? {
        session: {
          reuse: true,
          file: path.resolve(root, storageState ?? path.join(actorsDir, `${actor.name}.json`)),
        },
      }
    : {};
  return { type: type === 'oidc' ? 'sso' : type, ...rest, ...session };
}

/** La mission (document YAML brut) dérivée de la configuration du projet, pour une commande. */
export async function projectMission(
  project: ProjectConfigFile,
  options: MissionOptions,
): Promise<{ mission: Raw; flowFiles: string[] }> {
  const { config, root } = project;
  const at = (relative: string): string => path.resolve(root, relative);
  const { flows: discovered, files } = await discoverFlows(at(config.paths.flows));
  const selected = options.flows
    ? discovered.filter((flow) => typeof flow.name === 'string' && options.flows?.includes(flow.name))
    : discovered;
  if (options.flows)
    for (const name of options.flows)
      if (!selected.some((flow) => flow.name === name))
        throw new ConfigError(`Unknown flow "${name}" (looked in ${at(config.paths.flows)})`);
  const flows = [...selected, ...(options.extraFlows ?? [])];
  const primary = config.actors.find((actor) => actor.primary) ?? config.actors[0];
  const others = config.actors.filter((actor) => actor !== primary);
  const autonomous = options.command === 'explore' && config.exploration.enabled;
  const { browser: _engine, ...browserRest } = config.browser;
  const mission: Raw = {
    mission: {
      name: options.missionName ?? config.application.name ?? `qa-crawler-${options.command}`,
      mode: 'explore',
    },
    target: { baseUrl: config.application.baseUrl, startAt: config.application.startAt },
    browser: browserRest,
    exploration: { autonomous },
    ...(primary ? { auth: actorAuthOf(primary, root, config.paths.actors) } : {}),
    ...(others.length > 0
      ? {
          actors: others.map((actor) => ({
            name: actor.name,
            ...(actor.description ? { description: actor.description } : {}),
            auth: actorAuthOf(actor, root, config.paths.actors),
            ...(actor.profile ? { profile: actor.profile } : {}),
          })),
          authorization: { primaryActor: primary?.name ?? 'primary' },
        }
      : {}),
    output: {
      reportsDir: at(config.reporting.dir),
      screenshotsDir: path.join(at(config.reporting.dir), 'screenshots'),
      html: config.reporting.format.includes('html'),
      json: config.reporting.format.includes('json'),
    },
    report: { language: config.reporting.language, failOnSeverity: config.reporting.failOnSeverity },
    knowledge: { file: path.join(at(config.paths.knowledge), 'knowledge-base.json') },
    baseline: { dir: at(config.paths.baselines) },
    persistence: {
      enabled: config.persistence.enabled,
      provider: config.persistence.provider,
      file: { directory: at(config.paths.memory) },
      ...Object.fromEntries(
        Object.entries(config.persistence).filter(([key]) => !['enabled', 'provider'].includes(key)),
      ),
    },
    ...(config.api.openapi
      ? {
          openapi: { enabled: true, source: at(config.api.openapi) },
          apiTesting: { enabled: config.api.testing && options.command !== 'record' },
        }
      : {}),
    visual: { ...config.visual, enabled: config.visual.enabled && options.command !== 'record' },
    ...(config.staticAnalysis.enabled
      ? {
          staticAnalysis: {
            ...config.staticAnalysis,
            ...(config.staticAnalysis.source ? { source: { root: at(config.staticAnalysis.source) } } : {}),
          },
        }
      : {}),
    ai: {
      enabled: config.intelligence.enabled,
      mode: config.intelligence.enabled ? config.intelligence.mode : 'OFF',
      provider: config.intelligence.provider,
      ...Object.fromEntries(
        Object.entries(config.intelligence).filter(([key]) => !['enabled', 'mode', 'provider'].includes(key)),
      ),
    },
    recording: Object.fromEntries(Object.entries(config.recording).filter(([key]) => key !== 'enabled')),
    platform: {
      generatedTests: { enabled: options.command === 'generate-tests' },
      reproductions: { enabled: config.analysis.enabled },
    },
    flows,
  };
  return {
    mission: deepMerge(deepMerge(mission, options.missionOverlay ?? {}), config.mission),
    flowFiles: files,
  };
}

/** La mission dérivée, validée par le chargeur de missions (chemins relatifs résolus depuis le projet). */
export async function loadProjectMission(
  project: ProjectConfigFile,
  options: MissionOptions,
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig & { flowFiles: string[]; missionYaml: string }> {
  const { mission, flowFiles } = await projectMission(project, options);
  const missionYaml = stringify(mission, { lineWidth: 0 });
  const loaded = parseConfig(missionYaml, overrides, env, project.file);
  return { ...loaded, source: project.file, flowFiles, missionYaml };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}
