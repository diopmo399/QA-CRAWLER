import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFlowRuns } from '../../src/flows/flow-includes.js';
import { loadProjectConfig, loadProjectMission } from '../../src/project/project-config.js';
import {
  chain,
  compileJourneyPath,
  createQaCrawler,
  journeyOfParts,
  journeyPaths,
  journeyStructure,
  linearOrder,
  QaCrawlerError,
  type Journey,
  type JourneyGraph,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults, PROJECT_FILE } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LES PARCOURS VISUELS : le modèle (structure, chemins, mode linéaire sans perte, compilation `run:` +
 * `with:`), l'extension du moteur (`with:` renomme les données d'une instance, le bloc reste intact), puis
 * le serveur : enregistrement (révision), vérification chemin par chemin (une donnée d'une branche n'est
 * pas disponible sur l'autre), version à accepter, création d'un scénario (ou d'un par chemin sur
 * demande), lu par le chargeur de missions du moteur. Rien n'est écrasé.
 */

const graphOf = (nodes: JourneyGraph['nodes'], edges: [string, string, ('YES' | 'NO')?][]): JourneyGraph => ({
  nodes,
  edges: edges.map(([from, to, branch], index) => ({
    id: `e${String(index + 1)}`,
    from,
    to,
    ...(branch ? { branch } : {}),
  })),
});
const node = (id: string, kind: JourneyGraph['nodes'][number]['kind'], extra = {}) => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...extra,
});

describe('modèle du parcours', () => {
  it('structure : début, fin, conditions à deux branches, jonctions, accessibilité, boucles', () => {
    const ok = graphOf(
      [
        node('s', 'START'),
        node('a', 'BLOCK', { block: 'A' }),
        node('c', 'CONDITION', { label: 'Urgent ?' }),
        node('b', 'BLOCK', { block: 'B' }),
        node('d', 'BLOCK', { block: 'D' }),
        node('j', 'JOIN'),
        node('f', 'END'),
      ],
      [
        ['s', 'a'],
        ['a', 'c'],
        ['c', 'b', 'YES'],
        ['c', 'd', 'NO'],
        ['b', 'j'],
        ['d', 'j'],
        ['j', 'f'],
      ],
    );
    const good = journeyStructure(ok);
    expect(good.errors).toEqual([]);
    expect(good.nodes).toEqual({});
    expect(good.edges).toEqual({});
    expect(journeyPaths(ok).map((entry) => entry.nodes.join(''))).toEqual(['sacbjf', 'sacdjf']);
    expect(journeyPaths(ok)[1]?.choices).toEqual([{ node: 'c', label: 'Urgent ?', branch: 'NO' }]);

    // Une branche manquante, une boucle, un nœud isolé, une connexion vers un nœud absent.
    const bad = graphOf(
      [
        node('s', 'START'),
        node('a', 'BLOCK', { block: 'A' }),
        node('c', 'CONDITION', { label: '' }),
        node('x', 'BLOCK', { block: 'X' }),
        node('f', 'END'),
      ],
      [
        ['s', 'a'],
        ['a', 'c'],
        ['c', 'a', 'YES'],
        ['a', 'zz'],
      ],
    );
    const found = journeyStructure(bad);
    expect(found.nodes.c).toEqual(
      expect.arrayContaining([
        'la condition n’a pas de question',
        'une condition a exactement une branche Oui et une branche Non',
      ]),
    );
    expect(found.nodes.x).toEqual(expect.arrayContaining(['inaccessible depuis le début']));
    expect(Object.values(found.edges).flat()).toEqual(
      expect.arrayContaining([
        'connexion vers un nœud absent',
        'boucle : le moteur ne rejoue pas de boucle, retirez cette connexion',
      ]),
    );
  });

  it('mode linéaire : sans perte seulement ; sinon la raison est dite', () => {
    const linear = journeyOfParts('Parcours', [{ block: 'A', version: 1 }, { block: 'B' }]);
    const order = linearOrder(linear.graph);
    expect(order.ok && order.blocks.map((entry) => entry.block)).toEqual(['A', 'B']);
    const withCondition: JourneyGraph = {
      nodes: [...linear.graph.nodes, node('c9', 'CONDITION', { label: 'Urgent ?' })],
      edges: linear.graph.edges,
    };
    const refused = linearOrder(withCondition);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(
      /1 condition\(s\) : un branchement ne se lit pas comme une suite/,
    );
    const orphan: JourneyGraph = {
      nodes: [...linear.graph.nodes, node('n9', 'BLOCK', { block: 'Z' })],
      edges: linear.graph.edges,
    };
    const lost = linearOrder(orphan);
    expect(!lost.ok && lost.reason).toMatch(/hors de la suite.*seraient perdus/);
    // Réordonner garde les nœuds (et leurs paramètres) ; les connexions sont refaites.
    const blocks = order.ok ? [...order.blocks].reverse() : [];
    const start = linear.graph.nodes.find((entry) => entry.kind === 'START');
    const end = linear.graph.nodes.find((entry) => entry.kind === 'END');
    const reordered = chain(
      start ?? node('s', 'START'),
      blocks,
      end ?? node('f', 'END'),
      linear.graph.edges,
      true,
    );
    const again = linearOrder(reordered);
    expect(again.ok && again.blocks.map((entry) => entry.block)).toEqual(['B', 'A']);
  });

  it('compilation : run: par bloc, with: pour les données propres à une instance', () => {
    const graph = graphOf(
      [
        node('s', 'START'),
        node('n3', 'BLOCK', {
          block: 'Créer',
          params: { 'item.title': { mode: 'VALUE', value: 'Titre A' } },
        }),
        node('n4', 'BLOCK', {
          block: 'Créer',
          params: { 'item.title': { mode: 'VALUE', value: 'Titre B' } },
        }),
        node('n5', 'BLOCK', {
          block: 'Chercher',
          params: { 'item.title': { mode: 'MAP', key: 'item.title__n4' } },
        }),
        node('f', 'END'),
      ],
      [
        ['s', 'n3'],
        ['n3', 'n4'],
        ['n4', 'n5'],
        ['n5', 'f'],
      ],
    );
    const compiled = compileJourneyPath(graph, ['s', 'n3', 'n4', 'n5', 'f']);
    expect(compiled.steps).toEqual([
      { run: 'Créer', with: { 'item.title': 'item.title__n3' } },
      { run: 'Créer', with: { 'item.title': 'item.title__n4' } },
      { run: 'Chercher', with: { 'item.title': 'item.title__n4' } },
    ]);
    expect(compiled.values).toEqual([
      { key: 'item.title__n3', value: 'Titre A' },
      { key: 'item.title__n4', value: 'Titre B' },
    ]);
    // Le moteur : chaque instance lit sa clé ; le bloc lui-même n'est pas modifié.
    const block = {
      name: 'Créer',
      reusable: true,
      steps: [
        { fill: { label: 'Titre', value: { testData: 'item.title' } } },
        { expect: { text: '${testData:item.title}' } },
      ],
    };
    const resolved = resolveFlowRuns([block, { name: 'P', steps: compiled.steps.slice(0, 2) }]) as {
      steps: unknown[];
    }[];
    expect(JSON.stringify(resolved[0]?.steps)).toContain('{"testData":"item.title__n3"}');
    expect(JSON.stringify(resolved[0]?.steps)).toContain('${testData:item.title__n4}');
    expect(block.steps[0]).toEqual({ fill: { label: 'Titre', value: { testData: 'item.title' } } });
    expect(() =>
      resolveFlowRuns([block, { name: 'P', steps: [{ run: 'Créer', with: { 'item.title': 'a b' } }] }]),
    ).toThrow(/"with" needs data keys/);
  });
});

let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let projectDir: string;

const CREATE = `name: Créer un élément
startAt: /items
steps:
  - click: { role: button, name: Nouveau }
  - fill: { label: Titre, value: { testData: item.title } }
  - click: { role: button, name: Enregistrer }
`;
const NUMBER = `name: Numéroter
startAt: /items
testData: test-data.yaml
steps:
  - fill: { label: Numéro, value: { testData: item.number } }
`;
const NUMBER_DATA = `values:
  item:
    number: { strategy: generated, generator: unique }
`;
const CHECK = `name: Vérifier le numéro
startAt: /items
steps:
  - expect: { text: "\${testData:item.number}" }
`;

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? `${String(error.status)} ${error.message}` : String(error);
  }
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-journeys-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Parcours', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  projectDir = path.join(workspace, project.id);
  const flows = await flowsDirOf(projectDir);
  for (const [folder, flow, data] of [
    ['create', CREATE, undefined],
    ['number', NUMBER, NUMBER_DATA],
    ['check', CHECK, undefined],
  ] as const) {
    await mkdir(path.join(flows, folder), { recursive: true });
    await writeFile(path.join(flows, folder, `${folder}.flow.yaml`), flow);
    if (data) await writeFile(path.join(flows, folder, 'test-data.yaml'), data);
  }
  for (const [scenario, name] of [
    ['Créer un élément', 'Créer'],
    ['Numéroter', 'Numéroter (bloc)'],
    ['Vérifier le numéro', 'Vérifier'],
  ] as const)
    await client.library.add(project.id, { from: 'scenario', scenario, name });
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

const journeyWith = (name: string, graph: JourneyGraph, mode: Journey['mode'] = 'DIAGRAM'): Journey => ({
  name,
  mode,
  graph,
});

describe('SDK — parcours visuels', () => {
  it('enregistre, relit, refuse une révision périmée ; la vérification suit chaque chemin', async () => {
    expect(await client.journeys.list(project.id)).toEqual([]);
    const linear = journeyOfParts('Créer deux éléments', [
      { block: 'Créer', version: 1 },
      { block: 'Créer', version: 1 },
    ]);
    const blocks = linear.graph.nodes.filter((entry) => entry.kind === 'BLOCK');
    // Deux instances du même bloc, chacune sa valeur.
    (blocks[0] as (typeof blocks)[number]).params = { 'item.title': { mode: 'VALUE', value: 'Titre A' } };
    (blocks[1] as (typeof blocks)[number]).params = { 'item.title': { mode: 'VALUE', value: 'Titre B' } };
    const saved = await client.journeys.save(project.id, linear);
    expect(saved.revision).toMatch(/^[0-9a-f]{8}$/);
    expect((await client.journeys.open(project.id, 'Créer deux éléments')).graph).toEqual(linear.graph);
    expect(await refusal(client.journeys.save(project.id, linear, { revision: 'deadbeef' }))).toMatch(/^409/);
    const check = await client.journeys.check(project.id, linear);
    expect(check).toMatchObject({ ok: true, linear: true, publishable: 'SINGLE' });
    expect(check.paths).toHaveLength(1);

    // Sans valeur pour l'instance : l'entrée manque, sur le nœud concerné.
    const bare = journeyOfParts('Sans valeur', [{ block: 'Créer', version: 1 }]);
    const missing = await client.journeys.check(project.id, bare);
    const id = bare.graph.nodes.find((entry) => entry.kind === 'BLOCK')?.id ?? '';
    expect(missing.ok).toBe(false);
    expect(missing.nodes[id]?.missing).toEqual([{ key: 'item.title', path: 1 }]);

    // Une donnée produite dans la branche Oui seulement n'est pas disponible sur le chemin Non.
    const branching = journeyWith(
      'Numéroter si urgent',
      graphOf(
        [
          node('s', 'START', { y: 0 }),
          node('c', 'CONDITION', { label: 'Urgent ?' }),
          node('n', 'BLOCK', { block: 'Numéroter (bloc)', version: 1 }),
          node('j', 'JOIN'),
          node('v', 'BLOCK', { block: 'Vérifier', version: 1 }),
          node('f', 'END'),
        ],
        [
          ['s', 'c'],
          ['c', 'n', 'YES'],
          ['c', 'j', 'NO'],
          ['n', 'j'],
          ['j', 'v'],
          ['v', 'f'],
        ],
      ),
    );
    const paths = await client.journeys.check(project.id, branching);
    expect(paths.linear).toBe(false);
    expect(paths.linearReason).toMatch(/condition/);
    expect(paths.paths).toHaveLength(2);
    expect(paths.nodes.v?.missing).toEqual([{ key: 'item.number', path: 2 }]);
    // Disponible avant « Vérifier » : seulement ce qui l'est sur TOUS les chemins.
    expect(paths.nodes.v?.available).not.toContain('item.number');
    expect(paths.ok).toBe(false);

    // Une version plus récente que celle retenue est à accepter explicitement.
    const old = journeyOfParts('Version', [{ block: 'Créer', version: 7 }]);
    const versioned = await client.journeys.check(project.id, old);
    const oldId = old.graph.nodes.find((entry) => entry.kind === 'BLOCK')?.id ?? '';
    expect(versioned.nodes[oldId]?.errors.join(' ')).toMatch(/version 7 retenue, version 1 disponible/);
  });

  it('crée un scénario du parcours linéaire, lu par le moteur ; un parcours à conditions seulement par chemin', async () => {
    const created = await client.journeys.publish(project.id, 'Créer deux éléments');
    expect(created.scenarios).toEqual(['Créer deux éléments']);
    const config = await loadProjectConfig(path.join(projectDir, PROJECT_FILE));
    const loaded = await loadProjectMission(config, { command: 'replay', flows: ['Créer deux éléments'] });
    const flow = loaded.config.flows[0];
    expect(flow?.steps).toHaveLength(6);
    // Chaque instance saisit sa propre donnée.
    expect(JSON.stringify(flow?.steps)).toContain('item.title__n3');
    expect(JSON.stringify(flow?.steps)).toContain('item.title__n4');
    expect(flow?.testData?.values['item.title__n3']).toMatchObject({ value: 'Titre A' });
    expect(flow?.testData?.values['item.title__n4']).toMatchObject({ value: 'Titre B' });
    // Le bloc source n'a pas changé.
    const block = await readFile(
      path.join(await flowsDirOf(projectDir), 'library', 'creer', 'creer.flow.yaml'),
      'utf8',
    );
    expect(block).not.toContain('__n3');
    // Rien n'est écrasé : une deuxième création du même nom est refusée.
    expect(await refusal(client.journeys.publish(project.id, 'Créer deux éléments'))).toMatch(/^409/);
    expect((await client.journeys.list(project.id))[0]).toMatchObject({ published: ['Créer deux éléments'] });

    // Un parcours avec condition (valide) : refusé sans demande explicite, un scénario par chemin sinon.
    const graph = graphOf(
      [
        node('s', 'START'),
        node('n', 'BLOCK', { block: 'Numéroter (bloc)', version: 1 }),
        node('c', 'CONDITION', { label: 'Vérifier ?' }),
        node('v', 'BLOCK', { block: 'Vérifier', version: 1 }),
        node('f', 'END'),
        node('g', 'END'),
      ],
      [
        ['s', 'n'],
        ['n', 'c'],
        ['c', 'v', 'YES'],
        ['c', 'g', 'NO'],
        ['v', 'f'],
      ],
    );
    await client.journeys.save(project.id, journeyWith('Numéroter puis vérifier', graph));
    const check = await client.journeys.check(project.id, journeyWith('Numéroter puis vérifier', graph));
    expect(check).toMatchObject({ ok: true, linear: false, publishable: 'PER_PATH' });
    expect(await refusal(client.journeys.publish(project.id, 'Numéroter puis vérifier'))).toMatch(
      /^422 .*does not evaluate them/,
    );
    const split = await client.journeys.publish(project.id, 'Numéroter puis vérifier', { perPath: true });
    expect(split.scenarios).toEqual([
      'Numéroter puis vérifier · chemin A',
      'Numéroter puis vérifier · chemin B',
    ]);
    const scenarios = await client.scenarios.list(project.id);
    const first = scenarios.find((entry) => entry.name === split.scenarios[0]);
    expect(first?.uses).toEqual(['Numéroter (bloc)', 'Vérifier']);
    expect(scenarios.find((entry) => entry.name === split.scenarios[1])?.uses).toEqual(['Numéroter (bloc)']);
    expect(first?.description).toMatch(/chemin : Vérifier \? = Oui/);
  });

  it('retire un parcours ; les scénarios créés restent', async () => {
    await client.journeys.remove(project.id, 'Créer deux éléments');
    expect((await client.journeys.list(project.id)).map((entry) => entry.name)).not.toContain(
      'Créer deux éléments',
    );
    expect(
      (await client.scenarios.list(project.id)).some((entry) => entry.name === 'Créer deux éléments'),
    ).toBe(true);
    expect(await refusal(client.journeys.open(project.id, 'Créer deux éléments'))).toMatch(/^404/);
  });
});
