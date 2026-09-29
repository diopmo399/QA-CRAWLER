import {
  DatabaseNotSupportedError,
  type DatabaseAdapter,
  type DatabaseConnection,
} from './database-adapter.js';
import { PostgresAdapter } from './postgres/postgres-adapter.js';
import { SqliteAdapter } from './sqlite/sqlite-adapter.js';
import { SqlServerAdapter } from './sqlserver/sqlserver-adapter.js';

/**
 * Le seul endroit qui choisit un moteur. Les pilotes ne sont chargés qu'à la connexion
 * (import dynamique) : une mission sans base de données ne les charge jamais.
 * MySQL est prévu (type accepté, contrat de test prêt) mais pas implémenté : il est
 * signalé comme tel au lieu d'être présenté comme supporté.
 */
export function createDatabaseAdapter(connection: DatabaseConnection): DatabaseAdapter {
  switch (connection.engine) {
    case 'postgres':
      return new PostgresAdapter(connection);
    case 'sqlserver':
      return new SqlServerAdapter(connection);
    case 'sqlite':
      return new SqliteAdapter(connection);
    case 'mysql':
      throw new DatabaseNotSupportedError('mysql');
  }
}
