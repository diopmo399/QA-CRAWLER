import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { startTransitionApp, type TransitionApp } from '../fixtures/transition-app.js';

/**
 * REPLAY TRANSITION SYNCHRONIZATION, en vrai navigateur : une SPA lente (même URL) où chaque action
 * déclenche une transition qui prend du temps. Le rejeu doit attendre la transition pertinente et la
 * stabilité, résoudre la cible suivante sur le DOM FRAIS — jamais valider pendant le rendu.
 */
describe('Replay transition synchronization (real browser)', () => {
  let app: TransitionApp;
  let dir: string;
  beforeAll(async () => {
    app = await startTransitionApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-transition-'));
  });
  afterAll(async () => {
    await app.close();
  });

  let lastReportsDir = '';
  const replay = async (
    variant: string,
    steps: string,
    options: { sync?: string; logging?: string } = {},
  ): Promise<FlowRunReport> => {
    const reportsDir = await mkdtemp(path.join(dir, `${variant}-`));
    lastReportsDir = reportsDir;
    const { config } = parseConfig(
      `mission: { name: transition-${variant} }
target: { baseUrl: ${app.url}, startAt: "/?variant=${variant}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 800, intelligentRecovery: { enabled: false }${options.sync ? `, ${options.sync}` : ''} }
${options.logging ?? ''}
output: { reportsDir: ${reportsDir} }
flows:
  - name: Transition ${variant}
    steps:
${steps}`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    return report;
  };
  const describeFlow = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [
        step.index,
        step.status,
        step.reason,
        step.synchronization?.transition,
        step.synchronization?.signals,
      ]),
    );

  /** Le scénario du problème réel : la cible de N+1 existe dans l'ANCIEN DOM (une autre section). */
  const STALE = `      - click: { role: button, name: Views }
      - click: { role: button, name: Edit }
        allow: [MUTATION]
        fingerprint: { role: button, name: Edit, section: Views }
      - expect: { text: "Editing view" }
`;

  it('E2E (the real problem) — OLD behavior without synchronization: step N+1 is resolved against the old DOM → mismatch, the flow fails', async () => {
    const report = await replay('stale', STALE, { sync: 'uiStabilization: false' });
    expect(report.status, describeFlow(report)).toBe('FAILED');
    const edit = report.steps[1];
    expect(edit?.status).toBe('FAILED');
    expect(edit?.reason).toMatch(/MISMATCH|not found/i);
  }, 90_000);

  it('E2E (the real problem) — NEW behavior: ACTION_EXECUTED → TRANSITION_WAIT → DOM_CHANGED → target N+1 not ready → available → UI_STABLE → effect → fresh resolution of N+1 → PASS', async () => {
    const report = await replay('stale', STALE, { logging: 'logging: { level: DEBUG }' });
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const views = report.steps[0]?.synchronization;
    expect(views?.transition).toBe('NEXT_ACTION_READY');
    expect(views?.signals).toEqual(
      expect.arrayContaining([
        'DOM_CHANGED',
        expect.stringMatching(/^NEXT_ACTION_TARGET_NOT_READY/),
        'NEXT_ACTION_TARGET_AVAILABLE',
        expect.stringMatching(/^UI_STABLE/),
      ]),
    );
    // Jamais avant la transition : la vue arrive à 1 s.
    expect(views?.durationMs).toBeGreaterThanOrEqual(900);
    expect(views?.nextAction).toBe('READY');
    expect(report.steps[1]?.status).toBe('PASSED');
    const log = await readFile(path.join(lastReportsDir, 'engine-log.jsonl'), 'utf8');
    for (const event of [
      'ACTION_EXECUTED',
      'TRANSITION_WAIT',
      'TRANSITION_SIGNAL',
      'UI_STABLE',
      'NEXT_ACTION_READY',
      'EFFECT_VERIFY',
    ])
      expect(log, event).toContain(`"${event}"`);
    const html = await readFile(path.join(lastReportsDir, 'index.html'), 'utf8');
    expect(html).toContain('transition: <b>NEXT_ACTION_READY</b>');
  }, 90_000);

  it('TEST 1 delayed dialog (800 ms): the crawler waits for the dialog, then fills its field — PASS', async () => {
    const report = await replay(
      'dialog',
      `      - click: { role: button, name: Filter }
      - fill: { label: Value, value: alpha }
      - click: { role: button, name: Apply }
        allow: [MUTATION]
      - expect: { text: "Filtered by alpha" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
    expect(report.steps[0]?.synchronization?.signals).toEqual(expect.arrayContaining(['DIALOG_OPENED']));
    // Une saisie n'attend pas de transition : pas la borne complète.
    expect(report.steps[1]?.synchronization?.transition).toBe('NO_TRANSITION_EXPECTED');
    expect(report.steps[1]?.synchronization?.durationMs).toBeLessThan(1600);
  }, 90_000);

  it('TEST 3 same-URL tab: the panel is replaced 400 ms later, same URL — transition confirmed without URL_CHANGED', async () => {
    const report = await replay(
      'tab',
      `      - click: { role: tab, name: Details }
      - fill: { label: Comment, value: hello }
      - click: { role: button, name: Keep }
      - expect: { text: "Kept hello" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const sync = report.steps[0]?.synchronization;
    expect(sync?.transition).toBe('NEXT_ACTION_READY');
    expect(sync?.signals).not.toContain('URL_CHANGED');
  }, 90_000);

  it('TEST 4 rerender: the field appears, is recreated 300 ms later (new node) — the fill targets the fresh node, the value is held', async () => {
    const report = await replay(
      'rerender',
      `      - click: { role: button, name: Show }
      - fill: { label: Notes, value: kept }
      - click: { role: button, name: Save }
        allow: [MUTATION]
      - expect: { text: "Saved kept" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
  }, 90_000);

  it('TEST 5 loader: never validated while the spinner is visible — LOADER_APPEARED, LOADER_DISAPPEARED, then the target', async () => {
    const report = await replay(
      'loader',
      `      - click: { role: button, name: Load }
      - click: { role: button, name: Continue }
      - expect: { text: "Continued" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
    expect(report.steps[0]?.synchronization?.signals).toEqual(
      expect.arrayContaining(['LOADER_APPEARED', 'LOADER_DISAPPEARED']),
    );
  }, 90_000);

  it('TEST 6 network: request → response (700 ms) → DOM update → next target — correlated network signals, PASS', async () => {
    const report = await replay(
      'network',
      `      - click: { role: button, name: Search }
      - click: { role: button, name: Open result }
      - expect: { text: "Opened alpha" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
    expect(report.steps[0]?.synchronization?.signals).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^NETWORK_ACTIVITY_STARTED GET \/api\/search/),
        expect.stringMatching(/^NETWORK_ACTIVITY_COMPLETED GET \/api\/search 200/),
      ]),
    );
  }, 90_000);

  it('TEST 7 polling: the network never goes idle — the crawler does not wait for networkidle', async () => {
    const report = await replay(
      'polling',
      `      - click: { role: button, name: Show }
      - click: { role: button, name: Done }
      - expect: { text: "Done" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
    expect(report.steps[0]?.synchronization?.durationMs).toBeLessThan(4000);
  }, 90_000);

  it('TEST 9 real timeout: the expected dialog never comes — transition TIMEOUT (with what is missing); the screen is stable, so the action fails honestly as NO_EFFECT (never a TARGET_MISMATCH), nothing replayed', async () => {
    const report = await replay(
      'nothing',
      `      - click: { role: button, name: Filter }
        effects: { appears: ["dialog:Filter"] }
      - fill: { label: Value, value: alpha }
`,
      { sync: 'synchronization: { transitionTimeoutMs: 2500 }' },
    );
    const filter = report.steps[0];
    expect(filter?.synchronization?.transition).toBe('TIMEOUT');
    expect(filter?.synchronization?.missing.join(' ')).toMatch(/EXPECTED_EFFECT_OBSERVED/);
    expect(filter?.synchronization?.durationMs).toBeLessThan(4000);
    expect(filter?.status, describeFlow(report)).toBe('FAILED');
    // Écran stable, effet absent : une vraie absence d'effet — la borne est dite en complément.
    expect(filter?.reason).toMatch(/^ACTION_NOT_CONFIRMED \(NO_EFFECT\)/);
    expect(filter?.reason).toMatch(/transition TIMEOUT after \d+ ms, screen stable/);
    expect(filter?.reason).not.toMatch(/TARGET_MISMATCH|FUNCTIONAL_MISMATCH/);
  }, 90_000);

  it("TEST 9b the previous step timed out (effects not verified): the next step's missing target is reported as TRANSITION_TIMEOUT, a temporal problem — never a TARGET_MISMATCH", async () => {
    const report = await replay(
      'nothing',
      `      - click: { role: button, name: Filter }
        effects: { appears: ["dialog:Filter"] }
      - fill: { label: Value, value: alpha }
`,
      { sync: 'verifyActionEffects: false, synchronization: { transitionTimeoutMs: 2500 }' },
    );
    expect(report.steps[0]?.status).toBe('PASSED');
    expect(report.steps[0]?.synchronization?.transition).toBe('TIMEOUT');
    const value = report.steps[1];
    expect(value?.status, describeFlow(report)).toBe('FAILED');
    expect(value?.reason).toMatch(/^TRANSITION_TIMEOUT \(the previous step/);
    expect(value?.reason).not.toMatch(/TARGET_MISMATCH|FUNCTIONAL_MISMATCH/);
  }, 90_000);

  it('TEST 4b / §14 rerender after a fill: the next field is read on the OLD node (fingerprint differs) — re-observed after stability, re-resolved on the fresh DOM: TARGET_REACQUIRED_AFTER_RERENDER, never a mismatch', async () => {
    const report = await replay(
      'debounce',
      `      - fill: { label: Title, value: report }
      - fill: { css: "#notes", value: kept }
        fingerprint: { role: textbox, tag: input, name: Notes }
      - click: { role: button, name: Save }
        allow: [MUTATION]
      - expect: { text: "Saved kept" }
`,
    );
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const notes = report.steps[1];
    expect(notes?.synchronization?.reacquired).toMatch(/#notes/);
    expect(notes?.targetResolution).toBeUndefined();
  }, 90_000);
});
