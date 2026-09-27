import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * PERMISSION_REQUEST (géolocalisation, notifications, caméra, micro, presse-papiers).
 * Seules les permissions listées dans browserInteractions.permissions.grant sont
 * accordées (à l'origine cible, au démarrage du contexte du navigateur) ; toute autre
 * demande est refusée par le navigateur et enregistrée comme telle.
 */
export class PermissionHandler implements BrowserInteractionHandler {
  readonly name = 'PermissionHandler';
  readonly handles = ['PERMISSION_REQUEST'] as const;

  handle(interaction: BrowserInteraction): Promise<HandlerOutcome> {
    return Promise.resolve({
      status: 'HANDLED',
      outcome: 'PERMISSION_GRANTED',
      action: 'GRANT',
      success: true,
      reason: `"${String(interaction.details.permission ?? '')}" granted by the mission`,
    });
  }
}
