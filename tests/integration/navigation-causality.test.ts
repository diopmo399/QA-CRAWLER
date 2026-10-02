import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { runMission } from '../../src/orchestrator.js';
import type { RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { generatedFlow, readGeneratedFlow } from '../helpers.js';
import { startRequestsSpa, type RequestsSpa } from '../fixtures/requests-spa.js';

const clickNames = (steps: FlowStep[]): string[] =>
  steps.flatMap((step) => (step.kind === 'click' ? [step.target.name ?? step.target.value ?? ''] : []));

/**
 * ACTION CORRELATION de bout en bout, sur une application monopage façon Angular : la tuile
 * « Demandes » (un <div> cliquable), « Créer nouvelle demande » (données lentes, puis
 * router.navigate 3 s après le clic), le formulaire, « Soumettre » (POST lent → 201 →
 * /demandes/{id}). Le flow garde les clics, jamais un goto vers les pages qu'ils ont ouvertes.
 */
describe('Navigation causality (E2E)', () => {
  let app: RequestsSpa;
  let dir: string;
  let outcome: RecordOutcome;
  const events: RecordingEvent[] = [];

  beforeAll(async () => {
    app = await startRequestsSpa();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-causality-'));
    outcome = await runRecording({
      name: 'creer demande',
      url: `${app.url}/`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      onEvent: (event) => events.push(event),
      drive: async ({ page }) => {
        await page.getByText('Demandes').click();
        await page.waitForURL('**/demandes');
        await page.waitForTimeout(800);
        await page.getByRole('button', { name: 'Créer nouvelle demande' }).click();
        await page.waitForURL('**/demandes/create', { timeout: 10_000 });
        await page.waitForTimeout(800);
        await page.getByLabel('Description').fill('Une description');
        await page.waitForTimeout(600);
        await page.getByLabel('Type').selectOption('CLAIM');
        await page.getByLabel('Urgent').check();
        await page.waitForTimeout(600);
        await page.getByRole('button', { name: 'Soumettre' }).click();
        await page.waitForURL(/\/demandes\/\d+$/, { timeout: 10_000 });
        await page.waitForTimeout(1000);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('keeps every human click; the routes are their effects, not goto steps (§54, §61)', async () => {
    const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
    const flow = generatedFlow(yaml, outcome.directory);
    expect(flow.startAt).toBe('/');
    expect(flow.steps.filter((step) => step.kind === 'goto')).toEqual([]);
    expect(clickNames(flow.steps)).toEqual(['Demandes', 'Créer nouvelle demande', 'Soumettre']);
    expect(flow.steps.map((step) => step.kind)).toEqual(
      expect.arrayContaining(['click', 'click', 'fill', 'select', 'check', 'click', 'expect']),
    );
    const submit = flow.steps.find((step) => step.kind === 'click' && step.target.name === 'Soumettre');
    expect(submit?.allow).toEqual(['MUTATION']);
    const kept = outcome.result.normalized.kept;
    expect(
      kept.find((action) => action.target?.label === 'Créer nouvelle demande')?.navigation?.routes,
    ).toEqual(['/demandes/create']);
    expect(kept.find((action) => action.target?.label === 'Soumettre')?.navigation?.routes[0]).toMatch(
      /^\/demandes\/\d+$/,
    );
    expect(outcome.result.correlation?.stats).toMatchObject({ correlated: 3, gotos: 1 });
    expect(outcome.result.warnings.map((warning) => warning.code)).not.toContain(
      'SUSPICIOUS_NAVIGATION_COLLAPSE',
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'ACTION_CORRELATION_STARTED',
        'NAVIGATION_CORRELATED_TO_ACTION',
        'FLOW_SEMANTIC_PRESERVATION_CHECK',
      ]),
    );
    const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
    expect(html).toContain('Navigation causality');
  });

  it('the generated flow replays the human workflow through the UI (POST /api/demandes, Réclamation)', async () => {
    const generated = parseYaml(
      await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    // Le jeu de données du flow est à côté de lui (test-data.yaml).
    if (typeof generated.testData === 'string')
      generated.testData = path.join(outcome.directory, generated.testData);
    const { config } = parseConfig(
      `mission: { name: replay-causality }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'replay')}, screenshotsDir: ${path.join(dir, 'shots')} }
flows:
  - ${JSON.stringify(generated)}
`,
      {},
      {},
    );
    const before = app.created.length;
    const { result } = await runMission(config, { env: {} });
    const flow = result.flows[0];
    expect(
      flow?.status,
      JSON.stringify(flow?.steps.map((step) => [step.description, step.status, step.reason])),
    ).toBe('PASSED');
    expect(app.created.length).toBe(before + 1);
    expect(app.created.at(-1)).toMatchObject({ type: 'CLAIM', inbound: true, description: true });
  }, 120_000);
});

describe('Navigation causality: goto only with a reason', () => {
  it('an address typed in the address bar is a goto (DIRECT_URL_ENTRY); a click that redirects keeps the click and the chain', async () => {
    const app = await startRequestsSpa();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-causality-goto-'));
    try {
      const outcome = await runRecording({
        name: 'direct and redirect',
        url: `${app.url}/`,
        overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
        env: {},
        drive: async ({ page }) => {
          await page.getByText('Espace protégé').click();
          await page.waitForURL('**/login');
          await page.waitForTimeout(800);
          await page.goto(`${app.url}/aide`);
          await page.waitForTimeout(800);
        },
      });
      const decisions = outcome.result.correlation?.navigations ?? [];
      expect(decisions.map((decision) => decision.kind)).toEqual(['GOTO', 'EFFECT', 'REDIRECT', 'GOTO']);
      expect(decisions.at(-1)).toMatchObject({ gotoReason: 'DIRECT_URL_ENTRY', route: '/aide' });
      const click = outcome.result.normalized.kept.find((action) => action.type === 'CLICK');
      expect(click?.navigation?.routes).toEqual(['/protected', '/login']);
      const flow = await readGeneratedFlow(outcome.directory);
      expect(flow.steps.map((step) => step.kind)).toEqual(expect.arrayContaining(['click', 'goto']));
      expect(flow.steps.filter((step) => step.kind === 'goto')).toEqual([
        expect.objectContaining({ url: '/aide' }),
      ]);
    } finally {
      await app.close();
    }
  }, 90_000);
});
