import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadProjectConfig, loadProjectMission } from '../../src/project/project-config.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults, PROJECT_FILE } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LA BIBLIOTHÈQUE DE SCÉNARIOS par le SDK, avec le chargeur de missions du moteur : un scénario devient
 * un bloc réutilisable ; un parcours se compose de blocs ; un bloc s'insère dans un scénario ; ses
 * données de test suivent (un conflit est refusé) ; un bloc utilisé ne se retire pas ; le moteur recopie
 * les étapes du bloc à la place de `run:` et ne l'exécute jamais seul.
 */
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let flows: string;

const CREATE = `name: Créer un élément
startAt: /items
testData: test-data.yaml
steps:
  - click: { role: button, name: Nouveau }
  - fill: { label: Titre, value: { testData: item.title } }
  - click: { role: button, name: Enregistrer }
`;
const DATA = `values:
  item:
    title: { strategy: generated, generator: words }
`;
const SEARCH = `name: Chercher un élément
startAt: /items
steps:
  - fill: { label: Recherche, value: "\${testData:item.title}" }
  - expect: { text: "\${testData:item.title}" }
`;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-library-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Bibliothèque', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  const projectDir = path.join(workspace, project.id);
  flows = await flowsDirOf(projectDir);
  await mkdir(path.join(flows, 'create'), { recursive: true });
  await mkdir(path.join(flows, 'search'), { recursive: true });
  await writeFile(path.join(flows, 'create', 'create.flow.yaml'), CREATE);
  await writeFile(path.join(flows, 'create', 'test-data.yaml'), DATA);
  await writeFile(path.join(flows, 'search', 'search.flow.yaml'), SEARCH);
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK — scenario library', () => {
  it('turns a scenario into a reusable block, with its data', async () => {
    expect(await client.library.list(project.id)).toEqual([]);
    const block = await client.library.add(project.id, {
      from: 'scenario',
      scenario: 'Créer un élément',
      name: 'Bloc création',
      description: 'Crée un élément au titre généré',
    });
    expect(block).toMatchObject({
      name: 'Bloc création',
      file: 'library/bloc-creation/bloc-creation.flow.yaml',
      steps: 3,
      startAt: '/items',
      inputs: ['item.title'],
      citations: [],
      usedBy: [],
      origin: { kind: 'scenario', name: 'Créer un élément' },
    });
    const written = parseYaml(await readFile(path.join(flows, block.file), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written).toMatchObject({ reusable: true, testData: 'test-data.yaml' });
    await expect(
      client.library.add(project.id, {
        from: 'scenario',
        scenario: 'Créer un élément',
        name: 'Bloc création',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.library.add(project.id, { from: 'scenario', scenario: 'Inconnu', name: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
    const scenarios = await client.scenarios.list(project.id);
    expect(scenarios.find((entry) => entry.name === 'Bloc création')).toMatchObject({ reusable: true });
  });

  it('composes a new journey from blocks; the engine replays the block steps there', async () => {
    // Un scénario se met d'abord en bibliothèque : seul un bloc suit toujours le parcours qui le rejoue.
    await expect(
      client.scenarios.compose(project.id, {
        name: 'Créer puis chercher',
        parts: ['Bloc création', 'Chercher un élément'],
      }),
    ).rejects.toMatchObject({ status: 422 });
    await client.library.add(project.id, {
      from: 'scenario',
      scenario: 'Chercher un élément',
      name: 'Bloc recherche',
    });
    const composed = await client.scenarios.compose(project.id, {
      name: 'Créer puis chercher',
      parts: ['Bloc création', 'Bloc recherche'],
    });
    expect(composed).toMatchObject({
      name: 'Créer puis chercher',
      file: 'composed/creer-puis-chercher/creer-puis-chercher.flow.yaml',
      uses: ['Bloc création', 'Bloc recherche'],
    });
    await expect(
      client.scenarios.compose(project.id, { name: 'Vide', parts: ['Inconnu'] }),
    ).rejects.toMatchObject({ status: 404 });
    // Le moteur : le bloc suit le scénario choisi, ses étapes remplacent `run:`, il n'est jamais seul.
    const projectDir = path.join(workspace, project.id);
    const config = await loadProjectConfig(path.join(projectDir, PROJECT_FILE));
    const loaded = await loadProjectMission(config, { command: 'replay', flows: ['Créer puis chercher'] });
    expect(loaded.config.flows.map((flow) => flow.name)).toEqual(['Créer puis chercher']);
    const steps = loaded.config.flows[0]?.steps ?? [];
    expect(steps).toHaveLength(5);
    expect(steps[0]?.name).toContain('run Bloc création ›');
    expect(loaded.config.flows[0]?.testData?.values['item.title']).toMatchObject({
      strategy: 'GENERATE_AT_REPLAY',
    });
  });

  it('inserts a block into a scenario: the data joins its set; a used block is never removed', async () => {
    const updated = await client.scenarios.insert(project.id, 'Chercher un élément', {
      block: 'Bloc création',
      at: 'start',
    });
    expect(updated.uses).toEqual(['Bloc création']);
    const search = parseYaml(await readFile(path.join(flows, 'search', 'search.flow.yaml'), 'utf8')) as {
      testData?: string;
      steps: unknown[];
    };
    expect(search.steps[0]).toEqual({ run: 'Bloc création' });
    expect(search.testData).toBe('chercher-un-element.test-data.yaml');
    expect(await readFile(path.join(flows, 'search', search.testData ?? ''), 'utf8')).toContain('title');
    const block = (await client.library.list(project.id)).find((entry) => entry.name === 'Bloc création');
    expect(block?.usedBy.sort()).toEqual(['Chercher un élément', 'Créer puis chercher']);
    await expect(client.library.remove(project.id, 'Bloc création')).rejects.toMatchObject({ status: 409 });
    await expect(
      client.scenarios.insert(project.id, 'Chercher un élément', { block: 'Chercher un élément', at: 'end' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a data conflict, never overwrites; a block is never run alone; an unused block is removed', async () => {
    await writeFile(
      path.join(flows, 'search', 'chercher-un-element.test-data.yaml'),
      'values:\n  item:\n    title: { strategy: literal, value: Fixe }\n',
    );
    await expect(
      client.scenarios.insert(project.id, 'Chercher un élément', { block: 'Bloc création', at: 'end' }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('item.title') as string });
    await expect(client.executions.start(project.id, { scenarios: ['Bloc création'] })).rejects.toMatchObject(
      { status: 422, code: 'REUSABLE_BLOCK' },
    );
    const spare = await client.library.add(project.id, {
      from: 'scenario',
      scenario: 'Créer un élément',
      name: 'Bloc libre',
    });
    expect((await client.library.remove(project.id, spare.name)).removed).toBe('Bloc libre');
    expect((await client.library.list(project.id)).map((entry) => entry.name).sort()).toEqual([
      'Bloc création',
      'Bloc recherche',
    ]);
  });
});
