import { describeGoal, type GoalState } from '../goals/goal-model.js';

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
  'adaptive',
  'rules',
  'functional',
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
  /** AdaptiveScoring (intelligence.adaptiveScoring) : 0 quand désactivé ou sans historique. */
  adaptive: number;
  /** Couverture de règles (rules.influenceDecisionEngine) : 0 sans règle à vérifier. */
  rules: number;
  /** Objectifs de test (functionalIntelligence.testGoals.influenceDecisionEngine) : 0 sans objectif. */
  functional: number;
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
  'history-confidence': {
    en: 'historical success trusted at {confidence} ({observations} execution(s))',
    fr: 'succès historique pris à {confidence} ({observations} exécution(s))',
  },
  'rarely-explored': {
    en: 'rarely explored before (novelty {novelty}: {detail})',
    fr: 'peu explorée auparavant (nouveauté {novelty} : {detail})',
  },
  'rule-coverage': {
    en: 'RULE_COVERAGE: {field} = {value} would verify {count} expectation(s) ({expectations})',
    fr: 'RULE_COVERAGE : {field} = {value} vérifierait {count} attente(s) ({expectations})',
  },
  'field-influence': {
    en: 'influential field {field} ({dependencies} dependent(s), {unverified} unverified rule(s))',
    fr: 'champ influent {field} ({dependencies} dépendance(s), {unverified} règle(s) non vérifiée(s))',
  },
  'test-goal-progress': { en: '{reason}', fr: '{reason}' },
  'functional-coverage': { en: '{reason}', fr: '{reason}' },
  'unstable-history': {
    en: 'unstable history (stability {stability}, confidence {confidence}: {detail})',
    fr: 'historique instable (stabilité {stability}, confiance {confidence} : {detail})',
  },
} as const satisfies Record<string, { en: string; fr: string }>;
export type ScoreReasonCode = keyof typeof TEMPLATES;

/** Le texte d'une raison, avec ses points : « +70 goal relevance: create user ». */
export function renderReason(reason: ScoreReason, language: 'en' | 'fr' = 'en'): string {
  const template: string = TEMPLATES[reason.code][language];
  const params = { ...reason.params };
  // L'objectif est décrit dans la langue du rapport (sa description est en anglais).
  if (reason.code === 'goal-relevance' && typeof params.kind === 'string')
    params.goal = describeGoal(
      {
        kind: params.kind as GoalState['kind'],
        id: String(params.goal ?? ''),
        ...(params.subject !== undefined ? { subject: String(params.subject) } : {}),
        ...(params.concept !== undefined ? { concept: String(params.concept) } : {}),
      },
      language,
    );
  // Règle de catégorie (« category:menu ») : dite comme une catégorie d'action.
  if (
    reason.code === 'pattern-rule' &&
    typeof params.rule === 'string' &&
    params.rule.startsWith('category:')
  )
    params.rule =
      language === 'fr'
        ? `de catégorie ${params.rule.slice('category:'.length)}`
        : `${params.rule.slice('category:'.length)} category`;
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''));
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

/** Le total et ses composantes non nulles : « 312 = base 200 + goal 88 − adaptive 12 ». */
export function scoreEquation(breakdown: ScoreBreakdown): string {
  const terms = SCORE_FACTORS.filter((factor) => breakdown[factor] !== 0).map((factor, index) => {
    const sign = breakdown[factor] < 0 ? '−' : '+';
    return `${index === 0 ? (sign === '−' ? '−' : '') : `${sign} `}${factor} ${Math.abs(breakdown[factor])}`;
  });
  return `${breakdown.total} = ${terms.join(' ') || '0'}`;
}

/** L'explication complète d'un score : l'équation, puis chaque raison (anglais ou français). */
export function explainScore(breakdown: ScoreBreakdown, language: 'en' | 'fr' = 'en'): string {
  const reasons = breakdown.details.map((reason) => renderReason(reason, language));
  return `${scoreEquation(breakdown)}${reasons.length > 0 ? ` — ${reasons.join('; ')}` : ''}`;
}
