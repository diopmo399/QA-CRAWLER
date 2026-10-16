import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowStepReport } from '../../src/model/flow-run.js';
import type { Issue } from '../../src/model/issue.js';
import { analyzeAnomalies, defects } from '../../src/platform/anomaly-analyzer.js';
import { buildFunctionalCoverage } from '../../src/platform/functional-coverage.js';
import { buildRunWorkflowAnalysis, overallStatusOf } from '../../src/platform/run-workflow-analysis.js';
import { buildWorkflowGraph } from '../../src/platform/workflow-graph.js';
import { flow, result, step } from '../fixtures/qa-platform-results.js';

/**
 * QA PLATFORM — phases 1 à 3 : l'analyse du run de workflow (statut global, anomalies catégorisées
 * symptôme ↔ cause, graphe observé, couverture fonctionnelle). Chaque cas est un ExplorationResult
 * minimal : rien n'est recalculé, tout est relié.
 */
const issue = (extra: Partial<Issue>): Issue => ({
  id: 'ISSUE-0001',
  type: 'HTTP',
  severity: 'ERROR',
  message: 'HTTP 500 on GET /api/items',
  pageUrl: 'http://app.test/items',
  pages: ['http://app.test/items'],
  states: ['S2'],
  timestamp: '2026-10-11T10:00:02.000Z',
  occurrences: 1,
  ...extra,
});

describe('QA platform — anomalies: symptom, probable cause, category', () => {
  it('a failed step with a 5xx is an API_FAILURE; the request is the evidence', () => {
    const anomalies = analyzeAnomalies(
      result([
        flow('f', [
          step(1, 'click Save', {
            status: 'FAILED',
            reason: 'expected route /done',
            network: {
              requests: [{ method: 'POST', path: '/api/items', status: 500, resourceType: 'fetch' }],
              writes: 1,
              errors: 1,
            },
          }),
        ]),
      ]),
    );
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      category: 'API_FAILURE',
      severity: 'ERROR',
      location: { flow: 'f', step: 1 },
    });
    expect(anomalies[0]?.evidence).toContain('POST /api/items → 500');
  });

  it('a 4xx on a step that PASSED is an expected refusal, never a defect', () => {
    const anomalies = analyzeAnomalies(
      result([
        flow('f', [
          step(1, 'click Save', {
            network: {
              requests: [{ method: 'POST', path: '/api/items', status: 422, resourceType: 'fetch' }],
              writes: 1,
              errors: 1,
            },
          }),
          step(2, 'click Save again', {
            network: {
              requests: [{ method: 'POST', path: '/api/items', status: 409, resourceType: 'fetch' }],
              writes: 1,
              errors: 1,
            },
          }),
        ]),
      ]),
    );
    expect(anomalies.map((anomaly) => anomaly.category)).toEqual([
      'EXPECTED_VALIDATION',
      'EXPECTED_BUSINESS_REJECTION',
    ]);
    expect(anomalies.every((anomaly) => anomaly.severity === 'INFO')).toBe(true);
    expect(defects(anomalies)).toHaveLength(0);
  });

  it('a divergence on the target is a UI_FAILURE; a confident engine cause is CONFIRMED, a weak one PROBABLE', () => {
    const divergence = (confidence: number) =>
      ({
        actionId: 'a',
        stepIndex: 1,
        symptom: 'TARGET_NOT_FOUND',
        category: 'TARGET_RENAMED',
        confidence,
        evidence: [{ source: 'RUNTIME', detail: 'button renamed' }],
        possibleCauses: [{ category: 'TARGET_RENAMED', confidence, evidence: [] }],
        rootStepIndex: 1,
        recoverable: true,
      }) as unknown as NonNullable<FlowStepReport['recovery']>['divergence'];
    const recovery = (confidence: number) =>
      ({ divergence: divergence(confidence) }) as unknown as FlowStepReport['recovery'];
    const strong = analyzeAnomalies(
      result([
        flow('f', [
          step(1, 'click Save', { status: 'FAILED', reason: 'not found', recovery: recovery(0.95) }),
        ]),
      ]),
    );
    expect(strong[0]).toMatchObject({ category: 'UI_FAILURE' });
    expect(strong[0]?.confirmedCause?.conclusion).toContain('TARGET_RENAMED');
    expect(strong[0]?.probableCause).toBeUndefined();
    const weak = analyzeAnomalies(
      result([
        flow('f', [
          step(1, 'click Save', { status: 'FAILED', reason: 'not found', recovery: recovery(0.6) }),
        ]),
      ]),
    );
    expect(weak[0]?.probableCause?.confidence).toBe(0.6);
    expect(weak[0]?.confirmedCause).toBeUndefined();
  });

  it('autonomous issues are categorised by type and status; FLOW issues belong to their step', () => {
    const anomalies = analyzeAnomalies(
      result(
        [
          flow('f', [step(1, 'click Save', { status: 'FAILED', reason: 'boom' })], {
            issueIds: ['ISSUE-0003'],
          }),
        ],
        {
          issues: [
            issue({ id: 'ISSUE-0001', status: 500, requestUrl: '/api/items', method: 'GET' }),
            issue({ id: 'ISSUE-0002', type: 'REQUEST_FAILED', message: 'net::ERR_CONNECTION_REFUSED' }),
            issue({ id: 'ISSUE-0003', type: 'FLOW', message: 'Flow "f" — step 1: boom' }),
            issue({ id: 'ISSUE-0004', type: 'AUTHORIZATION', message: 'reader reached /admin' }),
            issue({ id: 'ISSUE-0005', type: 'WRITE_BLOCKED', message: 'blocked' }),
            issue({ id: 'ISSUE-0006', type: 'CONTRACT', message: 'undeclared 201' }),
            issue({
              id: 'ISSUE-0007',
              type: 'INVARIANT',
              message: 'invariant NO-SERVER-ERROR: observed GET /api/stats → 500',
            }),
            issue({
              id: 'ISSUE-INV-0001',
              type: 'INVARIANT',
              message: 'invariant ADMIN-ONLY (reader): expected DENIED, observed ALLOWED',
            }),
          ],
        },
      ),
    );
    expect(anomalies.map((anomaly) => anomaly.category)).toEqual([
      'UNKNOWN_FAILURE',
      'API_FAILURE',
      'NETWORK_FAILURE',
      'AUTHORIZATION_FAILURE',
      'CONTRACT_FAILURE',
      // Un invariant d'écran est un défaut fonctionnel ; seul un invariant d'accès est une autorisation.
      'FUNCTIONAL_FAILURE',
      'AUTHORIZATION_FAILURE',
    ]);
    expect(anomalies[0]?.issueIds).toEqual(['ISSUE-0003']);
    expect(anomalies[4]?.source).toBe('CONTRACT');
    expect(anomalies.map((anomaly) => anomaly.id)).toEqual([
      'ANOMALY-001',
      'ANOMALY-002',
      'ANOMALY-003',
      'ANOMALY-004',
      'ANOMALY-005',
      'ANOMALY-006',
      'ANOMALY-007',
    ]);
  });
});

describe('QA platform — overall status', () => {
  const anomaly = (
    category: 'API_FAILURE' | 'PERFORMANCE_REGRESSION' | 'EXPECTED_VALIDATION' | 'UI_FAILURE',
    severity: 'INFO' | 'WARNING' | 'ERROR',
  ) => ({
    id: 'A',
    category,
    severity,
    symptom: '',
    evidence: [],
    confidence: 1,
    source: 'RUNTIME' as const,
    location: {},
    issueIds: [],
  });
  it('PASS when nothing is wrong, PASS_WITH_WARNINGS on warnings or unverified effects', () => {
    expect(overallStatusOf({ verdict: 'PROVEN', anomalies: [], flows: 1, states: 2 }).status).toBe('PASS');
    expect(
      overallStatusOf({
        verdict: 'PASSED',
        anomalies: [anomaly('EXPECTED_VALIDATION', 'INFO')],
        flows: 1,
        states: 2,
      }).status,
    ).toBe('PASS');
    expect(
      overallStatusOf({
        verdict: 'PASSED',
        anomalies: [anomaly('UI_FAILURE', 'WARNING')],
        flows: 1,
        states: 2,
      }).status,
    ).toBe('PASS_WITH_WARNINGS');
    expect(overallStatusOf({ verdict: 'PASSED_UNVERIFIED', anomalies: [], flows: 1, states: 2 }).status).toBe(
      'PASS_WITH_WARNINGS',
    );
  });
  it('DEGRADED on recovery, performance or visual regression; FAIL on divergence, blocking defect or new regression', () => {
    expect(
      overallStatusOf({ verdict: 'PASSED_WITH_RECOVERY', anomalies: [], flows: 1, states: 2 }).status,
    ).toBe('DEGRADED');
    expect(
      overallStatusOf({
        verdict: 'PASSED',
        anomalies: [anomaly('PERFORMANCE_REGRESSION', 'ERROR')],
        flows: 1,
        states: 2,
      }).status,
    ).toBe('DEGRADED');
    expect(
      overallStatusOf({
        verdict: 'PASSED',
        anomalies: [],
        flows: 1,
        states: 2,
        signals: { visualRegressions: 1 },
      }).status,
    ).toBe('DEGRADED');
    expect(overallStatusOf({ verdict: 'DIVERGED', anomalies: [], flows: 1, states: 2 }).status).toBe('FAIL');
    expect(
      overallStatusOf({
        verdict: 'PASSED',
        anomalies: [anomaly('API_FAILURE', 'ERROR')],
        flows: 1,
        states: 2,
      }).status,
    ).toBe('FAIL');
    expect(
      overallStatusOf({
        verdict: 'PASSED',
        anomalies: [],
        flows: 1,
        states: 2,
        signals: { newRegressions: 1 },
      }).status,
    ).toBe('FAIL');
  });
  it('INCONCLUSIVE when the verdict is, or when nothing ran', () => {
    expect(overallStatusOf({ verdict: 'INCONCLUSIVE', anomalies: [], flows: 1, states: 2 }).status).toBe(
      'INCONCLUSIVE',
    );
    expect(overallStatusOf({ anomalies: [], flows: 0, states: 0 }).status).toBe('INCONCLUSIVE');
  });
});

describe('QA platform — observed workflow graph and functional coverage', () => {
  const report = () =>
    result(
      [
        flow(
          'create-and-find',
          [
            step(1, 'click Items', { stateId: 'S1' }),
            step(2, 'click Save', { stateId: 'S2', status: 'FAILED', reason: 'no effect' }),
            step(3, 'expect /done', { kind: 'expect', status: 'SKIPPED' }),
          ],
          {
            divergence: { stepIndex: 2, description: 'click Save', reason: 'no effect' },
            businessProof: {
              status: 'PARTIAL',
              key: 'item.name',
              evidence: ['CREATE: ok'],
              missing: ['OPEN'],
            },
          },
        ),
      ],
      {
        cognitive: {
          checkpoints: [
            { id: 'item-created', status: 'CONFIRMED' },
            { id: 'item-opened', status: 'NOT_REACHED' },
          ],
          coverageGaps: ['delete item never exercised'],
        } as unknown as ExplorationResult['cognitive'],
        functional: {
          workflows: [{ id: 'CREATE:ITEM', intent: 'create an item', status: 'FAILED' }],
          goals: [{ id: 'G1', intent: 'open an item', status: 'BLOCKED', generatedFrom: 'workflow' }],
        } as unknown as ExplorationResult['functional'],
        authorization: {
          primaryActor: 'primary',
          actors: ['reader'],
          observations: [],
          differences: [],
          errors: [],
          rules: [
            {
              actor: 'reader',
              path: '/admin/*',
              expect: 'denied',
              status: 'PASS',
              checked: 2,
              violations: [],
            },
          ],
        },
      },
    );

  it('the graph annotates screens with the steps, flows and divergences that happened there', () => {
    const graph = buildWorkflowGraph(report());
    expect(graph.summary).toMatchObject({ nodes: 2, edges: 1, coveredByFlows: 2, autonomousOnly: 0 });
    const save = graph.nodes.find((node) => node.id === 'S2');
    expect(save?.steps).toEqual(['create-and-find#2']);
    expect(save?.divergences).toEqual([{ flow: 'create-and-find', step: 2, reason: 'no effect' }]);
    expect(graph.paths[0]).toMatchObject({ states: ['S1', 'S2'], divergence: { step: 2, stateId: 'S2' } });
    expect(graph.edges[0]).toMatchObject({
      from: 'S1',
      to: 'S2',
      label: 'Items',
      result: 'SUCCESS',
      flow: 'create-and-find',
    });
    expect(graph.checkpoints).toHaveLength(2);
  });

  it('the coverage graph gives every functional element a five-valued status with its evidence', () => {
    const coverage = buildFunctionalCoverage(report());
    const byId = Object.fromEntries(coverage.items.map((item) => [item.id, item.status]));
    expect(byId).toEqual({
      'flow:create-and-find': 'PARTIALLY_COVERED',
      'proof:create-and-find': 'PARTIALLY_COVERED',
      'checkpoint:item-created': 'COVERED',
      'checkpoint:item-opened': 'NOT_COVERED',
      'workflow:CREATE:ITEM': 'COVERED',
      'goal:G1': 'BLOCKED',
      'authorization:reader:/admin/*': 'COVERED',
      'gap:1': 'NOT_COVERED',
    });
    expect(coverage.summary).toMatchObject({
      total: 8,
      COVERED: 3,
      PARTIALLY_COVERED: 2,
      NOT_COVERED: 2,
      BLOCKED: 1,
    });
    expect(coverage.byKind.FLOW.PARTIALLY_COVERED).toBe(1);
  });

  it('the run analysis report composes everything, takes the DEEP path on a divergence and explains its status', () => {
    const analysis = buildRunWorkflowAnalysis(report());
    expect(analysis.overallStatus).toBe('FAIL');
    expect(analysis.path).toBe('DEEP');
    expect(analysis.statusReasons[0]).toMatch(/blocking defect/);
    expect(analysis.execution.flows[0]).toMatchObject({ divergence: { step: 2 }, businessProof: 'PARTIAL' });
    expect(analysis.execution.flows[0]?.steps[1]).toMatchObject({ status: 'FAILED', stateId: 'S2' });
    expect(analysis.anomalySummary).toMatchObject({
      total: 1,
      defects: 1,
      byCategory: { FUNCTIONAL_FAILURE: 1 },
    });
    expect(analysis.findings[0]).toMatchObject({ conclusion: 'overall status FAIL', source: 'RUNTIME' });
    expect(
      analysis.findings.every((finding) => finding.evidence.length > 0 || finding.confidence === 1),
    ).toBe(true);
  });

  it('a clean run takes the FAST path and passes', () => {
    const analysis = buildRunWorkflowAnalysis(
      result([flow('f', [step(1, 'click Items', { stateId: 'S2' })])]),
    );
    expect(analysis).toMatchObject({ overallStatus: 'PASS', path: 'FAST' });
    expect(analysis.anomalies).toEqual([]);
  });
});
