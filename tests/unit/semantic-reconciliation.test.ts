import { describe, expect, it } from 'vitest';
import type { StepFunctionalIntent } from '../../src/config/flow-schema.js';
import { DryRunEngine } from '../../src/dry-run/dry-run-engine.js';
import type { FlowIntent, FlowIntentGraph } from '../../src/dry-run/flow-intent-graph.js';
import { reconcile, type ReconcileOptions } from '../../src/dry-run/flow-reconciliation.js';
import type {
  IntentFinding,
  ObservedFlowGraph,
  ObservedStep,
  Reconciliation,
} from '../../src/dry-run/reconciliation-model.js';
import { reconcileSemantically } from '../../src/dry-run/semantic-reconciliation.js';
import { buildSuggestedFlow, suggestedFlowYaml } from '../../src/dry-run/suggested-flow.js';
import { expectedFlow, SyntheticApp, UNLIMITED, type SyntheticScreen } from '../dry-run-app.js';

/**
 * SEMANTIC RECONCILIATION : une étape attendue « manquante » et une étape observée « insérée »
 * qui désignent le même événement fonctionnel ne restent jamais MISSING + INSERTED.
 *
 *   alignement brut → appariement des candidats → réconciliation sémantique → statut final
 */

/** Écran → action unique vers l'écran suivant. */
function chain(
  labels: string[],
  extra: Record<string, SyntheticScreen> = {},
): Record<string, SyntheticScreen> {
  const screens: Record<string, SyntheticScreen> = {};
  labels.forEach((label, index) => {
    screens[`s${String(index)}`] = {
      label: `Screen ${String(index)}`,
      actions: [{ label, to: `s${String(index + 1)}` }],
    };
  });
  screens[`s${String(labels.length)}`] = { label: 'End' };
  return { ...screens, ...extra };
}

/** L'intention `position` du flow devient un clic sur un sélecteur CSS qui n'existe plus, nommé `name`. */
function withChangedLocator(
  graph: FlowIntentGraph,
  position: number,
  name: string,
  extra: { functionalIntent?: StepFunctionalIntent } = {},
): FlowIntentGraph {
  const intents = graph.intents.map((intent) =>
    intent.index === position
      ? {
          ...intent,
          label: '#legacy-id',
          semanticTarget: 'legacy-id',
          step: {
            kind: 'click' as const,
            name,
            target: { strategy: 'css' as const, value: '#legacy-id' },
            allow: [],
            optional: false,
            ...extra,
          },
        }
      : intent,
  );
  return { ...graph, intents };
}

async function dryRun(
  app: SyntheticApp,
  graph: FlowIntentGraph,
  options: ReconcileOptions = {},
): Promise<Reconciliation> {
  const engine = new DryRunEngine(app, { budget: UNLIMITED, continueAfterMismatch: true });
  const { observed, findings } = await engine.run(graph);
  return reconcile(graph, observed, findings, options);
}

const rows = (reconciliation: Reconciliation): string[] =>
  reconciliation.entries.map(
    (entry) =>
      `${entry.expectedIntent ? (entry.expectedIntent.label === '#legacy-id' ? 'legacy' : entry.expectedIntent.label) : (entry.observedTarget?.label ?? '?')}${
        entry.expectedIntent && entry.observedTarget && entry.pairing ? `↔${entry.observedTarget.label}` : ''
      } ${entry.status}`,
  );

describe('Semantic reconciliation on synthetic applications', () => {
  it('the locator changed, the label did not: MATCHED_WITH_TARGET_CHANGE, never MISSING + INSERTED', async () => {
    const graph = withChangedLocator(
      expectedFlow('target', [
        ['CLICK', 'A'],
        ['CLICK', 'Process request'],
        ['CLICK', 'C'],
      ]),
      2,
      'Process request',
    );
    const paired = await dryRun(new SyntheticApp(chain(['A', 'Process request', 'C']), 's0'), graph);
    expect(rows(paired)).toEqual([
      'A MATCHED',
      'legacy↔Process request MATCHED_WITH_TARGET_CHANGE',
      'C MATCHED',
    ]);
    const entry = paired.entries[1];
    expect(entry?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(entry?.pairing?.score).toMatchObject({ target: 1, context: 1, sequence: 1 });
    expect(entry?.reasons.join('\n')).toContain('same functional event');
    expect(entry?.reasons.join('\n')).toMatch(/before pairing: POSSIBLY_OBSOLETE/);
    expect(entry?.reasons.join('\n')).toMatch(/before pairing: INSERTED/);
    expect(paired.summary).toMatchObject({
      matched: 2,
      matchedWithVariation: 1,
      inserted: 0,
      possiblyObsolete: 0,
    });
    expect(paired.status).toBe('PARTIALLY_MATCHED');

    // Sans la réconciliation sémantique : l'ancien résultat, MISSING/POSSIBLY_OBSOLETE + INSERTED.
    const raw = await dryRun(new SyntheticApp(chain(['A', 'Process request', 'C']), 's0'), graph, {
      semanticPairing: false,
    });
    expect(rows(raw)).toEqual([
      'A MATCHED',
      'legacy POSSIBLY_OBSOLETE',
      'Process request INSERTED',
      'C MATCHED',
    ]);
  });

  it('a reworded label that says the same UI intent, framed by the same neighbours: MATCHED_SEMANTICALLY', async () => {
    const graph = expectedFlow('reworded', [
      ['CLICK', 'A'],
      ['CLICK', 'Create user'],
      ['CLICK', 'C'],
    ]);
    const reconciliation = await dryRun(new SyntheticApp(chain(['A', 'New user', 'C']), 's0'), graph);
    expect(rows(reconciliation)).toEqual([
      'A MATCHED',
      'Create user↔New user MATCHED_SEMANTICALLY',
      'C MATCHED',
    ]);
    const entry = reconciliation.entries[1];
    expect(entry?.pairing?.score.target).toBeLessThan(0.95);
    expect(entry?.pairing?.score.intent).toBe(1);
    expect(entry?.reasons.join('\n')).toContain('both say OPEN_DIALOG');
  });

  it('two labels with nothing in common stay MISSING-like + INSERTED: the pairing score is below the threshold', async () => {
    const graph = expectedFlow('unrelated', [
      ['CLICK', 'A'],
      ['CLICK', 'B'],
      ['CLICK', 'C'],
    ]);
    const reconciliation = await dryRun(new SyntheticApp(chain(['A', 'X', 'C']), 's0'), graph);
    expect(rows(reconciliation)).toEqual(['A MATCHED', 'B POSSIBLY_OBSOLETE', 'X INSERTED', 'C MATCHED']);
    expect(reconciliation.summary.matchedWithVariation).toBe(0);
  });

  it('the same event reached after an extra step: MATCHED_AFTER_INSERTION, the extra step stays INSERTED', async () => {
    const graph = withChangedLocator(
      expectedFlow('after', [
        ['CLICK', 'A'],
        ['CLICK', 'Process request'],
        ['CLICK', 'C'],
      ]),
      2,
      'Process request',
    );
    const reconciliation = await dryRun(
      new SyntheticApp(chain(['A', 'Open panel', 'Process request', 'C']), 's0'),
      graph,
    );
    expect(rows(reconciliation)).toEqual([
      'A MATCHED',
      'Open panel INSERTED',
      'legacy↔Process request MATCHED_AFTER_INSERTION',
      'C MATCHED',
    ]);
    expect(reconciliation.summary).toMatchObject({ inserted: 1, matchedWithVariation: 1 });
  });

  it('a declared route that the observed screen does not match: MATCHED_WITH_CONTEXT_CHANGE', async () => {
    const graph = withChangedLocator(
      expectedFlow('context', [
        ['CLICK', 'A'],
        ['CLICK', 'Process request'],
        ['CLICK', 'C'],
      ]),
      2,
      'Process request',
      {
        functionalIntent: {
          name: 'PROCESS_REQUEST',
          status: 'CONFIRMED',
          confidence: 0.9,
          ui: 'OPEN_DIALOG',
          operation: 'PROCESS',
          entity: 'request',
          context: { route: '/requests' },
        },
      },
    );
    const reconciliation = await dryRun(new SyntheticApp(chain(['A', 'Process request', 'C']), 's0'), graph);
    const entry = reconciliation.entries[1];
    expect(entry?.status).toBe('MATCHED_WITH_CONTEXT_CHANGE');
    // L'entité de l'intention fonctionnelle est dite par le libellé observé ; la route ne l'est pas.
    expect(entry?.pairing?.score.entity).toBe(1);
    expect(entry?.pairing?.score.context).toBeLessThan(0.5);
    expect(entry?.reasons.join('\n')).toContain('route /requests not matched');
  });

  it('a label that contradicts the intent (cancel, close, back) is never paired, whatever the context', async () => {
    const graph = withChangedLocator(
      expectedFlow('cancel', [
        ['CLICK', 'A'],
        ['CLICK', 'Confirm'],
        ['CLICK', 'C'],
      ]),
      2,
      'Confirm',
    );
    const reconciliation = await dryRun(new SyntheticApp(chain(['A', 'Cancel', 'C']), 's0'), graph);
    expect(rows(reconciliation)).toEqual([
      'A MATCHED',
      'legacy POSSIBLY_OBSOLETE',
      'Cancel INSERTED',
      'C MATCHED',
    ]);
  });

  it('the suggested flow carries one step for the pair: the observed step, with the scenario text kept', async () => {
    const graph = withChangedLocator(
      expectedFlow('suggested', [
        ['CLICK', 'A'],
        ['CLICK', 'Process request'],
        ['CLICK', 'C'],
      ]),
      2,
      'Process request',
    );
    const app = new SyntheticApp(chain(['A', 'Process request', 'C']), 's0');
    const engine = new DryRunEngine(app, { budget: UNLIMITED, continueAfterMismatch: true });
    const { observed, findings } = await engine.run(graph);
    const suggested = buildSuggestedFlow(graph, observed, reconcile(graph, observed, findings));
    expect(suggested.steps.map((step) => `${step.label} ${step.status} ${step.provenance}`)).toEqual([
      'A MATCHED ORIGINAL',
      'Process request MATCHED_WITH_TARGET_CHANGE OBSERVED',
      'C MATCHED ORIGINAL',
    ]);
    expect(suggested.steps[1]?.originalText).toBe('CLICK Process request');
    expect(suggested.steps[1]?.review).toBeUndefined();
    const yaml = suggestedFlowYaml(suggested);
    expect(yaml).toContain('# MATCHED_WITH_TARGET_CHANGE · OBSERVED');
    expect(yaml).not.toContain('legacy-id');
  });
});

// ------------------------------------------------------------------ pure pairing

/** Un flow observé construit à la main : A (attendue 1) → insérées → C (attendue 3). */
function observedWith(inserted: { id: string; label: string; from: string; to: string; role?: string }[]): {
  observed: ObservedFlowGraph;
  findings: IntentFinding[];
} {
  const states = ['s0', 's1', 's2', 's3', 's4'].map((id) => ({
    id,
    signature: id,
    label: `Screen ${id}`,
    url: `/${id}`,
  }));
  const step = (
    id: string,
    label: string,
    from: string,
    to: string,
    intentId?: string,
    role?: string,
  ): ObservedStep => ({
    id,
    origin: intentId ? 'INTENT' : 'GUIDED',
    ...(intentId ? { intentId } : {}),
    type: 'CLICK',
    label,
    semanticTarget: label.toLowerCase().replace(/\s+/g, '-'),
    ...(intentId
      ? {}
      : {
          action: {
            id: `${from}:${label}`,
            signature: `click:${label}`,
            label,
            type: 'click' as const,
            category: 'navigation' as const,
            classification: 'SAFE' as const,
            ...(role ? { role } : {}),
          },
        }),
    from,
    to,
    status: 'PASSED',
    provenance: 'OBSERVED',
    reasons: [],
  });
  const last = inserted.at(-1)?.to ?? 's1';
  const steps = [
    step('o1', 'A', 's0', 's1', 'flow#1'),
    ...inserted.map((item) => step(item.id, item.label, item.from, item.to, undefined, item.role)),
    step('oC', 'C', last, 's4', 'flow#3'),
  ];
  return {
    observed: {
      flow: 'flow',
      states,
      steps,
      stopReason: 'COMPLETED',
      budget: { actions: 0, maxActions: 10, durationMs: 0, maxDurationMs: 1000 },
    },
    findings: [
      {
        intentId: 'flow#1',
        outcome: 'MATCHED',
        observedStepId: 'o1',
        confidence: 1,
        reasons: [],
        evidence: [],
      },
      {
        intentId: 'flow#2',
        outcome: 'NOT_FOUND',
        confidence: 0.6,
        seenElsewhere: true,
        reasons: [],
        evidence: [],
      },
      {
        intentId: 'flow#3',
        outcome: 'MATCHED',
        observedStepId: 'oC',
        confidence: 1,
        reasons: [],
        evidence: [],
      },
    ],
  };
}

const GRAPH = expectedFlow('flow', [
  ['CLICK', 'A'],
  ['CLICK', 'Process request'],
  ['CLICK', 'C'],
]);
const MISSING = GRAPH.intents[1] as FlowIntent;

describe('Semantic reconciliation, pure', () => {
  it('two observed candidates as plausible for the same expected step: DUPLICATE_CANDIDATE, nothing chosen', () => {
    const { observed, findings } = observedWith([
      { id: 'o2', label: 'Process request', from: 's1', to: 's2', role: 'button' },
      { id: 'o3', label: 'Process request', from: 's2', to: 's3', role: 'link' },
    ]);
    const inserted = observed.steps.filter((step) => step.origin === 'GUIDED');
    const result = reconcileSemantically([MISSING], inserted, GRAPH.intents, observed, findings);
    expect(result.pairs).toEqual([]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.candidates.map((candidate) => candidate.stepId)).toEqual(['o2', 'o3']);
    expect(result.duplicates[0]?.reasons[0]).toContain('DUPLICATE_CANDIDATE');

    const reconciliation = reconcile(GRAPH, observed, findings);
    expect(reconciliation.entries.map((entry) => entry.status)).toEqual([
      'MATCHED',
      'DUPLICATE_CANDIDATE',
      'INSERTED',
      'INSERTED',
      'MATCHED',
    ]);
    expect(reconciliation.entries[1]?.pairing?.candidates).toHaveLength(2);
    expect(reconciliation.summary.duplicateCandidate).toBe(1);
    // Un choix arbitraire n'est jamais fait : le scénario reste à trancher.
    expect(reconciliation.status).toBe('INCONCLUSIVE');
  });

  it('a clear winner among two candidates is paired; the other stays INSERTED and is named', () => {
    const { observed, findings } = observedWith([
      { id: 'o2', label: 'Open menu', from: 's1', to: 's2' },
      { id: 'o3', label: 'Process request', from: 's2', to: 's3' },
    ]);
    const reconciliation = reconcile(GRAPH, observed, findings);
    expect(
      reconciliation.entries.map((entry) => `${entry.observedTarget?.label ?? ''} ${entry.status}`),
    ).toEqual(['A MATCHED', 'Open menu INSERTED', 'Process request MATCHED_AFTER_INSERTION', 'C MATCHED']);
  });

  it('a field, an assertion or an address is never paired with a click: only a gesture can change its form', () => {
    const { observed, findings } = observedWith([
      { id: 'o2', label: 'Process request', from: 's1', to: 's3' },
    ]);
    const inserted = observed.steps.filter((step) => step.origin === 'GUIDED');
    const field: FlowIntent = {
      ...MISSING,
      type: 'FILL',
      step: {
        kind: 'fill',
        target: { strategy: 'label', value: 'Process request' },
        value: 'x',
        allow: [],
        optional: false,
      },
    };
    const assertion: FlowIntent = { ...MISSING, type: 'ASSERT' };
    const address: FlowIntent = { ...MISSING, type: 'NAVIGATE', label: '/process-request' };
    for (const intent of [field, assertion, address]) {
      const result = reconcileSemantically([intent], inserted, GRAPH.intents, observed, findings);
      expect(result.pairs).toEqual([]);
      expect(result.duplicates).toEqual([]);
    }
  });

  it('the threshold and the margin are options; a synonym dictionary raises the target similarity', () => {
    const { observed, findings } = observedWith([{ id: 'o2', label: 'Handle demand', from: 's1', to: 's3' }]);
    const inserted = observed.steps.filter((step) => step.origin === 'GUIDED');
    const without = reconcileSemantically([MISSING], inserted, GRAPH.intents, observed, findings);
    expect(without.pairs).toEqual([]);
    const synonyms = (term: string): string[] => (/process request/i.test(term) ? ['handle demand'] : []);
    const withSynonyms = reconcileSemantically([MISSING], inserted, GRAPH.intents, observed, findings, {
      synonyms,
    });
    expect(withSynonyms.pairs[0]?.status).toBe('MATCHED_WITH_TARGET_CHANGE');
    expect(withSynonyms.pairs[0]?.score.target).toBe(0.95);
    const strict = reconcileSemantically([MISSING], inserted, GRAPH.intents, observed, findings, {
      synonyms,
      minScore: 0.99,
    });
    expect(strict.pairs).toEqual([]);
  });

  it('every pairing explains itself: one reason per dimension, the score breakdown and the previous statuses', () => {
    const { observed, findings } = observedWith([
      { id: 'o2', label: 'Process request', from: 's1', to: 's3' },
    ]);
    const entry = reconcile(GRAPH, observed, findings).entries[1];
    expect(entry?.status).toBe('MATCHED_WITH_TARGET_CHANGE');
    const text = entry?.reasons.join('\n') ?? '';
    for (const dimension of ['target:', 'intent:', 'entity:', 'context:', 'sequence:', 'effect:'])
      expect(text).toContain(dimension);
    expect(text).toMatch(/target 1\.00 · intent/);
    expect(text).toContain('before pairing: MISSING');
    expect(entry?.pairing?.score.total).toBeGreaterThanOrEqual(0.85);
  });
});
