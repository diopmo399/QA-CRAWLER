import type { DiscoveredAction, DiscoveredForm } from './discovered-action.js';

export interface LinkStats {
  /** Links found on the page (anchors and routerLinks). */
  found: number;
  /** New URLs added to the crawl queue. */
  queued: number;
  /** Links not followed, grouped by reason (external host, ignored path, depth limit...). */
  skipped: Record<string, number>;
}

export interface PageResult {
  /** Sequence number in visit order (1-based). */
  sequence: number;
  url: string;
  /** URL after redirects, when different. */
  finalUrl?: string;
  /** Normalized route pattern, e.g. /users/:id. */
  route: string;
  depth: number;
  /** Page that linked here (undefined for the start page). */
  referrerUrl?: string;
  /** HTTP status of the main document, when available. */
  status?: number;
  title?: string;
  loadTimeMs: number;
  /** Navigation failed (timeout, redirect loop, network error...). */
  failed: boolean;
  error?: string;
  links: LinkStats;
  actions: DiscoveredAction[];
  forms: DiscoveredForm[];
  /** IDs of issues observed on this page. */
  issueIds: string[];
  screenshot?: string;
  visitedAt: string;
}
