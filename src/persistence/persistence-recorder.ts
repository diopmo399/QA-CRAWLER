import { randomUUID } from 'node:crypto';
import type { ExplorationListener } from '../explorer/flow-explorer.js';
import { observationOf } from '../semantics/resolution/semantic-knowledge.js';
import { actionSignature, stateSignature } from '../knowledge/signatures.js';
import { actionLabel, type DiscoveredAction } from '../model/discovered-action.js';
import type { FlowEdge } from '../model/flow.js';
import type { Issue } from '../model/issue.js';
import type { PageContext } from '../model/page-context.js';
import { redactUrl } from '../security/redactor.js';
import type { KnowledgeService } from './knowledge-service.js';
import { fit, LIMITS, type CrawlRunRecord, type RunStateRecord, type RunTransitionRecord } from './model.js';
import type { PersistenceProvider } from './persistence-provider.js';

/** Ce que l'enregistreur lit d'une action (une action découverte, ou le résumé d'une transition du graphe). */
type ActionRef = Pick<
  DiscoveredAction,
  'id' | 'type' | 'classification' | 'text' | 'label' | 'name' | 'elementType'
>;

/**
 * ENREGISTREUR : un ExplorationListener de plus (le même mécanisme que le journal du
 * moteur et la CLI). Le FlowExplorer ne sait pas qu'il existe, ni quel stockage il y a
 * derrière. Il écoute les événements existants —
 *
 *   onState (STATE_DISCOVERED) · onTransition (TRANSITION_OBSERVED) · onBlocked ·
 *   onIssue (ANOMALY_DETECTED) · start (RUN_STARTED) · finish (RUN_FINISHED)
 *
 * — et écrit par lots réguliers (persistence.flushEvery), jamais tout à la fin seulement.
 * Une écriture qui échoue n'arrête pas le crawl : elle est gardée pour le rapport.
 */
export class PersistenceRecorder {
  private readonly states = new Map<string, RunStateRecord>();
  private readonly dirtyStates = new Set<string>();
  private readonly signatures = new Map<string, string>();
  /** `from::actionId` déjà enregistrés (pour ne pas reprendre deux fois une transition du graphe). */
  private readonly recorded = new Set<string>();
  private transitions: RunTransitionRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly counts = { states: 0, actions: 0, transitions: 0, anomalies: 0 };
  readonly errors: string[] = [];

  constructor(
    private readonly provider: PersistenceProvider,
    readonly run: CrawlRunRecord,
    private readonly knowledge: KnowledgeService | undefined,
    private readonly options: { flushEvery: number; now?: () => string },
  ) {}

  /** RUN_STARTED */
  async start(): Promise<void> {
    await this.provider.runs.create(this.run);
  }

  listener(): ExplorationListener {
    return {
      onState: (context) => {
        this.onState(context);
      },
      onSemanticResolution: (event) => {
        // Une résolution réussie (ou échouée) est une connaissance de plus : transition_knowledge, via le KnowledgeService.
        const observed = observationOf(event);
        if (observed) {
          this.knowledge?.observeTransition(observed);
          this.maybeFlush();
        }
      },
      onTransition: (edge, action) => {
        this.onTransition(edge, action);
      },
      onBlocked: (context, action, reason) => {
        this.onBlocked(context, action, reason);
      },
      onIssue: (_issue: Issue, isNew) => {
        if (isNew) this.counts.anomalies += 1;
      },
    };
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private onState(context: PageContext): void {
    const signature = stateSignature(context.stateLabel);
    this.signatures.set(context.stateId, signature);
    this.knowledge?.observeState(signature);
    const at = this.now();
    const existing = this.states.get(context.stateId);
    if (existing) {
      existing.lastSeenAt = at;
    } else {
      this.counts.states += 1;
      this.states.set(context.stateId, {
        id: randomUUID(),
        runId: this.run.id,
        stateSignature: fit(signature, LIMITS.signature) ?? signature,
        stateId: fit(context.stateId, LIMITS.signature) ?? context.stateId,
        routePattern: fit(context.route, LIMITS.url) ?? '',
        urlNormalized: fit(redactUrl(context.url), LIMITS.url) ?? '',
        ...(context.title ? { title: fit(context.title, LIMITS.label) } : {}),
        ...(context.headings[0] ? { heading: fit(context.headings[0], LIMITS.label) } : {}),
        depth: context.metadata.depth,
        firstSeenAt: at,
        lastSeenAt: at,
        // Seulement des données normalisées : libellé, route, titres, nombre d'actions et de formulaires.
        context: {
          label: context.stateLabel,
          route: context.route,
          headings: context.headings.slice(0, 6),
          dialogs: context.dialogs.slice(0, 3),
          actions: context.actions.length,
          forms: context.forms.length,
        },
      });
    }
    this.dirtyStates.add(context.stateId);
    this.maybeFlush();
  }

  private onTransition(edge: FlowEdge, action: DiscoveredAction): void {
    const finishedAt = edge.timestamp;
    const startedAt =
      edge.durationMs !== undefined
        ? new Date(Date.parse(finishedAt) - edge.durationMs).toISOString()
        : finishedAt;
    const success = edge.result === 'SUCCESS';
    this.record({
      from: edge.from,
      to: success ? edge.to : null,
      action,
      status: edge.result,
      ...(edge.oracle ? { oracleStatus: edge.oracle.status } : {}),
      ...(edge.durationMs !== undefined ? { durationMs: edge.durationMs } : {}),
      startedAt,
      finishedAt,
    });
  }

  /** Une action refusée par la SafetyPolicy : une transition BLOCKED, sans destination. */
  private onBlocked(context: PageContext, action: DiscoveredAction, _reason: string): void {
    const at = this.now();
    this.record({
      from: context.stateId,
      to: null,
      action,
      status: 'BLOCKED',
      startedAt: at,
      finishedAt: at,
    });
  }

  /**
   * Les actions que la SafetyPolicy refuse dès la découverte d'un écran sont écrites BLOCKED
   * dans le graphe sans événement : elles sont reprises du graphe à la fin du run (une fois).
   */
  recordBlockedEdges(edges: readonly FlowEdge[]): void {
    for (const edge of edges) {
      if (edge.result !== 'BLOCKED' || this.recorded.has(`${edge.from}::${edge.actionId}`)) continue;
      this.record({
        from: edge.from,
        to: null,
        action: {
          id: edge.actionId,
          type: edge.action.type,
          classification: edge.action.classification,
          elementType: '',
          ...(edge.action.text !== undefined ? { text: edge.action.text } : {}),
          ...(edge.action.label !== undefined ? { label: edge.action.label } : {}),
        },
        status: 'BLOCKED',
        startedAt: edge.timestamp,
        finishedAt: edge.timestamp,
      });
    }
  }

  private record(input: {
    from: string;
    to: string | null;
    action: ActionRef;
    status: RunTransitionRecord['status'];
    oracleStatus?: string;
    durationMs?: number;
    startedAt: string;
    finishedAt: string;
  }): void {
    const signature = actionSignature(input.action);
    this.recorded.add(`${input.from}::${input.action.id}`);
    this.counts.transitions += 1;
    if (input.status !== 'BLOCKED') this.counts.actions += 1;
    this.transitions.push({
      id: randomUUID(),
      runId: this.run.id,
      fromStateId: fit(input.from, LIMITS.signature) ?? input.from,
      toStateId: input.to === null ? null : (fit(input.to, LIMITS.signature) ?? input.to),
      actionId: fit(input.action.id, LIMITS.signature) ?? input.action.id,
      actionSignature: fit(signature, LIMITS.signature) ?? signature,
      actionType: input.action.type,
      actionLabel: fit(actionLabel(input.action), LIMITS.label) ?? '',
      status: input.status,
      safetyClass: input.action.classification,
      safetyDecision: input.status === 'BLOCKED' ? 'BLOCK' : 'ALLOW',
      ...(input.oracleStatus ? { oracleStatus: input.oracleStatus } : {}),
      ...(input.durationMs !== undefined ? { durationMs: Math.round(input.durationMs) } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
    const from = this.signatures.get(input.from);
    if (from)
      this.knowledge?.observeTransition({
        fromStateSignature: from,
        actionSignature: signature,
        ...(input.to !== null && this.signatures.get(input.to)
          ? { toStateSignature: this.signatures.get(input.to) }
          : {}),
        result: input.status,
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        at: input.finishedAt,
      });
    this.maybeFlush();
  }

  private maybeFlush(): void {
    const pending = this.dirtyStates.size + this.transitions.length + (this.knowledge?.pending ?? 0);
    if (pending >= this.options.flushEvery) void this.flush();
  }

  /** Écrit ce qui attend (états, transitions, connaissances), dans l'ordre, une écriture à la fois. */
  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const states = [...this.dirtyStates].flatMap((id) => {
        const state = this.states.get(id);
        return state ? [{ ...state }] : [];
      });
      this.dirtyStates.clear();
      const transitions = this.transitions;
      this.transitions = [];
      try {
        if (states.length > 0) await this.provider.states.save(states);
        if (transitions.length > 0) await this.provider.transitions.add(transitions);
        await this.knowledge?.flush();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.errors.length < 20) this.errors.push(message.split('\n')[0] ?? message);
        // Rejouées au prochain flush : rien n'est perdu tant que le processus vit.
        for (const state of states) this.dirtyStates.add(state.stateId);
        this.transitions.unshift(...transitions);
      }
    });
    return this.queue;
  }

  /** RUN_FINISHED : tout est écrit, puis le run est clos avec ses compteurs. */
  async finish(status: CrawlRunRecord['status']): Promise<void> {
    await this.flush();
    try {
      await this.provider.runs.update(this.run.id, {
        status: this.errors.length > 0 && status === 'COMPLETED' ? 'COMPLETED' : status,
        finishedAt: this.now(),
        statesCount: this.counts.states,
        actionsCount: this.counts.actions,
        transitionsCount: this.counts.transitions,
        anomaliesCount: this.counts.anomalies,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push(message.split('\n')[0] ?? message);
    }
  }
}
