import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Environment,
  type ExplorationSnapshot,
  type Journey,
  type JourneyTraceability,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startLoopApp, type LoopApp } from '../fixtures/loop-app.js';
import { keepTraceValues } from '../fixtures/trace-values.js';

/**
 * LA TRAÇABILITÉ DES DONNÉES ENTRE BLOCS, sur des exécutions RÉELLES (moteur, application de test) :
 * Créer une société (nom généré, identifiant capturé) → attente de confirmation → Créer un dossier
 * (lit le nom et l'identifiant, capture l'identifiant du dossier depuis la réponse HTTP) → pour chaque
 * personne : Ajouter une personne → Vérifier le statut (relit le nom). Puis : deux exécutions
 * indépendantes, le rechargement par un autre serveur, l'absence d'exécution, une entrée sans producteur,
 * une collision, une version ancienne, et les branches.
 */
let app: LoopApp;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;

const BLOCKS: Record<string, { flow: string; data?: string }> = {
  'create-company': {
    flow: `name: Create company\nstartAt: /\nreusable: true\ntestData: test-data.yaml\nsteps:\n  - goto: /\n  - click: { role: button, name: New company }\n    allow: MUTATION\n  - fill: { label: Company name, value: { testData: company.name } }\n  - click: { role: button, name: Create company }\n    allow: MUTATION\n  - expect: { text: Company created }\n    timeoutMs: 5000\n  - capture: { as: company.id, text: { css: "#company-id" } }\n`,
    data: 'values:\n  company:\n    name: { strategy: generated, generator: company }\n',
  },
  'create-request': {
    flow: `name: Create request\nreusable: true\nsteps:\n  - click: { role: button, name: New request }\n    allow: MUTATION\n  - fill: { label: Request title, value: "Onboarding \${testData:company.id}" }\n  - fill: { label: Company, value: "\${testData:company.name}" }\n  - click: { role: button, name: Create request }\n    allow: MUTATION\n  - capture: { as: request.id, response: { method: POST, url: /api/requests, field: id } }\n  - expect: { text: Status DRAFT }\n`,
  },
  'add-person': {
    flow: `name: Add person\nreusable: true\nsteps:\n  - fill: { label: First name, value: "\${testData:person.firstName}" }\n  - fill: { label: Last name, value: "\${testData:person.lastName}" }\n  - fill: { label: Email, value: "\${testData:person.email}" }\n  - click: { role: button, name: Add person }\n    allow: MUTATION\n  - expect: { text: "\${testData:person.firstName} \${testData:person.lastName}" }\n    timeoutMs: 5000\n`,
  },
  'check-status': {
    flow: `name: Check request status\nreusable: true\nsteps:\n  - expect: { text: Status COMPLETE }\n  - expect: { text: "\${testData:company.name}" }\n  - expect: { text: "Request \${testData:request.id}" }\n`,
  },
  'other-company': {
    flow: `name: Name another company\nreusable: true\ntestData: test-data.yaml\nsteps:\n  - fill: { label: Company name, value: { testData: company.name } }\n`,
    data: 'values:\n  company:\n    name: { strategy: literal, value: Fixed Name }\n',
  },
};

async function finished(started: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the run did not finish in time'));
    }, 150_000);
    const subscription = client.explorations.subscribe(started.id, (event) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timer);
        subscription.close();
        resolve();
      }
    });
  });
  return client.explorations.status(started.id);
}

async function journey(name = 'Request traceability'): Promise<Journey> {
  const blocks = await client.library.list(project.id);
  const version = (block: string): number => blocks.find((entry) => entry.name === block)?.version ?? 1;
  const block = (id: string, name: string, y: number) => ({
    id,
    kind: 'BLOCK' as const,
    block: name,
    version: version(name),
    x: 0,
    y,
  });
  return {
    name,
    mode: 'LINEAR',
    graph: {
      nodes: [
        { id: 'n1', kind: 'START', x: 0, y: 0 },
        block('n3', 'Create company', 100),
        {
          id: 'n4',
          kind: 'WAIT',
          wait: { type: 'TEXT', text: 'Company created', timeoutS: 10, onTimeout: 'FAIL' },
          x: 0,
          y: 200,
        },
        block('n5', 'Create request', 300),
        {
          id: 'n6',
          kind: 'LOOP',
          loop: {
            type: 'FOR_EACH',
            as: 'person',
            items: [
              { firstName: 'Ada', lastName: 'Byron', email: 'ada@example.test' },
              { firstName: 'Alan', lastName: 'Turing', email: 'alan@example.test' },
              { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test' },
            ],
            maxIterations: 3,
            timeoutS: 120,
            onFailure: 'STOP',
            body: [{ id: 'n6i1', kind: 'BLOCK', block: 'Add person', version: version('Add person') }],
          },
          x: 0,
          y: 400,
        },
        block('n7', 'Check request status', 500),
        { id: 'n2', kind: 'END', x: 0, y: 600 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n3' },
        { id: 'e2', from: 'n3', to: 'n4' },
        { id: 'e3', from: 'n4', to: 'n5' },
        { id: 'e4', from: 'n5', to: 'n6' },
        { id: 'e5', from: 'n6', to: 'n7' },
        { id: 'e6', from: 'n7', to: 'n2' },
      ],
    },
  };
}

async function simulate(): Promise<string> {
  app.reset();
  const started = await client.journeys.simulate(project.id, await journey(), {
    environmentId: environment.id,
  });
  expect((await finished(started)).status).toBe('COMPLETED');
  const detail = await client.executions.get(project.id, started.run);
  expect(detail.verdict).toBe('PASSED');
  return started.run;
}

const variableOf = (trace: JourneyTraceability, key: string) => {
  const found = trace.variables.find((entry) => entry.key === key);
  if (!found) throw new Error(`no variable ${key}: ${trace.variables.map((entry) => entry.key).join(', ')}`);
  return found;
};

beforeAll(async () => {
  app = await startLoopApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-traceability-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'other' },
  });
  // Les valeurs sont comparées ici : le projet les garde (le défaut est vérifié plus bas).
  await keepTraceValues(path.join(workspace, project.id));
  const flows = await flowsDirOf(path.join(workspace, project.id));
  for (const [folder, block] of Object.entries(BLOCKS)) {
    await mkdir(path.join(flows, folder), { recursive: true });
    await writeFile(path.join(flows, folder, `${folder}.flow.yaml`), block.flow);
    if (block.data) await writeFile(path.join(flows, folder, 'test-data.yaml'), block.data);
  }
  environment = await client.environments.create(project.id, {
    name: 'Test',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 20 },
  });
}, 120_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('data traceability between blocks (real runs)', () => {
  it('before any run: definitions and correspondences only, nothing observed nor confirmed', async () => {
    const trace = await client.journeys.traceability(project.id, await journey());
    expect(trace.state).toBe('NO_EXECUTION');
    expect(trace.events).toEqual([]);
    expect(trace.variables.every((entry) => entry.status !== 'CONFIRMED')).toBe(true);
    const name = variableOf(trace, 'company.name');
    expect(name).toMatchObject({ origin: 'GENERATED', status: 'NO_EXECUTION' });
    expect(name.producers.map((entry) => [entry.node, entry.block])).toEqual([['n3', 'Create company']]);
    expect(name.consumers.map((entry) => [entry.node, entry.block]).sort()).toEqual([
      ['n5', 'Create request'],
      ['n7', 'Check request status'],
    ]);
    expect(variableOf(trace, 'company.id')).toMatchObject({ origin: 'CAPTURED' });
    expect(variableOf(trace, 'person.lastName')).toMatchObject({ origin: 'ITERATION' });
    expect(
      trace.correspondences
        .filter((entry) => entry.to === 'n5')
        .map((entry) => [entry.from, entry.fromKey, entry.kind])
        .sort(),
    ).toEqual([
      ['n3', 'company.id', 'AUTOMATIC'],
      ['n3', 'company.name', 'AUTOMATIC'],
    ]);
    expect(trace.flow.nodes.map((node) => [node.id, node.kind])).toEqual([
      ['n1', 'START'],
      ['n3', 'BLOCK'],
      ['n4', 'WAIT'],
      ['n5', 'BLOCK'],
      ['n6', 'LOOP'],
      ['n6i1', 'BLOCK'],
      ['n7', 'BLOCK'],
      ['n2', 'END'],
    ]);
    // Les liens de données sont distincts des liens de contrôle.
    expect(
      trace.flow.edges.find((edge) => edge.from === 'n3' && edge.to === 'n5' && edge.data)?.data?.sort(),
    ).toEqual(['company.id', 'company.name']);
  }, 60_000);

  it('after a real run: company.name generated once, then used with the SAME value by each consumer step', async () => {
    const run = await simulate();
    const trace = await client.journeys.traceability(project.id, await journey());
    expect(trace).toMatchObject({ state: 'OK', run: { run, simulation: true } });
    const [company] = app.companies();
    const name = variableOf(trace, 'company.name');
    expect(name.status).toBe('CONFIRMED');
    expect(name.observed?.occurrences).toEqual([{ valueId: 'company.name@1', value: company?.name }]);
    const events = trace.events.filter((event) => event.key === 'company.name');
    const generation = events.find((event) => event.origin === 'GENERATED');
    expect(generation).toMatchObject({ node: 'n3', block: 'Create company', value: company?.name });
    const uses = events.filter((event) => event.origin === 'USED');
    expect(uses.map((event) => [event.node, event.use, event.value, event.source, event.valueId])).toEqual([
      ['n3', 'ASSIGN', company?.name, generation?.id, 'company.name@1'],
      ['n5', 'ASSIGN', company?.name, generation?.id, 'company.name@1'],
      ['n7', 'VALIDATE', company?.name, generation?.id, 'company.name@1'],
    ]);
    // Les bonnes références d'étapes (positions dans le scénario et nom « Bloc › étape »).
    expect(uses.map((event) => event.stepName?.split(' › ')[0])).toEqual([
      'run Create company',
      'run Create request',
      'run Check request status',
    ]);
    expect(uses.every((event) => typeof event.step === 'number')).toBe(true);
    // L'identifiant capturé à l'écran, puis l'identifiant du dossier lu dans la réponse HTTP observée.
    expect(variableOf(trace, 'company.id')).toMatchObject({ status: 'CONFIRMED' });
    const requestId = variableOf(trace, 'request.id');
    expect(requestId.status).toBe('CONFIRMED');
    expect(requestId.observed?.occurrences[0]?.value).toBe(app.requests()[0]?.id);
    // Les itérations : une occurrence par personne, lue dans la même itération.
    const lastName = variableOf(trace, 'person.lastName');
    expect(lastName.status).toBe('CONFIRMED');
    expect(lastName.observed?.occurrences.map((entry) => entry.value)).toEqual(['Byron', 'Turing', 'Hopper']);
    const iteration2 = trace.events.filter(
      (event) => event.key === 'person.lastName' && event.loops?.[0]?.iteration === 2,
    );
    expect(new Set(iteration2.map((event) => event.valueId))).toEqual(new Set(['person.lastName@2']));
  }, 240_000);

  it('two independent runs keep their own values; the trace of each run is selectable', async () => {
    const before = await client.journeys.traceability(project.id, await journey());
    const first = before.run?.run ?? '';
    const firstName = variableOf(before, 'company.name').observed?.occurrences[0]?.value;
    const second = await simulate();
    const after = await client.journeys.traceability(project.id, await journey());
    expect(after.runs.map((entry) => entry.run).slice(0, 2)).toEqual([second, first]);
    const secondName = variableOf(after, 'company.name').observed?.occurrences[0]?.value;
    expect(secondName).toBe(app.companies()[0]?.name);
    expect(secondName).not.toBe(firstName);
    const old = await client.journeys.traceability(project.id, await journey(), { run: first });
    expect(variableOf(old, 'company.name').observed?.occurrences[0]?.value).toBe(firstName);
  }, 240_000);

  it('reloads the same traces from disk with another server (persistence)', async () => {
    const live = await client.journeys.traceability(project.id, await journey());
    const other = await startSdkServer({ workspace, language: 'fr' });
    const otherClient = createQaCrawler({ endpoint: `${other.url}/api`, token: other.token });
    try {
      const reloaded = await otherClient.journeys.traceability(project.id, await journey());
      expect(reloaded.run).toEqual(live.run);
      expect(reloaded.events).toEqual(live.events);
    } finally {
      otherClient.dispose();
      await other.close();
    }
  }, 60_000);

  it('by default the values are not kept: every link is still traced and confirmed by its occurrence', async () => {
    await keepTraceValues(path.join(workspace, project.id), false);
    try {
      const run = await simulate();
      const trace = await client.journeys.traceability(project.id, await journey());
      expect(trace.run?.run).toBe(run);
      const generated = app.companies()[0]?.name ?? '@@';
      expect(JSON.stringify(trace)).not.toContain(generated);
      expect(JSON.stringify(await client.executions.get(project.id, run))).not.toContain(generated);
      const name = variableOf(trace, 'company.name');
      expect(name.status).toBe('CONFIRMED');
      expect(name.observed?.occurrences).toEqual([{ valueId: 'company.name@1', withheld: true }]);
      const events = trace.events.filter((event) => event.key === 'company.name');
      const generation = events.find((event) => event.origin === 'GENERATED');
      expect(generation).toMatchObject({ node: 'n3', withheld: true });
      expect(generation?.value).toBeUndefined();
      expect(
        events
          .filter((event) => event.origin === 'USED')
          .map((event) => [event.node, event.source, event.valueId, event.withheld]),
      ).toEqual([
        ['n3', generation?.id, 'company.name@1', true],
        ['n5', generation?.id, 'company.name@1', true],
        ['n7', generation?.id, 'company.name@1', true],
      ]);
    } finally {
      await keepTraceValues(path.join(workspace, project.id));
    }
  }, 240_000);

  it('says what is missing, colliding or outdated — never confirmed without a run', async () => {
    const base = await journey('Broken traceability');
    // Sans « Create company » : le nom n'a pas de producteur.
    const missing: Journey = {
      ...base,
      graph: {
        nodes: base.graph.nodes.filter((node) => node.id !== 'n3' && node.id !== 'n4'),
        edges: [
          { id: 'e1', from: 'n1', to: 'n5' },
          { id: 'e4', from: 'n5', to: 'n6' },
          { id: 'e5', from: 'n6', to: 'n7' },
          { id: 'e6', from: 'n7', to: 'n2' },
        ],
      },
    };
    const lacking = await client.journeys.traceability(project.id, missing);
    expect(variableOf(lacking, 'company.name')).toMatchObject({ status: 'MISSING' });
    expect(
      lacking.correspondences.some(
        (entry) => entry.kind === 'MISSING' && entry.to === 'n5' && entry.toKey === 'company.name',
      ),
    ).toBe(true);
    // Une collision : deux blocs définissent company.name autrement (générée / valeur fixe).
    const collision: Journey = {
      ...base,
      graph: {
        nodes: [
          ...base.graph.nodes.filter((node) => node.id !== 'n7'),
          { id: 'n8', kind: 'BLOCK', block: 'Name another company', version: 1, x: 0, y: 500 },
        ],
        edges: [
          ...base.graph.edges.filter((edge) => edge.id !== 'e5' && edge.id !== 'e6'),
          { id: 'e7', from: 'n6', to: 'n8' },
          { id: 'e8', from: 'n8', to: 'n2' },
        ],
      },
    };
    const clash = await client.journeys.traceability(project.id, collision);
    expect(variableOf(clash, 'company.name').problems.join(' ')).toMatch(/collision/);
    // Une version retenue ancienne : signalée sur les données du bloc.
    const outdated = await journey('Outdated traceability');
    const node = outdated.graph.nodes.find((entry) => entry.id === 'n5');
    if (node) node.version = 0;
    const old = await client.journeys.traceability(project.id, outdated);
    expect(variableOf(old, 'company.name').problems.join(' ')).toMatch(
      /retenu en version 0, la bibliothèque est en version 1/,
    );
    expect(old.state).toBe('NO_EXECUTION');
  }, 60_000);

  it('alternative branches: one scenario per path, each real run traced on its own path', async () => {
    const blocks = await client.library.list(project.id);
    const version = (block: string): number => blocks.find((entry) => entry.name === block)?.version ?? 1;
    const branched: Journey = {
      name: 'Branch traceability',
      mode: 'DIAGRAM',
      graph: {
        nodes: [
          { id: 'n1', kind: 'START', x: 0, y: 0 },
          {
            id: 'n3',
            kind: 'BLOCK',
            block: 'Create company',
            version: version('Create company'),
            x: 0,
            y: 100,
          },
          { id: 'n4', kind: 'CONDITION', label: 'With a request?', x: 0, y: 200 },
          {
            id: 'n5',
            kind: 'BLOCK',
            block: 'Create request',
            version: version('Create request'),
            x: -200,
            y: 300,
          },
          { id: 'n2', kind: 'END', x: -200, y: 400 },
          { id: 'n9', kind: 'END', x: 200, y: 300 },
        ],
        edges: [
          { id: 'e1', from: 'n1', to: 'n3' },
          { id: 'e2', from: 'n3', to: 'n4' },
          { id: 'e3', from: 'n4', to: 'n5', branch: 'YES' },
          { id: 'e4', from: 'n5', to: 'n2' },
          { id: 'e5', from: 'n4', to: 'n9', branch: 'NO' },
        ],
      },
    };
    await client.journeys.save(project.id, branched);
    const { scenarios } = await client.journeys.publish(project.id, branched.name, { perPath: true });
    expect(scenarios).toHaveLength(2);
    const runs: string[] = [];
    for (const scenario of scenarios) {
      app.reset();
      const started = await client.executions.start(project.id, {
        environmentId: environment.id,
        scenarios: [scenario],
      });
      expect((await finished(started)).status).toBe('COMPLETED');
      runs.push(started.run ?? '');
    }
    const trace = await client.journeys.traceability(project.id, branched);
    expect(trace.runs.map((entry) => entry.run)).toEqual([...runs].reverse());
    for (const [index, run] of runs.entries()) {
      const one = await client.journeys.traceability(project.id, branched, { run });
      expect(new Set(one.events.map((event) => event.flow))).toEqual(new Set([scenarios[index]]));
      expect(variableOf(one, 'company.name').status).toBe('CONFIRMED');
      // Sur le chemin sans dossier, company.id est capturé mais jamais lu.
      expect(variableOf(one, 'company.id').status).toBe(index === 0 ? 'CONFIRMED' : 'PRODUCED_ONLY');
    }
  }, 300_000);
});
