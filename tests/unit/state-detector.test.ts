import { describe, expect, it } from 'vitest';
import { StateDetector } from '../../src/observation/state-detector.js';
import { button, element, field, link, snapshot } from '../helpers.js';

const detector = new StateDetector('pattern');

describe('StateDetector', () => {
  const userPage = (id: number) =>
    snapshot({
      url: `http://localhost:4200/users/${id}`,
      title: `Utilisateur ${id}`,
      headings: [`Utilisateur ${id}`],
      elements: [button('Modifier'), link('Retour', 'http://localhost:4200/users')],
    });

  it('is stable for the same observation and readable', () => {
    const state = detector.detect(userPage(1));
    expect(detector.detect(userPage(1)).stateId).toBe(state.stateId);
    expect(state.stateId).toMatch(/^utilisateur-[0-9a-f]{8}$/);
    expect(state.route).toBe('/users/:id');
  });

  it('merges records of the same kind (/users/1, /users/2)', () => {
    expect(detector.detect(userPage(1)).stateId).toBe(detector.detect(userPage(2)).stateId);
  });

  it('distinguishes wizard steps that share one URL', () => {
    const step = (heading: string, fields: string[]) =>
      snapshot({
        url: 'http://localhost:4200/dossiers/create',
        headings: ['Nouveau dossier', heading],
        elements: [...fields.map((label) => field(label)), button('Suivant')],
      });
    const one = detector.detect(step('Étape 1 — Informations', ['Titre', 'Email']));
    const two = detector.detect(step('Étape 2 — Détails', ['Montant']));
    expect(one.stateId).not.toBe(two.stateId);
    expect(one.route).toBe(two.route);
  });

  it('distinguishes tabs, dialogs and active steps without URL change', () => {
    const base = { url: 'http://localhost:4200/settings', headings: ['Paramètres'] };
    const general = detector.detect(snapshot({ ...base, selectedTabs: ['Général'] }));
    const security = detector.detect(snapshot({ ...base, selectedTabs: ['Sécurité'] }));
    const dialog = detector.detect(snapshot({ ...base, selectedTabs: ['Général'], dialogs: ['Confirmer'] }));
    expect(new Set([general.stateId, security.stateId, dialog.stateId]).size).toBe(3);
    expect(security.label).toBe('parametres-securite');
  });

  it('ignores data links and navigation menus, which change with the data', () => {
    const list = (names: string[]) =>
      snapshot({
        url: 'http://localhost:4200/users',
        headings: ['Utilisateurs'],
        elements: [
          element({ tag: 'a', role: 'link', name: 'Accueil', inNavigation: true }),
          ...names.map((name) => link(name, `http://localhost:4200/users/${name}`)),
        ],
      });
    expect(detector.detect(list(['Awa', 'Moussa'])).stateId).toBe(detector.detect(list(['Fatou'])).stateId);
  });
});
