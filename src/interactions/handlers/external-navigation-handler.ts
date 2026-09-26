import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * EXTERNAL_NAVIGATION: the page left the allowed origins. The safety policy
 * blocks it (the crawl engine goes back); this handler records the
 * navigation if a mission ever allows it.
 */
export class ExternalNavigationHandler implements BrowserInteractionHandler {
  readonly name = 'ExternalNavigationHandler';
  readonly handles = ['EXTERNAL_NAVIGATION'] as const;

  handle(interaction: BrowserInteraction): Promise<HandlerOutcome> {
    return Promise.resolve({
      status: 'DETECTED',
      outcome: 'EXTERNAL_ORIGIN',
      action: 'RECORD',
      success: true,
      ...(interaction.targetUrl ? { targetUrl: interaction.targetUrl } : {}),
    });
  }
}
