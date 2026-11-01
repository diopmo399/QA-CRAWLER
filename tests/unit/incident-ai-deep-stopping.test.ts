import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAIN_THRESHOLD,
  decisiveContradictions,
  gainThreshold,
  postConfirmationStrategy,
  shouldContinue,
  usefulStrategies,
  type StoppingState,
} from '../../src/incident/ai/deep/stopping.js';
import type {
  AiContradiction,
  GeneratedExperiment,
  InvestigationStrategy,
} from '../../src/sdk/core/incident-ai-contracts.js';

/**
 * LA POLITIQUE D'ARRÊT : on continue tant qu'une stratégie promet un gain ou qu'une contradiction ouverte a une
 * vérification décisive exécutable, avec du budget, sans pause ni annulation ; jamais parce qu'un score est haut ;
 * après une confirmation déterministe, seulement sur les causes contributives et les contradictions.
 */

function strategy(
  partial: Partial<InvestigationStrategy> & Pick<InvestigationStrategy, 'id'>,
): InvestigationStrategy {
  return {
    name: partial.id,
    category: 'CODE',
    applicableLayers: ['BACKEND'],
    prerequisites: [],
    requiredCapabilities: [],
    estimatedCost: 1,
    estimatedRisk: 'LOW',
    expectedInformationGain: 0.5,
    executionMode: 'READ_ONLY',
    status: 'AVAILABLE',
    hypothesisIds: [],
    via: { agent: 'BACKEND' },
    attempts: 0,
    outcomeRefs: [],
    ...partial,
  };
}

function contradiction(partial: Partial<AiContradiction> & Pick<AiContradiction, 'id'>): AiContradiction {
  return {
    hypothesisId: 'hyp-1',
    kind: 'REFUTING_EVIDENCE',
    summary: 'A passing save without the publisher was observed.',
    refs: [{ kind: 'request', id: 'rep_1:req-5-1' }],
    openQuestion: false,
    status: 'OPEN',
    foundBy: 'CONTRADICTION_HUNTER',
    at: '2026-10-30T10:00:00.000Z',
    ...partial,
  };
}

function experiment(
  partial: Partial<GeneratedExperiment> & Pick<GeneratedExperiment, 'id'>,
): GeneratedExperiment {
  return {
    hypothesisId: 'hyp-1',
    kind: 'COMPARE_WITH_PASSING',
    objective: 'Compare with the passing scenario',
    verification: { kind: 'COMPARE_WITH_PASSING', description: 'compare', params: {} },
    resources: [],
    permissions: [],
    risks: [],
    sideEffects: false,
    expected: 'The failing payload lacks the publisher',
    confirmIf: 'differs',
    refuteIf: 'same',
    status: 'PROPOSED',
    requiredEvidence: [],
    prerequisites: [],
    operations: [],
    estimatedCost: 1,
    risk: 'LOW',
    ...partial,
  };
}

function state(partial: Partial<StoppingState> = {}): StoppingState {
  return {
    strategies: [],
    contradictions: [],
    experiments: [],
    confirmedHypothesisIds: [],
    budgetExceeded: undefined,
    cancelled: false,
    paused: false,
    ...partial,
  };
}

describe('shouldContinue', () => {
  it('continues while an available strategy promises a gain above the threshold', () => {
    const decision = shouldContinue(
      state({ strategies: [strategy({ id: 's-1', expectedInformationGain: 0.4 })] }),
    );
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.usefulStrategyIds).toEqual(['s-1']);
  });

  it('ignores strategies that are blocked, completed or not applicable', () => {
    const decision = shouldContinue(
      state({
        strategies: [
          strategy({ id: 'blocked', status: 'BLOCKED', reason: 'no git' }),
          strategy({ id: 'done', status: 'COMPLETED' }),
          strategy({ id: 'na', status: 'NOT_APPLICABLE' }),
          strategy({ id: 'skipped', status: 'SKIPPED' }),
          strategy({ id: 'failed', status: 'FAILED' }),
        ],
      }),
    );
    expect(decision.continue).toBe(false);
    expect(decision.reason).toBe('STRATEGIES_EXHAUSTED');
  });

  it('stops with NO_USEFUL_VERIFICATION when every available strategy is under the threshold', () => {
    const decision = shouldContinue(
      state({ strategies: [strategy({ id: 'weak', expectedInformationGain: 0.05 })] }),
    );
    expect(decision.continue).toBe(false);
    expect(decision.reason).toBe('NO_USEFUL_VERIFICATION');
    expect(decision.detail).toContain(String(DEFAULT_GAIN_THRESHOLD));
  });

  it('honours a custom threshold and falls back to the default for an invalid one', () => {
    expect(gainThreshold({ gainThreshold: 0.6 })).toBe(0.6);
    expect(gainThreshold({ gainThreshold: 7 })).toBe(DEFAULT_GAIN_THRESHOLD);
    expect(gainThreshold({ gainThreshold: Number.NaN })).toBe(DEFAULT_GAIN_THRESHOLD);
    expect(gainThreshold({})).toBe(DEFAULT_GAIN_THRESHOLD);
    const strategies = [strategy({ id: 's', expectedInformationGain: 0.5 })];
    expect(shouldContinue(state({ strategies, gainThreshold: 0.6 })).reason).toBe('NO_USEFUL_VERIFICATION');
    expect(shouldContinue(state({ strategies, gainThreshold: 0.4 })).continue).toBe(true);
  });

  it('continues when an open contradiction has a runnable decisive experiment', () => {
    const decision = shouldContinue(
      state({
        contradictions: [contradiction({ id: 'c-1', proposalId: 'exp-1' })],
        experiments: [experiment({ id: 'exp-1' })],
      }),
    );
    expect(decision.continue).toBe(true);
    expect(decision.decisiveContradictionIds).toEqual(['c-1']);
  });

  it('does not count a contradiction whose experiment is refused, done, missing, or already resolved', () => {
    const s = state({
      contradictions: [
        contradiction({ id: 'refused', proposalId: 'exp-r' }),
        contradiction({ id: 'done', proposalId: 'exp-d' }),
        contradiction({ id: 'missing', proposalId: 'exp-x' }),
        contradiction({ id: 'resolved', proposalId: 'exp-ok', status: 'RESOLVED_CONTRADICTS' }),
        contradiction({ id: 'question', openQuestion: true }),
      ],
      experiments: [
        experiment({ id: 'exp-r', status: 'REFUSED' }),
        experiment({ id: 'exp-d', status: 'DONE' }),
        experiment({ id: 'exp-ok' }),
      ],
    });
    expect(decisiveContradictions(s)).toEqual([]);
    const decision = shouldContinue(s);
    expect(decision.continue).toBe(false);
    expect(decision.reason).toBe('STRATEGIES_EXHAUSTED');
    expect(decision.detail).toContain('4 contradiction(s)');
  });

  it('lets the caller decide what runnable means', () => {
    const awaiting = new Set(['exp-1']);
    const s = state({
      contradictions: [contradiction({ id: 'c-1', proposalId: 'exp-1' })],
      experiments: [experiment({ id: 'exp-1' })],
      isRunnable: (candidate) => candidate.status === 'PROPOSED' && !awaiting.has(candidate.id),
    });
    expect(shouldContinue(s).continue).toBe(false);
  });

  it('never stops because an agent found something: a high score alone changes nothing', () => {
    const strategies = [strategy({ id: 'alt', category: 'ALTERNATIVE', expectedInformationGain: 0.3 })];
    const decision = shouldContinue(state({ strategies }));
    expect(decision.continue).toBe(true);
    expect(decision.reason).not.toBe('GOALS_MET');
  });

  it('after a deterministic confirmation, continues only on contributing or contradiction strategies', () => {
    const confirmed = ['hyp-null-relation'];
    const onConfirmed = strategy({
      id: 'more-on-root',
      hypothesisIds: ['hyp-null-relation'],
      expectedInformationGain: 0.9,
    });
    const contributing = strategy({
      id: 'contrib',
      hypothesisIds: ['hyp-missing-validation'],
      expectedInformationGain: 0.3,
    });
    const hunt = strategy({
      id: 'hunt',
      via: { agent: 'CONTRADICTION_HUNTER' },
      expectedInformationGain: 0.3,
    });
    const alternative = strategy({ id: 'alt', category: 'ALTERNATIVE', expectedInformationGain: 0.3 });

    expect(postConfirmationStrategy(onConfirmed, confirmed)).toBe(false);
    expect(postConfirmationStrategy(contributing, confirmed)).toBe(true);
    expect(postConfirmationStrategy(hunt, confirmed)).toBe(true);
    expect(postConfirmationStrategy(alternative, confirmed)).toBe(true);

    const only = shouldContinue(state({ strategies: [onConfirmed], confirmedHypothesisIds: confirmed }));
    expect(only.continue).toBe(false);
    expect(only.reason).toBe('DETERMINISTIC_CONFIRMED');
    expect(only.detail).toContain('hyp-null-relation');

    const more = shouldContinue(
      state({
        strategies: [onConfirmed, contributing, hunt, alternative],
        confirmedHypothesisIds: confirmed,
      }),
    );
    expect(more.continue).toBe(true);
    expect(more.usefulStrategyIds).toEqual(['contrib', 'hunt', 'alt']);
    expect(usefulStrategies(state({ strategies: [onConfirmed], confirmedHypothesisIds: confirmed }))).toEqual(
      [],
    );
  });

  it('stops on budget exhaustion and timeout even when strategies remain', () => {
    const strategies = [strategy({ id: 's-1' })];
    expect(shouldContinue(state({ strategies, budgetExceeded: 'BUDGET_EXHAUSTED' }))).toMatchObject({
      continue: false,
      reason: 'BUDGET_EXHAUSTED',
    });
    expect(shouldContinue(state({ strategies, budgetExceeded: 'TIMEOUT' }))).toMatchObject({
      continue: false,
      reason: 'TIMEOUT',
    });
  });

  it('stops on cancel first, then pause, before anything else is considered', () => {
    const strategies = [strategy({ id: 's-1' })];
    expect(
      shouldContinue(state({ strategies, cancelled: true, paused: true, budgetExceeded: 'TIMEOUT' })).reason,
    ).toBe('CANCELLED');
    expect(shouldContinue(state({ strategies, paused: true, budgetExceeded: 'TIMEOUT' })).reason).toBe(
      'PAUSED',
    );
  });
});
