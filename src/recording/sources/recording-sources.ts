import type { Page } from 'playwright';
import type { RawRecordedEvent } from '../model.js';
import { CurrentRecordingSource } from './current-recording-source.js';
import { PlaywrightRecordingSource } from './playwright-recording-source.js';
import {
  consistentWithTouched,
  usableEvidence,
  type PlaywrightTargetEvidence,
} from './playwright-locator.js';
import { RecordingCoordinator, type Correlation, type CoordinatorSummary } from './recording-coordinator.js';
import type { RecordingMode, SourceObservation } from './recording-source.js';

/**
 * L'ENSEMBLE DES SOURCES d'un enregistrement, tel que le recorder le voit : la source actuelle
 * (toujours), la source Playwright (PLAYWRIGHT, HYBRID), et le coordinateur qui les corrèle.
 *
 * En CURRENT, aucun appel à Playwright n'est fait : le recorder se comporte exactement comme avant.
 */
export interface SourcesReport extends CoordinatorSummary {
  /** Le mode demandé, s'il a été ramené à CURRENT (API Playwright absente…). */
  requested?: RecordingMode;
  fallbackReason?: string;
  locators: {
    resolved: number;
    unique: number;
    unavailable: number;
    /** Gestes dont le localisateur Playwright est utilisable (unique, même élément, forme stable). */
    usable: number;
  };
}

export class RecordingSourceSet {
  private activeCoordinator: RecordingCoordinator;
  readonly current = new CurrentRecordingSource();
  private activePlaywright: PlaywrightRecordingSource | undefined;
  private requested: RecordingMode | undefined;
  private fallbackReason: string | undefined;
  private rawEvents: readonly RawRecordedEvent[] = [];
  private readonly evidence: PlaywrightTargetEvidence[] = [];
  /** Le localisateur d'un geste est connu (le panneau l'affiche en mode développeur). */
  onLocator: ((event: RawRecordedEvent, evidence: PlaywrightTargetEvidence) => void) | undefined;

  constructor(
    mode: RecordingMode,
    private readonly onEvent: (type: 'RECORDING_SOURCE', message: string) => void = () => undefined,
  ) {
    this.activeCoordinator = new RecordingCoordinator({ mode });
    this.activePlaywright = mode === 'CURRENT' ? undefined : new PlaywrightRecordingSource();
  }

  get coordinator(): RecordingCoordinator {
    return this.activeCoordinator;
  }

  get playwright(): PlaywrightRecordingSource | undefined {
    return this.activePlaywright;
  }

  get mode(): RecordingMode {
    return this.coordinator.mode;
  }

  /** Démarre les sources sur la page observée ; ramène à CURRENT si Playwright ne peut pas servir. */
  async start(page: Page, rawEvents: readonly RawRecordedEvent[], now: () => number): Promise<void> {
    this.rawEvents = rawEvents;
    const emit = (observation: SourceObservation): void => {
      this.decide(observation);
    };
    await this.current.start({ page, emit, now });
    if (!this.playwright) return;
    const support = this.playwright.available(page);
    if (!support.ok) {
      this.requested = this.mode;
      this.fallbackReason = support.reason;
      this.activePlaywright = undefined;
      this.activeCoordinator = new RecordingCoordinator({ mode: 'CURRENT' });
      this.onEvent(
        'RECORDING_SOURCE',
        `Playwright recording unavailable (${support.reason}): CURRENT is used`,
      );
      return;
    }
    await this.playwright.start({ page, emit, now });
    this.onEvent(
      'RECORDING_SOURCE',
      `recording sources: ${this.coordinator.sources.join(' + ')} (${this.mode})`,
    );
  }

  async stop(): Promise<void> {
    await this.playwright?.stop();
    await this.current.stop();
  }

  /** Un événement brut vient d'être capté par le recorder actuel. */
  observeRaw(event: RawRecordedEvent): void {
    this.current.observe(event);
  }

  /**
   * PLAYWRIGHT, HYBRID : le localisateur Playwright de l'élément réellement touché, posé sur
   * l'élément de l'événement (avant la validation de la cible). Jamais en CURRENT.
   */
  async resolve(page: Page, event: RawRecordedEvent, ref: string | undefined): Promise<void> {
    const playwright = this.playwright;
    const element = event.element;
    if (!playwright || !element || event.noise || !ref) return;
    let evidence = await playwright.resolveTarget(page, ref, {
      type: 'click',
      at: event.at,
      page: event.url,
      rawEventId: event.id,
      allowText: event.type === 'click' || event.type === 'submit',
    });
    // Playwright lit la page APRÈS le geste : son localisateur doit décrire l'élément tel que le
    // recorder l'a capturé AVANT (sinon il ne serait plus retrouvé au rejeu).
    if (evidence.target && !consistentWithTouched(evidence.target, element)) {
      const { target: _changed, quality: _quality, ...rest } = evidence;
      evidence = {
        ...rest,
        reason:
          'does not describe the element as captured before the gesture (Playwright reads the page after the action)',
      };
    }
    this.evidence.push(evidence);
    element.playwright = { ...evidence, mode: this.mode === 'PLAYWRIGHT' ? 'PLAYWRIGHT' : 'HYBRID' };
    this.onLocator?.(event, evidence);
    this.onEvent(
      'RECORDING_SOURCE',
      `${event.id} playwright locator ${evidence.locator ?? '-'} (${evidence.status}${
        evidence.matchCount !== undefined ? `, ${String(evidence.matchCount)} match(es)` : ''
      }${evidence.sameElement === false ? ', another element' : ''}${evidence.reason ? `, ${evidence.reason}` : ''})`,
    );
  }

  report(): SourcesReport {
    return {
      ...this.coordinator.summary(),
      ...(this.requested ? { requested: this.requested } : {}),
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      locators: {
        resolved: this.evidence.filter((entry) => entry.status === 'RESOLVED').length,
        unique: this.evidence.filter((entry) => entry.matchCount === 1 && entry.sameElement).length,
        unavailable: this.evidence.filter((entry) => entry.status === 'UNAVAILABLE').length,
        usable: this.evidence.filter((entry) => usableEvidence(entry)).length,
      },
    };
  }

  private decide(observation: SourceObservation): void {
    const decision = this.coordinator.observe(observation);
    if (decision.kind === 'REJECTED') {
      this.onEvent('RECORDING_SOURCE', `${observation.id} rejected: ${decision.reason ?? ''}`);
      return;
    }
    if (decision.correlation) this.annotate(decision.correlation);
  }

  /** Le geste vu par les deux sources : UNE action, les références des deux gardées sur l'événement brut. */
  private annotate(correlation: Correlation): void {
    const raw = this.rawEvents.find(
      (event) => event.id === correlation.primary || event.id === correlation.duplicate,
    );
    if (!raw) return;
    const other = raw.id === correlation.primary ? correlation.duplicate : correlation.primary;
    raw.sources = ['current', 'playwright'];
    raw.correlatedWith = other;
    this.onEvent(
      'RECORDING_SOURCE',
      `${correlation.primary} ≡ ${correlation.duplicate}: same user action (${correlation.evidence.join(', ')}) — one action kept`,
    );
  }
}
