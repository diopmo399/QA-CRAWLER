import type { DiscoveredAction, FormSummary } from './discovered-action.js';
import type { Issue } from './issue.js';

/**
 * Observable state of the current screen, as given to the decision engine.
 * Structured and compact — no raw HTML — so that a future engine (local or
 * cloud model) can receive it as-is.
 */
export interface PageContext {
  url: string;
  title: string;
  stateId: string;
  /** Human-readable name of the state (e.g. "users-list"). */
  stateLabel: string;
  /** Normalized route pattern (/users/:id). */
  route: string;
  headings: string[];
  /** Short visible text excerpt. */
  text?: string;
  dialogs: string[];
  actions: DiscoveredAction[];
  forms: FormSummary[];
  /** Anomalies already observed on this state. */
  errors: Issue[];
  metadata: {
    depth: number;
    timestamp: string;
    /** State ids from the start state to this one. */
    flow: string[];
  };
}
