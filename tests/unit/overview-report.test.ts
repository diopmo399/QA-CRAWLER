import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport, FlowStepReport } from '../../src/model/flow-run.js';
import { formatDuration, renderOverviewHtml } from '../../src/reporting/overview-html-reporter.js';
import { buildOverviewFlow, buildOverviewModel, stepSubtitle } from '../../src/reporting/overview-model.js';

const intent = (status: 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNKNOWN', operation?: string) =>
  ({
    position: {
      flowId: 'f',
      stepIndex: 1,
      confirmedCheckpoints: [],
      currentIntent: { name: 'X', status, confidence: 0.8, operation },
    },
    preconditions: [],
    dependencies: [],
    verdict: {
      preconditions: 'SATISFIED',
      execution: 'SUCCESS',
      target: 'CORRECT',
      effect: 'SUCCESS',
      functionalState: 'SUCCESS',
      outcome: 'COMMITTED',
    },
    confidence: {
      target: 1,
      intent: 1,
      preconditions: 1,
      effect: 1,
      state: 1,
      overall: 0.9,
      continueSilently: true,
      reasons: [],
    },
    checkpoints: [],
  }) as unknown as FlowStepReport['replay'];

const step = (index: number, partial: Partial<FlowStepReport>): FlowStepReport => ({
  index,
  kind: 'click',
  description: `click button "Step ${index}"`,
  status: 'PASSED',
  optional: false,
  durationMs: 1000,
  ...partial,
});

const flow: FlowRunReport = {
  name: 'create-and-find',
  status: 'FAILED',
  startedAt: '2026-10-10T14:32:00.000Z',
  durationMs: 6000,
  states: [],
  issueIds: [],
  explored: false,
  steps: [
    step(1, { kind: 'goto', description: 'goto /processusdoce', replay: intent('CONFIRMED') }),
    step(2, {
      kind: 'fill',
      description: 'fill label "Nom légal" = ${testData:company.legalName}',
      replay: intent('PROBABLE'),
    }),
    step(3, {
      description: 'click button "Créer"',
      replay: intent('UNKNOWN'),
      network: {
        requests: [{ method: 'POST', path: '/companies', status: 201, resourceType: 'fetch' }],
        writes: 1,
        errors: 0,
      },
    }),
    step(4, {
      kind: 'fill',
      description: 'fill label "Recherche" = ${testData:company.legalName}',
      replay: intent('CONFIRMED', 'SEARCH'),
    }),
    step(5, {
      description: 'click button "${testData:company.legalName}"',
      effect: {
        execution: 'EXECUTED',
        status: 'AMBIGUOUS',
        expected: [],
        observed: [],
        reasons: [],
        recovery: [],
      },
    }),
    step(6, {
      kind: 'expect',
      description: 'expect url contains "/companies/"',
      status: 'FAILED',
      reason: 'url mismatch',
    }),
  ],
  testDataReport: {
    entries: [
      {
        key: 'company.legalName',
        strategy: 'GENERATE_AT_REPLAY',
        generator: 'company',
        sensitive: false,
        value: 'ACME-2026-8472',
        producedAt: 2,
        usedBy: [
          { step: 2, how: 'INPUT' },
          { step: 4, how: 'INPUT' },
          { step: 5, how: 'CITATION' },
        ],
      },
      { key: 'user.password', strategy: 'RECORDED', sensitive: true, value: 'secret', usedBy: [] },
    ],
  },
};

const result = {
  mission: 'processusdoce',
  mode: 'verify',
  runId: 'run2996',
  target: { baseUrl: 'https://qa.example.com', startUrl: 'https://qa.example.com/' },
  startedAt: '2026-10-10T14:32:00.000Z',
  finishedAt: '2026-10-10T14:33:54.000Z',
  durationMs: 114_000,
  stats: { states: 4, actionsExecuted: 6, actionsSucceeded: 5, actionsFailed: 1, actionsBlocked: 0 },
  flows: [flow],
  issues: [{ id: 'i1' }],
  artifacts: { html: '/r/index.html', json: '/r/result.json' },
} as unknown as ExplorationResult;

describe('Overview — model', () => {
  const model = buildOverviewFlow(flow);

  it('counts validated and interpreted actions from the run (never invented)', () => {
    expect(model.kpis).toMatchObject({
      actions: 6,
      validated: 5,
      interpreted: 3,
      notInterpreted: 3,
      intentAvailable: true,
      warnings: 1,
      failed: 1,
      durationMs: 6000,
    });
  });

  it('gives each step a tone: failed > warning > unknown intent > valid', () => {
    expect(model.steps.map((entry) => entry.tone)).toEqual([
      'valid',
      'valid',
      'unknown',
      'valid',
      'warning',
      'failed',
    ]);
    expect(model.steps[5]?.current).toBe(true);
    expect(model.steps[3]?.title).toBe('Search');
    expect(model.steps[2]?.writes).toEqual(['POST /companies 201']);
  });

  it('links the step that produces a value to every step that reuses it', () => {
    expect(model.steps[1]?.generates).toEqual(['company.legalName']);
    expect(model.links).toEqual([
      { key: 'company.legalName', from: 2, to: 4, how: 'INPUT' },
      { key: 'company.legalName', from: 2, to: 5, how: 'CITATION' },
    ]);
    expect(model.data[0]?.uses.map((use) => use.role)).toEqual(['SOURCE', 'REUSE', 'CITATION']);
  });

  it('never publishes a sensitive value', () => {
    expect(model.data[1]).not.toHaveProperty('value');
  });

  it('reports intent as unavailable when no step carries one', () => {
    const plain = buildOverviewFlow({
      ...flow,
      steps: flow.steps.map((entry) => ({ ...entry, replay: undefined })),
    });
    expect(plain.kpis.intentAvailable).toBe(false);
  });

  it('shortens descriptions into readable subtitles', () => {
    expect(stepSubtitle({ kind: 'goto', description: 'goto /x' })).toBe('/x');
    expect(stepSubtitle({ kind: 'click', description: 'click button "${testData:a.b}"' })).toBe('{a.b}');
    expect(stepSubtitle({ kind: 'expect', description: 'expect url contains "/tasks"' })).toBe('URL /tasks');
  });

  it('summarises the run', () => {
    const overview = buildOverviewModel(result);
    expect(overview).toMatchObject({ mission: 'processusdoce', runId: 'run2996', issues: 1 });
    expect(overview.flows).toHaveLength(1);
  });
});

describe('Overview — HTML', () => {
  const html = renderOverviewHtml(result, (file) => file.replace('/r/', ''), 'fr');

  it('renders the mockup sections in French', () => {
    for (const text of [
      'Vue d&#39;ensemble',
      'Actions validées',
      'Parcours détecté',
      'Détails du run',
      'Timeline',
      'Test Data &amp; Data Lineage',
      'Génère une valeur',
      'ACME-2026-8472',
    ])
      expect(html).toContain(text);
    expect(html).toContain('href="index.html"');
  });

  it('escapes run data and keeps the page self-contained', () => {
    const hostile = renderOverviewHtml(
      { ...result, mission: '<script>alert(1)</script>' },
      (file) => file,
      'en',
    );
    expect(hostile).not.toContain('<script>alert(1)</script>');
    expect(hostile).not.toMatch(/<(link|script)[^>]+(src|href)="https?:/);
    expect(html).not.toContain('secret');
  });

  it('falls back to the exploration when the run has no flow', () => {
    const empty = renderOverviewHtml({ ...result, flows: [] }, (file) => file, 'en');
    expect(empty).toContain('No imposed flow in this run');
  });

  it('formats durations as mm:ss', () => {
    expect(formatDuration(114_000)).toBe('01:54');
  });
});
