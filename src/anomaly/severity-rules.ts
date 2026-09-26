import type { BrowserInteractionResult } from '../interactions/types.js';
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

  /** A field still invalid once the form is filled: wrong test data, or a validation bug. */
  formValidation(): Severity {
    return 'WARNING';
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

  /** An imposed flow step failed or was blocked; optional steps only warn. */
  flowStep(optional: boolean): Severity {
    return optional ? 'WARNING' : 'ERROR';
  },

  /**
   * Browser interaction outside the DOM. Blocking ones (authentication
   * required or refused, loop) are errors; things the crawler must not do by
   * itself (pick a file, answer a prompt) and unknown interactions are
   * warnings; the rest is only recorded.
   */
  browserInteraction(result: BrowserInteractionResult): Severity | undefined {
    if (result.blocking) return 'ERROR';
    if (
      result.status === 'UNSUPPORTED' ||
      result.status === 'FAILED' ||
      result.outcome === 'FILE_INPUT_REQUIRED' ||
      result.outcome === 'PROMPT_VALUE_REQUIRED'
    )
      return 'WARNING';
    return undefined;
  },

  /** Navigation that could not complete (timeout, redirect loop, redirect off-site...). */
  navigationFailure(kind: 'timeout' | 'redirect-loop' | 'external-redirect' | 'other'): Severity {
    return kind === 'external-redirect' ? 'WARNING' : 'ERROR';
  },
} as const;
