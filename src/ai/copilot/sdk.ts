import type { SdkModelInfo } from '../models/capability-resolver.js';

/**
 * Ce que QA-Crawler utilise de `@github/copilot-sdk`, décrit STRUCTURELLEMENT : le cœur ne
 * dépend jamais des types du SDK (dépendance optionnelle, chargée dynamiquement dans ce seul
 * module), et les tests peuvent fournir un faux SDK.
 */

export interface CopilotToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler?: (args: unknown, invocation: unknown) => unknown;
  skipPermission?: boolean;
  defer?: 'auto' | 'never';
}

export interface CopilotPermissionRequest {
  kind: string;
  toolName?: string;
}

export type CopilotPermissionResult = { kind: 'approve-once' } | { kind: 'reject'; feedback?: string };

export interface CopilotPreToolUseInput {
  toolName: string;
  toolArgs?: unknown;
}

export interface CopilotSessionConfig {
  model?: string;
  reasoningEffort?: string;
  /** Préférence du routage AUTO officiel (model: "auto"). */
  capi?: { autoTier?: string };
  tools?: CopilotToolDefinition[];
  availableTools?: string[];
  excludedTools?: string[];
  systemMessage?: { mode: 'replace'; content: string };
  onPermissionRequest?: (request: CopilotPermissionRequest, invocation: unknown) => CopilotPermissionResult;
  hooks?: {
    onPreToolUse?: (
      input: CopilotPreToolUseInput,
      invocation: unknown,
    ) => Promise<{ permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string }>;
  };
  enableConfigDiscovery?: boolean;
  skipCustomInstructions?: boolean;
  enableSessionStore?: boolean;
  infiniteSessions?: { enabled: boolean };
}

export interface CopilotAssistantMessage {
  data: { content?: string };
}

export interface CopilotSessionLike {
  readonly sessionId: string;
  sendAndWait(
    options: { prompt: string; responseSchema?: Record<string, unknown> },
    timeout?: number,
  ): Promise<CopilotAssistantMessage | undefined>;
  abort?(): Promise<void>;
  setModel?(model: string, options?: { reasoningEffort?: string; autoTier?: string | null }): Promise<void>;
  on?(eventType: string, handler: (event: { data?: Record<string, unknown> }) => void): () => void;
  disconnect(): Promise<void>;
}

/** `ModelInfo` du SDK (id, nom, capacités, politique, facturation, efforts déclarés). */
export type CopilotModelInfo = SdkModelInfo;

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  /** Arrêt immédiat (processus du runtime tué) : quand `stop()` ne rend pas la main. */
  forceStop?(): Promise<void>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  listModels(): Promise<CopilotModelInfo[]>;
  createSession(config: CopilotSessionConfig): Promise<CopilotSessionLike>;
}

export interface CopilotClientOptionsLike {
  mode?: 'empty' | 'copilot-cli';
  baseDirectory?: string;
  logLevel?: 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all';
  gitHubToken?: string;
  useLoggedInUser?: boolean;
}

/** Le module du SDK, tel que chargé par import dynamique. */
export interface CopilotSdkModule {
  CopilotClient: new (options?: CopilotClientOptionsLike) => CopilotClientLike;
}

/** Le chargement du SDK : dynamique, et seulement au premier besoin. */
export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  // Un spécificateur calculé : ni le compilateur ni le bundler ne rendent le SDK obligatoire.
  const specifier = ['@github', 'copilot-sdk'].join('/');
  const module = (await import(specifier)) as Partial<CopilotSdkModule>;
  if (typeof module.CopilotClient !== 'function')
    throw new Error('@github/copilot-sdk: CopilotClient not found');
  return module as CopilotSdkModule;
}
