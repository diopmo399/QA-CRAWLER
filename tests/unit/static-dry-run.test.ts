import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StaticPathHint } from '../../src/dry-run/dry-run-driver.js';
import { DryRunEngine } from '../../src/dry-run/dry-run-engine.js';
import { reconcile } from '../../src/dry-run/flow-reconciliation.js';
import type { Reconciliation } from '../../src/dry-run/reconciliation-model.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { StaticKnowledge } from '../../src/static-analysis/static-knowledge.js';
import { StaticPathResolver } from '../../src/static-analysis/static-path-resolver.js';
import { expectedFlow, SyntheticApp, UNLIMITED, type SyntheticScreen } from '../dry-run-app.js';
import { staticAnalyzerOptions } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');
const dictionary = new SemanticDictionary();

describe('StaticPathResolver: a hint from the routes, never a runtime truth (lot H)', () => {
  let resolver: StaticPathResolver;
  let knowledge: StaticKnowledge;

  beforeAll(async () => {
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(FIXTURE);
    const vocabulary = new SemanticVocabulary(dictionary);
    knowledge = new StaticKnowledge(graph, (text) => vocabulary.conceptOf(text)?.concept);
    resolver = new StaticPathResolver(knowledge, dictionary);
  });

  it('Dashboard → Users: the code says Dashboard → Administration → Users (STATIC_CODE, not confirmed)', () => {
    const hint = resolver.suggest('/dashboard', 'Users');
    expect(hint).toMatchObject({
      segments: ['administration', 'users'],
      route: '/administration/users',
      source: 'STATIC_CODE',
      runtimeConfirmed: false,
    });
    // router.navigate(['/administration', 'users']) dans DashboardComponent corrobore la route.
    expect(hint?.description).toContain('router navigation in the code');
    expect(hint?.description).toContain('guarded route');
    expect(hint?.confidence).toBeGreaterThan(0.7);
  });

  it('a route is RUNTIME_CONFIRMED only once the UI walked it', () => {
    expect(knowledge.graph.routes.find((route) => route.path === '/administration/users')?.truth).toBe(
      'STATIC_DISCOVERED',
    );
    knowledge.confirmRoute('/administration/users');
    expect(knowledge.graph.routes.find((route) => route.path === '/administration/users')?.truth).toBe(
      'RUNTIME_CONFIRMED',
    );
  });

  it('no route for an unknown intent: no hint', () => {
    expect(resolver.suggest('/dashboard', 'Facturation')).toBeUndefined();
  });
});

/** Le tableau de bord a des liens qui passent avant « Administration » ; seul Administration mène à Users. */
const SCREENS: Record<string, SyntheticScreen> = {
  dash: {
    label: 'Dashboard',
    actions: [
      { label: 'Accueil', to: 'home' },
      { label: 'Actualités', to: 'news' },
      { label: 'Administration', to: 'admin' },
    ],
  },
  home: { label: 'Accueil', actions: [{ label: 'Aide', to: 'help' }] },
  news: { label: 'Actualités', actions: [{ label: 'Archives', to: 'help' }] },
  help: { label: 'Aide' },
  admin: { label: 'Administration', actions: [{ label: 'Users', to: 'users' }] },
  users: { label: 'Users list' },
};

async function run(hint: StaticPathHint | undefined): Promise<{
  reconciliation: Reconciliation;
  executed: string[];
  outcomes: [boolean, readonly string[]][];
}> {
  const app = new SyntheticApp(SCREENS, 'dash');
  const outcomes: [boolean, readonly string[]][] = [];
  if (hint) {
    app.staticHints = (target) => (target.label === 'Users' ? { ...hint } : undefined);
    app.staticPathOutcome = (_hint, confirmed, path) => outcomes.push([confirmed, path]);
  }
  const graph = expectedFlow('users', [
    ['NAVIGATE', 'Dashboard'],
    ['CLICK', 'Users'],
  ]);
  // Deux actions essayées par écran : sans indice, « Administration » (3e) n'est jamais essayée.
  const engine = new DryRunEngine(
    app,
    { budget: { ...UNLIMITED, maxAlternativePaths: 2 }, continueAfterMismatch: true },
    () => undefined,
  );
  const { observed, findings } = await engine.run(graph);
  return { reconciliation: reconcile(graph, observed, findings), executed: app.executed, outcomes };
}

const rows = (reconciliation: Reconciliation): string[] =>
  reconciliation.entries.map(
    (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
  );

describe('Dry Run with static knowledge: use the code as a hint, confirm with the UI (lot H)', () => {
  const hint: StaticPathHint = {
    segments: ['administration', 'users'],
    route: '/administration/users',
    source: 'STATIC_CODE',
    confidence: 0.85,
    runtimeConfirmed: false,
    description: '/dashboard → /administration/users',
  };

  it('Dashboard MATCHED, Administration INSERTED (clicked for real), Users MATCHED; the path is confirmed at runtime', async () => {
    const { reconciliation, executed, outcomes } = await run(hint);
    expect(rows(reconciliation)).toEqual(['Dashboard MATCHED', 'Administration INSERTED', 'Users MATCHED']);
    // Administration a été cliquée pour de vrai, avant les autres liens : aucun raccourci vers la route.
    expect(executed[0]).toBe('Administration');
    expect(outcomes).toContainEqual([true, ['Administration']]);
    // Le chemin retenu cite l'indice du code et sa confirmation par l'exécution.
    const evidence = reconciliation.entries
      .flatMap((entry) => [...entry.reasons, ...entry.evidence])
      .join(' ');
    expect(evidence).toContain('path suggested by the application code');
    expect(evidence).toContain('confirmed at runtime: Administration');
  });

  it('without static knowledge (non-regression): the same budget does not find Users', async () => {
    const { reconciliation } = await run(undefined);
    expect(rows(reconciliation)).not.toContain('Users MATCHED');
  });

  it('a hint the UI does not confirm is reported as rejected, never used as a truth', async () => {
    const wrong: StaticPathHint = {
      ...hint,
      segments: ['facturation'],
      description: '/dashboard → /billing',
    };
    const { reconciliation, outcomes } = await run(wrong);
    expect(rows(reconciliation)).not.toContain('Users MATCHED');
    expect(outcomes.some(([confirmed]) => !confirmed)).toBe(true);
  });
});
