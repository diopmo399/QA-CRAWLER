import { z } from 'zod';

/**
 * VÉRIFICATION MÉTIER : le format déclaratif des exigences, des règles métier, des assertions et des
 * règles de cohérence. Un modèle TYPÉ et borné, pas un langage d'expression : chaque assertion choisit
 * un genre (`kind`) parmi une liste fermée, et chaque genre a ses champs.
 */

const nonEmpty = z.string().trim().min(1);
/** Un identifiant stable (REQ-REQUEST-001, BR-REQUEST-001, ASSERT-REQUEST-TITLE). */
const stableId = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/, 'an id: letters, digits, _ . : -, starting with a letter');

export const CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

/**
 * UNE VALEUR ATTENDUE : celle d'une donnée de test DU RUN (jamais la valeur littérale de
 * l'enregistrement), une valeur déclarée, ou un identifiant extrait plus tôt dans le flow.
 */
export const valueRefSchema = z.union([
  z.object({ testData: nonEmpty }).strict(),
  z.object({ value: z.union([nonEmpty, z.number().transform(String)]) }).strict(),
  z.object({ extracted: nonEmpty }).strict(),
]);
export type ValueRef = z.output<typeof valueRefSchema>;

/** Une requête observée : méthode facultative, chemin (sous-chaîne, ou motif avec * et **). */
const exchangeMatch = {
  method: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .optional(),
  path: nonEmpty,
};

/**
 * UNE LECTURE D'API AUTORISÉE : un GET seulement (jamais une écriture pour vérifier), sur un hôte que
 * la SafetyPolicy autorise. `${testData:clé}` et `${extracted:nom}` sont remplacés au moment de la
 * vérification ; `select` désigne la liste ou l'objet dans la réponse (data.items).
 */
export const apiReadSchema = z
  .object({ url: nonEmpty, select: nonEmpty.optional() })
  .strict()
  .refine((read) => !/^\s*(post|put|patch|delete)\s/i.test(read.url), 'an API read is a GET URL');
export type ApiRead = z.output<typeof apiReadSchema>;

const statusSchema = z
  .union([z.number().int().min(100).max(599), z.enum(['2xx', '3xx', '4xx', '5xx'])])
  .default('2xx');

/** Ce qu'une assertion doit trouver (les sources possibles dépendent du genre). */
const checkSchema = z.discriminatedUnion('kind', [
  /**
   * UNE REQUÊTE OBSERVÉE avec le statut attendu ; `extract` garde l'identifiant de la réponse (champ
   * `field`, sinon le premier identifiant) pour les vérifications suivantes.
   */
  z
    .object({
      kind: z.literal('request'),
      ...exchangeMatch,
      status: statusSchema,
      requireIdentifier: z.boolean().default(false),
      extract: z.object({ name: nonEmpty, field: nonEmpty.optional() }).strict().optional(),
    })
    .strict(),
  /** UNE VALEUR : envoyée, retournée, affichée ou relue par une API, comparée à la valeur attendue. */
  z
    .object({
      kind: z.literal('value'),
      source: z.enum(['request', 'response', 'ui', 'api']),
      method: exchangeMatch.method,
      path: nonEmpty.optional(),
      field: nonEmpty.optional(),
      expected: valueRefSchema,
      match: z.enum(['exact', 'normalized']).default('normalized'),
      api: apiReadSchema.optional(),
    })
    .strict(),
  /** UNE ENTITÉ présente (ou absente), retrouvée par une clé ; `unique` : une seule. */
  z
    .object({
      kind: z.literal('entity'),
      source: z.enum(['ui', 'api', 'network']),
      by: valueRefSchema,
      field: nonEmpty.optional(),
      expect: z.enum(['present', 'absent']).default('present'),
      unique: z.boolean().default(false),
      path: nonEmpty.optional(),
      api: apiReadSchema.optional(),
    })
    .strict(),
  /** UN ÉTAT MÉTIER (code en capitales) ; `pending` : les états « pas encore » d'un traitement asynchrone. */
  z
    .object({
      kind: z.literal('state'),
      source: z.enum(['response', 'api', 'ui']),
      expected: z.string().trim().min(1),
      pending: z.array(nonEmpty).default([]),
      field: nonEmpty.optional(),
      by: valueRefSchema.optional(),
      method: exchangeMatch.method,
      path: nonEmpty.optional(),
      api: apiReadSchema.optional(),
    })
    .strict(),
  /** UNE CARDINALITÉ : combien d'enregistrements portent cette valeur (un, au moins, au plus). */
  z
    .object({
      kind: z.literal('cardinality'),
      source: z.enum(['network', 'api']),
      matching: z.object({ field: nonEmpty.optional(), value: valueRefSchema }).strict(),
      equals: z.number().int().min(0).optional(),
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
      path: nonEmpty.optional(),
      api: apiReadSchema.optional(),
    })
    .strict(),
  /** UNE RELATION : l'entité retrouvée par `entity` porte, dans `field`, la référence attendue. */
  z
    .object({
      kind: z.literal('relation'),
      source: z.enum(['network', 'api']),
      entity: z.object({ field: nonEmpty.optional(), value: valueRefSchema }).strict(),
      field: nonEmpty,
      expected: valueRefSchema,
      path: nonEmpty.optional(),
      api: apiReadSchema.optional(),
    })
    .strict(),
  /** UNE TRANSITION d'état métier observée (de → vers), permise ou interdite. */
  z
    .object({
      kind: z.literal('transition'),
      from: nonEmpty,
      to: nonEmpty,
      expect: z.enum(['allowed', 'forbidden']),
      method: exchangeMatch.method,
      path: nonEmpty.optional(),
    })
    .strict(),
  /** AUCUN EFFET DE BORD INTERDIT : les écritures acceptées hors liste, ou trop de créations. */
  z
    .object({
      kind: z.literal('sideEffects'),
      allowedWrites: z.array(z.object({ ...exchangeMatch }).strict()).default([]),
      maxCreated: z.number().int().min(0).optional(),
    })
    .strict(),
  /** LE CONTRAT : les réponses observées de cette opération sont déclarées par l'OpenAPI de la mission. */
  z.object({ kind: z.literal('contract'), ...exchangeMatch }).strict(),
]);
export type AssertionCheck = z.output<typeof checkSchema>;

export const EVIDENCE_KINDS = ['NETWORK', 'DOM', 'API', 'OPENAPI'] as const;
export type RequiredEvidence = (typeof EVIDENCE_KINDS)[number];

/** UNE ASSERTION MÉTIER déclarée sur un flow. */
export const assertionSchema = z
  .object({
    id: stableId,
    description: nonEmpty,
    criticality: z.enum(CRITICALITIES).default('MEDIUM'),
    /** Obligatoire : son échec fait échouer le flow ; non vérifiée, le run reste INCONCLUSIVE. */
    mandatory: z.boolean().default(true),
    /** Vérifiée juste après cette étape (index à partir de 1) ; par défaut, à la fin du flow. */
    after: z.number().int().min(1).optional(),
    /** Préconditions : ces assertions doivent avoir réussi (sinon BLOCKED). */
    requires: z.array(stableId).default([]),
    /** Les entités concernées (pour le rapport et la traçabilité). */
    entities: z.array(nonEmpty).default([]),
    /** Délai maximal d'une vérification asynchrone (relue jusqu'au succès ou au délai). */
    timeoutMs: z.number().int().min(0).max(60_000).default(0),
    pollMs: z.number().int().min(100).max(10_000).default(500),
    /** Les preuves exigées : un succès sans elles est INCONCLUSIVE. */
    evidence: z.array(z.enum(EVIDENCE_KINDS)).default([]),
    check: checkSchema,
  })
  .strict()
  .refine(
    (assertion) =>
      assertion.check.kind !== 'cardinality' ||
      assertion.check.equals !== undefined ||
      assertion.check.min !== undefined ||
      assertion.check.max !== undefined,
    { message: 'cardinality needs equals, min or max', path: ['check'] },
  );
export type AssertionConfig = z.output<typeof assertionSchema>;

/**
 * LA COHÉRENCE DES DONNÉES d'un flow : les vérifications automatiques (saisie → requête → réponse →
 * écran, création → recherche) plus les règles déclarées (clés uniques, relations, effets de bord,
 * transformations documentées).
 */
export const consistencySchema = z
  .object({
    /** Les données de test à suivre (par défaut : toutes celles saisies, sauf les valeurs sensibles). */
    keys: z.array(nonEmpty).optional(),
    /** Transformations documentées (date affichée « 12/03 », envoyée « 2026-03-12 ») : jamais une divergence. */
    transforms: z.record(nonEmpty, nonEmpty).prefault({}),
    /** Valeurs qui doivent être affichées par l'écran final (l'entité ouverte). */
    displayed: z.array(nonEmpty).default([]),
    /** Clés métier uniques : deux enregistrements avec la même valeur sont un doublon. */
    uniqueKeys: z.array(z.object({ field: nonEmpty, value: valueRefSchema }).strict()).default([]),
    relations: z
      .array(
        z
          .object({
            id: stableId.optional(),
            entity: z.object({ field: nonEmpty.optional(), value: valueRefSchema }).strict(),
            field: nonEmpty,
            expected: valueRefSchema,
          })
          .strict(),
      )
      .default([]),
    sideEffects: z
      .object({
        allowedWrites: z.array(z.object({ ...exchangeMatch }).strict()).default([]),
        maxCreated: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    /** Recherche asynchrone : une entité pas encore indexée est PENDING_EVENTUAL_CONSISTENCY, pas INCONSISTENT. */
    eventual: z.boolean().default(false),
  })
  .strict();
export type ConsistencyConfig = z.output<typeof consistencySchema>;

/** UNE EXIGENCE (ticket, critère d'acceptation, contrat). */
export const requirementSchema = z
  .object({
    id: stableId,
    description: nonEmpty,
    criticality: z.enum(CRITICALITIES).default('MEDIUM'),
    /** D'où elle vient : un ticket, un document, une spécification (texte libre, jamais un secret). */
    source: nonEmpty.optional(),
    /** Les exigences dont elle dépend (DEPENDS_ON). */
    dependsOn: z.array(stableId).default([]),
    preconditions: z.array(nonEmpty).default([]),
  })
  .strict();
export type RequirementConfig = z.output<typeof requirementSchema>;

/** UNE RÈGLE MÉTIER : dérivée d'exigences, vérifiée par des assertions. */
export const businessRuleSchema = z
  .object({
    id: stableId,
    description: nonEmpty,
    requirementIds: z.array(stableId).default([]),
    assertions: z.array(stableId).default([]),
    /** DERIVED_FROM : un contrat OpenAPI (« POST /api/requests ») ou une autre source. */
    derivedFrom: z.array(nonEmpty).default([]),
    /** CONFLICTS_WITH : deux règles qui paraissent contradictoires (signalées, jamais résolues seules). */
    conflictsWith: z.array(stableId).default([]),
  })
  .strict();
export type BusinessRuleConfig = z.output<typeof businessRuleSchema>;

/** Réglages de la vérification métier (mission). */
export const qualitySchema = z
  .object({
    /**
     * Montrer les valeurs comparées dans les rapports : seulement les valeurs GÉNÉRÉES ou déclarées, et
     * jamais celles d'une clé sensible. Par défaut, seulement les noms et les empreintes.
     */
    showValues: z.boolean().default(false),
    /** Les preuves d'un run gardent leur validité ce nombre de jours dans l'historique (STALE_EVIDENCE au-delà). */
    evidenceMaxAgeDays: z.number().int().min(1).max(3650).default(30),
    /** L'historique de la traçabilité (relatif au dossier de connaissance) ; false : aucun historique. */
    history: z.union([nonEmpty, z.literal(false)]).default('traceability-history.json'),
    /** Les vérifications automatiques de cohérence sur chaque flow (sans déclaration). */
    autoConsistency: z.boolean().default(false),
  })
  .strict();
export type QualityConfig = z.output<typeof qualitySchema>;
