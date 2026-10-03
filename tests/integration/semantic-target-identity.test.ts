import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startSettingsApp, type SettingsApp } from '../fixtures/settings-app.js';

/**
 * SEMANTIC TARGET IDENTITY de bout en bout : deux champs « Search » identiques (Columns, Filters)
 * et un champ sans libellé relié (Priority, section General). L'enregistrement garde la SECTION ;
 * le rejeu ne prend jamais le champ d'une autre section, et ne choisit jamais au hasard.
 */
describe('Semantic target identity (real browser)', () => {
  let app: SettingsApp;
  let dir: string;
  beforeAll(async () => {
    app = await startSettingsApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-semantic-identity-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const replay = async (layout: string, steps: string, dnd = 'pointer'): Promise<FlowRunReport> => {
    const reportsDir = await mkdtemp(path.join(dir, 'replay-'));
    const { config } = parseConfig(
      `mission: { name: semantic-identity }
target: { baseUrl: ${app.url}, startAt: "/?layout=${layout}&dnd=${dnd}" }
exploration: { autonomous: false, actionTimeoutMs: 1500, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { intelligentRecovery: { enabled: false } }
output: { reportsDir: ${reportsDir} }
flows:
  - name: Report settings
    steps:
${steps}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const flow = result.flows[0];
    if (!flow) throw new Error('no flow report');
    return flow;
  };
  const describeFlow = (flow: FlowRunReport): string =>
    flow.steps.map((step) => `${step.status} ${step.description} ${step.reason ?? ''}`).join('\n');

  const SCOPED = `      - fill: { label: Priority, section: General, value: high }
      - fill: { label: Search, section: Columns, value: alpha }
      - fill: { label: Search, section: Filters, value: beta }
      - click: { role: button, name: Save }
        allow: [MUTATION]
      - expect: { text: "priority=high columns=alpha filters=beta selected=Name" }`;

  it('§66 / §67 the recording keeps the section of each field: same label and same input type are told apart, the unlabelled field keeps its human text', async () => {
    const outcome = await runRecording({
      name: 'Report settings',
      url: `${app.url}/`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      drive: async ({ page }) => {
        await page.locator('#priority').fill('high');
        await page.locator('#columnsSearch').fill('alpha');
        await page.locator('#filtersSearch').fill('beta');
        await page.waitForTimeout(600);
      },
    });
    const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
    expect(yaml).toMatch(/label: Priority\s+section: (Report settings > )?General/);
    expect(yaml).toMatch(/label: Search\s+section: (Report settings > )?Columns/);
    expect(yaml).toMatch(/label: Search\s+section: (Report settings > )?Filters/);
    expect(yaml).not.toMatch(/css:|nth-of-type/);
    const feature = await readFile(path.join(outcome.directory, 'generated.feature'), 'utf8');
    expect(feature).toMatch(/"Search" (in the|dans la) section "(Report settings > )?Columns"/);
    // RECORDING SEMANTIC AUDIT : écrit à chaque enregistrement ; intelligence OFF → aucun appel.
    const audit = JSON.parse(await readFile(path.join(outcome.directory, 'semantic-audit.json'), 'utf8')) as {
      mode: string;
      aiCalls: number;
      entries: {
        humanActionId: string;
        deterministicInterpretation: { section?: string };
        finalInterpretation: unknown;
      }[];
    };
    expect(audit.mode).toBe('SUSPICIOUS_ONLY');
    expect(audit.aiCalls).toBe(0);
    expect(audit.entries.map((entry) => entry.humanActionId)).toEqual(['h001', 'h002', 'h003']);
    expect(audit.entries[1]?.deterministicInterpretation.section).toMatch(/Columns$/);
    const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
    expect(html).toContain('Recording AI Audit');
  }, 120_000);

  it('the section-scoped flow replays on the recorded layout and on a reordered one (identity, not position)', async () => {
    for (const layout of ['default', 'swap']) {
      const flow = await replay(layout, SCOPED);
      expect(flow.status, `${layout}\n${describeFlow(flow)}`).toBe('PASSED');
    }
  }, 120_000);

  it('§79 the field disappeared from its section: never the same-label field of another section', async () => {
    const flow = await replay('noColumnsSearch', SCOPED);
    expect(flow.status).not.toBe('PASSED');
    expect(describeFlow(flow)).toMatch(/not found in section "Columns"/);
    expect(describeFlow(flow)).not.toMatch(/PASSED fill label="Search" = "alpha"/);
  }, 120_000);

  it('two equally plausible candidates in the same section: AMBIGUOUS_TARGET, nothing chosen arbitrarily', async () => {
    const flow = await replay('twin', SCOPED);
    expect(flow.status).not.toBe('PASSED');
    expect(describeFlow(flow)).toMatch(/AMBIGUOUS_TARGET/);
  }, 120_000);

  it('a structural locator that now reaches the field of another section is rejected by the fingerprint (section mismatch, not filled)', async () => {
    const flow = await replay(
      'swap',
      `      - fill: { css: "main > section:nth-of-type(2) input", value: alpha }
        fingerprint: { role: textbox, tag: input, label: Search, section: Columns }`,
    );
    expect(flow.status).not.toBe('PASSED');
    expect(describeFlow(flow)).toMatch(/section "Report settings > Filters" instead of "Columns"/);
  }, 120_000);

  const DRAG = `      - dragAndDrop: { item: Status, from: { section: "Columns > Available columns" }, to: { section: "Columns > Selected columns" } }
      - click: { role: button, name: Save }
        allow: [MUTATION]
      - expect: { text: "selected=Name,Status" }`;

  it('§68 / §69 a drag and drop replays as a first-class action, pointer-based and HTML5, and its ITEM_MOVED effect is verified', async () => {
    for (const dnd of ['pointer', 'html5']) {
      const flow = await replay('default', DRAG, dnd);
      expect(flow.status, `${dnd}\n${describeFlow(flow)}`).toBe('PASSED');
      expect(flow.steps[0]?.effect?.status).toBe('CONFIRMED');
      expect(flow.steps[0]?.effect?.reasons.join(' ')).toContain(
        `drag mode ${dnd === 'html5' ? 'HTML5' : 'POINTER'}`,
      );
    }
  }, 120_000);

  it('§69 the drag is executed but nothing moves: ACTION_EFFECT_MISMATCH, never a technical success', async () => {
    const flow = await replay('default', DRAG, 'broken');
    expect(flow.status).not.toBe('PASSED');
    expect(flow.steps[0]?.status).toBe('FAILED');
    expect(flow.steps[0]?.reason).toMatch(/ACTION_EFFECT_MISMATCH/);
    expect(flow.steps[0]?.effect?.status).toBe('NO_EFFECT');
  }, 120_000);

  it('§68 a human drag and drop is recorded as ONE first-class action (pointer and HTML5), preserved in the journey, and the generated flow replays it', async () => {
    for (const dnd of ['pointer', 'html5']) {
      const outcome = await runRecording({
        name: `Columns ${dnd}`,
        url: `${app.url}/?dnd=${dnd}`,
        overrides: { headless: true, reportsDir: path.join(dir, `reports-${dnd}`) },
        env: {},
        drive: async ({ page }) => {
          if (dnd === 'html5') await page.locator('#col-status').dragTo(page.locator('#selected'));
          else {
            const from = await page.locator('#col-status').boundingBox();
            const to = await page.locator('#selected').boundingBox();
            if (!from || !to) throw new Error('no box');
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
            await page.mouse.down();
            await page.mouse.move(from.x + 20, from.y + 20, { steps: 4 });
            await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
            await page.mouse.up();
          }
          await page.waitForTimeout(900);
        },
      });
      const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
      expect(yaml, dnd).toMatch(
        /dragAndDrop:\s+item: Status\s+from:\s+section: (Report settings > )?Columns > Available columns\s+to:\s+section: (Report settings > )?Columns > Selected columns/,
      );
      // Une seule action humaine, préservée (jamais un clic ni une perte).
      const accounts = JSON.parse(
        await readFile(path.join(outcome.directory, 'action-preservation.json'), 'utf8'),
      ) as { type: string; status: string }[];
      const drags = accounts.filter((account) => account.type === 'DRAG_AND_DROP');
      expect(drags, dnd).toHaveLength(1);
      expect(drags[0]?.status).toBe('PRESERVED');
      expect(accounts.filter((account) => account.status === 'UNACCOUNTED')).toHaveLength(0);
      const feature = await readFile(path.join(outcome.directory, 'generated.feature'), 'utf8');
      expect(feature).toMatch(/(je glisse|I drag) "Status"/);
      // Le flow généré se rejoue : ITEM_MOVED vérifié.
      const flow = await replay(
        'default',
        `      - dragAndDrop: { item: Status, from: { section: "Columns > Available columns" }, to: { section: "Columns > Selected columns" } }`,
        dnd,
      );
      expect(flow.status, describeFlow(flow)).toBe('PASSED');
    }
  }, 180_000);
});
