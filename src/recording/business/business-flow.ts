import type { BusinessDetection } from './business-event-detector.js';
import {
  CONFIRMED_AT,
  PROBABLE_AT,
  type BusinessEvent,
  type BusinessFlowModel,
  type BusinessFlowStep,
  type BusinessStatus,
} from './model.js';

const ACTION_OF: Record<BusinessEvent['type'], BusinessFlowStep['action']> = {
  ENTITY_CREATED: 'create',
  ENTITY_SEARCHED: 'search',
  ENTITY_OPENED: 'open',
  ENTITY_UPDATED: 'update',
  ENTITY_DELETED: 'delete',
};

/**
 * LE FLOW MÉTIER : les événements CONFIRMED et PROBABLE, dans l'ordre, chacun relié aux actions
 * enregistrées d'origine (étapes du flow, actions, événements bruts). Les ambiguïtés et les
 * hypothèses faibles restent à part (unresolved) : jamais une étape métier.
 */
export function buildBusinessFlow(name: string, detection: BusinessDetection): BusinessFlowModel {
  const steps: BusinessFlowStep[] = [];
  const unresolved: BusinessEvent[] = [];
  for (const event of detection.events) {
    if ((event.status !== 'CONFIRMED' && event.status !== 'PROBABLE') || !event.entity) {
      unresolved.push(event);
      continue;
    }
    steps.push({
      action: ACTION_OF[event.type],
      entity: event.entity,
      ...(event.reference ? { reference: event.reference } : {}),
      ...(event.output && event.identifier
        ? {
            outputs: {
              id: event.output,
              source: event.identifier.source,
              ...(event.identifier.field ? { field: event.identifier.field } : {}),
              ...(event.identifier.value !== undefined ? { value: event.identifier.value } : {}),
            },
          }
        : {}),
      status: event.status,
      confidence: event.confidence,
      businessEventId: event.id,
      recordedActions: event.stepIds,
      actionIds: event.actionIds,
      rawEventIds: event.rawEventIds,
      evidence: event.evidence,
      analyzer: event.analyzer,
    });
  }
  const entities = new Map<string, Set<string>>();
  for (const step of steps) {
    if (!step.entity) continue;
    const references = entities.get(step.entity) ?? new Set<string>();
    if (step.outputs) references.add(step.outputs.id);
    entities.set(step.entity, references);
  }
  const count = (status: BusinessStatus): number =>
    detection.events.filter((event) => event.status === status).length;
  return {
    name,
    entities: [...entities.entries()].map(([entity, references]) => ({
      name: entity,
      type: 'business_entity' as const,
      references: [...references],
    })),
    steps,
    relations: detection.relations,
    unresolved,
    summary: {
      events: detection.events.length,
      CONFIRMED: count('CONFIRMED'),
      PROBABLE: count('PROBABLE'),
      AMBIGUOUS: count('AMBIGUOUS'),
      UNKNOWN: count('UNKNOWN'),
    },
    thresholds: { confirmed: CONFIRMED_AT, probable: PROBABLE_AT },
  };
}

/** Une ligne lisible par étape : « CREATE demande → $created.demande.id = 12345 (CONFIRMED 0.97) ». */
export function businessFlowLines(model: BusinessFlowModel): string[] {
  const lines = model.steps.map((step) => {
    const head = `${step.action.toUpperCase()} ${step.entity ?? '?'}`;
    const tail = step.outputs
      ? ` → ${step.outputs.id}${step.outputs.value !== undefined ? ` = ${step.outputs.value}` : ''}`
      : step.reference
        ? ` (reference ${step.reference})`
        : '';
    return `${head}${tail} — ${step.status} ${step.confidence.toFixed(2)}${step.analyzer === 'AI_PROPOSAL' ? ' (AI choice)' : ''}`;
  });
  for (const event of model.unresolved)
    lines.push(
      `${event.type} — ${event.status}${event.candidates ? ` (candidates: ${event.candidates.join(', ')})` : ''}: not a business fact`,
    );
  return lines;
}
