import type { RawRecordedEvent, RecordedState, RecordingWarning, SemanticRecordedAction } from './model.js';
import {
  fieldIdentityOfEvent,
  matchFieldIdentity,
  sameFunctionalField,
  type FieldIdentity,
  type FieldIdentityMatch,
} from './field-identity.js';
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
  /** Un clic sans effet aussitôt répété sur la même cible avec effet : une seule étape. EXACT : false. */
  mergeRetryClicks?: boolean;
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

/**
 * TYPING MERGE DECISION : chaque fusion (ou refus de fusion) de deux saisies est expliquée.
 * PRESERVE FIRST, MERGE ONLY WITH EVIDENCE : en cas de doute, deux actions plutôt qu'une saisie perdue.
 */
export interface TypingMergeDecision {
  previousActionId: string;
  currentActionId: string;
  /** Les événements bruts des deux saisies (h013 → h015). */
  previousRawEventIds: string[];
  currentRawEventIds: string[];
  /** TYPING_MERGED (saisies successives) ou CORRECTION (le même champ ressaisi plus tard). */
  rule: 'TYPING_MERGED' | 'CORRECTION';
  decision: 'MERGE' | 'KEEP_SEPARATE' | 'AMBIGUOUS_KEEP_SEPARATE';
  verdict: FieldIdentityMatch['verdict'];
  confidence: number;
  reasons: string[];
  /** Les identités comparées (de quoi relire la décision). */
  previousIdentity?: FieldIdentity;
  currentIdentity?: FieldIdentity;
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
  /** Chaque décision de fusion de saisies, avec ses preuves. */
  mergeDecisions: TypingMergeDecision[];
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

  // 2. Saisies successives d'un même champ : une seule action, la dernière valeur — seulement si
  //    l'IDENTITÉ FONCTIONNELLE le prouve (jamais un localisateur identique à lui seul).
  const mergeDecisions: TypingMergeDecision[] = [];
  const decide = new FieldMergeJudge(events);
  let previous: SemanticRecordedAction | undefined;
  for (const action of live()) {
    if (mergeTyping && action.type === 'FILL' && previous?.type === 'FILL' && !protectedAction(previous)) {
      const decision = decide.judge(previous, action, 'TYPING_MERGED');
      mergeDecisions.push(decision);
      if (decision.decision !== 'MERGE') {
        previous = action;
        continue;
      }
      previous.dropped = 'merged into the next input of the same field';
      action.rawEventIds = [...previous.rawEventIds, ...action.rawEventIds];
      action.merged = 'successive inputs of the same field';
      action.provenance = 'NORMALIZED_FROM_HUMAN';
      stats.mergedInputs += 1;
    }
    previous = action;
  }

  // 2b. RETRY CLICK : deux clics consécutifs sur la MÊME cible (même libellé, même ligne / section),
  //     rapprochés, sans rien entre eux ; le premier n'a RIEN produit (écran, navigation, requête), le
  //     second produit l'effet. L'humain a recliqué parce que rien ne se passait (ou a cliqué la cellule
  //     puis le lien qu'elle contient) : une seule intention, l'étape qui a l'effet. Un clic qui a lui-même
  //     un effet n'est jamais retiré (un compteur « + », un bouton de pagination restent tous gardés).
  if (safe.mergeRetryClicks ?? true) {
    let before: SemanticRecordedAction | undefined;
    for (const action of live()) {
      if (
        before &&
        before.type === 'CLICK' &&
        action.type === 'CLICK' &&
        !keep(before) &&
        action.at - before.at <= RETRY_CLICK_MS &&
        sameClickTarget(before, action) &&
        !hasEffect(before) &&
        hasEffect(action)
      ) {
        before.dropped = `retry click: "${before.target?.label ?? 'click'}" had no effect, the next click on the same target did (RETRY_CLICK_MERGED)`;
        action.evidence.push(
          `RETRY_CLICK_MERGED: the previous click on the same target (${before.rawEventIds.join(', ')}) had no effect`,
        );
        action.provenance = 'NORMALIZED_FROM_HUMAN';
      }
      before = action;
    }
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
      const kind =
        action.type === 'UNCHECK'
          ? 'CHECK'
          : action.type === 'CHECK' && action.option
            ? `RADIO:${action.option}`
            : action.type;
      // La valeur précédente du MÊME champ fonctionnel (identité prouvée), jamais d'un champ au même CSS.
      let key = '';
      for (const [candidateKey, candidate] of lastOf) {
        if (!candidateKey.startsWith(`${kind}|`)) continue;
        const decision = decide.judge(candidate, action, 'CORRECTION');
        if (decision.decision === 'MERGE') {
          key = candidateKey;
          if (collapseCorrections && !keep(candidate)) mergeDecisions.push(decision);
          break;
        }
      }
      key ||= `${kind}|${action.id}`;
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
        lastOf.delete(key);
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
  return { actions, kept: live(), stats, warnings, negative, mergeDecisions };
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

/** Un clic suivi de l'autre en moins de ce délai : un « reclic » possible (jamais au-delà). */
const RETRY_CLICK_MS = 2500;

/** L'action a-t-elle produit quelque chose d'observable (écran, navigation, requête) ? */
function hasEffect(action: SemanticRecordedAction): boolean {
  return (
    (action.domEffects ?? []).length > 0 ||
    action.navigation !== undefined ||
    action.network.length > 0 ||
    action.checkpoint !== undefined
  );
}

/**
 * La même cible de clic : le même libellé lu par l'humain, et le même contexte quand les deux le
 * portent (ligne, section, fenêtre). Une cellule et le lien qu'elle contient (même texte, même ligne)
 * sont la même cible ; deux « Edit » de deux lignes ne le sont jamais.
 */
function sameClickTarget(a: SemanticRecordedAction, b: SemanticRecordedAction): boolean {
  const norm = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const labelA = norm(a.target?.label);
  if (!labelA || labelA !== norm(b.target?.label)) return false;
  const fa = a.target?.fingerprint;
  const fb = b.target?.fingerprint;
  const compatible = (x: string | undefined, y: string | undefined): boolean =>
    x === undefined || y === undefined || norm(x) === norm(y);
  return (
    compatible(fa?.row, fb?.row) &&
    compatible(fa?.section, fb?.section) &&
    compatible(fa?.dialog, fb?.dialog) &&
    compatible(fa?.tab, fb?.tab)
  );
}

function sameTarget(a: SemanticRecordedAction, b: SemanticRecordedAction): boolean {
  return (
    a.target !== undefined &&
    b.target !== undefined &&
    JSON.stringify(a.target.target) === JSON.stringify(b.target.target)
  );
}

/**
 * Le juge des fusions : l'identité de la dernière saisie de l'action précédente contre celle de la
 * première saisie de l'action courante, et les frontières entre les deux (un clic de focus dans un
 * AUTRE champ : FOCUS_CHANGED_TO_DIFFERENT_FIELD).
 */
class FieldMergeJudge {
  private readonly byId: Map<string, RawRecordedEvent>;
  constructor(private readonly events: readonly RawRecordedEvent[]) {
    this.byId = new Map(events.map((event) => [event.id, event]));
  }

  judge(
    previous: SemanticRecordedAction,
    current: SemanticRecordedAction,
    rule: TypingMergeDecision['rule'],
  ): TypingMergeDecision {
    const lastRaw = this.withElement([...previous.rawEventIds].reverse());
    const firstRaw = this.withElement(current.rawEventIds);
    const a = fieldIdentityOfEvent(lastRaw);
    const b = fieldIdentityOfEvent(firstRaw);
    const base = {
      previousActionId: previous.id,
      currentActionId: current.id,
      previousRawEventIds: [...previous.rawEventIds],
      currentRawEventIds: [...current.rawEventIds],
      rule,
      ...(a ? { previousIdentity: a } : {}),
      ...(b ? { currentIdentity: b } : {}),
    };
    if (!a || !b) {
      // Sans élément décrit : seul un localisateur sémantique identique (jamais un CSS fragile) suffit.
      const same =
        previous.target !== undefined &&
        current.target !== undefined &&
        previous.target.quality !== 'FRAGILE' &&
        JSON.stringify(previous.target.target) === JSON.stringify(current.target.target);
      return {
        ...base,
        decision: same ? 'MERGE' : 'AMBIGUOUS_KEEP_SEPARATE',
        verdict: same ? 'STRONG_SAME_FIELD' : 'AMBIGUOUS_FIELD',
        confidence: same ? 0.8 : 0.3,
        reasons: [same ? 'same semantic locator (no element description)' : 'no field identity to compare'],
      };
    }
    const match = matchFieldIdentity(a, b);
    const reasons = [...match.confidence.reasons];
    // Une frontière forte : entre les deux saisies, le focus est passé dans un AUTRE champ.
    if (match.verdict !== 'EXACT_SAME_FIELD' && rule === 'TYPING_MERGED' && lastRaw && firstRaw) {
      const boundary = this.events.find((event) => {
        if (event.sequence <= lastRaw.sequence || event.sequence >= firstRaw.sequence) return false;
        const other = fieldIdentityOfEvent(event);
        return (
          (event.type === 'click' || event.type === 'input' || event.type === 'change') &&
          other !== undefined &&
          matchFieldIdentity(a, other).verdict !== 'EXACT_SAME_FIELD' &&
          (other.domInstance !== undefined || matchFieldIdentity(a, other).verdict === 'DIFFERENT_FIELD')
        );
      });
      if (boundary) {
        return {
          ...base,
          decision: 'KEEP_SEPARATE',
          verdict: match.verdict === 'STRONG_SAME_FIELD' ? 'AMBIGUOUS_FIELD' : match.verdict,
          confidence: Math.min(match.confidence.score, 0.3),
          reasons: [`FOCUS_CHANGED_TO_DIFFERENT_FIELD (${boundary.id})`, ...reasons],
        };
      }
    }
    // L'élément actif au moment de la saisie n'est pas celui de la saisie précédente.
    const active = firstRaw?.activeDomInstance;
    if (match.verdict !== 'EXACT_SAME_FIELD' && active && a.domInstance && active !== a.domInstance)
      reasons.push(`active element ${active} ≠ ${a.domInstance}`);
    return {
      ...base,
      decision: sameFunctionalField(match)
        ? 'MERGE'
        : match.verdict === 'AMBIGUOUS_FIELD'
          ? 'AMBIGUOUS_KEEP_SEPARATE'
          : 'KEEP_SEPARATE',
      verdict: match.verdict,
      confidence: match.confidence.score,
      reasons,
    };
  }

  private withElement(ids: readonly string[]): RawRecordedEvent | undefined {
    for (const id of ids) {
      const event = this.byId.get(id);
      if (event?.element) return event;
    }
    return undefined;
  }
}

/** role:nom, la forme des contrôles d'un RecordedState. */
export function controlKey(action: SemanticRecordedAction): string {
  const target = action.target?.target;
  if (!target) return '';
  if (target.strategy === 'role') return `${target.role ?? ''}:${target.name ?? ''}`;
  return `:${target.value ?? ''}`;
}
