import type { Page } from 'playwright';
import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * POPUP (window.open, target=_blank with opener) and NEW_TAB (no opener):
 * the new page is linked to the action that opened it. On an allowed origin
 * it is observed as a new state of the flow graph (a new crawl context the
 * explorer can come back to by URL), then closed: exploration stays in one tab.
 */
export class PopupHandler implements BrowserInteractionHandler {
  readonly name = 'PopupHandler';
  readonly handles = ['POPUP', 'NEW_TAB'] as const;

  constructor(
    private readonly options: {
      observe: boolean;
      /** Leave the page open up to this long so it can finish on its own (SSO popup). */
      closeAfterMs?: number;
      /** Records the page as a state; returns its id. Provided by the crawl engine. */
      inspect?: (page: Page) => Promise<string | undefined>;
    },
  ) {}

  async handle(interaction: BrowserInteraction): Promise<HandlerOutcome> {
    const native = interaction.native;
    if (native.kind !== 'page') {
      return { status: 'FAILED', outcome: 'ERROR', success: false, reason: 'no page handle' };
    }
    const page = native.page;
    const wait = this.options.closeAfterMs ?? 0;
    if (wait > 0 && !page.isClosed()) {
      // e.g. SiteMinder: the popup signs in (HTTP_AUTH), then redirects or closes itself.
      await page.waitForEvent('close', { timeout: wait }).catch(() => undefined);
    }
    if (page.isClosed()) {
      return {
        status: 'HANDLED',
        outcome: 'POPUP_CLOSED',
        action: 'WAIT',
        success: true,
        targetUrl: interaction.targetUrl ?? '',
        details: { closedByPage: true },
        reason: 'the page closed itself',
      };
    }
    const targetUrl = page.url();
    let targetStateId: string | undefined;
    if (this.options.observe && this.options.inspect && !native.page.isClosed()) {
      targetStateId = await this.options.inspect(native.page).catch(() => undefined);
    }
    await native.page.close().catch(() => undefined);
    return {
      status: 'HANDLED',
      outcome: targetStateId ? 'POPUP_OBSERVED' : 'POPUP_CLOSED',
      action: targetStateId ? 'OBSERVE_AND_CLOSE' : 'CLOSE',
      success: true,
      targetUrl,
      ...(targetStateId ? { targetStateId } : {}),
    };
  }
}
