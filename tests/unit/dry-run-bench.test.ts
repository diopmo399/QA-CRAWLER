import { describe, expect, it } from 'vitest';
import { DryRunEngine } from '../../src/dry-run/dry-run-engine.js';
import { reconcile } from '../../src/dry-run/flow-reconciliation.js';
import type { KnownPath } from '../../src/dry-run/dry-run-driver.js';
import { expectedFlow, SyntheticApp, UNLIMITED, type SyntheticScreen } from '../dry-run-app.js';

/**
 * BENCHMARKS sur des graphes synthétiques : un arbre de `branching`^`depth` écrans. La
 * cible est tout au fond de la dernière branche. Mesure : actions exécutées, écrans
 * visités, durée ; et l'effet des chemins connus et de la proximité sémantique.
 */
function tree(
  branching: number,
  depth: number,
  names: (level: number, index: number) => string,
): { screens: Record<string, SyntheticScreen>; count: number } {
  const screens: Record<string, SyntheticScreen> = {};
  let count = 0;
  const build = (id: string, level: number): void => {
    count += 1;
    const children =
      level < depth
        ? Array.from({ length: branching }, (_, index) => ({
            label: names(level, index),
            to: `${id}.${String(index)}`,
          }))
        : id === `r${'.'.concat(String(branching - 1)).repeat(depth)}`
          ? [{ label: 'Utilisateurs', to: 'users' }]
          : [];
    screens[id] = { label: `Écran ${id}`, actions: children };
    if (level < depth)
      children.forEach((child) => {
        build(child.to, level + 1);
      });
  };
  build('r', 0);
  screens.users = { label: 'Utilisateurs' };
  return { screens, count: count + 1 };
}

const graph = expectedFlow('bench', [['CLICK', 'Utilisateurs']]);
const run = async (app: SyntheticApp, budget: Partial<typeof UNLIMITED> = {}) => {
  const engine = new DryRunEngine(app, { budget: { ...UNLIMITED, ...budget }, continueAfterMismatch: true });
  const started = performance.now();
  const { observed, findings } = await engine.run(graph);
  return {
    ms: performance.now() - started,
    reconciliation: reconcile(graph, observed, findings),
    actions: observed.budget.actions,
  };
};

describe('dry run benchmarks (synthetic graphs)', () => {
  // 5^4 : 781 écrans ; la cible sous la dernière branche de chaque niveau.
  const blind = tree(5, 4, (level, index) => `Section ${String(level)}-${String(index)}`);

  it('blind search: found, every screen expanded at most once, within the budget', async () => {
    const result = await run(new SyntheticApp(blind.screens, 'r'), { maxActions: 2000 });
    expect(result.reconciliation.entries.at(-1)?.status).toBe('MATCHED');
    // Chaque écran n'est développé qu'une fois : au plus une action par arête de l'arbre.
    expect(result.actions).toBeLessThan(blind.count);
    expect(result.ms).toBeLessThan(2000);
    console.info(
      `blind: ${String(blind.count)} screens, ${String(result.actions)} actions, ${result.ms.toFixed(0)} ms`,
    );
  });

  it('a known path first: the path is replayed, nothing else is explored', async () => {
    const path: KnownPath = {
      actions: ['click:section-#-#', 'click:section-#-#', 'click:section-#-#', 'click:section-#-#'],
      source: 'historical',
      observations: 40,
    };
    // Signatures stables : les chiffres sont masqués ; le chemin rejoue « la première action de même signature ».
    const named = tree(5, 4, (level, index) =>
      index === 4 ? `Administration ${String(level)}` : `Autre ${String(level)}-${String(index)}`,
    );
    const known: KnownPath = {
      actions: [
        'click:administration-#',
        'click:administration-#',
        'click:administration-#',
        'click:administration-#',
      ],
      source: 'historical',
      observations: 40,
    };
    const app = new SyntheticApp(named.screens, 'r', { history: { 'r>utilisateurs': [known, path] } });
    const result = await run(app);
    expect(result.reconciliation.entries.map((entry) => entry.status)).toEqual([
      'INSERTED',
      'INSERTED',
      'INSERTED',
      'INSERTED',
      'MATCHED',
    ]);
    expect(result.actions).toBe(4);
    console.info(
      `known path: ${String(named.count)} screens, ${String(result.actions)} actions, ${result.ms.toFixed(0)} ms`,
    );
  });

  it('semantic proximity guides the search: far fewer actions than a blind search', async () => {
    // Même arbre, mais la branche qui mène à la cible dit « Gestion des utilisateurs ».
    const hinted = tree(5, 4, (level, index) =>
      index === 4 ? `Gestion des utilisateurs ${String(level)}` : `Section ${String(level)}-${String(index)}`,
    );
    const blindRun = await run(new SyntheticApp(blind.screens, 'r'), { maxActions: 2000 });
    const hintedRun = await run(new SyntheticApp(hinted.screens, 'r'), {
      maxActions: 2000,
      maxAlternativePaths: 1,
    });
    expect(hintedRun.reconciliation.entries.at(-1)?.status).toBe('MATCHED');
    expect(hintedRun.actions).toBe(4);
    expect(hintedRun.actions).toBeLessThan(blindRun.actions / 10);
    console.info(`semantic: ${String(hintedRun.actions)} actions vs blind ${String(blindRun.actions)}`);
  });

  it('a large graph and a small budget: stops on time, NOT_VERIFIED, never UNREACHABLE', async () => {
    const big = tree(6, 5, (level, index) => `Zone ${String(level)}-${String(index)}`);
    const result = await run(new SyntheticApp(big.screens, 'r'), { maxActions: 50 });
    expect(result.actions).toBeLessThanOrEqual(50);
    expect(result.reconciliation.entries[0]?.status).toBe('NOT_VERIFIED');
    expect(result.reconciliation.stopReason).toBe('EXPLORATION_BUDGET_EXHAUSTED');
    expect(result.ms).toBeLessThan(1000);
    console.info(
      `budget: ${String(big.count)} screens, ${String(result.actions)} actions, ${result.ms.toFixed(0)} ms`,
    );
  });
});
