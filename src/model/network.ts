/**
 * One HTTP exchange seen while an action ran. Only what explains the
 * transition is kept — never headers (Authorization, cookies), bodies,
 * passwords or secrets; the URL goes through the redactor.
 */
export interface NetworkExchange {
  method: string;
  url: string;
  /** Absent when the request failed or had not answered when the window closed. */
  status?: number;
  durationMs?: number;
  /** document, xhr, fetch… */
  resourceType: string;
  /** Network error (ERR_CONNECTION_REFUSED…), when the request failed. */
  failure?: string;
}

/** The network window of one action: from just before it runs until the next state is observed. */
export interface ActionNetworkTrace {
  actionId: string;
  startedAt: string;
  finishedAt: string;
  requests: NetworkExchange[];
}
