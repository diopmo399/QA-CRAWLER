import type { QueryParamMode, ScenarioConfig } from '../config/config.js';
import { routeKey } from '../crawler/route-normalizer.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { ActionCategory, DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import type { ActionDecision, DecisionEngine } from './decision-engine.js';

export interface RuleBasedOptions {
  goals: ScenarioConfig['goals'];
  maxDepth: number;
  maxStatesPerRoute: number;
  queryParamMode: QueryParamMode;
  /** Similar controls (same kind, same label once numbers are masked) tried at most this many times per state. */
  maxSimilarActions?: number;
}

/** Base interest of each kind of click: structure first (tabs, menus, sections), then details, steps, pages. */
const CLICK_SCORE: Record<ActionCategory, number> = {
  tab: 90,
  menu: 85,
  navigation: 80,
  details: 70,
  toggle: 60,
  'form-step': 55,
  other: 50,
  pagination: 40,
  search: 35,
  filter: 35,
  'form-input': 20,
  submit: 0,
};

/** Added to actions in front of the screen: above any action of the page behind. */
const FOREGROUND_BONUS = 200;

export interface ScoredAction {
  action: DiscoveredAction;
  score: number;
  why: string;
}

/**
 * Deterministic strategy — same application, same exploration:
 *
 * 1. drop disabled/hidden actions, DANGEROUS ones, and those the SafetyPolicy refuses;
 * 2. drop actions already tried from this state (FlowGraph memory);
 * 3. drop what the mission's goals exclude, links to routes already explored
 *    enough (maxStatesPerRoute) and links to the current page;
 * 4. rank: tabs > menu buttons > content links to unseen routes > details > toggles >
 *    wizard steps > other SAFE controls > global menu links > pagination >
 *    search/filter > selects/checkboxes (so a screen is explored before leaving it);
 *    a few URLs per route pattern only (maxStatesPerRoute), selected tabs and
 *    tabs already opened from a sibling state are skipped, nothing is unchecked;
 *    links already followed from another state (global menu entries) are skipped,
 *    clicks already executed elsewhere come last;
 *    what is in front of the screen (dialog, drawer, open menu, overlay) comes
 *    before the page behind it, and what a modal layer covers is not tried;
 * 5. nothing left → BACKTRACK; max depth reached → BACKTRACK.
 *
 * Free-text fields are not filled one by one: the explorer fills a form
 * with test data just before clicking one of its step buttons.
 */
export class RuleBasedDecisionEngine implements DecisionEngine {
  readonly name = 'rule-based';

  constructor(
    private readonly safetyPolicy: SafetyPolicy,
    private readonly options: RuleBasedOptions,
  ) {}

  decide(context: PageContext, graph: FlowGraph): Promise<ActionDecision> {
    if (context.metadata.depth >= this.options.maxDepth) {
      return Promise.resolve({ decision: 'BACKTRACK', reason: `max depth ${this.options.maxDepth} reached` });
    }
    const ranked = this.rank(context, graph);
    const best = ranked[0];
    if (!best) {
      return Promise.resolve({
        decision: 'BACKTRACK',
        reason: 'no unexplored action worth trying on this state',
      });
    }
    return Promise.resolve({ decision: 'EXECUTE', actionId: best.action.id, reason: best.why });
  }

  /** Candidates in decision order (exposed for tests and debugging). */
  rank(context: PageContext, graph: FlowGraph): ScoredAction[] {
    const executedElsewhere = new Set<string>();
    const tabsTriedOnRoute = new Set<string>();
    const navigationsPerRoute = new Map<string, number>();
    for (const edge of graph.allEdges()) {
      if (edge.result !== 'SUCCESS') continue;
      if (edge.action.href) {
        const route = safeRoute(edge.action.href, this.options.queryParamMode);
        navigationsPerRoute.set(route, (navigationsPerRoute.get(route) ?? 0) + 1);
      }
      if (edge.from === context.stateId) continue;
      executedElsewhere.add(signature(edge.action.type, edge.action.text, edge.action.href));
      if (edge.action.category === 'tab') {
        tabsTriedOnRoute.add(
          `${graph.getNode(edge.from)?.route ?? ''}|${(edge.action.text ?? '').toLowerCase()}`,
        );
      }
    }
    // Similar controls: "1", "2"… of a date picker, "Voir" on each row. A few samples are enough.
    const similarOnScreen = new Map<string, number>();
    for (const action of context.actions) {
      const key = similarKey(action.type, action.category, action.text);
      if (key) similarOnScreen.set(key, (similarOnScreen.get(key) ?? 0) + 1);
    }
    const similarTried = new Map<string, number>();
    for (const edge of graph.allEdges()) {
      if (edge.from !== context.stateId || edge.result === 'BLOCKED') continue;
      const key = similarKey(edge.action.type, edge.action.category, edge.action.text);
      if (key) similarTried.set(key, (similarTried.get(key) ?? 0) + 1);
    }
    const maxSimilar = this.options.maxSimilarActions ?? Number.POSITIVE_INFINITY;
    const scored: ScoredAction[] = [];
    for (const action of context.actions) {
      const key = similarKey(action.type, action.category, action.text);
      if (key && (similarOnScreen.get(key) ?? 0) > maxSimilar && (similarTried.get(key) ?? 0) >= maxSimilar)
        continue;
      const score = this.score(
        action,
        context,
        graph,
        executedElsewhere,
        tabsTriedOnRoute,
        navigationsPerRoute,
      );
      if (score) scored.push({ action, ...score });
    }
    // Stable: equal scores keep document order.
    return scored.sort((a, b) => b.score - a.score);
  }

  private score(
    action: DiscoveredAction,
    context: PageContext,
    graph: FlowGraph,
    executedElsewhere: ReadonlySet<string>,
    tabsTriedOnRoute: ReadonlySet<string>,
    navigationsPerRoute: ReadonlyMap<string, number>,
  ): { score: number; why: string } | undefined {
    const { goals } = this.options;
    if (action.disabled || !action.visible) return undefined;
    // Behind a modal layer: the click would land on the layer, not on the element.
    if (action.obscured) return undefined;
    if (action.classification === 'DANGEROUS') return undefined;
    if (graph.hasTransition(context.stateId, action.id)) return undefined;
    if (this.safetyPolicy.evaluate(action).verdict === 'BLOCK') return undefined;

    let score: number;
    let why: string;
    switch (action.type) {
      case 'navigate': {
        if (!goals.discoverNavigation || !action.href) return undefined;
        if (sameUrl(action.href, context.url)) return undefined;
        const route = safeRoute(action.href, this.options.queryParamMode);
        const known = graph.statesForRoute(route).length;
        const visits = navigationsPerRoute.get(route) ?? 0;
        // /users/1, /users/2 … : a few samples per route pattern are enough.
        if (known >= this.options.maxStatesPerRoute || visits >= this.options.maxStatesPerRoute)
          return undefined;
        const base = NAVIGATE_SCORE[action.category] ?? NAVIGATE_SCORE.navigation;
        score = known === 0 ? base : base - 40;
        why =
          known === 0
            ? `${action.category} to a new route ${route}`
            : `${action.category} to ${route} (${known} state(s) known)`;
        break;
      }
      case 'click': {
        if (action.category === 'tab') {
          // A selected tab changes nothing; a tab already opened from a sibling state leads to a known state.
          if (action.selected === true) return undefined;
          if (tabsTriedOnRoute.has(`${context.route}|${(action.text ?? '').toLowerCase()}`)) return undefined;
        }
        const isStep = action.category === 'form-step';
        if (isStep ? !(goals.discoverForms || goals.discoverFlows) : !goals.discoverFlows) return undefined;
        score = CLICK_SCORE[action.category];
        why = `${action.category} control`;
        break;
      }
      case 'uncheck':
        // Unchecking only undoes a check: nothing new to learn.
        return undefined;
      case 'select':
      case 'check': {
        if (!goals.discoverForms) return undefined;
        score = CLICK_SCORE['form-input'];
        why = `${action.type} may reveal more of the form`;
        break;
      }
      case 'fill':
        // Filled together with the form, before its step button (see FlowExplorer).
        return undefined;
    }
    if (executedElsewhere.has(signature(action.type, action.text, action.href))) {
      // The same link followed from another state leads to a known place: nothing to learn.
      if (action.type === 'navigate') return undefined;
      score -= 60;
      why += ', already explored from another state';
    }
    if (action.foreground) {
      // What is in front of the screen first (dialog, drawer, open menu, overlay): it is what a user sees.
      score += FOREGROUND_BONUS;
      why += ', in front of the screen';
    }
    return { score, why };
  }
}

/** Same kind of control, same label once numbers are masked ("12" → "#", "2026-09-12" → "#-#-#"). */
function similarKey(type: string, category: string, text: string | undefined): string | undefined {
  if (type !== 'click' && type !== 'navigate') return undefined;
  const label = (text ?? '').trim().toLowerCase().replace(/\d+/g, '#');
  return label ? `${type}|${category}|${label}` : undefined;
}

/** Base interest of links: content first, the global menu after the page is explored. */
const NAVIGATE_SCORE: Partial<Record<ActionCategory, number>> & { navigation: number } = {
  navigation: 80,
  details: 70,
  menu: 45,
  pagination: 40,
};

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
