import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * DOWNLOAD: records which action produced which file (name, type, size when
 * the server announced them). The browser context refuses downloads, so the
 * file is never written to disk, let alone opened or executed.
 */
export class DownloadHandler implements BrowserInteractionHandler {
  readonly name = 'DownloadHandler';
  readonly handles = ['DOWNLOAD'] as const;

  async handle(interaction: BrowserInteraction): Promise<HandlerOutcome> {
    const native = interaction.native;
    if (native.kind !== 'download') {
      return { status: 'FAILED', outcome: 'ERROR', success: false, reason: 'no download handle' };
    }
    await native.download.cancel().catch(() => undefined);
    return {
      status: 'HANDLED',
      outcome: 'DOWNLOAD_RECORDED',
      action: 'RECORD',
      success: true,
      targetUrl: native.download.url(),
      details: { saved: false },
      reason: 'download recorded, file not saved',
    };
  }
}
