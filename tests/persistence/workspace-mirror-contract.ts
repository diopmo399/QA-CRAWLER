import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../src/persistence/database/database-adapter.js';
import { FilesystemObjectStore, type ObjectStore } from '../../src/storage/object-store.js';
import { WorkspaceMirror } from '../../src/storage/workspace-mirror.js';
import { StorageLeaseError, WorkspaceRepository } from '../../src/storage/workspace-repository.js';

/**
 * CONTRAT DU MIROIR HYBRIDE : le même pour SQLite, PostgreSQL et SQL Server. Le dossier de travail
 * n'est qu'un cache : envoi, modification, suppression, déduplication des objets, restauration après
 * effacement du disque, dossiers ignorés, bail d'écriture unique. Chaque test a son propre espace :
 * une base partagée (CI) ne mélange rien.
 */
export function workspaceMirrorContract(
  name: string,
  createAdapter: () => DatabaseAdapter,
  createObjects?: (base: string) => ObjectStore,
): void {
  describe(`workspace mirror: ${name}`, () => {
    const opened: WorkspaceMirror[] = [];
    const bases: string[] = [];

    afterEach(async () => {
      for (const mirror of opened.splice(0)) await mirror.stop().catch(() => undefined);
      for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
    });

    async function setup(): Promise<{
      base: string;
      root: string;
      objects: ObjectStore;
      space: string;
      open: (options?: { takeover?: boolean; maxDocumentBytes?: number }) => Promise<WorkspaceMirror>;
    }> {
      const base = await mkdtemp(path.join(tmpdir(), 'qa-mirror-'));
      bases.push(base);
      const root = path.join(base, 'workspace');
      const objects = createObjects?.(base) ?? new FilesystemObjectStore(path.join(base, 'objects'));
      const space = `t-${randomUUID().slice(0, 12)}`;
      const open = async (options: { takeover?: boolean; maxDocumentBytes?: number } = {}) => {
        const repository = new WorkspaceRepository(createAdapter(), space);
        await repository.open({ migrate: true });
        const mirror = new WorkspaceMirror({
          root,
          repository,
          objects,
          intervalMs: 3_600_000,
          settleMs: 0,
          ...options,
        });
        opened.push(mirror);
        return mirror;
      };
      return { base, root, objects, space, open };
    }

    const write = async (root: string, relative: string, data: string | Buffer): Promise<void> => {
      const file = path.join(root, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
    };
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

    it('saves text in the database, binaries in the object store, and restores a wiped workspace', async () => {
      const { root, open } = await setup();
      await write(root, 'p1/project.yaml', 'name: Démo — été\n');
      await write(root, 'p1/reports/r1/result.json', '{"ok":true}');
      await write(root, 'p1/reports/r1/shot.png', PNG);
      await write(root, 'p1/reports/r1/copy.png', PNG);
      await write(
        root,
        'p1/reports/r1/bom.txt',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a')]),
      );
      await write(root, 'p1/reports/r1/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])); // pas de l'UTF-8
      await write(root, '.maven-cache/org/x.jar', Buffer.alloc(64, 7));
      await write(root, 'p1/node_modules/dep/index.js', 'module.exports = 1;');
      const mirror = await open();
      await mirror.start();
      await mirror.sync();
      expect(mirror.status()).toMatchObject({
        state: 'RUNNING',
        stored: { documents: 3, objects: 3 },
        uploaded: 6,
      });
      expect(mirror.status().lastError).toBeUndefined();
      await mirror.stop();
      expect(mirror.status().state).toBe('STOPPED');

      await rm(root, { recursive: true, force: true });
      const again = await open();
      await again.start();
      expect(again.status().restored).toEqual({ documents: 3, objects: 3, missing: 0 });
      expect(await readFile(path.join(root, 'p1/project.yaml'), 'utf8')).toBe('name: Démo — été\n');
      expect([...(await readFile(path.join(root, 'p1/reports/r1/shot.png')))]).toEqual([...PNG]);
      expect([...(await readFile(path.join(root, 'p1/reports/r1/bom.txt')))]).toEqual([
        0xef, 0xbb, 0xbf, 0x61,
      ]);
      expect([...(await readFile(path.join(root, 'p1/reports/r1/latin1.txt')))]).toEqual([
        0x63, 0x61, 0x66, 0xe9,
      ]);
      // Les caches reconstructibles ne sont jamais copiés.
      await expect(readFile(path.join(root, '.maven-cache/org/x.jar'))).rejects.toThrow();
      await expect(readFile(path.join(root, 'p1/node_modules/dep/index.js'))).rejects.toThrow();
    });

    it('propagates edits and deletions, deduplicates identical objects and deletes the last copy only', async () => {
      const { base, root, objects, open } = await setup();
      await write(root, 'a.yaml', 'v: 1\n');
      await write(root, 'one.png', PNG);
      await write(root, 'two.png', PNG);
      const mirror = await open();
      await mirror.start();
      await mirror.sync();
      const keys = async (): Promise<string[]> =>
        objects instanceof FilesystemObjectStore
          ? (await readdir(path.join(base, 'objects'), { recursive: true }))
              .map(String)
              .filter((f) => /[0-9a-f]{64}$/.test(f))
          : [];
      if (objects instanceof FilesystemObjectStore) expect(await keys()).toHaveLength(1);

      await write(root, 'a.yaml', 'v: 2\n');
      await rm(path.join(root, 'one.png'));
      await mirror.sync();
      expect(mirror.status()).toMatchObject({ stored: { documents: 1, objects: 1 }, deleted: 1 });
      if (objects instanceof FilesystemObjectStore) expect(await keys()).toHaveLength(1);

      await rm(path.join(root, 'two.png'));
      await mirror.sync();
      expect(mirror.status().stored).toMatchObject({ documents: 1, objects: 0 });
      if (objects instanceof FilesystemObjectStore) expect(await keys()).toHaveLength(0);
      await mirror.stop();

      await rm(root, { recursive: true, force: true });
      const again = await open();
      await again.start();
      expect(await readFile(path.join(root, 'a.yaml'), 'utf8')).toBe('v: 2\n');
      expect(await readdir(root)).toEqual(['a.yaml']);
    });

    it('moves a text file to the object store above the document size, and back', async () => {
      const { root, open } = await setup();
      await write(root, 'log.txt', 'x'.repeat(100));
      const mirror = await open({ maxDocumentBytes: 50 });
      await mirror.start();
      await mirror.sync();
      expect(mirror.status().stored).toMatchObject({ documents: 0, objects: 1 });
      await write(root, 'log.txt', 'short');
      await mirror.sync();
      expect(mirror.status().stored).toMatchObject({ documents: 1, objects: 0 });
    });

    it('waits for a file still being written, and saves it at stop', async () => {
      const { root, space } = await setup();
      const repository = new WorkspaceRepository(createAdapter(), space);
      await repository.open({ migrate: true });
      const mirror = new WorkspaceMirror({
        root,
        repository,
        objects: new FilesystemObjectStore(path.join(root, '..', 'objects')),
        intervalMs: 3_600_000,
        settleMs: 60_000,
      });
      opened.push(mirror);
      await mirror.start();
      await write(root, 'fresh.json', '{}');
      await mirror.sync();
      expect(mirror.status()).toMatchObject({ pending: 1, stored: { documents: 0 } });
      await mirror.stop();
      expect(mirror.status().stored.documents).toBe(1);
    });

    it('keeps the durable content when the local copy differs at start (the database wins)', async () => {
      const { root, open } = await setup();
      await write(root, 'a.yaml', 'durable\n');
      const mirror = await open();
      await mirror.start();
      await mirror.stop();
      await write(root, 'a.yaml', 'stale local copy\n');
      const again = await open();
      await again.start();
      expect(await readFile(path.join(root, 'a.yaml'), 'utf8')).toBe('durable\n');
      expect(again.status().restored.documents).toBe(1);
    });

    it('refuses a second writer, accepts a takeover, and the old writer stops saving (LEASE_LOST)', async () => {
      const { root, open } = await setup();
      await write(root, 'a.yaml', 'v: 1\n');
      const first = await open();
      await first.start();
      await first.sync();

      const second = await open();
      const refusal = await second.start().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(StorageLeaseError);
      expect((refusal as Error).message).toContain('--storage-takeover');
      await second.stop();

      const taker = await open({ takeover: true });
      await taker.start();
      await write(root, 'a.yaml', 'v: 2 (written by the old server)\n');
      await first.sync();
      expect(first.status().state).toBe('LEASE_LOST');
      expect(first.status().lastError).toContain('lease');
      await first.stop();
      expect(first.status().state).toBe('LEASE_LOST');

      // L'ancien serveur n'a rien écrit et n'a pas rendu le bail du nouveau.
      const third = await open();
      await expect(third.start()).rejects.toBeInstanceOf(StorageLeaseError);
      await third.stop();
      await taker.stop();
      const after = await open();
      await after.start();
      await after.stop();
    });

    it('a lease expires: a server that crashed does not block the next one forever', async () => {
      const { space } = await setup();
      const repository = new WorkspaceRepository(createAdapter(), space);
      await repository.open({ migrate: true });
      try {
        await repository.acquireLease('crashed', -1_000);
        await repository.acquireLease('next', 60_000);
        expect(await repository.holdsLease('next')).toBe(true);
        expect(await repository.holdsLease('crashed')).toBe(false);
        await expect(repository.acquireLease('crashed', 60_000)).rejects.toBeInstanceOf(StorageLeaseError);
        await repository.releaseLease('next');
        await repository.acquireLease('crashed', 60_000);
        await repository.releaseLease('crashed');
      } finally {
        await repository.close();
      }
    });

    it('a failed start releases the lease at once', async () => {
      const { root, open, space } = await setup();
      const repository = new WorkspaceRepository(createAdapter(), space);
      await repository.open({ migrate: true });
      const broken: ObjectStore = {
        kind: 'filesystem',
        describe: () => 'broken',
        put: () => Promise.reject(new Error('down')),
        get: () => Promise.reject(new Error('down')),
        delete: () => Promise.reject(new Error('down')),
        healthCheck: () => Promise.reject(new Error('the object store does not answer')),
      };
      const mirror = new WorkspaceMirror({ root, repository, objects: broken, settleMs: 0 });
      await expect(mirror.start()).rejects.toThrow('does not answer');
      await mirror.stop();
      const next = await open();
      await next.start();
      expect(next.status().state).toBe('RUNNING');
    });

    it('stop reports a last save that failed', async () => {
      const { root, space } = await setup();
      const repository = new WorkspaceRepository(createAdapter(), space);
      await repository.open({ migrate: true });
      let fail = false;
      const store = new FilesystemObjectStore(path.join(root, '..', 'objects'));
      const flaky: ObjectStore = {
        kind: 'filesystem',
        describe: () => store.describe(),
        put: (key, body) => (fail ? Promise.reject(new Error('quota exceeded')) : store.put(key, body)),
        get: (key) => store.get(key),
        delete: (key) => store.delete(key),
        healthCheck: () => store.healthCheck(),
      };
      const warnings: string[] = [];
      const mirror = new WorkspaceMirror({
        root,
        repository,
        objects: flaky,
        settleMs: 0,
        intervalMs: 3_600_000,
        onWarning: (message) => warnings.push(message),
      });
      await mirror.start();
      fail = true;
      await write(root, 'shot.png', PNG);
      await expect(mirror.stop()).rejects.toThrow('quota exceeded');
      expect(warnings.join('\n')).toContain('shot.png');
    });
  });
}
