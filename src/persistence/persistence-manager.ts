import path from 'node:path';
import type { PersistenceConfig } from '../config/config.js';
import { createDatabaseAdapter } from './database/adapter-factory.js';
import {
  safeErrorMessage,
  type DatabaseConnection,
  type DatabaseEngine,
} from './database/database-adapter.js';
import { DatabasePersistenceProvider } from './database/database-provider.js';
import { JsonPersistenceProvider } from './file/json-provider.js';
import { InMemoryPersistenceProvider } from './memory/in-memory-provider.js';
import type { PersistenceKind, PersistenceProvider } from './persistence-provider.js';
import { sanitizingProvider } from './sanitize.js';

const ENGINE_LABELS: Record<DatabaseEngine, string> = {
  postgres: 'PostgreSQL',
  sqlserver: 'SQL Server',
  mysql: 'MySQL',
  sqlite: 'SQLite',
};

/** Ce que le rapport dit de la persistance : configurée, réellement utilisée, pourquoi. Jamais d'identifiants. */
export interface PersistenceStatus {
  enabled: boolean;
  status: 'DISABLED' | 'CONNECTED' | 'FALLBACK';
  configured?: { provider: PersistenceKind; database?: string };
  actual?: { provider: PersistenceKind; database?: string; location?: string };
  /** Pourquoi le provider réellement utilisé n'est pas celui configuré. */
  reason?: string;
  latencyMs?: number;
  schemaVersion?: number;
  /** Écritures qui ont échoué pendant le run (le crawl, lui, a continué). */
  writeErrors: string[];
}

export interface PersistenceSession {
  /** Absent quand la persistance est désactivée. */
  provider?: PersistenceProvider;
  status: PersistenceStatus;
}

/** La base est inutilisable et persistence.failureMode vaut fail : le run s'arrête avec une erreur claire. */
export class PersistenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

export interface PersistenceWarnings {
  warn(message: string): void;
}

/**
 * Ouvre la persistance configurée. Désactivée : rien n'est ouvert, rien n'est chargé (aucun
 * pilote de base de données n'est importé). Stockage inutilisable : failureMode fail →
 * PersistenceUnavailableError ; fallback → AVERTISSEMENT puis provider de repli (fichier ou
 * mémoire), et le rapport dit lequel et pourquoi. Le provider rendu nettoie toutes les écritures.
 */
export async function openPersistence(
  config: PersistenceConfig,
  env: NodeJS.ProcessEnv = process.env,
  warnings: PersistenceWarnings = { warn: () => undefined },
): Promise<PersistenceSession> {
  if (!config.enabled) return { status: { enabled: false, status: 'DISABLED', writeErrors: [] } };

  const configured = {
    provider: config.provider,
    ...(config.provider === 'database' && config.database
      ? { database: ENGINE_LABELS[config.database.type] }
      : {}),
  };
  let reason: string;
  try {
    const primary = createProvider(config, env);
    const opened = await initialize(primary);
    return {
      provider: sanitizingProvider(primary),
      status: {
        enabled: true,
        status: 'CONNECTED',
        configured,
        actual: { ...configured, ...locationOf(config, primary) },
        ...opened,
        writeErrors: [],
      },
    };
  } catch (error) {
    reason = safeErrorMessage(error, credentialsOf(config, env));
  }

  const label = configured.database ?? configured.provider;
  if (config.failureMode === 'fail')
    throw new PersistenceUnavailableError(
      `persistence ${label} unavailable: ${reason} (persistence.failureMode: fail)`,
    );
  warnings.warn(`persistence ${label} unavailable (${reason}): falling back to ${config.fallback.provider}`);
  const fallback =
    config.fallback.provider === 'memory'
      ? new InMemoryPersistenceProvider()
      : new JsonPersistenceProvider(path.resolve(config.fallback.directory ?? config.file.directory));
  const opened = await initialize(fallback);
  return {
    provider: sanitizingProvider(fallback),
    status: {
      enabled: true,
      status: 'FALLBACK',
      configured,
      actual: {
        provider: fallback.kind,
        ...(fallback instanceof JsonPersistenceProvider ? { location: fallback.directory } : {}),
      },
      reason,
      ...opened,
      writeErrors: [],
    },
  };
}

async function initialize(
  provider: PersistenceProvider,
): Promise<{ latencyMs?: number; schemaVersion?: number }> {
  await provider.initialize();
  const health = await provider.healthCheck();
  if (health.status !== 'CONNECTED') {
    await provider.close().catch(() => undefined);
    throw new Error(health.detail ?? 'health check failed');
  }
  return {
    ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
    ...(health.schemaVersion !== undefined ? { schemaVersion: health.schemaVersion } : {}),
  };
}

function createProvider(config: PersistenceConfig, env: NodeJS.ProcessEnv): PersistenceProvider {
  switch (config.provider) {
    case 'memory':
      return new InMemoryPersistenceProvider();
    case 'file':
      return new JsonPersistenceProvider(path.resolve(config.file.directory));
    case 'database': {
      if (!config.database) throw new Error('persistence.database is required when provider is database');
      return new DatabasePersistenceProvider(createDatabaseAdapter(connectionOf(config, env)), {
        migrate: config.database.migrate,
      });
    }
  }
}

/**
 * Les paramètres de connexion : hôte, port et nom de base depuis l'environnement (ou le YAML,
 * qui n'est pas secret), identifiants TOUJOURS depuis l'environnement.
 */
export function connectionOf(config: PersistenceConfig, env: NodeJS.ProcessEnv): DatabaseConnection {
  const database = config.database;
  if (!database) throw new Error('persistence.database is required when provider is database');
  const value = (name: string): string | undefined => {
    const found = env[name];
    return found === undefined || found.trim() === '' ? undefined : found.trim();
  };
  const host = value(database.hostEnv) ?? database.host;
  const portText = value(database.portEnv);
  const port = portText !== undefined ? Number(portText) : database.port;
  if (port !== undefined && (!Number.isInteger(port) || port <= 0))
    throw new Error(`${database.portEnv} is not a valid port`);
  const name = value(database.databaseEnv) ?? database.database;
  const username = value(database.usernameEnv);
  const password = env[database.passwordEnv];
  const file = value(database.fileEnv) ?? database.file;
  if (database.type !== 'sqlite' && !host)
    throw new Error(`the database host is missing: set ${database.hostEnv} (or persistence.database.host)`);
  if (database.type === 'sqlite' && !file)
    throw new Error(`the SQLite file is missing: set persistence.database.file (or ${database.fileEnv})`);
  return {
    engine: database.type,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(name !== undefined ? { database: name } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined && password !== '' ? { password } : {}),
    ...(file !== undefined ? { file: file === ':memory:' ? file : path.resolve(file) } : {}),
    connectTimeoutMs: database.connectTimeoutMs,
    ...(database.tls.enabled !== undefined ? { tls: database.tls.enabled } : {}),
    trustServerCertificate: database.tls.trustServerCertificate,
  };
}

function credentialsOf(
  config: PersistenceConfig,
  env: NodeJS.ProcessEnv,
): { username?: string; password?: string } {
  if (!config.database) return {};
  const username = env[config.database.usernameEnv];
  const password = env[config.database.passwordEnv];
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function locationOf(config: PersistenceConfig, provider: PersistenceProvider): { location?: string } {
  if (provider instanceof JsonPersistenceProvider) return { location: provider.directory };
  if (config.provider === 'database' && config.database?.type === 'sqlite' && config.database.file)
    return { location: path.resolve(config.database.file) };
  return {};
}
