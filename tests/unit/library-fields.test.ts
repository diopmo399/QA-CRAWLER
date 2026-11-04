import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flowSchema } from '../../src/config/flow-schema.js';
import { contractOf } from '../../src/sdk/server/library-contract.js';
import { contractFields, inferType } from '../../src/sdk/server/library-fields.js';
import {
  createQaCrawler,
  journeyOfParts,
  QaCrawlerError,
  type Journey,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import type { TestDataSet } from '../../src/data/test-data-set.js';

/**
 * LE CONTRAT DE DONNÉES ENRICHI : l'étape `capture` (schéma), l'analyse des données d'un bloc (provenance,
 * statut de détection, justification, étapes, type déclaré / proposé / par défaut, candidates), un ancien
 * bloc sans déclaration, les déclarations persistées et relues, la version d'une donnée qui évolue de façon
 * incompatible (refusée sans validation explicite quand le bloc est utilisé), et le raccordement :
 * propositions fiables, ambiguës, types incompatibles.
 */

const parse = (steps: unknown[]) => flowSchema.safeParse({ name: 'F', steps });
const issues = (steps: unknown[]): string => {
  const result = parse(steps);
  return result.success ? 'ok' : result.error.issues.map((issue) => issue.message).join(' | ');
};

describe('capture step — schema', () => {
  it('accepts each source, refuses a secret key, two sources, a pattern without group', () => {
    expect(issues([{ capture: { as: 'order.id', url: { pattern: '/orders/(\\d+)' } } }])).toBe('ok');
    expect(issues([{ capture: { as: 'order.id', url: { param: 'id' } } }])).toBe('ok');
    expect(issues([{ capture: { as: 'order.title', text: { css: 'h1' }, pattern: 'N° (\\w+)' } }])).toBe(
      'ok',
    );
    expect(
      issues([
        { capture: { as: 'order.link', attribute: { role: 'link', name: 'Voir', attribute: 'href' } } },
      ]),
    ).toBe('ok');
    expect(
      issues([
        { capture: { as: 'order.id', response: { method: 'post', url: '/api/orders', field: 'id' } } },
      ]),
    ).toBe('ok');
    expect(issues([{ capture: { as: 'order.copy', data: 'order.id' } }])).toBe('ok');
    expect(issues([{ capture: { as: 'user.password', text: { css: 'h1' } } }])).toMatch(
      /looks like a secret: never captured/,
    );
    expect(issues([{ capture: { as: 'order.id', text: { css: 'h1' }, data: 'x' } }])).toMatch(
      /exactly one of text, attribute, url, response, data/,
    );
    expect(issues([{ capture: { as: 'order.id', url: { pattern: '/orders/\\d+' } } }])).toMatch(
      /capturing group/,
    );
    expect(issues([{ capture: { as: 'order.id', url: { pattern: '(x)', param: 'id' } } }])).toMatch(
      /exactly one of pattern, param/,
    );
    expect(issues([{ capture: { as: 'not a key', url: { param: 'id' } } }])).toMatch(/is not a data key/);
    const parsed = parse([
      { capture: { as: 'order.id', response: { method: 'post', url: '/api/orders', field: 'id' } } },
    ]);
    expect(parsed.success && parsed.data.steps[0]).toMatchObject({
      kind: 'capture',
      capture: { as: 'order.id', from: 'response', method: 'POST', url: '/api/orders', field: 'id' },
    });
  });
});

const data = (values: TestDataSet['values']): TestDataSet => ({
  id: 'd',
  name: 'd',
  source: 'MANUAL',
  values,
});

describe('data of a block — analysis', () => {
  it('a block without input nor output has none, and no candidate', () => {
    const steps = [{ goto: '/' }, { click: { role: 'button', name: 'Ouvrir' } }];
    const { contract } = contractOf({ name: 'B', steps });
    expect(contract).toMatchObject({ inputs: [], outputs: [] });
    expect(contractFields({ blockId: 'b', steps, contract })).toEqual({
      inputs: [],
      outputs: [],
      candidates: [],
    });
  });

  it('generated, captured, fixed and read data: provenance, detection, evidence, steps, type', () => {
    const steps = [
      { fill: { label: 'Référence', value: { testData: 'order.ref' } } },
      { fill: { label: 'Canal', value: { testData: 'order.channel' } } },
      { fill: { label: 'Client', value: { testData: 'customer.name' } } },
      { fill: { label: 'Note', value: 'livraison rapide' } },
      { fill: { css: '#x', value: 'abc' } },
      { fill: { label: 'Mot de passe', value: 'secret' } },
      { capture: { as: 'order.id', url: { pattern: '/orders/(\\d+)' } } },
    ];
    const set = data({
      'order.ref': {
        key: 'order.ref',
        strategy: 'GENERATE_AT_REPLAY',
        generator: 'unique',
        sensitive: false,
      },
      'order.channel': { key: 'order.channel', strategy: 'BUSINESS_LITERAL', value: 'web', sensitive: false },
    });
    const { contract } = contractOf({ name: 'B', steps, data: set });
    const fields = contractFields({ blockId: 'b', steps, data: set, contract });
    const byKey = Object.fromEntries(fields.outputs.map((field) => [field.key, field]));
    expect(byKey['order.ref']).toMatchObject({
      origin: 'GENERATED',
      detection: 'CONFIRMED',
      steps: [1],
      type: 'identifier',
      typeSource: 'INFERRED',
      generator: 'unique',
    });
    expect(byKey['order.channel']).toMatchObject({
      origin: 'DATA',
      detection: 'PROBABLE',
      steps: [2],
      typeSource: 'DEFAULT',
    });
    expect(byKey['order.channel']?.evidence[0]).toMatch(/sans preuve qu’un bloc suivant en dépende/);
    expect(byKey['order.id']).toMatchObject({ origin: 'CAPTURED', detection: 'CONFIRMED', steps: [7] });
    expect(byKey['order.id']?.capture?.source).toMatch(/adresse/);
    expect(fields.inputs).toMatchObject([
      {
        key: 'customer.name',
        origin: 'INPUT',
        detection: 'CONFIRMED',
        steps: [3],
        required: true,
        type: 'text',
        typeSource: 'DEFAULT',
      },
    ]);
    // Les candidates : une valeur fixe dans un champ nommé (probable), dans un champ sans nom (inconnue) ;
    // jamais un champ secret.
    expect(fields.candidates.map((field) => [field.key, field.detection, field.steps[0]])).toEqual([
      ['input.note', 'PROBABLE', 4],
      ['input.step_5', 'UNKNOWN', 5],
    ]);
    expect(JSON.stringify(fields)).not.toContain('livraison rapide');
    expect(JSON.stringify(fields)).not.toContain('secret');
  });

  it('types are proposed from a clue, never confirmed; text otherwise', () => {
    expect(inferType('contact.email', {})).toBe('email');
    expect(inferType('x', { generator: 'email' })).toBe('email');
    expect(inferType('order.id', {})).toBe('identifier');
    expect(inferType('due', { field: 'Date de fin' })).toBe('date');
    expect(inferType('order.total', {})).toBe('number');
    expect(inferType('customer.name', {})).toBeUndefined();
  });
});

let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let projectDir: string;

const refusal = async (promise: Promise<unknown>): Promise<QaCrawlerError | string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? error : String(error);
  }
};

const FLOWS: [string, string, string?][] = [
  [
    'create',
    'name: Créer une commande\nstartAt: /orders\ntestData: test-data.yaml\nsteps:\n  - fill: { label: Référence, value: { testData: order.ref } }\n',
    'values:\n  order:\n    ref: { strategy: generated, generator: unique }\n',
  ],
  [
    'other',
    'name: Créer un lot\nstartAt: /lots\ntestData: test-data.yaml\nsteps:\n  - fill: { label: Lot, value: { testData: lot.ref } }\n',
    'values:\n  lot:\n    ref: { strategy: generated, generator: unique }\n',
  ],
  [
    'take',
    'name: Suivre\nstartAt: /track\nsteps:\n  - fill: { label: Suivi, value: { testData: track.ref } }\n',
  ],
  ['use', 'name: Utiliser\nstartAt: /use\nsteps:\n  - expect: { text: "${testData:order.ref}" }\n'],
];

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-fields-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Données', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  projectDir = path.join(workspace, project.id);
  const flows = await flowsDirOf(projectDir);
  for (const [folder, flow, testData] of FLOWS) {
    await mkdir(path.join(flows, folder), { recursive: true });
    await writeFile(path.join(flows, folder, `${folder}.flow.yaml`), flow);
    if (testData) await writeFile(path.join(flows, folder, 'test-data.yaml'), testData);
  }
  for (const [scenario, name] of [
    ['Créer une commande', 'Commande'],
    ['Créer un lot', 'Lot'],
    ['Suivre', 'Suivi'],
    ['Utiliser', 'Usage'],
  ] as const)
    await client.library.add(project.id, { from: 'scenario', scenario, name });
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

const block = async (name: string) =>
  (await client.library.list(project.id)).find((entry) => entry.name === name);

describe('SDK — data declarations, versions and wiring', () => {
  it('an old block (no declaration in the registry) reads as before, with described data', async () => {
    const registry = JSON.parse(await readFile(path.join(projectDir, 'sdk-library.json'), 'utf8')) as {
      blocks: Record<string, { fields?: unknown }>;
    };
    expect(registry.blocks.Commande?.fields).toBeUndefined();
    const view = await block('Commande');
    expect(view?.contract).toMatchObject({
      source: 'DERIVED',
      outputs: [{ key: 'order.ref', dynamic: true }],
    });
    expect(view?.contract.fields?.outputs[0]).toMatchObject({
      key: 'order.ref',
      version: 1,
      detection: 'CONFIRMED',
    });
  });

  it('declares label, meaning and type; persisted and read again; an unknown key is refused', async () => {
    const result = await client.library.declareFields(project.id, 'Commande', [
      {
        direction: 'output',
        key: 'order.ref',
        label: 'Référence',
        meaning: 'référence de commande',
        type: 'identifier',
      },
    ]);
    expect(result.incompatible).toEqual([]);
    expect(result.block.contract.fields?.outputs[0]).toMatchObject({
      label: 'Référence',
      meaning: 'référence de commande',
      type: 'identifier',
      typeSource: 'DECLARED',
      version: 1,
    });
    // Relu depuis le registre (un autre appel, rien en mémoire).
    expect((await block('Commande'))?.contract.fields?.outputs[0]).toMatchObject({
      meaning: 'référence de commande',
    });
    const unknown = await refusal(
      client.library.declareFields(project.id, 'Commande', [{ direction: 'input', key: 'nothing.here' }]),
    );
    expect(unknown instanceof QaCrawlerError && unknown.status).toBe(422);
  });

  it('wiring: by name; ambiguous between two references; the business meaning decides; incompatible types are said', async () => {
    const journey: Journey = journeyOfParts('Suivre une commande', [
      { block: 'Commande', version: 1 },
      { block: 'Lot', version: 1 },
      { block: 'Suivi', version: 1 },
    ]);
    const track = journey.graph.nodes.filter((node) => node.kind === 'BLOCK')[2];
    if (!track) throw new Error('no node');
    let check = await client.journeys.check(project.id, journey);
    expect(check.nodes[track.id]?.proposals).toMatchObject([
      {
        input: 'track.ref',
        status: 'AMBIGUOUS',
        candidates: [
          { key: 'lot.ref', compatible: true, reason: 'même type (identifier), même nom final (ref)' },
          { key: 'order.ref', compatible: true, reason: 'même type (identifier), même nom final (ref)' },
        ],
      },
    ]);
    expect(check.nodes[track.id]?.warnings.join(' ')).toMatch(
      /correspondance ambiguë pour track\.ref : lot\.ref, order\.ref/,
    );

    // Le sens métier déclaré de l'entrée départage : une seule proposition fiable (jamais retenue seule).
    await client.library.declareFields(project.id, 'Suivi', [
      { direction: 'input', key: 'track.ref', meaning: 'référence de commande' },
    ]);
    check = await client.journeys.check(project.id, journey);
    const proposal = check.nodes[track.id]?.proposals?.[0];
    expect(proposal).toMatchObject({ status: 'UNIQUE' });
    expect(proposal?.candidates[0]).toMatchObject({ key: 'order.ref', compatible: true });
    expect(proposal?.candidates[0]?.reason).toMatch(/même sens métier/);
    expect(check.ok).toBe(false);

    // Retenue explicitement : l'entrée est satisfaite, le parcours tient.
    track.params = { 'track.ref': { mode: 'MAP', key: 'order.ref' } };
    check = await client.journeys.check(project.id, journey);
    expect(check.nodes[track.id]?.missing).toEqual([]);
    expect(check.ok).toBe(true);

    // Deux types déclarés différents : la correspondance est refusée, rien n'est converti.
    await client.library.declareFields(project.id, 'Suivi', [
      { direction: 'input', key: 'track.ref', type: 'email' },
    ]);
    check = await client.journeys.check(project.id, journey);
    expect(check.nodes[track.id]?.errors).toContain(
      'types incompatibles : l’entrée track.ref reçoit order.ref (email ≠ identifier)',
    );
    expect(check.ok).toBe(false);
    await client.journeys.save(project.id, journey);
  });

  it('an incompatible change of a used block is refused until validated; the data version moves, not the block version', async () => {
    const before = await block('Commande');
    const refused = await refusal(
      client.library.declareFields(project.id, 'Commande', [
        { direction: 'output', key: 'order.ref', type: 'number' },
      ]),
    );
    expect(refused instanceof QaCrawlerError && refused.status).toBe(409);
    expect(refused instanceof QaCrawlerError && refused.details).toEqual([
      'order.ref : type identifier → number',
      'parcours Suivre une commande',
    ]);
    // Rien n'a été écrit.
    expect((await block('Commande'))?.contract.fields?.outputs[0]).toMatchObject({
      type: 'identifier',
      version: 1,
    });
    const accepted = await client.library.declareFields(
      project.id,
      'Commande',
      [{ direction: 'output', key: 'order.ref', type: 'number' }],
      { acceptIncompatible: true },
    );
    expect(accepted.incompatible).toEqual([
      { key: 'order.ref', direction: 'output', version: 2, reason: 'type identifier → number' },
    ]);
    expect(accepted.dependents).toEqual(['parcours Suivre une commande']);
    expect(accepted.block.contract.fields?.outputs[0]).toMatchObject({ type: 'number', version: 2 });
    expect(accepted.block.version).toBe(before?.version);
    expect(accepted.block.history.at(-1)?.change).toMatch(/incompatible: order\.ref v2/);
  });

  it('withdrawing an output (validated, the block is used): no longer exposed, nor offered downstream', async () => {
    const result = await client.library.declareFields(
      project.id,
      'Lot',
      [{ direction: 'output', key: 'lot.ref', confirmed: false }],
      { acceptIncompatible: true },
    );
    expect(result.incompatible).toMatchObject([{ key: 'lot.ref', reason: 'sortie retirée' }]);
    expect(result.block.contract.outputs).toEqual([]);
    expect(result.block.contract.fields?.outputs[0]).toMatchObject({ key: 'lot.ref', exposed: false });
  });
});
