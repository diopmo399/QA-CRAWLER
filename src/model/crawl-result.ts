import type { ActionClassification } from './discovered-action.js';
import type { Issue, IssueType, Severity } from './issue.js';
import type { PageResult } from './page-result.js';

export interface RouteSummary {
  route: string;
  /** Concrete URLs visited for this route. */
  visited: number;
}

export interface CrawlStats {
  pagesVisited: number;
  pagesFailed: number;
  issuesBySeverity: Record<Severity, number>;
  issuesByType: Record<IssueType, number>;
  actionsByClassification: Record<ActionClassification, number>;
  formsFound: number;
  /** Actions actually executed by the decision engine (SAFE only by default). */
  actionsExecuted: number;
  /** Links not followed, by reason. */
  linksSkipped: Record<string, number>;
}

export interface CrawlResult {
  scenario: string;
  description?: string;
  target: {
    baseUrl: string;
    startUrl: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesVisited: number;
  /** Crawl stopped because maxPages was reached while URLs were still queued. */
  maxPagesReached: boolean;
  /** URLs still queued when the crawl ended. */
  pendingUrls: number;
  stats: CrawlStats;
  routes: RouteSummary[];
  pages: PageResult[];
  issues: Issue[];
  /** Non-secret summary of the effective configuration. */
  settings: Record<string, unknown>;
  /** Report files written for this run. */
  artifacts: {
    json?: string;
    html?: string;
    screenshotsDir?: string;
  };
}
