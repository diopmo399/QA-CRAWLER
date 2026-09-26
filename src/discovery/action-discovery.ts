import type { Page } from 'playwright';
import type { DiscoveredAction, RawAction } from '../model/discovered-action.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import { redactUrl } from '../security/redactor.js';

/**
 * Elements considered interactive. The index of an element in
 * `page.locator(ACTION_SELECTOR)` identifies it for later execution.
 */
export const ACTION_SELECTOR = [
  'a[href]',
  'button',
  '[role="button"]',
  '[routerlink]',
  '[ng-reflect-router-link]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
].join(', ');

/**
 * Inventories the interactive elements of a page and classifies each one
 * with the SafetyPolicy. Discovery only reads the DOM: nothing is clicked here.
 */
export class ActionDiscovery {
  constructor(
    private readonly safetyPolicy: SafetyPolicy,
    private readonly maxRecorded: number,
  ) {}

  async discover(page: Page): Promise<DiscoveredAction[]> {
    const raw = await extractRawActions(page, this.maxRecorded);
    return raw.map((action) => {
      const safeAction: RawAction = action.href ? { ...action, href: redactUrl(action.href) } : action;
      return this.safetyPolicy.withClassification(safeAction);
    });
  }
}

/** Runs in the browser; must stay self-contained (no references to module-level code). */
async function extractRawActions(page: Page, max: number): Promise<RawAction[]> {
  return page.evaluate(
    ({ selector, limit }: { selector: string; limit: number }) => {
      const results: RawAction[] = [];
      const seen = new Set<string>();
      const elements = Array.from(document.querySelectorAll(selector));

      elements.forEach((element, index) => {
        if (results.length >= limit) return;
        const el = element as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const inputType = (el.getAttribute('type') ?? (tag === 'button' ? 'submit' : '')).toLowerCase();
        const routerLink =
          el.getAttribute('routerlink') ?? el.getAttribute('ng-reflect-router-link') ?? undefined;

        let type: RawAction['type'];
        if (tag === 'a') type = 'link';
        else if (tag === 'select') type = 'select';
        else if (tag === 'textarea') type = 'textarea';
        else if (tag === 'input') {
          type = ['submit', 'button', 'reset', 'image'].includes(inputType) ? 'button' : 'input';
        } else if (tag === 'button' || el.getAttribute('role') === 'button') type = 'button';
        else if (routerLink !== undefined) type = 'router-link';
        else type = 'button';

        // Never read the value of data-entry fields (could be a password); only button labels.
        const isButtonInput = tag === 'input' && type === 'button';
        const labelFromFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const rawText =
          el.getAttribute('aria-label') ||
          (type === 'input' || type === 'select' || type === 'textarea'
            ? (labelFromFor as HTMLElement | null)?.innerText || el.closest('label')?.innerText || ''
            : el.innerText) ||
          (isButtonInput ? (el as HTMLInputElement).value : '') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('name') ||
          '';
        const text = rawText.replace(/\s+/g, ' ').trim().slice(0, 120);

        const form = el.closest('form');
        const isSubmit =
          form !== null &&
          ((tag === 'button' && inputType === 'submit') ||
            (tag === 'input' && (inputType === 'submit' || inputType === 'image')));
        const inSearchForm =
          form !== null &&
          (form.getAttribute('role') === 'search' ||
            ((form.getAttribute('method') ?? 'get').toLowerCase() === 'get' &&
              form.querySelector('input[type="search"], input[name="q"], input[name="search"]') !== null));

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        const disabled =
          // .disabled only exists on form controls
          ('disabled' in el && (el as HTMLButtonElement).disabled) ||
          el.getAttribute('aria-disabled') === 'true';

        const name = el.getAttribute('name') ?? undefined;
        const elementId = el.id || undefined;
        const cssHint = elementId
          ? `${tag}#${elementId}`
          : name
            ? `${tag}[name="${name}"]`
            : el.classList.length > 0
              ? `${tag}.${Array.from(el.classList).slice(0, 2).join('.')}`
              : tag;

        const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;
        const key = [type, text, href ?? '', routerLink ?? '', cssHint].join('|');
        if (seen.has(key)) return;
        seen.add(key);

        results.push({
          type,
          text,
          ...(href ? { href } : {}),
          ...(routerLink ? { routerLink } : {}),
          tagName: tag,
          ...(inputType ? { inputType } : {}),
          ...(name ? { name } : {}),
          ...(elementId ? { elementId } : {}),
          selector: cssHint,
          index,
          visible,
          disabled,
          isSubmit,
          inSearchForm,
        });
      });
      return results;
    },
    { selector: ACTION_SELECTOR, limit: max },
  );
}
