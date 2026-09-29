import { describe, it } from 'vitest';
import { PostgresAdapter } from '../../src/persistence/database/postgres/postgres-adapter.js';
import { databaseContract } from '../persistence/database-contract.js';
import { databaseEndToEnd } from '../persistence/database-end-to-end.js';
import { POSTGRES_TEST } from '../persistence/test-databases.js';

// PostgreSQL réel (QA_TEST_PG_*) : exactement le même contrat que SQL Server, SQLite et les fichiers.
if (POSTGRES_TEST) {
  const connection = POSTGRES_TEST;
  databaseContract('PostgreSQL', () => new PostgresAdapter(connection));
  databaseEndToEnd('PostgreSQL', connection);
} else {
  describe('database contract: PostgreSQL', () => {
    it.skip('QA_TEST_PG_HOST is not set: no PostgreSQL to test against', () => undefined);
  });
}
