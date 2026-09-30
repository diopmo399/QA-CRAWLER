import { describe, expect, it } from 'vitest';
import { ActionResolver } from '../../src/semantics/resolution/action-resolver.js';
import { NavigationResolver } from '../../src/semantics/resolution/navigation-resolver.js';
import { OptionResolver } from '../../src/semantics/resolution/option-resolver.js';
import { DEFAULT_THRESHOLDS } from '../../src/semantics/resolution/resolution.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { button, element, field, link, screen, testConfig } from '../helpers.js';

const dictionary = new SemanticDictionary();
const vocabulary = new SemanticVocabulary(dictionary);
const actions = new ActionResolver(vocabulary, dictionary, DEFAULT_THRESHOLDS);
const navigation = new NavigationResolver(dictionary, DEFAULT_THRESHOLDS);
const options = new OptionResolver(vocabulary, DEFAULT_THRESHOLDS);
const config = testConfig(
  'safety: { mutations: { enabled: true }, allowedActionClasses: [SAFE, MUTATION] }\n',
);

describe('OptionResolver: never the first option, only the one that matches', () => {
  const roles = [
    { label: '-- Choisir --', placeholder: true },
    { label: 'Utilisateur' },
    { label: 'Bénévole' },
    { label: 'Administrateur' },
  ];
  it('visible text, normalization, abbreviation', () => {
    expect(options.resolve('Administrateur', roles).selected?.label).toBe('Administrateur');
    expect(options.resolve('administrateur', roles).selected?.label).toBe('Administrateur');
    expect(options.resolve('benevole', roles).selected?.label).toBe('Bénévole');
    expect(options.resolve('Admin', roles).selected?.label).toBe('Administrateur');
  });
  it('no matching option: NOT_FOUND; the placeholder is never a choice', () => {
    expect(options.resolve('Superviseur', roles).status).toBe('NOT_FOUND');
    expect(options.resolve('Choisir', roles).status).toBe('NOT_FOUND');
  });
  it('two options equally close: AMBIGUOUS', () => {
    expect(options.resolve('Admin', [{ label: 'Administrateur' }, { label: 'Administration' }]).status).toBe(
      'AMBIGUOUS',
    );
  });
  it('a disabled option is never chosen', () => {
    expect(options.resolve('Administrateur', [{ label: 'Administrateur', disabled: true }]).status).toBe(
      'NOT_FOUND',
    );
  });
  it('a custom list closed on screen: chosen by its text, said as unverified', () => {
    expect(options.resolve('Administrateur', undefined)).toMatchObject({
      status: 'UNVERIFIED',
      selected: { label: 'Administrateur' },
    });
  });
});

/** Le formulaire : champs, Annuler, Enregistrer (envoi natif), Créer, Retour, Suivant. */
const formScreen = screen(
  {
    url: 'http://localhost:4200/users/new',
    headings: ['Nouvel utilisateur'],
    elements: [
      field('Prénom', { formIndex: 0, formGroup: 'form:0' }),
      button('Annuler', { formIndex: 0, formGroup: 'form:0' }),
      button('Enregistrer', { formIndex: 0, formGroup: 'form:0', isSubmit: true }),
      button('Créer', { formIndex: 0, formGroup: 'form:0' }),
      button('Retour'),
      button('Suivant', { formIndex: 0, formGroup: 'form:0' }),
    ],
  },
  config,
);

describe('ActionResolver: the role of the button, not the word "valider"', () => {
  const resolve = (action: 'submit' | 'cancel' | 'next' | 'previous', verb?: string) =>
    actions.resolveFormAction({ kind: 'SUBMIT', action, ...(verb ? { verb } : {}) }, formScreen.actions, {
      stateSignature: 'nouvel-utilisateur',
      previousFormGroup: 'form:0',
    });

  it('valider → the native submit button of the form just filled', () => {
    const result = resolve('submit', 'valider');
    expect(result.status).toBe('RESOLVED');
    expect(result.selected?.text).toBe('Enregistrer');
    expect(result.reasons).toEqual(expect.arrayContaining(['+35 button[type=submit] of its form']));
    expect(result.candidates.find((candidate) => candidate.label === 'Annuler')?.score).toBe(0);
  });
  it('annuler → cancel; suivant → next; retour → previous', () => {
    expect(resolve('cancel').selected?.text).toBe('Annuler');
    expect(resolve('next').selected?.text).toBe('Suivant');
    expect(resolve('previous').selected?.text).toBe('Retour');
  });
  it('English buttons: save, cancel, next', () => {
    const english = screen(
      {
        elements: [
          field('Name', { formIndex: 0, formGroup: 'form:0' }),
          button('Cancel', { formIndex: 0, formGroup: 'form:0' }),
          button('Save', { formIndex: 0, formGroup: 'form:0', isSubmit: true }),
          button('Next', { formIndex: 0, formGroup: 'form:0' }),
        ],
      },
      config,
    );
    const on = (action: 'submit' | 'cancel' | 'next') =>
      actions.resolveFormAction({ kind: 'SUBMIT', action }, english.actions, {
        stateSignature: 'x',
        previousFormGroup: 'form:0',
      }).selected?.text;
    expect([on('submit'), on('cancel'), on('next')]).toEqual(['Save', 'Cancel', 'Next']);
  });
  it('two submit-like buttons without a native submit: AMBIGUOUS, never the first', () => {
    const two = screen(
      {
        elements: [
          field('Nom', { formIndex: 0, formGroup: 'form:0' }),
          button('Enregistrer', { formIndex: 0, formGroup: 'form:0' }),
          button('Confirmer', { formIndex: 0, formGroup: 'form:0' }),
        ],
      },
      config,
    );
    const result = actions.resolveFormAction({ kind: 'SUBMIT', action: 'submit' }, two.actions, {
      stateSignature: 'x',
      previousFormGroup: 'form:0',
    });
    expect(result.status).toBe('AMBIGUOUS');
  });
  it('the same link on every row of a list: the first row, said so; two different controls stay AMBIGUOUS', () => {
    const rows = screen(
      {
        url: 'http://localhost:4200/dossiers',
        headings: ['Dossiers'],
        elements: [1, 2, 3].map((row) =>
          element({
            tag: 'a',
            role: '',
            name: 'Ouvrir le dossier',
            text: 'Ouvrir le dossier',
            css: `tr:nth-child(${String(row)}) a`,
          }),
        ),
      },
      config,
    );
    const result = actions.resolveClick({ kind: 'CLICK', target: 'Ouvrir le dossier' }, rows.actions, {
      stateSignature: 'x',
    });
    expect(result.status).toBe('RESOLVED');
    expect(result.selected?.id).toBe(rows.actions[0]?.id);
    expect(result.reasons[0]).toContain('repeated 3 times (a list): the first one');
    const different = screen(
      { elements: [button('Ouvrir le dossier'), link('Ouvrir le dossier', 'http://localhost:4200/d/1')] },
      config,
    );
    expect(
      actions.resolveClick({ kind: 'CLICK', target: 'Ouvrir le dossier' }, different.actions, {
        stateSignature: 'x',
      }).status,
    ).toBe('AMBIGUOUS');
  });
  it('a named click without quotes: « nouvel utilisateur », « le bouton créer »', () => {
    const list = screen(
      {
        url: 'http://localhost:4200/users',
        headings: ['Utilisateurs'],
        elements: [
          button('Créer un utilisateur'),
          button('Exporter'),
          link('Voir', 'http://localhost:4200/users/1'),
        ],
      },
      config,
    );
    const create = actions.resolveClick({ kind: 'CLICK', target: 'créer un utilisateur' }, list.actions, {
      stateSignature: 'x',
    });
    expect(create.selected?.text).toBe('Créer un utilisateur');
    const synonym = actions.resolveClick({ kind: 'CLICK', target: 'nouvel utilisateur' }, list.actions, {
      stateSignature: 'x',
    });
    expect(synonym.selected?.text).toBe('Créer un utilisateur');
    expect(
      actions.resolveClick({ kind: 'CLICK', target: 'archiver' }, list.actions, { stateSignature: 'x' })
        .status,
    ).toBe('NOT_FOUND');
  });
});

describe('NavigationResolver: links, tabs, menus — and already there', () => {
  const home = screen(
    {
      url: 'http://localhost:4200/',
      title: 'Tableau de bord',
      headings: ['Tableau de bord'],
      elements: [
        link('Utilisateurs', 'http://localhost:4200/users', { inNavigation: true }),
        link('Settings', 'http://localhost:4200/settings', { inNavigation: true }),
        link('Gestion des rôles', 'http://localhost:4200/roles', { inNavigation: true }),
        link('Rapports', 'http://localhost:4200/reports', { inNavigation: true }),
      ],
    },
    config,
  );
  const go = (target: string) =>
    navigation.resolve({ kind: 'NAVIGATE', target }, home, { stateSignature: 'home' });

  it('utilisateurs, users (synonym), paramètres → Settings (same concept), gestion des rôles', () => {
    expect(go('utilisateurs').selected?.text).toBe('Utilisateurs');
    expect(go('utilisateur').selected?.text).toBe('Utilisateurs');
    expect(go('paramètres').selected?.text).toBe('Settings');
    expect(go('gestion des rôles').selected?.text).toBe('Gestion des rôles');
  });
  it('already on the page: nothing to click', () => {
    const result = go('tableau de bord');
    expect(result).toMatchObject({ status: 'RESOLVED', alreadyThere: 'Tableau de bord' });
    expect(result.selected).toBeUndefined();
  });
  it('the creation form is not "the users page"', () => {
    const result = navigation.resolve({ kind: 'NAVIGATE', target: 'utilisateurs' }, formScreen, {
      stateSignature: 'x',
    });
    expect(result.alreadyThere).toBeUndefined();
  });
  it('unknown destination: NOT_FOUND', () => {
    expect(go('facturation').status).toBe('NOT_FOUND');
  });
  it('a form button is not a navigation', () => {
    const form = screen(
      {
        elements: [
          field('Rôles', { formIndex: 0, formGroup: 'form:0' }),
          element({
            tag: 'button',
            role: 'button',
            name: 'Rôles',
            text: 'Rôles',
            isSubmit: true,
            formIndex: 0,
            formGroup: 'form:0',
          }),
        ],
      },
      config,
    );
    const result = navigation.resolve({ kind: 'NAVIGATE', target: 'rôles' }, form, { stateSignature: 'x' });
    expect(result.status).not.toBe('RESOLVED');
  });
});
