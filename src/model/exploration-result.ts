import type { ActionClassification, DiscoveredAction, DiscoveredForm } from './discovered-action.js';
import type { FlowEdge, FlowNode } from './flow.js';
import type { Issue, IssueType, Severity } from './issue.js';

/** Why the exploration ended. */
export type StopReason =
  'exhausted' | 'max-states' | 'max-actions' | 'max-duration' | 'engine-stop' | 'unreachable-start';

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
