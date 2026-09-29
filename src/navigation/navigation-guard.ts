import type { Page } from 'playwright';

/**
 * Ce qu'une erreur Playwright dit de la page. Seules les trois premières sont des
 * navigations : le document a changé sous la lecture, ce n'est pas un échec de l'application.
 *
 * - CONTEXT_DESTROYED : « Execution context was destroyed, most likely because of a navigation » ;
 * - FRAME_DETACHED : le cadre lu a été remplacé ou retiré ;
 * - NAVIGATION_INTERRUPTED : une navigation en a remplacé une autre (net::ERR_ABORTED…) ;
 * - PAGE_CLOSED : la page, le contexte ou le navigateur est fermé : rien à attendre ;
 * - TIMEOUT : délai dépassé ;
 * - OTHER : une erreur fonctionnelle, propagée telle quelle.
 */
export type PlaywrightErrorKind =
  'CONTEXT_DESTROYED' | 'FRAME_DETACHED' | 'NAVIGATION_INTERRUPTED' | 'PAGE_CLOSED' | 'TIMEOUT' | 'OTHER';

export interface ClassifiedError {
  kind: PlaywrightErrorKind;
  /** Une navigation a remplacé le document : attendre la nouvelle page puis relire a un sens. */
  navigation: boolean;
  message: string;
}

const PATTERNS: [PlaywrightErrorKind, RegExp][] = [
  [
    'PAGE_CLOSED',
    /Target page, context or browser has been closed|Target closed|Browser has been closed|Page closed/i,
  ],
  [
    'CONTEXT_DESTROYED',
    /Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/i,
  ],
  ['FRAME_DETACHED', /Frame was detached|frame got detached|Navigating frame was detached/i],
  ['NAVIGATION_INTERRUPTED', /interrupted by another navigation|net::ERR_ABORTED/i],
  ['TIMEOUT', /Timeout \d+ms exceeded|TimeoutError/i],
];

/** Range une erreur Playwright : navigation (récupérable), page fermée, délai, ou erreur fonctionnelle. */
export function classifyPlaywrightError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const kind = PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? 'OTHER';
  return {
    kind,
    navigation:
      kind === 'CONTEXT_DESTROYED' || kind === 'FRAME_DETACHED' || kind === 'NAVIGATION_INTERRUPTED',
    message: (message.split('\n')[0] ?? message).trim().slice(0, 300),
  };
}

/**
 * Ce qu'une opération fait au navigateur, pour décider si elle peut être rejouée après
 * une navigation. Une LECTURE (instantané du DOM, validité d'un champ) ne change rien :
 * elle peut être relue sur la nouvelle page. Une ACTION de l'utilisateur, quelle que soit
 * sa classe, n'est jamais rejouée automatiquement : si le document a changé pendant
 * qu'elle s'exécutait, elle a très probablement eu lieu (c'est elle qui a navigué).
 */
export type OperationKind = 'READ' | 'SAFE' | 'MUTATION' | 'DANGEROUS' | 'UNKNOWN';

export function mayReplayAfterNavigation(kind: OperationKind): boolean {
  return kind === 'READ';
}

export type NavigationEventType =
  'NAVIGATION_DETECTED' | 'NAVIGATION_RECOVERED' | 'NAVIGATION_RECOVERY_FAILED';

/** Un événement technique du garde de navigation : jamais une anomalie de l'application. */
export interface NavigationEvent {
  type: NavigationEventType;
  at: string;
  /** Lecture ou action en cours quand la navigation est arrivée (« dom-snapshot »…). */
  operation: string;
  reason: PlaywrightErrorKind;
  previousUrl: string;
  currentUrl: string;
  /** Lectures refaites (NAVIGATION_RECOVERED, NAVIGATION_RECOVERY_FAILED). */
  retries?: number;
  durationMs?: number;
  /** Erreur d'origine (première ligne), quand la récupération a échoué. */
  cause?: string;
  actionId?: string;
}

/** Une lecture n'a pas pu être refaite : la page n'a pas cessé de naviguer, ou elle a été fermée. */
export class NavigationRecoveryError extends Error {
  constructor(
    readonly operation: string,
    readonly original: ClassifiedError,
    readonly retries: number,
  ) {
    super(`navigation recovery failed during ${operation} after ${retries} retries: ${original.message}`);
    this.name = 'NavigationRecoveryError';
  }
}

export interface NavigationGuardOptions {
  /** Lectures au plus pour une même opération (la première comprise). */
  maxAttempts?: number;
  /** Attente au plus d'une nouvelle page utilisable (domcontentloaded), par tentative. */
  readyTimeoutMs?: number;
  onEvent?: (event: NavigationEvent) => void;
}

/** Ce qu'une action a fait au document : l'état d'avant n'est plus valable quand il a changé. */
export interface NavigationOutcome {
  navigationOccurred: boolean;
  previousUrl: string;
  currentUrl: string;
  /** Le document (ou le cadre principal) a changé : snapshot, actions et état d'avant sont périmés. */
  contextChanged: boolean;
}

/** Repère pris avant une action, pour savoir ensuite si elle a navigué. */
export interface NavigationMark {
  url: string;
  navigations: number;
}

/**
 * NAVIGATION GUARD : le seul endroit qui sait qu'une navigation n'est pas une erreur.
 *
 * - Passif quand tout va bien : il compte les navigations du cadre principal
 *   (`framenavigated` : chargement, redirection, envoi de formulaire, changement de
 *   route d'une application monopage par l'API history). Aucune attente, aucun délai.
 * - `read` : une LECTURE du document (page.evaluate…) interrompue par une navigation
 *   est abandonnée ; le garde attend que la nouvelle page soit utilisable
 *   (domcontentloaded, jamais networkidle ni pause fixe) puis relit, un nombre limité
 *   de fois. Toute autre erreur est propagée tout de suite.
 * - `outcome` : après une ACTION, dit si elle a navigué. Une action n'est jamais rejouée ici.
 */
export class NavigationGuard {
  private readonly counts = new WeakMap<Page, number>();
  private readonly maxAttempts: number;
  private readonly readyTimeoutMs: number;

  constructor(private readonly options: NavigationGuardOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  }

  /** Suit les navigations du cadre principal de la page (une seule fois par page). */
  watch(page: Page): void {
    if (this.counts.has(page)) return;
    this.counts.set(page, 0);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.counts.set(page, (this.counts.get(page) ?? 0) + 1);
    });
  }

  /** Repère à prendre juste avant une action. */
  mark(page: Page): NavigationMark {
    return { url: safeUrl(page), navigations: this.counts.get(page) ?? 0 };
  }

  /** L'action a-t-elle navigué depuis le repère (nouveau document, redirection, route SPA) ? */
  outcome(page: Page, mark: NavigationMark, error?: unknown): NavigationOutcome {
    const currentUrl = page.isClosed() ? mark.url : safeUrl(page);
    const navigated = (this.counts.get(page) ?? 0) !== mark.navigations || currentUrl !== mark.url;
    const destroyed = error !== undefined && classifyPlaywrightError(error).navigation;
    return {
      navigationOccurred: navigated || destroyed,
      previousUrl: mark.url,
      currentUrl,
      contextChanged: navigated || destroyed,
    };
  }

  /**
   * Une LECTURE du document, refaite sur la nouvelle page si une navigation l'interrompt.
   * `read` doit être sans effet (page.evaluate d'observation) : c'est ce qui permet de la rejouer.
   */
  async read<T>(page: Page, operation: string, read: () => Promise<T>, actionId?: string): Promise<T> {
    const started = Date.now();
    const previousUrl = safeUrl(page);
    let last: ClassifiedError | undefined;
    for (let attempt = 1; ; attempt++) {
      // Navigations du cadre principal vues avant cette lecture : dit si la nouvelle page a déjà remplacé l'ancienne.
      const seen = this.counts.get(page);
      try {
        const value = await read();
        if (last)
          this.emit('NAVIGATION_RECOVERED', operation, last.kind, previousUrl, page, {
            retries: attempt - 1,
            durationMs: Date.now() - started,
            actionId,
          });
        return value;
      } catch (error) {
        const classified = classifyPlaywrightError(error);
        // Une erreur réelle (même juste après une navigation récupérée) n'est jamais masquée.
        if (!classified.navigation) throw error;
        if (!last)
          this.emit('NAVIGATION_DETECTED', operation, classified.kind, previousUrl, page, { actionId });
        last = classified;
        if (attempt >= this.maxAttempts || page.isClosed()) {
          this.emit('NAVIGATION_RECOVERY_FAILED', operation, classified.kind, previousUrl, page, {
            retries: attempt - 1,
            durationMs: Date.now() - started,
            cause: classified.message,
            actionId,
          });
          throw new NavigationRecoveryError(operation, classified, attempt - 1);
        }
        await this.waitUntilUsable(page, seen);
      }
    }
  }

  /**
   * Attend que la nouvelle page soit utilisable : le DOM de son document est construit
   * (domcontentloaded). Pas de networkidle (une application monopage peut ne jamais
   * l'atteindre) ni de pause fixe : la lecture suivante vérifie elle-même la page.
   */
  async waitUntilUsable(page: Page, seen?: number): Promise<void> {
    if (page.isClosed()) return;
    // Le contexte est détruit mais le nouveau document n'est peut-être pas encore là : sans cela,
    // domcontentloaded répondrait tout de suite pour l'ancien, et la lecture suivante retomberait
    // dans la navigation en cours. Attendre l'événement (jamais une pause), brièvement.
    if (seen !== undefined && this.counts.get(page) === seen) {
      await page
        .waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: Math.min(this.readyTimeoutMs, COMMIT_WAIT_MS),
        })
        .catch(() => undefined);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: this.readyTimeoutMs }).catch(() => undefined);
  }

  private emit(
    type: NavigationEventType,
    operation: string,
    reason: PlaywrightErrorKind,
    previousUrl: string,
    page: Page,
    extra: { retries?: number; durationMs?: number; cause?: string; actionId?: string | undefined },
  ): void {
    this.options.onEvent?.({
      type,
      at: new Date().toISOString(),
      operation,
      reason,
      previousUrl,
      currentUrl: page.isClosed() ? previousUrl : safeUrl(page),
      ...(extra.retries !== undefined ? { retries: extra.retries } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
      ...(extra.actionId !== undefined ? { actionId: extra.actionId } : {}),
    });
  }
}

/** Attente au plus de l'arrivée du nouveau document quand elle n'a pas encore été vue. */
const COMMIT_WAIT_MS = 2_000;

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * Lignes de journal d'un événement : [NAVIGATION] detected / recovering / recovered,
 * [NAVIGATION_RECOVERY_FAILED] avec la cause d'origine. Les URL sont masquées par l'appelant.
 */
export function navigationLogLines(
  event: NavigationEvent,
  redact: (url: string) => string = (url) => url,
): string[] {
  const urls = `previousUrl=${redact(event.previousUrl)} currentUrl=${redact(event.currentUrl)}`;
  const reason = `reason=${reasonName(event.reason)} operation=${event.operation}`;
  switch (event.type) {
    case 'NAVIGATION_DETECTED':
      return [`[NAVIGATION] detected ${urls} ${reason}`, '[NAVIGATION] recovering'];
    case 'NAVIGATION_RECOVERED':
      return [
        '[NAVIGATION] DOM ready',
        '[NAVIGATION] snapshot invalidated',
        `[NAVIGATION] recovered ${urls} retries=${String(event.retries ?? 0)} durationMs=${String(event.durationMs ?? 0)}`,
      ];
    case 'NAVIGATION_RECOVERY_FAILED':
      return [
        `[NAVIGATION_RECOVERY_FAILED] ${urls} ${reason} retries=${String(event.retries ?? 0)} cause="${event.cause ?? ''}"`,
      ];
  }
}

function reasonName(kind: PlaywrightErrorKind): string {
  return kind === 'CONTEXT_DESTROYED'
    ? 'context-destroyed'
    : kind === 'FRAME_DETACHED'
      ? 'frame-detached'
      : kind === 'NAVIGATION_INTERRUPTED'
        ? 'navigation-interrupted'
        : kind.toLowerCase();
}
