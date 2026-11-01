/**
 * LE CLIENT DE MODÈLE DE L'INVESTIGATION IA : un contrat multi-tours avec appels d'outils et sortie structurée.
 *
 * Le fournisseur de `src/ai/` (`IntelligenceProvider.analyze`) est mono-tour et parle d'actions de rejeu : il
 * n'est pas étendu. Les adaptateurs de ce module (`providers/anthropic.ts`, `providers/copilot.ts`) réutilisent
 * ses utilitaires (chargement des SDK, schéma de sortie, extraction JSON, masquage) et exposent ce contrat.
 * Rien d'autre dans `src/incident/ai/` n'importe un SDK : la boucle ne connaît que `InvestigationModelClient`.
 */
export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  /** Pour `tool` : l'identifiant de l'appel auquel on répond. */
  toolCallId?: string;
  /** Pour `tool` : le nom de l'outil. */
  toolName?: string;
  content: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (objet) de l'entrée. */
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Coût estimé par l'adaptateur quand il connaît une grille ; 0 sinon. */
  estimatedCost: number;
}

export type ModelTurn =
  | { kind: 'tool_calls'; calls: ModelToolCall[]; usage: ModelUsage }
  | {
      kind: 'final';
      raw: unknown;
      usage: ModelUsage;
      stopReason?: 'end' | 'max_tokens' | 'refusal' | 'other';
    };

export interface ModelCompletionInput {
  /** Instructions système : règles, rôle, format ; jamais une donnée brute non délimitée. */
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  /** Quand présent, le dernier tour doit rendre un objet conforme (JSON Schema). */
  outputSchema?: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface ModelCallOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface InvestigationModelClient {
  readonly id: string;
  readonly model?: string;
  /** Disponible (installé, authentifié, joignable) ? Ne lève jamais. */
  isAvailable(): Promise<boolean>;
  /** La raison de l'indisponibilité (jamais un secret). */
  unavailableReason?(): string | undefined;
  /** Un tour : soit des appels d'outils, soit la réponse finale. Lève ModelTimeoutError, ModelNotAvailableError, ModelResponseError. */
  complete(input: ModelCompletionInput, options: ModelCallOptions): Promise<ModelTurn>;
  close?(): Promise<void>;
}

export class ModelNotAvailableError extends Error {
  override readonly name = 'ModelNotAvailableError';
}

export class ModelTimeoutError extends Error {
  override readonly name = 'ModelTimeoutError';
}

/** Le fournisseur a répondu quelque chose d'inexploitable (format, refus, dépassement). */
export class ModelResponseError extends Error {
  override readonly name = 'ModelResponseError';
}
