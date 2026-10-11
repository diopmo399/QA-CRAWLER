import { readFile, writeFile } from 'node:fs/promises';
import { decodePng, encodePng, type RgbaImage } from './png.js';
import type { VisualComparator, VisualComparison } from './visual-comparator.js';

/** Une zone masquée (pixels), jamais comparée : horloge, bandeau de notification, publicité. */
export interface VisualMask {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pourquoi (pour le rapport). */
  reason?: string;
}

export interface PixelComparatorOptions {
  /** Distance de couleur (0..255, par canal, somme) au-delà de laquelle un pixel compte comme différent. */
  colorThreshold: number;
  masks: readonly VisualMask[];
  /** Où écrire l'image des différences (absent : pas d'image). */
  diffImage?: (baselineImage: string, currentImage: string) => string;
}

/**
 * PIXEL VISUAL COMPARATOR : la première implémentation réelle de l'interface VisualComparator
 * (qui n'avait que le stub NoVisualComparator). Compare deux PNG pixel à pixel, hors des zones
 * masquées, et produit la part de l'image qui a changé (0..1) et une image des différences
 * (les pixels changés en rouge sur la capture courante assombrie). Deux tailles différentes sont
 * comparées sur la zone commune, le reste comptant comme différent.
 */
export class PixelVisualComparator implements VisualComparator {
  readonly name = 'pixel';

  constructor(private readonly options: PixelComparatorOptions) {}

  async compare(baselineImage: string, currentImage: string): Promise<VisualComparison> {
    let baseline: RgbaImage;
    let current: RgbaImage;
    try {
      [baseline, current] = await Promise.all([
        readFile(baselineImage).then((bytes) => decodePng(new Uint8Array(bytes))),
        readFile(currentImage).then((bytes) => decodePng(new Uint8Array(bytes))),
      ]);
    } catch (error) {
      return { status: 'UNKNOWN', reason: error instanceof Error ? error.message : String(error) };
    }
    const result = compareImages(baseline, current, this.options);
    const target = this.options.diffImage?.(baselineImage, currentImage);
    if (target && result.different > 0) await writeFile(target, encodePng(result.diff));
    return {
      status: result.different === 0 ? 'SAME' : 'DIFFERENT',
      difference: result.ratio,
      ...(target && result.different > 0 ? { diffImage: target } : {}),
      reason: `${String(result.different)} of ${String(result.compared)} pixel(s) differ${result.sizeDiffers ? ' (sizes differ)' : ''}${this.options.masks.length > 0 ? `, ${String(this.options.masks.length)} mask(s)` : ''}`,
    };
  }
}

export interface ImageComparison {
  compared: number;
  different: number;
  /** 0..1 */
  ratio: number;
  sizeDiffers: boolean;
  diff: RgbaImage;
}

function masked(x: number, y: number, masks: readonly VisualMask[]): boolean {
  return masks.some(
    (mask) => x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height,
  );
}

/** La comparaison pure de deux images RGBA (exportée pour les tests). */
export function compareImages(
  baseline: RgbaImage,
  current: RgbaImage,
  options: Pick<PixelComparatorOptions, 'colorThreshold' | 'masks'>,
): ImageComparison {
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const diff: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
  let compared = 0;
  let different = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      if (masked(x, y, options.masks)) {
        diff.data.set([40, 40, 80, 255], target);
        continue;
      }
      compared += 1;
      const inBaseline = x < baseline.width && y < baseline.height;
      const inCurrent = x < current.width && y < current.height;
      const source = inCurrent ? (y * current.width + x) * 4 : -1;
      const pixel = inCurrent ? current.data.subarray(source, source + 4) : new Uint8Array([0, 0, 0, 255]);
      let distance = Number.POSITIVE_INFINITY;
      if (inBaseline && inCurrent) {
        const base = (y * baseline.width + x) * 4;
        distance = 0;
        for (let channel = 0; channel < 4; channel += 1)
          distance += Math.abs((baseline.data[base + channel] ?? 0) - (pixel[channel] ?? 0));
      }
      if (distance > options.colorThreshold) {
        different += 1;
        diff.data.set([255, 0, 0, 255], target);
      } else {
        // la capture courante, assombrie : le contexte des différences
        diff.data.set([(pixel[0] ?? 0) >> 2, (pixel[1] ?? 0) >> 2, (pixel[2] ?? 0) >> 2, 255], target);
      }
    }
  return {
    compared,
    different,
    ratio: compared === 0 ? 0 : Math.round((different / compared) * 10_000) / 10_000,
    sizeDiffers: baseline.width !== current.width || baseline.height !== current.height,
    diff,
  };
}
