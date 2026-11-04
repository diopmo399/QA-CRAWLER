import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LA FENÊTRE « AJOUTER UN BLOC », CÔTÉ SERVEUR : la vérification sans rien écrire (source, étapes, nom
 * libre, contrat déduit ou déclaré) et la création avec un contrat déclaré, refusée si ce contrat ne tient
 * pas sur les étapes (rien n'est alors écrit).
 */

let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? `${String(error.status)} ${error.message}` : String(error);
  }
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-wizard-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Assistant', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  const flows = await flowsDirOf(path.join(workspace, project.id));
  await mkdir(path.join(flows, 'create'), { recursive: true });
  await writeFile(
    path.join(flows, 'create', 'create.flow.yaml'),
    'name: Créer un élément\nstartAt: /items\ntestData: test-data.yaml\nsteps:\n  - click: { role: button, name: Nouveau }\n  - fill: { label: Code, value: { testData: item.code } }\n  - fill: { label: Client, value: "${testData:client.nom}" }\n',
  );
  await writeFile(
    path.join(flows, 'create', 'test-data.yaml'),
    'values:\n  item:\n    code: { strategy: generated, generator: unique }\n',
  );
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK — « Ajouter un bloc »', () => {
  it('vérifie sans rien écrire : étapes, nom libre, contrat déduit ou déclaré', async () => {
    const ok = await client.library.check(project.id, {
      scenario: 'Créer un élément',
      name: 'Élément (bloc)',
    });
    expect(ok).toMatchObject({ ok: true, steps: 3, version: 1, errors: [] });
    expect(ok.contract).toMatchObject({
      source: 'DERIVED',
      inputs: [{ key: 'client.nom', required: true }],
      outputs: [{ key: 'item.code', dynamic: true }],
    });
    // Le nom : déjà pris par le scénario lui-même.
    const taken = await client.library.check(project.id, {
      scenario: 'Créer un élément',
      name: 'Créer un élément',
    });
    expect(taken.ok).toBe(false);
    expect(taken.errors[0]).toMatch(/already named "Créer un élément"/);
    // Un contrat déclaré qui contredit les étapes : refusé avec la raison.
    const wrong = await client.library.check(project.id, {
      scenario: 'Créer un élément',
      name: 'Élément (bloc)',
      contract: { inputs: [], outputs: ['autre.cle'], preconditions: [], postconditions: [] },
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.errors.join(' ')).toMatch(/uses client\.nom without declaring it as an input/);
    expect(wrong.errors.join(' ')).toMatch(/declares the output autre\.cle but does not type it/);
    expect(await client.library.list(project.id)).toHaveLength(0);
    // Une source inconnue.
    const unknown = await client.library.check(project.id, { scenario: 'Inconnu', name: 'X' });
    expect(unknown).toMatchObject({ ok: false });
  });

  it('crée le bloc avec son contrat déclaré ; un contrat qui ne tient pas ne crée rien', async () => {
    expect(
      await refusal(
        client.library.add(project.id, {
          from: 'scenario',
          scenario: 'Créer un élément',
          name: 'Élément (bloc)',
          contract: { inputs: [], outputs: ['autre.cle'], preconditions: [], postconditions: [] },
        }),
      ),
    ).toMatch(/^422 the declared contract does not hold/);
    expect(await client.library.list(project.id)).toHaveLength(0);
    const block = await client.library.add(project.id, {
      from: 'scenario',
      scenario: 'Créer un élément',
      name: 'Élément (bloc)',
      description: 'Crée un élément',
      contract: {
        inputs: [{ key: 'client.nom', required: false }],
        outputs: ['item.code'],
        preconditions: [],
        postconditions: [],
      },
    });
    expect(block).toMatchObject({
      name: 'Élément (bloc)',
      version: 1,
      state: 'VALID',
      contract: {
        source: 'DECLARED',
        inputs: [{ key: 'client.nom', required: false }],
        outputs: [{ key: 'item.code' }],
      },
    });
    // Une seconde création du même nom est refusée (rien n'est écrasé).
    expect(
      await refusal(
        client.library.add(project.id, {
          from: 'scenario',
          scenario: 'Créer un élément',
          name: 'Élément (bloc)',
        }),
      ),
    ).toMatch(/^409/);
  });
});
