import type { ExplorationEvent } from '../core/contracts.js';

/**
 * LE MODÈLE DU RUN MONITOR, en fonctions pures : ce que le flux d'une exploration a dit, regroupé et
 * choisi pour l'affichage. Rien n'est estimé : un flow sans événement de fin est « en cours », un
 * compte est un nombre d'événements reçus.
 */
export const MONITOR_EVENT_TYPES = [
  'flow-step',
  'flow',
  'state',
  'transition',
  'blocked',
  'issue',
  'status',
] as const;
export type MonitorEventType = (typeof MONITOR_EVENT_TYPES)[number];

/** Ce que l'utilisateur a choisi de voir ('' : tout). */
export interface MonitorView {
  flow: string;
  stepStatus: string;
  type: string;
  issueType: string;
}

export const EMPTY_VIEW: MonitorView = { flow: '', stepStatus: '', type: '', issueType: '' };

export interface FlowProgress {
  name: string;
  /** Le statut de fin donné par le moteur ; absent tant que le flow n'est pas terminé. */
  status?: string;
  steps: number;
  byStatus: Record<string, number>;
  durationMs?: number;
}

export interface MonitorFacets {
  flows: string[];
  stepStatuses: string[];
  types: string[];
  issueTypes: string[];
}

const flowOf = (event: ExplorationEvent): string | undefined =>
  event.type === 'flow' || event.type === 'flow-step' ? event.flow : undefined;

/** Les valeurs réellement présentes dans le flux, pour les listes de choix. */
export function monitorFacets(events: readonly ExplorationEvent[]): MonitorFacets {
  const flows = new Set<string>();
  const stepStatuses = new Set<string>();
  const types = new Set<string>();
  const issueTypes = new Set<string>();
  for (const event of events) {
    types.add(event.type);
    const flow = flowOf(event);
    if (flow) flows.add(flow);
    if (event.type === 'flow-step') stepStatuses.add(event.status);
    if (event.type === 'issue') issueTypes.add(event.issueType);
  }
  return {
    flows: [...flows],
    stepStatuses: [...stepStatuses].sort(),
    types: MONITOR_EVENT_TYPES.filter((type) => types.has(type)),
    issueTypes: [...issueTypes].sort(),
  };
}

/**
 * Les événements qui répondent aux choix, le plus récent d'abord. Un choix de flow ou de statut
 * d'étape ne garde que les événements de flow ; un type d'anomalie, que les anomalies.
 */
export function selectEvents(
  events: readonly ExplorationEvent[],
  view: MonitorView,
  limit = 300,
): { shown: ExplorationEvent[]; matching: number } {
  const matching = events.filter((event) => {
    if (view.type && event.type !== view.type) return false;
    if (view.flow && flowOf(event) !== view.flow) return false;
    if (view.stepStatus && (event.type !== 'flow-step' || event.status !== view.stepStatus)) return false;
    if (view.issueType && (event.type !== 'issue' || event.issueType !== view.issueType)) return false;
    return true;
  });
  return { shown: matching.slice(-limit).reverse(), matching: matching.length };
}

/** L'avancement de chaque flow imposé, tel que les événements le disent. */
export function flowProgress(events: readonly ExplorationEvent[]): FlowProgress[] {
  const flows = new Map<string, FlowProgress>();
  const entry = (name: string): FlowProgress => {
    let found = flows.get(name);
    if (!found) {
      found = { name, steps: 0, byStatus: {} };
      flows.set(name, found);
    }
    return found;
  };
  for (const event of events) {
    if (event.type === 'flow-step') {
      const progress = entry(event.flow);
      progress.steps += 1;
      progress.byStatus[event.status] = (progress.byStatus[event.status] ?? 0) + 1;
    }
    if (event.type === 'flow') {
      const progress = entry(event.flow);
      if (event.phase === 'end') {
        if (event.status) progress.status = event.status;
        if (event.durationMs !== undefined) progress.durationMs = event.durationMs;
      }
    }
  }
  return [...flows.values()];
}
