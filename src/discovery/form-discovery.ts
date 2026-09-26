import type { Page } from 'playwright';
import type { DiscoveredForm } from '../model/discovered-action.js';
import { redactUrl } from '../security/redactor.js';

/**
 * Describes forms and their fields (type, required, min/max, lengths,
 * pattern, options) without filling or submitting anything. This is the
 * input for future validation tests (required fields, invalid email,
 * boundaries). Field values are never read.
 */
export async function discoverForms(page: Page): Promise<DiscoveredForm[]> {
  const forms = await page.evaluate(() => {
    const FIELD_SELECTOR =
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

    const describeFields = (fields: Element[]): DiscoveredForm['fields'] =>
      fields.map((element) => {
        const el = element as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
        const tag = el.tagName.toLowerCase() as 'input' | 'select' | 'textarea';
        const labelFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const label = (
          el.getAttribute('aria-label') ||
          (labelFor as HTMLElement | null)?.innerText ||
          el.closest('label')?.innerText ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        const numberAttr = (name: string): number | undefined => {
          const value = el.getAttribute(name);
          return value !== null && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : undefined;
        };
        const attr = (name: string): string | undefined => {
          const value = el.getAttribute(name);
          return value !== null && value !== '' ? value : undefined;
        };
        const field: DiscoveredForm['fields'][number] = {
          tag,
          type: tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag,
          required: el.required || el.getAttribute('aria-required') === 'true',
          disabled: el.disabled,
          readOnly: el.hasAttribute('readonly'),
        };
        const optional: Partial<DiscoveredForm['fields'][number]> = {
          name: attr('name'),
          elementId: el.id || undefined,
          label: label || undefined,
          placeholder: attr('placeholder'),
          min: attr('min'),
          max: attr('max'),
          step: attr('step'),
          minLength: numberAttr('minlength'),
          maxLength: numberAttr('maxlength'),
          pattern: attr('pattern'),
          options:
            tag === 'select'
              ? Array.from(el.options)
                  .slice(0, 20)
                  .map((option) => option.text.trim())
              : undefined,
        };
        for (const [key, value] of Object.entries(optional) as [string, unknown][]) {
          if (value !== undefined) (field as unknown as Record<string, unknown>)[key] = value;
        }
        return field;
      });

    const results: DiscoveredForm[] = [];
    Array.from(document.querySelectorAll('form')).forEach((form, index) => {
      const method = (form.getAttribute('method') ?? 'get').toLowerCase();
      const fields = describeFields(Array.from(form.querySelectorAll(FIELD_SELECTOR)));
      const submit = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
      const isSearchForm =
        form.getAttribute('role') === 'search' ||
        (method === 'get' &&
          form.querySelector('input[type="search"], input[name="q"], input[name="search"]') !== null);
      results.push({
        index,
        ...(form.getAttribute('name') ? { name: form.getAttribute('name') ?? '' } : {}),
        ...(form.id ? { elementId: form.id } : {}),
        ...(form.getAttribute('action') ? { action: form.action } : {}),
        method,
        isSearchForm,
        ...(submit
          ? {
              submitLabel: ((submit as HTMLElement).innerText || (submit as HTMLInputElement).value || '')
                .trim()
                .slice(0, 120),
            }
          : {}),
        fields,
      });
    });

    // SPA frameworks often use fields without a <form> element.
    const orphans = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(
      (el) => el.closest('form') === null,
    );
    if (orphans.length > 0) {
      results.push({ index: -1, method: 'none', isSearchForm: false, fields: describeFields(orphans) });
    }
    return results;
  });

  return forms.map((form) => (form.action ? { ...form, action: redactUrl(form.action) } : form));
}
