import { mkdtempSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSdkServerArgs } from '../../src/cli/sdk-server-command.js';
import { rightFor } from '../../src/sdk/server/access.js';
import { SqliteAdapter } from '../../src/persistence/database/sqlite/sqlite-adapter.js';
import { AzureBlobStore, sharedKeyAuthorization } from '../../src/storage/azure-blob-store.js';
import { createObjectStore } from '../../src/storage/hybrid-storage.js';
import { assertObjectKey, FilesystemObjectStore } from '../../src/storage/object-store.js';
import { S3ObjectStore, signV4 } from '../../src/storage/s3-object-store.js';
import { documentText } from '../../src/storage/workspace-mirror.js';
import { workspaceMirrorContract } from '../persistence/workspace-mirror-contract.js';

// Le miroir sur SQLite (node:sqlite, sans serveur) ; PostgreSQL et SQL Server dans les tests d'intégration.
const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-mirror-sqlite-')), 'qa.db');
workspaceMirrorContract(
  'SQLite',
  () => new SqliteAdapter({ engine: 'sqlite', file, connectTimeoutMs: 5000, trustServerCertificate: false }),
);

/** Un fetch enregistreur : chaque requête est notée, la réponse vient du test. */
function recorder(answer: (url: URL, init: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: { url: URL; method: string; headers: Record<string, string>; body?: Buffer }[];
} {
  const calls: { url: URL; method: string; headers: Record<string, string>; body?: Buffer }[] = [];
  const fake = ((input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = { ...(init.headers as Record<string, string>) };
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      ...(init.body ? { body: Buffer.from(init.body as Uint8Array) } : {}),
    });
    return Promise.resolve(answer(url, init));
  }) as typeof fetch;
  return { fetch: fake, calls };
}

describe('S3 Signature Version 4 (vectors published by AWS)', () => {
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const date = new Date('2013-05-24T00:00:00Z');
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('GET object with a range', () => {
    const signed = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY,
      region: 'us-east-1',
      service: 's3',
      credentials,
      date,
    });
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(signed['x-amz-date']).toBe('20130524T000000Z');
  });

  it('PUT object with an encoded key and a signed x-amz header', () => {
    const signed = signV4({
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      region: 'us-east-1',
      service: 's3',
      credentials,
      date,
    });
    expect(signed.authorization).toContain(
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('GET bucket lifecycle (empty query value)', () => {
    const signed = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      headers: {},
      payloadHash: EMPTY,
      region: 'us-east-1',
      service: 's3',
      credentials,
      date,
    });
    expect(signed.authorization).toContain(
      'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('a session token is sent and signed', () => {
    const signed = signV4({
      method: 'GET',
      url: new URL('https://b.s3.amazonaws.com/k'),
      headers: {},
      payloadHash: EMPTY,
      region: 'eu-west-3',
      service: 's3',
      credentials: { ...credentials, sessionToken: 'session-token' },
      date,
    });
    expect(signed['x-amz-security-token']).toBe('session-token');
    expect(signed.authorization).toContain('x-amz-security-token');
  });
});

describe('S3ObjectStore (requests)', () => {
  const credentials = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-never-shown' };

  it('path-style addressing with an endpoint, prefix and encoded keys; 404 is "absent"', async () => {
    const { fetch, calls } = recorder((url, init) =>
      init.method === 'GET' && url.pathname.endsWith('missing')
        ? new Response('', { status: 404 })
        : new Response('ok'),
    );
    const store = new S3ObjectStore({
      bucket: 'qa-bucket',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      prefix: 'qa/',
      credentials,
      fetch,
    });
    await store.put('space/objects/ab/é f', Buffer.from('data'), 'image/png');
    expect(calls[0]?.url.href).toBe('http://127.0.0.1:9000/qa-bucket/qa/space/objects/ab/%C3%A9%20f');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers['content-type']).toBe('image/png');
    expect(calls[0]?.headers['x-amz-content-sha256']).toBe(
      '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
    );
    expect(calls[0]?.body?.toString()).toBe('data');
    expect(await store.get('space/missing')).toBeUndefined();
    expect((await store.get('space/present'))?.toString()).toBe('ok');
    await store.delete('space/missing');
    await store.healthCheck();
    expect(calls.at(-1)?.method).toBe('HEAD');
    expect(calls.at(-1)?.url.href).toBe('http://127.0.0.1:9000/qa-bucket');
    expect(store.describe()).not.toContain('secret');
  });

  it('virtual-hosted addressing on AWS', async () => {
    const { fetch, calls } = recorder(() => new Response('ok'));
    const store = new S3ObjectStore({ bucket: 'qa-bucket', region: 'eu-west-3', credentials, fetch });
    await store.put('k/v', Buffer.from('x'));
    expect(calls[0]?.url.href).toBe('https://qa-bucket.s3.eu-west-3.amazonaws.com/k/v');
    expect(calls[0]?.headers.authorization).toContain('/eu-west-3/s3/aws4_request');
  });

  it('a refusal names the S3 error code, never the secret', async () => {
    const { fetch } = recorder(
      () =>
        new Response(
          '<Error><Code>SignatureDoesNotMatch</Code><Message>secret-never-shown</Message></Error>',
          {
            status: 403,
          },
        ),
    );
    const store = new S3ObjectStore({ bucket: 'b', region: 'us-east-1', credentials, fetch });
    const error = (await store.put('k', Buffer.from('x')).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('S3 PUT failed: HTTP 403 SignatureDoesNotMatch');
    await expect(store.healthCheck()).rejects.toThrow('S3 bucket b failed: HTTP 403');
  });
});

describe('Azure Blob Storage', () => {
  // La clé de l'émulateur Azurite, publique et documentée.
  const accountKey =
    'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

  it('Shared Key: canonical headers and resource (account twice with the emulator)', () => {
    const url = new URL('http://127.0.0.1:10000/devstoreaccount1/qa/a/b.png?comp=metadata&restype=x');
    const headers = {
      'x-ms-date': 'Fri, 06 Nov 2026 10:00:00 GMT',
      'x-ms-version': '2021-08-06',
      'x-ms-blob-type': 'BlockBlob',
      'content-length': '4',
      'content-type': 'image/png',
    };
    const a = sharedKeyAuthorization({
      method: 'PUT',
      url,
      headers,
      accountName: 'devstoreaccount1',
      accountKey,
    });
    expect(a).toMatch(/^SharedKey devstoreaccount1:[A-Za-z0-9+/]{43}=$/);
    // Déterministe, et sensible à chaque partie signée.
    expect(
      sharedKeyAuthorization({ method: 'PUT', url, headers, accountName: 'devstoreaccount1', accountKey }),
    ).toBe(a);
    expect(
      sharedKeyAuthorization({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': 'text/plain' },
        accountName: 'devstoreaccount1',
        accountKey,
      }),
    ).not.toBe(a);
    // L'ordre des en-têtes x-ms-* ne change rien (ils sont triés).
    const reordered = Object.fromEntries(Object.entries(headers).reverse());
    expect(
      sharedKeyAuthorization({
        method: 'PUT',
        url,
        headers: reordered,
        accountName: 'devstoreaccount1',
        accountKey,
      }),
    ).toBe(a);
    // Une longueur nulle est signée comme une chaîne vide.
    expect(
      sharedKeyAuthorization({
        method: 'GET',
        url,
        headers: { ...headers, 'content-length': '0' },
        accountName: 'devstoreaccount1',
        accountKey,
      }),
    ).toBe(
      sharedKeyAuthorization({
        method: 'GET',
        url,
        headers: { ...headers, 'content-length': '' },
        accountName: 'devstoreaccount1',
        accountKey,
      }),
    );
  });

  it('SAS: the token is appended to every URL and no Authorization header is sent', async () => {
    const { fetch, calls } = recorder((url) =>
      url.pathname.endsWith('missing') ? new Response('', { status: 404 }) : new Response('ok'),
    );
    const store = new AzureBlobStore({
      accountUrl: 'https://acct.blob.core.windows.net/',
      container: 'qa',
      prefix: 'p/',
      auth: { sas: '?sv=2021-08-06&sig=abc%2B' },
      fetch,
    });
    await store.put('o/é', Buffer.from('data'), 'image/png');
    expect(calls[0]?.url.href).toBe(
      'https://acct.blob.core.windows.net/qa/p/o/%C3%A9?sv=2021-08-06&sig=abc%2B',
    );
    expect(calls[0]?.headers['x-ms-blob-type']).toBe('BlockBlob');
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(await store.get('missing')).toBeUndefined();
    await store.healthCheck();
    expect(calls.at(-1)?.url.href).toBe(
      'https://acct.blob.core.windows.net/qa?restype=container&sv=2021-08-06&sig=abc%2B',
    );
    expect(store.describe()).not.toContain('sig=');
  });

  it('a refusal names the Azure error code', async () => {
    const { fetch } = recorder(
      () => new Response('', { status: 403, headers: { 'x-ms-error-code': 'AuthorizationFailure' } }),
    );
    const store = new AzureBlobStore({
      accountUrl: 'http://127.0.0.1:10000/devstoreaccount1',
      container: 'qa',
      auth: { accountName: 'devstoreaccount1', accountKey },
      fetch,
    });
    await expect(store.put('k', Buffer.from('x'))).rejects.toThrow(
      'Azure Blob PUT failed: HTTP 403 AuthorizationFailure',
    );
  });
});

describe('object stores and documents', () => {
  it('documentText: UTF-8 that reads back identically, without NUL', () => {
    expect(documentText(Buffer.from('été — ok\n'))).toBe('été — ok\n');
    expect(documentText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
    expect(documentText(Buffer.from([0x63, 0xe9]))).toBeUndefined();
    expect(documentText(Buffer.from([0x61, 0, 0x62]))).toBeUndefined();
    expect(documentText(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });

  it('object keys never escape the store', () => {
    for (const bad of ['', '/abs', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb'])
      expect(() => {
        assertObjectKey(bad);
      }, bad).toThrow('invalid object key');
    expect(() => {
      assertObjectKey('space/objects/ab/abcdef');
    }).not.toThrow();
  });

  it('filesystem store: atomic put, absent get, idempotent delete, health check leaves nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qa-objects-'));
    try {
      const store = new FilesystemObjectStore(root);
      await store.healthCheck();
      expect(await readdir(root)).toEqual([]);
      await store.put('a/b', Buffer.from('x'));
      expect((await store.get('a/b'))?.toString()).toBe('x');
      expect(await readdir(path.join(root, 'a'))).toEqual(['b']);
      expect(await store.get('a/none')).toBeUndefined();
      await store.delete('a/b');
      await store.delete('a/b');
      expect(await store.get('a/b')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('createObjectStore reads the secrets from the environment and says which are missing', () => {
    expect(() =>
      createObjectStore(
        { provider: 's3', bucket: 'b', region: 'us-east-1' },
        { QA_OBJECTS_ACCESS_KEY_ID: 'a' },
      ),
    ).toThrow('QA_OBJECTS_SECRET_ACCESS_KEY');
    expect(
      createObjectStore(
        { provider: 's3', bucket: 'b', region: 'us-east-1' },
        { QA_OBJECTS_ACCESS_KEY_ID: 'a', QA_OBJECTS_SECRET_ACCESS_KEY: 's' },
      ).kind,
    ).toBe('s3');
    expect(() =>
      createObjectStore(
        { provider: 'azure-blob', accountUrl: 'https://a.blob.core.windows.net', container: 'c' },
        {},
      ),
    ).toThrow('QA_OBJECTS_SAS');
    expect(
      createObjectStore(
        { provider: 'azure-blob', accountUrl: 'https://a.blob.core.windows.net', container: 'c' },
        { QA_OBJECTS_ACCOUNT_NAME: 'a', QA_OBJECTS_ACCOUNT_KEY: 'a2V5' },
      ).kind,
    ).toBe('azure-blob');
  });
});

describe('qa-crawler sdk-server --storage', () => {
  it('rights: reading the storage state is VIEW, forcing a save is administration', () => {
    expect(rightFor(['api', 'storage'], 'GET')).toBe('VIEW');
    expect(rightFor(['api', 'storage', 'sync'], 'POST')).toBe('MANAGE_ACCESS');
  });

  it('local by default; storage options without --storage hybrid are refused', () => {
    expect(parseSdkServerArgs(['--workspace', 'w']).storage).toBeUndefined();
    expect(() => parseSdkServerArgs(['--workspace', 'w', '--objects', 'fs'])).toThrow(
      'needs --storage hybrid',
    );
    expect(() => parseSdkServerArgs(['--workspace', 'w', '--storage', 'cloud'])).toThrow('local or hybrid');
  });

  it('hybrid: database and object store are both required', () => {
    expect(() => parseSdkServerArgs(['--workspace', 'w', '--storage', 'hybrid'])).toThrow('--storage-db');
    expect(() =>
      parseSdkServerArgs(['--workspace', 'w', '--storage', 'hybrid', '--storage-db', 'postgres']),
    ).toThrow('--objects fs, s3, azure or artifactory');
    expect(() =>
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'mysql',
        '--objects',
        'fs',
      ]),
    ).toThrow('--storage-db');
    expect(() =>
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'sqlite',
        '--objects',
        's3',
      ]),
    ).toThrow('--objects-bucket');
    expect(() =>
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'postgres',
        '--storage-db-file',
        'x.db',
        '--objects',
        'fs',
        '--objects-dir',
        'o',
      ]),
    ).toThrow('--storage-db-file is for --storage-db sqlite');
  });

  it('hybrid with SQLite and a folder', () => {
    const args = parseSdkServerArgs([
      '--workspace',
      'w',
      '--storage',
      'hybrid',
      '--storage-db',
      'sqlite',
      '--storage-db-file',
      'state/qa.db',
      '--objects',
      'fs',
      '--objects-dir',
      'objects',
      '--storage-space',
      'staging',
      '--sync-interval',
      '30',
      '--storage-takeover',
    ]);
    expect(args.storage).toEqual({
      database: { type: 'sqlite', file: path.resolve('state/qa.db') },
      objects: { provider: 'filesystem', directory: path.resolve('objects') },
      space: 'staging',
      intervalMs: 30_000,
      takeover: true,
    });
  });

  it('hybrid with PostgreSQL and S3-compatible, SQL Server and Azure', () => {
    expect(
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'postgres',
        '--storage-db-tls',
        '--objects',
        's3',
        '--objects-bucket',
        'qa',
        '--objects-endpoint',
        'https://minio.example.test:9000',
        '--objects-prefix',
        'qa-crawler',
      ]).storage,
    ).toEqual({
      database: { type: 'postgres', tls: true },
      objects: {
        provider: 's3',
        bucket: 'qa',
        region: 'us-east-1',
        endpoint: 'https://minio.example.test:9000',
        prefix: 'qa-crawler/',
      },
    });
    expect(
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'sqlserver',
        '--objects',
        'azure',
        '--objects-account-url',
        'https://acct.blob.core.windows.net',
        '--objects-container',
        'qa',
      ]).storage?.objects,
    ).toEqual({ provider: 'azure-blob', accountUrl: 'https://acct.blob.core.windows.net', container: 'qa' });
    expect(() =>
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'sqlite',
        '--objects',
        'fs',
        '--objects-dir',
        'o',
        '--storage-space',
        '../x',
      ]),
    ).toThrow('--storage-space');
    expect(() =>
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--storage',
        'hybrid',
        '--storage-db',
        'sqlite',
        '--objects',
        's3',
        '--objects-bucket',
        'b',
        '--objects-prefix',
        '../up',
      ]),
    ).toThrow('--objects-prefix');
  });
});
