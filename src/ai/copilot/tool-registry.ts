import type { IntelligenceToolContext } from '../model.js';
import type { CopilotToolDefinition } from './sdk.js';

/** Un outil de LECTURE : il interroge les services existants, ne modifie rien. */
export interface ReadOnlyTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  read(context: IntelligenceToolContext, args: Record<string, unknown>): unknown;
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

/**
 * Le nom d'un outil qui EXÉCUTERAIT quelque chose : refusé à l'enregistrement (§82). Un ajout
 * futur ne peut pas transformer le conseiller en exécuteur par accident.
 */
const EXECUTION_VERB =
  /(^|_)(click|fill|type|press|submit|delete|remove|goto|navigate|open_url|execute|eval|run|shell|bash|write|edit|create|update|upload|send|post|put|patch|set)(_|$)/i;

export const READ_ONLY_TOOLS: readonly ReadOnlyTool[] = [
  {
    name: 'get_current_goal',
    description: 'The current functional goal and its conditions.',
    parameters: NO_ARGS,
    read: (context) => context.currentGoal(),
  },
  {
    name: 'get_business_state',
    description: 'The business state of the current screen (phase, facts, missing conditions, submission).',
    parameters: NO_ARGS,
    read: (context) => context.businessState(),
  },
  {
    name: 'get_available_actions',
    description: 'The actions QA-Crawler discovered on the screen, with their IDs and safety classification.',
    parameters: NO_ARGS,
    read: (context) => context.availableActions(),
  },
  {
    name: 'get_action_details',
    description: 'Details of one discovered action by its ID (A1, A2, ...).',
    parameters: {
      type: 'object',
      properties: { actionId: { type: 'string', pattern: '^A\\d{1,4}$' } },
      required: ['actionId'],
      additionalProperties: false,
    },
    read: (context, args) => context.actionDetails(typeof args.actionId === 'string' ? args.actionId : ''),
  },
  {
    name: 'get_relevant_evidence',
    description: 'Evidence (runtime, recording, static, contract, history) related to a short query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 120 } },
      required: ['query'],
      additionalProperties: false,
    },
    read: (context, args) =>
      context.relevantEvidence(typeof args.query === 'string' ? args.query.slice(0, 120) : ''),
  },
  {
    name: 'get_hypotheses',
    description: 'Current hypotheses with their status and confidence.',
    parameters: NO_ARGS,
    read: (context) => context.hypotheses(),
  },
  {
    name: 'get_contradictions',
    description: 'Open contradictions between knowledge sources.',
    parameters: NO_ARGS,
    read: (context) => context.contradictions(),
  },
  {
    name: 'get_functional_coverage',
    description: 'Functional coverage gaps already computed by QA-Crawler.',
    parameters: NO_ARGS,
    read: (context) => context.functionalCoverage(),
  },
  {
    name: 'get_previous_actions',
    description: 'The workflow steps already performed.',
    parameters: NO_ARGS,
    read: (context) => context.previousActions(),
  },
  {
    name: 'get_next_actions',
    description: 'The workflow steps expected next.',
    parameters: NO_ARGS,
    read: (context) => context.nextActions(),
  },
];

export interface ToolRegistryOptions {
  /** Le contexte de la requête EN COURS (les outils lisent toujours l'état présent). */
  current: () => IntelligenceToolContext | undefined;
  /** Chaque résultat est nettoyé avant de partir. */
  sanitize: (value: unknown) => unknown;
  /** Compte et borne les appels d'outils de la requête en cours. */
  allow: (name: string) => boolean;
  tools?: readonly ReadOnlyTool[];
}

/**
 * COPILOT TOOL REGISTRY (§47–§51) : seulement des outils de lecture, au résultat nettoyé et
 * borné par requête. Aucune deuxième représentation des connaissances : chaque outil lit les
 * services existants au travers du contexte de la requête.
 */
export class CopilotToolRegistry {
  readonly tools: readonly ReadOnlyTool[];

  constructor(private readonly options: ToolRegistryOptions) {
    const tools = options.tools ?? READ_ONLY_TOOLS;
    for (const tool of tools)
      if (EXECUTION_VERB.test(tool.name))
        throw new Error(`refusing to register "${tool.name}": the advisor only gets read-only tools`);
    this.tools = tools;
  }

  names(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  isRegistered(name: string): boolean {
    return this.tools.some((tool) => tool.name === name);
  }

  definitions(): CopilotToolDefinition[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      defer: 'never' as const,
      handler: (args: unknown) => {
        if (!this.options.allow(tool.name))
          return 'tool budget exhausted for this request: answer with what you have';
        const context = this.options.current();
        if (!context) return 'no current request';
        const input = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
        return this.options.sanitize(tool.read(context, input));
      },
    }));
  }
}
