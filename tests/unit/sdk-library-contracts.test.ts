import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProjectConfig, loadProjectMission } from '../../src/project/project-config.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults, PROJECT_FILE } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LA BIBLIOTHÈQUE, CONTRATS ET VERSIONS, par le SDK : chaque bloc a un identifiant, une version validée,
 * un historique et sa provenance ; un parcours est vérifié avant d'être créé (dépendances, données,
 * structure) ; une insertion n'écrit rien en partie, refuse un conflit (409) et une version périmée du
 * scénario ; un bloc modifié devient une nouvelle version seulement quand on la valide, et un parcours
 * suivi n'est pas rejoué avec ce bloc tant que la nouvelle version n'est pas acceptée ; l'ancien registre
 * (origines seules) est repris.
 */
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let projectDir: string;
let flows: string;

const write = async (relative: string, text: string): Promise<void> => {
  await mkdir(path.dirname(path.join(flows, relative)), { recursive: true });
  await writeFile(path.join(flows, relative), text);
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-library-v2-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Contrats', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  projectDir = path.join(workspace, project.id);
  flows = await flowsDirOf(projectDir);
  await write(
    'create/create.flow.yaml',
    `name: Créer un élément\nstartAt: /items\ntestData: test-data.yaml\nsteps:\n  - click: { role: button, name: Nouveau }\n  - fill: { label: Titre, value: { testData: item.title } }\n  - click: { role: button, name: Enregistrer }\n`,
  );
  await write(
    'create/test-data.yaml',
    'values:\n  item:\n    title: { strategy: generated, generator: words }\n',
  );
  await write(
    'search/search.flow.yaml',
    `name: Chercher un élément\nstartAt: /items\nsteps:\n  - fill: { label: Recherche, value: "\${testData:item.title}" }\n  - expect: { text: "\${testData:item.title}" }\n`,
  );
  await write(
    'list/list.flow.yaml',
    `name: Lister\nstartAt: /items\ntestData: test-data.yaml\nsteps:\n  - expect: { text: Éléments }\n`,
  );
  await write('list/test-data.yaml', 'values:\n  item:\n    title: { strategy: literal, value: Fixe }\n');
  await client.library.add(project.id, {
    from: 'scenario',
    scenario: 'Créer un élément',
    name: 'Bloc création',
  });
  await client.library.add(project.id, {
    from: 'scenario',
    scenario: 'Chercher un élément',
    name: 'Bloc recherche',
  });
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK — library contracts, checks and versions', () => {
  it('a block carries its id, version, history, provenance and derived contract', async () => {
    const blocks = await client.library.list(project.id);
    const create = blocks.find((block) => block.name === 'Bloc création');
    expect(create).toMatchObject({
      id: 'bloc-creation',
      version: 1,
      state: 'VALID',
      problems: [],
      origin: { kind: 'scenario', name: 'Créer un élément' },
      contract: { source: 'DERIVED', inputs: [], outputs: [{ key: 'item.title', dynamic: true }] },
      data: [{ key: 'item.title', dynamic: true }],
    });
    expect(create?.history).toEqual([
      { version: 1, at: create?.createdAt, change: 'created from the scenario "Créer un élément"' },
    ]);
    expect(create?.hash).toMatch(/^[0-9a-f]{16}$/);
    const search = blocks.find((block) => block.name === 'Bloc recherche');
    expect(search?.contract.inputs).toEqual([{ key: 'item.title', required: true }]);
    // L'aperçu d'un scénario avant de l'ajouter : son contenu et son contrat, jamais la valeur d'une donnée.
    const preview = await client.library.preview(project.id, 'Lister');
    expect(preview).toMatchObject({
      scenario: 'Lister',
      steps: 1,
      data: [{ key: 'item.title', dynamic: false }],
    });
    expect(JSON.stringify(preview)).not.toContain('Fixe');
  });

  it('a journey is checked before it is created: dependency satisfied, missing input refused (422)', async () => {
    const ok = await client.scenarios.checkComposition(project.id, {
      name: 'Créer puis chercher',
      parts: ['Bloc création', 'Bloc recherche'],
    });
    expect(ok).toMatchObject({
      ok: true,
      blocks: 2,
      steps: 5,
      dependencies: [{ key: 'item.title', from: 1, to: 2 }],
    });
    const missing = await client.scenarios.checkComposition(project.id, {
      name: 'Seul',
      parts: ['Bloc recherche'],
    });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual([{ key: 'item.title', block: 'Bloc recherche', position: 1 }]);
    await expect(
      client.scenarios.compose(project.id, { name: 'Seul', parts: ['Bloc recherche'] }),
    ).rejects.toMatchObject({
      status: 422,
      details: [expect.stringContaining('needs item.title') as string],
    });
    // Refusé : rien n'est écrit.
    expect((await client.scenarios.list(project.id)).some((scenario) => scenario.name === 'Seul')).toBe(
      false,
    );
    const created = await client.scenarios.compose(project.id, {
      name: 'Créer puis chercher',
      parts: ['Bloc création', 'Bloc recherche'],
    });
    expect(created.uses).toEqual(['Bloc création', 'Bloc recherche']);
    const pinned = (await client.library.list(project.id)).find((block) => block.name === 'Bloc création');
    expect(pinned?.pinnedBy).toEqual([{ scenario: 'Créer puis chercher', version: 1, current: true }]);
    // Le moteur rejoue les blocs à la place de `run:`, dans l'ordre.
    const config = await loadProjectConfig(path.join(projectDir, PROJECT_FILE));
    const loaded = await loadProjectMission(config, { command: 'replay', flows: ['Créer puis chercher'] });
    expect(loaded.config.flows[0]?.steps.map((step) => step.name?.split(' › ')[0])).toEqual([
      'run Bloc création',
      'run Bloc création',
      'run Bloc création',
      'run Bloc recherche',
      'run Bloc recherche',
    ]);
  });

  it('insertion: identical data is shared; a conflict is refused (409) and nothing is written', async () => {
    // Fin de « Lister » : le jeu de Lister définit item.title autrement (valeur fixe) que le bloc (générée).
    const file = path.join(flows, 'list/list.flow.yaml');
    const data = path.join(flows, 'list/test-data.yaml');
    const before = [await readFile(file, 'utf8'), await readFile(data, 'utf8')];
    await expect(
      client.scenarios.insert(project.id, 'Lister', { block: 'Bloc création', at: 'end' }),
    ).rejects.toMatchObject({
      status: 409,
      details: [
        expect.stringContaining(
          'item.title: fixed value "Fixe" in "Lister", generated at replay (words) in "Bloc création"',
        ) as string,
      ],
    });
    expect([await readFile(file, 'utf8'), await readFile(data, 'utf8')]).toEqual(before);
    // Au début de « Créer un élément » (même définition, identique) : partagée, insérée.
    const view = await client.scenarios.insert(project.id, 'Créer un élément', {
      block: 'Bloc création',
      at: 'start',
    });
    expect(view.uses).toEqual(['Bloc création']);
  });

  it('insertion: a missing input is refused (422); at the end, what the scenario produces satisfies it', async () => {
    await write(
      'plain/plain.flow.yaml',
      `name: Vide\nstartAt: /items\nsteps:\n  - expect: { text: Éléments }\n`,
    );
    await expect(
      client.scenarios.insert(project.id, 'Vide', { block: 'Bloc recherche', at: 'start' }),
    ).rejects.toMatchObject({
      status: 422,
      details: [expect.stringContaining('needs item.title') as string],
    });
    const view = await client.scenarios.insert(project.id, 'Créer un élément', {
      block: 'Bloc recherche',
      at: 'end',
    });
    expect(view.uses).toEqual(['Bloc création', 'Bloc recherche']);
  });

  it('a stale revision of the scenario is refused (409); two concurrent insertions never both apply', async () => {
    await write(
      'plain2/plain2.flow.yaml',
      `name: Vide 2\nstartAt: /items\nsteps:\n  - expect: { text: Éléments }\n`,
    );
    const scenario = (await client.scenarios.list(project.id)).find((entry) => entry.name === 'Vide 2');
    expect(scenario?.revision).toMatch(/^[0-9a-f]{12}$/);
    const revision = scenario?.revision ?? '';
    const results = await Promise.allSettled([
      client.scenarios.insert(project.id, 'Vide 2', { block: 'Bloc création', at: 'start', revision }),
      client.scenarios.insert(project.id, 'Vide 2', { block: 'Bloc création', at: 'end', revision }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const text = await readFile(path.join(flows, 'plain2/plain2.flow.yaml'), 'utf8');
    expect(text.match(/run: Bloc création/g)).toHaveLength(1);
  });

  it('a block used by scenarios is never removed (409 names them); a block never runs alone (422)', async () => {
    await expect(client.library.remove(project.id, 'Bloc création')).rejects.toMatchObject({
      status: 409,
      details: expect.arrayContaining(['Créer puis chercher', 'Créer un élément']) as string[],
    });
    await expect(
      client.executions.start(project.id, { scenarios: ['Bloc recherche'] }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'REUSABLE_BLOCK',
    });
  });

  it('a modified block is a new version only once validated; a pinned journey waits for an explicit acceptance', async () => {
    const blockFile = path.join(flows, 'library/bloc-recherche/bloc-recherche.flow.yaml');
    await writeFile(blockFile, `${await readFile(blockFile, 'utf8')}  - expect: { text: "Résultat" }\n`);
    const changed = (await client.library.list(project.id)).find((block) => block.name === 'Bloc recherche');
    expect(changed).toMatchObject({ version: 1, state: 'CHANGED' });
    expect(changed?.pinnedBy).toContainEqual({ scenario: 'Créer puis chercher', version: 1, current: false });
    // Le parcours suivi n'est pas rejoué avec un bloc changé, sans décision.
    await expect(
      client.executions.start(project.id, { scenarios: ['Créer puis chercher'] }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'BLOCK_VERSION_CHANGED',
      details: ['Créer puis chercher: Bloc recherche v1 → modified, not validated'],
    });
    await expect(client.scenarios.acceptBlocks(project.id, 'Créer puis chercher')).rejects.toMatchObject({
      status: 409,
    });
    const validated = await client.library.validateVersion(project.id, 'Bloc recherche');
    expect(validated).toMatchObject({ version: 2, state: 'VALID' });
    expect(validated.history.map((entry) => entry.change)).toEqual([
      'created from the scenario "Chercher un élément"',
      'new content validated',
    ]);
    expect(await client.library.drift(project.id)).toContainEqual({
      scenario: 'Créer puis chercher',
      block: 'Bloc recherche',
      pinned: 1,
      current: 2,
      unvalidated: false,
    });
    const accepted = await client.scenarios.acceptBlocks(project.id, 'Créer puis chercher');
    expect(accepted.ok).toBe(true);
    expect(
      (await client.library.drift(project.id)).filter((entry) => entry.scenario === 'Créer puis chercher'),
    ).toEqual([]);
    await expect(client.library.validateVersion(project.id, 'Bloc recherche')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('a declared contract is checked against the content; a broken one blocks the composition', async () => {
    const broken = await client.library.declareContract(project.id, 'Bloc création', {
      inputs: [],
      outputs: ['item.id'],
      preconditions: ['la liste est ouverte'],
      postconditions: [],
    });
    expect(broken).toMatchObject({ state: 'INVALID', contract: { source: 'DECLARED' } });
    expect(broken.problems).toContain('declares the output item.id but does not type it from its own data');
    const check = await client.scenarios.checkComposition(project.id, {
      name: 'Contrat',
      parts: ['Bloc création'],
    });
    expect(check.ok).toBe(false);
    await expect(
      client.library.declareContract(project.id, 'Bloc création', {
        inputs: [{ key: 'pas une clé', required: true }],
        outputs: [],
        preconditions: [],
        postconditions: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const fixed = await client.library.declareContract(project.id, 'Bloc création', {
      inputs: [],
      outputs: ['item.title'],
      preconditions: ['la liste est ouverte'],
      postconditions: ['un élément au titre généré existe'],
    });
    expect(fixed).toMatchObject({
      state: 'VALID',
      version: 1,
      contract: { postconditions: ['un élément au titre généré existe'] },
    });
    const reset = await client.library.declareContract(project.id, 'Bloc création', null);
    expect(reset.contract.source).toBe('DERIVED');
    expect(reset.history.map((entry) => entry.change).slice(-3)).toEqual([
      'contract declared',
      'contract declared',
      'contract derived from the content again',
    ]);
  });

  it('the former registry (origins only) and hand-written blocks are taken over with explicit defaults', async () => {
    const other = await client.projects.create({
      ...engineDefaults(),
      project: { name: 'Ancien', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
    });
    const dir = path.join(workspace, other.id);
    const root = await flowsDirOf(dir);
    await mkdir(path.join(root, 'library/ancien'), { recursive: true });
    await writeFile(
      path.join(root, 'library/ancien/ancien.flow.yaml'),
      'name: Ancien bloc\nreusable: true\nstartAt: /\nsteps:\n  - expect: { text: Accueil }\n',
    );
    await writeFile(
      path.join(dir, 'sdk-library.json'),
      JSON.stringify({ origins: { 'Ancien bloc': { kind: 'scenario', name: 'Accueil' } } }),
    );
    const [block] = await client.library.list(other.id);
    expect(block).toMatchObject({
      id: 'ancien-bloc',
      version: 1,
      state: 'VALID',
      origin: { kind: 'scenario', name: 'Accueil' },
      history: [{ version: 1, change: 'taken over: no earlier record of this block' }],
    });
    await client.scenarios.compose(other.id, { name: 'Parcours ancien', parts: ['Ancien bloc'] });
    const registry = JSON.parse(await readFile(path.join(dir, 'sdk-library.json'), 'utf8')) as {
      version: number;
      blocks: Record<string, { version: number; origin?: unknown }>;
      compositions: Record<string, unknown>;
    };
    expect(registry.version).toBe(2);
    expect(registry.blocks['Ancien bloc']).toMatchObject({
      version: 1,
      origin: { kind: 'scenario', name: 'Accueil' },
    });
    expect(Object.keys(registry.compositions)).toEqual(['Parcours ancien']);
  });
});
