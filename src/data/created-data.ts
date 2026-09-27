import { runTag } from '../forms/form-model.js';

/**
 * Data the run probably created: an action changing data (form sent,
 * "Save"…) answered by a successful POST/PUT/PATCH. Only what identifies it —
 * never the values sent, which carry the run's tag (QA-CRAWLER-<runId>).
 */
export interface CreatedDataRecord {
  runId: string;
  /** What to search for in the application to find the data. */
  tag: string;
  stateId: string;
  actionId: string;
  /** Visible label of the action ("Save"). */
  action: string;
  form?: string;
  /** Calls that created or changed something (URL redacted, no body). */
  requests: { method: string; url: string; status: number }[];
  at: string;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH']);

export class CreatedDataRegistry {
  private readonly records: CreatedDataRecord[] = [];

  constructor(private readonly runId: string) {}

  /** Keeps the action when one of its calls wrote something successfully. */
  record(entry: {
    stateId: string;
    actionId: string;
    action: string;
    form?: string;
    requests: readonly { method: string; url: string; status?: number }[];
  }): CreatedDataRecord | undefined {
    const writes = entry.requests
      .filter(
        (request): request is { method: string; url: string; status: number } =>
          WRITES.has(request.method) &&
          request.status !== undefined &&
          request.status >= 200 &&
          request.status < 400,
      )
      .map(({ method, url, status }) => ({ method, url, status }));
    if (writes.length === 0) return undefined;
    const record: CreatedDataRecord = {
      runId: this.runId,
      tag: runTag(this.runId),
      stateId: entry.stateId,
      actionId: entry.actionId,
      action: entry.action,
      ...(entry.form ? { form: entry.form } : {}),
      requests: writes,
      at: new Date().toISOString(),
    };
    this.records.push(record);
    return record;
  }

  all(): CreatedDataRecord[] {
    return [...this.records];
  }
}

export interface CleanupReport {
  cleaner: string;
  /** Records the cleaner took care of. */
  cleaned: number;
  /** Still to delete (by hand, or by a cleaner able to). */
  pending: CreatedDataRecord[];
  notes: string[];
}

/**
 * Removes what a run created. The explorer never deletes anything by itself
 * (deleting is DANGEROUS); an implementation for a given application (API
 * call, SQL script on a test database…) can be plugged in here.
 */
export interface TestDataCleanup {
  readonly name: string;
  cleanup(records: readonly CreatedDataRecord[]): Promise<CleanupReport>;
}

/** Default: deletes nothing, lists what to remove and how to find it. */
export class ManualCleanup implements TestDataCleanup {
  readonly name = 'manual';

  cleanup(records: readonly CreatedDataRecord[]): Promise<CleanupReport> {
    const tags = [...new Set(records.map((record) => record.tag))];
    return Promise.resolve({
      cleaner: this.name,
      cleaned: 0,
      pending: [...records],
      notes:
        records.length === 0
          ? []
          : [`Nothing was deleted automatically. Look for data containing ${tags.join(', ')}.`],
    });
  }
}
