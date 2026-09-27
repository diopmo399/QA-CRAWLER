import type { BrowserInteractionResult } from '../interactions/types.js';
import type { NetworkExchange } from './network.js';
import type { ActionClassification, ActionSummary, ActionType, ActionCategory } from './discovered-action.js';

/** A functional state of the application (a screen, a wizard step, a tab…). */
export interface FlowNode {
  id: string;
  /** Human-readable name derived from headings/route. */
  label: string;
  url: string;
  route: string;
  title?: string;
  headings: string[];
  /** What distinguishes this state on its screen: open dialog, selected tab or sub-heading (wizard step). */
  subtitle?: string;
  /** Depth (in transitions) at which the state was first reached. */
  depth: number;
  /** Ids of the actions available on this state. */
  discoveredActions: string[];
  /** Summary of each available action, by id. */
  actions: Record<string, ActionSummary>;
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
  screenshot?: string;
  issueIds: string[];
}

export type TransitionResult = 'SUCCESS' | 'FAILED' | 'BLOCKED';

/** One attempt to execute an action from a state. */
export interface FlowEdge {
  from: string;
  /** Resulting state (equal to `from` for blocked actions and actions without visible effect). */
  to: string;
  actionId: string;
  action: {
    type: ActionType;
    category: ActionCategory;
    text?: string;
    label?: string;
    href?: string;
    classification: ActionClassification;
  };
  result: TransitionResult;
  /** Block or failure reason. */
  reason?: string;
  timestamp: string;
  durationMs?: number;
  issueIds: string[];
  /** Name of the imposed flow that executed this transition (absent for autonomous exploration). */
  flow?: string;
  /** Browser interactions raised while this action ran (ids of FlowGraphData.interactions). */
  interactionIds?: string[];
  /** Transition produced by a browser interaction itself (popup, new tab). */
  interaction?: { id: string; type: string; status: string };
  /** HTTP exchanges seen while the action ran: STATE A → ACTION → NETWORK → STATE B. */
  network?: NetworkExchange[];
  /** Start and end of that network window. */
  networkWindow?: { startedAt: string; finishedAt: string };
}

export interface FlowGraphData {
  version: 1;
  rootId?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Browser interactions (HTTP_AUTH, dialogs, popups…). Never contains a secret. */
  interactions?: BrowserInteractionResult[];
}
