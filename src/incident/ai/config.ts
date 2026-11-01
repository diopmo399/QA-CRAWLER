import { z } from 'zod';
import type { AiConfig } from '../../config/config.js';
import {
  AI_INVESTIGATION_MODES,
  type AiBudget,
  type AiCapabilities,
  type AiDataPolicy,
  type AiInvestigationMode,
} from '../../sdk/core/incident-ai-contracts.js';

/**
 * LA CONFIGURATION DE L'INVESTIGATION IA (`ai.incidents`), validée et bornée ici — le schéma de
 * `src/config/config.ts` ne fait que l'accueillir (forme libre, mode DETERMINISTIC par défaut) pour que
 * rien de `src/incident/ai/` ne soit chargé tant que l'IA n'est pas demandée.
 *
 * Règles : DETERMINISTIC par défaut ; `ai.enabled === false` éteint tout ; `dataPolicy.allowExternal`
 * faux rend l'IA indisponible ; aucune commande n'est jamais permise (`maxCommands` vaut toujours 0) ;
 * les secrets ne sont désignés que par le NOM de leur variable d'environnement, jamais lus ici.
 */
export const INCIDENT_AI_PROVIDERS = ['anthropic', 'copilot'] as const;
export type IncidentAiProvider = (typeof INCIDENT_AI_PROVIDERS)[number];

export const DEFAULT_AI_BUDGET: Readonly<AiBudget> = Object.freeze({
  maxIterations: 4,
  maxModelCalls: 24,
  maxToolCalls: 60,
  maxInputTokens: 400_000,
  maxOutputTokens: 40_000,
  maxCost: 0,
  maxDurationMs: 300_000,
  maxFiles: 40,
  maxCommands: 0,
  maxExperiments: 2,
});

/** Plafonds : une configuration ne peut pas demander davantage. */
export const AI_BUDGET_CAPS: Readonly<AiBudget> = Object.freeze({
  maxIterations: 20,
  maxModelCalls: 200,
  maxToolCalls: 500,
  maxInputTokens: 5_000_000,
  maxOutputTokens: 500_000,
  maxCost: 1_000,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxFiles: 1_000,
  maxCommands: 0,
  maxExperiments: 20,
});

export const DEFAULT_AI_DATA_POLICY: Readonly<AiDataPolicy> = Object.freeze({
  allowExternal: false,
  sendSourceCode: true,
  sendHttpBodies: true,
  sendLogs: false,
  sendScreenshots: false,
  maxSnippetChars: 4_000,
});

export const MIN_SNIPPET_CHARS = 200;
export const MAX_SNIPPET_CHARS = 20_000;
export const DEFAULT_AI_TIMEOUT_MS = 60_000;
export const DEFAULT_AI_MAX_RETRIES = 2;
/** Tours par agent : un passage court en AI_ASSISTED, une boucle bornée en AI_AGENTIC. */
export const DEFAULT_TURNS_PER_AGENT: Readonly<
  Record<Exclude<AiInvestigationMode, 'DETERMINISTIC'>, number>
> = Object.freeze({ AI_ASSISTED: 2, AI_AGENTIC: 6 });
export const MAX_TURNS_PER_AGENT = 12;
/** Le nom standard de la variable qui porte la clé Anthropic (résolution du SDK). */
export const DEFAULT_ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';

const nonEmpty = z.string().trim().min(1);
const bounded = (max: number, fallback: number, min = 1): z.ZodDefault<z.ZodNumber> =>
  z.number().int().min(min).max(max).default(fallback);

export const aiBudgetSchema = z
  .object({
    maxIterations: bounded(AI_BUDGET_CAPS.maxIterations, DEFAULT_AI_BUDGET.maxIterations),
    maxModelCalls: bounded(AI_BUDGET_CAPS.maxModelCalls, DEFAULT_AI_BUDGET.maxModelCalls),
    maxToolCalls: bounded(AI_BUDGET_CAPS.maxToolCalls, DEFAULT_AI_BUDGET.maxToolCalls, 0),
    maxInputTokens: bounded(AI_BUDGET_CAPS.maxInputTokens, DEFAULT_AI_BUDGET.maxInputTokens, 1_000),
    maxOutputTokens: bounded(AI_BUDGET_CAPS.maxOutputTokens, DEFAULT_AI_BUDGET.maxOutputTokens, 256),
    /** 0 : pas de plafond de coût. */
    maxCost: z.number().min(0).max(AI_BUDGET_CAPS.maxCost).default(DEFAULT_AI_BUDGET.maxCost),
    maxDurationMs: bounded(AI_BUDGET_CAPS.maxDurationMs, DEFAULT_AI_BUDGET.maxDurationMs, 1_000),
    maxFiles: bounded(AI_BUDGET_CAPS.maxFiles, DEFAULT_AI_BUDGET.maxFiles, 0),
    /** Aucun outil ne lance une commande : toute autre valeur que 0 est refusée. */
    maxCommands: z.literal(0).default(0),
    maxExperiments: bounded(AI_BUDGET_CAPS.maxExperiments, DEFAULT_AI_BUDGET.maxExperiments, 0),
  })
  .strict();

export const aiDataPolicySchema = z
  .object({
    allowExternal: z.boolean().default(DEFAULT_AI_DATA_POLICY.allowExternal),
    sendSourceCode: z.boolean().default(DEFAULT_AI_DATA_POLICY.sendSourceCode),
    sendHttpBodies: z.boolean().default(DEFAULT_AI_DATA_POLICY.sendHttpBodies),
    sendLogs: z.boolean().default(DEFAULT_AI_DATA_POLICY.sendLogs),
    /** Jamais transmis dans cette version : la valeur est acceptée mais reste sans effet (vague 1). */
    sendScreenshots: z.boolean().default(DEFAULT_AI_DATA_POLICY.sendScreenshots),
    maxSnippetChars: z
      .number()
      .int()
      .min(MIN_SNIPPET_CHARS)
      .max(MAX_SNIPPET_CHARS)
      .default(DEFAULT_AI_DATA_POLICY.maxSnippetChars),
  })
  .strict();

/** La forme stricte de `ai.incidents` (celle de `src/config/config.ts` est libre : la validation est ici). */
export const incidentAiConfigSchema = z
  .object({
    mode: z.enum(AI_INVESTIGATION_MODES).default('DETERMINISTIC'),
    /** Absent : `ai.provider` quand c'est l'un des deux. */
    provider: z.enum(INCIDENT_AI_PROVIDERS).optional(),
    /** Absent : le modèle du fournisseur (`ai.anthropic.model`, `ai.copilot.modelSelection.model`). */
    model: nonEmpty.optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(DEFAULT_AI_TIMEOUT_MS),
    maxRetries: z.number().int().min(0).max(3).default(DEFAULT_AI_MAX_RETRIES),
    /** Absent : 2 en AI_ASSISTED, 6 en AI_AGENTIC. */
    maxTurnsPerAgent: z.number().int().min(1).max(MAX_TURNS_PER_AGENT).optional(),
    budget: aiBudgetSchema.prefault({}),
    dataPolicy: aiDataPolicySchema.prefault({}),
  })
  .strict();

export type IncidentAiConfigInput = z.input<typeof incidentAiConfigSchema>;
export type IncidentAiConfig = z.output<typeof incidentAiConfigSchema>;

export interface IncidentAiSettings {
  /** Le mode EFFECTIF : DETERMINISTIC dès que l'IA est éteinte ou indisponible. */
  mode: AiInvestigationMode;
  /** Le mode demandé par la configuration (affiché avec la raison quand il diffère). */
  configuredMode: AiInvestigationMode;
  /** Vrai quand un fournisseur peut être créé (mode non déterministe, politique et secrets en place). */
  enabled: boolean;
  provider?: IncidentAiProvider;
  model?: string;
  timeoutMs: number;
  maxRetries: number;
  maxTurnsPerAgent: number;
  budget: AiBudget;
  dataPolicy: AiDataPolicy;
  /** Les NOMS des variables d'environnement des secrets du fournisseur (jamais leurs valeurs). */
  secretEnvNames: string[];
  /** Pourquoi l'IA est indisponible (jamais un secret, jamais une valeur de l'environnement). */
  unavailableReason?: string;
}

export class IncidentAiConfigError extends Error {
  override readonly name = 'IncidentAiConfigError';
}

const issueText = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(racine)'} : ${issue.message}`)
    .join(' ; ');

/** Valide `ai.incidents` strictement ; lève IncidentAiConfigError (sans valeur de l'environnement). */
export function parseIncidentAiConfig(raw: unknown): IncidentAiConfig {
  const parsed = incidentAiConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new IncidentAiConfigError(`ai.incidents invalide — ${issueText(parsed.error)}`);
  return parsed.data;
}

function providerOf(config: IncidentAiConfig, ai: AiConfig | undefined): IncidentAiProvider | undefined {
  if (config.provider) return config.provider;
  const candidate = ai?.provider;
  return candidate === 'anthropic' || candidate === 'copilot' ? candidate : undefined;
}

function modelOf(
  config: IncidentAiConfig,
  ai: AiConfig | undefined,
  provider: IncidentAiProvider | undefined,
): string | undefined {
  if (config.model) return config.model;
  if (provider === 'anthropic') return ai?.anthropic.model;
  if (provider === 'copilot') return ai?.copilot.modelSelection.model;
  return undefined;
}

const envNamesOf = (ai: AiConfig | undefined, provider: IncidentAiProvider | undefined): string[] => {
  if (provider === 'anthropic') return [ai?.anthropic.apiKeyEnv ?? DEFAULT_ANTHROPIC_KEY_ENV];
  if (provider === 'copilot' && ai?.copilot.tokenEnv) return [ai.copilot.tokenEnv];
  return [];
};

const hasValue = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim() !== '';

/**
 * Résout `ai.incidents` en réglages validés et bornés. Ne lève jamais : une configuration invalide
 * ou incomplète donne DETERMINISTIC avec la raison (`unavailableReason`), sans aucune valeur secrète.
 */
export function resolveIncidentAiSettings(
  ai: AiConfig | undefined,
  env: NodeJS.ProcessEnv = {},
): IncidentAiSettings {
  let config: IncidentAiConfig;
  let invalid: string | undefined;
  try {
    config = parseIncidentAiConfig(ai?.incidents);
  } catch (error) {
    config = incidentAiConfigSchema.parse({});
    invalid = error instanceof Error ? error.message : String(error);
  }
  const provider = providerOf(config, ai);
  const model = modelOf(config, ai, provider);
  const secretEnvNames = envNamesOf(ai, provider);
  const configuredMode = config.mode;
  const turns =
    config.maxTurnsPerAgent ??
    (configuredMode === 'DETERMINISTIC'
      ? DEFAULT_TURNS_PER_AGENT.AI_ASSISTED
      : DEFAULT_TURNS_PER_AGENT[configuredMode]);

  const reasons: string[] = [];
  if (invalid) reasons.push(invalid);
  if (configuredMode !== 'DETERMINISTIC') {
    if (!ai || !ai.enabled) reasons.push('L’IA est désactivée (ai.enabled est faux).');
    if (!config.dataPolicy.allowExternal)
      reasons.push(
        'La politique de données interdit toute transmission externe (ai.incidents.dataPolicy.allowExternal).',
      );
    if (provider === undefined)
      reasons.push('Aucun fournisseur d’IA (ai.incidents.provider ou ai.provider : anthropic | copilot).');
    if (provider === 'anthropic' && model === undefined)
      reasons.push('Le fournisseur anthropic exige un modèle (ai.incidents.model ou ai.anthropic.model).');
    for (const name of secretEnvNames)
      if (!hasValue(env, name)) reasons.push(`La variable d’environnement ${name} n’est pas définie.`);
  }

  const unavailable = reasons.length > 0 ? reasons.join(' ') : undefined;
  const enabled = configuredMode !== 'DETERMINISTIC' && unavailable === undefined;
  return {
    mode: enabled ? configuredMode : 'DETERMINISTIC',
    configuredMode,
    enabled,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxTurnsPerAgent: turns,
    budget: { ...config.budget, maxCommands: 0 },
    dataPolicy: { ...config.dataPolicy, sendScreenshots: false },
    secretEnvNames,
    ...(unavailable !== undefined ? { unavailableReason: unavailable } : {}),
  };
}

/** Ce que le serveur annonce avant de lancer : les modes réellement disponibles et la politique en place. */
export function incidentAiCapabilities(settings: IncidentAiSettings): AiCapabilities {
  return {
    defaultMode: settings.mode,
    availableModes: settings.enabled ? [...AI_INVESTIGATION_MODES] : ['DETERMINISTIC'],
    ...(settings.provider !== undefined ? { provider: settings.provider } : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.unavailableReason !== undefined ? { unavailableReason: settings.unavailableReason } : {}),
    dataPolicy: { ...settings.dataPolicy },
    budget: { ...settings.budget },
  };
}
