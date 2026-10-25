import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import {
  createQaCrawler,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults, REPORTS_DIR } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startQualityApp, type QualityApp, type QualityAppBugs } from '../fixtures/quality-app.js';

/**
 * COMPARAISON DE DEUX VRAIES EXÉCUTIONS ET TRAÇABILITÉ : le moteur joue deux fois la même mission
 * (exigences, règle, assertions métier) sur une application à API en mémoire, la seconde avec un
 * défaut activé (le serveur enregistre un autre titre). Les deux runs sont écrits dans le dossier du
 * projet, là où le serveur du SDK range ses explorations. Le SDK les compare et sert la traçabilité ;
 * le composant <qa-crawler-run-compare> les montre dans Chromium.
 */
let app: QualityApp;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
const BASE = 'run-2026-10-20T10-00-00-000Z';
const HEAD = 'run-2026-10-21T10-00-00-000Z';

const mission = (reportsDir: string, data: string): string => `mission: { name: sdk-runs }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
report: { failOnSeverity: NONE, language: fr }
output: { reportsDir: ${reportsDir}, screenshotsDir: ${path.join(reportsDir, 'shots')} }
requirements:
  - { id: REQ-REQUEST-CREATE, description: A request is created with the title typed, criticality: CRITICAL }
  - { id: REQ-REQUEST-EXPORT, description: Requests can be exported }
flows:
  - name: create-request
    startAt: /
    testData: ${data}
    requirements: [REQ-REQUEST-CREATE]
    steps:
      - click: { role: button, name: New request }
        allow: MUTATION
      - fill: { label: Title, value: { testData: request.title } }
      - click: { role: button, name: Save }
        allow: MUTATION
      - expect: { url: /requests/ }
    assertions:
      - id: title-saved
        description: The server returns the title typed in this run
        criticality: HIGH
        check: { kind: value, source: response, method: POST, path: /api/requests, field: title, expected: { testData: request.title } }
`;

async function play(run: string, bugs: QualityAppBugs, data: string): Promise<void> {
  app.reset();
  Object.assign(app.bugs, bugs);
  const reportsDir = path.join(workspace, project.id, REPORTS_DIR, run);
  const { config } = parseConfig(mission(reportsDir, data), {}, {});
  await runMission(config, { env: {} });
}

beforeAll(async () => {
  app = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-runs-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: `${app.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
  const data = path.join(workspace, 'test-data.yaml');
  await writeFile(data, `values:\n  request:\n    title: { strategy: generated, generator: text }\n`);
  await play(BASE, {}, data);
  await play(HEAD, { wrongTitle: true }, data);
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK — two real runs compared, and their traceability', () => {
  it('lists both explorations of the project', async () => {
    const names = (await client.reports.list(project.id))
      .filter((entry) => entry.kind === 'exploration')
      .map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining([BASE, HEAD]));
  });

  it('compares the runs with the engine rule: the flow no longer passes, the requirement is now failing', async () => {
    const view = await client.reports.compare(project.id, BASE, HEAD);
    const flow = view.flows.find((item) => item.name === 'create-request');
    expect(flow).toMatchObject({
      presence: 'BOTH',
      baseStatus: 'PASSED',
      headStatus: 'FAILED',
      verdict: 'CHANGED',
    });
    expect(flow?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FLOW_STATUS' })]));
    expect(view.summary.newlyFailing).toEqual(['create-request']);
    expect(view.traceability).toEqual({ base: true, head: true });
    const create = view.requirements.find((item) => item.id === 'REQ-REQUEST-CREATE');
    expect(create).toMatchObject({ baseStatus: 'VERIFIED_PASS', headStatus: 'VERIFIED_FAIL', changed: true });
    // Aucun flow ne la cite : non couverte dans les deux runs, rien d'inventé.
    expect(view.requirements.find((item) => item.id === 'REQ-REQUEST-EXPORT')).toMatchObject({
      baseStatus: 'NOT_COVERED',
      headStatus: 'NOT_COVERED',
      changed: false,
    });
  });

  it('serves the traceability of a run: requirement, assertion and its evidence, as the engine wrote them', async () => {
    const trace = await client.reports.traceability(project.id, HEAD);
    expect(trace.verdict).toBe('FAIL');
    const create = trace.requirements.find((item) => item.id === 'REQ-REQUEST-CREATE');
    expect(create).toMatchObject({ status: 'VERIFIED_FAIL', flows: ['create-request'] });
    expect(create?.assertions).toEqual([expect.objectContaining({ id: 'title-saved', status: 'FAIL' })]);
    expect(trace.summary.criticalFailures).toEqual(['REQ-REQUEST-CREATE']);
    expect(trace.limits.length).toBeGreaterThan(0);
    const regression = await client.reports.regression(project.id, HEAD);
    expect(Object.keys(regression.summary)).toEqual(
      expect.arrayContaining(['NEW_REGRESSION', 'REGRESSION_FIXED']),
    );
  });

  it('shows the comparison and the traceability in <qa-crawler-run-compare>', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${server.url}/runs?project=${project.id}&base=${BASE}&head=${HEAD}`);
      const flowRow = page.locator('qa-crawler-run-compare').getByRole('button', { name: /create-request/ });
      await flowRow.waitFor();
      await expect.poll(() => flowRow.textContent()).toContain('Changé');
      await page.getByText('Ne passent plus').waitFor();
      await flowRow.click();
      await expect.poll(() => flowRow.getAttribute('aria-expanded')).toBe('true');
      await page.getByText('Statut du flow').waitFor();
      const rows = page.locator('qa-crawler-run-compare').locator('tr.chg');
      await expect.poll(() => rows.count()).toBe(1);
      await expect.poll(() => rows.first().textContent()).toContain('Vérifiée — échec');

      await page.getByRole('tab', { name: 'Traçabilité' }).click();
      await page.getByText('Exigences critiques en échec').waitFor();
      const select = page.locator('qa-crawler-run-compare').locator('select[data-status]');
      await select.selectOption('NOT_COVERED');
      const listed = page.locator('qa-crawler-run-compare').locator('.reqlist code');
      await expect.poll(() => listed.allTextContents()).toEqual(['REQ-REQUEST-EXPORT']);
      // Le clavier passe d'un onglet à l'autre.
      await page.getByRole('tab', { name: 'Traçabilité' }).press('ArrowLeft');
      await expect
        .poll(() => page.getByRole('tab', { name: 'Comparaison' }).getAttribute('aria-selected'))
        .toBe('true');
    } finally {
      await page.close();
    }
  }, 60_000);
});
