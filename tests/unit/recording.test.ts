import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import { GherkinStepDictionary, valueOf } from '../../src/flows/gherkin/gherkin-steps.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { dedupeNetwork, sanitize } from '../../src/recording/human-flow-recorder.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedState,
  RecordedValueFacts,
  RecordingSession,
} from '../../src/recording/model.js';
import { normalizeRecording } from '../../src/recording/normalizer.js';
import { optimizeRecordedActions } from '../../src/recording/flow-optimizer.js';
import { inferOutcomes, stableRoute } from '../../src/recording/outcomes.js';
import { processRecording } from '../../src/recording/process-recording.js';
import { resolveRecordedTarget } from '../../src/recording/recorded-target.js';
import { resolveSemanticActions } from '../../src/recording/semantic-recording.js';
import { classifyRecordedValue, testDataKey } from '../../src/recording/value-classifier.js';
import { parseRecordArgs } from '../../src/cli/record-command.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';

const { config } = parseConfig(
  'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /users }\n',
  {},
  {},
);
const safety = new SafetyPolicy(config.safety);
const CREDENTIALS = { usernameEnv: 'QA_USERNAME', passwordEnv: 'QA_PASSWORD' };

function element(overrides: Partial<RecordedElement> = {}): RecordedElement {
  return {
    tag: 'input',
    role: 'textbox',
    name: 'Email',
    label: 'Email',
    css: 'form > div:nth-of-type(2) > input',
    cssStable: false,
    inForm: true,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 1,
    ...overrides,
  };
}

function button(name: string, overrides: Partial<RecordedElement> = {}): RecordedElement {
  return element({ tag: 'button', role: 'button', name, label: undefined, text: name, ...overrides });
}

function facts(overrides: Partial<RecordedValueFacts> = {}): RecordedValueFacts {
  return { empty: false, length: 8, shape: 'text', digest: '0123456789abcdef', ...overrides };
}

function state(id: string, route: string, overrides: Partial<RecordedState> = {}): RecordedState {
  return {
    id,
    stateId: `${route.replace(/\W+/g, '-')}-x`,
    label: route,
    route,
    url: `http://app.test${route}`,
    title: route,
    headings: [],
    alerts: [],
    invalidFields: 0,
    dialogs: [],
    controls: [],
    ...overrides,
  };
}

let sequence = 0;
function raw(
  type: RawRecordedEvent['type'],
  at: number,
  extra: Partial<RawRecordedEvent> = {},
): RawRecordedEvent {
  sequence += 1;
  return { id: `r${String(sequence)}`, sequence, type, at, url: 'http://app.test/users/new', ...extra };
}

describe('recorded target (locator preference)', () => {
  it('prefers the field label over generated ids and positions', () => {
    const target = resolveRecordedTarget(element({ elementId: 'mat-input-23', generatedId: true }), 'field');
    expect(target.target).toEqual({ strategy: 'label', value: 'Email' });
    expect(target.quality).toBe('SEMANTIC');
    expect(JSON.stringify(target.alternatives)).not.toContain('mat-input-23');
  });

  it('uses role + accessible name for a button', () => {
    const target = resolveRecordedTarget(button('Save'), 'click');
    expect(target.target).toEqual({ strategy: 'role', role: 'button', name: 'Save' });
    expect(target.quality).toBe('SEMANTIC');
  });

  it('a name shared by several elements gives way to a stable attribute', () => {
    const target = resolveRecordedTarget(button('Edit', { sameRoleName: 3, testId: 'edit-user' }), 'click');
    expect(target.target).toEqual({ strategy: 'testId', value: 'edit-user' });
    expect(target.ambiguous).toBe(false);
    expect(target.reasons.join(' ')).toContain('not unique');
  });

  it('without any stable attribute, a shared name is AMBIGUOUS (with its position)', () => {
    const target = resolveRecordedTarget(button('Edit', { sameRoleName: 3, roleNameIndex: 2 }), 'click');
    expect(target.ambiguous).toBe(true);
    expect(target.target).toEqual({ strategy: 'role', role: 'button', name: 'Edit', nth: 2 });
  });

  it('a test id carried by another attribute than data-testid is targeted by that attribute', () => {
    const qa = resolveRecordedTarget(
      element({ label: undefined, name: '', testId: 'Reference_input', testIdAttribute: 'data-qa' }),
      'field',
    );
    expect(qa.target).toEqual({ strategy: 'css', value: '[data-qa="Reference_input"]' });
    const standard = resolveRecordedTarget(
      element({ label: undefined, name: '', testId: 'Reference_input', testIdAttribute: 'data-testid' }),
      'field',
    );
    expect(standard.target).toEqual({ strategy: 'testId', value: 'Reference_input' });
  });

  it('formControlName is a framework binding, a position is FRAGILE', () => {
    const bound = resolveRecordedTarget(
      element({ label: undefined, name: '', formControlName: 'firstName' }),
      'field',
    );
    expect(bound.quality).toBe('FRAMEWORK_BINDING');
    const fragile = resolveRecordedTarget(element({ label: undefined, name: '' }), 'field');
    expect(fragile.quality).toBe('FRAGILE');
  });
});

describe('value classification (no typed value is ever kept)', () => {
  it('passwords and sign-in identifiers become environment references', () => {
    expect(
      classifyRecordedValue(
        element({ inputType: 'password', label: 'Password', name: 'Password' }),
        facts({ sensitive: true }),
        CREDENTIALS,
      ),
    ).toMatchObject({
      class: 'SENSITIVE_REFERENCE',
      env: 'QA_PASSWORD',
      sensitive: true,
    });
    expect(
      classifyRecordedValue(element({ autocomplete: 'username', label: 'Username' }), facts(), CREDENTIALS),
    ).toMatchObject({
      class: 'SENSITIVE_REFERENCE',
      env: 'QA_USERNAME',
    });
    expect(
      classifyRecordedValue(element({ label: 'API key', name: 'API key' }), facts(), CREDENTIALS).class,
    ).toBe('SENSITIVE_REFERENCE');
  });

  it('a choice of the screen is a business literal; an unchanged value is no step; free text is test data', () => {
    expect(
      classifyRecordedValue(
        element({ tag: 'select', role: 'combobox' }),
        facts({ option: { label: 'Business', value: 'BUSINESS' } }),
        CREDENTIALS,
      ),
    ).toMatchObject({
      class: 'LITERAL_BUSINESS_VALUE',
      literal: 'Business',
    });
    expect(
      classifyRecordedValue(element(), facts({ initialDigest: '0123456789abcdef' }), CREDENTIALS).class,
    ).toBe('PREEXISTING_VALUE');
    expect(
      classifyRecordedValue(element({ inputType: 'email' }), facts({ shape: 'email' }), CREDENTIALS),
    ).toMatchObject({
      class: 'GENERATED_TEST_DATA',
      testData: 'email',
    });
  });

  it('test data keys follow the meaning of the field, then its name, then its shape', () => {
    expect(testDataKey(element({ label: 'First name', name: 'First name' }))).toBe('firstName');
    expect(testDataKey(element({ label: 'Amount', name: 'Amount' }), facts({ shape: 'number' }))).toBe(
      'amount',
    );
    expect(testDataKey(element({ label: undefined, name: '' }), facts({ shape: 'number' }))).toBe('number');
    // Un test id technique dit aussi le nom (et parfois le sens) du champ.
    expect(testDataKey(element({ label: undefined, name: '', testId: 'BranchCode_input' }))).toBe(
      'branchCode',
    );
    expect(testDataKey(element({ label: undefined, name: '', testId: 'PrenomContact_input' }))).toBe(
      'firstName',
    );
    expect(testDataKey(element({ label: undefined, name: '', formControlName: 'legalEntityCode' }))).toBe(
      'legalEntityCode',
    );
  });
});

describe('semantic resolution', () => {
  it('a custom list opened then an option chosen is one SELECT', () => {
    const events = [
      raw('click', 1000, {
        element: element({
          tag: 'mat-select',
          role: 'combobox',
          name: 'Account type',
          label: 'Account type',
          customSelect: true,
        }),
      }),
      raw('click', 1400, {
        element: element({ tag: 'mat-option', role: 'option', name: 'Business', label: undefined }),
      }),
    ];
    const { actions } = resolveSemanticActions(events, safety);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'SELECT',
      option: 'Business',
      rawEventIds: [events[0]?.id, events[1]?.id],
    });
  });

  it('the click on a submit button and its form submission are one SUBMIT; focus clicks are noise', () => {
    const events = [
      raw('click', 900, { element: element(), noise: 'focus click in a field' }),
      raw('click', 1000, { element: button('Save', { isSubmit: true }) }),
      raw('submit', 1010, { element: button('Save', { isSubmit: true }) }),
    ];
    const resolution = resolveSemanticActions(events, safety);
    expect(resolution.noise).toBe(1);
    expect(resolution.actions).toHaveLength(1);
    expect(resolution.actions[0]).toMatchObject({ type: 'SUBMIT', classification: 'MUTATION' });
  });

  it('an input started before another field keeps its place (the browser commits it on leaving the field)', () => {
    const events = [
      raw('change', 3000, {
        element: element({ tag: 'select', role: 'combobox', name: 'Type', label: 'Type' }),
        value: facts({ option: { label: 'A' } }),
      }),
      raw('change', 3100, { element: element(), value: facts({ startedAt: 2000 }) }),
    ];
    const { actions } = resolveSemanticActions(events, safety);
    expect(actions.map((action) => action.type)).toEqual(['FILL', 'SELECT']);
  });
});

describe('recording normalizer', () => {
  const normalize = (events: RawRecordedEvent[], states: RecordedState[] = []) => {
    const semantic = resolveSemanticActions(events, safety, states[0]?.id);
    return normalizeRecording(semantic.actions, events, states, semantic.noise, CREDENTIALS);
  };

  it('merges successive inputs and keeps only the corrected value of a field', () => {
    const email = element();
    const name = element({ name: 'First name', label: 'First name' });
    const result = normalize([
      raw('input', 1000, { element: email, value: facts({ digest: 'aaaaaaaaaaaaaaaa' }) }),
      raw('change', 1500, { element: email, value: facts({ digest: 'bbbbbbbbbbbbbbbb' }) }),
      raw('change', 2000, { element: name, value: facts() }),
      raw('change', 2500, { element: email, value: facts({ digest: 'cccccccccccccccc', shape: 'email' }) }),
    ]);
    expect(result.kept.map((action) => action.target?.label)).toEqual(['First name', 'Email']);
    expect(result.stats.mergedInputs).toBe(1);
    expect(result.stats.collapsedCorrections).toBe(1);
    expect(result.kept[1]?.value?.testData).toBe('email');
    expect(result.actions.filter((action) => action.dropped)).toHaveLength(2);
  });

  it('a box checked then unchecked is no step; a navigation caused by a click is no step', () => {
    const box = element({
      tag: 'input',
      role: 'checkbox',
      inputType: 'checkbox',
      name: 'Newsletter',
      label: 'Newsletter',
    });
    const result = normalize([
      raw('navigation', 500),
      raw('change', 1000, { element: box, value: facts({ checked: true }) }),
      raw('change', 1500, { element: box, value: facts({ checked: false }) }),
      raw('click', 2000, { element: button('Next') }),
      raw('navigation', 2300, { url: 'http://app.test/users/step-2' }),
    ]);
    expect(result.kept.map((action) => action.type)).toEqual(['NAVIGATE', 'CLICK']);
  });

  it('keeps a tab opened by the human (no shortest path); only the separate optimizer proposes to remove the detour', () => {
    const states = [
      state('o1', '/users', { controls: ['tab:Users', 'tab:Reports', 'button:Add user'] }),
      state('o2', '/reports', { controls: ['tab:Users', 'tab:Reports'] }),
      state('o3', '/users/new', { controls: ['button:Save'] }),
    ];
    const result = normalize(
      [
        raw('click', 1000, {
          element: button('Reports', { role: 'tab', inNavigation: true }),
          stateAfter: 'o2',
        }),
        raw('click', 4000, { element: button('Add user'), stateAfter: 'o3' }),
      ],
      states,
    );
    expect(result.kept.map((action) => action.target?.label)).toEqual(['Reports', 'Add user']);
    expect(result.stats.removedDetours).toBe(0);
    const optimized = optimizeRecordedActions(result.kept, states);
    expect(optimized.kept.map((action) => action.target?.label)).toEqual(['Add user']);
    expect(optimized.removed).toEqual([
      expect.objectContaining({ label: 'Reports', reason: expect.stringMatching(/^detour/) as unknown }),
    ]);
    // Le parcours humain n'est jamais modifié par l'optimiseur.
    expect(result.kept).toHaveLength(2);
  });

  it('never removes an action that wrote, even as a correction', () => {
    const save = button('Save', { isSubmit: true });
    const result = normalize([
      raw('click', 1000, {
        element: button('Reports', { role: 'tab' }),
        network: [{ method: 'POST', path: '/api/audit', status: 201 }],
      }),
      raw('click', 1500, { element: save }),
    ]);
    expect(result.kept).toHaveLength(2);
  });

  it('an invalid attempt corrected without a checkpoint is left out (AMBIGUOUS_RECORDING_INTENT)', () => {
    const save = button('Save', { isSubmit: true });
    const states = [
      state('o1', '/users/new'),
      state('o2', '/users/new', { invalidFields: 1, alerts: ['Email is required'] }),
      state('o3', '/users'),
    ];
    const result = normalize(
      [
        raw('click', 1000, {
          element: save,
          stateAfter: 'o2',
          network: [{ method: 'POST', path: '/api/users', status: 400 }],
        }),
        raw('change', 3000, { element: element(), value: facts({ shape: 'email' }) }),
        raw('click', 5000, {
          element: save,
          stateAfter: 'o3',
          network: [{ method: 'POST', path: '/api/users', status: 201 }],
        }),
      ],
      states,
    );
    expect(result.negative).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('AMBIGUOUS_RECORDING_INTENT');
    expect(result.kept.map((action) => action.type)).toEqual(['FILL', 'SUBMIT']);
  });
});

describe('outcomes and assertion candidates', () => {
  it('an accepted write is a STABLE, selected API outcome and names the workflow', () => {
    const states = [
      state('o1', '/users/new', { controls: ['button:Save'] }),
      state('o2', '/users', { controls: ['button:Add user'], alerts: ['User 42 created'] }),
    ];
    const semantic = resolveSemanticActions(
      [
        raw('click', 1000, {
          element: button('Save', { isSubmit: true }),
          stateAfter: 'o2',
          network: [
            {
              method: 'POST',
              path: '/api/users',
              status: 201,
              responseState: { field: 'status', code: 'ACTIVE' },
            },
          ],
        }),
      ],
      safety,
      'o1',
    );
    const { assertions, intent } = inferOutcomes(semantic.actions, states, false);
    expect(intent.workflow).toBe('CREATE:USER');
    expect(assertions).toContainEqual(
      expect.objectContaining({ kind: 'API_OUTCOME', stability: 'STABLE', selected: true }),
    );
    // /users/new contient /users : l'URL ne prouve rien, le bouton « Add user » oui.
    expect(assertions).toContainEqual(
      expect.objectContaining({ kind: 'ROUTE', expect: { url: '/users' }, selected: false }),
    );
    expect(assertions).toContainEqual(
      expect.objectContaining({
        expect: { visible: { strategy: 'role', role: 'button', name: 'Add user' } },
        selected: true,
      }),
    );
    // Un message qui contient une donnée est FRAGILE : jamais dans le flow.
    expect(assertions).toContainEqual(
      expect.objectContaining({ kind: 'MESSAGE', stability: 'FRAGILE', selected: false }),
    );
  });

  it('stable routes drop record ids', () => {
    expect(stableRoute('/users/42/edit')).toBe('/users/');
    expect(stableRoute('/#/users/42')).toBe('/users/');
    expect(stableRoute('/users?page=2')).toBe('/users');
  });
});

describe('one model → flow.yaml and .feature', () => {
  const session = (events: RawRecordedEvent[], states: RecordedState[]): RecordingSession => ({
    id: 'rec-test',
    name: 'Create user',
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: 'http://app.test/users',
    status: 'PROCESSING',
    rawEvents: events,
    semanticActions: [],
    checkpoints: [],
    states,
    initialStateId: states[0]?.id,
    warnings: [],
    droppedEvents: 0,
  });

  it('the feature reads back to the same steps as the YAML', () => {
    const states = [
      state('o1', '/users', { controls: ['button:Add user'] }),
      state('o2', '/users/new', { controls: ['button:Save'] }),
      state('o3', '/users', { controls: ['button:Add user'] }),
    ];
    const events = [
      raw('navigation', 100, { url: 'http://app.test/users', stateAfter: 'o1' }),
      raw('click', 1000, { url: 'http://app.test/users', element: button('Add user'), stateAfter: 'o2' }),
      raw('change', 2000, {
        element: element({ name: 'First name', label: 'First name' }),
        value: facts(),
        stateAfter: 'o2',
      }),
      raw('change', 3000, {
        element: element({ tag: 'select', role: 'combobox', name: 'Account type', label: 'Account type' }),
        value: facts({ option: { label: 'Business', value: 'BUSINESS' } }),
        stateAfter: 'o2',
      }),
      raw('change', 3500, {
        element: element({
          tag: 'input',
          role: 'radio',
          inputType: 'radio',
          name: 'Monthly',
          label: 'Monthly',
        }),
        value: facts({ checked: true, option: { label: 'Monthly' } }),
        stateAfter: 'o2',
      }),
      raw('click', 4000, {
        element: button('Save', { isSubmit: true }),
        stateAfter: 'o3',
        network: [{ method: 'POST', path: '/api/users', status: 201 }],
      }),
    ];
    for (const language of ['fr', 'en'] as const) {
      const result = processRecording(session(events, states), config, { language });
      const yaml = flowSchema.parse(withoutDataFile(result.files.yaml));
      const dictionary = new GherkinStepDictionary();
      const fromFeature = result.files.feature
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^(Quand|Et|Alors|Étant donné que|When|And|Then|Given)\s/.test(line))
        .flatMap(
          (line) =>
            dictionary.translate(
              line.replace(/^(Étant donné que|Quand|Et|Alors|Given|When|And|Then)\s+/, ''),
            ) ?? [{ unknown: line }],
        );
      const parsed = flowSchema.parse({ name: 'x', steps: fromFeature });
      const shape = (steps: typeof yaml.steps): unknown[] =>
        // Les effets appris et l'empreinte de la cible sont dans le YAML seulement (le .feature se vérifie à l'exécution).
        steps.map(({ allow: _a, optional: _o, name: _n, effects: _e, fingerprint: _f, ...rest }) => rest);
      expect(shape(parsed.steps), language).toEqual(shape(yaml.steps));
      expect(yaml.steps).toContainEqual(
        expect.objectContaining({ kind: 'check', target: { strategy: 'label', value: 'Monthly' } }),
      );
    }
  });

  it('a target that only a selector reaches becomes an intent in both files', () => {
    const events = [
      raw('click', 1000, {
        element: button('Dark mode', { role: 'switch', text: undefined, testId: 'dark-mode' }),
      }),
    ];
    const result = processRecording(session(events, [state('o1', '/users')]), config, { language: 'en' });
    expect(result.files.yaml).toContain('kind: CLICK');
    expect(result.files.feature).toContain('I click on "Dark mode"');
  });

  it('a field without any name keeps its selector: never an intent on "input"', () => {
    const events = [
      raw('change', 1000, {
        element: element({ label: undefined, name: '', css: '#search', cssStable: true }),
        value: facts(),
      }),
    ];
    const result = processRecording(session(events, [state('o1', '/users')]), config, { language: 'en' });
    expect(result.files.yaml).not.toContain('field: input');
    expect(result.files.yaml).toContain('css: "#search"');
  });

  it('a field labelled only by the text just before it becomes an intent with that text', () => {
    const events = [
      raw('change', 1000, {
        element: element({ label: undefined, name: '', guessedLabel: 'Branch code', css: 'div > input' }),
        value: facts(),
      }),
    ];
    const result = processRecording(session(events, [state('o1', '/users')]), config, { language: 'en' });
    expect(result.files.yaml).toContain('field: Branch code');
    expect(result.files.feature).toContain('Branch code');
  });

  it('a large recording is processed quickly (no heavy analysis per event)', () => {
    const events: RawRecordedEvent[] = [];
    for (let index = 0; index < 3000; index += 1)
      events.push(
        raw('change', index * 10, {
          element: element({ name: `Field ${String(index % 40)}`, label: `Field ${String(index % 40)}` }),
          value: facts(),
        }),
      );
    const started = Date.now();
    const result = processRecording(session(events, [state('o1', '/users')]), config, { language: 'en' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.flow.steps.length).toBeLessThanOrEqual(40);
  });
});

describe('page data is untrusted', () => {
  it('keeps only known event types, bounded texts and well-formed digests', () => {
    expect(sanitize({ type: 'eval', url: 'x' })).toBeUndefined();
    expect(sanitize('click')).toBeUndefined();
    const event = sanitize({
      type: 'change',
      url: 'http://app.test/?token=abc',
      element: { tag: 'input', role: 'textbox', name: 'x'.repeat(500), css: 'input', sameRoleName: 'NaN' },
      value: {
        empty: false,
        length: 3,
        shape: 'weird',
        digest: 'not-a-digest',
        option: { label: 'A' },
        sensitive: true,
      },
    });
    expect(event?.element?.name.length).toBeLessThanOrEqual(120);
    expect(event?.element?.sameRoleName).toBe(0);
    expect(event?.value?.shape).toBe('text');
    expect(event?.value?.digest).toBeUndefined();
    expect(event?.value?.option).toBeUndefined();
  });

  it('a request seen in two network windows belongs to the most recent action', () => {
    const shared = { method: 'POST', path: '/api/users', status: 201 };
    const events = [raw('click', 1, { network: [shared] }), raw('click', 2, { network: [shared] })];
    dedupeNetwork(events);
    expect(events[0]?.network).toEqual([]);
    expect(events[1]?.network).toEqual([shared]);
  });
});

describe('configuration, flow values and CLI', () => {
  it('recording: has safe defaults and recording.enabled=false refuses to record', async () => {
    expect(config.recording).toMatchObject({
      enabled: true,
      outputFormat: 'both',
      overlay: true,
      recordAfterAuthentication: true,
      validate: false,
    });
    const missionFile = new URL('../fixtures/recording-disabled.yaml', import.meta.url).pathname;
    await expect(runRecording({ name: 'x', missionFile })).rejects.toThrow(/disabled/i);
  });

  it('{ testData } is a flow value, <testData:key> its Gherkin form', () => {
    const flow = flowSchema.parse({
      name: 'x',
      steps: [{ fill: { label: 'Email', value: { testData: 'email' } } }],
    });
    expect(flow.steps[0]).toMatchObject({ kind: 'fill', value: { testData: 'email' } });
    expect(valueOf('<testData:email>')).toEqual({ testData: 'email' });
    expect(valueOf('<env:QA_PASSWORD>')).toEqual({ env: 'QA_PASSWORD' });
  });

  it('parses the record command', () => {
    expect(
      parseRecordArgs([
        '--url',
        'http://app.test/users',
        '--name',
        'Create user',
        '--output-format',
        'yaml',
        '--validate',
      ]),
    ).toMatchObject({
      url: 'http://app.test/users',
      name: 'Create user',
      outputFormat: 'yaml',
      validate: true,
      headless: false,
    });
    expect(() => parseRecordArgs(['--output-format', 'pdf'])).toThrow(/yaml, gherkin or both/);
  });
});

/** Le flow généré, sans son fichier de données (test-data.yaml, écrit à côté par l'enregistreur). */
function withoutDataFile(yaml: string): unknown {
  const raw = parseYaml(yaml) as Record<string, unknown>;
  delete raw.testData;
  return raw;
}
