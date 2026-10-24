import type { FunctionalExchange } from '../functional/model.js';
import type {
  ObservationKind,
  ObservationSource,
  RecordedFlow,
  RecordedState,
  RecordingObservation,
  RecordingSession,
  SemanticRecordedAction,
} from './model.js';
import { isWrite } from './normalizer.js';

/**
 * LES OBSERVATIONS DU RECORDING : chaque fait capturé pendant l'enregistrement, identifié (ob1, ob2…),
 * relié à son action et à son étape, daté, avec sa source et sa fiabilité. Une liste plate, lisible,
 * d'où les propositions d'assertions tirent leur origine (sourceObservationIds) et que le rapport
 * expose telle quelle.
 *
 * Règles :
 *   - rien n'est reconstitué : une observation absente (écran non observé après une action, réseau non
 *     capturé, console jamais capturée) est listée comme ABSENTE, jamais inventée ;
 *   - aucune valeur sensible : une saisie n'est décrite que par sa classe (donnée de test, littéral
 *     métier, secret) ; sa valeur n'apparaît que si elle est affichable (littéral non sensible) ;
 *   - la fiabilité est le plafond de la source (§122 du moteur cognitif) : DOM / réseau 0.95,
 *     accessibilité 0.85, humain 0.8.
 */
export interface MissingObservation {
  actionId: string;
  stepId?: string;
  what: string;
}

export interface ObservationSet {
  observations: RecordingObservation[];
  missing: MissingObservation[];
  /** Les sources que l'enregistreur ne capture pas (jamais présentées comme observées). */
  notCaptured: ObservationSource[];
}

const RELIABILITY: Record<ObservationSource, number> = {
  DOM: 0.95,
  ACCESSIBILITY: 0.85,
  NETWORK_REQUEST: 0.95,
  NETWORK_RESPONSE: 0.95,
  NAVIGATION: 0.95,
  CONSOLE: 0.9,
  USER_INPUT: 0.8,
  API_CONTRACT: 0.6,
  EXPLICIT_REQUIREMENT: 0.8,
};

export interface ObservationInput {
  session: Pick<RecordingSession, 'states' | 'checkpoints'>;
  kept: readonly SemanticRecordedAction[];
  flow: Pick<RecordedFlow, 'steps'>;
}

/** Les observations de la session, dans l'ordre des actions gardées. */
export function observationsOf(input: ObservationInput): ObservationSet {
  const stateById = new Map(input.session.states.map((state) => [state.id, state]));
  const observations: RecordingObservation[] = [];
  const missing: MissingObservation[] = [];
  const stepOf = (actionId: string): string | undefined =>
    input.flow.steps.find((item) => item.step.kind !== 'expect' && item.actionIds.includes(actionId))?.id;

  for (const action of input.kept) {
    const stepId = stepOf(action.id);
    const add = (
      kind: ObservationKind,
      source: ObservationSource,
      summary: string,
      extra: { value?: string; references?: string[]; redacted?: boolean } = {},
    ): string => {
      const id = `ob${String(observations.length + 1)}`;
      observations.push({
        id,
        kind,
        source,
        actionId: action.id,
        ...(stepId !== undefined ? { stepId } : {}),
        order: observations.length + 1,
        at: action.at,
        summary,
        ...(extra.value !== undefined ? { value: extra.value } : {}),
        reliability: RELIABILITY[source],
        references: extra.references ?? action.rawEventIds,
        ...(extra.redacted ? { redacted: true } : {}),
      });
      return id;
    };
    const before = action.stateBefore ? stateById.get(action.stateBefore) : undefined;
    const after = action.stateAfter ? stateById.get(action.stateAfter) : undefined;

    // L'élément touché : son rôle et son nom accessible (ou son libellé), tels que l'enregistreur les a lus.
    if (action.target) {
      const target = action.target.target;
      const semantic = target.strategy === 'role' || target.strategy === 'label';
      add(
        'TARGET',
        semantic ? 'ACCESSIBILITY' : 'DOM',
        `${action.type.toLowerCase()} on ${describeTarget(action.target.label, target.strategy, target.role)}${action.target.ambiguous ? ' (ambiguous)' : ''}`,
      );
    }
    // La saisie : sa classe, jamais sa valeur quand elle est sensible ou générée.
    if (action.value && (action.type === 'FILL' || action.type === 'UPLOAD')) {
      const value = action.value;
      const displayable =
        !value.sensitive && value.class === 'LITERAL_BUSINESS_VALUE' && value.literal !== undefined;
      add(
        'INPUT_VALUE',
        'USER_INPUT',
        value.sensitive
          ? `a sensitive value typed into "${action.target?.label ?? 'field'}" (redacted)`
          : value.testData
            ? `test data "${value.testData}" typed into "${action.target?.label ?? 'field'}" (${value.class})`
            : value.env
              ? `environment value ${value.env} typed into "${action.target?.label ?? 'field'}"`
              : `a ${value.class.toLowerCase().replace(/_/g, ' ')} typed into "${action.target?.label ?? 'field'}"`,
        {
          ...(displayable && value.literal !== undefined ? { value: value.literal } : {}),
          ...(value.sensitive ? { redacted: true } : {}),
        },
      );
    }
    if (action.type === 'SELECT' && action.option !== undefined)
      add(
        'SELECTED_OPTION',
        'USER_INPUT',
        `option "${action.option}" selected in "${action.target?.label ?? 'list'}"`,
        {
          value: action.option,
        },
      );
    if (action.type === 'CHECK' || action.type === 'UNCHECK')
      add(
        'CONTROL_STATE',
        'DOM',
        `"${action.target?.label ?? 'control'}" ${action.type === 'CHECK' ? 'checked' : 'unchecked'}`,
      );

    // La navigation causée par l'action, ou le changement d'écran observé.
    if (action.navigation && action.navigation.routes.length > 0)
      add(
        'NAVIGATION',
        'NAVIGATION',
        `navigation to ${action.navigation.routes.join(' → ')} (${action.navigation.confidence})`,
        {
          value: action.navigation.routes[action.navigation.routes.length - 1] ?? '',
          references: [...action.rawEventIds, ...action.navigation.navigationIds],
        },
      );
    else if (action.type === 'NAVIGATE' && action.route)
      add('NAVIGATION', 'NAVIGATION', `page ${action.route} opened`, { value: action.route });
    else if (after && before && after.route !== before.route)
      add('NAVIGATION', 'NAVIGATION', `${before.route} → ${after.route}`, {
        value: after.route,
        references: [before.id, after.id],
      });

    // L'écran après l'action : route, titre, messages, contrôles apparus.
    if (after) {
      add(
        'PAGE_STATE',
        'DOM',
        `screen ${after.route}${after.title ? ` · "${after.title}"` : ''}${after.invalidFields > 0 ? ` · ${String(after.invalidFields)} invalid field(s)` : ''}`,
        {
          references: [after.id],
        },
      );
      for (const message of newItems(after.alerts, before?.alerts))
        add('MESSAGE', 'DOM', `alert shown: "${message}"`, { value: message, references: [after.id] });
      for (const message of newItems(after.statuses ?? [], before?.statuses ?? []))
        add('MESSAGE', 'DOM', `status shown: "${message}"`, { value: message, references: [after.id] });
      for (const dialog of after.dialogs)
        add('DIALOG', 'DOM', `dialog open: "${dialog}"`, { references: [after.id] });
    } else if (action.type !== 'NAVIGATE') {
      missing.push({
        actionId: action.id,
        ...(stepId !== undefined ? { stepId } : {}),
        what: 'screen after the action not observed',
      });
    }
    for (const control of action.expectedEffects?.appears ?? [])
      add('ELEMENT_APPEARED', 'DOM', `appeared: ${control}`, { value: control });
    for (const control of action.expectedEffects?.disappears ?? [])
      add('ELEMENT_DISAPPEARED', 'DOM', `disappeared: ${control}`, { value: control });
    for (const effect of action.domEffects ?? []) add('ELEMENT_APPEARED', 'DOM', effect);

    // Le réseau déclenché par l'action : la requête (forme), la réponse (statut, état, identifiants, enregistrements).
    for (const exchange of action.network) {
      const reference = `${exchange.method} ${exchange.path}`;
      add('REQUEST', 'NETWORK_REQUEST', `${reference}${describeRequest(exchange)}`, {
        references: [...action.rawEventIds, reference],
      });
      if (exchange.status !== undefined)
        add(
          'RESPONSE',
          'NETWORK_RESPONSE',
          `${reference} → ${String(exchange.status)}${describeResponse(exchange)}`,
          {
            value: String(exchange.status),
            references: [...action.rawEventIds, reference],
          },
        );
      else
        missing.push({
          actionId: action.id,
          ...(stepId !== undefined ? { stepId } : {}),
          what: `response of ${reference} not observed`,
        });
      if (exchange.identifiers && exchange.identifiers.length > 0)
        add(
          'IDENTIFIER',
          'NETWORK_RESPONSE',
          `${String(exchange.identifiers.length)} identifier(s) in ${reference} (fingerprints only)`,
          {
            references: [reference],
          },
        );
      if (exchange.records && exchange.records.length > 0)
        add(
          'RECORDS',
          'NETWORK_RESPONSE',
          `${String(exchange.records.length)} record(s) served by ${reference}`,
          {
            value: String(exchange.records.length),
            references: [reference],
          },
        );
      else if (exchange.listSize !== undefined)
        add(
          'RECORDS',
          'NETWORK_RESPONSE',
          `a list of ${String(exchange.listSize)} item(s) served by ${reference}`,
          {
            value: String(exchange.listSize),
            references: [reference],
          },
        );
    }
    if (action.network.length === 0 && (action.type === 'SUBMIT' || action.classification === 'MUTATION'))
      missing.push({
        actionId: action.id,
        ...(stepId !== undefined ? { stepId } : {}),
        what: 'no network exchange observed for this write action',
      });

    if (action.dialog)
      add('DIALOG', 'DOM', `${action.dialog.kind}: "${action.dialog.message}"`, {
        value: action.dialog.message,
      });
    for (const effect of action.sideEffects ?? []) add('SIDE_EFFECT', 'DOM', effect);

    // Un point de contrôle posé par l'humain : une attente explicite, pas une déduction.
    const checkpoint = input.session.checkpoints.find((entry) => entry.afterActionId === action.id);
    if (checkpoint)
      add('CHECKPOINT', 'EXPLICIT_REQUIREMENT', `checkpoint "${checkpoint.label}" placed by the human`, {
        value: checkpoint.label,
        references: [checkpoint.id],
      });
  }
  return { observations, missing, notCaptured: ['CONSOLE', 'API_CONTRACT'] };
}

function describeTarget(label: string, strategy: string, role: string | undefined): string {
  if (strategy === 'role') return `${role ?? 'element'} "${label}"`;
  if (strategy === 'label') return `field "${label}"`;
  if (strategy === 'text') return `text "${label}"`;
  return `"${label}" (${strategy})`;
}

function describeRequest(exchange: FunctionalExchange): string {
  const parts: string[] = [];
  const fields = exchange.requestFields ? Object.keys(exchange.requestFields).length : 0;
  if (fields > 0) parts.push(`${String(fields)} field(s)`);
  if (exchange.requestState) parts.push(`state ${exchange.requestState.code}`);
  if (isWrite(exchange.method)) parts.push('write');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function describeResponse(exchange: FunctionalExchange): string {
  const parts: string[] = [];
  if (exchange.errorCode) parts.push(exchange.errorCode);
  if (exchange.responseState) parts.push(`state ${exchange.responseState.code}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function newItems(after: readonly string[], before: readonly string[] | undefined): string[] {
  const previous = new Set(before ?? []);
  return after.filter((item) => !previous.has(item));
}

/** Les observations d'une action, par genre (pour relier une proposition à son origine). */
export function observationIds(
  set: Pick<ObservationSet, 'observations'>,
  actionId: string,
  kinds: readonly ObservationKind[],
): string[] {
  return set.observations
    .filter((observation) => observation.actionId === actionId && kinds.includes(observation.kind))
    .map((observation) => observation.id);
}

/** Le résumé du rapport : combien d'observations par source, et ce qui manque. */
export function observationSummary(set: ObservationSet): {
  total: number;
  bySource: Partial<Record<ObservationSource, number>>;
  missing: number;
  notCaptured: ObservationSource[];
} {
  const bySource: Partial<Record<ObservationSource, number>> = {};
  for (const observation of set.observations)
    bySource[observation.source] = (bySource[observation.source] ?? 0) + 1;
  return {
    total: set.observations.length,
    bySource,
    missing: set.missing.length,
    notCaptured: set.notCaptured,
  };
}

export type { RecordedState };
