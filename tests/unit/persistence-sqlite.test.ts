import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../src/persistence/database/sqlite/sqlite-adapter.js';
import { databaseContract } from '../persistence/database-contract.js';

// SQLite (node:sqlite, intégré à Node.js 22.5+) : le contrat complet, sans serveur.
const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-persistence-sqlite-')), 'qa.db');
databaseContract(
  'SQLite',
  () => new SqliteAdapter({ engine: 'sqlite', file, connectTimeoutMs: 5000, trustServerCertificate: false }),
);
