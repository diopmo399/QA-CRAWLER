import type * as PgModule from 'pg';
import type { Pool, PoolClient } from 'pg';
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

export const POSTGRES_DIALECT: SqlDialect = {
  engine: 'postgres',
  label: 'PostgreSQL',
  param: (index) => `$${index}`,
  types: {
    id: 'VARCHAR(64)',
    signature: 'VARCHAR(200)',
    label: 'VARCHAR(500)',
    url: 'VARCHAR(2000)',
    name: 'VARCHAR(200)',
    json: 'JSONB',
    int: 'INTEGER',
    double: 'DOUBLE PRECISION',
    timestamp: 'TIMESTAMPTZ',
  },
  limit: (sql, count) => `${sql} LIMIT ${Math.max(0, Math.floor(count))}`,
  lockedTable: (table) => table,
  lockSuffix: ' FOR UPDATE',
  createTableIfMissing: (table, columns) => `CREATE TABLE IF NOT EXISTS ${table} (${columns})`,
  createIndexIfMissing: (name, table, columns, unique) =>
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')})`,
  isUniqueViolation: (error) => (error as { code?: unknown } | null)?.code === '23505',
  fromTimestamp: isoOf,
  fromJson: jsonOf,
};

/** PostgreSQL par le pilote `pg` (dépendance facultative, chargée seulement ici). */
export class PostgresAdapter implements DatabaseAdapter {
  readonly dialect = POSTGRES_DIALECT;
  private pool: Pool | undefined;

  constructor(private readonly connection: DatabaseConnection) {}

  async connect(): Promise<void> {
    const pg = await loadDriver();
    const { host, port, database, username, password, connectTimeoutMs, tls, trustServerCertificate } =
      this.connection;
    const pool = new pg.Pool({
      ...(host !== undefined ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(database !== undefined ? { database } : {}),
      ...(username !== undefined ? { user: username } : {}),
      ...(password !== undefined ? { password } : {}),
      connectionTimeoutMillis: connectTimeoutMs,
      max: 4,
      ...(tls ? { ssl: { rejectUnauthorized: !trustServerCertificate } } : {}),
    });
    // Une connexion perdue en arrière-plan ne doit jamais faire tomber le crawler.
    pool.on('error', () => undefined);
    try {
      const client = await pool.connect();
      client.release();
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw new Error(`PostgreSQL connection failed: ${safeErrorMessage(error, this.connection)}`);
    }
    this.pool = pool;
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }

  async healthCheck(): Promise<boolean> {
    const rows = await this.query('SELECT 1 AS ok');
    return Number(rows[0]?.ok) === 1;
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const result = await this.requirePool().query(sql, [...params]);
    return result.rows as SqlRow[];
  }

  async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const value = await operation({
        query: async (sql, params = []) => (await client.query(sql, [...params])).rows as SqlRow[],
      });
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private requirePool(): Pool {
    if (!this.pool) throw new Error('PostgreSQL adapter is not connected');
    return this.pool;
  }
}

async function loadDriver(): Promise<typeof PgModule> {
  try {
    const module = (await import('pg')) as typeof PgModule & { default?: typeof PgModule };
    return module.default ?? module;
  } catch {
    throw new Error('the PostgreSQL driver "pg" is not installed: npm install pg');
  }
}
