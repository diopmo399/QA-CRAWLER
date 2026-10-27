import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioConfig } from '../../src/config/config.js';
import type { RunOptions, RunOutcome } from '../../src/orchestrator.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type EnvironmentInput,
  type ExplorationSnapshot,
  type ProjectDraft,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { computeOverview, PASS_RATE_DEFINITION } from '../../src/sdk/server/platform.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LA PLATEFORME par le client du SDK, avec un moteur SIMULÉ (tests uniquement) qui écrit un
 * result.json comme le vrai : cycle de vie des projets, environnements validés et appliqués à la
 * mission, scénarios et promotion d'un enregistrement, exécutions (rejeu) lues sur disque, vue
 * d'ensemble. Le vrai moteur est couvert par tests/integration/sdk-platform.test.ts.
 */
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
const runs: { config: ScenarioConfig; env: NodeJS.ProcessEnv }[] = [];

async function fakeRun(config: ScenarioConfig, options: RunOptions): Promise<RunOutcome> {
  runs.push({ config, env: options.env ?? {} });
  const reports = config.output.reportsDir;
  await mkdir(path.join(reports, 'screenshots'), { recursive: true });
  await writeFile(path.join(reports, 'screenshots', 'step-1.png'), 'png');
  const flows = config.flows.map((flow) => {
    const broken = flow.name.includes('broken');
    return {
      name: flow.name,
      status: broken ? 'FAILED' : 'PASSED',
      startedAt: new Date().toISOString(),
      durationMs: 40,
      states: [],
      issueIds: [],
      explored: false,
      steps: [
        {
          index: 1,
          kind: 'fill',
          // Le format du moteur (describeStep) : la valeur après « = ».
          description: 'fill label "Title" = "Company ABC"',
          status: broken ? 'FAILED' : 'PASSED',
          optional: false,
          durationMs: 10,
          ...(broken ? { reason: 'value "Company ABC" refused' } : {}),
          testData: ['item.title'],
          screenshot: path.join(reports, 'screenshots', 'step-1.png'),
        },
        {
          index: 2,
          kind: 'click',
          description: 'click "Save"',
          status: 'PASSED',
          optional: false,
          durationMs: 5,
        },
      ],
      ...(broken ? { divergence: { stepIndex: 1, description: 'fill', reason: 'NOT_FOUND' } } : {}),
      quality: {
        verdict: 'PASS',
        assertions: [{ id: 'A1', description: 'the item is created', status: broken ? 'FAIL' : 'PASS' }],
        consistency: [],
        evidence: [],
        networkObserved: true,
        durationMs: 1,
      },
    };
  });
  const result = {
    startedAt: new Date().toISOString(),
    durationMs: 120,
    stopReason: config.flows.length > 0 ? 'flows-only' : 'exhausted',
    stats: {
      states: 1,
      transitions: 0,
      actionsExecuted: 2,
      actionsBlocked: 0,
      issuesBySeverity: {
        INFO: 0,
        WARNING: 0,
        ERROR: 0,
        CRITICAL: flows.some((f) => f.status === 'FAILED') ? 1 : 0,
      },
    },
    flows,
    issues: [],
    artifacts: { json: path.join(reports, 'result.json') },
  };
  await writeFile(path.join(reports, 'result.json'), JSON.stringify(result));
  return { passed: true, failingIssues: [], regressions: 0, result } as unknown as RunOutcome;
}

const draft = (name = 'Shop', targetUrl = 'http://127.0.0.1:9/app'): ProjectDraft => ({
  ...engineDefaults(),
  project: { name, targetUrl, framework: 'vue' },
});

const environment = (extra: Partial<EnvironmentInput> = {}): EnvironmentInput => ({
  name: 'Recette',
  kind: 'TEST',
  baseUrl: 'http://127.0.0.2:9',
  allowedDomains: ['127.0.0.2'],
  variables: { QA_LOCALE: 'fr' },
  secretEnv: ['QA_PASSWORD'],
  limits: { actionTimeoutMs: 4000, maxDurationMinutes: 3, maxStates: 7, maxActions: 30 },
  ...extra,
});

async function finished(snapshot: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await client.explorations.status(snapshot.id);
    if (current.status === 'COMPLETED' || current.status === 'FAILED') return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the execution never finished');
}

async function refusal(promise: Promise<unknown>): Promise<QaCrawlerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QaCrawlerError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Un flow YAML posé dans le dossier des flows du projet (comme un utilisateur le ferait). */
async function addFlow(projectId: string, name: string): Promise<void> {
  const dir = path.join(workspace, projectId, 'qa-crawler', 'flows');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${name}.flow.yaml`),
    `name: ${name}\nsteps:\n  - goto: /\n  - click: { role: button, name: Save }\n`,
  );
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-platform-'));
  server = await startSdkServer({
    workspace,
    run: fakeRun,
    env: { QA_PASSWORD: 'secret-value' },
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK platform — project lifecycle', () => {
  it('lists, details, updates (validated by the engine), duplicates, archives and restores', async () => {
    const shop = await client.projects.create(draft('Shop'));
    const admin = await client.projects.create(draft('Admin'));
    await addFlow(shop.id, 'checkout');
    const listed = await client.projects.list();
    expect(listed.map((project) => project.name).sort()).toEqual(['Admin', 'Shop']);
    const shopSummary = listed.find((project) => project.id === shop.id);
    expect(shopSummary).toMatchObject({
      state: 'ACTIVE',
      counts: { environments: 0, scenarios: 1, recordings: 0, executions: 0 },
    });

    // Modifier : le brouillon est revalidé, le fichier du moteur réécrit, l'identifiant et la création restent.
    const updated = await client.projects.update(shop.id, draft('Shop v2', 'http://127.0.0.1:9/v2'));
    expect(updated).toMatchObject({
      id: shop.id,
      name: 'Shop v2',
      targetUrl: 'http://127.0.0.1:9/v2',
      createdAt: shop.createdAt,
    });
    expect(updated.updatedAt).toBeDefined();
    expect(await readFile(path.join(workspace, shop.id, 'qa-crawler.config.yaml'), 'utf8')).toContain(
      'http://127.0.0.1:9',
    );
    const invalid = await refusal(client.projects.update(shop.id, draft('Shop', 'ftp://nope')));
    expect(invalid.code).toBe('DRAFT_INVALID');
    expect((await client.projects.detail(shop.id)).name).toBe('Shop v2');

    // Dupliquer : configuration, environnements (nouveaux identifiants), scénarios ; ni runs ni enregistrements.
    const created = await client.environments.create(shop.id, environment());
    const copy = await client.projects.duplicate(shop.id, { name: 'Shop copy' });
    expect(copy.id).not.toBe(shop.id);
    expect(copy.name).toBe('Shop copy');
    expect(copy.environments.map((entry) => entry.name)).toEqual(['Recette']);
    expect(copy.environments[0]?.id).not.toBe(created.id);
    expect(copy.scenarios.map((scenario) => scenario.name)).toEqual(['checkout']);
    expect(copy.counts.executions).toBe(0);

    // Archiver : caché de la liste, lecture seule, rien n'est supprimé ; restaurer le rend actif.
    const archived = await client.projects.archive(admin.id);
    expect(archived).toMatchObject({ state: 'ARCHIVED' });
    expect((await client.projects.list()).some((project) => project.id === admin.id)).toBe(false);
    expect((await client.projects.list({ archived: true })).some((project) => project.id === admin.id)).toBe(
      true,
    );
    expect((await refusal(client.executions.start(admin.id))).code).toBe('PROJECT_ARCHIVED');
    expect((await refusal(client.explorations.start(admin.id))).code).toBe('PROJECT_ARCHIVED');
    expect((await refusal(client.environments.create(admin.id, environment()))).code).toBe(
      'PROJECT_ARCHIVED',
    );
    expect((await stat(path.join(workspace, admin.id, 'qa-crawler.config.yaml'))).isFile()).toBe(true);
    expect((await client.projects.restore(admin.id)).state).toBe('ACTIVE');
  });
});

describe('SDK platform — environments', () => {
  it('checks the shape and the engine rules, never returns a secret, and needs a confirmation to remove', async () => {
    const project = await client.projects.create(draft('Env'));
    const check = await client.environments.check(project.id, environment());
    expect(check).toEqual({ ok: true, issues: [], secrets: { QA_PASSWORD: true } });
    expect(JSON.stringify(check)).not.toContain('secret-value');

    const wrong = await client.environments.check(
      project.id,
      environment({
        baseUrl: 'http://app.example.test',
        allowedDomains: ['other.example.test'],
        variables: { QA_API_TOKEN: 'abc' },
        secretEnv: ['AWS_SECRET_ACCESS_KEY'],
      }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.map((issue) => issue.field)).toEqual([
      'allowedDomains',
      'variables.QA_API_TOKEN',
      'secretEnv',
    ]);
    expect(
      (await client.environments.check(project.id, { ...environment(), baseUrl: 'javascript:alert(1)' })).ok,
    ).toBe(false);

    const recette = await client.environments.create(project.id, environment());
    expect(recette.id).toMatch(/^env_/);
    expect((await refusal(client.environments.create(project.id, environment()))).code).toBe(
      'ENVIRONMENT_INVALID',
    );
    const renamed = await client.environments.update(
      project.id,
      recette.id,
      environment({ name: 'Certification', kind: 'CERTIFICATION' }),
    );
    expect(renamed).toMatchObject({
      id: recette.id,
      name: 'Certification',
      kind: 'CERTIFICATION',
      createdAt: recette.createdAt,
    });

    expect(
      (await refusal(client.environments.remove(project.id, recette.id, {} as { confirm: true }))).code,
    ).toBe('CONFIRMATION_REQUIRED');
    expect(await client.environments.remove(project.id, recette.id, { confirm: true })).toEqual({
      removed: recette.id,
    });
    expect(await client.environments.list(project.id)).toEqual([]);
  });

  it('keeps projects apart: an environment of one project is unknown to another', async () => {
    const first = await client.projects.create(draft('First'));
    const second = await client.projects.create(draft('Second'));
    const own = await client.environments.create(first.id, environment());
    await addFlow(second.id, 'login');
    expect((await refusal(client.executions.start(second.id, { environmentId: own.id }))).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('SDK platform — scenarios and executions', () => {
  it('replays the scenarios through the engine mission, in the chosen environment, and reads the run back', async () => {
    const project = await client.projects.create(draft('Replay'));
    expect((await refusal(client.executions.start(project.id))).code).toBe('NO_SCENARIO');
    await addFlow(project.id, 'checkout');
    await addFlow(project.id, 'broken-search');
    const env = await client.environments.create(project.id, environment());
    expect((await refusal(client.executions.start(project.id, { scenarios: ['nope'] }))).code).toBe(
      'NOT_FOUND',
    );

    const started = await client.executions.start(project.id, {
      scenarios: ['checkout'],
      environmentId: env.id,
    });
    expect(started.kind).toBe('REPLAY');
    expect(['QUEUED', 'RUNNING']).toContain(started.status);
    expect(started.run).toMatch(/^run-/);
    expect((await finished(started)).status).toBe('COMPLETED');

    // La mission du moteur : seulement le scénario choisi, la cible et les règles de l'environnement.
    const last = runs.at(-1);
    expect(last?.config.flows.map((flow) => flow.name)).toEqual(['checkout']);
    expect(last?.config.target.baseUrl).toBe('http://127.0.0.2:9');
    expect(last?.config.safety.allowedHosts).toEqual(['127.0.0.2']);
    expect(last?.config.exploration).toMatchObject({
      actionTimeoutMs: 4000,
      maxDurationMinutes: 3,
      maxStates: 7,
      maxActions: 30,
    });
    expect(last?.env.QA_LOCALE).toBe('fr');
    // Sans IA : le moteur reste déterministe.
    expect(last?.config.ai.mode).toBe('OFF');

    const all = await finished(await client.executions.start(project.id));
    expect(
      runs
        .at(-1)
        ?.config.flows.map((flow) => flow.name)
        .sort(),
    ).toEqual(['broken-search', 'checkout']);
    const list = await client.executions.list(project.id);
    expect(list.map((execution) => [execution.kind, execution.verdict])).toEqual([
      ['REPLAY', 'FAILED'],
      ['REPLAY', 'PASSED'],
    ]);
    expect(list[1]).toMatchObject({
      environment: { id: env.id, name: 'Recette' },
      scenarios: ['checkout'],
      flows: { total: 1, passed: 1, failed: 0 },
    });

    const detail = await client.executions.get(project.id, all.run ?? '');
    const broken = detail.flowsDetail.find((flow) => flow.name === 'broken-search');
    expect(broken).toMatchObject({
      status: 'FAILED',
      divergence: { stepIndex: 1, reason: 'NOT_FOUND' },
      testData: ['item.title'],
    });
    expect(broken?.assertions).toEqual([{ id: 'A1', description: 'the item is created', status: 'FAIL' }]);
    expect(broken?.steps[0]).toMatchObject({
      kind: 'fill',
      status: 'FAILED',
      screenshot: 'screenshots/step-1.png',
    });
    // Une saisie n'est jamais décrite par sa valeur, et sa raison n'est pas relayée.
    expect(JSON.stringify(detail)).not.toContain('Company ABC');
    expect((await refusal(client.executions.get(project.id, '../etc'))).code).toBe('NOT_FOUND');
  });

  it('promotes a recording into a scenario (its flow and its data set, copied as is)', async () => {
    const project = await client.projects.create(draft('Promote'));
    const recording = path.join(workspace, project.id, 'qa-reports', 'recordings', 'create-item');
    await mkdir(recording, { recursive: true });
    await writeFile(
      path.join(recording, 'generated.flow.yaml'),
      'name: create item\ntestData: test-data.yaml\nsteps:\n  - goto: /\n',
    );
    await writeFile(path.join(recording, 'test-data.yaml'), 'values: {}\n');
    const scenario = await client.scenarios.promote(project.id, 'create-item');
    expect(scenario).toEqual({
      name: 'create item',
      file: 'create-item/create-item.flow.yaml',
      format: 'yaml',
      steps: 1,
      fromRecording: 'create-item',
    });
    expect(
      (await readdir(path.join(workspace, project.id, 'qa-crawler', 'flows', 'create-item'))).sort(),
    ).toEqual(['create-item.flow.yaml', 'test-data.yaml']);
    expect((await refusal(client.scenarios.promote(project.id, 'missing'))).code).toBe('REFUSED');
    expect((await refusal(client.scenarios.promote(project.id, '../x'))).code).toBe('BAD_REQUEST');
  });
});

describe('SDK platform — overview', () => {
  it('says what its pass rate counts, and links alerts to their project', async () => {
    const overview = await client.overview.get({ days: 7 });
    expect(overview.period.days).toBe(7);
    expect(overview.trend).toHaveLength(7);
    expect(overview.replays.definition).toBe(PASS_RATE_DEFINITION);
    expect(overview.replays.finished).toBe(overview.replays.passed + overview.replays.failed);
    expect(overview.replays.passRate).toBeCloseTo(overview.replays.passed / overview.replays.finished);
    expect(
      overview.alerts.some((alert) => alert.kind === 'EXECUTION_FAILED' && alert.projectName === 'Replay'),
    ).toBe(true);
    expect(overview.recent.length).toBeGreaterThan(0);
  });

  it('counts nothing it cannot see, and only replays in its pass rate', async () => {
    const empty = await computeOverview([], { days: 30, env: {} });
    expect(empty.replays).toEqual({ finished: 0, passed: 0, failed: 0, definition: PASS_RATE_DEFINITION });
    expect(empty.replays.passRate).toBeUndefined();
    const dir = await mkdtemp(path.join(tmpdir(), 'sdk-overview-'));
    await mkdir(path.join(dir, 'run-2026-10-20T10-00-00-000Z'), { recursive: true });
    await writeFile(
      path.join(dir, 'run-2026-10-20T10-00-00-000Z', 'result.json'),
      JSON.stringify({
        startedAt: '2026-10-20T10:00:00.000Z',
        durationMs: 1,
        stopReason: 'exhausted',
        flows: [],
        issues: [],
        stats: { issuesBySeverity: {} },
        artifacts: {},
      }),
    );
    const view = await computeOverview(
      [
        {
          id: 'p',
          name: 'P',
          archived: false,
          reportsDir: dir,
          scenarios: 0,
          recordings: 0,
          environments: [
            {
              id: 'e',
              name: 'E',
              kind: 'TEST',
              baseUrl: 'http://x',
              secretEnv: ['QA_ABSENT'],
              createdAt: '',
              updatedAt: '',
            },
          ],
        },
      ],
      { days: 30, env: {}, now: new Date('2026-10-27T00:00:00.000Z') },
    );
    // Une exploration sans flow n'entre pas dans le taux de réussite des rejeux.
    expect(view.executions).toEqual({ total: 1, byKind: { EXPLORATION: 1, REPLAY: 0 } });
    expect(view.replays.finished).toBe(0);
    expect(view.alerts).toEqual([
      {
        kind: 'SECRET_MISSING',
        projectId: 'p',
        projectName: 'P',
        message: 'QA_ABSENT (environment "E") is not defined on the server',
      },
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});
