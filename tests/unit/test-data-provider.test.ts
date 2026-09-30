import { describe, expect, it } from 'vitest';
import { DefaultTestDataProvider } from '../../src/data/test-data-provider.js';
import type { FormField } from '../../src/forms/form-model.js';
import type { DiscoveredAction, FieldConstraints } from '../../src/model/discovered-action.js';

const provider = new DefaultTestDataProvider({
  runId: 'abc123',
  today: () => new Date('2026-09-26T12:00:00Z'),
});
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
      // La personne fictive du run, et son id : les données créées pourront être retrouvées.
      value: 'emily.clark.qa-crawler-abc123@example.test',
    });
    expect(provider.instructionFor(fieldAction({ inputType: 'text', required: true }))).toEqual({
      kind: 'fill',
      value: 'Test value',
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

  it('a list never gets its placeholder option (-, –, —, …, « Choisir »)', () => {
    for (const placeholder of ['—', '–', '-- Choisir --', '…', 'Sélectionner un rôle'])
      expect(
        provider.instructionFor(
          fieldAction(
            { inputType: 'select', required: true, options: [placeholder, 'Lecteur', 'Administrateur'] },
            'select',
          ),
        ),
      ).toEqual({ kind: 'select', label: 'Lecteur' });
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
    ).toEqual({ kind: 'fill', value: 'Test valuexx' });
    expect(provider.instructionFor(fieldAction({ inputType: 'text', required: true, maxLength: 3 }))).toEqual(
      { kind: 'fill', value: 'Tes' },
    );
  });

  it('gives up when a pattern cannot be satisfied; a digits pattern gets digits', () => {
    expect(
      provider.instructionFor(fieldAction({ inputType: 'text', required: true, pattern: '[A-Z]{2}\\d{4}' }))
        .kind,
    ).toBe('skip');
    expect(
      provider.instructionFor(fieldAction({ inputType: 'text', required: true, pattern: '[0-9]{5}' })),
    ).toEqual({ kind: 'fill', value: '12345' });
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'text', required: true, name: 'zip', pattern: '[0-9]{5}' }),
      ),
      // Code postal canadien (lettres) : pas dans un motif de chiffres, donc des chiffres de la bonne longueur.
    ).toEqual({ kind: 'fill', value: '12345' });
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
    // Déjà rempli (date préremplie…) : laissé tel quel.
    expect(text({ hasValue: true }).kind).toBe('skip');
  });

  it('uses the values of the mission, by label, name or group label (case, accents, * ignored)', () => {
    const configured = new DefaultTestDataProvider({
      runId: 'abc123',
      today: () => new Date('2026-09-26T12:00:00Z'),
      fields: {
        'code agence': '81234',
        'Canal de contact': 'Courriel',
        'Type de dossier': 'Fermeture',
        "M'assigner le dossier": 'oui',
        'Mot de passe': 'secret',
      },
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
    // Champs sensibles : jamais, même listés.
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
    // Une case à cocher facultative reste décochée.
    expect(
      provider.instructionFor(
        fieldAction({ inputType: 'checkbox', required: false, label: 'Newsletter' }, 'check'),
      ),
    ).toEqual({ kind: 'skip', reason: 'optional choice' });
  });

  it("« Nom de la société » est une entreprise ; le « : » final d'un libellé est ignoré", () => {
    const fill = (label: string, fields?: Record<string, string>) =>
      new DefaultTestDataProvider({ runId: 'abc123', fields }).instructionFor(
        fieldAction({ inputType: 'text', required: true, label }),
      );
    expect(fill('Nom de la société')).toEqual({ kind: 'fill', value: 'Test Company QA-CRAWLER-abc123' });
    expect(fill('Nom du contact')).toEqual({ kind: 'fill', value: 'Clark' });
    expect(fill('N° dossier :', { 'N° dossier': '123456' })).toEqual({ kind: 'fill', value: '123456' });
    expect(fill('N° dossier', { 'N° dossier :': '123456' })).toEqual({ kind: 'fill', value: '123456' });
  });
});

describe('coherent, readable test data', () => {
  const text = (extra: Partial<FormField>): FormField => ({
    id: 'f',
    type: 'text',
    required: true,
    disabled: false,
    readonly: false,
    hasValue: false,
    sensitive: false,
    payment: false,
    locator: { strategy: 'label', value: 'x' },
    ...extra,
  });
  const today = () => new Date('2026-09-26T12:00:00Z');

  it('one fictional person per run: name, e-mail, phone and address go together (French)', () => {
    const provider = new DefaultTestDataProvider({ runId: 'abc123', language: 'fr', today });
    const value = (extra: Partial<FormField>) => provider.validValue(text(extra)).value;
    expect(value({ label: 'Prénom' })).toBe('Julie');
    expect(value({ label: 'Nom de famille' })).toBe('Tremblay');
    // E-mail en ASCII, cohérent avec la personne, marqué avec l'id du run, domaine réservé.
    expect(value({ type: 'email' })).toBe('julie.tremblay.qa-crawler-abc123@example.test');
    expect(value({ type: 'tel' })).toBe('5145550101');
    expect(value({ label: 'Adresse' })).toBe('1250 rue Principale');
    expect(value({ label: 'Ville' })).toBe('Montréal');
    expect(value({ label: 'Code postal' })).toBe('H2X 1Y4');
    expect(value({ label: 'Pays' })).toBe('Canada');
    // Ce qui nomme une donnée créée garde le marqueur du run.
    expect(value({ label: 'Nom de la société' })).toBe('Entreprise Test QA-CRAWLER-abc123');
    expect(value({ type: 'textarea' })).toBe(
      'Donnée de test saisie automatiquement par QA-Crawler (QA-CRAWLER-abc123).',
    );
    expect(value({ label: 'Commentaire' })).toBe('Valeur de test');
  });

  it('the same run always gets the same person; another run may get another one', () => {
    const first = (runId: string) =>
      new DefaultTestDataProvider({ runId, language: 'en' }).validValue(text({ label: 'First name' })).value;
    expect(first('abc123')).toBe(first('abc123'));
    const names = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'].map(first));
    expect(names.size).toBeGreaterThan(1);
  });

  it('a birth date is in the past, still within the field bounds', () => {
    const provider = new DefaultTestDataProvider({ runId: 'abc123', today });
    expect(provider.validValue(text({ type: 'date', label: 'Date de naissance' })).value).toBe('1991-09-26');
    expect(
      provider.validValue(text({ type: 'date', label: 'Birth date', minText: '2000-01-01' })).value,
    ).toBe('2000-01-01');
    // Une autre date reste aujourd'hui.
    expect(provider.validValue(text({ type: 'date', label: "Date d'échéance" })).value).toBe('2026-09-26');
  });
});
