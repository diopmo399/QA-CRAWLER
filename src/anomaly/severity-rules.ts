import type { Severity } from '../model/issue.js';

/**
 * Single place where anomalies get their severity, so the policy can be
 * reviewed and tuned without touching observers or the crawl engine.
 */
export const SeverityRules = {
  /** HTTP response on a sub-resource (API call, script, image...). */
  httpResponse(status: number): Severity {
    if (status >= 500) return 'ERROR';
    if (status === 401 || status === 403) return 'WARNING';
    if (status >= 400) return 'WARNING';
    return 'INFO';
  },

  /** Main document of a visited page. A missing or failing page is always an error. */
  pageResponse(status: number): Severity {
    if (status >= 500) return 'ERROR';
    if (status === 404 || status === 410) return 'ERROR';
    if (status >= 400) return 'WARNING';
    return 'INFO';
  },

  /** Network failure (DNS, connection refused, CORS, aborted...). */
  requestFailed(isDocument: boolean): Severity {
    return isDocument ? 'ERROR' : 'WARNING';
  },

  consoleError(): Severity {
    return 'ERROR';
  },

  consoleWarning(): Severity {
    return 'WARNING';
  },

  /** Uncaught exception in the page. */
  pageError(): Severity {
    return 'ERROR';
  },

  /** Renderer process crashed. */
  pageCrash(): Severity {
    return 'CRITICAL';
  },

  /** Navigation that could not complete (timeout, redirect loop, redirect off-site...). */
  navigationFailure(kind: 'timeout' | 'redirect-loop' | 'external-redirect' | 'other'): Severity {
    return kind === 'external-redirect' ? 'WARNING' : 'ERROR';
  },
} as const;
