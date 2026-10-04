import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema, type FlowStep } from '../../src/config/flow-schema.js';
import { verifyFieldFill } from '../../src/flows/action-effect-verifier.js';
import {
  buildTemporalContext,
  decide,
  functionalIdentityOf,
  scoreCandidates,
  type FunctionalCandidate,
} from '../../src/flows/functional-target.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import {
  buildFieldIdentity,
  fieldIdentityKey,
  matchFieldIdentity,
} from '../../src/recording/field-identity.js';
import { validateFieldMerges } from '../../src/recording/field-merge-validator.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedValueFacts,
  RecordingSession,
} from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';
import { resolveRecordedTarget } from '../../src/recording/recorded-target.js';

/**
 * SAME CSS ≠ SAME FIELD. PRESERVE FIRST, MERGE ONLY WITH STRONG EVIDENCE.
 * Trois mat-form-field dont les input partagent le même CSS structurel, relatif au composant.
 */
const APP = 'http://app.test';
const GENERIC = 'mat-form-field > div:nth-of-type(1) > div:nth-of-type(2) > div > input';
const config = parseConfig(
  `mission: { name: fields }\ntarget: { baseUrl: "${APP}", startAt: / }\n`,
  {},
  {},
).config;

/** Un input Material sans libellé relié, sans name, sans id stable : seul le CSS générique le localise. */
const material = (extra: Partial<RecordedElement> = {}): RecordedElement => ({
  tag: 'input',
  role: 'textbox',
  name: '',
  css: GENERIC,
  cssStable: false,
  cssMatches: 3,
  inForm: true,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  sameRoleName: 0,
  roleNameIndex: 0,
  sameLabel: 0,
  inputType: 'text',
  componentTag: 'mat-form-field',
  ...extra,
});
const facts = (value: string): RecordedValueFacts => ({
  empty: value === '',
  length: value.length,
  shape: /^\d+$/.test(value) ? 'number' : 'text',
  digest: valueDigest(value, 'salt'),
});

/** Une trace brute avec des identifiants h001… comme dans un enregistrement réel. */
class Trace {
  events: RawRecordedEvent[] = [];
  typed = new Map<string, string>();
  private n = 0;
  private clock = 1000;
  constructor(start = 0) {
    this.n = start;
  }
  push(event: Omit<RawRecordedEvent, 'id' | 'sequence' | 'at' | 'url'>): string {
    this.n += 1;
    this.clock += 300;
    const id = `h${String(this.n).padStart(3, '0')}`;
    this.events.push({ id, sequence: this.n, at: this.clock, url: `${APP}/requests/new`, ...event });
    return id;
  }
  /** Une saisie (input debounce, ou change) dans un champ. */
  type(element: RecordedElement, value: string, type: 'input' | 'change' = 'change'): string {
    const id = this.push({
      type,
      element,
      value: facts(value),
      ...(element.domInstance ? { activeDomInstance: element.domInstance } : {}),
    });
    this.typed.set(id, value);
    return id;
  }
  /** Le clic qui donne le focus à un champ : un bruit (aucune action), mais une frontière. */
  focus(element: RecordedElement): string {
    return this.push({ type: 'click', element, noise: 'focus click in a field' });
  }
  session(): RecordingSession {
    return {
      id: 'rec-fields',
      name: 'Create request',
      startedAt: '2026-01-01T00:00:00.000Z',
      startUrl: `${APP}/requests/new`,
      status: 'PROCESSING',
      rawEvents: [
        { id: 'h000', sequence: 0, type: 'navigation', at: 900, url: `${APP}/requests/new` },
        ...this.events,
      ],
      semanticActions: [],
      checkpoints: [],
      states: [],
      warnings: [],
      droppedEvents: 0,
    };
  }
  run() {
    return processRecording(this.session(), config, { language: 'en', typedValues: this.typed });
  }
}

const flowOf = (yaml: string): FlowStep[] => {
  const raw = parseYaml(yaml) as Record<string, unknown>;
  delete raw.testData;
  return flowSchema.parse(raw).steps;
};
const fills = (steps: FlowStep[]) =>
  steps.flatMap((step) =>
    step.kind === 'fill' ? [{ value: step.value, fingerprint: step.fingerprint }] : [],
  );

const A = material({ domInstance: 'e42', formField: 'Employee number', maxLength: 5, inputMode: 'numeric' });
const B = material({ domInstance: 'e57', formField: 'Employee name' });
const C = material({ domInstance: 'e61', formField: 'Company name' });

describe('THE BUG reconstructed: h013 / h015 / h017 were merged into h019 (TYPING_MERGED by serialized locator)', () => {
  const trace = new Trace(12);
  trace.type(A, '12345', 'input'); // h013
  trace.focus(B); // h014 — focus click in a field (noise)
  trace.type(B, 'alpha', 'input'); // h015
  trace.focus(C); // h016
  trace.type(C, 'Example inc', 'input'); // h017
  trace.push({ type: 'keydown' }); // h018
  trace.type(C, 'Example inc'); // h019 — change of C when leaving it
  const result = trace.run();

  it('three human inputs stay three FILL actions; only the input + change of the SAME field (C) are merged', () => {
    const kept = result.normalized.kept.filter((action) => action.type === 'FILL');
    expect(kept.map((action) => action.rawEventIds)).toEqual([['h013'], ['h015'], ['h017', 'h019']]);
  });

  it('every merge decision is explained (h013+h015 rejected: instance, label, profile, generic CSS)', () => {
    const decisions = result.normalized.mergeDecisions;
    const first = decisions.find((decision) => decision.previousRawEventIds.includes('h013'));
    expect(first).toMatchObject({ decision: 'KEEP_SEPARATE', verdict: 'DIFFERENT_FIELD' });
    expect(first?.reasons.join(' | ')).toMatch(/FOCUS_CHANGED_TO_DIFFERENT_FIELD \(h014\)/);
    expect(first?.reasons.join(' | ')).toMatch(/different field label/);
    expect(first?.reasons.join(' | ')).toMatch(/incompatible value profile/);
    expect(first?.reasons.join(' | ')).toMatch(/different DOM instance/);
    expect(first?.reasons.join(' | ')).toMatch(/not unique \(generic\)/);
    const same = decisions.find((decision) => decision.currentRawEventIds.includes('h019'));
    expect(same).toMatchObject({ decision: 'MERGE', verdict: 'EXACT_SAME_FIELD' });
  });

  it('§18 action preservation: h013 and h015 are PRESERVED; h017 only joins h019, the change of the SAME field', () => {
    const account = (id: string) => result.journey.accounts.find((entry) => entry.rawEventIds.includes(id));
    expect(account('h013')?.status).toBe('PRESERVED');
    expect(account('h015')?.status).toBe('PRESERVED');
    // Seule la saisie de C (h017) rejoint le « change » de C (h019) : même instance DOM, une seule étape.
    expect(account('h017')).toMatchObject({ status: 'MERGED', rule: 'TYPING_MERGED' });
    expect(account('h019')?.status).toBe('PRESERVED');
    expect(account('h017')?.actionId).toBe(account('h019')?.actionId);
  });

  it('§14 / TEST 9 test data follows the field: three distinct keys from the field labels, never "value"', () => {
    const steps = fills(flowOf(result.files.yaml));
    expect(steps).toHaveLength(3);
    const keys = steps.map((step) => (step.value as { testData?: string }).testData);
    expect(keys).toEqual(['employeeNumber', 'employeeName', 'companyName']);
    expect(Object.keys(result.testData?.set.values ?? {})).not.toContain('value');
    // §20 la cible générée garde l'identité : le CSS est générique, l'empreinte nomme le champ.
    expect(steps.map((step) => step.fingerprint?.formField)).toEqual([
      'Employee number',
      'Employee name',
      'Company name',
    ]);
  });

  it('§24 the recording validator finds no invalid merge in the corrected recording', () => {
    expect(validateFieldMerges(result.normalized.actions, result.session.rawEvents)).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('INVALID_FIELD_MERGE');
  });
});

describe('FieldIdentityMatcher / TypingMergeDecision (TEST 1–8)', () => {
  it('TEST 1 the same input typed d, di, dio, diop: one FILL (MERGE, EXACT_SAME_FIELD)', () => {
    const trace = new Trace();
    for (const value of ['d', 'di', 'dio', 'diop']) trace.type(B, value, 'input');
    const result = trace.run();
    const kept = result.normalized.kept.filter((action) => action.type === 'FILL');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.rawEventIds).toEqual(['h001', 'h002', 'h003', 'h004']);
    expect(result.normalized.mergeDecisions.every((decision) => decision.decision === 'MERGE')).toBe(true);
  });

  it('TEST 2 two inputs with the same generic CSS, 12345 then text: KEEP_SEPARATE', () => {
    const trace = new Trace();
    trace.type(material({ domInstance: 'e1' }), '12345');
    trace.type(material({ domInstance: 'e2' }), 'alpha');
    const result = trace.run();
    expect(result.normalized.kept.filter((action) => action.type === 'FILL')).toHaveLength(2);
    expect(result.normalized.mergeDecisions[0]?.decision).toBe('KEEP_SEPARATE');
  });

  const identity = (element: RecordedElement, value?: string) =>
    buildFieldIdentity(element, value === undefined ? undefined : facts(value));

  it('TEST 3 two #valueInput in different dialogs: DIFFERENT_FIELD', () => {
    const value = (dialog: string) =>
      identity(
        material({
          css: '#valueInput',
          cssStable: true,
          cssMatches: 2,
          elementId: 'valueInput',
          sameId: 2,
          inDialog: true,
          dialogName: dialog,
        }),
      );
    const match = matchFieldIdentity(value('Filter'), value('Export'));
    expect(match.verdict).toBe('DIFFERENT_FIELD');
    expect(match.confidence.reasons.join(' ')).toMatch(/different dialog/);
    // Un id dupliqué n'est jamais une clé de champ : sans autre preuve, aucune clé (jamais partagée).
    expect(fieldIdentityKey(value('Filter'))).toBeUndefined();
    expect(fieldIdentityKey(identity(material({ elementId: 'valueInput', formField: 'Value' })))).toBe(
      'id::valueInput',
    );
  });

  it('TEST 4 same CSS, different mat-label: DIFFERENT_FIELD', () => {
    expect(
      matchFieldIdentity(
        identity(material({ formField: 'City' })),
        identity(material({ formField: 'Country' })),
      ).verdict,
    ).toBe('DIFFERENT_FIELD');
  });

  it('TEST 5 the same field re-rendered (new DOM node, same formControlName + label + context): STRONG_SAME_FIELD', () => {
    const before = material({
      domInstance: 'e3',
      formControlName: 'city',
      formField: 'City',
      sectionPath: ['Address'],
    });
    const after = { ...before, domInstance: 'e9' };
    const match = matchFieldIdentity(identity(before), identity(after));
    expect(match.verdict).toBe('STRONG_SAME_FIELD');
    expect(match.confidence.score).toBeGreaterThan(0.8);
    expect(match.confidence.reasons.join(' ')).toMatch(/re-rendered/);
  });

  it('TEST 6 no label, no id, only the same CSS (old recording, no DOM instance): AMBIGUOUS_KEEP_SEPARATE', () => {
    const trace = new Trace();
    trace.type(material(), 'one');
    trace.type(material(), 'two');
    const result = trace.run();
    expect(result.normalized.mergeDecisions[0]).toMatchObject({
      decision: 'AMBIGUOUS_KEEP_SEPARATE',
      verdict: 'AMBIGUOUS_FIELD',
    });
    expect(result.normalized.kept.filter((action) => action.type === 'FILL')).toHaveLength(2);
  });

  it('TEST 7 different recorder element ids, the same CSS: KEEP_SEPARATE (no functional identifier proves a re-render)', () => {
    const match = matchFieldIdentity(
      identity(material({ domInstance: 'e42' })),
      identity(material({ domInstance: 'e57' })),
    );
    expect(match.verdict).toBe('DIFFERENT_FIELD');
    expect(match.confidence.score).toBeLessThan(0.4);
    expect(match.confidence.reasons).toEqual(
      expect.arrayContaining(['different DOM instance', 'same generic CSS only']),
    );
  });

  it('TEST 8 numeric maxlength=5 versus free text: DIFFERENT_FIELD (value profile)', () => {
    const match = matchFieldIdentity(
      identity(material({ maxLength: 5, inputMode: 'numeric' }), '12345'),
      identity(material(), 'alpha'),
    );
    expect(match.verdict).toBe('DIFFERENT_FIELD');
    expect(match.confidence.reasons.join(' ')).toMatch(/incompatible value profile/);
  });

  it('a value profile alone never separates the SAME node (a typing in progress changes its shape)', () => {
    const node = material({ domInstance: 'e5' });
    expect(matchFieldIdentity(identity(node, '12'), identity(node, '12ab')).verdict).toBe('EXACT_SAME_FIELD');
  });
});

describe('TestData, generated locator, validator (TEST 9, 10, §24, §27)', () => {
  it('TEST 9 three unnamed fields: three distinct field_<fingerprint> keys, never one shared "value"', () => {
    const trace = new Trace();
    trace.type(material({ domInstance: 'e1' }), 'one');
    trace.type(material({ domInstance: 'e2' }), 'two');
    trace.type(material({ domInstance: 'e3' }), 'three');
    const result = trace.run();
    const keys = fills(flowOf(result.files.yaml)).map(
      (step) => (step.value as { testData?: string }).testData,
    );
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^field_[a-z0-9]+$/);
    expect(result.testData?.events.map((event) => event.type)).toContain('TESTDATA_FIELD_CONFLICT');
  });

  it('TEST 10 a generated CSS that matches several elements is never declared unique; the fingerprint names the field', () => {
    const target = resolveRecordedTarget(material({ formField: 'Employee name' }), 'field');
    expect(target.ambiguous).toBe(false);
    expect(target.reasons.join(' ')).toMatch(
      /GENERIC_LOCATOR_DETECTED: generic selector \(matches 3 elements\)/,
    );
    expect(target.fingerprint?.formField).toBe('Employee name');
    // Rien ne distingue le champ : une ambiguïté déclarée (jamais un « unique » inventé).
    expect(resolveRecordedTarget(material(), 'field').ambiguous).toBe(true);
  });

  it('§24 INVALID_FIELD_MERGE: an OLD normalized action that carries the inputs of three fields', () => {
    const trace = new Trace(12);
    const ids = [trace.type(A, '12345'), trace.type(B, 'alpha'), trace.type(C, 'Example inc')];
    const merged = {
      id: 'a1',
      type: 'FILL' as const,
      rawEventIds: ids,
      at: 0,
      url: APP,
      network: [],
      provenance: 'NORMALIZED_FROM_HUMAN' as const,
      confidence: 0.9,
      evidence: [],
    };
    const issues = validateFieldMerges([merged], trace.events);
    expect(issues[0]).toMatchObject({ type: 'INVALID_FIELD_MERGE', rawEventIds: ['h013', 'h014', 'h015'] });
    expect(issues[0]?.reasons.join(' ')).toMatch(/different DOM instance/);
  });

  it('§27 an old recording (no DOM instance): generic locator + several values → POSSIBLY_INVALID_FIELD_MERGE', () => {
    const trace = new Trace();
    const ids = [trace.type(material(), 'one'), trace.type(material(), 'two')];
    const merged = {
      id: 'a1',
      type: 'FILL' as const,
      rawEventIds: ids,
      at: 0,
      url: APP,
      network: [],
      provenance: 'NORMALIZED_FROM_HUMAN' as const,
      confidence: 0.9,
      evidence: [],
      value: { class: 'GENERATED_TEST_DATA' as const, testData: 'value', sensitive: false, reason: '' },
    };
    expect(validateFieldMerges([merged], trace.events)[0]?.type).toBe('POSSIBLY_INVALID_FIELD_MERGE');
  });
});

describe('Replay: target identity before value (TEST 11–13)', () => {
  const candidate = (id: string): FunctionalCandidate => ({
    id,
    tag: 'input',
    role: 'textbox',
    name: '',
    visible: true,
    enabled: true,
    editable: true,
    matchesRecordedLocator: true,
    nearText: [],
    stableAttributes: {},
    cssHint: GENERIC,
  });

  it('TEST 11 two candidates that nothing distinguishes: AMBIGUOUS, never the first one silently', () => {
    const steps =
      parseConfig(
        `mission: { name: unit }
target: { baseUrl: "${APP}" }
flows:
  - name: Fields
    steps:
      - fill: { css: "${GENERIC}", value: alpha }
        fingerprint: { role: textbox, tag: input, component: mat-form-field }
`,
        {},
        {},
      ).config.flows[0]?.steps ?? [];
    const step = steps[0] as Extract<FlowStep, { target: unknown }>;
    const ranked = scoreCandidates(functionalIdentityOf(step, steps, 0), buildTemporalContext(steps, 0, []), [
      candidate('T1'),
      candidate('T2'),
    ]);
    const decision = decide(ranked);
    expect(decision.status).not.toBe('RESOLVED');
    expect(decision.chosen).toBeUndefined();
  });

  const expected = { role: 'textbox', tag: 'input', formField: 'Employee number', inputType: 'text' };

  it('TEST 12 the right field, the wrong value: FIELD_VALUE_MISMATCH (not a target problem)', () => {
    expect(
      verifyFieldFill({
        expected,
        observed: { tag: 'input', role: 'textbox', name: 'Employee number', inputType: 'text' },
        valueHeld: false,
      }).verdict,
    ).toBe('FIELD_VALUE_MISMATCH');
  });

  it('TEST 13 the wrong field, even if its value changed: FIELD_TARGET_MISMATCH', () => {
    const verdict = verifyFieldFill({
      expected,
      observed: { tag: 'input', role: 'textbox', name: 'Employee name', inputType: 'text' },
      valueHeld: true,
    });
    expect(verdict.verdict).toBe('FIELD_TARGET_MISMATCH');
    expect(verdict.reasons[0]).toMatch(/"Employee name", not "Employee number"/);
    expect(
      verifyFieldFill({
        expected,
        observed: { tag: 'input', role: 'textbox', name: 'Employee number', inputType: 'text' },
        valueHeld: true,
      }).verdict,
    ).toBe('CONFIRMED');
  });
});
