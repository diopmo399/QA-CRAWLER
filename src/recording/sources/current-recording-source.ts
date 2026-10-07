import type { Page } from 'playwright';
import type { RawRecordedEvent } from '../model.js';
import {
  observationOfRawEvent,
  type RecordingSource,
  type SourceContext,
  type SourceObservation,
} from './recording-source.js';

/**
 * LA SOURCE ACTUELLE : le recorder de QA-Crawler (script de capture dans la page, événements bruts).
 * Elle reste la capture des gestes ; cette classe ne fait que les présenter au coordinateur sous la
 * forme commune des sources. Elle ne change rien à ce que le recorder capte.
 */
export class CurrentRecordingSource implements RecordingSource {
  readonly id = 'current' as const;
  private context: SourceContext | undefined;

  available(_page: Page): { ok: true } {
    return { ok: true };
  }

  async start(context: SourceContext): Promise<void> {
    this.context = context;
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.context = undefined;
    await Promise.resolve();
  }

  /** Un événement brut capté par le recorder : son observation (si c'est un geste ou un événement de page). */
  observe(event: RawRecordedEvent): SourceObservation | undefined {
    const observation = observationOfRawEvent(event);
    if (observation) this.context?.emit(observation);
    return observation;
  }
}
