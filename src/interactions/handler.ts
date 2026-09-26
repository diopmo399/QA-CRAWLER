import type { InteractionDecision } from '../policies/interaction-policy.js';
import type { CredentialProvider } from './credential-provider.js';
import type {
  BrowserInteraction,
  BrowserInteractionType,
  InteractionContext,
  InteractionDetails,
  InteractionOutcome,
  InteractionStatus,
  OriginClass,
} from './types.js';

/** What a handler returns; the manager completes it into a BrowserInteractionResult. */
export interface HandlerOutcome {
  status: InteractionStatus;
  outcome?: InteractionOutcome;
  action?: string;
  success: boolean;
  reason?: string;
  targetUrl?: string;
  targetStateId?: string;
  originClass?: OriginClass;
  credentialProfile?: string;
  blocking?: boolean;
  details?: InteractionDetails;
}

/** Everything a handler may use. Handlers never see the crawl engine. */
export interface HandlerContext {
  /** Decision of the safety policy for this interaction (always ALLOW when the handler is called). */
  decision: InteractionDecision;
  credentials: CredentialProvider;
  /** 1 for the first try; incremented when the browser raises the same interaction again. */
  attempt: number;
  maxAttempts: number;
  crawl: InteractionContext;
}

/**
 * Strategy for one or more kinds of browser interaction. Registering a new
 * handler is enough to support a new interaction: the crawl engine does not
 * change.
 */
export interface BrowserInteractionHandler {
  readonly name: string;
  readonly handles: readonly BrowserInteractionType[];
  handle(interaction: BrowserInteraction, context: HandlerContext): Promise<HandlerOutcome>;
}
