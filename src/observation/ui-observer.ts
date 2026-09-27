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
    const dom = await page.evaluate(collectDomSnapshot, { maxElements: this.maxElements });
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
