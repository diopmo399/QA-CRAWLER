import type { FlowStep } from '../config/flow-schema.js';
import { slug } from '../knowledge/signatures.js';
import { saysCancel, uiIntentsOfLabel } from '../replay/planner.js';
import { labelSimilarity, round, tokensOf } from '../workflow-healing/similarity.js';
import type { FlowIntent } from './flow-intent-graph.js';
import type {
  IntentFinding,
  ObservedFlowGraph,
  ObservedStep,
  PairingBreakdown,
  PairingCandidate,
  ReconciliationStatus,
} from './reconciliation-model.js';

/**
 * SEMANTIC RECONCILIATION : après l'alignement brut (FlowAlignment), une étape attendue restée
 * sans correspondance (MISSING, POSSIBLY_OBSOLETE, UNREACHABLE) et une étape observée restée
 * « insérée » (INSERTED) peuvent désigner le même événement fonctionnel sous deux formes
 * techniques : un localisateur qui a changé, un libellé reformulé, le même bouton sur un autre
 * écran. Le moteur ne compare donc pas seulement `target == target` :
 *
 *   alignement brut → appariement des candidats → réconciliation sémantique → statut final
 *
 * Chaque couple (attendue, observée) reçoit un score par dimension — cible, intention, entité,
 * contexte, séquence (action précédente et suivante), effet — puis un total pondéré. Au-dessus
 * du seuil, le couple devient UNE entrée (MATCHED_SEMANTICALLY, MATCHED_WITH_TARGET_CHANGE,
 * MATCHED_WITH_CONTEXT_CHANGE ou MATCHED_AFTER_INSERTION). Deux candidats aussi plausibles pour la
 * même attendue : DUPLICATE_CANDIDATE, rien n'est choisi arbitrairement. Un libellé qui dit
 * l'abandon (cancel, close, back) alors que l'attendue ne le dit pas n'est jamais apparié ; un
 * champ de saisie, une vérification ou une adresse non plus : seul un geste (clic, envoi,
 * navigation par libellé) peut avoir changé de forme. Pur : aucune dépendance au navigateur.
 */
export interface SemanticPairingOptions {
  /** Score total minimal d'une paire (défaut 0.7). */
  minScore?: number;
  /** Deux candidats dont les scores diffèrent de moins que cette marge : DUPLICATE_CANDIDATE (défaut 0.1). */
  ambiguityMargin?: number;
  /** Formes équivalentes d'un terme (SemanticDictionary.expand). */
  synonyms?: (term: string) => readonly string[];
}

export interface SemanticPair {
  intent: FlowIntent;
  observed: ObservedStep;
  status: Extract<
    ReconciliationStatus,
    | 'MATCHED_SEMANTICALLY'
    | 'MATCHED_WITH_TARGET_CHANGE'
    | 'MATCHED_WITH_CONTEXT_CHANGE'
    | 'MATCHED_AFTER_INSERTION'
  >;
  score: PairingBreakdown;
  candidates: PairingCandidate[];
  reasons: string[];
}

export interface DuplicateCandidates {
  intent: FlowIntent;
  candidates: PairingCandidate[];
  reasons: string[];
}

export interface SemanticReconciliationResult {
  pairs: SemanticPair[];
  duplicates: DuplicateCandidates[];
}

const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_MARGIN = 0.1;
/** Poids des dimensions (somme 1). */
const WEIGHTS: Record<Exclude<keyof PairingBreakdown, 'total'>, number> = {
  target: 0.35,
  intent: 0.15,
  entity: 0.1,
  context: 0.1,
  sequence: 0.2,
  effect: 0.1,
};
/** Rien ne permet de juger cette dimension. */
const NEUTRAL = 0.5;
/** Un libellé quasi identique : la cible n'a pas changé, sa forme technique si. */
const SAME_LABEL = 0.95;
/** Seules ces intentions attendues peuvent avoir changé de forme (jamais un champ, une vérification). */
const GESTURES = new Set<FlowIntent['type']>(['CLICK', 'SUBMIT', 'NAVIGATE']);

export function reconcileSemantically(
  unmatched: readonly FlowIntent[],
  inserted: readonly ObservedStep[],
  intents: readonly FlowIntent[],
  observed: ObservedFlowGraph,
  findings: readonly IntentFinding[],
  options: SemanticPairingOptions = {},
): SemanticReconciliationResult {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const margin = options.ambiguityMargin ?? DEFAULT_MARGIN;
  const context = new PairingContext(intents, observed, findings, options.synonyms);
  const scored: { intent: FlowIntent; step: ObservedStep; score: PairingBreakdown; why: string[] }[] = [];
  for (const intent of unmatched) {
    if (!GESTURES.has(intent.type) || (intent.type === 'NAVIGATE' && intent.label.startsWith('/'))) continue;
    for (const step of inserted) {
      const scoredPair = context.score(intent, step);
      if (scoredPair && scoredPair.score.total >= minScore) scored.push({ intent, step, ...scoredPair });
    }
  }
  scored.sort((a, b) => b.score.total - a.score.total);

  const pairs: SemanticPair[] = [];
  const duplicates: DuplicateCandidates[] = [];
  const usedIntents = new Set<string>();
  const usedSteps = new Set<string>();
  for (const best of scored) {
    if (usedIntents.has(best.intent.id) || usedSteps.has(best.step.id)) continue;
    const rivals = scored.filter(
      (candidate) =>
        candidate.intent.id === best.intent.id &&
        candidate.step.id !== best.step.id &&
        !usedSteps.has(candidate.step.id),
    );
    const candidates: PairingCandidate[] = [best, ...rivals].map((candidate) => ({
      stepId: candidate.step.id,
      label: candidate.step.label,
      score: candidate.score,
    }));
    const tie = rivals.find((rival) => best.score.total - rival.score.total < margin);
    usedIntents.add(best.intent.id);
    if (tie) {
      duplicates.push({
        intent: best.intent,
        candidates,
        reasons: [
          `DUPLICATE_CANDIDATE: "${best.step.label}" (${fmt(best.score.total)}) and "${tie.step.label}" (${fmt(tie.score.total)}) are as plausible counterparts — nothing chosen arbitrarily`,
          ...best.why,
        ],
      });
      continue;
    }
    usedSteps.add(best.step.id);
    const status = context.statusOf(best.intent, best.step, best.score);
    pairs.push({
      intent: best.intent,
      observed: best.step,
      status,
      score: best.score,
      candidates,
      reasons: [
        `${status}: expected "${context.displayLabel(best.intent)}" and observed "${best.step.label}" are the same functional event (pairing score ${fmt(best.score.total)})`,
        ...best.why,
        ...(rivals.length > 0
          ? [
              `other candidate(s) considered: ${rivals.map((rival) => `"${rival.step.label}" (${fmt(rival.score.total)})`).join(', ')}`,
            ]
          : []),
      ],
    });
  }
  return { pairs, duplicates };
}

/** Le détail d'un score, pour les raisons. */
export function describePairing(score: PairingBreakdown): string {
  return `target ${fmt(score.target)} · intent ${fmt(score.intent)} · entity ${fmt(score.entity)} · context ${fmt(score.context)} · sequence ${fmt(score.sequence)} · effect ${fmt(score.effect)}`;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

class PairingContext {
  private readonly stepIndex = new Map<string, number>();
  private readonly matchedStepOf = new Map<string, ObservedStep>();
  private readonly stateUrl = new Map<string, string>();
  private readonly stateLabel = new Map<string, string>();
  private readonly byIndex = new Map<number, FlowIntent>();

  constructor(
    intents: readonly FlowIntent[],
    private readonly observed: ObservedFlowGraph,
    findings: readonly IntentFinding[],
    private readonly synonyms?: (term: string) => readonly string[],
  ) {
    observed.steps.forEach((step, index) => this.stepIndex.set(step.id, index));
    for (const state of observed.states) {
      this.stateUrl.set(state.id, state.url);
      this.stateLabel.set(state.id, state.label);
    }
    for (const intent of intents) this.byIndex.set(intent.index, intent);
    for (const finding of findings) {
      if (finding.outcome !== 'MATCHED' || !finding.observedStepId) continue;
      const step = observed.steps.find((candidate) => candidate.id === finding.observedStepId);
      if (step) this.matchedStepOf.set(finding.intentId, step);
    }
  }

  /** Le libellé lisible de l'attendue : son nom quand la cible est un sélecteur technique. */
  displayLabel(intent: FlowIntent): string {
    const technical = technicalTarget(intent.step);
    return technical && intent.step.name ? intent.step.name : intent.label;
  }

  score(intent: FlowIntent, step: ObservedStep): { score: PairingBreakdown; why: string[] } | undefined {
    const why: string[] = [];
    const expectedLabels = [intent.label, ...(intent.step.name ? [intent.step.name] : [])];
    // Contradiction : l'observée dit l'abandon, l'attendue non → jamais appariées.
    if (saysCancel(step.label) && !expectedLabels.some(saysCancel)) return undefined;

    const target = Math.max(
      ...expectedLabels.map((label) => labelSimilarity(label, step.label, this.synonyms)),
    );
    why.push(
      target >= SAME_LABEL
        ? `target: same label "${step.label}"`
        : `target: label similarity ${fmt(target)} ("${this.displayLabel(intent)}" ~ "${step.label}")`,
    );

    const { score: intentScore, why: intentWhy } = this.intentScore(intent, step, expectedLabels);
    why.push(intentWhy);
    const { score: entity, why: entityWhy } = this.entityScore(intent, step);
    why.push(entityWhy);
    const { score: context, why: contextWhy } = this.contextScore(intent, step);
    why.push(contextWhy);
    const { score: sequence, why: sequenceWhy } = this.sequenceScore(intent, step);
    why.push(sequenceWhy);
    const { score: effect, why: effectWhy } = this.effectScore(intent, step);
    why.push(effectWhy);

    const parts = { target, intent: intentScore, entity, context, sequence, effect };
    const total = round(
      (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
        (sum, key) => sum + WEIGHTS[key] * parts[key],
        0,
      ),
    );
    return { score: { ...parts, total }, why };
  }

  /** Le statut d'une paire retenue : comment l'événement a changé de forme. */
  statusOf(intent: FlowIntent, step: ObservedStep, score: PairingBreakdown): SemanticPair['status'] {
    if (this.insertedBetween(intent, step) > 0) return 'MATCHED_AFTER_INSERTION';
    if (score.context < NEUTRAL) return 'MATCHED_WITH_CONTEXT_CHANGE';
    if (score.target >= SAME_LABEL) return 'MATCHED_WITH_TARGET_CHANGE';
    return 'MATCHED_SEMANTICALLY';
  }

  private intentScore(
    intent: FlowIntent,
    step: ObservedStep,
    expectedLabels: readonly string[],
  ): { score: number; why: string } {
    const sameType = intent.type === step.type;
    let score = sameType ? 0.8 : 0.5;
    const declared = intent.step.functionalIntent?.ui;
    const expectedUi = new Set([
      ...(declared ? [declared] : []),
      ...expectedLabels.flatMap((label) => uiIntentsOfLabel(label)),
    ]);
    const observedUi = new Set(uiIntentsOfLabel(step.label));
    const common = [...expectedUi].filter((ui) => observedUi.has(ui));
    if (common.length > 0) score = 1;
    else if (expectedUi.size > 0 && observedUi.size > 0) score = Math.min(score, 0.3);
    return {
      score,
      why: `intent: ${sameType ? `same gesture ${intent.type}` : `${intent.type} vs ${step.type}`}${
        common.length > 0
          ? `, both say ${common.join('/')}`
          : expectedUi.size > 0 && observedUi.size > 0
            ? `, different UI intents (${[...expectedUi].join('/')} vs ${[...observedUi].join('/')})`
            : ''
      }`,
    };
  }

  private entityScore(intent: FlowIntent, step: ObservedStep): { score: number; why: string } {
    const functional = intent.step.functionalIntent;
    const words = new Set(
      [functional?.entity, functional?.operation, functional?.name]
        .filter((value): value is string => typeof value === 'string')
        .flatMap((value) => tokensOf(value.replace(/[_-]/g, ' '))),
    );
    if (words.size === 0)
      return { score: NEUTRAL, why: 'entity: no functional intent declared on the expected step' };
    const observedWords = new Set(tokensOf(step.label));
    const hits = [...words].filter((word) => observedWords.has(word));
    const score = hits.length === 0 ? 0.2 : Math.min(1, 0.6 + 0.4 * (hits.length / words.size));
    return {
      score,
      why:
        hits.length > 0
          ? `entity: the observed label says ${hits.join(', ')} (functional intent ${functional?.name ?? ''})`
          : `entity: the observed label says nothing of ${[...words].join(', ')}`,
    };
  }

  /** L'observée part-elle de l'écran où l'attendue était cherchée (celui atteint par l'étape précédente) ? */
  private contextScore(intent: FlowIntent, step: ObservedStep): { score: number; why: string } {
    const previous = this.previousMatched(intent);
    let score = NEUTRAL;
    let why = 'context: the screen where the expected step was looked for is unknown';
    if (previous) {
      if (previous.to === step.from) {
        score = 1;
        why = `context: same screen "${this.stateLabel.get(step.from) ?? step.from}"`;
      } else {
        score = 0.2;
        why = `context: observed on "${this.stateLabel.get(step.from) ?? step.from}", expected on "${this.stateLabel.get(previous.to) ?? previous.to}"`;
      }
    }
    const route = intent.step.functionalIntent?.context?.route;
    const url = this.stateUrl.get(step.from);
    if (route && url) {
      if (url.includes(route)) {
        score = Math.max(score, 0.8);
        why += `; route ${route} matches`;
      } else {
        score = Math.min(score, 0.3);
        why += `; route ${route} not matched by ${url}`;
      }
    }
    return { score, why };
  }

  /** L'action précédente et l'action suivante de l'attendue encadrent-elles l'observée ? */
  private sequenceScore(intent: FlowIntent, step: ObservedStep): { score: number; why: string } {
    const position = this.stepIndex.get(step.id) ?? -1;
    const previous = this.previousMatched(intent);
    const next = this.nextMatched(intent);
    const before = previous ? this.stepIndex.get(previous.id) : undefined;
    const after = next ? this.stepIndex.get(next.id) : undefined;
    const side = (neighbour: number | undefined, expectedGap: number): number => {
      if (neighbour === undefined) return NEUTRAL;
      const gap = expectedGap > 0 ? position - neighbour : neighbour - position;
      if (gap === 1) return 1;
      if (gap > 1) return Math.max(0.4, 0.9 - 0.15 * (gap - 1));
      return 0.1;
    };
    const left = side(before, 1);
    const right = side(after, -1);
    const score = round((left + right) / 2);
    const describe = (value: number, label: string): string =>
      value === NEUTRAL ? `${label} unknown` : value === 1 ? `${label} adjacent` : `${label} ${fmt(value)}`;
    return {
      score,
      why: `sequence: ${describe(left, 'previous action')}, ${describe(right, 'next action')}`,
    };
  }

  /** L'écran ou la route atteints par l'observée sont-ils ceux que l'attendue annonce ? */
  private effectScore(intent: FlowIntent, step: ObservedStep): { score: number; why: string } {
    const route = intent.step.effects?.route;
    const url = this.stateUrl.get(step.to);
    const reached = this.stateLabel.get(step.to) ?? step.to;
    if (route && url)
      return url.includes(route)
        ? { score: 1, why: `effect: route ${route} reached` }
        : { score: 0.1, why: `effect: route ${route} expected, ${url} reached` };
    if (intent.type === 'NAVIGATE')
      return slug(reached) === intent.semanticTarget
        ? { score: 1, why: `effect: screen "${reached}" reached` }
        : { score: 0.3, why: `effect: screen "${reached}" reached, "${intent.label}" expected` };
    return { score: NEUTRAL, why: 'effect: no expected effect declared' };
  }

  /** Nombre d'étapes observées insérées entre l'étape précédente retrouvée et l'observée. */
  private insertedBetween(intent: FlowIntent, step: ObservedStep): number {
    const previous = this.previousMatched(intent);
    const position = this.stepIndex.get(step.id);
    if (!previous || position === undefined) return 0;
    const before = this.stepIndex.get(previous.id);
    if (before === undefined || position <= before) return 0;
    return this.observed.steps.slice(before + 1, position).filter((between) => between.origin === 'GUIDED')
      .length;
  }

  private previousMatched(intent: FlowIntent): ObservedStep | undefined {
    for (let index = intent.index - 1; index >= 1; index -= 1) {
      const candidate = this.byIndex.get(index);
      const step = candidate ? this.matchedStepOf.get(candidate.id) : undefined;
      if (step) return step;
    }
    return undefined;
  }

  private nextMatched(intent: FlowIntent): ObservedStep | undefined {
    for (let index = intent.index + 1; this.byIndex.has(index); index += 1) {
      const candidate = this.byIndex.get(index);
      const step = candidate ? this.matchedStepOf.get(candidate.id) : undefined;
      if (step) return step;
    }
    return undefined;
  }
}

/** Une cible technique (sélecteur) : son texte ne dit rien de ce que l'utilisateur voit. */
function technicalTarget(step: FlowStep): boolean {
  if (!('target' in step)) return false;
  return step.target.strategy === 'css' || step.target.strategy === 'testId';
}
