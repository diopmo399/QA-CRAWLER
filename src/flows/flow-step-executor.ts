import type { Locator, Page } from 'playwright';
import type { FlowExpectation, FlowTarget } from '../config/flow-schema.js';
import { toLocator } from '../execution/locator-resolver.js';

/** Attribute set on the targeted element so the UIObserver can recognise it (see dom-snapshot.ts). */
export const FLOW_TARGET_ATTRIBUTE = 'data-qa-flow-target';

export type FlowElementAction =
  | { kind: 'click' | 'check' | 'uncheck' }
  | { kind: 'fill'; value: string }
  | { kind: 'select'; option: string };

/**
 * Playwright side of imposed flow steps: finds the element the YAML
 * designates, performs the step and checks expectations. Like the
 * PlaywrightActionExecutor, it contains no safety rule: the explorer only
 * calls `perform` after the SafetyPolicy allowed the step.
 */
export class FlowStepExecutor {
  constructor(private readonly settleTimeMs: number) {}

  /**
   * The element, once visible; an error message otherwise. With `nth`, that
   * match; without it, the first visible match inside an open dialog if any
   * (what a user sees on top: the page behind a modal cannot be clicked),
   * else the first match.
   */
  async locate(page: Page, target: FlowTarget, timeoutMs: number): Promise<Locator | string> {
    const base = toLocator(page, {
      strategy: target.strategy,
      ...(target.role !== undefined ? { role: target.role } : {}),
      ...(target.name !== undefined ? { name: target.name } : {}),
      ...(target.value !== undefined ? { value: target.value } : {}),
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
    });
    try {
      let index = target.nth ?? 0;
      if (target.nth === undefined) {
        await base.first().waitFor({ state: 'attached', timeout: timeoutMs });
        index = await base.evaluateAll((elements) => {
          const MODAL =
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
          const inModal = elements.findIndex((el) => {
            const rect = el.getBoundingClientRect();
            return el.closest(MODAL) !== null && (rect.width > 0 || rect.height > 0);
          });
          return inModal >= 0 ? inModal : 0;
        });
      }
      const locator = base.nth(index);
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch (error) {
      const count = await base.count().catch(() => 0);
      return count === 0
        ? `element not found within ${timeoutMs} ms`
        : `element not visible within ${timeoutMs} ms (${count} match(es)): ${firstLine(error)}`;
    }
  }

  /**
   * Marks the interactive element that will receive the action (the element
   * itself, or the link/button that contains it) for the next observation.
   */
  async mark(locator: Locator): Promise<void> {
    await locator.evaluate((el, attribute) => {
      const INTERACTIVE =
        'a[href], button, summary, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [routerlink], [onclick]';
      const NESTING = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
      let target: Element = el.closest(INTERACTIVE) ?? el;
      let outer = target.parentElement?.closest(NESTING);
      while (outer) {
        target = outer;
        outer = target.parentElement?.closest(NESTING);
      }
      target.setAttribute(attribute, 'true');
    }, FLOW_TARGET_ATTRIBUTE);
  }

  async unmark(page: Page): Promise<void> {
    await page
      .evaluate((attribute) => {
        for (const el of Array.from(document.querySelectorAll(`[${attribute}]`)))
          el.removeAttribute(attribute);
      }, FLOW_TARGET_ATTRIBUTE)
      .catch(() => undefined);
  }

  /** Runs the step on the element; returns an error message on failure. */
  async perform(
    page: Page,
    locator: Locator,
    action: FlowElementAction,
    timeoutMs: number,
  ): Promise<string | undefined> {
    try {
      switch (action.kind) {
        case 'click':
          await locator.click({ timeout: timeoutMs });
          break;
        case 'check':
          await this.setChecked(locator, true, timeoutMs);
          break;
        case 'uncheck':
          await this.setChecked(locator, false, timeoutMs);
          break;
        case 'fill':
          await locator.fill(action.value, { timeout: timeoutMs });
          break;
        case 'select':
          await this.select(page, locator, action.option, timeoutMs);
          break;
      }
      await this.settle(page, timeoutMs);
      return undefined;
    } catch (error) {
      await this.settle(page, timeoutMs).catch(() => undefined);
      return firstLine(error);
    }
  }

  /** Waits until every expectation holds; returns what did not hold. */
  async expect(page: Page, expectation: FlowExpectation, timeoutMs: number): Promise<string | undefined> {
    const failures: string[] = [];
    if (expectation.url !== undefined) {
      const expected = expectation.url;
      try {
        await page.waitForURL((url) => url.href.includes(expected), {
          timeout: timeoutMs,
          waitUntil: 'commit',
        });
      } catch {
        failures.push(`URL does not contain "${expected}" (${page.url()})`);
      }
    }
    if (expectation.text !== undefined) {
      try {
        await page.getByText(expectation.text).first().waitFor({ state: 'visible', timeout: timeoutMs });
      } catch {
        failures.push(`text "${expectation.text}" not visible`);
      }
    }
    if (expectation.visible) {
      const found = await this.locate(page, expectation.visible, timeoutMs);
      if (typeof found === 'string') failures.push(`expected element: ${found}`);
    }
    if (expectation.hidden) {
      const hidden = expectation.hidden;
      const base = toLocator(page, {
        strategy: hidden.strategy,
        ...(hidden.role !== undefined ? { role: hidden.role } : {}),
        ...(hidden.name !== undefined ? { name: hidden.name } : {}),
        ...(hidden.value !== undefined ? { value: hidden.value } : {}),
        ...(hidden.exact !== undefined ? { exact: hidden.exact } : {}),
      });
      try {
        await base.nth(hidden.nth ?? 0).waitFor({ state: 'hidden', timeout: timeoutMs });
      } catch {
        failures.push('element still visible');
      }
    }
    return failures.length > 0 ? failures.join('; ') : undefined;
  }

  /** Native <select>: selectOption; custom selects (Angular Material, ARIA combobox): open it, then click the option. */
  private async select(page: Page, locator: Locator, option: string, timeoutMs: number): Promise<void> {
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await locator.selectOption({ label: option }, { timeout: timeoutMs });
      return;
    }
    await locator.click({ timeout: timeoutMs });
    await page.getByRole('option', { name: option }).first().click({ timeout: timeoutMs });
  }

  /**
   * Styled radios and checkboxes (Angular Material…) draw over their native
   * input, which then never receives the click: after a short try, click its
   * label like a user would, then force the input as a last resort. The state
   * is checked each time.
   */
  private async setChecked(locator: Locator, checked: boolean, timeoutMs: number): Promise<void> {
    try {
      await locator.setChecked(checked, { timeout: Math.min(timeoutMs, QUICK_CHECK_MS) });
      return;
    } catch (error) {
      const done = async (): Promise<boolean> =>
        (await locator.isChecked().catch(() => !checked)) === checked;
      if (await done()) return;
      const viaLabel = await locator
        .evaluate((el) => {
          const label =
            (el as HTMLInputElement).labels?.[0] ??
            el.closest('label, mat-radio-button, mat-checkbox, [role="radio"], [role="checkbox"]');
          if (!label || label === el) return false;
          (label as HTMLElement).click();
          return true;
        })
        .catch(() => false);
      if (viaLabel) await locator.page().waitForTimeout(100);
      if (await done()) return;
      await locator.setChecked(checked, { force: true, timeout: timeoutMs }).catch(() => undefined);
      if (await done()) return;
      throw error;
    }
  }

  private async settle(page: Page, timeoutMs: number): Promise<void> {
    if (page.isClosed()) return;
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
    if (this.settleTimeMs > 0) await page.waitForTimeout(this.settleTimeMs).catch(() => undefined);
  }
}

/** Time given to a plain check before trying the label (styled radios/checkboxes). */
const QUICK_CHECK_MS = 3000;

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).trim();
}
