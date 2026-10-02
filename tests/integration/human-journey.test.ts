import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { runMission } from '../../src/orchestrator.js';
import type { InteractionAccount } from '../../src/recording/human-journey.js';
import type { RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { readGeneratedFlow } from '../helpers.js';
import { startJourneyApp, type JourneyApp } from '../fixtures/journey-app.js';

/** Ce que dit chaque étape d'action (les vérifications expect sont à part). */
function described(steps: FlowStep[]): string[] {
  return steps.flatMap((step) => {
    switch (step.kind) {
      case 'click':
      case 'check':
      case 'uncheck':
        return [`${step.kind} ${step.target.name ?? step.target.value ?? ''}`];
      case 'fill':
        return [`fill ${step.target.value ?? step.target.name ?? ''}`];
      case 'select':
        return [`select ${step.target.value ?? ''}=${step.option}`];
      case 'intent':
        return [
          `intent ${step.intent.kind} ${'target' in step.intent ? step.intent.target : 'field' in step.intent ? step.intent.field : ''}`,
        ];
      default:
        return [];
    }
  });
}

/**
 * HUMAN JOURNEY de bout en bout (§44, §45, §60) : un parcours sur une seule adresse, fait de
 * boutons, d'une carte maison, d'un en-tête d'accordéon, d'un onglet, d'un bouton sans effet,
 * de deux « Continue » et d'une confirmation. Le flow les garde TOUS, dans l'ordre humain, et
 * chaque interaction a un statut : aucune n'est perdue sans explication.
 */
describe('Human journey (E2E)', () => {
  let app: JourneyApp;
  let dir: string;
  let outcome: RecordOutcome;
  const events: RecordingEvent[] = [];

  beforeAll(async () => {
    app = await startJourneyApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-journey-'));
    outcome = await runRecording({
      name: 'journey',
      url: `${app.url}/`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      onEvent: (event) => events.push(event),
      drive: async ({ page }) => {
        const pause = (): Promise<void> => page.waitForTimeout(700);
        await page.getByRole('link', { name: 'Task list' }).click();
        await page.waitForURL('**/tasks');
        await pause();
        await page.getByText('Request 42').click();
        await page.waitForURL('**/simulator');
        await pause();
        await page.getByRole('button', { name: 'Company interview' }).click();
        await pause();
        await page.getByLabel('Premium plan').check();
        await pause();
        await page.getByText('Employee section').click();
        await pause();
        // Un clic de focus, puis la frappe : fusionnés en une saisie.
        await page.getByLabel('Employee name').click();
        await page.getByLabel('Employee name').pressSequentially('Jane Doe', { delay: 10 });
        await pause();
        await page.getByRole('tab', { name: 'Company' }).click();
        await pause();
        await page.getByLabel('Legal name').fill('Alpha Services');
        await pause();
        await page.getByLabel('Business number').fill('1234567890');
        await pause();
        await page.getByRole('button', { name: 'Advanced mode' }).click();
        await pause();
        await page.getByRole('button', { name: 'Continue' }).click();
        await pause();
        await page.getByLabel('Request type').selectOption('INCIDENT');
        await pause();
        await page.getByLabel('Description').fill('Printer down');
        await pause();
        await page.getByRole('button', { name: 'Continue' }).click();
        await pause();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await pause();
        await page.getByRole('button', { name: 'Submit' }).click();
        await page.getByText('Request saved').waitFor();
        await page.waitForTimeout(1000);
      },
    });
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  it('§44 / §20 / §46: every functional interaction is a step, in the human order', async () => {
    const flow = await readGeneratedFlow(outcome.directory);
    const steps = described(flow.steps);
    const expected = [
      'Task list',
      'Request 42',
      'Company interview',
      'Premium plan',
      'Employee section',
      'Employee name',
      'Company',
      'Legal name',
      'Business number',
      'Advanced mode',
      'Continue',
      'Request type',
      'Description',
      'Continue',
      'Confirm',
      'Submit',
    ];
    expect(steps, steps.join('\n')).toHaveLength(expected.length);
    expected.forEach((name, index) => {
      expect(steps[index], `step ${String(index + 1)}: ${steps.join(' | ')}`).toContain(name);
    });
    expect(flow.steps.filter((step) => step.kind === 'goto')).toEqual([]);
  });

  it('§45 / §60: meaningful = preserved + merged + excluded + noise; nothing lost; the manifest explains every interaction', async () => {
    const summary = outcome.result.journey.summary;
    expect(summary.unaccounted, JSON.stringify(outcome.result.journey.accounts, null, 1)).toBe(0);
    expect(summary.meaningful).toBe(
      summary.preserved + summary.unresolvedPreserved + summary.merged + summary.excluded + summary.noise,
    );
    expect(outcome.result.journey.ordered).toBe(true);
    const accounts = JSON.parse(
      await readFile(path.join(outcome.directory, 'action-preservation.json'), 'utf8'),
    ) as InteractionAccount[];
    // La carte maison et le bouton sans effet : gardés, UNRESOLVED.
    expect(accounts.find((account) => account.target === 'Request 42')).toMatchObject({
      status: expect.stringMatching(/PRESERVED/) as unknown,
    });
    expect(accounts.find((account) => account.target === 'Advanced mode')).toMatchObject({
      status: 'UNRESOLVED_BUT_PRESERVED',
    });
    // Le clic de focus avant la frappe : fusionné, avec sa règle.
    expect(accounts).toContainEqual(
      expect.objectContaining({ type: 'CLICK', status: 'MERGED', rule: 'REDUNDANT_FOCUS_CLICK' }),
    );
    const manifest = JSON.parse(
      await readFile(path.join(outcome.directory, 'human-journey.json'), 'utf8'),
    ) as {
      fidelity: string;
      dependencies: unknown[];
      phases: unknown[];
    };
    expect(manifest.fidelity).toBe('SEMANTIC');
    expect(manifest.dependencies.length).toBeGreaterThan(2);
    expect(manifest.phases.length).toBeGreaterThan(2);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'HUMAN_INTERACTION_CAPTURED',
        'HUMAN_INTERACTION_PRESERVED',
        'HUMAN_INTERACTION_MERGED',
        'HUMAN_ACTION_DEPENDENCY_DISCOVERED',
        'HUMAN_JOURNEY_BUILT',
        'HUMAN_JOURNEY_VALIDATED',
      ]),
    );
    const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
    expect(html).toContain('Human journey');
    expect(html).toContain('Lost without explanation');
    expect(await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8')).toContain(
      'UNRESOLVED_HUMAN_ACTION',
    );
  });

  it('§29: the .feature tells the same journey (every click is a sentence)', async () => {
    const feature = await readFile(path.join(outcome.directory, 'generated.feature'), 'utf8');
    for (const name of [
      'Company interview',
      'Employee section',
      'Company',
      'Advanced mode',
      'Continue',
      'Confirm',
      'Submit',
    ])
      expect(feature).toContain(name);
  });

  it('§49 / replay: the faithful flow replays through the UI, SafetyPolicy still deciding (POST allowed by the step)', async () => {
    const generated = parseYaml(
      await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    if (typeof generated.testData === 'string')
      generated.testData = path.join(outcome.directory, generated.testData);
    const { config } = parseConfig(
      `mission: { name: replay-journey }
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
    const report = result.flows[0];
    expect(
      report?.status,
      JSON.stringify(report?.steps.map((step) => [step.description, step.status, step.reason])),
    ).toBe('PASSED');
    expect(app.created.length).toBe(before + 1);
    expect(app.created.at(-1)).toMatchObject({ requestType: 'INCIDENT', premium: true });
    // §70 : chaque action EXÉCUTÉE est aussi CONFIRMÉE par son effet (ou n'exigeait rien, avec sa raison).
    const verified = report?.steps.filter((step) => step.effect !== undefined) ?? [];
    expect(verified.length).toBeGreaterThan(8);
    for (const step of verified)
      expect(['CONFIRMED', 'NOT_REQUIRED'], `${step.description}: ${JSON.stringify(step.effect)}`).toContain(
        step.effect?.status,
      );
    expect(verified.filter((step) => step.effect?.status === 'CONFIRMED').length).toBeGreaterThan(6);
  }, 180_000);
});
