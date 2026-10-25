import { describe, expect, it } from 'vitest';
import { routePattern } from '../../src/crawler/route-normalizer.js';
import {
  auraActions,
  isGraphqlRead,
  lightningReadOnlyPost,
  readOnlyPostOf,
} from '../../src/platforms/salesforce-lightning.js';
import { WriteGuard } from '../../src/policies/write-guard.js';
import { isDynamicValue } from '../../src/recording/selector-builder.js';

const auraBody = (...descriptors: string[]): string =>
  `message=${encodeURIComponent(JSON.stringify({ actions: descriptors.map((descriptor, index) => ({ id: `${String(index)};a`, descriptor })) }))}&aura.context=%7B%7D&aura.token=never-logged`;

describe('Salesforce Lightning profile — Aura and GraphQL reads', () => {
  it('reads the Aura actions of a POST /aura body and classifies them by method name', () => {
    expect(
      auraActions(
        auraBody(
          'aura://RecordUiController/ACTION$getRecordWithFields',
          'apex://LoanController/ACTION$saveLoan',
        ),
      ),
    ).toEqual([
      {
        descriptor: 'aura://RecordUiController/ACTION$getRecordWithFields',
        method: 'getRecordWithFields',
        read: true,
      },
      { descriptor: 'apex://LoanController/ACTION$saveLoan', method: 'saveLoan', read: false },
    ]);
    expect(auraActions('not=an&aura=body')).toBeUndefined();
    expect(auraActions('message=%7Bbroken')).toBeUndefined();
    expect(auraActions(null)).toBeUndefined();
  });

  it('lets a POST /aura pass only when every action reads', () => {
    expect(lightningReadOnlyPost('/aura', auraBody('aura://ListUiController/ACTION$getListUi'))).toBe(true);
    expect(
      lightningReadOnlyPost('/s/sfsites/aura', auraBody('serviceComponent://ui.x/ACTION$loadItems')),
    ).toBe(true);
    expect(
      lightningReadOnlyPost(
        '/aura',
        auraBody('aura://ListUiController/ACTION$getListUi', 'aura://RecordUiController/ACTION$updateRecord'),
      ),
    ).toBe(false);
    // « getter » n'est pas « get » suivi d'une majuscule ; une méthode sans verbe reconnu reste bloquée.
    expect(lightningReadOnlyPost('/aura', auraBody('apex://X/ACTION$getterDoesWrite'))).toBe(false);
    expect(lightningReadOnlyPost('/aura', auraBody('apex://X/ACTION$process'))).toBe(false);
    expect(lightningReadOnlyPost('/aura', 'garbage')).toBe(false);
    expect(lightningReadOnlyPost('/api/aura-like', auraBody('aura://X/ACTION$getY'))).toBe(false);
  });

  it('lets a GraphQL query pass, never a mutation', () => {
    const graphql = '/services/data/v60.0/graphql';
    expect(
      isGraphqlRead(
        JSON.stringify({ query: 'query Accounts { uiapi { query { Account { edges { node { Id } } } } } }' }),
      ),
    ).toBe(true);
    expect(
      lightningReadOnlyPost(
        graphql,
        JSON.stringify({ query: '{ uiapi { query { Account { totalCount } } } }' }),
      ),
    ).toBe(true);
    expect(
      lightningReadOnlyPost(
        graphql,
        JSON.stringify({ query: 'mutation Update { uiapi { AccountUpdate } }' }),
      ),
    ).toBe(false);
    expect(lightningReadOnlyPost(graphql, JSON.stringify({ query: '# a comment\n mutation { x }' }))).toBe(
      false,
    );
    // Le mot dans une chaîne n'est pas une opération.
    expect(
      lightningReadOnlyPost(graphql, JSON.stringify({ query: 'query { search(text: "mutation") }' })),
    ).toBe(true);
    expect(lightningReadOnlyPost(graphql, '{not json')).toBe(false);
  });

  it('is only active with the salesforce-lightning platform, inside the write guard', () => {
    expect(readOnlyPostOf('generic')).toBeUndefined();
    const guarded = (platform: 'generic' | 'salesforce-lightning'): WriteGuard =>
      new WriteGuard({
        enabled: true,
        allow: [],
        isGuardedHost: (host) => host === 'org.example.test',
        ...(readOnlyPostOf(platform) ? { readOnlyPost: readOnlyPostOf(platform) } : {}),
      });
    const read = auraBody('aura://RecordUiController/ACTION$getRecordWithFields');
    const write = auraBody('aura://RecordUiController/ACTION$updateRecord');
    const url = 'https://org.example.test/aura?r=3&aura.RecordUi.getRecordWithFields=1';
    expect(guarded('generic').decide('POST', url, read)).toBe('block');
    expect(guarded('salesforce-lightning').decide('POST', url, read)).toBe('continue');
    expect(guarded('salesforce-lightning').decide('POST', url, write)).toBe('block');
    // Un autre verbe d'écriture n'est jamais concerné : seules les lectures en POST passent.
    expect(
      guarded('salesforce-lightning').decide(
        'PATCH',
        'https://org.example.test/services/data/v60.0/ui-api/records/001',
        '{}',
      ),
    ).toBe('block');
  });
});

describe('Salesforce Lightning traits handled by the generic engine', () => {
  it('groups record pages by object: /lightning/r/<Object>/<15 or 18 char id>/…', () => {
    expect(routePattern('/lightning/r/Account/001Dn00000AbCdEIAV/view')).toBe(
      '/lightning/r/account/:recordid/view',
    );
    expect(routePattern('/lightning/r/Account/001Dn00000AbCdE/related/Contacts/view')).toBe(
      '/lightning/r/account/:recordid/related/contacts/view',
    );
    expect(routePattern('/lightning/o/Account/list')).toBe('/lightning/o/account/list');
    // Hors de /lightning/r/, un segment de 18 caractères garde les règles génériques.
    expect(routePattern('/catalog/ABCDEFGHIJKLMNOPQR')).toBe('/catalog/abcdefghijklmnopqr');
  });

  it('treats data-aura-rendered-by values as generated', () => {
    expect(isDynamicValue('attribute', '123:0')).toBe(true);
    expect(isDynamicValue('attribute', '1052:2;a')).toBe(true);
    expect(isDynamicValue('attribute', 'forceOutputLookup')).toBe(false);
  });
});
