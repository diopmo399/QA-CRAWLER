import type { CoverageTracker } from '../coverage/coverage-map.js';
import { areaOf } from '../coverage/coverage-map.js';
import type { NoveltyScore } from '../exploration/novelty-detector.js';
import type { GoalTracker } from '../goals/goal-tracker.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { KnowledgeBase } from '../knowledge/knowledge-model.js';
import { actionSignature, stateSignature } from '../knowledge/signatures.js';
import { actionLabel, type DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { patternInterest } from '../patterns/pattern-rules.js';
import type { DetectedPattern } from '../patterns/ui-pattern.js';
import type { PatternRuleHints } from '../semantics/domain-packs.js';
import type { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { ActionScore, ActionScorer, ScoringMission } from './action-scorer.js';
import { breakdownOf, type ScoreBreakdown, type ScoreReason } from './score-breakdown.js';

/** Poids des composantes (exploration.*Weight) ; déterministes. */
export interface ExplorationWeights {
  goalWeight: number;
  patternWeight: number;
  noveltyWeight: number;
  coverageWeight: number;
  historyWeight: number;
}

/** Ce que le scorer V2 sait en plus de l'état et du graphe. Tout est facultatif. */
export interface ScoringSignals {
  dictionary: SemanticDictionary;
  weights: ExplorationWeights;
  patternsOf(stateId: string): readonly DetectedPattern[];
  patternHints?: PatternRuleHints;
  goals?: GoalTracker;
  /** Les objectifs du moment, quand ils sont planifiés après la création du scorer. */
  currentGoals?(): GoalTracker | undefined;
  knowledge?: KnowledgeBase;
  coverage?: CoverageTracker;
  noveltyOf?(stateId: string): NoveltyScore | undefined;
  /** Pénalité de boucle (StuckDetector) pour cette action sur cet état. */
  loopPenaltyOf?(stateId: string, actionId: string): { points: number; detail: string } | undefined;
  /** Version de l'application (commit, appVersion) : une nouvelle version donne une nouvelle chance. */
  version?: string;
}

/** Le score d'une action, avec sa décomposition. */
export type ScoredActionV2 = ActionScore & { breakdown: ScoreBreakdown };

/**
 * ActionScorer V2 :
 *
 *   base (le scorer historique : nouvel écran, mots-clés, menu, export…)
 *   + objectif (GoalTracker)      + motif (règles centralisées)   + nouveauté
 *   + historique (KnowledgeBase)  + gain de couverture
 *   − risque                      − répétition (boucles, déjà utilisée) − échecs passés
 *
 * Chaque point a sa raison (ScoreBreakdown) : aucune décision opaque. Les exclusions
 * du scorer de base (déjà essayée, bloquée, désactivée…) restent des exclusions ; une
 * règle de motif BLOCK en ajoute une.
 */
export class AdvancedActionScorer implements ActionScorer {
  constructor(
    private readonly base: ActionScorer,
    private readonly signals: ScoringSignals,
  ) {}

  score(
    action: DiscoveredAction,
    context: PageContext,
    graph: FlowGraph,
    mission: ScoringMission,
  ): ScoredActionV2 {
    const base = this.base.score(action, context, graph, mission);
    const details: ScoreReason[] = [];
    const add = (reason: ScoreReason): void => {
      if (reason.points !== 0) details.push({ ...reason, points: Math.round(reason.points) });
    };
    add({ factor: 'base', points: base.score, code: 'base', params: { detail: shortReasons(base.reasons) } });
    if (base.excluded !== undefined) return { ...base, breakdown: breakdownOf(details) };
    const { weights, knowledge, coverage } = this.signals;
    const signature = actionSignature(action);

    // ---- objectif
    const goal = (this.signals.currentGoals?.() ?? this.signals.goals)?.relevance(action, context);
    if (goal)
      add({
        factor: 'goal',
        points: weights.goalWeight * 70 * goal.weight,
        code: 'goal-relevance',
        params: {
          goal: goal.description,
          kind: goal.kind,
          ...(goal.subject !== undefined ? { subject: goal.subject } : {}),
          ...(goal.concept !== undefined ? { concept: goal.concept } : {}),
        },
      });

    // ---- motif de l'écran
    const interest = patternInterest(
      action,
      this.signals.patternsOf(context.stateId),
      this.signals.dictionary,
      this.signals.patternHints,
    );
    if (interest.blocked)
      return {
        ...base,
        excluded: `pattern ${interest.blocked.pattern}: ${interest.blocked.rule} is never tried`,
        breakdown: breakdownOf(details),
      };
    for (const rule of interest.reasons)
      add({
        factor: 'pattern',
        points: weights.patternWeight * rule.points,
        code: 'pattern-rule',
        params: { pattern: rule.pattern, rule: rule.rule },
      });

    // ---- nouveauté
    const history = knowledge?.getActionKnowledge(signature);
    const usedThisRun = coverage?.timesExecuted(signature) ?? 0;
    if (usedThisRun === 0 && (history?.executionCount ?? 0) === 0)
      add({ factor: 'novelty', points: weights.noveltyWeight * 40, code: 'never-explored' });
    const expectation = knowledge?.expectationFor(stateSignature(context.stateLabel), signature);
    if (expectation && !graph.allNodes().some((node) => stateSignature(node.label) === expectation.target))
      add({
        factor: 'novelty',
        points: weights.noveltyWeight * 30,
        code: 'likely-new-state',
        params: { target: expectation.target },
      });
    const hint = knowledge?.hintFor(actionLabel(action));
    const seen: ReadonlySet<string> = coverage?.seenPatterns() ?? new Set();
    if (hint && !seen.has(hint.pattern))
      add({
        factor: 'novelty',
        points: weights.noveltyWeight * 20,
        code: 'learned-hint',
        params: { pattern: hint.pattern, count: hint.count, total: hint.total },
      });
    const novelty = this.signals.noveltyOf?.(context.stateId);
    if (novelty && novelty.score > 0)
      add({
        factor: 'novelty',
        points: weights.noveltyWeight * novelty.score * 0.3,
        code: 'novel-screen',
        params: { detail: novelty.reasons.join(', ') },
      });

    // ---- historique : succès passés, échecs répétés (par version de l'application)
    if (history && history.executionCount > 0) {
      const success = history.weightedSuccess ?? history.successCount;
      const failure = history.weightedFailure ?? history.failureCount;
      const rate = success + failure > 0 ? success / (success + failure) : 0;
      if (rate > 0)
        add({
          factor: 'history',
          points: weights.historyWeight * 20 * rate,
          code: 'historical-success',
          params: { rate: Math.round(rate * 100) },
        });
      const failures = history.failuresOnVersion ?? 0;
      if (failures >= 2) {
        const sameVersion =
          (history.failureVersion ?? 'unversioned') === (this.signals.version ?? 'unversioned');
        const penalty = Math.min(160, 20 * failures) * (sameVersion ? 1 : 0.25);
        add({
          factor: 'history',
          points: -weights.historyWeight * penalty * 2,
          code: sameVersion ? 'failure-history' : 'failure-history-new-version',
          params: { failures, version: history.failureVersion ?? 'unversioned' },
        });
      }
    }

    // ---- gain de couverture : une zone peu couverte d'abord (à mission égale)
    if (coverage) {
      const area = action.href ? areaFromHref(action.href) : areaOf(context.route);
      const ratio = coverage.areaRatio(area);
      if (ratio < 1)
        add({
          factor: 'coverage',
          points: weights.coverageWeight * 40 * (1 - ratio),
          code: 'coverage-gain',
          params: { area, ratio: Math.round(ratio * 100) },
        });
    }

    // ---- risque
    if (action.classification === 'MUTATION') add({ factor: 'risk', points: -20, code: 'mutation-risk' });
    else if (action.classification === 'UNKNOWN') add({ factor: 'risk', points: -10, code: 'unknown-risk' });
    if (action.submitsForm) add({ factor: 'risk', points: -10, code: 'submit-risk' });

    // ---- répétition
    const loop = this.signals.loopPenaltyOf?.(context.stateId, action.id);
    if (loop)
      add({
        factor: 'repetition',
        points: -loop.points,
        code: 'loop-penalty',
        params: { detail: loop.detail },
      });
    if (usedThisRun > 0)
      add({
        factor: 'repetition',
        points: -Math.min(60, 15 * usedThisRun),
        code: 'already-used',
        params: { count: usedThisRun },
      });

    const breakdown = breakdownOf(details);
    return { ...base, score: breakdown.total, reasons: breakdown.reasons, breakdown };
  }
}

function areaFromHref(href: string): string {
  try {
    return areaOf(new URL(href).pathname);
  } catch {
    return '/';
  }
}

/** « new route /users (+100), menu link (+30) » → « new route /users, menu link ». */
function shortReasons(reasons: readonly string[]): string {
  return reasons
    .map((reason) => reason.replace(/\s*\([+-]?\d+\)$/, ''))
    .slice(0, 3)
    .join(', ');
}
