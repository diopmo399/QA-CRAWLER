import { describe, expect, it } from 'vitest';
import {
  AssertionResolver,
  classifyMessage,
  judgeTexts,
} from '../../src/semantics/resolution/assertion-resolver.js';
import { fieldDescriptors } from '../../src/semantics/resolution/field-descriptor.js';
import { FieldMatcher } from '../../src/semantics/resolution/field-matcher.js';
import { FormIntentResolver } from '../../src/semantics/resolution/form-intent-resolver.js';
import { DEFAULT_THRESHOLDS } from '../../src/semantics/resolution/resolution.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { field, screen, testConfig } from '../helpers.js';

const dictionary = new SemanticDictionary();
const assertions = new AssertionResolver(dictionary);
const config = testConfig();

describe('AssertionResolver: a weak match never becomes a PASS', () => {
  const users = screen(
    { url: 'http://localhost:4200/users', title: 'Utilisateurs', headings: ['Utilisateurs'] },
    config,
  );
  const plan = (subject: string, context = users) =>
    assertions.plan({ kind: 'ASSERT', assertion: 'PAGE_DISPLAYED', subject }, context, { values: [] });

  it('the page named by its heading: PASSED', () => {
    expect(plan('Utilisateurs')).toMatchObject({ kind: 'decided', verdict: 'PASSED' });
    expect(plan('utilisateur')).toMatchObject({ kind: 'decided', verdict: 'PASSED' });
  });
  it('only mentioned (the creation form of a user): MANUAL, never PASSED', () => {
    const form = screen(
      { url: 'http://localhost:4200/users/new', title: 'Admin', headings: ['Nouvel utilisateur'] },
      config,
    );
    expect(plan('utilisateurs', form)).toMatchObject({ kind: 'decided', verdict: 'MANUAL' });
  });
  it('another page entirely: FAILED', () => {
    expect(plan('Paramètres')).toMatchObject({ kind: 'decided', verdict: 'FAILED' });
  });
  it('messages: confirmation, error, or unknown', () => {
    expect(classifyMessage('Utilisateur créé avec succès')).toBe('confirmation');
    expect(classifyMessage('Saved')).toBe('confirmation');
    expect(classifyMessage('Erreur : création impossible')).toBe('error');
    expect(classifyMessage('Bienvenue')).toBeUndefined();
  });
  it('values of the scenario in the list: identity values decide; none → FAILED; partial → MANUAL', () => {
    const planned = assertions.plan(
      { kind: 'ASSERT', assertion: 'ENTITY_VISIBLE', subject: 'utilisateur' },
      users,
      {
        values: [
          { text: 'Mohamed', identity: 'name' },
          { text: 'Diop', identity: 'name' },
          { text: 'mohamed@example.com', identity: 'contact' },
          { text: 'Créé par QA' },
        ],
      },
    );
    if (planned.kind !== 'texts') throw new Error('texts expected');
    expect(planned.identifying).toEqual(['Mohamed', 'Diop']);
    expect(judgeTexts(planned, new Set(['Mohamed', 'Diop'])).verdict).toBe('PASSED');
    expect(judgeTexts(planned, new Set()).verdict).toBe('FAILED');
    expect(judgeTexts(planned, new Set(['Mohamed'])).verdict).toBe('MANUAL');
    expect(
      assertions.plan({ kind: 'ASSERT', assertion: 'ENTITY_VISIBLE' }, users, { values: [] }),
    ).toMatchObject({ kind: 'decided', verdict: 'MANUAL' });
  });
});

describe('performance: in memory, no storage call', () => {
  const vocabulary = new SemanticVocabulary(dictionary);
  const matcher = new FieldMatcher(vocabulary, DEFAULT_THRESHOLDS);
  const forms = new FormIntentResolver(matcher, DEFAULT_THRESHOLDS);
  const LABELS = ['Champ', 'Donnée', 'Valeur', 'Information', 'Référence', 'Code', 'Zone', 'Paramètre'];

  // L'ActionDiscovery garde au plus 200 éléments par écran : les grands formulaires sont construits par lots.
  const screenOf = (count: number) => {
    const fields = fieldDescriptors(
      screen(
        {
          elements: [
            field('Adresse électronique', { fieldName: 'electronicMail', inputType: 'email', formIndex: 0 }),
          ],
        },
        config,
      ).actions,
    );
    for (let start = 0; fields.length < count; start += 100) {
      const size = Math.min(100, count - fields.length);
      fields.push(
        ...fieldDescriptors(
          screen(
            {
              url: `http://localhost:4200/big/${start}`,
              elements: Array.from({ length: size }, (_, offset) => {
                const index = start + offset;
                return field(`${LABELS[index % LABELS.length] ?? 'Champ'} ${index}`, {
                  fieldName: `f${index}`,
                  formIndex: 0,
                });
              }),
            },
            config,
          ).actions,
        ),
      );
    }
    return fields;
  };

  it.each([10, 50, 100, 500])('%i fields: one resolution, and a 5-row form, stay fast', (count) => {
    const fields = screenOf(count);
    expect(fields.length).toBe(count);
    const repeats = count >= 500 ? 5 : 20;
    const start = performance.now();
    for (let index = 0; index < repeats; index++) {
      const result = matcher.resolve({ kind: 'FILL', field: 'courriel', value: 'a@b.co' }, fields, {
        stateSignature: 's',
      });
      expect(result.selected?.field.name).toBe('electronicMail');
    }
    const single = (performance.now() - start) / repeats;
    const formStart = performance.now();
    forms.resolve(
      {
        kind: 'FILL_FORM',
        rows: [
          { field: 'courriel', value: 'a@b.co' },
          { field: 'code 3', value: 'X' },
          { field: 'zone 6', value: 'Y' },
          { field: 'valeur 2', value: 'Z' },
          { field: 'donnée 1', value: 'W' },
        ],
      },
      fields,
      { stateSignature: 's' },
    );
    const form = performance.now() - formStart;
    console.log(`BENCH ${count} fields: resolve ${single.toFixed(2)} ms, 5-row form ${form.toFixed(2)} ms`);
    // Bornes larges (machines de CI) : l'ordre de grandeur, pas une mesure fine.
    expect(single).toBeLessThan(count * 2);
    expect(form).toBeLessThan(count * 10);
  });
});
