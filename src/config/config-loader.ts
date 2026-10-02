import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ZodError } from 'zod';
import { FlowIncludeError, resolveFlowRuns } from '../flows/flow-includes.js';
import { GherkinError, gherkinFlows, isGherkinEntry } from '../flows/gherkin/gherkin-loader.js';
import type { CustomGherkinStep } from '../flows/gherkin/gherkin-steps.js';
import { scenarioSchema, type ScenarioConfig } from './config.js';

/** Levée pour tout scénario illisible, mal formé ou invalide. Le message peut être montré à l'utilisateur. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(details.length > 0 ? `${message}\n  - ${details.join('\n  - ')}` : message);
    this.name = 'ConfigError';
  }
}

/** Valeurs prioritaires sur le fichier YAML (options de la CLI, environnement). */
export interface ConfigOverrides {
  baseUrl?: string;
  maxStates?: number;
  maxActions?: number;
  headless?: boolean;
  reportsDir?: string;
  screenshotsDir?: string;
  /** --persistence <off|memory|file|postgres|sqlserver|sqlite|mysql>, --no-persistence (off). */
  persistence?: PersistenceChoice;
  /** --memory / --no-memory. */
  memory?: boolean;
  /** --intelligence <off|assist|hybrid> (QA_INTELLIGENCE_MODE). */
  intelligence?: IntelligenceChoice;
  /** --ai-provider <copilot|deterministic> (QA_INTELLIGENCE_PROVIDER). */
  aiProvider?: string;
  /** --ai-model <model> (QA_COPILOT_MODEL). */
  aiModel?: string;
}

export const INTELLIGENCE_CHOICES = ['off', 'assist', 'hybrid'] as const;
export type IntelligenceChoice = (typeof INTELLIGENCE_CHOICES)[number];

/** L'intelligence optionnelle (ai.*) : seulement des réglages, jamais un jeton (ai.copilot.tokenEnv nomme la variable). */
export const INTELLIGENCE_ENV = {
  enabled: 'QA_INTELLIGENCE_ENABLED',
  mode: 'QA_INTELLIGENCE_MODE',
  provider: 'QA_INTELLIGENCE_PROVIDER',
  model: 'QA_COPILOT_MODEL',
  reasoningEffort: 'QA_COPILOT_REASONING_EFFORT',
} as const;

export const PERSISTENCE_CHOICES = [
  'off',
  'memory',
  'file',
  'postgres',
  'sqlserver',
  'sqlite',
  'mysql',
] as const;
export type PersistenceChoice = (typeof PERSISTENCE_CHOICES)[number];

/** Variables d'environnement de la persistance (entre la CLI et le YAML). */
export const PERSISTENCE_ENV = {
  enabled: 'QA_PERSISTENCE_ENABLED',
  provider: 'QA_PERSISTENCE_PROVIDER',
  databaseType: 'QA_DB_TYPE',
  memory: 'QA_MEMORY_ENABLED',
} as const;

export interface LoadedConfig {
  config: ScenarioConfig;
  /** Remarques non bloquantes à montrer à l'utilisateur. */
  warnings: string[];
  source: string;
}

/** Variable d'environnement qui remplace target.baseUrl (pratique en CI : pointer le même scénario vers l'environnement d'une PR). */
export const BASE_URL_ENV = 'QA_BASE_URL';

export async function loadConfigFile(
  filePath: string,
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === 'ENOENT' ? `Scenario file not found: ${filePath}` : `Cannot read scenario file: ${filePath}`,
    );
  }
  return { ...parseConfig(text, overrides, env, filePath), source: filePath };
}

export function parseConfig(
  yamlText: string,
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  source = '<inline>',
): Omit<LoadedConfig, 'source'> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigError(`Invalid YAML in ${source}`, [detail]);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`Scenario ${source} must be a YAML mapping (key: value)`);
  }

  refuseInlineCredentials(raw as Record<string, unknown>);
  const migrationWarnings: string[] = [];
  const migrated = migrateLegacyKeys(raw as Record<string, unknown>, migrationWarnings);
  const baseDir = source === '<inline>' ? process.cwd() : path.dirname(path.resolve(source));
  const expanded = resolveTestDataFiles(resolveStaticRoot(expandFlows(migrated, baseDir), baseDir), baseDir);
  const withOverrides = applyOverrides(expanded, overrides, env);

  let config: ScenarioConfig;
  try {
    config = scenarioSchema.parse(withOverrides);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(`Invalid scenario ${source}`, formatZodIssues(error));
    }
    throw error;
  }

  const finalized = finalize(config);
  return { config: finalized.config, warnings: [...migrationWarnings, ...finalized.warnings] };
}

/** Les fichiers de données (flow.testData, testData.include) : relatifs au fichier de mission. */
function resolveTestDataFiles(raw: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const absolute = (file: unknown): unknown =>
    typeof file === 'string' && !path.isAbsolute(file) ? path.resolve(baseDir, file) : file;
  const flows = Array.isArray(raw.flows)
    ? (raw.flows as unknown[]).map((flow) =>
        flow !== null && typeof flow === 'object' && 'testData' in flow
          ? { ...flow, testData: absolute(flow.testData) }
          : flow,
      )
    : raw.flows;
  const testData = raw.testData as { include?: unknown } | undefined;
  const include =
    testData && Array.isArray(testData.include) ? (testData.include as unknown[]).map(absolute) : undefined;
  return {
    ...raw,
    ...(flows !== undefined ? { flows } : {}),
    ...(testData && include ? { testData: { ...testData, include } } : {}),
  };
}

/** staticAnalysis.source.root, comme les .feature : relatif au fichier de mission. */
function resolveStaticRoot(raw: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const analysis = raw.staticAnalysis as { source?: { root?: unknown } } | undefined;
  const root = analysis?.source?.root;
  if (!analysis || typeof root !== 'string' || path.isAbsolute(root)) return raw;
  return {
    ...raw,
    staticAnalysis: { ...analysis, source: { ...analysis.source, root: path.resolve(baseDir, root) } },
  };
}

/**
 * Avant la validation : `flows: - gherkin: ./x.feature` devient un flow par scénario (le
 * même schéma qu'un flow écrit dans le YAML ; chemins relatifs au fichier de mission),
 * puis chaque étape `run: <flow>` est remplacée par les étapes de ce flow.
 */
function expandFlows(raw: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  if (!Array.isArray(raw.flows)) return raw;
  try {
    return {
      ...raw,
      flows: resolveFlowRuns(expandGherkinFlows(raw.flows as unknown[], raw.gherkin, baseDir)),
    };
  } catch (error) {
    if (error instanceof FlowIncludeError) throw new ConfigError('Invalid scenario', [error.message]);
    throw error;
  }
}

function expandGherkinFlows(entries: unknown[], gherkinConfig: unknown, baseDir: string): unknown[] {
  if (!entries.some(isGherkinEntry)) return entries;
  const gherkin = gherkinConfig as { steps?: unknown } | undefined;
  // Les phrases mal formées sont signalées ensuite par le schéma (gherkin.steps) ; ici, seulement les bonnes.
  const custom = (
    Array.isArray(gherkin?.steps)
      ? (gherkin.steps as { pattern?: unknown; step?: unknown; steps?: unknown; manual?: unknown }[])
      : []
  ).filter(
    (step): step is CustomGherkinStep =>
      typeof step.pattern === 'string' &&
      ((step.step !== null && typeof step.step === 'object') ||
        Array.isArray(step.steps) ||
        step.manual === true),
  );
  const flows: unknown[] = [];
  for (const entry of entries) {
    if (!isGherkinEntry(entry)) {
      flows.push(entry);
      continue;
    }
    if (typeof entry.gherkin !== 'string' || entry.gherkin.trim() === '')
      throw new ConfigError('Invalid scenario', ['flows[].gherkin: the path of a .feature file is required']);
    const extra = Object.keys(entry).filter(
      (key) => !['gherkin', 'scenarios', 'tags', 'thenExplore', 'startAt', 'auto'].includes(key),
    );
    if (extra.length > 0)
      throw new ConfigError('Invalid scenario', [
        `flows[] (gherkin ${entry.gherkin}): unknown key(s) ${extra.join(', ')} — allowed: scenarios, tags, thenExplore, startAt, auto`,
      ]);
    try {
      flows.push(
        ...gherkinFlows(
          entry,
          baseDir,
          custom,
          (gherkin as { auto?: unknown } | undefined)?.auto === true,
          (gherkin as { semanticResolution?: { enabled?: unknown } } | undefined)?.semanticResolution
            ?.enabled === true,
        ),
      );
    } catch (error) {
      if (error instanceof GherkinError) throw new ConfigError(error.message, error.details);
      throw error;
    }
  }
  return flows;
}

/**
 * Les scénarios écrits pour la première version (crawler d'URL) fonctionnent
 * toujours : leurs clés sont traduites au format mission, avec un avertissement.
 */
function migrateLegacyKeys(raw: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw };
  const asObject = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : undefined;

  if ('name' in result || 'description' in result) {
    const mission = asObject(result.mission) ?? {};
    if ('name' in result) mission.name ??= result.name;
    if ('description' in result) mission.description ??= result.description;
    result.mission = mission;
    delete result.name;
    delete result.description;
    warnings.push('"name"/"description" are deprecated: use mission.name / mission.description.');
  }

  const exploration = asObject(result.exploration);
  if (exploration) {
    const renamed = new Map([
      ['maxPages', 'maxStates'],
      ['maxUrlsPerRoute', 'maxStatesPerRoute'],
    ]);
    const removed = new Set(['clickSafeActions', 'followRouterLinks', 'maxActionsPerPage']);
    const migrated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(exploration)) {
      const newKey = renamed.get(key);
      if (newKey !== undefined) {
        warnings.push(`exploration.${key} is deprecated: use exploration.${newKey}.`);
        if (!(newKey in exploration)) migrated[newKey] = value;
      } else if (removed.has(key)) {
        warnings.push(
          `exploration.${key} is obsolete and ignored: the flow explorer always discovers links, routerLinks and buttons (see goals.* and safety.allow).`,
        );
      } else {
        migrated[key] = value;
      }
    }
    result.exploration = migrated;
  }
  return result;
}

function applyOverrides(
  raw: Record<string, unknown>,
  overrides: ConfigOverrides,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw };
  const section = (key: string): Record<string, unknown> => {
    const current = result[key];
    const copy =
      current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    result[key] = copy;
    return copy;
  };

  const baseUrl = overrides.baseUrl ?? nonBlank(env[BASE_URL_ENV]);
  if (baseUrl !== undefined) section('target').baseUrl = baseUrl;
  if (overrides.maxStates !== undefined) section('exploration').maxStates = overrides.maxStates;
  if (overrides.maxActions !== undefined) section('exploration').maxActions = overrides.maxActions;
  if (overrides.headless !== undefined) section('browser').headless = overrides.headless;
  if (overrides.reportsDir !== undefined) section('output').reportsDir = overrides.reportsDir;
  if (overrides.screenshotsDir !== undefined) section('output').screenshotsDir = overrides.screenshotsDir;
  applyPersistenceOverrides(section, overrides, env);
  applyIntelligenceOverrides(section, overrides, env);
  return result;
}

/**
 * Intelligence optionnelle : CLI, puis environnement, puis YAML. Choisir ASSIST ou HYBRID
 * l'active ; OFF la coupe entièrement (aucun client, aucun appel).
 */
function applyIntelligenceOverrides(
  section: (key: string) => Record<string, unknown>,
  overrides: ConfigOverrides,
  env: NodeJS.ProcessEnv,
): void {
  const copilot = (ai: Record<string, unknown>): Record<string, unknown> => {
    const current = ai.copilot;
    const copy =
      current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    ai.copilot = copy;
    return copy;
  };
  const enabled = nonBlank(env[INTELLIGENCE_ENV.enabled])?.toLowerCase();
  if (enabled !== undefined) {
    if (!['true', '1', 'yes', 'on', 'false', '0', 'no', 'off'].includes(enabled))
      throw new ConfigError(`${INTELLIGENCE_ENV.enabled} must be true or false (got "${enabled}")`);
    section('ai').enabled = ['true', '1', 'yes', 'on'].includes(enabled);
  }
  const mode = overrides.intelligence ?? nonBlank(env[INTELLIGENCE_ENV.mode])?.toLowerCase();
  if (mode !== undefined) {
    if (!(INTELLIGENCE_CHOICES as readonly string[]).includes(mode))
      throw new ConfigError(
        `intelligence mode must be one of ${INTELLIGENCE_CHOICES.join(', ')} (got "${mode}")`,
      );
    const ai = section('ai');
    ai.mode = mode.toUpperCase();
    ai.enabled = mode !== 'off';
  }
  const provider = overrides.aiProvider ?? nonBlank(env[INTELLIGENCE_ENV.provider]);
  if (provider !== undefined) section('ai').provider = provider.toLowerCase();
  const model = overrides.aiModel ?? nonBlank(env[INTELLIGENCE_ENV.model]);
  if (model !== undefined) copilot(section('ai')).model = model;
  const effort = nonBlank(env[INTELLIGENCE_ENV.reasoningEffort]);
  if (effort !== undefined) copilot(section('ai')).reasoningEffort = effort.toLowerCase();
}

/**
 * Persistance et mémoire : CLI, puis environnement, puis YAML, puis valeurs par défaut —
 * la même priorité que target.baseUrl (--base-url, QA_BASE_URL). Les identifiants de base de
 * données ne passent jamais par ici : ils sont lus au moment de la connexion (…Env).
 */
function applyPersistenceOverrides(
  section: (key: string) => Record<string, unknown>,
  overrides: ConfigOverrides,
  env: NodeJS.ProcessEnv,
): void {
  const flag = (name: string): boolean | undefined => {
    const value = nonBlank(env[name])?.toLowerCase();
    if (value === undefined) return undefined;
    if (['true', '1', 'yes', 'on'].includes(value)) return true;
    if (['false', '0', 'no', 'off'].includes(value)) return false;
    throw new ConfigError(`${name} must be true or false (got "${value}")`);
  };
  const database = (persistence: Record<string, unknown>): Record<string, unknown> => {
    const current = persistence.database;
    const copy =
      current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    persistence.database = copy;
    return copy;
  };

  const envEnabled = flag(PERSISTENCE_ENV.enabled);
  const envProvider = nonBlank(env[PERSISTENCE_ENV.provider]);
  const envType = nonBlank(env[PERSISTENCE_ENV.databaseType]);
  if (envEnabled !== undefined) section('persistence').enabled = envEnabled;
  if (envProvider !== undefined) section('persistence').provider = envProvider;
  if (envType !== undefined) database(section('persistence')).type = envType;
  const envMemory = flag(PERSISTENCE_ENV.memory);
  if (envMemory !== undefined) section('memory').enabled = envMemory;

  const choice = overrides.persistence;
  if (choice !== undefined) {
    const persistence = section('persistence');
    if (choice === 'off') persistence.enabled = false;
    else {
      persistence.enabled = true;
      if (choice === 'memory' || choice === 'file') persistence.provider = choice;
      else {
        persistence.provider = 'database';
        database(persistence).type = choice;
      }
    }
  }
  if (overrides.memory !== undefined) section('memory').enabled = overrides.memory;
}

/** Jamais d'identifiants de base de données dans le YAML : seulement le nom de leur variable d'environnement. */
function refuseInlineCredentials(raw: Record<string, unknown>): void {
  const persistence = raw.persistence as { database?: unknown } | undefined;
  const database = persistence?.database;
  if (database === null || typeof database !== 'object') return;
  const inline = ['password', 'username', 'user', 'connectionString', 'url'].filter((key) => key in database);
  if (inline.length > 0)
    throw new ConfigError('Invalid scenario', [
      `persistence.database.${inline.join(', ')}: never write database credentials in the YAML; set usernameEnv / passwordEnv to the names of environment variables (default QA_DB_USERNAME / QA_DB_PASSWORD)`,
    ]);
}

function finalize(config: ScenarioConfig): Omit<LoadedConfig, 'source'> {
  const warnings: string[] = [];
  const baseHost = new URL(config.target.baseUrl).hostname;

  if (!config.target.startAt.startsWith('/') && !/^https?:\/\//i.test(config.target.startAt)) {
    config.target.startAt = `/${config.target.startAt}`;
  }
  if (config.safety.allowedHosts.length === 0) {
    config.safety.allowedHosts = [baseHost];
  } else if (!config.safety.allowedHosts.some((host) => hostMatches(baseHost, host))) {
    warnings.push(
      `safety.allowedHosts does not include the target host "${baseHost}": nothing will be crawled.`,
    );
  }
  if (config.safety.allowedActionClasses.includes('DANGEROUS')) {
    const stillBlocked = config.safety.block.filter((risk) => risk !== 'sensitive-data');
    warnings.push(
      `safety.allowedActionClasses includes DANGEROUS: destructive actions (delete, pay, send…) may be executed. Use only on disposable environments.${stillBlocked.length > 0 ? ` Risks still blocked by safety.block: ${stillBlocked.join(', ')}.` : ''} Sensitive fields are never filled.`,
    );
  }
  if (config.safety.mutations.enabled) {
    if (!config.safety.allowedActionClasses.includes('MUTATION'))
      config.safety.allowedActionClasses = [...config.safety.allowedActionClasses, 'MUTATION'];
    if (config.forms.submit !== false)
      config.safety.block = config.safety.block.filter((risk) => risk !== 'form-submit');
    warnings.push(
      `safety.mutations.enabled: the crawler may create or modify data (at most ${config.safety.mutations.maxPerRun} per run, tagged QA-CRAWLER-<runId>). Use a test environment.`,
    );
  } else if (config.safety.allowedActionClasses.includes('MUTATION')) {
    warnings.push('safety.allowedActionClasses includes MUTATION: the crawler may modify data.');
  }
  for (const flow of config.flows) {
    if (flow.startAt !== undefined && !flow.startAt.startsWith('/') && !/^https?:\/\//i.test(flow.startAt)) {
      flow.startAt = `/${flow.startAt}`;
    }
    const mutating = flow.steps.filter((step) => step.allow.includes('MUTATION')).length;
    if (mutating > 0) {
      warnings.push(`flow "${flow.name}": ${mutating} step(s) allow MUTATION and may modify data.`);
    }
  }
  const { discover } = config.goals;
  if (discover) {
    // goals.discover est la forme courte des interrupteurs discover*.
    if (discover.navigation !== undefined) config.goals.discoverNavigation = discover.navigation;
    if (discover.forms !== undefined) config.goals.discoverForms = discover.forms;
    if (discover.dialogs !== undefined) config.goals.discoverFlows = discover.dialogs;
  }
  if (config.forms.autoFill !== undefined) config.forms.exercise = config.forms.autoFill;
  const actorNames = config.actors.map((actor) => actor.name);
  const duplicates = actorNames.filter((name, index) => actorNames.indexOf(name) !== index);
  if (duplicates.length > 0 || actorNames.includes(config.authorization.primaryActor)) {
    throw new ConfigError('Invalid scenario', [
      `actors: names must be unique and differ from authorization.primaryActor (${[...new Set([...duplicates, config.authorization.primaryActor].filter((name) => actorNames.includes(name)))].join(', ')})`,
    ]);
  }
  const known = new Set([config.authorization.primaryActor, ...actorNames]);
  for (const rule of config.authorization.rules) {
    if (!known.has(rule.actor))
      throw new ConfigError('Invalid scenario', [`authorization.rules: unknown actor "${rule.actor}"`]);
  }
  if (config.openapi.enabled && !config.openapi.source) {
    throw new ConfigError('Invalid scenario', ['openapi.source: required when openapi.enabled is true']);
  }
  if (config.forms.submit === true) {
    config.safety.block = config.safety.block.filter((risk) => risk !== 'form-submit');
  } else if (config.forms.submit === false && !config.safety.block.includes('form-submit')) {
    config.safety.block = [...config.safety.block, 'form-submit'];
  }
  if (!config.memory.cache.enabled)
    warnings.push(
      'memory.cache.enabled: false is ignored: decisions always read the working memory (RAM), never the database directly.',
    );
  if (config.memory.enabled === true && !config.persistence.enabled)
    warnings.push('memory.enabled without persistence: only the memory of the current run is used.');
  if (!config.exploration.autonomous && config.flows.length === 0) {
    warnings.push('exploration.autonomous is false and no flow is defined: nothing will be tested.');
  }
  if (config.auth.type === 'http') {
    // auth.type: http est un raccourci pour un profil d'identifiants traité par le HttpAuthHandler.
    const { httpAuth } = config.browserInteractions;
    if (!('auth' in config.credentials)) {
      config.credentials.auth = {
        usernameEnv: config.auth.usernameEnv,
        passwordEnv: config.auth.passwordEnv,
      };
    }
    httpAuth.credentialProfile ??= 'auth';
    if (config.auth.origin !== undefined && httpAuth.origins.length === 0)
      httpAuth.origins = [config.auth.origin];
    if (config.auth.origin === undefined) {
      warnings.push(
        'auth.origin is not set: the HTTP credentials are only sent to the target and allowed hosts. If the sign-in dialog comes from another server (SSO), set auth.origin (e.g. https://sso.example.com).',
      );
    }
  }
  const profile = config.browserInteractions.httpAuth.credentialProfile;
  if (profile !== undefined && !(profile in config.credentials)) {
    throw new ConfigError('Invalid scenario', [
      `browserInteractions.httpAuth.credentialProfile: unknown profile "${profile}" (declare it under credentials)`,
    ]);
  }
  if (config.auth.type === 'form' && !config.auth.successSelector && !config.auth.successUrlContains) {
    warnings.push(
      'auth: neither successSelector nor successUrlContains is set; login success cannot be verified.',
    );
  }
  return { config, warnings };
}

/** `*.example.com` couvre les sous-domaines (pas le domaine lui-même) ; sinon, correspondance exacte, sans tenir compte de la casse. */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const expected = pattern.toLowerCase();
  if (expected.startsWith('*.')) {
    return host.endsWith(expected.slice(1));
  }
  return host === expected;
}

function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    if (issue.code === 'unrecognized_keys') {
      const hint = issue.keys.some((key) => /pass(word)?|secret|token/i.test(key))
        ? ' (credentials must come from environment variables, see auth.usernameEnv/passwordEnv)'
        : '';
      return `${path}: unknown key(s) ${issue.keys.map((key) => `"${key}"`).join(', ')}${hint}`;
    }
    return `${path}: ${issue.message}`;
  });
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}
