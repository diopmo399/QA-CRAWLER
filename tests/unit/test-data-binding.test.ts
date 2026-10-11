import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { TestDataRunContext } from '../../src/data/test-data-run-context.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import type { FunctionalExchange } from '../../src/functional/model.js';
import type { RawRecordedEvent, RecordedElement, RecordingSession } from '../../src/recording/model.js';
import { processRecording, TEST_DATA_FILE } from '../../src/recording/process-recording.js';
import { generateFlowFiles } from '../../src/recording/recorded-flow.js';
import {
  applyTestDataBinding,
  availableVariables,
  dataLineage,
  stepDataBinding,
} from '../../src/recording/test-data-binding.js';

/**
 * LIAISON EXPLICITE DES DONNÉES : l'humain choisit la source de la valeur d'une saisie (FIXED,
 * GENERATED, REFERENCE vers une donnée produite AVANT). Un champ au nom neutre (« Display label »)
 * n'est pas reconnu comme une donnée à générer : la valeur saisie (« Company Test QA ») reste telle
 * quelle jusqu'au choix explicite.
 */
const APP = 'http://app.test';
const SALT = 'unit-salt';

function record(): ReturnType<typeof processRecording> {
  let sequence = 0;
  const events: RawRecordedEvent[] = [];
  const typed = new Map<string, string>();
  const element = (name: string, extra: Partial<RecordedElement> = {}): RecordedElement => ({
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
  });
  const push = (event: Omit<RawRecordedEvent, 'id' | 'sequence' | 'at' | 'url'>): string => {
    sequence += 1;
    const id = `r${String(sequence)}`;
    events.push({ id, sequence, at: 1000 + sequence * 400, url: `${APP}/companies`, ...event });
    return id;
  };
  const type = (target: RecordedElement, value: string): void => {
    typed.set(
      push({
        type: 'change',
        element: target,
        value: { empty: false, length: value.length, shape: 'text', digest: valueDigest(value, SALT) },
      }),
      value,
    );
  };
  const button = (name: string, network: FunctionalExchange[] = []): void => {
    push({
      type: 'click',
      element: element(name, { tag: 'button', role: 'button', inputType: undefined, label: undefined }),
      network,
    });
  };
  const write = (pathName: string, fields: Record<string, string>): FunctionalExchange => ({
    method: 'POST',
    path: pathName,
    status: 200,
    requestFields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [
        name,
        { type: 'string', digest: valueDigest(value, SALT) },
      ]),
    ),
  });
  type(element('Display label', { nameAttr: 'displayLabel' }), 'Company Test QA');
  type(element('Region', { nameAttr: 'region' }), 'North shore');
  type(element('Account code', { nameAttr: 'accountCode' }), 'Code 4471');
  button('Save', [write('/api/accounts', { displayLabel: 'Company Test QA', region: 'North shore' })]);
  type(element('Search accounts', { nameAttr: 'q', inputType: 'search' }), 'Company Test QA');
  button('Search');
  button('Company Test QA');
  type(element('Filter code', { nameAttr: 'filterCode' }), 'Other text');
  const session: RecordingSession = {
    id: 'rec-binding',
    name: 'Create and find',
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: `${APP}/companies`,
    status: 'PROCESSING',
    rawEvents: [{ id: 'r0', sequence: 0, type: 'navigation', at: 900, url: `${APP}/companies` }, ...events],
    semanticActions: [],
    checkpoints: [],
    states: [],
    warnings: [],
    droppedEvents: 0,
  };
  const config = parseConfig(
    `mission: { name: bind }\ntarget: { baseUrl: "${APP}", startAt: / }\n`,
    {},
    {},
  ).config;
  return processRecording(session, config, { language: 'en', typedValues: typed });
}

const fillOf = (result: ReturnType<typeof record>, label: string) =>
  result.flow.steps.find(
    (item) => item.step.kind === 'fill' && JSON.stringify(item.step.target).includes(label),
  );
const keyOf = (result: ReturnType<typeof record>, label: string): string | undefined => {
  const step = fillOf(result, label)?.step;
  return step?.kind === 'fill' && typeof step.value !== 'string' && 'testData' in step.value
    ? step.value.testData
    : undefined;
};
const errorOf = (outcome: ReturnType<typeof applyTestDataBinding>): string =>
  'error' in outcome ? outcome.error : '';
const regenerate = (result: ReturnType<typeof record>) => (): void => {
  result.files = generateFlowFiles(result.flow, {
    language: 'en',
    recordedAt: '',
    testDataFile: TEST_DATA_FILE,
  });
};
const runOf = (result: ReturnType<typeof record>, runId: string) => {
  const context = new TestDataRunContext({ runId, env: {} });
  const sources = {
    fallback: () => undefined,
    generate: (generator: string) => `${generator}-QA-CRAWLER-${runId}`,
  };
  return (key: string): string => {
    const data = context.resolve(key, [result.testData?.set], sources);
    if (data.kind !== 'value') throw new Error(`no value for ${key}: ${JSON.stringify(data)}`);
    return data.value;
  };
};

describe('Explicit test data binding between steps', () => {
  it('before any choice: the neutral field keeps its recorded value, the search was auto-linked (a suggestion)', () => {
    const result = record();
    const label = keyOf(result, 'Display label') ?? '';
    expect(result.testData?.set.values[label]).toMatchObject({
      strategy: 'RECORDED_LITERAL',
      value: 'Company Test QA',
    });
    const search = stepDataBinding(result, fillOf(result, 'Search accounts')?.id ?? '');
    expect(search).toMatchObject({ source: 'REFERENCE', reference: label, suggestion: label, manual: false });
  });

  it('causality: a step only offers data produced BEFORE it; the first input offers nothing', () => {
    const result = record();
    expect(availableVariables(result, fillOf(result, 'Display label')?.id ?? '')).toEqual([]);
    const offered = availableVariables(result, fillOf(result, 'Search accounts')?.id ?? '').map((v) => v.key);
    expect(offered).toEqual([
      keyOf(result, 'Display label'),
      keyOf(result, 'Region'),
      keyOf(result, 'Account code'),
    ]);
    const late = applyTestDataBinding(
      result,
      {
        stepId: fillOf(result, 'Display label')?.id ?? '',
        source: 'REFERENCE',
        variable: keyOf(result, 'Search accounts') ?? 'x',
      },
      regenerate(result),
    );
    expect(errorOf(late)).toContain('not produced by a step before this one');
  });

  it('1 / 2 / 3 — GENERATED then REFERENCE: one generated value, the same at every use; the OPEN click cites it', () => {
    const result = record();
    const create = fillOf(result, 'Display label')?.id ?? '';
    const generated = applyTestDataBinding(
      result,
      { stepId: create, source: 'GENERATED', variable: 'company.name', generator: 'company' },
      regenerate(result),
    );
    expect(generated).toMatchObject({ decision: { source: 'GENERATED', variable: 'company.name' } });
    const search = fillOf(result, 'Search accounts')?.id ?? '';
    expect(
      applyTestDataBinding(
        result,
        { stepId: search, source: 'REFERENCE', variable: 'company.name' },
        regenerate(result),
      ),
    ).toMatchObject({ decision: { source: 'REFERENCE', variable: 'company.name' } });
    const filter = fillOf(result, 'Filter code')?.id ?? '';
    applyTestDataBinding(
      result,
      { stepId: filter, source: 'REFERENCE', variable: 'company.name' },
      regenerate(result),
    );
    expect(keyOf(result, 'Search accounts')).toBe('company.name');
    expect(keyOf(result, 'Filter code')).toBe('company.name');
    // Le résultat cliqué portait la valeur saisie : il cite maintenant la variable.
    const flow = parseYaml(result.files.yaml) as { steps: { click?: { name?: string } }[] };
    expect(flow.steps.map((step) => step.click?.name)).toContain('${testData:company.name}');
    expect(result.files.yaml).not.toContain('Company Test QA');
    // Au rejeu : UNE valeur, la même pour la création, la recherche et le critère.
    const resolve = runOf(result, 'R1');
    const value = resolve(keyOf(result, 'Display label') ?? '');
    expect(value).toBe('company-QA-CRAWLER-R1');
    expect(resolve(keyOf(result, 'Search accounts') ?? '')).toBe(value);
    expect(resolve(keyOf(result, 'Filter code') ?? '')).toBe(value);
    // La lignée : produite à l'étape de création, puis saisie deux fois et citée par l'ouverture.
    const lineage = dataLineage(result).find((entry) => entry.key === 'company.name');
    expect(lineage?.producedBy?.stepId).toBe(create);
    expect(lineage?.usedBy.filter((use) => use.how === 'INPUT')).toHaveLength(2);
    expect(lineage?.usedBy.filter((use) => use.how === 'CITATION')).toHaveLength(1);
    // Chaque choix est une décision du registre, en ajout seul.
    expect(result.humanReview?.bindings?.map((decision) => decision.source)).toEqual([
      'GENERATED',
      'REFERENCE',
      'REFERENCE',
    ]);
  });

  it('4 — two variables stay independent, each input citing its own', () => {
    const result = record();
    applyTestDataBinding(
      result,
      {
        stepId: fillOf(result, 'Display label')?.id ?? '',
        source: 'GENERATED',
        variable: 'company.name',
        generator: 'company',
      },
      regenerate(result),
    );
    applyTestDataBinding(
      result,
      {
        stepId: fillOf(result, 'Account code')?.id ?? '',
        source: 'GENERATED',
        variable: 'customer.code',
        generator: 'unique',
      },
      regenerate(result),
    );
    applyTestDataBinding(
      result,
      { stepId: fillOf(result, 'Filter code')?.id ?? '', source: 'REFERENCE', variable: 'customer.code' },
      regenerate(result),
    );
    const resolve = runOf(result, 'R4');
    expect(resolve('company.name')).not.toBe(resolve('customer.code'));
    expect(resolve(keyOf(result, 'Filter code') ?? '')).toBe(resolve('customer.code'));
  });

  it('5 — a reference to a variable that does not exist is refused explicitly (nothing changes)', () => {
    const result = record();
    const before = result.files.yaml;
    const refused = applyTestDataBinding(
      result,
      {
        stepId: fillOf(result, 'Search accounts')?.id ?? '',
        source: 'REFERENCE',
        variable: 'company.nothing',
      },
      regenerate(result),
    );
    expect(errorOf(refused)).toContain('company.nothing');

    expect(result.files.yaml).toBe(before);
  });

  it('6 / 7 — FIXED keeps (or replaces) the value; GENERATED renames the variable everywhere it is used', () => {
    const result = record();
    const region = fillOf(result, 'Region')?.id ?? '';
    applyTestDataBinding(
      result,
      { stepId: region, source: 'FIXED', value: 'Lake district' },
      regenerate(result),
    );
    expect(result.testData?.set.values[keyOf(result, 'Region') ?? '']).toMatchObject({
      strategy: 'BUSINESS_LITERAL',
      value: 'Lake district',
    });
    expect(runOf(result, 'R6')(keyOf(result, 'Region') ?? '')).toBe('Lake district');
    expect(
      applyTestDataBinding(result, { stepId: region, source: 'FIXED' }, regenerate(result)),
    ).toMatchObject({
      decision: { source: 'FIXED' },
    });
    expect(
      errorOf(
        applyTestDataBinding(
          result,
          { stepId: region, source: 'GENERATED', variable: 'bad name!' },
          regenerate(result),
        ),
      ),
    ).toContain('not a valid variable name');
  });

  it('8 — the explicit choice wins over the automatic link (the suggestion is only shown)', () => {
    const result = record();
    const search = fillOf(result, 'Search accounts')?.id ?? '';
    applyTestDataBinding(
      result,
      {
        stepId: fillOf(result, 'Account code')?.id ?? '',
        source: 'GENERATED',
        variable: 'customer.code',
        generator: 'unique',
      },
      regenerate(result),
    );
    applyTestDataBinding(
      result,
      { stepId: search, source: 'REFERENCE', variable: 'customer.code' },
      regenerate(result),
    );
    expect(keyOf(result, 'Search accounts')).toBe('customer.code');
    const binding = stepDataBinding(result, search);
    expect(binding).toMatchObject({ source: 'REFERENCE', reference: 'customer.code', manual: true });
    expect(binding?.suggestion).toBeUndefined();
  });

  it('a secret input can never be bound to test data', () => {
    const result = record();
    const step = fillOf(result, 'Region');
    if (step?.step.kind === 'fill') step.step.value = { env: 'QA_PASSWORD' };
    expect(
      errorOf(
        applyTestDataBinding(result, { stepId: step?.id ?? '', source: 'GENERATED' }, regenerate(result)),
      ),
    ).toContain('secret');
  });

  it('the HTTP analysis follows a binding: a search criterion cites the CURRENT key of its input, never a dropped one', () => {
    const result = record();
    const search = fillOf(result, 'Search accounts');
    const before = keyOf(result, 'Search accounts') ?? '';
    const rawId = result.testData?.items.find((item) => item.key === before)?.rawEventIds[0] ?? '';
    expect(rawId).not.toBe('');
    const criterion = {
      ui: { label: 'Search accounts', actionId: rawId, screen: '/accounts', match: 'EXACT' },
      testData: { key: before, reference: `\${testData.${before}}` },
      evidence: [`the value is the test datum testData.${before}: dynamic, not a frozen literal`],
    };
    result.http = {
      journal: [],
      consolidated: { business: [{ searchCriteria: [criterion] }] },
    } as unknown as NonNullable<typeof result.http>;
    applyTestDataBinding(
      result,
      {
        stepId: fillOf(result, 'Display label')?.id ?? '',
        source: 'GENERATED',
        variable: 'company.name',
        generator: 'company',
      },
      regenerate(result),
    );
    applyTestDataBinding(
      result,
      { stepId: search?.id ?? '', source: 'REFERENCE', variable: 'company.name' },
      regenerate(result),
    );
    expect(criterion.testData).toEqual({ key: 'company.name', reference: '${testData.company.name}' });
    expect(criterion.evidence).toEqual([
      'the value is the test datum testData.company.name: dynamic, not a frozen literal',
    ]);
    expect(result.testData?.set.values[before]).toBeUndefined();
  });
});
