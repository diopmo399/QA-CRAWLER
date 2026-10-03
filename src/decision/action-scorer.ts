import type { QueryParamMode, ScenarioConfig } from '../config/config.js';
import { routeKey } from '../crawler/route-normalizer.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { ActionCategory, DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { EXPORT_KEYWORDS, KeywordMatcher, RISK_KEYWORDS } from '../policies/keywords.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import { scoringWeights, type ScoringWeightName, type ScoringWeights } from './scoring-weights.js';

/** Pourquoi une action a reçu son score ; les actions exclues ne sont jamais proposées. */
export interface ActionScore {
  actionId: string;
  score: number;
  /** Raisons lisibles, avec le poids de chacune (« new route /users (+100) »). */
  reasons: string[];
  /** Jamais proposée depuis cet état : déjà essayée, bloquée, désactivée, hors des objectifs… */
  excluded?: string;
}

/** Ce que la mission attend de l'exploration, tel que le scorer en a besoin. */
export interface ScoringMission {
  name: string;
  goals: ScenarioConfig['goals'];
  /** Mots-clés d'objectif déterministes (libellés, textes, URL) : « utilisateurs », « permissions »… */
  keywords: readonly string[];
  weights: ScoringWeights;
  maxStatesPerRoute: number;
  queryParamMode: QueryParamMode;
  /** Contrôles pareils (même genre, même libellé une fois les nombres masqués) essayés au plus ce nombre de fois par état. */
  maxSimilarActions?: number;
  /** `stateId::actionId` déjà connus par la baseline (mode explore). */
  knownActions?: ReadonlySet<string>;
  /**
   * Options (radios, cases, listes) déjà essayées pendant ce run, par groupe + option
   * (optionKey) : chaque option d'un groupe n'est essayée qu'une fois au total, pas sur
   * chaque écran où le groupe réapparaît.
   */
  triedOptions?: ReadonlySet<string>;
  /**
   * `stateId::actionId` déjà tentés sur l'écran jumeau que celui-ci remplace (même écran
   * retrouvé avec un autre id après une page cassée) : ils comptent comme déjà essayés ici.
   */
  triedOnTwin?: ReadonlySet<string>;
}

/**
 * « À quel point cette action est-elle intéressante, ici et maintenant ? » Une
 * fonction pure de données simples : l'action, l'état courant, le graphe construit
 * jusqu'ici et la mission. Le DecisionEngine se contente de trier selon ce score.
 */
export interface ActionScorer {
  score(
    action: DiscoveredAction,
    context: PageContext,
    graph: FlowGraph,
    mission: ScoringMission,
  ): ActionScore;
}

/** Catégories de liens et le poids qui les exprime. */
const NAVIGATION_WEIGHT: Partial<Record<ActionCategory, ScoringWeightName>> = {
  navigation: 'internalNavigation',
  details: 'details',
  menu: 'globalMenu',
  pagination: 'pagination',
  search: 'search',
  filter: 'filter',
};
/** Contrôles de la page et le poids qui les exprime. */
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

/** Ce que le scorer doit savoir du graphe pour un état (calculé une fois par état et par taille du graphe). */
interface GraphFacts {
  key: string;
  executedElsewhere: Set<string>;
  tabsTriedOnRoute: Set<string>;
  navigationsPerRoute: Map<string, number>;
  similarOnScreen: Map<string, number>;
  similarTried: Map<string, number>;
}

/**
 * Score déterministe — même application, même mission, mêmes scores.
 * Chaque nombre vient des ScoringWeights (DEFAULT_SCORING_WEIGHTS + le
 * `scoring.weights` de la mission).
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

    // ---- jamais proposée
    if (action.disabled || !action.visible) return exclude('disabled or hidden');
    // Derrière un calque modal : le clic tomberait sur le calque, pas sur l'élément.
    if (action.obscured) return exclude('covered by a modal layer');
    if (action.classification === 'DANGEROUS') return exclude(`dangerous (${action.reason})`);
    if (
      graph.hasTransition(context.stateId, action.id) ||
      mission.triedOnTwin?.has(`${context.stateId}::${action.id}`)
    )
      return exclude('already tried from this state');
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

    // ---- ce qu'elle est
    switch (action.type) {
      case 'navigate': {
        if (!goals.discoverNavigation || !action.href) return exclude('navigation not in the goals');
        if (sameUrl(action.href, context.url)) return exclude('link to the current page');
        const route = safeRoute(action.href, mission.queryParamMode);
        const known = graph.statesForRoute(route).length;
        const visits = facts.navigationsPerRoute.get(route) ?? 0;
        // /users/1, /users/2 … : quelques exemples par modèle de route suffisent.
        if (known >= mission.maxStatesPerRoute || visits >= mission.maxStatesPerRoute)
          return exclude(`route ${route} explored enough`);
        // Le même lien suivi depuis un autre état mène à un endroit connu : rien à apprendre.
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
          // Un onglet déjà sélectionné ne change rien ; un onglet déjà ouvert depuis un état voisin mène à un état connu.
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
        // Un onglet jamais ouvert ou une étape d'assistant montre un écran pas encore vu.
        if (action.category === 'tab' || isStep) add('newState', 'may show a new state');
        if (facts.executedElsewhere.has(signature(action.type, action.text, action.href)))
          add('alreadyExplored', 'already used from another state');
        break;
      }
      case 'uncheck':
        // Décocher ne fait qu'annuler une coche : rien de nouveau à apprendre.
        return exclude('unchecking undoes a check');
      case 'select':
      case 'check':
        if (!goals.discoverForms) return exclude('forms not in the goals');
        if (mission.triedOptions?.has(optionKey(action))) return exclude('option already tried in this run');
        add('neverExecuted', 'never executed from this state');
        add('formNeverExplored', `${action.type} may reveal more of the form`);
        break;
      case 'fill':
        // Rempli avec le formulaire (FormExerciser), jamais un par un.
        return exclude('filled with its form');
    }

    // ---- ce que cherche la mission, et ce qui est moins intéressant
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
    // Ce qui est devant l'écran d'abord (fenêtre, tiroir, menu ouvert, calque) : c'est ce que voit l'utilisateur.
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

  /** Faits sur le graphe pour cet état, recalculés seulement quand l'état ou le graphe change. */
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

/** Les réglages de score de la mission, tirés de la configuration. */
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

/**
 * Une option d'un groupe, identique d'un écran à l'autre : libellé du groupe (ou name,
 * ou groupe de choix) + libellé de l'option. « Oui » de « Déjà client ? » et « Oui » de
 * « Accepte les conditions ? » restent deux options différentes.
 */
export function optionKey(
  action: Pick<DiscoveredAction, 'type' | 'text' | 'label' | 'name' | 'field'>,
): string {
  const group = action.field?.groupLabel ?? action.field?.name ?? action.field?.choiceGroup ?? '';
  const option = action.text ?? action.label ?? action.name ?? '';
  return `${action.type}|${group}|${option}`.toLowerCase().replace(/\d+/g, '#');
}

/** Même genre de contrôle, même libellé une fois les nombres masqués (« 12 » → « # », « 2026-09-12 » → « #-#-# »). */
function similarKey(type: string, category: string, text: string | undefined): string | undefined {
  if (type !== 'click' && type !== 'navigate') return undefined;
  const label = (text ?? '').trim().toLowerCase().replace(/\d+/g, '#');
  return label ? `${type}|${category}|${label}` : undefined;
}

/** Mots du chemin d'une URL : /admin/user-permissions → « admin user permissions ». */
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
