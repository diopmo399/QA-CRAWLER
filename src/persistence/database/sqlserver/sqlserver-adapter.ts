import type * as Mssql from 'mssql';
import type { ConnectionPool, Request, Transaction } from 'mssql';
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

type MssqlModule = typeof Mssql;

/**
 * SQL Server : NVARCHAR (Unicode), JSON stocké en NVARCHAR(MAX), DATETIMEOFFSET(3),
 * FLOAT, pagination OFFSET/FETCH, création idempotente par OBJECT_ID / sys.indexes, et
 * blocage en lecture par indice de table (UPDLOCK, HOLDLOCK) au lieu de FOR UPDATE.
 */
export const SQLSERVER_DIALECT: SqlDialect = {
  engine: 'sqlserver',
  label: 'SQL Server',
  param: (index) => `@p${index}`,
  types: {
    id: 'NVARCHAR(64)',
    signature: 'NVARCHAR(200)',
    label: 'NVARCHAR(500)',
    url: 'NVARCHAR(2000)',
    name: 'NVARCHAR(200)',
    json: 'NVARCHAR(MAX)',
    int: 'INT',
    double: 'FLOAT',
    timestamp: 'DATETIMEOFFSET(3)',
  },
  limit: (sql, count) => `${sql} OFFSET 0 ROWS FETCH NEXT ${Math.max(0, Math.floor(count))} ROWS ONLY`,
  lockedTable: (table) => `${table} WITH (UPDLOCK, HOLDLOCK)`,
  lockSuffix: '',
  createTableIfMissing: (table, columns) =>
    `IF OBJECT_ID(N'${table}', N'U') IS NULL CREATE TABLE ${table} (${columns})`,
  createIndexIfMissing: (name, table, columns, unique) =>
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${name}' AND object_id = OBJECT_ID(N'${table}')) CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${columns.join(', ')})`,
  isUniqueViolation: (error) => {
    const number =
      (error as { number?: unknown; originalError?: { info?: { number?: unknown } } } | null) ?? {};
    const code = number.number ?? number.originalError?.info?.number;
    return code === 2627 || code === 2601;
  },
  fromTimestamp: isoOf,
  fromJson: jsonOf,
};

/** SQL Server par le pilote `mssql` (tedious ; dépendance facultative, chargée seulement ici). */
export class SqlServerAdapter implements DatabaseAdapter {
  readonly dialect = SQLSERVER_DIALECT;
  private pool: ConnectionPool | undefined;
  private mssql: MssqlModule | undefined;

  constructor(private readonly connection: DatabaseConnection) {}

  async connect(): Promise<void> {
    const mssql = await loadDriver();
    const { host, port, database, username, password, connectTimeoutMs, tls, trustServerCertificate } =
      this.connection;
    if (!host) throw new Error('SQL Server: the host is required (persistence.database.hostEnv)');
    const pool = new mssql.ConnectionPool({
      server: host,
      ...(port !== undefined ? { port } : {}),
      ...(database !== undefined ? { database } : {}),
      ...(username !== undefined ? { user: username } : {}),
      ...(password !== undefined ? { password } : {}),
      connectionTimeout: connectTimeoutMs,
      requestTimeout: 30_000,
      pool: { max: 4, min: 0 },
      // Chiffré par défaut (comme le pilote) ; un certificat auto-signé n'est accepté que sur demande explicite.
      options: { encrypt: tls ?? true, trustServerCertificate },
    });
    pool.on('error', () => undefined);
    try {
      await pool.connect();
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw new Error(`SQL Server connection failed: ${safeErrorMessage(error, this.connection)}`);
    }
    this.mssql = mssql;
    this.pool = pool;
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.close();
  }

  async healthCheck(): Promise<boolean> {
    const rows = await this.query('SELECT 1 AS ok');
    return Number(rows[0]?.ok) === 1;
  }

  query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    return this.run(this.requirePool().request(), sql, params);
  }

  async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const mssql = this.requireDriver();
    const transaction: Transaction = new mssql.Transaction(this.requirePool());
    await transaction.begin();
    try {
      const value = await operation({
        query: (sql, params = []) => this.run(new mssql.Request(transaction), sql, params),
      });
      await transaction.commit();
      return value;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  private async run(request: Request, sql: string, params: readonly SqlValue[]): Promise<SqlRow[]> {
    const mssql = this.requireDriver();
    params.forEach((value, index) => {
      // Types explicites : jamais de conversion implicite vers VARCHAR (non Unicode) ou INT trop petit.
      if (value === null) request.input(`p${index + 1}`, mssql.NVarChar, null);
      else if (typeof value === 'number')
        request.input(`p${index + 1}`, Number.isInteger(value) ? mssql.BigInt : mssql.Float, value);
      else request.input(`p${index + 1}`, mssql.NVarChar(mssql.MAX), value);
    });
    const result = await request.query(sql);
    return (result.recordset as SqlRow[] | undefined) ?? [];
  }

  private requirePool(): ConnectionPool {
    if (!this.pool) throw new Error('SQL Server adapter is not connected');
    return this.pool;
  }

  private requireDriver(): MssqlModule {
    if (!this.mssql) throw new Error('SQL Server adapter is not connected');
    return this.mssql;
  }
}

async function loadDriver(): Promise<MssqlModule> {
  try {
    const module = (await import('mssql')) as MssqlModule & { default?: MssqlModule };
    return module.default ?? module;
  } catch {
    throw new Error('the SQL Server driver "mssql" is not installed: npm install mssql');
  }
}
