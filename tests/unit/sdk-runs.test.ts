import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowRunReport, FlowStepReport } from '../../src/model/flow-run.js';
import { REGRESSION_STATUSES as ENGINE_REGRESSION_STATUSES } from '../../src/platform/model.js';
import { COVERAGE_STATUSES as ENGINE_COVERAGE_STATUSES } from '../../src/quality/traceability.js';
import {
  COVERAGE_STATUSES,
  createQaCrawler,
  REGRESSION_STATUSES,
  type ProjectDraft,
  type RunComparisonView,
  type TraceabilityView,
} from '../../src/sdk/core/index.js';
import { engineDefaults, REPORTS_DIR } from '../../src/sdk/server/project.js';
import { compareRuns, regressionView, traceabilityView } from '../../src/sdk/server/runs.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { runsStrings } from '../../src/sdk/ui/runs-i18n.js';
import { renderRuns, type RunsState } from '../../src/sdk/ui/runs-view.js';

/**
 * COMPARAISON ET TRAÇABILITÉ : des dossiers de run écrits comme le moteur les écrit (result.json,
 * quality-verification.json, regression-analysis.json) ; le SDK les lit, compare avec la règle du
 * moteur (compareFlowRuns) et ne déduit rien d'autre. Les vrais runs : tests/integration/sdk-runs.test.ts.
 */
const step = (index: number, description: string, status: FlowStepReport['status'], durationMs = 100) =>
  ({ index, description, status, durationMs }) as FlowStepReport;

const flow = (name: string, status: FlowRunReport['status'], steps: FlowStepReport[]): FlowRunReport => ({
  name,
  status,
  startedAt: '2026-10-20T10:00:00.000Z',
  durationMs: steps.reduce((sum, item) => sum + item.durationMs, 0),
  steps,
  states: [],
  issueIds: [],
  explored: false,
});

const requirement = (id: string, status: string) => ({
  id,
  description: `Requirement ${id}`,
  criticality: 'HIGH',
  declared: true,
  status,
  flows: ['create'],
  rules: [],
  operations: [],
  assertions: [
    {
      flow: 'create',
      id: 'saved',
      status: status === 'VERIFIED_PASS' ? 'PASS' : 'FAIL',
      mandatory: true,
      evidence: [],
    },
  ],
  evidence: ['POST /api/items 201'],
  dependsOn: [],
  preconditions: [],
  reasons: [],
});

const quality = (statuses: Record<string, string>, verdict: string) => {
  const requirements = Object.entries(statuses).map(([id, status]) => requirement(id, status));
  const byStatus = Object.fromEntries(ENGINE_COVERAGE_STATUSES.map((status) => [status, 0]));
  for (const item of requirements) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  return {
    runId: 'r',
    generatedAt: '2026-10-20T10:01:00.000Z',
    verdict,
    flows: [],
    traceability: {
      runId: 'r',
      generatedAt: '2026-10-20T10:01:00.000Z',
      requirements,
      rules: [],
      links: [],
      warnings: [],
      summary: { total: requirements.length, byStatus, criticalFailures: [], passRate: null },
    },
    evidence: [],
    metrics: {},
    limits: ['A screen shown is not a server-side proof.'],
  };
};

async function writeRun(
  dir: string,
  flows: FlowRunReport[],
  extra: { quality?: unknown; regression?: unknown } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ startedAt: flows[0]?.startedAt, flows }));
  if (extra.quality)
    await writeFile(path.join(dir, 'quality-verification.json'), JSON.stringify(extra.quality));
  if (extra.regression)
    await writeFile(path.join(dir, 'regression-analysis.json'), JSON.stringify(extra.regression));
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sdk-runs-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('run comparison — read from the engine artifacts', () => {
  it('uses the vocabularies of the engine (coverage, regression)', () => {
    expect([...COVERAGE_STATUSES]).toEqual([...ENGINE_COVERAGE_STATUSES]);
    expect([...REGRESSION_STATUSES]).toEqual([...ENGINE_REGRESSION_STATUSES]);
  });

  it('compares two runs flow by flow with the engine rule, and requirement by requirement', async () => {
    const base = path.join(root, 'run-a');
    const head = path.join(root, 'run-b');
    await writeRun(
      base,
      [
        flow('create', 'PASSED', [step(1, 'click New', 'PASSED'), step(2, 'fill Title', 'PASSED')]),
        flow('search', 'FAILED', [step(1, 'fill Search', 'FAILED')]),
        flow('export', 'PASSED', [step(1, 'click Export', 'PASSED')]),
      ],
      { quality: quality({ 'REQ-1': 'VERIFIED_PASS', 'REQ-2': 'COVERED_NOT_EXECUTED' }, 'PASS') },
    );
    await writeRun(
      head,
      [
        flow('create', 'FAILED', [
          step(1, 'click New', 'PASSED'),
          step(2, 'fill Title', 'FAILED', 2000),
          step(3, 'click Save', 'SKIPPED'),
        ]),
        flow('search', 'PASSED', [step(1, 'fill Search', 'PASSED')]),
        flow('import', 'PASSED', [step(1, 'click Import', 'PASSED')]),
      ],
      { quality: quality({ 'REQ-1': 'VERIFIED_FAIL', 'REQ-2': 'COVERED_NOT_EXECUTED' }, 'FAIL') },
    );
    const view = (await compareRuns(
      { dir: base, run: 'run-a' },
      { dir: head, run: 'run-b' },
    )) as RunComparisonView;
    const byName = new Map(view.flows.map((item) => [item.name, item]));
    expect(byName.get('create')).toMatchObject({
      presence: 'BOTH',
      baseStatus: 'PASSED',
      headStatus: 'FAILED',
      verdict: 'CHANGED',
    });
    expect(byName.get('create')?.changes.map((change) => change.kind)).toEqual([
      'FLOW_STATUS',
      'STEP_STATUS',
      'STEP_SLOWER',
      'STEP_ADDED',
    ]);
    expect(byName.get('import')).toMatchObject({ presence: 'ONLY_HEAD', headStatus: 'PASSED', changes: [] });
    expect(byName.get('export')).toMatchObject({ presence: 'ONLY_BASE', baseStatus: 'PASSED' });
    expect(view.summary).toMatchObject({
      flows: 4,
      changed: 2,
      same: 0,
      onlyBase: 1,
      onlyHead: 1,
      newlyFailing: ['create'],
      newlyPassing: ['search'],
      requirementsChanged: 1,
    });
    expect(view.requirements).toEqual([
      expect.objectContaining({
        id: 'REQ-1',
        baseStatus: 'VERIFIED_PASS',
        headStatus: 'VERIFIED_FAIL',
        changed: true,
      }),
      expect.objectContaining({ id: 'REQ-2', changed: false }),
    ]);
    expect(view.traceability).toEqual({ base: true, head: true });
    expect(view.base).toEqual({ run: 'run-a', at: '2026-10-20T10:00:00.000Z' });
  });

  it('says SAME when nothing changed, and invents no requirement without traceability', async () => {
    const base = path.join(root, 'run-c');
    const head = path.join(root, 'run-d');
    const flows = [flow('create', 'PASSED', [step(1, 'click New', 'PASSED')])];
    await writeRun(base, flows);
    await writeRun(head, flows);
    const view = (await compareRuns(
      { dir: base, run: 'run-c' },
      { dir: head, run: 'run-d' },
    )) as RunComparisonView;
    expect(view.flows).toEqual([expect.objectContaining({ name: 'create', verdict: 'SAME', changes: [] })]);
    expect(view.requirements).toEqual([]);
    expect(view.traceability).toEqual({ base: false, head: false });
    expect(await traceabilityView(head, 'run-d')).toBeUndefined();
    expect(
      await compareRuns({ dir: base, run: 'run-c' }, { dir: path.join(root, 'nowhere'), run: 'x' }),
    ).toBeUndefined();
  });

  it('serves the traceability and the regression analysis as the engine wrote them', async () => {
    const dir = path.join(root, 'run-e');
    await writeRun(dir, [flow('create', 'PASSED', [step(1, 'click New', 'PASSED')])], {
      quality: quality({ 'REQ-1': 'STALE_EVIDENCE' }, 'INCONCLUSIVE'),
      regression: {
        entries: [
          { status: 'NEW_REGRESSION', subject: 'create', evidence: ['PASSED → FAILED'], source: 'RUNTIME' },
        ],
        summary: Object.fromEntries(
          ENGINE_REGRESSION_STATUSES.map((status) => [status, status === 'NEW_REGRESSION' ? 1 : 0]),
        ),
        signals: { newRegressions: 1, fixedRegressions: 0, flaky: 0 },
        findings: [],
      },
    });
    const trace = (await traceabilityView(dir, 'run-e')) as TraceabilityView;
    expect(trace).toMatchObject({
      run: 'run-e',
      verdict: 'INCONCLUSIVE',
      limits: ['A screen shown is not a server-side proof.'],
    });
    expect(trace.requirements[0]).toMatchObject({
      id: 'REQ-1',
      status: 'STALE_EVIDENCE',
      evidence: ['POST /api/items 201'],
    });
    expect(trace.summary.passRate).toBeNull();
    const regression = await regressionView(dir, 'run-e');
    expect(regression?.entries).toEqual([
      expect.objectContaining({ status: 'NEW_REGRESSION', subject: 'create' }),
    ]);
    expect(regression).not.toHaveProperty('findings');
  });
});

describe('run comparison — routes', () => {
  let server: RunningSdkServer;
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'sdk-runs-server-'));
    server = await startSdkServer({ workspace });
  });
  afterAll(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it('compares two runs of a project, serves traceability, and refuses what is not a pair of runs', async () => {
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    const draft: ProjectDraft = {
      ...engineDefaults(),
      project: { name: 'Demo', targetUrl: 'http://127.0.0.1:9/app', framework: 'other' },
    };
    const project = await client.projects.create(draft);
    const reports = path.join(workspace, project.id, REPORTS_DIR);
    await writeRun(
      path.join(reports, 'run-2026-10-20T10-00-00-000Z'),
      [flow('create', 'PASSED', [step(1, 'a', 'PASSED')])],
      {
        quality: quality({ 'REQ-1': 'VERIFIED_PASS' }, 'PASS'),
      },
    );
    await writeRun(path.join(reports, 'run-2026-10-21T10-00-00-000Z'), [
      flow('create', 'FAILED', [step(1, 'a', 'FAILED')]),
    ]);
    const view = await client.reports.compare(
      project.id,
      'run-2026-10-20T10-00-00-000Z',
      'run-2026-10-21T10-00-00-000Z',
    );
    expect(view.summary.newlyFailing).toEqual(['create']);
    expect(view.traceability).toEqual({ base: true, head: false });
    expect(view.requirements).toEqual([
      expect.objectContaining({ id: 'REQ-1', baseStatus: 'VERIFIED_PASS', changed: true }),
    ]);
    expect(view.requirements[0]).not.toHaveProperty('headStatus');
    await expect(
      client.reports.traceability(project.id, 'run-2026-10-20T10-00-00-000Z'),
    ).resolves.toMatchObject({
      verdict: 'PASS',
    });
    await expect(
      client.reports.traceability(project.id, 'run-2026-10-21T10-00-00-000Z'),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('declares no requirements') as unknown,
    });
    await expect(client.reports.regression(project.id, 'run-2026-10-21T10-00-00-000Z')).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      client.reports.compare(project.id, 'run-2026-10-20T10-00-00-000Z', 'run-2026-10-20T10-00-00-000Z'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.reports.compare(project.id, 'run-2026-10-20T10-00-00-000Z', 'run-nope'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.reports.compare(project.id, '../../etc', 'run-2026-10-20T10-00-00-000Z'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.reports.compare(project.id, '', 'run-2026-10-20T10-00-00-000Z'),
    ).rejects.toMatchObject({ status: 400 });
    const page = await fetch(`${server.url}/runs?project=x&base=<b>`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('<qa-crawler-run-compare endpoint="/api"');
    expect(html).not.toContain('<b>');
  });
});

describe('run comparison — rendering', () => {
  const t = runsStrings('fr');
  const base: RunsState = {
    t,
    phase: 'ready',
    tab: 'compare',
    runs: [
      { name: 'run-b', createdAt: '2026-10-21T10:00:00.000Z' },
      { name: 'run-a', createdAt: '2026-10-20T10:00:00.000Z' },
    ],
    base: 'run-a',
    head: 'run-b',
    status: '',
  };
  const comparison: RunComparisonView = {
    base: { run: 'run-a', at: '2026-10-20T10:00:00.000Z' },
    head: { run: 'run-b', at: '2026-10-21T10:00:00.000Z' },
    flows: [
      {
        name: '<script>x</script>',
        presence: 'BOTH',
        baseStatus: 'PASSED',
        headStatus: 'FAILED',
        verdict: 'CHANGED',
        durationDeltaMs: 1900,
        changes: [{ kind: 'STEP_STATUS', step: 2, detail: 'PASSED → FAILED' }],
      },
    ],
    requirements: [
      {
        id: 'REQ-1',
        description: 'Created',
        criticality: 'HIGH',
        baseStatus: 'VERIFIED_PASS',
        headStatus: 'VERIFIED_FAIL',
        changed: true,
      },
    ],
    traceability: { base: true, head: true },
    summary: {
      flows: 1,
      changed: 1,
      same: 0,
      onlyBase: 0,
      onlyHead: 0,
      newlyFailing: ['<script>x</script>'],
      newlyPassing: [],
      requirementsChanged: 1,
    },
  };

  it('shows the engine statuses, escaped, with counts and never a percentage', () => {
    const html = renderRuns({ ...base, comparison, open: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('Vérifiée — succès');
    expect(html).toContain('Vérifiée — échec');
    expect(html).toContain('Statut de l’étape');
    expect(html).toContain('+1900 ms');
    expect(html).toContain('Ne passent plus');
    expect(html).not.toContain('%');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
  });

  it('says what is missing instead of inventing it', () => {
    expect(
      renderRuns({ ...base, runs: [base.runs[0] as RunsState['runs'][number]], base: undefined }),
    ).toContain('Une seule exploration');
    expect(renderRuns({ ...base, runs: [] })).toContain('Aucune exploration terminée');
    expect(renderRuns({ ...base, comparison: { ...comparison, requirements: [] } })).toContain(
      'la mission ne déclare pas d’exigence',
    );
    expect(renderRuns({ ...base, tab: 'traceability', traceabilityError: t.noTraceability })).toContain(
      'la mission ne déclare pas d’exigence',
    );
  });

  it('lists the requirements of the compared run by coverage status', () => {
    const traceability: TraceabilityView = {
      run: 'run-b',
      generatedAt: '2026-10-21T10:01:00.000Z',
      verdict: 'FAIL',
      requirements: [
        { ...requirement('REQ-1', 'VERIFIED_FAIL'), status: 'VERIFIED_FAIL' },
        { ...requirement('REQ-2', 'NOT_COVERED'), status: 'NOT_COVERED' },
      ],
      rules: [],
      warnings: ['assertion "ghost" is unknown'],
      summary: {
        total: 2,
        byStatus: {
          ...Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, 0])),
          VERIFIED_FAIL: 1,
          NOT_COVERED: 1,
        } as TraceabilityView['summary']['byStatus'],
        criticalFailures: ['REQ-1'],
        passRate: 0,
      },
      limits: ['A screen shown is not a server-side proof.'],
    };
    const all = renderRuns({ ...base, tab: 'traceability', traceability });
    expect(all).toContain('REQ-1');
    expect(all).toContain('REQ-2');
    expect(all).toContain('Exigences critiques en échec');
    expect(all).toContain('assertion &quot;ghost&quot; is unknown');
    const failing = renderRuns({ ...base, tab: 'traceability', traceability, status: 'VERIFIED_FAIL' });
    expect(failing).toContain('REQ-1');
    expect(failing).not.toContain('<code>REQ-2</code>');
    expect(renderRuns({ ...base, tab: 'traceability', traceability, status: 'BLOCKED' })).toContain(
      'Aucune exigence avec ce statut',
    );
  });
});
