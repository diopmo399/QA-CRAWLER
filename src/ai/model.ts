import { z } from 'zod';
import type { ComplexityAssessment } from './models/complexity-analyzer.js';
import type { ModelExecutionContext } from './models/model-types.js';

/**
 * AI REASONING ADVISOR — le modèle.
 *
 *   COPILOT CAN THINK. QA-CRAWLER DECIDES WHAT IS VALID. SAFETY POLICY DECIDES WHAT IS ALLOWED.
 *   PLAYWRIGHT EXECUTES. RUNTIME DECIDES WHAT IS TRUE.
 *
 * Un fournisseur d'intelligence ne voit qu'une REQUÊTE structurée (jamais le DOM, jamais une
 * valeur saisie, jamais un secret) et ne rend qu'une PROPOSITION structurée, validée ensuite.
 */

export const INTELLIGENCE_MODES = ['OFF', 'ASSIST', 'HYBRID'] as const;
export type IntelligenceMode = (typeof INTELLIGENCE_MODES)[number];

export const INTELLIGENCE_TRIGGERS = [
  'AMBIGUOUS_TARGET',
  'UNKNOWN_SCREEN',
  'UNKNOWN_WORKFLOW_STATE',
  'FLOW_DIVERGENCE',
  'RECOVERY_EXHAUSTED',
  'MULTIPLE_PLAUSIBLE_PLANS',
  'UNRESOLVED_BUSINESS_INTENT',
  'UNRESOLVED_HYPOTHESIS',
  'KNOWLEDGE_CONTRADICTION',
  'UNKNOWN_BUSINESS_ERROR',
  'LOW_DECISION_CONFIDENCE',
] as const;
export type IntelligenceTriggerReason = (typeof INTELLIGENCE_TRIGGERS)[number];

/** Les déclencheurs qui méritent un raisonnement plus profond (si le modèle le permet). */
export const COMPLEX_TRIGGERS: readonly IntelligenceTriggerReason[] = [
  'FLOW_DIVERGENCE',
  'RECOVERY_EXHAUSTED',
  'KNOWLEDGE_CONTRADICTION',
  'UNKNOWN_BUSINESS_ERROR',
  'MULTIPLE_PLAUSIBLE_PLANS',
];

export type ActionSafety = 'SAFE' | 'MUTATION' | 'DANGEROUS' | 'UNKNOWN';

/** Une référence de preuve : un identifiant qui EXISTE dans l'EvidenceStore de QA-Crawler. */
export interface EvidenceReference {
  id: string;
  type: string;
}

/**
 * Une action DÉJÀ découverte par QA-Crawler, désignée par un identifiant stable (A1, A2…).
 * Le fournisseur raisonne sur ces identifiants : il ne fabrique jamais de locator.
 */
export interface IntelligenceAction {
  id: string;
  kind: 'click' | 'check' | 'select' | 'fill';
  /** TAB, BUTTON, LINK, CHECKBOX… (rôle ARIA en majuscules). */
  type: string;
  name: string;
  /** Classée par la SafetyPolicy (jamais par le fournisseur). */
  safety: ActionSafety;
  /** La SafetyPolicy l'autorise dans ce contexte. */
  allowed: boolean;
  disabled?: boolean;
  /** Score du raisonnement déterministe (0..1), s'il existe. */
  deterministicScore?: number;
}

export interface IntelligenceEvidence {
  id: string;
  type: string;
  summary: string;
}

export interface IntelligenceHypothesis {
  id: string;
  statement: string;
  status: string;
  confidence: number;
}

export interface IntelligenceContradiction {
  id: string;
  summary: string;
}

export interface IntelligenceConstraints {
  /** Seuls ces identifiants d'action peuvent être proposés. */
  allowedActionIds: string[];
  /** Rappel explicite de ce qui est interdit (le fournisseur ne peut rien exécuter). */
  forbidden: string[];
  maxPlanSteps: number;
}

export interface IntelligenceRequest {
  requestId: string;
  trigger: IntelligenceTriggerReason;
  mission?: string;
  goal?: { id: string; conditions: string[] };
  businessState?: { phase?: string; submission?: string; missing: string[]; facts: string[] };
  functionalState?: string;
  workflowContext?: { previous: string[]; next: string[]; requiredFields: string[]; intent?: string };
  currentPlan?: { steps: string[]; confidence: number };
  /** Ce que le raisonnement déterministe a conclu (pour comparer, jamais pour imposer). */
  deterministic?: { selectedActionId?: string; confidence: number; status: string };
  availableActions: IntelligenceAction[];
  relevantEvidence: IntelligenceEvidence[];
  hypotheses: IntelligenceHypothesis[];
  contradictions: IntelligenceContradiction[];
  coverageContext?: { gaps: string[] };
  /** Pour une erreur métier inconnue : le symptôme observé (texte court, nettoyé). */
  failure?: { step: string; symptom: string; observed: string[] };
  constraints: IntelligenceConstraints;
}

/** Ce qu'il faudra observer au runtime pour confirmer la proposition. */
export const EXPECTED_EFFECT_KINDS = [
  'VISIBLE_CONTROL',
  'VISIBLE_FIELD',
  'ROUTE',
  'GOAL_REACHED',
  'TEXT',
] as const;

const shortText = (max: number) => z.string().min(1).max(max);

/**
 * PROPOSITION STRICTEMENT STRUCTURÉE (§34) : tout champ inconnu, toute valeur hors bornes fait
 * rejeter la proposition. Pas de « chaîne de pensée » : un résumé court au plus.
 */
export const intelligenceProposalSchema = z
  .object({
    status: z.enum(['PROPOSAL', 'INCONCLUSIVE', 'NEED_MORE_EVIDENCE']),
    intent: shortText(120).optional(),
    selectedActionId: z
      .string()
      .regex(/^A\d{1,4}$/)
      .optional(),
    proposedGoal: z
      .object({ id: shortText(120), description: shortText(300).optional() })
      .strict()
      .optional(),
    hypothesis: z
      .object({ statement: shortText(300), evidenceIds: z.array(shortText(80)).max(20) })
      .strict()
      .optional(),
    plan: z
      .object({
        steps: z
          .array(z.string().regex(/^A\d{1,4}$/))
          .min(1)
          .max(10),
        rationale: shortText(300).optional(),
      })
      .strict()
      .optional(),
    expectedEffects: z
      .array(z.object({ kind: z.enum(EXPECTED_EFFECT_KINDS), value: shortText(160) }).strict())
      .max(10)
      .optional(),
    failureCategory: shortText(80).optional(),
    nextInvestigation: shortText(200).optional(),
    supportingEvidenceIds: z.array(shortText(80)).max(20),
    uncertainties: z.array(shortText(200)).max(10),
    confidence: z.number().min(0).max(1),
    summary: shortText(300).optional(),
  })
  .strict();
export type IntelligenceProposal = z.infer<typeof intelligenceProposalSchema>;

/** Le même contrat en JSON Schema, pour la sortie structurée du fournisseur (sans dépendre de sa version de zod). */
export const INTELLIGENCE_PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'supportingEvidenceIds', 'uncertainties', 'confidence'],
  properties: {
    status: { type: 'string', enum: ['PROPOSAL', 'INCONCLUSIVE', 'NEED_MORE_EVIDENCE'] },
    intent: { type: 'string', maxLength: 120 },
    selectedActionId: { type: 'string', pattern: '^A\\d{1,4}$' },
    proposedGoal: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', maxLength: 120 }, description: { type: 'string', maxLength: 300 } },
    },
    hypothesis: {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'evidenceIds'],
      properties: {
        statement: { type: 'string', maxLength: 300 },
        evidenceIds: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
      },
    },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: 'string', pattern: '^A\\d{1,4}$' },
        },
        rationale: { type: 'string', maxLength: 300 },
      },
    },
    expectedEffects: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: { type: 'string', enum: [...EXPECTED_EFFECT_KINDS] },
          value: { type: 'string', maxLength: 160 },
        },
      },
    },
    failureCategory: { type: 'string', maxLength: 80 },
    nextInvestigation: { type: 'string', maxLength: 200 },
    supportingEvidenceIds: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
    uncertainties: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', maxLength: 300 },
  },
};

/** Le résultat de l'interrogation d'un fournisseur (avant validation). */
export interface ProviderResult {
  /** La réponse brute : TOUJOURS revalidée par QA-Crawler. */
  raw: unknown;
  model?: string;
  toolCalls?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Modèle demandé, choisi, réellement utilisé ; effort ; repli (si le fournisseur gère des modèles). */
  modelContext?: ModelExecutionContext;
}

/** Ce qu'un fournisseur reçoit en plus de la requête : complexité, budget d'outils, annulation. */
export interface ProviderCallOptions {
  signal: AbortSignal;
  /** La difficulté du raisonnement (ReasoningComplexityAnalyzer) : guide le choix du modèle et de l'effort. */
  complexity?: ComplexityAssessment;
  /** Les événements du fournisseur (découverte, choix de modèle, repli…), relayés par la passerelle. */
  emit?: (event: string, message: string) => void;
  /** Les outils LECTURE SEULE pour cette requête (le fournisseur peut les ignorer). */
  tools?: IntelligenceToolContext;
  maxToolCalls: number;
}

/**
 * Les outils en LECTURE SEULE (§48) : ils interrogent les services existants ; aucun ne peut
 * cliquer, saisir, naviguer, exécuter du JavaScript ou écrire.
 */
export interface IntelligenceToolContext {
  currentGoal(): unknown;
  businessState(): unknown;
  availableActions(): unknown;
  actionDetails(actionId: string): unknown;
  relevantEvidence(query: string): unknown;
  hypotheses(): unknown;
  contradictions(): unknown;
  functionalCoverage(): unknown;
  previousActions(): unknown;
  nextActions(): unknown;
}

export class IntelligenceUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`intelligence provider unavailable: ${reason}`);
    this.name = 'IntelligenceUnavailableError';
  }
}
