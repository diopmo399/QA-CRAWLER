import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * PERMISSION_REQUEST (geolocation, notifications, camera, microphone,
 * clipboard). Only permissions listed in browserInteractions.permissions.grant
 * are granted (to the target origin, when the browser context starts);
 * every other request is denied by the browser and recorded as such.
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
