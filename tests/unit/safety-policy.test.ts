import { describe, expect, it } from 'vitest';
import type { RawAction } from '../../src/model/discovered-action.js';
import { normalizeText, SafetyPolicy } from '../../src/policies/safety-policy.js';

const policy = new SafetyPolicy({
  allowedActionClasses: ['SAFE'],
  keywords: { safe: [], mutation: [], dangerous: ['obliterate'] },
});

const action = (overrides: Partial<RawAction>): RawAction => ({
  type: 'button',
  text: '',
  tagName: 'button',
  selector: 'button',
  index: 0,
  visible: true,
  disabled: false,
  isSubmit: false,
  inSearchForm: false,
  ...overrides,
});

const classify = (overrides: Partial<RawAction>): string => policy.classify(action(overrides)).classification;

describe('SafetyPolicy.classify', () => {
  it('classifies destructive and irreversible actions as DANGEROUS (FR/EN)', () => {
    for (const text of [
      'Supprimer',
      'Delete user',
      'Payer maintenant',
      'Confirmer paiement',
      'Checkout',
      'Envoyer le message',
      'Send email',
      'Déconnexion',
      'Log out',
      'Réinitialiser le mot de passe',
    ]) {
      expect(classify({ text }), text).toBe('DANGEROUS');
    }
  });

  it('classifies data changes as MUTATION', () => {
    for (const text of [
      'Créer',
      'Nouvelle inscription',
      'Enregistrer',
      'Modifier',
      'Mettre à jour',
      'Save',
      'Add item',
    ]) {
      expect(classify({ text }), text).toBe('MUTATION');
    }
  });

  it('classifies navigation-like buttons as SAFE', () => {
    for (const text of [
      'Suivant',
      'Page 2',
      'Onglet Détails',
      'Filtrer',
      'Rechercher',
      'Next',
      'Voir plus',
    ]) {
      expect(classify({ text }), text).toBe('SAFE');
    }
  });

  it('marks unrecognised buttons as UNKNOWN (never executed)', () => {
    expect(classify({ text: '⚙' })).toBe('UNKNOWN');
    expect(classify({ text: '' })).toBe('UNKNOWN');
    expect(policy.isExecutionAllowed('UNKNOWN')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(classify({ type: 'link', text: 'Address book', href: 'https://x.test/address' })).toBe('SAFE');
    expect(classify({ type: 'link', text: 'Paysage', href: 'https://x.test/paysage' })).toBe('SAFE');
    expect(classify({ text: 'Newsletter archive list' })).toBe('DANGEROUS'); // "archive"
  });

  it('gives DANGEROUS precedence over MUTATION and SAFE', () => {
    expect(classify({ text: 'Enregistrer et supprimer' })).toBe('DANGEROUS');
    expect(classify({ text: 'Supprimer la page' })).toBe('DANGEROUS');
  });

  it('classifies links by their target too', () => {
    expect(classify({ type: 'link', text: 'Utilisateurs', href: 'https://x.test/users' })).toBe('SAFE');
    expect(classify({ type: 'link', text: 'Retirer', href: 'https://x.test/users/3' })).toBe('DANGEROUS');
    expect(classify({ type: 'link', text: 'Voir', href: 'https://x.test/users/3/delete' })).toBe('DANGEROUS');
    expect(classify({ type: 'router-link', text: 'x', routerLink: '/orders/new' })).toBe('MUTATION');
  });

  it('treats form submission as MUTATION unless it is a search form', () => {
    expect(classify({ text: 'OK', isSubmit: true })).toBe('MUTATION');
    expect(classify({ text: 'OK', isSubmit: true, inSearchForm: true })).toBe('SAFE');
    expect(classify({ text: 'Supprimer', isSubmit: true, inSearchForm: true })).toBe('DANGEROUS');
  });

  it('classifies fields', () => {
    expect(classify({ type: 'input', inputType: 'search' })).toBe('SAFE');
    expect(classify({ type: 'input', inputType: 'email' })).toBe('MUTATION');
    expect(classify({ type: 'select', text: 'Trier par' })).toBe('SAFE');
    expect(classify({ type: 'textarea' })).toBe('MUTATION');
  });

  it('supports custom keywords and camelCase identifiers', () => {
    expect(classify({ text: 'Obliterate' })).toBe('DANGEROUS');
    expect(classify({ text: '', elementId: 'deleteUserButton' })).toBe('DANGEROUS');
  });
});

describe('SafetyPolicy execution rules', () => {
  it('only allows SAFE actions by default', () => {
    expect(policy.isExecutionAllowed('SAFE')).toBe(true);
    expect(policy.isExecutionAllowed('MUTATION')).toBe(false);
    expect(policy.isExecutionAllowed('DANGEROUS')).toBe(false);
  });

  it('allows other classes only when explicitly configured', () => {
    const permissive = new SafetyPolicy({
      allowedActionClasses: ['SAFE', 'MUTATION'],
      keywords: { safe: [], mutation: [], dangerous: [] },
    });
    expect(permissive.isExecutionAllowed('MUTATION')).toBe(true);
    expect(permissive.isExecutionAllowed('DANGEROUS')).toBe(false);
  });

  it('classifies URLs', () => {
    expect(policy.classifyUrl('https://x.test/admin/users/4/delete').classification).toBe('DANGEROUS');
    expect(policy.classifyUrl('https://x.test/checkout').classification).toBe('DANGEROUS');
    expect(policy.classifyUrl('https://x.test/users/4').classification).toBe('SAFE');
  });
});

describe('normalizeText', () => {
  it('removes accents, splits camelCase and lower-cases', () => {
    expect(normalizeText('Réinitialiser  LE   Mot')).toBe('reinitialiser le mot');
    expect(normalizeText('deleteUser')).toBe('delete user');
  });
});
