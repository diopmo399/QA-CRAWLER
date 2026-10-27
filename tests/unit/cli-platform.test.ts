import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_EXIT, runPlatformCli, type PlatformCommand } from '../../src/cli/platform-command.js';
import type { ScenarioConfig } from '../../src/config/config.js';
import type { RunOptions, RunOutcome } from '../../src/orchestrator.js';
import { openQaCrawler } from '../../src/sdk/server/node.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LA CLI DE LA PLATEFORME sur le client du SDK, avec un moteur SIMULÉ (tests uniquement) qui écrit
 * un result.json comme le vrai : un flow `broken` échoue, un flow `slow` attend l'annulation. Le vrai
 * moteur est couvert par tests/integration/cli-platform.test.ts.
 */
let workspace = '';
let projectId = '';
const SECRET = 'cli-secret-value-123';

async function fakeRun(config: ScenarioConfig, options: RunOptions): Promise<RunOutcome> {
  const reports = config.output.reportsDir;
  await mkdir(reports, { recursive: true });
  const slow = config.flows.some((flow) => flow.name === 'slow');
  if (slow)
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else
        options.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
    });
  const cancelled = options.signal?.aborted ?? false;
  const flows = config.flows.map((flow) => ({
    name: flow.name,
    status: flow.name === 'broken' ? 'FAILED' : 'PASSED',
    startedAt: new Date().toISOString(),
    durationMs: 10,
    states: [],
    issueIds: [],
    explored: false,
    steps: [
      {
        index: 1,
        kind: 'fill',
        description: 'fill label "Title" = "typed value"',
        status: cancelled ? 'SKIPPED' : flow.name === 'broken' ? 'FAILED' : 'PASSED',
        optional: false,
        durationMs: 5,
      },
    ],
  }));
  const result = {
    mission: config.mission.name,
    startedAt: new Date().toISOString(),
    durationMs: 20,
    stopReason: cancelled ? 'cancelled' : 'flows-only',
    stats: {
      states: 1,
      transitions: 0,
      actionsExecuted: 1,
      actionsBlocked: 0,
      issuesBySeverity: { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 },
    },
    flows,
    issues: [],
    artifacts: { json: path.join(reports, 'result.json') },
  };
  await writeFile(path.join(reports, 'result.json'), JSON.stringify(result));
  return { passed: true, failingIssues: [], regressions: 0, result } as unknown as RunOutcome;
}

const open = (dir: string) => openQaCrawler({ workspace: dir, run: fakeRun, env: { QA_PASSWORD: SECRET } });

async function cli(
  command: PlatformCommand,
  argv: string[],
  extra: { signals?: EventEmitter; env?: NodeJS.ProcessEnv; onErr?: (line: string) => void } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPlatformCli(command, argv, {
    open,
    out: (line) => out.push(line),
    err: (line) => {
      err.push(line);
      extra.onErr?.(line);
    },
    ...(extra.signals ? { signals: extra.signals } : {}),
    ...(extra.env ? { env: extra.env } : {}),
    exit: () => undefined,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'cli-platform-'));
  const qa = await open(workspace);
  try {
    const project = await qa.client.projects.create({
      ...engineDefaults(),
      project: { name: 'Shop', targetUrl: 'http://127.0.0.1:9/app', framework: 'vue' },
    });
    projectId = project.id;
    const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
    await mkdir(flows, { recursive: true });
    for (const name of ['checkout', 'broken', 'slow'])
      await writeFile(path.join(flows, `${name}.flow.yaml`), `name: ${name}\nsteps:\n  - goto: /\n`);
    await qa.client.environments.create(project.id, {
      name: 'Recette',
      kind: 'TEST',
      baseUrl: 'http://127.0.0.2:9',
      allowedDomains: ['127.0.0.2'],
      secretEnv: ['QA_PASSWORD'],
    });
    await qa.client.environments.create(project.id, {
      name: 'Sans secret',
      kind: 'TEST',
      baseUrl: 'http://127.0.0.3:9',
      allowedDomains: ['127.0.0.3'],
      secretEnv: ['QA_MISSING_SECRET'],
    });
  } finally {
    await qa.close();
  }
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('CLI platform — usage', () => {
  it('needs exactly one connection, a known command and its arguments', async () => {
    expect((await cli('project', ['list'])).code).toBe(PLATFORM_EXIT.USAGE);
    expect((await cli('project', ['list', '--workspace', workspace, '--endpoint', 'http://x'])).code).toBe(
      PLATFORM_EXIT.USAGE,
    );
    expect((await cli('project', ['explode', '--workspace', workspace])).code).toBe(PLATFORM_EXIT.USAGE);
    expect((await cli('project', ['show', '--workspace', workspace])).err).toContain('<project> is required');
    expect((await cli('run', ['--help'])).out).toContain('qa-crawler run start <project>');
    const missing = await cli('project', ['list', '--workspace', path.join(workspace, 'nope')]);
    expect(missing.code).toBe(PLATFORM_EXIT.USAGE);
  });

  it('answers an error as JSON with --json', async () => {
    const { code, out } = await cli('project', ['show', 'Unknown', '--workspace', workspace, '--json']);
    expect(code).toBe(PLATFORM_EXIT.USAGE);
    expect(JSON.parse(out)).toEqual({ error: { code: 'USAGE', message: 'project not found: Unknown' } });
  });
});

describe('CLI platform — projects, environments, scenarios', () => {
  it('lists and shows a project, by name or identifier', async () => {
    const listed = await cli('project', ['list', '--workspace', workspace, '--json']);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as { name: string }[]).map((project) => project.name)).toEqual(['Shop']);
    const text = await cli('project', ['show', 'Shop', '--workspace', workspace]);
    expect(text.out).toContain(`Shop (${projectId}) — ACTIVE`);
    expect(text.out).toContain('Recette [TEST]');
    const byId = await cli('project', ['show', projectId, '--workspace', workspace, '--json']);
    expect((JSON.parse(byId.out) as { id: string }).id).toBe(projectId);
  });

  it('shows environments with secret names only, and validates them', async () => {
    const shown = await cli('env', ['show', 'Shop', 'Recette', '--workspace', workspace]);
    expect(shown.out).toContain('Secrets      : QA_PASSWORD');
    expect(shown.out + shown.err).not.toContain(SECRET);
    const listed = await cli('env', ['list', 'Shop', '--workspace', workspace, '--json']);
    expect(JSON.stringify(JSON.parse(listed.out))).not.toContain(SECRET);
    const valid = await cli('env', ['validate', 'Shop', 'Recette', '--workspace', workspace]);
    expect(valid.code, valid.out + valid.err).toBe(0);
    expect(valid.out).toContain('Recette: READY');
    expect(valid.out).toContain('QA_PASSWORD defined on the server');
    const invalid = await cli('env', ['validate', 'Shop', 'Sans secret', '--workspace', workspace, '--json']);
    expect(invalid.code).toBe(PLATFORM_EXIT.USAGE);
    expect(JSON.parse(invalid.out)).toMatchObject({ ready: false, secrets: { QA_MISSING_SECRET: false } });
  });

  it('lists the scenarios', async () => {
    const { code, out } = await cli('scenario', ['list', 'Shop', '--workspace', workspace]);
    expect(code).toBe(0);
    expect(out).toMatch(/checkout\s+yaml\s+1/);
  });
});

describe('CLI platform — runs', () => {
  let passedRun = '';

  it('replays, writes JUnit XML, and exits with the verdict', async () => {
    const junit = path.join(workspace, 'out', 'junit.xml');
    const passed = await cli('run', [
      'start',
      'Shop',
      '--env',
      'Recette',
      '--scenario',
      'checkout',
      '--junit',
      junit,
      '--workspace',
      workspace,
      '--json',
    ]);
    expect(passed.code).toBe(PLATFORM_EXIT.OK);
    const detail = JSON.parse(passed.out) as { run: string; verdict: string; environment: { name: string } };
    expect(detail).toMatchObject({ verdict: 'PASSED', environment: { name: 'Recette' } });
    passedRun = detail.run;
    // Le libellé de l'étape, jamais la valeur saisie.
    expect(passed.out).not.toContain('typed value');
    const xml = await readFile(junit, 'utf8');
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('checkout');

    const failed = await cli('run', ['start', 'Shop', '--scenario', 'broken', '--workspace', workspace]);
    expect(failed.code).toBe(PLATFORM_EXIT.FAILED);
    expect(failed.out).toContain('■ FAILED');
  });

  it('lists the runs and reads one back with its verdict', async () => {
    const listed = await cli('run', ['list', 'Shop', '--workspace', workspace, '--json']);
    expect((JSON.parse(listed.out) as { verdict: string }[]).map((run) => run.verdict)).toEqual([
      'FAILED',
      'PASSED',
    ]);
    const results = await cli('run', ['results', 'Shop', passedRun, '--workspace', workspace]);
    expect(results.code).toBe(0);
    expect(results.out).toContain('PASSED  1. fill label "Title"');
    expect(results.out).not.toContain('typed value');
    const status = await cli('run', ['status', 'exp_x', '--workspace', workspace]);
    expect(status.code).toBe(PLATFORM_EXIT.USAGE);
    expect(status.err).toContain('needs --endpoint');
  });

  it('cancels on Ctrl+C and exits 130', async () => {
    const signals = new EventEmitter();
    const { code, out } = await cli(
      'run',
      ['start', 'Shop', '--scenario', 'slow', '--workspace', workspace],
      {
        signals,
        onErr: (line) => {
          if (line.startsWith('▶ ')) setTimeout(() => signals.emit('SIGINT'), 50);
        },
      },
    );
    expect(code).toBe(PLATFORM_EXIT.CANCELLED);
    expect(out).toContain('■ CANCELLED');
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('counts the runs in the overview (cancelled excluded from the pass rate)', async () => {
    const { code, out } = await cli('overview', ['--days', '1', '--workspace', workspace, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ replays: { finished: 2, passed: 1, failed: 1, passRate: 0.5 } });
  });
});

describe('CLI platform — a running sdk-server (--endpoint)', () => {
  let server: RunningSdkServer;
  const token = 'endpoint-token-0123456789';
  const env = { QA_SDK_TOKEN: token };

  beforeAll(async () => {
    server = await startSdkServer({ workspace, run: fakeRun, env: { QA_PASSWORD: SECRET }, token });
  });
  afterAll(async () => {
    await server.close();
  });

  it('starts detached, reads the live status, and cancels', async () => {
    const started = await cli(
      'run',
      ['start', 'Shop', '--scenario', 'slow', '--detach', '--endpoint', server.url, '--json'],
      { env },
    );
    expect(started.code).toBe(0);
    const snapshot = JSON.parse(started.out) as { id: string };
    const status = await cli('run', ['status', snapshot.id, '--endpoint', server.url, '--json'], { env });
    expect(['QUEUED', 'RUNNING']).toContain((JSON.parse(status.out) as { status: string }).status);
    const cancelled = await cli('run', ['cancel', snapshot.id, '--endpoint', server.url], { env });
    expect(cancelled.code).toBe(0);
    await server.explorations.idle(5_000);
    const after = await cli('run', ['status', snapshot.id, '--endpoint', server.url, '--json'], { env });
    expect((JSON.parse(after.out) as { status: string }).status).toBe('CANCELLED');
    // Le jeton n'est jamais écrit.
    expect(started.out + status.out + cancelled.out + after.out).not.toContain(token);
  });

  it('refuses without the token, and with a wrong one', async () => {
    const missing = await cli('project', ['list', '--endpoint', server.url], { env: {} });
    expect(missing.code).toBe(PLATFORM_EXIT.USAGE);
    expect(missing.err).toContain('QA_SDK_TOKEN');
    const wrong = await cli('project', ['list', '--endpoint', server.url], {
      env: { QA_SDK_TOKEN: 'not-the-right-token-000' },
    });
    expect(wrong.code).toBe(PLATFORM_EXIT.USAGE);
  });

  it('doctor checks the service and its contract version', async () => {
    const { out } = await cli('doctor', ['--endpoint', server.url, '--json'], { env });
    const report = JSON.parse(out) as { checks: { name: string; ok: boolean; detail: string }[] };
    expect(report.checks.find((check) => check.name === 'service')).toMatchObject({ ok: true });
    expect(report.checks.find((check) => check.name === 'node')).toMatchObject({ ok: true });
  });
});
