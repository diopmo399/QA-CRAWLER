import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Environment,
  type ExecutionDetail,
  type ExplorationSnapshot,
  type Journey,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startLoopApp, type LoopApp } from '../fixtures/loop-app.js';
import { keepTraceValues } from '../fixtures/trace-values.js';

/**
 * LE SCÉNARIO D'ACCEPTATION, RÉELLEMENT (moteur Playwright, application de test) :
 *   1. générer un nom de société ; créer la société ; attendre la confirmation ;
 *   2. capturer son identifiant (sortie ajoutée au bloc par « Ajouter une sortie », version validée) ;
 *   3. exposer nom et identifiant comme sorties ; créer un dossier qui les réutilise ;
 *   4. FOR_EACH sur trois personnes : ajouter chacune au dossier ;
 *   5. vérifier le statut final ; montrer la traçabilité des données et des itérations.
 * Puis : l'aperçu statique (rien d'exécuté, aucune valeur inventée), le refus d'une simulation hors
 * environnement isolé, la persistance du parcours avec sa boucle, et la création du scénario.
 */
let app: LoopApp;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;
let preproduction: Environment;

const BLOCKS: Record<string, { flow: string; data?: string }> = {
  'create-company': {
    flow: `name: Create company
startAt: /
reusable: true
testData: test-data.yaml
steps:
  - goto: /
  - click: { role: button, name: New company }
    allow: MUTATION
  - fill: { label: Company name, value: { testData: company.name } }
  - click: { role: button, name: Create company }
    allow: MUTATION
  - name: Wait for the creation confirmation
    expect: { text: Company created }
    timeoutMs: 5000
`,
    data: `values:
  company:
    name: { strategy: generated, generator: company }
`,
  },
  'create-request': {
    flow: `name: Create request
reusable: true
steps:
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Request title, value: "Onboarding \${testData:company.id}" }
  - fill: { label: Company, value: "\${testData:company.name}" }
  - click: { role: button, name: Create request }
    allow: MUTATION
  - expect: { text: Status DRAFT }
`,
  },
  'add-person': {
    flow: `name: Add person
reusable: true
steps:
  - fill: { label: First name, value: "\${testData:person.firstName}" }
  - fill: { label: Last name, value: "\${testData:person.lastName}" }
  - fill: { label: Email, value: "\${testData:person.email}" }
  - click: { role: button, name: Add person }
    allow: MUTATION
  - name: Wait for the person row
    expect: { text: "\${testData:person.firstName} \${testData:person.lastName}" }
    timeoutMs: 5000
`,
  },
  'check-status': {
    flow: `name: Check request status
reusable: true
steps:
  - expect: { text: Status COMPLETE }
  - expect: { text: "\${testData:company.name}" }
`,
  },
};

const PERSONS = [
  { firstName: 'Ada', lastName: 'Byron', email: 'ada@example.test' },
  { firstName: 'Alan', lastName: 'Turing', email: 'alan@example.test' },
  { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test' },
];

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

async function journey(): Promise<Journey> {
  const blocks = await client.library.list(project.id);
  const version = (name: string): number => {
    const found = blocks.find((block) => block.name === name);
    if (!found) throw new Error(`no block ${name}`);
    return found.version;
  };
  return {
    name: 'Request with three persons',
    mode: 'LINEAR',
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
        {
          id: 'n4',
          kind: 'BLOCK',
          block: 'Create request',
          version: version('Create request'),
          x: 0,
          y: 200,
        },
        {
          id: 'n5',
          kind: 'LOOP',
          label: 'Add each person',
          loop: {
            type: 'FOR_EACH',
            items: PERSONS,
            as: 'person',
            maxIterations: 3,
            timeoutS: 120,
            onFailure: 'STOP',
            body: [{ id: 'n5i1', kind: 'BLOCK', block: 'Add person', version: version('Add person') }],
          },
          x: 0,
          y: 300,
        },
        {
          id: 'n6',
          kind: 'BLOCK',
          block: 'Check request status',
          version: version('Check request status'),
          x: 0,
          y: 400,
        },
        { id: 'n2', kind: 'END', x: 0, y: 500 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n3' },
        { id: 'e2', from: 'n3', to: 'n4' },
        { id: 'e3', from: 'n4', to: 'n5' },
        { id: 'e4', from: 'n5', to: 'n6' },
        { id: 'e5', from: 'n6', to: 'n2' },
      ],
    },
  };
}

beforeAll(async () => {
  app = await startLoopApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-acceptance-loops-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'other' },
  });
  // Les valeurs de la trace des données sont vérifiées ici : le projet les garde (défaut : non).
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
  preproduction = await client.environments.create(project.id, {
    name: 'Preproduction',
    kind: 'PREPRODUCTION',
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

describe('acceptance — generated and captured outputs, a FOR_EACH loop, a real simulation run', () => {
  it('adds the company id as an output (a capture step), validated as a new version', async () => {
    const before = (await client.library.list(project.id)).find((block) => block.name === 'Create company');
    expect(before?.contract.outputs.map((output) => output.key)).toEqual(['company.name']);
    const changed = await client.library.addOutput(project.id, 'Create company', {
      key: 'company.id',
      label: 'Company id',
      meaning: 'identifier of the created company',
      type: 'identifier',
      source: 'DOM_TEXT',
      selector: '#company-id',
    });
    expect(changed.state).toBe('CHANGED');
    const validated = await client.library.validateVersion(project.id, 'Create company');
    expect(validated.version).toBe(before ? before.version + 1 : 2);
    const fields = validated.contract.fields?.outputs ?? [];
    expect(fields.map((field) => [field.key, field.origin, field.detection]).sort()).toEqual([
      ['company.id', 'CAPTURED', 'CONFIRMED'],
      ['company.name', 'GENERATED', 'CONFIRMED'],
    ]);
    expect(fields.find((field) => field.key === 'company.id')).toMatchObject({
      label: 'Company id',
      type: 'identifier',
      typeSource: 'DECLARED',
    });
    // Une sortie sans source exécutable est refusée ; une clé déjà connue n'est jamais réécrite.
    await expect(
      client.library.addOutput(project.id, 'Create company', { key: 'company.code', source: 'URL' }),
    ).rejects.toThrow(/a parameter name, or a pattern/);
    await expect(
      client.library.addOutput(project.id, 'Create company', {
        key: 'company.name',
        source: 'GENERATED',
        generator: 'company',
      }),
    ).rejects.toThrow(/already exists/);
  }, 60_000);

  it('checks the journey: loop variables feed the body, the request reads the company outputs', async () => {
    const check = await client.journeys.check(project.id, await journey());
    const errors = [...check.errors, ...Object.values(check.nodes).flatMap((diag) => diag.errors)];
    expect(errors).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.nodes.n4?.satisfied.map((item) => [item.key, item.from]).sort()).toEqual([
      ['company.id', 'n3'],
      ['company.name', 'n3'],
    ]);
    expect(check.nodes.n5i1?.satisfied.map((item) => item.key).sort()).toEqual([
      'person.email',
      'person.firstName',
      'person.lastName',
    ]);
  }, 60_000);

  it('previews statically: iterations and values known in advance, generated and captured ones only at run', async () => {
    const preview = await client.journeys.preview(project.id, await journey());
    expect(preview).toMatchObject({ ok: true, staticOnly: true });
    const steps = preview.paths[0]?.steps ?? [];
    expect(steps.map((step) => [step.kind, step.label, step.depth])).toEqual([
      ['BLOCK', 'Create company', 0],
      ['BLOCK', 'Create request', 0],
      ['LOOP', 'Add each person', 0],
      ['BLOCK', 'Add person', 1],
      ['BLOCK', 'Check request status', 0],
    ]);
    const request = steps[1];
    expect(
      request?.inputs.map((input) => [input.key, input.source, input.from, input.status]).sort(),
    ).toEqual([
      ['company.id', 'UPSTREAM', 'n3', 'AT_RUN'],
      ['company.name', 'UPSTREAM', 'n3', 'AT_RUN'],
    ]);
    // Jamais une valeur inventée pour une donnée générée ou capturée.
    expect(
      steps[0]?.outputs.every((output) => output.status === 'AT_RUN' && output.value === undefined),
    ).toBe(true);
    expect(steps[2]?.loop).toMatchObject({ type: 'FOR_EACH', iterations: 3, maxIterations: 3 });
    expect(steps[2]?.loop?.variables.find((variable) => variable.key === 'person.lastName')?.values).toEqual([
      'Byron',
      'Turing',
      'Hopper',
    ]);
    expect(steps[3]?.inputs.every((input) => input.source === 'LOOP' && input.status === 'KNOWN')).toBe(true);
  }, 60_000);

  it('refuses a simulation run outside an isolated environment', async () => {
    await expect(
      client.journeys.simulate(project.id, await journey(), { environmentId: preproduction.id }),
    ).rejects.toThrow(/only in a development or test environment/);
    expect(app.companies()).toEqual([]);
  }, 60_000);

  it('runs the simulation for real: one company, one request reusing its name and id, three persons, COMPLETE', async () => {
    const started = await client.journeys.simulate(project.id, await journey(), {
      environmentId: environment.id,
    });
    expect(started.simulation).toMatchObject({ journey: 'Request with three persons', path: 0 });
    expect((await finished(started)).status).toBe('COMPLETED');
    const detail: ExecutionDetail = await client.executions.get(project.id, started.run);
    expect(detail.simulation).toEqual({ journey: 'Request with three persons', path: 0 });
    const flow = detail.flowsDetail[0];
    const failed = (flow?.steps ?? []).filter((step) => step.status !== 'PASSED');
    expect(failed.map((step) => `${step.label}: ${step.reason ?? ''}`)).toEqual([]);
    expect(detail.verdict).toBe('PASSED');

    // L'application a réellement reçu les données.
    const [company] = app.companies();
    const [request] = app.requests();
    expect(app.companies()).toHaveLength(1);
    expect(request).toMatchObject({
      company: company?.name,
      title: `Onboarding ${company?.id ?? ''}`,
      status: 'COMPLETE',
    });
    expect(
      request?.persons.map((person) => `${person.firstName} ${person.lastName} ${person.email}`),
    ).toEqual(PERSONS.map((person) => `${person.firstName} ${person.lastName} ${person.email}`));

    // Les itérations réelles.
    const loop = flow?.steps.find((step) => step.kind === 'loop')?.loop;
    expect(loop).toMatchObject({ id: 'n5', type: 'FOR_EACH', planned: 3, stop: 'COMPLETED' });
    expect(loop?.iterations.map((iteration) => [iteration.iteration, iteration.status])).toEqual([
      [1, 'PASSED'],
      [2, 'PASSED'],
      [3, 'PASSED'],
    ]);
    expect(loop?.iterations[1]?.variables).toContainEqual({ key: 'person.firstName', value: 'Alan' });

    // La traçabilité : le nom généré et l'identifiant capturé par « Create company », lus par « Create request ».
    const trace = flow?.dataTrace ?? [];
    const generated = trace.find((entry) => entry.key === 'company.name' && entry.origin === 'GENERATED');
    expect(generated).toMatchObject({ value: company?.name, block: 'Create company' });
    const captured = trace.find((entry) => entry.key === 'company.id' && entry.origin === 'CAPTURED');
    expect(captured).toMatchObject({ value: company?.id, block: 'Create company' });
    expect(
      trace
        .filter((entry) => entry.origin === 'USED' && entry.block === 'Create request')
        .map((entry) => entry.key),
    ).toEqual(expect.arrayContaining(['company.id', 'company.name']));
    const iterations = trace.filter(
      (entry) => entry.key === 'person.lastName' && entry.origin === 'ITERATION',
    );
    expect(iterations.map((entry) => [entry.value, entry.loops?.[0]?.iteration])).toEqual([
      ['Byron', 1],
      ['Turing', 2],
      ['Hopper', 3],
    ]);
    // Lu deux fois par itération (saisie, puis attente de la ligne), toujours par « Add person ».
    const reads = trace.filter((entry) => entry.key === 'person.lastName' && entry.origin === 'USED');
    expect(reads.map((entry) => [entry.block, entry.loops?.[0]?.iteration])).toEqual([
      ['Add person', 1],
      ['Add person', 1],
      ['Add person', 2],
      ['Add person', 2],
      ['Add person', 3],
      ['Add person', 3],
    ]);
  }, 240_000);

  it('saves the journey with its loop, reopens it intact, and creates a scenario that keeps the loop', async () => {
    const saved = await client.journeys.save(project.id, await journey());
    const reopened = await client.journeys.open(project.id, saved.name);
    expect(reopened.graph.nodes.find((node) => node.kind === 'LOOP')?.loop).toMatchObject({
      type: 'FOR_EACH',
      as: 'person',
      maxIterations: 3,
      body: [{ id: 'n5i1', kind: 'BLOCK', block: 'Add person' }],
    });
    const { scenarios } = await client.journeys.publish(project.id, saved.name);
    expect(scenarios).toEqual(['Request with three persons']);
    app.reset();
    const started = await client.executions.start(project.id, {
      environmentId: environment.id,
      scenarios,
    });
    expect((await finished(started)).status).toBe('COMPLETED');
    const detail = await client.executions.get(project.id, started.run ?? '');
    expect(detail.verdict).toBe('PASSED');
    expect(app.requests()[0]?.status).toBe('COMPLETE');
    expect(detail.flowsDetail[0]?.steps.find((step) => step.kind === 'loop')?.loop?.iterations).toHaveLength(
      3,
    );
  }, 240_000);
});
