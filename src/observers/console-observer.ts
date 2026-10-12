import type { ConsoleMessage, Page } from 'playwright';
import { SeverityRules } from '../anomaly/severity-rules.js';
import type { IssueDetails } from '../model/issue.js';
import { attributionOf, type ObservationContext, type PageObserver } from './observer.js';

/** L'écho par Chrome d'une réponse HTTP en échec — déjà signalée par le NetworkObserver. */
const RESOURCE_FAILURE_ECHO = /^Failed to load resource: the server responded with a status of \d+/i;

/** Signale les messages console.error (et en option console.warn). */
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
    const lines = text.split('\n').map((line) => line.trim());
    const head = lines[0] ?? text;
    const frames = lines.filter((line) => line.startsWith('at '));
    const details: IssueDetails = {
      name: `console.${type}`,
      ...(location.url
        ? { source: { url: location.url, line: location.lineNumber, column: location.columnNumber } }
        : {}),
      ...(frames.length > 0 ? { stack: frames } : {}),
      ...(lines.length > 1 ? { text } : {}),
      ...(message.args().length > 1 ? { extra: { arguments: String(message.args().length) } } : {}),
    };
    this.context.collector.add({
      type: 'CONSOLE',
      severity: isError ? SeverityRules.consoleError() : SeverityRules.consoleWarning(),
      message: `console.${type}: ${head}${where}`,
      pageUrl: this.context.currentPageUrl(),
      ...attributionOf(this.context),
      details,
    });
  }
}
