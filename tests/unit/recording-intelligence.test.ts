import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import type { IntelligenceMode, IntelligenceRequest } from '../../src/ai/model.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedState,
  RecordingSession,
} from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';
import {
  enrichRecording,
  humanActionsFingerprint,
  loadRecordingCandidates,
  rememberRecordingCandidates,
} from '../../src/recording/recording-intelligence.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

const { config } = parseConfig(
  'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /request }\n',
  {},
  {},
);

const element = (overrides: Partial<RecordedElement>): RecordedElement => ({
  tag: 'input',
  role: 'textbox',
  name: 'Company name',
  label: 'Company name',
  css: 'form > input',
  cssStable: false,
  inForm: true,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  sameRoleName: 1,
  roleNameIndex: 0,
  sameLabel: 1,
  ...overrides,
});
const button = (name: string): RecordedElement =>
  element({ tag: 'button', role: 'button', name, label: undefined, text: name, inForm: false });
const state = (id: string, controls: string[]): RecordedState => ({
  id,
  stateId: `request-${id}`,
  label: '/request',
  route: '/request',
  url: 'http://app.test/request',
  title: 'Request',
  headings: [],
  alerts: [],
  invalidFields: 0,
  dialogs: [],
  controls,
});
let sequence = 0;
const raw = (
  type: RawRecordedEvent['type'],
  at: number,
  extra: Partial<RawRecordedEvent>,
): RawRecordedEvent => {
  sequence += 1;
  return { id: `r${String(sequence)}`, sequence, type, at, url: 'http://app.test/request', ...extra };
};

/** §52 : Enterprise → Company Information → Company name → Business number (aucune écriture : l'intention reste ambiguë). */
function recording() {
  const states = [
    state('o1', ['button:Enterprise']),
    state('o2', ['button:Enterprise', 'button:Company information']),
    state('o3', [
      'button:Enterprise',
      'button:Company information',
      'textbox:Company name',
      'textbox:Business number',
    ]),
  ];
  const events = [
    raw('navigation', 100, { stateAfter: 'o1' }),
    raw('click', 1000, { element: button('Enterprise'), stateAfter: 'o2' }),
    raw('click', 2000, { element: button('Company information'), stateAfter: 'o3' }),
    raw('change', 3000, {
      element: element({ name: 'Company name', label: 'Company name' }),
      value: { empty: false, length: 5, shape: 'text', digest: 'aaaaaaaaaaaaaaaa' },
      stateAfter: 'o3',
    }),
    raw('change', 4000, {
      element: element({ name: 'Business number', label: 'Business number' }),
      value: { empty: false, length: 10, shape: 'number', digest: 'bbbbbbbbbbbbbbbb' },
      stateAfter: 'o3',
    }),
  ];
  const session: RecordingSession = {
    id: 'rec-company',
    name: 'Company information',
    startedAt: '2026-10-02T12:00:00.000Z',
    startUrl: 'http://app.test/request',
    status: 'PROCESSING',
    rawEvents: events,
    semanticActions: [],
    checkpoints: [],
    states,
    initialStateId: 'o1',
    warnings: [],
    droppedEvents: 0,
  };
  return processRecording(session, config, {
    language: 'en',
    typedValues: new Map([
      [events[3]?.id ?? '', 'Alpha'],
      [events[4]?.id ?? '', '1234567890'],
    ]),
  });
}

/** Copilot (simulé) : l'objectif fonctionnel, et « Company information » révèle les champs entreprise. */
const answer = (request: IntelligenceRequest): unknown => {
  const opener = request.availableActions.find((action) => action.name === 'Company information');
  return {
    status: 'PROPOSAL',
    ...(opener ? { selectedActionId: opener.id } : {}),
    proposedGoal: { id: 'COMPANY_INFORMATION_COMPLETE' },
    workflowPhase: 'Company information entry',
    hypothesis: {
      type: 'CAUSAL',
      statement: 'Company Information click reveals company fields',
      evidenceIds: [],
    },
    expectedEffects: [
      { kind: 'VISIBLE_FIELD', value: 'Company name' },
      { kind: 'CHECKPOINT', value: 'COMPANY_INFORMATION_AVAILABLE' },
    ],
    supportingEvidenceIds: [],
    uncertainties: [],
    confidence: 0.8,
  };
};

function gateway(mode: IntelligenceMode, provider: FakeIntelligenceProvider): IntelligenceGateway {
  return new IntelligenceGateway({
    mode,
    providerId: provider.id,
    createProvider: () => provider,
    triggers: {
      ambiguousTarget: true,
      unknownScreen: true,
      flowDivergence: true,
      recoveryFailed: true,
      multiplePlans: true,
      unresolvedHypothesis: true,
      unknownBusinessError: true,
      lowConfidence: true,
      knowledgeContradiction: true,
      unknownBlockingPrecondition: true,
      hypothesisAnalysis: true,
      recordingEnrichment: true,
    },
    thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    budgets: {
      maxCallsPerRun: 10,
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

describe('Recording intelligence: PRESERVE FIRST, UNDERSTAND SECOND', () => {
  it('§52 every human action is kept unchanged; the AI proposes a goal and a causal hypothesis that stay PROPOSED', async () => {
    const result = recording();
    const steps = structuredClone(result.flow.steps);
    const yaml = result.files.yaml;
    const fingerprint = humanActionsFingerprint(result);
    const provider = new FakeIntelligenceProvider(answer);
    const intelligence = await enrichRecording({
      result,
      mode: 'ASSIST',
      gateway: gateway('ASSIST', provider),
    });
    // PRESERVE : ni suppression, ni ordre changé, ni valeur, ni classification, ni flow modifié.
    expect(result.flow.steps).toEqual(steps);
    expect(result.files.yaml).toBe(yaml);
    expect(humanActionsFingerprint(result)).toBe(fingerprint);
    expect(intelligence.preservationVerified).toBe(true);
    expect(intelligence.humanActions).toBeGreaterThanOrEqual(4);
    expect(intelligence.preserved).toBe(intelligence.humanActions);
    // L'IA ne voit que des libellés : jamais une valeur saisie.
    const sent = JSON.stringify(provider.requests);
    expect(sent).not.toContain('Alpha');
    expect(sent).not.toContain('1234567890');
    expect(provider.requests[0]?.trigger).toBe('RECORDING_ENRICHMENT');
    expect(intelligence.aiCalls).toBeGreaterThanOrEqual(1);
    expect(intelligence.ambiguities.join(' ')).toMatch(/no business intent/);
    const ai = intelligence.candidates.filter((candidate) => candidate.origin === 'AI_PROPOSAL');
    expect(ai.map((candidate) => candidate.kind)).toEqual(
      expect.arrayContaining(['FUNCTIONAL_GOAL', 'WORKFLOW_PHASE', 'CAUSAL', 'SEMANTIC_CHECKPOINT']),
    );
    for (const candidate of ai)
      expect(candidate).toMatchObject({
        status: 'PROPOSED',
        runtimeConfirmed: false,
        sourceRecording: 'rec-company',
        usage: 'SHADOW',
      });
    expect(ai.find((candidate) => candidate.kind === 'FUNCTIONAL_GOAL')?.statement).toBe(
      'COMPANY_INFORMATION_COMPLETE',
    );
    // Une relation OBSERVABLE au rejeu (le rejeu seul la confirmera).
    expect(ai.find((candidate) => candidate.observable)?.observable).toEqual({
      action: 'click company information',
      effect: 'textbox:company name',
    });
    // L'enrichissement est une analyse : jamais exécuté, jamais un repli en ASSIST.
    expect(intelligence.decisions[0]?.lifecycle).toMatchObject({
      terminal: 'SHADOW_ONLY',
      acceptedForExecution: false,
    });
    expect(intelligence.summary.runtimeConfirmed).toBe(0);
    expect(intelligence.summary.pendingConfirmation).toBe(ai.length);
  });

  it('§41 HYBRID: candidates become usable hypotheses, kept outside the repository for the replay', async () => {
    const result = recording();
    const intelligence = await enrichRecording({
      result,
      mode: 'HYBRID',
      gateway: gateway('HYBRID', new FakeIntelligenceProvider(answer)),
    });
    expect(
      intelligence.candidates
        .filter((candidate) => candidate.origin === 'AI_PROPOSAL')
        .every((candidate) => candidate.usage === 'HYPOTHESIS'),
    ).toBe(true);
    const file = path.join(
      await mkdtemp(path.join(tmpdir(), 'qa-rec-ai-')),
      'knowledge',
      'ai-recording-candidates.json',
    );
    await rememberRecordingCandidates(file, intelligence.candidates);
    const loaded = await loadRecordingCandidates(file);
    expect(loaded.length).toBeGreaterThan(0);
    expect(
      loaded.every((candidate) => candidate.origin === 'AI_PROPOSAL' && !candidate.runtimeConfirmed),
    ).toBe(true);
  });

  it('OFF / no gateway: deterministic enrichment only, no call', async () => {
    const result = recording();
    const intelligence = await enrichRecording({ result, mode: 'OFF' });
    expect(intelligence.aiCalls).toBe(0);
    expect(intelligence.candidates.every((candidate) => candidate.origin === 'DETERMINISTIC')).toBe(true);
    expect(intelligence.preservationVerified).toBe(true);
  });
});
