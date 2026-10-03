import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import {
  analyzeRerender,
  buildTemporalContext,
  decide,
  functionalIdentityOf,
  sameFilledValue,
  scoreCandidates,
  targetResolutionRequest,
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
      futureWorkflowCompatibility: 0.1,
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
});
