import { describe, expect, it } from 'vitest';
import {
  confidenceLevel,
  describeConfidence,
  DeterministicConfidenceEngine,
  sampleConfidence,
} from '../../src/intelligence/confidence-engine.js';
import { confidenceEngineOf, knowledgeContextOf } from '../../src/intelligence/intelligence.js';
import { effectiveObservations, recencyWeight } from '../../src/intelligence/knowledge-aging.js';
import {
  contextSimilarity,
  viewportClassOf,
  type KnowledgeContext,
} from '../../src/intelligence/knowledge-context.js';
import { summarizeKnowledge } from '../../src/intelligence/knowledge-summary.js';
import { HistoricalTransitionAnomalyDetector } from '../../src/knowledge/historical-detectors.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import type { TransitionKnowledge } from '../../src/knowledge/knowledge-model.js';
import { testConfig } from '../helpers.js';

const NOW = '2026-06-01T12:00:00.000Z';
const now = (): string => NOW;
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const context: KnowledgeContext = {
  applicationId: 'app.test@dev',
  environment: 'dev',
  actor: 'admin',
  version: 'v2',
  browser: 'chromium',
  viewportClass: 'desktop',
};
const { applicationId: _ignored, ...sameContext } = context;

function knowledge(overrides: Partial<TransitionKnowledge> = {}): TransitionKnowledge {
  return {
    fromStateSignature: 'users-list',
    actionSignature: 'click:create-user',
    targets: { 'create-user-form': 20 },
    executionCount: 20,
    successCount: 20,
    failureCount: 0,
    firstSeenAt: daysAgo(10),
    lastSeenAt: NOW,
    lastContext: sameContext,
    ...overrides,
  };
}

const engine = new DeterministicConfidenceEngine({
  sampleHalfPoint: 5,
  aging: { halfLifeDays: 30, minWeight: 0.05 },
  compareContext: true,
  now,
});

describe('sample confidence: grows progressively, no brutal threshold', () => {
  it('1, 5, 20, 100, 1000 observations', () => {
    const values = [1, 5, 20, 100, 1000].map((n) => sampleConfidence(n, 5));
    expect(values.map((value) => Math.round(value * 1000) / 1000)).toEqual([0.167, 0.5, 0.8, 0.952, 0.995]);
    for (let index = 1; index < values.length; index++)
      expect(values[index]).toBeGreaterThan(values[index - 1] ?? 1);
    expect(values.every((value) => value < 1)).toBe(true);
    expect(sampleConfidence(0)).toBe(0);
  });

  it('levels: VERY_LOW < 0.2 ≤ LOW < 0.4 ≤ MEDIUM < 0.6 ≤ HIGH < 0.8 ≤ VERY_HIGH', () => {
    expect([0, 0.19, 0.2, 0.39, 0.4, 0.59, 0.6, 0.79, 0.8, 0.99].map(confidenceLevel)).toEqual([
      'VERY_LOW',
      'VERY_LOW',
      'LOW',
      'LOW',
      'MEDIUM',
      'MEDIUM',
      'HIGH',
      'HIGH',
      'VERY_HIGH',
      'VERY_HIGH',
    ]);
  });
});

describe('knowledge aging: old knowledge weighs less, never nothing', () => {
  it('500 observations 10 months ago weigh less than 80 seen yesterday', () => {
    const old = effectiveObservations(500, daysAgo(300), NOW);
    const recent = effectiveObservations(80, daysAgo(1), NOW);
    expect(old).toBeLessThan(1);
    expect(recent).toBeGreaterThan(75);
    expect(recent).toBeGreaterThan(old);
  });

  it('recency: 1 today, 0.5 after one half-life, the floor for very old knowledge', () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
    expect(recencyWeight(daysAgo(30), NOW)).toBeCloseTo(0.5, 5);
    expect(recencyWeight(daysAgo(3000), NOW)).toBe(0.05);
    expect(recencyWeight(daysAgo(3000), NOW, { halfLifeDays: 30, minWeight: 0.2 })).toBe(0.2);
    expect(recencyWeight(undefined, NOW)).toBe(1);
  });
});

describe('contextual knowledge', () => {
  it('same context: similarity 1', () => {
    expect(contextSimilarity(sameContext, context)).toEqual({ score: 1, differences: [], unknown: [] });
  });

  it('another actor, version or environment lowers the similarity, explained', () => {
    const actor = contextSimilarity({ ...sameContext, actor: 'user' }, context);
    expect(actor.score).toBe(0.5);
    expect(actor.differences).toEqual([{ dimension: 'actor', observed: 'user', current: 'admin' }]);
    expect(contextSimilarity({ ...sameContext, version: 'v1' }, context).score).toBe(0.85);
    expect(contextSimilarity({ ...sameContext, environment: 'prod' }, context).score).toBe(0.7);
    expect(contextSimilarity({ ...sameContext, environment: 'prod', actor: 'user' }, context).score).toBe(
      0.35,
    );
  });

  it('an unknown dimension does not penalize, but is said', () => {
    const similarity = contextSimilarity(undefined, context);
    expect(similarity.score).toBe(1);
    expect(similarity.unknown).toEqual(['environment', 'actor', 'version', 'browser', 'viewportClass']);
  });

  it('viewport classes', () => {
    expect([375, 768, 1199, 1280].map(viewportClassOf)).toEqual(['mobile', 'tablet', 'tablet', 'desktop']);
  });
});

describe('ConfidenceEngine', () => {
  it('confidence = sample × stability × recency × context, every factor explained', () => {
    const result = engine.evaluate(knowledge({ targets: { 'create-user-form': 19, login: 1 } }), context);
    expect(result.observations).toBe(20);
    expect(result.score).toBe(0.76); // 0.8 × 0.95 × 1 × 1
    expect(result.level).toBe('HIGH');
    expect(result.reasons.map((reason) => reason.factor)).toEqual([
      'sample',
      'stability',
      'recency',
      'context',
    ]);
    expect(describeConfidence(result)).toBe(
      '0.76 HIGH (20 observation(s); stability 0.95; recency 1; context 1)',
    );
  });

  it('weak data never gives strong certainty: 2 identical observations stay LOW', () => {
    const result = engine.evaluate(knowledge({ targets: { 'create-user-form': 2 } }), context);
    expect(result.score).toBe(0.286);
    expect(result.level).toBe('LOW');
  });

  it('old knowledge and another context lower the confidence', () => {
    const old = engine.evaluate(knowledge({ lastSeenAt: daysAgo(60) }), context);
    expect(old.score).toBe(0.2); // 0.8 × 1 × 0.25
    expect(old.reasons[2]?.detail).toBe('last seen 60 day(s) ago');
    const otherActor = engine.evaluate(
      knowledge({ lastContext: { ...sameContext, actor: 'user' } }),
      context,
    );
    expect(otherActor.score).toBe(0.4);
    expect(otherActor.reasons[3]?.detail).toBe('actor user ≠ admin');
  });

  it('aging and context can be disabled separately', () => {
    const plain = new DeterministicConfidenceEngine({ sampleHalfPoint: 5, compareContext: false, now });
    const result = plain.evaluate(
      knowledge({ lastSeenAt: daysAgo(300), lastContext: { ...sameContext, actor: 'user' } }),
      context,
    );
    expect(result.score).toBe(0.8);
    expect(result.reasons.map((reason) => reason.detail).slice(2)).toEqual([
      'aging disabled',
      'context not compared',
    ]);
  });

  it('no observation: confidence 0', () => {
    const result = engine.evaluate(knowledge({ targets: {} }), context);
    expect(result).toMatchObject({ score: 0, level: 'VERY_LOW', observations: 0 });
  });
});

describe('historical detector with the ConfidenceEngine', () => {
  const detectorOptions = { halfLifeDays: 30, minObservations: 1, dominance: 0.8 };
  const observed = {
    fromStateSignature: 'users-list',
    actionSignature: 'click:create-user',
    toStateSignature: 'login',
  };

  it('low confidence never gives a POTENTIAL_REGRESSION', () => {
    const detector = new HistoricalTransitionAnomalyDetector({
      ...detectorOptions,
      confidence: (entry) => engine.evaluate(entry, context),
    });
    const weak = detector.evaluate(observed, knowledge({ targets: { 'create-user-form': 2 } }));
    expect(weak?.category).not.toBe('POTENTIAL_REGRESSION');
    expect(weak?.confidenceResult?.level).toBe('LOW');
    const strong = detector.evaluate(observed, knowledge());
    expect(strong?.category).toBe('POTENTIAL_REGRESSION');
    expect(strong?.confidence).toBe(0.8);
    expect(strong?.message).toContain('confidence 0.8 VERY_HIGH (20 observation(s)');
    // Même historique, mais observé pour un autre acteur il y a longtemps : pas de régression.
    const stale = detector.evaluate(
      observed,
      knowledge({ lastSeenAt: daysAgo(90), lastContext: { ...sameContext, actor: 'user' } }),
    );
    expect(stale?.category).not.toBe('POTENTIAL_REGRESSION');
  });

  it('without the engine: the previous behaviour (no confidence detail)', () => {
    const detector = new HistoricalTransitionAnomalyDetector(detectorOptions);
    const anomaly = detector.evaluate(observed, knowledge());
    expect(anomaly?.category).toBe('POTENTIAL_REGRESSION');
    expect(anomaly?.confidenceResult).toBeUndefined();
    expect(anomaly?.message).not.toContain('confidence');
  });
});

describe('configuration', () => {
  it('disabled by default: no engine', () => {
    expect(testConfig().intelligence).toEqual({
      enabled: false,
      confidence: { enabled: true, sampleHalfPoint: 5 },
      aging: { enabled: true, minWeight: 0.05 },
      context: { enabled: true },
    });
    expect(confidenceEngineOf(testConfig())).toBeUndefined();
    expect(
      confidenceEngineOf(testConfig('intelligence: { enabled: true, confidence: { enabled: false } }')),
    ).toBeUndefined();
  });

  it('enabled: aging half-life from the knowledge settings unless overridden; flags honoured', () => {
    const entry = knowledge({ lastSeenAt: daysAgo(10), lastContext: { ...sameContext, actor: 'user' } });
    const withDefaults = confidenceEngineOf(
      testConfig('intelligence: { enabled: true }\nknowledge: { halfLifeDays: 10 }'),
      now,
    );
    expect(withDefaults?.evaluate(entry, context).reasons.map((reason) => reason.value)).toEqual([
      0.8, 1, 0.5, 0.5,
    ]);
    const overridden = confidenceEngineOf(
      testConfig(
        'intelligence: { enabled: true, aging: { halfLifeDays: 20 }, context: { enabled: false } }\nknowledge: { halfLifeDays: 10 }',
      ),
      now,
    );
    expect(overridden?.evaluate(entry, context).reasons.map((reason) => reason.value)).toEqual([
      0.8, 1, 0.707, 1,
    ]);
    const noAging = confidenceEngineOf(
      testConfig('intelligence: { enabled: true, aging: { enabled: false } }'),
      now,
    );
    expect(noAging?.evaluate(entry, context).reasons[2]?.detail).toBe('aging disabled');
  });

  it('unknown keys are refused', () => {
    expect(() => testConfig('intelligence: { enabled: true, llm: true }')).toThrow();
  });

  it('current context: application, environment, actor, version, browser, viewport class', () => {
    expect(
      knowledgeContextOf(testConfig(), {
        application: 'app.test',
        environment: 'dev',
        commit: 'abc',
        schemaVersion: 1,
      }),
    ).toEqual({
      applicationId: 'app.test@dev',
      environment: 'dev',
      actor: testConfig().authorization.primaryActor,
      version: 'abc',
      browser: 'chromium',
      viewportClass: viewportClassOf(testConfig().browser.viewport.width),
    });
  });
});

describe('knowledge summary and contextual recording', () => {
  it('the working memory stamps the context of the last observation', () => {
    const kb = JsonKnowledgeBase.inMemory({});
    kb.setObservationContext({ actor: 'user' });
    kb.recordTransition({
      fromStateSignature: 'a',
      actionSignature: 'click:b',
      toStateSignature: 'c',
      success: true,
    });
    expect(kb.getTransitionKnowledge('a', 'click:b')?.lastContext).toEqual({ actor: 'user' });
    kb.setObservationContext({ actor: 'admin' });
    kb.recordTransition({
      fromStateSignature: 'a',
      actionSignature: 'click:b',
      toStateSignature: 'c',
      success: true,
    });
    expect(kb.getTransitionKnowledge('a', 'click:b')?.lastContext).toEqual({ actor: 'admin' });
  });

  it('counts per level, aged, other context; the most observed first', () => {
    const summary = summarizeKnowledge(
      [
        knowledge({ fromStateSignature: 'a', targets: { x: 2 } }),
        knowledge({ fromStateSignature: 'b', lastSeenAt: daysAgo(90) }),
        knowledge({ fromStateSignature: 'c', lastContext: { ...sameContext, version: 'v1' } }),
        knowledge({ fromStateSignature: 'd', targets: { x: 100 } }),
      ],
      engine,
      context,
      3,
    );
    expect(summary.transitions).toBe(4);
    expect(summary.levels).toEqual({ VERY_LOW: 1, LOW: 1, MEDIUM: 0, HIGH: 1, VERY_HIGH: 1 });
    expect(summary.aged).toBe(1);
    expect(summary.otherContext).toBe(1);
    expect(summary.entries.map((entry) => entry.fromStateSignature)).toEqual(['d', 'b', 'c']);
    expect(summary.entries[0]).toMatchObject({ dominantTarget: 'x', dominantShare: 1 });
  });
});
