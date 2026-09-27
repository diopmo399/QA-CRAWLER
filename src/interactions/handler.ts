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

/** Ce que renvoie un handler ; le gestionnaire le complète en BrowserInteractionResult. */
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

/** Tout ce qu'un handler peut utiliser. Les handlers ne voient jamais le moteur d'exploration. */
export interface HandlerContext {
  /** Décision de la politique de sécurité pour cette interaction (toujours ALLOW quand le handler est appelé). */
  decision: InteractionDecision;
  credentials: CredentialProvider;
  /** 1 pour le premier essai ; incrémenté quand le navigateur relève la même interaction. */
  attempt: number;
  maxAttempts: number;
  crawl: InteractionContext;
}

/**
 * Stratégie pour un ou plusieurs genres d'interaction du navigateur. Enregistrer un
 * nouveau handler suffit à prendre en charge une nouvelle interaction : le moteur
 * d'exploration ne change pas.
 */
export interface BrowserInteractionHandler {
  readonly name: string;
  readonly handles: readonly BrowserInteractionType[];
  handle(interaction: BrowserInteraction, context: HandlerContext): Promise<HandlerOutcome>;
}
