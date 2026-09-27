import { describe, expect, it } from 'vitest';
import { optionKey } from '../../src/decision/action-scorer.js';
import { isAutocomplete } from '../../src/execution/playwright-action-executor.js';
import { WriteGuard } from '../../src/policies/write-guard.js';
import { element, field, screen } from '../helpers.js';

const guard = (allow: string[] = []): WriteGuard =>
  new WriteGuard({ enabled: true, allow, isGuardedHost: (host) => host === 'app.test' });

describe('WriteGuard', () => {
  it('blocks POST/PUT/PATCH/DELETE to the application unless permitted; reads always pass', async () => {
    const writes = guard();
    expect(writes.decide('PUT', 'http://app.test/api/tasks/QA%20Test/owner')).toBe('block');
    expect(writes.decide('delete', 'http://app.test/api/users/1')).toBe('block');
    expect(writes.decide('GET', 'http://app.test/api/users')).toBe('continue');
    // Hôte hors de l'application (analytics, fournisseur d'identité) : pas gardé.
    expect(writes.decide('POST', 'https://sso.example.test/token')).toBe('continue');
    await writes.permit('mutation action', () => {
      expect(writes.decide('POST', 'http://app.test/api/users')).toBe('continue');
      return Promise.resolve();
    });
    expect(writes.decide('POST', 'http://app.test/api/users')).toBe('block');
  });

  it('authentication is never blocked: OIDC / OAuth token, SAML, SSO, session, by path or by body', () => {
    const writes = guard();
    expect(writes.decide('POST', 'http://app.test/sso/oidc/web-client/token')).toBe('continue');
    expect(writes.decide('POST', 'http://app.test/oauth2/token')).toBe('continue');
    expect(writes.decide('POST', 'http://app.test/saml2/acs')).toBe('continue');
    expect(writes.decide('POST', 'http://app.test/api/session')).toBe('continue');
    expect(
      writes.decide('POST', 'http://app.test/idp/exchange', 'grant_type=authorization_code&code=x'),
    ).toBe('continue');
    // Une écriture métier reste bloquée, même si son chemin contient « auth » dans un mot.
    expect(writes.decide('PUT', 'http://app.test/api/authors/3')).toBe('block');
    expect(writes.decide('POST', 'http://app.test/api/tasks/QA%20Test/owner', '{"owner":"x"}')).toBe('block');
  });

  it('allow list: method + path with wildcards, or a path for any method', () => {
    const writes = guard(['POST /api/search', '/graphql', 'PATCH /api/*/preferences']);
    expect(writes.decide('POST', 'http://app.test/api/search?q=x')).toBe('continue');
    expect(writes.decide('PUT', 'http://app.test/api/search')).toBe('block');
    expect(writes.decide('POST', 'http://app.test/graphql')).toBe('continue');
    expect(writes.decide('PATCH', 'http://app.test/api/me/preferences')).toBe('continue');
  });

  it('disabled: nothing is blocked', () => {
    const off = new WriteGuard({ enabled: false, allow: [], isGuardedHost: () => true });
    expect(off.decide('DELETE', 'http://app.test/x')).toBe('continue');
  });
});

describe('options of a group, once per run', () => {
  it('the same option of the same group on another screen has the same key; another group does not', () => {
    const yes = (groupLabel: string) =>
      screen({
        elements: [
          element({
            tag: 'input',
            role: 'radio',
            inputType: 'radio',
            name: 'Oui',
            text: 'Oui',
            groupLabel,
            choiceGroup: 'g1',
          }),
        ],
      }).actions[0];
    const first = yes('Déjà client ?');
    const again = yes('Déjà client ?');
    const other = yes('Accepte les conditions ?');
    if (!first || !again || !other) throw new Error('no radio');
    expect(optionKey(first)).toBe(optionKey(again));
    expect(optionKey(first)).not.toBe(optionKey(other));
  });

  it('autocomplete fields are recognised (role combobox where one types)', () => {
    const [auto, plain] = screen({
      elements: [field('Code agence', { role: 'combobox' }), field('Nom')],
    }).actions;
    expect(auto && isAutocomplete(auto)).toBe(true);
    expect(plain && isAutocomplete(plain)).toBe(false);
  });
});
