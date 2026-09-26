import type { BrowserInteractionHandler, HandlerContext, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * HTTP_AUTH: the browser's own sign-in dialog (Basic, NTLM…). Answered
 * through the browser protocol with credentials from the CredentialProvider;
 * never with locators, clicks, keyboard or selectors (the dialog is not in
 * the DOM). No credentials, or too many tries: the challenge is cancelled and
 * the flow is marked blocked.
 */
export class HttpAuthHandler implements BrowserInteractionHandler {
  readonly name = 'HttpAuthHandler';
  readonly handles = ['HTTP_AUTH'] as const;

  async handle(interaction: BrowserInteraction, context: HandlerContext): Promise<HandlerOutcome> {
    const native = interaction.native;
    if (native.kind !== 'http-auth') {
      return {
        status: 'FAILED',
        outcome: 'ERROR',
        success: false,
        reason: 'no authentication handle',
        blocking: true,
      };
    }
    const profile = context.decision.credentialProfile ?? '';
    if (context.attempt > context.maxAttempts) {
      await native.cancel();
      return {
        status: 'FAILED',
        outcome: 'AUTH_FAILED',
        action: 'CANCEL',
        success: false,
        credentialProfile: profile,
        blocking: true,
        reason: `credentials rejected ${context.maxAttempts} time(s): authentication cancelled (retry.maxAttempts ${context.maxAttempts})`,
      };
    }
    const credentials = await context.credentials.resolve({
      type: 'HTTP_AUTH',
      profile,
      ...(interaction.origin ? { origin: interaction.origin } : {}),
      ...(typeof interaction.details.realm === 'string' ? { realm: interaction.details.realm } : {}),
      ...(typeof interaction.details.scheme === 'string' ? { scheme: interaction.details.scheme } : {}),
    });
    if (!credentials) {
      await native.cancel();
      return {
        status: 'BLOCKED',
        outcome: 'AUTH_REQUIRED',
        action: 'CANCEL',
        success: false,
        credentialProfile: profile,
        blocking: true,
        reason: `no credentials available for profile "${profile}": nothing is invented, authentication cancelled`,
      };
    }
    await native.provideCredentials(credentials.username, credentials.password);
    return {
      status: 'HANDLED',
      outcome: 'AUTHENTICATED',
      action: 'AUTHENTICATE',
      success: true,
      credentialProfile: profile,
      ...(context.attempt > 1 ? { reason: `retry ${context.attempt}/${context.maxAttempts}` } : {}),
    };
  }
}
