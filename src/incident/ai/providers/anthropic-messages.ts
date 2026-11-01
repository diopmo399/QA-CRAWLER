import type {
  AnthropicClientOptionsLike,
  AnthropicMessageRequest,
  AnthropicRequestOptionsLike,
} from '../../../ai/anthropic/sdk.js';
import { extractJson } from '../../../ai/copilot/prompt-builder.js';
import type { ModelMessage, ModelToolCall, ModelTurn, ModelUsage, ToolSpec } from '../model-client.js';

/**
 * LE SHIM STRUCTUREL DE L'API MESSAGES AVEC OUTILS, étendu pour l'investigation (le cœur ne dépend jamais des types
 * du SDK). Les formes suivent `@anthropic-ai/sdk` (resources/beta/messages) : `BetaTool` (name, description,
 * input_schema), `BetaMessageParam` (role, content : texte ou blocs), `BetaToolUseBlock` (id, name, input),
 * `BetaToolResultBlockParam` (tool_use_id, content, is_error), `BetaUsage` (input_tokens, output_tokens, cache_*),
 * `BetaStopReason` (end_turn, max_tokens, tool_use, refusal…), `BetaOutputConfig` (effort, format json_schema).
 *
 * Ce module traduit la conversation neutre (`ModelMessage[]`) en messages de l'API et la réponse en `ModelTurn` ;
 * il ne fait aucun appel réseau.
 */

export interface AnthropicToolLike {
  name: string;
  description?: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

export interface AnthropicTextBlockParamLike {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicToolUseBlockLike {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlockLike {
  type: 'tool_result';
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

/** Un bloc de contenu rendu par le modèle : texte, appel d'outil, ou autre (réflexion…), relu tel quel. */
export interface AnthropicContentBlockLike {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

export type AnthropicMessageParamLike =
  | { role: 'user'; content: string | (AnthropicTextBlockParamLike | AnthropicToolResultBlockLike)[] }
  | { role: 'assistant'; content: string | AnthropicContentBlockLike[] };

export interface AnthropicToolMessageRequest {
  model: string;
  max_tokens: number;
  system: AnthropicTextBlockParamLike[];
  messages: AnthropicMessageParamLike[];
  tools?: AnthropicToolLike[];
  tool_choice?: { type: 'auto'; disable_parallel_tool_use?: boolean };
  thinking?: { type: 'adaptive' };
  output_config?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    format?: { type: 'json_schema'; schema: Record<string, unknown> };
  };
  betas?: string[];
  fallbacks?: 'default';
}

export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface AnthropicToolMessageLike {
  model: string;
  content: AnthropicContentBlockLike[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: AnthropicUsageLike | null;
}

export interface AnthropicToolClientLike {
  beta: {
    messages: {
      create(
        body: AnthropicToolMessageRequest | AnthropicMessageRequest,
        options?: AnthropicRequestOptionsLike,
      ): Promise<AnthropicToolMessageLike>;
    };
  };
}

export interface AnthropicToolSdkModule {
  default: new (options?: AnthropicClientOptionsLike) => AnthropicToolClientLike;
}

/** Un prix par million de jetons (unités du fournisseur). */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Lecture de cache ; absent : tarif d'entrée. */
  cacheReadPerMillion?: number;
}

/** La spécification d'un outil pour l'API (le JSON Schema d'entrée est un objet). */
export function toAnthropicTool(spec: ToolSpec): AnthropicToolLike {
  const schema = spec.inputSchema;
  return {
    name: spec.name,
    description: spec.description,
    input_schema: { ...schema, type: 'object' },
  };
}

/**
 * La conversation neutre vers les messages de l'API : les appels d'outils consécutifs forment un tour assistant (avec
 * le contenu original du modèle quand il est connu, pour rendre les blocs de réflexion inchangés), les résultats
 * consécutifs un tour utilisateur de `tool_result`.
 */
export function toAnthropicMessages(
  messages: readonly ModelMessage[],
  originals: ReadonlyMap<string, AnthropicContentBlockLike[]> = new Map(),
): AnthropicMessageParamLike[] {
  const out: AnthropicMessageParamLike[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message) break;
    if (message.role === 'assistant' && message.toolCallId !== undefined) {
      const group: ModelMessage[] = [];
      while (index < messages.length) {
        const candidate = messages[index];
        if (!candidate || candidate.role !== 'assistant' || candidate.toolCallId === undefined) break;
        group.push(candidate);
        index += 1;
      }
      const first = group[0]?.toolCallId;
      const original = first !== undefined ? originals.get(first) : undefined;
      const sameTurn =
        original !== undefined &&
        group.every((entry) =>
          original.some((block) => block.type === 'tool_use' && block.id === entry.toolCallId),
        );
      out.push({
        role: 'assistant',
        content: sameTurn
          ? original
          : group.map((entry): AnthropicContentBlockLike => ({
              type: 'tool_use',
              id: entry.toolCallId ?? '',
              name: entry.toolName ?? '',
              input: parseInput(entry.content),
            })),
      });
      continue;
    }
    if (message.role === 'tool') {
      const results: AnthropicToolResultBlockLike[] = [];
      while (index < messages.length) {
        const candidate = messages[index];
        if (!candidate || candidate.role !== 'tool') break;
        results.push({
          type: 'tool_result',
          tool_use_id: candidate.toolCallId ?? '',
          content: candidate.content,
          ...(/"ok":\s*false/.test(candidate.content) ? { is_error: true } : {}),
        });
        index += 1;
      }
      out.push({ role: 'user', content: results });
      continue;
    }
    out.push(
      message.role === 'user'
        ? { role: 'user', content: message.content || '(empty)' }
        : { role: 'assistant', content: message.content || '(empty)' },
    );
    index += 1;
  }
  return mergeAdjacent(out);
}

/** Deux tours consécutifs du même rôle sont fusionnés (l'API alterne strictement user / assistant). */
function mergeAdjacent(messages: AnthropicMessageParamLike[]): AnthropicMessageParamLike[] {
  const out: AnthropicMessageParamLike[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (!last || last.role !== message.role) {
      out.push(message);
      continue;
    }
    const blocks = (entry: AnthropicMessageParamLike): AnthropicContentBlockLike[] =>
      typeof entry.content === 'string'
        ? [{ type: 'text', text: entry.content }]
        : (entry.content as AnthropicContentBlockLike[]);
    out[out.length - 1] =
      last.role === 'user'
        ? {
            role: 'user',
            content: [...blocks(last), ...blocks(message)] as (
              AnthropicTextBlockParamLike | AnthropicToolResultBlockLike
            )[],
          }
        : { role: 'assistant', content: [...blocks(last), ...blocks(message)] };
  }
  return out;
}

function parseInput(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return {};
  }
}

/** La réponse de l'API vers un tour du contrat : appels d'outils, ou réponse finale (JSON extrait du texte). */
export function turnOf(message: AnthropicToolMessageLike, usage: ModelUsage): ModelTurn {
  const calls: ModelToolCall[] = message.content
    .filter(
      (block) => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string',
    )
    .map((block) => ({ id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }));
  if (message.stop_reason === 'tool_use' && calls.length > 0) return { kind: 'tool_calls', calls, usage };
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    return {
      kind: 'final',
      raw: { refusal: `the model declined to answer${category ? ` (${category})` : ''}` },
      usage,
      stopReason: 'refusal',
    };
  }
  if (calls.length > 0) return { kind: 'tool_calls', calls, usage };
  const text = message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
  const stopReason: 'end' | 'max_tokens' | 'other' =
    message.stop_reason === 'max_tokens'
      ? 'max_tokens'
      : message.stop_reason === 'end_turn'
        ? 'end'
        : 'other';
  return {
    kind: 'final',
    raw: text ? extractJson(text) : { invalid: 'no text in the answer' },
    usage,
    stopReason,
  };
}

/** L'usage de l'API en jetons et coût (une lecture de cache compte comme entrée, au tarif de cache quand il est connu). */
export function usageOf(message: AnthropicToolMessageLike, price: ModelPrice | undefined): ModelUsage {
  const usage = message.usage ?? {};
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const inputTokens = input + cacheRead + cacheCreation;
  const estimatedCost = price
    ? ((input + cacheCreation) * price.inputPerMillion +
        cacheRead * (price.cacheReadPerMillion ?? price.inputPerMillion) +
        output * price.outputPerMillion) /
      1_000_000
    : 0;
  return {
    inputTokens,
    outputTokens: output,
    estimatedCost: Math.round(estimatedCost * 1_000_000) / 1_000_000,
  };
}

/** Le prix d'un modèle dans une grille (clé exacte, sinon préfixe le plus long). */
export function priceOf(model: string, prices: Readonly<Record<string, ModelPrice>>): ModelPrice | undefined {
  const exact = prices[model];
  if (exact) return exact;
  const prefix = Object.keys(prices)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix !== undefined ? prices[prefix] : undefined;
}
