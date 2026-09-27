import { readFile } from 'node:fs/promises';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ZodError } from 'zod';
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
}

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

  const migrationWarnings: string[] = [];
  const migrated = migrateLegacyKeys(raw as Record<string, unknown>, migrationWarnings);
  const withOverrides = applyOverrides(migrated, overrides, env);

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
  return result;
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
