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
      /** Records the page as a state; returns its id. Provided by the crawl engine. */
      inspect?: (page: Page) => Promise<string | undefined>;
    },
  ) {}

  async handle(interaction: BrowserInteraction): Promise<HandlerOutcome> {
    const native = interaction.native;
    if (native.kind !== 'page') {
      return { status: 'FAILED', outcome: 'ERROR', success: false, reason: 'no page handle' };
    }
    const targetUrl = native.page.url();
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
