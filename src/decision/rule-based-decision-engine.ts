import type { QueryParamMode, ScenarioConfig } from '../config/config.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import {
  RuleBasedActionScorer,
  type ActionScore,
  type ActionScorer,
  type ScoringMission,
} from './action-scorer.js';
import type { ScoreBreakdown } from './score-breakdown.js';
import type { ActionDecision, DecisionEngine } from './decision-engine.js';
import { scoringWeights, type ScoringWeights } from './scoring-weights.js';

export interface RuleBasedOptions {
  goals: ScenarioConfig['goals'];
  maxDepth: number;
  maxStatesPerRoute: number;
  queryParamMode: QueryParamMode;
  /** Contrôles semblables (même genre, même libellé une fois les nombres masqués) essayés au plus ce nombre de fois par état. */
  maxSimilarActions?: number;
  /** Nom de la mission (rapports). */
  missionName?: string;
  /** Mots-clés d'objectif : les actions dont le libellé ou l'URL en contient un sont préférées. Par défaut : goals.keywords. */
  keywords?: readonly string[];
  /** Poids du score (valeurs par défaut + surcharges de la mission). */
  weights?: ScoringWeights;
  /** `stateId::actionId` connus par la baseline (mode explore) : le nouveau terrain d'abord. */
  knownActions?: ReadonlySet<string>;
  /** Options de groupes déjà essayées pendant le run (partagé avec l'explorateur, qui le remplit). */
  triedOptions?: ReadonlySet<string>;
}

export interface ScoredAction {
  action: DiscoveredAction;
  score: number;
  /** Raisons réunies, pour les logs et les rapports. */
  why: string;
  reasons: string[];
  /** Décomposition du score (ActionScorer V2). */
  breakdown?: ScoreBreakdown;
}

/** Une action écartée, et pourquoi (pour les traces de décision). */
export interface ExcludedAction {
  action: DiscoveredAction;
  reason: string;
}

/**
 * Stratégie déterministe — même application, même mission, même exploration :
 *
 * 1. chaque action de l'état reçoit un score de l'ActionScorer (voir
 *    DEFAULT_SCORING_WEIGHTS) : les nouveaux états, les mots-clés d'objectif et
 *    ce qui est devant l'écran d'abord ; les actions déjà essayées, bloquées,
 *    désactivées, couvertes par une fenêtre modale ou hors objectifs sont exclues ;
 * 2. le meilleur score gagne (à score égal, l'ordre du document est gardé) ;
 * 3. plus rien → BACKTRACK ; profondeur maximale atteinte → BACKTRACK.
 *
 * Les champs de texte libre ne sont pas remplis un par un : l'explorateur remplit
 * tout un formulaire (FormExerciser) avant de considérer ses boutons.
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
      ...(options.triedOptions ? { triedOptions: options.triedOptions } : {}),
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
      score: best.score,
      ...(best.breakdown ? { breakdown: best.breakdown } : {}),
    });
  }

  /** Candidates dans l'ordre de décision (exposées pour les tests et le débogage). */
  rank(context: PageContext, graph: FlowGraph): ScoredAction[] {
    return this.rankWithExclusions(context, graph).ranked;
  }

  /** Les candidates classées, et les actions écartées avec leur raison. */
  rankWithExclusions(
    context: PageContext,
    graph: FlowGraph,
  ): { ranked: ScoredAction[]; excluded: ExcludedAction[] } {
    const ranked: ScoredAction[] = [];
    const excluded: ExcludedAction[] = [];
    for (const action of context.actions) {
      const score: ActionScore & { breakdown?: ScoreBreakdown } = this.scorer.score(
        action,
        context,
        graph,
        this.mission,
      );
      if (score.excluded !== undefined) {
        excluded.push({ action, reason: score.excluded });
        continue;
      }
      ranked.push({
        action,
        score: score.score,
        why: score.reasons.join(', '),
        reasons: score.reasons,
        ...(score.breakdown ? { breakdown: score.breakdown } : {}),
      });
    }
    // Stable : à score égal, l'ordre du document est gardé.
    return { ranked: ranked.sort((a, b) => b.score - a.score), excluded };
  }
}
