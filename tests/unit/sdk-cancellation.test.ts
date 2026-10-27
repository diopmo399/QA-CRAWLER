import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioConfig } from '../../src/config/config.js';
import type { RunOptions, RunOutcome } from '../../src/orchestrator.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type ExplorationSnapshot,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { canTransition } from '../../src/sdk/core/lifecycle.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { openQaCrawler } from '../../src/sdk/server/node.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * L'ANNULATION CONTRÔLÉE par le client du SDK, avec un moteur SIMULÉ (tests uniquement) qui, comme le
 * vrai, s'arrête quand le signal est levé et écrit son résultat avec `stopReason: cancelled`. Une
 * exécution en file n'est jamais lancée ; une exécution terminée ne s'annule plus. Le vrai moteur
 * est couvert par tests/integration/sdk-cancellation.test.ts.
 */
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let started = 0;

async function fakeRun(config: ScenarioConfig, options: RunOptions): Promise<RunOutcome> {
  started += 1;
  const signal = options.signal;
  if (!signal) throw new Error('the engine must receive the cancellation signal');
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
  });
  const reports = config.output.reportsDir;
  await mkdir(reports, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    durationMs: 30,
    stopReason: 'cancelled',
    stats: {
      states: 0,
      transitions: 0,
      actionsExecuted: 0,
      actionsBlocked: 0,
      issuesBySeverity: { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 },
    },
    flows: [],
    issues: [],
    artifacts: { json: path.join(reports, 'result.json') },
  };
  await writeFile(path.join(reports, 'result.json'), JSON.stringify(result));
  return { passed: true, failingIssues: [], regressions: 0, result } as unknown as RunOutcome;
}

async function settled(snapshot: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await client.explorations.status(snapshot.id);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the execution never settled');
}

async function running(snapshot: ExplorationSnapshot): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await client.explorations.status(snapshot.id)).status === 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the execution never started');
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-cancel-'));
  server = await startSdkServer({ workspace, run: fakeRun, env: {} });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK cancellation', () => {
  it('allows CANCELLED from QUEUED and RUNNING only', () => {
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    expect(canTransition('RUNNING', 'CANCELLED')).toBe(true);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'RUNNING')).toBe(false);
  });

  it('never starts a queued execution, stops a running one, and refuses a finished one', async () => {
    expect((await client.capabilities()).cancellation).toBe(true);
    const project = await client.projects.create({
      ...engineDefaults(),
      project: { name: 'Shop', targetUrl: 'http://127.0.0.1:9/app', framework: 'vue' },
    });
    const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
    await mkdir(flows, { recursive: true });
    await writeFile(path.join(flows, 'checkout.flow.yaml'), 'name: checkout\nsteps:\n  - goto: /\n');

    const first = await client.executions.start(project.id);
    await running(first);
    // Une seule exécution à la fois : la seconde attend.
    const second = await client.executions.start(project.id);
    expect((await client.explorations.status(second.id)).status).toBe('QUEUED');

    const dropped = await client.explorations.cancel(second.id);
    expect(dropped.status).toBe('CANCELLED');

    await client.explorations.cancel(first.id);
    const stopped = await settled(first);
    expect(stopped.status).toBe('CANCELLED');
    // La seconde n'a jamais été lancée par le moteur.
    expect(started).toBe(1);

    // Le résultat écrit par le moteur : l'exécution est lue comme annulée, pas comme un échec.
    const run = first.run ?? '';
    const stored = JSON.parse(
      await readFile(path.join(workspace, project.id, 'qa-reports', run, 'result.json'), 'utf8'),
    ) as { stopReason: string };
    expect(stored.stopReason).toBe('cancelled');
    expect((await client.executions.get(project.id, run)).verdict).toBe('CANCELLED');

    const refused = await client.explorations.cancel(first.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QaCrawlerError);
    expect((refused as QaCrawlerError).code).toBe('NOT_CANCELLABLE');

    // Une annulation n'est ni une réussite ni un échec : hors du taux de réussite, sans alerte.
    const overview = await client.overview.get({ days: 1 });
    expect(overview.replays.finished).toBe(0);
    expect(overview.replays.passRate).toBeUndefined();
    expect(overview.alerts.filter((alert) => alert.kind === 'EXECUTION_FAILED')).toEqual([]);
  });

  it('openQaCrawler: the service in the process, and close() cancels what is still running', async () => {
    const own = await mkdtemp(path.join(tmpdir(), 'sdk-node-'));
    const qa = await openQaCrawler({ workspace: own, run: fakeRun, env: {} });
    try {
      expect(qa.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const project = await qa.client.projects.create({
        ...engineDefaults(),
        project: { name: 'Admin', targetUrl: 'http://127.0.0.1:9/admin', framework: 'other' },
      });
      const flows = path.join(own, project.id, 'qa-crawler', 'flows');
      await mkdir(flows, { recursive: true });
      await writeFile(path.join(flows, 'login.flow.yaml'), 'name: login\nsteps:\n  - goto: /\n');
      const execution = await qa.client.executions.start(project.id);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await qa.client.explorations.status(execution.id)).status === 'RUNNING') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await Promise.all([qa.close(), qa.close()]);
      // Le moteur a reçu l'annulation et écrit son résultat avant la fermeture.
      const stored = JSON.parse(
        await readFile(path.join(own, project.id, 'qa-reports', execution.run ?? '', 'result.json'), 'utf8'),
      ) as { stopReason: string };
      expect(stored.stopReason).toBe('cancelled');
    } finally {
      await qa.close();
      await rm(own, { recursive: true, force: true });
    }
  });
});
