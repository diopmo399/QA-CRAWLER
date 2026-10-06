import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { rulesSection } from '../../src/reporting/rules-section.js';

/** Une section « Règles de l'application » vide dit POURQUOI : rien lu, seulement du minifié, aucun formulaire. */
describe('rules section: an empty section explains itself', () => {
  const coverage = {
    discovered: 0,
    confirmed: 0,
    contradicted: 0,
    partiallyVerified: 0,
    notVerified: 0,
    blockedByPolicy: 0,
    blockedByContext: 0,
    inconclusive: 0,
    verified: '0 / 0',
  };
  const result = (staticAnalysis: Record<string, unknown> | undefined, withRules = true): ExplorationResult =>
    ({
      ...(staticAnalysis ? { staticAnalysis } : {}),
      formRules: {
        rulesEnabled: true,
        fieldStates: [],
        dependencies: [],
        ...(withRules ? { rules: { coverage, items: [], tree: [], technicalConditions: 0 } } : {}),
      },
    }) as unknown as ExplorationResult;

  it('no code read (static analysis unavailable or disabled): points to source.git', () => {
    expect(rulesSection(result({ status: 'UNAVAILABLE' }, false), 'fr')).toContain(
      'aucun code de l’application n’a été lu (analyse statique UNAVAILABLE)',
    );
    expect(rulesSection(result(undefined, false), 'en')).toContain('static analysis DISABLED');
    expect(rulesSection(result(undefined, false), 'en')).toContain('staticAnalysis.source.git');
  });

  it('only minified bundles: the conditions cannot be read there', () => {
    expect(rulesSection(result({ status: 'USED', mode: 'BUNDLE', files: 8 }), 'en')).toContain(
      'only the minified bundles were read (BUNDLE)',
    );
  });

  it('source code read but no form recognised: the number of files and the path to check', () => {
    const html = rulesSection(result({ status: 'USED', mode: 'SOURCE', files: 42 }), 'fr');
    expect(html).toContain('Aucune règle dans les 42 fichier(s) lus');
    expect(html).toContain('Couverture des règles');
  });
});
