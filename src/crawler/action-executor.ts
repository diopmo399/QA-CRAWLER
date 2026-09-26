import type { Page } from 'playwright';
import { ACTION_SELECTOR } from '../discovery/action-discovery.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';

export type ExecutionOutcome = { executed: true; urlAfter: string } | { executed: false; reason: string };

/**
 * Executes one in-page action chosen by the decision engine, with a last
 * safety check on the live element: if its label changed since discovery,
 * it is re-classified and refused unless still allowed.
 */
export class ActionExecutor {
  constructor(
    private readonly safetyPolicy: SafetyPolicy,
    private readonly timeoutMs: number,
    private readonly settleTimeMs: number,
  ) {}

  async execute(page: Page, action: DiscoveredAction): Promise<ExecutionOutcome> {
    if (!this.safetyPolicy.isExecutionAllowed(action.classification)) {
      return { executed: false, reason: `${action.classification} actions are not allowed` };
    }
    const locator = page.locator(ACTION_SELECTOR).nth(action.index);
    let liveText: string;
    try {
      liveText = await locator.evaluate(
        (el) =>
          (
            el.getAttribute('aria-label') ||
            (el as HTMLElement).innerText ||
            (el as HTMLInputElement).value ||
            el.getAttribute('title') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120),
        undefined,
        { timeout: this.timeoutMs },
      );
    } catch {
      return { executed: false, reason: 'element no longer present' };
    }
    if (liveText !== action.text) {
      const recheck = this.safetyPolicy.classify({ ...action, text: liveText });
      if (!this.safetyPolicy.isExecutionAllowed(recheck.classification)) {
        return { executed: false, reason: `element changed and is now ${recheck.classification}` };
      }
    }

    try {
      await locator.click({ timeout: this.timeoutMs });
      await page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs }).catch(() => undefined);
      if (this.settleTimeMs > 0) await page.waitForTimeout(this.settleTimeMs);
      return { executed: true, urlAfter: page.url() };
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
      return { executed: false, reason };
    }
  }
}
