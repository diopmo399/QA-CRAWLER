import type { Page } from 'playwright';
import type { RawRecordedEvent } from '../model.js';

/**
 * LES SOURCES DE CAPTURE D'UN ENREGISTREMENT. Le navigateur est la seule source de vérité : une
 * source observe ce qui s'est réellement passé dans la page, jamais ce qu'un flow, une mémoire, une
 * découverte d'actions ou une IA suggère.
 *
 *   BROWSER USER ACTION → RAW EVENT → SOURCE (current | playwright) → COORDINATOR → validation → flow
 *
 * Les modes :
 *   CURRENT     le recorder actuel seul (comportement inchangé, par défaut)
 *   PLAYWRIGHT  les événements réels du recorder ; la cible et le localisateur sont ceux de Playwright
 *   HYBRID      les deux ; le meilleur localisateur, une seule action par geste (corrélation)
 */
export type RecordingMode = 'CURRENT' | 'PLAYWRIGHT' | 'HYBRID';

export type RecordingSourceId = 'current' | 'playwright';

/**
 * L'origine d'une observation : TOUJOURS le navigateur (un geste dans la page, ou un événement de
 * la page). Aucun autre type n'existe : un flow, une intention, une mémoire, une suggestion ou une
 * IA ne peuvent pas être une observation.
 */
export type ObservationOrigin = 'BROWSER_USER_EVENT' | 'BROWSER_PAGE_EVENT';

export type ObservationType =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'key'
  | 'drag'
  | 'navigation'
  | 'popup'
  | 'dialog'
  | 'download'
  | 'page-close';

export interface SourceObservation {
  /** r42 (recorder actuel), p87 (Playwright). */
  id: string;
  source: RecordingSourceId;
  origin: ObservationOrigin;
  type: ObservationType;
  /** Horodatage (ms, horloge du recorder). */
  at: number;
  /** URL de la page (déjà expurgée). */
  page: string;
  /** Le cadre : `main` pour la page principale. */
  frame: string;
  /** L'identité de la cible (rôle + nom, libellé, test id, instance DOM) : ce qui dit « le même élément ». */
  target?: ObservationTarget;
  /** L'événement brut correspondant (source current). */
  rawEventId?: string;
}

export interface ObservationTarget {
  role?: string;
  name?: string;
  label?: string;
  testId?: string;
  /** Instance DOM attribuée par le recorder (e42) : la preuve la plus forte. */
  domInstance?: string;
  /** Le sélecteur interne de Playwright, s'il a été lu. */
  selector?: string;
}

/** Ce qu'une source reçoit pour commencer : la page observée et le recorder (événements bruts). */
export interface SourceContext {
  page: Page;
  emit: (observation: SourceObservation) => void;
  now: () => number;
}

/**
 * Une source de capture. Elle observe ; elle ne crée jamais d'action à partir d'autre chose que
 * ce qu'elle a vu dans le navigateur.
 */
export interface RecordingSource {
  readonly id: RecordingSourceId;
  /** La source peut-elle fonctionner ici (API Playwright présente) ? Sinon pourquoi. */
  available(page: Page): { ok: true } | { ok: false; reason: string };
  start(context: SourceContext): Promise<void>;
  stop(): Promise<void>;
}

/** L'observation d'un événement brut du recorder actuel (source current). */
export function observationOfRawEvent(event: RawRecordedEvent): SourceObservation | undefined {
  const type = OBSERVED_RAW_TYPES[event.type];
  if (!type) return undefined;
  const element = event.element;
  return {
    id: event.id,
    source: 'current',
    origin:
      type === 'navigation' ||
      type === 'popup' ||
      type === 'dialog' ||
      type === 'download' ||
      type === 'page-close'
        ? 'BROWSER_PAGE_EVENT'
        : 'BROWSER_USER_EVENT',
    type,
    at: event.at,
    page: event.url,
    frame: 'main',
    rawEventId: event.id,
    ...(element
      ? {
          target: {
            ...(element.role ? { role: element.role } : {}),
            ...(element.name ? { name: element.name } : {}),
            ...(element.label ? { label: element.label } : {}),
            ...(element.testId ? { testId: element.testId } : {}),
            ...(element.domInstance ? { domInstance: element.domInstance } : {}),
          },
        }
      : {}),
  };
}

const OBSERVED_RAW_TYPES: Partial<Record<RawRecordedEvent['type'], ObservationType>> = {
  click: 'click',
  input: 'input',
  change: 'change',
  submit: 'submit',
  keydown: 'key',
  drag: 'drag',
  navigation: 'navigation',
  popup: 'popup',
  dialog: 'dialog',
  download: 'download',
};
