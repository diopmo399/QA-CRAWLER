import { actionLabel, type DiscoveredAction } from '../model/discovered-action.js';
import { KeywordMatcher } from '../policies/keywords.js';

/** Boutons qui font avancer un formulaire sans <form> (« Suivant », « Continuer »). */
const FORWARD = new KeywordMatcher([
  'next',
  'next step',
  'continue',
  'suivant',
  'etape suivante',
  'continuer',
]);

/**
 * Les champs à remplir avant de cliquer sur `action` : ceux de son <form> ; sans <form>
 * (Angular, fenêtre, page monopage), ceux de son groupe de formulaire, quand le bouton
 * valide ou fait avancer ce formulaire. Un champ sans libellé en fait partie comme les autres.
 */
export function formFieldsFor(
  action: DiscoveredAction,
  actions: readonly DiscoveredAction[],
): DiscoveredAction[] {
  if (action.type !== 'click') return [];
  const sameForm =
    action.formIndex !== undefined
      ? (candidate: DiscoveredAction) => candidate.formIndex === action.formIndex
      : action.formGroup !== undefined &&
          (action.submitsForm === true ||
            action.category === 'submit' ||
            action.category === 'form-step' ||
            FORWARD.match(actionLabel(action)) !== undefined)
        ? (candidate: DiscoveredAction) => candidate.formGroup === action.formGroup
        : undefined;
  if (!sameForm) return [];
  return actions.filter(
    (candidate) =>
      candidate.visible &&
      !candidate.disabled &&
      (candidate.type === 'fill' || candidate.type === 'select' || candidate.type === 'check') &&
      sameForm(candidate),
  );
}

/** Le nom d'un champ pour le rapport : son libellé, sinon son nom, son indication, ou « champ sans libellé ». */
export function fieldLabel(field: DiscoveredAction): string {
  return (
    field.label || field.name || field.field?.placeholder || field.text || `${field.elementType} (no label)`
  );
}
