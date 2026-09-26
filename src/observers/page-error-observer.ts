import type { Page } from 'playwright';
import { SeverityRules } from '../anomaly/severity-rules.js';
import type { ObservationContext, PageObserver } from './observer.js';

/** Reports uncaught JavaScript exceptions (`pageerror`) and renderer crashes. */
export class PageErrorObserver implements PageObserver {
  private crashed = false;

  private readonly onPageError = (error: Error): void => {
    if (!this.context.config.checks.pageErrors) return;
    const firstFrame = error.stack
      ?.split('\n')
      .slice(1)
      .find((line) => line.trim().startsWith('at '))
      ?.trim();
    this.context.collector.add({
      type: 'PAGE_ERROR',
      severity: SeverityRules.pageError(),
      message: `Uncaught ${error.name}: ${error.message}${firstFrame ? ` ${firstFrame}` : ''}`,
      pageUrl: this.context.currentPageUrl(),
    });
  };

  private readonly onCrash = (): void => {
    this.crashed = true;
    this.context.collector.add({
      type: 'PAGE_CRASH',
      severity: SeverityRules.pageCrash(),
      message: 'The browser page crashed',
      pageUrl: this.context.currentPageUrl(),
    });
  };

  constructor(private readonly context: ObservationContext) {}

  attach(page: Page): void {
    page.on('pageerror', this.onPageError);
    page.on('crash', this.onCrash);
  }

  detach(page: Page): void {
    page.off('pageerror', this.onPageError);
    page.off('crash', this.onCrash);
  }

  /** True once the page crashed; the engine must then open a new page. */
  consumeCrash(): boolean {
    const crashed = this.crashed;
    this.crashed = false;
    return crashed;
  }
}
