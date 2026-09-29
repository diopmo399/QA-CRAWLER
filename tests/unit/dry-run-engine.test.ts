import { describe, expect, it } from 'vitest';
import { DryRunEngine, type DryRunEvent } from '../../src/dry-run/dry-run-engine.js';
import { alignSequences } from '../../src/dry-run/flow-alignment.js';
import type { FlowIntentGraph } from '../../src/dry-run/flow-intent-graph.js';
import { reconcile } from '../../src/dry-run/flow-reconciliation.js';
import type { Reconciliation } from '../../src/dry-run/reconciliation-model.js';
import { expectedFlow, SyntheticApp, UNLIMITED, type SyntheticScreen } from '../dry-run-app.js';

/** Écran → action unique vers l'écran suivant : A → B → C … */
function chain(
  labels: string[],
  extra: Record<string, SyntheticScreen> = {},
): Record<string, SyntheticScreen> {
  const screens: Record<string, SyntheticScreen> = {};
  labels.forEach((label, index) => {
    screens[`s${String(index)}`] = {
      label: `Écran ${String(index)}`,
      actions: [{ label, to: `s${String(index + 1)}` }],
    };
  });
  screens[`s${String(labels.length)}`] = { label: 'Fin' };
  return { ...screens, ...extra };
}

async function dryRun(
  app: SyntheticApp,
  graph: FlowIntentGraph,
  options: Partial<typeof UNLIMITED> & { continueAfterMismatch?: boolean } = {},
): Promise<{ reconciliation: Reconciliation; events: DryRunEvent[] }> {
  const events: DryRunEvent[] = [];
  const { continueAfterMismatch = true, ...budget } = options;
  const engine = new DryRunEngine(
    app,
    { budget: { ...UNLIMITED, ...budget }, continueAfterMismatch },
    (event) => events.push(event),
  );
  const { observed, findings } = await engine.run(graph);
  return { reconciliation: reconcile(graph, observed, findings), events };
}

const rows = (reconciliation: Reconciliation): string[] =>
  reconciliation.entries.map(
    (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
  );

describe('FlowAlignment: sequences, never expected[i] === observed[i]', () => {
  const same = (a: string, b: string): boolean => a === b;
  const describeOps = (expected: string[], observed: string[]): string[] =>
    alignSequences(expected, observed, same).map((op) =>
      op.kind === 'INSERT' ? `${op.observed} INSERT` : `${op.expected} ${op.kind}`,
    );

  it('the critical case: A C F against A B C D E F', () => {
    expect(describeOps(['A', 'C', 'F'], ['A', 'B', 'C', 'D', 'E', 'F'])).toEqual([
      'A MATCH',
      'B INSERT',
      'C MATCH',
      'D INSERT',
      'E INSERT',
      'F MATCH',
    ]);
  });

  it('an obsolete step: A B C D against A X C D (B deleted, X inserted, nothing stops at B)', () => {
    expect(describeOps(['A', 'B', 'C', 'D'], ['A', 'X', 'C', 'D'])).toEqual([
      'A MATCH',
      'B DELETE',
      'X INSERT',
      'C MATCH',
      'D MATCH',
    ]);
  });

  it('reordering is not "B missing + B inserted"', () => {
    expect(describeOps(['A', 'B', 'C', 'D'], ['A', 'C', 'B', 'D'])).toEqual([
      'A MATCH',
      'C MATCH',
      'B REORDER',
      'D MATCH',
    ]);
  });

  it('identical sequences, empty sides', () => {
    expect(describeOps(['A', 'B'], ['A', 'B'])).toEqual(['A MATCH', 'B MATCH']);
    expect(describeOps([], ['A'])).toEqual(['A INSERT']);
    expect(describeOps(['A'], [])).toEqual(['A DELETE']);
  });
});

describe('DryRunEngine + reconciliation, on synthetic applications', () => {
  it('exact match: FULLY_MATCHED, every step MATCHED', async () => {
    const app = new SyntheticApp(chain(['Utilisateurs', 'Créer']), 's0');
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('exact', [
        ['CLICK', 'Utilisateurs'],
        ['CLICK', 'Créer'],
      ]),
    );
    expect(rows(reconciliation)).toEqual(['Utilisateurs MATCHED', 'Créer MATCHED']);
    expect(reconciliation.status).toBe('FULLY_MATCHED');
  });

  it('an inserted step: Dashboard → Administration → Users', async () => {
    const app = new SyntheticApp(
      {
        dash: {
          label: 'Tableau de bord',
          actions: [
            { label: 'Profil', to: 'profile' },
            { label: 'Administration', to: 'admin' },
          ],
        },
        profile: { label: 'Profil', actions: [{ label: 'Préférences', to: 'prefs' }] },
        prefs: { label: 'Préférences' },
        admin: { label: 'Administration', actions: [{ label: 'Utilisateurs', to: 'users' }] },
        users: { label: 'Utilisateurs', texts: ['Liste des utilisateurs'] },
      },
      'dash',
    );
    const { reconciliation, events } = await dryRun(app, expectedFlow('users', [['CLICK', 'Utilisateurs']]));
    expect(rows(reconciliation)).toEqual(['Administration INSERTED', 'Utilisateurs MATCHED']);
    expect(reconciliation.status).toBe('PARTIALLY_MATCHED');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'INTENT_MISMATCH',
        'GUIDED_EXPLORATION_STARTED',
        'PATH_DISCOVERED',
        'FLOW_STEP_INSERTED',
        'INTENT_MATCHED',
      ]),
    );
    // L'explication de l'insertion : où, comment, avec quelle preuve.
    const inserted = reconciliation.entries[0];
    expect(inserted?.reasons.join('\n')).toContain('observed between "Tableau de bord" and "Administration"');
    expect(inserted?.evidence).toContain('action click:administration (SAFE)');
  });

  it('several inserted steps: expected A C F, application A B C D E F', async () => {
    const app = new SyntheticApp(chain(['A', 'B', 'C', 'D', 'E', 'F', 'G']), 's0');
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('checkpoints', [
        ['CLICK', 'A'],
        ['CLICK', 'C'],
        ['CLICK', 'F'],
      ]),
    );
    expect(rows(reconciliation)).toEqual([
      'A MATCHED',
      'B INSERTED',
      'C MATCHED',
      'D INSERTED',
      'E INSERTED',
      'F MATCHED',
    ]);
    expect(reconciliation.summary).toMatchObject({ originalIntents: 3, matched: 3, inserted: 3 });
  });

  it('a possibly obsolete step: expected A B C D, application A X C D — the analysis never stops at B', async () => {
    const app = new SyntheticApp(chain(['A', 'X', 'C', 'D', 'E']), 's0');
    const { reconciliation, events } = await dryRun(
      app,
      expectedFlow('obsolete', [
        ['CLICK', 'A'],
        ['CLICK', 'B'],
        ['CLICK', 'C'],
        ['CLICK', 'D'],
      ]),
    );
    expect(rows(reconciliation)).toEqual([
      'A MATCHED',
      'B POSSIBLY_OBSOLETE',
      'X INSERTED',
      'C MATCHED',
      'D MATCHED',
    ]);
    const obsolete = reconciliation.entries[1];
    expect(obsolete?.reasons).toEqual(
      expect.arrayContaining([
        'kept for review, never deleted automatically',
        'no historical knowledge (memory off)',
      ]),
    );
    expect(events.some((event) => event.type === 'FLOW_STEP_POSSIBLY_OBSOLETE')).toBe(true);
    expect(reconciliation.status).toBe('DIVERGED');
  });

  it('history lowers the confidence that a step is obsolete (seen before: it may have moved)', async () => {
    const graph = expectedFlow('obsolete', [
      ['CLICK', 'A'],
      ['CLICK', 'B'],
      ['CLICK', 'C'],
    ]);
    const seen = await dryRun(
      new SyntheticApp(chain(['A', 'X', 'C']), 's0', { historicalObservations: { b: 12 } }),
      graph,
    );
    const never = await dryRun(
      new SyntheticApp(chain(['A', 'X', 'C']), 's0', { historicalObservations: { b: 0 } }),
      graph,
    );
    expect(seen.reconciliation.entries[1]).toMatchObject({ status: 'POSSIBLY_OBSOLETE', confidence: 0.4 });
    expect(never.reconciliation.entries[1]).toMatchObject({ status: 'POSSIBLY_OBSOLETE', confidence: 0.7 });
  });

  it('a step that exists elsewhere in the application is MISSING here, not obsolete', async () => {
    const screens = chain(['A', 'X', 'C'], {
      other: { label: 'Ailleurs', actions: [{ label: 'B', to: 's0' }] },
    });
    const { reconciliation } = await dryRun(
      new SyntheticApp(screens, 's0'),
      expectedFlow('missing', [
        ['CLICK', 'A'],
        ['CLICK', 'B'],
        ['CLICK', 'C'],
      ]),
    );
    expect(reconciliation.entries[1]?.status).toBe('MISSING');
  });

  it('reordered steps: expected A B C D, application A C B D', async () => {
    const app = new SyntheticApp(chain(['A', 'C', 'B', 'D']), 's0');
    const { reconciliation, events } = await dryRun(
      app,
      expectedFlow('reorder', [
        ['CLICK', 'A'],
        ['CLICK', 'B'],
        ['CLICK', 'C'],
        ['CLICK', 'D'],
      ]),
    );
    expect(rows(reconciliation)).toEqual(['A MATCHED', 'C MATCHED', 'B REORDERED', 'D MATCHED']);
    expect(events.some((event) => event.type === 'FLOW_STEP_REORDERED')).toBe(true);
    expect(reconciliation.status).toBe('PARTIALLY_MATCHED');
  });

  it('an alternative path: the historical one is replayed, confirmed, and the other is named', async () => {
    const app = new SyntheticApp(
      {
        dash: {
          label: 'Tableau de bord',
          actions: [
            { label: 'Accès rapide', to: 'quick' },
            { label: 'Administration', to: 'admin' },
          ],
        },
        quick: { label: 'Accès rapide', actions: [{ label: 'Utilisateurs', to: 'users' }] },
        admin: { label: 'Administration', actions: [{ label: 'Utilisateurs', to: 'users' }] },
        users: { label: 'Utilisateurs' },
      },
      'dash',
      {
        history: {
          'dash>utilisateurs': [
            // Vu dans ce run (graphe) : un autre chemin valide.
            { actions: ['click:acces-rapide'], source: 'graph', observations: 3, share: 0.03 },
            { actions: ['click:administration'], source: 'historical', observations: 97, share: 0.97 },
          ],
        },
      },
    );
    const { reconciliation } = await dryRun(app, expectedFlow('alt', [['CLICK', 'Utilisateurs']]));
    expect(rows(reconciliation)).toEqual(['Administration ALTERNATIVE', 'Utilisateurs MATCHED']);
    expect(app.executed).toEqual(['Administration', 'Utilisateurs']);
    const alternative = reconciliation.entries[0];
    expect(alternative?.confidence).toBe(0.95);
    expect(alternative?.evidence).toContain('provenance HISTORICAL_CONFIRMED');
    expect(alternative?.reasons.join('\n')).toContain('other known path(s): click:acces-rapide');
    // Une fréquence observée, jamais présentée comme une probabilité.
    expect(reconciliation.entries[1]?.reasons.join('\n')).toContain(
      '97% of the observed runs, not a probability',
    );
  });

  it('an alternative only known from history is named, not presented as valid', async () => {
    const app = new SyntheticApp(
      {
        dash: { label: 'Tableau de bord', actions: [{ label: 'Administration', to: 'admin' }] },
        admin: { label: 'Administration', actions: [{ label: 'Utilisateurs', to: 'users' }] },
        users: { label: 'Utilisateurs' },
      },
      'dash',
      {
        history: {
          'dash>utilisateurs': [
            { actions: ['click:administration'], source: 'historical', observations: 97 },
            { actions: ['click:acces-rapide'], source: 'historical', observations: 3 },
          ],
        },
      },
    );
    const { reconciliation } = await dryRun(app, expectedFlow('hist', [['CLICK', 'Utilisateurs']]));
    expect(rows(reconciliation)).toEqual(['Administration INSERTED', 'Utilisateurs MATCHED']);
    expect(reconciliation.entries[1]?.reasons.join('\n')).toContain(
      'other historical path(s), not confirmed in this run: click:acces-rapide',
    );
  });

  it('memory proposes, the application confirms: a known path whose step is gone is not used', async () => {
    const app = new SyntheticApp(
      {
        dash: { label: 'Tableau de bord', actions: [{ label: 'Administration', to: 'admin' }] },
        admin: { label: 'Administration', actions: [{ label: 'Utilisateurs', to: 'users' }] },
        users: { label: 'Utilisateurs' },
      },
      'dash',
      {
        history: {
          'dash>utilisateurs': [{ actions: ['click:gestion'], source: 'historical', observations: 50 }],
        },
      },
    );
    const { reconciliation } = await dryRun(app, expectedFlow('stale', [['CLICK', 'Utilisateurs']]));
    expect(rows(reconciliation)).toEqual(['Administration INSERTED', 'Utilisateurs MATCHED']);
    expect(reconciliation.entries[0]?.evidence).toContain('provenance OBSERVED');
  });

  it('ambiguous: two controls with the same name are never guessed; the analysis goes on', async () => {
    const app = new SyntheticApp(
      {
        s0: {
          label: 'Liste',
          actions: [
            { label: 'Modifier', to: 's1' },
            { label: 'Modifier', to: 's1' },
            { label: 'Suivant', to: 's1' },
          ],
        },
        s1: { label: 'Suite' },
      },
      's0',
    );
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('ambiguous', [
        ['CLICK', 'Modifier'],
        ['CLICK', 'Suivant'],
      ]),
    );
    expect(rows(reconciliation)).toEqual(['Modifier AMBIGUOUS', 'Suivant MATCHED']);
    expect(app.executed).toEqual(['Suivant']);
    expect(reconciliation.status).toBe('INCONCLUSIVE');
  });

  it('unreachable: the whole reachable application explored, the target is nowhere', async () => {
    const app = new SyntheticApp(chain(['A', 'B', 'C']), 's0');
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('unreachable', [
        ['CLICK', 'A'],
        ['CLICK', 'Z'],
      ]),
    );
    expect(rows(reconciliation)).toEqual(['A MATCHED', 'Z UNREACHABLE']);
    expect(reconciliation.status).toBe('DIVERGED');
  });

  it('blocked by policy: the target itself is refused — BLOCKED_BY_POLICY, never executed', async () => {
    const app = new SyntheticApp(
      {
        s0: {
          label: 'Compte',
          actions: [
            {
              label: 'Supprimer le compte',
              to: 's1',
              classification: 'DANGEROUS',
              blocked: 'DANGEROUS actions are not allowed',
            },
          ],
        },
        s1: { label: 'Supprimé' },
      },
      's0',
    );
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('dangerous', [['CLICK', 'Supprimer le compte']]),
    );
    expect(rows(reconciliation)).toEqual(['Supprimer le compte BLOCKED_BY_POLICY']);
    expect(reconciliation.status).toBe('BLOCKED');
    expect(app.executed).toEqual([]);
  });

  it('blocked by policy: the only known path needs a DANGEROUS action — PATH blocked, not UNREACHABLE', async () => {
    const app = new SyntheticApp(
      {
        s0: {
          label: 'Compte',
          actions: [
            { label: 'Aide', to: 'help' },
            {
              label: 'Clôturer',
              to: 's1',
              classification: 'DANGEROUS',
              blocked: 'DANGEROUS actions are not allowed',
            },
          ],
        },
        help: { label: 'Aide' },
        s1: { label: 'Confirmation', actions: [{ label: 'Confirmer la clôture', to: 's2' }] },
        s2: { label: 'Clôturé' },
      },
      's0',
      {
        history: {
          's0>confirmer-la-cloture': [{ actions: ['click:cloturer'], source: 'historical', observations: 8 }],
        },
      },
    );
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('path-blocked', [['CLICK', 'Confirmer la clôture']]),
    );
    expect(rows(reconciliation)).toEqual(['Confirmer la clôture BLOCKED_BY_POLICY']);
    expect(reconciliation.entries[0]?.evidence).toContain('blocked action: "Clôturer"');
    expect(app.executed).not.toContain('Clôturer');
  });

  it('an action refused for an expected step is never executed by the guided exploration either', async () => {
    const app = new SyntheticApp(
      {
        login: { label: 'Connexion', actions: [{ label: 'Se connecter', to: 'dash', role: 'button' }] },
        dash: { label: 'Tableau de bord', actions: [{ label: 'Utilisateurs', to: 'users' }] },
        users: { label: 'Utilisateurs' },
      },
      'login',
      { stepBlocked: ['Se connecter'] },
    );
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('refused', [
        ['CLICK', 'Se connecter'],
        ['CLICK', 'Utilisateurs'],
      ]),
    );
    expect(rows(reconciliation)).toEqual([
      'Se connecter BLOCKED_BY_POLICY',
      'Utilisateurs BLOCKED_BY_POLICY',
    ]);
    expect(reconciliation.entries[1]?.evidence).toContain('blocked action: "Se connecter"');
    expect(app.executed).toEqual([]);
  });

  it('budget exhausted: NOT_VERIFIED and EXPLORATION_BUDGET_EXHAUSTED, never UNREACHABLE', async () => {
    // Un écran à 5 branches, profond : la cible est hors de portée d'un budget de 3 actions.
    const screens: Record<string, SyntheticScreen> = {};
    for (let depth = 0; depth < 6; depth++)
      screens[`d${String(depth)}`] = {
        label: `Niveau ${String(depth)}`,
        actions: ['a', 'b', 'c', 'd', 'e'].map((suffix) => ({
          label: `${suffix}${String(depth)}`,
          to: `d${String(depth + 1)}`,
        })),
      };
    screens.d6 = { label: 'Fond', actions: [{ label: 'Cible', to: 'd0' }] };
    const app = new SyntheticApp(screens, 'd0');
    const graph = expectedFlow('budget', [
      ['CLICK', 'Cible'],
      ['CLICK', 'Encore'],
    ]);
    const { reconciliation } = await dryRun(app, graph, { maxActions: 3 });
    expect(rows(reconciliation)).toEqual(['Cible NOT_VERIFIED', 'Encore NOT_VERIFIED']);
    expect(reconciliation.stopReason).toBe('EXPLORATION_BUDGET_EXHAUSTED');
    expect(reconciliation.status).toBe('INCONCLUSIVE');
    expect(app.executed.length).toBeLessThanOrEqual(3);

    // Même chose avec la durée (horloge virtuelle : 1 s par action).
    const slow = new SyntheticApp(screens, 'd0', { msPerAction: 1000 });
    const timed = await dryRun(slow, graph, { maxDurationMs: 2500 });
    expect(timed.reconciliation.stopReason).toBe('EXPLORATION_BUDGET_EXHAUSTED');
    expect(timed.reconciliation.entries.every((entry) => entry.status === 'NOT_VERIFIED')).toBe(true);
  });

  it('continueAfterMismatch: false stops at the first mismatch; the rest is NOT_VERIFIED', async () => {
    const app = new SyntheticApp(chain(['A', 'X', 'C']), 's0');
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('strict', [
        ['CLICK', 'A'],
        ['CLICK', 'B'],
        ['CLICK', 'C'],
      ]),
      { continueAfterMismatch: false },
    );
    expect(rows(reconciliation)).toEqual(['A MATCHED', 'B NOT_VERIFIED', 'C NOT_VERIFIED']);
  });

  it('assertions are verified: reached after a form (inserted, with its fields), or ASSERTION_MISMATCH', async () => {
    const screens: Record<string, SyntheticScreen> = {
      list: { label: 'Utilisateurs', actions: [{ label: 'Créer', to: 'form' }] },
      form: {
        label: 'Nouvel utilisateur',
        fields: ['Nom', 'Courriel'],
        actions: [
          { label: 'Annuler', to: 'list' },
          {
            label: 'Enregistrer',
            to: 'done',
            category: 'submit',
            classification: 'MUTATION',
            role: 'button',
            formFields: ['Nom', 'Courriel'],
          },
        ],
      },
      done: { label: 'Utilisateurs', texts: ['Utilisateur créé'] },
    };
    const ok = await dryRun(
      new SyntheticApp(screens, 'list'),
      expectedFlow('assert', [
        ['CLICK', 'Créer'],
        ['ASSERT', 'Utilisateur créé'],
      ]),
    );
    expect(rows(ok.reconciliation)).toEqual([
      'Créer MATCHED',
      'Enregistrer INSERTED',
      'Utilisateur créé MATCHED',
    ]);
    expect(ok.reconciliation.entries[1]?.evidence).toContain('form filled with test data: Nom, Courriel');

    const wrong = await dryRun(
      new SyntheticApp(screens, 'list'),
      expectedFlow('assert-wrong', [
        ['CLICK', 'Créer'],
        ['ASSERT', 'Compte activé'],
      ]),
    );
    expect(rows(wrong.reconciliation)).toEqual(['Créer MATCHED', 'Compte activé ASSERTION_MISMATCH']);
  });

  it('the reference example: an incomplete scenario becomes the complete observed flow', async () => {
    const screens: Record<string, SyntheticScreen> = {
      login: {
        label: 'Connexion',
        actions: [{ label: 'Se connecter', to: 'dash', category: 'submit', role: 'button' }],
      },
      dash: {
        label: 'Tableau de bord',
        actions: [
          { label: 'Rapports', to: 'reports' },
          { label: 'Administration', to: 'admin' },
        ],
      },
      reports: { label: 'Rapports' },
      admin: { label: 'Administration', actions: [{ label: 'Utilisateurs', to: 'users' }] },
      users: { label: 'Utilisateurs', actions: [{ label: 'Créer un utilisateur', to: 'personal' }] },
      personal: {
        label: 'Informations personnelles',
        actions: [
          {
            label: 'Suivant',
            to: 'role',
            category: 'form-step',
            role: 'button',
            formFields: ['Prénom', 'Nom'],
          },
        ],
      },
      role: {
        label: 'Choix du rôle',
        actions: [
          { label: 'Continuer', to: 'confirm', category: 'form-step', role: 'button', formFields: ['Rôle'] },
        ],
      },
      confirm: {
        label: 'Confirmation',
        actions: [
          { label: 'Confirmer', to: 'list', category: 'submit', classification: 'MUTATION', role: 'button' },
        ],
      },
      list: { label: 'Utilisateurs', texts: ['Utilisateur créé'] },
    };
    const app = new SyntheticApp(screens, 'login');
    const { reconciliation } = await dryRun(
      app,
      expectedFlow('Créer un utilisateur', [
        ['CLICK', 'Se connecter'],
        ['CLICK', 'Utilisateurs'],
        ['CLICK', 'Créer un utilisateur'],
        ['ASSERT', 'Utilisateur créé'],
      ]),
    );
    expect(rows(reconciliation)).toEqual([
      'Se connecter MATCHED',
      'Administration INSERTED',
      'Utilisateurs MATCHED',
      'Créer un utilisateur MATCHED',
      'Suivant INSERTED',
      'Continuer INSERTED',
      'Confirmer INSERTED',
      'Utilisateur créé MATCHED',
    ]);
    expect(reconciliation.status).toBe('PARTIALLY_MATCHED');
    expect(reconciliation.summary).toMatchObject({
      originalIntents: 4,
      matched: 4,
      inserted: 4,
      possiblyObsolete: 0,
    });
  });
});
