import { describe, expect, it } from 'vitest';
import { LiveTimeline } from '../../src/recording/live-timeline.js';
import type { RawRecordedEvent, RecordedElement, RecordedFlow } from '../../src/recording/model.js';
import { reviewSteps } from '../../src/recording/panel-state.js';
import type { RecordingTargetValidation } from '../../src/recording/target-validator.js';

let sequence = 0;
const element = (overrides: Partial<RecordedElement>): RecordedElement => ({
  tag: 'button',
  role: 'button',
  name: 'Continue',
  css: '#continue',
  cssStable: true,
  sameRoleName: 1,
  sameLabel: 1,
  roleNameIndex: 0,
  inForm: false,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  ...overrides,
});
const raw = (
  type: RawRecordedEvent['type'],
  at: number,
  extra: Partial<RawRecordedEvent> = {},
): RawRecordedEvent => {
  sequence += 1;
  return { id: `r${String(sequence)}`, sequence, type, at, url: 'http://app.test/form', ...extra };
};
const field = (label: string, overrides: Partial<RecordedElement> = {}): RecordedElement =>
  element({ tag: 'input', role: 'textbox', name: label, label, css: `input[name="${label}"]`, ...overrides });
const validation = (
  rawEventId: string,
  status: RecordingTargetValidation['status'],
  candidates?: { index: number; original: boolean; name?: string; section?: string }[],
): RecordingTargetValidation =>
  ({
    rawEventId,
    status,
    validationBefore: {
      status,
      confidence: 1,
      reason: '',
      candidateCount: candidates?.length ?? 1,
      differences: [],
      ...(candidates ? { candidates } : {}),
    },
  }) as unknown as RecordingTargetValidation;

describe('Live timeline (what the human sees while recording)', () => {
  it('describes real actions in plain words, the page opening first', () => {
    const timeline = new LiveTimeline('fr');
    timeline.onEvent(raw('navigation', 0));
    timeline.onEvent(raw('click', 100, { element: element({}) }));
    const check = raw('change', 200, {
      element: field('Accept terms', { inputType: 'checkbox', role: 'checkbox', checked: false }),
      value: { empty: false, length: 0, shape: 'text', checked: true },
    });
    timeline.onEvent(check);
    timeline.onEvent(
      raw('change', 300, {
        element: field('Receive news', { inputType: 'checkbox', role: 'checkbox', checked: true }),
        value: { empty: false, length: 0, shape: 'text', checked: false },
      }),
    );
    timeline.onEvent(
      raw('change', 400, {
        element: field('Province', { tag: 'select', role: 'combobox', hasOptions: true }),
        value: { empty: false, length: 6, shape: 'text', option: { label: 'Quebec' } },
      }),
    );
    expect(timeline.actions.map((action) => action.description)).toEqual([
      'Ouvrir la page',
      'Cliquer sur "Continue"',
      'Cocher "Accept terms"',
      'Décocher "Receive news"',
      'Sélectionner "Quebec" dans "Province"',
    ]);
    // Affichée tout de suite, AVANT la validation (jamais d'attente d'une analyse).
    expect(timeline.actions[1]?.status).toBe('PENDING');
    expect(timeline.actions[0]?.status).toBe('CONFIRMED');
  });

  it('a field typed in several times is ONE line with the final value; a sensitive field is always masked', () => {
    const timeline = new LiveTimeline('fr');
    const first = raw('input', 0, {
      element: field('First name'),
      value: { empty: false, length: 2, shape: 'text' },
    });
    const second = raw('change', 50, {
      element: field('First name'),
      value: { empty: false, length: 4, shape: 'text' },
    });
    timeline.onEvent(first);
    timeline.setTypedValue(first.id, 'Al');
    timeline.onEvent(second);
    timeline.setTypedValue(second.id, 'Alex');
    expect(timeline.actions).toHaveLength(1);
    expect(timeline.actions[0]?.description).toBe('Saisir "Alex" dans "First name"');
    const secret = raw('change', 100, {
      element: field('Password', { inputType: 'password' }),
      value: { empty: false, length: 8, shape: 'text', sensitive: true },
    });
    timeline.onEvent(secret);
    expect(timeline.setTypedValue(secret.id, 'not shown')).toBeUndefined();
    expect(timeline.actions[1]?.description).toBe('Saisir "••••" dans "Password"');
    expect(JSON.stringify(timeline.actions)).not.toContain('not shown');
  });

  it('a navigation right after a click is its effect, never a separate action', () => {
    const timeline = new LiveTimeline('en');
    timeline.onEvent(raw('navigation', 0));
    timeline.onEvent(raw('click', 100, { element: element({ role: 'link', tag: 'a' }) }));
    timeline.onEvent(raw('navigation', 400, { url: 'http://app.test/done' }));
    expect(timeline.actions.map((action) => action.description)).toEqual([
      'Open the page',
      'Click "Continue"',
    ]);
    expect(timeline.actions[1]?.detail).toBe('→ /done');
  });

  it('noise (focus click, toggle click) adds no line', () => {
    const timeline = new LiveTimeline('fr');
    timeline.onEvent(raw('click', 0, { element: field('First name'), noise: 'focus click in a field' }));
    expect(timeline.actions).toHaveLength(0);
  });

  it('validation turns ● into ✓, ⚠ (with the candidates) or ✕', () => {
    const timeline = new LiveTimeline('fr');
    const a = raw('click', 0, { element: element({}) });
    const b = raw('click', 10, { element: element({ name: 'Save' }) });
    const c = raw('click', 20, { element: element({ name: 'Next' }) });
    for (const event of [a, b, c]) timeline.onEvent(event);
    timeline.onValidation(a.id, validation(a.id, 'VALIDATED'));
    timeline.onValidation(
      b.id,
      validation(b.id, 'AMBIGUOUS', [
        { index: 0, original: false, name: 'Save', section: 'Main' },
        { index: 1, original: true, name: 'Save', section: 'Side panel' },
      ]),
    );
    timeline.onValidation(c.id, validation(c.id, 'NOT_FOUND'));
    expect(timeline.actions.map((action) => action.status)).toEqual(['CONFIRMED', 'AMBIGUOUS', 'FAILED']);
    expect(timeline.actions[1]?.candidates?.map((candidate) => candidate.label)).toEqual([
      'Save — Main — n° 1',
      'Save — Side panel — n° 2 — élément touché',
    ]);
    expect(timeline.summary()).toMatchObject({
      actions: 3,
      confirmed: 1,
      ambiguous: 1,
      failed: 1,
      attention: 2,
    });
  });

  it('an ambiguity is resolved only with the element really touched; ignoring it keeps it visible', () => {
    const timeline = new LiveTimeline('fr');
    const event = raw('click', 0, { element: element({ name: 'Save' }) });
    timeline.onEvent(event);
    timeline.onValidation(
      event.id,
      validation(event.id, 'AMBIGUOUS', [
        { index: 0, original: false, name: 'Save' },
        { index: 1, original: true, name: 'Save' },
      ]),
    );
    const id = timeline.actions[0]?.id ?? '';
    expect(timeline.resolve(id, 0)).toEqual({ error: 'NOT_TOUCHED' });
    expect(timeline.actions[0]?.status).toBe('AMBIGUOUS');
    expect('action' in timeline.resolve(id, 1)).toBe(true);
    expect(timeline.actions[0]).toMatchObject({ status: 'CONFIRMED', resolution: 'RESOLVED' });

    const other = new LiveTimeline('en');
    const second = raw('click', 0, { element: element({ name: 'Save' }) });
    other.onEvent(second);
    other.onValidation(second.id, validation(second.id, 'AMBIGUOUS', [{ index: 0, original: true }]));
    other.ignore(other.actions[0]?.id ?? '');
    expect(other.actions[0]).toMatchObject({ status: 'AMBIGUOUS', resolution: 'IGNORED' });
    expect(other.summary().attention).toBe(0);
  });

  it('undo removes the last action (never the page opening)', () => {
    const timeline = new LiveTimeline('fr');
    timeline.onEvent(raw('navigation', 0));
    timeline.onEvent(raw('click', 10, { element: element({}) }));
    expect(timeline.undoLast()?.kind).toBe('click');
    expect(timeline.undoLast()).toBeUndefined();
    expect(timeline.actions).toHaveLength(1);
  });

  it('the quality comes from real facts only (confirmed, stable, unique, no error)', () => {
    const timeline = new LiveTimeline('fr');
    expect(timeline.quality().score).toBeUndefined();
    const ok = raw('click', 0, { element: element({}) });
    const fragile = raw('click', 10, { element: element({ name: 'X', cssStable: false }) });
    timeline.onEvent(ok);
    timeline.onEvent(fragile);
    timeline.onValidation(ok.id, validation(ok.id, 'VALIDATED'));
    timeline.onValidation(fragile.id, validation(fragile.id, 'VALIDATED_FRAGILE'));
    const quality = timeline.quality();
    expect(quality.checks.find((check) => check.id === 'stable')).toMatchObject({
      ok: false,
      passed: 1,
      total: 2,
    });
    expect(quality.score).toBe(Math.round((7 / 8) * 100));
  });
});

describe('Review steps (after Stop)', () => {
  it('lists the flow actions with the live words, keeps the checks apart, never an intent', () => {
    const timeline = new LiveTimeline('fr');
    const fill = raw('change', 0, {
      element: field('First name'),
      value: { empty: false, length: 4, shape: 'text' },
    });
    timeline.onEvent(fill);
    timeline.setTypedValue(fill.id, 'Alex');
    const flow = {
      steps: [
        {
          id: 's1',
          step: {
            kind: 'fill',
            target: { strategy: 'label', value: 'First name' },
            value: { testData: 'firstName' },
            allow: [],
            optional: false,
          },
          label: 'First name',
          actionIds: ['a1'],
          rawEventIds: [fill.id],
          provenance: 'HUMAN_RECORDED',
          confidence: 1,
          explanation: '',
        },
        {
          id: 's2',
          step: { kind: 'expect', expect: { url: '/done' }, allow: [], optional: false },
          label: 'the page /done is displayed',
          actionIds: ['a1'],
          rawEventIds: [fill.id],
          provenance: 'INFERRED_OUTCOME',
          confidence: 1,
          explanation: '',
        },
      ],
      intent: { workflow: 'CREATE:ITEM', transitions: [], confidence: 1, evidence: [] },
    } as unknown as RecordedFlow;
    const review = reviewSteps(flow, timeline.actions, 'fr');
    expect(review.actions.map((step) => step.description)).toEqual(['Saisir "Alex" dans "First name"']);
    expect(review.checks).toEqual([{ id: 's2', description: 'Vérifier : URL /done' }]);
    expect(JSON.stringify(review)).not.toContain('CREATE:ITEM');
  });
});
