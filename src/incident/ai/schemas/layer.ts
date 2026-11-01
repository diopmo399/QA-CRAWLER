import { z } from 'zod';
import type { AiRef, AiSourceLocation } from '../../../sdk/core/incident-ai-contracts.js';
import { AI_REF_KINDS } from '../../../sdk/core/incident-ai-contracts.js';
import { LAYERS } from '../../../sdk/core/incident-contracts.js';

/**
 * LA SORTIE COMMUNE DES TROIS AGENTS DE COUCHE (FRONTEND, BFF, BACKEND).
 *
 * Un agent de couche rend des constats (`findings`), la chaîne qu'il a suivie (`chain`, facultative) et ce qui
 * lui manque (`gaps`). Chaque constat porte sa base : OBSERVED (une preuve l'établit), STATICALLY_RESOLVED (lu
 * dans le code, relation littérale) ou INFERRED (déduit). Une relation lue dans le code n'est jamais une
 * fonction exécutée : c'est à la validation des références puis aux vérifications d'en décider.
 *
 * Ce fichier est partagé : le schéma zod valide la réponse du modèle, le JSON Schema (écrit à la main, sans
 * dépendre de la version de zod du fournisseur) lui est transmis comme format de sortie, et les deux restent
 * alignés (testé). Les bornes protègent la boucle : un modèle bavard est coupé net, pas interprété.
 */

export const LAYER_FINDING_BASES = ['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED'] as const;
export type LayerFindingBasis = (typeof LAYER_FINDING_BASES)[number];

export const LAYER_FINDINGS_LIMITS = {
  maxFindings: 20,
  maxRefsPerFinding: 20,
  maxLocationsPerFinding: 10,
  maxChainSteps: 12,
  maxGaps: 20,
  titleChars: 120,
  summaryChars: 800,
  idChars: 300,
  fileChars: 300,
  symbolChars: 200,
  textChars: 400,
} as const;

const L = LAYER_FINDINGS_LIMITS;
const text = (max: number) => z.string().trim().min(1).max(max);

export const LayerRefSchema = z
  .object({
    kind: z.enum(AI_REF_KINDS),
    id: text(L.idChars),
  })
  .strict();

export const LayerLocationSchema = z
  .object({
    applicationId: text(L.idChars),
    file: text(L.fileChars),
    line: z.number().int().positive().optional(),
    symbol: text(L.symbolChars).optional(),
  })
  .strict();

export const LayerFindingSchema = z
  .object({
    title: text(L.titleChars),
    summary: text(L.summaryChars),
    layer: z.enum(LAYERS),
    basis: z.enum(LAYER_FINDING_BASES),
    refs: z.array(LayerRefSchema).max(L.maxRefsPerFinding),
    locations: z.array(LayerLocationSchema).max(L.maxLocationsPerFinding),
    /** Un indice d'hypothèse (titre court ou id d'hypothèse existante) : jamais une hypothèse écrite directement. */
    hypothesisHint: text(L.textChars).optional(),
  })
  .strict();

export const LayerChainStepSchema = z
  .object({
    /** L'étape de la chaîne (« utilisateur », « bouton », « composant », « handler », « service », « client HTTP », « requête »…). */
    step: text(L.textChars),
    symbol: text(L.symbolChars).optional(),
    file: text(L.fileChars).optional(),
    basis: z.enum(LAYER_FINDING_BASES),
  })
  .strict();

export const LayerFindingsSchema = z
  .object({
    findings: z.array(LayerFindingSchema).max(L.maxFindings),
    chain: z.array(LayerChainStepSchema).max(L.maxChainSteps).optional(),
    gaps: z.array(text(L.textChars)).max(L.maxGaps),
  })
  .strict();

export type LayerRef = z.infer<typeof LayerRefSchema>;
export type LayerLocation = z.infer<typeof LayerLocationSchema>;
export type LayerFinding = z.infer<typeof LayerFindingSchema>;
export type LayerChainStep = z.infer<typeof LayerChainStepSchema>;
export type LayerFindings = z.infer<typeof LayerFindingsSchema>;

const JSON_BASIS = { type: 'string', enum: [...LAYER_FINDING_BASES] };
const JSON_TEXT = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

/** Le même contrat en JSON Schema (strict : aucune propriété inconnue), transmis au modèle comme format de sortie. */
export const LAYER_FINDINGS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'gaps'],
  properties: {
    findings: {
      type: 'array',
      maxItems: L.maxFindings,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'layer', 'basis', 'refs', 'locations'],
        properties: {
          title: JSON_TEXT(L.titleChars),
          summary: JSON_TEXT(L.summaryChars),
          layer: { type: 'string', enum: [...LAYERS] },
          basis: JSON_BASIS,
          refs: {
            type: 'array',
            maxItems: L.maxRefsPerFinding,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'id'],
              properties: {
                kind: { type: 'string', enum: [...AI_REF_KINDS] },
                id: JSON_TEXT(L.idChars),
              },
            },
          },
          locations: {
            type: 'array',
            maxItems: L.maxLocationsPerFinding,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['applicationId', 'file'],
              properties: {
                applicationId: JSON_TEXT(L.idChars),
                file: JSON_TEXT(L.fileChars),
                line: { type: 'integer', minimum: 1 },
                symbol: JSON_TEXT(L.symbolChars),
              },
            },
          },
          hypothesisHint: JSON_TEXT(L.textChars),
        },
      },
    },
    chain: {
      type: 'array',
      maxItems: L.maxChainSteps,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'basis'],
        properties: {
          step: JSON_TEXT(L.textChars),
          symbol: JSON_TEXT(L.symbolChars),
          file: JSON_TEXT(L.fileChars),
          basis: JSON_BASIS,
        },
      },
    },
    gaps: { type: 'array', maxItems: L.maxGaps, items: JSON_TEXT(L.textChars) },
  },
};

/** Ce qu'un index de références doit savoir répondre (le `RefIndex` de refs.ts le fait ; un agent peut en recevoir un autre). */
export interface LayerRefIndex {
  has(ref: AiRef): boolean;
  hasLocation(location: AiSourceLocation): boolean;
}

/** Toutes les références et localisations citées par une sortie (constats et chaîne), dédoublonnées. */
export function collectLayerRefs(output: LayerFindings): { refs: AiRef[]; locations: AiSourceLocation[] } {
  const refs = new Map<string, AiRef>();
  const locations = new Map<string, AiSourceLocation>();
  for (const finding of output.findings) {
    for (const ref of finding.refs) refs.set(`${ref.kind}:${ref.id}`, { kind: ref.kind, id: ref.id });
    for (const location of finding.locations) {
      const key = `${location.applicationId}:${location.file}:${location.line ?? ''}:${location.symbol ?? ''}`;
      locations.set(key, { ...location });
    }
  }
  for (const step of output.chain ?? []) {
    if (step.symbol) refs.set(`symbol:${step.symbol}`, { kind: 'symbol', id: step.symbol });
    if (step.file) refs.set(`file:${step.file}`, { kind: 'file', id: step.file });
  }
  return { refs: [...refs.values()], locations: [...locations.values()] };
}

/**
 * Les raisons de rejet d'une sortie : chaque référence et chaque localisation doit exister dans l'index.
 * Vide : la sortie est acceptable. Les raisons sont rédigées pour le modèle (une relance les lui transmet).
 */
export function validateLayerFindings(output: LayerFindings, index: LayerRefIndex): string[] {
  const reasons: string[] = [];
  const { refs, locations } = collectLayerRefs(output);
  for (const ref of refs) {
    if (!index.has(ref))
      reasons.push(`unknown ${ref.kind} reference "${ref.id}": cite only ids provided to you`);
  }
  for (const location of locations) {
    if (!index.hasLocation(location)) {
      const where = location.line === undefined ? location.file : `${location.file}:${location.line}`;
      reasons.push(
        `unknown location ${location.applicationId}/${where}: cite only files of the code index or files you read with read_source`,
      );
    }
  }
  return reasons;
}
