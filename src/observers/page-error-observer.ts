import type { Page } from 'playwright';
import { SeverityRules } from '../anomaly/severity-rules.js';
import type { IssueDetails } from '../model/issue.js';
import { attributionOf, type ObservationContext, type PageObserver } from './observer.js';

/** Signale les exceptions JavaScript non interceptées (`pageerror`) et les plantages du rendu. */
export class PageErrorObserver implements PageObserver {
  private crashed = false;

  private readonly onPageError = (error: Error): void => {
    if (!this.context.config.checks.pageErrors) return;
    const frames = stackFrames(error.stack);
    const firstFrame = frames[0];
    const source = firstFrame ? sourceOfFrame(firstFrame) : undefined;
    const details: IssueDetails = {
      name: error.name,
      ...(source ? { source } : {}),
      ...(frames.length > 0 ? { stack: frames } : {}),
      ...(error.message.includes('\n') ? { text: error.message } : {}),
    };
    this.context.collector.add({
      type: 'PAGE_ERROR',
      severity: SeverityRules.pageError(),
      message: `Uncaught ${error.name}: ${firstLine(error.message)}${firstFrame ? ` ${firstFrame}` : ''}`,
      pageUrl: this.context.currentPageUrl(),
      ...attributionOf(this.context),
      details,
    });
  };

  private readonly onCrash = (): void => {
    this.crashed = true;
    this.context.collector.add({
      type: 'PAGE_CRASH',
      severity: SeverityRules.pageCrash(),
      message: 'The browser page crashed',
      pageUrl: this.context.currentPageUrl(),
      ...attributionOf(this.context),
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

  /** Vrai une fois la page plantée ; le moteur doit alors ouvrir une nouvelle page. */
  consumeCrash(): boolean {
    const crashed = this.crashed;
    this.crashed = false;
    return crashed;
  }
}

/** Les cadres d'une pile V8 (« at fn (url:line:col) »), sans la ligne « Name: message ». */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '));
}

/** « at fn (http://host/app.js:13:16) » → { url, line, column }. */
export function sourceOfFrame(frame: string): IssueDetails['source'] | undefined {
  const match = /(\S+?):(\d+):(\d+)\)?$/.exec(frame.replace(/^at\s+/, ''));
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { url: match[1].replace(/^\(/, ''), line: Number(match[2]), column: Number(match[3]) };
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
