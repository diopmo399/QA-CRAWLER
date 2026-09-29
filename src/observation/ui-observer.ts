import type { Page } from 'playwright';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { redactText, redactUrl } from '../security/redactor.js';
import { collectDomSnapshot } from './dom-snapshot.js';

/**
 * Observe l'écran courant : URL, titre, éléments interactifs (avec rôle ARIA et nom
 * accessible), formulaires, titres, fenêtres, onglets sélectionnés et un court extrait
 * de texte. Lecture seule — ne clique ni ne tape jamais.
 *
 * Point d'extension : un observateur de captures / de vision pourra plus tard enrichir
 * l'instantané sans changer l'explorateur.
 */
export class UIObserver {
  constructor(private readonly maxElements = 400) {}

  async observe(page: Page): Promise<UiSnapshot> {
    const dom = await this.readDom(page);
    const title = await page.title().catch(() => '');
    return {
      ...dom,
      url: page.url(),
      title,
      textExcerpt: redactText(dom.textExcerpt),
      elements: dom.elements.map((element) =>
        element.href ? { ...element, href: redactUrl(element.href) } : element,
      ),
      forms: dom.forms.map((form) => (form.action ? { ...form, action: redactUrl(form.action) } : form)),
    };
  }

  /**
   * Lit le DOM. Si la page navigue pendant la lecture (redirections d'une connexion
   * unique, application qui recharge sa route), le contexte d'exécution est détruit :
   * attendre que la nouvelle page soit chargée puis relire, quelques fois au plus.
   */
  private async readDom(page: Page): Promise<Awaited<ReturnType<typeof collectDomSnapshot>>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await page.evaluate(collectDomSnapshot, { maxElements: this.maxElements });
      } catch (error) {
        if (attempt >= MAX_READ_ATTEMPTS || !isNavigationError(error)) throw error;
        await page
          .waitForLoadState('domcontentloaded', { timeout: NAVIGATION_WAIT_MS })
          .catch(() => undefined);
      }
    }
  }
}

const MAX_READ_ATTEMPTS = 4;
const NAVIGATION_WAIT_MS = 10_000;

/** La page a navigué (ou navigue encore) pendant la lecture : relire a un sens. */
export function isNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context with specified id|because of a navigation|Frame was detached/i.test(
    message,
  );
}
