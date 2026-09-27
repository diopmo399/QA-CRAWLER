import type { Page } from 'playwright';
import type { BrowserInteractionHandler, HandlerOutcome } from '../handler.js';
import type { BrowserInteraction } from '../types.js';

/**
 * POPUP (window.open, target=_blank avec opener) et NEW_TAB (sans opener) : la
 * nouvelle page est reliée à l'action qui l'a ouverte. Sur une origine autorisée, elle
 * est observée comme un nouvel état du graphe (un nouveau contexte d'exploration où
 * l'explorateur peut revenir par URL), puis fermée : l'exploration reste dans un seul onglet.
 */
export class PopupHandler implements BrowserInteractionHandler {
  readonly name = 'PopupHandler';
  readonly handles = ['POPUP', 'NEW_TAB'] as const;

  constructor(
    private readonly options: {
      observe: boolean;
      /** Laisser la page ouverte jusqu'à cette durée pour qu'elle termine seule (popup SSO). */
      closeAfterMs?: number;
      /** Enregistre la page comme un état ; renvoie son id. Fourni par le moteur d'exploration. */
      inspect?: (page: Page) => Promise<string | undefined>;
    },
  ) {}

  async handle(interaction: BrowserInteraction): Promise<HandlerOutcome> {
    const native = interaction.native;
    if (native.kind !== 'page') {
      return { status: 'FAILED', outcome: 'ERROR', success: false, reason: 'no page handle' };
    }
    const page = native.page;
    const wait = this.options.closeAfterMs ?? 0;
    if (wait > 0 && !page.isClosed()) {
      // par exemple SiteMinder : la popup connecte (HTTP_AUTH), puis redirige ou se ferme.
      await page.waitForEvent('close', { timeout: wait }).catch(() => undefined);
    }
    if (page.isClosed()) {
      return {
        status: 'HANDLED',
        outcome: 'POPUP_CLOSED',
        action: 'WAIT',
        success: true,
        targetUrl: interaction.targetUrl ?? '',
        details: { closedByPage: true },
        reason: 'the page closed itself',
      };
    }
    const targetUrl = page.url();
    let targetStateId: string | undefined;
    if (this.options.observe && this.options.inspect && !native.page.isClosed()) {
      targetStateId = await this.options.inspect(native.page).catch(() => undefined);
    }
    await native.page.close().catch(() => undefined);
    return {
      status: 'HANDLED',
      outcome: targetStateId ? 'POPUP_OBSERVED' : 'POPUP_CLOSED',
      action: targetStateId ? 'OBSERVE_AND_CLOSE' : 'CLOSE',
      success: true,
      targetUrl,
      ...(targetStateId ? { targetStateId } : {}),
    };
  }
}
