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
import { humanActionsFingerprint } from '../../src/recording/recording-intelligence.js';
import { arbitrateAudit, auditRecordingSemantics } from '../../src/recording/semantic-audit.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

const { config } = parseConfig(
  'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /settings }\n',
  {},
  {},
);

const element = (overrides: Partial<RecordedElement>): RecordedElement => ({
  tag: 'input',
  role: 'textbox',
  name: 'Search',
  label: 'Search',
  css: 'main > section:nth-of-type(2) input',
  cssStable: false,
  inForm: false,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  sameRoleName: 2,
  roleNameIndex: 0,
  sameLabel: 2,
  sectionPath: ['Columns'],
  sameLabelInSection: 1,
  ...overrides,
});
const state = (id: string): RecordedState => ({
  id,
  stateId: `settings-${id}`,
  label: '/settings',
  route: '/settings',
  url: 'http://app.test/settings',
  title: 'Settings',
  headings: ['Columns', 'Filters'],
  alerts: [],
  invalidFields: 0,
  dialogs: [],
  controls: ['textbox:Search', 'button:Save', 'textbox:Priority'],
});

/**
 * Un parcours avec trois actions : une saisie claire (Search, section Columns), un clic sur un
 * élément sans nom (localisateur fragile, intention inconnue) et un glisser sans déplacement observé.
 */
function recording(dropZoneKnown = true) {
  let sequence = 0;
  const raw = (
    type: RawRecordedEvent['type'],
    at: number,
    extra: Partial<RawRecordedEvent>,
  ): RawRecordedEvent => {
    sequence += 1;
    return { id: `r${String(sequence)}`, sequence, type, at, url: 'http://app.test/settings', ...extra };
  };
  const events = [
    raw('navigation', 100, { stateAfter: 'o1' }),
    raw('change', 1000, {
      element: element({}),
      value: { empty: false, length: 5, shape: 'text', digest: 'aaaaaaaaaaaaaaaa' },
      stateAfter: 'o1',
    }),
    raw('click', 2000, {
      element: element({
        tag: 'div',
        role: '',
        name: '',
        label: undefined,
        css: 'main > div:nth-of-type(3)',
        sameLabel: 0,
        sameRoleName: 0,
        sectionPath: undefined,
      }),
      stateAfter: 'o1',
    }),
    raw('drag', 3000, {
      element: element({
        tag: 'li',
        role: 'listitem',
        name: 'Status',
        label: undefined,
        text: 'Status',
        sameLabel: 0,
      }),
      drag: {
        kind: 'POINTER',
        item: 'Status',
        source: { section: 'Columns > Available columns' },
        ...(dropZoneKnown ? { destination: { section: 'Columns > Selected columns' } } : {}),
        sameZone: false,
        moved: false,
      },
      stateAfter: 'o1',
    }),
  ];
  const session: RecordingSession = {
    id: 'rec-settings',
    name: 'Settings',
    startedAt: '2026-10-03T12:00:00.000Z',
    startUrl: 'http://app.test/settings',
    status: 'PROCESSING',
    rawEvents: events,
    semanticActions: [],
    checkpoints: [],
    states: [state('o1')],
    initialStateId: 'o1',
    warnings: [],
    droppedEvents: 0,
  };
  return processRecording(session, config, {
    language: 'en',
    typedValues: new Map([[events[1]?.id ?? '', 'secret-looking-text']]),
  });
}

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

const settings = (mode: 'OFF' | 'SUSPICIOUS_ONLY' | 'FULL') => ({
  ...config.recording.intelligenceAudit,
  mode,
});

/** L'IA choisit la lecture déterministe (la seule action qui porte un score déterministe). */
const agree = (request: IntelligenceRequest): unknown => {
  const chosen = request.availableActions.find((action) => action.deterministicScore !== undefined);
  return {
    status: 'PROPOSAL',
    ...(chosen ? { selectedActionId: chosen.id } : {}),
    intent: 'configure the report',
    supportingEvidenceIds: request.relevantEvidence.slice(0, 1).map((evidence) => evidence.id),
    uncertainties: [],
    confidence: 0.85,
  };
};
/** L'IA lit une autre cible (« Save ») : un désaccord. */
const disagree = (request: IntelligenceRequest): unknown => {
  const save = request.availableActions.find((action) => action.name === 'Save');
  return {
    status: 'PROPOSAL',
    ...(save ? { selectedActionId: save.id } : {}),
    supportingEvidenceIds: ['E999'],
    uncertainties: [],
    confidence: 0.8,
  };
};

describe('Recording semantic audit (RecordingSemanticAuditor)', () => {
  it('§75 intelligence OFF: zero call, every action keeps its deterministic interpretation, suspicious ones are still flagged', async () => {
    const result = recording();
    const provider = new FakeIntelligenceProvider(agree);
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('FULL'),
      intelligenceMode: 'OFF',
      gateway: gateway('ASSIST', provider),
    });
    expect(provider.requests).toHaveLength(0);
    expect(audit.aiCalls).toBe(0);
    expect(audit.entries.every((entry) => entry.aiAssessment === 'NOT_AUDITED')).toBe(true);
    const drag = audit.entries.find(
      (entry) => entry.deterministicInterpretation.interaction === 'DRAG_AND_DROP',
    );
    expect(drag?.auditTrigger).toContain('POSSIBLE_DRAG_AND_DROP');
    expect(drag?.reviewRequired).toBe(true);
    expect(drag?.humanActionId).toMatch(/^h\d{3}$/);
  });

  it('§76 SUSPICIOUS_ONLY: only the actions with a trigger are sent; the clear field is not', async () => {
    const result = recording();
    const provider = new FakeIntelligenceProvider(agree);
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('SUSPICIOUS_ONLY'),
      intelligenceMode: 'ASSIST',
      gateway: gateway('ASSIST', provider),
    });
    const search = audit.entries.find((entry) => entry.deterministicInterpretation.target === 'Search');
    expect(search?.aiAssessment).toBe('NOT_AUDITED');
    expect(search?.deterministicInterpretation.section).toBe('Columns');
    expect(audit.aiCalls).toBe(2);
    expect(provider.requests).toHaveLength(2);
    // Jamais une valeur saisie dans une requête.
    expect(JSON.stringify(provider.requests)).not.toContain('secret-looking-text');
  });

  it('§74 FULL: every human action is audited (bounded by maxCalls)', async () => {
    const result = recording();
    const provider = new FakeIntelligenceProvider(agree);
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('FULL'),
      intelligenceMode: 'ASSIST',
      gateway: gateway('ASSIST', provider),
    });
    expect(audit.aiCalls).toBe(3);
    expect(
      audit.entries.find((entry) => entry.deterministicInterpretation.target === 'Search')?.auditTrigger,
    ).toEqual(['FULL_AUDIT']);
    const bounded = await auditRecordingSemantics({
      result,
      settings: { ...settings('FULL'), maxCalls: 1 },
      intelligenceMode: 'ASSIST',
      gateway: gateway('ASSIST', new FakeIntelligenceProvider(agree)),
    });
    expect(bounded.aiCalls).toBe(1);
    expect(bounded.entries.filter((entry) => entry.decisionReason.includes('audit budget'))).toHaveLength(2);
  });

  it('§70 the AI agrees: CONFIRMED, cited evidence kept (E…), nothing changes in the flow', async () => {
    const result = recording();
    const before = humanActionsFingerprint(result);
    const yaml = result.files.yaml;
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('FULL'),
      intelligenceMode: 'ASSIST',
      gateway: gateway('ASSIST', new FakeIntelligenceProvider(agree)),
    });
    expect(audit.summary.confirmed).toBe(3);
    for (const entry of audit.entries) {
      expect(entry.evidence.every((evidence) => /^E\d+$/.test(evidence.id))).toBe(true);
      expect(entry.finalInterpretation).toEqual(entry.deterministicInterpretation);
      expect(entry.runtimeConfirmation).toBe('PENDING');
    }
    expect(audit.entries.some((entry) => entry.citedEvidence.length > 0)).toBe(true);
    expect(humanActionsFingerprint(result)).toBe(before);
    expect(result.files.yaml).toBe(yaml);
  });

  it('§71 the AI disagrees: DISAGREEMENT kept as a hypothesis (AI_PROPOSAL, not runtime-confirmed), the deterministic reading stays final', async () => {
    const result = recording();
    const before = humanActionsFingerprint(result);
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('FULL'),
      intelligenceMode: 'HYBRID',
      gateway: gateway('HYBRID', new FakeIntelligenceProvider(disagree)),
    });
    const search = audit.entries.find((entry) => entry.deterministicInterpretation.target === 'Search');
    // E999 n'existe pas : la proposition citant une preuve inconnue est rejetée par la passerelle.
    expect(search?.aiAssessment).toBe('INCONCLUSIVE');
    const answer = await auditRecordingSemantics({
      result,
      settings: settings('FULL'),
      intelligenceMode: 'HYBRID',
      gateway: gateway(
        'HYBRID',
        new FakeIntelligenceProvider((request) => ({
          ...(disagree(request) as object),
          supportingEvidenceIds: [],
        })),
      ),
    });
    const disagreed = answer.entries.find((entry) => entry.deterministicInterpretation.target === 'Search');
    expect(disagreed?.aiAssessment).toBe('DISAGREEMENT');
    expect(disagreed?.aiProposal).toMatchObject({
      target: 'Save',
      origin: 'AI_PROPOSAL',
      runtimeConfirmed: false,
    });
    expect(disagreed?.finalInterpretation).toEqual(disagreed?.deterministicInterpretation);
    expect(disagreed?.reviewRequired).toBe(true);
    expect(disagreed?.disagreement).toContain('Save');
    expect(humanActionsFingerprint(result)).toBe(before);
  });

  it('§72 the provider is unavailable: INCONCLUSIVE, the deterministic interpretation is kept, nothing fails', async () => {
    const result = recording();
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('SUSPICIOUS_ONLY'),
      intelligenceMode: 'ASSIST',
      gateway: gateway('ASSIST', new FakeIntelligenceProvider(agree, { available: false })),
    });
    const audited = audit.entries.filter((entry) => entry.aiAssessment !== 'NOT_AUDITED');
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((entry) => entry.aiAssessment === 'INCONCLUSIVE')).toBe(true);
    expect(audited.every((entry) => entry.finalInterpretation === entry.deterministicInterpretation)).toBe(
      true,
    );
  });

  it('§73 a human interaction left without accounting is always reported (NORMALIZATION_LOSS)', async () => {
    const result = recording();
    result.journey.accounts.push({
      interactionId: 'h099',
      sequence: 99,
      type: 'CLICK',
      target: 'Apply',
      status: 'UNACCOUNTED',
    } as (typeof result.journey.accounts)[number]);
    const audit = await auditRecordingSemantics({
      result,
      settings: settings('SUSPICIOUS_ONLY'),
      intelligenceMode: 'OFF',
    });
    const lost = audit.entries.find((entry) => entry.humanActionId === 'h099');
    expect(lost?.auditTrigger).toEqual(['NORMALIZATION_LOSS']);
    expect(lost?.reviewRequired).toBe(true);
  });

  it('the arbiter never lets a weak or absent answer replace the deterministic reading', () => {
    const proposal = {
      status: 'PROPOSAL' as const,
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0.4,
    };
    expect(
      arbitrateAudit({ proposal, selectedKey: 'b', deterministicKey: 'a', minConfidence: 0.6 }).assessment,
    ).toBe('INCONCLUSIVE');
    expect(
      arbitrateAudit({
        proposal: undefined,
        selectedKey: undefined,
        deterministicKey: 'a',
        minConfidence: 0.6,
      }).assessment,
    ).toBe('INCONCLUSIVE');
    expect(
      arbitrateAudit({
        proposal: { ...proposal, confidence: 0.7, uncertainties: ['two similar fields'] },
        selectedKey: 'a',
        deterministicKey: 'a',
        minConfidence: 0.6,
      }).assessment,
    ).toBe('SUSPICIOUS');
  });

  it('§68 / §78 a drag whose drop zone is not understood is PRESERVED (UNRESOLVED, a manual step), never lost', () => {
    const result = recording(false);
    const step = result.flow.steps.find((entry) => entry.step.kind === 'manual');
    expect(step?.step).toMatchObject({ kind: 'manual', text: 'drag "Status" (drop zone not understood)' });
    const drag = result.journey.accounts.find((account) => account.type === 'DRAG_AND_DROP');
    expect(drag?.status).toMatch(/PRESERVED/);
    expect(result.journey.accounts.filter((account) => account.status === 'UNACCOUNTED')).toHaveLength(0);
    // Avec une zone connue : une étape dragAndDrop (jamais réduite à un clic).
    const known = recording(true).flow.steps.find((entry) => entry.step.kind === 'dragAndDrop');
    expect(known?.step).toMatchObject({ item: 'Status', to: { section: 'Columns > Selected columns' } });
  });
});
