import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { startRequestCreationApp, type RequestCreationApp } from '../fixtures/request-creation-app.js';

/**
 * DISCRIMINATING SELECTORS, de bout en bout : quatre champs construits par les mêmes composants
 * (structure Material identique, ids générés). Le chemin structurel désigne les quatre ; l'identité
 * est portée par l'hôte (formcontrolname). L'enregistrement produit QUATRE identités distinctes et un
 * CSS discriminant pour chacune ; le rejeu met chaque valeur dans SON champ, ne choisit jamais le
 * premier d'un CSS ambigu, et retrouve un champ dont le DOM interne a changé (V2).
 */
describe('Discriminating CSS selectors (record → replay, real browser)', () => {
  let app: RequestCreationApp;
  let dir: string;
  let outcome: RecordOutcome;
  const events: { type: string; message: string }[] = [];

  beforeAll(async () => {
    app = await startRequestCreationApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-discriminating-'));
    outcome = await runRecording({
      name: 'create request',
      url: `${app.url}/`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      onEvent: (event) => events.push(event),
      drive: async ({ page }) => {
        await page.waitForTimeout(800);
        const input = (control: string) => page.locator(`[formcontrolname="${control}"] input`);
        for (const [control, value] of [
          ['branchNumber', '99999'],
          ['legalName', 'ACME'],
          ['contactFirstName', 'Alex'],
          ['contactLastName', 'Smith'],
        ] as const) {
          await input(control).click();
          // Frappe par frappe : « 9 », « 99 »… consolidés en UNE saisie par champ.
          await input(control).pressSequentially(value, { delay: 50 });
          await page.waitForTimeout(400);
        }
        await page.getByRole('button', { name: 'Save' }).click();
        await page.getByText('Request saved').waitFor();
        await page.waitForTimeout(800);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const flowOf = async (): Promise<{ steps: FlowStep[] } & Record<string, unknown>> =>
    parseYaml(await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8')) as {
      steps: FlowStep[];
    } & Record<string, unknown>;
  type RawStep = Record<string, unknown> & { fingerprint?: FlowStep['fingerprint'] };
  const fills = (steps: readonly unknown[]): RawStep[] =>
    (steps as RawStep[]).filter((step) => 'fill' in step);

  it('§28 recording: FOUR fills, four distinct identities, each with a unique discriminating CSS; the generic structural CSS is kept as fallback, never selected', async () => {
    const steps = fills((await flowOf()).steps);
    expect(steps).toHaveLength(4);
    expect(steps.map((step) => step.fingerprint?.formControl)).toEqual([
      'branchNumber',
      'legalName',
      'contactFirstName',
      'contactLastName',
    ]);
    for (const step of steps) {
      const css = step.fingerprint?.css;
      expect(css?.preferred?.selector).toMatch(/^app-input(-mask)?\[formcontrolname="[a-zA-Z]+"\] input$/);
      expect(css?.preferred?.matchCount).toBe(1);
      expect(css?.fallback?.matchCount).toBeGreaterThan(1);
      expect(step.fingerprint?.ambiguity?.reasons).toEqual(
        expect.arrayContaining(['GENERIC_CSS', 'DYNAMIC_ID']),
      );
    }
    // Deux champs différents partagent le même CSS de repli : ils restent quatre champs.
    expect(new Set(steps.map((step) => step.fingerprint?.css?.fallback?.selector)).size).toBe(1);
    expect(steps[0]?.fingerprint?.maxLength).toBe(5);
  });

  it('FLOW AUDIT: the generated flow is reviewed as a whole (flow-audit.json), never modified; a clean flow has no finding', async () => {
    const audit = JSON.parse(await readFile(path.join(outcome.directory, 'flow-audit.json'), 'utf8')) as {
      flowModified: boolean;
      aiCalls: number;
      findings: { rule: string }[];
    };
    expect(audit.flowModified).toBe(false);
    // ai.mode OFF par défaut : les règles seulement, aucun appel.
    expect(audit.aiCalls).toBe(0);
    expect(audit.findings.map((finding) => finding.rule)).toEqual([]);
    expect(events.map((event) => event.type)).toContain('RECORDING_FLOW_AUDITED');
  });

  it('§20 / §26 the screen was inventoried BEFORE the interactions; the typing reused the inventory descriptors', async () => {
    const inventory = await readFile(path.join(outcome.directory, 'screen-inventory.txt'), 'utf8');
    expect(inventory).toMatch(/Screen: Create request/);
    expect(inventory).toMatch(/Inputs: 4/);
    expect(inventory.match(/status: UNIQUE/g)).toHaveLength(4);
    expect(inventory).toMatch(
      /Generic selector:\nmat-form-field > [^\n]+ > input\nmatches: 4\nstatus: AMBIGUOUS\nNOT SELECTED/,
    );
    const types = events.map((event) => event.type);
    expect(types).toContain('SCREEN_INVENTORY_COMPLETED');
    expect(types).toContain('TARGET_MATCHED_FROM_INVENTORY');
    expect(types).toContain('CSS_CANDIDATE_SELECTED');
  });

  const replay = async (
    variant: string,
    edit: (steps: unknown[]) => unknown[] = (steps) => steps,
    flow?: Record<string, unknown>,
  ): Promise<{ report: FlowRunReport; log: string }> => {
    const raw = flow ?? (await flowOf());
    const startAt = `/${variant === 'default' ? '' : `?variant=${variant}`}`;
    const reportsDir = await mkdtemp(path.join(dir, `replay-${variant}-`));
    const { config } = parseConfig(
      `mission: { name: css-${variant} }
target: { baseUrl: ${app.url}, startAt: "${startAt}" }
exploration: { autonomous: false, actionTimeoutMs: 4000 }
report: { failOnSeverity: NONE }
logging: { level: DEBUG }
output: { reportsDir: ${reportsDir} }
flows:
  - ${JSON.stringify({ ...raw, startAt, steps: edit(raw.steps as unknown[]), testData: path.join(outcome.directory, 'test-data.yaml') })}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    return {
      report: result.flows[0] as FlowRunReport,
      log: await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8'),
    };
  };
  const describeRun = (report: FlowRunReport): string =>
    JSON.stringify(report.steps.map((entry) => [entry.description, entry.status, entry.reason]));
  const lastSaved = (): Record<string, string> | undefined => app.saved.at(-1);

  it('§28 replay: each value goes ONLY into its own field (nothing overwritten); every preferred CSS is CSS_CONFIRMED', async () => {
    const before = app.saved.length;
    const { report } = await replay('default');
    expect(report.status, describeRun(report)).toBe('PASSED');
    expect(app.saved.length).toBe(before + 1);
    const saved = lastSaved();
    expect(saved?.branchNumber).toMatch(/^\d{5}$/);
    // Quatre valeurs distinctes non vides : aucune écrasée par l'action destinée à un autre champ.
    expect(Object.values(saved ?? {}).every((value) => value !== '')).toBe(true);
    expect(new Set(Object.values(saved ?? {})).size).toBe(4);
    const css = report.steps
      .filter((step) => step.kind === 'fill')
      .map((step) => step.cssResolution?.resolution);
    expect(css).toEqual(['CSS_CONFIRMED', 'CSS_CONFIRMED', 'CSS_CONFIRMED', 'CSS_CONFIRMED']);
  }, 120_000);

  it('§17 replay on a slightly modified DOM (fields reordered inside their sections): still the right fields', async () => {
    const before = app.saved.length;
    const { report } = await replay('shuffled');
    expect(report.status, describeRun(report)).toBe('PASSED');
    expect(app.saved.length).toBe(before + 1);
    expect(new Set(Object.values(lastSaved() ?? {})).size).toBe(4);
    expect(lastSaved()?.branchNumber).toMatch(/^\d{5}$/);
  }, 120_000);

  it('§29 V2 — the internal DOM changed (host renamed, extra wrapper): a CSS-targeted step is HEALED by its fingerprint, then the value is confirmed', async () => {
    const before = app.saved.length;
    const { report, log } = await replay('v2', (steps) =>
      (steps as RawStep[]).map((step) => {
        if (!('fill' in step) || step.fingerprint?.formControl !== 'branchNumber') return step;
        const fill = step.fill as Record<string, unknown>;
        return { ...step, fill: { css: step.fingerprint.css?.preferred?.selector, value: fill.value } };
      }),
    );
    expect(report.status, describeRun(report)).toBe('PASSED');
    expect(log).toContain('"TARGET_HEALED"');
    // Le CSS préféré enregistré ne désigne plus rien dans la V2 : la cible vient de l'empreinte.
    expect(report.steps[0]?.targetResolution?.trigger).toBe('LOCATOR_NOT_FOUND');
    expect(log).toContain('"REPLAY_FIELD_VALUE_CONFIRMED"');
    expect(app.saved.length).toBe(before + 1);
    expect(lastSaved()?.branchNumber).toMatch(/^\d{5}$/);
  }, 120_000);

  it('§19 / §31 an OLD flow (generic CSS only, no fingerprint) whose CSS matches several fields: AMBIGUOUS_TARGET, never the first one, nothing filled', async () => {
    const before = app.saved.length;
    const { report } = await replay('default', undefined, {
      name: 'old flow',
      steps: [
        { fill: { css: 'mat-form-field > div > div > div > input', value: '12345' } },
        { click: { role: 'button', name: 'Save' }, allow: ['MUTATION'] },
      ],
    });
    expect(report.steps[0]?.status, describeRun(report)).toBe('FAILED');
    expect(report.steps[0]?.reason).toMatch(/AMBIGUOUS_TARGET: AMBIGUOUS_LOCATOR — 4 visible elements/);
    expect(app.saved.length).toBe(before);
  }, 120_000);

  it('§20 a unique CSS whose fingerprint disagrees (another formControlName): never executed blindly on that element', async () => {
    const before = app.saved.length;
    const { report, log } = await replay('default', (steps) => {
      const [branch, legal] = fills(steps);
      const save = (steps as RawStep[]).find((step) => 'click' in step);
      if (!branch || !legal || !save) throw new Error('steps');
      const fill = legal.fill as Record<string, unknown>;
      // L'étape « Legal name » vise par CSS le champ Branch number : unique, mais pas la cible enregistrée.
      return [
        { ...legal, fill: { css: branch.fingerprint?.css?.preferred?.selector, value: fill.value } },
        save,
      ];
    });
    const step = report.steps[0];
    // Le CSS désigne UN élément, mais pas celui de l'empreinte : CSS_CONFLICT, jamais CSS_CONFIRMED.
    expect(step?.cssResolution?.resolution, describeRun(report)).toBe('CSS_CONFLICT');
    if (step?.status === 'PASSED') {
      // Retrouvé par son identité (healing, ré-acquisition) : la valeur est dans « Legal name », jamais
      // dans « Branch number » — et le champ rempli est confirmé comme celui enregistré.
      expect(log).toContain('"REPLAY_FIELD_TARGET_CONFIRMED"');
      expect(app.saved.length).toBe(before + 1);
      expect(lastSaved()?.branchNumber).toBe('');
      expect(lastSaved()?.legalName).not.toBe('');
    } else expect(app.saved.length).toBe(before);
  }, 120_000);
});
