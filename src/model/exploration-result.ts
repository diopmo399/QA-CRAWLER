import type { ActionClassification, DiscoveredAction, DiscoveredForm } from './discovered-action.js';
import type { FlowEdge, FlowNode } from './flow.js';
import type { FlowRunReport } from './flow-run.js';
import type { BrowserInteractionResult } from '../interactions/types.js';
import type { Issue, IssueType, Severity } from './issue.js';

/** Why the exploration ended. */
export type StopReason =
  | 'exhausted'
  | 'flows-only'
  | 'max-states'
  | 'max-actions'
  | 'max-duration'
  | 'engine-stop'
  | 'unreachable-start';

export interface ExplorationStats {
  states: number;
  transitions: number;
  actionsExecuted: number;
  actionsSucceeded: number;
  actionsFailed: number;
  actionsBlocked: number;
  backtracks: number;
  maxDepth: number;
  issuesBySeverity: Record<Severity, number>;
  issuesByType: Record<IssueType, number>;
  actionsByClassification: Record<ActionClassification, number>;
  formsFound: number;
  flowsPassed: number;
  flowsFailed: number;
  /** Browser interactions by type and by status. */
  interactionsByType: Record<string, number>;
  interactionsByStatus: Record<string, number>;
}

/** A state with everything observed on it. */
export interface StateReport extends FlowNode {
  actionsDetail: DiscoveredAction[];
  forms: DiscoveredForm[];
  /** How to reach it from the start state. */
  flow: string[];
}

export interface ExplorationResult {
  mission: string;
  description?: string;
  target: {
    baseUrl: string;
    startUrl: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: StopReason;
  decisionEngine: string;
  stats: ExplorationStats;
  states: StateReport[];
  transitions: FlowEdge[];
  /** Imposed flows, in mission order. */
  flows: FlowRunReport[];
  /** Interactions raised by the browser outside the DOM (HTTP_AUTH, dialogs, popups, downloads…). */
  browserInteractions: BrowserInteractionResult[];
  issues: Issue[];
  /** Non-secret summary of the effective configuration. */
  settings: Record<string, unknown>;
  artifacts: {
    json?: string;
    html?: string;
    flowGraph?: string;
    flowGraphHtml?: string;
    screenshotsDir?: string;
  };
}
