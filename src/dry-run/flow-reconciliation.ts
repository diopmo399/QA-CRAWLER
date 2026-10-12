import { alignSequences } from './flow-alignment.js';
import type { FlowIntent, FlowIntentGraph } from './flow-intent-graph.js';
import {
  PAIRED_STATUSES,
  type DryRunStatus,
  type IntentFinding,
  type ObservedFlowGraph,
  type ObservedStep,
  type Reconciliation,
  type ReconciliationEntry,
  type ReconciliationStatus,
  type ReconciliationSummary,
} from './reconciliation-model.js';
import {
  describePairing,
  reconcileSemantically,
  type SemanticPairingOptions,
} from './semantic-reconciliation.js';

export interface ReconcileOptions {
  /** Réconciliation sémantique des couples MISSING + INSERTED (activée par défaut ; `false` : jamais). */
  semanticPairing?: (SemanticPairingOptions & { enabled?: boolean }) | false;
}

/** Les statuts d'une attendue sans correspondance que l'appariement sémantique peut encore résoudre. */
const PAIRABLE = new Set<ReconciliationStatus>(['MISSING', 'POSSIBLY_OBSOLETE', 'UNREACHABLE']);

/**
 * FLOW RECONCILIATION : EXPECTED + OBSERVED → un statut par étape, avec sa confiance,
 * ses raisons et ses preuves. Rien n'est décidé pendant l'exploration : cette étape
 * vient une seule fois, à la fin, sur tout ce qui a été vu.
 *
 * L'alignement (FlowAlignment) donne la structure — appariements, insertions,
 * suppressions probables, réordonnancements ; les constats du moteur donnent la nature
 * de chaque écart (bloqué par la politique, ambigu, non vérifié faute de budget…). Puis la
 * réconciliation sémantique (SemanticReconciliation) relit les couples « manquante + insérée »
 * qui désignent le même événement fonctionnel : une seule entrée, jamais MISSING + INSERTED.
 */
export function reconcile(
  graph: FlowIntentGraph,
  observed: ObservedFlowGraph,
  findings: readonly IntentFinding[],
  options: ReconcileOptions = {},
): Reconciliation {
  const findingOf = new Map(findings.map((finding) => [finding.intentId, finding]));
  const stateLabel = new Map(observed.states.map((state) => [state.id, state.label]));
  const matchedIndexes = graph.intents
    .filter((intent) => findingOf.get(intent.id)?.outcome === 'MATCHED')
    .map((intent) => intent.index);

  const ops = alignSequences(graph.intents, observed.steps, (intent, step) => step.intentId === intent.id);
  const aligned: ReconciliationEntry[] = ops.map((op) => {
    switch (op.kind) {
      case 'MATCH':
      case 'REORDER': {
        const finding = findingOf.get(op.expected.id);
        return {
          status: op.kind === 'MATCH' ? 'MATCHED' : 'REORDERED',
          expectedIntent: expectedOf(op.expected),
          observedTarget: targetOf(op.observed, stateLabel),
          confidence: finding?.confidence ?? 0.9,
          reasons:
            op.kind === 'REORDER'
              ? ['the step exists, in another position than in the scenario', ...(finding?.reasons ?? [])]
              : (finding?.reasons ?? []),
          evidence: finding?.evidence ?? [],
        };
      }
      case 'INSERT':
        return insertedEntry(op.observed, stateLabel);
      case 'DELETE':
        return missingEntry(op.expected, findingOf.get(op.expected.id), matchedIndexes);
    }
  });

  const entries = pairSemantically(aligned, graph, observed, findings, options.semanticPairing);
  const summary = summarize(graph.intents.length, entries);
  return {
    flow: graph.name,
    status: globalStatus(entries, graph.intents),
    entries,
    summary,
    stopReason: observed.stopReason,
  };
}

/**
 * SEMANTIC RECONCILIATION : une attendue restée MISSING / POSSIBLY_OBSOLETE / UNREACHABLE et une
 * observée restée INSERTED qui ont un fort score d'appariement forment une seule entrée, placée
 * là où l'observée a été vue ; deux candidats aussi plausibles laissent l'attendue en
 * DUPLICATE_CANDIDATE (les observées restent INSERTED).
 */
function pairSemantically(
  entries: readonly ReconciliationEntry[],
  graph: FlowIntentGraph,
  observed: ObservedFlowGraph,
  findings: readonly IntentFinding[],
  options: ReconcileOptions['semanticPairing'],
): ReconciliationEntry[] {
  if (options === false || options?.enabled === false) return [...entries];
  const intentOf = new Map(graph.intents.map((intent) => [intent.id, intent]));
  const stepOf = new Map(observed.steps.map((step) => [step.id, step]));
  const unmatched = entries.flatMap((entry) => {
    const intent = entry.expectedIntent ? intentOf.get(entry.expectedIntent.id) : undefined;
    return intent && PAIRABLE.has(entry.status) && !entry.observedTarget ? [intent] : [];
  });
  const inserted = entries.flatMap((entry) => {
    const step = entry.observedTarget ? stepOf.get(entry.observedTarget.stepId) : undefined;
    return step && entry.status === 'INSERTED' && !entry.expectedIntent ? [step] : [];
  });
  if (unmatched.length === 0 || inserted.length === 0) return [...entries];
  const { pairs, duplicates } = reconcileSemantically(
    unmatched,
    inserted,
    graph.intents,
    observed,
    findings,
    options ?? {},
  );
  if (pairs.length === 0 && duplicates.length === 0) return [...entries];

  const pairOfIntent = new Map(pairs.map((pair) => [pair.intent.id, pair]));
  const pairOfStep = new Map(pairs.map((pair) => [pair.observed.id, pair]));
  const duplicateOf = new Map(duplicates.map((duplicate) => [duplicate.intent.id, duplicate]));
  const stateLabel = new Map(observed.states.map((state) => [state.id, state.label]));
  const result: ReconciliationEntry[] = [];
  for (const entry of entries) {
    const intentId = entry.expectedIntent?.id;
    const stepId = entry.observedTarget?.stepId;
    // L'attendue appariée disparaît de sa place : elle est portée par l'entrée de l'observée.
    if (intentId && !stepId && pairOfIntent.has(intentId)) continue;
    const pair = stepId && !intentId ? pairOfStep.get(stepId) : undefined;
    if (pair) {
      const missing = entries.find((candidate) => candidate.expectedIntent?.id === pair.intent.id);
      result.push({
        status: pair.status,
        expectedIntent: expectedOf(pair.intent),
        observedTarget: targetOf(pair.observed, stateLabel),
        confidence: pair.score.total,
        reasons: [
          ...pair.reasons,
          describePairing(pair.score),
          ...(missing ? [`before pairing: ${missing.status} — ${missing.reasons[0] ?? ''}`] : []),
          `before pairing: INSERTED — ${entry.reasons[0] ?? ''}`,
        ],
        evidence: [...(missing?.evidence ?? []), ...entry.evidence],
        pairing: { score: pair.score, candidates: pair.candidates },
      });
      continue;
    }
    const duplicate = intentId && !stepId ? duplicateOf.get(intentId) : undefined;
    if (duplicate) {
      const best = duplicate.candidates[0];
      result.push({
        ...entry,
        status: 'DUPLICATE_CANDIDATE',
        confidence: best?.score.total ?? entry.confidence,
        reasons: [...duplicate.reasons, `before pairing: ${entry.status} — ${entry.reasons[0] ?? ''}`],
        ...(best ? { pairing: { score: best.score, candidates: duplicate.candidates } } : {}),
      });
      continue;
    }
    result.push(entry);
  }
  return result;
}

function insertedEntry(step: ObservedStep, stateLabel: Map<string, string>): ReconciliationEntry {
  const alternative = step.alternatives !== undefined && step.alternatives.length > 0;
  const status: ReconciliationStatus = alternative ? 'ALTERNATIVE' : 'INSERTED';
  return {
    status,
    observedTarget: targetOf(step, stateLabel),
    confidence: step.provenance === 'HISTORICAL_CONFIRMED' ? 0.95 : 0.9,
    reasons: [
      `observed between "${stateLabel.get(step.from) ?? step.from}" and "${stateLabel.get(step.to) ?? step.to}", not in the scenario`,
      ...(alternative
        ? [
            `other known path(s): ${(step.alternatives ?? []).map((path) => path.join(' → ')).join(' | ')}; this one was used and confirmed`,
          ]
        : []),
      ...step.reasons,
    ],
    evidence: [
      ...(step.action ? [`action ${step.action.signature} (${step.action.classification})`] : []),
      ...(step.formFields ? [`form filled with test data: ${step.formFields.join(', ')}`] : []),
      `provenance ${step.provenance}`,
    ],
  };
}

function missingEntry(
  intent: FlowIntent,
  finding: IntentFinding | undefined,
  matchedIndexes: readonly number[],
): ReconciliationEntry {
  const base = {
    expectedIntent: expectedOf(intent),
    reasons: finding?.reasons ?? ['not reached'],
    evidence: finding?.evidence ?? [],
  };
  switch (finding?.outcome) {
    case 'AMBIGUOUS':
      return { ...base, status: 'AMBIGUOUS', confidence: finding.confidence };
    case 'BLOCKED_BY_POLICY':
      return { ...base, status: 'BLOCKED_BY_POLICY', confidence: finding.confidence };
    case 'ASSERTION_MISMATCH':
      return { ...base, status: 'ASSERTION_MISMATCH', confidence: finding.confidence };
    case 'MATCHED':
      return { ...base, status: 'MATCHED', confidence: finding.confidence };
    case 'NOT_FOUND': {
      const laterMatched = matchedIndexes.some((index) => index > intent.index);
      if (laterMatched) {
        if (finding.seenElsewhere)
          return {
            ...base,
            status: 'MISSING',
            confidence: 0.6,
            reasons: [
              'the target exists in the application (seen on another screen during this run), but not at this point of the flow',
              ...base.reasons,
            ],
          };
        const history = finding.historicalObservations;
        return {
          ...base,
          status: 'POSSIBLY_OBSOLETE',
          // Une seule exploration ne suffit pas : l'historique augmente ou diminue la confiance, jamais une suppression.
          confidence: history === undefined ? 0.6 : history > 0 ? 0.4 : 0.7,
          reasons: [
            'not found; the following steps of the scenario were found without it',
            ...(history === undefined
              ? ['no historical knowledge (memory off)']
              : history > 0
                ? [
                    `seen ${String(history)} time(s) in previous runs: it may have moved rather than disappeared`,
                  ]
                : ['never seen in previous runs either']),
            'kept for review, never deleted automatically',
            ...base.reasons,
          ],
        };
      }
      if (finding.searchExhausted)
        return {
          ...base,
          status: 'UNREACHABLE',
          confidence: Math.max(0.5, finding.confidence),
          reasons: [
            'every screen reachable within the allowed depth (and the safety policy) was explored without finding it',
            ...base.reasons,
          ],
        };
      return { ...base, status: 'NOT_VERIFIED', confidence: 0 };
    }
    case 'NOT_VERIFIED':
    case undefined:
      return { ...base, status: 'NOT_VERIFIED', confidence: 0 };
  }
}

function expectedOf(intent: FlowIntent): ReconciliationEntry['expectedIntent'] {
  return {
    id: intent.id,
    index: intent.index,
    type: intent.type,
    label: intent.label,
    semanticTarget: intent.semanticTarget,
    text: intent.sourceReference.text,
    ...(intent.sourceReference.line !== undefined ? { line: intent.sourceReference.line } : {}),
  };
}

function targetOf(
  step: ObservedStep,
  stateLabel: Map<string, string>,
): ReconciliationEntry['observedTarget'] {
  return {
    stepId: step.id,
    label: step.label,
    state: stateLabel.get(step.to) ?? step.to,
    ...(step.action ? { action: step.action.signature } : {}),
  };
}

function summarize(originalIntents: number, entries: readonly ReconciliationEntry[]): ReconciliationSummary {
  const count = (status: ReconciliationStatus): number =>
    entries.filter((entry) => entry.status === status).length;
  return {
    originalIntents,
    matched: count('MATCHED'),
    inserted: count('INSERTED'),
    missing: count('MISSING'),
    reordered: count('REORDERED'),
    alternative: count('ALTERNATIVE'),
    ambiguous: count('AMBIGUOUS'),
    unreachable: count('UNREACHABLE'),
    possiblyObsolete: count('POSSIBLY_OBSOLETE'),
    assertionMismatch: count('ASSERTION_MISMATCH'),
    blocked: count('BLOCKED_BY_POLICY'),
    notVerified: count('NOT_VERIFIED'),
    matchedWithVariation: entries.filter((entry) => PAIRED_STATUSES.includes(entry.status)).length,
    duplicateCandidate: count('DUPLICATE_CANDIDATE'),
  };
}

/**
 * Statut global, jamais un booléen :
 * - BLOCKED : une intention requise n'est atteignable qu'au prix d'une action refusée ;
 * - INCONCLUSIVE : une intention requise n'a pas pu être vérifiée (budget, ambiguïté, deux candidats) ;
 * - DIVERGED : une intention requise est introuvable, obsolète ou son résultat diffère ;
 * - PARTIALLY_MATCHED : tout est retrouvé, avec des étapes en plus, ailleurs, alternatives ou sous une autre forme ;
 * - FULLY_MATCHED : le scénario correspond tel quel.
 */
function globalStatus(entries: readonly ReconciliationEntry[], intents: readonly FlowIntent[]): DryRunStatus {
  const required = new Set(intents.filter((intent) => intent.required).map((intent) => intent.id));
  const onRequired = (statuses: ReconciliationStatus[]): boolean =>
    entries.some(
      (entry) =>
        statuses.includes(entry.status) &&
        entry.expectedIntent !== undefined &&
        required.has(entry.expectedIntent.id),
    );
  if (onRequired(['BLOCKED_BY_POLICY'])) return 'BLOCKED';
  if (onRequired(['NOT_VERIFIED', 'AMBIGUOUS', 'DUPLICATE_CANDIDATE'])) return 'INCONCLUSIVE';
  if (onRequired(['UNREACHABLE', 'POSSIBLY_OBSOLETE', 'MISSING', 'ASSERTION_MISMATCH'])) return 'DIVERGED';
  if (entries.some((entry) => entry.status !== 'MATCHED' && entry.status !== 'NOT_VERIFIED'))
    return 'PARTIALLY_MATCHED';
  return 'FULLY_MATCHED';
}
