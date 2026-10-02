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
import {
  QAReasoningEngine,
  narrate,
  type QAReasoningContext,
  type QAReasoningDecision,
  type ScreenAction,
} from './reasoning-engine.js';
import {
  shouldConsultAdvisor,
  validateProposal,
  type AdvisorTrigger,
  type ProposalVerdict,
  type ReasoningAdvisor,
  type ReasoningProblem,
} from './reasoning-advisor.js';
import {
  ActiveLearningEngine,
  type ExperimentAction,
  type ExperimentProposal,
  type RejectedExperiment,
  type SafetyClass,
} from './active-learning.js';
import {
  ContradictionDetector,
  TemporalDependencyGraph,
  type KnowledgeClaim,
  type KnowledgeContradiction,
} from './contradictions.js';
import { FunctionalCoverageGraph } from './functional-coverage.js';
import {
  FailureKnowledge,
  InvariantDiscoveryEngine,
  understandFailure,
  type DiscoveredInvariant,
  type FailureRecord,
  type FailureSignal,
  type FailureUnderstanding,
  type InvariantThresholds,
} from './invariants-failures.js';

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
  'CONTRADICTION_DETECTED',
  'ACTIVE_LEARNING_STARTED',
  'EXPERIMENT_PROPOSED',
  'EXPERIMENT_COMPLETED',
  'INVARIANT_CANDIDATE_CREATED',
  'INVARIANT_CONFIRMED',
  'INVARIANT_VIOLATED',
  'FAILURE_CLASSIFIED',
  'FUNCTIONAL_COVERAGE_UPDATED',
  'REASONING_DECISION_CREATED',
  'LLM_ADVISOR_REQUESTED',
  'LLM_ADVISOR_PROPOSAL_REJECTED',
  'LLM_ADVISOR_PROPOSAL_ACCEPTED',
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
  invariants?: DiscoveredInvariant[];
  failures?: FailureRecord[];
}

/** Ce que le rapport montre de la couche cognitive (§83) : des faits, des statuts, des preuves. */
export interface CognitiveSummary {
  mission?: string;
  functionalState?: string;
  goal?: string;
  missingChain?: string;
  currentPlan?: string;
  checkpoints: { id: string; status: string }[];
  hypotheses: {
    byStatus: Record<string, number>;
    top: { id: string; proposition: string; status: string; confidence: number }[];
  };
  confirmedRelations: string[];
  contradictions: string[];
  recoveredPlans: string[];
  failures: { step: string; class: string; reason: string }[];
  coverage: string[];
  coverageGaps: string[];
  invariants: { statement: string; status: string }[];
  decisions: {
    id: string;
    path: string;
    status: string;
    selected?: string;
    reason?: string;
    narration: string[];
  }[];
  experiments: { proposed: number; rejected: number };
  knowledge: { evidence: number; hypotheses: number; confirmed: number; contradicted: number };
}

export interface CognitiveOptions {
  version?: string;
  runTag: string;
  runtimeObservationsToConfirm: number;
  maxHypotheses: number;
  /** Observations et runs exigés pour qu'une régularité devienne un invariant (pas d'un seul coup). */
  invariantThresholds?: InvariantThresholds;
  /** Budgets du raisonnement (§87) : un budget atteint n'est jamais « impossible ». */
  budgets?: {
    maxPlanningDepth: number;
    maxExperiments: number;
    maxPlanCandidates: number;
    maxReasoningDurationMs: number;
  };
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
  readonly contradictions: ContradictionDetector;
  readonly temporal = new TemporalDependencyGraph();
  readonly invariants: InvariantDiscoveryEngine;
  failureKnowledge = new FailureKnowledge();
  readonly failures: (FailureUnderstanding & { step: string })[] = [];
  readonly activeLearning: ActiveLearningEngine;
  readonly experiments: { proposed: ExperimentProposal[]; rejected: RejectedExperiment[] } = {
    proposed: [],
    rejected: [],
  };
  private coverage: FunctionalCoverageGraph | undefined;
  readonly reasoning = new QAReasoningEngine();
  private lastDecision: QAReasoningDecision | undefined;
  private readonly narrations = new Map<string, string[]>();
  private advisorCalls = 0;
  readonly advice: {
    trigger: AdvisorTrigger;
    advisor: string;
    verdict: ProposalVerdict['status'];
    reasons: string[];
  }[] = [];
  /** Appelé quand un invariant soutenu est violé (l'oracle garde la provenance). */
  onInvariantViolated?: (invariant: DiscoveredInvariant) => void;
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
    this.contradictions = new ContradictionDetector((contradiction) => {
      this.emit(
        'CONTRADICTION_DETECTED',
        `${contradiction.property}: ${contradiction.types.join(', ')} — ${contradiction.claims.map((claim) => `${claim.source}=${String(claim.value)}`).join(' · ')}`,
      );
    });
    this.invariants = new InvariantDiscoveryEngine(
      { run: options.runTag, ...(options.version ? { version: options.version } : {}), now },
      options.invariantThresholds,
      (invariant, previous) => {
        if (invariant.status === 'VIOLATED') {
          this.emit(
            'INVARIANT_VIOLATED',
            `${invariant.statement} — ${invariant.counterexamples.at(-1)?.detail ?? ''}`,
          );
          this.onInvariantViolated?.(invariant);
        } else if (invariant.status === 'CONFIRMED') this.emit('INVARIANT_CONFIRMED', invariant.statement);
        else if (!previous || previous === 'CANDIDATE')
          this.emit('INVARIANT_CANDIDATE_CREATED', `${invariant.statement} (${invariant.status})`);
      },
    );
    this.activeLearning = new ActiveLearningEngine(this.hypotheses, (input) => this.addEvidence(input), {
      maxExperiments: options.budgets?.maxExperiments ?? 3,
      now,
    });
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
    this.invariants.restore(knowledge.invariants ?? []);
    this.failureKnowledge = new FailureKnowledge(knowledge.failures ?? []);
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
    this.rebuildCoverage();
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
      // Un état métier NOUVEAU (pas le même écran revu) : une observation pour les invariants et la couverture.
      this.invariants.observeSituation(situation);
      const before = this.coverageSummary();
      this.coverageGraph().observeSituation(situation, `screen ${route}`);
      if (this.coverageSummary() !== before) this.emit('FUNCTIONAL_COVERAGE_UPDATED', this.coverageSummary());
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
    /** Chronologie : durée de chaque requête et instant où l'état suivant a été observé (ms après l'action). */
    timing?: { observedAfterMs: number; durations: (number | undefined)[]; busy?: boolean };
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
    this.afterDecidedAction(input.label, appeared);
    // INVARIANTS : un changement de choix ou de champ ne doit pas vider les autres champs remplis.
    if (['fill', 'check', 'uncheck', 'select'].includes(input.kind) && input.before && input.after) {
      const filled = (snapshot: UiSnapshot): Map<string, boolean> =>
        new Map(
          snapshot.elements
            .filter(
              (element) =>
                element.visible && (element.label ?? element.name) && element.hasValue !== undefined,
            )
            .map((element) => [element.label ?? element.name, element.hasValue === true]),
        );
      const was = filled(input.before);
      const now = filled(input.after);
      for (const [field, had] of was)
        if (had && field.toLowerCase() !== input.label.toLowerCase() && now.has(field))
          this.invariants.observePreservation(
            actionKey(input.kind, input.label),
            field,
            now.get(field) === true,
          );
    }
    // TEMPORAL : un contrôle apparu après la fin d'une requête l'ATTEND (pas « immédiatement visible »).
    if (input.timing && appeared.length > 0)
      this.temporal.learn([
        { at: 0, kind: 'ACTION', label: actionKey(input.kind, input.label) },
        ...input.requests.map((request, index) => {
          const duration = input.timing?.durations[index];
          return {
            at: 0,
            kind: 'REQUEST_STARTED' as const,
            label: request.replace(/ \d{3}$/, ''),
            ...(duration !== undefined ? { end: duration } : {}),
          };
        }),
        ...(input.timing.busy ? [{ at: 1, kind: 'LOADING_STARTED' as const, label: 'loading' }] : []),
        ...appeared.map((control) => ({
          at: input.timing?.observedAfterMs ?? 0,
          kind: 'CONTROL_APPEARED' as const,
          label: control,
        })),
      ]);
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

  /**
   * QA REASONING : une décision pour l'écran courant (raison, preuves, alternatives écartées).
   * Le moteur de décision existant reçoit l'utilité comme signal ; la SafetyPolicy a déjà jugé
   * chaque action (`allowed`, `safety`), et le raisonnement ne la contourne jamais.
   */
  reason(
    availableActions: ScreenAction[],
    extra: { nextFields?: string[]; plan?: QAReasoningContext['currentPlan']; planPosition?: number } = {},
  ): QAReasoningDecision {
    const graph = this.goalGraph();
    const preconditions = graph.root
      ? resolvePreconditions(graph, graph.root, this.conditionContext, this.options.budgets?.maxPlanningDepth)
      : undefined;
    const context: QAReasoningContext = {
      ...(this.model.mission ? { mission: this.model.mission.id } : {}),
      ...(this.functionalState ? { currentState: this.functionalState } : {}),
      ...(this.situation ? { businessState: this.situation } : {}),
      ...(graph.root ? { goal: graph.root } : {}),
      ...(preconditions ? { preconditions } : {}),
      ...(extra.plan ? { currentPlan: extra.plan } : {}),
      ...(extra.planPosition !== undefined ? { planPosition: extra.planPosition } : {}),
      availableActions,
      hypotheses: this.hypotheses.all(),
      causal: this.causal.links(),
      coverageGaps: this.coverageGraph().gaps(),
      contradictions: this.contradictions.all(),
      ...(extra.nextFields ? { nextFields: extra.nextFields } : {}),
      budgets: {
        maxCandidates: this.options.budgets?.maxPlanCandidates ?? 30,
        maxReasoningDurationMs: this.options.budgets?.maxReasoningDurationMs ?? 250,
      },
    };
    const decision = this.reasoning.decide(context);
    this.lastDecision = decision;
    const story = narrate(decision, context);
    this.narrations.set(decision.id, story);
    this.emit(
      'REASONING_DECISION_CREATED',
      `${decision.id} ${decision.path} ${decision.status}${decision.selectedAction ? ` → ${decision.selectedAction.kind} "${decision.selectedAction.label}" (${decision.reason ?? '-'}: ${decision.why.join(', ')})` : ''}${decision.alternatives.length > 0 ? `; rejected ${String(decision.alternatives.length)}` : ''}`,
    );
    return decision;
  }

  /**
   * Un conseiller (déterministe, ou LLM injecté par programme) consulté seulement quand le
   * déterministe ne suffit pas, dans son budget. Sa proposition est validée (schéma, preuves,
   * existence de l'action) ; l'action acceptée repasse ensuite par la SafetyPolicy et l'exécuteur.
   */
  async consultAdvisor(
    advisor: ReasoningAdvisor | undefined,
    problem: ReasoningProblem,
    input: { exactLocatorFound: boolean; planKnown: boolean; confidence: number; maxCalls: number },
  ): Promise<ProposalVerdict | undefined> {
    if (
      !advisor ||
      !shouldConsultAdvisor({ ...input, trigger: problem.trigger, callsUsed: this.advisorCalls })
    )
      return undefined;
    this.advisorCalls += 1;
    this.emit('LLM_ADVISOR_REQUESTED', `${advisor.name}: ${problem.trigger} for ${problem.goal}`);
    const raw = await advisor
      .advise(problem)
      .catch((error: unknown) => ({ invalid: error instanceof Error ? error.message : String(error) }));
    const verdict = validateProposal(raw, problem, (id) => this.evidence.get(id) !== undefined, {
      engine: this.hypotheses,
      addEvidence: (evidence) => this.addEvidence(evidence),
    });
    this.advice.push({
      trigger: problem.trigger,
      advisor: advisor.name,
      verdict: verdict.status,
      reasons: verdict.reasons,
    });
    this.emit(
      verdict.status === 'ACCEPTED' ? 'LLM_ADVISOR_PROPOSAL_ACCEPTED' : 'LLM_ADVISOR_PROPOSAL_REJECTED',
      `${advisor.name}: ${verdict.reasons.join('; ')}`,
    );
    return verdict;
  }

  /** Le problème soumis à un conseiller, borné (jamais tout le DOM ni tout le code). */
  problemOf(trigger: AdvisorTrigger, availableActions: ScreenAction[]): ReasoningProblem {
    const evidence = this.evidence.all();
    const pick = (types: readonly string[]) =>
      evidence
        .filter((item) => types.includes(item.type))
        .slice(-5)
        .map((item) => ({ id: item.id, summary: `${item.type} ${item.source}` }));
    const allowed = availableActions
      .filter((action) => action.allowed && action.safety === 'SAFE')
      .slice(0, 20)
      .map((action) => ({
        kind: action.kind,
        label: action.label,
        ...(action.role ? { role: action.role } : {}),
      }));
    return {
      goal: this.goalGraph().root ?? this.model.mission?.id ?? 'EXPLORE',
      functionalState: this.lastSituation ?? 'unknown',
      visibleControls: allowed,
      previousActions: [],
      nextActions: [],
      knownRules: this.causal
        .confirmed()
        .slice(0, 10)
        .map((link) => `${link.cause} ${link.relation} ${link.effect}`),
      staticEvidence: pick(['STATIC_SOURCE', 'OPENAPI']),
      runtimeEvidence: pick(['RUNTIME', 'DOM', 'NETWORK']),
      historicalEvidence: pick(['HISTORICAL']),
      contradictions: this.contradictions
        .all()
        .map((contradiction) => `${contradiction.property}: ${contradiction.types.join(', ')}`),
      allowedActions: allowed,
      trigger,
    };
  }

  /**
   * Ce que le conseiller d'intelligence peut recevoir (après sélection et nettoyage) : la
   * mission, le but, l'état métier, les preuves, les hypothèses, les contradictions, les trous
   * de couverture. Des lectures : rien n'est copié dans une deuxième représentation.
   */
  intelligenceSources(): {
    mission?: string;
    goal?: { id: string; conditions: string[] };
    situation?: BusinessSituation;
    functionalState?: string;
    evidence: readonly Evidence[];
    hypotheses: readonly Hypothesis[];
    contradictions: readonly KnowledgeContradiction[];
    coverageGaps: string[];
  } {
    const graph = this.goalGraph();
    const preconditions = graph.root
      ? resolvePreconditions(graph, graph.root, this.conditionContext, this.options.budgets?.maxPlanningDepth)
      : undefined;
    return {
      ...(this.model.mission ? { mission: this.model.mission.id } : {}),
      ...(graph.root
        ? {
            goal: {
              id: graph.root,
              conditions: preconditions?.missingPreconditions.map((node) => node.id) ?? [],
            },
          }
        : {}),
      ...(this.situation ? { situation: this.situation } : {}),
      ...(this.lastSituation ? { functionalState: this.lastSituation } : {}),
      evidence: this.evidence.all(),
      hypotheses: this.hypotheses.all(),
      contradictions: this.contradictions.all(),
      coverageGaps: this.coverageGraph()
        .gaps()
        .slice(0, 10)
        .map((gap) => gap.item.label),
    };
  }

  /**
   * Une hypothèse PROPOSÉE par le conseiller d'intelligence : au plus une hypothèse (preuve
   * LLM_PROPOSAL, plafonnée), avec son origine — jamais une connaissance confirmée. Seules des
   * observations runtime pourront la faire progresser, selon les règles habituelles.
   */
  recordAiHypothesis(statement: string, evidenceIds: readonly string[], auditId: string): Hypothesis {
    const proof = this.addEvidence({
      type: 'LLM_PROPOSAL',
      source: `AI proposal ${auditId}`,
      timestamp: this.now(),
      confidence: 0.5,
      details: { origin: 'AI_PROPOSAL', auditId, evidenceIds: [...evidenceIds] },
    });
    const hypothesis = this.hypotheses.propose(
      { kind: 'BUSINESS_RULE', subject: 'ai-advisor', relation: 'CLAIMS', object: statement.slice(0, 300) },
      proof,
      { testable: false, reason: 'AI_PROPOSED_HYPOTHESIS: to be confirmed at runtime' },
    );
    this.emit(
      'HYPOTHESIS_CREATED',
      `${hypothesis.id} AI_PROPOSED_HYPOTHESIS (${auditId}): ${statement.slice(0, 120)}`,
    );
    return hypothesis;
  }

  /** L'action décidée a été exécutée : son résultat confirme (ou non) la décision et, pour un test d'hypothèse, l'hypothèse. */
  private afterDecidedAction(label: string, appeared: readonly string[]): void {
    const decision = this.lastDecision;
    if (
      !decision?.selectedAction ||
      normalizeControl(decision.selectedAction.label) !== normalizeControl(label)
    )
      return;
    this.lastDecision = undefined;
    const expected = decision.expectedEffects.map((effect) => effect.replace(/ visible$/, ''));
    const confirmed =
      expected.length === 0 ? appeared.length > 0 : expected.some((effect) => appeared.includes(effect));
    this.reasoning.recordOutcome(decision.id, confirmed, [...appeared]);
    if (decision.reason !== 'HYPOTHESIS' || !decision.goal) return;
    const hypothesis = this.hypotheses.byId(decision.goal);
    if (!hypothesis) return;
    const proof = this.addEvidence({
      type: 'TEST_RESULT',
      source: `experiment ${decision.id} ${decision.selectedAction.kind} "${decision.selectedAction.label}"`,
      timestamp: this.now(),
      confidence: 0.9,
      details: {
        experiment: true,
        observable: hypothesis.proposition.object,
        observed: appeared.includes(hypothesis.proposition.object),
      },
    });
    if (appeared.includes(hypothesis.proposition.object)) this.hypotheses.support(hypothesis.id, proof);
    else this.hypotheses.contradict(hypothesis.id, proof);
    this.emit(
      'EXPERIMENT_COMPLETED',
      `${decision.id}: ${hypothesis.id} → ${this.hypotheses.byId(hypothesis.id)?.status ?? '?'}`,
    );
  }

  /** Une affirmation sur une propriété (DOM, code, contrat…) : les désaccords deviennent des contradictions visibles. */
  claim(claim: KnowledgeClaim): KnowledgeContradiction | undefined {
    return this.contradictions.claim(claim);
  }

  /** FAILURE UNDERSTANDING : classer un échec, le rapprocher des échecs déjà vus, l'apprendre. */
  understand(signal: FailureSignal, step: string): FailureUnderstanding {
    const understanding = understandFailure(signal, this.failureKnowledge);
    this.failureKnowledge.record(understanding, this.now(), this.options.version);
    this.failures.push({ ...understanding, step });
    this.emit('FAILURE_CLASSIFIED', `${step}: ${understanding.class} — ${understanding.reasons.join('; ')}`);
    if (signal.request && /^POST|^PUT|^PATCH/.test(signal.request))
      this.coverageGraph().observeSubmission(understanding.class, step);
    return understanding;
  }

  /** Un envoi réussi (effet confirmé au runtime). */
  submissionSucceeded(source: string): void {
    this.coverageGraph().observeSubmission('SUCCESS', source);
    this.emit('FUNCTIONAL_COVERAGE_UPDATED', this.coverageSummary());
  }

  /**
   * ACTIVE LEARNING : pour chaque effet expliqué par plusieurs causes plausibles, les expériences
   * SÛRES qui les départageraient (les autres sont refusées par la SafetyPolicy, avec la raison).
   */
  proposeExperiments(
    available: ReadonlySet<string>,
    judge: (action: ExperimentAction) => SafetyClass,
  ): ExperimentProposal[] {
    const effects = new Set(
      this.causal
        .links()
        .filter(
          (link) =>
            link.relation === 'REVEALS' &&
            link.hypothesis.status !== 'RUNTIME_CONFIRMED' &&
            link.hypothesis.status !== 'REJECTED',
        )
        .map((link) => link.effect),
    );
    const proposed: ExperimentProposal[] = [];
    for (const effect of effects) {
      const { proposals, rejected } = this.activeLearning.propose(effect, available, judge);
      if (proposals.length === 0 && rejected.length === 0) continue;
      this.emit(
        'ACTIVE_LEARNING_STARTED',
        `${effect}: ${String(this.hypotheses.competing('REVEALS', effect).length)} competing hypotheses`,
      );
      for (const proposal of proposals)
        this.emit(
          'EXPERIMENT_PROPOSED',
          `${proposal.actions.map((action) => `${action.kind} "${action.label}"`).join(' → ')} tests ${proposal.tests} (gain ${String(proposal.informationGain)} bit, ${proposal.safetyClass}${proposal.reversible ? ', reversible' : ''})`,
        );
      proposed.push(...proposals);
      this.experiments.rejected.push(...rejected);
    }
    this.experiments.proposed.push(...proposed);
    return proposed;
  }

  /** La couverture fonctionnelle (créée avec le modèle, gardée quand le modèle grandit). */
  coverageGraph(): FunctionalCoverageGraph {
    this.coverage ??= new FunctionalCoverageGraph(this.model);
    return this.coverage;
  }

  private rebuildCoverage(): void {
    const previous = this.coverage;
    this.coverage = new FunctionalCoverageGraph(this.modelBuilder.build());
    for (const item of previous?.all() ?? [])
      if (item.covered) for (const source of item.evidence) this.coverage.markCovered(item.id, source);
  }

  private coverageSummary(): string {
    return this.coverageGraph()
      .summary()
      .map((row) => `${row.dimension} ${String(row.covered)}/${String(row.total)}`)
      .join(', ');
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
    return {
      hypotheses,
      evidence,
      invariants: this.invariants.all(),
      failures: this.failureKnowledge.all().slice(-200),
    };
  }

  /** WHERE AM I? WHAT IS THE BUSINESS STATE? … WHAT IS STILL UNTESTED? — en un résumé. */
  summary(): CognitiveSummary {
    const all = this.hypotheses.all();
    const byStatus: Record<string, number> = {};
    for (const hypothesis of all) byStatus[hypothesis.status] = (byStatus[hypothesis.status] ?? 0) + 1;
    const graph = this.goals;
    const resolution = graph?.root
      ? resolvePreconditions(graph, graph.root, this.conditionContext)
      : undefined;
    const lastPlans = this.plans.at(-1);
    const current = lastPlans?.plans.find((plan) => plan.kind === 'CURRENT_PLAN');
    return {
      ...(this.model.mission ? { mission: this.model.mission.id } : {}),
      ...(this.lastSituation ? { functionalState: this.lastSituation } : {}),
      ...(graph?.root ? { goal: graph.root } : {}),
      ...(resolution?.chains[0] ? { missingChain: describeChain(resolution.chains[0]) } : {}),
      ...(current ? { currentPlan: describePlan(current) || 'nothing left to do' } : {}),
      checkpoints: [...this.checkpoints.values()].map((checkpoint) => ({
        id: checkpoint.id,
        status: checkpoint.status,
      })),
      hypotheses: {
        byStatus,
        top: all
          .filter((hypothesis) => hypothesis.status !== 'REJECTED')
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 10)
          .map((hypothesis) => ({
            id: hypothesis.id,
            proposition: describeProposition(hypothesis.proposition),
            status: hypothesis.status,
            confidence: hypothesis.confidence,
          })),
      },
      confirmedRelations: this.causal
        .confirmed()
        .slice(0, 15)
        .map((link) => `${link.cause} ${link.relation} ${link.effect}`),
      contradictions: this.contradictions
        .all()
        .map((contradiction) => `${contradiction.property}: ${contradiction.types.join(', ')}`),
      recoveredPlans: this.plans.flatMap((entry) =>
        entry.repair?.status === 'REPAIRED'
          ? entry.repair.explanation.map((line) => `${entry.flow}: ${line}`)
          : [],
      ),
      failures: this.failures
        .slice(0, 20)
        .map((failure) => ({ step: failure.step, class: failure.class, reason: failure.reasons[0] ?? '' })),
      coverage: this.coverageGraph().describe(),
      coverageGaps: this.coverageGraph()
        .gaps()
        .slice(0, 8)
        .map((gap) => gap.suggestion),
      invariants: this.invariants
        .all()
        .map((invariant) => ({ statement: invariant.statement, status: invariant.status })),
      decisions: this.reasoning.trace.slice(-10).map((decision) => ({
        id: decision.id,
        path: decision.path,
        status: decision.status,
        ...(decision.selectedAction
          ? { selected: `${decision.selectedAction.kind} "${decision.selectedAction.label}"` }
          : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
        narration: this.narrations.get(decision.id) ?? [],
      })),
      experiments: { proposed: this.experiments.proposed.length, rejected: this.experiments.rejected.length },
      knowledge: {
        evidence: this.evidence.size,
        hypotheses: all.length,
        confirmed: byStatus.RUNTIME_CONFIRMED ?? 0,
        contradicted: (byStatus.CONTRADICTED ?? 0) + (byStatus.REJECTED ?? 0),
      },
    };
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
      'contradictions.json': { contradictions: this.contradictions.all() },
      'functional-coverage.json': {
        ...this.coverageGraph().toJSON(),
        lines: this.coverageGraph().describe(),
      },
      'invariants.json': { invariants: this.invariants.all() },
      'failures.json': { failures: this.failures, knowledge: this.failureKnowledge.all() },
      'temporal.json': { links: this.temporal.all() },
      'experiments.json': this.experiments,
      'reasoning.json': {
        decisions: this.reasoning.trace.map((decision) => ({
          ...decision,
          narration: this.narrations.get(decision.id) ?? [],
        })),
        advice: this.advice,
      },
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
