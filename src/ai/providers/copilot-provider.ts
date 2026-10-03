import { CopilotClientManager, type CopilotClientManagerOptions } from '../copilot/client-manager.js';
import { buildUserPrompt, extractJson } from '../copilot/prompt-builder.js';
import type { CopilotSessionLike } from '../copilot/sdk.js';
import { createAdvisorSessionConfig } from '../copilot/session-factory.js';
import { CopilotToolRegistry } from '../copilot/tool-registry.js';
import {
  INTELLIGENCE_PROPOSAL_JSON_SCHEMA,
  type IntelligenceRequest,
  type IntelligenceToolContext,
  type ProviderCallOptions,
  type ProviderResult,
} from '../model.js';
import type { IntelligenceProvider } from '../provider.js';

export interface CopilotProviderOptions extends CopilotClientManagerOptions {
  /** `auto`, ou un modèle validé avec la liste officielle du SDK. */
  model: string;
  sessionReuse: boolean;
  /** Outils de lecture exposés au modèle (désactivables). */
  tools: boolean;
  timeoutMs: number;
  /** Nettoyage des résultats d'outils (le même que pour les requêtes). */
  sanitize: (value: unknown) => unknown;
  /** Un client déjà construit (tests). */
  manager?: CopilotClientManager;
}

/**
 * COPILOT INTELLIGENCE PROVIDER : GitHub Copilot comme CONSEILLER de raisonnement, par le SDK
 * officiel (`@github/copilot-sdk`). Il reçoit une requête structurée et nettoyée, peut lire
 * l'état au travers d'outils de lecture, et rend une proposition structurée (sortie au schéma
 * JSON). Il n'a aucun moyen d'agir : ni Playwright, ni shell, ni fichiers.
 */
export class CopilotIntelligenceProvider implements IntelligenceProvider {
  readonly id = 'copilot';
  private readonly manager: CopilotClientManager;
  private readonly registry: CopilotToolRegistry | undefined;
  private current: IntelligenceToolContext | undefined;
  private toolCalls = 0;
  private toolLimit = 0;
  private reason: string | undefined;
  private effort: string | undefined;
  private structuredOutput = true;
  model: string | undefined;

  constructor(private readonly options: CopilotProviderOptions) {
    this.manager = options.manager ?? new CopilotClientManager(options);
    this.registry = options.tools
      ? new CopilotToolRegistry({
          current: () => this.current,
          sanitize: options.sanitize,
          allow: () => {
            if (this.toolCalls >= this.toolLimit) return false;
            this.toolCalls += 1;
            return true;
          },
        })
      : undefined;
  }

  /** Combien de clients ont été créés (0 tant qu'aucune requête n'a eu lieu). */
  get clientsCreated(): number {
    return this.manager.clientsCreated;
  }

  unavailableReason(): string | undefined {
    return this.reason ?? this.manager.unavailableReason;
  }

  async isAvailable(): Promise<boolean> {
    if (!(await this.manager.isAvailable())) return false;
    if (this.options.model !== 'auto') {
      const models = await this.manager.listModels();
      if (models.length > 0 && !models.some((model) => model.id === this.options.model)) {
        this.reason = `model "${this.options.model}" is not available to this account (available: ${models
          .slice(0, 8)
          .map((model) => model.id)
          .join(', ')})`;
        return false;
      }
    }
    this.model = this.options.model;
    return true;
  }

  async analyze(request: IntelligenceRequest, options: ProviderCallOptions): Promise<ProviderResult> {
    this.current = options.tools;
    this.toolCalls = 0;
    this.toolLimit = options.tools ? options.maxToolCalls : 0;
    const effort = await this.supportedEffort(options.reasoningEffort);
    const { session, created } = await this.manager.sessionFor(
      createAdvisorSessionConfig({
        model: this.options.model,
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(this.registry ? { registry: this.registry } : {}),
        toolBudgetLeft: () => this.toolCalls < this.toolLimit,
      }),
      this.options.sessionReuse,
    );
    if (!created && effort && effort !== this.effort)
      await session.setModel?.(this.options.model, { reasoningEffort: effort }).catch(() => undefined);
    this.effort = effort;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let model: string | undefined;
    const unsubscribe = session.on?.('assistant.usage', (event) => {
      const data = event.data ?? {};
      if (typeof data.inputTokens === 'number') usage.inputTokens += data.inputTokens;
      if (typeof data.outputTokens === 'number') usage.outputTokens += data.outputTokens;
      if (typeof data.model === 'string') model = data.model;
    });
    const onAbort = () => {
      void session.abort?.().catch(() => undefined);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const content = await this.send(session, request);
      if (model) this.model = model;
      return {
        raw: extractJson(content),
        ...(model ? { model } : this.model ? { model: this.model } : {}),
        toolCalls: this.toolCalls,
        ...(usage.inputTokens + usage.outputTokens > 0 ? { usage } : {}),
      };
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
      this.current = undefined;
      if (!this.options.sessionReuse) await this.manager.release(session);
    }
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  /** La sortie structurée (schéma JSON) si le runtime la permet ; sinon le schéma dans le message. */
  private async send(session: CopilotSessionLike, request: IntelligenceRequest): Promise<string> {
    const prompt = buildUserPrompt(request);
    if (this.structuredOutput)
      try {
        const message = await session.sendAndWait(
          { prompt, responseSchema: INTELLIGENCE_PROPOSAL_JSON_SCHEMA },
          this.options.timeoutMs,
        );
        return message?.data.content ?? '';
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!/response.?(format|schema)|structured/i.test(text)) throw error;
        this.structuredOutput = false;
      }
    const message = await session.sendAndWait(
      {
        prompt: `${prompt}\nJSON schema of the answer: ${JSON.stringify(INTELLIGENCE_PROPOSAL_JSON_SCHEMA)}`,
      },
      this.options.timeoutMs,
    );
    return message?.data.content ?? '';
  }

  /** Un niveau d'effort n'est demandé que si le modèle le déclare (jamais supposé). */
  private async supportedEffort(requested: string | undefined): Promise<string | undefined> {
    if (!requested || this.options.model === 'auto') return undefined;
    const models = await this.manager.listModels().catch(() => []);
    const info = models.find((model) => model.id === this.options.model);
    return info?.supportedReasoningEfforts?.includes(requested) ? requested : undefined;
  }
}
