import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import type { RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { readGeneratedFlow } from '../helpers.js';
import { startMaterialFormApp, type MaterialFormApp } from '../fixtures/material-form-app.js';

/**
 * LE CAS RÉEL (§26) : trois mat-form-field au même CSS structurel. Avant : les saisies de A, B et C
 * fusionnées en une seule (TYPING_MERGED par localisateur sérialisé) → un seul FILL ${testData:value}
 * → au rejeu, la valeur de C dans A (numérique) → WRONG_EFFECT. SAME CSS ≠ SAME FIELD.
 * La preuve, de bout en bout : raw → semantic → preservation → flow → test data → replay → valeur reçue.
 */
const GENERIC = 'mat-form-field > div > div:nth-of-type(2) > div > input';
const VALUES = ['12345', 'alpha', 'Example inc'];

describe('Field identity (record → normalize → test data → flow → replay, real browser)', () => {
  let app: MaterialFormApp;
  let dir: string;
  const recordings: Record<string, { outcome: RecordOutcome; events: RecordingEvent[] }> = {};
  const input = (index: number) => `mat-form-field >> nth=${String(index)} >> input`;

  const record = async (variant: 'bare' | 'labelled'): Promise<void> => {
    const events: RecordingEvent[] = [];
    const outcome = await runRecording({
      name: `material request ${variant}`,
      url: `${app.url}/requests/new${variant === 'bare' ? '?variant=bare' : ''}`,
      overrides: { headless: true, reportsDir: path.join(dir, `reports-${variant}`) },
      env: {},
      onEvent: (event) => events.push(event),
      drive: async ({ page }) => {
        // Comme un humain : clic dans le champ, frappe, puis le champ suivant.
        for (const [index, value] of VALUES.entries()) {
          await page.locator(input(index)).click();
          await page.locator(input(index)).pressSequentially(value, { delay: 20 });
          await page.waitForTimeout(150);
        }
        await page.getByRole('button', { name: 'Save' }).click();
        await page.getByText('Request saved').waitFor();
        await page.waitForTimeout(1000);
      },
    });
    recordings[variant] = { outcome, events };
  };

  beforeAll(async () => {
    app = await startMaterialFormApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-field-identity-'));
    await record('bare');
    await record('labelled');
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  const json = async <T>(variant: string, file: string): Promise<T> =>
    JSON.parse(await readFile(path.join(recordings[variant]?.outcome.directory ?? '', file), 'utf8')) as T;
  const fills = (steps: FlowStep[]) => steps.flatMap((step) => (step.kind === 'fill' ? [step] : []));

  interface MergeReport {
    inputs: {
      rawEventId: string;
      actionId?: string;
      status?: string;
      recorderElementId?: string;
      locatorUniqueness: string;
      testData?: string;
      valueProfile: { type: string; maxLength?: number };
    }[];
    validation: unknown[];
    decisions: {
      previousRawEventIds: string[];
      currentRawEventIds: string[];
      decision: string;
      verdict: string;
      reasons: string[];
    }[];
  }

  it('raw: three human inputs, three DOM instances, ONE generic non-unique CSS (the real case reproduced)', async () => {
    const raw = await json<{
      rawEvents: {
        id: string;
        type: string;
        element?: { css: string; cssMatches?: number; domInstance?: string };
      }[];
    }>('bare', 'raw-recording.json');
    const typing = raw.rawEvents.filter((event) => event.type === 'input' || event.type === 'change');
    expect(new Set(typing.map((event) => event.element?.css))).toEqual(new Set([GENERIC]));
    expect(typing.every((event) => event.element?.cssMatches === 3)).toBe(true);
    expect(new Set(typing.map((event) => event.element?.domInstance)).size).toBe(3);
  });

  it('semantic + typing-merge-decisions.json: three FILL, every merge between fields REJECTED with its reasons', async () => {
    const report = await json<MergeReport>('bare', 'typing-merge-decisions.json');
    const fieldActions = new Set(
      report.inputs.filter((entry) => entry.status === 'KEPT').map((entry) => entry.actionId),
    );
    expect(fieldActions.size).toBe(3);
    expect(report.inputs.every((entry) => entry.locatorUniqueness === 'NON_UNIQUE')).toBe(true);
    expect(report.inputs[0]?.valueProfile).toMatchObject({ type: 'NUMERIC', maxLength: 5 });
    const between = report.decisions.filter((decision) => decision.verdict === 'DIFFERENT_FIELD');
    expect(between.length).toBeGreaterThanOrEqual(2);
    for (const decision of between) {
      expect(decision.decision).toBe('KEEP_SEPARATE');
      expect(decision.reasons.join(' | ')).toMatch(/FOCUS_CHANGED_TO_DIFFERENT_FIELD/);
      expect(decision.reasons.join(' | ')).toMatch(/different DOM instance/);
    }
    expect(report.decisions[0]?.reasons.join(' | ')).toMatch(/incompatible value profile/);
    expect(report.validation).toEqual([]);
    const types = recordings.bare?.events.map((event) => event.type) ?? [];
    for (const type of [
      'FIELD_IDENTITY_CREATED',
      'TYPING_MERGE_EVALUATED',
      'TYPING_MERGE_REJECTED',
      'NON_UNIQUE_FIELD_LOCATOR',
      'GENERIC_LOCATOR_DETECTED',
      'FIELD_IDENTITY_MISMATCH',
    ])
      expect(types, type).toContain(type);
  });

  it('action-preservation.json: no human input disappears behind a TYPING_MERGED of another field', async () => {
    const accounts = await json<{ status: string; rule?: string; actionId?: string }[]>(
      'bare',
      'action-preservation.json',
    );
    const report = await json<MergeReport>('bare', 'typing-merge-decisions.json');
    const kept = new Set(
      report.inputs.filter((entry) => entry.status === 'KEPT').map((entry) => entry.actionId),
    );
    for (const actionId of kept)
      expect(
        accounts.some((account) => account.actionId === actionId && account.status === 'PRESERVED'),
        actionId,
      ).toBe(true);
    // Une fusion ne reste possible qu'à l'intérieur d'UN champ (ses frappes successives).
    for (const decision of report.decisions.filter((entry) => entry.decision === 'MERGE'))
      expect(decision.verdict).toBe('EXACT_SAME_FIELD');
  });

  it('generated flow + test data: one FILL per field, one key per field; the generic CSS keeps the recorded position', async () => {
    const flow = await readGeneratedFlow(recordings.bare?.outcome.directory ?? '');
    const steps = fills(flow.steps);
    expect(steps).toHaveLength(3);
    const keys = steps.map((step) => (step.value as { testData?: string }).testData);
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain('value');
    // Rien d'autre ne distingue ces champs : leur position, enregistrée sur l'élément réel (jamais « le premier »).
    expect(steps.map((step) => ('target' in step ? step.target : undefined))).toEqual(
      [0, 1, 2].map((nth): unknown =>
        expect.objectContaining({ strategy: 'css', value: GENERIC, ...(nth > 0 ? { nth } : { nth: 0 }) }),
      ),
    );
    // Avec un mat-label : la cible sémantique et une clé du libellé.
    const labelled = fills((await readGeneratedFlow(recordings.labelled?.outcome.directory ?? '')).steps);
    expect(labelled.map((step) => ('target' in step ? step.target.value : ''))).toEqual([
      'Employee number',
      'Employee name',
      'Company name',
    ]);
  });

  /** Rejoue un flow ; le rapport et le journal du moteur. */
  const replay = async (variant: 'bare' | 'labelled', name: string, flow: Record<string, unknown>) => {
    const reportsDir = await mkdtemp(path.join(dir, `replay-${name}-`));
    const { config } = parseConfig(
      `mission: { name: field-identity-${name} }
target: { baseUrl: ${app.url}, startAt: /requests/new${variant === 'bare' ? '?variant=bare' : ''} }
exploration: { autonomous: false, actionTimeoutMs: 8000, settleTimeMs: 150 }
report: { failOnSeverity: NONE }
logging: { level: DEBUG }
output: { reportsDir: ${reportsDir} }
flows:
  - ${JSON.stringify(flow)}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0] as FlowRunReport;
    return { report, log: await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8') };
  };
  const generated = async (variant: 'bare' | 'labelled'): Promise<Record<string, unknown>> => {
    const directory = recordings[variant]?.outcome.directory ?? '';
    const flow = parseYaml(await readFile(path.join(directory, 'generated.flow.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    return { ...flow, testData: path.join(directory, 'test-data.yaml') };
  };
  const describeRun = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [step.description, step.status, step.reason, step.effect?.status]),
    );

  for (const variant of ['bare', 'labelled'] as const)
    it(`replay (${variant}): each value reaches ITS field — A ${VALUES[0]}, B ${VALUES[1]}, C its own value; VALUE_CHANGED confirmed on the right target`, async () => {
      const before = app.created.length;
      const { report, log } = await replay(variant, variant, await generated(variant));
      expect(report.status, describeRun(report)).toBe('PASSED');
      const body = app.created.at(-1);
      expect(app.created.length).toBe(before + 1);
      expect(body?.employeeNumber).toBe('12345');
      expect(body?.employeeName).toBe('alpha');
      expect(body?.companyName).toBeTruthy();
      expect(body?.companyName).not.toMatch(/^(12345|alpha)$/);
      expect(log.match(/"REPLAY_FIELD_VALUE_CONFIRMED"/g)?.length).toBe(3);
      expect(log).not.toContain('"REPLAY_FIELD_TARGET_MISMATCH"');
    }, 120_000);

  it('an OLD merged flow (one FILL, generic CSS, testData value) is never typed into the first field', async () => {
    const { report } = await replay('bare', 'old', {
      name: 'Old merged recording',
      steps: [
        {
          fill: { css: GENERIC, value: 'Example inc' },
          fingerprint: { role: 'textbox', tag: 'input', component: 'mat-form-field' },
        },
        { click: { role: 'button', name: 'Save' }, allow: ['MUTATION'] },
      ],
    });
    const fill = report.steps[0];
    expect(fill?.status, describeRun(report)).toBe('FAILED');
    expect(fill?.reason).toMatch(/TARGET_LOCATOR_NON_UNIQUE: 3 elements match/);
    expect(fill?.reason).toMatch(/no candidate carries the recorded identity/);
    expect(fill?.reason).toMatch(/nothing chosen arbitrarily, not executed\) — FIELD_LOCATOR_NON_UNIQUE$/);
    // Rien n'a été saisi ni envoyé.
    expect(report.steps[1]?.status).toBe('SKIPPED');
  }, 120_000);
});
