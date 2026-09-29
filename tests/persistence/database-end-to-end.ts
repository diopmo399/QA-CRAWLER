import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import type { DatabaseConnection } from '../../src/persistence/database/database-adapter.js';

/**
 * Une vraie exploration (Chromium) enregistrée dans une vraie base, deux fois : le second run
 * précharge l'historique du premier. Même test pour PostgreSQL et SQL Server : passer de l'un à
 * l'autre ne change qu'une ligne de configuration (database.type), rien dans le moteur.
 */
export function databaseEndToEnd(name: string, connection: DatabaseConnection): void {
  describe(`end to end with ${name}`, () => {
    let server: Server;
    let url: string;
    let root: string;
    const application = `e2e-${Date.now().toString(36)}`;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const pages: Record<string, string> = {
          '/': '<h1>Dashboard</h1><a href="/users">Users</a>',
          '/users': '<h1>Users</h1><a href="/users/new">Create</a>',
          '/users/new': '<h1>Create user</h1>',
        };
        const body = pages[req.url ?? ''];
        res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>App</title></head><body>${body ?? 'Not found'}</body></html>`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      root = await mkdtemp(path.join(tmpdir(), 'qa-e2e-db-'));
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    // Les identifiants passent par l'environnement, jamais par le YAML.
    const env: NodeJS.ProcessEnv = {
      QA_DB_HOST: connection.host,
      QA_DB_PORT: connection.port !== undefined ? String(connection.port) : undefined,
      QA_DB_NAME: connection.database,
      QA_DB_USERNAME: connection.username,
      QA_DB_PASSWORD: connection.password,
    };
    const run = async (index: number): Promise<ExplorationResult> => {
      const { config } = parseConfig(
        `
mission: { name: e2e }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 10, actionTimeoutMs: 3000, settleTimeMs: 50 }
knowledge: { application: ${application} }
persistence:
  enabled: true
  provider: database
  database:
    type: ${connection.engine}
    tls: { trustServerCertificate: ${connection.trustServerCertificate} }
  failureMode: fail
memory: { enabled: true }
output:
  reportsDir: ${path.join(root, String(index), 'reports')}
  screenshotsDir: ${path.join(root, String(index), 'screenshots')}
`,
        {},
        env,
      );
      return (await runMission(config, { env })).result;
    };

    it('the first run is stored; the second preloads it from the database', async () => {
      const first = await run(1);
      expect(first.persistence).toMatchObject({
        status: 'CONNECTED',
        actual: { provider: 'database', database: name },
        schemaVersion: 4,
        memory: { mode: 'historical', historicalTransitionsLoaded: 0 },
        writeErrors: [],
      });
      expect(first.persistence?.memory.newTransitionsLearned).toBeGreaterThan(0);
      const second = await run(2);
      expect(second.persistence?.memory.historicalTransitionsLoaded).toBe(
        first.persistence?.memory.newTransitionsLearned,
      );
      expect(second.persistence?.memory.newTransitionsLearned).toBe(0);
      expect(second.persistence?.writeErrors).toEqual([]);
    });
  });
}
