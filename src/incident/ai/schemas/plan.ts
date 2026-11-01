import { z } from 'zod';
import {
  AI_AGENTS,
  AI_REF_KINDS,
  type AiAgentName,
  type AiRef,
  type AiSourceLocation,
} from '../../../sdk/core/incident-ai-contracts.js';
import { LAYERS } from '../../../sdk/core/incident-contracts.js';

/**
 * LES SCHÉMAS DE SORTIE DU PLANNER, DE LA SYNTHÈSE ET DE L'ASSISTANT (zod + JSON Schema).
 *
 * Chaque agent rend un objet conforme à l'un de ces schémas ; la boucle le valide (`schema.safeParse`),
 * puis les références citées sont vérifiées contre ce qui existe dans l'investigation. Les primitives
 * (`AiRefSchema`, `AiSourceLocationSchema`, `LayerSchema`, `jsonSchemaOf`) sont partagées par
 * `schemas/analysis.ts`. Aucun schéma n'accepte un statut d'hypothèse ni un diagnostic : le modèle propose,
 * le moteur déterministe décide.
 */

export const MAX_TEXT_CHARS = 2000;
export const MAX_ITEMS = 30;

/** Un texte court du modèle : jamais vide, toujours borné. */
export const shortText = (max = 400): z.ZodString => z.string().trim().min(1).max(max);
export const longText = (max = MAX_TEXT_CHARS): z.ZodString => z.string().trim().min(1).max(max);

export const LayerSchema = z.enum(LAYERS);
export const AgentNameSchema = z.enum(AI_AGENTS);

export const AiRefSchema: z.ZodType<AiRef> = z.object({
  kind: z.enum(AI_REF_KINDS),
  id: shortText(300),
});

export const AiSourceLocationSchema: z.ZodType<AiSourceLocation> = z.object({
  applicationId: shortText(100),
  file: shortText(500),
  line: z.number().int().positive().optional(),
  symbol: shortText(300).optional(),
});

/** Le JSON Schema (objet) d'un schéma zod, tel que transmis au modèle. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// ── Planner ────────────────────────────────────────────────────────────────────────────────────

/** Les agents qu'un plan peut mobiliser (le planner ne se planifie pas lui-même ; l'assistant est hors run). */
export const PLANNABLE_AGENTS = AI_AGENTS.filter(
  (agent): agent is Exclude<AiAgentName, 'PLANNER' | 'ASSISTANT'> =>
    agent !== 'PLANNER' && agent !== 'ASSISTANT',
);

export const PlannerStepSchema = z.object({
  /** Identifiant court et stable dans le plan (« step-1 »). */
  id: shortText(40),
  order: z.number().int().min(1).max(MAX_ITEMS),
  title: shortText(200),
  agent: z.enum(PLANNABLE_AGENTS as [AiAgentName, ...AiAgentName[]]),
  /** Couches, endpoints, preuves ou symboles visés (identifiants ou libellés courts). */
  targets: z.array(shortText(300)).max(MAX_ITEMS),
  rationale: shortText(600).optional(),
});

export const PlannerOutputSchema = z.object({
  /** Ce que le run cherche à établir, en une phrase par objectif. */
  goals: z.array(shortText(300)).min(1).max(10),
  steps: z.array(PlannerStepSchema).min(1).max(MAX_ITEMS),
  focus: z.object({
    layers: z.array(LayerSchema).max(LAYERS.length),
    /** « POST /api/books ». */
    endpoints: z.array(shortText(200)).max(MAX_ITEMS),
    /** Identifiants de preuves ou de requêtes à examiner en priorité (doivent exister). */
    refs: z.array(AiRefSchema).max(MAX_ITEMS),
  }),
  /** Les questions ouvertes que les agents doivent trancher. */
  questions: z.array(shortText(300)).max(MAX_ITEMS),
});
export type PlannerStep = z.infer<typeof PlannerStepSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export const PLANNER_OUTPUT_JSON_SCHEMA = jsonSchemaOf(PlannerOutputSchema);

// ── Synthèse ───────────────────────────────────────────────────────────────────────────────────

/** Même forme que `AiSynthesis` : l'orchestrateur la recopie telle quelle après validation des identifiants. */
export const SynthesisSchema = z.object({
  /** Résumé argumenté, court, en français. */
  summary: longText(),
  /** Les hypothèses retenues par ordre de vraisemblance (ids d'hypothèses existantes, règles ou IA). */
  ranking: z.array(shortText(100)).max(MAX_ITEMS),
  /** Ce qui manque pour conclure. */
  missing: z.array(shortText(400)).max(MAX_ITEMS),
  /** Les vérifications qui départageraient (ids de propositions). */
  decisive: z.array(shortText(100)).max(MAX_ITEMS),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;
export const SYNTHESIS_JSON_SCHEMA = jsonSchemaOf(SynthesisSchema);

// ── Assistant ──────────────────────────────────────────────────────────────────────────────────

/** La réponse de l'assistant ; l'orchestrateur ajoute id, question, horodatage, auteur, usage. */
export const AssistantAnswerSchema = z.object({
  answer: longText(4000),
  refs: z.array(AiRefSchema).max(MAX_ITEMS),
  locations: z.array(AiSourceLocationSchema).max(MAX_ITEMS),
  /** Vrai quand l'investigation ne permet pas de répondre : la réponse dit alors ce qui manque. */
  insufficient: z.boolean(),
});
export type AssistantAnswer = z.infer<typeof AssistantAnswerSchema>;
export const ASSISTANT_ANSWER_JSON_SCHEMA = jsonSchemaOf(AssistantAnswerSchema);
