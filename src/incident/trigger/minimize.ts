import type { Factor } from './model.js';

/**
 * LA MINIMISATION (delta debugging) : trouver une plus petite séquence de facteurs qui conserve le défaut.
 * Chaque candidat est rejoué par l'oracle (`test`), jamais supposé ; une séquence identique n'est pas rejouée
 * deux fois (cache par clé). Les préconditions (navigation, remplissages de référence) restent hors de la
 * réduction : elles sont indispensables. Il peut exister d'autres séquences minimales : celle-ci en est une.
 */
export interface MinimizeResult<T> {
  minimal: T[];
  tests: number;
  /** Les candidats essayés et leur résultat (pour la matrice). */
  tried: { items: T[]; reproduced: boolean }[];
}

export async function ddmin<T extends { id: string }>(
  items: readonly T[],
  test: (candidate: readonly T[]) => Promise<boolean>,
  options: { maxTests?: number } = {},
): Promise<MinimizeResult<T>> {
  const maxTests = options.maxTests ?? 40;
  const cache = new Map<string, boolean>();
  const tried: MinimizeResult<T>['tried'] = [];
  let tests = 0;
  const run = async (candidate: readonly T[]): Promise<boolean> => {
    const key = candidate.map((item) => item.id).join('→');
    const known = cache.get(key);
    if (known !== undefined) return known;
    if (tests >= maxTests) return false;
    tests += 1;
    const result = await test(candidate);
    cache.set(key, result);
    tried.push({ items: [...candidate], reproduced: result });
    return result;
  };
  let current = [...items];
  let granularity = 2;
  while (current.length >= 2 && tests < maxTests) {
    const size = Math.ceil(current.length / granularity);
    const chunks: T[][] = [];
    for (let at = 0; at < current.length; at += size) chunks.push(current.slice(at, at + size));
    let reduced = false;
    // Un morceau seul reproduit-il ?
    for (const chunk of chunks) {
      if (chunk.length === current.length) continue;
      if (await run(chunk)) {
        current = chunk;
        granularity = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    // Le complément d'un morceau reproduit-il ?
    for (const chunk of chunks) {
      const complement = current.filter((item) => !chunk.includes(item));
      if (complement.length === 0 || complement.length === current.length) continue;
      if (await run(complement)) {
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }
  return { minimal: current, tests, tried };
}

/** Les facteurs d'une séquence, dans l'ordre, d'après leurs ids. */
export function factorsById(ids: readonly string[], catalog: readonly Factor[]): Factor[] {
  return ids
    .map((id) => catalog.find((factor) => factor.id === id))
    .filter((factor): factor is Factor => factor !== undefined);
}
