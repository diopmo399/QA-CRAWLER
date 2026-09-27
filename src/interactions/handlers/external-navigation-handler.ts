import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * EXTERNAL_NAVIGATION : la page a quitté les origines autorisées. La politique de
 * sécurité la bloque (le moteur revient en arrière) ; ce handler enregistre la
 * navigation au cas où une mission l'autoriserait un jour.
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
