import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/persistence/database/sqlite/sqlite-adapter.js';
import { AzureBlobStore, sharedKeyAuthorization } from '../../src/storage/azure-blob-store.js';
import type { ObjectStore } from '../../src/storage/object-store.js';
import { S3ObjectStore } from '../../src/storage/s3-object-store.js';
import { workspaceMirrorContract } from '../persistence/workspace-mirror-contract.js';

/**
 * Stockages objet RÉELS, fournis par l'environnement (jamais écrits dans le dépôt) :
 *
 *   S3 et compatibles (MinIO…) : QA_TEST_S3_ENDPOINT, QA_TEST_S3_BUCKET (existant), QA_TEST_S3_REGION,
 *     QA_TEST_S3_ACCESS_KEY_ID, QA_TEST_S3_SECRET_ACCESS_KEY
 *   Azure Blob (ou Azurite) : QA_TEST_AZURE_URL (https://<compte>.blob.core.windows.net ou
 *     http://127.0.0.1:10000/devstoreaccount1), QA_TEST_AZURE_ACCOUNT, QA_TEST_AZURE_KEY ; le conteneur
 *     est créé par le test.
 *
 * Sans ces variables, les tests correspondants sont ignorés (et le disent). Le miroir y est vérifié de
 * bout en bout avec SQLite comme base.
 */
const env = process.env;
const S3 = env.QA_TEST_S3_ENDPOINT && env.QA_TEST_S3_BUCKET ? env : undefined;
const AZURE = env.QA_TEST_AZURE_URL && env.QA_TEST_AZURE_ACCOUNT && env.QA_TEST_AZURE_KEY ? env : undefined;
/** Une base SQLite par miroir vérifié (la même pour toutes les ouvertures de ce miroir). */
const sqlite = (): (() => SqliteAdapter) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-objects-db-')), 'qa.db');
  return () =>
    new SqliteAdapter({ engine: 'sqlite', file, connectTimeoutMs: 5000, trustServerCertificate: false });
};

/** Le contrat commun d'un stockage objet réel ; `refused` : le même stockage avec un secret faux. */
function objectStoreContract(name: string, store: () => ObjectStore, refused: () => ObjectStore): void {
  describe(`object store: ${name}`, () => {
    it('put, get, overwrite, absent, delete (twice), health check', async () => {
      const objects = store();
      await objects.healthCheck();
      const key = `contract/objects/ab/${randomUUID().replace(/-/g, '')}`;
      const body = Buffer.from([0, 1, 2, 0xff, 0x89, 0x50]);
      await objects.put(key, body, 'image/png');
      expect([...((await objects.get(key)) ?? [])]).toEqual([...body]);
      await objects.put(key, Buffer.from('second'));
      expect((await objects.get(key))?.toString()).toBe('second');
      expect(await objects.get(`${key}-absent`)).toBeUndefined();
      await objects.delete(key);
      await objects.delete(key);
      expect(await objects.get(key)).toBeUndefined();
    });

    it('a wrong secret is refused (403), and the error carries no secret', async () => {
      const objects = refused();
      const error = (await objects.put('contract/x', Buffer.from('x')).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/HTTP 403/);
      expect(error.message).not.toContain('wrong-secret');
    });
  });
}

if (S3) {
  const s3 = (secret: string): S3ObjectStore =>
    new S3ObjectStore({
      bucket: S3.QA_TEST_S3_BUCKET ?? '',
      region: S3.QA_TEST_S3_REGION ?? 'us-east-1',
      endpoint: S3.QA_TEST_S3_ENDPOINT ?? '',
      prefix: `qa-test-${randomUUID().slice(0, 8)}/`,
      credentials: { accessKeyId: S3.QA_TEST_S3_ACCESS_KEY_ID ?? '', secretAccessKey: secret },
    });
  objectStoreContract(
    'S3-compatible',
    () => s3(S3.QA_TEST_S3_SECRET_ACCESS_KEY ?? ''),
    () => s3('wrong-secret'),
  );
  workspaceMirrorContract('SQLite + S3-compatible', sqlite(), () =>
    s3(S3.QA_TEST_S3_SECRET_ACCESS_KEY ?? ''),
  );
} else
  describe('object store: S3-compatible', () => {
    it.skip('QA_TEST_S3_ENDPOINT is not set: no S3-compatible store to test against', () => undefined);
  });

if (AZURE) {
  const accountUrl = AZURE.QA_TEST_AZURE_URL ?? '';
  const accountName = AZURE.QA_TEST_AZURE_ACCOUNT ?? '';
  const accountKey = AZURE.QA_TEST_AZURE_KEY ?? '';
  const container = `qa-test-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    // Le conteneur du test (PUT ?restype=container), signé Shared Key.
    const url = new URL(`${accountUrl.replace(/\/$/, '')}/${container}?restype=container`);
    const headers: Record<string, string> = {
      'x-ms-date': new Date().toUTCString(),
      'x-ms-version': '2021-08-06',
    };
    headers.authorization = sharedKeyAuthorization({ method: 'PUT', url, headers, accountName, accountKey });
    const response = await fetch(url, { method: 'PUT', headers });
    expect([201, 409]).toContain(response.status);
  });
  const azure = (key: string): AzureBlobStore =>
    new AzureBlobStore({ accountUrl, container, prefix: 'ws/', auth: { accountName, accountKey: key } });
  objectStoreContract(
    'Azure Blob',
    () => azure(accountKey),
    () => azure(Buffer.from('wrong-secret').toString('base64')),
  );
  workspaceMirrorContract('SQLite + Azure Blob', sqlite(), () => azure(accountKey));
} else
  describe('object store: Azure Blob', () => {
    it.skip('QA_TEST_AZURE_URL is not set: no Azure Blob store to test against', () => undefined);
  });
