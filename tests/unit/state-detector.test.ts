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

  it('ignores generated ids, e-mails, tokens, dates, times and counters', () => {
    const screen = (id: string, mail: string, when: string, count: number) =>
      snapshot({
        url: `http://localhost:4200/dossiers/${id}`,
        title: `Dossier ${id} (${count})`,
        headings: [`Dossier ${id}`, `Modifié le ${when} par ${mail}`],
        elements: [button(`Commentaires (${count})`), button('Enregistrer'), field(`Réf. ${id}`)],
      });
    const one = detector.detect(
      screen('0b8f6c1e-4d2a-4f3b-9a51-7c2d1e0f9a3b', 'awa@example.test', '2026-09-26 10:32', 3),
    );
    const two = detector.detect(
      screen('9f1c2b3a-aaaa-4bbb-8ccc-1234567890ab', 'moussa@example.test', '2026-09-27 08:05', 12),
    );
    const three = detector.detect(
      screen('c3d4e5f6-0000-4111-8222-abcdefabcdef', 'fatou@example.test', '2025-01-01 23:59', 0),
    );
    expect(two.stateId).toBe(one.stateId);
    expect(three.stateId).toBe(one.stateId);
  });

  it('does not depend on the order of the controls', () => {
    const screen = (names: string[]) =>
      snapshot({
        url: 'http://localhost:4200/users/new',
        headings: ['Nouvel utilisateur'],
        elements: names.map((name) => button(name)),
      });
    expect(detector.detect(screen(['Continuer', 'Annuler'])).stateId).toBe(
      detector.detect(screen(['Annuler', 'Continuer'])).stateId,
    );
  });

  it('ignores toasts and live regions, which come and go', () => {
    const screen = (toast: boolean) =>
      snapshot({
        url: 'http://localhost:4200/users',
        headings: ['Utilisateurs'],
        elements: [
          button('Nouvel utilisateur'),
          ...(toast
            ? [element({ tag: 'button', role: 'button', name: 'Fermer la notification', transient: true })]
            : []),
        ],
      });
    expect(detector.detect(screen(true)).stateId).toBe(detector.detect(screen(false)).stateId);
  });

  it('turns the same route with other fields and buttons into another state (/dossiers/create)', () => {
    const step = (fields: string[], buttons: string[]) =>
      snapshot({
        url: 'http://localhost:4200/dossiers/create',
        headings: ['Créer dossier'],
        elements: [...fields.map((label) => field(label)), ...buttons.map((name) => button(name))],
      });
    const client = detector.detect(step(['Client', 'Produit', 'Date'], ['Continuer', 'Annuler']));
    const summary = detector.detect(step([], ['Précédent', 'Confirmer']));
    expect(client.stateId).not.toBe(summary.stateId);
    expect(client.signature).toContain(
      'controls=button:annuler|button:continuer|textbox:client|textbox:date|textbox:produit',
    );
  });
});
