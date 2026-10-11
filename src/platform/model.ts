/**
 * QA PLATFORM — MODÈLE COMMUN de l'analyse d'un run de workflow.
 *
 * Tout ce que la plateforme produit (anomalies, graphe observé, couverture, API, visuel,
 * performance, acteurs, régression, reproductions) partage le même vocabulaire :
 *
 *   - une PROVENANCE : d'où vient la conclusion (runtime > static > historique > LLM) ;
 *   - une CONCLUSION expliquée : Conclusion / Evidence / Confidence / Source — jamais une
 *     narration de raisonnement ;
 *   - un STATUT GLOBAL en cinq valeurs.
 *
 * Aucun secret, aucune valeur saisie : ce modèle ne reçoit que ce que les moteurs ont déjà
 * jugé publiable (chemins masqués, clés de données, libellés).
 */

/** D'où vient une conclusion. L'ordre est celui de la priorité : le runtime l'emporte toujours. */
export const PROVENANCES = ['RUNTIME', 'CONTRACT', 'RECORDING', 'STATIC', 'HISTORICAL', 'LLM'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Une conclusion explicable : ce qui est conclu, sur quelles preuves, avec quelle confiance, d'où. */
export interface Finding {
  conclusion: string;
  evidence: string[];
  /** 0..1 */
  confidence: number;
  source: Provenance;
}

export const OVERALL_STATUSES = ['PASS', 'PASS_WITH_WARNINGS', 'DEGRADED', 'FAIL', 'INCONCLUSIVE'] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];

/** FAST PATH : rien d'anormal, l'analyse profonde n'est pas déroulée ; DEEP PATH : au moins un signal l'exige. */
export type AnalysisPath = 'FAST' | 'DEEP';

export const ANOMALY_CATEGORIES = [
  'UI_FAILURE',
  'FUNCTIONAL_FAILURE',
  'API_FAILURE',
  'NETWORK_FAILURE',
  'CONTRACT_FAILURE',
  'PERFORMANCE_REGRESSION',
  'VISUAL_REGRESSION',
  'AUTHORIZATION_FAILURE',
  'DATA_FAILURE',
  'EXPECTED_VALIDATION',
  'EXPECTED_BUSINESS_REJECTION',
  'TECHNICAL_FAILURE',
  'UNKNOWN_FAILURE',
] as const;
export type AnomalyCategory = (typeof ANOMALY_CATEGORIES)[number];

/** Les catégories qui ne sont PAS des défauts : l'application a refusé comme elle doit. */
export const EXPECTED_CATEGORIES: readonly AnomalyCategory[] = [
  'EXPECTED_VALIDATION',
  'EXPECTED_BUSINESS_REJECTION',
];

export const REGRESSION_STATUSES = [
  'NEW_REGRESSION',
  'REGRESSION_PERSISTING',
  'REGRESSION_FIXED',
  'FLAKY_BEHAVIOR',
  'KNOWN_FAILURE',
  'NEW_BEHAVIOR',
  'EXPECTED_CHANGE',
] as const;
export type RegressionStatus = (typeof REGRESSION_STATUSES)[number];

export type AnomalySeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

/** Où une anomalie a été vue : le flow, l'étape, l'écran. */
export interface AnomalyLocation {
  flow?: string;
  step?: number;
  stateId?: string;
  /** URL masquée de l'écran. */
  url?: string;
}

/**
 * Une ANOMALIE DU RUN : le symptôme (ce qui a été observé), la cause probable (par règles ou par
 * les moteurs) et, quand une preuve directe l'établit, la cause confirmée. Les trois sont
 * toujours distingués.
 */
export interface RunAnomaly {
  id: string;
  category: AnomalyCategory;
  severity: AnomalySeverity;
  symptom: string;
  probableCause?: Finding;
  confirmedCause?: Finding;
  evidence: string[];
  /** 0..1 : la confiance dans la CATÉGORIE. */
  confidence: number;
  source: Provenance;
  location: AnomalyLocation;
  /** Les écrans depuis le départ (libellés), quand ils sont connus. */
  reproductionPath?: string[];
  /** Les anomalies (issues) du run qui portent ce symptôme. */
  issueIds: string[];
  /** Posé par le RegressionAnalyzer (phase 9). */
  regression?: RegressionStatus;
  /** Posé par le conseiller d'ambiguïté (phase 17) : un avis, jamais une décision. */
  advisory?: { status: 'ADVISORY' | 'REJECTED' | 'UNAVAILABLE' | 'DISABLED'; text?: string; reason?: string };
}

/** Compte par valeur d'une énumération, sans trou. */
export function countBy<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

/** Arrondi à deux décimales (confiances, pourcentages). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
