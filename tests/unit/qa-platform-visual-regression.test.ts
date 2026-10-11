import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import type { RunAnomaly } from '../../src/platform/model.js';
import { analyzePerformance, judgeMetric } from '../../src/platform/performance-analysis.js';
import { generatePlaywrightTest } from '../../src/platform/playwright-test-generator.js';
import { analyzeRegression } from '../../src/platform/regression-analysis.js';
import {
  assessReproduction,
  minimalPath,
  planReproductions,
  reproductionFlowYaml,
} from '../../src/platform/reproduction-planner.js';
import { analyzeVisual } from '../../src/platform/visual-analysis.js';
import { compareImages, PixelVisualComparator } from '../../src/visual/pixel-visual-comparator.js';
import { decodePng, encodePng, type RgbaImage } from '../../src/visual/png.js';
import { flow, result, step } from '../fixtures/qa-platform-results.js';

/**
 * QA PLATFORM — phases 7 à 11 : comparaison visuelle (PNG, masques, verdicts), baseline
 * historique de performance (une variation isolée n'est pas une régression), analyseur de
 * régression, planificateur de reproduction (chemin minimal, flow YAML, jugement d'un rejeu) et
 * générateur de tests Playwright.
 */
function image(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) data.set([...paint(x, y), 255], (y * width + x) * 4);
  return { width, height, data };
}
const white = (): [number, number, number] => [255, 255, 255];

describe('QA platform — visual comparison', () => {
  it('PNG round trip and pixel comparison with masks and different sizes', () => {
    const original = image(8, 4, (x) => (x < 4 ? [200, 10, 10] : [10, 10, 200]));
    const decoded = decodePng(encodePng(original));
    expect(decoded).toEqual(original);
    const changed = image(8, 4, (x, y) =>
      x < 4 ? [200, 10, 10] : y === 0 ? [255, 255, 255] : [10, 10, 200],
    );
    const comparison = compareImages(original, changed, { colorThreshold: 48, masks: [] });
    expect(comparison).toMatchObject({ compared: 32, different: 4, ratio: 0.125, sizeDiffers: false });
    const masked = compareImages(original, changed, {
      colorThreshold: 48,
      masks: [{ x: 4, y: 0, width: 4, height: 1 }],
    });
    expect(masked).toMatchObject({ compared: 28, different: 0 });
    const taller = compareImages(original, image(8, 6, white), { colorThreshold: 48, masks: [] });
    expect(taller.sizeDiffers).toBe(true);
    expect(taller.different).toBe(48);
  });

  it('the pixel comparator reads two files, writes the diff image and reports the changed share', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-visual-'));
    const baseline = path.join(dir, 'baseline.png');
    const current = path.join(dir, 'current.png');
    await writeFile(baseline, encodePng(image(10, 10, white)));
    await writeFile(
      current,
      encodePng(image(10, 10, (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255]))),
    );
    const comparator = new PixelVisualComparator({
      colorThreshold: 48,
      masks: [],
      diffImage: () => path.join(dir, 'diff.png'),
    });
    const comparison = await comparator.compare(baseline, current);
    expect(comparison).toMatchObject({
      status: 'DIFFERENT',
      difference: 0.01,
      diffImage: path.join(dir, 'diff.png'),
    });
    expect((await stat(path.join(dir, 'diff.png'))).size).toBeGreaterThan(0);
    expect(await comparator.compare(baseline, baseline)).toMatchObject({ status: 'SAME', difference: 0 });
    expect((await comparator.compare(baseline, path.join(dir, 'missing.png'))).status).toBe('UNKNOWN');
  });

  it('NEW_BASELINE, then VISUAL_MATCH / MINOR_CHANGE / MAJOR_CHANGE, and VISUAL_REGRESSION only with an anomaly on the step', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-visual-analysis-'));
    const shot = async (
      name: string,
      paint: (x: number, y: number) => [number, number, number],
    ): Promise<string> => {
      const file = path.join(dir, `${name}.png`);
      await writeFile(file, encodePng(image(20, 20, paint)));
      return file;
    };
    const comparator = new PixelVisualComparator({ colorThreshold: 48, masks: [] });
    const options = {
      comparator,
      baselineDir: dir,
      minorChangeRatio: 0.02,
      majorChangeRatio: 0.2,
      updateBaseline: 'on-pass' as const,
    };
    const run = (screens: Record<number, string>, failing?: number) =>
      result([
        flow('f', [
          step(1, 'click A', { screenshot: screens[1] ?? '' }),
          step(2, 'click B', {
            screenshot: screens[2] ?? '',
            ...(failing === 2 ? { status: 'FAILED' as const, reason: 'no effect' } : {}),
          }),
          step(3, 'click C', { screenshot: screens[3] ?? '' }),
        ]),
      ]);
    const anomaly = (stepIndex: number): RunAnomaly => ({
      id: 'ANOMALY-001',
      category: 'FUNCTIONAL_FAILURE',
      severity: 'ERROR',
      symptom: '',
      evidence: [],
      confidence: 1,
      source: 'RUNTIME',
      location: { flow: 'f', step: stepIndex },
      issueIds: [],
    });
    const first = await analyzeVisual(
      run({ 1: await shot('a1', white), 2: await shot('b1', white), 3: await shot('c1', white) }),
      [],
      options,
    );
    expect(first.checkpoints.map((entry) => entry.verdict)).toEqual([
      'NEW_BASELINE',
      'NEW_BASELINE',
      'NEW_BASELINE',
    ]);
    expect(first.checkpoints.every((entry) => entry.baselineUpdated)).toBe(true);

    const second = await analyzeVisual(
      run(
        {
          1: await shot('a2', white),
          2: await shot('b2', (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255])),
          3: await shot('c2', (x) => (x < 10 ? [0, 0, 0] : [255, 255, 255])),
        },
        2,
      ),
      [anomaly(2)],
      options,
    );
    expect(second.checkpoints.map((entry) => entry.verdict)).toEqual([
      'VISUAL_MATCH',
      'VISUAL_REGRESSION',
      'MAJOR_CHANGE',
    ]);
    expect(second.checkpoints[1]?.anomalies).toEqual(['ANOMALY-001']);
    expect(second.checkpoints[1]?.baselineUpdated).toBe(false);
    expect(second.checkpoints[2]?.baselineUpdated).toBe(true);
    expect(second.summary).toMatchObject({ checkpoints: 3, VISUAL_REGRESSION: 1, MAJOR_CHANGE: 1 });
    expect(second.findings.map((finding) => finding.conclusion)).toEqual([
      expect.stringContaining('VISUAL_REGRESSION'),
      expect.stringContaining('MAJOR_CHANGE'),
    ]);
    // Le même petit changement sans anomalie : MINOR_CHANGE, jamais une régression.
    const third = await analyzeVisual(
      run({
        1: await shot('a3', white),
        2: await shot('b3', (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255])),
        3: await shot('c3', (x) => (x < 10 ? [0, 0, 0] : [255, 255, 255])),
      }),
      [],
      options,
    );
    expect(third.checkpoints.map((entry) => entry.verdict)).toEqual([
      'VISUAL_MATCH',
      'MINOR_CHANGE',
      'VISUAL_MATCH',
    ]);
    const baselineB = await readFile(path.join(dir, 'visual', 'f', '002.png'));
    expect(baselineB.length).toBeGreaterThan(0);
  });
});

describe('QA platform — historical performance baseline', () => {
  const sample = (runId: string, value: number) => ({ runId, at: '2026-10-01T00:00:00.000Z', value });
  const options = { tolerance: 1.3, minSamples: 3, floorMs: 300 };
  const metric = (value: number) => ({ metric: 'flow:f#2', label: 'f step 2 click Save', value });

  it('INSUFFICIENT_DATA under minSamples, STABLE within tolerance, IMPROVED when clearly faster', () => {
    expect(judgeMetric(metric(1000), [sample('r1', 1000), sample('r2', 1000)], options).status).toBe(
      'INSUFFICIENT_DATA',
    );
    const stable = judgeMetric(
      metric(1100),
      [sample('r1', 1000), sample('r2', 1000), sample('r3', 1000)],
      options,
    );
    expect(stable).toMatchObject({
      status: 'STABLE',
      baselineValue: 1000,
      percentageChange: 10,
      samples: 3,
      confidence: 0.5,
    });
    expect(
      judgeMetric(metric(400), [sample('r1', 1000), sample('r2', 1000), sample('r3', 1000)], options).status,
    ).toBe('IMPROVED');
  });

  it('an isolated variation is a VARIATION; two consecutive exceeding runs are a PERFORMANCE_REGRESSION with its first run', () => {
    const history = [sample('r1', 1000), sample('r2', 1000), sample('r3', 1000)];
    expect(judgeMetric(metric(2000), history, options)).toMatchObject({
      status: 'VARIATION',
      percentageChange: 100,
    });
    const regression = judgeMetric(
      metric(2000),
      [...history, sample('r4', 1900), sample('r5', 2100)],
      options,
    );
    expect(regression).toMatchObject({
      status: 'PERFORMANCE_REGRESSION',
      firstDetectedRun: 'r4',
      trend: 'DEGRADING',
    });
    const analysis = analyzePerformance(
      [flow('f', [step(1, 'click A', { durationMs: 100 }), step(2, 'click Save', { durationMs: 2000 })])],
      { history: (name) => (name === 'flow:f#2' ? [...history, sample('r4', 1900)] : []) },
      options,
    );
    expect(analysis.summary).toMatchObject({ metrics: 3, PERFORMANCE_REGRESSION: 1, INSUFFICIENT_DATA: 2 });
    expect(analysis.findings[0]).toMatchObject({
      source: 'HISTORICAL',
      conclusion: expect.stringContaining('PERFORMANCE_REGRESSION') as string,
    });
  });
});

describe('QA platform — regression analyzer', () => {
  const anomaly = (
    id: string,
    flowName: string | undefined,
    issueIds: string[] = [],
    extra: Partial<RunAnomaly> = {},
  ): RunAnomaly => ({
    id,
    category: 'FUNCTIONAL_FAILURE',
    severity: 'ERROR',
    symptom: `${id} failed`,
    evidence: [],
    confidence: 1,
    source: 'RUNTIME',
    location: flowName ? { flow: flowName, step: 2 } : {},
    issueIds,
    ...extra,
  });

  it('lifecycle statuses, flow history, drift, baseline diff and expected refusals each get their status', () => {
    const anomalies = [
      anomaly('A1', 'with-history', ['ISSUE-1']),
      anomaly('A2', 'with-history', ['ISSUE-2']),
      anomaly('A3', 'with-history', ['ISSUE-3']),
      anomaly('A4', 'previously-passing'),
      anomaly('A5', 'drifted'),
      anomaly('A6', undefined),
      anomaly('A7', undefined, [], { category: 'EXPECTED_VALIDATION', severity: 'INFO' }),
    ];
    const comparison = (status: 'PASSED' | 'FAILED') => ({
      previous: { runId: 'run-0', at: '', status, durationMs: 1 },
      verdict: 'CHANGED' as const,
      durationDeltaMs: 0,
      changes: [],
    });
    const drift = {
      detected: true,
      classification: 'WORKFLOW_DRIFT',
      result: 'PASS_WITH_WORKFLOW_DRIFT',
      facts: {},
      explanation: ['a step was added'],
      flowUpdateSuggested: true,
    } as unknown as FlowRunReport['drift'];
    const analysis = analyzeRegression(
      result(
        [
          flow('with-history', [step(1, 'a'), step(2, 'b', { status: 'FAILED' })]),
          flow('previously-passing', [step(1, 'a'), step(2, 'b', { status: 'FAILED' })], {
            comparison: comparison('PASSED'),
          }),
          flow('drifted', [step(1, 'a'), step(2, 'b', { status: 'FAILED' })], { drift }),
          flow('fixed', [step(1, 'a')], { comparison: comparison('FAILED') }),
          flow('assumed', [step(1, 'a')], { drift }),
        ],
        {
          regression: {
            anomalies: {
              counts: { NEW: 1, KNOWN: 1, RESOLVED: 1, REOPENED: 0, FLAKY: 1 },
              entries: [
                {
                  id: 'ANOMALY-old',
                  type: 'HTTP',
                  severity: 'ERROR',
                  message: 'HTTP 500',
                  status: 'RESOLVED',
                  firstSeen: { at: '', run: 'run-0', version: 'v' },
                  lastSeen: { at: '', run: 'run-0', version: 'v' },
                  occurrenceCount: 3,
                  runsSeen: 3,
                  environments: [],
                  actors: [],
                  reproductionPath: [],
                  cleanChecks: 3,
                  reopenedCount: 0,
                },
              ],
              events: [],
              byIssue: {
                'ISSUE-1': { anomalyId: 'X1', status: 'NEW' },
                'ISSUE-2': { anomalyId: 'X2', status: 'KNOWN' },
                'ISSUE-3': { anomalyId: 'X3', status: 'FLAKY' },
              },
            },
          },
          flowDiff: {
            addedStates: [{ id: 'S9', label: 'Archive' }],
            removedStates: [],
            addedTransitions: [{}],
            removedTransitions: [],
            changedTransitions: [],
            summary: {},
          },
        } as unknown as Partial<ExplorationResult>,
      ),
      anomalies,
    );
    expect(anomalies.map((entry) => entry.regression)).toEqual([
      'NEW_REGRESSION',
      'REGRESSION_PERSISTING',
      'FLAKY_BEHAVIOR',
      'NEW_REGRESSION',
      'EXPECTED_CHANGE',
      'NEW_REGRESSION',
      'KNOWN_FAILURE',
    ]);
    expect(analysis.summary).toMatchObject({
      NEW_REGRESSION: 3,
      REGRESSION_PERSISTING: 1,
      FLAKY_BEHAVIOR: 1,
      REGRESSION_FIXED: 2,
      EXPECTED_CHANGE: 2,
      NEW_BEHAVIOR: 2,
    });
    // A6 n'a aucune histoire : nouveau pour ce que le run sait, mais le signal « nouvelle régression » ne compte que l'historique.
    expect(analysis.signals).toEqual({ newRegressions: 2, fixedRegressions: 2, flaky: 1 });
    expect(analysis.entries.find((entry) => entry.anomalyId === 'A6')).toMatchObject({
      source: 'RUNTIME',
      evidence: ['no history available for this anomaly: treated as new'],
    });
  });
});

const MISSION = `mission: { name: repro }
target: { baseUrl: http://app.test, startAt: / }
visual: { enabled: true, masks: [{ x: 0, y: 0, width: 10, height: 10, reason: clock }] }
platform: { generatedTests: { enabled: true }, performance: { tolerance: 1.5 } }
flows:
  - name: create-item
    startAt: /items
    steps:
      - click: { role: button, name: Items }
      - expect: { url: /items }
      - click: { role: button, name: New item }
        allow: MUTATION
      - fill: { label: Item label, value: { testData: item.label } }
      - fill: { label: Code, value: { env: ITEM_CODE } }
      - select: { label: Kind, option: standard }
      - click: { role: button, name: Save }
        allow: MUTATION
        effects: { route: /items/, appears: ['button:Edit'] }
      - click: { role: button, name: Reports }
      - fill: { label: Search items, value: { testData: item.label } }
      - click: { role: button, name: Search, exact: true }
      - expect: { visible: { text: '\${testData:item.label}' } }
`;

describe('QA platform — reproduction planner and Playwright generator', () => {
  const { config } = parseConfig(MISSION, {}, {});
  const definition = config.flows[0];
  if (!definition) throw new Error('flow missing');
  const report = flow(
    'create-item',
    [
      step(1, 'click Items', { stateId: 'S1' }),
      step(2, 'expect /items', { kind: 'expect', stateId: 'S1' }),
      step(3, 'click New item', { stateId: 'S1' }),
      step(4, 'fill Item label', { kind: 'fill', stateId: 'S1', testData: ['item.label'] }),
      step(5, 'fill Code', { kind: 'fill', stateId: 'S1' }),
      step(6, 'select Kind', { kind: 'select', stateId: 'S1' }),
      step(7, 'click Save', { stateId: 'S2' }),
      step(8, 'click Reports', { stateId: 'S3' }),
      step(9, 'fill Search items', { kind: 'fill', stateId: 'S3', testData: ['item.label'] }),
      step(10, 'click Search', { stateId: 'S3' }),
      step(11, 'expect visible', {
        kind: 'expect',
        status: 'FAILED',
        reason: 'expected text not visible',
        stateId: 'S3',
      }),
    ],
    {
      testDataReport: {
        entries: [
          {
            key: 'item.label',
            strategy: 'GENERATE_AT_REPLAY',
            sensitive: false,
            producedAt: 4,
            usedBy: [
              { step: 4, how: 'INPUT' },
              { step: 9, how: 'INPUT' },
              { step: 11, how: 'CITATION' },
            ],
          },
        ],
      },
    },
  );

  it('visual and platform configuration parse with their defaults', () => {
    expect(config.visual).toMatchObject({
      enabled: true,
      colorThreshold: 48,
      minorChangeRatio: 0.02,
      updateBaseline: 'on-pass',
    });
    expect(config.visual.masks[0]).toMatchObject({ x: 0, width: 10, reason: 'clock' });
    expect(config.platform).toEqual({
      performance: { tolerance: 1.5, minSamples: 3, floorMs: 300 },
      reproductions: { enabled: true },
      generatedTests: { enabled: true },
    });
  });

  it('the minimal path keeps navigation, the form that leads to the failure, the data producers and the failing step', () => {
    const path11 = minimalPath(definition, report, 11);
    // Gardés : la navigation (1, 7 change d'écran, 8), le formulaire de création (3..6) qui produit la donnée citée, la recherche (9, 10) et l'étape fautive.
    expect(path11.steps).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(path11.dropped).toBe(1);
    expect(path11.reasons[4]).toMatch(/input of the form|produces the test data/);
    const yaml = reproductionFlowYaml(definition, path11, 'ANOMALY-003');
    expect(yaml).toContain('name: repro-anomaly-003');
    expect(yaml).toContain('allow: MUTATION');
    expect(yaml).toContain('testData: item.label');
    expect(yaml).not.toContain('url: /items\n'); // l'expect 2 est écarté
    const path7 = minimalPath(
      definition,
      {
        ...report,
        steps: report.steps.map((entry) =>
          entry.index === 7 ? { ...entry, status: 'FAILED' as const } : entry,
        ),
      },
      7,
    );
    expect(path7.steps).toEqual([1, 3, 4, 5, 6, 7]);
  });

  it('reproduction artifacts and the judgement of a replay: reproduced, partial, not reproduced, environment, insufficient evidence', () => {
    const anomalies: RunAnomaly[] = [
      {
        id: 'ANOMALY-001',
        category: 'FUNCTIONAL_FAILURE',
        severity: 'ERROR',
        symptom: 'step 11 failed',
        evidence: [],
        confidence: 1,
        source: 'RUNTIME',
        location: { flow: 'create-item', step: 11 },
        issueIds: [],
      },
      {
        id: 'ANOMALY-002',
        category: 'API_FAILURE',
        severity: 'ERROR',
        symptom: 'HTTP 500',
        evidence: [],
        confidence: 1,
        source: 'RUNTIME',
        location: { url: 'http://app.test/x' },
        issueIds: ['ISSUE-1'],
      },
    ];
    const plans = planReproductions(anomalies, config.flows, [report]);
    expect(plans.artifacts.map((artifact) => artifact.status)).toEqual([
      'NOT_VERIFIED',
      'INSUFFICIENT_EVIDENCE',
    ]);
    const artifact = plans.artifacts[0];
    if (!artifact?.path) throw new Error('path missing');
    expect(artifact.testDataKeys).toEqual(['item.label']);
    expect(artifact.observed).toEqual(['expected text not visible']);
    expect(artifact.flowYaml).toContain('repro-anomaly-001');
    const replay = (steps: FlowRunReport['steps'], status: FlowRunReport['status']): FlowRunReport => ({
      ...flow('repro-anomaly-001', steps),
      status,
    });
    const passed = replay(
      artifact.path.steps.map((_, index) => step(index + 1, 'ok')),
      'PASSED',
    );
    expect(assessReproduction(artifact, passed)).toBe('NOT_REPRODUCED');
    const sameFailure = replay(
      artifact.path.steps.map((_, index) =>
        step(
          index + 1,
          'x',
          index + 1 === 10 ? { status: 'FAILED', reason: 'expected text not visible' } : {},
        ),
      ),
      'FAILED',
    );
    expect(assessReproduction(artifact, sameFailure)).toBe('REPRODUCED');
    const elsewhere = replay(
      artifact.path.steps.map((_, index) =>
        step(index + 1, 'x', index + 1 === 2 ? { status: 'FAILED', reason: 'not found' } : {}),
      ),
      'FAILED',
    );
    expect(assessReproduction(artifact, elsewhere)).toBe('PARTIALLY_REPRODUCED');
    const network = replay(
      artifact.path.steps.map((_, index) =>
        step(
          index + 1,
          'x',
          index + 1 === 10
            ? {
                status: 'FAILED',
                reason: 'other',
                network: {
                  requests: [{ method: 'GET', path: '/api/search', status: 503, resourceType: 'fetch' }],
                  writes: 0,
                  errors: 1,
                },
              }
            : {},
        ),
      ),
      'FAILED',
    );
    expect(assessReproduction(artifact, network)).toBe('ENVIRONMENT_DEPENDENT');
    expect(assessReproduction(plans.artifacts[1] ?? artifact, passed)).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('the generated Playwright test uses semantic locators, generated test data, environment secrets and effect assertions', () => {
    const test = generatePlaywrightTest(definition, report, {
      baseUrl: 'http://app.test',
      checkpoints: [{ id: 'item-created', status: 'CONFIRMED' }],
    });
    expect(test.fileName).toBe('create-item.spec.ts');
    expect(test.content).toContain(`import { test, expect } from '@playwright/test';`);
    expect(test.content).toContain(`await page.goto("http://app.test/items");`);
    expect(test.content).toContain(`page.getByRole("button", { name: "New item" }).click()`);
    expect(test.content).toContain(`page.getByLabel("Item label").fill(testData["item.label"])`);
    expect(test.content).toContain(`fill(process.env["ITEM_CODE"] ?? '')`);
    expect(test.content).toContain(`selectOption("standard")`);
    expect(test.content).toContain(`getByRole("button", { name: "Search", exact: true })`);
    expect(test.content).toContain(`toHaveURL(new RegExp("/items/"))`);
    expect(test.content).toContain(`getByRole("button", { name: "Edit" }).first()).toBeVisible()`);
    expect(test.content).toContain('item-created: CONFIRMED');
    expect(test.content).toContain('(FAILED at run time)');
    expect(test.content).not.toMatch(/ITEM_CODE\s*=/);
    expect(test).toMatchObject({ steps: 11, assertions: 4 });
  });
});
