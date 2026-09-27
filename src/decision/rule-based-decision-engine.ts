import type { QueryParamMode, ScenarioConfig } from '../config/config.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import { RuleBasedActionScorer, type ActionScorer, type ScoringMission } from './action-scorer.js';
import type { ActionDecision, DecisionEngine } from './decision-engine.js';
import { scoringWeights, type ScoringWeights } from './scoring-weights.js';

export interface RuleBasedOptions {
  goals: ScenarioConfig['goals'];
  maxDepth: number;
  maxStatesPerRoute: number;
  queryParamMode: QueryParamMode;
  /** Similar controls (same kind, same label once numbers are masked) tried at most this many times per state. */
  maxSimilarActions?: number;
  /** Mission name (reports). */
  missionName?: string;
  /** Goal keywords: actions whose label or URL matches one are preferred. Default: goals.keywords. */
  keywords?: readonly string[];
  /** Scoring weights (defaults + the mission's overrides). */
  weights?: ScoringWeights;
  /** `stateId::actionId` known from the baseline (explore mode): new ground first. */
  knownActions?: ReadonlySet<string>;
}

export interface ScoredAction {
  action: DiscoveredAction;
  score: number;
  /** Reasons joined, for logs and reports. */
  why: string;
  reasons: string[];
}

/**
 * Deterministic strategy — same application, same mission, same exploration:
 *
 * 1. every action of the state is scored by the ActionScorer (see
 *    DEFAULT_SCORING_WEIGHTS): new states, goal keywords and what is in front
 *    of the screen first; actions already tried, blocked, disabled, covered
 *    by a modal or out of the goals are excluded;
 * 2. the best score wins (equal scores keep document order);
 * 3. nothing left → BACKTRACK; max depth reached → BACKTRACK.
 *
 * Free-text fields are not filled one by one: the explorer fills a whole
 * form (FormExerciser) before its buttons are considered.
 */
export class RuleBasedDecisionEngine implements DecisionEngine {
  readonly name = 'rule-based';
  private readonly mission: ScoringMission;

  constructor(
    safetyPolicy: SafetyPolicy,
    private readonly options: RuleBasedOptions,
    private readonly scorer: ActionScorer = new RuleBasedActionScorer(safetyPolicy),
  ) {
    this.mission = {
      name: options.missionName ?? 'mission',
      goals: options.goals,
      keywords: options.keywords ?? options.goals.keywords,
      weights: options.weights ?? scoringWeights(),
      maxStatesPerRoute: options.maxStatesPerRoute,
      queryParamMode: options.queryParamMode,
      ...(options.maxSimilarActions !== undefined ? { maxSimilarActions: options.maxSimilarActions } : {}),
      ...(options.knownActions ? { knownActions: options.knownActions } : {}),
    };
  }

  decide(context: PageContext, graph: FlowGraph): Promise<ActionDecision> {
    if (context.metadata.depth >= this.options.maxDepth) {
      return Promise.resolve({ decision: 'BACKTRACK', reason: `max depth ${this.options.maxDepth} reached` });
    }
    const best = this.rank(context, graph)[0];
    if (!best) {
      return Promise.resolve({
        decision: 'BACKTRACK',
        reason: 'no unexplored action worth trying on this state',
      });
    }
    return Promise.resolve({
      decision: 'EXECUTE',
      actionId: best.action.id,
      reason: `score ${best.score}: ${best.why}`,
    });
  }

  /** Candidates in decision order (exposed for tests and debugging). */
  rank(context: PageContext, graph: FlowGraph): ScoredAction[] {
    const scored: ScoredAction[] = [];
    for (const action of context.actions) {
      const score = this.scorer.score(action, context, graph, this.mission);
      if (score.excluded !== undefined) continue;
      scored.push({ action, score: score.score, why: score.reasons.join(', '), reasons: score.reasons });
    }
    // Stable: equal scores keep document order.
    return scored.sort((a, b) => b.score - a.score);
  }
}
