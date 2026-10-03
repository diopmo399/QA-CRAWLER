/**
 * RECORDING VALIDATION ≠ REPLAY RECOVERY.
 *
 * Pendant l'enregistrement, l'action humaine est DÉJÀ exécutée : la valider, c'est prouver
 * qu'elle a été bien comprise, jamais la refaire ni la « réparer » comme un rejeu en échec.
 * Trois questions distinctes, jamais fusionnées :
 *
 *   1. TARGET IDENTITY  — quel élément l'humain a-t-il utilisé ? (preuves AVANT l'action)
 *   2. ACTION EFFECT    — qu'a produit l'action ? (l'écran APRÈS : une preuve complémentaire)
 *   3. FUNCTIONAL GOAL  — le but fonctionnel de l'action est-il atteint ?
 *
 * GOAL_ALREADY_REACHED ne valide pas une cible ; un effet confirmé non plus ; un localisateur
 * devenu périmé après l'action ne prouve pas que l'humain a visé le mauvais élément.
 */
export const ValidationMode = {
  /** L'action humaine est déjà faite : lecture seule, aucun rejeu, aucune récupération. */
  RECORDING: 'RECORDING',
  /** Un rejeu : la récupération par objectif (RecoveryEngine) y a sa place. */
  REPLAY: 'REPLAY',
} as const;
export type ValidationMode = (typeof ValidationMode)[keyof typeof ValidationMode];

/** Ce qui est interdit en mode RECORDING (jamais une seconde action, jamais une récupération). */
export const RECORDING_FORBIDDEN_OPERATIONS = [
  'click',
  'fill',
  'type',
  'press',
  'selectOption',
  'check',
  'uncheck',
  'dragTo',
  'dispatchEvent',
  'submit',
  'goal-based-recovery',
] as const;

/**
 * D'où vient la preuve d'IDENTITÉ, par priorité : le nœud original au moment exact de
 * l'action, son instantané pré-action, le contexte pré-action, l'empreinte capturée avant
 * toute mutation, une reconstruction déterministe, puis le conseiller (revalidé). L'effet et
 * l'objectif n'y figurent pas : ils ne prouvent jamais l'identité.
 */
export type TargetIdentitySource =
  | 'ORIGINAL_HUMAN_TARGET'
  | 'PRE_ACTION_TARGET_SNAPSHOT'
  | 'PRE_ACTION_CONTEXT'
  | 'TARGET_FINGERPRINT'
  | 'DETERMINISTIC_RECONSTRUCTION'
  | 'ADVISOR_REVALIDATED'
  | 'NONE';

export type ActionEffectStatus = 'CONFIRMED' | 'NOT_OBSERVED' | 'NOT_VERIFIABLE';
export type FunctionalGoalStatus = 'REACHED' | 'NOT_OBSERVED' | 'UNKNOWN';

/** Les trois verdicts d'une action enregistrée, chacun avec SES preuves. */
export interface RecordingVerdict {
  mode: typeof ValidationMode.RECORDING;
  target: { status: string; source: TargetIdentitySource; confidence: number; reason: string };
  effect: { status: ActionEffectStatus; evidence: string[] };
  goal: { status: FunctionalGoalStatus; evidence: string[] };
}

/**
 * Le but fonctionnel suit l'effet observé ; il n'a AUCUNE influence sur la cible (et aucun
 * statut de récupération ne peut l'y faire entrer).
 */
export function goalOf(
  effect: RecordingVerdict['effect'],
  semanticId: string | undefined,
): RecordingVerdict['goal'] {
  if (effect.status === 'CONFIRMED')
    return {
      status: 'REACHED',
      evidence: [...(semanticId ? [`${semanticId} applied`] : []), ...effect.evidence],
    };
  return { status: effect.status === 'NOT_OBSERVED' ? 'NOT_OBSERVED' : 'UNKNOWN', evidence: [] };
}

/** Le but fonctionnel nommé par le regroupement sémantique (filter.value…), connu après la capture. */
export function withSemanticGoal(
  goal: RecordingVerdict['goal'],
  semanticId: string | undefined,
): RecordingVerdict['goal'] {
  if (!semanticId || goal.status !== 'REACHED' || goal.evidence.some((line) => line.startsWith(semanticId)))
    return goal;
  return { ...goal, evidence: [`${semanticId} applied`, ...goal.evidence] };
}
