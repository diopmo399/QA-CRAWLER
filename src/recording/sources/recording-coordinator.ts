import type {
  ObservationOrigin,
  RecordingMode,
  RecordingSourceId,
  SourceObservation,
} from './recording-source.js';

/**
 * LE COORDINATEUR DES SOURCES. Il reçoit les observations des sources (recorder actuel, Playwright),
 * refuse tout ce qui ne vient pas du navigateur, et corrèle les observations qui décrivent le MÊME
 * geste : une seule action par geste, les références techniques des deux sources gardées.
 *
 * Il ne crée jamais d'action : il dit, pour chaque observation, si elle est un geste nouveau ou la
 * même interaction qu'une autre déjà vue.
 */
export interface Correlation {
  /** L'observation retenue (la première vue) et celle qui la confirme. */
  primary: string;
  duplicate: string;
  sameUserAction: true;
  /** Ce qui a prouvé la correspondance. */
  evidence: string[];
}

export interface CoordinatorDecision {
  accepted: boolean;
  /** NEW : geste nouveau ; DUPLICATE : même geste qu'une observation déjà retenue ; REJECTED : refusé. */
  kind: 'NEW' | 'DUPLICATE' | 'REJECTED';
  correlation?: Correlation;
  reason?: string;
}

export interface CoordinatorSummary {
  mode: RecordingMode;
  sources: RecordingSourceId[];
  observations: Record<RecordingSourceId, number>;
  accepted: number;
  duplicates: number;
  rejected: number;
  correlations: Correlation[];
}

/** Les seules origines admises : le navigateur. */
const BROWSER_ORIGINS: ReadonlySet<ObservationOrigin> = new Set(['BROWSER_USER_EVENT', 'BROWSER_PAGE_EVENT']);
const SOURCES: ReadonlySet<RecordingSourceId> = new Set(['current', 'playwright']);

export interface CoordinatorOptions {
  mode: RecordingMode;
  /** Deux observations à plus de cet écart ne sont jamais le même geste (ms). */
  windowMs?: number;
}

export class RecordingCoordinator {
  readonly mode: RecordingMode;
  private readonly windowMs: number;
  private readonly kept: SourceObservation[] = [];
  private readonly counts: Record<RecordingSourceId, number> = { current: 0, playwright: 0 };
  private duplicates = 0;
  private rejected = 0;
  readonly correlations: Correlation[] = [];

  constructor(options: CoordinatorOptions) {
    this.mode = options.mode;
    this.windowMs = options.windowMs ?? 1500;
  }

  /** Les sources actives de ce mode. */
  get sources(): RecordingSourceId[] {
    return this.mode === 'CURRENT' ? ['current'] : ['current', 'playwright'];
  }

  /**
   * Une observation arrive. Elle est REFUSÉE si elle ne vient pas du navigateur (un flow, une
   * intention, une mémoire, une suggestion, une IA) ou d'une source inactive dans ce mode.
   */
  observe(observation: SourceObservation): CoordinatorDecision {
    if (!SOURCES.has(observation.source) || !this.sources.includes(observation.source)) {
      this.rejected += 1;
      return {
        accepted: false,
        kind: 'REJECTED',
        reason: `source ${observation.source} is not active in ${this.mode}`,
      };
    }
    if (!BROWSER_ORIGINS.has(observation.origin)) {
      this.rejected += 1;
      return {
        accepted: false,
        kind: 'REJECTED',
        reason: `origin ${observation.origin} is not the browser: a recording only holds what happened in the page`,
      };
    }
    this.counts[observation.source] += 1;
    const match = this.kept.find((kept) => sameUserAction(kept, observation, this.windowMs));
    if (match) {
      const correlation: Correlation = {
        primary: match.id,
        duplicate: observation.id,
        sameUserAction: true,
        evidence: correlationEvidence(match, observation),
      };
      this.correlations.push(correlation);
      this.duplicates += 1;
      return { accepted: true, kind: 'DUPLICATE', correlation };
    }
    this.kept.push(observation);
    // Une fenêtre glissante : rien de plus vieux que quelques gestes ne sert à corréler.
    if (this.kept.length > 200) this.kept.shift();
    return { accepted: true, kind: 'NEW' };
  }

  summary(): CoordinatorSummary {
    return {
      mode: this.mode,
      sources: this.sources,
      observations: { ...this.counts },
      accepted: this.kept.length,
      duplicates: this.duplicates,
      rejected: this.rejected,
      correlations: [...this.correlations],
    };
  }
}

/**
 * Deux observations sont le même geste si elles viennent de deux sources différentes, ont le même
 * type, la même page et le même cadre, sont proches dans le temps, et désignent la même cible.
 * Deux gestes de la MÊME source ne sont jamais fusionnés ici (deux clics réels restent deux clics).
 */
export function sameUserAction(a: SourceObservation, b: SourceObservation, windowMs = 1500): boolean {
  if (a.source === b.source) return false;
  if (a.type !== b.type || a.frame !== b.frame) return false;
  if (pageKey(a.page) !== pageKey(b.page)) return false;
  if (Math.abs(a.at - b.at) > windowMs) return false;
  // Un événement de page (navigation, popup…) : type, page et moment suffisent.
  if (a.origin === 'BROWSER_PAGE_EVENT' && b.origin === 'BROWSER_PAGE_EVENT') return true;
  return sameTarget(a, b);
}

function sameTarget(a: SourceObservation, b: SourceObservation): boolean {
  const x = a.target;
  const y = b.target;
  if (!x || !y) return false;
  if (x.domInstance && y.domInstance) return x.domInstance === y.domInstance;
  if (x.testId && y.testId) return x.testId === y.testId;
  if (x.role && y.role && x.name && y.name)
    return x.role === y.role && normalize(x.name) === normalize(y.name);
  if (x.label && y.label) return normalize(x.label) === normalize(y.label);
  return false;
}

function correlationEvidence(a: SourceObservation, b: SourceObservation): string[] {
  const evidence = [
    `type ${a.type}`,
    `page ${pageKey(a.page)}`,
    `frame ${a.frame}`,
    `Δt ${String(Math.abs(a.at - b.at))} ms`,
  ];
  const x = a.target;
  const y = b.target;
  if (x?.domInstance && x.domInstance === y?.domInstance) evidence.push(`same DOM instance ${x.domInstance}`);
  else if (x?.testId && x.testId === y?.testId) evidence.push(`same test id "${x.testId}"`);
  else if (x?.role && x.name && x.role === y?.role) evidence.push(`same ${x.role} "${x.name}"`);
  else if (x?.label) evidence.push(`same label "${x.label}"`);
  return evidence;
}

function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Le mode effectif : PLAYWRIGHT et HYBRID n'existent que si `playwrightRecording` est activé ;
 * sinon CURRENT (comportement inchangé).
 */
export function effectiveRecordingMode(settings: {
  mode: 'current' | 'playwright' | 'hybrid';
  playwrightRecording: boolean;
}): { mode: RecordingMode; warning?: string } {
  if (settings.mode === 'current') return { mode: 'CURRENT' };
  if (!settings.playwrightRecording)
    return {
      mode: 'CURRENT',
      warning: `recording.mode ${settings.mode} needs recording.playwrightRecording: true — CURRENT is used`,
    };
  return { mode: settings.mode === 'playwright' ? 'PLAYWRIGHT' : 'HYBRID' };
}
