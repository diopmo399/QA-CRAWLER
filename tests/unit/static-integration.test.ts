import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DomOpenApiConstraintExtractor } from '../../src/constraints/constraints.js';
import { equivalencePartitions } from '../../src/constraints/test-case-generators.js';
import { DefaultTestDataProvider } from '../../src/data/test-data-provider.js';
import { fieldOf } from '../../src/forms/form-analyzer.js';
import type { UiElement } from '../../src/model/ui-snapshot.js';
import { parseOpenApi, type ApiContract } from '../../src/oracles/api-contract.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { StaticKnowledge, annotateStaticFields } from '../../src/static-analysis/static-knowledge.js';
import { element, screen, staticAnalyzerOptions } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');
const vocabulary = new SemanticVocabulary(new SemanticDictionary());

const bare = (frameworkName: string, overrides: Partial<UiElement> = {}): UiElement =>
  element({
    tag: 'input',
    role: 'textbox',
    name: '',
    inputType: 'text',
    frameworkName,
    formGroup: 'form:0',
    css: `input[formcontrolname="${frameworkName}"]`,
    ...overrides,
  });

describe('static knowledge in forms, test data and constraints (lot G)', () => {
  let knowledge: StaticKnowledge;
  let contract: ApiContract;

  beforeAll(async () => {
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(FIXTURE);
    contract = parseOpenApi(await readFile(path.join(FIXTURE, 'openapi.yaml'), 'utf8'));
    knowledge = new StaticKnowledge(graph, (text) => vocabulary.conceptOf(text)?.concept, contract);
  });

  const annotated = (...elements: UiElement[]) => {
    const context = screen({ url: 'http://localhost:4200/administration/users/new', elements });
    annotateStaticFields(knowledge, context.actions, '/administration/users/new');
    return context.actions;
  };

  it('a mute field (type=text, no label) gets its concept, API property and validators', () => {
    const [contact] = annotated(bare('contact'));
    expect(contact?.field).toMatchObject({
      staticConcept: 'email',
      staticProperty: 'email',
      staticValidators: [{ kind: 'required' }, { kind: 'email' }],
    });
  });

  it('TestDataProvider: the proven concept gives a synthetic e-mail, not "Test value"', () => {
    const [contact] = annotated(bare('contact'));
    if (!contact) throw new Error('no action');
    const value = new DefaultTestDataProvider({ runId: 'r1' }).validValue(fieldOf(contact));
    expect(value.kind).toBe('fill');
    expect(value.value).toMatch(/^[^@\s]+@example\.test$/);
  });

  it('without static knowledge the same mute field gets the fallback text (non-regression)', () => {
    const context = screen({
      url: 'http://localhost:4200/administration/users/new',
      elements: [bare('contact')],
    });
    const [contact] = context.actions;
    if (!contact) throw new Error('no action');
    expect(new DefaultTestDataProvider({ runId: 'r1' }).validValue(fieldOf(contact)).value).not.toContain(
      '@',
    );
  });

  it('constraints: HTML=100, Angular=100, OpenAPI=80 → CONSTRAINT_MISMATCH, never chosen silently; required and email converge', () => {
    const [firstName, contact] = annotated(bare('firstName', { maxLength: 100 }), bare('contact'));
    if (!firstName || !contact) throw new Error('no action');
    const extractor = new DomOpenApiConstraintExtractor();
    const name = extractor.extract(fieldOf(firstName), contract);
    expect(name.sources?.maxLength).toEqual(['HTML', 'FRAMEWORK']);
    expect(name.conflicts).toContainEqual(
      expect.objectContaining({
        kind: 'CONSTRAINT_MISMATCH',
        constraint: 'maxLength',
        values: [
          { source: 'HTML', value: 100 },
          { source: 'OPENAPI', value: 80 },
        ],
      }),
    );
    const email = extractor.extract(fieldOf(contact), contract);
    expect(email.required).toBe(true);
    expect(email.sources?.required).toEqual(['FRAMEWORK', 'OPENAPI']);
    expect(email.format).toBe('email');
    expect(email.sources?.format).toEqual(['FRAMEWORK', 'OPENAPI']);
    expect((email.confidence?.format ?? 0) > 0.8).toBe(true);
  });

  it('negative testing: the static validators give REQUIRED_EMPTY, INVALID_FORMAT and ABOVE_MAX_LENGTH cases', () => {
    const [firstName, contact] = annotated(bare('firstName'), bare('contact'));
    if (!firstName || !contact) throw new Error('no action');
    const extractor = new DomOpenApiConstraintExtractor();
    const emailCases = equivalencePartitions(extractor.extract(fieldOf(contact), contract)).map(
      (entry) => entry.name,
    );
    expect(emailCases).toEqual(expect.arrayContaining(['empty', 'malformed e-mail']));
    const nameCases = equivalencePartitions(extractor.extract(fieldOf(firstName))).map((entry) => entry.name);
    expect(nameCases).toEqual(expect.arrayContaining(['empty', 'length >100']));
  });
});
