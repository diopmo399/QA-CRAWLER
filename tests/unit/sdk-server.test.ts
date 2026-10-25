import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioConfig } from '../../src/config/config.js';
import type { RunOptions, RunOutcome } from '../../src/orchestrator.js';
import type { RecordOutcome, RecordRequest } from '../../src/recording/record-orchestrator.js';
import { createQaCrawler, type ExplorationEvent, type ProjectDraft } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * Le serveur du SDK par HTTP, avec un moteur SIMULÉ (tests uniquement) : il émet des événements
 * d'écouteur, écrit des rapports dans le dossier demandé et rend un résultat. Le vrai moteur est
 * couvert par tests/integration/sdk-wizard.test.ts.
 */
let server: RunningSdkServer;
let workspace: string;
let release: () => void = () => undefined;
const runs: ScenarioConfig[] = [];

async function fakeRun(config: ScenarioConfig, options: RunOptions): Promise<RunOutcome> {
  runs.push(config);
  await new Promise<void>((resolve) => {
    release = resolve;
  });
  const listener = options.listener;
  const context = {
    stateId: 's1',
    stateLabel: 'home',
    route: '/',
    title: 'Home',
    url: config.target.baseUrl,
  } as never;
  listener?.onState?.(context, true);
  listener?.onState?.(
    { ...(context as object), stateId: 's2', stateLabel: 'users', route: '/users' } as never,
    true,
  );
  listener?.onTransition?.(
    { from: 's1', to: 's2', action: { type: 'click', label: 'Users' } } as never,
    { text: 'Users' } as never,
  );
  listener?.onBlocked?.(context, { text: 'Delete', type: 'click' } as never, 'delete');
  listener?.onIssue?.(
    {
      id: 'i1',
      severity: 'WARNING',
      type: 'HTTP',
      message: 'GET /api/x returned 404',
      pageUrl: `${config.target.baseUrl}/users`,
    } as never,
    true,
  );
  const reports = config.output.reportsDir;
  await mkdir(path.join(reports, 'screenshots'), { recursive: true });
  await writeFile(
    path.join(reports, 'index.html'),
    '<!doctype html><title>Report</title><img src="screenshots/a.png">',
  );
  await writeFile(path.join(reports, 'screenshots', 'a.png'), 'png');
  await writeFile(path.join(reports, 'result.json'), '{}');
  await writeFile(
    path.join(reports, 'flow-graph.json'),
    JSON.stringify({
      version: 1,
      rootId: 's1',
      nodes: [
        { id: 's1', label: 'home', route: '/', title: 'Home', depth: 0 },
        { id: 's2', label: 'users', route: '/users', title: 'Users', depth: 1 },
      ],
      edges: [{ from: 's1', to: 's2', action: { type: 'click', text: 'Users' }, result: 'SUCCESS' }],
    }),
  );
  return {
    passed: true,
    failingIssues: [],
    regressions: 0,
    result: {
      stopReason: 'exhausted',
      durationMs: 1234,
      stats: {
        states: 2,
        transitions: 1,
        actionsExecuted: 1,
        actionsBlocked: 1,
        issuesBySeverity: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
      },
      issues: [
        {
          id: 'i1',
          severity: 'WARNING',
          type: 'HTTP',
          message: 'GET /api/x returned 404',
          pageUrl: `${config.target.baseUrl}/users`,
        },
      ],
      artifacts: { html: path.join(reports, 'index.html'), json: path.join(reports, 'result.json') },
    },
  } as unknown as RunOutcome;
}

/**
 * Un recorder SIMULÉ (tests uniquement) : il annonce le début, attend l'arrêt (API), écrit un dossier
 * d'enregistrement minimal et rend un résultat. Le vrai recorder est couvert par
 * tests/integration/sdk-extensions.test.ts.
 */
const records: RecordRequest[] = [];
async function fakeRecord(request: RecordRequest): Promise<RecordOutcome> {
  records.push(request);
  const at = new Date().toISOString();
  let stop: (reason: string) => void = () => undefined;
  const stopped = new Promise<string>((resolve) => {
    stop = resolve;
  });
  request.onEvent?.({ type: 'RECORDING_STARTED', at, message: 'recording started' } as never);
  request.onEvent?.({ type: 'RAW_EVENT_CAPTURED', at, message: 'click r1' } as never);
  request.control?.({
    requestStop: (reason: string) => {
      stop(reason);
    },
    stopped,
  } as never);
  const reason = await stopped;
  request.onEvent?.({ type: 'RECORDING_STOPPED', at, message: 'stopped (api)' } as never);
  request.onProgress?.({
    task: 'Finalizing',
    step: 1,
    total: 2,
    label: 'Building the flow',
    elapsedMs: 1,
  } as never);
  const dir = path.join(request.overrides?.reportsDir ?? '', 'recordings', 'parcours-test');
  await mkdir(dir, { recursive: true });
  const flow = {
    name: request.name,
    recordingSessionId: 'rec-1',
    startAt: '/',
    steps: [],
    assertions: [],
    proposals: [],
  };
  await writeFile(path.join(dir, 'recorded-flow.json'), JSON.stringify(flow));
  await writeFile(path.join(dir, 'raw-recording.json'), JSON.stringify({ startedAt: at, rawEvents: [] }));
  await writeFile(path.join(dir, 'generated.flow.yaml'), 'name: parcours test\nsteps: []\n');
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Recording</title>');
  await writeFile(
    path.join(dir, 'flow-graph.json'),
    JSON.stringify({
      version: 1,
      rootId: 'a',
      nodes: [{ id: 'a', label: 'home', route: '/', title: 'Home', depth: 0 }],
      edges: [],
    }),
  );
  return {
    result: { flow },
    directory: dir,
    files: { 'recorded-flow.json': 'recorded-flow.json', 'generated.flow.yaml': 'generated.flow.yaml' },
    replay: { status: 'NOT_VALIDATED' },
    stopReason: reason,
    warnings: [],
  } as unknown as RecordOutcome;
}

const draft = (): ProjectDraft => ({
  ...engineDefaults(),
  project: { name: 'Demo', targetUrl: 'http://127.0.0.1:9/app', framework: 'vue' },
});

async function call(
  pathname: string,
  init: RequestInit & { token?: string | null; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? server.token}`;
  if (init.origin) headers.origin = init.origin;
  return fetch(`${server.url}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-server-'));
  server = await startSdkServer({
    workspace,
    run: fakeRun,
    record: fakeRecord,
    allowedOrigins: ['https://portal.example.test'],
    env: { QA_USERNAME: 'jane', QA_PASSWORD: 'secret-value', AWS_SECRET_ACCESS_KEY: 'x' },
  });
});

afterAll(async () => {
  release();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK server — access control', () => {
  it('requires the token on the whole API', async () => {
    expect((await call('/api/capabilities', { token: null })).status).toBe(401);
    expect((await call('/api/capabilities', { token: 'wrong-token' })).status).toBe(401);
    expect((await call('/api/capabilities')).status).toBe(200);
  });

  it('refuses an origin that is not listed, and gives CORS headers to a listed one', async () => {
    const refused = await call('/api/capabilities', { origin: 'https://evil.example.test' });
    expect(refused.status).toBe(403);
    const allowed = await call('/api/capabilities', { origin: 'https://portal.example.test' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://portal.example.test');
    const preflight = await fetch(`${server.url}/api/projects`, {
      method: 'OPTIONS',
      headers: { origin: 'https://portal.example.test', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('only says whether QA_* variables are defined, never their value, and refuses other names', async () => {
    const known = await call('/api/checks/env', {
      method: 'POST',
      body: JSON.stringify({ names: ['QA_PASSWORD', 'QA_OTHER'] }),
    });
    expect(await known.json()).toEqual({ QA_PASSWORD: true, QA_OTHER: false });
    const probe = await call('/api/checks/env', {
      method: 'POST',
      body: JSON.stringify({ names: ['AWS_SECRET_ACCESS_KEY'] }),
    });
    expect(probe.status).toBe(400);
    expect(await probe.text()).not.toContain('"x"');
  });

  it('serves the browser modules publicly (transpiled in development)', async () => {
    const response = await fetch(`${server.url}/sdk/core/lifecycle.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    const code = await response.text();
    expect(code).toContain('export function applyEvent');
    expect(code).not.toContain(': ExplorationCounters');
    expect((await fetch(`${server.url}/sdk/server/server.js`)).status).toBe(404);
    expect((await fetch(`${server.url}/sdk/core/..%2Fserver%2Fserver.js`)).status).toBe(404);
  });

  it('serves the standalone page with a strict content security policy', async () => {
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(await page.text()).toContain('<qa-crawler-project-wizard mode="standalone"');
    const studio = await fetch(`${server.url}/studio?project=x&recording=<y>`);
    expect(studio.status).toBe(200);
    expect(studio.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await studio.text();
    expect(html).toContain('<qa-crawler-flow-studio endpoint="/api"');
    // Le projet et l'enregistrement sont lus par le script, jamais recopiés dans la page.
    expect(html).not.toContain('<y>');
  });
});

describe('SDK server — projects and explorations', () => {
  it('validates, creates, explores with the engine events, and serves the reports through a short link', async () => {
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    const caps = await client.capabilities();
    expect(caps).toMatchObject({ browsers: ['chromium'], cancellation: false, staticAnalysis: false });
    expect(Object.values(caps.extensions).every(Boolean)).toBe(true);

    const report = await client.projects.validate(draft());
    expect(report.ok).toBe(true);
    expect(report.projectFile).toContain('framework: vue');

    const project = await client.projects.create(draft());
    expect(project).toMatchObject({ name: 'Demo', status: 'PROJECT_CREATED' });
    const written = await readFile(path.join(workspace, project.id, 'qa-crawler.config.yaml'), 'utf8');
    expect(written).toContain('baseUrl: http://127.0.0.1:9');
    expect((await client.projects.get(project.id)).id).toBe(project.id);

    const started = await client.explorations.start(project.id);
    expect(['QUEUED', 'RUNNING']).toContain(started.status);
    expect(started.budget).toMatchObject({ maxStates: 100, maxDurationMinutes: 15 });
    // Pas de résultat ni de rapport avant la fin : jamais un « terminé » anticipé.
    await expect(client.explorations.result(started.id)).rejects.toMatchObject({ status: 409 });
    await expect(client.explorations.reportLink(started.id)).rejects.toMatchObject({ status: 409 });
    await expect(client.graph.exploration(started.id)).rejects.toMatchObject({ status: 409 });

    const events: ExplorationEvent[] = [];
    const subscription = client.explorations.subscribe(started.id, (event) => events.push(event));
    await expect.poll(() => runs.length).toBe(1);
    release();
    await subscription.done;

    expect(events.map((event) => event.type)).toEqual([
      'status', // QUEUED
      'status', // RUNNING
      'state',
      'state',
      'transition',
      'blocked',
      'issue',
      'completed',
      'status', // COMPLETED
    ]);
    const statuses = events.flatMap((event) => (event.type === 'status' ? [event.status] : []));
    expect(statuses).toEqual(['QUEUED', 'RUNNING', 'COMPLETED']);
    // Les rapports de l'exploration vont dans son propre dossier, sous le projet.
    expect(runs[0]?.output.reportsDir).toContain(path.join(project.id, 'qa-reports', 'run-'));

    const final = await client.explorations.status(started.id);
    expect(final.status).toBe('COMPLETED');
    expect(final.counters).toEqual({
      states: 2,
      transitions: 1,
      actions: 1,
      blocked: 1,
      issues: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
    });
    const summary = await client.explorations.result(started.id);
    expect(summary).toMatchObject({
      stopReason: 'exhausted',
      durationMs: 1234,
      reports: { html: 'index.html', json: 'result.json' },
    });

    const link = await client.explorations.reportLink(started.id);
    expect(link.url).toMatch(/\/reports\/[A-Za-z0-9_-]+\/index\.html$/);
    const html = await fetch(link.url);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    const image = await fetch(link.url.replace('index.html', 'screenshots/a.png'));
    expect(image.status).toBe(200);
    const escape = await fetch(link.url.replace('index.html', '..%2F..%2Fqa-crawler.config.yaml'));
    expect(escape.status).toBe(404);
    expect((await fetch(`${server.url}/reports/not-a-ticket/index.html`)).status).toBe(404);

    // Le graphe écrit par le moteur, réduit à ce qu'un écran affiche.
    const graph = await client.graph.exploration(started.id);
    expect(graph).toMatchObject({ rootId: 's1', nodes: [{ id: 's1' }, { id: 's2' }] });
    expect(graph.edges[0]).toMatchObject({
      from: 's1',
      to: 's2',
      action: 'Users',
      type: 'click',
      result: 'SUCCESS',
    });

    // Le flux d'une exploration terminée se rejoue, puis se ferme.
    const replay: ExplorationEvent[] = [];
    await client.explorations.subscribe(started.id, (event) => replay.push(event), { after: 7 }).done;
    expect(replay.map((event) => event.seq)).toEqual([8, 9]);
  });

  it('refuses to create a project whose credentials variables are missing', async () => {
    const response = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        draft: {
          ...draft(),
          environment: {
            ...draft().environment,
            auth: { type: 'http', usernameEnv: 'QA_USERNAME', passwordEnv: 'QA_MISSING_PASSWORD' },
          },
        },
      }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; issues: { step: string; message: string }[] };
    expect(body.code).toBe('DRAFT_INVALID');
    expect(body.issues[0]).toMatchObject({ step: 'environment' });
  });

  it('refuses credentials variables outside QA_* (the server never reads them)', async () => {
    const response = await call('/api/projects/validate', {
      method: 'POST',
      body: JSON.stringify({
        draft: {
          ...draft(),
          environment: {
            ...draft().environment,
            auth: { type: 'http', usernameEnv: 'QA_USERNAME', passwordEnv: 'AWS_SECRET_ACCESS_KEY' },
          },
        },
      }),
    });
    const report = (await response.json()) as {
      ok: boolean;
      environment: Record<string, boolean>;
      blocking: { message: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(
      report.blocking.some((issue) => issue.message.includes('only reads environment variables matching')),
    ).toBe(true);
  });

  it('answers unknown projects and explorations with 404', async () => {
    expect((await call('/api/projects/prj_unknown123')).status).toBe(404);
    expect((await call('/api/explorations/exp_unknown123')).status).toBe(404);
    expect((await call('/api/projects/../../etc')).status).toBe(404);
  });
});

describe('SDK server — recordings and reports', () => {
  it('refuses a bad name or a start path outside the application', async () => {
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    const project = await client.projects.create(draft());
    await expect(client.recordings.start(project.id, { name: '   ' })).rejects.toMatchObject({ status: 400 });
    for (const startPath of ['//evil.example.test/x', 'https://evil.example.test', 'users'])
      await expect(client.recordings.start(project.id, { name: 'X', startPath })).rejects.toMatchObject({
        status: 400,
      });
    // Un « / » encodé ne sort pas du dossier des enregistrements ; « .. » est résolu par l'URL avant le routage.
    expect((await call(`/api/projects/${project.id}/recordings/a%2Fb`)).status).toBe(404);
    expect((await call(`/api/projects/${project.id}/recordings/%2E%2E/%2E%2E/%2E%2E/etc`)).status).toBe(404);
    await expect(client.recordings.get(project.id, 'unknown')).rejects.toMatchObject({ status: 404 });
    await expect(
      client.recordings.subscribe(project.id, 'unknown', () => undefined).done,
    ).resolves.toBeUndefined();
  });

  it('runs one recording at a time, relays the recorder (not its raw events), stops by API, then serves the stored recording', async () => {
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    const project = await client.projects.create(draft());
    const started = await client.recordings.start(project.id, { name: 'Parcours test', startPath: '/users' });
    expect(started).toMatchObject({ name: 'parcours-test', status: 'RECORDING' });
    await expect.poll(() => records.length).toBe(1);
    // La mission du projet, un navigateur visible (un humain y joue le parcours), les rapports du projet.
    expect(records[0]).toMatchObject({ name: 'Parcours test', url: '/users', review: false });
    expect(records[0]?.overrides).toMatchObject({ headless: false });
    expect(records[0]?.missionFile).toContain(path.join(project.id, '.derived'));
    await expect(client.recordings.start(project.id, { name: 'Autre' })).rejects.toMatchObject({
      status: 409,
      code: 'RECORDING_ACTIVE',
    });
    await expect(client.recordings.flow(project.id, 'parcours-test')).rejects.toMatchObject({
      status: 409,
      code: 'RECORDING_IN_PROGRESS',
    });

    const events: { type: string; event?: string; status?: string }[] = [];
    const subscription = client.recordings.subscribe(project.id, 'parcours-test', (event) =>
      events.push(event),
    );
    await expect.poll(() => events.length).toBeGreaterThan(1);
    expect((await client.recordings.stop(project.id, 'parcours-test')).name).toBe('parcours-test');
    await subscription.done;
    expect(events.map((event) => event.type)).toEqual([
      'status',
      'recorder',
      'recorder',
      'status',
      'phase',
      'completed',
      'status',
    ]);
    expect(events.some((event) => event.event === 'RAW_EVENT_CAPTURED')).toBe(false);
    expect(events.filter((event) => event.type === 'status').map((event) => event.status)).toEqual([
      'RECORDING',
      'PROCESSING',
      'COMPLETED',
    ]);

    const done = await client.recordings.get(project.id, 'parcours-test');
    expect(done.summary).toMatchObject({ steps: 0, stopReason: 'api', replay: 'NOT_VALIDATED' });
    expect((await client.recordings.flow(project.id, 'parcours-test')).yaml).toContain('parcours test');
    expect(await client.assertions.list(project.id, 'parcours-test')).toEqual([]);
    expect(await client.groups.list(project.id, 'parcours-test')).toEqual([]);
    expect(await client.recordings.studio(project.id, 'parcours-test')).toEqual({
      name: expect.any(String) as unknown,
      startAt: '/',
      steps: [],
      groups: [],
      dependencies: [],
      violations: [],
    });
    await expect(client.recordings.studio(project.id, 'inconnu')).rejects.toMatchObject({ status: 404 });
    expect(await client.data.get(project.id, 'parcours-test')).toEqual({
      variables: [],
      inputs: [],
      missing: [],
      generators: expect.arrayContaining(['text', 'email']) as unknown,
    });
    await expect(
      client.data.bind(project.id, 'parcours-test', { stepId: 's1', source: 'MAGIC' as never }),
    ).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    await expect(
      client.data.bind(project.id, 'parcours-test', {
        stepId: 's1',
        source: 'FIXED',
        value: 'x'.repeat(501),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Sans jeu de données, le moteur refuse la liaison : rien n'est écrit.
    await expect(
      client.data.bind(project.id, 'parcours-test', { stepId: 's1', source: 'FIXED', value: 'x' }),
    ).rejects.toMatchObject({ status: 422, code: 'REFUSED' });
    await expect(
      client.assertions.decide(project.id, 'parcours-test', 'p-unknown', { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ status: 422, code: 'REFUSED' });
    await expect(
      client.assertions.decide(project.id, 'parcours-test', 'p1', { decision: 'MAYBE' as never }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.groups.edit(project.id, 'parcours-test', { op: 'explode' } as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client.generation.run(project.id, 'parcours-test', { formats: [] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.recordings.stop(project.id, 'parcours-test')).rejects.toMatchObject({
      status: 409,
      code: 'NOT_RECORDING',
    });

    const reports = await client.reports.list(project.id);
    expect(reports).toEqual([
      expect.objectContaining({
        kind: 'recording',
        name: 'parcours-test',
        recording: { steps: 0 },
        hasGraph: true,
      }),
    ]);
    expect((await client.graph.of(project.id, 'recording', 'parcours-test')).nodes).toHaveLength(1);
    const link = await client.reports.link(project.id, 'recording', 'parcours-test');
    expect((await fetch(link.url)).status).toBe(200);
    await expect(client.reports.link(project.id, 'exploration', '../../etc')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client.graph.of(project.id, 'recording', 'unknown')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the new routes behind the token', async () => {
    expect((await call('/api/projects/prj_whatever/recordings', { token: null })).status).toBe(401);
    expect((await call('/api/projects/prj_whatever/reports', { token: null })).status).toBe(401);
    expect((await call('/api/projects/prj_whatever/recordings/x/studio', { token: null })).status).toBe(401);
    expect((await call('/api/projects/prj_whatever/recordings/x/data', { token: null })).status).toBe(401);
  });
});
