import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * DOWNLOAD : enregistre quelle action a produit quel fichier (nom, type, taille
 * quand le serveur les a annoncés). Le contexte du navigateur refuse les
 * téléchargements : le fichier n'est jamais écrit sur le disque, encore moins ouvert ou exécuté.
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
