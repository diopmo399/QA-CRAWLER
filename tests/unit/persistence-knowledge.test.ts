import { describe, expect, it } from 'vitest';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import { actionSignature, stateSignature } from '../../src/knowledge/signatures.js';
import { HistoricalOracle } from '../../src/oracles/historical-oracle.js';
import { KnowledgeService } from '../../src/persistence/knowledge-service.js';
import { InMemoryPersistenceProvider } from '../../src/persistence/memory/in-memory-provider.js';
import type { TransitionObservation } from '../../src/persistence/model.js';
import { screen } from '../helpers.js';

const APP = 'app.test';
const at = (day: number): string => `2026-01-${String(day).padStart(2, '0')}T10:00:00.000Z`;
const observed = (overrides: Partial<TransitionObservation> = {}): TransitionObservation => ({
  applicationId: APP,
  fromStateSignature: 'users',
  actionSignature: 'click:create',
  toStateSignature: 'create-form',
  seen: 1,
  success: 1,
  failure: 0,
  blocked: 0,
  durationTotalMs: 100,
  durationCount: 1,
  firstSeenAt: at(1),
  lastSeenAt: at(1),
  ...overrides,
});

const workingMemory = () =>
  JsonKnowledgeBase.inMemory({ application: APP }, { minObservations: 3, dominance: 0.8 });

describe('KnowledgeService: long-term memory → working memory', () => {
  it('probabilities come from observations; several destinations are kept for the same action', async () => {
    const provider = new InMemoryPersistenceProvider();
    await provider.knowledge.record([
      observed({ seen: 97, success: 97, durationTotalMs: 9700, durationCount: 97 }),
      observed({ toStateSignature: 'login', seen: 2, success: 2 }),
      observed({ toStateSignature: 'error-page', seen: 1, success: 1 }),
    ]);
    const service = new KnowledgeService(provider.knowledge, APP, workingMemory());
    expect(await service.preload({ maxStates: 100, maxTransitions: 100 })).toEqual({
      states: 4,
      transitions: 3,
    });
    expect(service.getTransitionKnowledge('users', 'click:create')).toEqual({
      executions: 100,
      targets: [
        { stateSignature: 'create-form', count: 97, probability: 0.97 },
        { stateSignature: 'login', count: 2, probability: 0.02 },
        { stateSignature: 'error-page', count: 1, probability: 0.01 },
      ],
    });
    expect(service.getTransitionKnowledge('users', 'click:unknown')).toBeUndefined();
  });

  it('the preload respects the budget: the most recent rows, the most recent screens', async () => {
    const provider = new InMemoryPersistenceProvider();
    await provider.knowledge.record([
      observed({ fromStateSignature: 'old', lastSeenAt: at(1) }),
      observed({ fromStateSignature: 'mid', lastSeenAt: at(2) }),
      observed({ fromStateSignature: 'new', lastSeenAt: at(3) }),
      observed({ fromStateSignature: 'new', actionSignature: 'click:edit', lastSeenAt: at(4) }),
    ]);
    const memory = workingMemory();
    const loaded = await new KnowledgeService(provider.knowledge, APP, memory).preload({
      maxStates: 2,
      maxTransitions: 3,
    });
    expect(loaded.transitions).toBe(3);
    expect(memory.getTransitionKnowledge('old', 'click:create')).toBeUndefined();
    expect(memory.getTransitionKnowledge('mid', 'click:create')).toBeDefined();
    const tight = workingMemory();
    await new KnowledgeService(provider.knowledge, APP, tight).preload({ maxStates: 1, maxTransitions: 10 });
    expect(tight.getTransitionKnowledge('new', 'click:edit')).toBeDefined();
    expect(tight.getTransitionKnowledge('mid', 'click:create')).toBeUndefined();
  });

  it('observations are buffered and written as increments: the preloaded history is never counted twice', async () => {
    const provider = new InMemoryPersistenceProvider();
    await provider.knowledge.record([observed({ seen: 5, success: 5 })]);
    const service = new KnowledgeService(provider.knowledge, APP, workingMemory());
    await service.preload({ maxStates: 10, maxTransitions: 10 });
    service.observeState('users');
    service.observeState('reports');
    service.observeTransition({
      fromStateSignature: 'users',
      actionSignature: 'click:create',
      toStateSignature: 'create-form',
      result: 'SUCCESS',
      durationMs: 40,
      at: at(5),
    });
    service.observeTransition({
      fromStateSignature: 'users',
      actionSignature: 'click:delete',
      result: 'BLOCKED',
      at: at(5),
    });
    service.observeTransition({
      fromStateSignature: 'users',
      actionSignature: 'click:export',
      toStateSignature: 'users',
      result: 'FAILED',
      durationMs: 30,
      at: at(5),
    });
    expect(service.pending).toBe(3);
    // Rien n'est écrit avant le flush : pas une requête par observation.
    expect(await provider.knowledge.find(APP, 'users', 'click:delete')).toEqual([]);
    await service.flush();
    expect(service.pending).toBe(0);
    const [create] = await provider.knowledge.find(APP, 'users', 'click:create');
    expect(create).toMatchObject({ seenCount: 6, successCount: 6 });
    expect(await provider.knowledge.find(APP, 'users', 'click:delete')).toEqual([
      expect.objectContaining({ toStateSignature: '(none)', blockedCount: 1, seenCount: 1 }),
    ]);
    expect((await provider.knowledge.find(APP, 'users', 'click:export'))[0]).toMatchObject({
      toStateSignature: '(none)',
      failureCount: 1,
    });
    expect(service.statistics).toEqual({
      historicalStatesLoaded: 2,
      historicalTransitionsLoaded: 1,
      newStatesLearned: 1,
      newTransitionsLearned: 2,
    });
  });

  it('a failed write keeps the observations for the next flush', async () => {
    const provider = new InMemoryPersistenceProvider();
    let fail = true;
    const flaky = {
      ...provider.knowledge,
      record: (observations: readonly TransitionObservation[]) =>
        fail ? Promise.reject(new Error('database gone')) : provider.knowledge.record(observations),
    };
    const service = new KnowledgeService(flaky, APP, workingMemory());
    service.observeTransition({
      fromStateSignature: 'users',
      actionSignature: 'click:create',
      toStateSignature: 'create-form',
      result: 'SUCCESS',
      at: at(1),
    });
    await expect(service.flush()).rejects.toThrow('database gone');
    expect(service.pending).toBe(1);
    fail = false;
    await service.flush();
    expect(await provider.knowledge.find(APP, 'users', 'click:create')).toHaveLength(1);
  });
});

describe('history is an expectation, never a business truth', () => {
  it('19 of 20 executions reached the create form; this one reached an error page → POTENTIAL_REGRESSION, not a confirmed bug', async () => {
    const provider = new InMemoryPersistenceProvider();
    // Plusieurs runs : Users → Create → Create Form, 19 fois ; une autre fois vers la liste.
    for (let day = 1; day <= 19; day++)
      await provider.knowledge.record([observed({ firstSeenAt: at(day), lastSeenAt: at(day) })]);
    await provider.knowledge.record([observed({ toStateSignature: 'users-list', lastSeenAt: at(20) })]);

    const memory = workingMemory();
    const service = new KnowledgeService(provider.knowledge, APP, memory);
    await service.preload({ maxStates: 100, maxTransitions: 100 });
    expect(service.getTransitionKnowledge('users', 'click:create')?.targets[0]).toEqual({
      stateSignature: 'create-form',
      count: 19,
      probability: 0.95,
    });

    const before = screen({ title: 'Users', headings: ['Users'] });
    const after = screen({ title: 'Error Page', headings: ['Error Page'] });
    expect(stateSignature(before.stateLabel)).toBe('users');
    const action = {
      id: 'a1',
      type: 'click' as const,
      category: 'other' as const,
      classification: 'SAFE' as const,
      text: 'Create',
      result: 'SUCCESS' as const,
    };
    expect(actionSignature({ ...action, elementType: '' })).toBe('click:create');
    const verdict = await new HistoricalOracle(memory, {
      minObservations: 3,
      dominance: 0.8,
      slowFactor: 3,
    }).evaluate(before, action, after, { issues: [], network: [], pageCrashed: false });
    expect(verdict.status).toBe('WARNING');
    expect(verdict.category).toBe('POTENTIAL_REGRESSION');
    expect(verdict.status).not.toBe('FAIL');
    expect(verdict.reasons[0]?.message).toBe(
      'UNEXPECTED_TRANSITION: historically "click:create" led to "create-form" (19/20), this time to "error-page"',
    );
  });
});
