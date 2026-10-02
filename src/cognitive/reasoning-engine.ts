import { normalize as normalizeControl } from '../flows/action-effect-verifier.js';
import type { SafetyClass } from './active-learning.js';
import type { BusinessSituation, FunctionalState } from './business-state-engine.js';
import type { CausalLink } from './causal-graph.js';
import type { KnowledgeContradiction } from './contradictions.js';
import type { EvidenceReference } from './evidence.js';
import type { CoverageGap } from './functional-coverage.js';
import type { CandidateAction, PreconditionResolution } from './goal-graph.js';
import type { Hypothesis } from './hypothesis-engine.js';
import type { ExecutionPlan } from './planning.js';

/** Une action disponible à l'écran, déjà jugée par la SafetyPolicy (le moteur ne la contourne jamais). */
export interface ScreenAction {
  key: string;
  kind: 'click' | 'check' | 'fill' | 'select';
  label: string;
  role?: string;
  safety: SafetyClass;
  /** La SafetyPolicy l'autorise dans ce contexte (allow d'un flow, mission). */
  allowed: boolean;
  /** Déjà exécutée sur cet écran (répétition). */
  executed?: number;
  /** Échecs passés (instabilité). */
  failures?: number;
  /** Jamais vue avant (nouveauté). */
  novel?: boolean;
  /** Succès historique (0..1) d'après la KnowledgeBase. */
  historicalSuccess?: number;
  /** Le code source relie ce contrôle à un composant attendu. */
  staticEvidence?: boolean;
}

export type DecisionReason = 'GOAL' | 'COVERAGE' | 'HYPOTHESIS' | 'RECOVERY' | 'CONTRADICTION' | 'INVARIANT';
export type ReasonCode =
  | 'PLAN_NEXT_STEP'
  | 'GOAL_PRECONDITION'
  | 'NEXT_FIELDS_DEPEND_ON_TARGET'
  | 'SEMANTIC_MATCH'
  | 'STATIC_COMPONENT_MATCH'
  | 'RUNTIME_TARGET_EXISTS'
  | 'HISTORICAL_SUCCESS'
  | 'COVERAGE_GAP'
  | 'HYPOTHESIS_TEST'
  | 'SAFE_ACTION';
export type RejectionCode =
  | 'UNSAFE'
  | 'MUTATION_NOT_REQUIRED'
  | 'DIFFERENT_INTENT'
  | 'WEAK_RELATIONSHIP'
  | 'NO_EXPECTED_GOAL_EVIDENCE'
  | 'REPETITION'
  | 'LOWER_UTILITY';

/** DECISION UTILITY (§22) : un seul endroit, chaque terme visible. La sécurité n'en fait PAS partie. */
export interface UtilityTerms {
  goalProgress: number;
  functionalCoverageGain: number;
  novelty: number;
  informationGain: number;
  businessImportance: number;
  expectedKnowledgeGain: number;
  historicalSuccess: number;
  runtimeEvidence: number;
  repetition: number;
  instability: number;
  ambiguity: number;
  actionCost: number;
  recoveryCost: number;
}

export function decisionUtility(terms: UtilityTerms): number {
  const value =
    terms.goalProgress +
    terms.functionalCoverageGain +
    terms.novelty +
    terms.informationGain +
    terms.businessImportance +
    terms.expectedKnowledgeGain +
    terms.historicalSuccess +
    terms.runtimeEvidence -
    terms.repetition -
    terms.instability -
    terms.ambiguity -
    terms.actionCost -
    terms.recoveryCost;
  return Math.round(value * 1000) / 1000;
}

export interface QAReasoningContext {
  mission?: string;
  currentState?: FunctionalState;
  businessState?: BusinessSituation;
  /** Le but visé et ce qui le bloque (PreconditionResolver). */
  goal?: string;
  preconditions?: PreconditionResolution;
  currentPlan?: ExecutionPlan;
  /** Index de la prochaine étape du plan courant. */
  planPosition?: number;
  availableActions: ScreenAction[];
  hypotheses: Hypothesis[];
  causal: CausalLink[];
  coverageGaps: CoverageGap[];
  contradictions: KnowledgeContradiction[];
  /** Les champs que la suite du parcours va remplir (preuve d'intention). */
  nextFields?: string[];
  budgets: { maxCandidates: number; maxReasoningDurationMs: number };
  now?: () => number;
}

export interface RejectedAlternative {
  action: string;
  utility: number;
  reasons: RejectionCode[];
}

export interface QAReasoningDecision {
  id: string;
  path: 'FAST' | 'DEEP';
  status: 'DECIDED' | 'NO_SAFE_ACTION' | 'REASONING_BUDGET_EXHAUSTED' | 'INCONCLUSIVE';
  goal?: string;
  reason?: DecisionReason;
  selectedAction?: ScreenAction;
  intent?: string;
  expectedEffects: string[];
  evidence: EvidenceReference[];
  confidence: number;
  utility?: UtilityTerms & { total: number };
  why: ReasonCode[];
  alternatives: RejectedAlternative[];
  checkpointTarget?: string;
  /** Hypothèses sur lesquelles la décision repose sans les avoir prouvées. */
  assumptions: string[];
  /** Ce qui a été observé ensuite (rempli après l'action). */
  outcome?: { confirmed: boolean; observed: string[] };
}

const sameLabel = (a: string, b: string): boolean => normalizeControl(a) === normalizeControl(b);
const words = (text: string): Set<string> =>
  new Set(
    normalizeControl(text)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
const overlaps = (a: string, b: string): boolean => [...words(a)].some((word) => words(b).has(word));

/**
 * QA REASONING ENGINE : il ne clique pas, n'appelle pas Playwright, ne contourne pas la
 * SafetyPolicy et n'écrit pas dans la KnowledgeBase. Il produit une DÉCISION explicable :
 *
 *   FAST PATH   état connu, plan connu, l'étape suivante est à l'écran → exécution déterministe
 *   DEEP PATH   divergence, état inconnu, couverture, hypothèse à tester → utilité centralisée
 *
 * Toute décision a une raison (GOAL, COVERAGE, HYPOTHESIS, RECOVERY, CONTRADICTION, INVARIANT),
 * ses preuves, ses hypothèses non prouvées, et les alternatives écartées avec leur WHY NOT.
 */
export class QAReasoningEngine {
  private next = 1;
  readonly trace: QAReasoningDecision[] = [];

  decide(context: QAReasoningContext): QAReasoningDecision {
    const now = context.now ?? (() => Date.now());
    const started = now();
    const id = `D-${String(this.next)}`;
    this.next += 1;
    const evidence = context.businessState?.evidence.slice(0, 5) ?? [];
    const allowed = context.availableActions.filter((action) => action.allowed && action.safety === 'SAFE');
    const unsafe = context.availableActions.filter((action) => !(action.allowed && action.safety === 'SAFE'));

    // FAST PATH : la prochaine étape du plan est là, et sûre.
    const step = context.currentPlan?.steps[context.planPosition ?? 0];
    if (step && context.currentPlan && context.currentPlan.confidence >= 0.8) {
      const match = context.availableActions.find(
        (action) =>
          sameLabel(action.label, step.label) && (!step.role || !action.role || action.role === step.role),
      );
      if (match && match.allowed && (match.safety === 'SAFE' || step.writes)) {
        return this.record({
          id,
          path: 'FAST',
          status: 'DECIDED',
          goal: step.intent,
          reason: 'GOAL',
          selectedAction: match,
          intent: step.intent,
          expectedEffects: step.expectedEffects,
          evidence,
          confidence: context.currentPlan.confidence,
          why: [
            'PLAN_NEXT_STEP',
            'RUNTIME_TARGET_EXISTS',
            ...(match.safety === 'SAFE' ? (['SAFE_ACTION'] as const) : []),
          ],
          alternatives: [],
          assumptions: context.currentPlan.assumptions.map((assumption) => assumption.hypothesis),
          ...(context.currentPlan.checkpoints[0]
            ? { checkpointTarget: context.currentPlan.checkpoints[0] }
            : {}),
        });
      }
    }

    // DEEP PATH : utilité centralisée, raison obligatoire.
    const actionable = context.preconditions?.candidateActions ?? [];
    const gaps = context.coverageGaps;
    const testable = context.hypotheses.filter(
      (hypothesis) => hypothesis.status === 'HYPOTHESIS' || hypothesis.status === 'SUPPORTED',
    );
    const scored: {
      action: ScreenAction;
      terms: UtilityTerms;
      why: ReasonCode[];
      reason?: DecisionReason;
      goal?: string;
      assumptions: string[];
      effects: string[];
    }[] = [];
    for (const action of context.availableActions.slice(0, context.budgets.maxCandidates)) {
      if (now() - started > context.budgets.maxReasoningDurationMs)
        return this.record({
          id,
          path: 'DEEP',
          status: 'REASONING_BUDGET_EXHAUSTED',
          expectedEffects: [],
          evidence,
          confidence: 0,
          why: [],
          alternatives: [],
          assumptions: [],
        });
      const why: ReasonCode[] = [];
      const assumptions: string[] = [];
      const effects: string[] = [];
      let reason: DecisionReason | undefined;
      let goal: string | undefined;
      // GOAL : réalise une précondition manquante (directement, ou d'après une relation causale).
      const precondition = actionable.find((candidate: CandidateAction) =>
        sameLabel(candidate.label, action.label),
      );
      let goalProgress = 0;
      if (precondition) {
        goalProgress = 1;
        why.push('GOAL_PRECONDITION');
        reason = 'GOAL';
        goal =
          context.preconditions?.missingPreconditions.find((node) => node.achievedBy.includes(precondition))
            ?.id ?? context.goal;
        if (precondition.hypothesis) {
          if (precondition.hypothesis.status !== 'RUNTIME_CONFIRMED')
            assumptions.push(precondition.hypothesis.id);
          goalProgress *= Math.max(0.4, precondition.hypothesis.confidence);
        }
      }
      // La suite du parcours remplit des champs que cette action révèle (preuve d'intention + causalité).
      const reveals = context.causal.filter(
        (link) =>
          link.cause.endsWith(` ${normalizeControl(action.label)}`) &&
          link.relation === 'REVEALS' &&
          link.hypothesis.status !== 'REJECTED',
      );
      const feedsNext = reveals.filter((link) =>
        (context.nextFields ?? []).some((field) => link.effect.endsWith(`:${normalizeControl(field)}`)),
      );
      if (feedsNext.length > 0) {
        why.push('NEXT_FIELDS_DEPEND_ON_TARGET');
        goalProgress = Math.max(
          goalProgress,
          0.8 * Math.max(...feedsNext.map((link) => link.hypothesis.confidence)),
        );
        reason ??= 'GOAL';
        for (const link of feedsNext) {
          effects.push(`${link.effect} visible`);
          if (link.hypothesis.status !== 'RUNTIME_CONFIRMED') assumptions.push(link.hypothesis.id);
        }
      }
      if (context.goal && overlaps(action.label, context.goal)) why.push('SEMANTIC_MATCH');
      if (action.staticEvidence) why.push('STATIC_COMPONENT_MATCH');
      // COVERAGE : un trou de couverture que cette action peut combler.
      const gap = gaps.find(
        (candidate) =>
          overlaps(candidate.item.label, action.label) || overlaps(candidate.item.group, action.label),
      );
      if (gap) {
        why.push('COVERAGE_GAP');
        reason ??= 'COVERAGE';
        goal ??= gap.item.id;
      }
      // HYPOTHESIS : une hypothèse dont cette action est la cause à tester.
      const hypothesis = testable.find((candidate) =>
        candidate.proposition.subject.endsWith(` ${normalizeControl(action.label)}`),
      );
      if (hypothesis) {
        why.push('HYPOTHESIS_TEST');
        reason ??= 'HYPOTHESIS';
        goal ??= hypothesis.id;
      }
      // CONTRADICTION : une propriété contestée que cette action permet de réobserver.
      if (context.contradictions.some((contradiction) => overlaps(contradiction.property, action.label)))
        reason ??= 'CONTRADICTION';
      if ((action.historicalSuccess ?? 0) > 0.5) why.push('HISTORICAL_SUCCESS');
      why.push('RUNTIME_TARGET_EXISTS');
      if (action.safety === 'SAFE') why.push('SAFE_ACTION');
      const terms: UtilityTerms = {
        goalProgress,
        functionalCoverageGain: gap ? 0.6 * gap.item.importance : 0,
        novelty: action.novel ? 0.2 : 0,
        informationGain: hypothesis ? 0.4 * (1 - hypothesis.confidence) : 0,
        businessImportance: gap ? 0.2 * gap.item.importance : precondition ? 0.3 : 0,
        expectedKnowledgeGain:
          reveals.length > 0 && reveals.every((link) => link.hypothesis.status !== 'RUNTIME_CONFIRMED')
            ? 0.2
            : 0,
        historicalSuccess: 0.2 * (action.historicalSuccess ?? 0),
        runtimeEvidence: 0.1,
        repetition: 0.3 * Math.min(3, action.executed ?? 0),
        instability: 0.2 * Math.min(3, action.failures ?? 0),
        ambiguity: 0,
        actionCost: 0.05,
        recoveryCost: action.kind === 'check' || action.role === 'tab' ? 0 : 0.05,
      };
      scored.push({
        action,
        terms,
        why,
        ...(reason ? { reason } : {}),
        ...(goal ? { goal } : {}),
        assumptions,
        effects,
      });
    }
    const candidates = scored
      .filter((entry) => allowed.includes(entry.action) && entry.reason !== undefined)
      .sort((a, b) => decisionUtility(b.terms) - decisionUtility(a.terms));
    // AMBIGUITÉ : deux candidats aussi utiles, sans preuve qui les départage.
    const [best, second] = candidates;
    if (
      best &&
      second &&
      Math.abs(decisionUtility(best.terms) - decisionUtility(second.terms)) < 0.02 &&
      best.why.join() === second.why.join()
    )
      best.terms.ambiguity = 0.1;
    const alternatives: RejectedAlternative[] = [
      ...unsafe.map((action) => ({
        action: `${action.kind} "${action.label}"`,
        utility: decisionUtility(scored.find((entry) => entry.action === action)?.terms ?? zeroTerms()),
        reasons: [
          action.safety === 'MUTATION' && !action.allowed
            ? ('MUTATION_NOT_REQUIRED' as const)
            : ('UNSAFE' as const),
        ],
      })),
      ...scored
        .filter((entry) => entry !== best && allowed.includes(entry.action))
        .map((entry) => ({
          action: `${entry.action.kind} "${entry.action.label}"`,
          utility: decisionUtility(entry.terms),
          reasons: rejectionsOf(entry, best),
        })),
    ].slice(0, 8);
    if (!best)
      return this.record({
        id,
        path: 'DEEP',
        status: allowed.length === 0 ? 'NO_SAFE_ACTION' : 'INCONCLUSIVE',
        expectedEffects: [],
        evidence,
        confidence: 0,
        why: [],
        alternatives,
        assumptions: [],
      });
    const total = decisionUtility(best.terms);
    return this.record({
      id,
      path: 'DEEP',
      status: 'DECIDED',
      ...(best.goal ? { goal: best.goal } : {}),
      ...(best.reason ? { reason: best.reason } : {}),
      selectedAction: best.action,
      intent: best.goal ?? best.reason ?? 'EXPLORE',
      expectedEffects: best.effects,
      evidence,
      confidence: Math.round(Math.max(0, Math.min(0.95, total / 2)) * 100) / 100,
      utility: { ...best.terms, total },
      why: [...new Set(best.why)],
      alternatives,
      assumptions: [...new Set(best.assumptions)],
      ...(context.preconditions?.missingPreconditions[0]
        ? { checkpointTarget: context.goal ?? context.preconditions.goal }
        : {}),
    });
  }

  /** Ce qui a été observé après l'action décidée : confirmé ou non (trace vérifiable). */
  recordOutcome(id: string, confirmed: boolean, observed: string[]): void {
    const decision = this.trace.find((candidate) => candidate.id === id);
    if (decision) decision.outcome = { confirmed, observed: observed.slice(0, 8) };
  }

  private record(decision: QAReasoningDecision): QAReasoningDecision {
    this.trace.push(decision);
    if (this.trace.length > 500) this.trace.shift();
    return decision;
  }
}

function zeroTerms(): UtilityTerms {
  return {
    goalProgress: 0,
    functionalCoverageGain: 0,
    novelty: 0,
    informationGain: 0,
    businessImportance: 0,
    expectedKnowledgeGain: 0,
    historicalSuccess: 0,
    runtimeEvidence: 0,
    repetition: 0,
    instability: 0,
    ambiguity: 0,
    actionCost: 0,
    recoveryCost: 0,
  };
}

function rejectionsOf(
  entry: { terms: UtilityTerms; why: ReasonCode[]; reason?: DecisionReason },
  best: { terms: UtilityTerms; reason?: DecisionReason } | undefined,
): RejectionCode[] {
  const reasons: RejectionCode[] = [];
  if (!entry.reason) reasons.push('NO_EXPECTED_GOAL_EVIDENCE');
  else if (best?.reason && entry.reason !== best.reason) reasons.push('DIFFERENT_INTENT');
  if (entry.terms.goalProgress === 0 && entry.why.includes('SEMANTIC_MATCH'))
    reasons.push('WEAK_RELATIONSHIP');
  if (entry.terms.repetition > 0) reasons.push('REPETITION');
  reasons.push('LOWER_UTILITY');
  return reasons;
}

/**
 * L'explication d'une décision, en phrases (§125) : où l'on en est, ce qui bloque, ce que l'on
 * suppose, pourquoi cette action, ce que l'on vérifiera — sans « chaîne de pensée » libre.
 */
export function narrate(decision: QAReasoningDecision, context: QAReasoningContext): string[] {
  const situation = context.businessState;
  const lines: string[] = [];
  if (context.mission) lines.push(`Mission: ${context.mission}.`);
  if (situation?.phase) lines.push(`Current functional phase: ${situation.phase}.`);
  if (decision.goal) lines.push(`Goal: ${decision.goal}.`);
  if (situation?.submission === 'BLOCKED')
    lines.push(`Submission is blocked; missing: ${situation.missing.join(', ') || 'unknown'}.`);
  const chain = context.preconditions?.chains[0];
  if (chain) lines.push(`Missing condition chain: ${chain.join(' ← ')}.`);
  if (decision.selectedAction)
    lines.push(
      `Selected: ${decision.selectedAction.kind} "${decision.selectedAction.label}" (${decision.path} path, reason ${decision.reason ?? '-'}) because ${decision.why.join(', ')}.`,
    );
  if (decision.assumptions.length > 0)
    lines.push(
      `This relies on unconfirmed hypotheses (${decision.assumptions.join(', ')}): a supported hypothesis, not a confirmed rule.`,
    );
  if (decision.selectedAction) lines.push(`The action is ${decision.selectedAction.safety}.`);
  if (decision.expectedEffects.length > 0)
    lines.push(
      `Expected: ${decision.expectedEffects.join(', ')}. If observed, the hypothesis is strengthened; if not, contradicting evidence is recorded and the plan is revised.`,
    );
  for (const alternative of decision.alternatives.slice(0, 3))
    lines.push(`Rejected ${alternative.action}: ${alternative.reasons.join(', ')}.`);
  if (decision.status !== 'DECIDED') lines.push(`No decision: ${decision.status}.`);
  return lines;
}
