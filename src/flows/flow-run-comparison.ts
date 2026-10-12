import type { FlowRunReport, FlowStatus } from '../model/flow-run.js';

/**
 * ÉCART AVEC LE RUN PRÉCÉDENT d'un flow imposé : la base de connaissances garde, par flow, le résumé
 * du dernier run (statut, durée, localisateur utilisé par étape — jamais une valeur saisie) ; le run
 * suivant le compare au sien. Une dérive (étape plus lente, cible réparée, statut changé, étape
 * ajoutée ou retirée) est montrée sans relire deux rapports. L'historique SUGGÈRE : ce n'est jamais
 * une anomalie à lui seul.
 */
export interface FlowRunStepMemory {
  index: number;
  description: string;
  status: FlowStatus;
  durationMs: number;
  /** Le localisateur réellement utilisé (après guérison), quand l'étape l'a rapporté. */
  locator?: string;
  healed?: boolean;
  effect?: string;
}

export interface FlowRunMemory {
  runId: string;
  at: string;
  status: FlowStatus;
  durationMs: number;
  steps: FlowRunStepMemory[];
}

export type FlowRunChangeKind =
  | 'FLOW_STATUS'
  | 'STEP_STATUS'
  | 'STEP_SLOWER'
  | 'STEP_FASTER'
  | 'TARGET_CHANGED'
  | 'TARGET_HEALED'
  | 'EFFECT_CHANGED'
  | 'STEP_CHANGED'
  | 'STEP_ADDED'
  | 'STEP_REMOVED';

export interface FlowRunChange {
  kind: FlowRunChangeKind;
  step?: number;
  detail: string;
}

export interface FlowRunComparison {
  previous: { runId: string; at: string; status: FlowStatus; durationMs: number };
  /** SAME : même statut, mêmes étapes, aucune dérive notable. */
  verdict: 'SAME' | 'CHANGED';
  durationDeltaMs: number;
  changes: FlowRunChange[];
}

/** Une étape compte comme plus lente / plus rapide au-delà de 50 % ET de 300 ms. */
const DURATION_RATIO = 0.5;
const DURATION_FLOOR_MS = 300;

export function flowRunMemoryOf(flow: FlowRunReport, runId: string): FlowRunMemory {
  return {
    runId,
    at: flow.startedAt,
    status: flow.status,
    durationMs: flow.durationMs,
    steps: flow.steps.map((step) => ({
      index: step.index,
      description: step.description,
      status: step.status,
      durationMs: step.durationMs,
      // Une cible qui cite une donnée du run (le résultat créé) change de nom à chaque run : pas une dérive.
      ...(step.effect?.locator && !step.testData?.length ? { locator: step.effect.locator } : {}),
      ...(step.effect?.healed || step.targetResolution?.status === 'TARGET_HEALED' ? { healed: true } : {}),
      ...(step.effect ? { effect: step.effect.status } : {}),
    })),
  };
}

export function compareFlowRuns(previous: FlowRunMemory, current: FlowRunReport): FlowRunComparison {
  const changes: FlowRunChange[] = [];
  if (previous.status !== current.status)
    changes.push({ kind: 'FLOW_STATUS', detail: `${previous.status} → ${current.status}` });
  const now = flowRunMemoryOf(current, '');
  const count = Math.max(previous.steps.length, now.steps.length);
  for (let position = 0; position < count; position += 1) {
    const before = previous.steps[position];
    const after = now.steps[position];
    if (!before && after) {
      changes.push({ kind: 'STEP_ADDED', step: after.index, detail: after.description });
      continue;
    }
    if (before && !after) {
      changes.push({ kind: 'STEP_REMOVED', step: before.index, detail: before.description });
      continue;
    }
    if (!before || !after) continue;
    if (before.description !== after.description) {
      changes.push({
        kind: 'STEP_CHANGED',
        step: after.index,
        detail: `${before.description} → ${after.description}`,
      });
      continue;
    }
    if (before.status !== after.status)
      changes.push({ kind: 'STEP_STATUS', step: after.index, detail: `${before.status} → ${after.status}` });
    const delta = after.durationMs - before.durationMs;
    if (Math.abs(delta) > DURATION_FLOOR_MS && Math.abs(delta) > before.durationMs * DURATION_RATIO)
      changes.push({
        kind: delta > 0 ? 'STEP_SLOWER' : 'STEP_FASTER',
        step: after.index,
        detail: `${String(before.durationMs)} ms → ${String(after.durationMs)} ms`,
      });
    if (before.locator && after.locator && before.locator !== after.locator)
      changes.push({
        kind: 'TARGET_CHANGED',
        step: after.index,
        detail: `${before.locator} → ${after.locator}`,
      });
    if (!before.healed && after.healed)
      changes.push({ kind: 'TARGET_HEALED', step: after.index, detail: after.locator ?? after.description });
    if (before.effect && after.effect && before.effect !== after.effect)
      changes.push({
        kind: 'EFFECT_CHANGED',
        step: after.index,
        detail: `${before.effect} → ${after.effect}`,
      });
  }
  return {
    previous: {
      runId: previous.runId,
      at: previous.at,
      status: previous.status,
      durationMs: previous.durationMs,
    },
    verdict: changes.length > 0 ? 'CHANGED' : 'SAME',
    durationDeltaMs: current.durationMs - previous.durationMs,
    changes,
  };
}
