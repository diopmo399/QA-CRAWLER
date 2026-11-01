import { loadAnthropicSdk, type AnthropicSdkModule } from '../../../ai/anthropic/sdk.js';
import {
  ModelNotAvailableError,
  ModelResponseError,
  ModelTimeoutError,
  type InvestigationModelClient,
  type ModelCallOptions,
  type ModelCompletionInput,
  type ModelTurn,
} from '../model-client.js';
import {
  priceOf,
  toAnthropicMessages,
  toAnthropicTool,
  turnOf,
  usageOf,
  type AnthropicContentBlockLike,
  type AnthropicToolClientLike,
  type AnthropicToolMessageLike,
  type AnthropicToolMessageRequest,
  type AnthropicToolSdkModule,
  type ModelPrice,
} from './anthropic-messages.js';

/**
 * LE CLIENT ANTHROPIC DE L'INVESTIGATION : l'API Messages avec outils, par le SDK officiel (dépendance
 * optionnelle, chargée au premier appel). La clé n'est lue qu'ici, depuis le nom de variable de la
 * configuration, et ne sort jamais : ni dans les traces, ni dans les erreurs, ni dans les runs.
 *
 * Ce que le modèle a réellement rendu (blocs de réflexion compris) est gardé par identifiant d'appel d'outil,
 * pour être renvoyé inchangé au tour suivant ; rien n'est persisté.
 */
export interface AnthropicInvestigationClientOptions {
  model: string;
  /** Le NOM de la variable d'environnement de la clé (défaut ANTHROPIC_API_KEY) ; sa valeur n'est lue qu'ici. */
  apiKeyEnv?: string;
  env: NodeJS.ProcessEnv;
  baseUrl?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxRetries?: number;
  /** Repli côté serveur sur un refus (`fallbacks: "default"`), pour un modèle qui l'accepte. */
  serverSideFallback?: boolean;
  /** La grille tarifaire connue ; absente : coût estimé 0 (jamais inventé). */
  prices?: Readonly<Record<string, ModelPrice>>;
  /** Remplace le chargement du SDK (tests). */
  loadSdk?: () => Promise<AnthropicToolSdkModule>;
}

export const DEFAULT_ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';
const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Les blocs originaux gardés par appel d'outil : au-delà, les plus anciens sont oubliés. */
const MAX_ORIGINALS = 400;

export class AnthropicInvestigationClient implements InvestigationModelClient {
  readonly id = 'anthropic';
  readonly model: string;
  private client: AnthropicToolClientLike | undefined;
  private reason: string | undefined;
  private readonly originals = new Map<string, AnthropicContentBlockLike[]>();

  constructor(private readonly options: AnthropicInvestigationClientOptions) {
    this.model = options.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  unavailableReason(): string | undefined {
    return this.reason;
  }

  async complete(input: ModelCompletionInput, options: ModelCallOptions): Promise<ModelTurn> {
    let client: AnthropicToolClientLike;
    try {
      client = await this.connect();
    } catch (error) {
      throw new ModelNotAvailableError(error instanceof Error ? error.message : String(error));
    }
    const request: AnthropicToolMessageRequest = {
      model: this.model,
      max_tokens: Math.max(256, input.maxOutputTokens),
      system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(input.messages, this.originals),
      ...(input.tools.length > 0
        ? { tools: input.tools.map(toAnthropicTool), tool_choice: { type: 'auto' as const } }
        : {}),
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.options.effort ?? 'high',
        // Un schéma de sortie et des outils ne se combinent pas : le JSON final est extrait du texte.
        ...(input.outputSchema && input.tools.length === 0
          ? { format: { type: 'json_schema' as const, schema: input.outputSchema } }
          : {}),
      },
      ...(this.options.serverSideFallback
        ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' as const }
        : {}),
    };
    const message = await this.call(client, request, options);
    for (const block of message.content)
      if (block.type === 'tool_use' && typeof block.id === 'string') this.remember(block.id, message.content);
    const usage = usageOf(message, priceOf(this.model, this.options.prices ?? {}));
    return turnOf(message, usage);
  }

  close(): Promise<void> {
    this.originals.clear();
    this.client = undefined;
    return Promise.resolve();
  }

  private async call(
    client: AnthropicToolClientLike,
    request: AnthropicToolMessageRequest,
    options: ModelCallOptions,
  ): Promise<AnthropicToolMessageLike> {
    const timeoutMs = Math.max(1, options.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ModelTimeoutError(`model call timed out after ${String(timeoutMs)} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        client.beta.messages.create(request, {
          signal: options.signal,
          timeout: timeoutMs,
          maxRetries: this.options.maxRetries ?? 0,
        }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof ModelTimeoutError) throw error;
      if (options.signal.aborted) throw error;
      throw new ModelResponseError(`anthropic: ${describeError(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async connect(): Promise<AnthropicToolClientLike> {
    if (this.client) return this.client;
    const { env } = this.options;
    const keyEnv = this.options.apiKeyEnv ?? DEFAULT_ANTHROPIC_KEY_ENV;
    const apiKey = (env[keyEnv] ?? '').trim();
    if (!apiKey) throw new Error(`no Anthropic API key: ${keyEnv} is not set`);
    let sdk: AnthropicToolSdkModule;
    try {
      sdk = await (this.options.loadSdk ?? loadToolSdk)();
    } catch {
      throw new Error('@anthropic-ai/sdk is not installed');
    }
    this.client = new sdk.default({
      apiKey,
      ...(this.options.baseUrl ? { baseURL: this.options.baseUrl } : {}),
      maxRetries: 0,
    });
    return this.client;
  }

  private remember(id: string, blocks: AnthropicContentBlockLike[]): void {
    if (this.originals.size >= MAX_ORIGINALS) {
      const oldest = this.originals.keys().next().value;
      if (oldest !== undefined) this.originals.delete(oldest);
    }
    this.originals.set(id, blocks);
  }
}

/** Le SDK, vu avec l'API outils (même module ; la forme structurelle est plus large que celle du cœur). */
async function loadToolSdk(): Promise<AnthropicToolSdkModule> {
  const sdk: AnthropicSdkModule = await loadAnthropicSdk();
  return sdk as unknown as AnthropicToolSdkModule;
}

/** Un message d'erreur sans valeur de l'environnement : seuls le statut et le type sont conservés. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const status = (error as { status?: unknown }).status;
  const head = typeof status === 'number' ? `HTTP ${String(status)}` : error.name || 'Error';
  const text = error.message.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300);
  return `${head}: ${text}`;
}

export function createAnthropicInvestigationClient(
  options: AnthropicInvestigationClientOptions,
): InvestigationModelClient {
  return new AnthropicInvestigationClient(options);
}
