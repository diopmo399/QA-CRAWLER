import { describe, expect, it } from 'vitest';
import { DefaultTestDataProvider } from '../../src/data/test-data-provider.js';
import { ActionDiscovery } from '../../src/discovery/action-discovery.js';
import { DomFormAnalyzer } from '../../src/forms/form-analyzer.js';
import { ValidDataFillStrategy } from '../../src/forms/form-fill-strategy.js';
import type { FormField } from '../../src/forms/form-model.js';
import type { PageContext } from '../../src/model/page-context.js';
import type { UiElement } from '../../src/model/ui-snapshot.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { sensitivityOf } from '../../src/policies/sensitive-fields.js';
import { element, snapshot, testConfig } from '../helpers.js';

const config = testConfig();
const safety = new SafetyPolicy(config.safety);
const discovery = new ActionDiscovery(safety);
const analyzer = new DomFormAnalyzer();

const input = (label: string, extra: Partial<UiElement> = {}): UiElement =>
  element({
    tag: 'input',
    role: 'textbox',
    name: label,
    label,
    inputType: 'text',
    text: '',
    formGroup: 'page',
    ...extra,
  });

/** "Créer utilisateur" without <form>: Nom *, Email *, Rôle *, Actif, [Annuler] [Enregistrer]. */
const createUser = (): PageContext => {
  const shot = snapshot({
    url: 'http://localhost:4200/users/new',
    headings: ['Créer utilisateur'],
    elements: [
      input('Nom', { required: true, fieldName: 'name' }),
      input('Email', { required: true, inputType: 'email', maxLength: 100 }),
      element({
        tag: 'select',
        role: 'combobox',
        name: 'Rôle',
        label: 'Rôle',
        required: true,
        options: ['-- Choisir --', 'ADMIN', 'USER'],
        disabledOptions: ['ADMIN'],
        formGroup: 'page',
      }),
      element({
        tag: 'input',
        role: 'checkbox',
        name: 'Actif',
        label: 'Actif',
        inputType: 'checkbox',
        formGroup: 'page',
      }),
      input('Mot de passe', { inputType: 'password', required: true }),
      element({ tag: 'button', role: 'button', name: 'Annuler', text: 'Annuler', formGroup: 'page' }),
      element({ tag: 'button', role: 'button', name: 'Enregistrer', text: 'Enregistrer', formGroup: 'page' }),
    ],
  });
  const actions = discovery.discover(shot, 'create-user');
  return {
    url: shot.url,
    title: 'App',
    stateId: 'create-user',
    stateLabel: 'create-user',
    route: '/users/new',
    headings: shot.headings,
    dialogs: [],
    actions,
    forms: [],
    errors: [],
    metadata: { depth: 1, timestamp: '', flow: [] },
  };
};

describe('FormAnalyzer', () => {
  it('understands a form without <form> as one logical form', async () => {
    const [form, ...others] = await analyzer.analyze(undefined, createUser());
    expect(others).toEqual([]);
    expect(form?.name).toBe('Créer utilisateur');
    expect(form?.fields.map((field) => [field.label, field.type, field.required, field.sensitive])).toEqual([
      ['Nom', 'text', true, false],
      ['Email', 'email', true, false],
      ['Rôle', 'select', true, false],
      ['Actif', 'checkbox', false, false],
      ['Mot de passe', 'password', true, true],
    ]);
    expect(form?.fields[2]?.options).toEqual([
      { label: '-- Choisir --', disabled: false, placeholder: true },
      { label: 'ADMIN', disabled: true, placeholder: false },
      { label: 'USER', disabled: false, placeholder: false },
    ]);
    expect(form?.submitActions.map((action) => action.text)).toEqual(['Enregistrer']);
  });

  it('does not take a lone checkbox next to a "Create…" button for a form', async () => {
    const shot = snapshot({
      elements: [
        element({ tag: 'input', role: 'checkbox', name: 'Garder', inputType: 'checkbox', formGroup: 'page' }),
        element({ tag: 'button', role: 'button', name: 'Créer', text: 'Créer', formGroup: 'page' }),
      ],
    });
    const actions = discovery.discover(shot, 's');
    expect(actions.find((action) => action.text === 'Créer')?.submitsForm).toBeUndefined();
    expect(await analyzer.analyze(undefined, { ...createUser(), actions })).toEqual([]);
  });
});

describe('FormFillStrategy', () => {
  it('produces a plan: valid values, real options, sensitive fields skipped without value', async () => {
    const context = createUser();
    const [form] = await analyzer.analyze(undefined, context);
    const strategy = new ValidDataFillStrategy(
      new DefaultTestDataProvider({ runId: 'abc123', defaults: { lastName: 'Tester' } }),
      safety,
      'abc123',
    );
    if (!form) throw new Error('no form');
    const plan = await strategy.fill(form, context);
    expect(plan.formId).toBe('create-user:page');
    expect(plan.operations.map(({ operation, value, source }) => ({ operation, value, source }))).toEqual([
      { operation: 'fill', value: 'Tester', source: 'rule' }, // testData.defaults.lastName ("Nom")
      { operation: 'fill', value: 'qa-crawler-abc123@example.test', source: 'rule' }, // tagged with the run id
      { operation: 'select', value: 'USER', source: 'type' }, // no placeholder, no disabled option
      { operation: 'skip', value: undefined, source: 'type' }, // optional checkbox
      { operation: 'skip', value: undefined, source: undefined }, // password: never filled, no value
    ]);
  });
});

describe('TestDataProvider', () => {
  const provider = new DefaultTestDataProvider({ runId: 'abc123', fields: { email: 'qa@example.test' } });
  const field = (extra: Partial<FormField>): FormField => ({
    id: 'f',
    type: 'text',
    required: false,
    disabled: false,
    readonly: false,
    hasValue: false,
    sensitive: false,
    payment: false,
    locator: { strategy: 'label', value: 'x' },
    ...extra,
  });

  it('follows the priority: configuration, rule, type, fallback', () => {
    expect(provider.validValue(field({ type: 'email', name: 'email' }))).toMatchObject({
      value: 'qa@example.test',
      source: 'configured',
    });
    expect(provider.validValue(field({ label: 'Titre' }))).toMatchObject({
      value: 'QA-CRAWLER-abc123',
      source: 'rule',
    });
    expect(provider.validValue(field({ type: 'number', min: 1, max: 100 }))).toMatchObject({
      value: '51',
      source: 'type',
    });
    expect(provider.validValue(field({ label: 'Commentaire libre' }))).toMatchObject({
      value: 'QA Test',
      source: 'fallback',
    });
    expect(provider.validValue(field({ type: 'checkbox', required: true }))).toMatchObject({ kind: 'check' });
  });

  it('generates a few telling invalid values, never for sensitive fields', () => {
    const cases = (extra: Partial<FormField>): string[] =>
      provider.invalidValues(field(extra)).map((value) => `${value.case}=${value.value ?? ''}`);
    expect(cases({ type: 'number', required: true, min: 1, max: 100 })).toEqual([
      'empty=',
      'below-min=0',
      'above-max=101',
    ]);
    expect(cases({ type: 'email', required: true, maxLength: 5 })).toEqual([
      'empty=',
      'invalid-email=invalid-email',
      'too-long=xxxxxx',
    ]);
    expect(cases({ type: 'password', required: true, sensitive: true })).toEqual([]);
    expect(cases({ type: 'checkbox', required: true })).toEqual(['required-unchecked=']);
  });
});

describe('sensitivityOf', () => {
  it('recognizes passwords, secrets, tokens, authorization, API keys, cards, bank accounts, SIN/NAS, SSN', () => {
    const sensitive = [
      { inputType: 'password', label: 'Code' },
      { label: 'Client secret' },
      { name: 'api_key' },
      { label: 'Authorization' },
      { label: 'Numéro de carte' },
      { label: 'CVV' },
      { label: 'Compte bancaire' },
      { label: 'NAS' },
      { label: 'SSN' },
      { autocomplete: 'cc-number', label: 'Numéro' },
    ].map((description) => sensitivityOf(description).sensitive);
    expect(sensitive.every(Boolean)).toBe(true);
    expect(sensitivityOf({ label: 'Numéro de carte' }).payment).toBe(true);
    expect(sensitivityOf({ label: 'Compte bancaire' }).payment).toBe(true);
    expect(sensitivityOf({ label: 'Nom' }).sensitive).toBe(false);
    expect(sensitivityOf({ label: 'Code agence' }).sensitive).toBe(false);
  });
});
