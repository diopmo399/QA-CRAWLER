import type { FlowConfig } from '../config/flow-schema.js';
import { normalize as normalizeControl } from '../flows/action-effect-verifier.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import type { StaticApplicationGraph } from '../static-analysis/model.js';
import {
  BusinessStateEngine,
  describeSituation,
  observationOf,
  type BusinessSituation,
  type FunctionalState,
} from './business-state-engine.js';
import { CausalKnowledgeGraph } from './causal-graph.js';
import { EvidenceStore, type Evidence } from './evidence.js';
import { EvidenceGraph, importStaticGraph } from './evidence-graph.js';
import { FunctionalModelBuilder, type FunctionalModel } from './functional-model.js';
import { HypothesisEngine, describeProposition, type Hypothesis } from './hypothesis-engine.js';
import {
  buildGoalGraph,
  describeChain,
  resolvePreconditions,
  type ConditionContext,
  type GoalGraph,
  type PreconditionResolution,
} from './goal-graph.js';
import {
  checkpointsOf,
  describePlan,
  evaluateCheckpoint,
  planGoal,
  recordedPlan,
  repairPlan,
  type ExecutionPlan,
  type PlannedAction,
  type RepairResult,
  type SemanticCheckpoint,
} from './planning.js';
import type { FlowStepReport } from '../model/flow-run.js';

/** La clé causale d'une action : « check eur », « click company information ». */
export function actionKey(kind: string, label: string): string {
  return `${kind} ${normalizeControl(label)}`;
}

export const COGNITIVE_EVENTS = [
  'EVIDENCE_ADDED',
  'HYPOTHESIS_CREATED',
  'HYPOTHESIS_SUPPORTED',
  'HYPOTHESIS_CONTRADICTED',
  'CAUSAL_RELATION_CONFIRMED',
  'BUSINESS_STATE_UPDATED',
  'GOAL_CREATED',
  'GOAL_BLOCKED',
  'PRECONDITION_DISCOVERED',
  'PLAN_CREATED',
  'PLAN_REPAIRED',
  'SEMANTIC_CHECKPOINT_REACHED',
] as const;
export type CognitiveEvent = (typeof COGNITIVE_EVENTS)[number];

export interface CognitiveEventRecord {
  at: string;
  event: CognitiveEvent;
  message: string;
}

/** Ce qui est gardé d'un run à l'autre (dans la KnowledgeBase) : des hypothèses et leurs preuves. */
export interface CognitiveKnowledge {
  hypotheses: Hypothesis[];
  evidence: Evidence[];
}

export interface CognitiveOptions {
  version?: string;
  runTag: string;
  runtimeObservationsToConfirm: number;
  maxHypotheses: number;
  emit?: (record: CognitiveEventRecord) => void;
  now?: () => string;
}

/**
 * COGNITIVE ENGINE (couche de connaissance) : preuves, graphe de preuves, modèle fonctionnel,
 * état métier, hypothèses et graphe causal — réunis pour un run. Il OBSERVE et APPREND ;
 * il ne clique pas, n'appelle pas Playwright et ne contourne aucune politique.
 *
 *   OBSERVE → INTERPRET → HYPOTHESIZE → (plan, act : ailleurs) → VERIFY → LEARN
 */
export class CognitiveEngine {
  readonly evidence: EvidenceStore;
  readonly graph: EvidenceGraph;
  readonly hypotheses: HypothesisEngine;
  readonly causal: CausalKnowledgeGraph;
  private readonly modelBuilder = new FunctionalModelBuilder();
  private model: FunctionalModel = new FunctionalModelBuilder().build();
  private stateEngine: BusinessStateEngine;
  private lastSituation: string | undefined;
  situation: BusinessSituation | undefined;
  functionalState: FunctionalState | undefined;
  readonly events: CognitiveEventRecord[] = [];
  private goals: GoalGraph | undefined;
  private checkpoints = new Map<string, SemanticCheckpoint>();
  private lastBlocked: string | undefined;
  private conditionContext: ConditionContext = {};
  readonly plans: {
    flow: string;
    plans: ExecutionPlan[];
    repair?: RepairResult;
    preconditions?: PreconditionResolution;
  }[] = [];

  constructor(private readonly options: CognitiveOptions) {
    const now = options.now ?? (() => new Date().toISOString());
    let counter = 0;
    this.evidence = new EvidenceStore(`E-${options.runTag}`, (added) => {
      counter += 1;
      // Le journal reste lisible : les 50 premières preuves, puis une sur cent.
      if (counter <= 50 || counter % 100 === 0)
        this.emit('EVIDENCE_ADDED', `${added.id} ${added.type} ${added.source}`);
    });
    this.graph = new EvidenceGraph({ ...(options.version ? { version: options.version } : {}), now });
    this.hypotheses = new HypothesisEngine(
      {
        runtimeObservationsToConfirm: options.runtimeObservationsToConfirm,
        ...(options.version ? { version: options.version } : {}),
        now,
      },
      (change) => {
        const text = `${change.hypothesis.id} ${describeProposition(change.hypothesis.proposition)} → ${change.hypothesis.status} (${String(change.hypothesis.confidence)})`;
        if (change.created) this.emit('HYPOTHESIS_CREATED', text);
        else if (change.hypothesis.status === 'CONTRADICTED' || change.hypothesis.status === 'REJECTED')
          this.emit('HYPOTHESIS_CONTRADICTED', text);
        else if (
          change.hypothesis.status === 'RUNTIME_CONFIRMED' &&
          change.hypothesis.proposition.kind === 'CAUSAL'
        )
          this.emit('CAUSAL_RELATION_CONFIRMED', text);
        else this.emit('HYPOTHESIS_SUPPORTED', text);
      },
    );
    this.causal = new CausalKnowledgeGraph(this.hypotheses, this.graph);
    this.stateEngine = new BusinessStateEngine(this.model, (input) => this.addEvidence(input), now);
  }

  /** Une preuve, identifiée pour ce run. */
  addEvidence(input: Omit<Evidence, 'id'>): Evidence {
    return this.evidence.add({
      ...input,
      ...(this.options.version && !input.applicationVersion
        ? { applicationVersion: this.options.version }
        : {}),
    });
  }

  /** La connaissance des runs précédents : des hypothèses, réévaluées (âge, version), jamais des vérités. */
  restore(knowledge: CognitiveKnowledge | undefined): void {
    if (!knowledge) return;
    this.hypotheses.restore(knowledge.hypotheses, knowledge.evidence);
  }

  /** Un parcours démontré (flow, enregistrement) : une preuve d'INTENTION pour le modèle fonctionnel. */
  learnFlow(flow: Pick<FlowConfig, 'name' | 'steps'>): void {
    const proof = this.addEvidence({
      type: 'HUMAN_RECORDING',
      source: `flow "${flow.name}"`,
      timestamp: this.now(),
      confidence: 0.9,
      details: { steps: flow.steps.length },
    });
    this.modelBuilder.addFlow(flow, [{ id: proof.id, type: proof.type }]);
    // Les effets appris à l'enregistrement : l'humain a montré que l'action révèle ces contrôles.
    for (const step of flow.steps) {
      if (!('target' in step) || !('effects' in step) || !step.effects?.appears) continue;
      const cause = {
        kind: 'ACTION' as const,
        label: actionKey(step.kind, step.target.name ?? step.target.value ?? ''),
      };
      const demo = this.addEvidence({
        type: 'HUMAN_RECORDING',
        source: `flow "${flow.name}" learned effects`,
        timestamp: this.now(),
        confidence: 0.8,
        details: { action: cause.label },
      });
      for (const control of step.effects.appears.slice(0, 3)) {
        const colon = control.indexOf(':');
        const key =
          colon > 0
            ? `${control.slice(0, colon)}:${normalizeControl(control.slice(colon + 1))}`
            : normalizeControl(control);
        this.causal.observe(cause, 'REVEALS', { kind: 'CONTROL', label: key }, demo);
      }
    }
    this.model = this.modelBuilder.build();
    this.stateEngine = new BusinessStateEngine(
      this.model,
      (input) => this.addEvidence(input),
      () => this.now(),
    );
    this.goals = undefined;
  }

  /** Le code source (déjà analysé, en cache) : des preuves d'implémentation. */
  learnStatic(statics: StaticApplicationGraph): number {
    return importStaticGraph(this.graph, statics, (input) => this.addEvidence(input));
  }

  /** WHERE AM I? WHAT IS THE BUSINESS STATE? — sur chaque écran observé. */
  observeScreen(snapshot: UiSnapshot, route: string): BusinessSituation {
    const { situation, state } = this.stateEngine.evaluate(observationOf(snapshot, route));
    this.situation = situation;
    this.functionalState = state;
    const text = describeSituation(situation);
    if (text !== this.lastSituation) {
      this.lastSituation = text;
      this.emit('BUSINESS_STATE_UPDATED', text);
    }
    this.conditionContext = {
      situation,
      controls: new Set(
        snapshot.elements
          .filter((element) => element.visible && !element.disabled && element.role && element.name)
          .map((element) => `${element.role}:${normalizeControl(element.name)}`),
      ),
    };
    this.trackGoals();
    return situation;
  }

  /**
   * Une action exécutée : ce qu'elle a changé devient des HYPOTHÈSES causales (une seule
   * observation n'est jamais une relation confirmée).
   */
  observeAction(input: {
    kind: string;
    label: string;
    before?: UiSnapshot;
    after?: UiSnapshot;
    beforeRoute: string;
    afterRoute: string;
    requests: readonly string[];
    source: string;
  }): Hypothesis[] {
    const keys = (snapshot: UiSnapshot | undefined, enabled: boolean): Set<string> =>
      new Set(
        (snapshot?.elements ?? [])
          .filter((element) => element.visible && element.role && element.name && !element.transient)
          .filter((element) => (enabled ? !element.disabled : element.disabled))
          .map((element) => `${element.role}:${normalizeControl(element.name)}`),
      );
    const before = keys(input.before, true);
    const after = keys(input.after, true);
    const disabledBefore = keys(input.before, false);
    const disabledAfter = keys(input.after, false);
    const appeared = [...after].filter((key) => !before.has(key) && !disabledBefore.has(key));
    const enabled = [...after].filter((key) => disabledBefore.has(key));
    const disabled = [...disabledAfter].filter((key) => before.has(key));
    const disappeared = [...before].filter((key) => !after.has(key) && !disabledAfter.has(key));
    const route = input.afterRoute !== input.beforeRoute ? input.afterRoute : undefined;
    if (
      appeared.length + disappeared.length + enabled.length + disabled.length + input.requests.length === 0 &&
      !route
    )
      return [];
    const proof = this.addEvidence({
      type: 'RUNTIME',
      source: input.source,
      timestamp: this.now(),
      confidence: 0.8,
      details: {
        action: actionKey(input.kind, input.label),
        appeared: appeared.slice(0, 5),
        route: route ?? null,
      },
    });
    if (this.hypotheses.all().length >= this.options.maxHypotheses) return [];
    return this.causal.learnFromAction(
      {
        action: actionKey(input.kind, input.label),
        appeared,
        disappeared,
        enabled,
        disabled,
        ...(route ? { route } : {}),
        requests: [...input.requests],
      },
      proof,
    );
  }

  /** GOAL GRAPH du modèle courant (reconstruit quand le modèle change). */
  goalGraph(): GoalGraph {
    if (!this.goals) {
      this.goals = buildGoalGraph(this.model, this.causal);
      if (this.goals.nodes.length > 0) {
        this.emit(
          'GOAL_CREATED',
          `${this.goals.root ?? ''}: ${String(this.goals.nodes.length)} goal(s) and precondition(s)`,
        );
        for (const checkpoint of checkpointsOf(this.goals))
          if (!this.checkpoints.has(checkpoint.id)) this.checkpoints.set(checkpoint.id, checkpoint);
      }
    }
    return this.goals;
  }

  /** WHAT PRECONDITIONS ARE MISSING? — pour un objectif, sur l'écran courant. */
  preconditions(goalId?: string): PreconditionResolution | undefined {
    const graph = this.goalGraph();
    const goal = goalId ?? graph.root;
    return goal ? resolvePreconditions(graph, goal, this.conditionContext) : undefined;
  }

  /** Les checkpoints sémantiques, réévalués sur l'écran (jamais l'URL seule). */
  private trackGoals(): void {
    const graph = this.goalGraph();
    if (!graph.root) return;
    for (const [id, checkpoint] of this.checkpoints) {
      const next = evaluateCheckpoint(checkpoint, graph, this.conditionContext, this.now());
      if (next.status === 'CONFIRMED' && checkpoint.status !== 'CONFIRMED')
        this.emit('SEMANTIC_CHECKPOINT_REACHED', `${id} (${String(next.evidence.length)} signal(s))`);
      this.checkpoints.set(id, next);
    }
    const resolution = resolvePreconditions(graph, graph.root, this.conditionContext);
    const text = resolution.chains.map(describeChain).join(' | ');
    if (resolution.status === 'BLOCKED' && text !== this.lastBlocked) {
      this.lastBlocked = text;
      this.emit('GOAL_BLOCKED', `${graph.root}: ${text}`);
      for (const node of resolution.missingPreconditions)
        this.emit(
          'PRECONDITION_DISCOVERED',
          `${node.id} — ${node.achievedBy.map((action) => `${action.kind} "${action.label}" (${action.source})`).join(', ') || 'no known action'}`,
        );
    }
  }

  /**
   * Les plans d'un flow : RECORDED (le parcours démontré), CURRENT (depuis l'état atteint),
   * RECOVERED / SUGGESTED (le plan réparé par les récupérations confirmées au runtime).
   */
  planFlow(
    flow: Pick<FlowConfig, 'name' | 'steps'>,
    steps: readonly FlowStepReport[],
    judge: (action: PlannedAction) => { allowed: boolean; reason: string },
  ): ExecutionPlan[] {
    const graph = this.goalGraph();
    const mission = graph.mission ?? flow.name;
    const goal = graph.root ?? flow.name;
    const recorded = recordedPlan(flow, mission, goal);
    const plans: ExecutionPlan[] = [recorded];
    this.emit('PLAN_CREATED', `RECORDED_PLAN ${flow.name}: ${describePlan(recorded)}`);
    if (graph.root) {
      const current = planGoal(graph, graph.root, this.conditionContext);
      plans.push(current);
      this.emit(
        'PLAN_CREATED',
        `CURRENT_PLAN ${graph.root}: ${describePlan(current) || 'nothing left to do'}${current.assumptions.length > 0 ? ` (assumes ${current.assumptions.map((assumption) => assumption.hypothesis).join(', ')})` : ''}`,
      );
    }
    const repairs = steps
      .filter((step) => step.recovery?.outcome.status === 'GOAL_REACHED')
      .map((step) => ({
        originalIndex: step.index - 1,
        reason: `${step.recovery?.divergence.category ?? 'recovered'}: goal ${step.recovery?.goal.id ?? ''} confirmed at runtime`,
        replacement: (step.recovery?.outcome.path ?? []).map((action): PlannedAction => ({
          kind: action.kind,
          label: action.name,
          role: action.role,
          intent: step.recovery?.goal.id ?? '',
          source: 'RECOVERY',
          expectedEffects: step.recovery?.goalVerification?.satisfied ?? [],
        })),
      }));
    const repair = repairPlan(recorded, repairs, judge);
    if (repair.status === 'REPAIRED' && repair.recovered && repair.suggested) {
      plans.push(repair.recovered, repair.suggested);
      this.emit('PLAN_REPAIRED', `${flow.name}: ${repair.explanation.join(' · ')}`);
    }
    const preconditions = graph.root
      ? resolvePreconditions(graph, graph.root, this.conditionContext)
      : undefined;
    this.plans.push({
      flow: flow.name,
      plans,
      ...(repair.status !== 'NO_REPAIR' ? { repair } : {}),
      ...(preconditions ? { preconditions } : {}),
    });
    return plans;
  }

  get functionalModel(): FunctionalModel {
    return this.model;
  }

  /** Ce qui est gardé pour les runs suivants : hypothèses (bornées) et preuves référencées. */
  export(): CognitiveKnowledge {
    const hypotheses = this.hypotheses
      .all()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.options.maxHypotheses)
      .map((hypothesis) => ({
        ...hypothesis,
        evidenceFor: hypothesis.evidenceFor.slice(-10),
        evidenceAgainst: hypothesis.evidenceAgainst.slice(-10),
      }));
    const ids = new Set(
      hypotheses.flatMap((hypothesis) =>
        [...hypothesis.evidenceFor, ...hypothesis.evidenceAgainst].map((reference) => reference.id),
      ),
    );
    const evidence = hypotheses
      .flatMap((hypothesis) => {
        const resolved = this.hypotheses.evidenceOf(hypothesis);
        return [...resolved.for, ...resolved.against];
      })
      .filter(
        (item, index, list) => ids.has(item.id) && list.findIndex((other) => other.id === item.id) === index,
      );
    return { hypotheses, evidence };
  }

  /** Les artefacts de débogage (§84) produits par cette couche. */
  artifacts(): Record<string, unknown> {
    return {
      'knowledge-graph.json': this.graph.toJSON(),
      'causal-graph.json': this.causal.toJSON(),
      'hypotheses.json': {
        hypotheses: this.hypotheses.all().map((hypothesis) => ({
          id: hypothesis.id,
          proposition: describeProposition(hypothesis.proposition),
          kind: hypothesis.proposition.kind,
          status: hypothesis.status,
          confidence: hypothesis.confidence,
          evidenceFor: hypothesis.evidenceFor,
          evidenceAgainst: hypothesis.evidenceAgainst,
          testability: hypothesis.testability,
        })),
      },
      'functional-model.json': this.model,
      'business-state.json': {
        situation: this.situation ?? null,
        functionalState: this.functionalState ?? null,
      },
      'goal-graph.json': this.goals ?? { nodes: [] },
      'plan.json': { flows: this.plans, checkpoints: [...this.checkpoints.values()] },
    };
  }

  private emit(event: CognitiveEvent, message: string): void {
    const record: CognitiveEventRecord = { at: this.now(), event, message };
    if (this.events.length < 2000) this.events.push(record);
    this.options.emit?.(record);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
