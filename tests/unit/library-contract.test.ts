import { describe, expect, it } from 'vitest';
import type { TestDataEntry, TestDataSet } from '../../src/data/test-data-set.js';
import {
  checkComposition,
  contentHash,
  contractOf,
  mergeData,
  type CompositionPart,
} from '../../src/sdk/server/library-contract.js';

/**
 * LE CONTRAT D'UN BLOC ET LA VÉRIFICATION D'UN PARCOURS (fonctions pures) : contrat dérivé de ce que le
 * bloc saisit et cite, contrat déclaré confronté au contenu, fusion des données sans écrasement
 * (identique : partagée ; différente, ou fixe face à générée : conflit nommé), dépendances entre blocs,
 * entrées manquantes, ordre, données dynamiques.
 */
const entry = (
  key: string,
  strategy: TestDataEntry['strategy'],
  extra: Partial<TestDataEntry> = {},
): TestDataEntry => ({
  key,
  strategy,
  sensitive: false,
  ...extra,
});
const set = (name: string, ...entries: TestDataEntry[]): TestDataSet => ({
  id: name,
  name,
  source: 'MANUAL',
  values: Object.fromEntries(entries.map((value) => [value.key, value])),
});

const CREATE = {
  name: 'Créer un élément',
  steps: [
    { click: { role: 'button', name: 'Nouveau' } },
    { fill: { label: 'Titre', value: { testData: 'item.title' } } },
    { click: { role: 'button', name: 'Enregistrer' } },
  ],
  data: set('c', entry('item.title', 'GENERATE_AT_REPLAY', { generator: 'words' })),
};
const SEARCH = {
  name: 'Chercher un élément',
  steps: [
    { fill: { label: 'Recherche', value: '${testData:item.title}' } },
    { expect: { text: '${testData:item.title}' } },
  ],
};

const part = (
  block: { name: string; steps: unknown[]; data?: TestDataSet },
  version = 1,
): CompositionPart => {
  const { contract, problems } = contractOf(block);
  return {
    name: block.name,
    block: {
      reusable: true,
      version,
      state: problems.length > 0 ? 'INVALID' : 'VALID',
      steps: block.steps.length,
      contract,
      problems,
      ...(block.data ? { data: block.data } : {}),
    },
  };
};

describe('block contract', () => {
  it('is derived from the content: outputs typed from its own data, inputs read without defining them', () => {
    expect(contractOf(CREATE)).toEqual({
      contract: {
        source: 'DERIVED',
        inputs: [],
        outputs: [{ key: 'item.title', dynamic: true }],
        preconditions: [],
        postconditions: [],
      },
      problems: [],
    });
    expect(contractOf(SEARCH).contract.inputs).toEqual([{ key: 'item.title', required: true }]);
    expect(contractOf(SEARCH).contract.outputs).toEqual([]);
  });

  it('a declared contract is held against the content (never a promise the steps do not keep)', () => {
    const declared = contractOf({
      ...SEARCH,
      declared: {
        inputs: [{ key: 'item.code', required: true }],
        outputs: ['item.id'],
        preconditions: ['un élément existe'],
        postconditions: ['l’élément est affiché'],
      },
    });
    expect(declared.contract.source).toBe('DECLARED');
    expect(declared.contract.preconditions).toEqual(['un élément existe']);
    expect(declared.problems).toEqual([
      'uses item.title without declaring it as an input',
      'declares the output item.id but does not type it from its own data',
    ]);
    const kept = contractOf({
      ...SEARCH,
      declared: {
        inputs: [{ key: 'item.title', required: true }],
        outputs: [],
        preconditions: [],
        postconditions: [],
      },
    });
    expect(kept.problems).toEqual([]);
  });

  it('the content hash follows the executable content, not the provenance', () => {
    const a = contentHash({ steps: CREATE.steps }, CREATE.data);
    const withProvenance = set(
      'c',
      entry('item.title', 'GENERATE_AT_REPLAY', { generator: 'words', provenance: { reasons: ['x'] } }),
    );
    expect(contentHash({ steps: CREATE.steps }, withProvenance)).toBe(a);
    expect(contentHash({ steps: [...CREATE.steps, { expect: { text: 'ok' } }] }, CREATE.data)).not.toBe(a);
  });
});

describe('test data merge', () => {
  it('identical definitions are shared; a different one is a named conflict and nothing is merged', () => {
    const same = mergeData(
      [
        { from: 'A', data: set('a', entry('item.title', 'BUSINESS_LITERAL', { value: 'X' })) },
        { from: 'B', data: set('b', entry('item.title', 'BUSINESS_LITERAL', { value: 'X' })) },
      ],
      'P',
    );
    expect(same.conflicts).toEqual([]);
    expect(same.shared).toEqual([{ key: 'item.title', blocks: ['A', 'B'] }]);
    expect(Object.keys(same.merged?.values ?? {})).toEqual(['item.title']);
    const clash = mergeData(
      [
        { from: 'A', data: set('a', entry('item.title', 'BUSINESS_LITERAL', { value: 'Fixe' })) },
        { from: 'B', data: set('b', entry('item.title', 'GENERATE_AT_REPLAY', { generator: 'words' })) },
      ],
      'P',
    );
    expect(clash.merged).toBeUndefined();
    expect(clash.conflicts).toEqual([
      {
        key: 'item.title',
        blocks: ['A', 'B'],
        detail: 'item.title: fixed value "Fixe" in "A", generated at replay (words) in "B"',
      },
    ]);
  });

  it('a secret is never shown in a conflict', () => {
    const clash = mergeData(
      [
        {
          from: 'A',
          data: set('a', entry('user.password', 'CREDENTIAL_REFERENCE', { env: 'PASS_A', sensitive: true })),
        },
        {
          from: 'B',
          data: set('b', entry('user.password', 'CREDENTIAL_REFERENCE', { env: 'PASS_B', sensitive: true })),
        },
      ],
      'P',
    );
    expect(clash.conflicts[0]?.detail).toBe('user.password: secret (PASS_A) in "A", secret (PASS_B) in "B"');
  });
});

describe('composition check (dry run, nothing is run)', () => {
  it('a block that produces what the next one consumes: dependency satisfied, data dynamic', () => {
    const check = checkComposition({
      name: 'Créer puis chercher',
      parts: [part(CREATE), part(SEARCH)],
      taken: [],
    });
    expect(check).toMatchObject({
      ok: true,
      blocks: 2,
      steps: 5,
      dependencies: [{ key: 'item.title', from: 1, to: 2 }],
      missing: [],
      conflicts: [],
      dynamic: ['item.title'],
      errors: [],
    });
    expect(check.order[1]?.satisfied).toEqual([{ key: 'item.title', from: 1 }]);
  });

  it('an input nobody provides is missing; produced only later is an order error', () => {
    const alone = checkComposition({ name: 'Chercher', parts: [part(SEARCH)], taken: [] });
    expect(alone.ok).toBe(false);
    expect(alone.missing).toEqual([{ key: 'item.title', block: 'Chercher un élément', position: 1 }]);
    expect(alone.errors[0]).toContain('needs item.title');
    const reversed = checkComposition({ name: 'Inverse', parts: [part(SEARCH), part(CREATE)], taken: [] });
    expect(reversed.ok).toBe(false);
    expect(reversed.errors).toContain('#1 "Chercher un élément" needs item.title, produced only later by #2');
  });

  it('structure: a name is required and free; an unknown part, a scenario, an empty journey are errors', () => {
    const check = checkComposition({
      name: 'Pris',
      parts: [
        { name: 'Inconnu' },
        {
          name: CREATE.name,
          block: { ...(part(CREATE).block as NonNullable<CompositionPart['block']>), reusable: false },
        },
      ],
      taken: ['Pris'],
    });
    expect(check.errors).toEqual([
      'a scenario or a block is already named "Pris"',
      '#1 "Inconnu": no block has this name',
      '#2 "Créer un élément" is a scenario: add it to the library first',
    ]);
    expect(checkComposition({ name: '', parts: [], taken: [] }).errors).toEqual([
      'a name of 1 to 80 characters is required',
      'choose at least one block',
    ]);
  });

  it('the same block twice shares its data; a block whose content changed is a warning', () => {
    const changed = part(CREATE, 2);
    if (changed.block) changed.block.state = 'CHANGED';
    const check = checkComposition({ name: 'Deux fois', parts: [part(CREATE), changed], taken: [] });
    expect(check.ok).toBe(true);
    // Le même bloc deux fois : une seule définition, rien à partager ni à opposer.
    expect(check.shared).toEqual([]);
    expect(check.conflicts).toEqual([]);
    expect(check.warnings[0]).toContain('changed since its version 2');
  });
});
