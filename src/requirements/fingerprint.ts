import { createHash } from 'node:crypto';

/**
 * EMPREINTES ET SIMILARITÉ. L'empreinte d'un texte ignore la casse, les accents, la ponctuation et
 * les espaces : une remise en forme de la source n'est pas un changement. La similarité est un indice
 * de proximité des mots (Jaccard sur les mots de 3 lettres ou plus), pas une probabilité : elle
 * PROPOSE une fusion, elle ne la fait jamais.
 */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(normalizeForComparison(text)).digest('hex').slice(0, 24);
}

const words = (text: string): Set<string> =>
  new Set(
    normalizeForComparison(text)
      .split(' ')
      .filter((word) => word.length >= 3),
  );

export function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common);
}

/** Au-delà de ce seuil, deux textes sans identifiant commun sont proposés à la fusion (SIMILAR). */
export const SIMILARITY_THRESHOLD = 0.75;
