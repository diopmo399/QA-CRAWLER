import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';

/**
 * FILE_CHOOSER: a page asks for a file. The native chooser is intercepted
 * (it never opens) and no file is ever selected by the crawler. The safety
 * policy blocks it (FILE_INPUT_REQUIRED); this handler only runs if a future
 * policy allows a file explicitly provided by the mission.
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
