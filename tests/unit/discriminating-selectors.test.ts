import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema, type FlowStep } from '../../src/config/flow-schema.js';
import {
  classifyValueLoss,
  healingCandidates,
  matchFingerprint,
} from '../../src/flows/action-effect-verifier.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { detectDuplicateTargetActions } from '../../src/recording/duplicate-target.js';
import { buildFieldIdentity, matchFieldIdentity } from '../../src/recording/field-identity.js';
import { sanitizeInventory } from '../../src/recording/human-flow-recorder.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedSelectors,
  RecordedValueFacts,
  RecordingSession,
  ScreenInventory,
  SemanticRecordedAction,
} from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';
import { resolveRecordedTarget } from '../../src/recording/recorded-target.js';
import { screenInventorySummary, screenInventoryText } from '../../src/recording/screen-inventory.js';
import {
  ambiguityOf,
  candidateConfidence,
  isDynamicValue,
  rankCandidates,
} from '../../src/recording/selector-builder.js';

/**
 * DISCRIMINATING SELECTORS — la partie pure : PRESERVE CSS, ENRICH CSS, VERIFY UNIQUENESS. Les
 * mêmes quatre champs que l'application de test : la même structure Material, l'identité sur l'hôte.
 */
const APP = 'http://app.test';
const GENERIC = 'mat-form-field > div > div > div > input';
const config = parseConfig(
  `mission: { name: css }\ntarget: { baseUrl: "${APP}", startAt: / }\n`,
  {},
  {},
).config;

const selectors = (host: string, control: string, structuralMatches = 4): RecordedSelectors => ({
  preferred: {
    selector: `${host}[formcontrolname="${control}"] input`,
    kind: 'HOST_BINDING',
    matchCount: 1,
    confidence: 0.95,
  },
  structural: { selector: GENERIC, kind: 'STRUCTURAL', matchCount: structuralMatches, confidence: 0.1 },
  candidates: [],
  ambiguity: { level: 'LOW', reasons: ['GENERIC_CSS', 'DYNAMIC_ID'], structuralMatches },
  inventory: 'INVENTORY',
});

/** Un input dans un composant maison : le CSS capturé est le CSS discriminant de l'hôte. */
const hosted = (host: string, control: string, extra: Partial<RecordedElement> = {}): RecordedElement => ({
  tag: 'input',
  role: 'textbox',
  name: '',
  css: `${host}[formcontrolname="${control}"] input`,
  cssStable: true,
  inForm: true,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  sameRoleName: 0,
  roleNameIndex: 0,
  sameLabel: 0,
  inputType: 'text',
  elementId: 'mat-input-0',
  generatedId: true,
  formControlName: control,
  formControlFromHost: true,
  hostIdentity: { tag: host, attribute: 'formcontrolname', value: control, depth: 4 },
  selectors: selectors(host, control),
  ...extra,
});

describe('DynamicAttributeDetector / scoring (§5 – §7)', () => {
  it('TEST 5 generated ids and classes are dynamic; business bindings are stable', () => {
    for (const value of [
      'mat-input-0',
      'mat-input-17',
      'cdk-overlay-3',
      ':r1:',
      '0b5e8c2a-1f2e-4c5d-9a8b-000000000000',
    ])
      expect(isDynamicValue('id', value), value).toBe(true);
    expect(isDynamicValue('class', 'css-1x2y3z')).toBe(true);
    expect(isDynamicValue('class', '_ngcontent-abc-c12')).toBe(true);
    for (const value of ['branchNumber', 'contactFirstName', 'legalName', 'customer-name'])
      expect(isDynamicValue('attribute', value), value).toBe(false);
    // Un hachage mêle chiffres et lettres ; un long nom métier n'en est pas un.
    expect(isDynamicValue('attribute', 'a1b2c3d4e5f6a7b8c9')).toBe(true);
    expect(isDynamicValue('attribute', 'contactFirstNameValue')).toBe(false);
  });

  it('TEST 9 / 10 UNIQUE ≠ GOOD: a unique nth-of-type chain scores far below a unique stable semantic selector', () => {
    const semantic = candidateConfidence({
      matchCount: 1,
      unique: true,
      stabilityScore: 0.94,
      semanticScore: 0.98,
      specificityScore: 0.88,
      usesDynamicAttribute: false,
      usesStructuralIndex: false,
    });
    const fragile = candidateConfidence({
      matchCount: 1,
      unique: true,
      stabilityScore: 0.3,
      semanticScore: 0.2,
      specificityScore: 0.4,
      usesDynamicAttribute: false,
      usesStructuralIndex: true,
    });
    expect(semantic).toBeGreaterThan(0.9);
    expect(fragile).toBeLessThan(0.3);
    const dynamic = candidateConfidence({
      matchCount: 1,
      unique: true,
      stabilityScore: 0.9,
      semanticScore: 0.8,
      specificityScore: 1,
      usesDynamicAttribute: true,
      usesStructuralIndex: false,
    });
    expect(dynamic).toBeLessThan(semantic / 2 + 0.05);
  });

  it('TEST 7 a generic selector matching 6 elements is never trusted, whatever its stability; unique candidates rank first', () => {
    const generic = {
      unique: false,
      confidence: candidateConfidence({
        matchCount: 6,
        unique: false,
        stabilityScore: 0.6,
        semanticScore: 0.5,
        specificityScore: 0.9,
        usesDynamicAttribute: false,
        usesStructuralIndex: false,
      }),
    };
    const unique = { unique: true, confidence: 0.3 };
    expect(generic.confidence).toBeLessThan(0.25);
    expect(rankCandidates([generic, unique])[0]).toBe(unique);
  });

  it('§19 ambiguity levels: NONE / LOW (generic fallback) / MEDIUM (only structural) / HIGH (nothing unique)', () => {
    const strong = { usesStructuralIndex: false, usesDynamicAttribute: false };
    expect(ambiguityOf({ preferred: strong, structuralMatches: 1, dynamicId: false }).level).toBe('NONE');
    expect(ambiguityOf({ preferred: strong, structuralMatches: 6, dynamicId: true })).toEqual({
      level: 'LOW',
      reasons: ['GENERIC_CSS', 'DYNAMIC_ID'],
      structuralMatches: 6,
    });
    expect(
      ambiguityOf({
        preferred: { usesStructuralIndex: true, usesDynamicAttribute: false },
        structuralMatches: 1,
        dynamicId: false,
      }).level,
    ).toBe('MEDIUM');
    expect(ambiguityOf({ preferred: undefined, structuralMatches: 6, dynamicId: false }).level).toBe('HIGH');
  });
});

describe('Recorded target: preferred CSS + structural fallback (§8, §11)', () => {
  it('TEST 2 / 3 / 11 an input whose formControlName is on its custom host: the host CSS is chosen (FRAMEWORK_BINDING), the structural CSS is kept as fallback', () => {
    const target = resolveRecordedTarget(hosted('app-input-mask', 'branchNumber', { maxLength: 5 }), 'field');
    expect(target.target).toEqual({
      strategy: 'css',
      value: 'app-input-mask[formcontrolname="branchNumber"] input',
    });
    expect(target.quality).toBe('FRAMEWORK_BINDING');
    expect(target.ambiguous).toBe(false);
    // Jamais « [formcontrolname=x] » seul : il viserait l'hôte, pas l'input.
    expect(JSON.stringify(target.alternatives)).not.toContain('"[formcontrolname=');
    expect(target.fingerprint).toMatchObject({
      formControl: 'branchNumber',
      host: 'app-input-mask[formcontrolname="branchNumber"]',
      maxLength: 5,
      css: {
        preferred: { selector: 'app-input-mask[formcontrolname="branchNumber"] input', matchCount: 1 },
        fallback: { selector: GENERIC, matchCount: 4 },
      },
      ambiguity: { level: 'LOW', reasons: ['GENERIC_CSS', 'DYNAMIC_ID'] },
    });
  });

  it('TEST 12 two different fields sharing the same fallback CSS stay two identities', () => {
    const a = hosted('app-input', 'legalName', { formField: 'Legal name', label: 'Legal name' });
    const b = hosted('app-input', 'contactLastName', {
      formField: 'Contact last name',
      label: 'Contact last name',
    });
    expect(resolveRecordedTarget(a, 'field').fingerprint?.css?.fallback?.selector).toBe(
      resolveRecordedTarget(b, 'field').fingerprint?.css?.fallback?.selector,
    );
    expect(matchFieldIdentity(buildFieldIdentity(a), buildFieldIdentity(b)).verdict).toBe('DIFFERENT_FIELD');
    expect(buildFieldIdentity(a).componentIdentity).toBe('app-input[formcontrolname="legalName"]');
  });

  it('§19 a repeated label adds REPEATED_LABEL to the recorded ambiguity', () => {
    const target = resolveRecordedTarget(
      hosted('app-input', 'contactLastName', { label: 'Name', sameLabel: 2 }),
      'field',
    );
    expect(target.fingerprint?.ambiguity?.reasons).toContain('REPEATED_LABEL');
  });

  it('§31 backward compatibility: an old fingerprint without css still parses; a new one with css round-trips through the schema', () => {
    const steps = flowSchema.parse({
      name: 'compat',
      steps: [
        { fill: { css: GENERIC, value: 'x' } },
        {
          fill: { label: 'Legal name', value: 'x' },
          fingerprint: {
            label: 'Legal name',
            css: { preferred: { selector: 'app-input[formcontrolname="legalName"] input', matchCount: 1 } },
            host: 'app-input[formcontrolname="legalName"]',
            maxLength: 80,
            ambiguity: { level: 'LOW', reasons: ['GENERIC_CSS'] },
          },
        },
      ],
    }).steps;
    expect(steps[0]?.fingerprint).toBeUndefined();
    expect(steps[1]?.fingerprint?.css?.preferred?.matchCount).toBe(1);
  });
});

/** Une trace : des saisies frappe par frappe, comme l'enregistreur les envoie. */
class Trace {
  events: RawRecordedEvent[] = [];
  typed = new Map<string, string>();
  private n = 0;
  private clock = 1000;
  push(event: Omit<RawRecordedEvent, 'id' | 'sequence' | 'at' | 'url'>, gap = 300): string {
    this.n += 1;
    this.clock += gap;
    const id = `h${String(this.n).padStart(3, '0')}`;
    this.events.push({ id, sequence: this.n, at: this.clock, url: `${APP}/requests/new`, ...event });
    return id;
  }
  type(element: RecordedElement, value: string, gap = 300): string {
    const facts: RecordedValueFacts = {
      empty: value === '',
      length: value.length,
      shape: /^\d+$/.test(value) ? 'number' : 'text',
      digest: valueDigest(value, 'salt'),
    };
    const id = this.push(
      {
        type: 'input',
        element,
        value: facts,
        ...(element.domInstance ? { activeDomInstance: element.domInstance } : {}),
      },
      gap,
    );
    this.typed.set(id, value);
    return id;
  }
  run() {
    const session: RecordingSession = {
      id: 'rec-css',
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
    const events: { type: string; message: string }[] = [];
    const result = processRecording(session, config, {
      language: 'en',
      typedValues: this.typed,
      onEvent: (event) => events.push(event),
    });
    return { result, events };
  }
}

const fillSteps = (yaml: string): FlowStep[] => {
  const raw = parseYaml(yaml) as Record<string, unknown>;
  delete raw.testData;
  return flowSchema.parse(raw).steps.filter((step) => step.kind === 'fill');
};

describe('Typing merge with host identity (§12)', () => {
  // Même structure Material, même CSS de repli, mêmes ids générés ; seule l'identité de l'hôte diffère.
  const branch = hosted('app-input-mask', 'branchNumber', {
    domInstance: 'e1',
    formField: 'Branch number',
    maxLength: 5,
    inputMode: 'numeric',
  });
  const legal = hosted('app-input', 'legalName', { domInstance: 'e2', formField: 'Legal name' });

  it('TEST 14 key events of the SAME field (9, 99, 999, 9999, 99999) are consolidated into one fill', () => {
    const trace = new Trace();
    for (const value of ['9', '99', '999', '9999', '99999']) trace.type(branch, value, 60);
    const { result } = trace.run();
    expect(result.normalized.kept.filter((action) => action.type === 'FILL')).toHaveLength(1);
    const [step] = fillSteps(result.files.yaml);
    expect(step?.fingerprint?.css?.preferred?.selector).toBe(
      'app-input-mask[formcontrolname="branchNumber"] input',
    );
  });

  it('TEST 13 two different fields typed one right after the other are NEVER merged, even with the same structural CSS', () => {
    const trace = new Trace();
    trace.type(branch, '99999', 60);
    trace.type(legal, 'ACME', 60);
    const { result, events } = trace.run();
    const fills = result.normalized.kept.filter((action) => action.type === 'FILL');
    expect(fills).toHaveLength(2);
    expect(fillSteps(result.files.yaml).map((step) => step.fingerprint?.formControl)).toEqual([
      'branchNumber',
      'legalName',
    ]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['CSS_CANDIDATE_SELECTED', 'TARGET_MATCHED_FROM_INVENTORY']),
    );
  });
});

describe('DUPLICATE_TARGET_ACTION (§24)', () => {
  const action = (
    id: string,
    at: number,
    control: string,
    type: SemanticRecordedAction['type'] = 'FILL',
  ): SemanticRecordedAction =>
    ({
      id,
      type,
      at,
      rawEventIds: [id],
      target: {
        target: { strategy: 'label', value: control },
        quality: 'SEMANTIC',
        fingerprint: { formControl: control },
        label: control,
        named: true,
        alternatives: [],
        ambiguous: false,
        reasons: [],
      },
    }) as unknown as SemanticRecordedAction;

  it('flags consecutive actions on the same target identity, explains them, never removes them', () => {
    const found = detectDuplicateTargetActions([
      action('a1', 1000, 'legalName'),
      action('a2', 1500, 'legalName'),
      action('a3', 9000, 'legalName'),
      action('a4', 9500, 'branchNumber'),
      action('a5', 9800, 'save', 'CLICK'),
      action('a6', 9900, 'save', 'CLICK'),
    ]);
    expect(found.map((entry) => [entry.firstActionId, entry.secondActionId, entry.classification])).toEqual([
      ['a1', 'a2', 'TYPING_CONSOLIDATION_CANDIDATE'],
      ['a2', 'a3', 'HUMAN_CORRECTION'],
      ['a5', 'a6', 'REPEATED_ACTION'],
    ]);
  });

  it('two different fields that share a fragile CSS are never "duplicates"', () => {
    const fragile = (id: string): SemanticRecordedAction =>
      ({
        id,
        type: 'FILL',
        at: 1000,
        rawEventIds: [id],
        target: {
          target: { strategy: 'css', value: GENERIC },
          quality: 'FRAGILE',
          fingerprint: {},
          label: 'input',
          named: false,
          alternatives: [],
          ambiguous: true,
          reasons: [],
        },
      }) as unknown as SemanticRecordedAction;
    expect(detectDuplicateTargetActions([fragile('a1'), fragile('a2')])).toEqual([]);
  });
});

describe('Screen inventory report (§20)', () => {
  const inventory: ScreenInventory = {
    at: 1,
    url: `${APP}/requests/new`,
    screen: 'Create request',
    reason: 'SCREEN_ARRIVED',
    elements: 5,
    durationMs: 4,
    descriptors: [
      {
        elementId: 'INPUT-001',
        kind: 'INPUT',
        tag: 'input',
        label: 'Branch number',
        preferredCss: 'app-input-mask[formcontrolname="branchNumber"] input',
        preferredMatches: 1,
        structuralCss: GENERIC,
        structuralMatches: 4,
        status: 'UNIQUE',
      },
      {
        elementId: 'INPUT-002',
        kind: 'INPUT',
        tag: 'input',
        label: 'Legal name',
        preferredCss: 'app-input[formcontrolname="legalName"] input',
        preferredMatches: 1,
        structuralCss: GENERIC,
        structuralMatches: 4,
        status: 'UNIQUE',
      },
      {
        elementId: 'BUTTON-001',
        kind: 'BUTTON',
        tag: 'button',
        label: 'Save',
        status: 'UNIQUE',
        preferredCss: '#save',
        preferredMatches: 1,
      },
    ],
  };

  it('lists each input with its preferred CSS and status, and the generic selector NOT SELECTED', () => {
    const text = screenInventoryText([inventory]).join('\n');
    expect(text).toContain('Screen: Create request');
    expect(text).toContain('Inputs: 2');
    expect(text).toMatch(
      /INPUT-001\nsemantic: Branch number\npreferred CSS: app-input-mask\[formcontrolname="branchNumber"\] input\nmatches: 1\nstatus: UNIQUE/,
    );
    expect(text).toMatch(
      /Generic selector:\nmat-form-field > div > div > div > input\nmatches: 4\nstatus: AMBIGUOUS\nNOT SELECTED/,
    );
    expect(screenInventorySummary([inventory])).toEqual({ screens: 1, elements: 3, unique: 3, ambiguous: 0 });
  });

  it('the inventory sent by the page is untrusted: bounded, typed, redacted', () => {
    const clean = sanitizeInventory({
      at: 5,
      url: 'https://app.test/x?token=abc',
      reason: 'drop table',
      descriptors: [
        {
          elementId: '<script>',
          kind: 'INPUT',
          tag: 'INPUT',
          status: 'WHATEVER',
          reasons: ['GENERIC_CSS', 'bad reason!'],
          confidence: 7,
        },
      ],
    });
    expect(clean?.reason).toBe('SCREEN_ARRIVED');
    expect(clean?.descriptors[0]).toMatchObject({
      elementId: 'ELEMENT-000',
      tag: 'element',
      status: 'AMBIGUOUS',
      reasons: ['GENERIC_CSS'],
      confidence: 1,
    });
    expect(sanitizeInventory('nope')).toBeUndefined();
  });
});

describe('Replay: fingerprint, healing, value loss (§16, §18, §20, §23)', () => {
  it('TEST 20 a unique element whose formControlName differs is a HARD mismatch (never executed blindly)', () => {
    const match = matchFingerprint(
      { label: 'Legal name', formControl: 'legalName', tag: 'input' },
      { tag: 'input', role: 'textbox', name: 'Branch number', formControl: 'branchNumber' },
    );
    expect(match.verdict).toBe('MISMATCH');
    expect(match.severity).toBe('HARD');
    expect(match.reasons.join(' ')).toMatch(/formControlName "branchNumber" instead of "legalName"/);
    // Le même champ, nom lu identique : la même identité technique le renforce.
    expect(
      matchFingerprint(
        { name: 'Legal name', formControl: 'legalName' },
        { name: 'Legal name', formControl: 'legalName', tag: 'input' },
      ).verdict,
    ).not.toBe('MISMATCH');
  });

  it('TEST 18 healing tries the recorded preferred CSS first, then the semantic identity, then the structural fallback', () => {
    const candidates = healingCandidates(
      {
        role: 'textbox',
        name: 'Branch number',
        label: 'Branch number number',
        css: {
          preferred: { selector: 'app-input-mask[formcontrolname="branchNumber"] input' },
          fallback: { selector: GENERIC },
        },
      },
      { strategy: 'css', value: 'something-else' },
    );
    expect(candidates[0]).toEqual({
      strategy: 'css',
      value: 'app-input-mask[formcontrolname="branchNumber"] input',
    });
    expect(candidates.at(-1)).toEqual({ strategy: 'css', value: GENERIC });
    expect(candidates).toContainEqual({ strategy: 'role', role: 'textbox', name: 'Branch number' });
  });

  it('§23 value loss is classified on the REAL resolved target', () => {
    const kind = (
      probe: Parameters<typeof classifyValueLoss>[0]['probe'],
      expected = 'ACME',
      wrongTarget = false,
    ) => classifyValueLoss({ expected, probe, wrongTarget }).kind;
    expect(kind({ attached: true, value: 'ACME' }, 'ACME', true)).toBe('WRONG_TARGET');
    expect(kind({ attached: false })).toBe('FIELD_DISAPPEARED');
    expect(kind({ attached: false, rerenderedValue: '' })).toBe('FIELD_RERENDERED');
    expect(kind({ attached: true, value: '', invalid: true })).toBe('VALIDATION_REJECTED');
    expect(kind({ attached: true, value: '' })).toBe('VALUE_CLEARED');
    expect(kind({ attached: true, value: '999' }, '99999')).toBe('VALUE_REJECTED_BY_APPLICATION');
    expect(kind({ attached: true, value: 'Other Inc' })).toBe('VALUE_REPLACED');
    expect(kind(undefined)).toBe('UNKNOWN_VALUE_LOSS');
  });
});
