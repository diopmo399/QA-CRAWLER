import type { FlowStep } from '../config/flow-schema.js';
import type { RawRecordedEvent, RecordedState, SemanticRecordedAction } from './model.js';

/**
 * RECORDING CONSISTENCY VALIDATOR : à la fin d'un enregistrement, chaque action est relue — ses effets
 * attendus lui appartiennent-ils ? Un effet d'une action FUTURE (écarté ou resté), une route que la
 * corrélation donne à une autre action, un même effet attendu de deux actions, une attente
 * obligatoire de faible confiance : signalés (recording-validation.json), jamais corrigés en silence.
 */
export type RecordingConsistencyStatus = 'CLEAN' | 'POSSIBLY_CONTAMINATED' | 'CONTAMINATED' | 'AMBIGUOUS';

export interface RecordingConsistencyIssue {
  type:
    | 'FUTURE_ACTION_EFFECT_CONTAMINATION'
    | 'ROUTE_OWNED_BY_ANOTHER_ACTION'
    | 'OWNERSHIP_CONFLICT'
    | 'LOW_CONFIDENCE_REQUIRED_EFFECT'
    | 'TRANSIENT_SCREEN_EFFECT';
  effect: string;
  probableOwner?: string;
  /** true : l'attribution causale l'a déjà écarté des attentes (consigné pour l'explication). */
  resolved: boolean;
  detail: string;
}

export interface ActionConsistency {
  actionId: string;
  action: string;
  status: RecordingConsistencyStatus;
  issues: RecordingConsistencyIssue[];
  required: string[];
  optional: string[];
  rejected: { effect: string; classification: string; probableOwner?: string }[];
}

export interface TimelineEntry {
  /** Millisecondes depuis la première action humaine. */
  at: number;
  kind: 'HUMAN' | 'REQUEST' | 'NAVIGATION' | 'OBSERVATION';
  label: string;
  actionId?: string;
}

export interface RecordingConsistencyReport {
  status: RecordingConsistencyStatus;
  actions: ActionConsistency[];
  /** La chronologie : actions humaines, requêtes, navigations, observations — chacune avec son action. */
  timeline: TimelineEntry[];
}

const label = (action: SemanticRecordedAction): string =>
  `${action.type} ${action.target?.label ?? action.route ?? ''}`.trim();

/** Les effets attendus obligatoires d'une action, sous forme lisible (« + button:x », « route /x »…). */
function requiredOf(action: SemanticRecordedAction): string[] {
  const effects = action.expectedEffects;
  if (!effects) return [];
  return [
    ...(effects.appears ?? []).map((control) => `+ ${control}`),
    ...(effects.disappears ?? []).map((control) => `- ${control}`),
    ...(effects.route ? [`route ${effects.route}`] : []),
    ...(effects.request ? [`request ${effects.request}`] : []),
  ];
}

export function validateRecordingConsistency(
  actions: readonly SemanticRecordedAction[],
  states: readonly RecordedState[] = [],
  rawEvents: readonly RawRecordedEvent[] = [],
): RecordingConsistencyReport {
  const results: ActionConsistency[] = actions.map((action, index) => {
    const issues: RecordingConsistencyIssue[] = [];
    const required = requiredOf(action);
    const causality = action.effectCausality ?? [];
    for (const candidate of causality)
      if (candidate.classification === 'BELONGS_TO_NEXT_ACTION')
        issues.push({
          type: 'FUTURE_ACTION_EFFECT_CONTAMINATION',
          effect: candidate.effect,
          ...(candidate.ownerActionId ? { probableOwner: candidate.ownerActionId } : {}),
          resolved: true,
          detail: `rejected from this action: ${candidate.evidence.join('; ')}`,
        });
      // Un contrôle passager (déjà là avant, ou disparu avant le geste suivant) : écarté des attentes.
      else if (
        candidate.classification === 'AMBIGUOUS' &&
        (candidate.kind === 'APPEARS' || candidate.kind === 'DISAPPEARS')
      )
        issues.push({
          type: 'TRANSIENT_SCREEN_EFFECT',
          effect: candidate.effect,
          resolved: true,
          detail: `rejected from required effects: ${candidate.evidence.join('; ')}`,
        });
    // Une route attendue que la corrélation attribue à une action PLUS TARDIVE.
    const route = action.expectedEffects?.route;
    if (route)
      for (const later of actions.slice(index + 1))
        if ((later.navigation?.routes ?? []).some((candidate) => sameRoute(candidate, route))) {
          issues.push({
            type: 'ROUTE_OWNED_BY_ANOTHER_ACTION',
            effect: `route ${route}`,
            probableOwner: later.id,
            resolved: false,
            detail: `the navigation to ${route} is correlated to ${later.id} (${label(later)})`,
          });
          break;
        }
    // Le même effet attendu de l'action suivante : une propriété disputée.
    const next = actions[index + 1];
    if (next)
      for (const effect of required.filter((effect) => !effect.startsWith('request ')))
        if (requiredOf(next).includes(effect))
          issues.push({
            type: 'OWNERSHIP_CONFLICT',
            effect,
            probableOwner: next.id,
            resolved: false,
            detail: `also expected from ${next.id} (${label(next)})`,
          });
    for (const candidate of causality)
      if (required.includes(candidate.effect) && candidate.causalConfidence < 0.6)
        issues.push({
          type: 'LOW_CONFIDENCE_REQUIRED_EFFECT',
          effect: candidate.effect,
          resolved: false,
          detail: `${candidate.classification} ${String(candidate.causalConfidence)}`,
        });
    const open = issues.filter((issue) => !issue.resolved);
    const status: RecordingConsistencyStatus = open.some(
      (issue) => issue.type === 'ROUTE_OWNED_BY_ANOTHER_ACTION',
    )
      ? 'CONTAMINATED'
      : open.length > 0
        ? 'POSSIBLY_CONTAMINATED'
        : 'CLEAN';
    return {
      actionId: action.id,
      action: label(action),
      status,
      issues,
      required,
      optional: action.expectedEffects?.optional ?? [],
      rejected: causality
        .filter(
          (candidate) =>
            !['DIRECT', 'STRONGLY_CORRELATED', 'POSSIBLY_CORRELATED'].includes(candidate.classification),
        )
        .map((candidate) => ({
          effect: candidate.effect,
          classification: candidate.classification,
          ...(candidate.ownerActionId ? { probableOwner: candidate.ownerActionId } : {}),
        })),
    };
  });
  const status: RecordingConsistencyStatus = results.some((result) => result.status === 'CONTAMINATED')
    ? 'CONTAMINATED'
    : results.some((result) => result.status === 'POSSIBLY_CONTAMINATED')
      ? 'POSSIBLY_CONTAMINATED'
      : 'CLEAN';
  return { status, actions: results, timeline: timelineOf(actions, states, rawEvents) };
}

/** La chronologie de l'enregistrement : chaque événement et l'action à laquelle il est attribué. */
function timelineOf(
  actions: readonly SemanticRecordedAction[],
  states: readonly RecordedState[],
  rawEvents: readonly RawRecordedEvent[],
): TimelineEntry[] {
  const origin = actions[0]?.at ?? 0;
  const entries: TimelineEntry[] = [];
  const ownerOfState = new Map<string, string>();
  for (const action of actions) {
    entries.push({ at: action.at - origin, kind: 'HUMAN', label: label(action), actionId: action.id });
    for (const exchange of action.network)
      entries.push({
        at: action.at - origin,
        kind: 'REQUEST',
        label: `${exchange.method.toUpperCase()} ${exchange.path}${exchange.status !== undefined ? ` ${String(exchange.status)}` : ''}`,
        actionId: action.id,
      });
    if (action.stateAfter && !ownerOfState.has(action.stateAfter))
      ownerOfState.set(action.stateAfter, action.id);
    for (const navigationId of action.navigation?.navigationIds ?? []) {
      const event = rawEvents.find((candidate) => candidate.id === navigationId);
      entries.push({
        at: (event?.at ?? action.at) - origin,
        kind: 'NAVIGATION',
        label: event?.url ?? action.navigation?.routes.at(-1) ?? '',
        actionId: action.id,
      });
    }
  }
  for (const state of states)
    if (state.observedAt !== undefined && ownerOfState.has(state.id))
      entries.push({
        at: state.observedAt - origin,
        kind: 'OBSERVATION',
        label: `${state.label} (${state.route})`,
        ...(ownerOfState.get(state.id) ? { actionId: ownerOfState.get(state.id) } : {}),
      });
  return entries.sort((a, b) => a.at - b.at);
}

/** La chronologie en lignes (T+0000 HUMAN CLICK "Apply" [a9]). */
export function timelineLines(report: RecordingConsistencyReport): string[] {
  return report.timeline.map(
    (entry) =>
      `T+${String(Math.max(0, Math.round(entry.at))).padStart(4, '0')} ${entry.kind} ${entry.label}${entry.actionId ? ` [${entry.actionId}]` : ''}`,
  );
}

/**
 * MIGRATION (anciens enregistrements) : les effets attendus d'une étape qui désignent la SUITE du
 * parcours — un contrôle qui est la cible d'une étape ultérieure (N+2 et au-delà). Indice d'une
 * contamination temporelle : jamais une réécriture automatique.
 */
export function futureEffectsOf(steps: readonly FlowStep[], index: number): string[] {
  const step = steps[index];
  const effects = step?.effects;
  if (!effects) return [];
  const later = steps
    .slice(index + 2, index + 8)
    .flatMap((candidate) =>
      'target' in candidate
        ? [
            candidate.target.name,
            candidate.target.value,
            candidate.fingerprint?.name,
            candidate.fingerprint?.label,
          ]
        : [],
    )
    .filter((name): name is string => Boolean(name))
    .map((name) => normalizeName(name));
  return (effects.appears ?? []).filter((control) => {
    const name = normalizeName(control.slice(control.indexOf(':') + 1));
    return name.length > 1 && later.includes(name);
  });
}

const normalizeName = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function sameRoute(a: string, b: string): boolean {
  const template = (route: string): string =>
    (route.split(/[?#]/)[0] ?? route)
      .split('/')
      .map((segment) => (/^\{.+\}$|^:|^\d+$/.test(segment) ? '{}' : segment))
      .join('/');
  return template(a) === template(b);
}
