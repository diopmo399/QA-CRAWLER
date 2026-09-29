import { describe, expect, it } from 'vitest';
import { DomOpenApiConstraintExtractor } from '../../src/constraints/constraints.js';
import {
  equivalencePartitions,
  OneFactorPropertyTestGenerator,
  SimpleBoundaryValueGenerator,
} from '../../src/constraints/test-case-generators.js';
import type { DiscoveredForm, FormField } from '../../src/forms/form-model.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';

const field = (overrides: Partial<FormField>): FormField => ({
  id: 'f',
  type: 'text',
  required: false,
  disabled: false,
  readonly: false,
  hasValue: false,
  sensitive: false,
  payment: false,
  locator: { strategy: 'label', value: 'x' },
  ...overrides,
});

const contract = parseOpenApi(`
openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /api/users:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [email]
              properties:
                email: { type: string, format: email, maxLength: 80 }
                age: { type: integer, minimum: 18, maximum: 65 }
                role: { type: string, enum: [admin, reader] }
      responses: { '201': { description: ok } }
`);

describe('ConstraintExtractor', () => {
  const extractor = new DomOpenApiConstraintExtractor();

  it('keeps every source; the page value is the one tested, a disagreement is a CONSTRAINT_MISMATCH', () => {
    const age = extractor.extract(field({ name: 'age', type: 'number', min: 21 }), contract);
    expect(age).toMatchObject({
      min: 21,
      max: 65,
      format: 'integer',
      type: 'integer',
      sources: { min: ['HTML'], max: ['OPENAPI'], format: ['HTML', 'OPENAPI'], type: ['HTML', 'OPENAPI'] },
    });
    expect(age.conflicts).toEqual([
      expect.objectContaining({
        kind: 'CONSTRAINT_MISMATCH',
        constraint: 'min',
        values: [
          { source: 'HTML', value: 21 },
          { source: 'OPENAPI', value: 18 },
        ],
        effective: 'HTML',
      }),
    ]);
    const email = extractor.extract(field({ label: 'E-mail', name: 'email', maxLength: 50 }), contract);
    expect(email).toMatchObject({
      required: true,
      maxLength: 50,
      format: 'email',
      sources: { maxLength: ['HTML'], required: ['OPENAPI'], format: ['OPENAPI'] },
    });
    expect(email.conflicts?.map((conflict) => conflict.constraint)).toEqual(['maxLength']);
    const role = extractor.extract(
      field({
        name: 'role',
        type: 'select',
        options: [
          { label: '-- Choisir --', disabled: false, placeholder: true },
          { label: 'Lecteur', disabled: false, placeholder: false },
        ],
      }),
      contract,
    );
    // Un choix à l'écran, deux dans l'API : le nombre de choix diffère.
    expect(role.enum).toEqual(['Lecteur']);
    expect(role.conflicts?.[0]).toMatchObject({ constraint: 'enum', effective: 'HTML' });
    expect(extractor.extract(field({ pattern: '[0-9]{5}', required: true }))).toMatchObject({
      pattern: '[0-9]{5}',
      required: true,
      sources: { pattern: ['HTML'], required: ['HTML'] },
    });
  });

  it('never the constraints of a sensitive field', () => {
    const form: DiscoveredForm = {
      id: 's:form:0',
      stateId: 's',
      group: 'form:0',
      name: 'x',
      fields: [field({ id: 'pwd', sensitive: true, minLength: 8 }), field({ id: 'age', name: 'age' })],
      submitActions: [],
      validationMessages: [],
      foreground: false,
    };
    expect(Object.keys(extractor.extractForm(form, contract))).toEqual(['age']);
  });
});

describe('BoundaryValueGenerator', () => {
  const generator = new SimpleBoundaryValueGenerator();

  it('min 18, max 65 → valid 18 19 64 65, invalid 17 66', () => {
    const cases = generator.generate({ min: 18, max: 65 });
    expect(cases.filter((entry) => entry.valid).map((entry) => entry.value)).toEqual([
      '18',
      '19',
      '64',
      '65',
    ]);
    expect(cases.filter((entry) => !entry.valid).map((entry) => entry.value)).toEqual(['17', '66']);
  });

  it('length 3..20 → 2, 3, 4, 19, 20, 21 characters; the number of cases is limited', () => {
    const lengths = generator.generate({ minLength: 3, maxLength: 20 }).map((entry) => entry.value.length);
    expect([...lengths].sort((a, b) => a - b)).toEqual([2, 3, 4, 19, 20, 21]);
    expect(
      new SimpleBoundaryValueGenerator(3).generate({ min: 1, max: 9, minLength: 1, maxLength: 3 }),
    ).toHaveLength(3);
  });
});

describe('equivalence partitioning', () => {
  it('age 18..65 → <18, 18..65, >65: one representative each', () => {
    expect(equivalencePartitions({ min: 18, max: 65 })).toEqual([
      { name: '<18', valid: false, representative: '13' },
      { name: '18..65', valid: true, representative: '42' },
      { name: '>65', valid: false, representative: '70' },
    ]);
    expect(
      equivalencePartitions({ format: 'email', required: true }).map((partition) => partition.name),
    ).toEqual(['well-formed e-mail', 'malformed e-mail', 'empty']);
  });
});

describe('PropertyTestGenerator', () => {
  it('all valid first, then one factor at a time, invalid first, within the budget', () => {
    const form: DiscoveredForm = {
      id: 's:form:0',
      stateId: 's',
      group: 'form:0',
      name: 'Nouvel utilisateur',
      fields: [field({ id: 'age', label: 'Âge', type: 'number' }), field({ id: 'name', label: 'Nom' })],
      submitActions: [],
      validationMessages: [],
      foreground: false,
    };
    const cases = new OneFactorPropertyTestGenerator().generate(
      form,
      { age: { min: 18, max: 65 }, name: { minLength: 3, maxLength: 20, required: true } },
      5,
    );
    expect(cases).toHaveLength(5);
    expect(cases[0]).toEqual({
      id: 'all-valid',
      description: 'all fields valid',
      values: { age: '42', name: 'xxxxxxxxxxxx' },
      expectation: 'ACCEPTED',
    });
    expect(cases.slice(1).map((entry) => [entry.fieldId, entry.expectation])).toEqual([
      ['age', 'REJECTED'],
      ['name', 'REJECTED'],
      ['age', 'REJECTED'],
      ['name', 'REJECTED'],
    ]);
    // Un seul champ varie, l'autre garde sa valeur valide.
    expect(cases[1]?.values).toEqual({ age: '13', name: 'xxxxxxxxxxxx' });
    expect(cases[1]?.description).toBe('Âge: <18 ("13")');
  });
});
