import { describe, expect, it } from 'vitest';
import { DefaultTestDataProvider } from '../../src/data/test-data-provider.js';
import type { DiscoveredAction, FieldConstraints } from '../../src/model/discovered-action.js';

const provider = new DefaultTestDataProvider(() => new Date('2026-09-26T12:00:00Z'));
const fieldAction = (field: FieldConstraints, type: DiscoveredAction['type'] = 'fill'): DiscoveredAction => ({
  id: 'a',
  stateId: 's',
  type,
  category: 'form-input',
  elementType: 'input',
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: '',
  risks: [],
  locator: { strategy: 'label', value: 'x' },
  field,
});

describe('DefaultTestDataProvider', () => {
  it('produces valid values by type', () => {
    expect(provider.instructionFor(fieldAction({ inputType: 'email', required: true }))).toEqual({
      kind: 'fill',
      value: 'qa-crawler@example.test',
    });
    expect(provider.instructionFor(fieldAction({ inputType: 'text', required: true }))).toEqual({
      kind: 'fill',
      value: 'QA Test',
    });
    expect(provider.instructionFor(fieldAction({ inputType: 'date', required: true }))).toEqual({
      kind: 'fill',
      value: '2026-09-26',
    });
    expect(provider.instructionFor(fieldAction({ inputType: 'url', required: false }))).toEqual({
      kind: 'fill',
      value: 'https://example.test',
    });
  });

  it('respects min/max/step and length constraints', () => {
    expect(
      provider.instructionFor(fieldAction({ inputType: 'number', required: true, min: '18', max: '99' })),
    ).toEqual({ kind: 'fill', value: '59' });
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'number', required: true, min: '0', max: '1', step: '0.25' }),
      ),
    ).toEqual({ kind: 'fill', value: '0.5' });
    expect(
      provider.instructionFor(fieldAction({ inputType: 'date', required: true, min: '2030-01-01' })),
    ).toEqual({ kind: 'fill', value: '2030-01-01' });
    expect(
      provider.instructionFor(fieldAction({ inputType: 'text', required: true, minLength: 12 })),
    ).toEqual({ kind: 'fill', value: 'QA Testxxxxx' });
    expect(provider.instructionFor(fieldAction({ inputType: 'text', required: true, maxLength: 3 }))).toEqual(
      { kind: 'fill', value: 'QA ' },
    );
  });

  it('gives up when a pattern cannot be satisfied', () => {
    expect(
      provider.instructionFor(fieldAction({ inputType: 'text', required: true, pattern: '[0-9]{5}' })).kind,
    ).toBe('skip');
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'text', required: true, name: 'zip', pattern: '[0-9]{5}' }),
      ),
    ).toEqual({ kind: 'fill', value: '75001' });
  });

  it('checks required boxes only and picks a real select option', () => {
    expect(provider.instructionFor(fieldAction({ inputType: 'checkbox', required: true }, 'check'))).toEqual({
      kind: 'check',
    });
    expect(
      provider.instructionFor(fieldAction({ inputType: 'checkbox', required: false }, 'check')).kind,
    ).toBe('skip');
    expect(
      provider.instructionFor(
        fieldAction(
          { inputType: 'select', required: true, options: ['-- Choisir --', 'Subvention'] },
          'select',
        ),
      ),
    ).toEqual({ kind: 'select', label: 'Subvention' });
  });

  it('never fills sensitive fields', () => {
    for (const field of [
      { inputType: 'password', required: true },
      { inputType: 'text', required: true, autocomplete: 'cc-number' },
      { inputType: 'text', required: true, label: 'Numéro de carte bancaire' },
      { inputType: 'text', required: true, name: 'iban' },
      { inputType: 'text', required: true, label: 'Code OTP' },
    ] as FieldConstraints[]) {
      expect(provider.instructionFor(fieldAction(field)).kind, JSON.stringify(field)).toBe('skip');
    }
  });
});
