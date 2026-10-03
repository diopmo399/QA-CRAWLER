import { QA_ADVISOR_SYSTEM_PROMPT } from './prompt-builder.js';
import type { CopilotPermissionRequest, CopilotPermissionResult, CopilotSessionConfig } from './sdk.js';
import type { CopilotToolRegistry } from './tool-registry.js';

export interface SessionFactoryOptions {
  model: string;
  reasoningEffort?: string;
  registry?: CopilotToolRegistry;
  /** Compte un appel d'outil (audit, budget). */
  onToolUse?: (name: string, allowed: boolean) => void;
  /** Le budget d'outils de la requête en cours est-il épuisé ? */
  toolBudgetLeft?: () => boolean;
}

/**
 * COPILOT SESSION FACTORY (§52) : une session spécialisée QA-Crawler.
 *
 * Défense en profondeur (§82), en plus du mode `empty` du client :
 *   1. `availableTools` : seuls les outils de lecture enregistrés existent pour le modèle ;
 *   2. `excludedTools` : tous les outils intégrés et MCP sont exclus ;
 *   3. `onPermissionRequest` : seul un outil personnalisé enregistré est approuvé, une fois ;
 *      shell, écriture, lecture de fichiers, URL, mémoire… sont refusés ;
 *   4. `onPreToolUse` : le même contrôle, et le budget d'outils par requête.
 * Ces contrôles ne dupliquent pas la SafetyPolicy : ils protègent le PROCESSUS, la SafetyPolicy
 * protège l'APPLICATION testée (et seule elle juge les actions proposées).
 */
export function createAdvisorSessionConfig(options: SessionFactoryOptions): CopilotSessionConfig {
  const registry = options.registry;
  const names = registry?.names() ?? [];
  const permitted = (name: string | undefined): boolean => name !== undefined && names.includes(name);
  return {
    model: options.model,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    systemMessage: { mode: 'replace', content: QA_ADVISOR_SYSTEM_PROMPT },
    tools: registry?.definitions() ?? [],
    availableTools: names.map((name) => `custom:${name}`),
    excludedTools: ['builtin:*', 'mcp:*'],
    onPermissionRequest: (request: CopilotPermissionRequest): CopilotPermissionResult => {
      const allowed = request.kind === 'custom-tool' && permitted(request.toolName);
      options.onToolUse?.(request.toolName ?? request.kind, allowed);
      return allowed
        ? { kind: 'approve-once' }
        : { kind: 'reject', feedback: 'The QA-Crawler advisor has read-only tools only.' };
    },
    hooks: {
      onPreToolUse: (input) => {
        if (!permitted(input.toolName))
          return Promise.resolve({
            permissionDecision: 'deny',
            permissionDecisionReason: 'not a registered read-only tool',
          });
        if (options.toolBudgetLeft && !options.toolBudgetLeft())
          return Promise.resolve({
            permissionDecision: 'deny',
            permissionDecisionReason: 'tool budget exhausted for this request',
          });
        return Promise.resolve({ permissionDecision: 'allow' });
      },
    },
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableSessionStore: false,
    infiniteSessions: { enabled: false },
  };
}
