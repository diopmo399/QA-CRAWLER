import { describe, expect, it } from 'vitest';
import { cleanName, cleanPage, GherkinIntentParser } from '../../src/flows/gherkin/gherkin-intents.js';
import { describeIntent } from '../../src/semantics/resolution/intent.js';
import {
  containsPhrase,
  isDynamicId,
  matchKey,
  normalizeForMatch,
  sameMeaningfulText,
  tokenOverlap,
} from '../../src/semantics/resolution/normalize.js';
import { classifyValue, valueFieldCompatibility } from '../../src/semantics/resolution/value-classifier.js';

describe('normalization for matching (never for the value typed)', () => {
  it('case, accents, spaces, punctuation give the same key', () => {
    for (const text of ['Prénom', 'prenom', 'PRÉNOM', '  prénom ', 'Prénom :', 'Prénom *', 'le prénom'])
      expect(matchKey(text)).toBe('prenom');
  });

  it('camelCase, snake_case, kebab-case and spaces are brought together', () => {
    for (const text of ['firstName', 'first_name', 'First Name', 'first-name', 'FIRST_NAME'])
      expect(matchKey(text)).toBe('first name');
  });

  it('stop words are dropped from the tokens, plurals made singular', () => {
    expect(normalizeForMatch("L'adresse de facturation").tokens).toEqual(['adresse', 'facturation']);
    expect(normalizeForMatch('la page des utilisateurs').tokens).toEqual(['page', 'utilisateur']);
    expect(normalizeForMatch('the users page').tokens).toEqual(['user', 'page']);
    expect(sameMeaningfulText('Utilisateurs', "l'utilisateur")).toBe(true);
    expect(sameMeaningfulText('Prénom', 'Nom')).toBe(false);
  });

  it('overlap and phrases work on whole tokens, never on substrings', () => {
    expect(tokenOverlap(['nom'], normalizeForMatch('Prénom').tokens).ratio).toBe(0);
    expect(tokenOverlap(['adresse'], normalizeForMatch('Adresse de facturation').tokens)).toEqual({
      ratio: 1,
      extra: 1,
      common: 1,
    });
    expect(containsPhrase(['nom', 'famille', 'titulaire'], ['nom', 'famille'])).toBe(true);
    expect(containsPhrase(['famille', 'nom'], ['nom', 'famille'])).toBe(false);
  });

  it('framework-generated ids are recognised (never a stable identity)', () => {
    expect(['mat-input-23', 'ng-12', ':r5:', 'field_8f3a2c', undefined].map(isDynamicId)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['email', 'givenName', 'accountType'].map(isDynamicId)).toEqual([false, false, false]);
  });
});

describe('ValueClassifier: a signal, never a certainty', () => {
  const type = (value: string, options?: string[]): string => classifyValue(value, options).type;

  it('recognises the usual kinds of values', () => {
    expect(type('john@example.com')).toBe('EMAIL');
    expect(type('2026-09-28')).toBe('DATE');
    expect(type('28/09/2026')).toBe('DATE');
    expect(type('2026-09-28T10:30')).toBe('DATETIME');
    expect(type('10:30')).toBe('TIME');
    expect(type('42')).toBe('INTEGER');
    expect(type('3,14')).toBe('NUMBER');
    expect(type('https://example.com')).toBe('URL');
    expect(type('oui')).toBe('BOOLEAN');
    expect(type('+1 418-555-1234')).toBe('PHONE');
    expect(type('Mohamed')).toBe('TEXT');
    expect(type('')).toBe('UNKNOWN');
    expect(type('Administrateur', ['Utilisateur', 'Administrateur'])).toBe('ENUM');
  });

  it('ambiguous values keep both readings: 4185551234 is probably a phone, maybe a number', () => {
    const result = classifyValue('4185551234');
    expect(result.type).toBe('PHONE');
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.alternatives).toEqual([{ type: 'INTEGER', confidence: 0.45 }]);
    expect(valueFieldCompatibility(result, 'number')).toBe('compatible');
    expect(valueFieldCompatibility(result, 'tel')).toBe('compatible');
  });

  it('impossible dates are not dates', () => {
    expect(type('2026-02-30')).not.toBe('DATE');
  });

  it('compatibility with the field type', () => {
    expect(valueFieldCompatibility(classifyValue('a@b.co'), 'email')).toBe('compatible');
    expect(valueFieldCompatibility(classifyValue('a@b.co'), 'number')).toBe('conflict');
    expect(valueFieldCompatibility(classifyValue('Mohamed'), 'date')).toBe('conflict');
    expect(valueFieldCompatibility(classifyValue('Mohamed'), 'text')).toBe('neutral');
    expect(valueFieldCompatibility(classifyValue('42'), 'text')).toBe('neutral');
    expect(valueFieldCompatibility(classifyValue('2026-09-28'), 'date')).toBe('compatible');
  });
});

describe('Gherkin intents: what the scenario asks, never how', () => {
  const parser = new GherkinIntentParser();
  const parse = (text: string, type: 'Context' | 'Action' | 'Outcome' = 'Action', table?: string[][]) =>
    parser.parse(text, type, table);

  it('the reference scenario, sentence by sentence', () => {
    expect(parse('je suis sur la page des utilisateurs', 'Context')).toEqual({
      kind: 'NAVIGATE',
      target: 'utilisateurs',
      precondition: true,
    });
    expect(parse('je renseigne le prénom avec "Mohamed"')).toEqual({
      kind: 'FILL',
      field: 'prénom',
      value: 'Mohamed',
    });
    expect(parse('je saisis "test@example.com" dans le courriel')).toEqual({
      kind: 'FILL',
      field: 'courriel',
      value: 'test@example.com',
    });
    expect(parse('je sélectionne "Administrateur" comme rôle')).toEqual({
      kind: 'SELECT',
      field: 'rôle',
      option: 'Administrateur',
    });
    expect(parse('je valide le formulaire')).toEqual({ kind: 'SUBMIT', action: 'submit', verb: 'valider' });
    expect(parse("l'utilisateur doit être créé", 'Outcome')).toEqual({
      kind: 'ASSERT',
      assertion: 'ENTITY_CREATED',
      subject: 'utilisateur',
    });
    expect(parse("l'utilisateur doit apparaître dans la liste", 'Outcome')).toEqual({
      kind: 'ASSERT',
      assertion: 'ENTITY_VISIBLE',
      subject: 'utilisateur',
    });
  });

  it('English sentences give the same intents', () => {
    expect(parse('I fill in the first name with "Mohamed"')).toEqual({
      kind: 'FILL',
      field: 'first name',
      value: 'Mohamed',
    });
    expect(parse('I enter "a@b.co" in the email field')).toEqual({
      kind: 'FILL',
      field: 'email',
      value: 'a@b.co',
    });
    expect(parse('I select "Admin" as role')).toEqual({ kind: 'SELECT', field: 'role', option: 'Admin' });
    expect(parse('I save')).toEqual({ kind: 'SUBMIT', action: 'submit', verb: 'save' });
    expect(parse('I go to the next step')).toEqual({ kind: 'SUBMIT', action: 'next' });
    expect(parse('I cancel')).toEqual({ kind: 'SUBMIT', action: 'cancel' });
    expect(parse('I open the settings')).toEqual({ kind: 'NAVIGATE', target: 'settings' });
    expect(parse('the Users page is displayed', 'Outcome')).toEqual({
      kind: 'ASSERT',
      assertion: 'PAGE_DISPLAYED',
      subject: 'Users',
    });
  });

  it('navigation, clicks, check boxes, uploads, messages', () => {
    expect(parse("j'ouvre les utilisateurs")).toEqual({ kind: 'NAVIGATE', target: 'utilisateurs' });
    expect(parse('je vais dans les paramètres')).toEqual({ kind: 'NAVIGATE', target: 'paramètres' });
    expect(parse("j'accède à la gestion des rôles")).toEqual({
      kind: 'NAVIGATE',
      target: 'gestion des rôles',
    });
    expect(parse("je clique sur l'onglet profil")).toEqual({ kind: 'CLICK', target: 'profil', role: 'tab' });
    expect(parse('je coche la case actif')).toEqual({ kind: 'CHECK', field: 'actif', checked: true });
    expect(parse('je décoche les notifications')).toEqual({
      kind: 'CHECK',
      field: 'notifications',
      checked: false,
    });
    expect(parse('je joins "cv.pdf" dans le curriculum')).toEqual({
      kind: 'UPLOAD',
      field: 'curriculum',
      file: 'cv.pdf',
    });
    expect(parse('un message de confirmation est affiché', 'Outcome')).toEqual({
      kind: 'ASSERT',
      assertion: 'MESSAGE',
      message: 'confirmation',
    });
    expect(parse('je suis sur la page des utilisateurs', 'Outcome')).toEqual({
      kind: 'ASSERT',
      assertion: 'PAGE_DISPLAYED',
      subject: 'utilisateurs',
    });
  });

  it('a whole form, with or without values', () => {
    expect(
      parse('je remplis le formulaire utilisateur avec :', 'Action', [
        ['prénom', 'Mohamed'],
        ['courriel', 'test@example.com'],
        ['mot de passe', '<env:QA_PASSWORD>'],
      ]),
    ).toEqual({
      kind: 'FILL_FORM',
      form: 'utilisateur',
      rows: [
        { field: 'prénom', value: 'Mohamed' },
        { field: 'courriel', value: 'test@example.com' },
        { field: 'mot de passe', value: { env: 'QA_PASSWORD' } },
      ],
    });
    expect(parse('je remplis le formulaire utilisateur')).toEqual({ kind: 'FILL_FORM', form: 'utilisateur' });
    expect(parse('I fill in the form')).toEqual({ kind: 'FILL_FORM' });
  });

  it('no selector ever enters an intent; unknown sentences stay unknown', () => {
    expect(parse('je fais quelque chose de vague')).toBeUndefined();
    expect(parse('je valide le formulaire', 'Outcome')).toBeUndefined();
    expect(describeIntent({ kind: 'FILL', field: 'mot de passe', value: 'secret' })).toBe(
      'FILL "mot de passe"',
    );
  });

  it('names are cleaned of articles and element words', () => {
    expect(cleanName('le champ du prénom')).toEqual({ name: 'prénom' });
    expect(cleanName('le bouton Créer')).toEqual({ name: 'Créer', role: 'button' });
    expect(cleanPage('la page des utilisateurs')).toBe('utilisateurs');
    expect(cleanPage('the users page')).toBe('users');
  });
});
