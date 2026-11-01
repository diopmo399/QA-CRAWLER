import { AI_AGENTS } from '../../src/sdk/core/incident-ai-contracts.js';
import {
  ModelResponseError,
  ModelNotAvailableError,
  type InvestigationModelClient,
  type ModelCallOptions,
  type ModelCompletionInput,
  type ModelToolCall,
  type ModelTurn,
  type ModelUsage,
} from '../../src/incident/ai/model-client.js';

/**
 * UN CLIENT DE MODÈLE SCRIPTÉ, pour tous les tests de l'investigation IA : aucun réseau, aucun SDK.
 *
 * Les tours sont donnés par CLÉ D'AGENT : la clé est cherchée dans le message système de chaque
 * `complete()` — d'abord un marqueur explicite (« Agent: PLANNER », « agent=FRONTEND », « [agent:BFF] »),
 * sinon le premier nom d'agent (AI_AGENTS) qui apparaît dans le système, sinon la clé `*` (script par
 * défaut). Un script épuisé rend `fallback` (par défaut : une réponse finale `{}`), ou lève s'il n'y en a
 * pas. Chaque entrée reçue est enregistrée (`calls`) pour les assertions ; un tour peut attendre
 * (`delayMs`, annulable par le signal), lever (`throw`), rendre un texte non JSON (`invalid`) ou être
 * calculé (`fn(input, index)`).
 */
export type ScriptedStep =
  | {
      kind: 'tool_calls';
      calls: (Omit<ModelToolCall, 'id'> & { id?: string })[];
      usage?: Partial<ModelUsage>;
      delayMs?: number;
    }
  | {
      kind: 'final';
      raw: unknown;
      usage?: Partial<ModelUsage>;
      stopReason?: 'end' | 'max_tokens' | 'refusal' | 'other';
      delayMs?: number;
    }
  /** Le modèle rend un texte qui n'est pas du JSON (ou un JSON qui ne respecte pas le schéma). */
  | { kind: 'invalid'; text: string; usage?: Partial<ModelUsage>; delayMs?: number }
  | { kind: 'throw'; error: Error; delayMs?: number }
  | ((input: ModelCompletionInput, index: number) => ModelTurn | Promise<ModelTurn>);

export interface ScriptedCall {
  /** Numéro d'ordre (1…) parmi tous les appels. */
  index: number;
  key: string;
  input: ModelCompletionInput;
  timeoutMs: number;
  at: number;
}

export interface ScriptedModelClientOptions {
  id?: string;
  model?: string;
  /** Faux : `isAvailable()` rend faux et `complete()` lève ModelNotAvailableError. */
  available?: boolean;
  unavailableReason?: string;
  /** Les tours par clé d'agent ; un tableau seul vaut pour la clé `*`. */
  turns?: Record<string, ScriptedStep[]> | ScriptedStep[];
  /** Ce qu'un script épuisé rend ; absent : une réponse finale `{}`. `null` : lever ModelResponseError. */
  fallback?: ScriptedStep | null;
  /** Attente avant chaque tour (annulable par le signal). */
  delayMs?: number;
  /** Comment trouver la clé d'un appel (par défaut : marqueur, puis nom d'agent, puis `*`). */
  keyOf?: (input: ModelCompletionInput) => string | undefined;
  usage?: Partial<ModelUsage>;
}

export const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

export const usageOf = (
  partial: Partial<ModelUsage> | undefined,
  fallback: Partial<ModelUsage> = {},
): ModelUsage => ({
  ...NO_USAGE,
  ...fallback,
  ...partial,
});

/** Un tour d'appels d'outils (les ids manquants sont numérotés `call-N`). */
export const toolCallsTurn = (
  calls: (Omit<ModelToolCall, 'id'> & { id?: string })[],
  usage?: Partial<ModelUsage>,
): ScriptedStep => ({ kind: 'tool_calls', calls, ...(usage ? { usage } : {}) });

/** Une réponse finale (objet déjà structuré ou texte contenant du JSON). */
export const finalTurn = (raw: unknown, usage?: Partial<ModelUsage>): ScriptedStep => ({
  kind: 'final',
  raw,
  ...(usage ? { usage } : {}),
});

export const invalidTurn = (text = 'Sorry, I cannot answer in JSON.'): ScriptedStep => ({
  kind: 'invalid',
  text,
});
export const throwingTurn = (error: Error): ScriptedStep => ({ kind: 'throw', error });

const MARKER = /\[?\bagent\s*[:=]\s*«?\s*([A-Z][A-Z_]+)\b/i;

/** La clé d'agent d'un appel : marqueur explicite, sinon le premier nom d'agent cité dans le système. */
export function agentKeyOf(input: ModelCompletionInput): string | undefined {
  const marker = MARKER.exec(input.system);
  if (marker?.[1]) return marker[1].toUpperCase();
  let best: { name: string; at: number } | undefined;
  for (const name of AI_AGENTS) {
    const at = new RegExp(`\\b${name}\\b`).exec(input.system)?.index;
    if (at !== undefined && (best === undefined || at < best.at)) best = { name, at };
  }
  return best?.name;
}

class AbortedError extends Error {
  override readonly name = 'AbortError';
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError('Appel annulé.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError('Appel annulé.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ScriptedModelClient implements InvestigationModelClient {
  readonly id: string;
  readonly model: string;
  readonly calls: ScriptedCall[] = [];
  closed = false;
  availabilityChecks = 0;
  private readonly scripts = new Map<string, ScriptedStep[]>();
  private readonly cursors = new Map<string, number>();
  private counter = 0;

  constructor(private readonly options: ScriptedModelClientOptions = {}) {
    this.id = options.id ?? 'scripted';
    this.model = options.model ?? 'scripted-model';
    const turns = options.turns ?? [];
    if (Array.isArray(turns)) this.scripts.set('*', [...turns]);
    else for (const [key, steps] of Object.entries(turns)) this.scripts.set(key.toUpperCase(), [...steps]);
  }

  /** Ajoute des tours à une clé (après construction). */
  script(key: string, steps: ScriptedStep[]): this {
    const upper = key.toUpperCase();
    this.scripts.set(upper, [...(this.scripts.get(upper) ?? []), ...steps]);
    return this;
  }

  /** Les tours restants d'une clé. */
  remaining(key = '*'): number {
    const upper = key.toUpperCase();
    return (this.scripts.get(upper)?.length ?? 0) - (this.cursors.get(upper) ?? 0);
  }

  /** Les entrées reçues pour une clé d'agent. */
  callsFor(key: string): ScriptedCall[] {
    const upper = key.toUpperCase();
    const found: ScriptedCall[] = [];
    for (const call of this.calls) if (call.key === upper) found.push(call);
    return found;
  }

  isAvailable(): Promise<boolean> {
    this.availabilityChecks += 1;
    return Promise.resolve(this.options.available ?? true);
  }

  unavailableReason(): string | undefined {
    return this.options.available === false
      ? (this.options.unavailableReason ?? 'scripted client offline')
      : undefined;
  }

  async complete(input: ModelCompletionInput, options: ModelCallOptions): Promise<ModelTurn> {
    if (this.options.available === false)
      throw new ModelNotAvailableError(this.unavailableReason() ?? 'unavailable');
    this.counter += 1;
    const key = (this.options.keyOf ?? agentKeyOf)(input)?.toUpperCase() ?? '*';
    const resolved = this.scripts.has(key) ? key : '*';
    this.calls.push({
      index: this.counter,
      key: resolved,
      input,
      timeoutMs: options.timeoutMs,
      at: Date.now(),
    });
    const step = this.next(resolved);
    if (this.options.delayMs !== undefined) await wait(this.options.delayMs, options.signal);
    if (typeof step === 'function') return step(input, this.counter);
    if (step.delayMs !== undefined) await wait(step.delayMs, options.signal);
    if (options.signal.aborted) throw new AbortedError('Appel annulé.');
    switch (step.kind) {
      case 'throw':
        throw step.error;
      case 'tool_calls':
        return {
          kind: 'tool_calls',
          calls: step.calls.map((call, index) => ({
            id: call.id ?? `call-${this.counter}-${index + 1}`,
            name: call.name,
            input: call.input,
          })),
          usage: usageOf(step.usage, this.options.usage),
        };
      case 'invalid':
        return {
          kind: 'final',
          raw: step.text,
          usage: usageOf(step.usage, this.options.usage),
          stopReason: 'end',
        };
      case 'final':
        return {
          kind: 'final',
          raw: step.raw,
          usage: usageOf(step.usage, this.options.usage),
          stopReason: step.stopReason ?? 'end',
        };
    }
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private next(key: string): ScriptedStep {
    const steps = this.scripts.get(key) ?? [];
    const cursor = this.cursors.get(key) ?? 0;
    const step = steps[cursor];
    if (step !== undefined) {
      this.cursors.set(key, cursor + 1);
      return step;
    }
    if (this.options.fallback === null) throw new ModelResponseError(`Script épuisé pour « ${key} ».`);
    return this.options.fallback ?? finalTurn({});
  }
}

export function scriptedModelClient(options: ScriptedModelClientOptions = {}): ScriptedModelClient {
  return new ScriptedModelClient(options);
}
