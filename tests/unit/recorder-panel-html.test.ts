import { describe, expect, it } from 'vitest';
import { recorderPanelHtml } from '../../src/recording/recorder-panel-html.js';

/**
 * La fenêtre d'enregistrement : les pictogrammes des gestes (clic, saisie, case…) ont leur propre
 * table de SVG complets, distincte de celle des boutons. Une seule table `SVG` partagée par les
 * deux rendait « undefined » pour une saisie et un fragment invisible pour un clic.
 */
describe('recorder panel HTML: gesture pictograms', () => {
  for (const language of ['fr', 'en'] as const) {
    it(`${language}: the gesture table is declared once, apart from the button icons, and every gesture maps to a full SVG`, () => {
      const html = recorderPanelHtml(language);
      expect(html.match(/var SVG = \{/g)).toHaveLength(1);
      expect(html.match(/var KIND_SVG = \{/g)).toHaveLength(1);
      // Le rendu d'un geste (la ligne du parcours) passe par kindSvg, jamais par SVG[...].
      expect(html.match(/kindSvg\(step\.kind\)/g)).toHaveLength(1);
      expect(html).not.toContain('SVG[KIND_ICON[step.kind]');
      const kinds = /var KIND_ICON = \{([^}]*)\}/.exec(html)?.[1] ?? '';
      const icons = [...kinds.matchAll(/:\s*'([a-z]+)'/g)].map((match) => match[1]);
      const table = /var KIND_SVG = \{([\s\S]*?)\n {2}\};/.exec(html)?.[1] ?? '';
      expect(icons.length).toBeGreaterThan(5);
      for (const icon of new Set(icons)) expect(table, icon).toMatch(new RegExp(`\\n\\s+${icon}: '<svg `));
    });
  }
});
