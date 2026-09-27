import type { BrowserInteractionHandler, HandlerContext, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/** JS_ALERT / JS_CONFIRM / JS_PROMPT : répondus comme l'a décidé l'InteractionPolicy. */
export class DialogHandler implements BrowserInteractionHandler {
  readonly name = 'DialogHandler';
  readonly handles = ['JS_ALERT', 'JS_CONFIRM', 'JS_PROMPT'] as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async handle(interaction: BrowserInteraction, context: HandlerContext): Promise<HandlerOutcome> {
    const native = interaction.native;
    if (native.kind !== 'dialog') {
      return { status: 'FAILED', outcome: 'ERROR', success: false, reason: 'no dialog handle' };
    }
    const answer = context.decision.dialog ?? { accept: false };
    if (!answer.accept) {
      await native.dialog.dismiss();
      return {
        status: 'HANDLED',
        outcome: 'DIALOG_DISMISSED',
        action: 'DISMISS',
        success: true,
        reason: context.decision.reason,
      };
    }
    if (interaction.type === 'JS_PROMPT') {
      const value = typeof answer.value === 'object' ? this.env[answer.value.env] : answer.value;
      if (value === undefined) {
        await native.dialog.dismiss();
        return {
          status: 'BLOCKED',
          outcome: 'PROMPT_VALUE_REQUIRED',
          action: 'DISMISS',
          success: false,
          reason: 'the prompt value comes from an environment variable that is not set',
        };
      }
      await native.dialog.accept(value);
      // La valeur elle-même n'est jamais enregistrée.
      return {
        status: 'HANDLED',
        outcome: 'PROMPT_ANSWERED',
        action: 'ACCEPT',
        success: true,
        reason: context.decision.reason,
      };
    }
    await native.dialog.accept();
    return {
      status: 'HANDLED',
      outcome: 'DIALOG_ACCEPTED',
      action: 'ACCEPT',
      success: true,
      reason: context.decision.reason,
    };
  }
}
