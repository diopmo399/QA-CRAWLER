import { z } from 'zod';
import {
  CONTRADICTION_KINDS,
  MAX_CONTRADICTIONS,
  type AiRef,
} from '../../../sdk/core/incident-ai-contracts.js';
import { EXPERIMENT_KINDS } from '../../../sdk/core/incident-contracts.js';
import { ParamsSchema } from './analysis.js';
import { AiRefSchema, jsonSchemaOf, longText, shortText } from './plan.js';

/**
 * LA SORTIE DU CHASSEUR DE CONTRADICTIONS.
 *
 * Chaque élément conteste UNE hypothèse existante (`hypothesisId`) d'une des sortes du contrat
 * (`CONTRADICTION_KINDS`) : preuve contraire, chemin de code incompatible, scénario qui passe malgré la
 * condition suspectée, erreur antérieure, différence d'environnement, écart journal/trace, preuve manquante,
 * explication alternative. Ou bien il cite des références qui existent (`refs`), ou bien il est une question
 * ouverte explicite (`openQuestion: true`) : un élément sans référence qui se présente comme un constat est
 * rejeté. La vérification décisive (`decisiveVerification`) est un indice, de la forme d'une
 * `ProposedVerification` ; le moteur et la politique décident seuls de ce qui s'exécute.
 *
 * Le JSON Schema est dérivé du schéma zod (`jsonSchemaOf`) ; les bornes protègent la boucle.
 */
export const CONTRADICTION_LIMITS = {
  /** Au plus autant d'éléments par sortie (la mémoire plafonne séparément à MAX_CONTRADICTIONS). */
  maxContradictions: Math.min(30, MAX_CONTRADICTIONS),
  maxRefsPerContradiction: 20,
  hypothesisIdChars: 100,
  summaryChars: 800,
  descriptionChars: 400,
} as const;

const L = CONTRADICTION_LIMITS;

/** Un indice de vérification décisive : la sorte, ce qu'elle établirait, ses paramètres réels (VERIFICATION_PARAMS). */
export const DecisiveVerificationSchema = z
  .object({
    kind: z.enum(EXPERIMENT_KINDS),
    description: shortText(L.descriptionChars),
    params: ParamsSchema,
  })
  .strict();

export const ContradictionItemSchema = z
  .object({
    /** L'hypothèse contestée : un id existant (règle ou `hyp-ai-<n>` du même run). */
    hypothesisId: shortText(L.hypothesisIdChars),
    kind: z.enum(CONTRADICTION_KINDS),
    /** En français, court et factuel : ce qui contredit, ou la question qui reste ouverte. */
    summary: longText(L.summaryChars),
    refs: z.array(AiRefSchema).max(L.maxRefsPerContradiction),
    /** Vrai quand aucune preuve ne la porte : une question, jamais un constat. */
    openQuestion: z.boolean(),
    decisiveVerification: DecisiveVerificationSchema.optional(),
  })
  .strict();

export const ContradictionFindingsSchema = z
  .object({
    contradictions: z.array(ContradictionItemSchema).max(L.maxContradictions),
  })
  .strict();

export type DecisiveVerification = z.infer<typeof DecisiveVerificationSchema>;
export type ContradictionItem = z.infer<typeof ContradictionItemSchema>;
export type ContradictionFindings = z.infer<typeof ContradictionFindingsSchema>;

/** Le même contrat en JSON Schema, transmis au modèle comme format de sortie. */
export const CONTRADICTION_FINDINGS_JSON_SCHEMA: Record<string, unknown> =
  jsonSchemaOf(ContradictionFindingsSchema);

/** Ce qu'un index de références doit savoir répondre (le `RefIndex` de refs.ts le fait). */
export interface ContradictionRefLookup {
  has(ref: AiRef): boolean;
}

/** Toutes les références citées par une sortie, dédoublonnées (les hypothèses contestées sont à part). */
export function collectContradictionRefs(output: ContradictionFindings): AiRef[] {
  const refs = new Map<string, AiRef>();
  for (const item of output.contradictions)
    for (const ref of item.refs) refs.set(`${ref.kind}:${ref.id}`, { kind: ref.kind, id: ref.id });
  return [...refs.values()];
}

/** Les hypothèses contestées par une sortie (ids, dédoublonnés, dans l'ordre). */
export function contestedHypothesisIds(output: ContradictionFindings): string[] {
  return [...new Set(output.contradictions.map((item) => item.hypothesisId))];
}

/**
 * Les raisons de rejet d'une sortie (vide : acceptable). Rédigées pour le modèle, qui reçoit UNE relance :
 * une hypothèse inconnue, une référence inconnue, un constat sans référence qui n'est pas une question ouverte.
 * Un indice de vérification aux paramètres douteux n'est pas une raison de rejet : la conversion l'écarte.
 */
export function validateContradictionFindings(
  output: ContradictionFindings,
  index: ContradictionRefLookup,
): string[] {
  const reasons: string[] = [];
  const push = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  output.contradictions.forEach((item, position) => {
    const where = `contradictions[${String(position)}]`;
    if (!index.has({ kind: 'hypothesis', id: item.hypothesisId }))
      push(
        `${where}.hypothesisId: unknown hypothesis "${item.hypothesisId}": contest only hypotheses that exist`,
      );
    for (const ref of item.refs)
      if (!index.has(ref))
        push(
          `unknown ${ref.kind} reference "${ref.id}": cite only ids provided to you or returned by a tool`,
        );
    if (!item.openQuestion && item.refs.length === 0)
      push(
        `${where}: a contradiction without refs is not a finding; either cite existing ids or set openQuestion to true`,
      );
  });
  return reasons;
}
