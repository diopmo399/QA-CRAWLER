import type { ExplorationListener } from '../explorer/flow-explorer.js';
import { actionLabel } from '../model/discovered-action.js';
import { redactText, redactUrl } from '../security/redactor.js';
import type { StaticAnalysisEvent } from '../static-analysis/static-analyzer.js';
import type { RuleEvent } from '../rules/runtime-rule-verifier.js';
import type { FunctionalEvent } from '../functional/functional-intelligence.js';

export const LOG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type EngineEvent =
  | 'AUTHENTICATED'
  | 'FLOW_STATE_DISCOVERED'
  | 'FLOW_STATE_REVISITED'
  | 'ACTION_SELECTED'
  | 'GOAL_REACHED'
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
  | 'BROWSER_INTERACTION'
  | 'KNOWLEDGE_LOADED'
  | 'KNOWLEDGE_AGED'
  | 'CONFIDENCE_EVALUATED'
  | 'SEMANTIC_RESOLUTION_SUCCEEDED'
  | 'SEMANTIC_RESOLUTION_FAILED'
  | 'SEMANTIC_RESOLUTION_AMBIGUOUS'
  | 'FLOW_EVOLVED'
  | 'ANOMALY_CREATED'
  | 'ANOMALY_RESOLVED'
  | 'ANOMALY_REOPENED'
  | 'ANOMALY_FLAKY'
  | 'NAVIGATION_DETECTED'
  | 'NAVIGATION_RECOVERED'
  | 'NAVIGATION_RECOVERY_FAILED'
  | 'DRY_RUN_STARTED'
  | 'FLOW_INTENT_PARSED'
  | 'INTENT_MATCHED'
  | 'INTENT_MISMATCH'
  | 'GUIDED_EXPLORATION_STARTED'
  | 'PATH_DISCOVERED'
  | 'FLOW_STEP_INSERTED'
  | 'FLOW_STEP_POSSIBLY_OBSOLETE'
  | 'FLOW_STEP_REORDERED'
  | 'FLOW_STEP_AMBIGUOUS'
  | 'FLOW_RECONCILIATION_COMPLETED'
  | 'SUGGESTED_FLOW_GENERATED'
  | 'DRY_RUN_COMPLETED'
  | StaticAnalysisEvent
  | RuleEvent
  | FunctionalEvent;

/**
 * Une ligne du journal du moteur (engine-log.jsonl). Seulement des id, des libellés
 * et des URL masquées : jamais une valeur saisie, un en-tête, un cookie ni un secret.
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

/** Arrête l'enregistrement au-delà de ce nombre de lignes (un run très long reste lisible). */
const MAX_ENTRIES = 50_000;

/**
 * Journal structuré de ce qu'a fait le moteur, filtré par niveau : ERROR (échecs,
 * plantages), WARN (blocages, récupération, blocage en boucle), INFO (états,
 * transitions, verdicts), DEBUG (décisions, retours arrière), TRACE (états revisités,
 * chaque occurrence d'anomalie).
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
    // Les messages citent des pages et des erreurs : quoi qu'ils contiennent, aucun secret ne sort.
    this.lines.push({ at: new Date().toISOString(), level, event, message: redactText(message), ...extra });
  }

  entries(): EngineLogEntry[] {
    return [...this.lines];
  }

  /** Lignes JSON, une entrée par ligne. */
  toJsonLines(): string {
    const tail =
      this.dropped > 0
        ? [JSON.stringify({ level: 'WARN', message: `${this.dropped} entries not kept` })]
        : [];
    return [...this.lines.map((entry) => JSON.stringify(entry)), ...tail].join('\n') + '\n';
  }

  /** Les événements de l'explorateur, sous forme de lignes de journal. */
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
        // Aucune décision opaque : le score et chaque raison sont journalisés.
        this.log(
          decision.decision === 'EXECUTE' ? 'INFO' : 'DEBUG',
          'ACTION_SELECTED',
          `${decision.decision}: ${decision.reason}`,
          {
            stateId: context.stateId,
            ...(decision.actionId ? { actionId: decision.actionId } : {}),
            ...(decision.breakdown
              ? { data: { score: decision.breakdown.total, reasons: decision.breakdown.reasons.join('; ') } }
              : {}),
          },
        );
      },
      onGoal: (goal) => {
        this.log('INFO', 'GOAL_REACHED', `${goal.id}: ${goal.description}`, {
          ...(goal.evidence[0] ? { stateId: goal.evidence[0].stateId } : {}),
          data: { evidence: goal.evidence.map((entry) => `${entry.kind}: ${entry.value}`).join('; ') },
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
          {
            stateId: edge.from,
            actionId: edge.actionId,
            data: {
              confidence: verdict.confidence,
              ...(verdict.categories.length > 0 ? { categories: verdict.categories.join(', ') } : {}),
            },
          },
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
      onNavigation: (event) => {
        // Technique, pas une anomalie : une navigation a interrompu une lecture de la page.
        this.log(
          event.type === 'NAVIGATION_RECOVERY_FAILED' ? 'WARN' : 'DEBUG',
          event.type,
          `${event.operation}: ${event.previousUrl} → ${event.currentUrl} (${event.reason}${event.retries !== undefined ? `, ${String(event.retries)} retries` : ''}${event.durationMs !== undefined ? `, ${String(event.durationMs)} ms` : ''}${event.cause ? `: ${event.cause}` : ''})`,
          { ...(event.actionId ? { actionId: event.actionId } : {}) },
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
      onStaticAnalysis: (event) => {
        const warn =
          event.event === 'SEMANTIC_EVIDENCE_CONFLICT' ||
          event.event === 'STATIC_ANALYSIS_BUDGET_EXHAUSTED' ||
          event.event === 'STATIC_ANALYSIS_UNAVAILABLE' ||
          event.event === 'STATIC_PATH_REJECTED' ||
          event.event === 'SOURCE_MAP_REJECTED' ||
          event.event === 'SOURCE_MAP_PARTIAL' ||
          event.event === 'SOURCE_CONTENT_CONFLICT' ||
          event.event === 'SOURCE_BUILD_MISMATCH' ||
          event.event === 'BUNDLE_FALLBACK_STARTED';
        const detail =
          event.event.startsWith('STATIC_ROUTE') ||
          event.event.startsWith('STATIC_FIELD') ||
          event.event.startsWith('STATIC_FORM') ||
          event.event.startsWith('STATIC_DATA') ||
          event.event.startsWith('STATIC_HTTP') ||
          event.event === 'SOURCE_EXTRACTED' ||
          event.event === 'BUNDLE_DISCOVERED' ||
          event.event === 'SOURCE_MAP_REFERENCE_DISCOVERED' ||
          event.event === 'SOURCE_MAP_LOADING_STARTED';
        this.log(warn ? 'WARN' : detail ? 'DEBUG' : 'INFO', event.event, redactText(event.message));
      },
      onRule: (event) => {
        const warn =
          event.event === 'RULE_RUNTIME_CONTRADICTED' ||
          event.event === 'RULE_VERIFICATION_INCONCLUSIVE' ||
          event.event === 'RULE_BLOCKED_BY_POLICY';
        const detail =
          event.event === 'RULE_DISCOVERED' ||
          event.event === 'RULE_CANDIDATE_DISCOVERED' ||
          event.event === 'FIELD_DEPENDENCY_DISCOVERED';
        this.log(warn ? 'WARN' : detail ? 'DEBUG' : 'INFO', event.event, redactText(event.message));
      },
      onFunctional: (event) => {
        const warn =
          event.event === 'INVARIANT_VIOLATED' ||
          event.event === 'SIDE_EFFECT_MISSING' ||
          event.event === 'CONTRACT_RUNTIME_MISMATCH' ||
          event.event === 'TEST_GOAL_FAILED' ||
          event.event === 'TEST_GOAL_BLOCKED';
        const detail =
          event.event === 'BUSINESS_STATE_DISCOVERED' ||
          event.event === 'BUSINESS_TRANSITION_DISCOVERED' ||
          event.event === 'INVARIANT_DISCOVERED' ||
          event.event === 'WORKFLOW_DISCOVERED' ||
          event.event === 'SIDE_EFFECT_EXPECTED' ||
          event.event === 'TEST_GOAL_GENERATED' ||
          event.event === 'TEST_GOAL_PROGRESS';
        this.log(warn ? 'WARN' : detail ? 'DEBUG' : 'INFO', event.event, redactText(event.message));
      },
      onSemanticResolution: (event) => {
        const kind =
          event.outcome === 'SUCCEEDED'
            ? 'SEMANTIC_RESOLUTION_SUCCEEDED'
            : event.outcome === 'AMBIGUOUS'
              ? 'SEMANTIC_RESOLUTION_AMBIGUOUS'
              : 'SEMANTIC_RESOLUTION_FAILED';
        this.log(
          event.outcome === 'SUCCEEDED' ? 'INFO' : 'WARN',
          kind,
          `${event.intent}${event.selected ? ` → "${event.selected}"` : ''} ${event.outcome} (${event.score} ${event.confidence})`,
          {
            stateId: event.stateId,
            data: {
              flow: event.flow,
              outcome: event.outcome,
              intentKey: event.intentKey,
              score: event.score,
              confidence: event.confidence,
              candidates: redactText(
                event.candidates.map((candidate) => `${candidate.label} ${candidate.score}`).join(' | '),
              ),
              ...(event.reason ? { reason: redactText(event.reason) } : {}),
            },
          },
        );
      },
    };
  }
}

/** Chaque listener reçoit chaque événement, dans l'ordre. */
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
