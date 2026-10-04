import type { SemanticRecordedAction } from './model.js';

/**
 * DUPLICATE TARGET ACTION : deux actions CONSÉCUTIVES du même type sur la même identité de cible,
 * sans action entre elles. Signalées, jamais supprimées : une correction humaine (« fill A » puis
 * « fill A » avec une autre valeur) est légitime ; seule l'explication change.
 */
export type DuplicateClassification =
  /** Deux saisies rapprochées dans le même champ : la normalisation aurait pu les consolider. */
  | 'TYPING_CONSOLIDATION_CANDIDATE'
  /** L'humain est revenu corriger le champ (un délai, une autre valeur). */
  | 'HUMAN_CORRECTION'
  /** Le même clic / choix répété. */
  | 'REPEATED_ACTION';

export interface DuplicateTargetAction {
  firstActionId: string;
  secondActionId: string;
  type: string;
  target: string;
  classification: DuplicateClassification;
  reasons: string[];
}

/** L'identité fonctionnelle de la cible : jamais un CSS fragile seul (SAME CSS ≠ SAME FIELD). */
export function targetIdentityKey(action: SemanticRecordedAction): string | undefined {
  const target = action.target;
  if (!target) return undefined;
  const fingerprint = target.fingerprint ?? {};
  const scope = fingerprint.section ?? fingerprint.dialog ?? '';
  if (fingerprint.testId) return `testId:${fingerprint.testId}`;
  if (fingerprint.formControl) return `formControl:${scope}:${fingerprint.formControl}`;
  if (fingerprint.semanticId) return `semantic:${fingerprint.semanticId}`;
  if (fingerprint.label) return `label:${scope}:${fingerprint.label}`;
  if (target.quality === 'FRAGILE') return undefined;
  return `locator:${JSON.stringify(target.target)}`;
}

const CONSOLIDATION_WINDOW_MS = 1500;

export function detectDuplicateTargetActions(
  actions: readonly SemanticRecordedAction[],
): DuplicateTargetAction[] {
  const found: DuplicateTargetAction[] = [];
  for (let index = 1; index < actions.length; index += 1) {
    const previous = actions[index - 1];
    const current = actions[index];
    if (!previous || !current || previous.type !== current.type) continue;
    const key = targetIdentityKey(previous);
    if (!key || key !== targetIdentityKey(current)) continue;
    const gap = current.at - previous.at;
    const fill = current.type === 'FILL';
    const classification: DuplicateClassification = !fill
      ? 'REPEATED_ACTION'
      : gap <= CONSOLIDATION_WINDOW_MS
        ? 'TYPING_CONSOLIDATION_CANDIDATE'
        : 'HUMAN_CORRECTION';
    found.push({
      firstActionId: previous.id,
      secondActionId: current.id,
      type: current.type,
      target: current.target?.label ?? key,
      classification,
      reasons: [
        `same target identity (${key})`,
        `${String(gap)} ms apart, no action in between`,
        classification === 'HUMAN_CORRECTION'
          ? 'kept: the human came back to the field (the last value wins at replay)'
          : 'kept: never removed automatically',
      ],
    });
  }
  return found;
}
