import { beforeAll, describe, it } from 'vitest';
import { SqlServerAdapter } from '../../src/persistence/database/sqlserver/sqlserver-adapter.js';
import { databaseContract } from '../persistence/database-contract.js';
import { databaseEndToEnd } from '../persistence/database-end-to-end.js';
import { SQLSERVER_TEST } from '../persistence/test-databases.js';

// SQL Server réel (QA_TEST_MSSQL_*) : exactement le même contrat que PostgreSQL, SQLite et les fichiers.
if (SQLSERVER_TEST) {
  const connection = SQLSERVER_TEST;
  beforeAll(async () => {
    // Une image SQL Server neuve n'a que « master » : créer la base de test si besoin.
    if (!connection.database) return;
    const master = new SqlServerAdapter({ ...connection, database: 'master' });
    await master.connect();
    try {
      await master.query(
        `IF DB_ID(N'${connection.database.replace(/'/g, "''")}') IS NULL CREATE DATABASE [${connection.database.replace(/]/g, ']]')}]`,
      );
    } finally {
      await master.disconnect();
    }
  });
  databaseContract('SQL Server', () => new SqlServerAdapter(connection));
  databaseEndToEnd('SQL Server', connection);
} else {
  describe('database contract: SQL Server', () => {
    it.skip('QA_TEST_MSSQL_HOST is not set: no SQL Server to test against', () => undefined);
  });
}
