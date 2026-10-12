import type { FunctionalExchange } from '../functional/model.js';
import type { RememberedIntentDecision } from '../knowledge/functional-knowledge-store.js';
import type { TrackedEntity } from '../recording/business/entity-tracker.js';
import type { RecordedFlowStep, RecordedState, SemanticRecordedAction } from '../recording/model.js';
import type { ActionLifecycle, ContractHint, IntentHistoryHint } from './evidence.js';
import type { StepFunctionalIntent } from '../config/flow-schema.js';
import {
  annotationOf,
  genericOf,
  type FunctionalIntent,
  type IntentStatus,
  type IntentThresholds,
} from './model.js';
import { resolveFunctionalIntent } from './resolver.js';

/**
 * Les intentions d'un enregistrement complet : chaque action humaine conservée, avec ses voisines
 * (3 avant, 4 après), les écrans avant / après, le cycle de vie des entités que la couche métier lui
 * attribue, les décisions humaines mémorisées et la bibliothèque d'intentions. Pur et déterministe.
 */
export interface RecordingIntentInput {
  kept: readonly SemanticRecordedAction[];
  states: readonly RecordedState[];
  steps?: readonly RecordedFlowStep[];
  entities?: readonly TrackedEntity[];
  decisions?: readonly RememberedIntentDecision[];
  history?: readonly IntentHistoryHint[];
  contract?: (exchange: FunctionalExchange) => ContractHint | undefined;
  thresholds?: Partial<IntentThresholds>;
}

export interface RecordingIntentSummary {
  actions: number;
  byStatus: Record<IntentStatus, number>;
  /** Les intentions fonctionnelles distinctes (SEARCH_ITEM…) et leur forme générale (SEARCH_ENTITY). */
  functional: { name: string; generic: string; count: number }[];
  /** Les actions dont l'intention est AMBIGUOUS ou UNKNOWN (à soumettre à l'humain ou à l'IA). */
  unresolved: { actionId: string; label?: string; candidates: string[] }[];
}

export interface RecordingIntents {
  layer: 'FUNCTIONAL_INTENT';
  modifiesRecording: false;
  intents: FunctionalIntent[];
  summary: RecordingIntentSummary;
}

const INTENT_ACTIONS = new Set<SemanticRecordedAction['type']>([
  'NAVIGATE',
  'CLICK',
  'FILL',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'SUBMIT',
  'CONFIRM',
  'CANCEL',
  'UPLOAD',
  'DRAG_AND_DROP',
]);

export function resolveRecordingIntents(input: RecordingIntentInput): RecordingIntents {
  const stateById = new Map(input.states.map((state) => [state.id, state]));
  const stepOf = new Map<string, string>();
  for (const step of input.steps ?? [])
    for (const id of step.actionIds) if (!stepOf.has(id)) stepOf.set(id, step.id);
  const lifecycleOf = new Map<string, ActionLifecycle[]>();
  for (const entity of input.entities ?? [])
    for (const step of entity.lifecycle)
      for (const actionId of step.actionIds)
        lifecycleOf.set(actionId, [
          ...(lifecycleOf.get(actionId) ?? []),
          {
            entityType: entity.type,
            kind: step.kind,
            confidence: step.confidence,
            createdDuringRecording: entity.provenance.classification === 'CREATED_DURING_RECORDING',
          },
        ]);
  const actions = input.kept.filter((action) => INTENT_ACTIONS.has(action.type) && !action.dropped);
  const intents: FunctionalIntent[] = actions.map((action, index) => {
    const stepId = stepOf.get(action.id);
    return resolveFunctionalIntent(
      {
        action,
        previous: actions.slice(Math.max(0, index - 3), index),
        next: actions.slice(index + 1, index + 5),
        ...(action.stateBefore ? { stateBefore: stateById.get(action.stateBefore) } : {}),
        ...(action.stateAfter ? { stateAfter: stateById.get(action.stateAfter) } : {}),
        ...(lifecycleOf.has(action.id) ? { lifecycle: lifecycleOf.get(action.id) } : {}),
        ...(input.decisions ? { decisions: input.decisions } : {}),
        ...(input.history ? { history: input.history } : {}),
        ...(input.contract ? { contract: input.contract } : {}),
      },
      { ...(stepId ? { stepId } : {}), ...(input.thresholds ? { thresholds: input.thresholds } : {}) },
    );
  });
  return { layer: 'FUNCTIONAL_INTENT', modifiesRecording: false, intents, summary: summarize(intents) };
}

/** L'annotation d'étape (YAML `functionalIntent:`), depuis l'intention : des chaînes seulement. */
export function toStepFunctionalIntent(intent: FunctionalIntent): StepFunctionalIntent {
  const annotation = annotationOf(intent);
  return {
    name: annotation.name,
    status: annotation.status,
    confidence: annotation.confidence,
    ...(annotation.ui ? { ui: annotation.ui } : {}),
    ...(annotation.operation ? { operation: annotation.operation } : {}),
    ...(annotation.entity ? { entity: annotation.entity } : {}),
    ...(annotation.alternatives ? { alternatives: annotation.alternatives } : {}),
    ...(annotation.context
      ? {
          context: Object.fromEntries(
            Object.entries(annotation.context).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
        }
      : {}),
    ...(annotation.expectedEffects ? { expectedEffects: [...annotation.expectedEffects] } : {}),
  };
}

/**
 * Chaque étape du flow reçoit l'intention de son action : `intent` (modèle) et `step.functionalIntent`
 * (YAML, informatif). L'action brute, la cible, la valeur et les effets ne changent pas.
 */
export function annotateFlowSteps(
  steps: readonly RecordedFlowStep[],
  intents: readonly FunctionalIntent[],
): void {
  const byAction = new Map(intents.map((intent) => [intent.actionId, intent]));
  for (const step of steps) {
    if (step.step.kind === 'expect' || step.step.kind === 'goto') continue;
    const intent = step.actionIds.map((id) => byAction.get(id)).find((candidate) => candidate !== undefined);
    if (!intent) continue;
    step.functionalIntent = annotationOf(intent);
    step.step.functionalIntent = toStepFunctionalIntent(intent);
  }
}

export function summarize(intents: readonly FunctionalIntent[]): RecordingIntentSummary {
  const byStatus: Record<IntentStatus, number> = { CONFIRMED: 0, PROBABLE: 0, AMBIGUOUS: 0, UNKNOWN: 0 };
  const functional = new Map<string, number>();
  const unresolved: RecordingIntentSummary['unresolved'] = [];
  for (const intent of intents) {
    byStatus[intent.status] += 1;
    if (intent.functional) {
      const key = `${intent.functional.name}|${genericOf(intent)}`;
      functional.set(key, (functional.get(key) ?? 0) + 1);
    }
    if (intent.status === 'AMBIGUOUS' || intent.status === 'UNKNOWN')
      unresolved.push({
        actionId: intent.actionId,
        ...(intent.target?.label ? { label: intent.target.label } : {}),
        candidates: intent.alternatives
          .slice(0, 3)
          .map((candidate) => `${candidate.name} ${String(candidate.confidence)}`),
      });
  }
  return {
    actions: intents.length,
    byStatus,
    functional: [...functional.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => {
        const [name = key, generic = key] = key.split('|');
        return { name, generic, count };
      }),
    unresolved,
  };
}
