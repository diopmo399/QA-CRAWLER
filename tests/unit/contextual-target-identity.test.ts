import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { matchFingerprint } from '../../src/flows/action-effect-verifier.js';
import {
  buildTemporalContext,
  decide,
  functionalIdentityOf,
  resolutionOutcomeOf,
  scoreCandidates,
  TARGET_SCORE_WEIGHTS,
  type FunctionalCandidate,
} from '../../src/flows/functional-target.js';
import { resolveRecordedTarget } from '../../src/recording/recorded-target.js';
import type { RecordedElement } from '../../src/recording/model.js';

/**
 * LOCATOR ≠ TARGET IDENTITY : un localisateur trouve des CANDIDATS ; l'empreinte contextualisée
 * (libellé, champ, fenêtre, parcours) identifie la cible ; une ambiguïté n'est jamais tranchée au hasard.
 */
const flow = (fingerprint: string, target = 'css: "#valueInput"'): FlowStep[] =>
  parseConfig(
    `mission: { name: unit }
target: { baseUrl: "http://app.test" }
flows:
  - name: Filter
    steps:
      - click: { role: button, name: Filter }
      - select: { label: Field, option: Company name }
      - select: { label: Operator, option: Like }
      - fill: { ${target}, value: alpha }
        fingerprint: ${fingerprint}
      - click: { role: button, name: Apply }
`,
    {},
    {},
  ).config.flows[0]?.steps ?? [];

const ENRICHED =
  '{ role: textbox, tag: input, name: Company name, id: valueInput, dialog: Filter, formField: Company name, section: "Requests > Filter", nearbyText: [Apply] }';

const candidate = (overrides: Partial<FunctionalCandidate> & { id: string }): FunctionalCandidate => ({
  tag: 'input',
  role: 'textbox',
  name: '',
  visible: true,
  enabled: true,
  editable: true,
  matchesRecordedLocator: true,
  nearText: [],
  stableAttributes: { id: 'valueInput' },
  cssHint: '#valueInput',
  ...overrides,
});
/** Les quatre #valueInput du cas réel (libellés neutres). */
const DATE = candidate({ id: 'T1', name: 'Date', label: 'Date', section: 'Requests > Search panel' });
const RIGHT = candidate({
  id: 'T2',
  name: 'Company name',
  label: 'Company name',
  section: 'Requests > Filter',
  dialog: 'Filter',
  previousControl: 'textbox: Like',
  nextControl: 'button: Apply',
});
const LIKE = candidate({
  id: 'T3',
  name: 'Like',
  label: 'Like',
  section: 'Requests > Filter',
  dialog: 'Filter',
  previousControl: 'combobox: Operator = Like',
  nextControl: 'button: Apply',
});
const HIDDEN = candidate({ id: 'T4', visible: false });

const resolve = (fingerprint: string, candidates: FunctionalCandidate[], target?: string) => {
  const steps = flow(fingerprint, target);
  const step = steps[3] as Extract<FlowStep, { target: unknown }>;
  const temporal = buildTemporalContext(steps, 3, [
    { status: 'PASSED' },
    { status: 'PASSED' },
    { status: 'PASSED' },
  ]);
  const ranked = scoreCandidates(functionalIdentityOf(step, steps, 3), temporal, candidates);
  return { ranked, decision: decide(ranked) };
};

describe('Contextual target identity (pure)', () => {
  it('TEST 1 a single #valueInput: normal resolution (one candidate, clearly the right one)', () => {
    const { decision } = resolve(ENRICHED, [RIGHT]);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T2');
  });

  it('TEST 2 / 3 / §7 four #valueInput, one labelled "Company name" in the Filter dialog: selected, the others explained', () => {
    const { ranked, decision } = resolve(ENRICHED, [DATE, RIGHT, LIKE, HIDDEN]);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T2');
    expect(decision.chosen?.evidence?.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'LABEL_MATCH',
        'DIALOG_MATCH',
        'SECTION_MATCH',
        'FORM_FIELD_MATCH',
        'WORKFLOW_CONTEXT_MATCH',
      ]),
    );
    expect(ranked.find((entry) => entry.id === 'T4')?.rejected).toBe('hidden');
    expect(ranked.find((entry) => entry.id === 'T1')?.rejected).toMatch(/context mismatch/);
    const like = ranked.find((entry) => entry.id === 'T3');
    expect(like?.evidence?.map((entry) => entry.kind)).toContain('LABEL_CHANGED');
    expect(like?.score ?? 1).toBeLessThan(decision.chosen?.score ?? 0);
  });

  it('TEST 4 two candidates 0.96 / 0.55: the first is confirmed (score AND gap)', () => {
    const ranked = [
      { ...RIGHT, score: 0.96, components: {} },
      { ...LIKE, score: 0.55, components: {} },
    ];
    const decision = decide(ranked, 0.6, 0.15);
    expect(decision.status).toBe('RESOLVED');
    expect(
      resolutionOutcomeOf(
        { status: 'TARGET_CONTEXTUAL_MATCH', decision: decision.status },
        ranked,
        decision.chosen,
        'LOCATOR_NON_UNIQUE',
      ),
    ).toMatchObject({
      outcome: 'CONTEXTUAL_MATCH',
      confidence: 0.96,
      ambiguity: { bestScore: 0.96, secondBestScore: 0.55, scoreGap: 0.41 },
    });
  });

  it('TEST 5 two candidates 0.91 / 0.89: TARGET_AMBIGUOUS — a high score is not enough while the ambiguity is strong', () => {
    const ranked = [
      { ...RIGHT, score: 0.91, components: {} },
      { ...LIKE, score: 0.89, components: {} },
    ];
    const decision = decide(ranked, 0.6, 0.15);
    expect(decision.status).toBe('AMBIGUOUS');
    expect(decision.chosen).toBeUndefined();
    expect(
      resolutionOutcomeOf(
        { status: 'TARGET_AMBIGUOUS', decision: decision.status },
        ranked,
        undefined,
        'LOCATOR_NON_UNIQUE',
      ).outcome,
    ).toBe('AMBIGUOUS');
  });

  it('TEST 6 the element with the recorded id is hidden, another is visible: never selected blindly by its id', () => {
    const { ranked, decision } = resolve(ENRICHED, [
      HIDDEN,
      { ...RIGHT, stableAttributes: {}, cssHint: undefined, matchesRecordedLocator: false },
    ]);
    expect(ranked.find((entry) => entry.id === 'T4')?.rejected).toBe('hidden');
    expect(decision.chosen?.id).toBe('T2');
  });

  it('TEST 7 the old #valueInput is gone, role + label + dialog match another element: HEALED', () => {
    const healed = {
      ...RIGHT,
      matchesRecordedLocator: false,
      stableAttributes: { 'data-testid': 'filter-value' },
    };
    const { ranked, decision } = resolve(ENRICHED, [healed]);
    expect(decision.status).toBe('RESOLVED');
    expect(
      resolutionOutcomeOf(
        { status: 'TARGET_HEALED', decision: decision.status },
        ranked,
        decision.chosen,
        'LOCATOR_NOT_FOUND',
      ).outcome,
    ).toBe('HEALED');
  });

  it('TEST 8 the recorded locator finds an element, but the fingerprint designates another: the historical locator is not favoured', () => {
    const designated = { ...LIKE, matchesRecordedLocator: true };
    const other = { ...RIGHT, matchesRecordedLocator: false, stableAttributes: {}, cssHint: undefined };
    const { decision } = resolve(ENRICHED, [designated, other]);
    expect(decision.chosen?.id).toBe('T2');
  });

  it('TEST 9 the same label in two dialogs: the recorded dialog decides', () => {
    const elsewhere = {
      ...RIGHT,
      id: 'T5',
      dialog: 'Advanced search',
      section: 'Requests > Advanced search',
    };
    const { ranked, decision } = resolve(ENRICHED, [elsewhere, RIGHT]);
    expect(decision.chosen?.id).toBe('T2');
    expect(ranked.find((entry) => entry.id === 'T5')?.rejected).toMatch(/context mismatch/);
  });

  it('TEST 10 same label, same dialog: the workflow context (right after "Operator = Like") decides', () => {
    const afterLike = {
      ...RIGHT,
      id: 'T6',
      previousControl: 'combobox: Operator = Like',
      nextControl: undefined,
    };
    const afterEquals = {
      ...RIGHT,
      id: 'T7',
      previousControl: 'combobox: Operator = Equals',
      nextControl: undefined,
    };
    const { decision } = resolve(ENRICHED, [afterEquals, afterLike]);
    expect(decision.status).toBe('RESOLVED');
    expect(decision.chosen?.id).toBe('T6');
    expect(decision.chosen?.evidence?.map((entry) => entry.kind)).toContain('PREVIOUS_ACTION');
  });

  it('TEST 11 a structural nth-of-type locator matches, but the semantics are wrong: rejected (a positional path is a weak proof)', () => {
    const fragile = 'css: "div:nth-of-type(3) > input:nth-of-type(1)"';
    const wrong = { ...LIKE, matchesRecordedLocator: true };
    const right = { ...RIGHT, matchesRecordedLocator: false };
    const { ranked, decision } = resolve(ENRICHED, [wrong, right], fragile);
    expect(decision.chosen?.id).toBe('T2');
    expect(ranked.find((entry) => entry.id === 'T3')?.components.locatorIdentity).toBe(
      TARGET_SCORE_WEIGHTS.fragileLocatorIdentity,
    );
  });

  it('the weights are centralized and ordered: testId > label > locator; a positional locator is almost nothing', () => {
    expect(TARGET_SCORE_WEIGHTS.testIdMatch).toBeGreaterThan(TARGET_SCORE_WEIGHTS.labelExact);
    expect(TARGET_SCORE_WEIGHTS.labelExact).toBeGreaterThan(TARGET_SCORE_WEIGHTS.locatorIdentity);
    expect(TARGET_SCORE_WEIGHTS.fragileLocatorIdentity).toBeLessThan(TARGET_SCORE_WEIGHTS.nearbyText);
  });
});

describe('Target fingerprint matcher: components, evidence, HARD vs SOFT', () => {
  const recorded = {
    role: 'textbox',
    name: 'Company name',
    tag: 'input',
    id: 'valueInput',
    dialog: 'Filter',
  };

  it('§14 explains every component (identity, context, semantic, structural) with matched / mismatched evidence', () => {
    const match = matchFingerprint(recorded, {
      tag: 'input',
      role: 'textbox',
      name: 'Company name',
      id: 'valueInput',
      dialog: 'Filter',
    });
    expect(match.severity).toBe('NONE');
    expect(match.components?.identity).toBeGreaterThan(0);
    expect(match.components?.context).toBeGreaterThan(0);
    expect(match.matchedEvidence).toEqual(
      expect.arrayContaining(['ACCESSIBLE_NAME', 'ROLE', 'DIALOG', 'ID', 'TAG']),
    );
  });

  it('§15 the dialog was renamed: SOFT mismatch (the target is not invalidated)', () => {
    const match = matchFingerprint(recorded, {
      tag: 'input',
      role: 'textbox',
      name: 'Company name',
      id: 'valueInput',
      dialog: 'Advanced filters',
    });
    expect(match.severity).toBe('SOFT');
    expect(match.verdict).not.toBe('MISMATCH');
    expect(match.mismatchedEvidence).toContain('DIALOG');
  });

  it('§15 another label ("Birth date" instead of "Company name"): HARD mismatch', () => {
    const match = matchFingerprint(recorded, {
      tag: 'input',
      role: 'textbox',
      name: 'Birth date',
      id: 'valueInput',
      dialog: 'Filter',
    });
    expect(match.severity).toBe('HARD');
    expect(match.verdict).toBe('MISMATCH');
    expect(match.mismatchedEvidence).toContain('ACCESSIBLE_NAME');
  });
});

describe('Recording: the identity is captured, a shared id is never "unique"', () => {
  const element = (overrides: Partial<RecordedElement> = {}): RecordedElement => ({
    tag: 'input',
    role: 'textbox',
    name: '',
    css: '#valueInput',
    cssStable: true,
    inForm: false,
    isSubmit: false,
    inNavigation: false,
    inDialog: true,
    dialogName: 'Filter',
    sameRoleName: 0,
    sameLabel: 0,
    roleNameIndex: 0,
    elementId: 'valueInput',
    generatedId: false,
    inputType: 'text',
    formField: 'Company name',
    nearbyText: ['Field', 'Operator', 'Apply'],
    sectionPath: ['Requests', 'Filter'],
    ...overrides,
  });

  it('§2 the fingerprint keeps the id, the dialog, the form field and the nearby text (never a value)', () => {
    const { fingerprint } = resolveRecordedTarget(element(), 'field');
    expect(fingerprint).toMatchObject({
      id: 'valueInput',
      inputType: 'text',
      dialog: 'Filter',
      formField: 'Company name',
      nearbyText: ['Field', 'Operator', 'Apply'],
    });
  });

  it('UNIQUE CSS SELECTOR ≠ STABLE TARGET: "#valueInput" shared by 4 elements is not retained as a unique locator', () => {
    const shared = resolveRecordedTarget(element({ sameId: 4 }), 'field');
    expect(shared.reasons.join(' ')).toMatch(/shared by 4 elements/);
    const alone = resolveRecordedTarget(element(), 'field');
    expect(alone.target).toEqual({ strategy: 'css', value: '#valueInput' });
  });

  it('§3 an old fingerprint (no contextual fields) still parses and scores as before', () => {
    const { decision } = resolve(
      '{ role: textbox, tag: input, name: Company name, section: "Requests > Filter" }',
      [DATE, RIGHT, LIKE, HIDDEN],
    );
    expect(decision.chosen?.id).toBe('T2');
  });
});
