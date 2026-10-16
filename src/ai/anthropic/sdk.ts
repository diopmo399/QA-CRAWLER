/**
 * Ce que QA-Crawler utilise de `@anthropic-ai/sdk`, décrit STRUCTURELLEMENT : le cœur ne dépend
 * jamais des types du SDK (dépendance optionnelle, chargée dynamiquement dans ce seul module), et
 * les tests peuvent fournir un faux SDK.
 */

export interface AnthropicTextBlockLike {
  type: string;
  text?: string;
}

export interface AnthropicMessageLike {
  model: string;
  content: AnthropicTextBlockLike[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

/** Le corps d'une requête Messages, tel que QA-Crawler l'envoie (sous-ensemble du SDK). */
export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  messages: { role: 'user'; content: string }[];
  thinking?: { type: 'adaptive' };
  output_config: {
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    format: { type: 'json_schema'; schema: Record<string, unknown> };
  };
  betas?: string[];
  fallbacks?: 'default';
}

export interface AnthropicRequestOptionsLike {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

export interface AnthropicClientLike {
  beta: {
    messages: {
      create(
        body: AnthropicMessageRequest,
        options?: AnthropicRequestOptionsLike,
      ): Promise<AnthropicMessageLike>;
    };
  };
}

export interface AnthropicClientOptionsLike {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
}

/** Le module du SDK, tel que chargé par import dynamique. */
export interface AnthropicSdkModule {
  default: new (options?: AnthropicClientOptionsLike) => AnthropicClientLike;
}

/** Le chargement du SDK : dynamique, et seulement au premier besoin. */
export async function loadAnthropicSdk(): Promise<AnthropicSdkModule> {
  // Un spécificateur calculé : ni le compilateur ni le bundler ne rendent le SDK obligatoire.
  const specifier = ['@anthropic-ai', 'sdk'].join('/');
  const module = (await import(specifier)) as Partial<AnthropicSdkModule>;
  if (typeof module.default !== 'function') throw new Error('@anthropic-ai/sdk: Anthropic client not found');
  return module as AnthropicSdkModule;
}
