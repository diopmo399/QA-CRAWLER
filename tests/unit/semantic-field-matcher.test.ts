import { describe, expect, it } from 'vitest';
import { describeField, fieldDescriptors } from '../../src/semantics/resolution/field-descriptor.js';
import { FieldMatcher } from '../../src/semantics/resolution/field-matcher.js';
import {
  decide,
  DEFAULT_THRESHOLDS,
  explainResolution,
  POINTS_FOR_CERTAINTY,
  rank,
  type ResolutionCandidate,
} from '../../src/semantics/resolution/resolution.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { element, field, screen, testConfig } from '../helpers.js';

const vocabulary = new SemanticVocabulary(new SemanticDictionary());
const matcher = new FieldMatcher(vocabulary, DEFAULT_THRESHOLDS);
const context = { stateSignature: 'create-user' };
const config = testConfig();

const select = (label: string, options: string[], overrides = {}) =>
  element({ tag: 'select', role: 'combobox', name: label, label, options, ...overrides });
const radio = (label: string, group: string, groupLabel: string) =>
  element({
    tag: 'input',
    role: 'radio',
    inputType: 'radio',
    name: label,
    label,
    choiceGroup: group,
    groupLabel,
  });
const checkbox = (label: string) =>
  element({ tag: 'input', role: 'checkbox', inputType: 'checkbox', name: label, label });

/** L'écran de création d'un utilisateur : les name du DOM ne ressemblent PAS aux mots du scénario. */
const form = screen(
  {
    url: 'http://localhost:4200/users/new',
    headings: ['Nouvel utilisateur'],
    elements: [
      field('Prénom', { fieldName: 'givenName', formIndex: 0 }),
      field('Nom', { fieldName: 'familyName', formIndex: 0 }),
      field('Adresse électronique', { fieldName: 'electronicMail', inputType: 'email', formIndex: 0 }),
      field('Téléphone', { fieldName: 'phoneNumber', inputType: 'tel', formIndex: 0 }),
      field('Date de naissance', { fieldName: 'birth', inputType: 'date', formIndex: 0 }),
      field('Nombre de postes', { fieldName: 'seats', inputType: 'number', formIndex: 0 }),
      select('Rôle', ['-- Choisir --', 'Utilisateur', 'Bénévole', 'Administrateur'], {
        fieldName: 'accountType',
      }),
      radio('Mensuel', 'freq', 'Fréquence'),
      radio('Annuel', 'freq', 'Fréquence'),
      checkbox('Actif'),
    ],
  },
  config,
);
const fields = fieldDescriptors(form.actions);

describe('FieldDescriptor', () => {
  it('is built from what discovery already knows (label, name, type, options), never the value', () => {
    const email = fields.find((entry) => entry.name === 'electronicMail');
    expect(email).toMatchObject({
      label: 'Adresse électronique',
      type: 'email',
      sensitive: false,
      payment: false,
    });
    const role = fields.find((entry) => entry.name === 'accountType');
    expect(role?.options?.map((option) => option.label)).toEqual([
      '-- Choisir --',
      'Utilisateur',
      'Bénévole',
      'Administrateur',
    ]);
    expect(role?.options?.[0]?.placeholder).toBe(true);
    const [code] = screen({ elements: [field('Code', { elementId: 'mat-input-23' })] }, config).actions;
    if (!code) throw new Error('no field');
    const dynamic = describeField(code);
    expect(dynamic.idAttribute).toBeUndefined();
  });
});

describe('FieldMatcher: the scenario names a meaning, the screen a label', () => {
  const resolve = (fieldIntent: string, value = 'x') =>
    matcher.resolve({ kind: 'FILL', field: fieldIntent, value }, fields, context);

  it('Prénom / prenom / first name → givenName, without a naive name equality', () => {
    for (const intent of ['Prénom', 'prenom', 'prénom', 'first name', 'firstName']) {
      const result = resolve(intent, 'Mohamed');
      expect(result.status, intent).toBe('RESOLVED');
      expect(result.selected?.field.name, intent).toBe('givenName');
    }
  });

  it('nom / last name → familyName, never the Prénom field', () => {
    for (const intent of ['nom', 'last name', 'nom de famille']) {
      const result = resolve(intent, 'Diop');
      expect(result.selected?.field.name, intent).toBe('familyName');
      expect(result.candidates.find((candidate) => candidate.label === 'Prénom')?.score ?? 0).toBeLessThan(
        0.25,
      );
    }
  });

  it('courriel / mail / email → the field labelled "Adresse électronique", explained', () => {
    for (const intent of ['courriel', 'mail', 'email', 'e-mail']) {
      const result = resolve(intent, 'mohamed@example.com');
      expect(result.status, intent).toBe('RESOLVED');
      expect(result.selected?.field.name, intent).toBe('electronicMail');
    }
    const result = resolve('courriel', 'mohamed@example.com');
    expect(result.valueType).toBe('EMAIL');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        '+70 semantic alias "courriel" → email ← label "Adresse électronique"',
        '+15 type=email expected for email',
        '+15 value EMAIL fits type=email',
      ]),
    );
    expect(result.confidence).toBe('VERY_HIGH');
  });

  it('a value classified EMAIL favours input[type=email]; a date the date field; a number the numeric one', () => {
    const plain = screen(
      {
        elements: [
          field('Contact phone', { fieldName: 'contactPhone', inputType: 'tel' }),
          field('Contact email', { fieldName: 'contactMail', inputType: 'email' }),
        ],
      },
      config,
    );
    const both = fieldDescriptors(plain.actions);
    const email = matcher.resolve(
      { kind: 'FILL', field: 'contact', value: 'test@example.com' },
      both,
      context,
    );
    expect(email.status).toBe('RESOLVED');
    expect(email.selected?.field.name).toBe('contactMail');
    const phone = matcher.resolve(
      { kind: 'FILL', field: 'contact', value: '+1 418-555-1234' },
      both,
      context,
    );
    expect(phone.selected?.field.name).toBe('contactPhone');
    expect(resolve('date de naissance', '2026-09-28').selected?.field.type).toBe('date');
    expect(resolve('nombre de postes', '42').selected?.field.type).toBe('number');
    // Un texte dans un champ date : jamais choisi.
    expect(resolve('date de naissance', 'Mohamed').status).not.toBe('RESOLVED');
  });

  it('rôle → the select; the option "Administrateur" is resolved, never the first one', () => {
    const result = matcher.resolve(
      { kind: 'SELECT', field: 'rôle', option: 'Administrateur' },
      fields,
      context,
    );
    expect(result.status).toBe('RESOLVED');
    expect(result.selected?.field.name).toBe('accountType');
    expect(result.option?.selected?.label).toBe('Administrateur');
    const admin = matcher.resolve({ kind: 'SELECT', field: 'rôle', option: 'admin' }, fields, context);
    expect(admin.option?.selected?.label).toBe('Administrateur');
    const missing = matcher.resolve(
      { kind: 'SELECT', field: 'rôle', option: 'Superviseur' },
      fields,
      context,
    );
    expect(missing.status).not.toBe('RESOLVED');
  });

  it('a radio group is a choice list; check boxes are checked by meaning', () => {
    const result = matcher.resolve({ kind: 'SELECT', field: 'fréquence', option: 'Annuel' }, fields, context);
    expect(result.status).toBe('RESOLVED');
    expect(result.option?.radio?.label).toBe('Annuel');
    const active = matcher.resolve({ kind: 'CHECK', field: 'actif', checked: true }, fields, context);
    expect(active.selected?.label).toBe('Actif');
  });

  it('nothing on the screen: NOT_FOUND, never a guess', () => {
    const result = resolve('numéro de passeport', 'X123');
    expect(result.status).toBe('NOT_FOUND');
    expect(result.selected).toBeUndefined();
  });
});

describe('ambiguity: never choose arbitrarily between two close candidates', () => {
  it('Adresse principale / Adresse de facturation with "l\'adresse": AMBIGUOUS', () => {
    const addresses = fieldDescriptors(
      screen(
        {
          elements: [
            field('Adresse principale', { fieldName: 'mainAddress' }),
            field('Adresse de facturation', { fieldName: 'billingAddress' }),
          ],
        },
        config,
      ).actions,
    );
    const result = matcher.resolve({ kind: 'FILL', field: 'adresse', value: '1 rue X' }, addresses, context);
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.selected).toBeUndefined();
    expect(result.candidates.map((candidate) => candidate.label).sort()).toEqual([
      'Adresse de facturation',
      'Adresse principale',
    ]);
    // Le nom complet départage.
    const billing = matcher.resolve(
      { kind: 'FILL', field: 'adresse de facturation', value: 'x' },
      addresses,
      context,
    );
    expect(billing.status).toBe('RESOLVED');
    expect(billing.selected?.field.name).toBe('billingAddress');
  });

  const candidate = (label: string, score: number): ResolutionCandidate => ({
    id: label,
    label,
    score,
    points: score * POINTS_FOR_CERTAINTY,
    components: [],
  });

  it('0.91 vs 0.90 → AMBIGUOUS; 0.96 vs 0.60 → RESOLVED; 0.70 alone → AMBIGUOUS; 0.1 → NOT_FOUND', () => {
    expect(decide(rank([candidate('a', 0.91), candidate('b', 0.9)]), DEFAULT_THRESHOLDS).status).toBe(
      'AMBIGUOUS',
    );
    expect(decide(rank([candidate('a', 0.96), candidate('b', 0.6)]), DEFAULT_THRESHOLDS).status).toBe(
      'RESOLVED',
    );
    expect(decide(rank([candidate('a', 0.7)]), DEFAULT_THRESHOLDS).status).toBe('AMBIGUOUS');
    expect(decide(rank([candidate('a', 0.1)]), DEFAULT_THRESHOLDS).status).toBe('NOT_FOUND');
    expect(decide(rank([candidate('a', 0.85), candidate('b', 0.7)]), DEFAULT_THRESHOLDS).status).toBe(
      'RESOLVED',
    );
  });

  it('a payment field is BLOCKED even when it matches', () => {
    const card = fieldDescriptors(
      screen({ elements: [field('Numéro de carte', { fieldName: 'cardNumber' })] }, config).actions,
    );
    const result = matcher.resolve({ kind: 'FILL', field: 'numéro de carte', value: '4111' }, card, context);
    expect(result.status).toBe('BLOCKED');
  });
});

describe('multilingual: the same logic for FR and EN, not written around French', () => {
  const english = fieldDescriptors(
    screen(
      {
        elements: [
          field('First name', { fieldName: 'fn' }),
          field('Last name', { fieldName: 'ln' }),
          field('Email', { fieldName: 'mail', inputType: 'email' }),
        ],
      },
      config,
    ).actions,
  );
  it.each([
    ['prénom', 'fn'],
    ['first name', 'fn'],
    ['nom', 'ln'],
    ['last name', 'ln'],
    ['courriel', 'mail'],
    ['email', 'mail'],
  ])('%s → %s on an English screen', (intent, name) => {
    const result = matcher.resolve(
      { kind: 'FILL', field: intent, value: intent === 'courriel' || intent === 'email' ? 'a@b.co' : 'X' },
      english,
      context,
    );
    expect(result.status).toBe('RESOLVED');
    expect(result.selected?.field.name).toBe(name);
  });
});

describe('explanation', () => {
  it('says what was asked, what was chosen, why, and the other candidates — never the value', () => {
    const result = matcher.resolve(
      { kind: 'FILL', field: 'courriel', value: 'mohamed@example.com' },
      fields,
      context,
    );
    const lines = explainResolution({
      title: 'FIELD MATCH',
      step: 'je renseigne le courriel avec "…"',
      intent: result.intent,
      ...(result.valueType ? { valueType: result.valueType } : {}),
      status: result.status,
      ...(result.selected ? { selected: result.selected.label } : {}),
      score: result.score,
      confidence: result.confidence,
      reasons: result.reasons,
      candidates: result.candidates,
    });
    expect(lines.slice(0, 4)).toEqual([
      'FIELD MATCH',
      'Step: je renseigne le courriel avec "…"',
      'Intent: FILL "courriel" · Value type: EMAIL',
      'Status: RESOLVED → "Adresse électronique" · Confidence: 1 VERY_HIGH',
    ]);
    expect(lines.join('\n')).not.toContain('mohamed@example.com');
    expect(lines.at(-1)).toMatch(/^Candidates: Adresse électronique 1 · /);
    const secret = matcher.resolve({ kind: 'FILL', field: 'courriel', value: 'x@y.co' }, fields, {
      ...context,
      sensitiveValue: true,
    });
    expect(secret.valueType).toBeUndefined();
    expect(secret.reasons.join(' ')).not.toContain('EMAIL');
  });
});
