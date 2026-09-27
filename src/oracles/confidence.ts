/**
 * Catégories de résultat : un comportement inhabituel n'est PAS automatiquement un bug.
 *
 * - CONFIRMED_FAILURE : échec technique certain (HTTP 5xx, plantage, action impossible) ;
 * - CONTRACT_VIOLATION : réponse non déclarée par le contrat OpenAPI ;
 * - INVARIANT_VIOLATION : une règle explicite de la mission n'est pas respectée ;
 * - POTENTIAL_REGRESSION : différent de la baseline / de l'historique, vers un écran d'erreur ;
 * - UNEXPECTED_BEHAVIOR : inhabituel par rapport à l'historique, sans être une erreur ;
 * - UNKNOWN : pas assez d'informations.
 */
export const VERDICT_CATEGORIES = [
  'CONFIRMED_FAILURE',
  'CONTRACT_VIOLATION',
  'INVARIANT_VIOLATION',
  'POTENTIAL_REGRESSION',
  'UNEXPECTED_BEHAVIOR',
  'UNKNOWN',
] as const;
export type VerdictCategory = (typeof VERDICT_CATEGORIES)[number];

/**
 * D'où vient la confiance d'un verdict, de la plus forte à la plus faible. Le rapport
 * affiche la source : « invariant explicite », « contrat OpenAPI », « historique (18/19) »…
 */
export const CONFIDENCE_SOURCES = {
  /** Règle écrite par l'équipe (invariants). */
  'explicit-invariant': 0.95,
  /** Fait technique observé (statut 5xx, plantage de la page). */
  'technical-fact': 0.9,
  /** Contrat d'API (OpenAPI). */
  'openapi-contract': 0.85,
  /** Baseline enregistrée par un run LEARN. */
  baseline: 0.7,
  /** Transition vue de nombreuses fois (confiance ajustée au nombre d'observations). */
  'repeated-history': 0.65,
  /** Une seule observation passée. */
  'single-observation': 0.3,
  /** Heuristique de texte (bannière « erreur », libellé). */
  'text-heuristic': 0.3,
} as const;
export type ConfidenceSource = keyof typeof CONFIDENCE_SOURCES;

/**
 * La confiance d'une source. Pour l'historique, elle grandit avec le nombre
 * d'observations (plafonnée sous celle d'une règle explicite) : 1 observation → faible,
 * 20 → moyenne/forte.
 */
export function confidenceOf(source: ConfidenceSource, observations?: number): number {
  const base = CONFIDENCE_SOURCES[source];
  if (source !== 'repeated-history' || observations === undefined) return base;
  if (observations <= 1) return CONFIDENCE_SOURCES['single-observation'];
  return Math.round(Math.min(0.8, 0.3 + 0.5 * Math.min(1, observations / 20)) * 100) / 100;
}

/** Libellé lisible d'une source de confiance (rapports). */
export const CONFIDENCE_SOURCE_LABELS: Record<'en' | 'fr', Record<ConfidenceSource, string>> = {
  en: {
    'explicit-invariant': 'explicit invariant',
    'technical-fact': 'technical fact',
    'openapi-contract': 'OpenAPI contract',
    baseline: 'baseline',
    'repeated-history': 'repeated history',
    'single-observation': 'single observation',
    'text-heuristic': 'text heuristic',
  },
  fr: {
    'explicit-invariant': 'invariant explicite',
    'technical-fact': 'fait technique',
    'openapi-contract': 'contrat OpenAPI',
    baseline: 'baseline',
    'repeated-history': 'historique répété',
    'single-observation': 'observation unique',
    'text-heuristic': 'heuristique de texte',
  },
};

/** La catégorie d'un avis d'oracle : selon l'oracle qui le donne et son statut. */
export function categoryOf(
  oracle: string,
  status: 'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN',
): VerdictCategory | undefined {
  if (status === 'PASS') return undefined;
  if (status === 'UNKNOWN') return 'UNKNOWN';
  switch (oracle) {
    case 'technical':
      return status === 'FAIL' ? 'CONFIRMED_FAILURE' : 'UNEXPECTED_BEHAVIOR';
    case 'contract':
      return 'CONTRACT_VIOLATION';
    case 'invariant':
      return 'INVARIANT_VIOLATION';
    case 'baseline':
      return 'POTENTIAL_REGRESSION';
    case 'historical':
      return status === 'FAIL' ? 'POTENTIAL_REGRESSION' : 'UNEXPECTED_BEHAVIOR';
    case 'ui':
      return status === 'FAIL' ? 'CONFIRMED_FAILURE' : 'UNEXPECTED_BEHAVIOR';
    default:
      return status === 'FAIL' ? 'CONFIRMED_FAILURE' : 'UNEXPECTED_BEHAVIOR';
  }
}
