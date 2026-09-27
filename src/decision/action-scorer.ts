import type { QueryParamMode, ScenarioConfig } from '../config/config.js';
import { routeKey } from '../crawler/route-normalizer.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { ActionCategory, DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { EXPORT_KEYWORDS, KeywordMatcher, RISK_KEYWORDS } from '../policies/keywords.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import { scoringWeights, type ScoringWeightName, type ScoringWeights } from './scoring-weights.js';

/** Why an action got its score; excluded actions are never proposed. */
export interface ActionScore {
  actionId: string;
  score: number;
  /** Readable reasons, with the weight of each ("new route /users (+100)"). */
  reasons: string[];
  /** Never proposed from this state: already tried, blocked, disabled, out of the goals… */
  excluded?: string;
}

/** What the mission wants from the exploration, as the scorer needs it. */
export interface ScoringMission {
  name: string;
  goals: ScenarioConfig['goals'];
  /** Deterministic goal keywords (labels, texts, URLs): "utilisateurs", "permissions"… */
  keywords: readonly string[];
  weights: ScoringWeights;
  maxStatesPerRoute: number;
  queryParamMode: QueryParamMode;
  /** Similar controls (same kind, same label once numbers are masked) tried at most this many times per state. */
  maxSimilarActions?: number;
  /** `stateId::actionId` already known from the baseline (explore mode). */
  knownActions?: ReadonlySet<string>;
}

/**
 * "How interesting is this action, here and now?" A pure function of plain
 * data: the action, the current state, the graph built so far and the
 * mission. The DecisionEngine only sorts by it.
 */
export interface ActionScorer {
  score(
    action: DiscoveredAction,
    context: PageContext,
    graph: FlowGraph,
    mission: ScoringMission,
  ): ActionScore;
}

/** Link categories and the weight that expresses them. */
const NAVIGATION_WEIGHT: Partial<Record<ActionCategory, ScoringWeightName>> = {
  navigation: 'internalNavigation',
  details: 'details',
  menu: 'globalMenu',
  pagination: 'pagination',
  search: 'search',
  filter: 'filter',
};
/** In-page controls and the weight that expresses them. */
const CLICK_WEIGHT: Record<ActionCategory, ScoringWeightName | undefined> = {
  tab: 'tab',
  menu: 'menu',
  navigation: 'internalNavigation',
  details: 'details',
  toggle: 'toggle',
  'form-step': 'formNeverExplored',
  other: 'other',
  pagination: 'pagination',
  search: 'search',
  filter: 'filter',
  'form-input': 'formNeverExplored',
  submit: undefined,
};

const exportWords = new KeywordMatcher(EXPORT_KEYWORDS);
const logoutWords = new KeywordMatcher(RISK_KEYWORDS.logout ?? []);

/** What the scorer needs to know about the graph for one state (computed once per state and graph size). */
interface GraphFacts {
  key: string;
  executedElsewhere: Set<string>;
  tabsTriedOnRoute: Set<string>;
  navigationsPerRoute: Map<string, number>;
  similarOnScreen: Map<string, number>;
  similarTried: Map<string, number>;
}

/**
 * Deterministic scoring — same application, same mission, same scores.
 * Every number comes from ScoringWeights (DEFAULT_SCORING_WEIGHTS + the
 * mission's `scoring.weights`).
 */
export class RuleBasedActionScorer implements ActionScorer {
  private facts: GraphFacts | undefined;
  private goalMatcher: { keywords: readonly string[]; matcher: KeywordMatcher } | undefined;

  constructor(private readonly safetyPolicy: SafetyPolicy) {}

  score(
    action: DiscoveredAction,
    context: PageContext,
    graph: FlowGraph,
    mission: ScoringMission,
  ): ActionScore {
    const result: ActionScore = { actionId: action.id, score: 0, reasons: [] };
    const exclude = (reason: string): ActionScore => ({ ...result, excluded: reason });
    const add = (weight: ScoringWeightName, reason: string): void => {
      const value = mission.weights[weight];
      if (value === 0) return;
      result.score += value;
      result.reasons.push(`${reason} (${value > 0 ? '+' : ''}${value})`);
    };
    const { goals } = mission;
    const facts = this.factsFor(context, graph, mission);

    // ---- never proposed
    if (action.disabled || !action.visible) return exclude('disabled or hidden');
    // Behind a modal layer: the click would land on the layer, not on the element.
    if (action.obscured) return exclude('covered by a modal layer');
    if (action.classification === 'DANGEROUS') return exclude(`dangerous (${action.reason})`);
    if (graph.hasTransition(context.stateId, action.id)) return exclude('already tried from this state');
    if (this.safetyPolicy.evaluate(action).verdict === 'BLOCK')
      return exclude('blocked by the safety policy');
    const similar = similarKey(action.type, action.category, action.text);
    const maxSimilar = mission.maxSimilarActions ?? Number.POSITIVE_INFINITY;
    if (
      similar &&
      (facts.similarOnScreen.get(similar) ?? 0) > maxSimilar &&
      (facts.similarTried.get(similar) ?? 0) >= maxSimilar
    )
      return exclude(`${maxSimilar} similar controls already tried`);

    // ---- what it is
    switch (action.type) {
      case 'navigate': {
        if (!goals.discoverNavigation || !action.href) return exclude('navigation not in the goals');
        if (sameUrl(action.href, context.url)) return exclude('link to the current page');
        const route = safeRoute(action.href, mission.queryParamMode);
        const known = graph.statesForRoute(route).length;
        const visits = facts.navigationsPerRoute.get(route) ?? 0;
        // /users/1, /users/2 … : a few samples per route pattern are enough.
        if (known >= mission.maxStatesPerRoute || visits >= mission.maxStatesPerRoute)
          return exclude(`route ${route} explored enough`);
        // The same link followed from another state leads to a known place: nothing to learn.
        if (facts.executedElsewhere.has(signature(action.type, action.text, action.href)))
          return exclude('link already followed from another state');
        add('neverExecuted', 'never executed from this state');
        add(NAVIGATION_WEIGHT[action.category] ?? 'internalNavigation', `${action.category} link`);
        if (known === 0) add('newState', `new route ${route}`);
        else add('targetWellExplored', `${route}: ${known} state(s) known`);
        break;
      }
      case 'click': {
        if (action.category === 'tab') {
          // A selected tab changes nothing; a tab already opened from a sibling state leads to a known state.
          if (action.selected === true) return exclude('tab already selected');
          if (facts.tabsTriedOnRoute.has(`${context.route}|${(action.text ?? '').toLowerCase()}`))
            return exclude('tab already opened on this route');
        }
        const isStep = action.category === 'form-step';
        if (isStep ? !(goals.discoverForms || goals.discoverFlows) : !goals.discoverFlows)
          return exclude('in-page controls not in the goals');
        add('neverExecuted', 'never executed from this state');
        const weight = CLICK_WEIGHT[action.category];
        if (weight) add(weight, `${action.category} control`);
        // A tab never opened or a wizard step shows a screen not seen yet.
        if (action.category === 'tab' || isStep) add('newState', 'may show a new state');
        if (facts.executedElsewhere.has(signature(action.type, action.text, action.href)))
          add('alreadyExplored', 'already used from another state');
        break;
      }
      case 'uncheck':
        // Unchecking only undoes a check: nothing new to learn.
        return exclude('unchecking undoes a check');
      case 'select':
      case 'check':
        if (!goals.discoverForms) return exclude('forms not in the goals');
        add('neverExecuted', 'never executed from this state');
        add('formNeverExplored', `${action.type} may reveal more of the form`);
        break;
      case 'fill':
        // Filled together with the form (FormExerciser), never one by one.
        return exclude('filled with its form');
    }

    // ---- what the mission is after, and what is less interesting
    const label = [action.text, action.label, action.name].filter(Boolean).join(' ');
    const goal = this.goalKeyword(mission, label);
    if (goal) add('goalText', `matches the goal "${goal}"`);
    else if (action.href) {
      const inUrl = this.goalKeyword(mission, urlWords(action.href));
      if (inUrl) add('goalUrl', `URL matches the goal "${inUrl}"`);
    }
    const exportWord = exportWords.match(label, action.href ? urlWords(action.href) : undefined);
    if (exportWord) add('export', `export/download ("${exportWord}")`);
    if (logoutWords.match(label, action.href ? urlWords(action.href) : undefined)) add('logout', 'logout');
    if (mission.knownActions?.has(`${context.stateId}::${action.id}`))
      add('knownInBaseline', 'known from the baseline');
    // What is in front of the screen first (dialog, drawer, open menu, overlay): it is what a user sees.
    if (action.foreground) add('foreground', 'in front of the screen');
    return result;
  }

  private goalKeyword(mission: ScoringMission, text: string): string | undefined {
    if (mission.keywords.length === 0 || !text) return undefined;
    if (this.goalMatcher?.keywords !== mission.keywords) {
      this.goalMatcher = { keywords: mission.keywords, matcher: new KeywordMatcher(mission.keywords) };
    }
    return this.goalMatcher.matcher.match(text);
  }

  /** Facts about the graph for this state, recomputed only when the state or the graph changes. */
  private factsFor(context: PageContext, graph: FlowGraph, mission: ScoringMission): GraphFacts {
    const edges = graph.allEdges();
    const key = `${context.stateId}|${edges.length}|${context.actions.length}`;
    if (this.facts?.key === key) return this.facts;
    const facts: GraphFacts = {
      key,
      executedElsewhere: new Set(),
      tabsTriedOnRoute: new Set(),
      navigationsPerRoute: new Map(),
      similarOnScreen: new Map(),
      similarTried: new Map(),
    };
    for (const edge of edges) {
      if (edge.from === context.stateId && edge.result !== 'BLOCKED') {
        const similar = similarKey(edge.action.type, edge.action.category, edge.action.text);
        if (similar) facts.similarTried.set(similar, (facts.similarTried.get(similar) ?? 0) + 1);
      }
      if (edge.result !== 'SUCCESS') continue;
      if (edge.action.href) {
        const route = safeRoute(edge.action.href, mission.queryParamMode);
        facts.navigationsPerRoute.set(route, (facts.navigationsPerRoute.get(route) ?? 0) + 1);
      }
      if (edge.from === context.stateId) continue;
      facts.executedElsewhere.add(signature(edge.action.type, edge.action.text, edge.action.href));
      if (edge.action.category === 'tab') {
        facts.tabsTriedOnRoute.add(
          `${graph.getNode(edge.from)?.route ?? ''}|${(edge.action.text ?? '').toLowerCase()}`,
        );
      }
    }
    for (const action of context.actions) {
      const similar = similarKey(action.type, action.category, action.text);
      if (similar) facts.similarOnScreen.set(similar, (facts.similarOnScreen.get(similar) ?? 0) + 1);
    }
    this.facts = facts;
    return facts;
  }
}

/** The mission's scoring settings, from the configuration. */
export function scoringMissionOf(config: ScenarioConfig, knownActions?: ReadonlySet<string>): ScoringMission {
  return {
    name: config.mission.name,
    goals: config.goals,
    keywords: config.goals.keywords,
    weights: scoringWeights(config.scoring.weights),
    maxStatesPerRoute: config.exploration.maxStatesPerRoute,
    queryParamMode: config.exploration.queryParams.mode,
    maxSimilarActions: config.exploration.maxSimilarActions,
    ...(knownActions ? { knownActions } : {}),
  };
}

/** Same kind of control, same label once numbers are masked ("12" → "#", "2026-09-12" → "#-#-#"). */
function similarKey(type: string, category: string, text: string | undefined): string | undefined {
  if (type !== 'click' && type !== 'navigate') return undefined;
  const label = (text ?? '').trim().toLowerCase().replace(/\d+/g, '#');
  return label ? `${type}|${category}|${label}` : undefined;
}

/** Words of a URL's path: /admin/user-permissions → "admin user permissions". */
function urlWords(href: string): string {
  try {
    return decodeURIComponent(new URL(href).pathname).replace(/[/_-]+/g, ' ');
  } catch {
    return href;
  }
}

function safeRoute(href: string, mode: QueryParamMode): string {
  try {
    return routeKey(href, mode);
  } catch {
    return href;
  }
}

function signature(type: string, text: string | undefined, href: string | undefined): string {
  return `${type}|${(text ?? '').toLowerCase()}|${href ?? ''}`;
}

function sameUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = /^#!?\//.test(left.hash) ? left.hash : '';
    right.hash = /^#!?\//.test(right.hash) ? right.hash : '';
    return left.toString().replace(/\/$/, '') === right.toString().replace(/\/$/, '');
  } catch {
    return false;
  }
}
