import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema, type FlowStep } from '../../src/config/flow-schema.js';
import { correlateActions } from '../../src/recording/action-correlation.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedState,
  RecordingSession,
} from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';

const APP = 'http://app.test';
const mission = (extra = ''): ReturnType<typeof parseConfig>['config'] =>
  parseConfig(`mission: { name: corr }\ntarget: { baseUrl: "${APP}", startAt: / }\n${extra}`, {}, {}).config;
const config = mission();
const OPTIONS = config.recording.actionCorrelation;

let sequence = 0;
function raw(
  type: RawRecordedEvent['type'],
  at: number,
  route: string,
  extra: Partial<RawRecordedEvent> = {},
): RawRecordedEvent {
  sequence += 1;
  return { id: `r${String(sequence)}`, sequence, type, at, url: `${APP}${route}`, ...extra };
}
function element(name: string, extra: Partial<RecordedElement> = {}): RecordedElement {
  return {
    tag: 'button',
    role: 'button',
    name,
    text: name,
    css: `#${name.replace(/\W+/g, '-')}`,
    cssStable: true,
    inForm: false,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 1,
    ...extra,
  };
}
const link = (name: string, href: string): RecordedElement =>
  element(name, { tag: 'a', role: 'link', href: `${APP}${href}`, inNavigation: true });
function state(id: string, route: string, controls: string[] = []): RecordedState {
  return {
    id,
    stateId: `${route.replace(/\W+/g, '-')}-s`,
    label: route,
    route,
    url: `${APP}${route}`,
    title: route,
    headings: [route],
    alerts: [],
    invalidFields: 0,
    dialogs: [],
    controls,
  };
}
function session(events: RawRecordedEvent[], states: RecordedState[] = [state('o1', '/')]): RecordingSession {
  return {
    id: 'rec-corr',
    name: 'Create request',
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: `${APP}/`,
    status: 'PROCESSING',
    rawEvents: events,
    semanticActions: [],
    checkpoints: [],
    states,
    initialStateId: states[0]?.id,
    warnings: [],
    droppedEvents: 0,
  };
}
const flowOf = (events: RawRecordedEvent[], states?: RecordedState[], cfg = config) => {
  const result = processRecording(session(events, states), cfg, { language: 'en' });
  return { result, flow: flowSchema.parse(withoutDataFile(result.files.yaml)) };
};
const kinds = (steps: FlowStep[]): string[] => steps.map((step) => step.kind);
const clickNames = (steps: FlowStep[]): string[] =>
  steps.flatMap((step) =>
    step.kind === 'click'
      ? [step.target.name ?? step.target.value ?? '']
      : step.kind === 'intent' && step.intent.kind === 'CLICK'
        ? [step.intent.target]
        : [],
  );

describe('action correlation: navigation is an effect of the human action', () => {
  it('a click followed by a navigation keeps the click; the route is its outcome, never a goto (§42)', () => {
    const events = [
      raw('navigation', 0, '/dashboard'),
      raw('click', 1000, '/dashboard', { element: link('Demandes', '/demandes'), stateAfter: 'o2' }),
      raw('navigation', 1150, '/demandes', { stateAfter: 'o2' }),
    ];
    const correlation = correlateActions(events, OPTIONS);
    expect(correlation.navigations[1]).toMatchObject({
      kind: 'EFFECT',
      causedBy: events[1]?.id,
      confidence: 'VERY_HIGH',
    });
    expect(correlation.navigations[1]?.reasons.join(' ')).toContain('links to /demandes');
    const { result, flow } = flowOf(events, [state('o1', '/dashboard'), state('o2', '/demandes')]);
    expect(kinds(flow.steps)).not.toContain('goto');
    expect(clickNames(flow.steps)).toEqual(['Demandes']);
    const click = result.normalized.kept.find((action) => action.type === 'CLICK');
    expect(click?.navigation).toMatchObject({ routes: ['/demandes'], provenance: 'RUNTIME_OBSERVED' });
    expect(click?.provenance).toBe('HUMAN_RECORDED');
  });

  it('two navigating clicks stay two clicks (§43), each with its own navigation', () => {
    const events = [
      raw('navigation', 0, '/dashboard'),
      raw('click', 1000, '/dashboard', { element: link('Demandes', '/demandes') }),
      raw('navigation', 1100, '/demandes'),
      raw('click', 4000, '/demandes', { element: element('Créer nouvelle demande') }),
      raw('navigation', 4200, '/demandes/create'),
    ];
    const { flow, result } = flowOf(events);
    expect(clickNames(flow.steps)).toEqual(['Demandes', 'Créer nouvelle demande']);
    expect(kinds(flow.steps)).not.toContain('goto');
    expect(result.correlation?.stats).toMatchObject({ navigations: 3, correlated: 2, gotos: 1 });
  });

  it('submit → POST 201 → navigation: the submit stays, with MUTATION, and the navigation is its effect (§44, §53)', () => {
    const events = [
      raw('navigation', 0, '/demandes/create'),
      raw('click', 1000, '/demandes/create', {
        element: element('Soumettre', { isSubmit: true, inForm: true }),
        network: [{ method: 'POST', path: '/api/demandes', status: 201 }],
      }),
      raw('submit', 1010, '/demandes/create', {
        element: element('Soumettre', { isSubmit: true, inForm: true }),
      }),
      raw('navigation', 3500, '/demandes/123'),
    ];
    const correlation = correlateActions(events, OPTIONS);
    expect(correlation.navigations[1]).toMatchObject({ kind: 'EFFECT', confidence: 'VERY_HIGH' });
    expect(correlation.navigations[1]?.reasons.join(' ')).toContain('POST /api/demandes');
    const { flow, result } = flowOf(events);
    expect(kinds(flow.steps)).not.toContain('goto');
    expect(flow.steps).toContainEqual(
      expect.objectContaining({
        kind: 'click',
        allow: ['MUTATION'],
        target: { strategy: 'role', role: 'button', name: 'Soumettre' },
      }),
    );
    expect(result.preservation.lostMutations).toEqual([]);
  });

  it('the first page is startAt, never a step, and no click is invented (§45)', () => {
    const result = processRecording(session([raw('navigation', 0, '/')]), config, { language: 'en' });
    expect(result.flow.startAt).toBe('/');
    expect(result.flow.steps).toEqual([]);
    expect(result.correlation?.navigations[0]).toMatchObject({
      kind: 'GOTO',
      gotoReason: 'INITIAL_NAVIGATION',
    });
  });

  it('an address typed in the address bar is a goto with DIRECT_URL_ENTRY (§46)', () => {
    const events = [
      raw('navigation', 0, '/'),
      raw('click', 500, '/', { element: element('Rafraîchir') }),
      raw('navigation', 900, '/demandes/123', { transition: 'typed' }),
    ];
    const { flow, result } = flowOf(events);
    expect(flow.steps).toContainEqual(expect.objectContaining({ kind: 'goto', url: '/demandes/123' }));
    expect(result.correlation?.navigations[1]).toMatchObject({
      kind: 'GOTO',
      gotoReason: 'DIRECT_URL_ENTRY',
    });
  });

  it('a button whose handler calls router.navigate after loading data (3 s later) keeps the click (§48)', () => {
    const events = [
      raw('navigation', 0, '/demandes'),
      raw('click', 1000, '/demandes', {
        element: element('Créer'),
        network: [{ method: 'GET', path: '/api/reference-data', status: 200 }],
      }),
      raw('navigation', 4100, '/demandes/create'),
    ];
    const correlation = correlateActions(events, OPTIONS);
    expect(correlation.navigations[1]).toMatchObject({ kind: 'EFFECT', causedBy: events[1]?.id });
    // Ancien comportement (corrélation désactivée) : le goto de ce bug.
    const off = mission('recording: { actionCorrelation: { enabled: false } }');
    expect(kinds(flowOf(events, undefined, off).flow.steps)).toEqual(['click', 'goto']);
    expect(kinds(flowOf(events).flow.steps)).toEqual(['click']);
  });

  it('a click followed by a redirect keeps the click and the whole chain (§49, §22)', () => {
    const events = [
      raw('navigation', 0, '/'),
      raw('click', 1000, '/', { element: element('Espace protégé', { tag: 'div', role: '' }) }),
      raw('navigation', 1080, '/protected'),
      raw('navigation', 1120, '/login'),
    ];
    const correlation = correlateActions(events, OPTIONS);
    expect(correlation.navigations.map((decision) => decision.kind)).toEqual(['GOTO', 'EFFECT', 'REDIRECT']);
    expect(correlation.groups[0]?.effects.navigation?.routes).toEqual(['/protected', '/login']);
    const { flow, result } = flowOf(events);
    expect(kinds(flow.steps)).toEqual(['click']);
    expect(result.normalized.kept.find((action) => action.type === 'CLICK')?.navigation?.routes).toEqual([
      '/protected',
      '/login',
    ]);
  });

  it('a navigation with no human action to explain it stays a goto with NO_CAUSAL_ACTION (§52)', () => {
    const events = [raw('navigation', 0, '/'), raw('navigation', 30_000, '/session-expired')];
    const { flow, result } = flowOf(events);
    expect(flow.steps).toContainEqual(expect.objectContaining({ kind: 'goto', url: '/session-expired' }));
    expect(result.correlation?.navigations[1]).toMatchObject({ gotoReason: 'NO_CAUSAL_ACTION' });
    expect(result.flow.steps[0]?.explanation).toContain('NO_CAUSAL_ACTION');
  });

  it('several actions before a navigation: the last meaningful one caused it (§26)', () => {
    const events = [
      raw('navigation', 0, '/wizard'),
      raw('click', 1000, '/wizard', { element: element('Type', { role: 'combobox', tag: 'mat-select' }) }),
      raw('click', 1500, '/wizard', { element: element('Business', { role: 'option', tag: 'mat-option' }) }),
      raw('click', 2500, '/wizard', { element: element('Continue') }),
      raw('navigation', 2700, '/wizard/step-2'),
    ];
    const correlation = correlateActions(events, OPTIONS);
    expect(correlation.navigations[1]?.causedBy).toBe(events[3]?.id);
  });

  it('a click on an element without a role (a tile with a click handler) that navigates is promoted, not noise', () => {
    const events = [
      raw('navigation', 0, '/'),
      raw('click', 1000, '/', {
        element: element('Demandes', { tag: 'span', role: '' }),
        noise: 'click on a non-interactive element',
      }),
      raw('navigation', 1100, '/demandes'),
    ];
    const { flow, result } = flowOf(events);
    expect(result.correlation?.promoted.has(events[1]?.id ?? '')).toBe(true);
    expect(clickNames(flow.steps)).toEqual(['Demandes']);
    expect(kinds(flow.steps)).not.toContain('goto');
  });

  it('the flow graph keeps the human transition: A -- click --> B (§51)', () => {
    const events = [
      raw('navigation', 0, '/', { stateAfter: 'o1' }),
      raw('click', 1000, '/', { element: link('Create', '/create'), stateAfter: 'o1' }),
      raw('navigation', 1100, '/create', { stateAfter: 'o2' }),
    ];
    const { result } = flowOf(events, [state('o1', '/'), state('o2', '/create')]);
    expect(
      result.graph.edges.map((edge) => [edge.from, edge.action.type, edge.action.label, edge.to]),
    ).toEqual([['--s', 'click', 'Create', '-create-s']]);
  });
});

describe('flow semantic preservation', () => {
  it('a flow made of goto while the human clicked: SUSPICIOUS_NAVIGATION_COLLAPSE (old behaviour, correlation off)', () => {
    const off = mission('recording: { actionCorrelation: { enabled: false } }');
    const events = [
      raw('navigation', 0, '/'),
      raw('click', 1000, '/', {
        element: element('Demandes', { tag: 'span', role: '' }),
        noise: 'click on a non-interactive element',
      }),
      raw('navigation', 1100, '/demandes'),
      raw('click', 2000, '/demandes', { element: element('Ouvrir') }),
      raw('navigation', 6000, '/demandes/create'),
      raw('click', 7000, '/demandes/create', { element: element('Suivant') }),
      raw('navigation', 11_000, '/demandes/create/2'),
    ];
    const { result } = flowOf(events, undefined, off);
    expect(result.warnings.map((warning) => warning.code)).toContain('SUSPICIOUS_NAVIGATION_COLLAPSE');
    // Avec la corrélation : aucun goto, aucun avertissement.
    const on = flowOf(events);
    expect(kinds(on.flow.steps)).not.toContain('goto');
    expect(on.result.warnings.map((warning) => warning.code)).not.toContain('SUSPICIOUS_NAVIGATION_COLLAPSE');
  });

  it('existing normalization is unchanged: inputs merged, corrections collapsed (§50)', () => {
    const field = element('Description', { tag: 'textarea', role: 'textbox', label: 'Description' });
    const facts = (digest: string) => ({ empty: false, length: 5, shape: 'text' as const, digest });
    const events = [
      raw('navigation', 0, '/f'),
      raw('input', 1000, '/f', { element: field, value: facts('aaaaaaaaaaaaaaaa') }),
      raw('change', 1500, '/f', { element: field, value: facts('bbbbbbbbbbbbbbbb') }),
    ];
    const { flow, result } = flowOf(events);
    expect(kinds(flow.steps)).toEqual(['fill']);
    expect(result.normalized.stats.mergedInputs).toBe(1);
  });
});

/** Le flow généré, sans son fichier de données (test-data.yaml, écrit à côté par l'enregistreur). */
function withoutDataFile(yaml: string): unknown {
  const raw = parseYaml(yaml) as Record<string, unknown>;
  delete raw.testData;
  return raw;
}
