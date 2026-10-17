import { describe, expect, it } from 'vitest';
import type { ScreenShot } from '../../src/recording/human-flow-recorder.js';
import type { PreActionBox } from '../../src/recording/model.js';
import { beforeScreenOf } from '../../src/recording/recording-console.js';

/**
 * L'IMAGE « AVANT LE CLIC » de la revue : la dernière image prise avant l'appui, jamais une image
 * périmée. Le cas réel : l'écran pris pendant un chargement, l'humain qui clique une fois la page
 * chargée ; montrer l'écran de chargement avec le bouton encadré serait faux.
 */
const screen = (at: number, extra: Partial<ScreenShot> = {}): ScreenShot => ({
  image: `data:image/jpeg;base64,${String(at)}`,
  url: 'http://app.test/items',
  width: 1280,
  height: 800,
  scrollX: 0,
  scrollY: 0,
  at,
  ...extra,
});

const box = (extra: Partial<PreActionBox> = {}): PreActionBox => ({
  x: 100,
  y: 200,
  width: 120,
  height: 32,
  scrollX: 0,
  scrollY: 0,
  viewWidth: 1280,
  viewHeight: 800,
  at: 5_000,
  ...extra,
});

describe('before-click image', () => {
  it('takes the last image taken before the press', () => {
    expect(beforeScreenOf([screen(1_000), screen(4_000), screen(6_000)], box())?.at).toBe(4_000);
  });

  it('keeps an image taken after the last visible change of the page', () => {
    expect(beforeScreenOf([screen(4_000)], box({ changedAt: 3_500 }))?.at).toBe(4_000);
  });

  it('refuses an image taken before the page changed (a loading screen, then the loaded page)', () => {
    expect(beforeScreenOf([screen(2_000)], box({ changedAt: 3_500 }))).toBeUndefined();
  });

  it('refuses an image taken after the press', () => {
    expect(beforeScreenOf([screen(6_000)], box())).toBeUndefined();
  });

  it('refuses an image at another scroll position or window size (the frame would miss)', () => {
    expect(beforeScreenOf([screen(4_000, { scrollY: 300 })], box())).toBeUndefined();
    expect(beforeScreenOf([screen(4_000, { width: 1024 })], box())).toBeUndefined();
  });

  it('refuses an element without size', () => {
    expect(beforeScreenOf([screen(4_000)], box({ width: 0 }))).toBeUndefined();
  });
});
