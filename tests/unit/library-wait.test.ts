import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadProjectConfig, loadProjectMission } from '../../src/project/project-config.js';
import {
  createQaCrawler,
  journeyOfParts,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults, PROJECT_FILE } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * UNE ATTENTE DANS UN BLOC ENREGISTRÉ : insérée entre deux étapes (étape `expect` avec délai), les groupes
 * métier décalés, le bloc CHANGED jusqu'à la validation explicite de sa version suivante ; un parcours qui
 * suit le bloc garde sa version tant qu'il ne l'accepte pas. Les refus disent pourquoi.
 */

let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let projectDir: string;

const ORDER = `name: Passer une commande
startAt: /orders
testData: test-data.yaml
steps:
  - click: { role: button, name: Nouvelle commande }
  - fill: { label: Référence, value: { testData: order.ref } }
  - click: { role: button, name: Envoyer }
`;
const ORDER_DATA = `values:
  order:
    ref: { strategy: generated, generator: unique }
    channel: { value: web }
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
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-wait-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Attentes', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  projectDir = path.join(workspace, project.id);
  const flows = await flowsDirOf(projectDir);
  await mkdir(path.join(flows, 'order'), { recursive: true });
  await writeFile(path.join(flows, 'order', 'order.flow.yaml'), ORDER);
  await writeFile(path.join(flows, 'order', 'test-data.yaml'), ORDER_DATA);
  await client.library.add(project.id, {
    from: 'scenario',
    scenario: 'Passer une commande',
    name: 'Commander',
  });
  // Les groupes métier du bloc (comme après une extraction composée) : informatifs, ils ne changent pas l’empreinte.
  const file = path.join(flows, 'library', 'commander', 'commander.flow.yaml');
  const content = await readFile(file, 'utf8');
  await writeFile(
    file,
    content.replace(
      'steps:',
      'groups:\n  - { id: g1, name: Saisie, steps: [1, 2] }\n  - { id: g2, name: Envoi, steps: [3] }\nsteps:',
    ),
  );
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK — attente insérée dans un bloc', () => {
  it('refuse une attente incomplète, une donnée inconnue, une donnée générée citée avant sa saisie', async () => {
    expect(
      await refusal(
        client.library.insertWait(project.id, 'Commander', {
          after: 1,
          wait: { type: 'VISIBLE', timeoutS: 30, onTimeout: 'FAIL' },
        }),
      ),
    ).toBe('422 indiquez un sélecteur CSS ou un texte visible');
    expect(
      await refusal(
        client.library.insertWait(project.id, 'Commander', {
          after: 3,
          wait: { type: 'TEXT', text: '${testData:order.total}', timeoutS: 30, onTimeout: 'FAIL' },
        }),
      ),
    ).toBe('422 la donnée order.total n’est ni dans le jeu du bloc ni saisie avant l’attente');
    expect(
      await refusal(
        client.library.insertWait(project.id, 'Commander', {
          after: 1,
          wait: { type: 'TEXT', text: 'Commande ${testData:order.ref}', timeoutS: 30, onTimeout: 'FAIL' },
        }),
      ),
    ).toBe('422 la donnée order.ref est générée au rejeu : insérez l’attente après l’étape qui la saisit');
    expect(
      await refusal(
        client.library.insertWait(project.id, 'Commander', {
          after: 9,
          wait: { type: 'URL', url: '/orders/', timeoutS: 30, onTimeout: 'FAIL' },
        }),
      ),
    ).toMatch(/^400 after is a position between 0 and 3/);
    expect(
      await refusal(
        client.library.insertWait(project.id, 'Inconnu', {
          after: 0,
          wait: { type: 'URL', url: '/x', timeoutS: 5, onTimeout: 'FAIL' },
        }),
      ),
    ).toMatch(/^404/);
    // Rien n'a été écrit.
    expect((await client.library.list(project.id))[0]).toMatchObject({
      state: 'VALID',
      version: 1,
      steps: 3,
    });
  });

  it('insère l’attente, décale les groupes, attend la validation explicite ; le parcours garde sa version', async () => {
    const journey = journeyOfParts('Commande suivie', [{ block: 'Commander', version: 1 }]);
    await client.journeys.save(project.id, journey);

    const changed = await client.library.insertWait(project.id, 'Commander', {
      after: 2,
      wait: {
        type: 'TEXT',
        text: 'Commande ${testData:order.ref} enregistrée',
        timeoutS: 20,
        onTimeout: 'WARN',
      },
    });
    expect(changed).toMatchObject({ state: 'CHANGED', version: 1, steps: 4 });
    expect(changed.history.at(-1)?.change).toMatch(
      /^wait inserted after step 2 .*validate it to make version 2/,
    );

    const file = parseYaml(
      await readFile(
        path.join(await flowsDirOf(projectDir), 'library', 'commander', 'commander.flow.yaml'),
        'utf8',
      ),
    ) as { steps: unknown[]; groups: { steps: number[] }[]; testData: string };
    expect(file.steps[2]).toEqual({
      name: 'Attente : texte « Commande ${testData:order.ref} enregistrée »',
      expect: { text: 'Commande ${testData:order.ref} enregistrée' },
      timeoutMs: 20_000,
      optional: true,
    });
    expect(file.groups.map((group) => group.steps)).toEqual([[1, 2], [4]]);
    expect(file.testData).toBe('test-data.yaml');

    // Le parcours suit la version 1 : rien ne change pour lui tant qu'il n'accepte pas la suivante.
    const before = await client.journeys.check(project.id, journey);
    const id = journey.graph.nodes.find((node) => node.kind === 'BLOCK')?.id ?? '';
    expect(before.nodes[id]?.warnings).toContain(
      'le contenu du bloc a changé depuis sa dernière version validée',
    );
    expect(
      (await client.journeys.open(project.id, 'Commande suivie')).graph.nodes.find((node) => node.id === id),
    ).toMatchObject({ version: 1 });

    const validated = await client.library.validateVersion(project.id, 'Commander');
    expect(validated).toMatchObject({ state: 'VALID', version: 2 });
    const after = await client.journeys.check(project.id, journey);
    expect(after.nodes[id]?.errors.join(' ')).toMatch(/version 1 retenue, version 2 disponible/);
  });

  it('le moteur lit le bloc modifié : l’attente est une étape expect avec son délai', async () => {
    await client.scenarios.compose(project.id, { name: 'Commande rejouée', parts: ['Commander'] });
    const config = await loadProjectConfig(path.join(projectDir, PROJECT_FILE));
    const loaded = await loadProjectMission(config, { command: 'replay', flows: ['Commande rejouée'] });
    const steps = loaded.config.flows[0]?.steps ?? [];
    expect(steps.map((step) => step.kind)).toEqual(['click', 'fill', 'expect', 'click']);
    expect(steps[2]).toMatchObject({ kind: 'expect', timeoutMs: 20_000, optional: true });
  });
});
