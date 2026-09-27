import type { LocatorDescriptor } from '../model/locator.js';
import type { UiElement } from '../model/ui-snapshot.js';

/** Rôles que getByRole de Playwright peut cibler de façon fiable. */
const ROLE_LOCATABLE = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'checkbox',
  'radio',
  'option',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
]);

const FIELD_TAGS = new Set(['input', 'select', 'textarea']);

/**
 * Localisateur sérialisable le plus robuste pour un élément :
 * 1. testId (data-testid et apparentés), 2. rôle + nom accessible,
 * 3. libellé (champs de formulaire), 4. texte visible, 5. CSS en dernier recours.
 */
export function buildLocator(element: UiElement): LocatorDescriptor {
  if (element.testId) return { strategy: 'testId', value: element.testId };
  // Libellé deviné (texte voisin, attribut label ou slot d'un composant) : Playwright ne le
  // connaît pas. Le chemin CSS (qui traverse les shadow roots) trouve l'élément lui-même.
  if (element.labelGuessed) return { strategy: 'css', value: element.css };
  if (ROLE_LOCATABLE.has(element.role) && element.name) {
    return { strategy: 'role', role: element.role, name: element.name, exact: true };
  }
  if (FIELD_TAGS.has(element.tag) && element.label)
    return { strategy: 'label', value: element.label, exact: true };
  if (!FIELD_TAGS.has(element.tag) && element.text)
    return { strategy: 'text', value: element.text, exact: true };
  return { strategy: 'css', value: element.css };
}

/** Clé canonique d'un descripteur (sans nth), pour détecter les localisateurs ambigus. */
export function locatorKey(locator: LocatorDescriptor): string {
  return [locator.strategy, locator.role ?? '', locator.name ?? '', locator.value ?? ''].join('|');
}

/**
 * Construit les localisateurs de tous les éléments d'un instantané, en ajoutant
 * `nth` quand plusieurs éléments partagent le même descripteur (par exemple dix boutons « Voir » dans un tableau).
 */
export function buildLocators(elements: readonly UiElement[]): LocatorDescriptor[] {
  const descriptors = elements.map((element) => buildLocator(element));
  const totals = new Map<string, number>();
  for (const descriptor of descriptors) {
    const key = locatorKey(descriptor);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return descriptors.map((descriptor) => {
    const key = locatorKey(descriptor);
    if ((totals.get(key) ?? 0) <= 1 || descriptor.strategy === 'css') return descriptor;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    return { ...descriptor, nth };
  });
}
