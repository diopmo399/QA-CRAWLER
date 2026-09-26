import type { Page } from 'playwright';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { redactText, redactUrl } from '../security/redactor.js';
import { collectDomSnapshot } from './dom-snapshot.js';

/**
 * Observes the current screen: URL, title, interactive elements (with ARIA
 * role and accessible name), forms, headings, dialogs, selected tabs and a
 * short text excerpt. Reads only — never clicks or types.
 *
 * Extension point: a screenshot/vision observer can later enrich the
 * snapshot without changing the explorer.
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
