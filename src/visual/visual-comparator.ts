/**
 * Compares a screenshot with the one the baseline kept for the same state.
 * No implementation ships: the verdict stays UNKNOWN until one is plugged in
 * (pixel diff, perceptual hash…), with its own tolerance and masked zones.
 */
export interface VisualComparison {
  status: 'SAME' | 'DIFFERENT' | 'UNKNOWN';
  /** 0..1: share of the image that changed, when known. */
  difference?: number;
  /** Image highlighting the differences, when produced. */
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
