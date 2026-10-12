import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport, FlowStepReport } from '../../src/model/flow-run.js';

/** Des résultats d'exploration minimaux pour les tests de la QA platform : rien n'est recalculé, tout est relié. */
export function step(
  index: number,
  description: string,
  extra: Partial<FlowStepReport> = {},
): FlowStepReport {
  return { index, kind: 'click', description, status: 'PASSED', optional: false, durationMs: 100, ...extra };
}

export function flow(
  name: string,
  steps: FlowStepReport[],
  extra: Partial<FlowRunReport> = {},
): FlowRunReport {
  const failed = steps.some((entry) => entry.status === 'FAILED');
  const blocked = steps.some((entry) => entry.status === 'BLOCKED');
  return {
    name,
    status: blocked ? 'BLOCKED' : failed ? 'FAILED' : 'PASSED',
    startedAt: '2026-10-11T10:00:00.000Z',
    durationMs: steps.reduce((sum, entry) => sum + entry.durationMs, 0),
    steps,
    states: steps.map((entry) => entry.stateId).filter((id): id is string => id !== undefined),
    issueIds: [],
    explored: false,
    ...extra,
  };
}

export function result(flows: FlowRunReport[], extra: Partial<ExplorationResult> = {}): ExplorationResult {
  return {
    mission: 'create-and-find',
    mode: 'explore',
    target: { baseUrl: 'http://app.test', startUrl: 'http://app.test/' },
    startedAt: '2026-10-11T10:00:00.000Z',
    finishedAt: '2026-10-11T10:00:10.000Z',
    durationMs: 10_000,
    stopReason: 'flows-only',
    runId: 'run-1',
    stats: {
      states: 2,
      transitions: 1,
      actionsExecuted: 3,
      actionsFailed: 0,
      actionsBlocked: 0,
      issuesBySeverity: { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 },
    },
    states: [
      { id: 'S1', label: 'Home', route: '/', url: 'http://app.test/', visits: 1, issueIds: [] },
      { id: 'S2', label: 'Items', route: '/items', url: 'http://app.test/items', visits: 1, issueIds: [] },
    ],
    transitions: [
      {
        from: 'S1',
        to: 'S2',
        actionId: 'a1',
        action: { type: 'click', category: 'navigation', label: 'Items', classification: 'SAFE' },
        result: 'SUCCESS',
        timestamp: '2026-10-11T10:00:01.000Z',
        durationMs: 120,
        issueIds: [],
        flow: 'create-and-find',
      },
    ],
    flows,
    issues: [],
    settings: {},
    mutations: { enabled: true, executed: 1, autonomous: 0, flows: 1 },
    artifacts: {},
    ...extra,
  } as unknown as ExplorationResult;
}
