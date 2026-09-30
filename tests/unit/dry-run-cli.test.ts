import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../src/cli/args.js';
import { runCli } from '../../src/cli/cli.js';
import { parseDryRunArgs } from '../../src/cli/dry-run-command.js';
import { scenarioName } from '../../src/dry-run/dry-run-orchestrator.js';
import { findKnownPaths, type KnownEdge } from '../../src/dry-run/known-paths.js';
import { loadDryRunScenario } from '../../src/dry-run/scenario-input.js';

describe('qa-crawler dry-run: arguments', () => {
  it('a scenario, a mission, the budgets and the output format', () => {
    expect(
      parseDryRunArgs([
        'create-user.feature',
        '-c',
        'mission.yaml',
        '--no-history',
        '--max-depth',
        '8',
        '--max-actions',
        '40',
        '--max-duration',
        '2m',
        '--output-format',
        'both',
      ]),
    ).toEqual({
      scenario: 'create-user.feature',
      configPath: 'mission.yaml',
      useHistory: false,
      maxDepth: 8,
      maxActions: 40,
      maxDurationMs: 120_000,
      outputFormat: 'both',
      quiet: false,
      help: false,
    });
    expect(parseDryRunArgs(['x.flow.yaml', '--use-history', '--max-duration', '90s'])).toMatchObject({
      useHistory: true,
      maxDurationMs: 90_000,
    });
    expect(parseDryRunArgs(['x.feature', '--max-duration', '120000']).maxDurationMs).toBe(120_000);
    expect(parseDryRunArgs(['x.feature', '--isolated-memory']).isolatedMemory).toBe(true);
    expect(parseDryRunArgs(['x.feature']).isolatedMemory).toBeUndefined();
  });

  it('refuses what makes no sense, with the reason', () => {
    expect(() => parseDryRunArgs(['a.feature', 'b.feature'])).toThrow(UsageError);
    expect(() => parseDryRunArgs(['a.feature', '--use-history', '--no-history'])).toThrow(/either/);
    expect(() => parseDryRunArgs(['a.feature', '--output-format', 'pdf'])).toThrow(/gherkin, yaml or both/);
    expect(() => parseDryRunArgs(['a.feature', '--max-depth', '0'])).toThrow(/positive integer/);
    expect(() => parseDryRunArgs(['a.feature', '--max-duration', 'soon'])).toThrow(/duration/);
    expect(() => parseDryRunArgs(['a.feature', '--unknown'])).toThrow(UsageError);
  });

  it('the dry-run command: help, missing file, invalid scenario (exit codes)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runCli(['dry-run', '--help'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain(
        'qa-crawler dry-run <scenario.feature | scenario.flow.yaml>',
      );
      expect(await runCli(['dry-run'])).toBe(2);
      expect(await runCli(['dry-run', 'missing.feature', '--base-url', 'http://localhost:1'])).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('Scenario file not found: missing.feature');
      // Les autres commandes ne changent pas.
      expect(await runCli(['--help'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('dry-run  Check a scenario');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('the report folder is named after the scenario', () => {
    expect(scenarioName('features/create-user.feature')).toBe('create-user');
    expect(scenarioName('/x/create-user.flow.yaml')).toBe('create-user');
    expect(scenarioName('Créer Utilisateur.yml')).toBe('creer-utilisateur');
  });

  it('without a mission: the target from --base-url is enough', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-dry-run-cli-'));
    await writeFile(
      path.join(dir, 'x.flow.yaml'),
      'name: x\nsteps:\n  - goto: /\n  - click: { text: Suivant }\n',
    );
    const loaded = loadDryRunScenario({
      scenarioFile: path.join(dir, 'x.flow.yaml'),
      overrides: { baseUrl: 'http://localhost:4200' },
    });
    expect(loaded.config.target.baseUrl).toBe('http://localhost:4200');
    expect(loaded.graphs[0]?.intents.map((intent) => intent.type)).toEqual(['NAVIGATE', 'CLICK']);
  });
});

describe('known paths (graph, memory, KnowledgeBase)', () => {
  const edges: KnownEdge[] = [
    { from: 'dash', action: 'click:administration', to: 'admin', count: 97, source: 'historical' },
    { from: 'admin', action: 'click:utilisateurs', to: 'users', count: 97, source: 'historical' },
    { from: 'dash', action: 'click:acces-rapide', to: 'quick', count: 3, source: 'historical' },
    { from: 'quick', action: 'click:utilisateurs', to: 'users', count: 3, source: 'historical' },
    { from: 'dash', action: 'click:profil', to: 'profile', count: 1, source: 'graph' },
    { from: 'profile', action: 'click:tableau-de-bord', to: 'dash', count: 1, source: 'graph' },
  ];

  it('shortest first, with the observed frequency (share), never a probability', () => {
    const paths = findKnownPaths(edges, 'dash', (state) => state === 'users', { maxDepth: 5, maxPaths: 5 });
    expect(paths).toEqual([
      {
        actions: ['click:administration', 'click:utilisateurs'],
        source: 'historical',
        observations: 97,
        share: 0.97,
      },
      {
        actions: ['click:acces-rapide', 'click:utilisateurs'],
        source: 'historical',
        observations: 3,
        share: 0.03,
      },
    ]);
  });

  it('no loop, bounded depth, the same transition seen twice counts twice', () => {
    expect(findKnownPaths(edges, 'dash', (state) => state === 'users', { maxDepth: 1, maxPaths: 5 })).toEqual(
      [],
    );
    const doubled = findKnownPaths(
      [...edges, { from: 'dash', action: 'click:administration', to: 'admin', count: 1, source: 'graph' }],
      'dash',
      (state) => state === 'admin',
      { maxDepth: 3, maxPaths: 5 },
    );
    expect(doubled).toEqual([{ actions: ['click:administration'], source: 'historical', observations: 98 }]);
    // Profil → Tableau de bord ramène au départ : jamais un chemin.
    expect(findKnownPaths(edges, 'dash', (state) => state === 'dash', { maxDepth: 5, maxPaths: 5 })).toEqual(
      [],
    );
  });
});
