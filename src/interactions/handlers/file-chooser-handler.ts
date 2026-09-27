import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';

/**
 * FILE_CHOOSER : une page demande un fichier. Le sélecteur natif est intercepté (il
 * ne s'ouvre jamais) et le crawler ne choisit jamais de fichier. La politique de
 * sécurité le bloque (FILE_INPUT_REQUIRED) ; ce handler ne s'exécute que si une
 * future politique autorise un fichier fourni explicitement par la mission.
 */
export class FileChooserHandler implements BrowserInteractionHandler {
  readonly name = 'FileChooserHandler';
  readonly handles = ['FILE_CHOOSER'] as const;

  handle(): Promise<HandlerOutcome> {
    return Promise.resolve({
      status: 'BLOCKED',
      outcome: 'FILE_INPUT_REQUIRED',
      action: 'NONE',
      success: false,
      reason: 'no file provided by the mission',
    });
  }
}
