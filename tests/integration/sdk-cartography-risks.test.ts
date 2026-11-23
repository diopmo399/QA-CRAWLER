import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * L'API DES RISQUES D'ANOMALIES (vrai serveur, vrai scanner, fixture `tests/fixtures/risk`) : liste filtrée et
 * résumé, détail, preuves, impact développé, vérifications (simulation, test déclaré), suppression justifiée,
 * réglage des règles, refus motivés, et persistance (le rapport et l'état survivent au redémarrage du serveur).
 */
const FIXTURE = path.resolve('tests/fixtures/risk');
let workspace: string;
let sourcesRoot: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;

const start = async (): Promise<void> => {
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [sourcesRoot] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
};
const failure = async (call: Promise<unknown>): Promise<number> => {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(QaCrawlerError);
  return (error as QaCrawlerError).status;
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-risks-'));
  sourcesRoot = await mkdtemp(path.join(tmpdir(), 'sdk-risks-sources-'));
  await cp(FIXTURE, sourcesRoot, { recursive: true });
  await start();
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Risques', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
  });
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(sourcesRoot, { recursive: true, force: true });
});

describe('SDK server — anomaly risks API', () => {
  it('refuses before any scan, then lists the risks of the scan with their summary', async () => {
    expect(await failure(client.cartography.risks(project.id))).toBe(409);
    await client.cartography.saveConfig(project.id, {
      sources: (
        [
          ['front', 'FRONTEND'],
          ['backend', 'BACKEND'],
        ] as const
      ).map(([id, layer]) => ({
        id,
        name: id,
        layer,
        path: path.join(sourcesRoot, id),
        include: [],
        enabled: true,
      })),
    });
    await client.cartography.scan(project.id);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if ((await client.cartography.currentScan(project.id)).state !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const page = await client.cartography.risks(project.id, { size: 100 });
    expect(page.total).toBe(page.summary.total);
    expect(page.total).toBeGreaterThanOrEqual(15);
    expect(page.summary.byCategory.STATE).toBeGreaterThan(0);
    expect(page.summary.byLayer.BACKEND).toBeGreaterThan(0);
    expect(page.summary.rules.every((r) => r.enabled)).toBe(true);
    expect(page.summary.metrics.rulesRun).toBe(page.summary.rules.length);
    // Le rapport du scan est persisté (relu au lieu d'être recalculé).
    const files = (await readdir(workspace, { recursive: true })).filter((f) =>
      /cartography[\\/]risks[\\/]scan-[\w-]+\.json$/.test(f),
    );
    expect(files.length).toBe(1);
  });

  it('filters on the server and refuses an unknown filter value', async () => {
    const cleanup = await client.cartography.risks(project.id, { category: 'CLEANUP' });
    expect(cleanup.items.length).toBeGreaterThan(0);
    expect(cleanup.items.every((r) => r.category === 'CLEANUP')).toBe(true);
    const confident = await client.cartography.risks(project.id, { minConfidence: 0.8, size: 100 });
    expect(confident.items.every((r) => r.confidence >= 0.8)).toBe(true);
    const text = await client.cartography.risks(project.id, { q: 'lastClient' });
    expect(text.items.map((r) => r.ruleId)).toEqual(['RISK-BE-001']);
    expect(await failure(client.cartography.risks(project.id, { category: 'NOPE' as 'STATE' }))).toBe(400);
  });

  it('serves a risk, its evidence, its impact expanded deeper, and refuses an unknown id', async () => {
    const page = await client.cartography.risks(project.id, { q: 'ClientStore.selected peut garder' });
    const id = page.items[0]?.id ?? '';
    const risk = await client.cartography.risk(project.id, id);
    expect(risk.ruleId).toBe('RISK-STATE-001');
    expect(risk.evidence.length).toBeGreaterThan(0);
    const evidence = (await (
      await fetch(`${server.url}/api/projects/${project.id}/cartography/risks/${id}/evidence`, {
        headers: { authorization: `Bearer ${server.token}` },
      })
    ).json()) as { evidence: unknown[] };
    expect(evidence.evidence.length).toBe(risk.evidence.length);
    const deeper = await client.cartography.riskImpact(project.id, id, 8);
    expect(deeper.nodes.length).toBeGreaterThanOrEqual(risk.impact?.nodes.length ?? 0);
    expect(await failure(client.cartography.risk(project.id, 'R-0000000000000000'))).toBe(404);
  });

  it('verifies by simulation, records a declared test, and validates the declaration', async () => {
    const page = await client.cartography.risks(project.id, { q: 'OrderPageComponent.loading' });
    const id = page.items[0]?.id ?? '';
    const simulated = await client.cartography.verifyRisk(project.id, id, { method: 'STATE_SIMULATION' });
    expect(simulated.verifications.at(-1)?.method).toBe('STATE_SIMULATION');
    expect(simulated.verifications.at(-1)?.outcome).toBe('CORROBORATED');
    expect(simulated.status).toBe('CORROBORATED');
    expect(
      await failure(
        client.cartography.verifyRisk(project.id, id, { method: 'EXTERNAL_TEST', outcome: 'REPRODUCED' }),
      ),
    ).toBe(422);
    const declared = await client.cartography.verifyRisk(project.id, id, {
      method: 'EXTERNAL_TEST',
      outcome: 'REFUTED',
      observed: 'Le test du projet montre loading à faux après l’erreur (intercepteur global).',
    });
    expect(declared.status).toBe('REFUTED');
    expect(declared.confidence).toBeLessThanOrEqual(0.1);
    const history = await client.cartography.riskVerifications(project.id, id);
    expect(history.verifications.map((v) => v.method)).toEqual(
      expect.arrayContaining(['STATE_SIMULATION', 'EXTERNAL_TEST']),
    );
  });

  it('suppresses with a reason (refused without), lifts it, and toggles a rule', async () => {
    const page = await client.cartography.risks(project.id, { q: 'ContractService.read' });
    const id = page.items[0]?.id ?? '';
    expect(
      await failure(client.cartography.suppressRisk(project.id, id, { reason: 42 as unknown as string })),
    ).toBe(422);
    const suppressed = await client.cartography.suppressRisk(project.id, id, { reason: 'Absence tolérée.' });
    expect(suppressed.suppressed?.reason).toBe('Absence tolérée.');
    expect((await client.cartography.risks(project.id, { q: 'ContractService.read' })).total).toBe(0);
    expect(
      (await client.cartography.risks(project.id, { q: 'ContractService.read', suppressed: true })).total,
    ).toBe(1);
    const lifted = await client.cartography.suppressRisk(project.id, id, { reason: '' });
    expect(lifted.suppressed).toBeUndefined();
    const summary = await client.cartography.riskRules(project.id, { disabled: ['RISK-CLEAN-002'] });
    expect(summary.rules.find((r) => r.id === 'RISK-CLEAN-002')?.enabled).toBe(false);
    expect(
      (await client.cartography.risks(project.id, { size: 100 })).items.some(
        (r) => r.ruleId === 'RISK-CLEAN-002',
      ),
    ).toBe(false);
    expect(await failure(client.cartography.riskRules(project.id, { disabled: ['rm -rf'] }))).toBe(422);
    await client.cartography.riskRules(project.id, { disabled: [] });
  });

  it('keeps the declared verifications and the report across a server restart', async () => {
    const before = await client.cartography.risks(project.id, { q: 'OrderPageComponent.loading' });
    client.dispose();
    await server.close();
    await start();
    const after = await client.cartography.risks(project.id, { q: 'OrderPageComponent.loading' });
    expect(after.items[0]?.id).toBe(before.items[0]?.id);
    expect(after.items[0]?.status).toBe('REFUTED');
    expect(after.items[0]?.verifications.some((v) => v.method === 'EXTERNAL_TEST')).toBe(true);
  });
});
