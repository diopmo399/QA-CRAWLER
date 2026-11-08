import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createDatabaseAdapter } from '../persistence/database/adapter-factory.js';
import type { DatabaseEngine } from '../persistence/database/database-adapter.js';
import { databaseConnectionOf } from '../persistence/persistence-manager.js';
import { ArtifactoryStore } from './artifactory-store.js';
import { AzureBlobStore } from './azure-blob-store.js';
import { FilesystemObjectStore, type ObjectStore } from './object-store.js';
import { S3ObjectStore } from './s3-object-store.js';
import { WorkspaceMirror } from './workspace-mirror.js';
import { WorkspaceRepository } from './workspace-repository.js';

/**
 * STOCKAGE HYBRIDE du serveur : les fichiers texte du dossier de travail en base (PostgreSQL, SQL Server,
 * SQLite), les fichiers lourds ou binaires dans un stockage objet (dossier monté, S3 et compatibles,
 * Azure Blob, dépôt générique Artifactory). Aucun secret ici : identifiants lus dans l'environnement (QA_DB_*, QA_OBJECTS_*).
 */
export interface HybridStorageOptions {
  database: {
    type: Exclude<DatabaseEngine, 'mysql'>;
    /** Hôte, port et nom de base : QA_DB_HOST, QA_DB_PORT, QA_DB_NAME (ou ces valeurs). */
    host?: string;
    port?: number;
    name?: string;
    /** SQLite : le fichier de la base (ou QA_DB_FILE). */
    file?: string;
    /** Exécuter les migrations manquantes (ajouts seulement ; défaut true). */
    migrate?: boolean;
    tls?: boolean;
    trustServerCertificate?: boolean;
    connectTimeoutMs?: number;
  };
  objects:
    | { provider: 'filesystem'; directory: string }
    | {
        provider: 's3';
        bucket: string;
        region: string;
        endpoint?: string;
        pathStyle?: boolean;
        prefix?: string;
      }
    | { provider: 'azure-blob'; accountUrl: string; container: string; prefix?: string }
    | { provider: 'artifactory'; url: string; repository: string; prefix?: string };
  /** Le nom de l'espace : plusieurs serveurs (environnements) peuvent partager la même base (défaut « default »). */
  space?: string;
  /** Intervalle des envois en ms (défaut 10 000). */
  intervalMs?: number;
  /** Au-delà, un fichier texte va dans le stockage objet (défaut 256 Kio). */
  maxDocumentBytes?: number;
  /** Reprendre le bail d'un serveur arrêté brutalement. */
  takeover?: boolean;
}

/** Les noms des variables d'environnement des secrets du stockage objet. */
export const OBJECT_STORE_ENV = {
  accessKeyId: 'QA_OBJECTS_ACCESS_KEY_ID',
  secretAccessKey: 'QA_OBJECTS_SECRET_ACCESS_KEY',
  sessionToken: 'QA_OBJECTS_SESSION_TOKEN',
  sas: 'QA_OBJECTS_SAS',
  accountName: 'QA_OBJECTS_ACCOUNT_NAME',
  accountKey: 'QA_OBJECTS_ACCOUNT_KEY',
  token: 'QA_OBJECTS_TOKEN',
  username: 'QA_OBJECTS_USERNAME',
  password: 'QA_OBJECTS_PASSWORD',
} as const;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Le stockage objet configuré, avec ses secrets lus dans l'environnement (erreur claire s'ils manquent). */
export function createObjectStore(
  options: HybridStorageOptions['objects'],
  env: NodeJS.ProcessEnv,
): ObjectStore {
  switch (options.provider) {
    case 'filesystem':
      return new FilesystemObjectStore(options.directory);
    case 's3': {
      const accessKeyId = envValue(env, OBJECT_STORE_ENV.accessKeyId);
      const secretAccessKey = envValue(env, OBJECT_STORE_ENV.secretAccessKey);
      if (!accessKeyId || !secretAccessKey)
        throw new Error(
          `the S3 credentials are missing: set ${OBJECT_STORE_ENV.accessKeyId} and ${OBJECT_STORE_ENV.secretAccessKey}`,
        );
      const sessionToken = envValue(env, OBJECT_STORE_ENV.sessionToken);
      return new S3ObjectStore({
        bucket: options.bucket,
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.pathStyle !== undefined ? { pathStyle: options.pathStyle } : {}),
        ...(options.prefix ? { prefix: options.prefix } : {}),
        credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
      });
    }
    case 'azure-blob': {
      const sas = envValue(env, OBJECT_STORE_ENV.sas);
      const accountName = envValue(env, OBJECT_STORE_ENV.accountName);
      const accountKey = envValue(env, OBJECT_STORE_ENV.accountKey);
      const auth = sas ? { sas } : accountName && accountKey ? { accountName, accountKey } : undefined;
      if (!auth)
        throw new Error(
          `the Azure Blob credentials are missing: set ${OBJECT_STORE_ENV.sas}, or ${OBJECT_STORE_ENV.accountName} and ${OBJECT_STORE_ENV.accountKey}`,
        );
      return new AzureBlobStore({
        accountUrl: options.accountUrl,
        container: options.container,
        ...(options.prefix ? { prefix: options.prefix } : {}),
        auth,
      });
    }
    case 'artifactory': {
      const token = envValue(env, OBJECT_STORE_ENV.token);
      const username = envValue(env, OBJECT_STORE_ENV.username);
      const password = envValue(env, OBJECT_STORE_ENV.password);
      const auth = token ? { token } : username && password ? { username, password } : undefined;
      if (!auth)
        throw new Error(
          `the Artifactory credentials are missing: set ${OBJECT_STORE_ENV.token}, or ${OBJECT_STORE_ENV.username} and ${OBJECT_STORE_ENV.password}`,
        );
      return new ArtifactoryStore({
        url: options.url,
        repository: options.repository,
        ...(options.prefix ? { prefix: options.prefix } : {}),
        auth,
      });
    }
  }
}

/**
 * Ouvre la base (migrations additives comprises) et le stockage objet, et prépare le miroir du dossier de
 * travail ; `start()` le restaure puis l'envoie périodiquement. Une base ou un stockage injoignable est une
 * erreur au démarrage : le serveur ne démarre pas sur un dossier qui ne serait pas sauvegardé.
 */
export async function openWorkspaceMirror(
  root: string,
  options: HybridStorageOptions,
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void,
): Promise<WorkspaceMirror> {
  const db = options.database;
  const connection = databaseConnectionOf(
    {
      type: db.type,
      ...(db.host !== undefined ? { host: db.host } : {}),
      ...(db.port !== undefined ? { port: db.port } : {}),
      ...(db.name !== undefined ? { database: db.name } : {}),
      ...(db.file !== undefined ? { file: db.file } : {}),
      hostEnv: 'QA_DB_HOST',
      portEnv: 'QA_DB_PORT',
      databaseEnv: 'QA_DB_NAME',
      usernameEnv: 'QA_DB_USERNAME',
      passwordEnv: 'QA_DB_PASSWORD',
      fileEnv: 'QA_DB_FILE',
      migrate: db.migrate ?? true,
      connectTimeoutMs: db.connectTimeoutMs ?? 5000,
      tls: {
        ...(db.tls !== undefined ? { enabled: db.tls } : {}),
        trustServerCertificate: db.trustServerCertificate ?? false,
      },
    },
    env,
  );
  const objects = createObjectStore(options.objects, env);
  // SQLite : le dossier du fichier est créé au premier démarrage (« state/qa.db » sur un volume vide).
  if (connection.engine === 'sqlite' && connection.file && connection.file !== ':memory:')
    await mkdir(path.dirname(path.resolve(connection.file)), { recursive: true });
  const repository = new WorkspaceRepository(createDatabaseAdapter(connection), options.space ?? 'default');
  await repository.open({ migrate: db.migrate ?? true });
  const ignorePaths = [
    ...(connection.file && connection.file !== ':memory:'
      ? [connection.file, `${connection.file}-wal`, `${connection.file}-shm`, `${connection.file}-journal`]
      : []),
    ...(options.objects.provider === 'filesystem' ? [path.resolve(options.objects.directory)] : []),
  ];
  return new WorkspaceMirror({
    root,
    repository,
    objects,
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.maxDocumentBytes !== undefined ? { maxDocumentBytes: options.maxDocumentBytes } : {}),
    ...(options.takeover !== undefined ? { takeover: options.takeover } : {}),
    ignorePaths,
    ...(onWarning ? { onWarning } : {}),
  });
}
