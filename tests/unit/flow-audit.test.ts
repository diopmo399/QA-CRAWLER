import { describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import type { IntelligenceMode, IntelligenceRequest } from '../../src/ai/model.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { RecordedFlowStep, SemanticRecordedAction } from '../../src/recording/model.js';
import type { RecordingResult } from '../../src/recording/process-recording.js';
import {
  annotateFlowYaml,
  auditGeneratedFlow,
  deterministicFlowFindings,
  flowAuditText,
} from '../../src/recording/flow-audit.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

/**
 * FLOW AUDIT : le flow GÉNÉRÉ relu dans son ensemble. Le cas réel : un clic sur la cellule « Process
 * request » sans effet, puis le même clic avec la navigation (trop espacés pour être fusionnés).
 */
interface Spec {
  step: FlowStep;
  label: string;
  effect?: { route?: string; dom?: string[]; writes?: string[] };
  unresolved?: boolean;
  quality?: RecordedFlowStep['quality'];
}

const click = (name: string, row?: string): FlowStep =>
  ({
    kind: 'click',
    target: { strategy: 'text', value: name },
    allow: [],
    optional: false,
    ...(row ? { fingerprint: { row } } : {}),
  });
const fill = (label: string): FlowStep =>
  ({
    kind: 'fill',
    target: { strategy: 'label', value: label },
    value: 'x',
    allow: [],
    optional: false,
  });
const expectText = (text: string): FlowStep =>
  ({ kind: 'expect', expect: { text }, allow: [], optional: false }) as unknown as FlowStep;

function recordingOf(specs: Spec[], assertions = 0): RecordingResult {
  const actions = specs.map(
    (spec, index) =>
      ({
        id: `a${String(index + 1)}`,
        type: spec.step.kind.toUpperCase(),
        at: 1000 * (index + 1),
        rawEventIds: [`r${String(index + 1)}`],
        evidence: [],
        network: (spec.effect?.writes ?? []).map((write) => {
          const [method, path] = write.split(' ');
          return { method, path };
        }),
        ...(spec.effect?.dom ? { domEffects: spec.effect.dom } : {}),
        ...(spec.effect?.route ? { navigation: { route: spec.effect.route } } : {}),
      }) as unknown as SemanticRecordedAction,
  );
  return {
    session: { id: 'rec-audit', states: [], rawEvents: [] },
    normalized: { actions, kept: actions },
    flow: {
      name: 'Process a request',
      recordingSessionId: 'rec-audit',
      startAt: '/tasks',
      steps: specs.map((spec, index) => ({
        id: `s${String(index + 1)}`,
        step: spec.step,
        label: spec.label,
        actionIds: [`a${String(index + 1)}`],
        rawEventIds: [`r${String(index + 1)}`],
        provenance: 'HUMAN_RECORDED',
        confidence: 0.9,
        ...(spec.quality ? { quality: spec.quality } : {}),
        ...(spec.unresolved ? { semanticStatus: 'UNRESOLVED' } : {}),
        explanation: '',
      })),
      assertions: Array.from({ length: assertions }, () => ({})),
      intent: {},
      negative: false,
    },
  } as unknown as RecordingResult;
}

/** Le cas de l'écran réel, en libellés neutres. */
const REAL = (): RecordingResult =>
  recordingOf([
    { step: click('Open filters'), label: 'Open filters', effect: { dom: ['+ textbox:Keyword'] } },
    { step: click('Process request', 'Request 42'), label: 'Process request', unresolved: true },
    { step: click('Process request', 'Request 42'), label: 'Process request', effect: { route: '/process' } },
    { step: fill('Comment'), label: 'Comment' },
  ]);

describe('FlowAuditor — deterministic rules', () => {
  it('the effect-less click before the same click with the effect is flagged on both steps, with the fix', () => {
    const findings = deterministicFlowFindings(REAL());
    const retry = findings.find((finding) => finding.rule === 'EFFECTLESS_CLICK_BEFORE_SAME_TARGET');
    expect(retry).toMatchObject({
      severity: 'WARNING',
      steps: [2, 3],
      origin: 'DETERMINISTIC',
      reviewRequired: true,
    });
    expect(retry?.suggestion).toMatch(/remove step 2/);
    // Le flow finit par une saisie jamais envoyée, et ne vérifie rien.
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['TRAILING_INPUT_NOT_SUBMITTED', 'NO_FINAL_CHECK']),
    );
    // Le clic sans effet déjà couvert par le constat ci-dessus n'est pas compté deux fois.
    expect(findings.filter((finding) => finding.rule === 'UNRESOLVED_STEP')).toEqual([]);
  });

  it('two clicks on different rows are never a duplicate; a repeated write is a DOUBLE_MUTATION_RISK', () => {
    const rows = deterministicFlowFindings(
      recordingOf([
        { step: click('Edit', 'Request 41'), label: 'Edit', effect: { route: '/edit/41' } },
        { step: click('Edit', 'Request 42'), label: 'Edit', effect: { route: '/edit/42' } },
        { step: expectText('Saved'), label: 'expect' },
      ]),
    );
    expect(rows.map((finding) => finding.rule)).not.toContain('CONSECUTIVE_DUPLICATE_STEP');
    const writes = deterministicFlowFindings(
      recordingOf([
        { step: click('Save'), label: 'Save', effect: { writes: ['POST /api/requests'] } },
        { step: click('Save again'), label: 'Save again', effect: { writes: ['POST /api/requests'] } },
        { step: expectText('Saved'), label: 'expect' },
      ]),
    );
    expect(writes.find((finding) => finding.rule === 'DOUBLE_MUTATION_RISK')).toMatchObject({
      severity: 'ERROR',
      steps: [1, 2],
    });
  });

  it('a clean flow (effects, final check) has no finding', () => {
    expect(
      deterministicFlowFindings(
        recordingOf([
          { step: click('Open filters'), label: 'Open filters', effect: { dom: ['+ textbox:Keyword'] } },
          { step: fill('Keyword'), label: 'Keyword' },
          { step: click('Apply'), label: 'Apply', effect: { dom: ['3 results'] } },
          { step: expectText('3 results'), label: 'expect' },
        ]),
      ),
    ).toEqual([]);
  });
});

function gateway(mode: IntelligenceMode, provider: FakeIntelligenceProvider): IntelligenceGateway {
  const on = true;
  return new IntelligenceGateway({
    mode,
    providerId: provider.id,
    createProvider: () => provider,
    triggers: {
      ambiguousTarget: on,
      unknownScreen: on,
      flowDivergence: on,
      recoveryFailed: on,
      multiplePlans: on,
      unresolvedHypothesis: on,
      unknownBusinessError: on,
      lowConfidence: on,
      knowledgeContradiction: on,
      unknownBlockingPrecondition: on,
      hypothesisAnalysis: on,
      recordingEnrichment: on,
    },
    thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    budgets: {
      maxCallsPerRun: 20,
      maxCallsPerAction: 1,
      maxCallsPerDivergence: 1,
      maxToolCallsPerRequest: 4,
      maxReasoningDurationMs: 60_000,
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    failOnUnavailable: false,
    sanitizer: new IntelligenceContextSanitizer(),
  });
}

/** Le conseiller : il désigne l'étape « 2. » (le clic sans effet) et l'explique. */
const advisor = (request: IntelligenceRequest): unknown => {
  const second = request.availableActions.find((action) => action.name.startsWith('2.'));
  const fourth = request.availableActions.find((action) => action.name.startsWith('4.'));
  const global = /whole recorded test flow/.test(JSON.stringify(request));
  const chosen = global ? fourth : second;
  return {
    status: 'PROPOSAL',
    ...(chosen ? { selectedActionId: chosen.id } : {}),
    hypothesis: {
      type: 'CAUSAL',
      statement: global
        ? 'the comment is typed but never saved'
        : 'step 2 is a missed click on the cell; step 3 opens the request',
      evidenceIds: request.relevantEvidence.slice(0, 2).map((evidence) => evidence.id),
    },
    supportingEvidenceIds: request.relevantEvidence.slice(0, 2).map((evidence) => evidence.id),
    uncertainties: [],
    confidence: 0.85,
  };
};

describe('FlowAuditor — the advisor reviews, never modifies', () => {
  const settings = { enabled: true, ai: true, maxCalls: 5 };

  it('ai.mode OFF: zero call, the deterministic findings are still reported', async () => {
    const provider = new FakeIntelligenceProvider(advisor);
    const report = await auditGeneratedFlow({
      result: REAL(),
      settings,
      intelligenceMode: 'OFF',
      gateway: gateway('ASSIST', provider),
    });
    expect(report.aiCalls).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.flowModified).toBe(false);
  });

  it('the advisor CONFIRMS the effect-less click; its own finding on another step stays an AI_PROPOSAL to review', async () => {
    const result = REAL();
    const stepsBefore = JSON.stringify(result.flow.steps);
    const report = await auditGeneratedFlow({
      result,
      settings,
      intelligenceMode: 'ASSIST',
      gateway: gateway('ASSIST', new FakeIntelligenceProvider(advisor)),
    });
    expect(report.aiCalls).toBeGreaterThan(0);
    const retry = report.findings.find((finding) => finding.rule === 'EFFECTLESS_CLICK_BEFORE_SAME_TARGET');
    expect(retry?.assessment).toBe('AI_CONFIRMED');
    expect(retry?.aiStatement).toMatch(/missed click/);
    // Le flow n'a pas bougé.
    expect(JSON.stringify(result.flow.steps)).toBe(stepsBefore);
    expect(flowAuditText(report).join('\n')).toMatch(
      /EFFECTLESS_CLICK_BEFORE_SAME_TARGET — step\(s\) 2, 3 \(DETERMINISTIC, AI_CONFIRMED\)/,
    );
  });

  it('the YAML is annotated ABOVE the concerned step, its content unchanged', async () => {
    const report = await auditGeneratedFlow({ result: REAL(), settings, intelligenceMode: 'OFF' });
    const yaml = [
      'name: Process a request',
      'steps:',
      '  # HUMAN_RECORDED · h001',
      '  - click:',
      '      text: Open filters',
      '  # UNRESOLVED_HUMAN_ACTION · h002',
      '  - click:',
      '      text: Process request',
      '  # HUMAN_RECORDED · h003',
      '  - click:',
      '      text: Process request',
      '  - fill:',
      '      label: Comment',
      '',
    ].join('\n');
    const annotated = annotateFlowYaml(yaml, report);
    expect(annotated).toMatch(
      / {2}# FLOW AUDIT F\d \[WARNING\] EFFECTLESS_CLICK_BEFORE_SAME_TARGET: remove step 2[^\n]*\n {2}# UNRESOLVED_HUMAN_ACTION · h002/,
    );
    expect(
      annotated
        .split('\n')
        .filter((line) => !line.includes('FLOW AUDIT'))
        .join('\n'),
    ).toBe(yaml);
  });
});
