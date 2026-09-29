import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * RÉGRESSION D'UNE VERSION À L'AUTRE : la même application en quatre versions.
 *   v1 : Accueil → Utilisateurs (erreur JavaScript), Ancien
 *   v2 : « Ancien » a disparu, « Rapports » est apparu ; plus d'erreur
 *   v3 : pas d'erreur (deuxième vérification : l'anomalie est résolue)
 *   v4 : l'erreur revient (rouverte)
 */
describe('regression across versions: flow evolution and anomaly lifecycle', () => {
  let version = 1;
  let server: Server;
  let url: string;
  let root: string;
  const results: ExplorationResult[] = [];

  const page = (title: string, body: string, script = ''): string =>
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

  const run = async (n: number): Promise<ExplorationResult> => {
    version = n;
    const { config } = parseConfig(
      `
mission: { name: regression }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 20, actionTimeoutMs: 3000, settleTimeMs: 100 }
knowledge: { commit: v${n}, file: ${path.join(root, 'knowledge.json')} }
persistence: { enabled: true, provider: file, file: { directory: ${path.join(root, 'history')} } }
regression:
  flowEvolution: { enabled: true }
  anomalyLifecycle: { enabled: true, resolveAfterChecks: 2 }
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(root, `v${n}`, 'reports')}
  screenshotsDir: ${path.join(root, `v${n}`, 'screenshots')}
`,
      {},
      {},
    );
    return (await runMission(config)).result;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const route = new URL(req.url ?? '/', 'http://localhost').pathname;
      const html =
        route === '/'
          ? page(
              'Accueil',
              version === 1
                ? '<a href="/users">Utilisateurs</a> <a href="/old">Ancien</a>'
                : '<a href="/users">Utilisateurs</a> <a href="/reports">Rapports</a>',
            )
          : route === '/users'
            ? page(
                'Utilisateurs',
                '<p>3 utilisateurs</p>',
                version === 1 || version === 4 ? 'undefinedFunction()' : '',
              )
            : route === '/old'
              ? page('Ancien', '<p>Ancienne page</p>')
              : route === '/reports'
                ? page('Rapports', '<p>Aucun rapport</p>')
                : undefined;
      if (!html) {
        res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Introuvable</h1>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(path.join(tmpdir(), 'qa-regression-'));
    for (const n of [1, 2, 3, 4]) results.push(await run(n));
  }, 300_000);
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  const statusOf = (result: ExplorationResult | undefined): string | undefined =>
    result?.regression?.anomalies?.entries.find((entry) => entry.message.includes('undefinedFunction'))
      ?.status;

  it('v1: everything appears; the JavaScript error is NEW', () => {
    const [v1] = results;
    expect(v1?.regression?.skipped).toBeUndefined();
    expect(v1?.regression?.evolution?.changes.every((change) => change.change === 'APPEARED')).toBe(true);
    expect(v1?.regression?.evolution?.tracked.STATE).toBeGreaterThanOrEqual(3);
    expect(statusOf(v1)).toBe('NEW');
    const issue = v1?.issues.find((entry) => entry.message.includes('undefinedFunction'));
    expect(issue?.lifecycle?.status).toBe('NEW');
  });

  it('v2: "Ancien" is gone from the home page, "Rapports" appeared; the error is checked absent once', () => {
    const changes = results[1]?.regression?.evolution?.changes.map(
      (change) => `${change.kind} ${change.change} ${change.label}`,
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        'STATE APPEARED rapports',
        'TRANSITION APPEARED accueil → "Rapports"',
        'TRANSITION DISAPPEARED accueil → "Ancien"',
      ]),
    );
    const entry = results[1]?.regression?.anomalies?.entries.find((candidate) =>
      candidate.message.includes('undefinedFunction'),
    );
    expect(entry).toMatchObject({ status: 'NEW', cleanChecks: 1 });
  });

  it('v3: two consecutive clean checks → RESOLVED; v4: back → REOPENED', () => {
    expect(statusOf(results[2])).toBe('RESOLVED');
    expect(statusOf(results[3])).toBe('REOPENED');
    expect(results[3]?.regression?.anomalies?.counts.REOPENED).toBe(1);
  });

  it('first seen and versions are answered from the history', () => {
    const reports = results[3]?.regression?.evolution;
    expect(reports?.tracked.TRANSITION).toBeGreaterThanOrEqual(3);
    const appeared = results[1]?.regression?.evolution?.changes.find((change) => change.label === 'rapports');
    expect(appeared?.firstSeen.version).toBe('v2');
  });

  it('report and engine log: the regression section and the lifecycle events', async () => {
    const html = await readFile(path.join(root, 'v4', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Regression across versions');
    expect(html).toContain('REOPENED');
    const log = await readFile(path.join(root, 'v4', 'reports', 'engine-log.jsonl'), 'utf8');
    expect(log).toContain('ANOMALY_REOPENED');
    expect(log).toContain('FLOW_EVOLVED');
  });

  it('disabled by default: nothing computed, nothing stored', () => {
    const { config } = parseConfig(`target: { baseUrl: ${url} }\n`, {}, {});
    expect(config.regression.flowEvolution.enabled).toBe(false);
    expect(config.regression.anomalyLifecycle.enabled).toBe(false);
  });
});
