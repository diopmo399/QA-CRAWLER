import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { readGeneratedFlow } from '../helpers.js';
import { startEffectsApp, type EffectsApp } from '../fixtures/effects-app.js';

/**
 * CLICKED != SUCCEEDED (§61–§69) : chaque étape est EXÉCUTÉE puis CONFIRMÉE par son effet ;
 * une cible trouvée par un CSS de position n'est cliquée que si c'est la bonne ; le rejeu
 * s'arrête à la PREMIÈRE divergence, pas à l'étape suivante qui ne trouve plus rien.
 */
describe('Action effect verification (replay)', () => {
  let app: EffectsApp;
  let dir: string;

  beforeAll(async () => {
    app = await startEffectsApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-effects-'));
  });
  afterAll(async () => {
    await app.close();
  });

  let run = 0;
  const replay = async (startAt: string, steps: string, extra = ''): Promise<FlowRunReport> => {
    run += 1;
    const { config } = parseConfig(
      `mission: { name: effects-${String(run)} }
target: { baseUrl: ${app.url}, startAt: "${startAt}" }
exploration: { autonomous: false, actionTimeoutMs: 6000, settleTimeMs: 150 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 1500${extra} }
output: { reportsDir: ${path.join(dir, `r${String(run)}`)}, screenshotsDir: ${path.join(dir, `s${String(run)}`)} }
flows:
  - name: effects
    steps:
${steps}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    return report;
  };
  const describeSteps = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [step.description, step.status, step.reason, step.effect?.status]),
    );

  it('§61 / §64 / §79: a click that Playwright executes without its effect is NO_EFFECT, and the replay stops there (first divergence)', async () => {
    const started = Date.now();
    const report = await replay(
      '/?broken=1',
      `      - click: { role: button, name: Tasks }
        effects: { appears: ["button:Company interview"] }
      - click: { role: button, name: Company interview }`,
    );
    const [tasks, interview] = report.steps;
    expect(tasks, describeSteps(report)).toMatchObject({
      status: 'FAILED',
      effect: { execution: 'EXECUTED', status: 'NO_EFFECT' },
    });
    expect(tasks?.reason).toMatch(/^ACTION_NOT_CONFIRMED \(NO_EFFECT\)/);
    expect(tasks?.effect?.recovery[0]).toMatch(/^RE_RESOLVE_TARGET/);
    expect(interview?.status).toBe('SKIPPED');
    expect(report.divergence).toMatchObject({ stepIndex: 1 });
    // Pas d'attente du délai de l'étape suivante : la divergence est vue à l'étape 1.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it('§28 / §7: without any learned effect, the next step target missing after the click is the divergence', async () => {
    const report = await replay(
      '/?broken=1',
      `      - click: { role: button, name: Tasks }
      - click: { role: button, name: Company interview }`,
    );
    expect(report.steps[0], describeSteps(report)).toMatchObject({
      status: 'FAILED',
      effect: { status: 'NO_EFFECT' },
    });
    expect(report.steps[0]?.effect?.expected).toEqual([
      'next target "role=button[name="Company interview"]" available',
    ]);
    expect(report.divergence?.stepIndex).toBe(1);
  }, 60_000);

  it('§62 / §63: a structural CSS that now points to "Settings" is never clicked; the same element is healed by its fingerprint', async () => {
    const before = app.counts.settings;
    const report = await replay(
      '/?layout=b',
      `      - click: { css: "main > div > button:nth-of-type(1)" }
        fingerprint: { role: button, name: Tasks, tag: button }
        effects: { appears: ["button:Company interview"] }
      - click: { role: button, name: Company interview }`,
    );
    expect(report.status, describeSteps(report)).toBe('PASSED');
    expect(report.steps[0]?.effect).toMatchObject({
      status: 'CONFIRMED',
      healed: { to: 'role=button[name="Tasks"]' },
    });
    expect(app.counts.settings).toBe(before);
    // Sans guérison : la cible ne correspond pas, elle n'est pas cliquée.
    const strict = await replay(
      '/?layout=b',
      `      - click: { css: "main > div > button:nth-of-type(1)" }
        fingerprint: { role: button, name: Tasks, tag: button }`,
      ', locatorHealing: false',
    );
    expect(strict.steps[0], describeSteps(strict)).toMatchObject({
      status: 'FAILED',
      effect: { status: 'TARGET_MISMATCH', execution: 'NOT_EXECUTED' },
    });
    // Le CSS désigne 2 éléments, aucun ne porte l'identité enregistrée : rien n'est choisi au hasard
    // (jamais « le premier », même s'il correspondait par chance).
    expect(strict.steps[0]?.reason).toMatch(/^(TARGET_FINGERPRINT_MISMATCH|TARGET_LOCATOR_NON_UNIQUE)/);
    expect(app.counts.settings).toBe(before);
  }, 90_000);

  it('§63: a recorded CSS that no longer exists is healed (role + name), then the effect confirms it', async () => {
    const report = await replay(
      '/',
      `      - click: { css: "#old-tasks-button" }
        fingerprint: { role: button, name: Tasks, tag: button }
        effects: { appears: ["button:Company interview"] }`,
    );
    expect(report.steps[0], describeSteps(report)).toMatchObject({
      status: 'PASSED',
      effect: { status: 'CONFIRMED' },
    });
  }, 60_000);

  it('§65 / §66 / §24: a tab and an accordion keep the same URL and state fingerprint, yet are CONFIRMED (the next field appeared)', async () => {
    const report = await replay(
      '/',
      `      - click: { role: tab, name: Company }
      - fill: { label: Legal name, value: Alpha }
      - click: { text: More information }
      - fill: { label: Details, value: Some text }`,
    );
    expect(report.status, describeSteps(report)).toBe('PASSED');
    expect(report.steps[0]?.effect?.status).toBe('CONFIRMED');
    expect(report.steps[2]?.effect?.status).toBe('CONFIRMED');
  }, 60_000);

  it('§67: a click confirmed by its request and by what it displays (slow GET)', async () => {
    const report = await replay(
      '/',
      `      - click: { role: button, name: Load tasks }
        effects: { appears: ["button:Task one"], request: "GET /api/tasks" }`,
    );
    expect(report.steps[0], describeSteps(report)).toMatchObject({
      status: 'PASSED',
      effect: { status: 'CONFIRMED' },
    });
  }, 60_000);

  it('§68 / §32: a write answered 500 is MUTATION_EFFECT_AMBIGUOUS and is never sent twice', async () => {
    const before = app.counts.submit;
    const report = await replay(
      '/',
      `      - click: { role: button, name: Submit }
        allow: MUTATION
        effects: { request: "POST /api/submit" }`,
    );
    expect(report.steps[0], describeSteps(report)).toMatchObject({
      status: 'FAILED',
      effect: { status: 'AMBIGUOUS' },
    });
    expect(report.steps[0]?.reason).toMatch(/MUTATION_EFFECT_AMBIGUOUS/);
    expect(app.counts.submit).toBe(before + 1);
  }, 60_000);

  it('§69 / §36: a control covered by an overlay is clicked once the overlay is gone (no force click), then confirmed', async () => {
    const report = await replay(
      '/?overlay=1',
      `      - click: { role: button, name: Tasks }
        effects: { appears: ["button:Company interview"] }`,
    );
    expect(report.steps[0], describeSteps(report)).toMatchObject({
      status: 'PASSED',
      effect: { status: 'CONFIRMED' },
    });
  }, 60_000);

  it('§60: replay.verifyActionEffects: false keeps the previous behavior (the failure shows up at the next step)', async () => {
    const report = await replay(
      '/?broken=1',
      `      - click: { role: button, name: Tasks }
        effects: { appears: ["button:Company interview"] }
      - click: { role: button, name: Company interview }
        timeoutMs: 1500`,
      ', verifyActionEffects: false',
    );
    expect(report.steps[0]?.status, describeSteps(report)).toBe('PASSED');
    expect(report.steps[0]?.effect).toBeUndefined();
    expect(report.steps[1]?.status).toBe('FAILED');
  }, 60_000);

  it('§39 / §40 / §41: a click inside a web component (shadow DOM) is recorded on the real button, not on the host, and replays', async () => {
    const outcome = await runRecording({
      name: 'shadow',
      url: `${app.url}/`,
      overrides: { headless: true, reportsDir: path.join(dir, 'recording') },
      env: {},
      drive: async ({ page }) => {
        await page.locator('x-panel').getByRole('button', { name: 'Open details' }).click();
        await page.waitForTimeout(700);
        await page.getByLabel('Inner name').fill('Jane');
        await page.waitForTimeout(700);
      },
    });
    const flow = await readGeneratedFlow(outcome.directory);
    expect(flow.steps[0]).toMatchObject({
      kind: 'click',
      target: { strategy: 'role', role: 'button', name: 'Open details' },
    });
    expect(flow.steps[1]).toMatchObject({ kind: 'fill', target: { strategy: 'label', value: 'Inner name' } });
    expect(outcome.result.journey.summary.unaccounted).toBe(0);
    const report = await replay(
      '/',
      `      - click: { role: button, name: Open details }
      - fill: { label: Inner name, value: Jane }`,
    );
    expect(report.status, describeSteps(report)).toBe('PASSED');
    expect(report.steps[0]?.effect?.status).toBe('CONFIRMED');
  }, 120_000);
});
