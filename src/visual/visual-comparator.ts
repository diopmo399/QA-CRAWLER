/**
 * Compare une capture avec celle que la baseline a gardée pour le même état. Aucune
 * implémentation n'est fournie : le verdict reste UNKNOWN tant qu'aucune n'est
 * branchée (différence de pixels, empreinte perceptuelle…), avec sa propre tolérance
 * et ses zones masquées.
 */
export interface VisualComparison {
  status: 'SAME' | 'DIFFERENT' | 'UNKNOWN';
  /** 0..1 : part de l'image qui a changé, quand elle est connue. */
  difference?: number;
  /** Image qui met en évidence les différences, quand elle est produite. */
  diffImage?: string;
  reason?: string;
}

export interface VisualComparator {
  readonly name: string;
  compare(baselineImage: string, currentImage: string): Promise<VisualComparison>;
}

export class NoVisualComparator implements VisualComparator {
  readonly name = 'none';

  compare(): Promise<VisualComparison> {
    return Promise.resolve({ status: 'UNKNOWN', reason: 'no visual comparator configured' });
  }
}
