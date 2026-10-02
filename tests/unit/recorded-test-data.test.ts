import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema, type FlowStep } from '../../src/config/flow-schema.js';
import { TestDataRunContext } from '../../src/data/test-data-run-context.js';
import { parseTestDataSet, TestDataSetError } from '../../src/data/test-data-set.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { loadDryRunScenario } from '../../src/dry-run/scenario-input.js';
import type { FunctionalExchange } from '../../src/functional/model.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedValueFacts,
  RecordingSession,
} from '../../src/recording/model.js';
import { processRecording, TEST_DATA_FILE } from '../../src/recording/process-recording.js';
import { entityOf, resolveTestDataKey } from '../../src/recording/recorded-test-data.js';

const APP = 'http://app.test';
const SALT = 'unit-salt';
const mission = (extra = ''): ReturnType<typeof parseConfig>['config'] =>
  parseConfig(`mission: { name: data }\ntarget: { baseUrl: "${APP}", startAt: / }\n${extra}`, {}, {}).config;

const digest = (value: string): string => valueDigest(value, SALT);

let sequence = 0;
let clock = 1000;
interface Recording {
  events: RawRecordedEvent[];
  typed: Map<string, string>;
}
const fresh = (): Recording => ({ events: [], typed: new Map() });

function field(name: string, extra: Partial<RecordedElement> = {}): RecordedElement {
  return {
    tag: 'input',
    role: 'textbox',
    name,
    label: name,
    css: `#${name.replace(/\W+/g, '-')}`,
    cssStable: true,
    inForm: true,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 1,
    inputType: 'text',
    ...extra,
  };
}
function push(recording: Recording, event: Omit<RawRecordedEvent, 'id' | 'sequence' | 'at' | 'url'>): string {
  sequence += 1;
  clock += 400;
  const id = `r${String(sequence)}`;
  recording.events.push({ id, sequence, at: clock, url: `${APP}/requests/new`, ...event });
  return id;
}
function type(
  recording: Recording,
  element: RecordedElement,
  value: string,
  facts: Partial<RecordedValueFacts> = {},
): void {
  const shape = /@/.test(value)
    ? 'email'
    : /^[A-Z][A-Z0-9_]+$/.test(value)
      ? 'code'
      : /^\d+$/.test(value)
        ? 'number'
        : 'text';
  const id = push(recording, {
    type: 'change',
    element,
    value: { empty: false, length: value.length, shape, digest: digest(value), ...facts },
  });
  if (!facts.sensitive) recording.typed.set(id, value);
}
function choose(recording: Recording, element: RecordedElement, label: string, code: string): void {
  push(recording, {
    type: 'change',
    element: { ...element, tag: 'select', role: 'combobox', inputType: undefined },
    value: { empty: false, length: 0, shape: 'text', option: { label, value: code } },
  });
}
function check(recording: Recording, label: string): void {
  push(recording, {
    type: 'change',
    element: field(label, { inputType: 'checkbox', role: 'checkbox' }),
    value: { empty: false, length: 0, shape: 'text', checked: true },
  });
}
function submit(recording: Recording, label: string, exchange: FunctionalExchange): void {
  push(recording, {
    type: 'click',
    element: field(label, {
      tag: 'button',
      role: 'button',
      inputType: 'submit',
      isSubmit: true,
      label: undefined,
    }),
    network: [exchange],
  });
}
const post = (
  pathName: string,
  fields: Record<string, string> = {},
  method = 'POST',
): FunctionalExchange => ({
  method,
  path: pathName,
  status: method === 'POST' ? 201 : 200,
  requestFields: Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, { type: 'string', digest: digest(value) }]),
  ),
});

function session(recording: Recording): RecordingSession {
  return {
    id: 'rec-data',
    name: 'Create request',
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: `${APP}/requests/new`,
    status: 'PROCESSING',
    rawEvents: [
      { id: 'r0', sequence: 0, type: 'navigation', at: 900, url: `${APP}/requests/new` },
      ...recording.events,
    ],
    semanticActions: [],
    checkpoints: [],
    states: [],
    warnings: [],
    droppedEvents: 0,
  };
}
const run = (recording: Recording, config = mission()) =>
  processRecording(session(recording), config, { language: 'en', typedValues: recording.typed });

/** Le flow YAML (le jeu de données est un fichier à côté : pas relu ici). */
const flowOf = (yaml: string) => {
  const raw = parseYaml(yaml) as Record<string, unknown>;
  delete raw.testData;
  return flowSchema.parse(raw);
};
const fills = (steps: FlowStep[]): unknown[] =>
  steps.flatMap((step) =>
    step.kind === 'fill'
      ? [step.value]
      : step.kind === 'intent' && step.intent.kind === 'FILL'
        ? [step.intent.value]
        : [],
  );

describe('Recorded test data: the values the human used become a TestDataSet', () => {
  it('§67: title and description recorded, contact e-mail generated, request type kept, checkbox stays a step', () => {
    const recording = fresh();
    type(recording, field('Title', { nameAttr: 'title' }), 'Imprimante bureau');
    type(
      recording,
      field('Description', { tag: 'textarea', nameAttr: 'description' }),
      "Impossible d'imprimer",
    );
    choose(recording, field('Request type', { nameAttr: 'requestType' }), 'Incident', 'INCIDENT');
    type(
      recording,
      field('Contact e-mail', { nameAttr: 'contactEmail', inputType: 'email' }),
      'test@example.com',
    );
    check(recording, 'Urgent');
    submit(
      recording,
      'Submit',
      post('/api/requests', {
        title: 'Imprimante bureau',
        description: "Impossible d'imprimer",
        contactEmail: 'test@example.com',
      }),
    );
    const result = run(recording);
    const values = result.testData?.set.values ?? {};
    expect(values['request.title']).toMatchObject({
      strategy: 'RECORDED_LITERAL',
      value: 'Imprimante bureau',
    });
    expect(values['request.description']).toMatchObject({
      strategy: 'RECORDED_LITERAL',
      value: "Impossible d'imprimer",
    });
    expect(values['request.contactEmail']).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
      generator: 'email',
    });
    expect(values['request.contactEmail']?.value).toBeUndefined();
    // Le flow cite le jeu, il ne duplique pas les valeurs.
    const flow = flowOf(result.files.yaml);
    expect(fills(flow.steps)).toEqual([
      { testData: 'request.title' },
      { testData: 'request.description' },
      { testData: 'request.contactEmail' },
    ]);
    expect(result.files.yaml).not.toContain('Imprimante');
    expect(result.files.yaml).toMatch(/^testData: test-data\.yaml$/m);
    expect(result.files.feature).toMatch(/^# testData: test-data\.yaml$/m);
    // Le choix de l'écran reste l'option du flow ; la case reste une étape (pas une donnée).
    expect(
      flow.steps.some(
        (step) => step.kind === 'select' || (step.kind === 'intent' && step.intent.kind === 'SELECT'),
      ),
    ).toBe(true);
    const items = result.testData?.items ?? [];
    expect(items.find((item) => item.field === 'Urgent')).toMatchObject({ classification: 'FLOW_BEHAVIOR' });
    expect(items.find((item) => item.field === 'Request type')).toMatchObject({
      classification: 'BUSINESS_LITERAL',
      detail: 'Incident',
    });
    // test-data.yaml : imbriqué par entité.
    expect(result.testData?.document).toMatchObject({
      name: 'Create request-recorded-data',
      source: 'HUMAN_RECORDING',
      values: {
        request: {
          title: { strategy: 'recorded', value: 'Imprimante bureau' },
          contactEmail: { strategy: 'generated', generator: 'email' },
        },
      },
    });
    expect(TEST_DATA_FILE).toBe('test-data.yaml');
  });

  it('§47 / §5: an e-mail is generated at replay; the key is the semantic identity, never a generated id', () => {
    const recording = fresh();
    type(
      recording,
      field('Courriel', { elementId: 'mat-input-17', generatedId: true, inputType: 'email' }),
      'john.smith@example.com',
    );
    type(
      recording,
      field('', { label: undefined, name: '', nameAttr: 'input3', guessedLabel: 'Prénom' }),
      'Mohamed',
    );
    const result = run(recording);
    const keys = Object.keys(result.testData?.set.values ?? {});
    expect(keys).toEqual(['email', 'firstName']);
    expect(keys.some((key) => /mat|input3/.test(key))).toBe(false);
    expect(result.testData?.set.values.email).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
      generator: 'email',
    });
    // Prénom : une donnée personnelle, générée (firstName).
    expect(result.testData?.set.values.firstName).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
      generator: 'firstName',
    });
  });

  it('§48: a business code typed as is (BUSINESS) stays a literal', () => {
    const recording = fresh();
    type(recording, field('Account type', { nameAttr: 'accountType' }), 'BUSINESS');
    const result = run(recording);
    expect(result.testData?.set.values.accountType).toMatchObject({
      strategy: 'BUSINESS_LITERAL',
      value: 'BUSINESS',
    });
  });

  it('§49: a value already in the field and kept is not test data (PRESERVE_EXISTING)', () => {
    const recording = fresh();
    type(recording, field('Country', { nameAttr: 'country' }), 'Canada', { initialDigest: digest('Canada') });
    const result = run(recording);
    expect(result.testData?.set.values).toEqual({});
    expect(result.testData?.items).toEqual([
      expect.objectContaining({
        field: 'Country',
        classification: 'PREFILLED_VALUE',
        strategy: 'PRESERVE_EXISTING',
      }),
    ]);
  });

  it('§50: quantity and price are inputs; a computed total (read-only) never is', () => {
    const recording = fresh();
    type(recording, field('Quantity', { nameAttr: 'quantity', inputType: 'number' }), '2');
    type(recording, field('Price', { nameAttr: 'price', inputType: 'number' }), '10');
    type(recording, field('Total', { nameAttr: 'total', readOnly: true }), '20');
    const result = run(recording);
    expect(Object.keys(result.testData?.set.values ?? {})).toEqual(['quantity', 'price']);
    expect(result.testData?.set.values.quantity).toMatchObject({ strategy: 'RECORDED_LITERAL', value: '2' });
    expect(result.testData?.items.find((item) => item.field === 'Total')).toMatchObject({
      classification: 'DERIVED_VALUE',
      strategy: 'IGNORE_DERIVED',
    });
    expect(fills(flowOf(result.files.yaml).steps)).toHaveLength(2);
  });

  it('§51 / §45: a password is a credential reference; its value is in no artefact', () => {
    const recording = fresh();
    const secret = 'MyPassword123!';
    type(recording, field('Login', { nameAttr: 'login' }), 'agent.one');
    type(recording, field('Password', { nameAttr: 'password', inputType: 'password' }), secret, {
      sensitive: true,
      digest: undefined,
    });
    // Même si un texte sensible arrivait dans le coffre, il ne serait jamais utilisé.
    recording.typed.set(recording.events.at(-1)?.id ?? '', secret);
    type(recording, field('Api token', { nameAttr: 'apiToken' }), 'abcdef0123456789abcdef0123456789');
    const result = run(recording);
    const everything = JSON.stringify({
      document: result.testData?.document,
      items: result.testData?.items,
      flow: result.flow,
      actions: result.normalized.actions,
      files: result.files,
    });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('abcdef0123456789abcdef0123456789');
    // Login (identifiant de connexion), mot de passe, jeton : trois références, aucune valeur.
    expect(result.testData?.security).toEqual({
      sensitiveRecorded: 3,
      credentialReferences: 3,
      clearTextPersisted: 0,
    });
    expect(everything).not.toContain('agent.one');
    const steps = flowOf(result.files.yaml).steps;
    expect(fills(steps)).toEqual(expect.arrayContaining([{ env: 'QA_PASSWORD' }, { env: 'QA_API_TOKEN' }]));
    expect(Object.keys(result.testData?.set.values ?? {}).some((key) => /password|token/i.test(key))).toBe(
      false,
    );
  });

  it('§52 / §35: the same e-mail reused (search, confirmation) is one data, by reference', () => {
    const recording = fresh();
    type(recording, field('Email', { nameAttr: 'email', inputType: 'email' }), 'user@example.com');
    type(
      recording,
      field('Confirm email', { nameAttr: 'confirmEmail', inputType: 'email' }),
      'user@example.com',
    );
    submit(recording, 'Create', post('/api/users', { email: 'user@example.com' }));
    type(recording, field('Search', { nameAttr: 'search', inputType: 'search' }), 'user@example.com');
    const result = run(recording);
    const values = result.testData?.set.values ?? {};
    expect(values['user.email']).toMatchObject({ strategy: 'GENERATE_AT_REPLAY' });
    // La confirmation porte la même valeur que la propriété email du corps envoyé : la même donnée.
    expect(values['user.confirmEmail']).toBeUndefined();
    expect(values.search).toMatchObject({ strategy: 'REFERENCE', reference: 'user.email' });
    expect(fills(flowOf(result.files.yaml).steps)).toEqual([
      { testData: 'user.email' },
      { testData: 'user.email' },
      { testData: 'search' },
    ]);
  });

  it('§53 / §26: an edited value never overwrites the first one (initial / updated)', () => {
    const recording = fresh();
    type(recording, field('Description', { nameAttr: 'description' }), 'Initial');
    submit(recording, 'Save', post('/api/requests', { description: 'Initial' }));
    type(recording, field('Description', { nameAttr: 'description' }), 'Updated');
    submit(recording, 'Save', post('/api/requests/5', { description: 'Updated' }, 'PUT'));
    const result = run(recording);
    const values = result.testData?.set.values ?? {};
    expect(values['request.description.initial']).toMatchObject({ value: 'Initial' });
    expect(values['request.description.updated']).toMatchObject({ value: 'Updated' });
    expect(fills(flowOf(result.files.yaml).steps)).toEqual([
      { testData: 'request.description.initial' },
      { testData: 'request.description.updated' },
    ]);
    expect(result.warnings.map((warning) => warning.code)).toContain('TEST_DATA_COLLISION');
  });

  it('§54 / §28: two customers created are two entities, never one key overwritten', () => {
    const recording = fresh();
    type(recording, field('Name', { nameAttr: 'companyName' }), 'Alpha inc');
    submit(recording, 'Create', post('/api/v1/customers', { companyName: 'Alpha inc' }));
    type(recording, field('Name', { nameAttr: 'companyName' }), 'Beta inc');
    submit(recording, 'Create', post('/api/v1/customers', { companyName: 'Beta inc' }));
    const result = run(recording);
    expect(Object.keys(result.testData?.set.values ?? {})).toEqual([
      'customer1.companyName',
      'customer2.companyName',
    ]);
  });

  it('§6: a field without a usable name is named after the DTO property that carries its value', () => {
    const element = field('', { label: undefined, name: '', elementId: 'mat-input-4', generatedId: true });
    const value = digest('Paris office');
    expect(
      resolveTestDataKey(
        element,
        { empty: false, length: 12, shape: 'text', digest: value },
        {
          method: 'POST',
          path: '/api/sites',
          requestFields: { 'site.officeName': { type: 'string', digest: value } },
        },
      ),
    ).toMatchObject({ key: 'officeName', source: 'DTO property site.officeName' });
    expect(entityOf('/api/v2/addresses/12')).toBe('address');
    expect(entityOf('/api/demandes')).toBe('demande');
    expect(entityOf('/rest/categories/{id}')).toBe('category');
  });

  it('§57 / §58: an explicit override wins, but never over security', () => {
    const recording = fresh();
    type(recording, field('Email', { nameAttr: 'email', inputType: 'email' }), 'fixed@example.com');
    type(recording, field('Description', { nameAttr: 'description' }), 'Printer down');
    type(recording, field('Pin', { nameAttr: 'pinCode' }), '4321');
    const config = mission(
      'recording:\n  testData:\n    overrides:\n      email: { strategy: recorded }\n      description: { strategy: template, template: "QA ${runId}" }\n      pinCode: { strategy: recorded }\n',
    );
    const values = run(recording, config).testData?.set.values ?? {};
    expect(values.email).toMatchObject({ strategy: 'RECORDED_LITERAL', value: 'fixed@example.com' });
    expect(values.description).toMatchObject({ strategy: 'TEMPLATE', template: 'QA ${runId}' });
    expect(values.pinCode).toBeUndefined();
  });

  it('§56: recording.testData.enabled: false keeps the previous behavior', () => {
    const recording = fresh();
    type(recording, field('Description', { nameAttr: 'description' }), 'Printer down');
    const result = run(recording, mission('recording:\n  testData: { enabled: false }\n'));
    expect(result.testData).toBeUndefined();
    expect(result.files.yaml).not.toMatch(/^testData:/m);
    expect(fills(flowOf(result.files.yaml).steps)).toEqual([{ testData: 'description' }]);
  });

  it('values not recorded (extractRecordedValues: false) are generated at replay, never invented', () => {
    const recording = fresh();
    type(recording, field('Description', { nameAttr: 'description' }), 'Printer down');
    recording.typed.clear();
    const result = run(recording);
    expect(result.testData?.set.values.description).toMatchObject({ strategy: 'GENERATE_AT_REPLAY' });
    expect(JSON.stringify(result.testData?.document)).not.toContain('Printer');
  });
});

describe('TestDataSet file', () => {
  it('reads nested values, shorthands and references', () => {
    const set = parseTestDataSet(
      {
        name: 'demo',
        values: {
          request: { title: 'Printer', type: { strategy: 'literal', value: 'INCIDENT' } },
          email: { strategy: 'generated', generator: 'email' },
          'confirm.email': { strategy: 'reference', reference: 'email' },
        },
      },
      'demo.yaml',
    );
    expect(Object.keys(set.values).sort()).toEqual([
      'confirm.email',
      'email',
      'request.title',
      'request.type',
    ]);
    expect(set.values['request.title']).toMatchObject({ strategy: 'RECORDED_LITERAL', value: 'Printer' });
  });

  it('refuses a secret written in clear text, and an unknown reference', () => {
    expect(() => parseTestDataSet({ values: { password: 'MyPassword123' } }, 'x')).toThrow(TestDataSetError);
    expect(() =>
      parseTestDataSet({ values: { user: { apiKey: { strategy: 'recorded', value: 'k' } } } }, 'x'),
    ).toThrow(/never written in clear text/);
    expect(() => parseTestDataSet({ values: { a: { strategy: 'reference', reference: 'b' } } }, 'x')).toThrow(
      /unknown key "b"/,
    );
    expect(
      parseTestDataSet({ values: { password: { strategy: 'credential', env: 'QA_PASSWORD' } } }, 'x').values
        .password,
    ).toMatchObject({
      strategy: 'CREDENTIAL_REFERENCE',
      sensitive: true,
    });
  });
});

describe('TestDataRunContext: one value per key and per run', () => {
  const set = parseTestDataSet(
    {
      values: {
        user: {
          email: { strategy: 'generated', generator: 'email' },
          confirmEmail: { strategy: 'reference', reference: 'user.email' },
        },
        customer2: { email: { strategy: 'generated', generator: 'email' } },
        title: 'Printer',
        country: { strategy: 'preserve' },
        password: { strategy: 'credential', env: 'QA_PASSWORD' },
        ref: { strategy: 'template', template: 'QA-${runId}' },
      },
    },
    'run.yaml',
  );
  const make = (runId: string): { context: TestDataRunContext; generated: string[] } => {
    const generated: string[] = [];
    return {
      context: new TestDataRunContext({
        runId,
        env: { QA_PASSWORD: 'from-env' },
        onGenerated: (key) => generated.push(key),
      }),
      generated,
    };
  };
  const sources = (runId: string) => ({
    fallback: () => `fallback-${runId}`,
    generate: (generator: string) =>
      generator === 'email' ? `qa.${runId}@example.test` : `${generator}-${runId}`,
  });

  it('§31 / §32: the same key resolved three times gives the same generated value; references follow it', () => {
    const { context, generated } = make('A1');
    const first = context.resolve('user.email', [set], sources('A1'));
    const again = context.resolve('user.email', [set], sources('A1'));
    const confirm = context.resolve('user.confirmEmail', [set], sources('A1'));
    expect(first).toMatchObject({ kind: 'value', value: 'qa.A1@example.test', generated: true });
    expect(again).toEqual(first);
    expect(confirm).toMatchObject({ kind: 'value', value: 'qa.A1@example.test' });
    expect(generated).toEqual(['user.email']);
    // Une autre entité générée avec le même générateur : jamais la même adresse.
    expect(context.resolve('customer2.email', [set], sources('A1'))).toMatchObject({
      value: 'qa.A1+2@example.test',
    });
    // Un nouveau run : une nouvelle valeur.
    const { context: next } = make('B2');
    expect(next.resolve('user.email', [set], sources('B2'))).toMatchObject({ value: 'qa.B2@example.test' });
  });

  it('§30: each strategy resolves as declared', () => {
    const { context } = make('C3');
    expect(context.resolve('title', [set], sources('C3'))).toMatchObject({
      value: 'Printer',
      generated: false,
    });
    expect(context.resolve('country', [set], sources('C3'))).toEqual({ kind: 'preserve' });
    expect(context.resolve('password', [set], sources('C3'))).toMatchObject({ value: 'from-env' });
    expect(context.resolve('ref', [set], sources('C3'))).toMatchObject({ value: 'QA-C3' });
    // Une clé absente du jeu : le TestDataProvider (comportement d'avant), une fois par run.
    expect(context.resolve('other', [set], sources('C3'))).toMatchObject({
      value: 'fallback-C3',
      strategy: 'PROVIDER',
    });
    // Le jeu du flow l'emporte sur celui de la mission.
    const flowSet = parseTestDataSet({ values: { title: 'From the flow' } }, 'flow');
    expect(context.resolve('title', [flowSet, set], sources('C3'))).toMatchObject({ value: 'From the flow' });
  });
});

describe('§55: flow.yaml and .feature resolve to the same TestDataSet', () => {
  it('both generated files load test-data.yaml', async () => {
    const recording = fresh();
    type(recording, field('Title', { nameAttr: 'title' }), 'Imprimante bureau');
    submit(recording, 'Submit', post('/api/requests', { title: 'Imprimante bureau' }));
    const result = run(recording);
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-recorded-data-'));
    await writeFile(path.join(dir, TEST_DATA_FILE), stringify(result.testData?.document), 'utf8');
    await writeFile(path.join(dir, 'generated.flow.yaml'), result.files.yaml, 'utf8');
    await writeFile(path.join(dir, 'generated.feature'), result.files.feature, 'utf8');
    const overrides = { baseUrl: APP };
    const yaml = loadDryRunScenario({
      scenarioFile: path.join(dir, 'generated.flow.yaml'),
      overrides,
      env: {},
    });
    const feature = loadDryRunScenario({
      scenarioFile: path.join(dir, 'generated.feature'),
      overrides,
      env: {},
    });
    const yamlSet = yaml.config.flows[0]?.testData;
    const featureSet = feature.config.flows[0]?.testData;
    expect(yamlSet?.values['request.title']).toMatchObject({ value: 'Imprimante bureau' });
    expect(featureSet?.values).toEqual(yamlSet?.values);
    expect(fills(yaml.config.flows[0]?.steps ?? [])).toEqual(fills(feature.config.flows[0]?.steps ?? []));
  });
});

describe('performance', () => {
  it('extracts the data of a long recording (400 entries) quickly', () => {
    const recording = fresh();
    for (let index = 0; index < 400; index += 1)
      type(
        recording,
        field(`Field ${String(index)}`, {
          nameAttr: `field${String.fromCharCode(97 + (index % 26))}${String(index)}`,
        }),
        `value number ${String(index)}`,
      );
    const started = performance.now();
    const result = run(recording);
    expect(Object.keys(result.testData?.set.values ?? {}).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
