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
    postState?: { status: string; reason: string };
    differences: { property: string; expected?: string; actual?: string }[];
  };
  validationAfter?: { status: string } | null;
  fingerprintAfter?: { role?: string; semanticId?: string };
  finalFingerprint?: { role?: string; semanticId?: string };
  knowledge?: { recordingValidated: boolean; replayValidated: boolean };
  mode?: string;
  target?: { status: string; source: string };
  effect?: { status: string; evidence: string[] };
  goal?: { status: string; evidence: string[] };
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
  const replay = async (
    yaml: string,
    testData: string | undefined,
    functional = true,
  ): Promise<FlowRunReport> => {
    const { config } = parseConfig(
      `mission: { name: replay-filter }
target: { baseUrl: ${app.url}, startAt: "/" }
exploration: { autonomous: false, actionTimeoutMs: 2000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { intelligentRecovery: { enabled: false }, functionalTargetResolution: { enabled: ${String(functional)} } }
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
    const BEFORE = `name: Filter requests (before)
steps:
  - click: { role: button, name: Filter }
  - select: { label: Field, option: Company name }
  - select: { label: Operator, option: Like }
  - fill: { css: "#valueInput", value: alpha }
    fingerprint: { role: combobox, tag: input }
  - click: { role: button, name: Apply }
`;
    // Sans résolution fonctionnelle, la représentation d'origine (rôle faux) échouait au rejeu.
    const before = await replay(BEFORE, undefined, false);
    expect(describeFlow(before)).toMatch(/TARGET_FINGERPRINT_MISMATCH/);
    // Avec elle : le même champ, dans le même contexte, retrouvé puis PROUVÉ par la valeur tenue.
    const recovered = await replay(BEFORE, undefined);
    const fill = recovered.steps.find((step) => step.description.includes('#valueInput'));
    expect(fill?.status, describeFlow(recovered)).toBe('PASSED');
    expect(fill?.targetResolution?.runtime.fingerprintVerdict).toBe('MISMATCH');
    expect(fill?.targetResolution?.runtimeVerification?.status).toBe('CONFIRMED');
  }, 180_000);

  it('RECORDING ≠ RECOVERY: the value field is re-rendered after the fill — target VALIDATED_PRE_ACTION (post-state kept as evidence only), effect CONFIRMED, goal REACHED; the replay passes without any recovery', async () => {
    const outcome = await record('Filter rerender', 'rerender');
    const report = await validationOf(outcome);
    const value = report.actions.find((entry) => entry.action === 'FILL');
    // Le nœud original a disparu : l'identité vient d'AVANT l'action, jamais de ce que #valueInput désigne après.
    expect(value?.status).toBe('VALIDATED_PRE_ACTION');
    expect(value?.classification).toBe('VALIDATED');
    expect(value?.mode).toBe('RECORDING');
    expect(value?.target).toMatchObject({ status: 'VALIDATED_PRE_ACTION', source: 'PRE_ACTION_CONTEXT' });
    // L'après est une preuve complémentaire : jamais un MISMATCH d'identité, jamais une récupération.
    expect(value?.validationBefore?.differences).toEqual([]);
    expect(value?.validationBefore?.postState?.status).toBeDefined();
    expect(JSON.stringify(value)).not.toMatch(/GOAL_ALREADY_REACHED|RECOVERED/);
    // TROIS verdicts séparés : l'effet (la valeur saisie, par empreinte) et l'objectif.
    expect(value?.effect?.status).toBe('CONFIRMED');
    expect(value?.effect?.evidence.join(' ')).toContain('holds the typed value');
    expect(value?.goal?.status).toBe('REACHED');
    expect(value?.goal?.evidence[0]).toBe('filter.value applied');
    // La valeur saisie n'apparaît jamais dans la preuve (empreinte salée seulement).
    expect(JSON.stringify(value)).not.toContain('alpha');
    // La représentation alignée sur ce que le rejeu lira : le flow se rejoue, récupération désactivée.
    const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
    const after = await replay(yaml, path.join(outcome.directory, 'test-data.yaml'));
    expect(after.status, describeFlow(after)).toBe('PASSED');
  }, 180_000);

  it('§48.1 end to end: the "Filter" button disappears with its click — validated from the pre-action context captured by the recorder, with its effect', async () => {
    const outcome = await record('Filter hidden opener', 'hideOpener');
    const report = await validationOf(outcome);
    const opener = report.actions.find((entry) => entry.action === 'CLICK' && entry.label === 'Filter');
    expect(opener?.status).toBe('VALIDATED_WITH_EFFECT');
    expect(opener?.classification).toBe('VALIDATED');
    const raw = JSON.parse(await readFile(path.join(outcome.directory, 'raw-recording.json'), 'utf8')) as {
      rawEvents?: { type: string; pre?: { title: string; cssCount: number } }[];
      events?: { type: string; pre?: { title: string; cssCount: number } }[];
    };
    const events = raw.rawEvents ?? raw.events ?? [];
    const click = events.find((entry) => entry.type === 'click' && entry.pre);
    expect(click?.pre?.title).toBe('Requests');
  }, 120_000);
});
