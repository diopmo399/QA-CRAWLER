import type { FlowStep } from '../config/flow-schema.js';
import { slug } from '../knowledge/signatures.js';
import type { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { DryRunCandidate, DryRunDriver } from './dry-run-driver.js';
import { describeFlowIntent, type FlowIntent, type FlowIntentGraph } from './flow-intent-graph.js';
import {
  DryRunBudget,
  IntentPathResolver,
  type DryRunBudgetLimits,
  type PathResolution,
  type PathStep,
} from './intent-path-resolver.js';
import type {
  DryRunStopReason,
  IntentFinding,
  ObservedFlowGraph,
  ObservedState,
  ObservedStep,
} from './reconciliation-model.js';

export const DRY_RUN_EVENT_TYPES = [
  'DRY_RUN_STARTED',
  'FLOW_INTENT_PARSED',
  'INTENT_MATCHED',
  'INTENT_MISMATCH',
  'GUIDED_EXPLORATION_STARTED',
  'PATH_DISCOVERED',
  'FLOW_STEP_INSERTED',
  'FLOW_STEP_POSSIBLY_OBSOLETE',
  'FLOW_STEP_REORDERED',
  'FLOW_STEP_AMBIGUOUS',
  'FLOW_RECONCILIATION_COMPLETED',
  'SUGGESTED_FLOW_GENERATED',
  'DRY_RUN_COMPLETED',
] as const;
export type DryRunEventType = (typeof DRY_RUN_EVENT_TYPES)[number];

/** Un événement du Dry Run : des libellés et des statuts, jamais une valeur saisie. */
export interface DryRunEvent {
  type: DryRunEventType;
  at: string;
  flow: string;
  intentId?: string;
  message: string;
}

export interface DryRunOptions {
  budget: DryRunBudgetLimits;
  /** false : la première intention introuvable arrête l'analyse (le reste est NOT_VERIFIED). */
  continueAfterMismatch: boolean;
  /** Intentions suivantes cherchées en même temps que celle attendue (étape obsolète). */
  lookahead?: number;
}

export interface DryRunOutcome {
  observed: ObservedFlowGraph;
  findings: IntentFinding[];
}

/**
 * DRY RUN ENGINE : confronte le flow ATTENDU à l'application, sans le prendre pour vrai.
 *
 * Chaque intention est un point de passage sémantique. Trouvée sur l'écran : exécutée
 * (si la SafetyPolicy le permet). Introuvable : l'analyse ne s'arrête PAS — exploration
 * guidée vers elle ou vers les suivantes ; celles qu'on dépasse sont mises de côté,
 * réessayées après chaque intention trouvée (réordonnancement), puis qualifiées à la fin.
 * Aucune suggestion n'est faite en cours de route : le moteur enregistre ce qu'il voit ;
 * la réconciliation et le flow suggéré viennent une seule fois, à la fin.
 */
export class DryRunEngine {
  private readonly states = new Map<string, ObservedState>();
  private readonly steps: ObservedStep[] = [];
  private readonly findings = new Map<string, IntentFinding>();
  /** (écran, intention) déjà cherchées sans succès : jamais cherchées à nouveau depuis le même écran. */
  private readonly searched = new Set<string>();
  private flow = '';

  constructor(
    private readonly driver: DryRunDriver,
    private readonly options: DryRunOptions,
    private readonly onEvent: (event: DryRunEvent) => void = () => undefined,
    private readonly dictionary?: SemanticDictionary,
  ) {}

  async run(graph: FlowIntentGraph): Promise<DryRunOutcome> {
    this.flow = graph.name;
    const budget = new DryRunBudget(this.options.budget, () => this.driver.now());
    const resolver = new IntentPathResolver(this.driver, budget, this.dictionary);
    this.emit('DRY_RUN_STARTED', `dry run of "${graph.name}" (${graph.source.type})`);
    this.emit('FLOW_INTENT_PARSED', `${String(graph.intents.length)} intent(s)`);

    const start = await this.driver.start(graph.startAt);
    if (!start) {
      for (const intent of graph.intents)
        this.find(intent, 'NOT_VERIFIED', 0, ['the start page could not be loaded']);
      return this.outcome(graph, 'START_FAILED', budget);
    }
    this.remember(start);

    let stopReason: DryRunStopReason = 'COMPLETED';
    const pending: FlowIntent[] = [];
    const intents = graph.intents;
    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index];
      if (!intent) continue;
      const exhausted = budget.exhausted();
      if (exhausted) {
        stopReason = 'EXPLORATION_BUDGET_EXHAUSTED';
        for (const rest of intents.slice(index))
          this.find(rest, 'NOT_VERIFIED', 0, [
            `exploration budget exhausted (${exhausted}) before this intent`,
          ]);
        break;
      }
      const jump = await this.attempt(intent, intents.slice(index + 1), resolver, pending);
      if (jump === 'STOP') {
        stopReason = budget.exhausted() ? 'EXPLORATION_BUDGET_EXHAUSTED' : 'COMPLETED';
        for (const rest of intents.slice(index + 1))
          if (!this.findings.has(rest.id))
            this.find(rest, 'NOT_VERIFIED', 0, [
              budget.exhausted()
                ? `exploration budget exhausted (${budget.exhausted() ?? ''})`
                : 'analysis stopped at the first mismatch (continueAfterMismatch: false)',
            ]);
        break;
      }
      if (jump > 0) index += jump;
      await this.retryPending(pending);
    }

    // Ce qui n'a jamais été trouvé : qualifié avec ce que le run et la mémoire savent.
    for (const intent of pending) {
      const finding = this.findings.get(intent.id);
      if (!finding || finding.outcome !== 'NOT_FOUND') continue;
      const seen = this.driver.seenDuringRun?.(intent) ?? false;
      const history = this.driver.historicalObservations?.(intent);
      finding.seenElsewhere = seen;
      if (history !== undefined) finding.historicalObservations = history;
      this.emit('FLOW_STEP_POSSIBLY_OBSOLETE', `${describeFlowIntent(intent)} not found`, intent.id);
    }
    return this.outcome(graph, stopReason, budget);
  }

  /** Une intention : sur l'écran ? sinon exploration guidée. Rend le nombre d'intentions sautées, ou STOP. */
  private async attempt(
    intent: FlowIntent,
    following: readonly FlowIntent[],
    resolver: IntentPathResolver,
    pending: FlowIntent[],
  ): Promise<number | 'STOP'> {
    if (intent.type === 'CUSTOM' && !intent.required) {
      this.find(intent, 'NOT_VERIFIED', 0, ['manual check: not verifiable by the robot']);
      return 0;
    }
    const checking = intent.type === 'ASSERT' || intent.type === 'CUSTOM';
    if (checking) {
      const result = await this.driver.perform(intent);
      if (result.status === 'PASSED') {
        this.matched(intent, result.state, result.target, result.confidence, [result.reason ?? 'verified']);
        return 0;
      }
      if (result.status === 'NOT_VERIFIED') {
        this.find(intent, 'NOT_VERIFIED', 0, [result.reason ?? 'not verifiable on this screen']);
        return 0;
      }
    } else {
      const probe = await this.driver.probe(intent);
      if (probe.status === 'AMBIGUOUS') {
        this.find(intent, 'AMBIGUOUS', probe.confidence, [probe.reason]);
        this.emit('FLOW_STEP_AMBIGUOUS', `${describeFlowIntent(intent)}: ${probe.reason}`, intent.id);
        return 0;
      }
      if (probe.status === 'BLOCKED') {
        this.find(
          intent,
          'BLOCKED_BY_POLICY',
          0.9,
          [probe.reason],
          [`found "${probe.target ?? intent.label}"`],
        );
        return 0;
      }
      if (probe.status === 'RESOLVED') {
        const done = await this.driver.perform(intent);
        if (done.status === 'PASSED') {
          this.matched(intent, done.state, done.target ?? probe.target, done.confidence, [probe.reason]);
          return 0;
        }
        if (done.status === 'BLOCKED') {
          this.find(intent, 'BLOCKED_BY_POLICY', 0.9, [done.reason ?? 'refused by the safety policy']);
          return 0;
        }
      }
    }

    // Pas sur l'écran : ne pas conclure, chercher.
    this.emit(
      'INTENT_MISMATCH',
      `${describeFlowIntent(intent)} not on "${this.driver.current().label}"`,
      intent.id,
    );
    if (!this.options.continueAfterMismatch) {
      this.find(intent, checking && intent.type === 'ASSERT' ? 'ASSERTION_MISMATCH' : 'NOT_FOUND', 0.5, [
        'not found on the current screen; guided exploration disabled (continueAfterMismatch: false)',
      ]);
      pending.push(intent);
      return 'STOP';
    }
    const lookahead = checking
      ? []
      : following
          .filter((next) => next.required && next.type !== 'ASSERT' && next.type !== 'CUSTOM')
          .slice(0, this.options.lookahead ?? 3);
    const targets = [intent, ...lookahead];
    const from = this.driver.current();
    const key = `${from.signature}|${targets.map((target) => target.id).join(',')}`;
    if (this.searched.has(key)) {
      this.find(intent, 'NOT_FOUND', 0.6, ['already searched from this screen without finding it'], [], true);
      pending.push(intent);
      return 0;
    }
    this.emit(
      'GUIDED_EXPLORATION_STARTED',
      `looking for ${targets.map((t) => `"${t.label}"`).join(', ')}`,
      intent.id,
    );
    const resolution = await resolver.resolvePath(targets);
    return this.afterSearch(intent, targets, resolution, pending, key, from);
  }

  private async afterSearch(
    intent: FlowIntent,
    targets: readonly FlowIntent[],
    resolution: PathResolution,
    pending: FlowIntent[],
    key: string,
    from: ObservedState,
  ): Promise<number | 'STOP'> {
    const checking = intent.type === 'ASSERT' || intent.type === 'CUSTOM';
    switch (resolution.status) {
      case 'EXHAUSTED':
        this.find(intent, 'NOT_VERIFIED', 0, resolution.reasons);
        return 'STOP';
      case 'BLOCKED':
        this.find(
          intent,
          'BLOCKED_BY_POLICY',
          resolution.confidence,
          resolution.reasons,
          resolution.blocked ? [`blocked action: "${resolution.blocked.action}"`] : [],
        );
        return 0;
      case 'NOT_FOUND':
        this.searched.add(key);
        await this.driver.restore(from.id);
        if (checking && intent.type === 'ASSERT') {
          this.find(intent, 'ASSERTION_MISMATCH', 0.8, [
            'the expected outcome is not observable on this screen, nor on the screens reachable from it',
            ...resolution.reasons,
          ]);
          return 0;
        }
        this.find(intent, 'NOT_FOUND', resolution.confidence, resolution.reasons, [], true);
        pending.push(intent);
        return 0;
      case 'FOUND':
        break;
    }
    const reached = resolution.targetIndex ?? 0;
    const alternatives = resolution.alternatives.length > 0 ? resolution.alternatives : undefined;
    for (const step of resolution.path) this.guided(step, alternatives);
    this.emit(
      'PATH_DISCOVERED',
      `${resolution.path.map((step) => step.action.label).join(' → ') || '(same screen)'} → ${targets[reached]?.label ?? ''}`,
      intent.id,
    );
    // Les intentions dépassées sont mises de côté : obsolètes, ou réordonnées si on les retrouve plus loin.
    for (const skipped of targets.slice(0, reached)) {
      this.find(skipped, 'NOT_FOUND', 0.6, [
        `not found; the flow continued with "${targets[reached]?.label ?? ''}" without it`,
      ]);
      pending.push(skipped);
    }
    const target = targets[reached];
    if (!target) return 0;
    const done = await this.driver.perform(target);
    if (done.status === 'PASSED') {
      this.matched(
        target,
        done.state,
        done.target,
        Math.min(done.confidence, 1),
        [...resolution.reasons, done.reason ?? ''].filter(Boolean),
      );
    } else if (done.status === 'BLOCKED') {
      this.find(target, 'BLOCKED_BY_POLICY', 0.9, [done.reason ?? 'refused by the safety policy']);
    } else if (target.type === 'ASSERT') {
      this.find(target, 'ASSERTION_MISMATCH', 0.7, [done.reason ?? 'the expected outcome is not observed']);
    } else {
      this.find(target, 'NOT_FOUND', 0.5, [`found but failed: ${done.reason ?? ''}`]);
      pending.push(target);
    }
    return reached;
  }

  /** Après chaque intention trouvée : une intention mise de côté est-elle là maintenant ? (réordonnancement) */
  private async retryPending(pending: FlowIntent[]): Promise<void> {
    for (const intent of [...pending]) {
      if (intent.type === 'ASSERT' || intent.type === 'CUSTOM') continue;
      const probe = await this.driver.probe(intent);
      if (probe.status !== 'RESOLVED') continue;
      const done = await this.driver.perform(intent);
      if (done.status !== 'PASSED') continue;
      pending.splice(pending.indexOf(intent), 1);
      this.findings.delete(intent.id);
      this.matched(intent, done.state, done.target ?? probe.target, done.confidence, [
        'found later in the flow than expected',
        probe.reason,
      ]);
      const finding = this.findings.get(intent.id);
      if (finding) finding.late = true;
      this.emit('FLOW_STEP_REORDERED', `${describeFlowIntent(intent)} found later than expected`, intent.id);
    }
  }

  private matched(
    intent: FlowIntent,
    to: ObservedState,
    target: string | undefined,
    confidence: number,
    reasons: string[],
  ): void {
    const from = this.lastState();
    this.remember(to);
    const step: ObservedStep = {
      id: `o${String(this.steps.length + 1)}`,
      origin: 'INTENT',
      intentId: intent.id,
      type: intent.type,
      label: target ?? intent.label,
      semanticTarget: intent.semanticTarget,
      from: from.id,
      to: to.id,
      status: 'PASSED',
      provenance: 'OBSERVED',
      reasons,
      step: intent.step,
    };
    this.steps.push(step);
    this.findings.set(intent.id, {
      intentId: intent.id,
      outcome: 'MATCHED',
      observedStepId: step.id,
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      evidence: [`state "${to.label}" (${to.signature})`, ...(target ? [`target "${target}"`] : [])],
    });
    this.emit('INTENT_MATCHED', `${describeFlowIntent(intent)} → "${to.label}"`, intent.id);
  }

  private guided(step: PathStep, alternatives: string[][] | undefined): void {
    this.remember(step.from);
    this.remember(step.to);
    const observed: ObservedStep = {
      id: `o${String(this.steps.length + 1)}`,
      origin: 'GUIDED',
      type: step.action.category === 'submit' ? 'SUBMIT' : 'CLICK',
      label: step.action.label,
      semanticTarget: slug(step.action.label),
      action: {
        id: step.action.id,
        signature: step.action.signature,
        label: step.action.label,
        type: step.action.type,
        category: step.action.category,
        classification: step.action.classification,
        ...(step.action.role ? { role: step.action.role } : {}),
        ...(step.action.href ? { href: step.action.href } : {}),
      },
      ...(step.formFields && step.formFields.length > 0 ? { formFields: step.formFields } : {}),
      from: step.from.id,
      to: step.to.id,
      status: 'PASSED',
      provenance: step.provenance,
      ...(alternatives ? { alternatives } : {}),
      reasons: step.reasons,
      step: stepOfAction(step.action),
    };
    this.steps.push(observed);
    this.emit('FLOW_STEP_INSERTED', `"${step.action.label}" (${step.from.label} → ${step.to.label})`);
  }

  private find(
    intent: FlowIntent,
    outcome: IntentFinding['outcome'],
    confidence: number,
    reasons: string[],
    evidence: string[] = [],
    searchExhausted?: boolean,
  ): void {
    this.findings.set(intent.id, {
      intentId: intent.id,
      outcome,
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      evidence,
      ...(searchExhausted !== undefined ? { searchExhausted } : {}),
    });
    if (outcome === 'AMBIGUOUS' || outcome === 'MATCHED') return;
    if (outcome !== 'NOT_FOUND')
      this.emit('INTENT_MISMATCH', `${describeFlowIntent(intent)}: ${outcome}`, intent.id);
  }

  private lastState(): ObservedState {
    const last = this.steps.at(-1);
    return (last ? this.states.get(last.to) : undefined) ?? this.driver.current();
  }

  private remember(state: ObservedState): void {
    this.states.set(state.id, state);
  }

  private outcome(graph: FlowIntentGraph, stopReason: DryRunStopReason, budget: DryRunBudget): DryRunOutcome {
    return {
      observed: {
        flow: graph.name,
        states: [...this.states.values()],
        steps: this.steps,
        stopReason,
        budget: budget.usage(),
      },
      findings: graph.intents.map(
        (intent) =>
          this.findings.get(intent.id) ?? {
            intentId: intent.id,
            outcome: 'NOT_VERIFIED',
            confidence: 0,
            reasons: ['not reached'],
            evidence: [],
          },
      ),
    };
  }

  private emit(type: DryRunEventType, message: string, intentId?: string): void {
    this.onEvent({
      type,
      at: new Date(this.driver.now()).toISOString(),
      flow: this.flow,
      ...(intentId ? { intentId } : {}),
      message,
    });
  }
}

/** L'étape d'un flow qui rejoue une action observée : rôle + nom accessible, sinon le texte visible. */
export function stepOfAction(action: Pick<DryRunCandidate, 'label' | 'role' | 'classification'>): FlowStep {
  const allow = action.classification === 'MUTATION' ? (['MUTATION'] as const) : [];
  return {
    kind: 'click',
    target: action.role
      ? { strategy: 'role', role: action.role, name: action.label }
      : { strategy: 'text', value: action.label },
    allow: [...allow],
    optional: false,
  };
}
