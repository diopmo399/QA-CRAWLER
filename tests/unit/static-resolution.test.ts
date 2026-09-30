import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { UiElement } from '../../src/model/ui-snapshot.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import type { FieldDescriptor } from '../../src/semantics/resolution/field-descriptor.js';
import { DEFAULT_THRESHOLDS } from '../../src/semantics/resolution/resolution.js';
import { SemanticResolver, type ResolveOptions } from '../../src/semantics/resolution/semantic-resolver.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { StaticKnowledge } from '../../src/static-analysis/static-knowledge.js';
import { button, element, screen, staticAnalyzerOptions } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');
const resolver = new SemanticResolver(new SemanticDictionary(), DEFAULT_THRESHOLDS);

/** Un champ sans libellé, sans aria-label, sans placeholder, sans name : seulement formControlName. */
const bare = (frameworkName: string, overrides: Partial<UiElement> = {}): UiElement =>
  element({
    tag: 'input',
    role: 'textbox',
    name: '',
    inputType: 'text',
    frameworkName,
    formGroup: 'form:0',
    formIndex: 0,
    css: `input[formcontrolname="${frameworkName}"]`,
    ...overrides,
  });

describe('semantic resolution with static evidence (lot F)', () => {
  let knowledge: StaticKnowledge;
  const createUser = screen({
    url: 'http://localhost:4200/administration/users/new',
    headings: ['Nouvel utilisateur'],
    elements: [
      bare('firstName'),
      bare('contact'),
      bare('phone', { inputType: 'tel' }),
      button('Enregistrer'),
    ],
  });
  const withStatic = (pathname: string): ResolveOptions => ({
    stateSignature: 'create-user',
    staticEvidence: (field: FieldDescriptor) => knowledge.provenanceFor(field.frameworkName, pathname),
  });

  beforeAll(async () => {
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(FIXTURE);
    const contract = parseOpenApi(await readFile(path.join(FIXTURE, 'openapi.yaml'), 'utf8'));
    knowledge = new StaticKnowledge(graph, (text) => resolver.vocabulary.conceptOf(text)?.concept, contract);
  });

  it('an input without label, aria-label, placeholder or name, type=text: resolved as EMAIL thanks to the code and the API', () => {
    const resolution = resolver.resolve(
      { kind: 'FILL', field: 'courriel', value: 'test@example.com' },
      createUser,
      withStatic('/administration/users/new'),
    );
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.target).toMatchObject({ kind: 'field', field: { frameworkName: 'contact' } });
    expect(['HIGH', 'VERY_HIGH']).toContain(resolution.confidence);
    const explained = resolution.explanation.join('\n');
    expect(explained).toContain('static evidence means email');
    expect(explained).toContain('contact → request.email → CreateUserRequest.email → POST /api/users');
    expect(explained).toContain('format=email');
    expect(explained).toMatch(/independent sources agree/);
  });

  it('without static analysis the same screen is not resolved (nothing to tell the three bare fields apart)', () => {
    const resolution = resolver.resolve(
      { kind: 'FILL', field: 'courriel', value: 'test@example.com' },
      createUser,
      { stateSignature: 'create-user' },
    );
    expect(resolution.status).not.toBe('RESOLVED');
  });

  it('contradiction: DOM type=tel, code backupEmail, OpenAPI format=email → SEMANTIC_EVIDENCE_CONFLICT, explained, never hidden', () => {
    const phoneOnly = screen({
      url: 'http://localhost:4200/administration/users/new',
      elements: [bare('phone', { inputType: 'tel' })],
    });
    const resolution = resolver.resolve(
      { kind: 'FILL', field: 'courriel', value: 'test@example.com' },
      phoneOnly,
      withStatic('/administration/users/new'),
    );
    expect(resolution.reasons.join('\n')).toContain(
      'SEMANTIC_EVIDENCE_CONFLICT: DOM type=tel means phone, code/API mean email',
    );
    // Un courriel ne rentre pas dans un champ tel : les règles de confiance refusent de résoudre.
    expect(resolution.status).not.toBe('RESOLVED');
  });

  it('ambiguity: primaryContact → primaryEmail and secondaryContact → secondaryEmail: "le courriel" is AMBIGUOUS, with both candidates', () => {
    const contacts = screen({
      url: 'http://localhost:4200/administration/users/7/contacts',
      elements: [bare('primaryContact'), bare('secondaryContact'), button('Enregistrer')],
    });
    const resolution = resolver.resolve(
      { kind: 'FILL', field: 'courriel', value: 'test@example.com' },
      contacts,
      withStatic('/administration/users/7/contacts'),
    );
    expect(resolution.status).toBe('AMBIGUOUS');
    expect(resolution.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('a visible label still wins over static evidence (the code enlightens a poor field, it never overrides what the user sees)', () => {
    const labelled = screen({
      url: 'http://localhost:4200/administration/users/new',
      elements: [
        bare('contact'),
        element({
          tag: 'input',
          role: 'textbox',
          name: 'Courriel',
          label: 'Courriel',
          inputType: 'email',
          css: '#mail',
        }),
      ],
    });
    const resolution = resolver.resolve(
      { kind: 'FILL', field: 'courriel', value: 'test@example.com' },
      labelled,
      withStatic('/administration/users/new'),
    );
    // Le libellé visible (preuve la plus forte) l'emporte nettement sur le champ nu prouvé par le code.
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.target).toMatchObject({ field: { label: 'Courriel' } });
  });
});
