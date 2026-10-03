import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import {
  aiTriggerOf,
  analyzeRerender,
  buildTemporalContext,
  decide,
  functionalIdentityOf,
  redactDeep,
  sameFilledValue,
  scoreCandidates,
  targetResolutionRequest,
  temporalLine,
  type FunctionalCandidate,
  type TargetResolutionTrace,
} from '../../src/flows/functional-target.js';

/** Le parcours du panneau Filter : champ, opérateur, valeur, Apply (libellés neutres). */
const steps = (): FlowStep[] =>
  parseConfig(
    `mission: { name: unit }
target: { baseUrl: "http://app.test" }
flows:
  - name: Filter
    steps:
      - click: { role: button, name: Filter }
      - select: { label: Field, option: Company name }
      - select: { label: Operator, option: Like }
      - fill: { css: "#valueInput", value: alpha }
        fingerprint: { role: textbox, tag: input, name: Search term, context: Filter, section: "Requests > Filter", semanticId: filter.value }
      - click: { role: button, name: Apply }
`,
    {},
    {},
  ).config.flows[0]?.steps ?? [];

const candidate = (overrides: Partial<FunctionalCandidate> & { id: string }): FunctionalCandidate => ({
  tag: 'input',
  role: 'textbox',
  name: '',
  visible: true,
  enabled: true,
  editable: true,
  matchesRecordedLocator: false,
  nearText: [],
  stableAttributes: {},
  ...overrides,
});
const FILTER_VALUE = candidate({
  id: 'T1',
  name: 'Value',
  label: 'Value',
  section: 'Requests > Filter',
  dialog: 'Filter',
  matchesRecordedLocator: true,
  previousControl: 'combobox: Operator = Like',
  nextControl: 'button: Apply',
  parent: 'mat-form-field',
  cssHint: '#valueInput',
});

describe('Functional target resolution (pure)', () => {
  const flow = steps();
  const fill = flow[3] as Extract<FlowStep, { target: unknown }>;
  const temporal = buildTemporalContext(flow, 3, [
    { status: 'PASSED' },
    { status: 'PASSED' },
    { status: 'PASSED' },
  ]);
  const identity = functionalIdentityOf(fill, flow, 3);

  it('the temporal context: previous choices (with their option and result), the next action, the phase and the preconditions', () => {
    expect(temporal.previousActions.slice(1)).toEqual([
      { type: 'SELECT', target: 'Field', value: 'Company name', result: 'CONFIRMED' },
      { type: 'SELECT', target: 'Operator', value: 'Like', result: 'CONFIRMED' },
    ]);
    expect(temporal.nextActions).toEqual([{ type: 'CLICK', target: 'Apply' }]);
    expect(temporal.workflowPhase).toBe('FILTER_CONFIGURATION');
    expect(temporal.currentAction.semanticIntent).toBe('ENTER_FILTER_VALUE');
    expect(temporal.preconditions).toEqual(['FIELD_SELECTED', 'OPERATOR_SELECTED', 'VALUE_INPUT_AVAILABLE']);
    expect(identity).toMatchObject({
      semanticRole: 'FILTER_VALUE',
      businessConcept: 'filter.value',
      section: 'Requests > Filter',
      configuration: { Field: 'Company name', Operator: 'Like' },
    });
  });

  it('TEST 5 / 14 the right input is found through the workflow context: after "Operator = Like", before "Apply", in the Filter section — the global search box is not even a candidate', () => {
    const ranked = scoreCandidates(identity, temporal, [
      candidate({ id: 'T2', name: 'Search', label: 'Search', section: 'Requests', cssHint: '#search' }),
      FILTER_VALUE,
    ]);
    const decision = decide(ranked);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T1');
    expect(decision.chosen?.components).toMatchObject({
      previousActionCompatibility: 0.15,
      nextActionCompatibility: 0.1,
      businessConceptMatch: 0.1,
      section: 0.2,
    });
    expect(ranked.find((entry) => entry.id === 'T2')?.rejected).toMatch(/context mismatch/);
  });

  it('TEST 3 the same locator in ANOTHER section is rejected (context mismatch), never "recovered"', () => {
    const decision = decide(
      scoreCandidates(identity, temporal, [
        candidate({ id: 'T1', name: 'Archive search', section: 'Archive', matchesRecordedLocator: true }),
      ]),
    );
    expect(decision.status).toBe('NONE');
    expect(decision.reason).toMatch(/context mismatch/);
  });

  it('TEST 4 two equally plausible candidates: AMBIGUOUS — never the first one by chance', () => {
    const twin = { ...FILTER_VALUE, id: 'T2' };
    const decision = decide(scoreCandidates(identity, temporal, [FILTER_VALUE, twin]));
    expect(decision.status).toBe('AMBIGUOUS');
    expect(decision.chosen).toBeUndefined();
  });

  it('hidden, disabled or read-only fields are never candidates for a FILL', () => {
    const ranked = scoreCandidates(identity, temporal, [
      { ...FILTER_VALUE, id: 'T1', visible: false },
      { ...FILTER_VALUE, id: 'T2', enabled: false },
      { ...FILTER_VALUE, id: 'T3', editable: false },
    ]);
    expect(ranked.map((entry) => entry.rejected)).toEqual(['hidden', 'disabled', 'not editable']);
    expect(decide(ranked).status).toBe('NONE');
  });

  it('TEST 13 rerender: the recorded locator designates the equivalent element, its fingerprint changed, right after the causal SELECT', () => {
    const [chosen] = scoreCandidates(identity, temporal, [FILTER_VALUE]);
    const rerender = analyzeRerender(chosen, temporal, ['"Value" instead of "Search term"']);
    expect(rerender.detected).toBe(true);
    expect(rerender.evidence.join(' ')).toMatch(/appeared after SELECT "Operator" = "Like"/);
    if (!chosen) throw new Error('no candidate');
    expect(analyzeRerender({ ...chosen, matchesRecordedLocator: false }, temporal, []).detected).toBe(false);
  });

  it('the runtime proof of a FILL: same value, or the same once formatted (case, spaces, masks)', () => {
    expect(sameFilledValue('alpha', 'alpha')).toBe(true);
    expect(sameFilledValue('(514) 555-1234', '5145551234')).toBe(true);
    expect(sameFilledValue('ALPHA ', 'alpha')).toBe(true);
    expect(sameFilledValue('', 'alpha')).toBe(false);
    expect(sameFilledValue('beta', 'alpha')).toBe(false);
  });

  it('TEST 9 / 16 the advisor request carries public candidate ids only, the functional context, and never a typed value', () => {
    const ranked = scoreCandidates(identity, temporal, [FILTER_VALUE]);
    const trace: TargetResolutionTrace = {
      action: 'Filter#4 FILL filter.value',
      recorded: { locator: 'css=#valueInput' },
      runtime: {
        locator: 'css=#valueInput',
        fingerprintVerdict: 'MISMATCH',
        reasons: ['"Value" instead of "Search term"'],
      },
      rerender: { detected: true, evidence: [] },
      identity,
      temporal,
      candidates: [],
      decision: 'AMBIGUOUS',
      reason: '',
      ai: { requested: true },
      status: 'TARGET_AMBIGUOUS',
    };
    const request = targetResolutionRequest(trace, ranked, (id) => `A${id.slice(1)}`, 'Filter');
    expect(request).toMatchObject({
      trigger: 'TARGET_FINGERPRINT_MISMATCH',
      expectedEffects: ['VALUE_CHANGED'],
      runtimeCandidates: [
        { id: 'A1', previousControl: 'combobox: Operator = Like', nextVisibleControl: 'button: Apply' },
      ],
    });
    expect(JSON.stringify(request)).not.toContain('alpha');
  });

  describe('Evidence model', () => {
    const mismatch = { score: 0.3, reasons: ['"Value" instead of "Search term"'] };

    it('a fingerprint mismatch is NEGATIVE evidence, never an exclusion: the recorded-locator target stays a candidate with contradictory evidence', () => {
      const [kept] = scoreCandidates(identity, temporal, [FILTER_VALUE], mismatch);
      expect(kept?.rejected).toBeUndefined();
      const kinds = (polarity: string): string[] =>
        (kept?.evidence ?? []).filter((entry) => entry.polarity === polarity).map((entry) => entry.kind);
      expect(kinds('POSITIVE')).toEqual(
        expect.arrayContaining([
          'RECORDED_LOCATOR_MATCH',
          'VISIBLE',
          'ENABLED',
          'EDITABLE',
          'SECTION_MATCH',
          'PREVIOUS_ACTION',
          'NEXT_ACTION',
        ]),
      );
      expect(kinds('NEGATIVE')).toEqual(expect.arrayContaining(['FINGERPRINT_MISMATCH']));
      expect(kept?.contradictions).toContain('E_T1_FINGERPRINT_MISMATCH');
      expect(kept?.components.locatorIdentity).toBe(0.15);
    });

    it('soft vs hard context: another section of the SAME dialog is a penalty (SECTION_PATH_CHANGED), another section outside the dialog is rejected', () => {
      const ranked = scoreCandidates(identity, temporal, [
        { ...FILTER_VALUE, id: 'T1', section: 'Requests > Advanced' },
        { ...FILTER_VALUE, id: 'T2', section: 'Archive', dialog: undefined, matchesRecordedLocator: false },
      ]);
      const soft = ranked.find((entry) => entry.id === 'T1');
      expect(soft?.rejected).toBeUndefined();
      expect(soft?.components.contextMismatchPenalty).toBe(-0.2);
      expect(soft?.evidence?.map((entry) => entry.kind)).toContain('SECTION_PATH_CHANGED');
      expect(ranked.find((entry) => entry.id === 'T2')?.rejected).toMatch(/context mismatch/);
    });

    it('TEST 18 (critical) deterministic discovery returns 0, the recorded locator still finds an element: CandidateSet >= 1, the advisor is triggered (never TARGET_NOT_FOUND)', () => {
      // Ce que recordedLocatorCandidate décrit par l'API Playwright : ni section ni fenêtre lues.
      const fromLocator = candidate({
        id: 'T1',
        name: 'Value',
        label: 'Value',
        matchesRecordedLocator: true,
        cssHint: '#valueInput',
      });
      const ranked = scoreCandidates(identity, temporal, [fromLocator], mismatch);
      expect(ranked.length).toBeGreaterThanOrEqual(1);
      expect(ranked[0]?.rejected).toBeUndefined();
      const decision = decide(ranked);
      expect(decision.status).not.toBe('RESOLVED');
      expect(aiTriggerOf(decision)).toBe('CONTRADICTORY_TARGET_EVIDENCE');
    });

    it('aiTriggerOf: never when resolved, never without a viable candidate; ambiguity, contradiction, functional mismatch otherwise', () => {
      expect(aiTriggerOf(decide(scoreCandidates(identity, temporal, [FILTER_VALUE])))).toBeUndefined();
      expect(
        aiTriggerOf(
          decide(scoreCandidates(identity, temporal, [FILTER_VALUE, { ...FILTER_VALUE, id: 'T2' }])),
        ),
      ).toBe('TARGET_AMBIGUOUS');
      expect(
        aiTriggerOf(decide(scoreCandidates(identity, temporal, [{ ...FILTER_VALUE, visible: false }]))),
      ).toBeUndefined();
      const weak = candidate({ id: 'T3', name: 'Notes', label: 'Notes' });
      expect(aiTriggerOf(decide(scoreCandidates(identity, temporal, [weak])))).toBe(
        'TARGET_FUNCTIONAL_MISMATCH',
      );
    });

    it('the advisor request: mission, failure, known facts, constraints, citable evidence ids and contradictions per candidate', () => {
      const ranked = scoreCandidates(identity, temporal, [FILTER_VALUE], mismatch);
      const trace: TargetResolutionTrace = {
        action: 'Filter#4 FILL filter.value',
        recorded: { locator: 'css=#valueInput' },
        runtime: { locator: 'css=#valueInput', fingerprintVerdict: 'MISMATCH', reasons: mismatch.reasons },
        rerender: { detected: false, evidence: [] },
        identity,
        temporal,
        candidates: [],
        decision: 'NONE',
        reason: 'no candidate fills the same function in this context',
        ai: { requested: true, trigger: 'CONTRADICTORY_TARGET_EVIDENCE' },
        status: 'TARGET_REQUIRES_REPLAY_VALIDATION',
      };
      const request = targetResolutionRequest(trace, ranked, (id) => `A${id.slice(1)}`, 'Filter');
      expect(request).toMatchObject({
        mission: { type: 'TARGET_RESOLUTION', context: 'REPLAY_RECORDED_HUMAN_JOURNEY' },
        resolutionFailure: { trigger: 'CONTRADICTORY_TARGET_EVIDENCE' },
        constraints: {
          mustChooseExistingCandidate: true,
          mustNotInventElement: true,
          mustNotExecuteAction: true,
        },
      });
      expect(request.knownFacts).toContain('The recorded locator resolves to a runtime element');
      const [sent] = request.runtimeCandidates as { evidence: string[]; contradictions: string[] }[];
      expect(sent?.evidence).toContain('E_T1_RECORDED_LOCATOR_MATCH');
      expect(sent?.contradictions.join(' ')).toMatch(/E_T1_FINGERPRINT_MISMATCH/);
      expect(JSON.stringify(request)).not.toContain('alpha');
    });

    it('[TARGET_CONTEXT]: previous ✓, current ?, next →', () => {
      const line = temporalLine(temporal);
      expect(line).toMatch(/previous ✓ SELECT Operator = Like/);
      expect(line).toMatch(/current \? FILL/);
      expect(line).toMatch(/next → CLICK Apply/);
    });

    it('the debug artifact is redacted in depth (no token, no Authorization header)', () => {
      const redacted = redactDeep({
        a: ['Authorization: Bearer abc.def.ghi'],
        b: { c: 'password=hunter22' },
      });
      expect(JSON.stringify(redacted)).not.toMatch(/abc\.def\.ghi|hunter22/);
    });
  });
});
