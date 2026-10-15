import { buildUserPrompt, extractJson, QA_ADVISOR_SYSTEM_PROMPT } from '../copilot/prompt-builder.js';
import {
  loadAnthropicSdk,
  type AnthropicSdkModule,
  type AnthropicClientLike,
  type AnthropicMessageLike,
  type AnthropicMessageRequest,
} from '../anthropic/sdk.js';
import {
  INTELLIGENCE_PROPOSAL_JSON_SCHEMA,
  type IntelligenceRequest,
  type ProviderCallOptions,
  type ProviderResult,
} from '../model.js';
import type { IntelligenceProvider } from '../provider.js';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions {
  /** L'identifiant du modèle ; absent : le fournisseur est indisponible. */
  model?: string;
  effort: AnthropicEffort;
  maxTokens: number;
  timeoutMs: number;
  /** Repli côté serveur sur un refus (`fallbacks: "default"`), pour un modèle qui l'accepte. */
  serverSideFallback: boolean;
  /** Nom de la variable d'environnement de la clé ; absent : résolution standard du SDK. */
  apiKeyEnv?: string;
  baseUrl?: string;
  env: NodeJS.ProcessEnv;
  /** Remplace le chargement du SDK (tests, intégrations). */
  loadSdk?: () => Promise<AnthropicSdkModule>;
}

const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Les contraintes que les sorties structurées refusent : retirées, puis revalidées par QA-Crawler. */
const UNSUPPORTED_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

/** Le schéma de proposition, sans les contraintes non prises en charge (le validateur les revérifie). */
export function structuredOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structuredOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]) => [key, structuredOutputSchema(value)]),
  );
}

/**
 * ANTHROPIC INTELLIGENCE PROVIDER : un modèle de l'API Anthropic (celui de `ai.anthropic.model`)
 * comme CONSEILLER de raisonnement, par le SDK officiel (`@anthropic-ai/sdk`). Il reçoit la requête structurée et
 * nettoyée, et rend une proposition au schéma JSON (sorties structurées). Il n'a aucun outil :
 * ni Playwright, ni shell, ni fichiers — la passerelle valide, la SafetyPolicy autorise,
 * l'exécuteur exécute, le runtime confirme.
 */
export class AnthropicIntelligenceProvider implements IntelligenceProvider {
  readonly id = 'anthropic';
  model: string | undefined;
  private client: AnthropicClientLike | undefined;
  private unavailable: string | undefined;

  constructor(private readonly options: AnthropicProviderOptions) {}

  unavailableReason(): string | undefined {
    return this.unavailable;
  }

  /** Le SDK est installé et une clé est configurée. Aucun appel réseau, ne lève jamais. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async analyze(request: IntelligenceRequest, options: ProviderCallOptions): Promise<ProviderResult> {
    const client = await this.connect();
    const model = this.options.model ?? '';
    const fallback = this.options.serverSideFallback;
    const body: AnthropicMessageRequest = {
      model,
      max_tokens: this.options.maxTokens,
      // Instructions stables en tête, mises en cache ; la requête (volatile) vient après.
      system: [{ type: 'text', text: QA_ADVISOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserPrompt(request) }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.options.effort,
        format: {
          type: 'json_schema',
          schema: structuredOutputSchema(INTELLIGENCE_PROPOSAL_JSON_SCHEMA) as Record<string, unknown>,
        },
      },
      ...(fallback ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
    // Une seule tentative ici : la passerelle gère délai, nouvelles tentatives et replis.
    const message = await client.beta.messages.create(body, {
      signal: options.signal,
      timeout: this.options.timeoutMs,
      maxRetries: 0,
    });
    this.model = message.model;
    if (message.model !== model)
      options.emit?.('AI_MODEL_FALLBACK', `server-side fallback: ${model} → ${message.model}`);
    const usage = {
      ...(typeof message.usage?.input_tokens === 'number' ? { inputTokens: message.usage.input_tokens } : {}),
      ...(typeof message.usage?.output_tokens === 'number'
        ? { outputTokens: message.usage.output_tokens }
        : {}),
    };
    return {
      raw: answerOf(message),
      model: message.model,
      toolCalls: 0,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
  }

  private async connect(): Promise<AnthropicClientLike> {
    if (this.client) return this.client;
    const { apiKeyEnv, env } = this.options;
    if (!this.options.model) throw new Error('no model: set ai.anthropic.model (or --ai-model)');
    const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
    if (apiKeyEnv && !apiKey) throw new Error(`no Anthropic API key: ${apiKeyEnv} is not set`);
    if (!apiKeyEnv && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN)
      throw new Error('no Anthropic API key: ANTHROPIC_API_KEY is not set (or set ai.anthropic.apiKeyEnv)');
    let sdk: AnthropicSdkModule;
    try {
      sdk = await (this.options.loadSdk ?? loadAnthropicSdk)();
    } catch {
      throw new Error('@anthropic-ai/sdk is not installed');
    }
    this.client = new sdk.default({
      ...(apiKey ? { apiKey } : {}),
      ...(this.options.baseUrl ? { baseURL: this.options.baseUrl } : {}),
      timeout: this.options.timeoutMs,
      maxRetries: 0,
    });
    return this.client;
  }
}

/** La réponse → l'objet que la passerelle revalide. Un refus est une abstention, jamais une proposition. */
function answerOf(message: AnthropicMessageLike): unknown {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    return {
      status: 'INCONCLUSIVE',
      supportingEvidenceIds: [],
      uncertainties: [`the model declined to answer (refusal${category ? `: ${category}` : ''})`],
      confidence: 0,
    };
  }
  if (message.stop_reason === 'max_tokens') return { invalid: 'max_tokens: the answer was cut off' };
  const text = message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  return text ? extractJson(text) : { invalid: 'no text in the answer' };
}
