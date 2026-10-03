import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IntelligenceRequest } from '../../src/ai/model.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';
import { startFilterApp, type FilterApp } from '../fixtures/filter-app.js';

/**
 * RÉSOLUTION FONCTIONNELLE DE CIBLE au rejeu : le parcours « champ → opérateur → valeur → Apply »
 * où le framework RECRÉE le champ valeur après le choix de l'opérateur. Le même #valueInput, un
 * nouveau nœud, une autre empreinte : l'élément qui remplit la même fonction dans le même contexte
 * est retrouvé, puis PROUVÉ par l'effet (la valeur tenue) — jamais le premier par hasard.
 */
const FLOW = (fingerprint: string): string => `flows:
  - name: Filter requests
    steps:
      - click: { role: button, name: Filter }
      - select: { label: Field, option: Company name }
      - select: { label: Operator, option: Like }
      - fill: { css: "#valueInput", value: alpha }
        fingerprint: ${fingerprint}
      - click: { role: button, name: Apply }
        allow: [MUTATION]
      - expect: { text: "Filtered: Company name Like alpha" }
`;
/** L'empreinte enregistrée AVANT le re-rendu : le mat-label était « Search term ». */
const RECORDED =
  '{ role: textbox, tag: input, name: Search term, context: Filter, section: "Requests > Filter", semanticId: filter.value }';

describe('Functional target resolution on replay (real browser)', () => {
  let app: FilterApp;
  let dir: string;
  beforeAll(async () => {
    app = await startFilterApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-functional-target-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const replay = async (
    variant: string,
    options: { fingerprint?: string; ai?: string; provider?: FakeIntelligenceProvider } = {},
  ): Promise<FlowRunReport> => {
    const reportsDir = await mkdtemp(path.join(dir, `${variant}-`));
    const { config } = parseConfig(
      `mission: { name: functional-${variant} }
target: { baseUrl: ${app.url}, startAt: "/?variant=${variant}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 800, intelligentRecovery: { enabled: false } }
${options.ai ?? ''}
output: { reportsDir: ${reportsDir} }
${FLOW(options.fingerprint ?? RECORDED)}`,
      {},
      {},
    );
    const { result } = await runMission(config, {
      env: {},
      ...(options.provider ? { intelligenceProvider: options.provider } : {}),
    });
    const report = result.flows[0];
    if (!report) throw new Error('no flow report');
    return report;
  };
  const fillOf = (report: FlowRunReport) =>
    report.steps.find((step) => step.description.includes('#valueInput'));
  const describeFlow = (report: FlowRunReport): string =>
    JSON.stringify(
      report.steps.map((step) => [step.index, step.status, step.reason, step.targetResolution?.status]),
    );

  it('TEST 1 same node, same fingerprint: EXACT — no functional resolution at all', async () => {
    const report = await replay('default', {
      fingerprint: '{ role: textbox, tag: input, context: Filter }',
    });
    expect(report.status, describeFlow(report)).toBe('PASSED');
    expect(fillOf(report)?.targetResolution).toBeUndefined();
    expect(fillOf(report)?.status).toBe('PASSED');
  }, 90_000);

  it('TEST 2 / 6 / 13 / 14 Angular rerender after the operator choice (old node detached, same locator, other mat-label): RERENDERED, functionally equivalent, VALUE_CHANGED confirmed, next action available — the flow passes', async () => {
    const report = await replay('relabel');
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const trace = fillOf(report)?.targetResolution;
    expect(trace?.runtime.fingerprintVerdict).toBe('MISMATCH');
    expect(trace?.status).toBe('TARGET_RERENDERED');
    expect(trace?.rerender.detected).toBe(true);
    expect(trace?.rerender.evidence.join(' ')).toMatch(/appeared after SELECT "Operator" = "Like"/);
    expect(trace?.identity).toMatchObject({ businessConcept: 'filter.value', semanticRole: 'FILTER_VALUE' });
    expect(trace?.identity.configuration).toEqual({ Field: 'Company name', Operator: 'Like' });
    expect(trace?.temporal.nextActions[0]).toMatchObject({ type: 'CLICK', target: 'Apply' });
    expect(trace?.temporal.preconditions).toEqual([
      'FIELD_SELECTED',
      'OPERATOR_SELECTED',
      'VALUE_INPUT_AVAILABLE',
    ]);
    expect(trace?.runtimeVerification?.status).toBe('CONFIRMED');
    expect(trace?.nextAction).toBe('AVAILABLE');
    expect(trace?.final).toBe('TARGET_RECOVERED_AND_CONFIRMED');
    expect(trace?.ai.requested).toBe(false);
    // L'action suivante « Apply » renforce le candidat (une preuve, pas une vérité).
    expect(trace?.candidates[0]?.score).toBeGreaterThanOrEqual(0.6);
    // Une connaissance CANDIDATE, jamais une vérité globale.
    expect(trace?.knowledge).toMatchObject({
      functionalTarget: 'filter.value',
      rerenderSensitive: true,
      globallyTrusted: false,
    });
  }, 90_000);

  it('TEST 3 the same #valueInput now designates a field of ANOTHER section: rejected, never filled (no hidden regression)', async () => {
    const report = await replay('wrongSection');
    expect(report.status).toBe('FAILED');
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.targetResolution?.status).toMatch(/TARGET_CONTEXT_MISMATCH|TARGET_FUNCTIONAL_MISMATCH/);
    expect(fill?.reason).toMatch(/TARGET_FINGERPRINT_MISMATCH/);
  }, 90_000);

  it('TEST 7 fingerprint matches but the field does not hold the value: never SUCCESS — ACTION_EFFECT_NOT_CONFIRMED on the FILL itself (first functional divergence)', async () => {
    const report = await replay('swallow', {
      fingerprint: '{ role: combobox, tag: input, context: Filter }',
    });
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.reason).toMatch(/ACTION_EFFECT_NOT_CONFIRMED/);
    // L'erreur appartient au FILL, pas à « Apply ».
    expect(report.steps.find((step) => step.description.includes('Apply'))?.status).not.toBe('FAILED');
  }, 90_000);

  /** Le conseiller : choisit le candidat dont la description contient ce texte (ou un identifiant inventé). */
  const advisor = (pick: (request: IntelligenceRequest) => string | undefined) =>
    new FakeIntelligenceProvider((request) => {
      const id = pick(request);
      return {
        status: id ? 'PROPOSAL' : 'INCONCLUSIVE',
        ...(id ? { selectedActionId: id } : {}),
        supportingEvidenceIds: [],
        uncertainties: [],
        confidence: 0.91,
      };
    });
  const resolutionRequest = (provider: FakeIntelligenceProvider): Record<string, unknown> | undefined =>
    provider.requests.find((request) => request.targetResolution)?.targetResolution;
  const candidateIds = (request: IntelligenceRequest): string[] =>
    ((request.targetResolution?.runtimeCandidates as { id: string }[] | undefined) ?? []).map(
      (entry) => entry.id,
    );
  const HYBRID = 'ai: { enabled: true, mode: HYBRID, provider: deterministic }';

  it('TEST 4 / 11 two plausible #valueInput, intelligence OFF: AMBIGUOUS — never the first by chance, no AI call', async () => {
    const report = await replay('ambiguous');
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.targetResolution?.status).toBe('TARGET_AMBIGUOUS');
    expect(fill?.targetResolution?.ai.requested).toBe(false);
    expect(fill?.targetResolution?.resolution).toBeUndefined();
  }, 90_000);

  it('TEST 8 / 16 HYBRID: the advisor receives the structured context (previous, next, preconditions, screen, candidates — never the value) and picks an existing candidate; validated, executed, VALUE_CHANGED confirmed', async () => {
    const provider = advisor((request) => candidateIds(request)[0]);
    const report = await replay('ambiguous', { ai: HYBRID, provider });
    const trace = fillOf(report)?.targetResolution;
    // T1 = la recherche globale (autre section, écartée) ; T2 = le champ après « Operator = Like ».
    expect(trace?.ai).toMatchObject({ requested: true, outcome: 'VALIDATED', proposal: 'T2' });
    expect(trace?.candidates.find((candidate) => candidate.id === 'T1')?.rejected).toMatch(
      /context mismatch/,
    );
    expect(trace?.status).toBe('TARGET_AI_ASSISTED');
    expect(trace?.runtimeVerification?.status).toBe('CONFIRMED');
    expect(report.status, describeFlow(report)).toBe('PASSED');
    const request = resolutionRequest(provider);
    expect(request).toMatchObject({
      trigger: 'TARGET_FINGERPRINT_MISMATCH',
      workflow: { phase: 'FILTER_CONFIGURATION' },
      currentAction: { type: 'FILL', semanticIntent: 'ENTER_FILTER_VALUE' },
      preconditions: ['FIELD_SELECTED', 'OPERATOR_SELECTED', 'VALUE_INPUT_AVAILABLE'],
      originalTarget: {
        businessConcept: 'filter.value',
        configuration: { Field: 'Company name', Operator: 'Like' },
      },
    });
    expect(JSON.stringify(request)).toMatch(/"Apply"/);
    expect((request?.screen as { selectedValues?: Record<string, string> }).selectedValues).toMatchObject({
      Operator: 'Like',
    });
    // Jamais la valeur saisie, ni le DOM complet.
    expect(JSON.stringify(provider.requests)).not.toContain('alpha');
    expect(JSON.stringify(provider.requests)).not.toContain('<mat-form-field');
  }, 90_000);

  it('TEST 9 HYBRID: an invented candidate (T99) is rejected — nothing is executed', async () => {
    const provider = advisor(() => 'T99');
    const report = await replay('ambiguous', { ai: HYBRID, provider });
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.targetResolution?.ai.outcome).toMatch(/REJECTED|UNAVAILABLE/);
    expect(fill?.targetResolution?.resolution).toBeUndefined();
    expect(fill?.effect?.execution).not.toBe('EXECUTED');
  }, 90_000);

  it('TEST 10 HYBRID: the advisor picks the wrong input — the runtime effect fails, the proposal is contradicted, the FILL fails', async () => {
    const provider = advisor((request) => candidateIds(request)[1]);
    const report = await replay('ambiguous', { ai: HYBRID, provider });
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.reason).toMatch(/ACTION_EFFECT_NOT_CONFIRMED/);
    expect(fill?.targetResolution?.runtimeVerification?.status).toBe('REJECTED');
    expect(fill?.targetResolution?.final).toBe('TARGET_RECOVERY_REJECTED');
  }, 90_000);

  it('TEST 12 ASSIST: the proposal is recorded, the deterministic decision is unchanged (still AMBIGUOUS, not executed)', async () => {
    const provider = advisor((request) => candidateIds(request)[0]);
    const report = await replay('ambiguous', {
      ai: 'ai: { enabled: true, mode: ASSIST, provider: deterministic }',
      provider,
    });
    const fill = fillOf(report);
    expect(fill?.status).toBe('FAILED');
    expect(fill?.targetResolution?.ai).toMatchObject({
      requested: true,
      outcome: 'RECORDED_ONLY',
      proposal: 'T2',
    });
    expect(fill?.targetResolution?.status).toBe('TARGET_AMBIGUOUS');
  }, 90_000);

  it('the HTML report shows the Target resolution section', async () => {
    const reportsDir = await mkdtemp(path.join(dir, 'html-'));
    const { config } = parseConfig(
      `mission: { name: functional-html }
target: { baseUrl: ${app.url}, startAt: "/?variant=relabel" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 800, intelligentRecovery: { enabled: false } }
output: { reportsDir: ${reportsDir} }
${FLOW(RECORDED)}`,
      {},
      {},
    );
    await runMission(config, { env: {} });
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('Target resolution: TARGET_RERENDERED');
    expect(html).toContain('RUNTIME_CONFIRMED');
  }, 90_000);
});
