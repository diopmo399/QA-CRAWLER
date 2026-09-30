import type { Page } from 'playwright';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { redactText, redactUrl } from '../security/redactor.js';
import { collectDomSnapshot } from './dom-snapshot.js';
import { classifyPlaywrightError, NavigationGuard } from '../navigation/navigation-guard.js';

/**
 * Observe l'écran courant : URL, titre, éléments interactifs (avec rôle ARIA et nom
 * accessible), formulaires, titres, fenêtres, onglets sélectionnés et un court extrait
 * de texte. Lecture seule — ne clique ni ne tape jamais.
 *
 * Point d'extension : un observateur de captures / de vision pourra plus tard enrichir
 * l'instantané sans changer l'explorateur.
 */
export class UIObserver {
  constructor(
    private readonly maxElements = 400,
    /** Une navigation pendant la lecture (redirection, route, envoi) : la page est relue, pas la mission arrêtée. */
    private readonly navigation: NavigationGuard = new NavigationGuard(),
  ) {}

  async observe(page: Page): Promise<UiSnapshot> {
    // Juste après une navigation (connexion, redirection), le document peut ne pas avoir encore
    // de <body> : il est attendu un court instant, puis lu quoi qu'il arrive (sans erreur).
    await page
      .waitForFunction(() => document.querySelector('body') !== null, undefined, { timeout: 3000 })
      .catch(() => undefined);
    // Une LECTURE sans effet : le garde peut la refaire sur la nouvelle page si le document change pendant qu'elle court.
    const dom = await this.navigation.read(page, 'dom-snapshot', () =>
      page.evaluate(collectDomSnapshot, { maxElements: this.maxElements }),
    );
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
}

/** La page a navigué (ou navigue encore) pendant la lecture : relire a un sens. */
export function isNavigationError(error: unknown): boolean {
  return classifyPlaywrightError(error).navigation;
}
