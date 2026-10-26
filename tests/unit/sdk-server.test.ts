import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioConfig } from '../../src/config/config.js';
import type { RunOptions, RunOutcome } from '../../src/orchestrator.js';
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
  });
});

describe('SDK server — projects and explorations', () => {
  it('validates, creates, explores with the engine events, and serves the reports through a short link', async () => {
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    const caps = await client.capabilities();
    expect(caps).toMatchObject({ browsers: ['chromium'], cancellation: false, staticAnalysis: false });

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
