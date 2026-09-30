/**
 * FLOW ALIGNMENT : aligner la séquence ATTENDUE et la séquence OBSERVÉE, jamais
 * `expected[i] === observed[i]`.
 *
 * Plus longue sous-suite commune (alignement de séquences sans substitution) : les
 * paires alignées gardent l'ordre des deux côtés ; un pas observé hors de toute paire est
 * une INSERTION, un pas attendu hors de toute paire une SUPPRESSION probable. Ensuite,
 * une suppression et une insertion qui désignent la même chose forment un
 * RÉORDONNANCEMENT (l'étape existe, mais ailleurs dans l'ordre).
 *
 * Le côté observé est le chemin effectivement parcouru dans le graphe des écrans ; les
 * autres chemins du graphe (alternatives) sont portés par les pas eux-mêmes.
 */
export type AlignmentOp<E, O> =
  | { kind: 'MATCH'; expected: E; expectedIndex: number; observed: O; observedIndex: number }
  | { kind: 'INSERT'; observed: O; observedIndex: number }
  | { kind: 'DELETE'; expected: E; expectedIndex: number }
  | { kind: 'REORDER'; expected: E; expectedIndex: number; observed: O; observedIndex: number };

export function alignSequences<E, O>(
  expected: readonly E[],
  observed: readonly O[],
  match: (expected: E, observed: O) => boolean,
): AlignmentOp<E, O>[] {
  const n = expected.length;
  const m = observed.length;
  // lcs[i][j] : longueur de la plus longue sous-suite commune de expected[i..] et observed[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] ?? [];
    const below = lcs[i + 1] ?? [];
    for (let j = m - 1; j >= 0; j--) {
      const e = expected[i] as E;
      const o = observed[j] as O;
      row[j] = match(e, o) ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (match(expected[i] as E, observed[j] as O) && (lcs[i]?.[j] ?? 0) === (lcs[i + 1]?.[j + 1] ?? 0) + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }

  // Dans l'ordre observé : avant chaque paire, les attendus sautés puis les observés insérés.
  const ops: AlignmentOp<E, O>[] = [];
  let nextExpected = 0;
  let nextObserved = 0;
  const flush = (untilExpected: number, untilObserved: number): void => {
    for (; nextExpected < untilExpected; nextExpected++)
      ops.push({ kind: 'DELETE', expected: expected[nextExpected] as E, expectedIndex: nextExpected });
    for (; nextObserved < untilObserved; nextObserved++)
      ops.push({ kind: 'INSERT', observed: observed[nextObserved] as O, observedIndex: nextObserved });
  };
  for (const [i, j] of pairs) {
    flush(i, j);
    ops.push({
      kind: 'MATCH',
      expected: expected[i] as E,
      expectedIndex: i,
      observed: observed[j] as O,
      observedIndex: j,
    });
    nextExpected = i + 1;
    nextObserved = j + 1;
  }
  flush(n, m);

  // Réordonnancement : une étape attendue « manquante » retrouvée plus loin (ou plus tôt).
  const result: AlignmentOp<E, O>[] = [];
  const reordered = new Set<number>();
  for (const op of ops) {
    if (op.kind !== 'INSERT') continue;
    const deleted = ops.find(
      (candidate): candidate is Extract<AlignmentOp<E, O>, { kind: 'DELETE' }> =>
        candidate.kind === 'DELETE' &&
        !reordered.has(candidate.expectedIndex) &&
        match(candidate.expected, op.observed),
    );
    if (deleted) reordered.add(deleted.expectedIndex);
  }
  const used = new Set<number>();
  for (const op of ops) {
    if (op.kind === 'DELETE' && reordered.has(op.expectedIndex)) continue;
    if (op.kind === 'INSERT') {
      const index = [...reordered].find(
        (expectedIndex) => !used.has(expectedIndex) && match(expected[expectedIndex] as E, op.observed),
      );
      if (index !== undefined) {
        used.add(index);
        result.push({
          kind: 'REORDER',
          expected: expected[index] as E,
          expectedIndex: index,
          observed: op.observed,
          observedIndex: op.observedIndex,
        });
        continue;
      }
    }
    result.push(op);
  }
  return result;
}
