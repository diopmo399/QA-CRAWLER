import { describe, expect, it } from 'vitest';
import { RuleBasedGoalMatcher } from '../../src/goals/goal-matcher.js';
import type { GoalState } from '../../src/goals/goal-model.js';
import { missionOf, RuleBasedGoalPlanner } from '../../src/goals/goal-planner.js';
import { GoalTracker } from '../../src/goals/goal-tracker.js';
import { FlowGraph } from '../../src/graph/flow-graph.js';
import { RuleBasedPatternDetector } from '../../src/patterns/pattern-detector.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { button, field, link, screen, structure, testConfig } from '../helpers.js';

const dictionary = new SemanticDictionary({ synonyms: { user: ['utilisateur', 'membre'] } });
const planner = new RuleBasedGoalPlanner(dictionary, { blockedConcepts: new Set(['delete']) });
const matcher = new RuleBasedGoalMatcher(dictionary);
const detector = new RuleBasedPatternDetector(dictionary);

const home = screen({ url: 'http://localhost:4200/', headings: ['Tableau de bord'] });
const byId = (goals: readonly GoalState[], id: string): GoalState => {
  const goal = goals.find((candidate) => candidate.id === id);
  if (!goal) throw new Error(`no goal ${id}`);
  return goal;
};

describe('GoalPlanner', () => {
  it('turns goals into functional sub-goals, never clicks; shared sub-goals once', async () => {
    const config = testConfig('goals: [users, create-user, delete-user, permissions]\n');
    const plan = await planner.plan(missionOf(config), home, new FlowGraph());
    const ids = plan.goals.map((goal) => goal.id);
    expect(ids).toEqual([
      'users',
      'find:user',
      'explore:user',
      'create-user',
      'action:create-user',
      'reach:create-user',
      'delete-user',
      'action:delete-user',
      'reach:delete-user',
      'permissions',
      'find:permission',
      'explore:permission',
    ]);
    expect(byId(plan.goals, 'reach:create-user')).toMatchObject({
      kind: 'reach-pattern',
      concept: 'create',
      subject: 'user',
      patterns: ['CREATE_FORM', 'WIZARD'],
      dependsOn: ['action:create-user'],
      status: 'PENDING',
    });
    // Supprimer est bloqué par la SafetyPolicy : l'objectif l'est dès le départ, avec sa raison.
    expect(byId(plan.goals, 'reach:delete-user')).toMatchObject({ status: 'BLOCKED' });
    expect(byId(plan.goals, 'users').priority).toBeGreaterThan(byId(plan.goals, 'permissions').priority);
  });

  it('the object form of a goal (priority, keywords) and goals.keywords as a fallback', async () => {
    const config = testConfig('goals:\n  keywords: [parking]\n');
    const plan = await planner.plan(missionOf(config), home, new FlowGraph());
    expect(plan.goals.map((goal) => goal.id)).toEqual(['parking', 'find:parking', 'explore:parking']);
  });
});

describe('GoalMatcher', () => {
  const locate: GoalState = {
    id: 'find:user',
    description: 'find "user"',
    status: 'PENDING',
    priority: 10,
    evidence: [],
    kind: 'locate',
    subject: 'user',
    dependsOn: [],
    keywords: [],
    hints: [],
  };

  it('REACHED only with observable evidence: URL, heading, region, breadcrumb — in French too', () => {
    const users = screen({
      url: 'http://localhost:4200/admin/utilisateurs',
      headings: ['Gestion des membres'],
    });
    const match = matcher.evaluate(locate, users);
    expect(match.reached).toBe(true);
    expect(match.evidence.map((entry) => entry.kind)).toEqual(['url', 'heading']);
    const byRegion = screen({ structure: structure({ regions: ['Liste des utilisateurs'] }) });
    expect(matcher.evaluate(locate, byRegion).evidence[0]).toMatchObject({ kind: 'region' });
  });

  it('a button that talks about the goal brings closer, but does not prove it', () => {
    const page = screen({
      headings: ['Accueil'],
      elements: [link('Utilisateurs', 'http://localhost:4200/x')],
    });
    expect(matcher.evaluate(locate, page).reached).toBe(false);
    const [action] = page.actions;
    expect(action && matcher.relevance(locate, action, page)).toBe(1);
  });
});

describe('GoalTracker', () => {
  it('follows the plan: active goal, evidence, mission reached when all its sub-goals are', async () => {
    const config = testConfig('goals: [create-user]\n');
    const tracker = new GoalTracker(await planner.plan(missionOf(config), home, new FlowGraph()), matcher);
    expect(tracker.active()?.id).toBe('find:user');

    const list = screen({
      url: 'http://localhost:4200/users',
      headings: ['Utilisateurs'],
      elements: [button('Nouvel utilisateur'), link('Voir', 'http://localhost:4200/users/1')],
      structure: structure({ tables: 1, tableRows: 1 }),
    });
    expect(tracker.observe(list, detector.detect(list)).map((goal) => goal.id)).toEqual([
      'find:user',
      'action:create-user',
    ]);
    expect(tracker.active()?.id).toBe('reach:create-user');
    // Le bouton « Nouvel utilisateur » sert l'objectif actif.
    const [create] = list.actions;
    expect(create && tracker.relevance(create, list)).toMatchObject({ goalId: 'reach:create-user' });

    const form = screen({
      url: 'http://localhost:4200/users/new',
      headings: ['Nouvel utilisateur'],
      elements: [
        field('Nom', { required: true, formGroup: 'form:0' }),
        button('Enregistrer', { isSubmit: true, formIndex: 0, formGroup: 'form:0' }),
      ],
    });
    const reached = tracker.observe(form, detector.detect(form)).map((goal) => goal.id);
    expect(reached).toEqual(['reach:create-user', 'create-user']);
    expect(tracker.goals.find((goal) => goal.id === 'create-user')?.evidence.length).toBeGreaterThan(0);
  });

  it('what was never observed ends UNREACHABLE; a blocked sub-goal blocks its mission goal', async () => {
    const config = testConfig('goals: [users, delete-user]\n');
    const tracker = new GoalTracker(await planner.plan(missionOf(config), home, new FlowGraph()), matcher);
    tracker.finalize('max-actions');
    expect(byId(tracker.goals, 'users')).toMatchObject({ status: 'UNREACHABLE' });
    expect(byId(tracker.goals, 'delete-user')).toMatchObject({ status: 'BLOCKED' });
  });
});
