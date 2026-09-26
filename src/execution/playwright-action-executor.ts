import type { Locator, Page } from 'playwright';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { LocatorDescriptor } from '../model/locator.js';
import { toLocator } from './locator-resolver.js';

/** Value to type/select for fill and select actions. */
export interface ExecutionInput {
  value?: string;
}

export interface ActionExecutionResult {
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  urlBefore: string;
  urlAfter: string;
  durationMs: number;
  /** The preferred locator did not match; the CSS fallback was used. */
  usedFallback: boolean;
  /** The element opened a new window (handled by the BrowserInteractionManager). */
  openedPopup: boolean;
}

/**
 * "Execute it." Translates the chosen action into Playwright calls
 * (getByRole(...).click(), fill, selectOption, setChecked) and waits for the
 * page to settle. It contains no decision logic and no safety rules: it is
 * only ever called with an action the SafetyPolicy allowed.
 */
export class PlaywrightActionExecutor {
  constructor(
    private readonly actionTimeoutMs: number,
    private readonly settleTimeMs: number,
  ) {}

  async execute(
    page: Page,
    action: DiscoveredAction,
    input: ExecutionInput = {},
  ): Promise<ActionExecutionResult> {
    const started = Date.now();
    const urlBefore = page.url();
    const result = (
      status: 'SUCCESS' | 'FAILED',
      extra: Partial<ActionExecutionResult> = {},
    ): ActionExecutionResult => ({
      status,
      urlBefore,
      urlAfter: page.isClosed() ? urlBefore : page.url(),
      durationMs: Date.now() - started,
      usedFallback: false,
      openedPopup: false,
      ...extra,
    });

    let target: { locator: Locator; usedFallback: boolean } | undefined;
    try {
      target = await this.resolve(page, action);
    } catch (error) {
      return result('FAILED', { error: `locator error: ${firstLine(error)}` });
    }
    if (!target) return result('FAILED', { error: 'element not found on the page' });

    const timeout = this.actionTimeoutMs;
    let openedPopup = false;
    try {
      switch (action.type) {
        case 'click':
        case 'navigate': {
          let opened: Page | undefined;
          const onPopup = (popup: Page): void => {
            opened = popup;
          };
          page.on('popup', onPopup);
          try {
            await this.click(target.locator, timeout);
            await this.settle(page);
          } finally {
            page.off('popup', onPopup);
          }
          if (opened) {
            openedPopup = true;
            // The new window itself is handled by the BrowserInteractionManager (recorded, observed, closed).
            // A link opening a new window: reach its target in the current page too.
            if (action.type === 'navigate' && action.href) {
              await page.goto(action.href, { timeout, waitUntil: 'domcontentloaded' });
            }
          }
          break;
        }
        case 'fill':
          await target.locator.fill(input.value ?? '', { timeout });
          break;
        case 'select':
          await this.select(page, target.locator, input.value, timeout);
          break;
        case 'check':
          await target.locator.setChecked(true, { timeout }).catch(async (error: unknown) => {
            // Styled checkbox/radio (Angular Material): the drawing covers the native input.
            if (!interceptor(error)) throw error;
            await target.locator.check({ force: true, timeout });
          });
          break;
        case 'uncheck':
          await target.locator.setChecked(false, { timeout });
          break;
      }
      await this.settle(page);
      return result('SUCCESS', { usedFallback: target.usedFallback, openedPopup });
    } catch (error) {
      await this.settle(page).catch(() => undefined);
      return result('FAILED', { error: firstLine(error), usedFallback: target.usedFallback, openedPopup });
    }
  }

  /**
   * Clicks, failing fast with a clear reason when another layer (a date
   * picker's backdrop, a modal…) takes the click instead of the element.
   */
  private async click(locator: Locator, timeout: number): Promise<void> {
    try {
      await locator.click({ trial: true, timeout: Math.min(timeout, TRIAL_CLICK_MS) });
    } catch (error) {
      const blocker = interceptor(error);
      if (blocker) throw new Error(`click intercepted by ${blocker}: another layer covers the element`);
      // Not ready yet (animation, loading…): the real click below waits for it.
    }
    await locator.click({ timeout });
  }

  /** Native <select>: selectOption; custom list (Angular Material, ARIA combobox): open it, pick the option. */
  private async select(
    page: Page,
    locator: Locator,
    label: string | undefined,
    timeout: number,
  ): Promise<void> {
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await locator.selectOption(label ? { label } : { index: 0 }, { timeout });
      return;
    }
    await this.click(locator, timeout);
    const options = page.locator('[role="option"]:visible:not([aria-disabled="true"])');
    await options.first().waitFor({ state: 'visible', timeout });
    if (label) {
      await page.getByRole('option', { name: label }).first().click({ timeout });
    } else {
      // The first real option: placeholders ("--", "Choisir…") are skipped.
      const texts = await options.allInnerTexts();
      const index = texts.findIndex((text) => text.trim() !== '' && !PLACEHOLDER_OPTION.test(text.trim()));
      await options.nth(Math.max(index, 0)).click({ timeout });
    }
    // A multiple-choice list stays open: close it.
    if (
      await options
        .first()
        .isVisible()
        .catch(() => false)
    )
      await page.keyboard.press('Escape');
  }

  /** Preferred locator, else the CSS fallback; `nth` applied when several elements match. */
  private async resolve(
    page: Page,
    action: DiscoveredAction,
  ): Promise<{ locator: Locator; usedFallback: boolean } | undefined> {
    const attempts: [LocatorDescriptor, boolean][] = [[action.locator, false]];
    if (action.fallback) attempts.push([action.fallback, true]);
    for (const [descriptor, usedFallback] of attempts) {
      const base = toLocator(page, descriptor);
      const count = await base.count();
      if (count === 0) continue;
      const index = Math.min(descriptor.nth ?? 0, count - 1);
      return { locator: count === 1 ? base : base.nth(index), usedFallback };
    }
    return undefined;
  }

  private async settle(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.waitForLoadState('domcontentloaded', { timeout: this.actionTimeoutMs }).catch(() => undefined);
    if (this.settleTimeMs > 0) await page.waitForTimeout(this.settleTimeMs).catch(() => undefined);
  }
}

/** Time given to a click before telling that another layer takes it. */
const TRIAL_CLICK_MS = 2500;
const PLACEHOLDER_OPTION = /^(-+|choisir|select|choose|aucun|none)/i;

/** The element that took the click instead of the target, from Playwright's call log. */
export function interceptor(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /(<[^\n]*?>)(?: from <[^\n]*?> subtree)? intercepts pointer events/.exec(message);
  if (!match?.[1]) return undefined;
  const element = match[1];
  return element.length > 90 ? `${element.slice(0, 87)}…>` : element;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).trim();
}
