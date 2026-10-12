import { combineWeights } from '../cognitive/evidence.js';
import type { SemanticRecordedAction } from '../recording/model.js';
import {
  collectIntentEvidence,
  UI_TO_OPERATION,
  uiOfOperation,
  type IntentEvidenceInput,
} from './evidence.js';
import {
  DEFAULT_INTENT_THRESHOLDS,
  FUNCTIONAL_OPERATIONS,
  functionalName,
  UI_INTENTS,
  type ExpectedIntentEffect,
  type FunctionalIntent,
  type FunctionalOperation,
  type IntentCandidate,
  type IntentContradiction,
  type IntentEvidence,
  type IntentStatus,
  type IntentThresholds,
  type PhysicalAction,
  type UiIntent,
} from './model.js';

/**
 * FUNCTIONAL INTENT RESOLVER : des preuves aux candidats, des candidats à UNE intention — ou à
 * AMBIGUOUS, jamais à un gagnant par défaut.
 *
 *   preuves → candidats (ui:…, op:…[:entité]) → score noisy-or des preuves pour, pénalité des preuves
 *   contre → contradictions (deux candidats forts qui s'excluent) → statut par seuils ET par marge.
 *
 * Le niveau UI et le niveau fonctionnel sont résolus séparément ; le nom retenu est fonctionnel
 * quand il existe (SEARCH_ITEM), sinon UI (OPEN_DIALOG), sinon le geste (CLICK). Déterministe :
 * les mêmes preuves donnent toujours la même intention.
 */
export interface ResolveIntentOptions {
  thresholds?: Partial<IntentThresholds>;
  stepId?: string;
}

/** La part d'une preuve pour ses candidats secondaires (ceux qu'elle liste après le premier). */
const SECONDARY_SUPPORT = 0.55;

const PHYSICAL: Partial<Record<SemanticRecordedAction['type'], PhysicalAction>> = {
  NAVIGATE: 'NAVIGATE',
  CLICK: 'CLICK',
  FILL: 'FILL',
  SELECT: 'SELECT',
  CHECK: 'CHECK',
  UNCHECK: 'UNCHECK',
  SUBMIT: 'SUBMIT',
  CONFIRM: 'CONFIRM',
  CANCEL: 'CANCEL',
  UPLOAD: 'UPLOAD',
  DRAG_AND_DROP: 'DRAG_AND_DROP',
};

/** Les gestes dont l'intention d'interface découle du geste lui-même. */
const INTRINSIC_UI: Partial<Record<SemanticRecordedAction['type'], UiIntent>> = {
  NAVIGATE: 'NAVIGATE',
  FILL: 'ENTER_VALUE',
  SELECT: 'CHOOSE_OPTION',
  UPLOAD: 'UPLOAD',
  CONFIRM: 'CONFIRM',
  CANCEL: 'CANCEL',
  DRAG_AND_DROP: 'MOVE_ITEM',
};

/** Les intentions d'interface qui s'excluent : deux candidats forts de deux groupes = contradiction. */
const EXCLUSIVE_GROUPS: readonly UiIntent[][] = [
  ['SEARCH', 'FILTER', 'SORT', 'PAGINATE'],
  ['SUBMIT', 'SAVE', 'ADD', 'EDIT', 'REMOVE'],
  ['CANCEL', 'BACK', 'CLOSE_DIALOG', 'CLOSE_SECTION'],
  ['OPEN_DIALOG', 'OPEN_SECTION', 'OPEN_MENU', 'SELECT_TAB'],
  ['NAVIGATE', 'OPEN_ITEM', 'NEXT'],
  ['SELECT_ITEM', 'DESELECT_ITEM', 'TOGGLE', 'CHOOSE_OPTION', 'ENTER_VALUE'],
  ['LOGIN', 'LOGOUT'],
  ['CONFIRM', 'MOVE_ITEM', 'UPLOAD'],
];

/** Le geste peut-il porter cette intention d'interface ? (une saisie n'est jamais un SEARCH) */
function compatible(physical: PhysicalAction, ui: UiIntent): boolean {
  switch (physical) {
    case 'FILL':
      return ui === 'ENTER_VALUE' || ui === 'SEARCH';
    case 'SELECT':
      return ui === 'CHOOSE_OPTION' || ui === 'FILTER' || ui === 'SORT';
    case 'CHECK':
      return ui === 'SELECT_ITEM' || ui === 'TOGGLE' || ui === 'CHOOSE_OPTION';
    case 'UNCHECK':
      return ui === 'DESELECT_ITEM' || ui === 'TOGGLE';
    case 'NAVIGATE':
      return ui === 'NAVIGATE';
    case 'UPLOAD':
      return ui === 'UPLOAD';
    case 'DRAG_AND_DROP':
      return ui === 'MOVE_ITEM';
    case 'CONFIRM':
      return ui === 'CONFIRM' || ui === 'SUBMIT' || ui === 'SAVE' || ui === 'REMOVE';
    case 'CANCEL':
      return ui === 'CANCEL' || ui === 'CLOSE_DIALOG';
    default:
      return ui !== 'ENTER_VALUE' && ui !== 'CHOOSE_OPTION' && ui !== 'UPLOAD' && ui !== 'MOVE_ITEM';
  }
}

interface Scored {
  key: string;
  level: 'ui' | 'op';
  confidence: number;
  evidenceIds: string[];
  contradictedBy: string[];
}

function score(evidence: readonly IntentEvidence[], physical: PhysicalAction): Scored[] {
  // Une preuve qui soutient plusieurs candidats pèse entièrement pour le PREMIER (son candidat
  // principal) et moins pour les suivants : « label Search » dit SEARCH avant FILTER.
  const forKeys = new Map<string, { item: IntentEvidence; weight: number }[]>();
  const against = new Map<string, IntentEvidence[]>();
  for (const item of evidence) {
    item.supports.forEach((key, position) => {
      forKeys.set(key, [
        ...(forKeys.get(key) ?? []),
        { item, weight: item.weight * (position === 0 ? 1 : SECONDARY_SUPPORT) },
      ]);
    });
    for (const key of item.contradicts ?? []) against.set(key, [...(against.get(key) ?? []), item]);
  }
  const scored: Scored[] = [];
  for (const [key, supporters] of forKeys) {
    const level = key.startsWith('ui:') ? 'ui' : 'op';
    if (level === 'ui' && !compatible(physical, key.slice(3) as UiIntent)) continue;
    // Les preuves contre une opération visent aussi ses variantes par entité (op:SEARCH ⊃ op:SEARCH:item).
    const generic = level === 'op' ? key.split(':').slice(0, 2).join(':') : key;
    const opponents = [...(against.get(key) ?? []), ...(generic !== key ? (against.get(generic) ?? []) : [])];
    const support = combineWeights(supporters.map((entry) => entry.weight));
    const penalty = combineWeights(opponents.map((item) => item.weight * 0.7));
    scored.push({
      key,
      level,
      confidence: Math.round(Math.max(0, support * (1 - penalty)) * 1000) / 1000,
      evidenceIds: supporters.map((entry) => entry.item.id),
      contradictedBy: opponents.map((item) => item.id),
    });
  }
  // Une opération nommée par entité hérite des preuves de l'opération générique (op:SEARCH → op:SEARCH:item).
  for (const entry of scored.filter(
    (candidate) => candidate.level === 'op' && candidate.key.split(':').length === 3,
  )) {
    const generic = scored.find((candidate) => candidate.key === entry.key.split(':').slice(0, 2).join(':'));
    if (!generic) continue;
    const ids = [...new Set([...entry.evidenceIds, ...generic.evidenceIds])];
    const weights = ids.map(
      (id) =>
        (forKeys.get(entry.key) ?? []).find((candidate) => candidate.item.id === id)?.weight ??
        (forKeys.get(generic.key) ?? []).find((candidate) => candidate.item.id === id)?.weight ??
        0,
    );
    const penalty = combineWeights(
      entry.contradictedBy.map((id) => (evidence.find((item) => item.id === id)?.weight ?? 0) * 0.7),
    );
    entry.evidenceIds = ids;
    entry.confidence = Math.round(Math.max(0, combineWeights(weights) * (1 - penalty)) * 1000) / 1000;
  }
  return scored.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
}

function candidateOf(entry: Scored, evidence: readonly IntentEvidence[]): IntentCandidate {
  const parts = entry.key.split(':');
  const ui = entry.level === 'ui' ? (parts[1] as UiIntent) : undefined;
  const operation = entry.level === 'op' ? (parts[1] as FunctionalOperation) : undefined;
  const entity = entry.level === 'op' ? parts[2] : undefined;
  const summaries = entry.evidenceIds
    .map((id) => evidence.find((item) => item.id === id)?.summary ?? id)
    .slice(0, 4);
  return {
    name: operation ? functionalName(operation, entity) : (ui ?? entry.key),
    ...(ui ? { ui } : {}),
    ...(operation ? { operation } : {}),
    ...(entity ? { entity } : {}),
    confidence: entry.confidence,
    evidenceIds: entry.evidenceIds,
    contradictedBy: entry.contradictedBy,
    explanation: `${summaries.join('; ')}${entry.contradictedBy.length > 0 ? ` · against: ${String(entry.contradictedBy.length)} evidence(s)` : ''}`,
  };
}

/** Deux candidats UI du même groupe exclusif (SEARCH / FILTER) ou croisés par leurs preuves contre : des rivaux. */
/** Les groupes qui s'excluent entre eux : lire (SEARCH) n'est pas écrire (SUBMIT) ni renoncer (CANCEL). */
const RIVAL_GROUP_PAIRS: readonly [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
  [3, 4],
  [2, 4],
];

function rivals(a: Scored, b: Scored): boolean {
  if (a.level === 'op' || b.level === 'op') return true;
  const uiA = a.key.slice(3) as UiIntent;
  const uiB = b.key.slice(3) as UiIntent;
  const groupA = EXCLUSIVE_GROUPS.findIndex((group) => group.includes(uiA));
  const groupB = EXCLUSIVE_GROUPS.findIndex((group) => group.includes(uiB));
  if (groupA >= 0 && groupA === groupB) return true;
  if (RIVAL_GROUP_PAIRS.some(([x, y]) => (groupA === x && groupB === y) || (groupA === y && groupB === x)))
    return true;
  return (
    a.contradictedBy.some((id) => b.evidenceIds.includes(id)) ||
    b.contradictedBy.some((id) => a.evidenceIds.includes(id))
  );
}

function statusOf(ranked: readonly Scored[], thresholds: IntentThresholds): IntentStatus {
  const best = ranked[0];
  if (!best || best.confidence <= 0) return 'UNKNOWN';
  // Un rival (même groupe exclusif, ou preuves croisées) trop proche : ambigu, quelle que soit la confiance.
  // Deux intentions compatibles (OPEN_DIALOG et EDIT) ne se disputent pas : la meilleure gagne, l'autre reste une alternative.
  const rival = ranked.slice(1).find((entry) => rivals(best, entry));
  const close =
    rival !== undefined &&
    best.confidence - rival.confidence < thresholds.margin &&
    rival.confidence >= thresholds.probable * 0.8;
  if (close) return 'AMBIGUOUS';
  if (best.confidence >= thresholds.confirmed) return 'CONFIRMED';
  if (best.confidence >= thresholds.probable) return 'PROBABLE';
  return ranked.slice(1).some((entry) => rivals(best, entry) && entry.confidence > 0)
    ? 'AMBIGUOUS'
    : 'UNKNOWN';
}

function contradictionsOf(
  ranked: readonly Scored[],
  evidence: readonly IntentEvidence[],
  thresholds: IntentThresholds,
): IntentContradiction[] {
  const strong = ranked.filter(
    (entry) => entry.level === 'ui' && entry.confidence >= thresholds.probable * 0.5,
  );
  const found: IntentContradiction[] = [];
  for (let a = 0; a < strong.length; a += 1)
    for (let b = a + 1; b < strong.length; b += 1) {
      const first = strong[a];
      const second = strong[b];
      if (!first || !second) continue;
      const uiA = first.key.slice(3) as UiIntent;
      const uiB = second.key.slice(3) as UiIntent;
      const sameGroup = EXCLUSIVE_GROUPS.some((group) => group.includes(uiA) && group.includes(uiB));
      // Deux intentions de groupes différents, chacune contredite par les preuves de l'autre : une vraie opposition.
      const crossed =
        first.contradictedBy.some((id) => second.evidenceIds.includes(id)) ||
        second.contradictedBy.some((id) => first.evidenceIds.includes(id));
      if (sameGroup || !crossed) continue;
      const ids = [...new Set([...first.evidenceIds, ...second.evidenceIds])];
      found.push({
        id: `ic${String(found.length + 1)}`,
        summary: `${uiA} (${String(first.confidence)}) vs ${uiB} (${String(second.confidence)}): ${evidence.find((item) => first.contradictedBy.includes(item.id))?.summary ?? evidence.find((item) => second.contradictedBy.includes(item.id))?.summary ?? 'opposing evidence'}`,
        between: [uiA, uiB],
        evidenceIds: ids,
      });
    }
  return found;
}

function expectedEffectsOf(
  evidence: readonly IntentEvidence[],
  ui: UiIntent | undefined,
  operation: FunctionalOperation | undefined,
): ExpectedIntentEffect[] {
  const effects: ExpectedIntentEffect[] = [];
  const push = (kind: ExpectedIntentEffect['kind'], detail?: string): void => {
    if (!effects.some((effect) => effect.kind === kind))
      effects.push({ kind, ...(detail ? { detail } : {}) });
  };
  for (const item of evidence) {
    if (item.type === 'EFFECT_ROWS') push('ROWS_CHANGED', item.summary);
    if (item.type === 'EFFECT_ROUTE') push('ROUTE_CHANGED', item.summary);
    if (item.type === 'EFFECT_DIALOG')
      push(item.summary.includes('closed') ? 'DIALOG_CLOSED' : 'DIALOG_OPENED', item.summary);
    if (item.type === 'EFFECT_APPEARS') push('CONTROLS_APPEARED', item.summary);
    if (item.type === 'EFFECT_DISAPPEARS') push('CONTROLS_DISAPPEARED', item.summary);
    if (item.type === 'EFFECT_SELECTION') push('SELECTION_CHANGED', item.summary);
    if (item.type === 'NETWORK_LIST') push('RESULTS_UPDATED', item.summary);
    if (
      item.type === 'NETWORK_WRITE' ||
      item.type === 'NETWORK_READ' ||
      item.type === 'NETWORK_LIST' ||
      item.type === 'NETWORK_STATE'
    )
      push('NETWORK_REQUEST', item.summary);
    if (item.type === 'NETWORK_STATE' && item.summary.includes('moved the state'))
      push('RECORD_STATE_CHANGED', item.summary);
    if (item.type === 'NETWORK_WRITE' && item.summary.includes('created'))
      push('RECORD_CREATED', item.summary);
  }
  if (operation === 'SEARCH' || ui === 'SEARCH' || ui === 'FILTER') push('RESULTS_UPDATED');
  if (ui === 'OPEN_DIALOG') push('DIALOG_OPENED');
  if (ui === 'SELECT_ITEM' || ui === 'DESELECT_ITEM') push('SELECTION_CHANGED');
  return effects;
}

/** L'intention d'une action, à partir de ses preuves (voir collectIntentEvidence). */
export function resolveFunctionalIntent(
  input: IntentEvidenceInput,
  options: ResolveIntentOptions = {},
): FunctionalIntent {
  const thresholds: IntentThresholds = { ...DEFAULT_INTENT_THRESHOLDS, ...options.thresholds };
  const { action } = input;
  const physical = PHYSICAL[action.type] ?? 'CLICK';
  const collected = collectIntentEvidence(input);
  const evidence = [...collected.evidence];
  const intrinsic = INTRINSIC_UI[action.type];
  if (intrinsic)
    evidence.push({
      id: `ie${String(evidence.length + 1)}`,
      type: 'ROLE',
      trust: 'RUNTIME',
      summary: `the gesture itself is ${intrinsic}`,
      weight: 0.9,
      supports: [`ui:${intrinsic}`],
    });
  const ranked = score(evidence, physical);
  const uiRanked = ranked.filter((entry) => entry.level === 'ui');
  const opRanked = ranked.filter((entry) => entry.level === 'op');
  // Une opération suggérée par la meilleure intention UI (sans preuve métier propre) : un candidat faible, jamais plus.
  const bestUi = uiRanked[0];
  if (bestUi && opRanked.length === 0) {
    const suggested = UI_TO_OPERATION[bestUi.key.slice(3) as UiIntent];
    if (suggested && bestUi.confidence >= thresholds.probable)
      opRanked.push({
        key: `op:${suggested}${collected.entity ? `:${collected.entity}` : ''}`,
        level: 'op',
        confidence: Math.round(bestUi.confidence * 0.6 * 1000) / 1000,
        evidenceIds: bestUi.evidenceIds,
        contradictedBy: bestUi.contradictedBy,
      });
  }
  const uiStatus = statusOf(uiRanked, thresholds);
  const opStatus = statusOf(opRanked, thresholds);
  const ui =
    bestUi && uiStatus !== 'UNKNOWN' && uiStatus !== 'AMBIGUOUS'
      ? (bestUi.key.slice(3) as UiIntent)
      : undefined;
  const bestOp = opRanked[0];
  const functional =
    bestOp && (opStatus === 'CONFIRMED' || opStatus === 'PROBABLE')
      ? (() => {
          const parts = bestOp.key.split(':');
          const operation = parts[1] as FunctionalOperation;
          const entity = parts[2] ?? collected.entity;
          return { operation, entity: entity ?? 'ENTITY', name: functionalName(operation, entity) };
        })()
      : undefined;
  const contradictions = contradictionsOf(ranked, evidence, thresholds);
  // Le statut global : celui du niveau le plus précis qui a répondu ; une contradiction forte abaisse à AMBIGUOUS.
  let status: IntentStatus = functional ? opStatus : uiStatus;
  if (status === 'UNKNOWN' && (opStatus === 'AMBIGUOUS' || uiStatus === 'AMBIGUOUS')) status = 'AMBIGUOUS';
  if (contradictions.length > 0 && status === 'CONFIRMED') status = 'PROBABLE';
  const alternatives: IntentCandidate[] = [
    ...(functional ? opRanked : []),
    ...uiRanked,
    ...(functional ? [] : opRanked),
  ]
    .map((entry) => candidateOf(entry, evidence))
    .filter((candidate, index, list) => list.findIndex((other) => other.name === candidate.name) === index);
  const chosen = functional ? bestOp : bestUi;
  const confidence = chosen?.confidence ?? 0;
  const name =
    functional?.name ??
    ui ??
    (uiStatus === 'AMBIGUOUS' && bestUi
      ? `AMBIGUOUS(${uiRanked
          .slice(0, 2)
          .map((entry) => entry.key.slice(3))
          .join('|')})`
      : physical);
  const explanation = chosen
    ? `${name}: ${
        chosen.evidenceIds.length > 0
          ? chosen.evidenceIds
              .map((id) => evidence.find((item) => item.id === id)?.summary ?? id)
              .slice(0, 5)
              .join('; ')
          : 'no evidence'
      }${status === 'AMBIGUOUS' ? ` — ambiguous with ${alternatives[1]?.name ?? 'another candidate'}` : ''}`
    : `no evidence names the intention of this ${physical}`;
  return {
    actionId: action.id,
    ...(options.stepId ? { stepId: options.stepId } : {}),
    physical,
    ...(ui ? { ui } : {}),
    ...(functional ? { functional } : {}),
    name,
    ...(functional || collected.entity
      ? {
          subject: {
            ...(functional
              ? { type: functional.entity }
              : collected.entity
                ? { type: collected.entity }
                : {}),
          },
        }
      : {}),
    ...(action.target
      ? {
          target: {
            ...((action.target.fingerprint?.role ?? action.target.target.role)
              ? { role: action.target.fingerprint?.role ?? action.target.target.role }
              : {}),
            ...(action.target.label ? { label: action.target.label } : {}),
          },
        }
      : {}),
    context: collected.context,
    expectedEffects: expectedEffectsOf(evidence, ui, functional?.operation),
    evidence,
    confidence,
    alternatives,
    contradictions,
    status,
    source: 'DETERMINISTIC',
    explanation,
  };
}

/** Un candidat retenu de l'extérieur (humain, IA) devient l'intention : l'action brute et les preuves ne changent pas. */
export function adoptCandidate(
  intent: FunctionalIntent,
  candidateName: string,
  source: FunctionalIntent['source'],
  reason: string,
): FunctionalIntent {
  const candidate = intent.alternatives.find((entry) => entry.name === candidateName);
  if (!candidate) return intent;
  const ui =
    candidate.ui ?? (candidate.operation ? uiOfOperation(candidate.operation)?.[0] : undefined) ?? intent.ui;
  const functional = candidate.operation
    ? {
        operation: candidate.operation,
        entity: candidate.entity ?? intent.subject?.type ?? 'ENTITY',
        name: candidate.name,
      }
    : undefined;
  return {
    ...intent,
    ...(ui ? { ui } : {}),
    ...(functional ? { functional } : {}),
    name: candidate.name,
    confidence: Math.max(intent.confidence, candidate.confidence),
    alternatives: [candidate, ...intent.alternatives.filter((entry) => entry !== candidate)],
    status: source === 'HUMAN_DECISION' ? 'CONFIRMED' : 'PROBABLE',
    source,
    explanation: `${candidate.name} chosen by ${source}: ${reason}`,
  };
}

export const KNOWN_UI_INTENTS: ReadonlySet<string> = new Set(UI_INTENTS);
export const KNOWN_OPERATIONS: ReadonlySet<string> = new Set(FUNCTIONAL_OPERATIONS);
