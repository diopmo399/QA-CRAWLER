import type { Page } from 'playwright';
import type { Severity } from '../model/issue.js';
import { redactText } from '../security/redactor.js';

/** Basic checks, from the DOM alone. Not an audit: a first signal, to confirm with a dedicated tool. */
export const ACCESSIBILITY_RULES = [
  'field-without-name',
  'button-without-name',
  'image-link-without-alt',
  'image-without-alt',
  'duplicate-id',
  'not-focusable',
  'keyboard-trap',
  'no-keyboard-focus',
] as const;
export type AccessibilityRule = (typeof ACCESSIBILITY_RULES)[number];

export interface AccessibilityFinding {
  rule: AccessibilityRule;
  severity: Severity;
  message: string;
  count: number;
  /** Up to 3 elements, described by tag, id, name or visible text — never a field value. */
  examples: string[];
}

export interface AccessibilityOptions {
  rules: readonly AccessibilityRule[];
  /** Also walk the page with Tab (focus moves, no trap). */
  keyboardNavigation: boolean;
  maxTabs: number;
}

const SEVERITY: Record<AccessibilityRule, Severity> = {
  'field-without-name': 'WARNING',
  'button-without-name': 'WARNING',
  'image-link-without-alt': 'WARNING',
  'image-without-alt': 'INFO',
  'duplicate-id': 'INFO',
  'not-focusable': 'WARNING',
  'keyboard-trap': 'WARNING',
  'no-keyboard-focus': 'WARNING',
};

const MESSAGE: Record<AccessibilityRule, string> = {
  'field-without-name': 'form field(s) without accessible name (label, aria-label)',
  'button-without-name': 'button(s) without accessible name',
  'image-link-without-alt': 'link(s) showing only an image without alternative text',
  'image-without-alt': 'image(s) without alt attribute',
  'duplicate-id': 'id(s) used by several elements',
  'not-focusable': 'clickable element(s) not reachable with the keyboard (no tabindex)',
  'keyboard-trap': 'keyboard focus stays stuck on one element',
  'no-keyboard-focus': 'no element receives the focus with Tab',
};

/** "Accessibility: 2 button(s) without accessible name (button#close, …)" */
function messageOf(finding: RawFinding): string {
  const counted = finding.rule !== 'keyboard-trap' && finding.rule !== 'no-keyboard-focus';
  const examples = finding.examples.length > 0 ? ` (${finding.examples.join(', ')})` : '';
  return redactText(
    `Accessibility: ${counted ? `${finding.count} ` : ''}${MESSAGE[finding.rule]}${examples}`,
  );
}

interface RawFinding {
  rule: AccessibilityRule;
  examples: string[];
  count: number;
}

/**
 * Runs inside the browser (serialized by Playwright): self-contained, no
 * imports. Reads attributes and visible text only, never a field value.
 */
export function collectAccessibility(): RawFinding[] {
  const findings: Record<string, { count: number; examples: string[] }> = {};
  const add = (rule: string, element: Element): void => {
    const entry = findings[rule] ?? { count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < 3) {
      const id = element.id ? `#${element.id}` : '';
      const name = element.getAttribute('name');
      const text = element.textContent.replace(/\s+/g, ' ').trim().slice(0, 30);
      const isField = /^(input|select|textarea)$/i.test(element.tagName);
      entry.examples.push(
        `${element.tagName.toLowerCase()}${id}${name ? `[name=${name}]` : ''}${!isField && text ? ` "${text}"` : ''}`,
      );
    }
    findings[rule] = entry;
  };
  const visible = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (ids: string | null): string =>
    (ids ?? '')
      .split(/\s+/)
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
      .join(' ')
      .trim();
  const named = (element: Element): boolean =>
    Boolean(
      element.getAttribute('aria-label')?.trim() ||
      textOf(element.getAttribute('aria-labelledby')) ||
      element.getAttribute('title')?.trim(),
    );

  for (const field of Array.from(document.querySelectorAll('input, select, textarea'))) {
    const type = (field.getAttribute('type') ?? '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || !visible(field)) continue;
    const labelled =
      named(field) ||
      Boolean(field.closest('label')?.textContent.trim()) ||
      (field.id !== '' &&
        Array.from(document.querySelectorAll('label')).some(
          (label) => label.htmlFor === field.id && Boolean(label.textContent.trim()),
        ));
    if (!labelled) add('field-without-name', field);
  }

  const buttons = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
  for (const button of Array.from(document.querySelectorAll(buttons))) {
    if (!visible(button)) continue;
    const text = button.textContent.trim();
    const value = button instanceof HTMLInputElement ? button.value.trim() : '';
    const imageAlt = Array.from(button.querySelectorAll('img[alt], svg[aria-label]')).some((image) =>
      Boolean((image.getAttribute('alt') ?? image.getAttribute('aria-label') ?? '').trim()),
    );
    if (!text && !value && !imageAlt && !named(button)) add('button-without-name', button);
  }

  for (const link of Array.from(document.querySelectorAll('a[href]'))) {
    if (!visible(link) || link.textContent.trim() || named(link)) continue;
    const images = Array.from(link.querySelectorAll('img'));
    if (images.length > 0 && !images.some((image) => (image.getAttribute('alt') ?? '').trim()))
      add('image-link-without-alt', link);
  }

  for (const image of Array.from(document.querySelectorAll('img:not([alt])'))) {
    if (visible(image) && !image.closest('a[href]') && !named(image)) add('image-without-alt', image);
  }

  const ids = new Map<string, Element[]>();
  for (const element of Array.from(document.querySelectorAll('[id]'))) {
    if (!element.id) continue;
    ids.set(element.id, [...(ids.get(element.id) ?? []), element]);
  }
  for (const elements of ids.values()) {
    const first = elements[0];
    if (elements.length > 1 && first) add('duplicate-id', first);
  }

  const natural = /^(a|button|input|select|textarea|summary|iframe)$/i;
  const clickable =
    '[onclick], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]';
  for (const element of Array.from(document.querySelectorAll(clickable))) {
    if (!visible(element) || natural.test(element.tagName) || element.hasAttribute('tabindex')) continue;
    if (element.closest('a[href], button')) continue;
    if ((element as HTMLElement).isContentEditable) continue;
    add('not-focusable', element);
  }

  return Object.entries(findings).map(([rule, entry]) => ({
    rule: rule as AccessibilityRule,
    count: entry.count,
    examples: entry.examples,
  }));
}

/**
 * ACCESSIBILITY: basic checks on each new screen (missing names, image
 * links without alternative text, duplicate ids, clickable elements the
 * keyboard cannot reach) and, optionally, a walk with the Tab key.
 */
export class AccessibilityChecker {
  constructor(private readonly options: AccessibilityOptions) {}

  async check(page: Page): Promise<AccessibilityFinding[]> {
    const raw = await page.evaluate(collectAccessibility).catch(() => [] as RawFinding[]);
    if (this.options.keyboardNavigation) raw.push(...(await this.keyboardWalk(page)));
    return raw
      .filter((finding) => this.options.rules.includes(finding.rule))
      .map((finding) => ({
        ...finding,
        severity: SEVERITY[finding.rule],
        message: messageOf(finding),
      }));
  }

  /** Presses Tab and follows the focus: does it move, and does it get stuck? */
  private async keyboardWalk(page: Page): Promise<RawFinding[]> {
    const focused = (): Promise<string> =>
      page
        .evaluate(() => {
          const element = document.activeElement;
          if (!element || element === document.body) return '';
          return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}|${Array.from(
            element.parentElement?.children ?? [],
          ).indexOf(element)}|${element.getAttribute('name') ?? ''}`;
        })
        .catch(() => '');
    const hasFocusable = await page
      .evaluate(() =>
        Array.from(
          document.querySelectorAll(
            'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).some((element) => element.getClientRects().length > 0),
      )
      .catch(() => false);
    if (!hasFocusable) return [];
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => undefined);
    const seen: string[] = [];
    let stuck = 0;
    for (let index = 0; index < this.options.maxTabs; index++) {
      await page.keyboard.press('Tab').catch(() => undefined);
      const current = await focused();
      stuck = current !== '' && current === seen[seen.length - 1] ? stuck + 1 : 0;
      seen.push(current);
      if (stuck >= 2) break;
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => undefined);
    const distinct = new Set(seen.filter(Boolean));
    if (distinct.size === 0) return [{ rule: 'no-keyboard-focus', count: 1, examples: [] }];
    if (stuck >= 2) {
      const element = seen[seen.length - 1]?.split('|')[0] ?? '';
      return [{ rule: 'keyboard-trap', count: 1, examples: element ? [element] : [] }];
    }
    return [];
  }
}
