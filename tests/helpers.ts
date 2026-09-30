import { parseConfig } from '../src/config/config-loader.js';
import type { ScenarioConfig } from '../src/config/config.js';
import { ActionDiscovery } from '../src/discovery/action-discovery.js';
import type { PageContext } from '../src/model/page-context.js';
import type { PageStructure, UiElement, UiSnapshot } from '../src/model/ui-snapshot.js';
import { StateDetector } from '../src/observation/state-detector.js';
import { SafetyPolicy } from '../src/policies/safety-policy.js';
import type { StaticAnalyzerOptions } from '../src/static-analysis/static-analyzer.js';

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

/**
 * Un écran observé tel que le moteur le reçoit (StateDetector + ActionDiscovery →
 * PageContext), à partir d'un instantané. `structure` : la forme de l'écran.
 */
export function screen(overrides: Partial<UiSnapshot>, config: ScenarioConfig = testConfig()): PageContext {
  const shot = snapshot(overrides);
  const state = new StateDetector(config.exploration.queryParams.mode).detect(shot);
  const actions = new ActionDiscovery(new SafetyPolicy(config.safety)).discover(shot, state.stateId);
  return {
    url: shot.url,
    title: shot.title,
    stateId: state.stateId,
    stateLabel: state.label,
    route: state.route,
    headings: shot.headings,
    dialogs: shot.dialogs,
    actions,
    forms: shot.forms,
    errors: [],
    ...(shot.structure ? { structure: shot.structure } : {}),
    metadata: { depth: 0, timestamp: '2026-09-27T10:00:00Z', flow: [state.stateId] },
  };
}

/** Structure d'écran par défaut (rien), avec des surcharges. */
export function structure(overrides: Partial<PageStructure> = {}): PageStructure {
  return {
    tables: 0,
    tableRows: 0,
    columnHeaders: [],
    lists: 0,
    cards: 0,
    breadcrumbs: [],
    regions: [],
    wizardSteps: 0,
    fileInputs: 0,
    pagination: false,
    ...overrides,
  };
}

/** Options de l'analyseur statique pour les tests (toutes les analyses, budgets larges). */
export function staticAnalyzerOptions(overrides: Partial<StaticAnalyzerOptions> = {}): StaticAnalyzerOptions {
  return {
    applicationId: 'fixture',
    features: {
      routes: true,
      forms: true,
      validators: true,
      dtoMapping: true,
      httpCalls: true,
      dataFlow: true,
    },
    analyzers: { angular: true, genericJs: true },
    budgets: { maxFiles: 500, maxDurationMs: 30_000, maxFileSizeBytes: 2_000_000, maxAstNodes: 5_000_000 },
    ...overrides,
  };
}
