import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  journeyOfParts,
  type Environment,
  type ExplorationSnapshot,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * UN PARCOURS VISUEL EXÉCUTÉ PAR LE MOTEUR RÉEL, sur l'application de test : un bloc « créer une demande »
 * rejoué deux fois dans le même parcours, chaque instance avec SA valeur de titre (paramètre d'instance,
 * compilé en `run:` + `with:`). Le scénario créé par le compositeur passe, et l'application reçoit les deux
 * demandes avec les deux titres : les instances ne s'écrasent pas, le bloc source n'est pas modifié.
 */
const BLOCK = `name: Créer une demande
startAt: /
steps:
  - goto: /
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: { testData: request.title } }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { url: /requests/ }
`;

let app: QualityApp;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;

async function finished(snapshot: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  await new Promise<void>((resolve, reject) => {
    const subscription = client.explorations.subscribe(snapshot.id, (event) => {
      if (event.type === 'completed' || event.type === 'failed') {
        subscription.close();
        resolve();
      }
    });
    setTimeout(() => {
      reject(new Error('the replay did not finish in time'));
    }, 120_000);
  });
  return client.explorations.status(snapshot.id);
}

beforeAll(async () => {
  app = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-journeys-run-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: `${app.url}/`, framework: 'other' },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows', 'create-request');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'create-request.flow.yaml'), BLOCK);
  environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 5 },
  });
  await client.library.add(project.id, {
    from: 'scenario',
    scenario: 'Créer une demande',
    name: 'Bloc demande',
  });
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('parcours visuel — exécution réelle', () => {
  it('deux instances du même bloc, chacune sa valeur : le scénario créé passe et l’application reçoit les deux titres', async () => {
    const journey = journeyOfParts('Deux demandes', [
      { block: 'Bloc demande', version: 1 },
      { block: 'Bloc demande', version: 1 },
    ]);
    const [first, second] = journey.graph.nodes.filter((node) => node.kind === 'BLOCK');
    if (!first || !second) throw new Error('two blocks expected');
    first.params = { 'request.title': { mode: 'VALUE', value: 'Titre A' } };
    second.params = { 'request.title': { mode: 'VALUE', value: 'Titre B' } };
    await client.journeys.save(project.id, journey);
    const check = await client.journeys.check(project.id, journey);
    expect(check).toMatchObject({ ok: true, linear: true, publishable: 'SINGLE' });
    expect((await client.journeys.publish(project.id, 'Deux demandes')).scenarios).toEqual(['Deux demandes']);

    const started = await client.executions.start(project.id, {
      environmentId: environment.id,
      scenarios: ['Deux demandes'],
    });
    const last = await finished(started);
    expect(last.status).toBe('COMPLETED');
    const detail = await client.executions.get(project.id, started.run ?? '');
    expect(detail).toMatchObject({ verdict: 'PASSED', scenarios: ['Deux demandes'] });
    expect(detail.flowsDetail[0]?.steps.every((step) => step.status === 'PASSED')).toBe(true);
    // L'application a reçu deux demandes, chacune avec le titre de son instance.
    expect(app.records().map((record) => record.title)).toEqual(['Titre A', 'Titre B']);
  }, 180_000);

  it('le parcours devenu bloc se rejoue dans un autre parcours : mêmes étapes, mêmes valeurs d’instance', async () => {
    const converted = await client.journeys.toBlock(project.id, 'Deux demandes', {
      block: 'Deux demandes (bloc)',
    });
    expect(converted.block).toMatchObject({
      name: 'Deux demandes (bloc)',
      origin: { journey: 'Deux demandes' },
    });
    const reuse = journeyOfParts('Réutiliser deux demandes', [{ block: 'Deux demandes (bloc)', version: 1 }]);
    await client.journeys.save(project.id, reuse);
    expect(await client.journeys.check(project.id, reuse)).toMatchObject({ ok: true, publishable: 'SINGLE' });
    await client.journeys.publish(project.id, 'Réutiliser deux demandes');

    const started = await client.executions.start(project.id, {
      environmentId: environment.id,
      scenarios: ['Réutiliser deux demandes'],
    });
    const last = await finished(started);
    expect(last.status).toBe('COMPLETED');
    const detail = await client.executions.get(project.id, started.run ?? '');
    expect(detail).toMatchObject({ verdict: 'PASSED', scenarios: ['Réutiliser deux demandes'] });
    expect(detail.flowsDetail[0]?.steps.every((step) => step.status === 'PASSED')).toBe(true);
    // Deux demandes de plus, avec les valeurs des instances du parcours d'origine.
    expect(app.records().map((record) => record.title)).toEqual(['Titre A', 'Titre B', 'Titre A', 'Titre B']);
  }, 180_000);
});
