import type { SdkModelInfo } from '../../src/ai/models/capability-resolver.js';
import type {
  CopilotClientLike,
  CopilotClientOptionsLike,
  CopilotSdkModule,
  CopilotSessionConfig,
  CopilotSessionLike,
} from '../../src/ai/copilot/sdk.js';

export type Responder = (prompt: string, session: FakeSession) => Promise<string> | string;

export interface FakeSdkOptions {
  authenticated?: boolean;
  /** Ce que listModels() rend (forme du ModelInfo du SDK). */
  models?: SdkModelInfo[] | (() => SdkModelInfo[]);
  /** listModels() échoue. */
  discoveryFails?: boolean;
  /** createSession() refuse ces modèles (comme un runtime qui refuse un modèle). */
  rejectSessionModels?: string[];
  /** Le modèle rapporté par `assistant.usage` ; null : aucun événement d'usage (rien d'observable). */
  usageModel?: (config: CopilotSessionConfig) => string | null;
}

/**
 * Un FAUX SDK GitHub Copilot, conforme à la forme du SDK installé (@github/copilot-sdk 1.0.16) :
 * CopilotClient (start, stop, getAuthStatus, listModels, createSession), session (sendAndWait,
 * on('assistant.usage'), setModel, disconnect). Aucun réseau : les tests restent déterministes.
 */
export class FakeSession implements CopilotSessionLike {
  readonly sessionId = `s-${String(Math.random()).slice(2, 8)}`;
  readonly prompts: string[] = [];
  readonly schemas: (Record<string, unknown> | undefined)[] = [];
  readonly modelChanges: { model: string; reasoningEffort?: string; autoTier?: string | null }[] = [];
  private usage: ((event: { data?: Record<string, unknown> }) => void) | undefined;
  disconnected = false;

  constructor(
    public config: CopilotSessionConfig,
    private readonly respond: Responder,
    private readonly usageModel: FakeSdkOptions['usageModel'],
  ) {}

  async sendAndWait(options: { prompt: string; responseSchema?: Record<string, unknown> }) {
    this.prompts.push(options.prompt);
    this.schemas.push(options.responseSchema);
    const content = await this.respond(options.prompt, this);
    const model = this.usageModel ? this.usageModel(this.config) : 'fake-model-1';
    if (model !== null)
      this.usage?.({
        data: {
          inputTokens: 120,
          outputTokens: 30,
          model,
          ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
        },
      });
    return { data: { content } };
  }

  on(eventType: string, handler: (event: { data?: Record<string, unknown> }) => void) {
    if (eventType === 'assistant.usage') this.usage = handler;
    return () => {
      this.usage = undefined;
    };
  }

  setModel(
    model: string,
    options: { reasoningEffort?: string; autoTier?: string | null } = {},
  ): Promise<void> {
    this.modelChanges.push({ model, ...options });
    const { capi: _previous, reasoningEffort: _effort, ...rest } = this.config;
    this.config = {
      ...rest,
      model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.autoTier ? { capi: { autoTier: options.autoTier } } : {}),
    };
    return Promise.resolve();
  }

  /** Ce que ferait le runtime : appeler un outil enregistré (après permission et hook). */
  async callTool(name: string, args: unknown = {}): Promise<unknown> {
    const permission = this.config.onPermissionRequest?.({ kind: 'custom-tool', toolName: name }, {});
    const hook = await this.config.hooks?.onPreToolUse?.({ toolName: name, toolArgs: args }, {});
    if (permission?.kind !== 'approve-once' || hook?.permissionDecision !== 'allow') return 'denied';
    const tool = this.config.tools?.find((candidate) => candidate.name === name);
    return tool?.handler?.(args, {});
  }

  disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }
}

export interface FakeSdkState {
  clients: (CopilotClientLike & { options?: CopilotClientOptionsLike; stopped: boolean })[];
  sessions: FakeSession[];
  /** Les configurations de session demandées, y compris celles refusées. */
  sessionRequests: CopilotSessionConfig[];
  loads: number;
  discoveries: number;
}

export function fakeSdk(
  respond: Responder,
  options: FakeSdkOptions = {},
): { state: FakeSdkState; load: () => Promise<CopilotSdkModule> } {
  const state: FakeSdkState = { clients: [], sessions: [], sessionRequests: [], loads: 0, discoveries: 0 };
  class FakeClient implements CopilotClientLike {
    started = false;
    stopped = false;
    constructor(readonly options?: CopilotClientOptionsLike) {
      state.clients.push(this);
    }
    start() {
      this.started = true;
      return Promise.resolve();
    }
    stop() {
      this.stopped = true;
      return Promise.resolve([]);
    }
    getAuthStatus() {
      return Promise.resolve({ isAuthenticated: options.authenticated ?? true });
    }
    listModels() {
      state.discoveries += 1;
      if (options.discoveryFails) return Promise.reject(new Error('models endpoint unavailable (503)'));
      const models =
        typeof options.models === 'function'
          ? options.models()
          : (options.models ?? [{ id: 'model-a', supportedReasoningEfforts: ['low', 'medium', 'high'] }]);
      return Promise.resolve(models);
    }
    createSession(config: CopilotSessionConfig) {
      state.sessionRequests.push(config);
      if (config.model && options.rejectSessionModels?.includes(config.model))
        return Promise.reject(new Error(`model ${config.model} is not supported for this session`));
      const session = new FakeSession(config, respond, options.usageModel);
      state.sessions.push(session);
      return Promise.resolve(session);
    }
  }
  const load = (): Promise<CopilotSdkModule> => {
    state.loads += 1;
    return Promise.resolve({ CopilotClient: FakeClient });
  };
  return { state, load };
}

/** Une réponse : choisir l'action dont le nom est donné, dans la requête reçue (le JSON du message). */
export function answerByName(name: string, confidence = 0.9): Responder {
  return (prompt) => {
    const json = prompt.split('\n').find((line) => line.startsWith('{')) ?? '{}';
    const request = JSON.parse(json) as { availableActions?: { id: string; name: string }[] };
    const action = request.availableActions?.find((candidate) => candidate.name === name);
    return JSON.stringify(
      action
        ? {
            status: 'PROPOSAL',
            selectedActionId: action.id,
            supportingEvidenceIds: [],
            uncertainties: [],
            confidence,
          }
        : {
            status: 'INCONCLUSIVE',
            supportingEvidenceIds: [],
            uncertainties: ['not on screen'],
            confidence: 0,
          },
    );
  };
}
