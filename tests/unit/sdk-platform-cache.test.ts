import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import {
  flowsDirOf,
  listExecutions,
  listScenarios,
  runDigest,
  scenarioHistory,
} from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * CE QUI SE RELIT À CHAQUE ÉCRAN EST GARDÉ, JAMAIS PÉRIMÉ : les résumés des runs et les flows des
 * scénarios ne sont relus que si leur fichier change (date de modification, taille). Un résultat
 * réécrit, un run qui se termine, un scénario modifié ou supprimé se voient à la lecture suivante. Un
 * fichier modifié il y a moins de deux secondes est toujours relu (les dates du système de fichiers sont
 * trop grossières pour distinguer deux écritures rapprochées de même taille).
 */
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let projectDir: string;
let reportsDir: string;

const RUN = 'run-2026-10-01T10-00-00-000Z';

/** Écrit un fichier daté de `when` (secondes écoulées, ou une date) : un fichier ancien est gardé, un récent relu. */
async function write(file: string, text: string, when: number | Date): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  const at = when instanceof Date ? when : new Date(Date.now() - when * 1000);
  await utimes(file, at, at);
}

async function writeRun(
  run: string,
  files: { meta?: object; result?: object },
  when: number | Date = 60,
): Promise<void> {
  const directory = path.join(reportsDir, run);
  if (files.meta) await write(path.join(directory, 'execution.json'), JSON.stringify(files.meta), when);
  if (files.result) await write(path.join(directory, 'result.json'), JSON.stringify(files.result), when);
}

const result = (status: 'PASSED' | 'FAILED', critical = 0): object => ({
  startedAt: '2026-10-01T10:00:00.000Z',
  durationMs: 1200,
  stopReason: 'flows-only',
  stats: { issuesBySeverity: { CRITICAL: critical, MAJOR: 0, MINOR: 0, INFO: 0 } },
  flows: [{ name: 'Chercher un livre', status, durationMs: 800 }],
  issues: [],
});

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-platform-cache-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Lectures gardées', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  projectDir = path.join(workspace, project.id);
  reportsDir = path.join(projectDir, 'qa-reports');
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK platform — runs read again only when they change', () => {
  it('sees a run finish, its result rewritten, then removed', async () => {
    await writeRun(RUN, { meta: { kind: 'REPLAY', startedAt: '2026-10-01T10:00:00.000Z' } });
    expect((await listExecutions(project.id, reportsDir))[0]?.verdict).toBe('INCOMPLETE');

    await writeRun(RUN, { result: result('PASSED') });
    expect((await client.executions.list(project.id))[0]).toMatchObject({
      run: RUN,
      verdict: 'PASSED',
      flows: { total: 1, passed: 1, failed: 0 },
    });
    expect((await scenarioHistory(project.id, reportsDir, 10))[0]?.runs[0]?.status).toBe('PASSED');

    // Même taille, autre contenu : la date de modification suffit à le voir.
    await writeRun(RUN, { result: result('FAILED') }, 30);
    expect((await listExecutions(project.id, reportsDir))[0]?.verdict).toBe('FAILED');
    expect((await scenarioHistory(project.id, reportsDir, 10))[0]?.runs[0]?.status).toBe('FAILED');

    await writeRun(RUN, { result: result('FAILED', 2) }, 20);
    expect((await runDigest(project.id, reportsDir, RUN)).issuesBySeverity.CRITICAL).toBe(2);
    const overview = await client.overview.get({ days: 3650 });
    expect(overview.alerts.some((alert) => alert.kind === 'CRITICAL_ISSUES' && alert.run === RUN)).toBe(true);

    await rm(path.join(reportsDir, RUN), { recursive: true });
    expect(await listExecutions(project.id, reportsDir)).toEqual([]);
  });

  it('reads a run written just now again, even when its date and size have not changed', async () => {
    const meta = { kind: 'REPLAY', startedAt: '2026-10-01T10:00:00.000Z' };
    const now = new Date(Date.now() - 500);
    await writeRun(RUN, { meta, result: result('PASSED') }, now);
    expect((await listExecutions(project.id, reportsDir))[0]?.verdict).toBe('PASSED');
    // Même date, même taille : seule une relecture le voit.
    await writeRun(RUN, { meta, result: result('FAILED') }, now);
    expect((await listExecutions(project.id, reportsDir))[0]?.verdict).toBe('FAILED');
    await rm(path.join(reportsDir, RUN), { recursive: true });
  });
});

describe('SDK platform — scenarios read again only when their file changes', () => {
  it('sees a flow renamed, a file added and a file removed, with a new revision', async () => {
    const flows = await flowsDirOf(projectDir);
    const file = path.join(flows, 'catalogue/chercher.flow.yaml');
    await write(file, 'flows:\n  - name: Chercher\n    steps:\n      - goto: /\n', 60);
    const before = await listScenarios(projectDir);
    expect(before.map((scenario) => scenario.name)).toEqual(['Chercher']);

    // Même taille : la date de modification suffit à le voir.
    await write(file, 'flows:\n  - name: Trouver\n    steps:\n      - goto: /\n', 30);
    const after = await listScenarios(projectDir);
    expect(after.map((scenario) => scenario.name)).toEqual(['Trouver']);
    expect(after[0]?.revision).not.toBe(before[0]?.revision);

    await write(
      path.join(flows, 'catalogue/ouvrir.flow.yaml'),
      'flows:\n  - name: Ouvrir\n    steps: []\n',
      60,
    );
    expect((await client.projects.detail(project.id)).scenarios.map((scenario) => scenario.name)).toEqual([
      'Trouver',
      'Ouvrir',
    ]);

    await rm(file);
    expect((await listScenarios(projectDir)).map((scenario) => scenario.name)).toEqual(['Ouvrir']);
  });

  it('reads a flow written just now again, even when its date and size have not changed', async () => {
    const file = path.join(await flowsDirOf(projectDir), 'catalogue/ouvrir.flow.yaml');
    const now = new Date(Date.now() - 500);
    await write(file, 'flows:\n  - name: Ouvrir\n    steps: []\n', now);
    expect((await listScenarios(projectDir)).map((scenario) => scenario.name)).toEqual(['Ouvrir']);
    await write(file, 'flows:\n  - name: Fermer\n    steps: []\n', now);
    expect((await listScenarios(projectDir)).map((scenario) => scenario.name)).toEqual(['Fermer']);
  });
});
