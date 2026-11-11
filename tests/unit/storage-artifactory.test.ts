import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSdkServerArgs } from '../../src/cli/sdk-server-command.js';
import { SqliteAdapter } from '../../src/persistence/database/sqlite/sqlite-adapter.js';
import { ArtifactoryStore } from '../../src/storage/artifactory-store.js';
import { createObjectStore } from '../../src/storage/hybrid-storage.js';
import { startFakeArtifactory, type FakeArtifactory } from '../fixtures/fake-artifactory.js';
import { workspaceMirrorContract } from '../persistence/workspace-mirror-contract.js';

/**
 * Le stockage objet Artifactory contre un Artifactory SIMULÉ (tests/fixtures/fake-artifactory.ts) :
 * authentification, empreintes vérifiées au déploiement, droits de déploiement et de suppression.
 * Un vrai Artifactory : tests/integration/storage-object-stores.test.ts (QA_TEST_ARTIFACTORY_*).
 */
let fake: FakeArtifactory;
const users = [
  { token: 'token-full', canDeploy: true, canDelete: true },
  { username: 'qa', password: 'p:ss', canDeploy: true, canDelete: true },
  { token: 'token-no-delete', canDeploy: true, canDelete: false },
  { token: 'token-read-only' },
];

beforeAll(async () => {
  fake = await startFakeArtifactory({ repositories: ['qa-objects'], users });
});
afterAll(async () => {
  await fake.close();
});

const store = (auth: { token: string } | { username: string; password: string }, repository = 'qa-objects') =>
  new ArtifactoryStore({ url: fake.url, repository, prefix: 'qa/', auth });

describe('Artifactory object store (simulated Artifactory)', () => {
  it('deploys with checksums, downloads, deletes; absent is undefined', async () => {
    const objects = store({ token: 'token-full' });
    await objects.healthCheck();
    const body = Buffer.from([0, 1, 2, 0xff]);
    await objects.put('space/objects/ab/abc', body, 'image/png');
    expect([...(fake.files.get('qa-objects/qa/space/objects/ab/abc') ?? [])]).toEqual([...body]);
    expect([...((await objects.get('space/objects/ab/abc')) ?? [])]).toEqual([...body]);
    expect(await objects.get('space/objects/ab/none')).toBeUndefined();
    await objects.delete('space/objects/ab/abc');
    await objects.delete('space/objects/ab/abc');
    expect(await objects.get('space/objects/ab/abc')).toBeUndefined();
    // Le fichier de contrôle du démarrage a été retiré.
    expect([...fake.files.keys()].filter((key) => key.includes('.probe'))).toEqual([]);
    expect(objects.describe()).toBe(`${fake.url}/qa-objects/qa/`);
  });

  it('Basic authentication (user and password or identity token)', async () => {
    const objects = store({ username: 'qa', password: 'p:ss' });
    await objects.healthCheck();
    await objects.put('k', Buffer.from('x'));
    expect((await objects.get('k'))?.toString()).toBe('x');
  });

  it('refusals are clear and carry no secret', async () => {
    const wrong = await store({ token: 'wrong-secret' })
      .put('k', Buffer.from('x'))
      .catch((e: unknown) => e as Error);
    expect((wrong as Error).message).toBe('Artifactory deploy failed: HTTP 401 (Bad credentials)');
    expect((wrong as Error).message).not.toContain('wrong-secret');
    await expect(store({ token: 'token-full' }, 'missing-repo').healthCheck()).rejects.toThrow(
      'Artifactory repository missing-repo failed: HTTP 404',
    );
  });

  it('the start check needs the deploy AND delete rights', async () => {
    await expect(store({ token: 'token-read-only' }).healthCheck()).rejects.toThrow(
      'Artifactory deploy failed: HTTP 403 (Not enough permissions to deploy)',
    );
    await expect(store({ token: 'token-no-delete' }).healthCheck()).rejects.toThrow(
      'Artifactory delete failed: HTTP 403 (Not enough permissions to delete)',
    );
  });

  it('a body altered on the way is refused by the checksum check', async () => {
    const tampering: typeof fetch = (input, init) =>
      fetch(input, init?.body ? { ...init, body: Uint8Array.from(Buffer.from('tampered')) } : init);
    const objects = new ArtifactoryStore({
      url: fake.url,
      repository: 'qa-objects',
      auth: { token: 'token-full' },
      fetch: tampering,
    });
    await expect(objects.put('k2', Buffer.from('original'))).rejects.toThrow('HTTP 409');
  });

  it('credentials come from the environment, and say which are missing', () => {
    const options = { provider: 'artifactory' as const, url: fake.url, repository: 'qa-objects' };
    expect(() => createObjectStore(options, {})).toThrow('QA_OBJECTS_TOKEN');
    expect(createObjectStore(options, { QA_OBJECTS_TOKEN: 't' }).kind).toBe('artifactory');
    expect(createObjectStore(options, { QA_OBJECTS_USERNAME: 'u', QA_OBJECTS_PASSWORD: 'p' }).kind).toBe(
      'artifactory',
    );
    expect(() => new ArtifactoryStore({ ...options, repository: '../x', auth: { token: 't' } })).toThrow(
      'repository key',
    );
  });

  it('qa-crawler sdk-server --objects artifactory', () => {
    const base = [
      '--workspace',
      'w',
      '--storage',
      'hybrid',
      '--storage-db',
      'postgres',
      '--objects',
      'artifactory',
    ];
    expect(
      parseSdkServerArgs([
        ...base,
        '--objects-url',
        'https://artifactory.example.test/artifactory',
        '--objects-repository',
        'qa-crawler-objects',
        '--objects-prefix',
        'staging',
      ]).storage?.objects,
    ).toEqual({
      provider: 'artifactory',
      url: 'https://artifactory.example.test/artifactory',
      repository: 'qa-crawler-objects',
      prefix: 'staging/',
    });
    expect(() => parseSdkServerArgs(base)).toThrow('--objects-url and --objects-repository');
    expect(() =>
      parseSdkServerArgs([...base, '--objects-url', 'ftp://x', '--objects-repository', 'r']),
    ).toThrow('--objects-url must be an http(s) URL');
  });
});

// Le miroir complet (SQLite + Artifactory simulé) : le même contrat que les autres stockages.
const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-mirror-artifactory-')), 'qa.db');
workspaceMirrorContract(
  'SQLite + Artifactory (simulated)',
  () => new SqliteAdapter({ engine: 'sqlite', file, connectTimeoutMs: 5000, trustServerCertificate: false }),
  () => store({ token: 'token-full' }),
);
