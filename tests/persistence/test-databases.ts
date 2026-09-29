import type { DatabaseConnection } from '../../src/persistence/database/database-adapter.js';

/**
 * Bases de test, fournies par l'environnement (jamais écrites dans le dépôt) :
 *
 *   QA_TEST_PG_HOST, QA_TEST_PG_PORT, QA_TEST_PG_DATABASE, QA_TEST_PG_USERNAME, QA_TEST_PG_PASSWORD
 *   QA_TEST_MSSQL_HOST, QA_TEST_MSSQL_PORT, QA_TEST_MSSQL_DATABASE, QA_TEST_MSSQL_USERNAME,
 *   QA_TEST_MSSQL_PASSWORD, QA_TEST_MSSQL_TRUST_CERT=true (conteneur local, certificat auto-signé)
 *
 * Sans ces variables, les tests de la base correspondante sont ignorés (et le disent).
 */
function fromEnv(prefix: string, engine: DatabaseConnection['engine']): DatabaseConnection | undefined {
  const env = process.env;
  const host = env[`${prefix}_HOST`];
  if (!host) return undefined;
  const port = env[`${prefix}_PORT`];
  return {
    engine,
    host,
    ...(port ? { port: Number(port) } : {}),
    ...(env[`${prefix}_DATABASE`] ? { database: env[`${prefix}_DATABASE`] } : {}),
    ...(env[`${prefix}_USERNAME`] ? { username: env[`${prefix}_USERNAME`] } : {}),
    ...(env[`${prefix}_PASSWORD`] ? { password: env[`${prefix}_PASSWORD`] } : {}),
    connectTimeoutMs: 15_000,
    trustServerCertificate: env[`${prefix}_TRUST_CERT`] === 'true',
  };
}

export const POSTGRES_TEST = fromEnv('QA_TEST_PG', 'postgres');
export const SQLSERVER_TEST = fromEnv('QA_TEST_MSSQL', 'sqlserver');
