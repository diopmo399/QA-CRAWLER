import type { ConsoleMessage, Page } from 'playwright';
import { SeverityRules } from '../anomaly/severity-rules.js';
import type { ObservationContext, PageObserver } from './observer.js';

/** Chrome's own echo of a failed HTTP response — already reported by the NetworkObserver. */
const RESOURCE_FAILURE_ECHO = /^Failed to load resource: the server responded with a status of \d+/i;

/** Reports console.error (and optionally console.warn) messages. */
export class ConsoleObserver implements PageObserver {
  private readonly onConsole = (message: ConsoleMessage): void => {
    this.handle(message);
  };

  constructor(private readonly context: ObservationContext) {}

  attach(page: Page): void {
    page.on('console', this.onConsole);
  }

  detach(page: Page): void {
    page.off('console', this.onConsole);
  }

  private handle(message: ConsoleMessage): void {
    const { checks, http } = this.context.config;
    const type = message.type();
    const isError = type === 'error' && checks.consoleErrors;
    const isWarning = type === 'warning' && checks.consoleWarnings;
    if (!isError && !isWarning) return;

    const text = message.text().trim();
    if (text === '') return;
    if (checks.httpErrors && RESOURCE_FAILURE_ECHO.test(text)) return;
    if (http.ignoreUrlPatterns.some((pattern) => text.includes(pattern))) return;

    const location = message.location();
    const where = location.url ? ` (${location.url}:${location.lineNumber})` : '';
    this.context.collector.add({
      type: 'CONSOLE',
      severity: isError ? SeverityRules.consoleError() : SeverityRules.consoleWarning(),
      message: `console.${type}: ${text}${where}`,
      pageUrl: this.context.currentPageUrl(),
    });
  }
}
