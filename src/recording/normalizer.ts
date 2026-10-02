import type { RawRecordedEvent, RecordedState, RecordingWarning, SemanticRecordedAction } from './model.js';
import { classifyRecordedValue, type ValueClassifierOptions } from './value-classifier.js';

/** Une navigation qui suit une action de si près en est la conséquence (redirection, route d'une SPA). */
const CAUSED_NAVIGATION_MS = 2500;

/**
 * SAFE NORMALIZATION : comment représenter proprement ce que l'humain a fait — pas comment le
 * raccourcir. La frappe et les corrections se fusionnent ; un bouton, un onglet, une section,
 * un choix, un envoi ou un contrôle inconnu ne disparaissent jamais.
 */
export interface SafeNormalizationOptions {
  mergeTyping?: boolean;
  /** EXACT : false (chaque valeur saisie reste une étape). */
  collapseCorrections?: boolean;
  /** Actions à ne jamais fusionner ni retirer (effet sur l'écran, dépendance d'une action suivante). */
  preserve?: ReadonlySet<string>;
}

export interface NormalizationStats {
  removedNoise: number;
  mergedInputs: number;
  collapsedCorrections: number;
  removedDetours: number;
  preexistingValues: number;
}

export interface NormalizedRecording {
  /** Toutes les actions sémantiques, annotées (dropped / merged) : la trace n'est jamais réécrite. */
  actions: SemanticRecordedAction[];
  /** Les actions gardées, dans l'ordre. */
  kept: SemanticRecordedAction[];
  stats: NormalizationStats;
  warnings: RecordingWarning[];
  /** L'humain a montré une erreur de validation exprès (point de contrôle sur l'erreur). */
  negative: boolean;
}

/**
 * RECORDING NORMALIZER — de ce que l'humain a fait à ce qu'il voulait faire :
 *   1. navigations causées par une action (redirection, route) : pas des étapes ;
 *   2. saisies successives d'un même champ : une seule (la dernière) ;
 *   3. cycle invalide → corrigé → renvoyé : voulu (point de contrôle) → NEGATIVE_VALIDATION_FLOW,
 *      gardé tel quel ; sinon la tentative ratée est écartée (AMBIGUOUS_RECORDING_INTENT) ;
 *   4. corrections (un champ ressaisi, une case cochée puis décochée) : la valeur finale ;
 *   5. valeurs : données de test, littéraux métier, secrets en { env }, valeur inchangée → rien.
 * Les détours ne sont plus retirés ici (FlowOptimizer, séparé et facultatif).
 * Une action qui écrit (requête acceptée), change un état métier ou porte un point de
 * contrôle n'est jamais écartée. Rien n'est supprimé : une action écartée garde sa raison.
 */
export function normalizeRecording(
  input: readonly SemanticRecordedAction[],
  events: readonly RawRecordedEvent[],
  states: readonly RecordedState[],
  noise: number,
  options: ValueClassifierOptions,
  /** Les navigations ont déjà été rattachées à leurs actions (ACTION CORRELATION) : les NAVIGATE restants sont des goto voulus. */
  correlated = false,
  safe: SafeNormalizationOptions = {},
): NormalizedRecording {
  const mergeTyping = safe.mergeTyping ?? true;
  const collapseCorrections = safe.collapseCorrections ?? true;
  const preserve = safe.preserve ?? new Set<string>();
  /** Jamais fusionnée ni retirée : elle écrit, porte un point de contrôle, change l'écran ou une action en dépend. */
  const keep = (action: SemanticRecordedAction): boolean =>
    protectedAction(action) || preserve.has(action.id);
  const actions = input.map((action) => ({ ...action, evidence: [...action.evidence] }));
  const rawById = new Map(events.map((event) => [event.id, event]));
  const stateById = new Map(states.map((state) => [state.id, state]));
  const stats: NormalizationStats = {
    removedNoise: noise,
    mergedInputs: 0,
    collapsedCorrections: 0,
    removedDetours: 0,
    preexistingValues: 0,
  };
  const warnings: RecordingWarning[] = [];
  const live = (): SemanticRecordedAction[] => actions.filter((action) => !action.dropped);
  const drop = (action: SemanticRecordedAction, reason: string): void => {
    if (keep(action)) return;
    action.dropped = reason;
  };

  // 1. Navigations : la première est le départ ; les autres, si une action les a causées, ne sont pas des étapes.
  let first = true;
  let previousRoute: string | undefined;
  for (const [index, action] of actions.entries()) {
    if (action.type !== 'NAVIGATE') continue;
    if (first) {
      first = false;
      previousRoute = action.route;
      continue;
    }
    const before = actions
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.type !== 'NAVIGATE');
    if (!correlated && before && action.at - before.at < CAUSED_NAVIGATION_MS && causesNavigation(before)) {
      // Un point de contrôle posé après la redirection appartient à l'action qui l'a causée.
      if (action.checkpoint !== undefined && before.checkpoint === undefined) {
        before.checkpoint = action.checkpoint;
        delete action.checkpoint;
      }
      if (action.stateAfter) before.stateAfter = action.stateAfter;
      drop(action, `navigation caused by "${before.target?.label ?? before.type}"`);
    } else if (action.route === previousRoute) drop(action, 'same page reloaded');
    previousRoute = action.route;
  }

  // 2. Saisies successives d'un même champ : une seule action, la dernière valeur.
  let previous: SemanticRecordedAction | undefined;
  for (const action of live()) {
    if (
      mergeTyping &&
      action.type === 'FILL' &&
      previous?.type === 'FILL' &&
      fieldKey(previous) === fieldKey(action) &&
      !protectedAction(previous)
    ) {
      previous.dropped = 'merged into the next input of the same field';
      action.rawEventIds = [...previous.rawEventIds, ...action.rawEventIds];
      action.merged = 'successive inputs of the same field';
      action.provenance = 'NORMALIZED_FROM_HUMAN';
      stats.mergedInputs += 1;
    }
    previous = action;
  }

  // 3. Cycle invalide → corrigé → renvoyé.
  let negative = false;
  const kept = live();
  for (const [index, action] of kept.entries()) {
    if (!isSubmitLike(action) || !failedValidation(action, stateById)) continue;
    const retry = kept.slice(index + 1).find((later) => isSubmitLike(later) && sameTarget(later, action));
    if (!retry) continue;
    const between = kept.slice(index, kept.indexOf(retry));
    if (between.some((candidate) => candidate.checkpoint !== undefined)) {
      negative = true;
      warnings.push({
        code: 'NEGATIVE_VALIDATION_FLOW',
        message: `"${action.target?.label ?? 'submit'}" was refused on purpose (checkpoint on the error), then corrected: kept as a negative validation scenario`,
        actionId: action.id,
      });
    } else {
      action.dropped = 'failed validation attempt, corrected before submitting again';
      warnings.push({
        code: 'AMBIGUOUS_RECORDING_INTENT',
        message: `"${action.target?.label ?? 'submit'}" was refused, then corrected: the refused attempt is left out (add a checkpoint on the error to keep it as a negative test)`,
        actionId: action.id,
      });
    }
  }

  // 4. Corrections : la valeur finale d'un champ (jusqu'au prochain envoi), une case revenue à son état.
  const segment: SemanticRecordedAction[] = [];
  const flush = (): void => {
    const lastOf = new Map<string, SemanticRecordedAction>();
    for (const action of segment) {
      if (!['FILL', 'SELECT', 'CHECK', 'UNCHECK'].includes(action.type)) continue;
      const key = `${action.type === 'UNCHECK' ? 'CHECK' : action.type === 'CHECK' && action.option ? `RADIO:${action.option}` : action.type}|${fieldKey(action)}`;
      const earlier = lastOf.get(key);
      // Une correction n'est fusionnée que si rien n'a dépendu de la valeur intermédiaire.
      if (earlier && collapseCorrections && !keep(earlier)) {
        if (
          (earlier.type === 'CHECK' && action.type === 'UNCHECK') ||
          (earlier.type === 'UNCHECK' && action.type === 'CHECK')
        ) {
          earlier.dropped = 'toggled back: no change';
          if (!keep(action)) action.dropped = 'toggled back: no change';
          lastOf.delete(key);
          stats.collapsedCorrections += 1;
          continue;
        }
        earlier.dropped = 'corrected later';
        action.rawEventIds = [...earlier.rawEventIds, ...action.rawEventIds];
        action.merged = action.merged ? `${action.merged}; correction` : 'correction of an earlier value';
        action.provenance = 'NORMALIZED_FROM_HUMAN';
        stats.collapsedCorrections += 1;
      }
      lastOf.set(key, action);
    }
    segment.length = 0;
  };
  for (const action of live()) {
    if (isSubmitLike(action) || action.type === 'NAVIGATE') flush();
    else segment.push(action);
  }
  flush();

  // 5. Valeurs des saisies (sans la saisie) : la dernière forme connue du champ.
  for (const action of live()) {
    if (action.type !== 'FILL') continue;
    const raw = [...action.rawEventIds]
      .reverse()
      .map((id) => rawById.get(id))
      .find((event) => event?.value);
    const element = raw?.element;
    if (!element) continue;
    action.value = classifyRecordedValue(element, raw.value, options);
    if (action.value.class === 'PREEXISTING_VALUE') {
      action.dropped = 'value unchanged (already in the field)';
      stats.preexistingValues += 1;
    }
    if (action.value.class === 'SENSITIVE_REFERENCE')
      warnings.push({
        code: 'SENSITIVE_VALUE_REDACTED',
        message: `"${action.target?.label ?? 'field'}": ${action.value.reason}`,
        actionId: action.id,
      });
  }

  // Les détours (un onglet ouvert puis quitté) ne sont PAS retirés ici : c'est de l'optimisation
  // (FlowOptimizer, optimized.flow.yaml), jamais une normalisation du parcours humain.
  return { actions, kept: live(), stats, warnings, negative };
}

/** Jamais écartée : elle écrit (requête acceptée), change un état métier, ou porte un point de contrôle. */
export function protectedAction(action: SemanticRecordedAction): boolean {
  return (
    action.checkpoint !== undefined ||
    action.network.some(
      (exchange) =>
        isWrite(exchange.method) &&
        exchange.status !== undefined &&
        exchange.status >= 200 &&
        exchange.status < 300,
    ) ||
    action.network.some((exchange) => exchange.responseState !== undefined && isWrite(exchange.method))
  );
}

export function isWrite(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function isSubmitLike(action: SemanticRecordedAction): boolean {
  return action.type === 'SUBMIT' || (action.type === 'CLICK' && action.classification === 'MUTATION');
}

function failedValidation(action: SemanticRecordedAction, states: Map<string, RecordedState>): boolean {
  const accepted = action.network.some(
    (exchange) => isWrite(exchange.method) && (exchange.status ?? 0) >= 200 && (exchange.status ?? 0) < 300,
  );
  if (accepted) return false;
  const refused = action.network.some(
    (exchange) => isWrite(exchange.method) && (exchange.status ?? 0) >= 400 && (exchange.status ?? 0) < 500,
  );
  const after = action.stateAfter ? states.get(action.stateAfter) : undefined;
  return refused || (after !== undefined && after.invalidFields > 0);
}

function causesNavigation(action: SemanticRecordedAction): boolean {
  return ['CLICK', 'SUBMIT', 'CONFIRM', 'SELECT', 'CHECK'].includes(action.type);
}

function sameTarget(a: SemanticRecordedAction, b: SemanticRecordedAction): boolean {
  return (
    a.target !== undefined &&
    b.target !== undefined &&
    JSON.stringify(a.target.target) === JSON.stringify(b.target.target)
  );
}

function fieldKey(action: SemanticRecordedAction): string {
  return action.target ? JSON.stringify(action.target.target) : action.id;
}

/** role:nom, la forme des contrôles d'un RecordedState. */
export function controlKey(action: SemanticRecordedAction): string {
  const target = action.target?.target;
  if (!target) return '';
  if (target.strategy === 'role') return `${target.role ?? ''}:${target.name ?? ''}`;
  return `:${target.value ?? ''}`;
}
