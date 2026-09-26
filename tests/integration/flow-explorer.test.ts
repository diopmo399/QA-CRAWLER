import { access, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowGraphData } from '../../src/model/flow.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startFlowApp, type FlowApp } from '../fixtures/flow-app.js';

/**
 * Main acceptance test: only a start URL and a general mission — no list of
 * buttons. The explorer must observe, discover, decide, pass the safety
 * policy, execute with Playwright, record transitions, backtrack and build
 * the flow graph of the back-office by itself.
 */
describe('FlowExplorer on the mini back-office', () => {
  let app: FlowApp;
  let result: ExplorationResult;
  let outputDir: string;

  beforeAll(async () => {
    app = await startFlowApp();
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-flow-'));
    const { config } = parseConfig(
      `
mission:
  name: explore-back-office
target:
  baseUrl: ${app.url}
exploration:
  maxStates: 40
  maxActions: 150
  maxDurationMinutes: 3
  actionTimeoutMs: 5000
  settleTimeMs: 150
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    ({ result } = await runMission(config));
  });

  afterAll(async () => {
    await app.close();
  });

  const heading = (text: string) =>
    result.states.filter((state) => state.headings.some((h) => h.includes(text)));
  const stateByHeading = (text: string) => heading(text)[0];

  it('discovers the screens of the application', () => {
    for (const title of [
      'Tableau de bord',
      'Utilisateurs',
      'Utilisateur',
      'Dossiers',
      'Nouveau dossier',
      'Paramètres',
      'Administration',
      'Journal',
    ]) {
      expect(heading(title).length, title).toBeGreaterThan(0);
    }
    expect(result.stats.states).toBeGreaterThanOrEqual(12);
    expect(result.stopReason).toBe('exhausted');
  });

  it('discovers states that share one URL: tabs and wizard steps', () => {
    const settings = result.states.filter((state) => state.route === '/settings');
    expect(settings.length).toBe(3);
    const wizard = result.states.filter((state) => state.route === '/dossiers/create');
    const steps = wizard.flatMap((state) => state.headings.filter((h) => h.startsWith('Étape')));
    expect(steps).toEqual(
      expect.arrayContaining(['Étape 1 — Informations', 'Étape 2 — Détails', 'Étape 3 — Confirmation']),
    );
  });

  it('records transitions, including same-URL transitions, and backtracks', () => {
    expect(result.stats.transitions).toBeGreaterThanOrEqual(12);
    const step = (n: number) =>
      result.states.find((state) => state.headings.some((h) => h.startsWith(`Étape ${n}`)));
    const stepTransition = result.transitions.find(
      (edge) => edge.from === step(1)?.id && edge.to === step(2)?.id && edge.result === 'SUCCESS',
    );
    expect(stepTransition?.action.text).toBe('Suivant');
    expect(result.stats.backtracks).toBeGreaterThan(0);
  });

  it('builds a tree matching the application structure', () => {
    const rootId = result.states[0]?.id;
    expect(stateByHeading('Tableau de bord')?.id).toBe(rootId);
    const byId = new Map(result.states.map((state) => [state.id, state]));
    const detail = stateByHeading('Utilisateur ');
    expect(detail?.flow.map((id) => byId.get(id)?.headings[0])).toEqual([
      'Tableau de bord',
      'Utilisateurs',
      'Utilisateur 1',
    ]);
  });

  it('never executes dangerous or mutating actions, and reports them as blocked', () => {
    expect(app.dangerousHits).toEqual([]);
    const blocked = result.transitions
      .filter((edge) => edge.result === 'BLOCKED')
      .map((edge) => edge.action.text);
    expect(blocked).toEqual(
      expect.arrayContaining([
        "Supprimer l'utilisateur",
        'Vider le cache',
        'Enregistrer le dossier',
        'Nouvel utilisateur',
        'Déconnexion',
      ]),
    );
    // The card number field is never filled.
    const card = result.states
      .flatMap((state) => state.actionsDetail)
      .find((action) => action.label?.includes('carte'));
    expect(card).toMatchObject({ classification: 'DANGEROUS', risks: ['sensitive-data'] });
    expect(result.transitions.some((edge) => edge.actionId === card?.id && edge.result === 'SUCCESS')).toBe(
      false,
    );
  });

  it('bounds record pages (/users/:id)', () => {
    const users = result.states.filter((state) => state.route === '/users/:id');
    expect(users.length).toBeLessThanOrEqual(3);
    const visits = result.transitions.filter(
      (edge) => edge.action.text === 'Voir' && edge.result === 'SUCCESS',
    );
    expect(visits.length).toBeLessThanOrEqual(3);
  });

  it('attributes anomalies to a state, an action and a flow', () => {
    const logs = result.issues.find((issue) => issue.type === 'HTTP' && issue.status === 500);
    expect(logs).toBeDefined();
    const journal = stateByHeading('Journal');
    expect(logs?.stateId).toBe(journal?.id);
    expect(logs?.actionId).toBeDefined();
    expect(logs?.flow?.at(-1)).toBe(journal?.id);
    // Shortest reproduction path: start → Administration → Journal.
    expect(logs?.flow?.length).toBe(3);
  });

  it('writes result.json, index.html, flow-graph.json, flow-graph.html and screenshots', async () => {
    const reports = path.join(outputDir, 'reports');
    for (const file of ['result.json', 'index.html', 'flow-graph.json', 'flow-graph.html']) {
      await access(path.join(reports, file));
    }
    const graph = JSON.parse(await readFile(path.join(reports, 'flow-graph.json'), 'utf8')) as FlowGraphData;
    expect(graph.nodes.length).toBe(result.stats.states);
    expect(graph.edges.length).toBe(result.transitions.length);
    const html = await readFile(path.join(reports, 'flow-graph.html'), 'utf8');
    expect(html).toContain('Nouveau dossier');
    const shots = await readdir(path.join(outputDir, 'screenshots'));
    expect(shots.length).toBeGreaterThanOrEqual(result.stats.states);
    for (const file of shots) expect(file).toMatch(/^\d{3}-[a-z0-9-]+\.png$/);
  });
});
