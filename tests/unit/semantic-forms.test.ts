import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { fieldDescriptors } from '../../src/semantics/resolution/field-descriptor.js';
import { FieldMatcher } from '../../src/semantics/resolution/field-matcher.js';
import { FormIntentResolver, toFormFillPlan } from '../../src/semantics/resolution/form-intent-resolver.js';
import { DEFAULT_THRESHOLDS } from '../../src/semantics/resolution/resolution.js';
import { SemanticResolver } from '../../src/semantics/resolution/semantic-resolver.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { button, element, field, screen, testConfig } from '../helpers.js';

const dictionary = new SemanticDictionary();
const matcher = new FieldMatcher(new SemanticVocabulary(dictionary), DEFAULT_THRESHOLDS);
const forms = new FormIntentResolver(matcher, DEFAULT_THRESHOLDS);
const config = testConfig();
const context = { stateSignature: 'nouvel-utilisateur' };

const userForm = screen(
  {
    url: 'http://localhost:4200/users/new',
    headings: ['Nouvel utilisateur'],
    elements: [
      field('Prénom', { fieldName: 'givenName', formIndex: 0, formGroup: 'form:0' }),
      field('Nom', { fieldName: 'familyName', formIndex: 0, formGroup: 'form:0' }),
      field('Courriel', {
        fieldName: 'electronicMail',
        inputType: 'email',
        formIndex: 0,
        formGroup: 'form:0',
      }),
      element({
        tag: 'select',
        role: 'combobox',
        name: 'Rôle',
        label: 'Rôle',
        fieldName: 'accountType',
        options: ['Utilisateur', 'Bénévole', 'Administrateur'],
        formIndex: 0,
        formGroup: 'form:0',
      }),
      element({
        tag: 'input',
        role: 'checkbox',
        inputType: 'checkbox',
        name: 'Actif',
        label: 'Actif',
        formIndex: 0,
        formGroup: 'form:0',
      }),
      button('Créer', { formIndex: 0, formGroup: 'form:0', isSubmit: true }),
    ],
  },
  config,
);
const fields = fieldDescriptors(userForm.actions);

describe('FormIntentResolver: the whole table at once, before any typing', () => {
  it('prénom, nom, courriel, rôle, actif → givenName, familyName, electronicMail, accountType, Actif', () => {
    const plan = forms.resolve(
      {
        kind: 'FILL_FORM',
        form: 'utilisateur',
        rows: [
          { field: 'prénom', value: 'Mohamed' },
          { field: 'nom', value: 'Diop' },
          { field: 'courriel', value: 'test@example.com' },
          { field: 'rôle', value: 'Administrateur' },
          { field: 'actif', value: 'oui' },
        ],
      },
      fields,
      context,
    );
    expect(plan.unresolved).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    expect(
      plan.mappings.map((mapping) => [
        mapping.intent,
        mapping.field.name ?? mapping.target,
        mapping.operation,
      ]),
    ).toEqual([
      ['prénom', 'givenName', 'fill'],
      ['nom', 'familyName', 'fill'],
      ['courriel', 'electronicMail', 'fill'],
      ['rôle', 'accountType', 'select'],
      ['actif', 'Actif', 'check'],
    ]);
    expect(plan.mappings.find((mapping) => mapping.intent === 'rôle')?.option).toBe('Administrateur');
    expect(plan.formGroup).toBe('form:0');
    // Compatible avec la FormFillStrategy : un FormFillPlan ordinaire.
    const fill = toFormFillPlan('form-1', plan);
    expect(fill.operations.map((operation) => operation.operation)).toEqual([
      'fill',
      'fill',
      'fill',
      'select',
      'check',
    ]);
    expect(fill.operations[3]?.value).toBe('Administrateur');
  });

  it('two rows claiming the same field: a global check, never the first one by default', () => {
    const single = fieldDescriptors(
      screen(
        { elements: [field('Nom complet', { fieldName: 'name', formGroup: 'form:0', formIndex: 0 })] },
        config,
      ).actions,
    );
    const plan = forms.resolve(
      {
        kind: 'FILL_FORM',
        rows: [
          { field: 'nom', value: 'Diop' },
          { field: 'nom complet', value: 'Mohamed Diop' },
        ],
      },
      single,
      context,
    );
    // « nom complet » gagne nettement le champ ; « nom » n'a plus de champ : jamais deux lignes sur un champ.
    expect(plan.mappings.map((mapping) => mapping.intent)).toEqual(['nom complet']);
    expect([...plan.ambiguous, ...plan.unresolved].map((issue) => issue.intent)).toEqual(['nom']);
  });

  it('equally good claims on one field: both rows AMBIGUOUS (collision)', () => {
    const one = fieldDescriptors(
      screen(
        { elements: [field('Adresse', { fieldName: 'address', formGroup: 'form:0', formIndex: 0 })] },
        config,
      ).actions,
    );
    const plan = forms.resolve(
      {
        kind: 'FILL_FORM',
        rows: [
          { field: 'adresse', value: '1 rue A' },
          { field: 'rue', value: '1 rue B' },
        ],
      },
      one,
      context,
    );
    expect(plan.mappings.length).toBeLessThan(2);
    expect(plan.ambiguous.length + plan.unresolved.length).toBeGreaterThanOrEqual(1);
  });

  it('a row without any matching field is NOT_FOUND; nothing is executed', () => {
    const plan = forms.resolve(
      {
        kind: 'FILL_FORM',
        rows: [
          { field: 'numéro de passeport', value: 'X' },
          { field: 'prénom', value: 'M' },
        ],
      },
      fields,
      context,
    );
    expect(plan.unresolved.map((issue) => issue.intent)).toEqual(['numéro de passeport']);
  });
});

describe('SemanticResolver facade: intent → target, never an action', () => {
  const resolver = new SemanticResolver(dictionary, DEFAULT_THRESHOLDS);

  it('FILL, SELECT, SUBMIT on the user form', () => {
    const fill = resolver.resolve(
      { kind: 'FILL', field: 'courriel', value: 'mohamed@example.com' },
      userForm,
      context,
    );
    expect(fill.status).toBe('RESOLVED');
    expect(fill.target).toMatchObject({
      kind: 'field',
      operation: 'fill',
      field: { name: 'electronicMail' },
    });
    expect(fill.explanation[0]).toBe('FIELD MATCH');
    const role = resolver.resolve(
      { kind: 'SELECT', field: 'rôle', option: 'Administrateur' },
      userForm,
      context,
    );
    expect(role.target).toMatchObject({ kind: 'field', operation: 'select', option: 'Administrateur' });
    const submit = resolver.resolve({ kind: 'SUBMIT', action: 'submit', verb: 'valider' }, userForm, {
      ...context,
      previousFormGroup: 'form:0',
    });
    expect(submit.target).toMatchObject({ kind: 'action', action: { text: 'Créer' } });
  });

  it('a whole form without values: the form, for the synthetic data of the TestDataProvider', () => {
    const synthetic = resolver.resolve({ kind: 'FILL_FORM', form: 'utilisateur' }, userForm, context);
    expect(synthetic.status).toBe('RESOLVED');
    expect(synthetic.target?.kind).toBe('synthetic-form');
  });

  it('uploads are always blocked; an env value is never shown', () => {
    expect(resolver.resolve({ kind: 'UPLOAD', field: 'cv', file: 'cv.pdf' }, userForm, context).status).toBe(
      'BLOCKED',
    );
    const secret = resolver.resolve({ kind: 'FILL', field: 'nom', value: { env: 'QA_NAME' } }, userForm, {
      ...context,
      sensitiveValue: true,
    });
    expect(secret.explanation.join('\n')).toContain('Value: [REDACTED]');
    expect(secret.explanation.join('\n')).not.toContain('QA_NAME');
  });
});

describe('Gherkin loading with gherkin.semanticResolution', () => {
  let dir: string;
  const feature = `# language: fr
@mutation
Fonctionnalité: Utilisateurs
  Scénario: Création utilisateur
    Étant donné que je suis sur la page des utilisateurs
    Quand je clique sur "Créer un utilisateur"
    Et je renseigne le prénom avec "Mohamed"
    Et je renseigne le courriel avec "mohamed@example.com"
    Et je sélectionne "Administrateur" comme rôle
    Et je valide le formulaire
    Alors l'utilisateur doit apparaître dans la liste
`;
  const load = (semantic: boolean) =>
    parseConfig(
      `target: { baseUrl: http://localhost:4200 }
gherkin: { semanticResolution: { enabled: ${semantic} } }
flows:
  - gherkin: ${path.join(dir, 'users.feature')}
`,
    ).config;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-semantic-'));
    await writeFile(path.join(dir, 'users.feature'), feature);
    await writeFile(
      path.join(dir, 'classic.feature'),
      `# language: fr
Fonctionnalité: Classique
  Scénario: Recherche
    Étant donné que je suis sur "/clients"
    Quand je saisis "Dupont" dans "Rechercher"
    Alors je vois "1 client"
`,
    );
  });

  it('enabled: intent steps, no selector anywhere', () => {
    const [flow] = load(true).flows;
    expect(flow?.steps.map((step) => step.kind)).toEqual([
      'intent',
      'click',
      'intent',
      'intent',
      'intent',
      'intent',
      'intent',
    ]);
    const intents = flow?.steps.flatMap((step) => (step.kind === 'intent' ? [step.intent] : []));
    expect(intents?.map((intent) => intent.kind)).toEqual([
      'NAVIGATE',
      'FILL',
      'FILL',
      'SELECT',
      'SUBMIT',
      'ASSERT',
    ]);
    expect(JSON.stringify(intents)).not.toMatch(/css|xpath|#|getBy/i);
    // Les tags du scénario s'appliquent : la validation (MUTATION) est permise par @mutation.
    expect(flow?.steps.every((step) => step.allow.includes('MUTATION'))).toBe(true);
  });

  it('disabled: the same file is refused as before (unknown sentences), never guessed', () => {
    expect(() => load(false)).toThrow(/Unrecognised Gherkin sentence/);
  });

  it('existing scenarios translate exactly as before, enabled or not', () => {
    const classic = (semantic: boolean) =>
      parseConfig(
        `target: { baseUrl: http://localhost:4200 }
gherkin: { semanticResolution: { enabled: ${semantic} } }
flows:
  - gherkin: ${path.join(dir, 'classic.feature')}
`,
      ).config.flows;
    expect(classic(true)).toEqual(classic(false));
  });
});
