import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BaselineMetadata } from '../../src/baseline/baseline-store.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { MissionMode } from '../../src/config/config.js';
import { BaselineMissingError, runMission, type RunOutcome } from '../../src/orchestrator.js';

/** La même application, avant et après une livraison. */
let version = 1;
const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const pages = (): Record<string, string> => ({
  '/': page(
    'Dashboard',
    `<h1>Dashboard</h1><a href="/users">Users</a> <a href="/settings">Settings</a>${version === 2 ? ' <a href="/audit">Audit</a>' : ''}`,
  ),
  '/users': page(
    'Users',
    `<h1>Users</h1><button onclick="openForm()">User form</button>
     <div id="form" role="dialog" aria-label="User form" style="display:none"><h2>User form</h2></div>
     <div id="error" role="alertdialog" aria-label="Error" style="display:none"><h2>Error</h2></div>
     <script>async function openForm() {
       const response = await fetch('/api/roles');
       document.getElementById(response.ok ? 'form' : 'error').style.display = 'block';
     }</script>`,
  ),
  '/settings': page(
    'Settings',
    `<h1>Settings</h1>${version === 1 ? '<a href="/settings/permissions">Permissions</a>' : ''}`,
  ),
  '/settings/permissions': page('Permissions', '<h1>Permissions</h1>'),
  '/audit': page('Audit', '<h1>Audit</h1>'),
});

describe('learn → verify → explore', () => {
  let server: Server;
  let url: string;
  let root: string;
  let baselineDir: string;

  const run = async (mode: MissionMode, name: string): Promise<RunOutcome> => {
    const { config } = parseConfig(
      `
mission: { name: example }
target: { baseUrl: ${url} }
exploration: { maxStates: 20, maxActions: 30, actionTimeoutMs: 3000, settleTimeMs: 150 }
report: { failOnSeverity: NONE }
baseline: { dir: ${baselineDir}, environment: qa }
output:
  reportsDir: ${path.join(root, name, 'reports')}
  screenshotsDir: ${path.join(root, name, 'screenshots')}
`,
      {},
      {},
    );
    return runMission(config, { mode, env: { QA_BRANCH: 'main', QA_COMMIT: '1a2b3c4d5e6f7a8b' } });
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/roles') {
        res.writeHead(version === 1 ? 200 : 500, { 'content-type': 'application/json' });
        res.end('[]');
        return;
      }
      const body = pages()[req.url ?? ''];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(path.join(tmpdir(), 'qa-modes-'));
    baselineDir = path.join(root, 'baseline');
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('verify without a baseline asks to learn first', async () => {
    await expect(run('verify', 'no-baseline')).rejects.toBeInstanceOf(BaselineMissingError);
  });

  it('learn stores a versioned baseline with its metadata', async () => {
    version = 1;
    const { result } = await run('learn', 'learn');
    expect(result.mode).toBe('learn');
    expect(result.learnedBaseline).toMatchObject({
      application: 'example',
      branch: 'main',
      commit: '1a2b3c4d5e6f7a8b',
      environment: 'qa',
      states: 5,
    });
    const metadata = JSON.parse(
      await readFile(path.join(baselineDir, 'metadata.json'), 'utf8'),
    ) as BaselineMetadata;
    expect(metadata.runId).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ-1a2b3c4$/);
    expect(await readdir(path.join(baselineDir, 'runs'))).toEqual([metadata.runId]);
    const labels = result.states.map((state) => state.label).sort();
    expect(labels).toEqual(['dashboard', 'permissions', 'settings', 'users', 'users-user-form']);
  });

  it('verify on the same version: every known transition still leads where it did', async () => {
    version = 1;
    const outcome = await run('verify', 'verify-same');
    const verification = outcome.result.verification;
    // Users, Settings, User form, Permissions — et User form à nouveau, depuis le formulaire ouvert (même état).
    expect(verification?.transitions.length).toBe(5);
    expect(verification?.regressions).toBe(0);
    expect(verification?.summary.PASSED).toBe(5);
    expect(outcome.passed).toBe(true);
    expect(outcome.result.flowDiff?.summary).toEqual({
      addedStates: 0,
      removedStates: 0,
      addedTransitions: 0,
      removedTransitions: 0,
      changedTransitions: 0,
    });
  });

  it('verify after a release: reports the regressions and fails', async () => {
    version = 2;
    const outcome = await run('verify', 'verify-release');
    const statuses = (outcome.result.verification?.transitions ?? []).map(
      (v) => `${v.fromLabel} → ${v.action.text ?? ''}: ${v.status}`,
    );
    expect(statuses).toEqual([
      'dashboard → Users: PASSED',
      'dashboard → Settings: PASSED',
      'users → User form: CHANGED',
      'settings → Permissions: ACTION_MISSING',
      'users-user-form → User form: UNREACHABLE',
    ]);
    expect(outcome.regressions).toBe(3);
    expect(outcome.passed).toBe(false);
    const changed = outcome.result.flowDiff?.changedTransitions[0];
    expect(changed?.changes).toEqual([
      'target: users-user-form → users-error',
      'network: + GET /api/roles 5xx, - GET /api/roles 2xx',
    ]);
    expect(outcome.result.flowDiff?.removedStates.map((state) => state.label).sort()).toEqual([
      'permissions',
      'users-user-form',
    ]);
    await expect(
      readFile(path.join(root, 'verify-release', 'reports', 'flow-diff.json'), 'utf8'),
    ).resolves.toContain('changedTransitions');
  });

  it('explore after a release: finds the new ground, the baseline being only a hint', async () => {
    version = 2;
    const { result } = await run('explore', 'explore');
    expect(result.mode).toBe('explore');
    expect(result.baseline?.environment).toBe('qa');
    expect(result.flowDiff?.addedStates.map((state) => state.label)).toEqual(
      expect.arrayContaining(['audit']),
    );
    // explore ne remplace jamais la baseline.
    expect((await readdir(path.join(baselineDir, 'runs'))).length).toBe(1);
  });
});
