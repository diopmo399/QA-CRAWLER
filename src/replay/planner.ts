import type { StepFunctionalIntent } from '../config/flow-schema.js';
import type { ScreenControl } from '../workflow-healing/model.js';
import { labelSimilarity, RECOVERY_ROLES, round } from '../workflow-healing/similarity.js';
import type { PlanCandidate, ReplayPlan } from './model.js';

export interface PlannerInput {
  /** L'action enregistrée : son geste, son rôle, son libellé. */
  original: { kind: string; role?: string; label: string };
  intent?: StepFunctionalIntent;
  /** L'objectif de l'étape (FunctionalGoal.id ou le nom de l'intention). */
  goal: string;
  /** Les contrôles à l'écran maintenant. */
  controls: readonly ScreenControl[];
  /** Les résolutions apprises (déjà pondérées), et celles à éviter. */
  historical?: { candidates: readonly PlanCandidate[]; avoid: readonly string[] };
  /** Formes équivalentes d'un terme (SemanticDictionary). */
  synonyms?: (term: string) => readonly string[];
  /** Seuil d'un candidat sémantique (défaut 0.6) et marge d'ambiguïté (défaut 0.12). */
  thresholds?: { semantic?: number; margin?: number };
}

const DEFAULT_SEMANTIC = 0.6;
const DEFAULT_MARGIN = 0.12;

/** Mots qui disent une intention d'interface, par geste UI enregistré : ils rapprochent un candidat de l'objectif. */
const CANCEL_WORDS = /\b(cancel|annuler|close|fermer|back|retour)\b/i;
const UI_WORDS: Record<string, RegExp> = {
  SEARCH: /\b(search|find|rechercher|chercher|lookup|run|lancer|go)\b/i,
  FILTER: /\b(filter|filtrer|refine|affiner)\b/i,
  SUBMIT: /\b(submit|send|envoyer|soumettre|validate|valider|confirm|confirmer|finish|terminer)\b/i,
  SAVE: /\b(save|enregistrer|sauvegarder|store)\b/i,
  CONFIRM: /\b(confirm|confirmer|ok|yes|accept|accepter)\b/i,
  CANCEL: CANCEL_WORDS,
  OPEN_DIALOG: /\b(edit|modifier|open|ouvrir|new|nouveau|nouvelle|add|ajouter|create|cr[ée]er|details?)\b/i,
  NEXT: /\b(next|suivant|continue|continuer)\b/i,
  DELETE: /\b(delete|supprimer|remove|retirer)\b/i,
  NAVIGATE: /\b(go|aller|open|ouvrir|view|voir)\b/i,
};

/** Les intentions d'interface qu'un libellé exprime (SEARCH, SUBMIT, OPEN_DIALOG…), par ses mots. */
export function uiIntentsOfLabel(label: string): string[] {
  return Object.entries(UI_WORDS)
    .filter(([, words]) => words.test(label))
    .map(([kind]) => kind);
}

/** Un libellé qui dit l'abandon (cancel, close, back…). */
export function saysCancel(label: string): boolean {
  return CANCEL_WORDS.test(label);
}

/**
 * REPLAY PLANNER : à une étape, « quelle action à l'écran permet le mieux d'atteindre l'objectif ? »
 *
 *   RECORDED   — la cible enregistrée est là : c'est elle (jamais autre chose).
 *   HISTORICAL — une résolution apprise dans ce contexte est à l'écran : proposée d'abord.
 *   SEMANTIC   — un contrôle du même genre, au libellé proche ou qui dit la même intention UI.
 *   NONE       — rien de convaincant ; AMBIGUOUS quand deux candidats sont aussi plausibles.
 *
 * Le planificateur n'exécute rien : l'explorateur juge le candidat (SafetyPolicy), l'exécute et
 * laisse l'effet runtime confirmer. Un champ de saisie n'est jamais un candidat de remplacement.
 */
export function planReplayAction(input: PlannerInput): ReplayPlan {
  const reasons: string[] = [];
  const semanticThreshold = input.thresholds?.semantic ?? DEFAULT_SEMANTIC;
  const margin = input.thresholds?.margin ?? DEFAULT_MARGIN;
  const visible = input.controls.filter((control) => control.visible && !control.field && !control.disabled);
  const avoid = new Set((input.historical?.avoid ?? []).map((signature) => signature.toLowerCase()));
  const candidates: PlanCandidate[] = [];

  // 1. RECORDED : la cible enregistrée elle-même.
  const recorded = visible.find(
    (control) =>
      labelSimilarity(control.name, input.original.label, input.synonyms) >= 0.99 &&
      (!input.original.role || control.role === input.original.role),
  );
  if (recorded) {
    const candidate: PlanCandidate = {
      role: recorded.role,
      name: recorded.name,
      source: 'RECORDED',
      score: 1,
      reasons: ['the recorded target is on screen'],
    };
    return {
      goal: input.goal,
      choice: 'RECORDED',
      selected: candidate,
      candidates: [candidate],
      ambiguous: false,
      reasons: ['recorded target present: nothing else is considered'],
    };
  }
  reasons.push(`recorded target "${input.original.label}" not on screen`);

  // 2. HISTORICAL : une résolution apprise, présente à l'écran, non évitée.
  for (const learned of input.historical?.candidates ?? []) {
    const onScreen = visible.find(
      (control) => control.role === learned.role && labelSimilarity(control.name, learned.name) >= 0.95,
    );
    if (!onScreen || avoid.has(`${learned.role}:${learned.name}`.toLowerCase())) continue;
    candidates.push({
      ...learned,
      name: onScreen.name,
      score: round(Math.min(0.97, 0.6 + learned.score * 0.4)),
      reasons: [...learned.reasons, 'present on screen'],
    });
  }

  // 3. SEMANTIC : même genre de contrôle, libellé proche ou intention UI commune.
  const uiKind = input.intent?.ui ?? '';
  const words = UI_WORDS[uiKind];
  const compatibleRole = (control: ScreenControl): boolean =>
    !input.original.role ||
    control.role === input.original.role ||
    (RECOVERY_ROLES.has(control.role) && RECOVERY_ROLES.has(input.original.role));
  for (const control of visible) {
    if (!RECOVERY_ROLES.has(control.role) || !compatibleRole(control)) continue;
    if (avoid.has(`${control.role}:${control.name}`.toLowerCase())) continue;
    if (candidates.some((candidate) => candidate.role === control.role && candidate.name === control.name))
      continue;
    const similarity = labelSimilarity(control.name, input.original.label, input.synonyms);
    const saysIntent = words ? words.test(control.name) : false;
    const contradicts = uiKind !== 'CANCEL' && CANCEL_WORDS.test(control.name) && !saysIntent;
    let score = similarity;
    const why: string[] = [];
    if (similarity > 0) why.push(`label similarity ${String(similarity)}`);
    if (saysIntent) {
      score = Math.max(score, 0.55) + 0.2;
      why.push(`says the recorded intent ${uiKind}`);
    }
    if (contradicts) {
      score -= 0.4;
      why.push('contradicts the intent (cancel / close / back)');
    }
    if (control.role !== input.original.role && input.original.role) {
      score -= 0.1;
      why.push(`another role (${control.role})`);
    }
    score = round(Math.max(0, Math.min(0.9, score)));
    if (score >= semanticThreshold * 0.5)
      candidates.push({ role: control.role, name: control.name, source: 'SEMANTIC', score, reasons: why });
  }
  candidates.sort((a, b) => b.score - a.score);
  const [best, second] = candidates;
  if (!best)
    return {
      goal: input.goal,
      choice: 'NONE',
      candidates,
      ambiguous: false,
      reasons: [...reasons, 'no candidate on screen'],
    };
  const threshold = best.source === 'HISTORICAL' ? 0.5 : semanticThreshold;
  if (best.score < threshold)
    return {
      goal: input.goal,
      choice: 'NONE',
      candidates,
      ambiguous: false,
      reasons: [
        ...reasons,
        `best candidate ${best.role}:${best.name} scores ${String(best.score)} < ${String(threshold)}`,
      ],
    };
  const ambiguous =
    second !== undefined &&
    best.score - second.score < margin &&
    second.source !== 'HISTORICAL' &&
    best.source !== 'HISTORICAL';
  if (ambiguous)
    return {
      goal: input.goal,
      choice: 'NONE',
      candidates,
      ambiguous: true,
      reasons: [
        ...reasons,
        `AMBIGUOUS: ${best.role}:${best.name} (${String(best.score)}) and ${second.role}:${second.name} (${String(second.score)}) are as plausible — nothing chosen arbitrarily`,
      ],
    };
  return {
    goal: input.goal,
    choice: best.source === 'HISTORICAL' ? 'HISTORICAL' : 'SEMANTIC',
    selected: best,
    candidates,
    ambiguous: false,
    reasons: [
      ...reasons,
      `${best.source} ${best.role}:${best.name} (${String(best.score)}): ${best.reasons.join(', ')}`,
    ],
  };
}
