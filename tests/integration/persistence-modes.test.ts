import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { JsonPersistenceProvider } from '../../src/persistence/file/json-provider.js';

/** Users → Create → formulaire de création ; un bouton « Delete » que la SafetyPolicy bloque. */
const PAGES: Record<string, string> = {
  '/': '<h1>Dashboard</h1><a href="/users">Users</a> <a href="/reports">Reports</a>',
  '/users': '<h1>Users</h1><a href="/users/new">Create</a> <button>Delete</button>',
  '/users/new': '<h1>Create user</h1>',
  '/reports': '<h1>Reports</h1>',
};

describe('persistence and memory, end to end', () => {
  let server: Server;
  let url: string;
  let root: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = PAGES[req.url ?? ''];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body ?? 'Not found'}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(path.join(tmpdir(), 'qa-persistence-e2e-'));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const run = async (
    name: string,
    extra: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<ExplorationResult> => {
    const out = path.join(root, name);
    const { config } = parseConfig(
      `
mission: { name: persistence }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 30, actionTimeoutMs: 3000, settleTimeMs: 50 }
knowledge: { file: ${path.join(out, 'knowledge.json')} }
logging: { decisionTrace: true }
output:
  reportsDir: ${path.join(out, 'reports')}
  screenshotsDir: ${path.join(out, 'screenshots')}
${extra}`,
      {},
      env,
    );
    return (await runMission(config, { env, onWarning: () => undefined })).result;
  };
  /** Ce que le moteur a décidé, dans l'ordre : doit être identique quand la mémoire est éteinte. */
  const decisions = (result: ExplorationResult): string[] =>
    result.transitions.map(
      (edge) => `${edge.from} --${edge.action.text ?? edge.actionId}--> ${edge.to} ${edge.result}`,
    );

  it('persistence OFF: QA-CRAWLER works without any database, nothing is stored', async () => {
    const result = await run('off', '');
    expect(result.stats.states).toBeGreaterThanOrEqual(4);
    expect(result.persistence).toMatchObject({
      enabled: false,
      status: 'DISABLED',
      memory: { mode: 'legacy' },
    });
    const html = await readFile(path.join(root, 'off', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Persistence and memory');
  });

  it('persistence ON + memory OFF: the run is stored, the decisions are exactly those of an isolated run', async () => {
    const directory = path.join(root, 'store');
    const isolated = await run('isolated', 'memory: { enabled: false }');
    const stored = await run(
      'stored',
      `persistence: { enabled: true, provider: file, file: { directory: ${directory} }, flushEvery: 2 }
memory: { enabled: false }`,
    );
    expect(decisions(stored)).toEqual(decisions(isolated));
    expect(stored.persistence).toMatchObject({
      status: 'CONNECTED',
      actual: { provider: 'file', location: directory },
      memory: { mode: 'isolated', historicalTransitionsLoaded: 0 },
    });

    // La persistance, interrogée directement.
    const provider = new JsonPersistenceProvider(directory);
    await provider.initialize();
    const [runRecord] = await provider.runs.list(stored.persistence?.applicationId ?? '', 10);
    expect(runRecord).toMatchObject({ status: 'COMPLETED', mode: 'explore', missionName: 'persistence' });
    expect(runRecord?.statesCount).toBe(stored.stats.states);
    const states = await provider.states.listByRun(runRecord?.id ?? '');
    expect(states.map((state) => state.stateSignature).sort()).toEqual(
      expect.arrayContaining(['dashboard', 'users', 'create-user', 'reports']),
    );
    const transitions = await provider.transitions.listByRun(runRecord?.id ?? '');
    const blocked = transitions.find((transition) => transition.actionLabel === 'Delete');
    expect(blocked).toMatchObject({ status: 'BLOCKED', toStateId: null, safetyDecision: 'BLOCK' });
    const create = transitions.find((transition) => transition.actionLabel === 'Create');
    expect(create).toMatchObject({ status: 'SUCCESS', safetyDecision: 'ALLOW' });
    expect(create?.toStateId).toBeTruthy();
    const knowledge = await provider.knowledge.find(
      stored.persistence?.applicationId ?? '',
      'users',
      'navigate:create',
    );
    expect(knowledge).toEqual([
      expect.objectContaining({ toStateSignature: 'create-user', seenCount: 1, successCount: 1 }),
    ]);
    await provider.close();
  });

  it('persistence ON + memory ON: the history is preloaded into the working memory, and grows run after run', async () => {
    const directory = path.join(root, 'store');
    const extra = `persistence: { enabled: true, provider: file, file: { directory: ${directory} } }
memory: { enabled: true }`;
    const second = await run('memory-1', extra);
    expect(second.persistence?.memory).toMatchObject({ mode: 'historical', historicalKnowledge: true });
    expect(second.persistence?.memory.historicalTransitionsLoaded).toBeGreaterThan(0);
    expect(second.persistence?.memory.newTransitionsLearned).toBe(0);
    const provider = new JsonPersistenceProvider(directory);
    await provider.initialize();
    const [create] = await provider.knowledge.find(
      second.persistence?.applicationId ?? '',
      'users',
      'navigate:create',
    );
    expect(create?.seenCount).toBe(2);
    expect(await provider.runs.list(second.persistence?.applicationId ?? '', 10)).toHaveLength(2);
    await provider.close();
  });

  it('persistence OFF + memory ON: the memory of the current run only', async () => {
    const result = await run('current', 'memory: { enabled: true }');
    expect(result.persistence).toMatchObject({
      status: 'DISABLED',
      memory: { mode: 'current-run', historicalTransitionsLoaded: 0 },
    });
  });

  it('database unavailable + failureMode fallback: the crawl goes on with the file provider, and the report says so', async () => {
    const directory = path.join(root, 'fallback');
    const result = await run(
      'fallback',
      `persistence:
  enabled: true
  provider: database
  database: { type: sqlserver, connectTimeoutMs: 1000 }
  failureMode: fallback
  fallback: { provider: file, directory: ${directory} }`,
      {
        QA_DB_HOST: '127.0.0.1',
        QA_DB_PORT: '9',
        QA_DB_USERNAME: 'qa',
        QA_DB_PASSWORD: 'fallback-secret-3k',
      },
    );
    expect(result.stats.states).toBeGreaterThanOrEqual(4);
    expect(result.persistence).toMatchObject({
      status: 'FALLBACK',
      configured: { provider: 'database', database: 'SQL Server' },
      actual: { provider: 'file', location: directory },
    });
    expect(result.persistence?.reason).toMatch(/SQL Server connection failed/);
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(['crawl-runs.json', 'transition-knowledge.json']),
    );
    const html = await readFile(path.join(root, 'fallback', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('database (SQL Server)');
    expect(html).toContain('file');
    const json = await readFile(path.join(root, 'fallback', 'reports', 'result.json'), 'utf8');
    expect(json + html).not.toContain('fallback-secret-3k');
  });

  it('database unavailable + failureMode fail: the run stops with a clear error', async () => {
    await expect(
      run(
        'fail',
        `persistence:
  enabled: true
  provider: database
  database: { type: postgres, connectTimeoutMs: 1000 }
  failureMode: fail`,
        { QA_DB_HOST: '127.0.0.1', QA_DB_PORT: '9' },
      ),
    ).rejects.toThrow(/persistence PostgreSQL unavailable/);
  });
});
