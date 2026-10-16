import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import { startOrbitApp, type OrbitApp } from '../fixtures/orbit-desk-app.js';

/**
 * Orbit Desk (npm run demo:server) avec la mission livrée scenarios/demo-orbit.yaml : les deux flows
 * passent, l'écran Rapports en panne est détecté (GET /api/statistiques → 500), la suppression et
 * l'assignation sont bloquées, rien n'est créé, et le rapport et les tests générés sont en français.
 */
describe('Orbit Desk demo (scenarios/demo-orbit.yaml)', () => {
  let app: OrbitApp;
  beforeAll(async () => {
    app = await startOrbitApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('runs the bundled mission: flows pass, the HTTP 500 is found, writes are blocked, the report is French', async () => {
    const reportsDir = await mkdtemp(path.join(tmpdir(), 'qa-orbit-'));
    const { config, warnings } = await loadConfigFile('scenarios/demo-orbit.yaml', {
      baseUrl: app.url,
      reportsDir,
      headless: true,
      persistence: 'off',
    });
    expect(warnings).toEqual([]);
    const { result } = await runMission(config);

    expect(result.flows.map((flow) => [flow.name, flow.status])).toEqual([
      ['consulter-les-rapports', 'PASSED'],
      ['ouvrir-un-dossier', 'PASSED'],
    ]);
    const serverError = result.issues.find((issue) => issue.status === 500);
    expect(serverError?.requestUrl).toMatch(/\/api\/statistiques$/);
    expect(result.stats.actionsBlocked).toBeGreaterThanOrEqual(2);
    // « Créer la demande » est une soumission bloquée par la mission : aucune demande créée.
    expect(app.created).toBe(0);

    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('Erreurs HTTP et pages cassées');
    expect(html).toContain('Actions bloquées');
    expect(html).toContain('Supprimer');
    expect((await readdir(path.join(reportsDir, 'generated-tests'))).sort()).toEqual([
      'consulter-les-rapports.spec.ts',
      'ouvrir-un-dossier.spec.ts',
    ]);
  }, 180_000);
});
