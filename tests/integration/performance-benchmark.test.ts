import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import type { PerformanceReport } from '../../src/performance/performance-tracer.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startContextApp, type ContextApp } from '../fixtures/context-app.js';
import { startFilterApp, type FilterApp } from '../fixtures/filter-app.js';

/**
 * PERFORMANCE BENCHMARK : des parcours représentatifs (une liste filtrée puis une demande ouverte ; un
 * dossier client à onglets, section repliable, case et dialogues), enregistrés par un humain simulé
 * puis rejoués avec la configuration PAR DÉFAUT. Chaque rejeu produit performance.json ; avec
 * QA_PERF_OUT, les rapports sont copiés dans ce dossier (mesures avant / après).
 */
describe('Performance benchmark (record → replay, real browser)', () => {
  let filterApp: FilterApp;
  let contextApp: ContextApp;
  let dir: string;
  const out = process.env.QA_PERF_OUT;

  beforeAll(async () => {
    filterApp = await startFilterApp();
    contextApp = await startContextApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-perf-'));
  });
  afterAll(async () => {
    await filterApp.close();
    await contextApp.close();
  });

  const SCENARIOS: Record<
    string,
    { url: () => string; startAt: string; baseUrl: () => string; drive: (page: Page) => Promise<void> }
  > = {
    'list-filter-process': {
      baseUrl: () => filterApp.url,
      url: () => `${filterApp.url}/?variant=navigate`,
      startAt: '/?variant=navigate',
      drive: async (page) => {
        await page.getByRole('button', { name: 'Filter' }).click();
        await page.waitForTimeout(700);
        await page.getByLabel('Field').selectOption('Company name');
        await page.waitForTimeout(700);
        await page.getByLabel('Operator').selectOption('Like');
        await page.waitForTimeout(700);
        await page.locator('#valueInput').fill('alpha');
        await page.waitForTimeout(700);
        const searched = page.waitForResponse((response) => response.url().includes('/api/search'));
        await page.getByRole('button', { name: 'Apply' }).click();
        await searched;
        await page.getByRole('button', { name: 'Process request' }).click();
        await page.getByRole('heading', { name: 'Process' }).waitFor();
        await page.waitForTimeout(1500);
      },
    },
    'client-context': {
      baseUrl: () => contextApp.url,
      url: () => `${contextApp.url}/client`,
      startAt: '/client',
      drive: async (page) => {
        await page.getByRole('tab', { name: 'Company' }).click();
        await page.waitForTimeout(500);
        await page.getByLabel('Business number').fill('12345');
        await page.waitForTimeout(500);
        await page.getByLabel('Interview done').check();
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'Filter' }).click();
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'Edit request' }).click();
        await page.waitForTimeout(500);
        await page.locator('#dlg-filter .apply').click();
        await page.getByText('Filter applied').waitFor();
        await page.waitForTimeout(1000);
      },
    },
  };

  const measure = async (
    name: string,
  ): Promise<{ report: FlowRunReport; performance: PerformanceReport }> => {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(name);
    const recorded = await runRecording({
      name,
      url: scenario.url(),
      overrides: { headless: true, reportsDir: path.join(dir, `record-${name}`) },
      env: {},
      drive: async ({ page }) => {
        await scenario.drive(page);
      },
    });
    const flow = parseYaml(await readFile(path.join(recorded.directory, 'generated.flow.yaml'), 'utf8')) as {
      testData?: string;
    } & Record<string, unknown>;
    const reportsDir = await mkdtemp(path.join(dir, `replay-${name}-`));
    // La configuration PAR DÉFAUT (aucun délai réduit) : ce que vit un utilisateur.
    const { config } = parseConfig(
      `mission: { name: perf-${name} }
target: { baseUrl: ${scenario.baseUrl()}, startAt: "${scenario.startAt}" }
exploration: { autonomous: false }
report: { failOnSeverity: NONE }
output: { reportsDir: ${reportsDir} }
flows:
  - ${JSON.stringify({ ...flow, startAt: scenario.startAt, testData: path.join(recorded.directory, 'test-data.yaml') })}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    const performance = JSON.parse(
      await readFile(path.join(reportsDir, 'performance.json'), 'utf8'),
    ) as PerformanceReport;
    if (out) {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, `${name}.performance.json`), JSON.stringify(performance, null, 2));
      await writeFile(
        path.join(out, `${name}.summary.txt`),
        await readFile(path.join(reportsDir, 'performance-summary.txt'), 'utf8'),
      );
    }
    return { report, performance };
  };

  const describeRun = (report: FlowRunReport): string =>
    JSON.stringify(report.steps.map((entry) => [entry.description, entry.status, entry.reason]));

  for (const name of Object.keys(SCENARIOS))
    it(`${name}: replays PASSED and every step has a performance trace with phases and waits`, async () => {
      const { report, performance } = await measure(name);
      expect(report.status, describeRun(report)).toBe('PASSED');
      expect(performance.actions).toHaveLength(report.steps.length);
      for (const trace of performance.actions) {
        expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
        expect(trace.phases.length, trace.description).toBeGreaterThan(0);
      }
      expect(performance.summary.actions).toBe(report.steps.length);
      expect(performance.summary.fastPath + performance.summary.deepPath).toBe(report.steps.length);
    }, 180_000);
});
