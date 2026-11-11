import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSdkServerCli } from '../../src/cli/sdk-server-command.js';
import { createQaCrawler, QaCrawlerError, type ProjectDraft } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import type { HybridStorageOptions } from '../../src/storage/hybrid-storage.js';

/**
 * LE SERVEUR DU SDK EN STOCKAGE HYBRIDE (SQLite + dossier d'objets). Le dossier de travail n'est qu'un
 * cache : un projet créé par l'API, une capture binaire déposée dans le projet, l'arrêt du serveur, le
 * dossier effacé (un conteneur éphémère remplacé), un nouveau serveur : le projet et la capture sont là.
 */
let base: string;
let workspace: string;
let storage: HybridStorageOptions;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const draft = (name: string): ProjectDraft => ({
  ...engineDefaults(),
  project: { name, targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
});

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'sdk-hybrid-'));
  workspace = path.join(base, 'workspace');
  storage = {
    database: { type: 'sqlite', file: path.join(base, 'state', 'qa.db') },
    objects: { provider: 'filesystem', directory: path.join(base, 'objects') },
    intervalMs: 3_600_000,
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('SDK server with hybrid storage', () => {
  let server: RunningSdkServer | undefined;

  afterAll(async () => {
    await server?.close().catch(() => undefined);
  });

  it('a project survives the loss of the workspace', async () => {
    server = await startSdkServer({ workspace, storage });
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    expect(await client.storage.status()).toMatchObject({
      mode: 'hybrid',
      space: 'default',
      state: 'RUNNING',
      restored: { documents: 0, objects: 0, missing: 0 },
    });
    const project = await client.projects.create(draft('Hybride'));
    await writeFile(path.join(workspace, project.id, 'capture.png'), PNG);
    const synced = await client.storage.sync();
    expect(synced).toMatchObject({ mode: 'hybrid', state: 'RUNNING', pending: 0 });
    if (synced.mode !== 'hybrid') throw new Error('hybrid expected');
    expect(synced.stored.documents).toBeGreaterThan(0);
    expect(synced.stored.objects).toBe(1);
    expect(synced.lastSyncAt).toBeDefined();
    expect(synced.lastError).toBeUndefined();
    client.dispose();
    await server.close();
    server = undefined;

    // Le conteneur est remplacé : plus rien sur le disque.
    await rm(workspace, { recursive: true, force: true });
    server = await startSdkServer({ workspace, storage });
    const again = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    const status = await again.storage.status();
    expect(status).toMatchObject({ mode: 'hybrid', state: 'RUNNING' });
    if (status.mode !== 'hybrid') throw new Error('hybrid expected');
    expect(status.restored.objects).toBe(1);
    expect(status.restored.missing).toBe(0);
    expect((await again.projects.list()).map((p) => p.name)).toContain('Hybride');
    expect((await again.projects.get(project.id)).name).toBe('Hybride');
    expect(await readdir(path.join(workspace, project.id))).toContain('capture.png');
    again.dispose();
    await server.close();
    server = undefined;
  }, 60_000);

  it('a second server on the same space is refused while the first runs', async () => {
    server = await startSdkServer({ workspace, storage });
    const other = path.join(base, 'other-workspace');
    await expect(startSdkServer({ workspace: other, storage })).rejects.toThrow('--storage-takeover');
    await server.close();
    server = undefined;
  }, 60_000);

  it('local storage: the route says so and a sync is refused', async () => {
    const local = await startSdkServer({ workspace: path.join(base, 'local') });
    const client = createQaCrawler({ endpoint: `${local.url}/api`, token: local.token });
    try {
      expect(await client.storage.status()).toEqual({ mode: 'local' });
      const error = (await client.storage.sync().catch((e: unknown) => e)) as QaCrawlerError;
      expect(error).toBeInstanceOf(QaCrawlerError);
      expect(error.code).toBe('STORAGE_LOCAL');
    } finally {
      client.dispose();
      await local.close();
    }
  });
});

describe('qa-crawler sdk-server --storage hybrid', () => {
  it('starts on the restored workspace and saves at stop', async () => {
    const cliWorkspace = path.join(base, 'cli-workspace');
    const args = [
      '--workspace',
      cliWorkspace,
      '--port',
      '0',
      '--quiet',
      '--storage',
      'hybrid',
      '--storage-db',
      'sqlite',
      '--storage-db-file',
      path.join(base, 'cli-state', 'qa.db'),
      '--objects',
      'fs',
      '--objects-dir',
      path.join(base, 'cli-objects'),
      '--storage-space',
      'cli',
    ];
    let stop: () => void = () => undefined;
    let running: RunningSdkServer | undefined;
    const first = runSdkServerCli(args, {
      onStarted: (started) => {
        running = started;
      },
      waitForStop: () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
    });
    await expect.poll(() => running !== undefined, { timeout: 30_000 }).toBe(true);
    expect(running?.storage?.status().space).toBe('cli');
    // Écrit juste avant l'arrêt : c'est le dernier passage (à l'arrêt) qui l'enregistre.
    await writeFile(path.join(cliWorkspace, 'note.txt'), 'saved at stop\n');
    stop();
    expect(await first).toBe(0);

    await rm(cliWorkspace, { recursive: true, force: true });
    running = undefined;
    const second = runSdkServerCli(args, {
      onStarted: (started) => {
        running = started;
      },
      waitForStop: () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
    });
    await expect.poll(() => running !== undefined, { timeout: 30_000 }).toBe(true);
    expect(await readdir(cliWorkspace)).toContain('note.txt');
    stop();
    expect(await second).toBe(0);
  }, 60_000);

  it('an unreachable object store stops the start (exit 3), the lease is released', async () => {
    const blocked = path.join(base, 'blocked-file');
    await writeFile(blocked, 'not a folder');
    const code = await runSdkServerCli(
      [
        '--workspace',
        path.join(base, 'w3'),
        '--port',
        '0',
        '--quiet',
        '--storage',
        'hybrid',
        '--storage-db',
        'sqlite',
        '--storage-db-file',
        path.join(base, 'w3-state', 'qa.db'),
        '--objects',
        'fs',
        '--objects-dir',
        path.join(blocked, 'objects'),
      ],
      { waitForStop: () => Promise.resolve() },
    );
    expect(code).toBe(3);
  }, 60_000);
});
