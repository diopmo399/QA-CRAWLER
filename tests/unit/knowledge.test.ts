import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiStatusAnomaly,
  HistoricalTransitionAnomalyDetector,
  performanceAnomaly,
} from '../../src/knowledge/historical-detectors.js';
import {
  JsonKnowledgeBase,
  knowledgeIdentityOf,
  migrateKnowledge,
} from '../../src/knowledge/json-knowledge-base.js';
import { actionSignature, stateSignature } from '../../src/knowledge/signatures.js';
import { decayFactor, median, percentile } from '../../src/knowledge/statistics.js';
import { testConfig } from '../helpers.js';

const options = { halfLifeDays: 30, minObservations: 3, dominance: 0.8 };
const identity = { application: 'app.test', schemaVersion: 1 };

function recordCreate(kb: JsonKnowledgeBase, target: string, times: number): void {
  for (let index = 0; index < times; index++)
    kb.recordTransition({
      fromStateSignature: 'users-list',
      actionSignature: 'click:create-user',
      toStateSignature: target,
      success: true,
    });
}

describe('JsonKnowledgeBase', () => {
  it('counts executions, successes and failures per action signature; failures per application version', () => {
    const kb = JsonKnowledgeBase.inMemory({ commit: 'abc' });
    kb.recordActionResult({ actionSignature: 'click:save', result: 'SEEN' });
    kb.recordActionResult({ actionSignature: 'click:save', result: 'FAILED', durationMs: 100 });
    kb.recordActionResult({ actionSignature: 'click:save', result: 'FAILED', durationMs: 300 });
    kb.recordActionResult({ actionSignature: 'click:save', result: 'BLOCKED' });
    expect(kb.getActionKnowledge('click:save')).toMatchObject({
      seenCount: 1,
      executionCount: 2,
      failureCount: 2,
      blockedCount: 1,
      averageDurationMs: 200,
      failuresOnVersion: 2,
      failureVersion: 'abc',
    });
    kb.recordActionResult({ actionSignature: 'click:save', result: 'SUCCESS' });
    expect(kb.getActionKnowledge('click:save')?.failuresOnVersion).toBe(0);
  });

  it('HISTORICAL expectation: the dominant target, only with enough observations', () => {
    const kb = JsonKnowledgeBase.inMemory({}, options);
    recordCreate(kb, 'create-user-form', 2);
    expect(kb.expectationFor('users-list', 'click:create-user')).toBeUndefined(); // 2 < 3
    recordCreate(kb, 'create-user-form', 16);
    recordCreate(kb, 'error-page', 1);
    expect(kb.expectationFor('users-list', 'click:create-user')).toMatchObject({
      target: 'create-user-form',
      share: 0.95,
      observations: 19,
    });
    expect(kb.actionsLeadingTo((state) => state.includes('user'))).toEqual(['click:create-user']);
  });

  it('API statuses and durations without any body; learned hints stay hints', () => {
    const kb = JsonKnowledgeBase.inMemory();
    for (let index = 0; index < 17; index++) kb.recordApiCall('POST /api/users', 201, 120);
    kb.recordApiCall('POST /api/users', 400, 80);
    expect(kb.getApiKnowledge('POST /api/users')?.statuses).toEqual({ '201': 17, '400': 1 });
    for (let index = 0; index < 12; index++) kb.recordOutcomePatterns('Ajouter', ['CREATE_FORM']);
    kb.recordOutcomePatterns('Ajouter', ['CRUD_LIST']);
    expect(kb.hintFor('ajouter')).toMatchObject({ pattern: 'CREATE_FORM', count: 12, total: 13 });
    expect(kb.hintFor('Voir')).toBeUndefined();
  });

  it('saves a versioned file, one entry per application and environment, and loads it back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-kb-'));
    const file = path.join(dir, 'knowledge.json');
    const first = new JsonKnowledgeBase(file, { ...identity, environment: 'dev' }, options);
    first.startRun();
    recordCreate(first, 'create-user-form', 3);
    await first.save();
    const other = new JsonKnowledgeBase(file, { ...identity, environment: 'qa' }, options);
    await other.load();
    expect(other.getTransitionKnowledge('users-list', 'click:create-user')).toBeUndefined(); // jamais mélangées
    await other.save();
    const again = new JsonKnowledgeBase(file, { ...identity, environment: 'dev' }, options);
    await again.load();
    expect(again.snapshot.runs).toBe(1);
    expect(again.getTransitionKnowledge('users-list', 'click:create-user')?.executionCount).toBe(3);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number; applications: object };
    expect(saved.schemaVersion).toBe(1);
    expect(Object.keys(saved.applications)).toEqual(['app.test@dev', 'app.test@qa']);
  });

  it('migrates the v0 format; ignores a newer format instead of overwriting it', async () => {
    const migrated = migrateKnowledge({
      identity: { application: 'a' },
      updatedAt: '',
      runs: 2,
      actions: {},
    });
    expect(migrated?.applications['a@default']?.runs).toBe(2);
    expect(migrateKnowledge({ schemaVersion: 99, applications: {} })).toBeUndefined();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-kb-'));
    const file = path.join(dir, 'knowledge.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 99, applications: { x: {} } }));
    const kb = new JsonKnowledgeBase(file, identity, options);
    await kb.load();
    expect(kb.snapshot.runs).toBe(0);
  });

  it('identity: the host of the application, the version from CI variables', () => {
    const config = testConfig().knowledge;
    expect(
      knowledgeIdentityOf(config, 'http://app.test:4200/x', { GITHUB_SHA: 'f00', QA_ENVIRONMENT: 'dev' }),
    ).toMatchObject({
      application: 'app.test:4200',
      commit: 'f00',
      environment: 'dev',
    });
  });
});

describe('historical detectors', () => {
  it('UNEXPECTED_TRANSITION: Users --Create--> Login instead of the form (95 %) is a potential regression', () => {
    const kb = JsonKnowledgeBase.inMemory({}, options);
    recordCreate(kb, 'create-user-form', 19);
    const history = kb.getTransitionKnowledge('users-list', 'click:create-user');
    if (!history) throw new Error('no history');
    const detector = new HistoricalTransitionAnomalyDetector(options);
    const anomaly = detector.evaluate(
      { fromStateSignature: 'users-list', actionSignature: 'click:create-user', toStateSignature: 'login' },
      history,
    );
    expect(anomaly).toMatchObject({
      kind: 'UNEXPECTED_TRANSITION',
      category: 'POTENTIAL_REGRESSION',
      expectation: { target: 'create-user-form', share: 1, observations: 19 },
    });
    expect(anomaly?.confidence).toBeGreaterThan(0.5);
    expect(
      detector.evaluate(
        {
          fromStateSignature: 'users-list',
          actionSignature: 'click:create-user',
          toStateSignature: 'create-user-form',
        },
        history,
      ),
    ).toBeNull();
    // Vers un autre écran ordinaire : inhabituel, pas une régression.
    expect(
      detector.evaluate(
        {
          fromStateSignature: 'users-list',
          actionSignature: 'click:create-user',
          toStateSignature: 'user-detail',
        },
        history,
      )?.category,
    ).toBe('UNEXPECTED_BEHAVIOR');
  });

  it('unusual API status family, and PERFORMANCE_WARNING above the median × factor', () => {
    const api = {
      operation: 'POST /api/users',
      statuses: { '201': 17, '400': 3 },
      durations: [],
      lastSeenAt: '',
    };
    expect(apiStatusAnomaly(500, api, 3)?.message).toBe(
      'POST /api/users answered 500; historically 201 → 17, 400 → 3',
    );
    expect(apiStatusAnomaly(422, api, 3)).toBeUndefined(); // 4xx déjà vu
    const perf = {
      key: 'click:save',
      kind: 'action' as const,
      durations: [100, 110, 120, 130, 140],
      lastSeenAt: '',
    };
    expect(performanceAnomaly(1000, perf, 3)?.message).toContain('median 120 ms');
    expect(performanceAnomaly(300, perf, 3)).toBeUndefined();
  });
});

describe('statistics and signatures', () => {
  it('median, p95, decay', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(decayFactor('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', 30)).toBeCloseTo(0.5);
  });

  it('signatures are stable across runs: no ids, no numbers', () => {
    expect(actionSignature({ type: 'click', text: 'Créer utilisateur', elementType: 'button' })).toBe(
      'click:creer-utilisateur',
    );
    expect(actionSignature({ type: 'navigate', text: 'Voir 42', elementType: 'a' })).toBe('navigate:voir-#');
    expect(stateSignature('Utilisateurs 3')).toBe('utilisateurs-#');
  });
});
