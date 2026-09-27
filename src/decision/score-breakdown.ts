/** Les composantes du score d'une action. */
export const SCORE_FACTORS = [
  'base',
  'goal',
  'pattern',
  'novelty',
  'history',
  'coverage',
  'risk',
  'repetition',
] as const;
export type ScoreFactor = (typeof SCORE_FACTORS)[number];

/**
 * Une raison du score, structurée : son code et ses paramètres sont traduits à
 * l'affichage (anglais ou français), jamais figés dans une langue.
 */
export interface ScoreReason {
  factor: ScoreFactor;
  points: number;
  code: ScoreReasonCode;
  /** Paramètres du message (objectif, motif, nombres…). */
  params?: Record<string, string | number>;
}

/** Pourquoi une action a reçu son score : chaque composante, le total, et les raisons. */
export interface ScoreBreakdown {
  base: number;
  goal: number;
  pattern: number;
  novelty: number;
  history: number;
  coverage: number;
  risk: number;
  repetition: number;
  total: number;
  /** Raisons lisibles (anglais), dans l'ordre des composantes. */
  reasons: string[];
  /** Les mêmes raisons, structurées (traduites dans les rapports). */
  details: ScoreReason[];
}

const TEMPLATES = {
  base: { en: 'base score ({detail})', fr: 'score de base ({detail})' },
  'goal-relevance': { en: 'goal relevance: {goal}', fr: 'pertinence pour l’objectif : {goal}' },
  'pattern-rule': { en: '{pattern}: {rule} action', fr: '{pattern} : action {rule}' },
  'never-explored': { en: 'never explored', fr: 'jamais explorée' },
  'likely-new-state': { en: 'likely new state ({target})', fr: 'nouvel état probable ({target})' },
  'learned-hint': {
    en: 'usually leads to {pattern} ({count}/{total})',
    fr: 'mène d’habitude à {pattern} ({count}/{total})',
  },
  'novel-screen': { en: 'novel screen ({detail})', fr: 'écran nouveau ({detail})' },
  'historical-success': { en: 'historical success ({rate} %)', fr: 'succès historique ({rate} %)' },
  'failure-history': {
    en: '{failures} failure(s) in a row on {version}',
    fr: '{failures} échec(s) de suite sur {version}',
  },
  'failure-history-new-version': {
    en: 'failed on an older version ({failures}×), new chance',
    fr: 'échecs sur une ancienne version ({failures}×), nouvelle chance',
  },
  'coverage-gain': { en: 'low coverage of {area} ({ratio} %)', fr: 'zone {area} peu couverte ({ratio} %)' },
  'mutation-risk': { en: 'mutation risk', fr: 'risque de modification' },
  'unknown-risk': { en: 'unknown effect', fr: 'effet inconnu' },
  'submit-risk': { en: 'submits a form', fr: 'envoie un formulaire' },
  'loop-penalty': { en: 'loop detected ({detail})', fr: 'boucle détectée ({detail})' },
  'already-used': { en: 'already used {count}× in this run', fr: 'déjà utilisée {count}× pendant ce run' },
} as const satisfies Record<string, { en: string; fr: string }>;
export type ScoreReasonCode = keyof typeof TEMPLATES;

/** Le texte d'une raison, avec ses points : « +70 goal relevance: create user ». */
export function renderReason(reason: ScoreReason, language: 'en' | 'fr' = 'en'): string {
  const template: string = TEMPLATES[reason.code][language];
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => String(reason.params?.[key] ?? ''));
  return `${reason.points > 0 ? '+' : ''}${reason.points} ${text}`;
}

/** Assemble la décomposition à partir des raisons. */
export function breakdownOf(details: readonly ScoreReason[]): ScoreBreakdown {
  const sums = Object.fromEntries(SCORE_FACTORS.map((factor) => [factor, 0])) as Record<ScoreFactor, number>;
  for (const reason of details) sums[reason.factor] += reason.points;
  const total = SCORE_FACTORS.reduce((sum, factor) => sum + sums[factor], 0);
  const ordered = [...details].sort(
    (a, b) => SCORE_FACTORS.indexOf(a.factor) - SCORE_FACTORS.indexOf(b.factor),
  );
  return {
    ...sums,
    total,
    reasons: ordered.map((reason) => renderReason(reason)),
    details: ordered,
  };
}
