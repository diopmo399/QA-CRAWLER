import type { Dialog, Download, FileChooser, Page } from 'playwright';

/**
 * Interactions that come from the browser itself, outside the application's
 * DOM: they cannot be found with locators and may block a flow (the native
 * "Sign in" dialog, alert/confirm/prompt, a new window, a download…).
 */
export const BROWSER_INTERACTION_TYPES = [
  'HTTP_AUTH',
  'JS_ALERT',
  'JS_CONFIRM',
  'JS_PROMPT',
  'POPUP',
  'NEW_TAB',
  'DOWNLOAD',
  'FILE_CHOOSER',
  'PERMISSION_REQUEST',
  'EXTERNAL_NAVIGATION',
  'UNKNOWN_BROWSER_INTERACTION',
] as const;
export type BrowserInteractionType = (typeof BROWSER_INTERACTION_TYPES)[number];

/**
 * - DETECTED: seen, nothing had to be done.
 * - HANDLED: a handler took care of it (authenticated, dialog answered, popup observed…).
 * - BLOCKED: refused by the safety policy, or needs something the crawler must not invent.
 * - FAILED: the handler tried and did not succeed (rejected credentials, timeout…).
 * - SKIPPED: deliberately ignored (feature disabled).
 * - UNSUPPORTED: no handler for this interaction; a safe fallback was applied.
 */
export const INTERACTION_STATUSES = [
  'DETECTED',
  'HANDLED',
  'BLOCKED',
  'FAILED',
  'SKIPPED',
  'UNSUPPORTED',
] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

/** Why an interaction ended the way it did (stable codes for reports and CI). */
export const INTERACTION_OUTCOMES = [
  'AUTHENTICATED',
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'CREDENTIALS_NOT_ALLOWED',
  'INTERACTION_LOOP_DETECTED',
  'DIALOG_ACCEPTED',
  'DIALOG_DISMISSED',
  'PROMPT_VALUE_REQUIRED',
  'PROMPT_ANSWERED',
  'POPUP_OBSERVED',
  'POPUP_CLOSED',
  'DOWNLOAD_RECORDED',
  'FILE_INPUT_REQUIRED',
  'PERMISSION_DENIED',
  'PERMISSION_GRANTED',
  'EXTERNAL_ORIGIN',
  'BLOCKED_ORIGIN',
  'NO_HANDLER',
  'TIMEOUT',
  'ERROR',
] as const;
export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number];

/** Where a URL stands compared to the mission's target (see AllowedOriginPolicy). */
export const ORIGIN_CLASSES = ['SAME_ORIGIN', 'ALLOWED_ORIGIN', 'EXTERNAL_ORIGIN', 'BLOCKED_ORIGIN'] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/** Non-secret facts about an interaction, safe to log and report. */
export type InteractionDetails = Record<string, string | number | boolean>;

/**
 * What the browser lets us do with the interaction. Each source provides
 * the native handle; handlers use it, the crawl engine never does.
 */
export type NativeHandle =
  | {
      kind: 'http-auth';
      /** Answers the browser's challenge. Credentials only travel to the browser, never elsewhere. */
      provideCredentials(username: string, password: string): Promise<void>;
      cancel(): Promise<void>;
    }
  | { kind: 'dialog'; dialog: Dialog }
  | { kind: 'page'; page: Page }
  | { kind: 'download'; download: Download }
  | { kind: 'file-chooser'; chooser: FileChooser }
  | { kind: 'none' };

/** An interaction detected by the BrowserEventDiscovery, before it is handled. */
export interface BrowserInteraction {
  id: string;
  type: BrowserInteractionType;
  /** Page on which it happened (the opener for popups). */
  page: Page;
  sourceUrl: string;
  targetUrl?: string;
  /** Origin concerned (the server asking for credentials, the popup's origin…). */
  origin?: string;
  details: InteractionDetails;
  native: NativeHandle;
  /**
   * Safe way out when nobody handles the interaction, so the browser is never
   * left blocked: cancel the authentication, dismiss the dialog, close the popup…
   */
  fallback: () => Promise<void>;
}

/** Where the crawl was when the interaction happened. */
export interface InteractionContext {
  /** State on which the triggering action was executed. */
  stateId?: string;
  actionId?: string;
  /** Imposed flow in progress. */
  flow?: string;
}

/** Recorded outcome of an interaction: reports, flow graph, CLI. Never contains a secret. */
export interface BrowserInteractionResult {
  id: string;
  type: BrowserInteractionType;
  status: InteractionStatus;
  outcome?: InteractionOutcome;
  /** Handler that dealt with it. */
  handler?: string;
  /** What was done: AUTHENTICATE, CANCEL, ACCEPT, DISMISS, OBSERVE, CLOSE, DENY… */
  action?: string;
  sourceUrl: string;
  targetUrl?: string;
  origin?: string;
  originClass?: OriginClass;
  timestamp: string;
  /** 1 for the first try; higher when the browser asked again (retry). */
  attempt: number;
  retryAttempted: boolean;
  success: boolean;
  reason?: string;
  stateId?: string;
  actionId?: string;
  flow?: string;
  /** State observed in the new page (popups, new tabs). */
  targetStateId?: string;
  /** Logical credential profile used — never the credentials. */
  credentialProfile?: string;
  /** The flow cannot go on normally (authentication required or refused, loop…). */
  blocking: boolean;
  details: InteractionDetails;
}
