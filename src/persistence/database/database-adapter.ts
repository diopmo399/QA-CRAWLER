/**
 * Ce qui change d'un moteur SQL à l'autre, et rien de plus : la connexion, les
 * paramètres, les types de colonnes, la limite de lignes, le blocage en lecture (lock), la
 * création idempotente, la détection des doublons, et la conversion des dates / JSON.
 * Les requêtes des repositories (database-provider.ts) sont écrites une fois pour
 * toutes avec ces pièces : aucun SQL propre à PostgreSQL n'est envoyé à SQL Server.
 */

export type DatabaseEngine = 'postgres' | 'sqlserver' | 'mysql' | 'sqlite';

export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

export interface SqlDialect {
  readonly engine: DatabaseEngine;
  /** Nom lisible : PostgreSQL, SQL Server, SQLite. */
  readonly label: string;
  /** Paramètre n° `index` (à partir de 1) : $1, @p1, ?. */
  param(index: number): string;
  readonly types: {
    id: string;
    signature: string;
    label: string;
    url: string;
    name: string;
    /** JSONB (PostgreSQL), NVARCHAR(MAX) (SQL Server), TEXT (SQLite). */
    json: string;
    int: string;
    double: string;
    /** TIMESTAMPTZ, DATETIMEOFFSET(3), TEXT ISO 8601. */
    timestamp: string;
  };
  /** Ajoute la limite à une requête qui a déjà son ORDER BY : LIMIT n, ou OFFSET 0 ROWS FETCH NEXT n ROWS ONLY. */
  limit(selectWithOrderBy: string, count: number): string;
  /** La table lue bloquée (lock) jusqu'à la fin de la transaction (SQL Server : indice de table). */
  lockedTable(table: string): string;
  /** Suffixe de blocage (lock) d'un SELECT (PostgreSQL : FOR UPDATE). */
  readonly lockSuffix: string;
  createTableIfMissing(table: string, columns: string): string;
  createIndexIfMissing(name: string, table: string, columns: readonly string[], unique: boolean): string;
  /** Ajoute une colonne NULLable (migrations additives seulement). */
  addColumn(table: string, column: string, type: string): string;
  /** Violation d'unicité (deux crawlers écrivent la même ligne en même temps) : la transaction est rejouée. */
  isUniqueViolation(error: unknown): boolean;
  /** Valeur lue d'une colonne de date → ISO 8601 UTC. */
  fromTimestamp: (value: unknown) => string;
  /** Valeur lue d'une colonne JSON → objet. */
  fromJson: (value: unknown) => Record<string, unknown>;
}

/** Exécute du SQL, dans ou hors d'une transaction. Les lignes sont des objets par nom de colonne. */
export interface SqlExecutor {
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
}

export interface DatabaseAdapter extends SqlExecutor {
  readonly dialect: SqlDialect;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Une requête triviale aboutit-elle ? */
  healthCheck(): Promise<boolean>;
  /** Tout ou rien : l'erreur de `operation` annule la transaction et est relancée. */
  transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Paramètres de connexion résolus (identifiants lus dans l'environnement, jamais dans le YAML). */
export interface DatabaseConnection {
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  /** SQLite : chemin du fichier (ou « :memory: »). */
  file?: string;
  connectTimeoutMs: number;
  /** undefined : le choix par défaut du pilote (PostgreSQL : sans TLS ; SQL Server : chiffré). */
  tls?: boolean;
  /** Accepter un certificat auto-signé (base de développement locale seulement). */
  trustServerCertificate: boolean;
}

/** Un moteur prévu par la configuration mais pas encore implémenté (et donc jamais présenté comme supporté). */
export class DatabaseNotSupportedError extends Error {
  constructor(engine: DatabaseEngine) {
    super(
      `database type "${engine}" is not implemented in this version (supported: postgres, sqlserver, sqlite)`,
    );
    this.name = 'DatabaseNotSupportedError';
  }
}

/** Le texte d'une erreur de pilote, sans jamais d'identifiants de connexion. */
export function safeErrorMessage(
  error: unknown,
  connection?: Pick<DatabaseConnection, 'username' | 'password'>,
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [connection?.password, connection?.username])
    if (secret && secret.length >= 3) message = message.split(secret).join('[REDACTED]');
  return message.split('\n')[0]?.trim() ?? message;
}
