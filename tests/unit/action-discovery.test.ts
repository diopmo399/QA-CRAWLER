import { describe, expect, it } from 'vitest';
import { ActionDiscovery, actionId } from '../../src/discovery/action-discovery.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { button, element, field, link, snapshot, testConfig } from '../helpers.js';

const discovery = new ActionDiscovery(new SafetyPolicy(testConfig().safety));

describe('ActionDiscovery', () => {
  const page = snapshot({
    url: 'http://localhost:4200/users',
    elements: [
      link('Utilisateurs', 'http://localhost:4200/users', { inNavigation: true }),
      link('Voir', 'http://localhost:4200/users/1'),
      link('Voir', 'http://localhost:4200/users/2'),
      link('Documentation', 'https://docs.example.com/'),
      link('Section', 'http://localhost:4200/users#section'),
      element({ tag: 'div', role: 'button', name: 'Rapports', text: 'Rapports', routerLink: '/reports' }),
      button('Nouvel utilisateur'),
      button('Supprimer'),
      element({ tag: 'button', role: 'tab', name: 'Profil', text: 'Profil', selected: true }),
      element({ tag: 'button', role: 'tab', name: 'Historique', text: 'Historique', selected: false }),
      field('Email', { inputType: 'email', required: true, maxLength: 80, fieldName: 'email', formIndex: 0 }),
      field('Mot de passe', { inputType: 'password', fieldName: 'password', formIndex: 0 }),
      element({
        tag: 'select',
        role: 'combobox',
        name: 'Pays',
        label: 'Pays',
        options: ['France', 'Sénégal'],
      }),
      element({
        tag: 'input',
        role: 'checkbox',
        name: 'CGU',
        label: 'CGU',
        inputType: 'checkbox',
        checked: false,
        required: true,
      }),
      element({ tag: 'input', role: 'radio', name: 'Oui', label: 'Oui', inputType: 'radio', checked: true }),
      button('', { css: '.icon-btn' }),
    ],
  });
  const actions = discovery.discover(page, 'users-abc');
  const find = (text: string) => actions.find((action) => action.text === text || action.label === text);

  it('turns elements into typed actions', () => {
    expect(find('Utilisateurs')).toMatchObject({
      type: 'navigate',
      category: 'menu',
      classification: 'SAFE',
    });
    expect(find('Rapports')).toMatchObject({ type: 'navigate', href: 'http://localhost:4200/reports' });
    expect(find('Email')).toMatchObject({ type: 'fill', category: 'form-input', formIndex: 0 });
    expect(find('Pays')).toMatchObject({ type: 'select' });
    expect(find('CGU')).toMatchObject({ type: 'check' });
    expect(find('Historique')).toMatchObject({ type: 'click', category: 'tab', selected: false });
  });

  it('skips in-page anchors and already-checked radios', () => {
    expect(find('Section')).toBeUndefined();
    expect(find('Oui')).toBeUndefined();
  });

  it('classifies every action with the SafetyPolicy', () => {
    expect(find('Nouvel utilisateur')?.classification).toBe('MUTATION');
    expect(find('Supprimer')).toMatchObject({ classification: 'DANGEROUS', risks: ['delete'] });
    expect(find('Mot de passe')).toMatchObject({ classification: 'DANGEROUS', risks: ['sensitive-data'] });
    expect(find('Documentation')).toMatchObject({ external: true, risks: ['external-navigation'] });
    expect(actions.find((action) => action.locator.value === '.icon-btn')?.classification).toBe('UNKNOWN');
  });

  it('builds robust, serializable locators and disambiguates duplicates', () => {
    expect(find('Supprimer')?.locator).toEqual({
      strategy: 'role',
      role: 'button',
      name: 'Supprimer',
      exact: true,
    });
    const views = actions.filter((action) => action.text === 'Voir');
    expect(views.map((action) => action.locator.nth)).toEqual([0, 1]);
    expect(find('Supprimer')?.fallback?.strategy).toBe('css');
    expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
  });

  it('records field constraints for the test data provider', () => {
    expect(find('Email')?.field).toMatchObject({
      inputType: 'email',
      required: true,
      maxLength: 80,
      name: 'email',
    });
    expect(find('Pays')?.field?.options).toEqual(['France', 'Sénégal']);
  });

  it('gives stable ids: same state and element ⇒ same id, different state ⇒ different id', () => {
    const again = discovery.discover(page, 'users-abc');
    expect(again.map((action) => action.id)).toEqual(actions.map((action) => action.id));
    const elsewhere = discovery.discover(page, 'other-state');
    expect(elsewhere[0]?.id).not.toBe(actions[0]?.id);
    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    expect(actionId('s', 'click', 'button', 'OK', undefined, undefined)).toBe(
      actionId('s', 'click', 'button', 'ok', undefined, 0),
    );
  });
});
