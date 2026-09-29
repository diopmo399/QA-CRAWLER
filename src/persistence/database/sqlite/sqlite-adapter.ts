import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import {
  safeErrorMessage,
  type DatabaseAdapter,
  type DatabaseConnection,
  type SqlDialect,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
} from '../database-adapter.js';
import { isoOf, jsonOf } from '../values.js';

/** SQLite : dates en texte ISO 8601 (l'ordre du texte est l'ordre chronologique), JSON en texte. */
export const SQLITE_DIALECT: SqlDialect = {
  engine: 'sqlite',
  label: 'SQLite',
  param: () => '?',
  types: {
    id: 'TEXT',
    signature: 'TEXT',
    label: 'TEXT',
    url: 'TEXT',
    name: 'TEXT',
    json: 'TEXT',
    int: 'INTEGER',
    double: 'REAL',
    timestamp: 'TEXT',
  },
  limit: (sql, count) => `${sql} LIMIT ${Math.max(0, Math.floor(count))}`,
  lockedTable: (table) => table,
  // Toute la base est bloquée par BEGIN IMMEDIATE (voir transaction()).
  lockSuffix: '',
  createTableIfMissing: (table, columns) => `CREATE TABLE IF NOT EXISTS ${table} (${columns})`,
  createIndexIfMissing: (name, table, columns, unique) =>
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')})`,
  isUniqueViolation: (error) => /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : ''),
  fromTimestamp: isoOf,
  fromJson: jsonOf,
};

/**
 * SQLite par le module `node:sqlite` intégré à Node.js (22.5 et plus) : aucune dépendance.
 * Les appels sont synchrones ; une file garantit qu'une transaction n'est jamais
 * entrecoupée par une autre requête.
 */
export class SqliteAdapter implements DatabaseAdapter {
  readonly dialect = SQLITE_DIALECT;
  private db: DatabaseSync | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: DatabaseConnection) {}

  async connect(): Promise<void> {
    const file = this.connection.file;
    if (!file) throw new Error('SQLite: the database file is required (persistence.database.file)');
    let sqlite: typeof NodeSqlite;
    try {
      sqlite = await import('node:sqlite');
    } catch {
      throw new Error('SQLite needs Node.js 22.5 or later (module node:sqlite)');
    }
    try {
      this.db = new sqlite.DatabaseSync(file);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(this.connection.connectTimeoutMs))}`);
    } catch (error) {
      throw new Error(`SQLite connection failed: ${safeErrorMessage(error)}`);
    }
  }

  disconnect(): Promise<void> {
    return this.serialized(() => {
      this.db?.close();
      this.db = undefined;
    });
  }

  async healthCheck(): Promise<boolean> {
    const rows = await this.query('SELECT 1 AS ok');
    return Number(rows[0]?.ok) === 1;
  }

  query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    return this.serialized(() => this.run(sql, params));
  }

  transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const db = this.requireDb();
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = await operation({
          query: (sql, params = []) => Promise.resolve(this.run(sql, params)),
        });
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // déjà annulée
        }
        throw error;
      }
    });
  }

  private run(sql: string, params: readonly SqlValue[]): SqlRow[] {
    return this.requireDb()
      .prepare(sql)
      .all(...params);
  }

  private serialized<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('SQLite adapter is not connected');
    return this.db;
  }
}
