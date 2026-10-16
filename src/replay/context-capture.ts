import type { Page } from 'playwright';
import type { ContextField, ContextSnapshot } from './context-checkpoint.js';
import type { ObservedFunctionalState } from './model.js';

/**
 * LA CAPTURE DU CONTEXTE dans la page (Playwright) : URL complète, route, cadres, onglets, dialogue,
 * overlay, défilement, champs (libellé, rempli, coché ; la valeur seulement pour un champ non
 * sensible et court), lignes sélectionnées. Lecture seule, bornée, sans aucune valeur sensible.
 */
const SENSITIVE =
  /(pass(word|wd)?|mot ?de ?passe|secret|token|jeton|otp|pin\b|cvv|card|carte|iban|ssn|nas\b|nip\b)/i;

export async function captureContextSnapshot(
  page: Page,
  functional?: ObservedFunctionalState,
): Promise<ContextSnapshot | undefined> {
  if (page.isClosed()) return undefined;
  try {
    const raw = await page.evaluate((sensitivePattern: string) => {
      const sensitive = new RegExp(sensitivePattern, 'i');
      const clean = (value: string | null | undefined, max: number): string =>
        (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelOf = (element: Element): string => {
        const aria = element.getAttribute('aria-label');
        if (aria) return clean(aria, 60);
        const id = element.getAttribute('id');
        const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (forLabel) return clean(forLabel.textContent, 60);
        const wrapping = element.closest('label');
        if (wrapping) return clean(wrapping.textContent, 60);
        return clean(element.getAttribute('placeholder') ?? element.getAttribute('name'), 60);
      };
      const fields = Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((element) => visible(element))
        .slice(0, 60)
        .map((element) => {
          const input = element as HTMLInputElement;
          const type = (input.getAttribute('type') ?? '').toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'button') return undefined;
          const key = labelOf(element);
          if (!key) return undefined;
          const kind =
            element.tagName === 'SELECT'
              ? 'select'
              : type === 'checkbox'
                ? 'checkbox'
                : type === 'radio'
                  ? 'radio'
                  : element.tagName === 'TEXTAREA' ||
                      ['', 'text', 'search', 'email', 'tel', 'number', 'url', 'date'].includes(type)
                    ? 'text'
                    : 'other';
          const secret = type === 'password' || sensitive.test(key) || sensitive.test(input.name);
          const value = kind === 'checkbox' || kind === 'radio' ? '' : clean(input.value, 80);
          return {
            key,
            kind,
            filled: kind === 'checkbox' || kind === 'radio' ? input.checked : value !== '',
            ...(kind === 'checkbox' || kind === 'radio' ? { checked: input.checked } : {}),
            sensitive: secret,
            ...(!secret && value && kind !== 'other' ? { value } : {}),
          };
        })
        .filter((field) => field !== undefined);
      const dialog = Array.from(
        document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'),
      ).find((element) => visible(element));
      const dialogName = dialog
        ? clean(
            dialog.getAttribute('aria-label') ??
              dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent,
            60,
          )
        : '';
      const overlay = Array.from(document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')).find(
        (element) => visible(element),
      );
      const url = new URL(location.href);
      return {
        href: url.href,
        path: url.pathname,
        query: Object.fromEntries(
          Array.from(url.searchParams.entries())
            .slice(0, 30)
            .map(([key, value]) => [key, clean(value, 80)]),
        ),
        fragment: url.hash.replace(/^#/, '').slice(0, 120),
        title: clean(document.title, 80),
        activeTabs: Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
          .slice(0, 10)
          .map((element) => clean(element.textContent, 60))
          .filter(Boolean),
        dialog: dialogName || (dialog ? 'dialog' : ''),
        overlay: overlay
          ? clean(overlay.getAttribute('aria-label') ?? overlay.tagName.toLowerCase(), 40)
          : '',
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        fields,
        selectedRows: Array.from(
          document.querySelectorAll('tr[aria-selected="true"], [role="row"][aria-selected="true"]'),
        )
          .slice(0, 10)
          .map((row) => clean(row.querySelector('td, [role="cell"], [role="gridcell"]')?.textContent, 60))
          .filter(Boolean),
        historyLength: history.length,
        // Les contrôles visibles (rôle:nom) : les préconditions de l'étape se vérifient dessus.
        controls: Array.from(
          document.querySelectorAll(
            'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="checkbox"], input[type="radio"]',
          ),
        )
          .filter((element) => visible(element))
          .slice(0, 120)
          .map((element) => {
            const tag = element.tagName.toLowerCase();
            const type = (element.getAttribute('type') ?? '').toLowerCase();
            const role =
              element.getAttribute('role') ??
              (tag === 'a'
                ? 'link'
                : tag === 'button'
                  ? 'button'
                  : type === 'checkbox'
                    ? 'checkbox'
                    : type === 'radio'
                      ? 'radio'
                      : tag);
            const name = clean(
              element.getAttribute('aria-label') ?? (element.textContent || labelOf(element)),
              60,
            );
            const disabled =
              (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
            return { control: `${role}:${name}`, disabled };
          })
          .filter((entry) => !entry.control.endsWith(':')),
      };
    }, SENSITIVE.source);
    const frames = page
      .frames()
      .filter((frame) => frame !== page.mainFrame() && /^https?:/.test(frame.url()))
      .map((frame) => new URL(frame.url()).pathname)
      .slice(0, 10);
    return {
      capturedAt: new Date().toISOString(),
      location: {
        href: raw.href,
        path: raw.path,
        query: raw.query,
        fragment: raw.fragment,
        route: raw.path,
        title: raw.title,
      },
      frames,
      activeTabs: raw.activeTabs,
      ...(raw.dialog ? { dialog: raw.dialog } : {}),
      ...(raw.overlay ? { overlay: raw.overlay } : {}),
      scroll: raw.scroll,
      fields: raw.fields as ContextField[],
      selectedRows: raw.selectedRows,
      historyLength: raw.historyLength,
      functional: {
        route: raw.path,
        controls: raw.controls.map((entry) => entry.control),
        enabledControls: raw.controls.filter((entry) => !entry.disabled).map((entry) => entry.control),
        fields: raw.fields.map((field) => field.key),
        selectedTabs: raw.activeTabs,
        ...(raw.dialog ? { dialog: raw.dialog } : {}),
        ...(raw.overlay ? { overlay: raw.overlay } : {}),
        ...functional,
      },
    };
  } catch {
    return undefined;
  }
}
