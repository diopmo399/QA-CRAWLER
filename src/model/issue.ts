/** Ordered from least to most severe. */
export const SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ISSUE_TYPES = [
  'HTTP',
  'REQUEST_FAILED',
  'BROKEN_LINK',
  'CONSOLE',
  'PAGE_ERROR',
  'PAGE_CRASH',
  'NAVIGATION',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * An anomaly observed while crawling. Identical anomalies (same type, message,
 * request, status) are merged: `occurrences` counts them and `pages` lists
 * every page on which they were seen.
 */
export interface Issue {
  id: string;
  type: IssueType;
  severity: Severity;
  message: string;
  /** Page on which the anomaly was first observed. */
  pageUrl: string;
  /** All pages on which this anomaly was observed. */
  pages: string[];
  requestUrl?: string;
  method?: string;
  status?: number;
  /** Page that linked to a broken page. */
  referrerUrl?: string;
  /** Functional state (see StateDetector) on which the anomaly was first observed. */
  stateId?: string;
  /** Action whose execution triggered the anomaly (undefined when seen while loading a state). */
  actionId?: string;
  /** Path of state ids from the start state to `stateId`: how to reproduce the problem. */
  flow?: string[];
  /** All states on which this anomaly was observed. */
  states: string[];
  /** ISO timestamp of the first occurrence. */
  timestamp: string;
  occurrences: number;
  /** Screenshot path relative to the working directory, when one was captured. */
  screenshot?: string;
}

/** Data needed to report a new anomaly; bookkeeping fields are filled by the collector. */
export type IssueInput = Omit<Issue, 'id' | 'pages' | 'states' | 'timestamp' | 'occurrences' | 'severity'> & {
  severity?: Severity;
};

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export function isAtLeast(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) >= severityRank(threshold);
}
