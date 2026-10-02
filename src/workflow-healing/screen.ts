import type { UiSnapshot } from '../model/ui-snapshot.js';
import type { ScreenControl } from './model.js';

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox']);
const NOT_FIELD_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image']);

/** Les contrôles de l'écran, vus par l'analyse et le planificateur (jamais une valeur de champ). */
export function screenControlsOf(snapshot: UiSnapshot): ScreenControl[] {
  return snapshot.elements
    .filter((element) => element.role && element.name)
    .map((element) => {
      const field =
        FIELD_ROLES.has(element.role) ||
        element.tag === 'textarea' ||
        element.tag === 'select' ||
        (element.tag === 'input' && !NOT_FIELD_INPUTS.has(element.inputType ?? 'text'));
      return {
        role: element.role,
        name: element.name,
        tag: element.tag,
        visible: element.visible,
        disabled: element.disabled,
        ...(element.checked !== undefined ? { checked: element.checked } : {}),
        ...(element.selected !== undefined ? { selected: element.selected } : {}),
        ...(element.expanded !== undefined ? { expanded: element.expanded } : {}),
        inNavigation: element.inNavigation,
        ...(field ? { field: true } : {}),
      };
    });
}
