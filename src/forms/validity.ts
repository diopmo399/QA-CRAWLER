import type { Locator } from 'playwright';

/**
 * Runs in the browser: is the field invalid, and which message does the
 * application show for it (mat-error, invalid-feedback, aria-errormessage…)?
 * The value itself is never read.
 */
export function readValidity(el: Element): { invalid: boolean; message: string } {
  const ERRORS =
    'mat-error, .mat-mdc-form-field-error, .mat-error, .invalid-feedback, .error-message, .field-error, [role="alert"]';
  const CONTAINER =
    'mat-form-field, .mat-mdc-form-field, .mat-form-field, .form-group, .form-field, .field, [role="radiogroup"], mat-radio-group, fieldset';
  const visible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return (rect.width > 0 || rect.height > 0) && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const text = (node: Element | null): string =>
    ((node as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const container = el.closest(CONTAINER) ?? el.parentElement;
  const described = [el.getAttribute('aria-errormessage'), el.getAttribute('aria-describedby')]
    .join(' ')
    .split(/\s+/)
    .map((id) => (id ? document.getElementById(id) : null))
    .filter((node): node is HTMLElement => node !== null && node.matches(ERRORS) && visible(node));
  const shown = [...described, ...Array.from(container?.querySelectorAll(ERRORS) ?? []).filter(visible)];
  const message = [...new Set(shown.map((node) => text(node)).filter(Boolean))].join(' ').slice(0, 160);
  const control = el as HTMLInputElement;
  const invalid =
    el.getAttribute('aria-invalid') === 'true' ||
    (typeof control.checkValidity === 'function' && !control.checkValidity()) ||
    message !== '';
  return { invalid, message: message || control.validationMessage };
}

/** Validity of a field on the page; undefined when it cannot be read. */
export async function validityOf(
  locator: Locator,
): Promise<{ invalid: boolean; message: string } | undefined> {
  return locator.evaluate(readValidity).catch(() => undefined);
}
