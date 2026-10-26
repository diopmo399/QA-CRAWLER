import { describe, expect, it } from 'vitest';
import { MONITOR_CSS } from '../../src/sdk/ui/monitor-styles.js';
import { RUNS_CSS } from '../../src/sdk/ui/runs-styles.js';
import { STUDIO_CSS } from '../../src/sdk/ui/studio-styles.js';
import { WIZARD_CSS } from '../../src/sdk/ui/styles.js';
import { darkThemeCss } from '../../src/sdk/ui/theme.js';

/**
 * THÈMES ET CONTRASTE : les quatre composants portent le thème sombre (theme="dark", et "auto" par
 * prefers-color-scheme) ; les couleurs de texte de la comparaison et du Run Monitor atteignent le
 * contraste WCAG AA (4,5:1) sur leur surface, dans les deux thèmes. Calcul : luminance relative WCAG
 * 2.x ; color-mix(in srgb) mélangé canal par canal, comme le navigateur.
 */
type Rgb = [number, number, number];

const hex = (value: string): Rgb => {
  const text = value.replace('#', '');
  const full = text.length === 3 ? text.replace(/./g, '$&$&') : text;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};
const luminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: Rgb, b: Rgb, share: number): Rgb =>
  a.map((value, i) => Math.round(value * share + (b[i] ?? 0) * (1 - share))) as Rgb;

/** Les jetons `--qa-color-*` d'un bloc CSS. */
const tokens = (css: string): Record<string, Rgb> => {
  const found: Record<string, Rgb> = {};
  for (const m of css.matchAll(/--qa-color-([a-z0-9-]+):(#[0-9A-Fa-f]{3,6})/g))
    found[m[1] ?? ''] = hex(m[2] ?? '#000');
  return found;
};

const lightOf = (css: string): Record<string, Rgb> =>
  tokens(css.slice(0, css.indexOf(':host([theme="dark"])')));
const dark = tokens(darkThemeCss().split('@media')[0] ?? '');

describe('SDK themes', () => {
  it('every component carries the dark theme, by attribute and by system preference', () => {
    for (const css of [WIZARD_CSS, STUDIO_CSS, RUNS_CSS, MONITOR_CSS]) {
      expect(css).toContain(':host([theme="dark"]){');
      expect(css).toContain('@media (prefers-color-scheme:dark)');
      expect(css).toContain(':host([theme="auto"]){');
      expect(css).toContain('color-scheme:dark');
    }
    // Les couleurs écrites en dur sur un fond clair de l'assistant ont leur version sombre.
    expect(WIZARD_CSS).toContain(':host([theme="dark"]) .alert.e{');
    expect(WIZARD_CSS).toContain(':host([theme="dark"]) .win{');
  });

  it('the dark theme redefines every color token of the light one', () => {
    for (const css of [WIZARD_CSS, STUDIO_CSS, RUNS_CSS, MONITOR_CSS])
      for (const name of Object.keys(lightOf(css))) expect(dark, name).toHaveProperty(name);
  });

  for (const [label, css] of [
    ['comparison', RUNS_CSS],
    ['run monitor', MONITOR_CSS],
  ] as const) {
    it(`${label}: text reaches WCAG AA on its surface, light and dark`, () => {
      for (const theme of [lightOf(css), { ...lightOf(css), ...dark }]) {
        const surface = theme.surface as Rgb;
        const text = theme.text as Rgb;
        expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(theme.muted as Rgb, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(theme.primary as Rgb, surface)).toBeGreaterThanOrEqual(4.5);
        // Statuts : la couleur du statut mêlée à 60 % à celle du texte (color-mix des styles).
        for (const status of ['success', 'warning', 'danger'])
          expect(contrast(mix(theme[status] as Rgb, text, 0.6), surface), status).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('status colors are always mixed with the text color in the comparison and the run monitor', () => {
    for (const css of [RUNS_CSS, MONITOR_CSS])
      expect(css).not.toMatch(/[{;]color:var\(--qa-color-(success|warning|danger)\)/);
  });
});
