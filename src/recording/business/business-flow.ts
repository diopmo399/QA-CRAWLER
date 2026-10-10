import type { BusinessDetection } from './business-event-detector.js';
import {
  CONFIRMED_AT,
  PROBABLE_AT,
  type BusinessEvent,
  type BusinessFlowEntity,
  type BusinessFlowModel,
  type BusinessFlowStep,
  type BusinessStatus,
} from './model.js';

const ACTION_OF: Record<BusinessEvent['type'], BusinessFlowStep['action']> = {
  ENTITY_CREATED: 'create',
  // Jamais une étape : une création possible reste dans les incertains (son statut est UNKNOWN).
  POSSIBLE_CREATE: 'create',
  ENTITY_SEARCHED: 'search',
  ENTITY_RETRIEVED: 'retrieve',
  ENTITY_CORRELATED: 'correlate',
  ENTITY_OPENED: 'open',
  ENTITY_UPDATED: 'update',
  ENTITY_SAVED: 'save',
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
    if (
      (event.status !== 'CONFIRMED' && event.status !== 'PROBABLE') ||
      (!event.entity && !event.entityKey)
    ) {
      unresolved.push(event);
      continue;
    }
    steps.push({
      action: ACTION_OF[event.type],
      ...(event.entity ? { entity: event.entity } : {}),
      ...(event.entityKey ? { entityKey: event.entityKey } : {}),
      ...(event.provenance ? { provenance: event.provenance } : {}),
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
  // Les entités : celles que le ProvenanceResolver a suivies (identité, provenance, cycle de vie),
  // puis les entités nommées d'étapes qu'aucune identité ne porte.
  const entities: BusinessFlowEntity[] = detection.entities.map((entity) => ({
    name: entity.type,
    type:
      entity.classification.classification === 'BUSINESS_ENTITY'
        ? ('business_entity' as const)
        : ('observed_entity' as const),
    references: detection.memory.all
      .filter((record) =>
        detection.memory
          .observedWith({
            ...(record.identifier.digest ? { digest: record.identifier.digest } : {}),
            ...(record.identifier.value !== undefined ? { value: record.identifier.value } : {}),
          })
          .some((tracked) => tracked.key === entity.key),
      )
      .map((record) => record.reference),
    key: entity.key,
    identity: {
      ...(entity.identity.value !== undefined ? { value: entity.identity.value } : {}),
      source: entity.identity.source,
      ...(entity.identity.field ? { field: entity.identity.field } : {}),
      confidence: entity.identity.confidence,
    },
    provenance: {
      classification: entity.provenance.classification,
      confidence: entity.provenance.confidence,
      reason: entity.provenance.reason,
      evidence: entity.provenance.evidence,
      rules: entity.provenance.rules,
      ...(entity.provenance.contradictions ? { contradictions: entity.provenance.contradictions } : {}),
      ...(entity.provenance.candidates ? { candidates: entity.provenance.candidates } : {}),
      analyzer: entity.provenance.analyzer,
    },
    classification: {
      classification: entity.classification.classification,
      confidence: entity.classification.confidence,
      reason: entity.classification.reason,
      signals: entity.classification.signals,
    },
    firstSeen: {
      ...(entity.firstSeen.actionId ? { actionId: entity.firstSeen.actionId } : {}),
      evidence: entity.firstSeen.evidence,
    },
    lifecycle: entity.lifecycle.map((step) => ({
      kind: step.kind,
      actionIds: step.actionIds,
      stepIds: step.stepIds,
      confidence: step.confidence,
    })),
    ...(entity.linkCandidates ? { linkCandidates: entity.linkCandidates } : {}),
  }));
  for (const step of steps) {
    if (!step.entity || step.entityKey) continue;
    const named = entities.find((entry) => entry.key === undefined && entry.name === step.entity);
    if (named) {
      if (step.outputs) named.references.push(step.outputs.id);
    } else
      entities.push({
        name: step.entity,
        type: 'business_entity',
        references: step.outputs ? [step.outputs.id] : [],
      });
  }
  const count = (status: BusinessStatus): number =>
    detection.events.filter((event) => event.status === status).length;
  return {
    name,
    entities,
    steps,
    relations: detection.relations,
    correlations: detection.correlations,
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
    const head = `${step.action.toUpperCase()} ${step.entity ?? step.entityKey ?? '?'}${step.provenance ? ` [${step.provenance}]` : ''}`;
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
