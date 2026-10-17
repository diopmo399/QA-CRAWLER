import type { Evidence } from '../cognitive/evidence.js';
import type { Criticality } from '../config/quality-schema.js';

/**
 * LA VÉRIFICATION MÉTIER : assertions, cohérence des données, traçabilité. Ce module ne prend aucune
 * décision d'exécution : il juge, à partir de preuves déjà observées (ou relues en lecture seule), si le
 * résultat métier attendu est atteint.
 */

/**
 * PASS          toutes les preuves exigées confirment le résultat ;
 * FAIL          une preuve contredit le résultat attendu ;
 * BLOCKED       une précondition (étape, assertion requise) n'est pas remplie : rien n'a été vérifié ;
 * INCONCLUSIVE  des preuves existent mais ne suffisent pas à conclure (ambiguïté, attente asynchrone) ;
 * UNVERIFIABLE  la source de vérification exigée n'est pas disponible (réseau non observé, API absente).
 * Aucun de BLOCKED, INCONCLUSIVE, UNVERIFIABLE n'est jamais un succès.
 */
/** Les événements de la vérification métier (des identifiants et des statuts, jamais une valeur). */
export const QUALITY_EVENTS = [
  'BUSINESS_ASSERTION_PASSED',
  'BUSINESS_ASSERTION_FAILED',
  'BUSINESS_ASSERTION_NOT_VERIFIED',
  'DATA_CONSISTENCY_CHECKED',
  'DATA_INCONSISTENCY_DETECTED',
  'REQUIREMENT_COVERAGE_COMPUTED',
] as const;
export type QualityEvent = (typeof QUALITY_EVENTS)[number];

export const ASSERTION_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'UNVERIFIABLE'] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

export type VerificationSource = 'NETWORK' | 'DOM' | 'API' | 'OPENAPI' | 'RUN_DATA';

/**
 * UNE PREUVE DE QUALITÉ : l'Evidence du moteur cognitif (même type, même plafond de confiance), plus
 * ce qui la rattache au run, à l'étape, à l'assertion, à l'exigence et à la corrélation. `details` ne
 * porte que des noms, des codes, des compteurs et des empreintes : jamais une valeur sensible.
 */
export interface QualityEvidence extends Evidence {
  runId: string;
  flow: string;
  /** L'étape du flow (index à partir de 1) quand la preuve vient d'une étape. */
  step?: number;
  /** La source de vérification (une lecture d'API autorisée se distingue du trafic observé). */
  sourceType?: VerificationSource;
  assertionId?: string;
  requirementIds?: string[];
  /** Ce qui relie les représentations : l'identifiant de l'entité (empreinte), l'échange réseau… */
  correlationId?: string;
  /** Ce qui a été masqué (clés sensibles, valeurs non générées). */
  redaction?: { masked: string[] };
}

export interface AssertionResult {
  id: string;
  description: string;
  flow: string;
  kind: string;
  criticality: Criticality;
  mandatory: boolean;
  status: AssertionStatus;
  /** La source réellement utilisée pour conclure. */
  source?: VerificationSource;
  /** L'étape après laquelle elle a été vérifiée (absente : fin du flow). */
  after?: number;
  entities: string[];
  /** Ce qui était attendu, en clair seulement quand l'affichage est permis (sinon la référence : testData.title). */
  expected: string;
  observed: string;
  reasons: string[];
  /** Les identifiants des preuves (QualityEvidence.id). */
  evidence: string[];
  attempts: number;
  durationMs: number;
  /** La prochaine action utile pour diagnostiquer. */
  nextStep?: string;
}

export const CONSISTENCY_STATUSES = [
  'CONSISTENT',
  'INCONSISTENT',
  'MISSING_DATA',
  'AMBIGUOUS_ENTITY',
  'NOT_OBSERVABLE',
  'PENDING_EVENTUAL_CONSISTENCY',
  'INCONCLUSIVE',
] as const;
export type ConsistencyStatus = (typeof CONSISTENCY_STATUSES)[number];

export const CONSISTENCY_RULES = [
  'UI_TO_REQUEST',
  'REQUEST_TO_RESPONSE',
  'RESPONSE_TO_UI',
  'CREATE_TO_SEARCH',
  'RELATION',
  'DUPLICATE',
  'SIDE_EFFECT',
] as const;
export type ConsistencyRule = (typeof CONSISTENCY_RULES)[number];

export interface ConsistencyResult {
  id: string;
  flow: string;
  rule: ConsistencyRule;
  /** La donnée de test suivie (sa clé, jamais sa valeur) ou l'entité. */
  key?: string;
  field?: string;
  status: ConsistencyStatus;
  /** Les sources comparées (« UI input step 2 », « POST /api/requests (request) »). */
  sources: string[];
  /** La normalisation qui a permis la correspondance (casse, accents, espaces ; transformation documentée). */
  normalization?: string;
  expected?: string;
  observed?: string;
  difference?: string;
  confidence: number;
  /** Ce que l'observation ne couvre pas (aucune affirmation d'exhaustivité). */
  limits: string[];
  evidence: string[];
  /** Déclarée (la mission la demande) : son incohérence fait échouer le flow. */
  declared: boolean;
}

/** Le verdict métier d'un flow, à partir de ses assertions obligatoires. */
export type BusinessVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE' | 'UNVERIFIABLE' | 'NOT_DECLARED';

export interface FlowQualityReport {
  verdict: BusinessVerdict;
  assertions: AssertionResult[];
  consistency: ConsistencyResult[];
  evidence: QualityEvidence[];
  /** Le réseau du flow a-t-il été observé avec ses empreintes (corps des requêtes et réponses) ? */
  networkObserved: boolean;
  durationMs: number;
}

/** Le verdict d'un ensemble d'assertions : un échec obligatoire l'emporte, puis ce qui n'a pas pu être vérifié. */
export function verdictOf(assertions: readonly AssertionResult[]): BusinessVerdict {
  const mandatory = assertions.filter((assertion) => assertion.mandatory);
  if (mandatory.length === 0) return 'NOT_DECLARED';
  const has = (status: AssertionStatus): boolean =>
    mandatory.some((assertion) => assertion.status === status);
  if (has('FAIL')) return 'FAIL';
  if (has('BLOCKED')) return 'BLOCKED';
  if (has('UNVERIFIABLE')) return 'UNVERIFIABLE';
  if (has('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}
