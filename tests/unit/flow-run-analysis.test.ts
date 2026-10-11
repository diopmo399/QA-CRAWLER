import { describe, expect, it } from 'vitest';
import { describeFlowIntent } from '../../src/dry-run/flow-intent-graph.js';
import { businessProofOf } from '../../src/flows/business-proof.js';
import { compareFlowRuns, flowRunMemoryOf } from '../../src/flows/flow-run-comparison.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport, FlowStepReport, StepRequestReport } from '../../src/model/flow-run.js';
import { flowAnalysisBlocks, targetHowOf } from '../../src/reporting/flow-analysis-section.js';
import { dataSection } from '../../src/reporting/quality-sections.js';

/**
 * ANALYSE D'UN FLOW EXÉCUTÉ : la preuve métier (CREATE → SEARCH → OPEN), l'écart avec le run
 * précédent, et la section du rapport qui les montre — tout vient du rapport du flow.
 */
const request = (method: string, path: string, status = 200): StepRequestReport => ({
  method,
  path,
  status,
  durationMs: 12,
  resourceType: 'fetch',
});

function step(
  index: number,
  description: string,
  extra: Partial<FlowStepReport> & { requests?: StepRequestReport[] } = {},
): FlowStepReport {
  const { requests, ...rest } = extra;
  return {
    index,
    kind: description.split(' ')[0] ?? 'click',
    description,
    status: 'PASSED',
    optional: false,
    durationMs: 100,
    ...(requests
      ? {
          network: {
            requests,
            writes: requests.filter((entry) => entry.method !== 'GET').length,
            errors: requests.filter((entry) => (entry.status ?? 0) >= 400).length,
          },
        }
      : {}),
    ...rest,
  };
}

function flowOf(
  steps: FlowStepReport[],
  usedBy: { step: number; how: 'INPUT' | 'CITATION' }[],
): FlowRunReport {
  return {
    name: 'create-and-find',
    status: steps.every((entry) => entry.status === 'PASSED') ? 'PASSED' : 'FAILED',
    startedAt: '2026-10-11T10:00:00.000Z',
    durationMs: steps.reduce((sum, entry) => sum + entry.durationMs, 0),
    steps,
    states: [],
    issueIds: [],
    explored: false,
    testDataReport: {
      entries: [
        {
          key: 'company.name',
          strategy: 'GENERATE_AT_REPLAY',
          generator: 'company',
          sensitive: false,
          value: 'Test Company QA-CRAWLER-r1',
          producedAt: usedBy.find((use) => use.how === 'INPUT')?.step,
          usedBy,
        },
      ],
    },
  };
}

const PROVEN_STEPS = (): FlowStepReport[] => [
  step(1, 'click role=button[name="New company"]'),
  step(2, 'fill label="Display label" = ${testData:company.name}', { testData: undefined }),
  step(3, 'click role=button[name="Save"]', { requests: [request('POST', '/api/companies', 204)] }),
  step(4, 'fill label="Search companies" = ${testData:company.name}'),
  step(5, 'click role=button[name="Search"]', { requests: [request('POST', '/api/companies/search')] }),
  step(6, 'click role=button[name="${testData:company.name}"]', {
    testData: ['testData.company.name'],
    url: '/companies/123456',
    requests: [request('GET', '/api/companies/123456')],
  }),
];
const PROVEN_USES = [
  { step: 2, how: 'INPUT' as const },
  { step: 4, how: 'INPUT' as const },
  { step: 6, how: 'CITATION' as const },
];

describe('Business proof of an executed flow (CREATE → SEARCH → OPEN)', () => {
  it('PROVEN: the generated datum is typed, written, searched with the same value, and its result opened', () => {
    const proof = businessProofOf(flowOf(PROVEN_STEPS(), PROVEN_USES));
    expect(proof).toMatchObject({
      status: 'PROVEN',
      key: 'company.name',
      creation: { step: 3, request: 'POST /api/companies → 204' },
      search: { step: 4, request: 'POST /api/companies/search → 200' },
      open: { step: 6, request: 'GET /api/companies/123456 → 200' },
      missing: [],
    });
    expect(proof.evidence.join('\n')).toMatch(/CREATE: testData\.company\.name typed at step 2/);
    expect(proof.evidence.join('\n')).toMatch(/OPEN: the target of step 6 cites testData\.company\.name/);
  });

  it('PARTIAL: the created value is searched but never opened — what is missing is named', () => {
    const steps = PROVEN_STEPS().slice(0, 5);
    const proof = businessProofOf(flowOf(steps, PROVEN_USES.slice(0, 2)));
    expect(proof.status).toBe('PARTIAL');
    expect(proof.missing.join('\n')).toContain('never opened');
    expect(proof.open).toBeUndefined();
  });

  it('NOT_PROVEN: a stage ran but failed (the search step is FAILED)', () => {
    const steps = PROVEN_STEPS();
    const search = steps[3];
    if (search) search.status = 'FAILED';
    const proof = businessProofOf(flowOf(steps, PROVEN_USES));
    expect(proof.status).toBe('NOT_PROVEN');
    expect(proof.missing.join('\n')).toContain('step 4 is FAILED');
  });

  it('NOT_APPLICABLE: no datum is reused by a later step', () => {
    const proof = businessProofOf(flowOf(PROVEN_STEPS().slice(0, 3), [{ step: 2, how: 'INPUT' }]));
    expect(proof.status).toBe('NOT_APPLICABLE');
  });

  it('no accepted write after the input: the creation is missing (PARTIAL), never invented', () => {
    const steps = PROVEN_STEPS();
    const save = steps[2];
    if (save) save.network = { requests: [request('POST', '/api/companies', 409)], writes: 1, errors: 1 };
    const proof = businessProofOf(flowOf(steps, PROVEN_USES));
    expect(proof.creation).toBeUndefined();
    expect(proof.missing.join('\n')).toContain('no accepted write');
  });
});

describe('Comparison with the previous run of the same flow', () => {
  it('SAME: identical status, steps and pace', () => {
    const flow = flowOf(PROVEN_STEPS(), PROVEN_USES);
    const previous = flowRunMemoryOf(flow, 'run-1');
    const comparison = compareFlowRuns(previous, { ...flow, startedAt: '2026-10-12T10:00:00.000Z' });
    expect(comparison).toMatchObject({ verdict: 'SAME', changes: [], durationDeltaMs: 0 });
    expect(comparison.previous).toMatchObject({ runId: 'run-1', status: 'PASSED' });
  });

  it('CHANGED: a slower step, a healed target, a changed status and a removed step are each named', () => {
    const before = flowOf(PROVEN_STEPS(), PROVEN_USES);
    const open = before.steps[5];
    if (open)
      open.effect = {
        execution: 'EXECUTED',
        status: 'CONFIRMED',
        expected: [],
        observed: [],
        reasons: [],
        recovery: [],
        locator: 'role=button[name="X"]',
      };
    const previous = flowRunMemoryOf(before, 'run-1');
    const after = flowOf(PROVEN_STEPS().slice(0, 5), PROVEN_USES);
    const search = after.steps[3];
    if (search) search.durationMs = 2000;
    const save = after.steps[2];
    if (save) {
      save.status = 'FAILED';
      save.effect = {
        execution: 'EXECUTED',
        status: 'WRONG_EFFECT',
        expected: [],
        observed: [],
        reasons: [],
        recovery: [],
        locator: 'css=#save-2',
        healed: { from: 'css=#save', to: 'css=#save-2' },
      };
    }
    after.status = 'FAILED';
    const comparison = compareFlowRuns(previous, after);
    expect(comparison.verdict).toBe('CHANGED');
    const kinds = comparison.changes.map((change) => `${change.kind}@${String(change.step ?? '')}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'FLOW_STATUS@',
        'STEP_STATUS@3',
        'TARGET_HEALED@3',
        'STEP_SLOWER@4',
        'STEP_REMOVED@6',
      ]),
    );
    // Un localisateur n'est comparé qu'entre deux étapes qui l'ont rapporté : pas de faux changement.
    expect(kinds.filter((kind) => kind.startsWith('TARGET_CHANGED'))).toEqual([]);
  });

  it('the knowledge base keeps the last run of each flow (status, durations, locators — never a value)', () => {
    const knowledge = JsonKnowledgeBase.inMemory();
    expect(knowledge.flowRunMemory('create-and-find')).toBeUndefined();
    knowledge.rememberFlowRun(
      'create-and-find',
      flowRunMemoryOf(flowOf(PROVEN_STEPS(), PROVEN_USES), 'run-1'),
    );
    const memory = knowledge.flowRunMemory('create-and-find');
    expect(memory).toMatchObject({ runId: 'run-1', status: 'PASSED' });
    expect(JSON.stringify(memory)).not.toContain('Test Company QA-CRAWLER-r1');
    expect(JSON.stringify(knowledge.snapshot)).toContain('"flowRuns"');
  });
});

describe('The report: analysis blocks of an executed flow', () => {
  const flow = (): FlowRunReport => {
    const report = flowOf(PROVEN_STEPS(), PROVEN_USES);
    const save = report.steps[2];
    if (save) {
      save.effect = {
        execution: 'EXECUTED',
        status: 'CONFIRMED',
        expected: ['route /tasks', '+ textbox:Search companies'],
        observed: ['route /tasks'],
        reasons: [],
        recovery: [],
        locator: 'role=button[name="Save"]',
      };
      save.synchronization = {
        execution: 'EXECUTED',
        transition: 'NEXT_ACTION_READY',
        signals: ['URL_CHANGED'],
        missing: [],
        stability: { stable: true, durationMs: 160 },
        durationMs: 420,
        nextAction: 'READY',
      };
      save.timing = { totalMs: 900, actionMs: 500, transitionMs: 420, stabilityMs: 160, verificationMs: 400 };
    }
    report.comparison = {
      previous: { runId: 'run-1', at: '2026-10-10T10:00:00.000Z', status: 'PASSED', durationMs: 500 },
      verdict: 'CHANGED',
      durationDeltaMs: 100,
      changes: [{ kind: 'STEP_SLOWER', step: 3, detail: '300 ms → 900 ms' }],
    };
    report.businessProof = businessProofOf(report);
    return report;
  };

  it('shows the seven analyses in French, with the generated value and never a step reason hidden', () => {
    const html = flowAnalysisBlocks(flow(), 'fr');
    for (const title of [
      'Données de test de ce run',
      'Preuve métier',
      'Écart avec le run précédent',
      'Réseau par étape',
      'Résolution des cibles',
      'Effets attendus / observés',
      'Temps par étape',
    ])
      expect(html).toContain(title);
    expect(html).toContain('Test Company QA-CRAWLER-r1');
    expect(html).toContain('PROVEN');
    expect(html).toContain('POST /api/companies');
    expect(html).toContain('+ textbox:Search companies'); // attendu, non observé
    expect(html).toContain('Non observé');
    expect(html).toContain('STEP_SLOWER');
    expect(html).toContain('run précédent run-1');
    expect(html).toContain('Étapes les plus lentes');
  });

  it('a sensitive datum shows (secret), a recorded one (not shown): never the value', () => {
    const report = flow();
    report.testDataReport = {
      entries: [
        {
          key: 'login.password',
          strategy: 'CREDENTIAL_REFERENCE',
          sensitive: true,
          value: 'never',
          usedBy: [],
        },
        {
          key: 'request.title',
          strategy: 'RECORDED_LITERAL',
          sensitive: false,
          usedBy: [{ step: 2, how: 'INPUT' }],
        },
      ],
    };
    const html = flowAnalysisBlocks(report, 'en');
    expect(html).toContain('(secret)');
    expect(html).toContain('(not shown)');
    expect(html).not.toContain('hunter2-secret-value');
  });

  it('target resolution: how each target was found, from what the step reported', () => {
    expect(targetHowOf(step(1, 'click x'))).toBeUndefined();
    expect(
      targetHowOf(
        step(1, 'click x', {
          effect: {
            execution: 'EXECUTED',
            status: 'CONFIRMED',
            expected: [],
            observed: [],
            reasons: [],
            recovery: [],
            locator: 'css=#a',
          },
        }),
      ),
    ).toBe('RECORDED');
    expect(
      targetHowOf(
        step(1, 'click x', {
          effect: {
            execution: 'EXECUTED',
            status: 'CONFIRMED',
            expected: [],
            observed: [],
            reasons: [],
            recovery: [],
            healed: { from: 'a', to: 'b' },
          },
        }),
      ),
    ).toBe('HEALED');
    expect(
      targetHowOf(
        step(1, 'click x', {
          synchronization: {
            execution: 'EXECUTED',
            transition: 'NEXT_ACTION_READY',
            signals: [],
            missing: [],
            stability: { stable: true, durationMs: 1 },
            durationMs: 1,
            nextAction: 'READY',
            reacquired: 'css=#a',
          },
        }),
      ),
    ).toBe('REACQUIRED');
  });

  it('Data created: the flows’ writes are counted and attributed to their step', () => {
    const result = {
      mutations: { enabled: true, executed: 1, autonomous: 0, flows: 1, maxPerRun: 20 },
      createdData: [
        {
          runId: 'r1',
          tag: 'QA-CRAWLER-r1',
          stateId: 's1',
          actionId: 'a1',
          action: 'Save',
          flow: 'create-and-find',
          step: 3,
          requests: [{ method: 'POST', url: '/api/companies', status: 204 }],
          at: '2026-10-11T10:00:00.000Z',
        },
      ],
    } as unknown as ExplorationResult;
    const html = dataSection(result, () => 'New company', 'en');
    expect(html).toContain('1 action(s) changing data executed');
    expect(html).toContain('0 by the autonomous exploration · 1 by the imposed flows');
    expect(html).toContain('create-and-find · 3');
    expect(html).toContain('POST /api/companies → 204');
  });
});

describe('Dry run: an expected intent names its test datum, never as an env secret', () => {
  it('${testData:key} for a test datum, ${env} for a secret, "…" for a literal', () => {
    expect(
      describeFlowIntent({ type: 'FILL', label: 'Display label', value: { testData: 'company.name' } }),
    ).toBe('FILL "Display label" = ${testData:company.name}');
    expect(describeFlowIntent({ type: 'FILL', label: 'Password', value: { env: 'QA_PASSWORD' } })).toBe(
      'FILL "Password" = ${env}',
    );
    expect(describeFlowIntent({ type: 'FILL', label: 'Title', value: 'x' })).toBe('FILL "Title" = "…"');
  });
});
