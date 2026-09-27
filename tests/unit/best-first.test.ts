import { describe, expect, it } from 'vitest';
import { DecisionTraceRecorder } from '../../src/exploration/decision-trace.js';
import { BudgetTracker, budgetOf } from '../../src/exploration/exploration-budget.js';
import { ExplorationFrontier, type ExplorationContext } from '../../src/exploration/frontier.js';
import {
  BestFirstExplorationStrategy,
  DepthFirstExplorationStrategy,
  effectiveScore,
  seededRandom,
} from '../../src/exploration/strategies.js';
import { StuckDetector } from '../../src/recovery/stuck-detector.js';
import { testConfig } from '../helpers.js';

const at = '2026-09-27T10:00:00Z';
const candidate = (stateId: string, actionId: string, score: number, depth = 1) => ({
  stateId,
  actionId,
  score,
  depth,
  discoveredAt: at,
});
const context = (overrides: Partial<ExplorationContext> = {}): ExplorationContext => ({
  currentStateId: 'users',
  agingBonus: 2,
  switchMargin: 60,
  ...overrides,
});

describe('ExplorationFrontier', () => {
  it('no duplicates: add updates the score, keeps age and attempts; remove / removeState', () => {
    const frontier = new ExplorationFrontier();
    frontier.add(candidate('users', 'create', 120));
    frontier.tick();
    frontier.update('users', 'create', { attempts: 1 });
    const again = frontier.add(candidate('users', 'create', 180));
    expect(frontier.size).toBe(1);
    expect(again).toMatchObject({ score: 180, attempts: 1, waited: 1, sequence: 0 });
    frontier.add(candidate('settings', 'tab', 70));
    frontier.removeState('settings');
    expect(frontier.candidates().map((entry) => entry.actionId)).toEqual(['create']);
    frontier.remove('users', 'create');
    expect(frontier.hasCandidates()).toBe(false);
  });
});

describe('BestFirstExplorationStrategy', () => {
  const strategy = new BestFirstExplorationStrategy();

  it('explores the best allowed candidate: A 180 > B 120 > C 70', () => {
    const frontier = new ExplorationFrontier();
    frontier.add(candidate('users', 'C', 70));
    frontier.add(candidate('users', 'A', 180));
    frontier.add(candidate('users', 'B', 120));
    expect(frontier.next(strategy, context())?.actionId).toBe('A');
    expect(frontier.next(strategy, context({ isAllowed: (entry) => entry.actionId !== 'A' }))?.actionId).toBe(
      'B',
    );
  });

  it('leaves the current screen only for clearly better (switchMargin, travel cost)', () => {
    const frontier = new ExplorationFrontier();
    frontier.add(candidate('users', 'local', 100));
    frontier.add(candidate('reports', 'far', 150));
    expect(frontier.next(strategy, context())?.actionId).toBe('local'); // +50 < marge 60
    frontier.update('reports', 'far', { score: 200 });
    expect(frontier.next(strategy, context())?.actionId).toBe('far');
    expect(frontier.next(strategy, context({ travelCost: () => 50 }))?.actionId).toBe('local');
    // Rien à faire ici : n'importe où ailleurs.
    frontier.remove('users', 'local');
    expect(frontier.next(strategy, context({ travelCost: () => 50 }))?.actionId).toBe('far');
  });

  it('anti-starvation: a low branch is not ignored forever (age bonus)', () => {
    const frontier = new ExplorationFrontier();
    const low = frontier.add(candidate('users', 'low', 10));
    frontier.add(candidate('users', 'high', 50));
    for (let step = 0; step < 25; step++) frontier.tick(frontier.get('users', 'high'));
    expect(effectiveScore(low, context())).toBe(60);
    expect(frontier.next(strategy, context())?.actionId).toBe('low');
  });

  it('deterministic ties: document order by default, reproducible with a seed', () => {
    const frontier = new ExplorationFrontier();
    for (const id of ['a', 'b', 'c', 'd']) frontier.add(candidate('users', id, 100));
    expect(frontier.next(strategy, context())?.actionId).toBe('a');
    const first = frontier.next(strategy, context({ seed: 42 }))?.actionId;
    expect(frontier.next(strategy, context({ seed: 42 }))?.actionId).toBe(first);
    expect(seededRandom(7)()).toBe(seededRandom(7)());
  });

  it('depth-first keeps the historical behaviour: current screen, then the most recent', () => {
    const frontier = new ExplorationFrontier();
    frontier.add(candidate('home', 'old', 500));
    frontier.add(candidate('reports', 'recent', 10));
    const depthFirst = new DepthFirstExplorationStrategy();
    expect(frontier.next(depthFirst, context({ currentStateId: 'nowhere' }))?.actionId).toBe('recent');
    frontier.add(candidate('nowhere', 'here', 1));
    expect(frontier.next(depthFirst, context({ currentStateId: 'nowhere' }))?.actionId).toBe('here');
  });
});

describe('DecisionTraceRecorder', () => {
  it('keeps every decision (bounded) and each selected action with its score', () => {
    const recorder = new DecisionTraceRecorder(2);
    for (const id of ['a', 'b', 'c'])
      recorder.record({
        at,
        stateId: 'users',
        strategy: 'best-first',
        candidates: [{ stateId: 'users', actionId: id, label: `Action ${id}`, score: 100 }],
        selectedActionId: id,
        decision: 'EXECUTE',
        reasons: [],
      });
    expect(recorder.all().map((trace) => trace.selectedActionId)).toEqual(['b', 'c']);
    expect(recorder.selections().map((selection) => selection.label)).toEqual([
      'Action a',
      'Action b',
      'Action c',
    ]);
  });
});

describe('BudgetTracker', () => {
  it('one budget for everything: states, actions, duration, validation and property cases', () => {
    const config = testConfig(
      'propertyTesting: { enabled: true, maxCasesPerRun: 3 }\nexploration: { maxActions: 2 }\n',
    );
    let now = 0;
    const budget = new BudgetTracker(budgetOf(config), 0, () => now);
    expect(budget.budget).toMatchObject({ maxPropertyCases: 3, maxValidationCases: 0, maxMutations: 0 });
    budget.consume('propertyCases', 3);
    expect(budget.allows('propertyCases')).toBe(false);
    expect(budget.exhausted()).toBeUndefined();
    budget.consume('actions', 2);
    expect(budget.exhausted()).toBe('max-actions');
    now = 16 * 60_000;
    expect(new BudgetTracker(budgetOf(config), 0, () => now).exhausted()).toBe('max-duration');
  });
});

describe('StuckDetector V2', () => {
  const detector = (): StuckDetector =>
    new StuckDetector({ oscillationCycles: 2, maxNoOpActions: 5, maxBusyObservations: 5 });
  const walk = (stuck: StuckDetector, states: string[]) =>
    states
      .slice(1)
      .map((to, index) =>
        stuck.observe({ from: states[index] ?? '', to, actionId: `go-${to}`, requests: 1, busy: false }),
      );

  it('A → B → C → A: first penalize the actions of the loop, then backtrack if it comes back', () => {
    const stuck = detector();
    const events = walk(stuck, ['a', 'b', 'c', 'a', 'b', 'c', 'a']).filter(Boolean);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'cycle',
        response: 'penalize',
        message: 'cycle a → b → c → a, 2 times',
        actions: [
          { stateId: 'a', actionId: 'go-b' },
          { stateId: 'b', actionId: 'go-c' },
          { stateId: 'c', actionId: 'go-a' },
        ],
      }),
    ]);
    const again = walk(stuck, ['a', 'b', 'c', 'a', 'b', 'c', 'a']).filter(Boolean);
    expect(again).toEqual([expect.objectContaining({ kind: 'cycle', response: 'backtrack' })]);
  });

  it('A ↔ B stays an oscillation (backtrack); a walk through new screens is not a loop', () => {
    const stuck = detector();
    expect(walk(stuck, ['a', 'b', 'a', 'b']).filter(Boolean)).toEqual([
      expect.objectContaining({ kind: 'oscillation', response: 'backtrack' }),
    ]);
    expect(walk(detector(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).filter(Boolean)).toEqual([]);
  });
});
