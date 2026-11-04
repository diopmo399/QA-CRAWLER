import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chain,
  createQaCrawler,
  journeyOfParts,
  type Journey,
  type JourneyNode,
  type WaitSpec,
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
const GENERATED = `name: Créer une demande générée
startAt: /
testData: test-data.yaml
steps:
  - goto: /
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: { testData: request.title } }
  - click: { role: button, name: Save }
    allow: MUTATION
`;
const GENERATED_DATA = `values:
  request:
    title: { strategy: generated, generator: unique }
`;

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
  const generated = path.join(workspace, project.id, 'qa-crawler', 'flows', 'create-generated');
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, 'create-generated.flow.yaml'), GENERATED);
  await writeFile(path.join(generated, 'test-data.yaml'), GENERATED_DATA);
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
  await client.library.add(project.id, {
    from: 'scenario',
    scenario: 'Créer une demande générée',
    name: 'Bloc demande générée',
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

  /** Un parcours : le bloc qui génère le titre, puis des attentes en suite. */
  const withWaits = (name: string, waits: WaitSpec[]): Journey => {
    const journey = journeyOfParts(name, [{ block: 'Bloc demande générée', version: 1 }]);
    const start = journey.graph.nodes.find((node) => node.kind === 'START') as JourneyNode;
    const end = journey.graph.nodes.find((node) => node.kind === 'END') as JourneyNode;
    const block = journey.graph.nodes.find((node) => node.kind === 'BLOCK') as JourneyNode;
    const nodes: JourneyNode[] = waits.map((wait, index) => ({
      id: `w${String(index + 1)}`,
      kind: 'WAIT',
      wait,
      x: 0,
      y: 0,
    }));
    return { ...journey, graph: chain(start, [block, ...nodes], end, [], true) };
  };

  async function runJourney(
    journey: Journey,
  ): Promise<Awaited<ReturnType<QaCrawlerClient['executions']['get']>>> {
    await client.journeys.save(project.id, journey);
    const check = await client.journeys.check(project.id, journey);
    expect(check).toMatchObject({ ok: true, linear: true, publishable: 'SINGLE' });
    expect((await client.journeys.publish(project.id, journey.name)).scenarios).toEqual([journey.name]);
    const started = await client.executions.start(project.id, {
      environmentId: environment.id,
      scenarios: [journey.name],
    });
    const last = await finished(started);
    expect(last.status).toBe('COMPLETED');
    return client.executions.get(project.id, started.run ?? '');
  }

  it('attentes réelles : réponse HTTP vue, titre généré cité sans être régénéré, élément visible, disparition, adresse ; un délai dépassé en avertissement laisse continuer', async () => {
    const before = app.records().length;
    const detail = await runJourney(
      withWaits('Créer puis attendre', [
        {
          type: 'RESPONSE',
          method: 'POST',
          url: '/api/requests',
          status: 201,
          timeoutS: 10,
          onTimeout: 'FAIL',
        },
        { type: 'TEXT', text: '${testData:request.title}', timeoutS: 10, onTimeout: 'FAIL' },
        { type: 'VISIBLE', selector: 'h1#title', timeoutS: 10, onTimeout: 'FAIL' },
        { type: 'HIDDEN', text: 'Loading…', timeoutS: 10, onTimeout: 'FAIL' },
        { type: 'URL', url: '/requests/', timeoutS: 10, onTimeout: 'FAIL' },
        { type: 'TEXT', text: 'Jamais affiché', timeoutS: 2, onTimeout: 'WARN' },
        { type: 'URL', url: '/requests/', timeoutS: 5, onTimeout: 'FAIL' },
      ]),
    );
    const steps = detail.flowsDetail[0]?.steps ?? [];
    // Le bloc (4 étapes), puis les 7 attentes, toutes exécutées : l'avertissement n'arrête rien.
    expect(steps).toHaveLength(11);
    expect(steps.slice(0, 9).every((step) => step.status === 'PASSED')).toBe(true);
    // L'attente en avertissement : son étape est en échec (raison dite), le scénario continue et passe.
    expect(steps[9]).toMatchObject({
      status: 'FAILED',
      reason: 'expectation not met: text "Jamais affiché" not visible',
    });
    expect(steps[10]?.status).toBe('PASSED');
    expect(detail.verdict).toBe('PASSED');
    // Une seule demande créée : son titre (généré) est celui que l'attente a lu sur l'écran.
    expect(app.records()).toHaveLength(before + 1);
  }, 180_000);

  it('un délai dépassé qui arrête le scénario : l’étape échoue en disant ce qui manque, la suite n’est pas jouée', async () => {
    const detail = await runJourney(
      withWaits('Attendre en vain', [
        { type: 'TEXT', text: 'Jamais affiché', timeoutS: 2, onTimeout: 'FAIL' },
        { type: 'URL', url: '/requests/', timeoutS: 5, onTimeout: 'FAIL' },
      ]),
    );
    expect(detail.verdict).toBe('FAILED');
    const steps = detail.flowsDetail[0]?.steps ?? [];
    const failed = steps.find((step) => step.status === 'FAILED');
    expect(failed?.reason ?? '').toContain('Jamais affiché');
    expect(steps.at(-1)?.status).not.toBe('PASSED');
  }, 180_000);
});
