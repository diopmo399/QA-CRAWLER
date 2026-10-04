import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { startFilterApp, type FilterApp } from '../fixtures/filter-app.js';

/**
 * LE CAS RÉEL : « Filter » → Field = Company name → Operator = Like → FILL #valueInput → Apply, sur un
 * écran où #valueInput désigne QUATRE éléments (un caché, un dans un autre panneau, un leurre « Like »
 * dans la fenêtre AVANT le bon, et le bon). Apply ne lit que le bon champ : remplir un autre
 * #valueInput fait échouer le parcours, même si Playwright n'a signalé aucune erreur.
 */
const FLOW = (fingerprint: string, target = 'css: "#valueInput"'): string => `flows:
  - name: Filter requests
    steps:
      - click: { role: button, name: Filter }
      - select: { label: Field, option: Company name }
      - select: { label: Operator, option: Like }
      - fill: { ${target}, value: Company ABC }
        fingerprint: ${fingerprint}
      - click: { role: button, name: Apply }
        allow: [MUTATION]
      - expect: { text: "Filtered: Company name Like Company ABC" }
`;
/** Ce que l'enregistrement capture désormais : l'identité contextualisée, pas seulement « #valueInput ». */
const ENRICHED =
  '{ role: textbox, tag: input, name: Company name, id: valueInput, dialog: Filter, formField: Company name, section: "Requests > Filter", nearbyText: [Apply] }';
/** Un ancien enregistrement : rôle et balise seulement (aucun nom). */
const LEGACY = '{ role: textbox, tag: input }';

describe('Contextual target identity: a non-unique locator is a candidate generator (real browser)', () => {
  let app: FilterApp;
  let dir: string;
  let lastReportsDir = '';
  beforeAll(async () => {
    app = await startFilterApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-contextual-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const replay = async (
    flow: string,
    options: { replay?: string; variant?: string; logging?: string } = {},
  ): Promise<FlowRunReport> => {
    const reportsDir = await mkdtemp(path.join(dir, 'run-'));
    lastReportsDir = reportsDir;
    const { config } = parseConfig(
      `mission: { name: contextual }
target: { baseUrl: ${app.url}, startAt: "/?variant=${options.variant ?? 'duplicates'}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 800, intelligentRecovery: { enabled: false }${options.replay ? `, ${options.replay}` : ''} }
${options.logging ?? ''}
output: { reportsDir: ${reportsDir} }
${flow}`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    return report;
  };
  const fillOf = (report: FlowRunReport) => report.steps.find((step) => step.kind === 'fill');
  const describeFlow = (report: FlowRunReport): string =>
    JSON.stringify(report.steps.map((step) => [step.index, step.status, step.reason]));

  it('OLD behavior (non-unique resolution off, old fingerprint): the first #valueInput of the dialog is filled — Playwright succeeds, the filter is NOT applied, the flow fails later', async () => {
    const report = await replay(FLOW(LEGACY), {
      replay: 'functionalTargetResolution: { resolveNonUniqueLocators: false }',
    });
    expect(fillOf(report)?.status).toBe('PASSED');
    expect(report.status).toBe('FAILED');
    expect(report.steps.at(-1)?.status).toBe('FAILED');
  }, 90_000);

  it('E2E (§25) the enriched identity: non-unique detected, every candidate scored, dialog + label + workflow context select the right field, only it is filled, Apply → the filter is really applied — PASS', async () => {
    const report = await replay(FLOW(ENRICHED), { logging: 'logging: { level: DEBUG }' });
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const trace = fillOf(report)?.targetResolution;
    expect(trace).toMatchObject({
      trigger: 'LOCATOR_NON_UNIQUE',
      rawMatches: 3,
      outcome: 'CONTEXTUAL_MATCH',
      status: 'TARGET_CONTEXTUAL_MATCH',
    });
    expect(trace?.confidence).toBeGreaterThanOrEqual(0.6);
    const selected = trace?.candidates.find((candidate) => candidate.id === trace.resolution);
    expect(selected?.summary).toMatch(/Company name/);
    expect(selected?.positive).toEqual(
      expect.arrayContaining(['LABEL_MATCH', 'DIALOG_MATCH', 'FORM_FIELD_MATCH']),
    );
    // 4 #valueInput, 3 visibles (une copie cachée ne se confond pas) ; les autres : expliqués, jamais choisis.
    expect(
      trace?.candidates.filter((candidate) => candidate.rejected).map((candidate) => candidate.rejected),
    ).toEqual(expect.arrayContaining(['hidden', expect.stringMatching(/context mismatch/)]));
    // La cible retenue n'est confirmée que par l'effet : la valeur est tenue par CE champ.
    expect(trace?.runtimeVerification?.status).toBe('CONFIRMED');
    expect(trace?.final).toBe('TARGET_RECOVERED_AND_CONFIRMED');
    const log = await readFile(path.join(lastReportsDir, 'engine-log.jsonl'), 'utf8');
    for (const event of [
      'TARGET_LOCATOR_NON_UNIQUE',
      'TARGET_CANDIDATE_DISCOVERED',
      'TARGET_EVIDENCE',
      'TARGET_CONTEXTUAL_MATCH',
    ])
      expect(log, event).toContain(`"${event}"`);
    const html = await readFile(path.join(lastReportsDir, 'index.html'), 'utf8');
    expect(html).toContain('Raw matches');
    expect(html).toContain('CONTEXTUAL_MATCH');
    expect(html).toContain('Rejected candidates');
  }, 90_000);

  it('§8 an old recording (no name, no context): two dialog fields remain equally plausible — TARGET_AMBIGUOUS, nothing chosen arbitrarily, nothing filled', async () => {
    const report = await replay(FLOW(LEGACY));
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.reason).toMatch(/^TARGET_LOCATOR_NON_UNIQUE: 3 elements/);
    expect(fill?.targetResolution?.outcome).toBe('AMBIGUOUS');
    expect(fill?.effect?.execution).not.toBe('EXECUTED');
  }, 90_000);

  it('TEST 7 / 14 the recorded locator is gone: healed by role + label + dialog, confirmed by the runtime effect — a knowledge CANDIDATE', async () => {
    const report = await replay(FLOW(ENRICHED, 'css: "#oldValueInput"'), {
      logging: 'logging: { level: DEBUG }',
    });
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const trace = fillOf(report)?.targetResolution;
    expect(trace).toMatchObject({ trigger: 'LOCATOR_NOT_FOUND', outcome: 'HEALED' });
    expect(trace?.runtimeVerification?.status).toBe('CONFIRMED');
    expect(trace?.knowledge).toMatchObject({ status: 'CANDIDATE', globallyTrusted: false });
    const log = await readFile(path.join(lastReportsDir, 'engine-log.jsonl'), 'utf8');
    for (const event of ['TARGET_HEALING_REQUESTED', 'TARGET_HEALED', 'TARGET_HEALING_CONFIRMED'])
      expect(log, event).toContain(`"${event}"`);
  }, 90_000);

  it('TEST 12 / 15 a healed target whose runtime effect is wrong (the field refuses the value): ACTION_EFFECT_NOT_CONFIRMED, healing rejected, nothing learned', async () => {
    const report = await replay(
      FLOW(
        '{ role: textbox, tag: input, dialog: Filter, section: "Requests > Filter" }',
        'css: "#oldValueInput"',
      ),
      { variant: 'swallow', logging: 'logging: { level: DEBUG }' },
    );
    const fill = fillOf(report);
    expect(fill?.status, describeFlow(report)).toBe('FAILED');
    expect(fill?.reason).toMatch(/ACTION_EFFECT_NOT_CONFIRMED/);
    expect(fill?.targetResolution?.outcome).toBe('HEALED');
    expect(fill?.targetResolution?.knowledge).toBeUndefined();
    const log = await readFile(path.join(lastReportsDir, 'engine-log.jsonl'), 'utf8');
    expect(log).toContain('"TARGET_HEALING_REJECTED"');
  }, 90_000);
});
