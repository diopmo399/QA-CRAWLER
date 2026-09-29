import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../../src/cli/args.js';
import { ConfigError, parseConfig } from '../../src/config/config-loader.js';
import {
  connectionOf,
  openPersistence,
  PersistenceUnavailableError,
} from '../../src/persistence/persistence-manager.js';

const MISSION = `
mission: { name: p }
target: { baseUrl: http://localhost:4200 }
`;
const load = (extra = '', env: NodeJS.ProcessEnv = {}, overrides = {}) =>
  parseConfig(`${MISSION}${extra}`, overrides, env).config;

describe('persistence and memory configuration', () => {
  it('defaults: no persistence; memory keeps the previous behaviour (knowledge file)', () => {
    const config = load();
    expect(config.persistence).toMatchObject({
      enabled: false,
      provider: 'file',
      failureMode: 'fallback',
      file: { directory: '.qa-crawler/memory' },
    });
    expect(config.memory.enabled).toBeUndefined();
    expect(config.memory.preload).toEqual({ maxStates: 1000, maxTransitions: 5000 });
    expect(config.knowledge.enabled).toBe(true);
  });

  it('a database block: credentials are names of environment variables, never values', () => {
    const config = load(`
persistence:
  enabled: true
  provider: database
  database: { type: sqlserver }
memory: { enabled: true, preload: { maxStates: 10, maxTransitions: 20 } }
`);
    expect(config.persistence.database).toMatchObject({
      type: 'sqlserver',
      hostEnv: 'QA_DB_HOST',
      portEnv: 'QA_DB_PORT',
      databaseEnv: 'QA_DB_NAME',
      usernameEnv: 'QA_DB_USERNAME',
      passwordEnv: 'QA_DB_PASSWORD',
      migrate: true,
    });
    expect(config.memory).toMatchObject({ enabled: true, preload: { maxStates: 10, maxTransitions: 20 } });
    expect(() =>
      load(`
persistence:
  enabled: true
  provider: database
  database: { type: postgres, password: hunter2 }
`),
    ).toThrow(/never write database credentials in the YAML/);
    expect(() => load('persistence: { enabled: true, provider: database }')).toThrow(/persistence.database/);
  });

  it('environment overrides the YAML; the CLI overrides the environment', () => {
    const env = {
      QA_PERSISTENCE_ENABLED: 'true',
      QA_PERSISTENCE_PROVIDER: 'database',
      QA_DB_TYPE: 'postgres',
      QA_MEMORY_ENABLED: 'false',
    };
    const fromEnv = load('persistence: { enabled: false, provider: file }', env);
    expect(fromEnv.persistence).toMatchObject({
      enabled: true,
      provider: 'database',
      database: { type: 'postgres' },
    });
    expect(fromEnv.memory.enabled).toBe(false);
    const fromCli = load('', env, { persistence: 'sqlserver', memory: true });
    expect(fromCli.persistence).toMatchObject({
      enabled: true,
      provider: 'database',
      database: { type: 'sqlserver' },
    });
    expect(fromCli.memory.enabled).toBe(true);
    expect(load('', env, { persistence: 'off' }).persistence.enabled).toBe(false);
    expect(() => load('', { QA_PERSISTENCE_ENABLED: 'maybe' })).toThrow(ConfigError);
  });

  it('CLI flags: --persistence, --no-persistence, --memory, --no-memory', () => {
    expect(parseCliArgs(['m.yaml', '--persistence', 'postgres'])).toMatchObject({ persistence: 'postgres' });
    expect(parseCliArgs(['m.yaml', '--persistence', 'sqlserver', '--no-memory'])).toMatchObject({
      persistence: 'sqlserver',
      memory: false,
    });
    expect(parseCliArgs(['m.yaml', '--no-persistence'])).toMatchObject({ persistence: 'off' });
    expect(parseCliArgs(['m.yaml', '--memory']).memory).toBe(true);
    expect(parseCliArgs(['m.yaml']).persistence).toBeUndefined();
    expect(() => parseCliArgs(['m.yaml', '--persistence', 'oracle'])).toThrow(UsageError);
  });

  it('connection: host, port and database from the environment (or YAML); credentials only from the environment', () => {
    const config = load(`
persistence:
  enabled: true
  provider: database
  database: { type: postgres, host: yaml-host, port: 5433, database: yaml_db }
`);
    expect(connectionOf(config.persistence, {})).toMatchObject({
      host: 'yaml-host',
      port: 5433,
      database: 'yaml_db',
    });
    const connection = connectionOf(config.persistence, {
      QA_DB_HOST: 'env-host',
      QA_DB_PORT: '6543',
      QA_DB_NAME: 'env_db',
      QA_DB_USERNAME: 'qa',
      QA_DB_PASSWORD: 'from-env',
    });
    expect(connection).toMatchObject({
      engine: 'postgres',
      host: 'env-host',
      port: 6543,
      database: 'env_db',
      username: 'qa',
      password: 'from-env',
    });
    expect(() =>
      connectionOf(
        load('persistence: { enabled: true, provider: database, database: { type: sqlserver } }').persistence,
        {},
      ),
    ).toThrow(/QA_DB_HOST/);
  });
});

describe('PersistenceManager', () => {
  const directory = () => mkdtempSync(path.join(tmpdir(), 'qa-persistence-manager-'));

  it('disabled: nothing is opened, no driver is loaded', async () => {
    const session = await openPersistence(load().persistence);
    expect(session.provider).toBeUndefined();
    expect(session.status).toEqual({ enabled: false, status: 'DISABLED', writeErrors: [] });
  });

  it('file: connected, with its location', async () => {
    const dir = directory();
    const session = await openPersistence(
      load(`persistence: { enabled: true, provider: file, file: { directory: ${dir} } }`).persistence,
    );
    expect(session.status).toMatchObject({
      status: 'CONNECTED',
      configured: { provider: 'file' },
      actual: { provider: 'file', location: dir },
    });
    await session.provider?.close();
  });

  it('database unavailable + fallback: WARNING, then the file provider; the report says which and why', async () => {
    const dir = directory();
    const warnings: string[] = [];
    const config = load(`
persistence:
  enabled: true
  provider: database
  database: { type: postgres, connectTimeoutMs: 1000 }
  failureMode: fallback
  fallback: { provider: file, directory: ${dir} }
`);
    const session = await openPersistence(
      config.persistence,
      { QA_DB_HOST: '127.0.0.1', QA_DB_PORT: '9', QA_DB_USERNAME: 'qa', QA_DB_PASSWORD: 'never-shown-9f2' },
      { warn: (message) => warnings.push(message) },
    );
    expect(session.status).toMatchObject({
      status: 'FALLBACK',
      configured: { provider: 'database', database: 'PostgreSQL' },
      actual: { provider: 'file', location: dir },
    });
    expect(session.status.reason).toMatch(/connection failed/i);
    expect(warnings).toEqual([expect.stringMatching(/PostgreSQL unavailable .* falling back to file/)]);
    expect(JSON.stringify(session.status) + warnings.join()).not.toContain('never-shown-9f2');
    await session.provider?.runs.list('x', 1); // le repli fonctionne
    await session.provider?.close();
  });

  it('database unavailable + fail: the run stops with a clear error', async () => {
    const config = load(`
persistence:
  enabled: true
  provider: database
  database: { type: sqlserver, connectTimeoutMs: 1000 }
  failureMode: fail
`);
    await expect(
      openPersistence(config.persistence, { QA_DB_HOST: '127.0.0.1', QA_DB_PORT: '9' }),
    ).rejects.toThrow(PersistenceUnavailableError);
  });

  it('a database type that is not implemented is never presented as supported', async () => {
    const config = load(`
persistence:
  enabled: true
  provider: database
  database: { type: mysql }
  failureMode: fail
`);
    await expect(openPersistence(config.persistence, { QA_DB_HOST: 'x' })).rejects.toThrow(
      /mysql.*not implemented/,
    );
  });

  it('SQLite through the same manager (node:sqlite, no server)', async () => {
    const file = path.join(directory(), 'qa.db');
    const session = await openPersistence(
      load(`persistence: { enabled: true, provider: database, database: { type: sqlite, file: ${file} } }`)
        .persistence,
    );
    expect(session.status).toMatchObject({
      status: 'CONNECTED',
      actual: { provider: 'database', database: 'SQLite', location: file },
      schemaVersion: 4,
    });
    await session.provider?.close();
  });
});
