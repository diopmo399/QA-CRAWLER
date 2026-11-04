import { describe, expect, it } from 'vitest';
import { flowSchema } from '../../src/config/flow-schema.js';
import { outputStep, sanitizeOutput } from '../../src/sdk/server/library-outputs.js';

/** « Ajouter une sortie » : chaque source devient une étape exécutable valide ; jamais une simple déclaration. */
describe('block outputs — the executable step behind each source', () => {
  const known = new Set(['company.name', 'request.code']);
  const step = (raw: Record<string, unknown>) => outputStep(sanitizeOutput(raw), known);
  const parses = (value: Record<string, unknown>): boolean =>
    flowSchema.safeParse({ name: 'Block', steps: [value] }).success;

  it('builds a capture step for every source, with its transformation', () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { key: 'company.alias', source: 'GENERATED', generator: 'company' },
        { as: 'company.alias', generate: 'company' },
      ],
      [
        { key: 'company.id', source: 'DOM_TEXT', selector: '#company-id', transform: 'digits' },
        { as: 'company.id', text: { css: '#company-id' }, transform: 'digits' },
      ],
      [
        {
          key: 'company.link',
          source: 'DOM_ATTRIBUTE',
          testId: 'detail',
          attribute: 'href',
          pattern: '/(\\d+)$',
        },
        { as: 'company.link', attribute: { testId: 'detail', attribute: 'href' }, pattern: '/(\\d+)$' },
      ],
      [
        { key: 'request.id', source: 'URL', pattern: '/requests/(\\d+)' },
        { as: 'request.id', url: { pattern: '/requests/(\\d+)' } },
      ],
      [
        { key: 'person.id', source: 'RESPONSE', method: 'post', url: '/persons', field: 'id' },
        { as: 'person.id', response: { method: 'POST', url: '/persons', field: 'id' } },
      ],
      [
        {
          key: 'company.label',
          source: 'INPUT',
          from: 'company.name',
          transform: 'uppercase',
          label: 'Label',
        },
        { as: 'company.label', data: 'company.name', transform: 'uppercase' },
      ],
    ];
    for (const [raw, capture] of cases) {
      const built = step(raw);
      expect(built.capture).toEqual(capture);
      expect(parses(built)).toBe(true);
    }
    expect(step({ key: 'company.label', source: 'INPUT', from: 'company.name', label: 'Label' }).name).toBe(
      'Label',
    );
  });

  it('refuses an output without an executable source, a secret, or an unknown passthrough', () => {
    expect(() => step({ key: 'x.code', source: 'URL' })).toThrow(/a parameter name, or a pattern/);
    expect(() => step({ key: 'x.code', source: 'DOM_TEXT' })).toThrow(/a CSS selector or a test id/);
    expect(() => step({ key: 'x.code', source: 'DOM_ATTRIBUTE', selector: 'a' })).toThrow(
      /attribute to read/,
    );
    expect(() => step({ key: 'x.code', source: 'RESPONSE', url: '/x' })).toThrow(/field to read/);
    expect(() => step({ key: 'x.code', source: 'GENERATED', generator: 'anything' })).toThrow(
      /generator: one of/,
    );
    expect(() => step({ key: 'x.code', source: 'INPUT', from: 'unknown.key' })).toThrow(/an input or a data/);
    expect(() => step({ key: 'company.name', source: 'INPUT', from: 'company.name' })).toThrow(/its own key/);
    expect(() => sanitizeOutput({ key: 'user.password', source: 'GENERATED' })).toThrow(
      /a secret is never an output/,
    );
    expect(() => sanitizeOutput({ key: 'bad key', source: 'GENERATED' })).toThrow(/a data key/);
    expect(() => sanitizeOutput({ key: 'ok.key', source: 'NOPE' })).toThrow(/source: one of/);
  });
});
