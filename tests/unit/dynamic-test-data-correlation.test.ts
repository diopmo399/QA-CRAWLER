import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import {
  referencedTestDataKeys,
  resolveTestDataReferences,
  testDataReference,
} from '../../src/data/test-data-references.js';
import { TestDataRunContext } from '../../src/data/test-data-run-context.js';
import { parseTestDataSet } from '../../src/data/test-data-set.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import type { FunctionalExchange } from '../../src/functional/model.js';
import type { RawRecordedEvent, RecordedElement, RecordingSession } from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';

/**
 * DONNÉES DE TEST DYNAMIQUES : la référence ${testData:clé} (résolue une fois par étape, par le contexte
 * du run) et la corrélation de LECTURE à l'enregistrement (le résultat cliqué porte la valeur créée).
 */
describe('Test data references: ${testData:key} resolved by the run context', () => {
  const set = parseTestDataSet(
    {
      values: {
        company: { companyName: { strategy: 'generated', generator: 'company' } },
        search: { q: { strategy: 'reference', reference: 'company.companyName' } },
      },
    },
    'run.yaml',
  );
  const runOf = (runId: string): { context: TestDataRunContext; resolve: (key: string) => string } => {
    const context = new TestDataRunContext({ runId, env: {} });
    const sources = {
      fallback: () => undefined,
      generate: (generator: string) => `${generator}-QA-CRAWLER-${runId}`,
    };
    return {
      context,
      resolve: (key) => {
        const data = context.resolve(key, [set], sources);
        if (data.kind !== 'value') throw new Error(`no value for ${key}`);
        return data.value;
      },
    };
  };
  const openStep = {
    kind: 'click',
    target: { strategy: 'role', role: 'button', name: testDataReference('company.companyName') },
    effects: { appears: [`button:${testDataReference('company.companyName')}`] },
  };

  it('A — generation: a dynamic key gets a valid, non-empty, run-tagged value', () => {
    const { resolve } = runOf('A1');
    expect(resolve('company.companyName')).toBe('company-QA-CRAWLER-A1');
  });

  it('B — stability: every reference to the key returns exactly the same value during the run', () => {
    const { resolve } = runOf('B1');
    let asked = 0;
    const answers = Array.from({ length: 5 }, () =>
      resolveTestDataReferences(openStep, (key) => {
        asked += 1;
        return { value: resolve(key) };
      }),
    );
    const names = answers.map((answer) => (answer.ok ? answer.value.target.name : undefined));
    expect(new Set(names)).toEqual(new Set(['company-QA-CRAWLER-B1']));
    // Une fois par appel (deux citations dans l'étape → une seule demande), la valeur venant du run.
    expect(asked).toBe(5);
    const first = answers[0];
    expect(first?.ok && first.value.effects.appears).toEqual(['button:company-QA-CRAWLER-B1']);
    expect(first?.ok && first.keys).toEqual(['company.companyName']);
  });

  it('C — reuse: the search (a reference) and the creation get the same value', () => {
    const { resolve } = runOf('C1');
    expect(resolve('search.q')).toBe(resolve('company.companyName'));
  });

  it('E / H — isolation and concurrency: two runs interleaved never share a value', async () => {
    const first = runOf('E1');
    const second = runOf('E2');
    const values = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        Promise.resolve().then(() => (index % 2 === 0 ? first : second).resolve('company.companyName')),
      ),
    );
    expect(new Set(values.filter((_, index) => index % 2 === 0))).toEqual(new Set(['company-QA-CRAWLER-E1']));
    expect(new Set(values.filter((_, index) => index % 2 === 1))).toEqual(new Set(['company-QA-CRAWLER-E2']));
  });

  it('G — an unknown key is an explicit failure naming the key, never an empty value', () => {
    const result = resolveTestDataReferences(openStep, () => ({ error: 'unknown test data key' }));
    expect(result).toMatchObject({ ok: false, key: 'company.companyName' });
    expect(result.ok ? '' : result.reason).toContain('${testData:company.companyName}');
  });

  it('a reference inside text is interpolated; a CSS selector never cites test data', () => {
    const text = resolveTestDataReferences({ text: `Open ${testDataReference('a.b')} now` }, () => ({
      value: 'X',
    }));
    expect(text).toMatchObject({ ok: true, value: { text: 'Open X now' } });
    const css = resolveTestDataReferences({ css: `[title="${testDataReference('a.b')}"]` }, () => ({
      value: 'X',
    }));
    expect(css).toMatchObject({ ok: false });
    expect(referencedTestDataKeys(openStep)).toEqual(['company.companyName']);
    expect(referencedTestDataKeys({ name: 'Save' })).toEqual([]);
  });
});

describe('Recording: the clicked result carrying the created value cites the data (read correlation)', () => {
  const APP = 'http://app.test';
  const SALT = 'unit-salt';
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
    const id = push({
      type: 'change',
      element: target,
      value: { empty: false, length: value.length, shape: 'text', digest: valueDigest(value, SALT) },
    });
    typed.set(id, value);
  };
  const button = (name: string, network: FunctionalExchange[] = []): void => {
    push({
      type: 'click',
      element: element(name, { tag: 'button', role: 'button', inputType: undefined, label: undefined }),
      network,
    });
  };
  const exchange = (
    method: string,
    pathName: string,
    fields: Record<string, string>,
  ): FunctionalExchange => ({
    method,
    path: pathName,
    status: 200,
    requestFields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [
        name,
        { type: 'string', digest: valueDigest(value, SALT) },
      ]),
    ),
  });

  type(element('Company name', { nameAttr: 'companyName' }), 'Company Test QA');
  type(element('Comment', { nameAttr: 'comment' }), 'Fixed note');
  button('Save', [
    exchange('POST', '/api/companies', { companyName: 'Company Test QA', comment: 'Fixed note' }),
  ]);
  type(element('Search companies', { nameAttr: 'q', inputType: 'search' }), 'Company Test QA');
  button('Search', [exchange('POST', '/api/companies/search', { companyName: 'Company Test QA' })]);
  button('Company Test QA');
  button('Open Company Test QA details');
  button('Fixed note');

  const session: RecordingSession = {
    id: 'rec-dyn',
    name: 'Create and open',
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
    `mission: { name: dyn }\ntarget: { baseUrl: "${APP}", startAt: / }\n`,
    {},
    {},
  ).config;
  const result = processRecording(session, config, { language: 'en', typedValues: typed });
  const flow = parseYaml(result.files.yaml) as { steps: { click?: { name?: string } }[] };
  const clicks = flow.steps.flatMap((step) => (step.click?.name !== undefined ? [step.click.name] : []));

  it('D / J — the result clicked after the search cites the generated company name (another screen, another selector)', () => {
    expect(result.testData?.set.values['company.companyName']).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
    });
    expect(clicks).toContain('${testData:company.companyName}');
    expect(result.testData?.events.map((event) => event.type)).toContain('TEST_DATA_TARGET_CORRELATED');
  });

  it('a text that only CONTAINS the value is never rewritten (uncertain correlation stays literal)', () => {
    expect(clicks).toContain('Open Company Test QA details');
  });

  it('a value kept as recorded (RECORDED_LITERAL) changes nothing: its click stays literal', () => {
    expect(
      result.testData?.set.values['company.comment'] ?? result.testData?.set.values.comment,
    ).toMatchObject({
      strategy: 'RECORDED_LITERAL',
    });
    expect(clicks).toContain('Fixed note');
    // Les actions gardent leur classement : des clics restent des clics, des saisies des saisies.
    expect(clicks).toEqual([
      'Save',
      'Search',
      '${testData:company.companyName}',
      'Open Company Test QA details',
      'Fixed note',
    ]);
  });
});
