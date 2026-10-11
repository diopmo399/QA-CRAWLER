import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabasePersistenceProvider } from '../../src/persistence/database/database-provider.js';
import { SqliteAdapter } from '../../src/persistence/database/sqlite/sqlite-adapter.js';
import { persistenceProviderContract } from '../persistence/provider-contract.js';

/**
 * SQLite (node:sqlite, sans serveur) tenu au même contrat que la mémoire, le fichier, PostgreSQL et
 * SQL Server — y compris la FLOW MEMORY de la QA platform (migration 005, index, recherche).
 */
const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-persistence-sqlite-')), 'qa.db');
persistenceProviderContract('SQLite', {
  create: () =>
    new DatabasePersistenceProvider(
      new SqliteAdapter({ engine: 'sqlite', file, connectTimeoutMs: 5000, trustServerCertificate: false }),
      { migrate: true },
    ),
  durable: true,
});
