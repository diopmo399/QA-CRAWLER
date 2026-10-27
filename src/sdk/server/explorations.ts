import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ScenarioConfig } from '../../config/config.js';
import type { ExplorationListener } from '../../explorer/flow-explorer.js';
import type { ExplorationResult } from '../../model/exploration-result.js';
import type { FlowStepReport } from '../../model/flow-run.js';
import type { RunOptions, RunOutcome } from '../../orchestrator.js';
import { redactText } from '../../security/redactor.js';
import type {
  ExecutionKind,
  ExplorationBudget,
  ExplorationCounters,
  ExplorationEvent,
  ExplorationSnapshot,
  ExplorationStatus,
  ExplorationSummary,
  ReportKind,
} from '../core/contracts.js';
import { REPORT_KINDS } from '../core/contracts.js';
import { applyEvent, canTransition, emptyCounters, isTerminal } from '../core/lifecycle.js';

/**
 * LES EXPLORATIONS DU SERVEUR : chacune lance le vrai moteur (`runMission`) avec un écouteur qui
 * relaie ses événements. Une seule exploration à la fois par défaut (un navigateur, une machine) :
 * les suivantes attendent en QUEUED. Rien n'est simulé : un compteur n'avance que sur un événement
 * du moteur, et COMPLETED n'est annoncé qu'avec le résultat du moteur.
 */
export type MissionRunner = (config: ScenarioConfig, options: RunOptions) => Promise<RunOutcome>;

export interface ExplorationRequest {
  projectId: string;
  config: ScenarioConfig;
  /** Le dossier des rapports de cette exploration (sous le projet). */
  reportsDir: string;
  /** EXPLORATION (défaut) ou REPLAY : la même mécanique, une autre mission du moteur. */
  kind?: ExecutionKind;
  /** Les variables d'environnement d'exécution de CETTE mission (variables d'un environnement du projet). */
  env?: NodeJS.ProcessEnv;
}

type Listener = (event: ExplorationEvent) => void;

const MAX_EVENTS = 2000;
const MAX_ISSUES_IN_SUMMARY = 200;

export class Exploration {
  readonly id: string;
  readonly projectId: string;
  readonly reportsDir: string;
  readonly budget: ExplorationBudget;
  readonly queuedAt = new Date().toISOString();
  status: ExplorationStatus = 'QUEUED';
  startedAt?: string;
  finishedAt?: string;
  counters: ExplorationCounters = emptyCounters();
  error?: string;
  summary?: ExplorationSummary;
  private seq = 0;
  /** L'annulation : passée au moteur (RunOptions.signal). */
  readonly abort = new AbortController();
  private readonly events: ExplorationEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly seenStates = new Set<string>();

  constructor(
    readonly request: ExplorationRequest,
    id = `exp_${randomBytes(9).toString('base64url')}`,
  ) {
    this.id = id;
    this.projectId = request.projectId;
    this.reportsDir = request.reportsDir;
    const exploration = request.config.exploration;
    this.budget = {
      maxStates: exploration.maxStates,
      maxActions: exploration.maxActions,
      maxDurationMinutes: exploration.maxDurationMinutes,
      maxDepth: exploration.maxDepth,
    };
    this.emit({ type: 'status', status: 'QUEUED' });
  }

  get lastSeq(): number {
    return this.seq;
  }

  snapshot(): ExplorationSnapshot {
    return {
      id: this.id,
      projectId: this.projectId,
      status: this.status,
      queuedAt: this.queuedAt,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.finishedAt ? { finishedAt: this.finishedAt } : {}),
      serverTime: new Date().toISOString(),
      budget: this.budget,
      counters: this.counters,
      ...(this.error ? { error: this.error } : {}),
      lastSeq: this.seq,
      kind: this.request.kind ?? 'EXPLORATION',
      run: path.basename(this.reportsDir),
    };
  }

  /** Les événements après `after` (les plus anciens peuvent avoir été oubliés : les compteurs, eux, sont complets). */
  eventsAfter(after: number): ExplorationEvent[] {
    return this.events.filter((event) => event.seq > after);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get terminal(): boolean {
    return isTerminal(this.status);
  }

  /** Distribution d'un événement : numéroté, horodaté, compté, conservé, envoyé aux abonnés. */
  emit(partial: DistributiveOmit<ExplorationEvent, 'seq' | 'at'>): void {
    const event = { ...partial, seq: ++this.seq, at: new Date().toISOString() };
    this.counters = applyEvent(this.counters, event);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // un abonné défaillant n'arrête ni l'exploration ni les autres abonnés
      }
    }
  }

  transition(to: ExplorationStatus, message?: string): void {
    if (!canTransition(this.status, to)) return;
    this.status = to;
    if (to === 'RUNNING') this.startedAt = new Date().toISOString();
    if (isTerminal(to)) this.finishedAt = new Date().toISOString();
    this.emit({ type: 'status', status: to, ...(message ? { message } : {}) });
  }

  /** L'écouteur branché sur le moteur : seulement des faits observés, sans valeur saisie. */
  listener(): ExplorationListener {
    return {
      onAuthenticated: (description) => {
        this.emit({ type: 'authenticated', message: redactText(description) });
      },
      onState: (context, isNew) => {
        if (!isNew || this.seenStates.has(context.stateId)) return;
        this.seenStates.add(context.stateId);
        this.emit({
          type: 'state',
          stateId: context.stateId,
          label: redactText(context.stateLabel),
          route: redactText(context.route),
          title: redactText(context.title),
        });
      },
      onTransition: (edge, action) => {
        this.emit({
          type: 'transition',
          from: edge.from,
          to: edge.to,
          action: redactText(
            action.text ?? action.label ?? edge.action.text ?? edge.action.label ?? edge.action.type,
          ),
          changed: edge.to !== edge.from,
        });
      },
      onBlocked: (context, action, reason) => {
        this.emit({
          type: 'blocked',
          stateId: context.stateId,
          action: redactText(action.text ?? action.label ?? action.type),
          reason: redactText(reason),
        });
      },
      onFlowStart: (flow) => {
        this.emit({ type: 'flow', flow: redactText(flow.name), phase: 'start' });
      },
      onFlowStep: (flow, step) => {
        this.emit({
          type: 'flow-step',
          flow: redactText(flow.name),
          index: step.index,
          kind: step.kind,
          label: stepLabel(step),
          status: step.status,
          durationMs: step.durationMs,
          // La raison d'une saisie peut citer la valeur : elle n'est jamais relayée.
          ...(step.reason && !VALUE_KINDS.has(step.kind) && !FREE_TEXT_KINDS.has(step.kind)
            ? { reason: redactText(step.reason).slice(0, 300) }
            : {}),
        });
      },
      onFlowEnd: (report) => {
        this.emit({
          type: 'flow',
          flow: redactText(report.name),
          phase: 'end',
          status: report.status,
          durationMs: report.durationMs,
          steps: report.steps.length,
        });
      },
      onIssue: (issue, isNew) => {
        if (!isNew) return;
        let route: string | undefined;
        try {
          route = new URL(issue.pageUrl).pathname;
        } catch {
          route = undefined;
        }
        this.emit({
          type: 'issue',
          severity: issue.severity,
          issueType: issue.type,
          message: redactText(issue.message),
          ...(route ? { route } : {}),
        });
      },
    };
  }
}

/** Les étapes dont la description du moteur porte la valeur saisie ou choisie (après « = »). */
const VALUE_KINDS = new Set(['fill', 'select']);
/** Les étapes décrites par une phrase libre, qui peut citer une valeur. */
const FREE_TEXT_KINDS = new Set(['auto', 'intent', 'manual']);

/**
 * Le libellé public d'une étape : la description du moteur, sans valeur. `fill … = "valeur"` garde sa
 * cible ; une phrase libre (auto, intention, vérification manuelle) n'est désignée que par son genre.
 */
export function stepLabel(step: Pick<FlowStepReport, 'kind' | 'description'>): string {
  if (VALUE_KINDS.has(step.kind))
    return redactText(step.description.replace(/\s=\s[\s\S]*$/, '')).slice(0, 200);
  if (FREE_TEXT_KINDS.has(step.kind)) return step.kind;
  return redactText(step.description).slice(0, 200);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ExplorationManagerOptions {
  run: MissionRunner;
  env: NodeJS.ProcessEnv;
  /** Explorations simultanées (défaut 1). */
  concurrency?: number;
  onWarning?: (message: string) => void;
}

export class ExplorationManager {
  private readonly explorations = new Map<string, Exploration>();
  private readonly queue: Exploration[] = [];
  private running = 0;
  private readonly concurrency: number;

  constructor(private readonly options: ExplorationManagerOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  get(id: string): Exploration | undefined {
    return this.explorations.get(id);
  }

  /**
   * L'ANNULATION : en file, l'exploration n'est jamais lancée (CANCELLED tout de suite) ; en cours, le
   * moteur reçoit le signal et s'arrête à la prochaine vérification de ses limites, puis CANCELLED
   * quand il a rendu son résultat. Une exploration terminée ne s'annule plus (`false`).
   */
  cancel(id: string): boolean {
    const exploration = this.explorations.get(id);
    if (!exploration || exploration.terminal) return false;
    const queued = this.queue.indexOf(exploration);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      exploration.transition('CANCELLED', 'cancelled before it started');
      return true;
    }
    if (!exploration.abort.signal.aborted) {
      exploration.abort.abort();
      exploration.emit({ type: 'phase', phase: 'cancellation requested' });
    }
    return true;
  }

  start(request: ExplorationRequest): Exploration {
    const exploration = new Exploration({
      ...request,
      config: {
        ...request.config,
        output: {
          ...request.config.output,
          reportsDir: request.reportsDir,
          screenshotsDir: path.join(request.reportsDir, 'screenshots'),
        },
      },
    });
    this.explorations.set(exploration.id, exploration);
    this.queue.push(exploration);
    this.pump();
    return exploration;
  }

  /** Annule tout ce qui n'est pas terminé (arrêt du serveur) ; le nombre d'explorations annulées. */
  cancelAll(): number {
    let cancelled = 0;
    for (const exploration of this.explorations.values()) if (this.cancel(exploration.id)) cancelled += 1;
    return cancelled;
  }

  /**
   * Attend la fin de toutes les explorations (arrêt du serveur, tests). `timeoutMs` : n'attend pas
   * plus longtemps ; `false` si des explorations tournent encore à l'échéance.
   */
  async idle(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 || this.queue.length > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.running += 1;
      void this.execute(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async execute(exploration: Exploration): Promise<void> {
    exploration.transition('RUNNING');
    let lastPhase = '';
    try {
      const outcome = await this.options.run(exploration.request.config, {
        listener: exploration.listener(),
        env: exploration.request.env ?? this.options.env,
        signal: exploration.abort.signal,
        onWarning: (message) => this.options.onWarning?.(redactText(message)),
        onProgress: (update) => {
          // Une phase est annoncée une fois, quand elle commence (pas à chaque détail).
          if (update.state !== 'RUNNING' || update.label === lastPhase) return;
          lastPhase = update.label;
          exploration.emit({ type: 'phase', phase: redactText(update.label) });
        },
      });
      exploration.summary = summarize(outcome, exploration.request.config.output.reportsDir);
      exploration.emit({ type: 'completed', summary: exploration.summary });
      // Annulée en cours : le moteur s'est arrêté et a écrit son rapport (stopReason `cancelled`).
      exploration.transition(outcome.result.stopReason === 'cancelled' ? 'CANCELLED' : 'COMPLETED');
    } catch (error) {
      exploration.error = redactText(error instanceof Error ? error.message : String(error));
      exploration.emit({ type: 'failed', error: exploration.error });
      exploration.transition('FAILED', exploration.error);
    }
  }
}

/** Le résumé publié d'un ExplorationResult : ses chiffres, ses anomalies, ses rapports (noms de fichiers). */
export function summarize(outcome: RunOutcome, reportsDir: string): ExplorationSummary {
  const result: ExplorationResult = outcome.result;
  const reports: Partial<Record<ReportKind, string>> = {};
  for (const kind of REPORT_KINDS) {
    const file = result.artifacts[kind];
    if (typeof file !== 'string') continue;
    const relative = path.relative(path.resolve(reportsDir), path.resolve(file));
    if (!relative.startsWith('..') && !path.isAbsolute(relative))
      reports[kind] = relative.split(path.sep).join('/');
  }
  const bySeverity: Partial<Record<string, number>> = result.stats.issuesBySeverity;
  return {
    stopReason: result.stopReason,
    passed: outcome.passed,
    durationMs: result.durationMs,
    stats: {
      states: result.stats.states,
      transitions: result.stats.transitions,
      actionsExecuted: result.stats.actionsExecuted,
      actionsBlocked: result.stats.actionsBlocked,
      issuesBySeverity: {
        INFO: bySeverity.INFO ?? 0,
        WARNING: bySeverity.WARNING ?? 0,
        ERROR: bySeverity.ERROR ?? 0,
        CRITICAL: bySeverity.CRITICAL ?? 0,
      },
    },
    issues: result.issues.slice(0, MAX_ISSUES_IN_SUMMARY).map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      type: issue.type,
      message: redactText(issue.message),
      pageUrl: redactText(issue.pageUrl),
    })),
    reports,
  };
}
