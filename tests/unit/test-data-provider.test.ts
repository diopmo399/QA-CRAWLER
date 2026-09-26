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

  it('follows the hints of the application: 99999, HH:MM, date formats', () => {
    const text = (extra: Partial<FieldConstraints>) =>
      provider.instructionFor(fieldAction({ inputType: 'text', required: true, ...extra }));
    expect(text({ hint: '99999' })).toEqual({ kind: 'fill', value: '12345' });
    expect(text({ hint: 'HH:MM' })).toEqual({ kind: 'fill', value: '10:00' });
    expect(text({ hint: 'AAAA-MM-JJ' })).toEqual({ kind: 'fill', value: '2026-09-26' });
    expect(text({ placeholder: 'JJ/MM/AAAA' })).toEqual({ kind: 'fill', value: '26/09/2026' });
    expect(text({ dateLike: true })).toEqual({ kind: 'fill', value: '2026-09-26' });
    // Already filled (prefilled date…): left as it is.
    expect(text({ hasValue: true }).kind).toBe('skip');
  });

  it('uses the values of the mission, by label, name or group label (case, accents, * ignored)', () => {
    const configured = new DefaultTestDataProvider(() => new Date('2026-09-26T12:00:00Z'), {
      'code agence': '81234',
      'Canal de contact': 'Courriel',
      'Type de dossier': 'Fermeture',
      "M'assigner le dossier": 'oui',
      'Mot de passe': 'secret',
    });
    const field = (extra: Partial<FieldConstraints>, type: DiscoveredAction['type'] = 'fill') =>
      configured.instructionFor(fieldAction({ inputType: 'text', required: true, ...extra }, type));
    expect(field({ label: 'Code agence *', hasValue: true })).toEqual({ kind: 'fill', value: '81234' });
    const radio = { inputType: 'radio', groupLabel: '* Canal de contact', choiceGroup: 'name:p' };
    expect(field({ ...radio, label: 'Courriel' }, 'check')).toEqual({ kind: 'check' });
    expect(field({ ...radio, label: 'Téléphone' }, 'check').kind).toBe('skip');
    expect(field({ label: 'Type de dossier', customSelect: true }, 'select')).toEqual({
      kind: 'select',
      label: 'Fermeture',
    });
    expect(
      field({ inputType: 'checkbox', required: false, label: "M'assigner le dossier" }, 'check'),
    ).toEqual({
      kind: 'check',
    });
    // Sensitive fields: never, even when listed.
    expect(field({ inputType: 'password', label: 'Mot de passe' }).kind).toBe('skip');
  });

  it('chooses an option of every radio group and the first option of a custom list', () => {
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'radio', required: false, choiceGroup: 'name:p', label: 'Oui' }, 'check'),
      ),
    ).toEqual({ kind: 'check' });
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'div', required: false, customSelect: true }, 'select'),
      ),
    ).toEqual({ kind: 'select', label: '' });
    // An optional checkbox stays unchecked.
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'checkbox', required: false, label: 'Newsletter' }, 'check'),
      ),
    ).toEqual({ kind: 'skip', reason: 'optional choice' });
  });
});
