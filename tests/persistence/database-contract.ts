import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../src/persistence/database/database-adapter.js';
import { DatabasePersistenceProvider } from '../../src/persistence/database/database-provider.js';
import { MIGRATIONS, migrate, SchemaVersionError } from '../../src/persistence/database/migrations.js';
import { persistenceProviderContract } from './provider-contract.js';

/**
 * CONTRAT DES BASES DE DONNÉES : le même pour PostgreSQL, SQL Server et SQLite —
 * connexion, migrations versionnées, transaction, rollback, health check — puis le
 * contrat commun des providers (crawl_run, run_state, run_transition, transition_knowledge,
 * historique, plusieurs destinations, atomicité, durabilité).
 */
export function databaseContract(name: string, createAdapter: () => DatabaseAdapter): void {
  describe(`database contract: ${name}`, () => {
    let adapter: DatabaseAdapter;
    const table = `qa_tx_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    beforeAll(async () => {
      adapter = createAdapter();
      await adapter.connect();
      await adapter.query(
        adapter.dialect.createTableIfMissing(table, `id ${adapter.dialect.types.id} NOT NULL PRIMARY KEY`),
      );
    });
    afterAll(async () => {
      await adapter.query(`DROP TABLE ${table}`).catch(() => undefined);
      await adapter.disconnect();
    });

    it('connection and health check', async () => {
      expect(await adapter.healthCheck()).toBe(true);
    });

    it('migrations: applied once, versioned, idempotent', async () => {
      const first = await migrate(adapter, { apply: true });
      expect(first.version).toBe(MIGRATIONS.length);
      const again = await migrate(adapter, { apply: true });
      expect(again).toEqual({ version: MIGRATIONS.length, applied: [] });
      // Rien à appliquer : migrate: false est accepté.
      expect((await migrate(adapter, { apply: false })).version).toBe(MIGRATIONS.length);
    });

    it('migrations: a pending migration with migrate: false is a clear error, and nothing is changed', async () => {
      const future = { id: '999_future', statements: () => ['CREATE TABLE qa_never_created (id INTEGER)'] };
      await expect(migrate(adapter, { apply: false }, [...MIGRATIONS, future])).rejects.toThrow(
        SchemaVersionError,
      );
      await expect(adapter.query('SELECT * FROM qa_never_created')).rejects.toThrow();
    });

    it('migrations: a schema newer than the crawler is never touched', async () => {
      await expect(migrate(adapter, { apply: true }, MIGRATIONS.slice(0, 1))).rejects.toThrow(
        /newer than this crawler/,
      );
    });

    it('transaction: committed', async () => {
      const id = randomUUID();
      await adapter.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} (id) VALUES (${adapter.dialect.param(1)})`, [id]);
      });
      expect(
        await adapter.query(`SELECT id FROM ${table} WHERE id = ${adapter.dialect.param(1)}`, [id]),
      ).toHaveLength(1);
    });

    it('transaction: rolled back on error, the error is passed on', async () => {
      const id = randomUUID();
      await expect(
        adapter.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (id) VALUES (${adapter.dialect.param(1)})`, [id]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(
        await adapter.query(`SELECT id FROM ${table} WHERE id = ${adapter.dialect.param(1)}`, [id]),
      ).toHaveLength(0);
    });

    it('a duplicate key is recognised as a unique violation (concurrent writers are retried)', async () => {
      const id = randomUUID();
      await adapter.query(`INSERT INTO ${table} (id) VALUES (${adapter.dialect.param(1)})`, [id]);
      const error = await adapter
        .query(`INSERT INTO ${table} (id) VALUES (${adapter.dialect.param(1)})`, [id])
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(adapter.dialect.isUniqueViolation(error)).toBe(true);
    });
  });

  persistenceProviderContract(name, {
    create: () => new DatabasePersistenceProvider(createAdapter(), { migrate: true }),
    durable: true,
  });
}
