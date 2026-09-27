import { describe, expect, it } from 'vitest';
import { CoverageTracker, areaOf } from '../../src/coverage/coverage-map.js';
import { RuleBasedActionScorer, scoringMissionOf } from '../../src/decision/action-scorer.js';
import { AdvancedActionScorer, type ScoringSignals } from '../../src/decision/advanced-action-scorer.js';
import { renderReason } from '../../src/decision/score-breakdown.js';
import { GraphNoveltyDetector } from '../../src/exploration/novelty-detector.js';
import { RuleBasedGoalMatcher } from '../../src/goals/goal-matcher.js';
import { missionOf, RuleBasedGoalPlanner } from '../../src/goals/goal-planner.js';
import { GoalTracker } from '../../src/goals/goal-tracker.js';
import { FlowGraph } from '../../src/graph/flow-graph.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { RuleBasedPatternDetector } from '../../src/patterns/pattern-detector.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { button, link, screen, structure, testConfig } from '../helpers.js';

const config = testConfig(
  'goals: [create-user]\nsafety: { mutations: { enabled: true }, allowedActionClasses: [SAFE, MUTATION] }\n',
);
const dictionary = new SemanticDictionary();
const detector = new RuleBasedPatternDetector(dictionary);
const weights = { goalWeight: 1, patternWeight: 1, noveltyWeight: 1, coverageWeight: 1, historyWeight: 1 };

const users = screen(
  {
    url: 'http://localhost:4200/users',
    headings: ['Utilisateurs'],
    elements: [
      button('Créer utilisateur'),
      link('Voir', 'http://localhost:4200/users/1'),
      link('Voir', 'http://localhost:4200/users/2'),
      link('Paramètres', 'http://localhost:4200/settings'),
    ],
    structure: structure({ tables: 1, tableRows: 2, pagination: true }),
  },
  config,
);

function find(context: PageContext, text: string): DiscoveredAction {
  const action = context.actions.find((candidate) => candidate.text === text);
  if (!action) throw new Error(`no action ${text}`);
  return action;
}

async function scorer(overrides: Partial<ScoringSignals> = {}): Promise<AdvancedActionScorer> {
  const planner = new RuleBasedGoalPlanner(dictionary);
  const goals = new GoalTracker(
    await planner.plan(missionOf(config), users, new FlowGraph()),
    new RuleBasedGoalMatcher(dictionary),
  );
  goals.observe(users, detector.detect(users));
  const patterns = detector.detect(users);
  return new AdvancedActionScorer(new RuleBasedActionScorer(new SafetyPolicy(config.safety)), {
    dictionary,
    weights,
    patternsOf: () => patterns,
    goals,
    ...overrides,
  });
}

describe('ActionScorer V2', () => {
  it('explains every point: « Créer utilisateur » = base + goal + CRUD pattern + never explored − mutation', async () => {
    const scored = (await scorer()).score(
      find(users, 'Créer utilisateur'),
      users,
      new FlowGraph(),
      scoringMissionOf(config),
    );
    const { breakdown } = scored;
    expect(breakdown.goal).toBe(Math.round(70 * 1.25)); // objectif actif, priorité 10
    expect(breakdown.pattern).toBeGreaterThan(40); // CRUD_LIST: create, pondéré par la confiance
    expect(breakdown.risk).toBe(-20);
    expect(breakdown.total).toBe(
      breakdown.base +
        breakdown.goal +
        breakdown.pattern +
        breakdown.novelty +
        breakdown.history +
        breakdown.coverage +
        breakdown.risk +
        breakdown.repetition,
    );
    expect(scored.score).toBe(breakdown.total);
    expect(breakdown.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\+\d+ goal relevance: reach the "create" screen for "user"$/),
        '-20 mutation risk',
      ]),
    );
    const goalReason = breakdown.details.find((reason) => reason.code === 'goal-relevance');
    expect(goalReason && renderReason(goalReason, 'fr')).toMatch(/^\+\d+ pertinence pour l’objectif/);
  });

  it('history: repeated failures on the same version weigh heavily; a new version gives a new chance', async () => {
    const knowledge = JsonKnowledgeBase.inMemory({ commit: 'v1' });
    for (let index = 0; index < 8; index++)
      knowledge.recordActionResult({ actionSignature: 'navigate:parametres', result: 'FAILED' });
    const settings = find(users, 'Paramètres');
    const same = (await scorer({ knowledge, version: 'v1' })).score(
      settings,
      users,
      new FlowGraph(),
      scoringMissionOf(config),
    );
    const next = (await scorer({ knowledge, version: 'v2' })).score(
      settings,
      users,
      new FlowGraph(),
      scoringMissionOf(config),
    );
    expect(same.breakdown.history).toBeLessThanOrEqual(-150);
    expect(next.breakdown.history).toBeGreaterThan(same.breakdown.history);
    expect(same.breakdown.details.find((reason) => reason.code === 'failure-history')?.params).toMatchObject({
      failures: 8,
    });
  });

  it('a pattern BLOCK excludes the action; exclusions of the base scorer stay exclusions', async () => {
    const withDelete = screen(
      {
        url: 'http://localhost:4200/users',
        elements: [button('Supprimer la sélection')],
        structure: structure({ tables: 1, tableRows: 3 }),
      },
      config,
    );
    const scored = (
      await scorer({ patternsOf: () => [{ type: 'CRUD_LIST', confidence: 1, evidence: [] }] })
    ).score(
      find(withDelete, 'Supprimer la sélection'),
      withDelete,
      new FlowGraph(),
      scoringMissionOf(config),
    );
    expect(scored.excluded).toBeDefined();
  });

  it('coverage gain: a little-covered area is preferred; repetition and loops are penalised', async () => {
    const coverage = new CoverageTracker();
    coverage.observeState(users, []);
    const settings = screen(
      { url: 'http://localhost:4200/settings', elements: [button('A'), button('B')] },
      config,
    );
    coverage.observeState(settings, []);
    for (const action of users.actions) coverage.actionExecuted(users.stateId, action, true);
    const scoring = await scorer({ coverage, loopPenaltyOf: () => ({ points: 50, detail: 'A → B → A' }) });
    const toSettings = scoring.score(
      find(users, 'Paramètres'),
      users,
      new FlowGraph(),
      scoringMissionOf(config),
    );
    expect(toSettings.breakdown.coverage).toBe(40); // /settings : 0 %
    expect(toSettings.breakdown.repetition).toBe(-50 - 15);
    expect(coverage.map()).toMatchObject({
      actions: { EXECUTED: 4, DISCOVERED: 2 },
      states: { EXECUTED: 1, DISCOVERED: 1 },
    });
    expect(coverage.areas().map((area) => [area.area, area.ratio])).toEqual([
      ['settings', 0],
      ['users', 1],
    ]);
    expect(areaOf('/users/:id/edit')).toBe('users');
  });
});

describe('NoveltyDetector', () => {
  it('new heading, new actions, new pattern: higher priority than a known screen', () => {
    const graph = new FlowGraph();
    graph.addNode({
      id: users.stateId,
      label: users.stateLabel,
      url: users.url,
      route: users.route,
      headings: users.headings,
      depth: 0,
      actions: users.actions,
    });
    const novelty = new GraphNoveltyDetector(() => new Set(['CRUD_LIST']));
    const fresh = screen(
      { url: 'http://localhost:4200/reports', headings: ['Rapports'], elements: [button('Exporter')] },
      config,
    );
    expect(novelty.evaluate(fresh, graph, undefined, ['DASHBOARD'])).toEqual({
      score: 55,
      reasons: ['new heading', '1 new action(s)', 'new pattern DASHBOARD'],
    });
    const again = screen(
      {
        url: 'http://localhost:4200/users?page=2',
        headings: ['Utilisateurs'],
        elements: [button('Créer utilisateur')],
      },
      config,
    );
    expect(novelty.evaluate(again, graph, undefined, ['CRUD_LIST']).score).toBe(0);
  });
});
