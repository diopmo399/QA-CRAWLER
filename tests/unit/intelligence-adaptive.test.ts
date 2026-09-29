import { describe, expect, it } from 'vitest';
import { RuleBasedActionScorer, scoringMissionOf } from '../../src/decision/action-scorer.js';
import { AdvancedActionScorer } from '../../src/decision/advanced-action-scorer.js';
import { explainScore, scoreEquation } from '../../src/decision/score-breakdown.js';
import { FlowGraph } from '../../src/graph/flow-graph.js';
import { ADAPTIVE_BOUNDS, AdaptiveActionScorer } from '../../src/intelligence/adaptive-scoring.js';
import { adaptiveScorerOf } from '../../src/intelligence/intelligence.js';
import { noveltyScore } from '../../src/intelligence/novelty-score.js';
import {
  DEFAULT_STABILITY,
  describeStability,
  stabilityScore,
} from '../../src/intelligence/stability-score.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import { actionSignature, stateSignature } from '../../src/knowledge/signatures.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { button, link, screen, structure, testConfig } from '../helpers.js';

const NOW = '2026-06-01T12:00:00.000Z';
const now = (): string => NOW;
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const aging = { halfLifeDays: 30, minWeight: 0.05 };

describe('NoveltyScore', () => {
  const options = { sampleHalfPoint: 5, aging, now };

  it('never executed: NEW, novelty 1', () => {
    expect(noveltyScore({ executions: 0, usedThisRun: 0 }, options)).toMatchObject({
      score: 1,
      level: 'NEW',
      reasons: ['never executed in previous runs'],
    });
  });

  it('decreases progressively with the executions', () => {
    const scores = [1, 5, 20, 100].map(
      (executions) => noveltyScore({ executions, usedThisRun: 0, lastExecutedAt: NOW }, options).score,
    );
    expect(scores).toEqual([0.833, 0.5, 0.2, 0.048]);
  });

  it('500 executions 10 months ago are rare again; 80 yesterday are familiar', () => {
    const old = noveltyScore({ executions: 500, usedThisRun: 0, lastExecutedAt: daysAgo(300) }, options);
    expect(old.level).toBe('RARE');
    expect(old.score).toBeGreaterThan(0.9);
    expect(old.reasons[0]).toMatch(/^500 past execution\(s\), last 300 day\(s\) ago ≈ 0\.\d+ effective$/);
    const recent = noveltyScore({ executions: 80, usedThisRun: 0, lastExecutedAt: daysAgo(1) }, options);
    expect(recent.level).toBe('FAMILIAR');
    // Sans vieillissement : 500 exécutions restent 500.
    expect(
      noveltyScore({ executions: 500, usedThisRun: 0, lastExecutedAt: daysAgo(300) }, { sampleHalfPoint: 5 })
        .level,
    ).toBe('FAMILIAR');
  });

  it('the executions of this run count, and are not counted twice as history', () => {
    const result = noveltyScore({ executions: 2, usedThisRun: 2, lastExecutedAt: NOW }, options);
    expect(result.effectiveHistory).toBe(0);
    expect(result.score).toBe(0.714);
    expect(result.reasons).toEqual(['never executed in previous runs', '2 execution(s) in this run']);
  });
});

describe('StabilityScore', () => {
  const steady = [100, 110, 105, 120, 98, 102, 115, 108, 111, 99];

  it('always the same result, destination and duration: STABLE, p50 / p95 from the samples', () => {
    const result = stabilityScore({
      successes: 20,
      failures: 0,
      targets: { form: 20 },
      durations: steady,
    });
    expect(result).toMatchObject({ score: 1, level: 'STABLE', confidence: 0.8, p50: 105, p95: 120 });
    expect(describeStability(result)).toBe(
      'STABLE' === result.level
        ? '1 STABLE (confidence 0.8; outcome 1: 20/20 succeeded; destination 1: 20/20 to the same destination (1 destination(s)); timing 1: p50 105 ms, p95 120 ms over 10 sample(s))'
        : '',
    );
  });

  it('half failures and two destinations: UNSTABLE, explained', () => {
    const result = stabilityScore({ successes: 10, failures: 10, targets: { form: 12, error: 8 } });
    expect(result.score).toBe(0.3);
    expect(result.level).toBe('UNSTABLE');
    expect(result.factors.map((factor) => factor.value)).toEqual([0.5, 0.6, undefined]);
  });

  it('very variable durations lower the timing factor', () => {
    const result = stabilityScore({
      successes: 10,
      failures: 0,
      durations: [100, 100, 100, 100, 100, 100, 100, 100, 100, 1500],
    });
    expect(result.factors[2]).toMatchObject({ factor: 'timing', value: 0.2 });
    expect(result.level).toBe('UNSTABLE');
  });

  it('too few duration samples: no p50 / p95, timing not scored (never from an average)', () => {
    const result = stabilityScore({ successes: 10, failures: 0, durations: [100, 5000] });
    expect(result.p50).toBeUndefined();
    expect(result.p95).toBeUndefined();
    expect(result.factors[2]).toEqual({
      factor: 'timing',
      detail: '2 duration sample(s) < 5: timing not scored',
    });
    expect(result.level).toBe('STABLE');
  });

  it('weak data never gives a strong verdict: 2 failures are UNCERTAIN, not UNSTABLE', () => {
    const result = stabilityScore({ successes: 0, failures: 2 }, DEFAULT_STABILITY);
    expect(result.score).toBe(0);
    expect(result.level).toBe('UNCERTAIN');
    expect(stabilityScore({ successes: 0, failures: 0 }).level).toBe('UNCERTAIN');
  });
});

const config = testConfig(
  'safety: { mutations: { enabled: true }, allowedActionClasses: [SAFE, MUTATION] }\n',
);
const dictionary = new SemanticDictionary();
const weights = { goalWeight: 1, patternWeight: 1, noveltyWeight: 1, coverageWeight: 1, historyWeight: 1 };
const users = screen(
  {
    url: 'http://localhost:4200/users',
    headings: ['Utilisateurs'],
    elements: [link('Paramètres', 'http://localhost:4200/settings'), button('Supprimer la sélection')],
    structure: structure({ tables: 1, tableRows: 2 }),
  },
  config,
);
const find = (context: PageContext, text: string): DiscoveredAction => {
  const action = context.actions.find((candidate) => candidate.text === text);
  if (!action) throw new Error(`no action ${text}`);
  return action;
};
const settings = find(users, 'Paramètres');
const signature = actionSignature(settings);

function scorers(knowledge: JsonKnowledgeBase, historyAvailable = true) {
  const inner = new AdvancedActionScorer(new RuleBasedActionScorer(new SafetyPolicy(config.safety)), {
    dictionary,
    weights,
    patternsOf: () => [],
    knowledge,
  });
  const adaptive = new AdaptiveActionScorer(inner, {
    historyAvailable,
    weights: { confidenceWeight: 1, noveltyWeight: 1, stabilityWeight: 1 },
    sampleHalfPoint: 5,
    novelty: { enabled: true, aging },
    stability: { enabled: true, ...DEFAULT_STABILITY },
    knowledge,
    now,
  });
  const score = (scorer: AdvancedActionScorer | AdaptiveActionScorer, action = settings) =>
    scorer.score(action, users, new FlowGraph(), scoringMissionOf(config));
  return { inner, adaptive, score };
}

function executions(knowledge: JsonKnowledgeBase, successes: number, failures: number, at: string): void {
  for (let index = 0; index < successes; index++)
    knowledge.recordActionResult({ actionSignature: signature, result: 'SUCCESS', at });
  for (let index = 0; index < failures; index++)
    knowledge.recordActionResult({ actionSignature: signature, result: 'FAILED', at });
}

describe('AdaptiveScoring', () => {
  it('no history available (memory.enabled: false): exactly the previous score', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    executions(knowledge, 2, 0, NOW);
    const { inner, adaptive, score } = scorers(knowledge, false);
    expect(score(adaptive)).toEqual(score(inner));
    expect(score(adaptive).breakdown.adaptive).toBe(0);
  });

  it('2 historical successes are not 200: the historical success is weighted by its confidence', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    executions(knowledge, 2, 0, NOW);
    const { inner, adaptive, score } = scorers(knowledge);
    const before = score(inner);
    const after = score(adaptive);
    const historical = before.breakdown.history;
    expect(historical).toBe(20);
    const reason = after.breakdown.details.find((detail) => detail.code === 'history-confidence');
    expect(reason).toMatchObject({
      factor: 'adaptive',
      points: -14,
      params: { confidence: 0.286, observations: 2 },
    });
    // 2 exécutions seulement : aussi « peu explorée » (nouveauté 0,714 → +18).
    expect(
      after.breakdown.details.filter((detail) => detail.factor === 'adaptive').map((detail) => detail.code),
    ).toEqual(['history-confidence', 'rarely-explored']);
    expect(after.breakdown.adaptive).toBe(-14 + 18);
    expect(after.score).toBe(before.score + 4);
    // Beaucoup d'observations : la confiance est haute, l'ajustement faible.
    const many = JsonKnowledgeBase.inMemory({});
    executions(many, 200, 0, NOW);
    const manyScorers = scorers(many);
    expect(manyScorers.score(manyScorers.adaptive).breakdown.adaptive).toBe(0);
  });

  it('rarely explored before (old history): a small, explained bonus', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    executions(knowledge, 3, 0, daysAgo(200));
    const { adaptive, score } = scorers(knowledge);
    const rare = score(adaptive).breakdown.details.find((detail) => detail.code === 'rarely-explored');
    expect(rare?.points).toBeGreaterThan(15);
    expect(rare?.params?.detail).toMatch(/^3 past execution\(s\), last 200 day\(s\) ago/);
  });

  it('unstable history, with enough observations: a penalty, never an exclusion', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    executions(knowledge, 10, 10, NOW);
    for (let index = 0; index < 10; index++)
      knowledge.recordTransition({
        fromStateSignature: stateSignature(users.stateLabel),
        actionSignature: signature,
        toStateSignature: index % 2 === 0 ? 'settings' : 'error',
        success: index % 2 === 0,
        at: NOW,
      });
    const { adaptive, score } = scorers(knowledge);
    const scored = score(adaptive);
    expect(scored.excluded).toBeUndefined();
    const unstable = scored.breakdown.details.find((detail) => detail.code === 'unstable-history');
    expect(unstable?.points).toBeLessThan(0);
    expect(scored.breakdown.adaptive).toBeGreaterThanOrEqual(ADAPTIVE_BOUNDS.min);
    // 2 échecs seulement : incertain, aucune pénalité d'instabilité.
    const weak = JsonKnowledgeBase.inMemory({});
    executions(weak, 0, 2, NOW);
    const weakScorers = scorers(weak);
    expect(
      weakScorers
        .score(weakScorers.adaptive)
        .breakdown.details.some((detail) => detail.code === 'unstable-history'),
    ).toBe(false);
  });

  it('an excluded action stays excluded (SafetyPolicy and pattern rules are never bypassed)', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    const remove = find(users, 'Supprimer la sélection');
    for (let index = 0; index < 3; index++)
      knowledge.recordActionResult({
        actionSignature: actionSignature(remove),
        result: 'SUCCESS',
        at: daysAgo(300),
      });
    const inner = new AdvancedActionScorer(new RuleBasedActionScorer(new SafetyPolicy(config.safety)), {
      dictionary,
      weights,
      patternsOf: () => [{ type: 'CRUD_LIST', confidence: 1, evidence: [] }],
      knowledge,
    });
    const adaptive = new AdaptiveActionScorer(inner, {
      historyAvailable: true,
      weights: { confidenceWeight: 2, noveltyWeight: 2, stabilityWeight: 2 },
      sampleHalfPoint: 5,
      novelty: { enabled: true, aging },
      stability: { enabled: true, ...DEFAULT_STABILITY },
      knowledge,
      now,
    });
    const scored = adaptive.score(remove, users, new FlowGraph(), scoringMissionOf(config));
    expect(scored.excluded).toBeDefined();
    expect(scored.breakdown.adaptive).toBe(0);
  });

  it('every score is explained: the equation, then each reason', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    executions(knowledge, 2, 0, NOW);
    const { adaptive, score } = scorers(knowledge);
    const { breakdown } = score(adaptive);
    expect(scoreEquation(breakdown)).toMatch(/^\d+ = base \d+ \+ history 20 \+ adaptive 4$/);
    expect(explainScore(breakdown)).toContain('-14 historical success trusted at 0.286 (2 execution(s))');
    expect(explainScore(breakdown, 'fr')).toContain('-14 succès historique pris à 0.286 (2 exécution(s))');
  });
});

describe('configuration', () => {
  const inner = new AdvancedActionScorer(new RuleBasedActionScorer(new SafetyPolicy(config.safety)), {
    dictionary,
    weights,
    patternsOf: () => [],
  });
  const knowledge = JsonKnowledgeBase.inMemory({});

  it('disabled by default, even when intelligence is enabled', () => {
    expect(testConfig().intelligence.adaptiveScoring).toEqual({
      enabled: false,
      confidenceWeight: 1,
      noveltyWeight: 1,
      stabilityWeight: 1,
    });
    expect(adaptiveScorerOf(testConfig(), inner, { knowledge, historyAvailable: true })).toBe(inner);
    expect(
      adaptiveScorerOf(testConfig('intelligence: { enabled: true }'), inner, {
        knowledge,
        historyAvailable: true,
      }),
    ).toBe(inner);
    expect(
      adaptiveScorerOf(testConfig('intelligence: { adaptiveScoring: { enabled: true } }'), inner, {
        knowledge,
        historyAvailable: true,
      }),
    ).toBe(inner);
  });

  it('enabled: the adaptive scorer; novelty and stability have their own flags', () => {
    const enabled = testConfig(
      'intelligence: { enabled: true, adaptiveScoring: { enabled: true }, stability: { enabled: false, minDurationSamples: 8 } }',
    );
    const scorer = adaptiveScorerOf(enabled, inner, { knowledge, historyAvailable: true });
    expect(scorer).toBeInstanceOf(AdaptiveActionScorer);
    expect((scorer as AdaptiveActionScorer).signalsOf(settings, users).stability).toBeUndefined();
    expect((scorer as AdaptiveActionScorer).signalsOf(settings, users).novelty?.level).toBe('NEW');
    expect(() => testConfig('intelligence: { adaptiveScoring: { enabled: true, weight: 9 } }')).toThrow();
    expect(() => testConfig('intelligence: { stability: { minConfidence: 2 } }')).toThrow();
  });
});
