import type { Page } from 'playwright';
import type { IssueCollector } from '../anomaly/issue-collector.js';
import type { ScenarioConfig } from '../config/config.js';

/** Where an anomaly comes from in the exploration: reproducible through `flow` + `actionId`. */
export interface IssueAttribution {
  stateId?: string;
  actionId?: string;
  flow?: string[];
}

/** What observers need to know about the exploration in progress. */
export interface ObservationContext {
  /** URL of the page being explored; anomalies are attributed to it. */
  currentPageUrl(): string;
  /** State and action in progress. */
  currentAttribution(): IssueAttribution;
  collector: IssueCollector;
  config: ScenarioConfig;
}

/** Listens to Playwright page events and reports anomalies. */
export interface PageObserver {
  attach(page: Page): void;
  detach(page: Page): void;
}

/** Attribution fields ready to spread into an IssueInput. */
export function attributionOf(context: ObservationContext): IssueAttribution {
  const { stateId, actionId, flow } = context.currentAttribution();
  return {
    ...(stateId !== undefined ? { stateId } : {}),
    ...(actionId !== undefined ? { actionId } : {}),
    ...(flow !== undefined ? { flow: [...flow] } : {}),
  };
}
