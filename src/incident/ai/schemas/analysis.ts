import { z } from 'zod';
import {
  EXPERIMENT_KINDS,
  type ExperimentKind,
  type Incident,
} from '../../../sdk/core/incident-contracts.js';
import {
  AiRefSchema,
  AiSourceLocationSchema,
  LayerSchema,
  MAX_ITEMS,
  jsonSchemaOf,
  longText,
  shortText,
} from './plan.js';

/**
 * LES SCHÉMAS DE SORTIE DES AGENTS DE CORRÉLATION : analyse des preuves, comparaison inter-couches,
 * propositions d'hypothèses, plan de vérification. Chaque constat cite des références (`AiRef`) qui doivent
 * exister ; la boucle rejette la sortie sinon. Les propositions d'hypothèses ne portent ni statut ni
 * diagnostic : le moteur déterministe les crée PROPOSED, plafonne la confiance et décide seul de la suite.
 */

export const BasisSchema = z.enum(['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED']);
export type Basis = z.infer<typeof BasisSchema>;

/** Un constat qui cite au moins une preuve. */
const CitedSchema = z.object({
  summary: longText(800),
  refs: z.array(AiRefSchema).min(1).max(MAX_ITEMS),
});

// ── Analyse des preuves ────────────────────────────────────────────────────────────────────────

export const TEMPORAL_RELATIONS = ['BEFORE', 'TRIGGERS', 'CONCURRENT', 'FOLLOWS'] as const;

export const EvidenceAnalysisSchema = z.object({
  /** Le premier symptôme observable (réponse en erreur, erreur JavaScript, action en échec…). */
  firstSymptom: CitedSchema.extend({ at: shortText(60).optional() }),
  /** Ce qui précède le symptôme, dans l'ordre. */
  precedingEvents: z.array(CitedSchema).max(MAX_ITEMS),
  /** Les incohérences entre preuves (un corps envoyé sans un champ que l'écran affichait, un statut contradictoire…). */
  inconsistencies: z.array(CitedSchema).max(MAX_ITEMS),
  /** Les preuves qui manquent pour conclure (texte libre : journaux, corps de réponse…). */
  missingEvidence: z.array(shortText(400)).max(MAX_ITEMS),
  temporalRelations: z
    .array(
      z.object({
        from: AiRefSchema,
        to: AiRefSchema,
        relation: z.enum(TEMPORAL_RELATIONS),
        summary: shortText(400),
      }),
    )
    .max(MAX_ITEMS),
  /** Les pistes à creuser par les agents de couche. */
  leads: z
    .array(
      CitedSchema.extend({
        title: shortText(200),
        layer: LayerSchema,
        hypothesisHint: shortText(400).optional(),
      }),
    )
    .max(MAX_ITEMS),
  gaps: z.array(shortText(400)).max(MAX_ITEMS),
});
export type EvidenceAnalysis = z.infer<typeof EvidenceAnalysisSchema>;
export const EVIDENCE_ANALYSIS_JSON_SCHEMA = jsonSchemaOf(EvidenceAnalysisSchema);

// ── Comparaison inter-couches ──────────────────────────────────────────────────────────────────

export const CROSS_LAYER_CATEGORIES = [
  'FIELD_LOST',
  'WRONG_TRANSFORM',
  'CONTRACT_MISMATCH',
  'GENERIC_ERROR_CONVERSION',
  'MISSING_VALIDATION',
  'STATUS_PROPAGATION',
  'OTHER',
] as const;
export type CrossLayerCategory = (typeof CROSS_LAYER_CATEGORIES)[number];

export const CrossLayerFindingSchema = z.object({
  title: shortText(200),
  summary: longText(800),
  category: z.enum(CROSS_LAYER_CATEGORIES),
  /** Les couches concernées, de l'émetteur au récepteur. */
  layers: z.array(LayerSchema).min(1).max(8),
  basis: BasisSchema,
  refs: z.array(AiRefSchema).min(1).max(MAX_ITEMS),
  locations: z.array(AiSourceLocationSchema).max(MAX_ITEMS),
  /** Le champ en cause (« publisherId ») quand il y en a un. */
  field: shortText(100).optional(),
  hypothesisHint: shortText(400).optional(),
});

/** Une relation suggérée entre deux nœuds du graphe (ids existants) ; toujours INFERRED une fois écrite. */
export const SuggestedRelationSchema = z.object({
  from: shortText(300),
  to: shortText(300),
  reason: shortText(400),
  refs: z.array(AiRefSchema).max(MAX_ITEMS),
});

export const CrossLayerFindingsSchema = z.object({
  findings: z.array(CrossLayerFindingSchema).max(MAX_ITEMS),
  relations: z.array(SuggestedRelationSchema).max(MAX_ITEMS),
  gaps: z.array(shortText(400)).max(MAX_ITEMS),
});
export type CrossLayerFinding = z.infer<typeof CrossLayerFindingSchema>;
export type CrossLayerFindings = z.infer<typeof CrossLayerFindingsSchema>;
export const CROSS_LAYER_FINDINGS_JSON_SCHEMA = jsonSchemaOf(CrossLayerFindingsSchema);

// ── Propositions d'hypothèses ──────────────────────────────────────────────────────────────────

export const CitedFactSchema = z.object({ ref: AiRefSchema, fact: shortText(400) });

export const ParamValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export const ParamsSchema = z.record(z.string(), ParamValueSchema);
export type VerificationParams = z.infer<typeof ParamsSchema>;

export const VerificationHintSchema = z.object({
  kind: z.enum(EXPERIMENT_KINDS),
  description: shortText(400),
  params: ParamsSchema,
});

/** Ce que le modèle rend pour une hypothèse (sans identifiant : le moteur l'attribue). */
export const HypothesisProposalModelSchema = z.object({
  title: shortText(200),
  description: longText(1200),
  suspectedCause: longText(600),
  layer: LayerSchema,
  /** Les endroits du code en cause ; chacun doit exister (index du code ou fichier lu pendant le run). */
  locations: z.array(AiSourceLocationSchema).max(MAX_ITEMS),
  supporting: z.array(CitedFactSchema).min(1).max(MAX_ITEMS),
  contradicting: z.array(CitedFactSchema).max(MAX_ITEMS),
  /** Indicative, 0 à 1 ; le moteur la plafonne. */
  confidence: z.number().min(0).max(1),
  verificationHints: z.array(VerificationHintSchema).max(10),
});

export const EXISTING_ASSESSMENTS = ['SUPPORTS', 'CONTRADICTS', 'NEUTRAL'] as const;

export const HypothesisProposalsModelSchema = z.object({
  hypotheses: z.array(HypothesisProposalModelSchema).max(MAX_ITEMS),
  /** Ce que les preuves disent des hypothèses déjà présentes (ids existants) ; jamais un statut. */
  existing: z
    .array(
      z.object({
        hypothesisId: shortText(100),
        assessment: z.enum(EXISTING_ASSESSMENTS),
        summary: shortText(600),
        refs: z.array(AiRefSchema).max(MAX_ITEMS),
      }),
    )
    .max(MAX_ITEMS),
  gaps: z.array(shortText(400)).max(MAX_ITEMS),
});
export type HypothesisProposalModel = z.infer<typeof HypothesisProposalModelSchema>;
export type HypothesisProposalsModel = z.infer<typeof HypothesisProposalsModelSchema>;
export const HYPOTHESIS_PROPOSALS_JSON_SCHEMA = jsonSchemaOf(HypothesisProposalsModelSchema);

/** La proposition une fois identifiée par le moteur (`hyp-ai-<n>`), telle que les agents suivants la voient. */
export type HypothesisProposal = HypothesisProposalModel & { id: string };
export type HypothesisProposals = Omit<HypothesisProposalsModel, 'hypotheses'> & {
  hypotheses: HypothesisProposal[];
};

// ── Plan de vérification ───────────────────────────────────────────────────────────────────────

export const ExperimentProposalSchema = z.object({
  /** L'hypothèse vérifiée (id existant : règle ou `hyp-ai-<n>` du même run). */
  hypothesisId: shortText(100),
  kind: z.enum(EXPERIMENT_KINDS),
  objective: shortText(400),
  description: shortText(400),
  /** Les paramètres réels de la sorte (voir VERIFICATION_PARAMS). */
  params: ParamsSchema,
  resources: z.array(shortText(200)).max(MAX_ITEMS),
  permissions: z.array(shortText(200)).max(MAX_ITEMS),
  risks: z.array(shortText(300)).max(MAX_ITEMS),
  sideEffects: z.boolean(),
  expected: shortText(400),
  confirmIf: shortText(400),
  refuteIf: shortText(400),
  /** 1 = à faire d'abord. */
  priority: z.number().int().min(1).max(MAX_ITEMS),
});

export const VerificationPlanSchema = z.object({
  proposals: z.array(ExperimentProposalSchema).max(MAX_ITEMS),
  /** Quand rien d'utile ne peut être vérifié dans le périmètre : pourquoi. */
  noUsefulVerification: shortText(600).optional(),
  gaps: z.array(shortText(400)).max(MAX_ITEMS),
});
export type ExperimentProposal = z.infer<typeof ExperimentProposalSchema>;
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;
export const VERIFICATION_PLAN_JSON_SCHEMA = jsonSchemaOf(VerificationPlanSchema);

// ── Les paramètres réels de chaque sorte de vérification (experiments.ts) ──────────────────────

export interface VerificationParamsSpec {
  /** Les clés comprises par l'exécuteur (toute autre clé est ignorée par lui et refusée ici). */
  keys: readonly string[];
  /** Les clés sans lesquelles l'exécuteur rend ERROR. */
  required: readonly string[];
  /** Lecture seule, sans exécution de commande : auto-exécutable quand le périmètre le permet. */
  sideEffects: boolean;
  /** Ce qu'il faut dire au modèle. */
  summary: string;
}

const COMPARE_KEYS = ['endpoint', 'field', 'expectMissingField', 'expectMessage', 'expectStatus'] as const;
const TEST_KEYS = [
  'applicationId',
  'module',
  'cwd',
  'command',
  'test',
  'args',
  'timeoutMs',
  'patterns',
  'expect',
] as const;

export const VERIFICATION_PARAMS: Record<ExperimentKind, VerificationParamsSpec> = {
  REPLAY: {
    keys: ['scenario', 'baseUrl'],
    required: [],
    sideEffects: false,
    summary: 'replay the incident scenario; params: scenario? (defaults to the incident scenario), baseUrl?',
  },
  COMPARE_WITH_PASSING: {
    keys: ['passingScenario', 'failing', ...COMPARE_KEYS],
    required: ['passingScenario'],
    sideEffects: false,
    summary:
      'replay a scenario that must succeed and compare its request with the failing reproduction; params: passingScenario (required, a library scenario name), failing? (reproduction id), endpoint? ("POST /api/books"), field? (field expected missing on the failing side), expectMessage?, expectStatus?',
  },
  COMPARE_REQUESTS: {
    keys: ['left', 'right', ...COMPARE_KEYS],
    required: ['left', 'right'],
    sideEffects: false,
    summary:
      'compare the requests of two existing reproductions; params: left, right (reproduction ids, required), endpoint?, field?, expectMessage?, expectStatus?',
  },
  COMPARE_RESPONSES: {
    keys: ['left', 'right', ...COMPARE_KEYS],
    required: ['left', 'right'],
    sideEffects: false,
    summary:
      'compare the responses of two existing reproductions; params: left, right (reproduction ids, required), endpoint?, expectMessage?, expectStatus?',
  },
  UNIT_TEST: {
    keys: TEST_KEYS,
    required: [],
    sideEffects: false,
    summary:
      'run one unit test of a repository (needs permissions.runTests); params: applicationId (required when several applications), test? (class or file), command? (mvn|gradle|npm|npx), args?, module?, patterns? (expected failure text), expect? ("pass"|"fail", default fail), timeoutMs?',
  },
  INTEGRATION_TEST: {
    keys: [...TEST_KEYS, 'environmentKind'],
    required: [],
    sideEffects: true,
    summary:
      'run an integration test (always a side effect: explicit approval, never against production); params as UNIT_TEST plus environmentKind (LOCAL, DEV, TEST, CI… required when the execution target is LOCAL)',
  },
  INSPECT_LOGS: {
    keys: [
      'applicationId',
      'path',
      'namespace',
      'selector',
      'container',
      'tail',
      'sinceSeconds',
      'patterns',
      'pattern',
      'maxLines',
      'since',
      'until',
      'marginSeconds',
      'expect',
    ],
    required: [],
    sideEffects: false,
    summary:
      'search the logs around the incident window (needs permissions.readLogs or openshift); params: patterns (exception names, paths), path? (log file of an application) or namespace?/selector? (OpenShift), applicationId?, maxLines?, since?/until?, expect? ("absent")',
  },
  CHECK_VALIDATION: {
    keys: ['file', 'field', 'applicationId', 'expect', 'annotations'],
    required: ['file', 'field'],
    sideEffects: false,
    summary:
      'read one source file and check whether a field is validated; params: file (required, relative to the repository), field (required), applicationId (required when several applications), expect? ("missing"|"present", default missing), annotations?',
  },
};

const isReproduction = (incident: Incident, id: unknown): boolean =>
  typeof id === 'string' && incident.investigation.reproductions.some((run) => run.id === id);

/**
 * Les raisons pour lesquelles l'exécuteur rendrait ERROR (ou ignorerait des clés) pour ces paramètres :
 * vide quand la vérification est exécutable par le chemin ordinaire.
 */
export function verificationParamsProblems(
  kind: ExperimentKind,
  params: VerificationParams,
  incident: Incident,
): string[] {
  const spec = VERIFICATION_PARAMS[kind];
  const problems: string[] = [];
  for (const key of Object.keys(params))
    if (!spec.keys.includes(key) && key !== 'sideEffects') problems.push(`${kind}: unknown param "${key}"`);
  for (const key of spec.required)
    if (params[key] === undefined || params[key] === '') problems.push(`${kind}: params.${key} is required`);
  const apps = incident.scope.applications;
  const appId = params.applicationId;
  if (appId !== undefined && !apps.some((app) => app.id === appId))
    problems.push(`${kind}: unknown applicationId "${String(appId)}"`);
  if (
    (kind === 'UNIT_TEST' || kind === 'INTEGRATION_TEST' || kind === 'CHECK_VALIDATION') &&
    appId === undefined &&
    apps.length !== 1
  )
    problems.push(
      `${kind}: params.applicationId is required (${String(apps.length)} applications in the scope)`,
    );
  if (kind === 'COMPARE_REQUESTS' || kind === 'COMPARE_RESPONSES')
    for (const side of ['left', 'right'])
      if (params[side] !== undefined && !isReproduction(incident, params[side]))
        problems.push(`${kind}: params.${side} is not a reproduction id`);
  if (
    kind === 'COMPARE_WITH_PASSING' &&
    params.failing !== undefined &&
    !isReproduction(incident, params.failing)
  )
    problems.push(`${kind}: params.failing is not a reproduction id`);
  if (kind === 'COMPARE_WITH_PASSING' && params.passingScenario === incident.scenario)
    problems.push(`${kind}: passingScenario must differ from the incident scenario`);
  if (
    kind === 'INTEGRATION_TEST' &&
    incident.execution.target === 'LOCAL' &&
    params.environmentKind === undefined
  )
    problems.push(`${kind}: params.environmentKind is required for a LOCAL execution target`);
  if (kind === 'INSPECT_LOGS') {
    const app = typeof appId === 'string' ? apps.find((entry) => entry.id === appId) : undefined;
    const hasSource =
      params.path !== undefined ||
      (params.namespace !== undefined && params.selector !== undefined) ||
      (app ? app.openshift !== undefined || (app.logFiles?.length ?? 0) > 0 : false) ||
      apps.some((entry) => entry.openshift !== undefined || (entry.logFiles?.length ?? 0) > 0);
    if (!hasSource) problems.push(`${kind}: no log source (params.path, an OpenShift selector or logFiles)`);
  }
  const file = params.file;
  if (
    kind === 'CHECK_VALIDATION' &&
    typeof file === 'string' &&
    (file.startsWith('/') || file.includes('..'))
  )
    problems.push(`${kind}: params.file must be relative to the repository, without ".."`);
  return problems;
}

/** Les sortes exécutables sans effet de bord déclaré (une proposition INTEGRATION_TEST en a toujours). */
export function hasSideEffects(kind: ExperimentKind, params: VerificationParams): boolean {
  return VERIFICATION_PARAMS[kind].sideEffects || params.sideEffects === true;
}
