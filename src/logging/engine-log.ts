import type { ExplorationListener } from '../explorer/flow-explorer.js';
import { actionLabel } from '../model/discovered-action.js';
import { redactUrl } from '../security/redactor.js';

export const LOG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type EngineEvent =
  | 'AUTHENTICATED'
  | 'FLOW_STATE_DISCOVERED'
  | 'FLOW_STATE_REVISITED'
  | 'ACTION_SELECTED'
  | 'ACTION_BLOCKED'
  | 'ACTION_EXECUTED'
  | 'ACTION_FAILED'
  | 'ORACLE_VERDICT'
  | 'BACKTRACK'
  | 'RECOVERY_ATTEMPT'
  | 'STUCK_DETECTED'
  | 'ISSUE_RAISED'
  | 'FLOW_STARTED'
  | 'FLOW_STEP'
  | 'FLOW_FINISHED'
  | 'BROWSER_INTERACTION';

/**
 * One line of the engine log (engine-log.jsonl). Only ids, labels and
 * redacted URLs: never a typed value, header, cookie or secret.
 */
export interface EngineLogEntry {
  at: string;
  level: LogLevel;
  event: EngineEvent;
  message: string;
  stateId?: string;
  actionId?: string;
  data?: Record<string, string | number | boolean>;
}

/** Stops recording beyond this many lines (a very long run stays readable). */
const MAX_ENTRIES = 50_000;

/**
 * Structured log of what the engine did, filtered by level: ERROR (failures,
 * crashes), WARN (blocked, recovery, stuck), INFO (states, transitions,
 * verdicts), DEBUG (decisions, backtracks), TRACE (revisited states, every
 * issue occurrence).
 */
export class EngineEventLog {
  private readonly lines: EngineLogEntry[] = [];
  private dropped = 0;
  private readonly threshold: number;

  constructor(level: LogLevel = 'INFO') {
    this.threshold = LOG_LEVELS.indexOf(level);
  }

  log(
    level: LogLevel,
    event: EngineEvent,
    message: string,
    extra: Omit<EngineLogEntry, 'at' | 'level' | 'event' | 'message'> = {},
  ): void {
    if (LOG_LEVELS.indexOf(level) > this.threshold) return;
    if (this.lines.length >= MAX_ENTRIES) {
      this.dropped += 1;
      return;
    }
    this.lines.push({ at: new Date().toISOString(), level, event, message, ...extra });
  }

  entries(): EngineLogEntry[] {
    return [...this.lines];
  }

  /** JSON lines, one entry per line. */
  toJsonLines(): string {
    const tail =
      this.dropped > 0
        ? [JSON.stringify({ level: 'WARN', message: `${this.dropped} entries not kept` })]
        : [];
    return [...this.lines.map((entry) => JSON.stringify(entry)), ...tail].join('\n') + '\n';
  }

  /** The explorer's events, as log lines. */
  listener(): ExplorationListener {
    return {
      onAuthenticated: (description) => {
        this.log('INFO', 'AUTHENTICATED', description);
      },
      onState: (context, isNew) => {
        this.log(
          isNew ? 'INFO' : 'TRACE',
          isNew ? 'FLOW_STATE_DISCOVERED' : 'FLOW_STATE_REVISITED',
          `${context.stateLabel} (${context.route})`,
          {
            stateId: context.stateId,
            data: {
              url: redactUrl(context.url),
              actions: context.actions.length,
              depth: context.metadata.depth,
            },
          },
        );
      },
      onDecision: (context, decision) => {
        this.log('DEBUG', 'ACTION_SELECTED', `${decision.decision}: ${decision.reason}`, {
          stateId: context.stateId,
          ...(decision.actionId ? { actionId: decision.actionId } : {}),
        });
      },
      onBlocked: (context, action, reason) => {
        this.log('WARN', 'ACTION_BLOCKED', `${action.type} "${actionLabel(action)}": ${reason}`, {
          stateId: context.stateId,
          actionId: action.id,
          data: { classification: action.classification },
        });
      },
      onTransition: (edge, action) => {
        const failed = edge.result !== 'SUCCESS';
        this.log(
          failed ? 'ERROR' : 'INFO',
          failed ? 'ACTION_FAILED' : 'ACTION_EXECUTED',
          `${action.type} "${actionLabel(action)}" → ${failed ? `${edge.result}: ${edge.reason ?? ''}` : edge.to}`,
          {
            stateId: edge.from,
            actionId: edge.actionId,
            data: {
              result: edge.result,
              to: edge.to,
              ...(edge.durationMs !== undefined ? { durationMs: edge.durationMs } : {}),
              requests: edge.network?.length ?? 0,
            },
          },
        );
      },
      onOracle: (edge, verdict) => {
        this.log(
          verdict.status === 'FAIL' ? 'ERROR' : verdict.status === 'WARNING' ? 'WARN' : 'INFO',
          'ORACLE_VERDICT',
          `${verdict.status}${verdict.reasons.length > 0 ? `: ${verdict.reasons.join('; ')}` : ''}`,
          { stateId: edge.from, actionId: edge.actionId, data: { confidence: verdict.confidence } },
        );
      },
      onBacktrack: (from, to, method) => {
        this.log('DEBUG', 'BACKTRACK', `${from} → ${to ?? '(nothing left)'} (${method})`, {
          stateId: from,
        });
      },
      onRecovery: (event) => {
        this.log(
          event.success ? 'INFO' : 'WARN',
          'RECOVERY_ATTEMPT',
          `${event.strategy} after ${event.failure}: ${event.success ? 'recovered' : 'failed'}`,
          {
            stateId: event.stateId,
            ...(event.actionId ? { actionId: event.actionId } : {}),
          },
        );
      },
      onStuck: (event) => {
        this.log('WARN', 'STUCK_DETECTED', `${event.kind}: ${event.message}`, { stateId: event.stateId });
      },
      onIssue: (issue, isNew) => {
        const level =
          issue.severity === 'CRITICAL' || issue.severity === 'ERROR'
            ? 'ERROR'
            : issue.severity === 'WARNING'
              ? 'WARN'
              : 'INFO';
        this.log(isNew ? level : 'TRACE', 'ISSUE_RAISED', `${issue.type}: ${issue.message}`, {
          ...(issue.stateId ? { stateId: issue.stateId } : {}),
          ...(issue.actionId ? { actionId: issue.actionId } : {}),
          data: { severity: issue.severity, occurrences: issue.occurrences },
        });
      },
      onFlowStart: (flow) => {
        this.log('INFO', 'FLOW_STARTED', flow.name);
      },
      onFlowStep: (flow, step) => {
        this.log(
          step.status === 'FAILED' ? 'ERROR' : 'DEBUG',
          'FLOW_STEP',
          `${flow.name} #${step.index} ${step.status}`,
        );
      },
      onFlowEnd: (report) => {
        this.log(
          report.status === 'PASSED' ? 'INFO' : 'ERROR',
          'FLOW_FINISHED',
          `${report.name}: ${report.status}`,
        );
      },
      onInteraction: (result) => {
        this.log('INFO', 'BROWSER_INTERACTION', `${result.type} ${result.status}`);
      },
    };
  }
}

/** Every listener receives every event, in order. */
export function combineListeners(...listeners: (ExplorationListener | undefined)[]): ExplorationListener {
  const present = listeners.filter((listener): listener is ExplorationListener => listener !== undefined);
  const combined: Record<string, (...args: unknown[]) => void> = {};
  const names = new Set(present.flatMap((listener) => Object.keys(listener)));
  for (const name of names) {
    combined[name] = (...args: unknown[]) => {
      for (const listener of present) {
        const handler = (listener as Record<string, ((...args: unknown[]) => void) | undefined>)[name];
        handler?.(...args);
      }
    };
  }
  return combined;
}
