import type { LocatorDescriptor } from '../model/locator.js';
import type { UiElement } from '../model/ui-snapshot.js';

/** Roles Playwright's getByRole can target reliably. */
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
 * Most robust serializable locator for an element:
 * 1. testId (data-testid & co), 2. role + accessible name,
 * 3. label (form fields), 4. visible text, 5. CSS as last resort.
 */
export function buildLocator(element: UiElement): LocatorDescriptor {
  if (element.testId) return { strategy: 'testId', value: element.testId };
  // Named through its web component (label attribute, slot): Playwright may compute another name.
  // The CSS path pierces the component's shadow root.
  if (element.labelledByHost) return { strategy: 'css', value: element.css };
  if (ROLE_LOCATABLE.has(element.role) && element.name) {
    return { strategy: 'role', role: element.role, name: element.name, exact: true };
  }
  if (FIELD_TAGS.has(element.tag) && element.label)
    return { strategy: 'label', value: element.label, exact: true };
  if (!FIELD_TAGS.has(element.tag) && element.text)
    return { strategy: 'text', value: element.text, exact: true };
  return { strategy: 'css', value: element.css };
}

/** Canonical key of a descriptor (without nth), used to detect ambiguous locators. */
export function locatorKey(locator: LocatorDescriptor): string {
  return [locator.strategy, locator.role ?? '', locator.name ?? '', locator.value ?? ''].join('|');
}

/**
 * Builds locators for all elements of a snapshot, adding `nth` when several
 * elements share the same descriptor (e.g. ten "Voir" buttons in a table).
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
