import type { BaselineMetadata } from '../baseline/baseline-store.js';
import type { MissionMode } from '../config/config.js';
import type { FlowDiff } from '../diff/flow-diff.js';
import type { VerificationReport } from './verification.js';
import type { ActionClassification, DiscoveredAction, FormSummary } from './discovered-action.js';
import type { FlowEdge, FlowNode } from './flow.js';
import type { FlowRunReport } from './flow-run.js';
import type { BrowserInteractionResult } from '../interactions/types.js';
import type { Issue, IssueType, Severity } from './issue.js';
import type { FormReport } from '../forms/form-report.js';
import type { RecoverySummary } from '../recovery/recovery-model.js';
import type { CleanupReport, CreatedDataRecord } from '../data/created-data.js';
import type { AuthorizationReport } from '../actors/authorization-observer.js';

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
  forms: FormSummary[];
  /** How to reach it from the start state. */
  flow: string[];
}

export interface ExplorationResult {
  mission: string;
  /** learn, verify or explore. */
  mode: MissionMode;
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
  /** Baseline this run was compared with (verify, explore) or replaced (learn). */
  baseline?: BaselineMetadata;
  /** learn: the baseline this run stored. */
  learnedBaseline?: BaselineMetadata;
  /** Differences with that baseline. */
  flowDiff?: FlowDiff;
  /** verify: every known transition of the baseline, replayed. */
  verification?: VerificationReport;
  /** Id of the run, carried by the data it created (QA-CRAWLER-<runId>). */
  runId?: string;
  /** Forms found and filled, with their validation cases (never a sensitive value). */
  formReports?: FormReport[];
  /** Recovery attempts, abandoned branches, open circuits. */
  recovery?: RecoverySummary;
  /** Actions changing data executed, and the budget (safety.mutations). */
  mutations?: { enabled: boolean; executed: number; maxPerRun?: number };
  /** Data the run probably created, tagged QA-CRAWLER-<runId> (never the values). */
  createdData?: CreatedDataRecord[];
  /** What was cleaned up, and what is left to remove. */
  cleanup?: CleanupReport;
  /** actors: what each user reaches, the differences, the rules checked. */
  authorization?: AuthorizationReport;
  /** Non-secret summary of the effective configuration. */
  settings: Record<string, unknown>;
  artifacts: {
    json?: string;
    html?: string;
    flowGraph?: string;
    flowGraphHtml?: string;
    screenshotsDir?: string;
    flowDiff?: string;
    baseline?: string;
    /** Structured engine log (JSON lines). */
    engineLog?: string;
  };
}
