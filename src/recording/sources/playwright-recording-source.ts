import type { Frame, Locator, Page } from 'playwright';
import { parsePlaywrightSelector, qualityOf, type PlaywrightTargetEvidence } from './playwright-locator.js';
import type { RecordingSource, SourceContext, SourceObservation } from './recording-source.js';

/**
 * LA SOURCE PLAYWRIGHT, NON INTRUSIVE. Elle n'intercepte, ne bloque et ne rejoue aucun geste :
 *
 *   - pour chaque geste réel capté par le recorder, elle demande à Playwright SON localisateur de
 *     l'élément réellement touché (getByRole, getByLabel, getByTestId…), puis le compte dans la page
 *     et vérifie qu'il désigne bien ce même élément ;
 *   - elle observe les événements de page de Playwright (navigation, popup, dialogue, téléchargement).
 *
 * Elle ne lit jamais un flow, une mémoire, une suggestion ni une IA.
 */
const MARK = 'data-qa-crawler-pw';

/** La forme minimale de l'API de Playwright utilisée (privée : détectée au démarrage). */
interface ResolvableLocator {
  _resolveSelector?: () => Promise<{ resolvedSelector: string }>;
}

export class PlaywrightRecordingSource implements RecordingSource {
  readonly id = 'playwright' as const;
  private context: SourceContext | undefined;
  private sequence = 0;
  private tokens = 0;
  private readonly detach: (() => void)[] = [];
  /** Les preuves de localisateur produites (rapport, tests). */
  readonly evidence = new Map<string, PlaywrightTargetEvidence>();

  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  available(page: Page): { ok: true } | { ok: false; reason: string } {
    return playwrightLocatorApiAvailable(page);
  }

  async start(context: SourceContext): Promise<void> {
    this.context = context;
    const page = context.page;
    const onNavigated = (frame: Frame): void => {
      if (frame !== page.mainFrame()) return;
      this.emit({ type: 'navigation', origin: 'BROWSER_PAGE_EVENT', page: frame.url() });
    };
    const onPopup = (popup: Page): void => {
      this.emit({ type: 'popup', origin: 'BROWSER_PAGE_EVENT', page: popup.url() || page.url() });
    };
    const onDialog = (): void => {
      this.emit({ type: 'dialog', origin: 'BROWSER_PAGE_EVENT', page: page.url() });
    };
    const onDownload = (): void => {
      this.emit({ type: 'download', origin: 'BROWSER_PAGE_EVENT', page: page.url() });
    };
    page.on('framenavigated', onNavigated);
    page.on('popup', onPopup);
    page.on('dialog', onDialog);
    page.on('download', onDownload);
    this.detach.push(
      () => page.off('framenavigated', onNavigated),
      () => page.off('popup', onPopup),
      () => page.off('dialog', onDialog),
      () => page.off('download', onDownload),
    );
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    for (const undo of this.detach.splice(0)) undo();
    this.context = undefined;
    await Promise.resolve();
  }

  /**
   * Le localisateur Playwright de l'élément réellement touché (référence `ref` du recorder) :
   * lu, compté, vérifié sur le même élément. Jamais une cible devinée : sans l'élément, UNAVAILABLE.
   */
  async resolveTarget(
    page: Page,
    ref: string | undefined,
    observation: Pick<SourceObservation, 'type' | 'at' | 'page' | 'rawEventId'> & { allowText: boolean },
  ): Promise<PlaywrightTargetEvidence> {
    const started = Date.now();
    const done = (evidence: PlaywrightTargetEvidence): PlaywrightTargetEvidence => {
      const result = { ...evidence, durationMs: Date.now() - started };
      if (observation.rawEventId) this.evidence.set(observation.rawEventId, result);
      return result;
    };
    if (!ref || page.isClosed())
      return done({ status: 'UNAVAILABLE', reason: 'the touched element is gone' });
    const support = playwrightLocatorApiAvailable(page);
    if (!support.ok) return done({ status: 'UNAVAILABLE', reason: support.reason });
    this.tokens += 1;
    const token = `pw-${String(this.tokens)}`;
    try {
      const marked = await withTimeout(
        page.evaluate(
          ([key, mark, value]) => {
            const lookup = (window as unknown as Record<string, unknown>).__qaCrawlerOriginal;
            const el = typeof lookup === 'function' ? (lookup as (k: string) => Element | null)(key) : null;
            if (!el?.isConnected) return false;
            el.setAttribute(mark, value);
            return true;
          },
          [ref, MARK, token] as const,
        ),
        this.timeout(),
      );
      if (!marked) return done({ status: 'UNAVAILABLE', reason: 'the touched element is gone' });
      const anchor = page.locator(`[${MARK}="${token}"]`) as Locator & ResolvableLocator;
      const resolved = await withTimeout(
        anchor._resolveSelector?.() ?? Promise.reject(new Error('no API')),
        this.timeout(),
      );
      const selector = resolved.resolvedSelector;
      const located = page.locator(selector);
      const matches = await withTimeout(
        located.evaluateAll((elements, mark) => elements.map((el) => el.getAttribute(mark)), MARK),
        this.timeout(),
      );
      const parsed = parsePlaywrightSelector(selector);
      const sameElement = matches.length === 1 && matches[0] === token;
      // Un texte visible d'un champ saisi peut être la saisie elle-même : jamais une cible.
      const textOfField = parsed.strategy === 'text' && !observation.allowText;
      const target = sameElement && !textOfField ? parsed.target : undefined;
      return done({
        status: 'RESOLVED',
        selector,
        // Le Locator de Playwright se présente lui-même : getByRole('button', { name: 'Continuer' }).
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        locator: located.toString(),
        strategy: parsed.strategy,
        matchCount: matches.length,
        sameElement,
        ...(target ? { target, quality: qualityOf(parsed.strategy) } : {}),
        ...(sameElement
          ? textOfField
            ? { reason: 'text of an edited field: never a locator' }
            : {}
          : {
              reason:
                matches.length === 1
                  ? 'designates another element'
                  : `matches ${String(matches.length)} elements`,
            }),
      });
    } catch (error) {
      return done({
        status: 'UNAVAILABLE',
        reason: error instanceof Error ? error.message.split('\n')[0]?.slice(0, 160) : String(error),
      });
    } finally {
      await page
        .evaluate(
          ([mark, value]) => {
            for (const el of document.querySelectorAll(`[${mark}="${value}"]`)) el.removeAttribute(mark);
          },
          [MARK, token] as const,
        )
        .catch(() => undefined);
    }
  }

  private timeout(): number {
    return this.options.timeoutMs ?? 1500;
  }

  private emit(input: Pick<SourceObservation, 'type' | 'origin' | 'page'>): void {
    const context = this.context;
    if (!context) return;
    this.sequence += 1;
    context.emit({
      id: `p${String(this.sequence)}`,
      source: 'playwright',
      frame: 'main',
      at: context.now(),
      ...input,
    });
  }
}

/** L'API de localisateur de Playwright (privée) est-elle là, dans cette version ? */
export function playwrightLocatorApiAvailable(page: Page): { ok: true } | { ok: false; reason: string } {
  const probe = page.locator('html') as Locator & ResolvableLocator;
  return typeof probe._resolveSelector === 'function'
    ? { ok: true }
    : {
        ok: false,
        reason: 'this Playwright version has no locator resolution API (Locator._resolveSelector)',
      };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
