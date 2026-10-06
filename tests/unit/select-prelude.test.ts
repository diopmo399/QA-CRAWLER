import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { RawRecordedEvent, RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';
import { normalizeRecording } from '../../src/recording/normalizer.js';
import { validateRecordingConsistency } from '../../src/recording/recording-consistency.js';

/**
 * SELECT PRELUDE : l'humain clique l'enveloppe d'une liste maison (un <div> sans rôle), ce qui n'affiche
 * que ses options, puis choisit dans CETTE liste. Une seule intention : le choix. Tout autre effet du
 * clic (requête, navigation, fenêtre, erreur, contrôle non-option) le garde comme étape.
 */
const config = parseConfig(
  `mission: { name: prelude }\ntarget: { baseUrl: "http://app.test", startAt: / }\n`,
  {},
  {},
).config;

const state = (id: string, controls: string[], extra: Partial<RecordedState> = {}): RecordedState => ({
  id,
  stateId: id,
  label: '/form',
  route: '/form',
  url: 'http://app.test/form',
  title: 'Form',
  headings: [],
  alerts: [],
  invalidFields: 0,
  dialogs: [],
  controls,
  ...extra,
});
const BEFORE = state('s1', ['combobox:Country', 'button:Save']);
const OPEN = state('s2', ['combobox:Country', 'button:Save', 'option:Canada', 'option:France']);

const action = (
  id: string,
  type: 'CLICK' | 'SELECT',
  label: string,
  extra: Partial<SemanticRecordedAction> = {},
): SemanticRecordedAction =>
  ({
    id,
    type,
    at: 0,
    rawEventIds: [`r${id}`],
    evidence: [],
    network: [],
    provenance: 'HUMAN_RECORDED',
    confidence: 0.9,
    url: 'http://app.test/form',
    target: {
      target: { strategy: 'text', value: label },
      quality: 'ACCESSIBLE',
      fingerprint: { tag: 'div', name: label, section: 'Address' },
      label,
      named: true,
      alternatives: [],
      ambiguous: false,
      reasons: [],
    },
    ...extra,
  }) as unknown as SemanticRecordedAction;
const raw = (id: string, tag: string, role = ''): RawRecordedEvent =>
  ({
    id,
    type: 'click',
    at: 0,
    url: 'http://app.test/form',
    element: { tag, role },
  }) as unknown as RawRecordedEvent;

const run = (
  actions: SemanticRecordedAction[],
  states: RecordedState[] = [BEFORE, OPEN],
  events: RawRecordedEvent[] = [raw('rc1', 'div')],
) => normalizeRecording(actions, events, states, 0, config.recording.credentials, true, {});

describe('SELECT PRELUDE', () => {
  it('a passive wrapper click that only showed the options, then the choice in that list: ONE step (the choice)', () => {
    const result = run([
      action('c1', 'CLICK', 'Country Canada France', { stateBefore: 's1', stateAfter: 's2' }),
      action('s1', 'SELECT', 'Country', { stateBefore: 's2', stateAfter: 's2' }),
    ]);
    expect(result.kept.map((entry) => entry.id)).toEqual(['s1']);
    expect(result.kept[0]).toMatchObject({
      stateBefore: 's1',
      merged: 'select prelude',
      rawEventIds: ['rc1', 'rs1'],
    });
    expect(result.actions.find((entry) => entry.id === 'c1')?.dropped).toMatch(/^select prelude/);
  });

  it('kept as a step: a real control (button), a request, another section, or a screen change beyond options', () => {
    const click = (extra: Partial<SemanticRecordedAction> = {}) =>
      action('c1', 'CLICK', 'Country Canada France', { stateBefore: 's1', stateAfter: 's2', ...extra });
    const select = action('s1', 'SELECT', 'Country', { stateBefore: 's2' });
    expect(run([click(), select], undefined, [raw('rc1', 'button')]).kept).toHaveLength(2);
    expect(
      run([click({ network: [{ method: 'GET', path: '/api/countries', status: 200 }] }), select]).kept,
    ).toHaveLength(2);
    const elsewhere = action('s1', 'SELECT', 'Country', { stateBefore: 's2' });
    (elsewhere.target as unknown as { fingerprint: Record<string, string> }).fingerprint.section = 'Billing';
    expect(run([click(), elsewhere]).kept).toHaveLength(2);
    const changed = state('s2', [...OPEN.controls, 'button:Delete']);
    expect(run([click(), select], [BEFORE, changed]).kept).toHaveLength(2);
  });
});

describe('TRANSIENT_SCREEN_EFFECT', () => {
  it('an AMBIGUOUS screen effect (already there before the action) is reported as a resolved transient effect, never required', () => {
    const report = validateRecordingConsistency([
      action('a1', 'CLICK', 'Details', {
        effectCausality: [
          {
            effect: '+ button:Details',
            kind: 'APPEARS',
            actionId: 'a1',
            temporalConfidence: 0.9,
            causalConfidence: 0.3,
            evidence: ['already present before this human action (a1)'],
            startedBeforeNextHumanAction: true,
            classification: 'AMBIGUOUS',
          },
        ],
      }),
    ]);
    const issue = report.actions[0]?.issues.find((entry) => entry.type === 'TRANSIENT_SCREEN_EFFECT');
    expect(issue).toMatchObject({ resolved: true, effect: '+ button:Details' });
    expect(report.actions[0]?.status).toBe('CLEAN');
  });
});
