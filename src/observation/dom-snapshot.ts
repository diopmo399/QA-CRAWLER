import type { DiscoveredForm } from '../model/discovered-action.js';
import type { UiElement, UiSnapshot } from '../model/ui-snapshot.js';

export type DomSnapshot = Omit<UiSnapshot, 'url' | 'title'>;

/**
 * Runs inside the browser (serialized by Playwright): it must stay
 * self-contained — no imports, no references to module-level code.
 *
 * Reads the DOM and computes, for each interactive element, its ARIA role
 * and an approximation of its accessible name (the same notions Playwright's
 * getByRole uses). Field values are never read.
 */
export function collectDomSnapshot(options: { maxElements: number }): DomSnapshot {
  // Set by the flow runner on the element an imposed step targets (see FlowStepExecutor).
  const FLOW_TARGET_ATTRIBUTE = 'data-qa-flow-target';
  const CANDIDATES = [
    'a[href]',
    'button',
    'summary',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="option"]',
    '[routerlink]',
    '[ng-reflect-router-link]',
    '[onclick]',
    '[tabindex="0"]',
  ].join(', ');
  const FIELD_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

  const clean = (value: string | null | undefined, max = 120): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  /** Text used for accessible names: text nodes, skipping aria-hidden/hidden subtrees (no CSS text-transform). */
  const nameText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    if (el.getAttribute('aria-hidden') === 'true') return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return '';
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    if (tag === 'img') return ` ${el.getAttribute('alt') ?? ''} `;
    const block = style.display !== 'inline' && style.display !== 'inline-block' ? ' ' : '';
    return (
      block +
      Array.from(el.childNodes)
        .map((child) => nameText(child))
        .join('') +
      block
    );
  };

  const labelOf = (el: Element): string => {
    const id = el.getAttribute('id');
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapping = el.closest('label');
    return clean(byFor ? nameText(byFor) : wrapping ? nameText(wrapping) : '');
  };

  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['', 'text', 'email', 'tel', 'url', 'password'].includes(type)) return 'textbox';
      return '';
    }
    return '';
  };

  const accessibleName = (el: Element, role: string): string => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return clean(ariaLabel);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((ref) => {
          const target = document.getElementById(ref);
          return target ? nameText(target) : '';
        })
        .join(' ');
      if (text.trim()) return clean(text);
    }
    const tag = el.tagName.toLowerCase();
    if (
      [
        'textbox',
        'searchbox',
        'combobox',
        'listbox',
        'spinbutton',
        'checkbox',
        'radio',
        'slider',
        'switch',
      ].includes(role) &&
      tag !== 'button'
    ) {
      const label = labelOf(el);
      if (label) return label;
      return clean(el.getAttribute('title') ?? el.getAttribute('placeholder'));
    }
    if (tag === 'input')
      return clean((el as HTMLInputElement).value || el.getAttribute('alt') || el.getAttribute('title'));
    const text = clean(nameText(el));
    if (text) return text;
    const img = el.querySelector('img[alt], svg[aria-label]');
    return clean(img?.getAttribute('alt') ?? img?.getAttribute('aria-label') ?? el.getAttribute('title'));
  };

  const cssPath = (el: Element): string => {
    const id = el.getAttribute('id');
    if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
        : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
      const parentId = parent?.getAttribute('id');
      if (parentId && document.querySelectorAll(`#${CSS.escape(parentId)}`).length === 1) {
        parts.unshift(`#${CSS.escape(parentId)}`);
        break;
      }
      current = parent;
    }
    return parts.join(' > ');
  };

  const dialogNameOf = (el: Element): string | undefined => {
    const dialog = el.closest('[role="dialog"], [role="alertdialog"], dialog');
    if (!dialog) return undefined;
    const heading = dialog.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
    return clean(dialog.getAttribute('aria-label') ?? heading?.innerText ?? '') || 'dialog';
  };

  const forms = Array.from(document.querySelectorAll('form'));
  const searchForm = (form: HTMLFormElement | null): boolean =>
    form !== null &&
    (form.getAttribute('role') === 'search' ||
      ((form.getAttribute('method') ?? 'get').toLowerCase() === 'get' &&
        form.querySelector('input[type="search"], input[name="q"], input[name="search"]') !== null));

  // ---- foreground: what is in front of the screen (modal, drawer, open menu, cookie banner…)
  const LAYERS =
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane, [role="menu"], [role="listbox"]';
  // A menu or listbox is in front only when it floats (dropdown), not when it is part of the page (sidebar).
  const floating = (el: Element): boolean => {
    let current: Element | null = el;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const position = window.getComputedStyle(current).position;
      if (position === 'fixed' || position === 'absolute') return true;
    }
    return false;
  };
  const layers = Array.from(document.querySelectorAll(LAYERS)).filter(
    (el) =>
      isVisible(el) &&
      el.querySelector(CANDIDATES) !== null &&
      !el.parentElement?.closest(LAYERS) &&
      (!el.matches('[role="menu"], [role="listbox"]') || floating(el)),
  );
  // A layer that takes the pointer from the page behind: an aria-modal/<dialog> modal, or a
  // fixed/absolute layer covering most of the viewport whatever its markup (backdrop + box).
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const coveringLayer = (): Element | undefined => {
    const points: [number, number][] = [
      [0.5, 0.5],
      [0.5, 0.3],
      [0.5, 0.7],
    ];
    for (const [x, y] of points) {
      let hit = document.elementFromPoint(window.innerWidth * x, window.innerHeight * y);
      let covering: Element | undefined;
      while (hit && hit !== document.body && hit !== document.documentElement) {
        const position = window.getComputedStyle(hit).position;
        const rect = hit.getBoundingClientRect();
        if (
          (position === 'fixed' || position === 'absolute') &&
          (rect.width * rect.height) / viewportArea >= 0.6
        )
          covering = hit; // keep the outermost one: the backdrop's container holds the box
        hit = hit.parentElement;
      }
      if (covering && covering.querySelector(CANDIDATES) !== null) return covering;
    }
    return undefined;
  };
  const modal =
    layers.find((el) => el.matches('[aria-modal="true"], dialog[open]:modal, [role="alertdialog"]')) ??
    coveringLayer();
  if (modal && !layers.includes(modal)) layers.push(modal);
  const foregroundOf = (el: Element): boolean => layers.some((layer) => layer.contains(el));
  const overlayName = (el: Element): string => {
    const heading = el.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
    return clean(el.getAttribute('aria-label') ?? heading?.innerText ?? '', 80) || 'overlay';
  };

  // ---- interactive elements
  const elements: UiElement[] = [];
  const all = Array.from(document.querySelectorAll(CANDIDATES));
  for (const [index, el] of all.entries()) {
    const foreground = layers.length > 0 && foregroundOf(el);
    // What is in front is always kept, even beyond maxElements (overlays are often last in the DOM).
    if (elements.length >= options.maxElements && !el.hasAttribute(FLOW_TARGET_ATTRIBUTE) && !foreground)
      continue;
    if (!isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const isField = ['input', 'select', 'textarea'].includes(tag);
    // A clickable wrapper around another candidate (e.g. <li onclick><a href>): keep the innermost element.
    if (!isField && el.matches('[onclick], [tabindex="0"]') && el.querySelector(CANDIDATES) !== null)
      continue;
    // Elements nested inside another interactive element are reached through it.
    if (
      !isField &&
      el.parentElement?.closest(
        'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
      )
    )
      continue;

    const role =
      clean(el.getAttribute('role')) ||
      implicitRole(el) ||
      (el.matches('[routerlink], [ng-reflect-router-link], [onclick], [tabindex="0"]') ? 'button' : '');
    const inputType =
      tag === 'input'
        ? (el.getAttribute('type') ?? 'text').toLowerCase()
        : tag === 'button'
          ? (el.getAttribute('type') ?? 'submit').toLowerCase()
          : undefined;
    const form = el.closest('form');
    const formIndex = form ? forms.indexOf(form) : -1;
    const html = el as HTMLElement & Partial<HTMLInputElement>;
    const isSubmit =
      form !== null &&
      ((tag === 'button' && inputType === 'submit') ||
        (tag === 'input' && (inputType === 'submit' || inputType === 'image')));
    const ariaExpanded = el.getAttribute('aria-expanded');
    const ariaSelected = el.getAttribute('aria-selected');
    const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;
    const routerLink =
      el.getAttribute('routerlink') ?? el.getAttribute('ng-reflect-router-link') ?? undefined;
    const dialogName = dialogNameOf(el);
    const label = isField ? labelOf(el) : '';
    const numberAttr = (name: string): number | undefined => {
      const value = el.getAttribute(name);
      return value !== null && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : undefined;
    };
    const attr = (name: string): string | undefined => {
      const value = el.getAttribute(name);
      return value !== null && value !== '' ? value : undefined;
    };

    const element: UiElement = {
      index,
      tag,
      role,
      name: accessibleName(el, role),
      text: isField ? '' : clean(nameText(el)),
      visible: true,
      disabled:
        ('disabled' in el && (el as HTMLButtonElement).disabled) ||
        el.getAttribute('aria-disabled') === 'true',
      readOnly: el.hasAttribute('readonly'),
      hasPopup: (el.getAttribute('aria-haspopup') ?? 'false') !== 'false',
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      isSubmit,
      inSearchForm: searchForm(form),
      formHasAction: form !== null && (form.getAttribute('action') ?? '').trim() !== '',
      inNavigation:
        el.closest('nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"]') !== null,
      inDialog: dialogName !== undefined,
      css: cssPath(el),
    };
    const optional: Partial<UiElement> = {
      label: label || undefined,
      testId:
        attr('data-testid') ??
        attr('data-test-id') ??
        attr('data-test') ??
        attr('data-qa') ??
        attr('data-cy'),
      inputType,
      fieldName: attr('name'),
      elementId: attr('id'),
      href,
      target: attr('target'),
      routerLink,
      autocomplete: attr('autocomplete'),
      placeholder: attr('placeholder'),
      checked:
        inputType === 'checkbox' || inputType === 'radio'
          ? Boolean(html.checked)
          : el.getAttribute('aria-checked') !== null
            ? el.getAttribute('aria-checked') === 'true'
            : undefined,
      selected: ariaSelected !== null ? ariaSelected === 'true' : undefined,
      expanded: ariaExpanded !== null ? ariaExpanded === 'true' : undefined,
      formIndex: formIndex >= 0 ? formIndex : undefined,
      dialogName,
      flowTarget: el.hasAttribute(FLOW_TARGET_ATTRIBUTE) ? true : undefined,
      foreground: foreground ? true : undefined,
      // Behind a modal layer: the page behind cannot receive the click.
      obscured: modal !== undefined && !foreground ? true : undefined,
      min: attr('min'),
      max: attr('max'),
      step: attr('step'),
      minLength: numberAttr('minlength'),
      maxLength: numberAttr('maxlength'),
      pattern: attr('pattern'),
      options:
        tag === 'select'
          ? Array.from((el as HTMLSelectElement).options)
              .slice(0, 30)
              .map((option) => clean(option.text))
          : undefined,
    };
    for (const [key, value] of Object.entries(optional) as [string, unknown][]) {
      if (value !== undefined) (element as unknown as Record<string, unknown>)[key] = value;
    }
    elements.push(element);
  }

  // ---- forms (structure only)
  const describeFields = (fields: Element[]): DiscoveredForm['fields'] =>
    fields.map((element) => {
      const el = element as HTMLInputElement;
      const tag = el.tagName.toLowerCase() as 'input' | 'select' | 'textarea';
      const field: DiscoveredForm['fields'][number] = {
        tag,
        type: tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag,
        required: el.required || el.getAttribute('aria-required') === 'true',
        disabled: el.disabled,
        readOnly: el.hasAttribute('readonly'),
      };
      const values: Record<string, unknown> = {
        name: el.getAttribute('name') ?? undefined,
        elementId: el.id || undefined,
        label: labelOf(el) || el.getAttribute('aria-label') || undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        min: el.getAttribute('min') ?? undefined,
        max: el.getAttribute('max') ?? undefined,
        step: el.getAttribute('step') ?? undefined,
        minLength: el.getAttribute('minlength') ? Number(el.getAttribute('minlength')) : undefined,
        maxLength: el.getAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : undefined,
        pattern: el.getAttribute('pattern') ?? undefined,
        options:
          tag === 'select'
            ? Array.from((el as unknown as HTMLSelectElement).options)
                .slice(0, 20)
                .map((option) => clean(option.text))
            : undefined,
      };
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) (field as unknown as Record<string, unknown>)[key] = value;
      }
      return field;
    });

  const formResults: DiscoveredForm[] = forms.map((form, index) => {
    const method = (form.getAttribute('method') ?? 'get').toLowerCase();
    const submit = form.querySelector<HTMLElement>(
      'button[type="submit"], button:not([type]), input[type="submit"]',
    );
    const result: DiscoveredForm = {
      index,
      method,
      isSearchForm: searchForm(form),
      fields: describeFields(
        Array.from(form.querySelectorAll(FIELD_SELECTOR)).filter((field) => isVisible(field)),
      ),
    };
    if (form.getAttribute('name')) result.name = form.getAttribute('name') ?? '';
    if (form.id) result.elementId = form.id;
    if (form.getAttribute('action')) result.action = form.action;
    if (submit) result.submitLabel = clean(submit.innerText || (submit as HTMLInputElement).value);
    return result;
  });
  const orphans = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(
    (field) => field.closest('form') === null && isVisible(field),
  );
  if (orphans.length > 0) {
    formResults.push({ index: -1, method: 'none', isSearchForm: false, fields: describeFields(orphans) });
  }

  // ---- structural signals
  const visibleTexts = (selector: string, max: number): string[] =>
    Array.from(document.querySelectorAll(selector))
      .filter((el) => isVisible(el))
      .map((el) => clean((el as HTMLElement).innerText || el.getAttribute('aria-label'), 80))
      .filter(Boolean)
      .slice(0, max);

  return {
    headings: visibleTexts('h1, h2, h3, [role="heading"]', 12),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
      .filter((el) => isVisible(el))
      .map((el) => {
        const heading = el.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
        return clean(el.getAttribute('aria-label') ?? heading?.innerText ?? 'dialog', 80);
      }),
    overlay: modal ? overlayName(modal) : undefined,
    selectedTabs: visibleTexts('[role="tab"][aria-selected="true"]', 10),
    currentItems: visibleTexts('[aria-current]:not([aria-current="false"])', 10),
    textExcerpt: clean(document.body.innerText, 600),
    elements,
    forms: formResults,
  };
}
