import { describe, expect, it } from 'vitest';
import {
  RuleBasedActionScorer,
  scoringMissionOf,
  type ScoringMission,
} from '../../src/decision/action-scorer.js';
import { DEFAULT_SCORING_WEIGHTS } from '../../src/decision/scoring-weights.js';
import { RuleBasedDecisionEngine } from '../../src/decision/rule-based-decision-engine.js';
import { FlowGraph, summaryOf } from '../../src/graph/flow-graph.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

const config = testConfig('goals:\n  keywords: [utilisateurs, administration, permissions]\n');
const safety = new SafetyPolicy(config.safety);
const scorer = new RuleBasedActionScorer(safety);
const mission: ScoringMission = scoringMissionOf(config);

let counter = 0;
const link = (text: string, path: string, overrides: Partial<DiscoveredAction> = {}): DiscoveredAction => ({
  id: `l-${(counter += 1)}`,
  stateId: 'home',
  type: 'navigate',
  category: 'navigation',
  elementType: 'a',
  text,
  href: `http://localhost:4200${path}`,
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: '',
  risks: [],
  locator: { strategy: 'role', role: 'link', name: text },
  ...overrides,
});
const button = (text: string, overrides: Partial<DiscoveredAction> = {}): DiscoveredAction =>
  link(text, '', { type: 'click', category: 'other', elementType: 'button', ...overrides, href: undefined });

const context = (actions: DiscoveredAction[]): PageContext => ({
  url: 'http://localhost:4200/',
  title: 'Dashboard',
  stateId: 'home',
  stateLabel: 'home',
  route: '/',
  headings: [],
  dialogs: [],
  actions,
  forms: [],
  errors: [],
  metadata: { depth: 0, timestamp: '', flow: ['home'] },
});
const graphOf = (actions: DiscoveredAction[]): FlowGraph => {
  const graph = new FlowGraph();
  graph.addNode({
    id: 'home',
    label: 'home',
    url: 'http://localhost:4200/',
    route: '/',
    headings: [],
    depth: 0,
    actions,
  });
  return graph;
};

describe('RuleBasedActionScorer', () => {
  it('explains each score with the weights it used', () => {
    const users = link('Users', '/users');
    const score = scorer.score(users, context([users]), graphOf([users]), mission);
    const w = DEFAULT_SCORING_WEIGHTS;
    expect(score.score).toBe(w.neverExecuted + w.internalNavigation + w.newState);
    expect(score.reasons).toEqual([
      `never executed from this state (+${w.neverExecuted})`,
      `navigation link (+${w.internalNavigation})`,
      `new route /users (+${w.newState})`,
    ]);
    expect(score.excluded).toBeUndefined();
  });

  it('prefers what the mission is after (goals.keywords), by label then by URL', () => {
    const actions = [
      link('Parking', '/parking'),
      link('Réglages', '/admin/permissions'),
      link('Utilisateurs', '/people'),
    ];
    const engine = new RuleBasedDecisionEngine(safety, {
      goals: config.goals,
      maxDepth: 5,
      maxStatesPerRoute: 3,
      queryParamMode: 'pattern',
    });
    const ranked = engine.rank(context(actions), graphOf(actions));
    expect(ranked.map((entry) => entry.action.text)).toEqual(['Utilisateurs', 'Réglages', 'Parking']);
    expect(ranked[0]?.why).toContain('matches the goal "utilisateurs" (+100)');
    expect(ranked[1]?.why).toContain('URL matches the goal "permissions" (+80)');
  });

  it('lowers exports and routes already explored, excludes what was tried or is blocked', () => {
    const exportButton = button('Exporter CSV');
    const refresh = button('Actualiser');
    const known = link('Liste', '/users');
    const tried = button('Déjà fait');
    const remove = button('Supprimer', { classification: 'DANGEROUS', risks: ['delete'], reason: 'delete' });
    const actions = [exportButton, refresh, known, tried, remove];
    const graph = graphOf(actions);
    graph.addNode({
      id: 'users',
      label: 'users',
      url: 'http://localhost:4200/users',
      route: '/users',
      headings: [],
      depth: 1,
      actions: [],
    });
    graph.addEdge({
      from: 'home',
      to: 'home',
      actionId: tried.id,
      action: summaryOf(tried),
      result: 'SUCCESS',
    });
    const scores = new Map(
      actions.map((action) => [action.text, scorer.score(action, context(actions), graph, mission)]),
    );
    expect(scores.get('Exporter CSV')?.score).toBe(
      (scores.get('Actualiser')?.score ?? 0) + DEFAULT_SCORING_WEIGHTS.export,
    );
    expect(scores.get('Liste')?.reasons).toContain('/users: 1 state(s) known (-40)');
    expect(scores.get('Déjà fait')?.excluded).toBe('already tried from this state');
    expect(scores.get('Supprimer')?.excluded).toMatch(/^dangerous/);
  });

  it('weights are configurable from the mission', () => {
    const custom = scoringMissionOf(testConfig('scoring:\n  weights: { export: 0, newState: 500 }\n'));
    expect(custom.weights.newState).toBe(500);
    const exportButton = button('Exporter');
    const refresh = button('Actualiser');
    const both = [exportButton, refresh];
    expect(scorer.score(exportButton, context(both), graphOf(both), custom).score).toBe(
      scorer.score(refresh, context(both), graphOf(both), custom).score,
    );
  });

  it('puts what is already known from the baseline after new ground (explore mode)', () => {
    const a = link('Alpha', '/alpha');
    const b = link('Beta', '/beta');
    const knowing = { ...mission, knownActions: new Set([`home::${a.id}`]) };
    const scoreA = scorer.score(a, context([a, b]), graphOf([a, b]), knowing);
    const scoreB = scorer.score(b, context([a, b]), graphOf([a, b]), knowing);
    expect(scoreA.score).toBe(scoreB.score + DEFAULT_SCORING_WEIGHTS.knownInBaseline);
  });
});
