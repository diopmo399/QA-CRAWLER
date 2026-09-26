import type { Page } from 'playwright';
import type { IssueCollector } from '../anomaly/issue-collector.js';
import type { ScenarioConfig } from '../config/config.js';

/** What observers need to know about the crawl in progress. */
export interface ObservationContext {
  /** URL of the page currently being crawled; anomalies are attributed to it. */
  currentPageUrl(): string;
  collector: IssueCollector;
  config: ScenarioConfig;
}

/** Listens to Playwright page events and reports anomalies. */
export interface PageObserver {
  attach(page: Page): void;
  detach(page: Page): void;
}
