import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuleBasedActionScorer, scoringMissionOf } from '../../src/decision/action-scorer.js';
import { AdvancedActionScorer } from '../../src/decision/advanced-action-scorer.js';
import { renderReason } from '../../src/decision/score-breakdown.js';
import { decideFieldAction, type FieldState } from '../../src/forms/state/field-state.js';
import { FieldDependencyGraph, diffFormStates } from '../../src/forms/state/field-dependencies.js';
import { FormStateAnalyzer, observeFields } from '../../src/forms/state/form-state-analyzer.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { CrawlerValueMemory, ResponseValueIndex } from '../../src/forms/state/value-sources.js';
import { FlowGraph } from '../../src/graph/flow-graph.js';
import { RuleKnowledgeStore } from '../../src/knowledge/rule-knowledge-store.js';
import type { UiElement } from '../../src/model/ui-snapshot.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { checkEffect, evaluateConditions, type ScreenFacts } from '../../src/rules/rule-evaluator.js';
import { RuleGraph } from '../../src/rules/rule-graph.js';
import type { StaticApplicationGraph } from '../../src/static-analysis/model.js';
import { buildStaticGraph } from '../../src/static-analysis/graph-builder.js';
import { conditionOf, parseTemplateExpression } from '../../src/static-analysis/rules/condition-parser.js';
import {
  describeConditions,
  ruleSignature,
  type ApplicationRule,
} from '../../src/static-analysis/rules/rule-model.js';
import { scanTemplateRules } from '../../src/static-analysis/rules/template-rules.js';
import { collectSources, sourceSetOf } from '../../src/static-analysis/source-set.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { loadTypeScript } from '../../src/static-analysis/typescript-loader.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { screen, staticAnalyzerOptions, testConfig } from '../helpers.js';

const SALT = 'unit-salt';
const FIXTURE = path.resolve('tests/fixtures/static-apps/accounts');

let index = 0;
function element(partial: Partial<UiElement> & { tag: string }): UiElement {
  index += 1;
  return {
    index,
    role: partial.tag === 'select' ? 'combobox' : partial.tag === 'button' ? 'button' : 'textbox',
    name: partial.label ?? partial.frameworkName ?? '',
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
    css: `#e${String(index)}`,
    ...partial,
  };
}

const select = (
  control: string,
  codes: string[],
  chosen?: string,
  extra: Partial<UiElement> = {},
): UiElement =>
  element({
    tag: 'select',
    frameworkName: control,
    label: control,
    options: codes,
    optionValues: codes,
    ...(chosen ? { hasValue: true, selectedValue: chosen, selectedOption: chosen } : { hasValue: false }),
    frameworkValid: true,
    ...extra,
  });
const text = (control: string, value?: string, extra: Partial<UiElement> = {}): UiElement =>
  element({
    tag: 'input',
    inputType: 'text',
    frameworkName: control,
    label: control,
    hasValue: value !== undefined,
    ...(value !== undefined ? { valueDigest: valueDigest(value, SALT) } : {}),
    frameworkValid: true,
    ...extra,
  });

function state(partial: Partial<FieldState>): FieldState {
  return {
    fieldId: 'field',
    kind: 'text',
    state: 'EMPTY',
    editable: true,
    readonly: false,
    disabled: false,
    required: false,
    visible: true,
    sensitive: false,
    ...partial,
  };
}

// ------------------------------------------------------------------ LOT A

describe('FieldActionDecision: never « if value exists → skip » again', () => {
  it.each([
    ['EMPTY', {}, 'FILL', 'EMPTY_FIELD'],
    ['PREFILLED', { valid: true }, 'KEEP', 'VALID_EXISTING_VALUE'],
    ['DEFAULT_VALUE', { valid: true }, 'KEEP', 'VALID_EXISTING_VALUE'],
    ['AUTOFILLED', {}, 'KEEP', 'VALID_EXISTING_VALUE'],
    ['DERIVED_VALUE', {}, 'OBSERVE_ONLY', 'DERIVED_FIELD'],
    ['PREFILLED', { valid: false }, 'REPLACE', 'INVALID_EXISTING_VALUE'],
    ['PREFILLED', { readonly: true }, 'OBSERVE_ONLY', 'READONLY_FIELD'],
    ['PREFILLED', { disabled: true }, 'SKIP_DISABLED', 'DISABLED_FIELD'],
    ['EMPTY', { sensitive: true }, 'SKIP_UNSAFE', 'SENSITIVE_FIELD'],
  ] as const)('%s %o → %s', (valueState, extra, decision, reason) => {
    expect(
      decideFieldAction(state({ state: valueState, ...extra }), { preserveExisting: true }),
    ).toMatchObject({
      decision,
      reason,
    });
  });

  it('country = Canada, DEFAULT_VALUE, valid → KEEP « valid existing default value »', () => {
    const country = state({
      fieldId: 'country',
      kind: 'select',
      state: 'DEFAULT_VALUE',
      valid: true,
      currentValue: { code: 'CA', option: 'Canada' },
    });
    expect(decideFieldAction(country, { preserveExisting: true })).toEqual({
      fieldId: 'country',
      decision: 'KEEP',
      reason: 'VALID_EXISTING_VALUE',
      explanation: 'valid existing default value',
    });
    // « Et je sélectionne "France" comme pays » : la valeur explicite du scénario l'emporte.
    expect(
      decideFieldAction(country, { preserveExisting: true, explicit: { option: 'France' } }),
    ).toMatchObject({
      decision: 'REPLACE',
      reason: 'EXPLICIT_SCENARIO_VALUE',
    });
    expect(
      decideFieldAction(country, { preserveExisting: true, explicit: { option: 'Canada' } }),
    ).toMatchObject({
      decision: 'KEEP',
      reason: 'EXPLICIT_VALUE_ALREADY_PRESENT',
    });
    expect(decideFieldAction(country, { preserveExisting: false }).decision).toBe('REPLACE');
    expect(decideFieldAction(country, { preserveExisting: true, blockedByPolicy: true }).decision).toBe(
      'SKIP_UNSAFE',
    );
  });
});

// ------------------------------------------------------------------ LOT B

describe('ValueProvenanceAnalyzer: why a value is there (fingerprints only)', () => {
  const analyzer = new FormStateAnalyzer();
  const staticSources = [
    {
      component: 'A',
      control: 'country',
      kind: 'INITIALIZER' as const,
      origin: 'FORM_DEFAULT' as const,
      literal: 'CA',
      location: { file: 'a.ts', line: 1 },
    },
    {
      component: 'A',
      control: 'email',
      kind: 'PATCH_VALUE' as const,
      origin: 'API_RESPONSE' as const,
      apiRoute: 'GET /api/profile',
      responseProperty: 'email',
      expression: 'profile.email',
      location: { file: 'a.ts', line: 9 },
    },
    {
      component: 'A',
      control: 'total',
      kind: 'SET_VALUE' as const,
      origin: 'DERIVED' as const,
      inputs: ['quantity', 'price'],
      location: { file: 'a.ts', line: 12 },
    },
  ];

  it('API response (profile), form default, derived, previous step, autofill, server HTML, unknown', () => {
    const responses = new ResponseValueIndex(SALT);
    responses.record('GET', 'https://app.test/api/profile?x=1', {
      email: 'someone@example.test',
      address: { city: 'Laval' },
    });
    const memory = new CrawlerValueMemory(SALT);
    memory.record({ fieldId: 'reference', stateId: 'step-1', value: 'QA-REF-7' });
    const states = analyzer.analyze(
      [
        text('email', 'someone@example.test'),
        select('country', ['CA', 'FR'], 'CA'),
        text('total', '40', { readOnly: true }),
        text('confirmation', 'QA-REF-7'),
        text('nickname', 'Zed', { autofilled: true }),
        text('server', 'fixed', { defaultValueDigest: valueDigest('fixed', SALT) }),
        text('mystery', 'x'),
        text('empty'),
      ],
      {
        salt: SALT,
        stateId: 'step-2',
        staticSources: (control) => staticSources.filter((source) => source.control === control),
        responses,
        crawlerValues: memory,
      },
    );
    const by = (id: string) => states.find((entry) => entry.fieldId === id);
    expect(by('email')).toMatchObject({
      state: 'PREFILLED',
      provenance: { origin: 'PROFILE_PREFILLED', sourceApi: 'GET /api/profile', sourceProperty: 'email' },
    });
    expect(by('email')?.provenance?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(by('country')).toMatchObject({ state: 'DEFAULT_VALUE', provenance: { origin: 'FORM_DEFAULT' } });
    expect(by('total')).toMatchObject({ state: 'DERIVED_VALUE', provenance: { origin: 'DERIVED' } });
    expect(by('confirmation')).toMatchObject({
      state: 'PREVIOUS_STEP_VALUE',
      provenance: { origin: 'PREVIOUS_STEP', sourceField: 'reference' },
    });
    expect(by('nickname')).toMatchObject({ state: 'AUTOFILLED', provenance: { origin: 'BROWSER_AUTOFILL' } });
    expect(by('server')).toMatchObject({ state: 'PREFILLED', provenance: { origin: 'SERVER_PREFILLED' } });
    expect(by('mystery')).toMatchObject({ state: 'UNKNOWN_PREFILLED', provenance: { origin: 'UNKNOWN' } });
    expect(by('empty')?.state).toBe('EMPTY');
    // Jamais une valeur en clair dans l'état d'un champ.
    expect(JSON.stringify(states)).not.toContain('someone@example.test');
  });

  it('the in-browser fingerprint is the Node fingerprint (same salted algorithm)', async () => {
    const { collectDomSnapshot } = await import('../../src/observation/dom-snapshot.js');
    expect(typeof collectDomSnapshot).toBe('function');
    // Même entrée, même empreinte ; sel différent, empreinte différente.
    expect(valueDigest('Canada', 'a')).toBe(valueDigest(' Canada ', 'a'));
    expect(valueDigest('Canada', 'a')).not.toBe(valueDigest('Canada', 'b'));
    expect(valueDigest('Canada', 'a')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('static: defaults, patchValue from a GET response, calculation (the existing analyzer, one AST pass)', async () => {
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(FIXTURE);
    const sources = graph.valueSources ?? [];
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ control: 'country', origin: 'FORM_DEFAULT', literal: 'CA' }),
        expect.objectContaining({ control: 'companyNumber', origin: 'EMPTY' }),
        expect.objectContaining({
          control: 'email',
          kind: 'PATCH_VALUE',
          origin: 'API_RESPONSE',
          apiRoute: 'GET /api/profile',
          responseProperty: 'email',
        }),
        expect.objectContaining({
          control: 'total',
          origin: 'DERIVED',
          inputs: ['quantity', 'price', 'discount'],
        }),
      ]),
    );
  });
});

// ------------------------------------------------------------------ LOTS C / D

describe('FormStateDiff + FieldDependencyGraph', () => {
  it('BUSINESS → companyNumber appears and becomes required; country → province options and a request', () => {
    const before = observeFields([
      select('accountType', ['PERSONAL', 'BUSINESS'], 'PERSONAL'),
      select('province', ['']),
      text('total', '20', { readOnly: true }),
    ]);
    const after = observeFields([
      select('accountType', ['PERSONAL', 'BUSINESS'], 'BUSINESS'),
      text('companyNumber', undefined, { frameworkValid: false }),
      select('province', ['', 'QC', 'ON']),
      text('total', '40', { readOnly: true }),
    ]);
    const changes = diffFormStates(before, after);
    expect(changes).toEqual(
      expect.arrayContaining([
        { fieldId: 'companyNumber', control: 'companyNumber', change: 'ADDED' },
        { fieldId: 'province', control: 'province', change: 'OPTIONS_CHANGED' },
        { fieldId: 'total', control: 'total', change: 'VALUE_CHANGED' },
      ]),
    );
    const graph = new FieldDependencyGraph();
    graph.infer(
      'accountType',
      changes,
      [{ method: 'GET', url: 'https://app.test/api/provinces?country=CA', resourceType: 'fetch' }],
      {
        triggerValue: 'BUSINESS',
        derived: (id) => id === 'total',
      },
    );
    expect(graph.all().map((edge) => `${edge.from}->${edge.to}:${edge.kind}`)).toEqual(
      expect.arrayContaining([
        'accountType->companyNumber:VISIBILITY_DEPENDENCY',
        'accountType->province:OPTIONS_DEPENDENCY',
        'accountType->total:DERIVATION_DEPENDENCY',
        'accountType->GET /api/provinces:NETWORK_DEPENDENCY',
      ]),
    );
    expect(graph.all().every((edge) => edge.evidence === 'RUNTIME')).toBe(true);
  });

  it('required appears: empty + ng-invalid (Angular sets no attribute) → VALIDATION_DEPENDENCY', () => {
    const before = observeFields([text('guardianName', undefined, { frameworkValid: true })]);
    const after = observeFields([text('guardianName', undefined, { frameworkValid: false })]);
    expect(diffFormStates(before, after)).toEqual([
      { fieldId: 'guardianName', control: 'guardianName', change: 'REQUIRED' },
    ]);
  });
});

// ------------------------------------------------------------------ LOTS E / F

describe('Rule extraction: templates and code → candidate rules (never an executed line)', () => {
  it('template: @if / @else / @switch / *ngIf / [disabled] / [readonly] / *ngFor options', () => {
    const facts = scanTemplateRules(`
      @if (accountType === 'BUSINESS') { <input formControlName="companyNumber"> } @else { <input formControlName="personalId"> }
      @switch (mode) { @case ('EDIT') { <input formControlName="reason"> } @default { <p>x</p> } }
      <div *ngIf="country === 'CA'"><select formControlName="province"><option *ngFor="let p of provinces">{{ p }}</option></select></div>
      <button [disabled]="!form.valid || loading">Save {{ count }}</button>
      <input formControlName="customerId" [readonly]="mode === 'EDIT'">`);
    const byControl = (control: string) => facts.elements.find((entry) => entry.control === control);
    expect(byControl('companyNumber')?.visibleWhen).toEqual([
      { expression: "accountType === 'BUSINESS'", negated: false },
    ]);
    expect(byControl('personalId')?.visibleWhen).toEqual([
      { expression: "accountType === 'BUSINESS'", negated: true },
    ]);
    expect(byControl('reason')?.visibleWhen).toEqual([{ expression: "mode === 'EDIT'", negated: false }]);
    expect(byControl('province')).toMatchObject({
      optionsFrom: 'provinces',
      visibleWhen: [{ expression: "country === 'CA'", negated: false }],
    });
    expect(byControl('customerId')?.readonlyWhen).toBe("mode === 'EDIT'");
    expect(facts.elements.find((entry) => entry.kind === 'BUTTON')).toMatchObject({
      label: 'Save',
      disabledWhen: '!form.valid || loading',
    });
  });

  it('conditions: comparisons, AND / OR / NOT, form validity, roles — the rest stays OPAQUE', async () => {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript missing');
    const parse = (source: string) => {
      const expression = parseTemplateExpression(ts, source);
      if (!expression) throw new Error(source);
      return describeConditions([conditionOf(ts, expression, () => undefined)]);
    };
    expect(parse("order.total > 1000 && customer.type === 'BUSINESS'")).toBe(
      'total > 1000 AND type == BUSINESS',
    );
    expect(parse('!form.valid || loading')).toBe('form.invalid OR loading');
    expect(parse('1000 < total')).toBe('total > 1000');
    expect(parse('!(age < 18)')).toBe('age >= 18');
    expect(parse("auth.hasRole('ADMIN')")).toBe('permission ADMIN');
    expect(parse("user.role === 'ADMIN'")).toBe('permission ADMIN');
    expect(parse('compute(a, b)')).toMatch(/^« compute/);
    expect(parse("token === 'abc'")).toBe('« secret comparison »');
  });

  it('the fixture: every category, with evidence; the technical « if (!response) return » is NOT a rule', async () => {
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(FIXTURE);
    const rules = graph.rules ?? [];
    const named = (name: string) => rules.find((rule) => rule.name === name);
    expect(named('ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER')).toMatchObject({
      category: 'VALIDATION',
      status: 'STATIC_DISCOVERED',
    });
    expect(
      named('ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER')?.effects.map((effect) => effect.kind),
    ).toEqual(expect.arrayContaining(['REQUIRED', 'SHOW', 'INCLUDE_IN_REQUEST']));
    expect(named('COUNTRY_CHANGE_LOADS_OPTIONS_OF_PROVINCE')?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'SET_OPTIONS', api: 'GET /api/provinces' })]),
    );
    expect(named('QUANTITY_CHANGE_CALCULATES_TOTAL')?.category).toBe('CALCULATION');
    expect(named('TOTAL_ABOVE_1000_AND_CUSTOMER_TYPE_BUSINESS_SETS_DISCOUNT')?.category).toBe('BUSINESS');
    expect(named('MODE_EDIT_LOCKS_CUSTOMER_ID')?.category).toBe('READONLY');
    expect(named('FORM_INVALID_OR_LOADING_DISABLES_ENREGISTRER')?.category).toBe('ENABLEMENT');
    expect(named('IS_ADMIN_SHOWS_ADMINISTRATION')?.category).toBe('PERMISSION');
    expect(named('ADMIN_ALLOWS_ADMINISTRATION')?.category).toBe('PERMISSION');
    expect(named('AGE_ABOVE_0_AND_AGE_BELOW_18_REQUIRES_GUARDIAN_NAME')?.category).toBe('VALIDATION');
    expect(graph.technicalConditions?.map((entry) => entry.text)).toEqual(['!response']);
    expect(rules.some((rule) => describeConditions(rule.conditions).includes('response'))).toBe(false);
    // Chaque règle cite sa preuve (fichier:ligne).
    expect(rules.every((rule) => rule.evidence.every((entry) => entry.provenance?.location?.line))).toBe(
      true,
    );
  });

  it('signature: same semantics → same signature, whatever the line; different effect → different', async () => {
    const sources = await collectSources(FIXTURE, {
      maxFiles: 50,
      maxFileSizeBytes: 2e6,
      maxDurationMs: 30_000,
    });
    const shifted = sourceSetOf(
      'x',
      sources.files.map((file) => ({
        path: file.path,
        text: file.path.endsWith('.ts') ? `\n\n\n${file.text}` : file.text,
      })),
    );
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript missing');
    const options = {
      applicationId: 'x',
      mode: 'SOURCE' as const,
      features: staticAnalyzerOptions().features,
      analyzers: { angular: true, genericJs: true },
      maxAstNodes: 5e6,
      maxDurationMs: 30_000,
    };
    const signatures = (graph: StaticApplicationGraph) =>
      (graph.rules ?? []).map((rule) => rule.signature).sort();
    const original = buildStaticGraph(ts, sources, options);
    const moved = buildStaticGraph(ts, shifted, options);
    expect(signatures(moved)).toEqual(signatures(original));
    const rule = (original.rules ?? [])[0];
    if (!rule) throw new Error('no rule');
    expect(
      ruleSignature({
        ...rule,
        effects: [{ kind: 'HIDE', target: { kind: 'FIELD', name: 'x', control: 'x' } }],
      }),
    ).not.toBe(rule.signature);
  });
});

// ------------------------------------------------------------------ LOTS G / H

function rule(partial: Partial<ApplicationRule>): ApplicationRule {
  return {
    id: 'r',
    signature: 's',
    name: 'R',
    category: 'VISIBILITY',
    component: 'AccountForm',
    conditions: [],
    effects: [],
    evidence: [],
    confidence: 0.8,
    status: 'STATIC_DISCOVERED',
    origin: 'TEMPLATE',
    location: { file: 'a.html', line: 1 },
    ...partial,
  };
}

const business = rule({
  id: 'business',
  name: 'ACCOUNT_TYPE_BUSINESS_SHOWS_COMPANY_NUMBER',
  conditions: [
    {
      kind: 'COMPARE',
      subject: { kind: 'FIELD', name: 'accountType', control: 'accountType' },
      operator: '==',
      value: 'BUSINESS',
    },
  ],
  effects: [
    {
      kind: 'SHOW',
      target: { kind: 'FIELD', name: 'companyName', control: 'companyName' },
      bidirectional: true,
    },
    {
      kind: 'SHOW',
      target: { kind: 'FIELD', name: 'companyNumber', control: 'companyNumber' },
      bidirectional: true,
    },
    { kind: 'REQUIRED', target: { kind: 'FIELD', name: 'companyNumber', control: 'companyNumber' } },
  ],
});

function facts(elements: UiElement[], extra: Partial<ScreenFacts> = {}): ScreenFacts {
  return { fields: observeFields(elements), elements, salt: SALT, apisSeen: new Set(), ...extra };
}

describe('RuleEvaluator + RuleGraph: STATIC_DISCOVERED → RUNTIME_CONFIRMED / CONTRADICTED, coverage', () => {
  it('prefilled BUSINESS: the rule is confirmed WITHOUT changing accountType (passive)', () => {
    const graph = new RuleGraph([business]);
    const screenFacts = facts([
      select('accountType', ['PERSONAL', 'BUSINESS'], 'BUSINESS'),
      text('companyName'),
      text('companyNumber', undefined, { frameworkValid: false }),
    ]);
    const [target] = graph.all();
    if (!target) throw new Error('no rule');
    expect(evaluateConditions(target.conditions, screenFacts)).toBe(true);
    target.effects.forEach((effect, index) => {
      const check = checkEffect(effect, true, screenFacts);
      if (check)
        graph.record(target, {
          at: '',
          effect: index,
          verdict: check.verdict,
          conditionHeld: true,
          mode: 'PASSIVE',
          detail: check.detail,
        });
    });
    expect(target).toMatchObject({ status: 'RUNTIME_CONFIRMED', coverage: 'VERIFIED' });
    expect(graph.coverage()).toMatchObject({ discovered: 1, confirmed: 1, verified: '1 / 1' });
  });

  it('PERSONAL → companyNumber absent (the other side of a template binding); present → CONTRADICTED', () => {
    const personal = facts([select('accountType', ['PERSONAL', 'BUSINESS'], 'PERSONAL')]);
    const show = business.effects[1];
    if (!show) throw new Error('no effect');
    expect(evaluateConditions(business.conditions, personal)).toBe(false);
    expect(checkEffect(show, false, personal)?.verdict).toBe('CONFIRMED');
    const wrong = facts([select('accountType', ['PERSONAL', 'BUSINESS'], 'PERSONAL'), text('companyNumber')]);
    expect(checkEffect(show, false, wrong)?.verdict).toBe('CONTRADICTED');
    // Un validateur du code ne se défait pas seul : rien à dire quand la condition est fausse.
    const required = business.effects[2];
    if (!required) throw new Error('no effect');
    expect(checkEffect(required, false, wrong)).toBeUndefined();
  });

  it('contradiction: CA → province required, but the application does not require it', () => {
    const province = rule({
      category: 'VALIDATION',
      conditions: [
        {
          kind: 'COMPARE',
          subject: { kind: 'FIELD', name: 'country', control: 'country' },
          operator: '==',
          value: 'CA',
        },
      ],
      effects: [{ kind: 'REQUIRED', target: { kind: 'FIELD', name: 'province', control: 'province' } }],
    });
    const graph = new RuleGraph([province]);
    const [target] = graph.all();
    if (!target) throw new Error('no rule');
    const screenFacts = facts([
      select('country', ['CA', 'FR'], 'CA'),
      select('province', ['', 'QC'], undefined, { frameworkValid: true }),
    ]);
    const effect = target.effects[0];
    if (!effect) throw new Error('no effect');
    const check = checkEffect(effect, true, screenFacts);
    expect(check?.verdict).toBe('CONTRADICTED');
    graph.record(target, {
      at: '',
      effect: 0,
      verdict: 'CONTRADICTED',
      conditionHeld: true,
      mode: 'PASSIVE',
      detail: check?.detail ?? '',
      context: { route: '/accounts/new' },
    });
    expect(target).toMatchObject({ status: 'RUNTIME_CONTRADICTED', coverage: 'CONTRADICTED' });
  });

  it('disabled button: invalid form → disabled; valid form → enabled (template binding)', () => {
    const disable = rule({
      category: 'ENABLEMENT',
      conditions: [
        {
          kind: 'OR',
          items: [
            { kind: 'FORM_STATE', subject: { kind: 'FORM', name: 'form' }, state: 'INVALID' },
            { kind: 'FLAG', subject: { kind: 'STATE', name: 'loading' } },
          ],
        },
      ],
      effects: [{ kind: 'DISABLE', target: { kind: 'ACTION', name: 'Save' }, bidirectional: true }],
    });
    const button = (disabled: boolean) => element({ tag: 'button', text: 'Save', name: 'Save', disabled });
    const invalid = facts([text('email', undefined, { frameworkValid: false }), button(true)]);
    expect(evaluateConditions(disable.conditions, invalid)).toBe(true);
    const [disabled] = disable.effects;
    if (!disabled) throw new Error('no effect');
    expect(checkEffect(disabled, true, invalid)?.verdict).toBe('CONFIRMED');
    // Formulaire valide : « loading » reste inconnu (état interne) → la condition est inconnue, rien n'est conclu.
    const valid = facts([text('email', 'a@b.c'), button(false)]);
    expect(evaluateConditions(disable.conditions, valid)).toBeUndefined();
  });

  it('numeric condition on a value the crawler typed: age 9 < 18 → guardian required', () => {
    const age = rule({
      category: 'VALIDATION',
      conditions: [
        { kind: 'COMPARE', subject: { kind: 'FIELD', name: 'age', control: 'age' }, operator: '>', value: 0 },
        {
          kind: 'COMPARE',
          subject: { kind: 'FIELD', name: 'age', control: 'age' },
          operator: '<',
          value: 18,
        },
      ],
      effects: [
        { kind: 'REQUIRED', target: { kind: 'FIELD', name: 'guardianName', control: 'guardianName' } },
      ],
    });
    const screenFacts = facts(
      [text('age', '9'), text('guardianName', undefined, { frameworkValid: false })],
      {
        knownValue: (id) => (id === 'age' ? '9' : undefined),
      },
    );
    expect(evaluateConditions(age.conditions, screenFacts)).toBe(true);
    const [required] = age.effects;
    if (!required) throw new Error('no effect');
    expect(checkEffect(required, true, screenFacts)?.verdict).toBe('CONFIRMED');
    // Une valeur lue (non saisie par le crawler) n'est jamais comparée à un nombre : inconnue.
    expect(evaluateConditions(age.conditions, facts([text('age', '9')]))).toBeUndefined();
  });

  it('permission and policy: never forced — BLOCKED, and the coverage says so', () => {
    const admin = rule({
      category: 'PERMISSION',
      conditions: [{ kind: 'PERMISSION', permission: 'ADMIN' }],
      effects: [{ kind: 'SHOW', target: { kind: 'ELEMENT', name: 'Administration' } }],
    });
    const graph = new RuleGraph([admin, business]);
    const [target] = graph.all();
    if (!target) throw new Error('no rule');
    expect(evaluateConditions(target.conditions, facts([]))).toBeUndefined();
    graph.block(target, 'BLOCKED_BY_CONTEXT', 'role of the signed-in user');
    expect(graph.coverage()).toMatchObject({ discovered: 2, blockedByContext: 1, notVerified: 1 });
  });

  it('opportunity: selecting BUSINESS would verify 3 uncovered expectations (LOW risk, 1 interaction)', () => {
    const graph = new RuleGraph([business]);
    expect(graph.targetValues('accountType')).toEqual(['BUSINESS']);
    expect(graph.opportunity('accountType', { value: 'BUSINESS', component: 'AccountForm' })).toMatchObject({
      field: 'accountType',
      value: 'BUSINESS',
      level: 'HIGH',
      risk: 'LOW',
      cost: 1,
      expectations: ['companyName visible', 'companyNumber visible', 'companyNumber required'],
    });
    expect(graph.opportunity('accountType', { value: 'PERSONAL' })).toBeUndefined();
    expect(graph.tree()).toEqual([
      {
        subject: 'accountType',
        branches: [
          {
            when: 'accountType == BUSINESS',
            effects: ['companyName visible', 'companyNumber visible', 'companyNumber required'],
            rules: ['ACCOUNT_TYPE_BUSINESS_SHOWS_COMPANY_NUMBER'],
          },
        ],
      },
    ]);
  });
});

describe('DecisionEngine signal: ruleCoverageOpportunity (SafetyPolicy stays outside the score)', () => {
  it('two comparable actions: the one that verifies 3 uncovered rules wins, with an explanation', () => {
    const config = testConfig('');
    const context = screen(
      {
        url: 'http://localhost/accounts/new',
        headings: ['Compte'],
        elements: [
          element({
            tag: 'select',
            frameworkName: 'accountType',
            label: 'Type',
            options: ['Personnel', 'Entreprise'],
            optionValues: ['PERSONAL', 'BUSINESS'],
            hasValue: true,
            selectedValue: 'PERSONAL',
          }),
          element({
            tag: 'select',
            frameworkName: 'theme',
            label: 'Thème',
            options: ['Clair', 'Sombre'],
            optionValues: ['LIGHT', 'DARK'],
            hasValue: true,
            selectedValue: 'LIGHT',
          }),
        ],
      },
      config,
    );
    const scorer = (withRules: boolean) =>
      new AdvancedActionScorer(new RuleBasedActionScorer(new SafetyPolicy(config.safety)), {
        dictionary: new SemanticDictionary(),
        weights: { goalWeight: 1, patternWeight: 1, noveltyWeight: 1, coverageWeight: 1, historyWeight: 1 },
        patternsOf: () => [],
        ...(withRules
          ? {
              ruleOpportunityOf: (action) =>
                action.field?.frameworkName === 'accountType'
                  ? {
                      field: 'accountType',
                      value: 'BUSINESS',
                      expectations: [
                        'companyName visible',
                        'companyNumber visible',
                        'companyNumber required',
                      ],
                    }
                  : undefined,
            }
          : {}),
      });
    const [accountType, theme] = ['accountType', 'theme'].map((name) => {
      const action = context.actions.find((entry) => entry.field?.frameworkName === name);
      if (!action) throw new Error(name);
      return action;
    }) as [NonNullable<(typeof context.actions)[number]>, NonNullable<(typeof context.actions)[number]>];
    const mission = scoringMissionOf(config);
    const plain = scorer(false);
    const base = [
      plain.score(accountType, context, new FlowGraph(), mission).score,
      plain.score(theme, context, new FlowGraph(), mission).score,
    ];
    const withRules = scorer(true);
    const a = withRules.score(accountType, context, new FlowGraph(), mission);
    const b = withRules.score(theme, context, new FlowGraph(), mission);
    expect(a.score - (base[0] ?? 0)).toBe(90);
    expect(b.score).toBe(base[1]);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.breakdown.rules).toBe(90);
    const reason = a.breakdown.details.find((entry) => entry.factor === 'rules');
    expect(reason && renderReason(reason)).toContain(
      'RULE_COVERAGE: accountType = BUSINESS would verify 3 expectation(s)',
    );
  });
});

describe('RuleKnowledgeStore: history is never proof', () => {
  it('remembers statuses per signature, flags another version as not current', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-rules-kb-'));
    const first = new RuleKnowledgeStore(directory, { application: 'app', version: '1.0.0' });
    await first.save([
      { ...business, status: 'RUNTIME_CONFIRMED', coverage: 'VERIFIED', signature: 'sig-1' },
    ]);
    const later = new RuleKnowledgeStore(directory, { application: 'app', version: '2.0.0' });
    await later.load();
    expect(later.recall('sig-1')).toMatchObject({
      status: 'RUNTIME_CONFIRMED',
      version: '1.0.0',
      confirmations: 1,
      sameVersion: false,
    });
    const same = new RuleKnowledgeStore(directory, { application: 'app', version: '1.0.0' });
    await same.load();
    expect(same.recall('sig-1')?.sameVersion).toBe(true);
    expect(same.recall('unknown')).toBeUndefined();
  });
});

describe('performance: indexes, never the AST, at decision time', () => {
  it('1 000 rules: 10 000 opportunity lookups in well under a second', () => {
    const many: ApplicationRule[] = Array.from({ length: 1000 }, (_, position) =>
      rule({
        id: `r${String(position)}`,
        signature: `s${String(position)}`,
        conditions: [
          {
            kind: 'COMPARE',
            subject: {
              kind: 'FIELD',
              name: `f${String(position % 50)}`,
              control: `f${String(position % 50)}`,
            },
            operator: '==',
            value: `V${String(position)}`,
          },
        ],
        effects: [
          {
            kind: 'SHOW',
            target: { kind: 'FIELD', name: `t${String(position)}`, control: `t${String(position)}` },
          },
        ],
      }),
    );
    const graph = new RuleGraph(many);
    const started = performance.now();
    for (let lookup = 0; lookup < 10_000; lookup += 1)
      graph.opportunity(`f${String(lookup % 50)}`, { value: `V${String(lookup % 1000)}` });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
