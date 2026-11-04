import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Environment,
  type ExecutionDetail,
  type ExplorationSnapshot,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startLoopApp, type LoopApp } from '../fixtures/loop-app.js';

/**
 * LES BOUCLES, RÉELLEMENT : REPEAT, FOR_EACH (attente, génération et capture dans le corps), WHILE (arrêt
 * normal), la protection contre la boucle infinie, le délai global, la politique d'échec ; chaque itération
 * est rapportée avec ses variables, et la trace des données relie production et lecture.
 */
let app: LoopApp;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;

async function finished(started: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the replay did not finish in time'));
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

async function scenario(name: string, yaml: string): Promise<ExecutionDetail> {
  const flows = await flowsDirOf(path.join(workspace, project.id));
  const folder = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await mkdir(path.join(flows, folder), { recursive: true });
  await writeFile(path.join(flows, folder, `${folder}.flow.yaml`), `name: ${name}\nstartAt: /\n${yaml}`);
  const started = await client.executions.start(project.id, {
    environmentId: environment.id,
    scenarios: [name],
  });
  expect((await finished(started)).status).toBe('COMPLETED');
  return client.executions.get(project.id, started.run ?? '');
}

const loopOf = (detail: ExecutionDetail) => detail.flowsDetail[0]?.steps.find((step) => step.kind === 'loop');

beforeAll(async () => {
  app = await startLoopApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-loops-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Boucles', targetUrl: `${app.url}/`, framework: 'other' },
  });
  environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 40 },
  });
}, 120_000);

beforeEach(() => {
  app.reset();
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('loops in the engine (real runs)', () => {
  it('REPEAT runs its body N times, each iteration reported with its index', async () => {
    const detail = await scenario(
      'Repeat increment',
      `steps:
  - click: { role: button, name: Counter }
  - loop:
      id: clicks
      type: REPEAT
      times: 3
      steps:
        - click: { role: button, name: Increment }
          allow: MUTATION
        - expect: { text: "Count \${testData:clicks.index}" }
  - expect: { text: "Count 3" }
`,
    );
    expect(detail.verdict).toBe('PASSED');
    expect(app.counter()).toBe(3);
    const loop = loopOf(detail)?.loop;
    expect(loop).toMatchObject({ id: 'clicks', type: 'REPEAT', planned: 3, stop: 'COMPLETED' });
    expect(loop?.iterations.map((iteration) => [iteration.iteration, iteration.status])).toEqual([
      [1, 'PASSED'],
      [2, 'PASSED'],
      [3, 'PASSED'],
    ]);
    expect(loop?.iterations[1]?.variables).toEqual([{ key: 'clicks.index', value: '2' }]);
    expect(loop?.iterations[0]?.steps.map((step) => step.status)).toEqual(['PASSED', 'PASSED']);
  }, 180_000);

  it('WHILE stops normally when its condition becomes false', async () => {
    app.fillQueue(['alpha', 'beta', 'gamma', 'delta']);
    const detail = await scenario(
      'While queue',
      `steps:
  - click: { role: button, name: Queue }
  - expect: { text: alpha }
  - loop:
      id: queue
      type: WHILE
      while: { visible: { css: "li.pending-item" } }
      maxIterations: 10
      steps:
        - click: { role: button, name: Process one }
          allow: MUTATION
  - expect: { text: "Processed 4" }
`,
    );
    expect(detail.verdict).toBe('PASSED');
    const loop = loopOf(detail)?.loop;
    expect(loop).toMatchObject({ type: 'WHILE', stop: 'CONDITION_FALSE', maxIterations: 10 });
    expect(loop?.iterations).toHaveLength(4);
  }, 180_000);

  it('WHILE never runs forever: still true at maxIterations is a failure', async () => {
    const detail = await scenario(
      'While endless',
      `steps:
  - click: { role: button, name: Queue }
  - loop:
      id: endless
      type: WHILE
      while: { text: Always visible banner }
      maxIterations: 3
      steps:
        - click: { role: button, name: Process one }
          allow: MUTATION
`,
    );
    expect(detail.verdict).toBe('FAILED');
    const step = loopOf(detail);
    expect(step?.status).toBe('FAILED');
    expect(step?.loop).toMatchObject({ stop: 'MAX_ITERATIONS' });
    expect(step?.loop?.iterations).toHaveLength(3);
    expect(step?.reason).toMatch(/still true after 3 iterations \(stopped: infinite loop protection\)/);
  }, 180_000);

  it('a global timeout stops the loop; CONTINUE keeps going after a failed iteration, STOP does not', async () => {
    const timeout = await scenario(
      'Loop timeout',
      `steps:
  - click: { role: button, name: Counter }
  - loop:
      id: slow
      type: REPEAT
      times: 5
      timeoutMs: 1500
      steps:
        - click: { role: button, name: Increment }
          allow: MUTATION
        - expect: { text: Never shown }
          optional: true
`,
    );
    expect(loopOf(timeout)?.loop?.stop).toBe('TIMEOUT');
    expect(loopOf(timeout)?.status).toBe('FAILED');
    expect(loopOf(timeout)?.reason).toMatch(/exceeded its 1500 ms timeout/);
    expect(loopOf(timeout)?.loop?.iterations.length).toBeLessThan(5);

    const items = `      items: [one, two, three]
      steps:
        - expect: { text: "Count \${testData:item}" }
          timeoutMs: 800`;
    const keepGoing = await scenario(
      'Loop continue',
      `steps:
  - click: { role: button, name: Counter }
  - loop:
      id: tries
      type: FOR_EACH
      as: item
      onFailure: CONTINUE
${items}
`,
    );
    expect(loopOf(keepGoing)?.loop?.iterations).toHaveLength(3);
    expect(loopOf(keepGoing)?.reason).toMatch(/3 of 3 iteration\(s\) failed/);
    const stopAtFirst = await scenario(
      'Loop stop',
      `steps:
  - click: { role: button, name: Counter }
  - loop:
      id: tries
      type: FOR_EACH
      as: item
${items}
`,
    );
    expect(loopOf(stopAtFirst)?.loop).toMatchObject({ stop: 'FAILED', onFailure: 'STOP' });
    expect(loopOf(stopAtFirst)?.loop?.iterations).toHaveLength(1);
  }, 240_000);

  it('FOR_EACH adds three persons: wait, generation and capture in each iteration, values traced', async () => {
    const detail = await scenario(
      'Request with persons',
      `steps:
  - click: { role: button, name: New company }
    allow: MUTATION
  - capture: { as: company.name, generate: company }
  - fill: { label: Company name, value: "\${testData:company.name}" }
  - click: { role: button, name: Create company }
    allow: MUTATION
  - expect: { text: Company created }
    timeoutMs: 5000
  - capture: { as: company.id, text: { css: "#company-id" } }
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Request title, value: Onboarding }
  - fill: { label: Company, value: "\${testData:company.name}" }
  - click: { role: button, name: Create request }
    allow: MUTATION
  - expect: { text: "Status DRAFT" }
  - loop:
      id: persons
      type: FOR_EACH
      as: person
      items:
        - { firstName: Ada, lastName: Byron }
        - { firstName: Alan, lastName: Turing }
        - { firstName: Grace, lastName: Hopper }
      steps:
        - capture: { as: person.email, generate: email }
        - fill: { label: First name, value: "\${testData:person.firstName}" }
        - fill: { label: Last name, value: "\${testData:person.lastName}" }
        - fill: { label: Email, value: "\${testData:person.email}" }
        - click: { role: button, name: Add person }
          allow: MUTATION
        - capture: { as: person.id, response: { method: POST, url: /persons, field: id } }
        - expect: { text: "#\${testData:person.id}" }
          timeoutMs: 5000
  - expect: { text: "Status COMPLETE" }
`,
    );
    const failed = detail.flowsDetail[0]?.steps.filter((step) => step.status !== 'PASSED') ?? [];
    expect(failed.map((step) => `${step.label}: ${step.reason ?? ''}`)).toEqual([]);
    expect(detail.verdict).toBe('PASSED');
    const [request] = app.requests();
    expect(request?.status).toBe('COMPLETE');
    expect(request?.company).toBe(app.companies()[0]?.name);
    expect(request?.persons.map((person) => `${person.firstName} ${person.lastName}`)).toEqual([
      'Ada Byron',
      'Alan Turing',
      'Grace Hopper',
    ]);
    // Une adresse générée PAR itération (jamais la même deux fois).
    expect(new Set(request?.persons.map((person) => person.email)).size).toBe(3);
    const loop = loopOf(detail)?.loop;
    expect(loop?.iterations.map((iteration) => iteration.variables)).toEqual([
      [
        { key: 'person.index', value: '1' },
        { key: 'person.firstName', value: 'Ada' },
        { key: 'person.lastName', value: 'Byron' },
      ],
      [
        { key: 'person.index', value: '2' },
        { key: 'person.firstName', value: 'Alan' },
        { key: 'person.lastName', value: 'Turing' },
      ],
      [
        { key: 'person.index', value: '3' },
        { key: 'person.firstName', value: 'Grace' },
        { key: 'person.lastName', value: 'Hopper' },
      ],
    ]);
    const trace = detail.flowsDetail[0]?.dataTrace ?? [];
    const captured = trace.filter((entry) => entry.key === 'person.id' && entry.origin === 'CAPTURED');
    expect(captured.map((entry) => entry.value)).toEqual(request?.persons.map((person) => person.id));
    expect(captured.map((entry) => entry.loops)).toEqual([
      [{ id: 'persons', iteration: 1 }],
      [{ id: 'persons', iteration: 2 }],
      [{ id: 'persons', iteration: 3 }],
    ]);
    expect(trace.find((entry) => entry.key === 'company.name' && entry.origin === 'GENERATED')?.value).toBe(
      app.companies()[0]?.name,
    );
    expect(trace.find((entry) => entry.key === 'company.id' && entry.origin === 'CAPTURED')?.value).toBe(
      app.companies()[0]?.id,
    );
    expect(
      trace.filter((entry) => entry.key === 'company.name' && entry.origin === 'USED').length,
    ).toBeGreaterThan(0);
  }, 240_000);
});
