import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { startFilterApp, type FilterApp } from '../fixtures/filter-app.js';

interface ValidationEntry {
  humanActionId: string;
  action: string;
  label: string;
  classification: string;
  status?: string;
  repairApplied: boolean;
  semanticGroup?: string;
  validationBefore?: {
    status: string;
    reason: string;
    differences: { property: string; expected?: string; actual?: string }[];
  };
  validationAfter?: { status: string } | null;
  fingerprintAfter?: { role?: string; semanticId?: string };
  finalFingerprint?: { role?: string; semanticId?: string };
  knowledge?: { recordingValidated: boolean; replayValidated: boolean };
}

/**
 * AUTO-VALIDATION DE LA CIBLE pendant l'enregistrement (bug réel « #valueInput ») : le panneau
 * Filter, champ → opérateur → valeur → Apply. La capture lisait la valeur « combobox », le rejeu
 * « textbox » : TARGET_FINGERPRINT_MISMATCH découvert au rejeu. Désormais : détecté et réparé
 * pendant l'enregistrement, revalidé, et jamais une action rejouée par la validation.
 */
describe('Recording target self-validation (real browser)', () => {
  let app: FilterApp;
  let dir: string;
  beforeAll(async () => {
    app = await startFilterApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-target-validation-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const human = async (page: Page, counts: string[]): Promise<void> => {
    await page.locator('#open').click();
    await page.locator('#field').selectOption('Company name');
    await page.locator('#operator').selectOption('Like');
    await page.locator('#valueInput').fill('alpha');
    await page.locator('#valueInput').blur();
    await page.locator('#apply').click();
    // Le temps des validations immédiates : aucune ne doit recliquer « Apply ».
    await page.waitForTimeout(1500);
    counts.push((await page.locator('#count').textContent()) ?? '');
  };
  const record = async (name: string, variant = 'default', counts: string[] = []): Promise<RecordOutcome> =>
    runRecording({
      name,
      url: `${app.url}/?variant=${variant}`,
      overrides: { headless: true, reportsDir: path.join(dir, `reports-${variant}`) },
      env: {},
      drive: async ({ page }) => {
        await human(page, counts);
      },
    });
  const validationOf = async (
    outcome: RecordOutcome,
  ): Promise<{ actions: ValidationEntry[]; replayConfidence: string }> =>
    JSON.parse(await readFile(path.join(outcome.directory, 'target-validation.json'), 'utf8')) as {
      actions: ValidationEntry[];
      replayConfidence: string;
    };
  const replay = async (yaml: string, testData: string | undefined): Promise<FlowRunReport> => {
    const { config } = parseConfig(
      `mission: { name: replay-filter }
target: { baseUrl: ${app.url}, startAt: "/" }
exploration: { autonomous: false, actionTimeoutMs: 2000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { intelligentRecovery: { enabled: false } }
output: { reportsDir: ${await mkdtemp(path.join(dir, 'replay-'))} }
flows:
  - ${JSON.stringify({ ...(parseYaml(yaml) as object), startAt: '/', ...(testData ? { testData } : {}) })}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const flow = result.flows[0];
    if (!flow) throw new Error('no flow');
    return flow;
  };
  const describeFlow = (flow: FlowRunReport): string =>
    flow.steps.map((step) => `${step.status} ${step.description} ${step.reason ?? ''}`).join('\n');

  it("§60 / §48 the value field's wrong role is detected IMMEDIATELY (MISMATCH, RECORDED_ROLE_INCORRECT), repaired, revalidated; Apply ran exactly once; the replay passes", async () => {
    const counts: string[] = [];
    const outcome = await record('Filter requests', 'default', counts);
    // §55 : la validation n'a JAMAIS recliqué « Apply ».
    expect(counts).toEqual(['1']);
    const report = await validationOf(outcome);
    const value = report.actions.find((entry) => entry.action === 'FILL');
    expect(value?.validationBefore?.status).toBe('MISMATCH');
    expect(value?.validationBefore?.reason).toBe('RECORDED_ROLE_INCORRECT');
    expect(value?.validationBefore?.differences).toContainEqual({
      property: 'role',
      expected: 'combobox',
      actual: 'textbox',
    });
    expect(value?.repairApplied).toBe(true);
    expect(value?.validationAfter?.status).toBe('VALIDATED');
    expect(value?.fingerprintAfter).toMatchObject({ role: 'textbox' });
    expect(value?.finalFingerprint).toMatchObject({ role: 'textbox', semanticId: 'filter.value' });
    expect(value?.semanticGroup).toMatch(/^FILTER_CONFIGURATION G1$/);
    // §45 : prouvé dans CE runtime ; pas encore une connaissance universelle.
    expect(value?.knowledge).toEqual({ recordingValidated: true, replayValidated: false });
    // Les autres cibles : validées du premier coup (aucun conseiller : intelligence OFF).
    for (const entry of report.actions.filter((item) => item.action !== 'FILL'))
      expect(entry.classification, `${entry.action} ${entry.label}`).toBe('VALIDATED');
    const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
    expect(yaml).not.toMatch(/role: combobox\s+tag: input/);
    expect(yaml).toMatch(/role: textbox/);
    expect(yaml).toContain('target VALIDATED (repaired)');
    const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
    expect(html).toContain('Target validation');
    // AFTER : le flow généré se rejoue.
    const after = await replay(yaml, path.join(outcome.directory, 'test-data.yaml'));
    expect(after.status, describeFlow(after)).toBe('PASSED');
    // BEFORE : la représentation d'origine (rôle faux) échouait au rejeu.
    const before = await replay(
      `name: Filter requests (before)
steps:
  - click: { role: button, name: Filter }
  - select: { label: Field, option: Company name }
  - select: { label: Operator, option: Like }
  - fill: { css: "#valueInput", value: alpha }
    fingerprint: { role: combobox, tag: input }
  - click: { role: button, name: Apply }
`,
      undefined,
    );
    expect(describeFlow(before)).toMatch(/TARGET_FINGERPRINT_MISMATCH/);
  }, 180_000);

  it('§57 a framework that replaces the node after the change: snapshot-based comparison, VALIDATED_AFTER_RERENDER (then repaired)', async () => {
    const outcome = await record('Filter rerender', 'rerender');
    const report = await validationOf(outcome);
    const value = report.actions.find((entry) => entry.action === 'FILL');
    expect(['VALIDATED_AFTER_RERENDER', 'VALIDATED']).toContain(value?.status);
    expect(value?.classification).toBe('VALIDATED');
  }, 120_000);
});
