import { describe, expect, it } from 'vitest';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import { normalizeText } from '../../src/policies/keywords.js';
import { SafetyPolicy, type ClassifiableAction } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

const policy = new SafetyPolicy(testConfig('safety:\n  keywords:\n    dangerous: [obliterate]\n').safety);

const click = (text: string, extra: Partial<ClassifiableAction> = {}): string =>
  policy.classify({ type: 'click', category: 'other', text, ...extra }).classification;

const action = (overrides: Partial<DiscoveredAction>): DiscoveredAction => ({
  id: 'a-1',
  stateId: 's-1',
  type: 'click',
  category: 'other',
  elementType: 'button',
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: 'test',
  risks: [],
  locator: { strategy: 'role', role: 'button', name: 'x' },
  ...overrides,
});

describe('SafetyPolicy.classify', () => {
  it('classifies destructive, payment, sending and session actions as DANGEROUS (FR/EN)', () => {
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
      'Vider le cache',
    ]) {
      expect(click(text), text).toBe('DANGEROUS');
    }
  });

  it('records the kind of risk', () => {
    expect(policy.classify({ type: 'click', category: 'other', text: 'Supprimer' }).risks).toContain(
      'delete',
    );
    expect(policy.classify({ type: 'click', category: 'other', text: 'Payer' }).risks).toContain('payment');
    expect(policy.classify({ type: 'click', category: 'other', text: 'Log out' }).risks).toContain('logout');
  });

  it('classifies data changes as MUTATION', () => {
    for (const text of [
      'Créer',
      'Nouvel utilisateur',
      'Enregistrer',
      'Modifier',
      'Mettre à jour',
      'Save',
      'Add item',
      'Oui',
    ]) {
      expect(click(text), text).toBe('MUTATION');
    }
  });

  it('classifies labelled in-page controls without risky words as SAFE', () => {
    for (const text of ['Suivant', 'Onglet Détails', 'Filtrer', 'Rechercher', 'Utilisateurs', 'Voir plus']) {
      expect(click(text), text).toBe('SAFE');
    }
  });

  it('marks unlabelled and symbol-only controls as UNKNOWN (never executed)', () => {
    expect(click('')).toBe('UNKNOWN');
    for (const symbol of ['⚙', '×', '…', '+', '🗑']) expect(click(symbol), symbol).toBe('UNKNOWN');
    expect(policy.isExecutionAllowed('UNKNOWN')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(
      policy.classify({
        type: 'navigate',
        category: 'navigation',
        text: 'Address book',
        href: 'http://localhost:4200/address',
      }).classification,
    ).toBe('SAFE');
    expect(
      policy.classify({
        type: 'navigate',
        category: 'navigation',
        text: 'Paysage',
        href: 'http://localhost:4200/paysage',
      }).classification,
    ).toBe('SAFE');
  });

  it('uses the link target and the dialog context', () => {
    expect(
      policy.classify({
        type: 'navigate',
        category: 'navigation',
        text: 'Voir',
        href: 'http://localhost:4200/users/3/delete',
      }).classification,
    ).toBe('DANGEROUS');
    expect(click('Confirmer', { dialogName: "Supprimer l'utilisateur ?" })).toBe('DANGEROUS');
    expect(click('x', { elementId: 'deleteUserButton' })).toBe('DANGEROUS');
    expect(click('Obliterate')).toBe('DANGEROUS');
  });

  it('treats form submission as MUTATION, except search forms and client-side wizard steps', () => {
    expect(click('OK', { isSubmit: true })).toBe('MUTATION');
    expect(click('Go', { isSubmit: true, inSearchForm: true })).toBe('SAFE');
    expect(click('Suivant', { isSubmit: true })).toBe('SAFE');
    expect(click('Suivant', { isSubmit: true, formHasAction: true })).toBe('MUTATION');
  });

  it('never fills sensitive fields', () => {
    const fill = (extra: Partial<ClassifiableAction>): string =>
      policy.classify({ type: 'fill', category: 'form-input', ...extra }).classification;
    expect(fill({ inputType: 'password', label: 'Mot de passe' })).toBe('DANGEROUS');
    expect(fill({ inputType: 'text', label: 'Numéro de carte bancaire' })).toBe('DANGEROUS');
    expect(fill({ inputType: 'text', autocomplete: 'cc-number' })).toBe('DANGEROUS');
    expect(fill({ inputType: 'text', label: 'IBAN' })).toBe('DANGEROUS');
    expect(fill({ inputType: 'email', label: 'Email' })).toBe('SAFE');
  });

  it('flags links to other sites', () => {
    const result = policy.classify({
      type: 'navigate',
      category: 'navigation',
      text: 'Docs',
      href: 'https://other.test',
      external: true,
    });
    expect(result.risks).toContain('external-navigation');
  });
});

describe('SafetyPolicy.evaluate (gate between the decision engine and Playwright)', () => {
  it('allows SAFE actions of allowed kinds', () => {
    expect(policy.evaluate(action({ category: 'tab' })).verdict).toBe('ALLOW');
  });

  it('blocks DANGEROUS, MUTATION, UNKNOWN, disabled and hidden actions by default', () => {
    expect(policy.evaluate(action({ classification: 'DANGEROUS', risks: ['delete'] })).verdict).toBe('BLOCK');
    expect(policy.evaluate(action({ classification: 'MUTATION', risks: ['mutation'] })).verdict).toBe(
      'BLOCK',
    );
    expect(policy.evaluate(action({ classification: 'UNKNOWN' })).verdict).toBe('BLOCK');
    expect(policy.evaluate(action({ disabled: true })).verdict).toBe('BLOCK');
    expect(policy.evaluate(action({ visible: false })).verdict).toBe('BLOCK');
  });

  it('blocks external navigation, ignored paths and downloads', () => {
    const navigate = (href: string, extra: Partial<DiscoveredAction> = {}) =>
      policy.evaluate(action({ type: 'navigate', category: 'navigation', href, ...extra })).verdict;
    expect(navigate('https://evil.test/', { external: true, risks: ['external-navigation'] })).toBe('BLOCK');
    expect(navigate('http://localhost:4200/logout')).toBe('BLOCK');
    expect(navigate('http://localhost:4200/files/report.pdf')).toBe('BLOCK');
    expect(navigate('http://localhost:4200/users')).toBe('ALLOW');
  });

  it('applies the mission allow-list of SAFE action kinds', () => {
    const restricted = new SafetyPolicy(testConfig('safety:\n  allow: [navigation, search]\n').safety);
    expect(restricted.evaluate(action({ category: 'tab' })).verdict).toBe('BLOCK');
    expect(restricted.evaluate(action({ category: 'search' })).verdict).toBe('ALLOW');
  });

  it('always blocks sensitive data, even when every class is allowed; DANGEROUS runs only when listed', () => {
    const permissive = new SafetyPolicy(
      testConfig('safety:\n  allowedActionClasses: [SAFE, MUTATION, DANGEROUS, UNKNOWN]\n  block: []\n')
        .safety,
    );
    expect(
      permissive.evaluate(action({ type: 'fill', classification: 'DANGEROUS', risks: ['sensitive-data'] }))
        .verdict,
    ).toBe('BLOCK');
    expect(permissive.evaluate(action({ classification: 'DANGEROUS', risks: ['delete'] })).verdict).toBe(
      'ALLOW',
    );
    // Listée, mais son risque est encore dans safety.block : bloquée.
    const listedOnly = new SafetyPolicy(
      testConfig('safety:\n  allowedActionClasses: [SAFE, DANGEROUS]\n').safety,
    );
    expect(listedOnly.evaluate(action({ classification: 'DANGEROUS', risks: ['delete'] })).verdict).toBe(
      'BLOCK',
    );
    expect(permissive.evaluate(action({ classification: 'MUTATION' })).verdict).toBe('ALLOW');
  });
});

describe('normalizeText', () => {
  it('removes accents, splits camelCase and lower-cases', () => {
    expect(normalizeText('Réinitialiser  LE   Mot')).toBe('reinitialiser le mot');
    expect(normalizeText('deleteUser')).toBe('delete user');
  });

  it('treats a button that sends its form (dialog without <form>) as a form submission', () => {
    const sent = policy.classify({ type: 'click', category: 'other', text: 'Soumettre', submitsForm: true });
    expect(sent).toMatchObject({ classification: 'MUTATION', risks: ['form-submit'] });
    expect(policy.evaluate(action({ text: 'Soumettre', ...sent, submitsForm: true })).verdict).toBe('BLOCK');
    // Une étape d'assistant reste une étape.
    expect(click('Suivant', { submitsForm: true })).toBe('SAFE');
  });
});
