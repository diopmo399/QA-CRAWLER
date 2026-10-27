import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type Environment,
  type ExplorationEvent,
  type ExplorationSnapshot,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults, REPORTS_DIR } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * LA PLATEFORME AVEC LE VRAI MOTEUR. Un projet créé par le SDK, un scénario dans ses flows, deux
 * environnements qui pointent sur deux instances de l'application (recette, préproduction). Le SDK
 * lance le rejeu par le moteur (`runMission`, mission `replay`) dans l'environnement choisi, le suit
 * par le flux d'événements, puis lit le run écrit sur disque : verdict, étapes, assertions, preuves.
 * Le second rejeu, contre une instance qui enregistre un autre titre, échoue sur l'assertion métier.
 */
let recette: QualityApp;
let preprod: QualityApp;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let test: Environment;
let pre: Environment;

const FLOW = `name: create-request
startAt: /
testData: test-data.yaml
steps:
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: { testData: request.title } }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { url: /requests/ }
assertions:
  - id: title-saved
    description: The server returns the title typed in this run
    criticality: HIGH
    check: { kind: value, source: response, method: POST, path: /api/requests, field: title, expected: { testData: request.title } }
`;

async function followed(
  snapshot: ExplorationSnapshot,
): Promise<{ events: ExplorationEvent[]; last: ExplorationSnapshot }> {
  const events: ExplorationEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const subscription = client.explorations.subscribe(snapshot.id, (event) => {
      events.push(event);
      if (event.type === 'completed' || event.type === 'failed') {
        subscription.close();
        resolve();
      }
    });
    setTimeout(() => {
      reject(new Error('the replay did not finish in time'));
    }, 120_000);
  });
  return { events, last: await client.explorations.status(snapshot.id) };
}

beforeAll(async () => {
  recette = await startQualityApp();
  preprod = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-platform-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: `${recette.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows', 'create-request');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'create-request.flow.yaml'), FLOW);
  await writeFile(
    path.join(flows, 'test-data.yaml'),
    `values:\n  request:\n    title: { strategy: generated, generator: text }\n`,
  );
  const host = new URL(recette.url).hostname;
  test = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: recette.url,
    allowedDomains: [host],
    mutations: { enabled: true, maxPerRun: 5 },
  });
  pre = await client.environments.create(project.id, {
    name: 'Préproduction',
    kind: 'PREPRODUCTION',
    baseUrl: preprod.url,
    allowedDomains: [host],
    mutations: { enabled: true, maxPerRun: 5 },
  });
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await recette.close();
  await preprod.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK platform — real engine', () => {
  let passedRun = '';
  let failedRun = '';

  it('replays the scenario in the chosen environment, followed live, and reads the run back', async () => {
    expect((await client.scenarios.list(project.id)).map((scenario) => scenario.name)).toEqual([
      'create-request',
    ]);
    const started = await client.executions.start(project.id, { environmentId: test.id });
    expect(started.kind).toBe('REPLAY');
    const { events, last } = await followed(started);
    expect(last.status).toBe('COMPLETED');
    // Les événements du moteur : le flow commence, ses étapes sont jouées, il finit.
    expect(
      events.some(
        (event) => event.type === 'flow' && event.phase === 'start' && event.flow === 'create-request',
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === 'flow-step').length).toBeGreaterThanOrEqual(4);
    // Une seule instance a reçu l'écriture : celle de l'environnement choisi.
    expect(recette.records()).toHaveLength(1);
    expect(preprod.records()).toHaveLength(0);

    passedRun = started.run ?? '';
    const detail = await client.executions.get(project.id, passedRun);
    expect(detail).toMatchObject({
      kind: 'REPLAY',
      verdict: 'PASSED',
      environment: { id: test.id, name: 'Recette' },
      scenarios: ['create-request'],
      flows: { total: 1, passed: 1, failed: 0 },
    });
    const flow = detail.flowsDetail[0];
    expect(flow?.steps.map((step) => step.status)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);
    expect(flow?.assertions).toEqual([
      { id: 'title-saved', description: 'The server returns the title typed in this run', status: 'PASS' },
    ]);
    expect(flow?.testData).toContain('request.title');
    // La valeur générée pour ce run n'apparaît nulle part dans la réponse du SDK.
    expect(JSON.stringify(detail)).not.toContain(recette.records()[0]?.title ?? '@@');
    // Les preuves : les captures et le rapport sont des fichiers réels du run.
    const shot = flow?.steps.find((step) => step.screenshot)?.screenshot;
    if (shot)
      expect((await stat(path.join(workspace, project.id, REPORTS_DIR, passedRun, shot))).isFile()).toBe(
        true,
      );
    expect(detail.reports.html).toBeDefined();
  }, 150_000);

  it('fails on the business assertion against an environment that saves another title', async () => {
    preprod.bugs.wrongTitle = true;
    const started = await client.executions.start(project.id, {
      environmentId: pre.id,
      scenarios: ['create-request'],
    });
    const { last } = await followed(started);
    expect(last.status).toBe('COMPLETED');
    expect(preprod.records()).toHaveLength(1);
    failedRun = started.run ?? '';
    const detail = await client.executions.get(project.id, failedRun);
    expect(detail.verdict).toBe('FAILED');
    expect(detail.environment).toEqual({ id: pre.id, name: 'Préproduction' });
    expect(detail.flowsDetail[0]?.assertions[0]?.status).toBe('FAIL');
  }, 150_000);

  it('lists the executions, compares them, and counts them in the overview', async () => {
    const list = await client.executions.list(project.id);
    expect(list.map((execution) => [execution.run, execution.verdict])).toEqual([
      [failedRun, 'FAILED'],
      [passedRun, 'PASSED'],
    ]);
    const comparison = await client.reports.compare(project.id, passedRun, failedRun);
    expect(comparison.summary.newlyFailing).toEqual(['create-request']);
    // L'historique par scénario : les deux runs, du plus récent au plus ancien, une bascule.
    const history = await client.scenarios.history(project.id, { limit: 5 });
    expect(history).toEqual([
      expect.objectContaining({ name: 'create-request', passed: 1, failed: 1, flips: 1 }),
    ]);
    expect(history[0]?.runs.map((entry) => [entry.run, entry.status])).toEqual([
      [failedRun, 'FAILED'],
      [passedRun, 'PASSED'],
    ]);
    expect((await client.scenarios.history(project.id, { limit: 1 }))[0]?.runs).toHaveLength(1);
    const overview = await client.overview.get({ days: 1 });
    expect(overview.replays).toMatchObject({ finished: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(overview.alerts).toContainEqual(
      expect.objectContaining({ kind: 'EXECUTION_FAILED', projectId: project.id, run: failedRun }),
    );
    const summary = (await client.projects.list()).find((entry) => entry.id === project.id);
    expect(summary?.counts).toMatchObject({ environments: 2, scenarios: 1, executions: 2 });
    expect(summary?.lastExecution?.run).toBe(failedRun);
  });

  it('refuses to run an archived project, and runs again once restored', async () => {
    await client.projects.archive(project.id);
    const refused = await client.executions.start(project.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QaCrawlerError);
    expect((refused as QaCrawlerError).code).toBe('PROJECT_ARCHIVED');
    await client.projects.restore(project.id);
    expect((await client.projects.detail(project.id)).state).toBe('ACTIVE');
  });
});
