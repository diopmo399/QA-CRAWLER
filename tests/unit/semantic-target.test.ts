import { describe, expect, it } from 'vitest';
import { flowSchema } from '../../src/config/flow-schema.js';
import { rawStepOf, sentenceOf } from '../../src/dry-run/suggested-flow.js';
import { matchFingerprint, sectionMatch } from '../../src/flows/action-effect-verifier.js';
import { GherkinStepDictionary } from '../../src/flows/gherkin/gherkin-steps.js';
import { sanitize } from '../../src/recording/human-flow-recorder.js';
import { semanticIdOf } from '../../src/recording/recorded-target.js';

const parseSteps = (steps: unknown[]) => flowSchema.parse({ name: 'f', steps }).steps;

describe('Semantic target identity (pure)', () => {
  it('a section-scoped target round-trips YAML → step → Gherkin → step', () => {
    const [step] = parseSteps([{ fill: { label: 'Search', section: 'Columns', value: 'alpha' } }]);
    if (!step) throw new Error('no step');
    expect(rawStepOf(step)).toEqual({ fill: { label: 'Search', section: 'Columns', value: 'alpha' } });
    const sentence = sentenceOf(step, 'en');
    expect(sentence).toBe('I type "alpha" into "Search" in the section "Columns"');
    const dictionary = new GherkinStepDictionary();
    expect(dictionary.translate(sentence ?? '')).toEqual([
      { fill: { label: 'Search', value: 'alpha', section: 'Columns' } },
    ]);
    expect(dictionary.translate('je clique sur le bouton "Save" dans la section "Filters"')).toEqual([
      { click: { role: 'button', name: 'Save', section: 'Filters' } },
    ]);
  });

  it('DRAG_AND_DROP is a flow step of its own, said in Gherkin and read back identically', () => {
    const raw = {
      dragAndDrop: {
        item: 'Status',
        from: { section: 'Columns > Available columns' },
        to: { section: 'Columns > Selected columns' },
      },
    };
    const [step] = parseSteps([raw]);
    if (!step) throw new Error('no step');
    expect(step.kind).toBe('dragAndDrop');
    expect(rawStepOf(step)).toEqual(raw);
    for (const language of ['fr', 'en'] as const) {
      const sentence = sentenceOf(step, language) ?? '';
      expect(new GherkinStepDictionary().translate(sentence)).toEqual([raw]);
    }
    expect(() => parseSteps([{ dragAndDrop: { item: 'Status', to: {} } }])).toThrow();
  });

  it('the fingerprint rejects the same field in another section (Filters ≠ General)', () => {
    expect(sectionMatch('General', 'Settings > General')).toBe('SAME');
    expect(sectionMatch('Columns > Available', 'Columns > Selected')).toBe('OTHER');
    expect(sectionMatch('General', undefined)).toBe('UNKNOWN');
    const expected = { role: 'textbox', tag: 'input', name: 'Search', section: 'Columns' };
    expect(
      matchFingerprint(expected, { tag: 'input', role: 'textbox', name: 'Search', section: 'Filters' })
        .verdict,
    ).toBe('MISMATCH');
    const same = matchFingerprint(expected, {
      tag: 'input',
      role: 'textbox',
      name: 'Search',
      section: 'Columns',
    });
    expect(same.verdict).toBe('EXACT_MATCH');
    expect(same.reasons).toContain('same section');
  });

  it('a stable semantic id comes from the section and the human name', () => {
    expect(semanticIdOf('Général', 'Priorité')).toBe('general.priorite');
    expect(semanticIdOf(undefined, undefined)).toBeUndefined();
  });

  it('the drag payload from the page is untrusted: bounded, redacted, strict booleans', () => {
    const event = sanitize({
      type: 'drag',
      url: 'http://app.test/x',
      drag: {
        kind: 'HTML5',
        item: 'Status',
        source: { section: 'Columns > Available columns', extra: 'ignored' },
        destination: { section: 'Columns > Selected columns' },
        moved: 'yes',
        sameZone: false,
      },
    });
    expect(event?.drag).toEqual({
      kind: 'HTML5',
      item: 'Status',
      source: { section: 'Columns > Available columns' },
      destination: { section: 'Columns > Selected columns' },
      sameZone: false,
      moved: false,
    });
    expect(sanitize({ type: 'drag', url: '', drag: { item: '' } })?.drag).toBeUndefined();
  });
});
