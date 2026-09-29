import { describe, expect, it } from 'vitest';
import { DomOpenApiConstraintExtractor, formConflicts } from '../../src/constraints/constraints.js';
import { enrichWithContract } from '../../src/forms/contract-enrichment.js';
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

const api = (version: string, properties: string, required = '[]') =>
  parseOpenApi(`
openapi: ${version}
info: { title: t, version: '1' }
paths:
  /api/items:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: ${required}
              properties:
${properties}
      responses: { '201': { description: ok } }
`);

const extractor = new DomOpenApiConstraintExtractor();

describe('constraint model: the page (HTML, ARIA)', () => {
  it('reads every HTML constraint from the FormAnalyzer field, with its origin', () => {
    const constraints = extractor.extract(
      field({
        type: 'number',
        required: true,
        requiredBy: ['HTML'],
        min: 18,
        max: 120,
        step: 1,
        minLength: 1,
        maxLength: 3,
        pattern: '[0-9]+',
        multiple: true,
        disabled: true,
        readonly: true,
      }),
    );
    expect(constraints).toMatchObject({
      required: true,
      type: 'number',
      format: 'number',
      min: 18,
      max: 120,
      step: 1,
      minLength: 1,
      maxLength: 3,
      pattern: '[0-9]+',
      multiple: true,
      disabled: true,
      readonly: true,
      control: 'number',
    });
    for (const key of ['required', 'min', 'max', 'step', 'minLength', 'maxLength', 'pattern'] as const)
      expect(constraints.sources?.[key]).toEqual(['HTML']);
    expect(constraints.confidence?.min).toBe(0.8);
    expect(constraints.conflicts).toBeUndefined();
  });

  it('aria-required is an ARIA source; both attributes agree and raise the confidence', () => {
    const aria = extractor.extract(field({ required: true, requiredBy: ['ARIA'] }));
    expect(aria.sources?.required).toEqual(['ARIA']);
    expect(aria.confidence?.required).toBe(0.75);
    const both = extractor.extract(field({ required: true, requiredBy: ['HTML', 'ARIA'] }));
    expect(both.sources?.required).toEqual(['HTML', 'ARIA']);
    expect(both.confidence?.required).toBe(0.95);
  });

  it('records aria-invalid as an observation, not as a constraint', () => {
    const constraints = extractor.extract(field({ ariaInvalid: true }));
    expect(constraints.observedInvalid).toBe(true);
    expect(constraints.sources).toEqual({});
  });

  it('control kind tells what "empty" means (select, checkbox, radio)', () => {
    expect(extractor.extract(field({ type: 'select' })).control).toBe('select');
    expect(extractor.extract(field({ type: 'checkbox' })).type).toBe('boolean');
    expect(extractor.extract(field({ type: 'radio', choiceGroup: 'name:r' })).control).toBe('radio');
  });
});

describe('constraint model: OpenAPI', () => {
  it('reads required, nullable, type, format, bounds, lengths, pattern and enum', () => {
    const contract = api(
      '3.0.0',
      `                code: { type: string, nullable: true, format: uuid, minLength: 36, maxLength: 36, pattern: '^[0-9a-f-]+$' }
                score: { type: number, minimum: 0, maximum: 10, exclusiveMinimum: true, exclusiveMaximum: true }
                level: { type: string, enum: [LOW, HIGH] }`,
      '[code]',
    );
    const code = extractor.extract(field({ name: 'code' }), contract);
    expect(code).toMatchObject({
      required: true,
      nullable: true,
      type: 'string',
      format: 'uuid',
      minLength: 36,
      maxLength: 36,
      pattern: '^[0-9a-f-]+$',
    });
    expect(code.sources?.nullable).toEqual(['OPENAPI']);
    expect(code.confidence?.format).toBe(0.7);
    // OpenAPI 3.0 : exclusiveMinimum: true rend minimum exclusif.
    const score = extractor.extract(field({ name: 'score' }), contract);
    expect(score).toMatchObject({ exclusiveMinimum: 0, exclusiveMaximum: 10 });
    expect(score.min).toBeUndefined();
    expect(score.max).toBeUndefined();
    expect(extractor.extract(field({ name: 'level' }), contract).enum).toEqual(['LOW', 'HIGH']);
  });

  it('OpenAPI 3.1: numeric exclusive bounds and a "null" type', () => {
    const contract = api(
      '3.1.0',
      `                age: { type: [integer, 'null'], exclusiveMinimum: 17, exclusiveMaximum: 121 }`,
    );
    expect(extractor.extract(field({ name: 'age' }), contract)).toMatchObject({
      type: 'integer',
      nullable: true,
      exclusiveMinimum: 17,
      exclusiveMaximum: 121,
    });
  });
});

describe('constraint model: HTML + OpenAPI', () => {
  const contract = api(
    '3.0.0',
    `                email: { type: string, format: email, minLength: 5, maxLength: 100 }
                nickname: { type: string, maxLength: 80, pattern: '^[a-z]+$' }
                age: { type: integer, minimum: 18, maximum: 120 }
                role: { type: string, enum: [USER, ADMIN] }
                website: { type: string, format: uri }`,
    '[email]',
  );

  it('same value on both sides: both sources kept, confidence up', () => {
    const email = extractor.extract(
      field({ name: 'email', type: 'email', required: true, requiredBy: ['HTML'], maxLength: 100 }),
      contract,
    );
    expect(email.maxLength).toBe(100);
    expect(email.sources?.maxLength).toEqual(['HTML', 'OPENAPI']);
    expect(email.confidence?.maxLength).toBe(0.95);
    expect(email.sources?.required).toEqual(['HTML', 'OPENAPI']);
    expect(email.sources?.format).toEqual(['HTML', 'OPENAPI']);
    // Seule l'API le dit.
    expect(email.minLength).toBe(5);
    expect(email.sources?.minLength).toEqual(['OPENAPI']);
    expect(email.conflicts).toBeUndefined();
  });

  it('HTML maxlength=100 vs OpenAPI maxLength=80: CONSTRAINT_MISMATCH, never settled silently', () => {
    const nickname = extractor.extract(field({ name: 'nickname', maxLength: 100 }), contract);
    expect(nickname.maxLength).toBe(100);
    expect(nickname.sources?.maxLength).toEqual(['HTML']);
    expect(nickname.confidence?.maxLength).toBe(0.5);
    expect(nickname.conflicts).toEqual([
      {
        kind: 'CONSTRAINT_MISMATCH',
        constraint: 'maxLength',
        values: [
          { source: 'HTML', value: 100 },
          { source: 'OPENAPI', value: 80 },
        ],
        effective: 'HTML',
        reason: expect.stringContaining('HTML and OPENAPI disagree on maxLength') as string,
      },
    ]);
  });

  it('a pattern with or without anchors is the same pattern', () => {
    const nickname = extractor.extract(field({ name: 'nickname', pattern: '[a-z]+' }), contract);
    expect(nickname.sources?.pattern).toEqual(['HTML', 'OPENAPI']);
    expect(nickname.conflicts).toBeUndefined();
  });

  it('number + integer is a refinement, not a conflict; url and uri are the same format', () => {
    const age = extractor.extract(field({ name: 'age', type: 'number', min: 18, max: 120 }), contract);
    expect(age.format).toBe('integer');
    expect(age.conflicts).toBeUndefined();
    expect(age.sources?.min).toEqual(['HTML', 'OPENAPI']);
    const website = extractor.extract(field({ name: 'website', type: 'url' }), contract);
    expect(website.format).toBe('uri');
    expect(website.sources?.format).toEqual(['HTML', 'OPENAPI']);
  });

  it('min 21 vs minimum 18 and email vs date are mismatches; labels vs enum values with the same count are not', () => {
    const conflicts = formConflicts(
      extractor.extractForm(
        {
          id: 's:form:0',
          stateId: 's',
          group: 'form:0',
          name: 'x',
          fields: [
            field({ id: 'age', name: 'age', type: 'number', min: 21 }),
            field({ id: 'email', name: 'email', type: 'date' }),
            field({
              id: 'role',
              name: 'role',
              type: 'select',
              options: [
                { label: 'Utilisateur', disabled: false, placeholder: false },
                { label: 'Administrateur', disabled: false, placeholder: false },
              ],
            }),
          ],
          submitActions: [],
          validationMessages: [],
          foreground: false,
        },
        contract,
      ),
    );
    expect(conflicts.map((conflict) => `${conflict.fieldId}:${conflict.constraint}`)).toEqual([
      'age:min',
      'email:format',
    ]);
  });

  it('what enrichWithContract added to a field is not mistaken for a page declaration', () => {
    const form: DiscoveredForm = {
      id: 's:form:0',
      stateId: 's',
      group: 'form:0',
      name: 'x',
      fields: [field({ id: 'email', name: 'email' })],
      submitActions: [],
      validationMessages: [],
      foreground: false,
    };
    const enriched = enrichWithContract(form, contract);
    expect(enriched.fields[0]).toMatchObject({ type: 'email', maxLength: 100, required: true });
    const email = extractor.extractForm(enriched, contract).email;
    expect(email?.sources).toMatchObject({
      maxLength: ['OPENAPI'],
      required: ['OPENAPI'],
      format: ['OPENAPI'],
    });
    expect(email?.conflicts).toBeUndefined();
  });
});
