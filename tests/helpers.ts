import { parseConfig } from '../src/config/config-loader.js';
import type { ScenarioConfig } from '../src/config/config.js';
import type { UiElement, UiSnapshot } from '../src/model/ui-snapshot.js';

/** Configuration complète, valeurs par défaut appliquées, pour http://localhost:4200, avec des ajouts YAML facultatifs. */
export function testConfig(extraYaml = ''): ScenarioConfig {
  return parseConfig(`target:\n  baseUrl: http://localhost:4200\n${extraYaml}`, {}, {}).config;
}

let index = 0;

/** UiElement avec des valeurs par défaut raisonnables (un bouton visible et actif). */
export function element(overrides: Partial<UiElement>): UiElement {
  index += 1;
  return {
    index,
    tag: 'button',
    role: 'button',
    name: '',
    text: '',
    visible: true,
    disabled: false,
    readOnly: false,
    hasPopup: false,
    required: false,
    isSubmit: false,
    inSearchForm: false,
    formHasAction: false,
    inNavigation: false,
    inDialog: false,
    css: `button:nth-of-type(${index})`,
    ...overrides,
  };
}

export const button = (name: string, overrides: Partial<UiElement> = {}): UiElement =>
  element({ tag: 'button', role: 'button', name, text: name, ...overrides });

export const link = (name: string, href: string, overrides: Partial<UiElement> = {}): UiElement =>
  element({ tag: 'a', role: 'link', name, text: name, href, ...overrides });

export const field = (label: string, overrides: Partial<UiElement> = {}): UiElement =>
  element({ tag: 'input', role: 'textbox', name: label, label, inputType: 'text', ...overrides });

export function snapshot(overrides: Partial<UiSnapshot>): UiSnapshot {
  return {
    url: 'http://localhost:4200/',
    title: 'App',
    headings: [],
    dialogs: [],
    selectedTabs: [],
    currentItems: [],
    textExcerpt: '',
    elements: [],
    forms: [],
    ...overrides,
  };
}
