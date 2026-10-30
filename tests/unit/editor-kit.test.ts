import { describe, expect, it } from 'vitest';
import { diffSummary } from '../../src/sdk/ui/editor-kit.js';

/** LE RÉSUMÉ DE LA COMPARAISON : des lignes ajoutées et retirées comptées ligne par ligne, et des blocs. */
describe('diff summary', () => {
  it('counts one added line, wherever the character diff would cut it', () => {
    const before =
      'steps:\n  - click:\n      role: link\n      name: Utilisateur 1\n  - expect:\n      url: /users/\n';
    const after = before.replace(
      '      name: Utilisateur 1\n',
      '      name: Utilisateur 1\n    name: Ouvrir la fiche\n',
    );
    expect(diffSummary(before, after)).toEqual({ added: 1, removed: 0, changes: 1 });
  });

  it('a changed line is one removed and one added; separate places are separate blocks', () => {
    expect(diffSummary('a\nb\nc\nd\n', 'a\nB\nc\nD\n')).toEqual({ added: 2, removed: 2, changes: 2 });
    expect(diffSummary('same\n', 'same\n')).toEqual({ added: 0, removed: 0, changes: 0 });
    expect(diffSummary('a\nb\n', 'a\n')).toEqual({ added: 0, removed: 1, changes: 1 });
  });
});
