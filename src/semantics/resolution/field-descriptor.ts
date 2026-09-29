import { fieldOf, fieldTypeOf } from '../../forms/form-analyzer.js';
import type { DiscoveredAction } from '../../model/discovered-action.js';
import type { LocatorDescriptor } from '../../model/locator.js';
import { isDynamicId } from './normalize.js';

export interface FieldOption {
  label: string;
  disabled: boolean;
  /** « -- Choisir -- » : pas un vrai choix. */
  placeholder: boolean;
}

/**
 * Ce que la résolution sémantique sait d'un champ de l'écran. Construit à partir de ce
 * que l'ActionDiscovery et le FormAnalyzer décrivent déjà (DiscoveredAction.field,
 * fieldOf) : aucune nouvelle lecture du DOM. Jamais la valeur du champ.
 */
export interface FieldDescriptor {
  /** L'id de l'action (stable d'un run à l'autre). */
  id: string;
  label?: string;
  name?: string;
  /** Attribut id du DOM, s'il n'est pas généré par le framework. */
  idAttribute?: string;
  placeholder?: string;
  /** Nom accessible, quand il diffère du libellé. */
  ariaLabel?: string;
  autocomplete?: string;
  /** Type du FormAnalyzer : text, email, date, number, select, combobox, checkbox, radio… */
  type: string;
  role?: string;
  required: boolean;
  disabled: boolean;
  options?: FieldOption[];
  sensitive: boolean;
  payment: boolean;
  /** Texte voisin : libellé du groupe, aide, fenêtre. */
  nearbyText: string[];
  groupLabel?: string;
  choiceGroup?: string;
  formGroup?: string;
  foreground: boolean;
  locator: LocatorDescriptor;
  /** L'action découverte, pour l'exécution (qui repasse par la SafetyPolicy). */
  action: DiscoveredAction;
}

const FIELD_ACTIONS = new Set(['fill', 'select', 'check', 'uncheck']);

/** Les champs visibles de l'écran, décrits pour la résolution. */
export function fieldDescriptors(actions: readonly DiscoveredAction[]): FieldDescriptor[] {
  return actions.filter((action) => FIELD_ACTIONS.has(action.type) && action.visible).map(describeField);
}

export function describeField(action: DiscoveredAction): FieldDescriptor {
  const form = fieldOf(action);
  const constraints = action.field;
  const nearby = [constraints?.groupLabel, constraints?.hint, action.dialogName].filter(
    (text): text is string => Boolean(text),
  );
  const idAttribute =
    constraints?.elementId && !isDynamicId(constraints.elementId) ? constraints.elementId : undefined;
  return {
    id: action.id,
    ...(form.label ? { label: form.label } : {}),
    ...(form.name ? { name: form.name } : {}),
    ...(idAttribute ? { idAttribute } : {}),
    ...(form.placeholder ? { placeholder: form.placeholder } : {}),
    ...(constraints?.accessibleName ? { ariaLabel: constraints.accessibleName } : {}),
    ...(constraints?.autocomplete ? { autocomplete: constraints.autocomplete } : {}),
    type: fieldTypeOf(action),
    ...(action.role ? { role: action.role } : {}),
    required: form.required,
    disabled: action.disabled || action.obscured === true,
    ...(form.options ? { options: form.options } : {}),
    sensitive: form.sensitive,
    payment: form.payment,
    nearbyText: nearby,
    ...(form.groupLabel ? { groupLabel: form.groupLabel } : {}),
    ...(form.choiceGroup ? { choiceGroup: form.choiceGroup } : {}),
    ...(action.formGroup ? { formGroup: action.formGroup } : {}),
    foreground: action.foreground === true,
    locator: action.locator,
    action,
  };
}
