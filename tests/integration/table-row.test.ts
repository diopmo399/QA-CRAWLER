import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import type { ProgressUpdate } from '../../src/progress/progress.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { parse as parseYaml } from 'yaml';
import { startTaskListApp, type TaskListApp } from '../fixtures/task-list-app.js';

/**
 * TABLE ROW IDENTITY : le même lien « Process request » sur chaque ligne. La ligne est désignée par ses
 * valeurs (row: colonne → valeur), jamais par sa position : tri inverse, nouveaux éléments en tête,
 * pagination, grille ARIA / Material — toujours la même tâche ; une ligne ambiguë n'est jamais choisie.
 */
describe('Table row identity (real browser)', () => {
  let app: TaskListApp;
  let dir: string;

  beforeAll(async () => {
    app = await startTaskListApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-table-row-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (
    query: string,
    click: Record<string, unknown>,
    expectText?: string,
  ): Promise<FlowRunReport> => {
    const reportsDir = await mkdtemp(path.join(dir, 'run-'));
    const steps = [{ click }, ...(expectText ? [{ expect: { text: expectText } }] : [])];
    const { config } = parseConfig(
      `mission: { name: table-row }
target: { baseUrl: ${app.url}, startAt: "/${query}" }
exploration: { autonomous: false, actionTimeoutMs: 4000 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${reportsDir} }
flows:
  - ${JSON.stringify({ name: 'process a task', steps })}
`,
      {},
      {},
    );
    const { result } = await runMission(config, {
      env: {},
      onProgress: (update) => runProgress.push(update),
    });
    return result.flows[0] as FlowRunReport;
  };
  const runProgress: ProgressUpdate[] = [];
  const describeRun = (report: FlowRunReport): string =>
    JSON.stringify(report.steps.map((step) => [step.description, step.status, step.reason]));
  const KEY = { text: 'Process request', row: { 'Business key': '2935' } };

  it.each([
    ['default order', ''],
    ['reverse order', '?order=desc'],
    ['new tasks inserted at the top', '?fresh=1'],
    ['ARIA / Material grid (mat-row, mat-cell, sort icon in the header)', '?material=1&order=desc'],
  ])(
    'the row of business key 2935 is always the one processed — %s',
    async (_label, query) => {
      const report = await run(query, KEY, 'Task 2935');
      expect(report.status, describeRun(report)).toBe('PASSED');
      expect(report.steps[0]?.description).toContain('in row {Business key=2935}');
      // Après le dernier flow, le run dit ce qu'il fait jusqu'aux rapports.
      const finishing = runProgress.splice(0);
      expect(finishing.map((update) => update.label)).toEqual([
        'Closing the browser',
        'Saving the memory',
        'Closing the run',
        'Comparing with earlier runs',
        'Saving the knowledge',
        'Writing the artifacts',
        'Writing the reports',
        '1 flow(s), 0 issue(s)',
      ]);
      expect(finishing.at(-1)).toMatchObject({ state: 'DONE', task: 'Finishing the run' });
    },
    120_000,
  );

  it('a row on another page of the table: the pages are read until the row is found', async () => {
    const report = await run('', { text: 'Process request', row: { 'Business key': '1615' } }, 'Task 1615');
    expect(report.status, describeRun(report)).toBe('PASSED');
    const reversed = await run(
      '?order=desc',
      { text: 'Process request', row: { 'Business key': '1615' } },
      'Task 1615',
    );
    expect(reversed.status, describeRun(reversed)).toBe('PASSED');
  }, 120_000);

  it('several columns together, and a "contains" value (~)', async () => {
    const report = await run(
      '?order=desc',
      { text: 'Process request', row: { 'Legal name': 'Tech One', Status: 'NEW' } },
      'Task 2936',
    );
    expect(report.status, describeRun(report)).toBe('PASSED');
    const contains = await run(
      '',
      { text: 'Process request', row: { 'Legal name': '~crawler' } },
      'Task 2934',
    );
    expect(contains.status, describeRun(contains)).toBe('PASSED');
  }, 120_000);

  it('several rows match (rowPick: unique by default): AMBIGUOUS_ROW, nothing clicked; rowPick: first takes the first matching row', async () => {
    const ambiguous = await run('', { text: 'Process request', row: { Status: 'NEW' } });
    expect(ambiguous.steps[0]?.status).toBe('FAILED');
    expect(ambiguous.steps[0]?.reason).toMatch(/AMBIGUOUS_ROW — 3 rows match \{Status=NEW\}/);
    const first = await run(
      '?fresh=1',
      { text: 'Process request', row: { Status: 'NEW' }, rowPick: 'first' },
      'Task 3001',
    );
    expect(first.status, describeRun(first)).toBe('PASSED');
  }, 120_000);

  it('an unknown column or a row that does not exist: ROW_NOT_FOUND, explained (never another row)', async () => {
    const column = await run('', { text: 'Process request', row: { Reference: '2935' } });
    expect(column.steps[0]?.reason).toMatch(
      /ROW_NOT_FOUND: no table column "Reference" \(columns: task name, process, status/,
    );
    const missing = await run('', { text: 'Process request', row: { 'Business key': '9999' } });
    expect(missing.steps[0]?.reason).toMatch(
      /ROW_NOT_FOUND: no row matches \{Business key=9999\} \(9 row\(s\) read on 2 page\(s\)\)/,
    );
  }, 120_000);
  it('RECORDING: the click on the repeated link records the row by its unique key column (Business key), never its position — and the replay finds it in another order', async () => {
    const progress: ProgressUpdate[] = [];
    const outcome = await runRecording({
      onProgress: (update) => progress.push(update),
      name: 'process task',
      url: `${app.url}/`,
      overrides: { headless: true, reportsDir: path.join(dir, 'recording') },
      env: {},
      drive: async ({ page }) => {
        await page
          .getByRole('row', { name: /2930/ })
          .getByRole('link', { name: 'Process request' })
          .waitFor();
        await page.waitForTimeout(600);
        await page.getByRole('row', { name: /2930/ }).getByRole('link', { name: 'Process request' }).click();
        await page.getByText('Task 2930').waitFor();
        await page.waitForTimeout(800);
      },
    });
    const flow = parseYaml(await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8')) as {
      steps: Record<string, Record<string, unknown> | undefined>[];
    };
    const click = flow.steps.find((step) => step.click)?.click;
    expect(click?.row, JSON.stringify(flow.steps)).toEqual({ 'Business key': '2930' });
    expect(click?.nth).toBeUndefined();
    // Après l'arrêt : chaque phase de la finalisation est annoncée, dans l'ordre, jusqu'à DONE.
    const phases = [...new Set(progress.filter((u) => u.state === 'RUNNING').map((u) => u.label))];
    expect(phases).toEqual([
      'Finishing the capture',
      'Closing the browser',
      'Building the flow',
      'Writing the files',
      'Auditing the flow',
      'Writing the report',
    ]);
    expect(progress.at(-1)).toMatchObject({ state: 'DONE', task: 'Finalizing the recording', total: 6 });
    expect(progress.at(-1)?.label).toMatch(/^\d+ step\(s\)$/);
    for (const query of ['?order=desc', '?fresh=1']) {
      const report = await run(query, click ?? {}, 'Task 2930');
      expect(report.status, `${query}: ${describeRun(report)}`).toBe('PASSED');
    }
  }, 180_000);
});
