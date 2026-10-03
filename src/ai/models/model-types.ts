/**
 * COPILOT MODEL MANAGEMENT — le modèle interne, indépendant du SDK.
 *
 * Le reste de QA-Crawler ne connaît jamais un nom de modèle : il demande un PROFIL (FAST,
 * BALANCED, INTELLIGENCE) ; la politique de sélection choisit parmi les modèles RÉELLEMENT
 * découverts. Aucune capacité n'est supposée : une capacité absente vaut « inconnue ».
 */

export const MODEL_SELECTION_MODES = ['AUTO', 'EXPLICIT', 'ADAPTIVE'] as const;
export type ModelSelectionMode = (typeof MODEL_SELECTION_MODES)[number];

export const MODEL_PROFILES = ['FAST', 'BALANCED', 'INTELLIGENCE'] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];

export const COMPLEXITY_LEVELS = ['TRIVIAL', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

/** Niveaux internes ; traduits vers ceux du SDK (low, medium, high) seulement s'ils sont déclarés. */
export const REASONING_EFFORTS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORTS)[number];
export type ReasoningEffortSetting = ReasoningEffortLevel | 'AUTO';

/** Les préférences du routage AUTO officiel (`capi.autoTier`). */
export type AutoTier = 'efficiency' | 'balance' | 'intelligence' | 'fast';

/**
 * Ce que l'on SAIT d'un modèle. Seules les propriétés exposées par le SDK sont renseignées ;
 * `tools` et `structuredOutput` ne le sont pas par la version installée : elles restent
 * `undefined` (inconnues), jamais supposées vraies ou fausses.
 */
export interface ModelCapabilities {
  reasoning?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  tools?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  maxContextTokens?: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
}

export type ModelUnavailability = 'MODEL_NOT_AUTHORIZED' | 'MODEL_POLICY_UNCONFIGURED';

export interface AvailableModel {
  id: string;
  name?: string;
  capabilities: ModelCapabilities;
  /** Utilisable par le compte courant (politique « enabled », ou sans politique déclarée). */
  available: boolean;
  unavailableReason?: ModelUnavailability;
  /** Multiplicateur de coût déclaré par le SDK (observation, jamais un classement). */
  billingMultiplier?: number;
}

export interface RequiredCapabilities {
  tools?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  /** Taille estimée du contexte nécessaire (jetons). */
  minContextTokens?: number;
}

export const FALLBACK_REASONS = [
  'MODEL_NOT_AVAILABLE',
  'MODEL_NOT_AUTHORIZED',
  'MODEL_CAPABILITY_MISMATCH',
  'MODEL_SESSION_CREATION_FAILED',
  'REASONING_EFFORT_UNSUPPORTED',
  'MODEL_TEMPORARILY_UNAVAILABLE',
  'MODEL_DISCOVERY_FAILED',
] as const;
export type ModelFallbackReason = (typeof FALLBACK_REASONS)[number];

export interface ModelSelectionDecision {
  status: 'SELECTED' | 'NO_LLM_REQUIRED' | 'NO_MODEL';
  mode: ModelSelectionMode;
  complexity: ComplexityLevel;
  /** Demandé par la configuration, la CLI ou la politique. */
  requestedModel?: string;
  /** Choisi par la politique (`auto` = le routage officiel de Copilot). */
  selectedModel?: string;
  autoTier?: AutoTier;
  profile?: ModelProfile;
  requestedReasoningEffort?: ReasoningEffortLevel;
  /** Ce qui sera réellement envoyé au SDK (absent : rien n'est envoyé). */
  reasoningEffort?: ReasoningEffortLevel;
  alternatives: string[];
  reasons: string[];
  confidence: number;
  fallback?: { reason: ModelFallbackReason; from?: string; to?: string };
}

/** Le contexte d'exécution d'un appel, tel qu'il reste dans l'audit (§44). */
export interface ModelExecutionContext {
  selectionMode: ModelSelectionMode;
  complexity: ComplexityLevel;
  complexityReasons: string[];
  profile?: ModelProfile;
  requestedModel?: string;
  selectedModel?: string;
  autoTier?: AutoTier;
  /** Le modèle qui a RÉELLEMENT servi l'appel (événement `assistant.usage`), jamais déduit. */
  effectiveModel?: string;
  requestedReasoningEffort?: ReasoningEffortLevel;
  /** Le niveau réellement ENVOYÉ au SDK (absent : rien n'a été envoyé). */
  sentReasoningEffort?: ReasoningEffortLevel;
  /** Le niveau rapporté par le runtime (événement `assistant.usage`), s'il l'a été. */
  effectiveReasoningEffort?: ReasoningEffortLevel;
  fallbackApplied: boolean;
  fallbackReason?: ModelFallbackReason;
  reasons: string[];
}

/** Un modèle indisponible, sans repli permis : l'appel n'a pas lieu (repli déterministe). */
export class ModelUnavailableError extends Error {
  constructor(
    readonly reason: ModelFallbackReason,
    readonly context: ModelExecutionContext,
  ) {
    super(`no usable model: ${reason}`);
    this.name = 'ModelUnavailableError';
  }
}
