import { describe, expect, it } from 'vitest';
import { requirementSchema } from '../../src/config/quality-schema.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { overallStatusOf } from '../../src/platform/run-workflow-analysis.js';
import type { AssertionResult, AssertionStatus } from '../../src/quality/model.js';
import {
  QUALITY_LIMITS,
  buildQualityVerification,
  qualityCountsOf,
} from '../../src/quality/quality-verification.js';

/**
 * LE RAPPORT DE VÉRIFICATION DU RUN et le STATUT GLOBAL : une assertion obligatoire contredite fait
 * échouer le run, une assertion obligatoire non vérifiée le rend INCONCLUSIVE (jamais PASS).
 */
const NOW = new Date('2026-10-17T12:00:00.000Z');

function assertion(id: string, status: AssertionStatus, mandatory = true): AssertionResult {
  return {
    id,
    description: id,
    flow: 'create',
    kind: 'value',
    criticality: 'HIGH',
    mandatory,
    status,
    entities: [],
    expected: 'testData.title',
    observed: 'observed',
    reasons: [],
    evidence: [`create#${id}#e1`],
    attempts: 1,
    durationMs: 4,
  };
}

function flow(
  name: string,
  assertions: AssertionResult[],
  status: FlowRunReport['status'] = 'PASSED',
): FlowRunReport {
  return {
    name,
    status,
    startedAt: NOW.toISOString(),
    durationMs: 100,
    steps: [
      { index: 1, kind: 'click', description: 'Save', status: 'PASSED', optional: false, durationMs: 5 },
    ],
    states: [],
    issueIds: [],
    explored: false,
    quality: {
      verdict: assertions.some((entry) => entry.status === 'FAIL') ? 'FAIL' : 'PASS',
      assertions,
      consistency: [
        {
          id: 'REQUEST_TO_RESPONSE-1',
          flow: name,
          rule: 'REQUEST_TO_RESPONSE',
          status: 'INCONSISTENT',
          sources: [],
          confidence: 0.9,
          limits: [],
          evidence: [],
          declared: true,
        },
        {
          id: 'CREATE_TO_SEARCH-2',
          flow: name,
          rule: 'CREATE_TO_SEARCH',
          status: 'AMBIGUOUS_ENTITY',
          sources: [],
          confidence: 0.5,
          limits: [],
          evidence: [],
          declared: false,
        },
      ],
      evidence: [],
      networkObserved: true,
      durationMs: 40,
    },
  };
}

describe('Run-level business verification', () => {
  it('aggregates flows, metrics and traceability without hiding a failure', () => {
    const report = buildQualityVerification({
      runId: 'run-9',
      flows: [flow('create', [assertion('a', 'PASS'), assertion('b', 'FAIL'), assertion('c', 'BLOCKED')])],
      declared: [
        { name: 'create', requirements: ['REQ-1'], assertions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      ],
      requirements: [
        requirementSchema.parse({ id: 'REQ-1', description: 'Create', criticality: 'CRITICAL' }),
      ],
      rules: [],
      evidenceMaxAgeDays: 30,
      now: NOW,
    });
    expect(report.verdict).toBe('FAIL');
    expect(report.metrics).toMatchObject({
      assertionsDeclared: 3,
      assertionsExecuted: 2,
      assertionsByStatus: { PASS: 1, FAIL: 1, BLOCKED: 1, INCONCLUSIVE: 0, UNVERIFIABLE: 0 },
      requirementsTotal: 1,
      consistencyChecks: 2,
      ambiguousCorrelations: 1,
      verificationMs: 40,
    });
    expect(report.metrics.divergencesByRule.REQUEST_TO_RESPONSE).toBe(1);
    expect(report.traceability.summary.criticalFailures).toEqual(['REQ-1']);
    expect(report.limits).toEqual(QUALITY_LIMITS);
    expect(report.limits[0]).toContain('database persistence are not verified');
  });

  it('counts only mandatory assertions for the overall status', () => {
    const flows = [
      flow('a', [assertion('x', 'PASS'), assertion('y', 'UNVERIFIABLE'), assertion('z', 'FAIL', false)]),
    ];
    expect(qualityCountsOf(flows)).toEqual({ failed: 0, unverified: 1 });
  });

  it('overall status: a failed mandatory assertion is FAIL, an unverified one INCONCLUSIVE, never PASS', () => {
    const base = { anomalies: [], flows: 1, states: 3 };
    expect(overallStatusOf({ ...base, verdict: 'PASSED' }).status).toBe('PASS');
    const failed = overallStatusOf({
      ...base,
      verdict: 'INCONCLUSIVE',
      business: { failed: 2, unverified: 1 },
    });
    expect(failed).toEqual({ status: 'FAIL', reasons: ['2 mandatory business assertion(s) failed'] });
    const unverified = overallStatusOf({
      ...base,
      verdict: 'PROVEN',
      business: { failed: 0, unverified: 1 },
    });
    expect(unverified.status).toBe('INCONCLUSIVE');
    expect(unverified.reasons[0]).toContain('could not be verified');
    expect(
      overallStatusOf({ ...base, verdict: 'PROVEN', business: { failed: 0, unverified: 0 } }).status,
    ).toBe('PASS');
  });
});
