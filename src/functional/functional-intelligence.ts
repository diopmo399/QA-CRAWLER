import type { ScenarioConfig } from '../config/config.js';
import type { FunctionalKnowledgeStore } from '../knowledge/functional-knowledge-store.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import type { ApiContract } from '../oracles/api-contract.js';
import type { StaticApplicationGraph } from '../static-analysis/model.js';
import type { ApplicationRule } from '../static-analysis/rules/rule-model.js';
import { ErrorPathAnalyzer } from './error-paths.js';
import { TestGoalPlanner, routeMatches, type GoalPlan, type PlanningContext } from './goal-planner.js';
import { goalSignal, type GoalSignal } from './goal-scoring.js';
import { InvariantAnalyzer } from './invariants.js';
import {
  apiMatches,
  sameLabel,
  type ActionSideEffect,
  type ApplicationInvariant,
  type BusinessStateMachine,
  type ContractObservation,
  type ErrorPath,
  type FunctionalActionObservation,
  type FunctionalFinding,
  type FunctionalWorkflow,
  type ScreenFacts,
  type SemanticTarget,
  type TestGoal,
  type TestGoalCategory,
} from './model.js';
import { RuntimeContractCorrelator } from './runtime-contract.js';
import { SideEffectAnalyzer } from './side-effects.js';
import { BusinessStateMachineAnalyzer } from './state-machines.js';
import { TestGoalGenerator, type GoalSafetyJudgement } from './test-goals.js';
import { WorkflowIntentAnalyzer, type DeclaredScenario } from './workflows.js';

export type FunctionalEvent =
  | 'BUSINESS_STATE_DISCOVERED'
  | 'BUSINESS_TRANSITION_DISCOVERED'
  | 'BUSINESS_TRANSITION_CONFIRMED'
  | 'INVARIANT_DISCOVERED'
  | 'INVARIANT_CONFIRMED'
  | 'INVARIANT_VIOLATED'
  | 'WORKFLOW_DISCOVERED'
  | 'SIDE_EFFECT_EXPECTED'
  | 'SIDE_EFFECT_CONFIRMED'
  | 'SIDE_EFFECT_MISSING'
  | 'ERROR_PATH_DISCOVERED'
  | 'CONTRACT_RUNTIME_MISMATCH'
  | 'TEST_GOAL_GENERATED'
  | 'TEST_GOAL_SELECTED'
  | 'TEST_GOAL_STARTED'
  | 'TEST_GOAL_PROGRESS'
  | 'TEST_GOAL_VERIFIED'
  | 'TEST_GOAL_FAILED'
  | 'TEST_GOAL_BLOCKED'
  | 'TEST_GOAL_INCONCLUSIVE';

export interface FunctionalDependencies {
  config: ScenarioConfig['functionalIntelligence'];
  salt: string;
  /** La SafetyPolicy juge l'action qui réaliserait un objectif. */
  safety(target: SemanticTarget, category: TestGoalCategory): GoalSafetyJudgement;
  emit(event: FunctionalEvent, message: string): void;
  /** Les règles du RuleGraph (statut et couverture du run). */
  rules?(): readonly ApplicationRule[];
  /** FlowGraph : étapes vers un écran confirmé de cette route. */
  knownPath?(route: string): number | undefined;
  store?: FunctionalKnowledgeStore;
  now?: () => number;
}

/** Couverture fonctionnelle : ce qui a été vérifié, jamais une note de qualité. */
export interface FunctionalCoverage {
  rules: { total: number; verified: number };
  states: { total: number; observed: number };
  transitions: { total: number; confirmed: number; contradicted: number };
  invariants: { total: number; confirmed: number; violated: number };
  workflows: { total: number; verified: number; failed: number };
  sideEffects: { total: number; confirmed: number; missing: number };
  errorPaths: { total: number; observed: number };
  contract: { operations: number; checked: number; mismatches: number };
  goals: Record<TestGoal['status'], number>;
}

export interface FunctionalSummary {
  machines: BusinessStateMachine[];
  workflows: FunctionalWorkflow[];
  invariants: ApplicationInvariant[];
  sideEffects: ActionSideEffect[];
  errorPaths: ErrorPath[];
  contract: ContractObservation[];
  goals: (TestGoal & { plan?: GoalPlan; history?: string })[];
  coverage: FunctionalCoverage;
  /** Les objectifs écartés par le budget maxGoalsPerRun. */
  deferredGoals: number;
}

/**
 * L'INTELLIGENCE FONCTIONNELLE d'un run : elle ne parcourt rien et n'exécute rien. Elle
 * lit la connaissance que l'analyse statique, le contrat et le RuleGraph ont déjà
 * produite, la confronte à chaque action exécutée (avant / après, fenêtre réseau), en
 * tire des OBJECTIFS DE TEST, et donne au moteur de décision un signal `functional`
 * centralisé (goal-scoring). La SafetyPolicy reste seule juge de ce qui s'exécute.
 *
 *   Static suggests. History guides. Runtime confirms. Safety decides.
 */
export class FunctionalIntelligence {
  readonly machines: BusinessStateMachineAnalyzer;
  readonly workflows: WorkflowIntentAnalyzer;
  readonly invariants = new InvariantAnalyzer();
  readonly sideEffects = new SideEffectAnalyzer();
  readonly errorPaths = new ErrorPathAnalyzer();
  readonly goals: TestGoalGenerator;
  private readonly planner = new TestGoalPlanner();
  private contract: RuntimeContractCorrelator;
  private contractSource: ApiContract | undefined;
  private readonly findings = new Map<string, FunctionalFinding[]>();
  private readonly unexpected: ActionSideEffect[] = [];
  private screen: ScreenFacts | undefined;
  private readonly running = new Map<string, { actions: number; startedAt: number }>();
  private readonly checkedOperations = new Set<string>();
  private built = false;
  private readonly now: () => number;

  constructor(private readonly deps: FunctionalDependencies) {
    this.now = deps.now ?? ((): number => Date.now());
    this.machines = new BusinessStateMachineAnalyzer(deps.salt);
    this.workflows = new WorkflowIntentAnalyzer(deps.salt);
    this.goals = new TestGoalGenerator(
      (target, category) => deps.safety(target, category),
      deps.config.testGoals.budgets.maxGoalsPerRun,
    );
    this.contract = new RuntimeContractCorrelator(undefined, deps.salt);
  }

  /** L'historique (knowledge/functional) : un indice pour planifier, jamais une preuve. */
  async loadHistory(): Promise<void> {
    if (this.enabled) await this.deps.store?.load().catch(() => undefined);
  }

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  /** La connaissance statique (et le contrat) est là : machines, workflows, invariants, effets, erreurs, objectifs. */
  useStaticKnowledge(
    graph: StaticApplicationGraph | undefined,
    contract?: ApiContract,
    declared: readonly DeclaredScenario[] = [],
  ): void {
    if (!this.enabled || this.built) return;
    this.built = true;
    const config = this.deps.config;
    this.contractSource = contract;
    this.contract = new RuntimeContractCorrelator(
      config.runtimeContracts.enabled ? contract : undefined,
      this.deps.salt,
    );
    const facts = graph?.functionalFacts;
    const machines = config.stateMachines.enabled ? this.machines.build(facts, contract) : [];
    for (const machine of machines.slice(0, 20)) {
      this.deps.emit(
        'BUSINESS_STATE_DISCOVERED',
        `${machine.entityType}: ${machine.states.map((state) => state.state).join(', ')}`,
      );
      for (const transition of machine.transitions.slice(0, 20)) {
        const history = this.deps.store?.recall(`TRANSITION:${transition.id}`);
        if (history) this.machines.recallHistory(transition.id, history.status);
        this.deps.emit(
          'BUSINESS_TRANSITION_DISCOVERED',
          `${machine.entityType}: ${transition.from} → ${transition.to} (${transition.trigger ?? '?'}${transition.triggerLabel ? `, "${transition.triggerLabel}"` : ''}${transition.api ? `, ${transition.api}` : ''})`,
        );
      }
    }
    const workflows = config.workflows.enabled
      ? this.workflows.build(graph, this.machines.transitions(), declared)
      : [];
    for (const workflow of workflows.slice(0, 30))
      this.deps.emit('WORKFLOW_DISCOVERED', `${workflow.id}${workflow.api ? ` (${workflow.api})` : ''}`);
    const invariants = config.invariants.enabled
      ? this.invariants.build({
          ...(facts ? { facts } : {}),
          rules: graph?.rules ?? [],
          machines,
          ...(contract ? { contract } : {}),
        })
      : [];
    for (const invariant of invariants.filter((entry) => entry.scope !== 'API').slice(0, 30))
      this.deps.emit('INVARIANT_DISCOVERED', `${invariant.scope}: ${invariant.assertion.text}`);
    if (config.sideEffects.enabled) {
      this.sideEffects.build(workflows, machines);
      for (const effect of this.sideEffects.all().slice(0, 30))
        this.deps.emit(
          'SIDE_EFFECT_EXPECTED',
          `${effect.actionIntent}: ${effect.category} ${effect.expectedEffect}`,
        );
    }
    if (config.errorPaths.enabled)
      for (const path of this.errorPaths.build(facts, workflows, contract).slice(0, 30))
        this.deps.emit(
          'ERROR_PATH_DISCOVERED',
          `${path.operation} → ${String(path.httpStatus ?? '?')}${path.businessCode ? ` ${path.businessCode}` : ''}${path.uiTarget ? ` → field ${path.uiTarget}` : ''}${path.uiMessage ? ` → "${path.uiMessage}"` : ''}`,
        );
    this.generateGoals();
  }

  private generateGoals(): void {
    if (!this.deps.config.testGoals.enabled) return;
    const created = this.goals.generate({
      machines: this.machines.all(),
      workflows: this.workflows.all(),
      invariants: this.invariants.all(),
      errorPaths: this.errorPaths.all(),
      sideEffects: this.sideEffects.all(),
      rules: this.deps.rules?.() ?? [],
      ...(this.contractSource && this.deps.config.runtimeContracts.enabled
        ? { contract: this.contractSource }
        : {}),
    });
    for (const goal of created.slice(0, 50)) {
      this.deps.emit(
        'TEST_GOAL_GENERATED',
        `${goal.intent} — priority ${String(goal.priority)}, cost ${String(goal.estimatedCost)}, from ${goal.generatedFrom}`,
      );
      if (goal.status === 'BLOCKED')
        this.deps.emit('TEST_GOAL_BLOCKED', `${goal.intent}: ${goal.observations?.[0] ?? 'blocked'}`);
    }
  }

  // ------------------------------------------------------------------ écran

  /** Un écran observé : états affichés, transitions interdites confirmées, plans revus. */
  observeScreen(screen: ScreenFacts): void {
    if (!this.enabled) return;
    this.screen = screen;
    const before = new Set(
      this.machines
        .all()
        .flatMap((machine) =>
          machine.forbidden
            .filter((entry) => entry.status === 'RUNTIME_CONFIRMED')
            .map((entry) => `${entry.from}:${entry.trigger}`),
        ),
    );
    this.machines.observeScreen(screen);
    for (const machine of this.machines.all())
      for (const forbidden of machine.forbidden)
        if (forbidden.status === 'RUNTIME_CONFIRMED' && !before.has(`${forbidden.from}:${forbidden.trigger}`))
          this.invariants.onForbiddenConfirmed(forbidden.trigger, forbidden.from);
    this.syncGoals();
  }

  private planningContext(): PlanningContext {
    return {
      ...(this.screen ? { screen: this.screen } : {}),
      statesShown: (entity) => {
        const machine = this.machines.machine(entity);
        return machine ? this.machines.statesShown(machine, this.screen) : [];
      },
      knownPath: (route) => this.deps.knownPath?.(route),
      historicalPath: (route) => this.deps.store?.routeSteps(route),
    };
  }

  plan(goal: TestGoal): GoalPlan {
    return this.planner.plan(goal, this.planningContext());
  }

  // ------------------------------------------------------------------ moteur de décision

  /**
   * Signal `functional` d'une action (centralisé dans goal-scoring) : le meilleur
   * objectif qu'elle fait avancer. Rien quand testGoals ou influenceDecisionEngine est
   * désactivé ; jamais pour un objectif BLOCKED.
   */
  signalFor(action: { label: string; type: string; route?: string }): GoalSignal | undefined {
    const settings = this.deps.config.testGoals;
    if (!this.enabled || !settings.enabled || !settings.influenceDecisionEngine) return undefined;
    let best: GoalSignal | undefined;
    const context = this.planningContext();
    for (const goal of this.goals.all()) {
      let signal: GoalSignal | undefined;
      const trigger = goal.target?.actionLabel;
      if (trigger && action.type === 'click' && sameLabel(trigger, action.label)) {
        const holds = this.planner.preconditionHolds(goal, context);
        if (holds === false) continue;
        signal = goalSignal(goal, holds === true ? 'TRIGGER_READY' : 'TRIGGER_PRECONDITION_UNKNOWN');
      } else if (
        goal.target?.route &&
        action.route &&
        routeMatches(goal.target.route, action.route) &&
        !routeMatches(goal.target.route, this.screen?.route)
      ) {
        signal = goalSignal(goal, 'LEADS_TO_TARGET');
      }
      if (signal && (!best || signal.points > best.points)) best = signal;
    }
    return best;
  }

  /** L'action est choisie : les objectifs qu'elle réalise passent RUNNING (TEST_GOAL_SELECTED, STARTED). */
  onActionSelected(action: { label: string; type: string }): void {
    if (!this.enabled || !this.deps.config.testGoals.enabled || action.type !== 'click') return;
    for (const goal of this.goals.all()) {
      const trigger = goal.target?.actionLabel;
      if (!trigger || !sameLabel(trigger, action.label)) continue;
      if (goal.status !== 'CANDIDATE' && goal.status !== 'PLANNED') continue;
      const plan = this.plan(goal);
      if (this.planner.preconditionHolds(goal, this.planningContext()) === false) continue;
      this.deps.emit(
        'TEST_GOAL_SELECTED',
        `ACTION SELECTED click "${action.label}" — reason TEST_GOAL_PROGRESS; goal: ${goal.intent}; plan ${plan.strategy}: ${plan.explanation}`,
      );
      if (this.goals.transition(goal, 'RUNNING', `started by "${action.label}"`)) {
        this.running.set(goal.id, { actions: 0, startedAt: this.now() });
        this.deps.emit('TEST_GOAL_STARTED', goal.intent);
      }
    }
  }

  // ------------------------------------------------------------------ après une action

  /** Constats de l'analyse d'une action, pour le SemanticFunctionalOracle. */
  findingsFor(actionId: string): FunctionalFinding[] {
    return this.findings.get(actionId) ?? [];
  }

  /**
   * Après une action exécutée : transitions, workflows, effets, invariants touchés
   * (index), chemins d'erreur, contrat — et les objectifs concernés concluent.
   */
  afterAction(observation: FunctionalActionObservation): FunctionalFinding[] {
    if (!this.enabled) return [];
    const config = this.deps.config;
    const findings: FunctionalFinding[] = [];
    if (observation.after) this.screen = observation.after;
    // 1. Transitions métier.
    const verdicts = config.stateMachines.enabled ? this.machines.observeAction(observation) : [];
    for (const verdict of verdicts) {
      const transition = verdict.transition;
      if (verdict.verdict === 'CONFIRMED') {
        this.deps.emit('BUSINESS_TRANSITION_CONFIRMED', `${transition.entityType}: ${verdict.detail}`);
        findings.push({
          code: 'TRANSITION_CONFIRMED',
          status: 'PASS',
          message: `${transition.entityType} ${verdict.detail}`,
        });
      } else if (verdict.verdict === 'CONTRADICTED') {
        findings.push({
          code: 'EXPECTED_STATE_TRANSITION_MISSING',
          status: 'WARNING',
          message: `${transition.entityType} ${transition.from} → ${transition.to} expected: ${verdict.detail}`,
        });
      } else if (verdict.discovered)
        this.deps.emit('BUSINESS_TRANSITION_DISCOVERED', `${transition.entityType}: ${verdict.detail}`);
      // Invariants d'état de cette transition (index par transition).
      if (config.invariants.enabled && (verdict.verdict === 'CONFIRMED' || verdict.verdict === 'OBSERVED')) {
        const machine = this.machines.machine(transition.entityType);
        const from = machine ? this.machines.statesShown(machine, observation.before)[0] : undefined;
        for (const invariant of this.invariants.onTransition(transition, from, true)) {
          if (invariant.status === 'RUNTIME_VIOLATED') {
            this.deps.emit('INVARIANT_VIOLATED', invariant.assertion.text);
            findings.push({
              code: 'INVARIANT_VIOLATED',
              status: 'WARNING',
              message: `${invariant.assertion.text} violated: ${invariant.observations?.at(-1) ?? ''}`,
            });
          } else this.deps.emit('INVARIANT_CONFIRMED', invariant.assertion.text);
        }
      }
    }
    // 2. Workflows et effets attendus.
    const stateShown = (workflow: FunctionalWorkflow): boolean | undefined => {
      const verdict = verdicts.find(
        (entry) =>
          entry.transition.entityType === workflow.entityType &&
          `${(entry.transition.trigger ?? '').toUpperCase()}:${entry.transition.entityType}` === workflow.id,
      );
      return verdict?.verdict === 'CONFIRMED'
        ? true
        : verdict?.verdict === 'CONTRADICTED'
          ? false
          : undefined;
    };
    const touched = config.workflows.enabled ? this.workflows.observe(observation, stateShown) : [];
    if (config.sideEffects.enabled) {
      for (const workflow of touched) {
        for (const verdict of this.sideEffects.observe(
          workflow,
          observation,
          stateShown(workflow),
          this.workflows.realizedBy(workflow, observation),
        )) {
          const effect = verdict.effect;
          if (verdict.status === 'CONFIRMED')
            this.deps.emit('SIDE_EFFECT_CONFIRMED', `${workflow.id}: ${verdict.detail}`);
          if (verdict.status !== 'MISSING') continue;
          this.deps.emit('SIDE_EFFECT_MISSING', `${workflow.id}: ${verdict.detail}`);
          // L'état manquant est déjà dit par EXPECTED_STATE_TRANSITION_MISSING.
          if (effect.category === 'STATE_CHANGE') continue;
          findings.push({
            code:
              effect.category === 'ENTITY' ? 'EXPECTED_ENTITY_NOT_OBSERVED' : 'EXPECTED_SIDE_EFFECT_MISSING',
            status: 'WARNING',
            message: `${workflow.id}: ${verdict.detail}`,
          });
          if (config.testGoals.enabled) {
            const goal = this.goals.sideEffectGoal(effect, workflow);
            if (goal) this.deps.emit('TEST_GOAL_GENERATED', `${goal.intent} — from ${goal.generatedFrom}`);
          }
        }
        for (const effect of this.sideEffects.expected(workflow.id))
          if (effect.status === 'CONFIRMED' && effect.category !== 'STATE_CHANGE')
            findings.push({
              code: 'SIDE_EFFECT_CONFIRMED',
              status: 'PASS',
              message: `${workflow.id}: ${effect.expectedEffect}`,
            });
      }
      const known = (method: string, path: string): boolean =>
        this.workflows
          .all()
          .some((workflow) => workflow.api !== undefined && apiMatches(workflow.api, method, path));
      for (const effect of this.sideEffects.unexpected(observation, known))
        if (
          this.unexpected.length < 30 &&
          !this.unexpected.some((entry) => entry.expectedEffect === effect.expectedEffect)
        )
          this.unexpected.push(effect);
    }
    // 3. Chemins d'erreur.
    if (config.errorPaths.enabled)
      for (const path of this.errorPaths.observe(observation, this.workflows.all()))
        this.deps.emit(
          'ERROR_PATH_DISCOVERED',
          `${path.operation} → ${String(path.httpStatus ?? '?')}${path.businessCode ? ` ${path.businessCode}` : ''} (${path.status})${path.uiTarget ? ` → field ${path.uiTarget}` : ''}`,
        );
    // 4. Contrat au runtime.
    if (config.runtimeContracts.enabled) {
      for (const exchange of observation.exchanges)
        if (exchange.method !== 'GET' && exchange.requestFields)
          this.checkedOperations.add(`${exchange.method} ${exchange.path}`);
      for (const mismatch of this.contract.observe(observation)) {
        this.deps.emit(
          'CONTRACT_RUNTIME_MISMATCH',
          `${mismatch.kind} ${mismatch.operation}: ${mismatch.detail}`,
        );
        findings.push({
          code: 'CONTRACT_MISMATCH',
          status: 'WARNING',
          message: `${mismatch.kind} ${mismatch.operation}: ${mismatch.detail}`,
        });
      }
    }
    this.findings.set(observation.actionId, findings);
    if (this.findings.size > 500) this.findings.delete(this.findings.keys().next().value ?? '');
    this.concludeGoals(observation);
    return findings;
  }

  /** Les objectifs en cours concluent d'après la connaissance revue ; budgets d'actions et de durée. */
  private concludeGoals(observation: FunctionalActionObservation): void {
    if (!this.deps.config.testGoals.enabled) return;
    this.syncGoals(observation);
    const budgets = this.deps.config.testGoals.budgets;
    for (const [id, progress] of this.running) {
      const goal = this.goals.get(id);
      if (!goal || goal.status !== 'RUNNING') {
        this.running.delete(id);
        continue;
      }
      progress.actions += 1;
      if (
        progress.actions >= budgets.maxGoalActions ||
        this.now() - progress.startedAt >= budgets.maxGoalDurationMs
      ) {
        this.conclude(goal, 'INCONCLUSIVE', `budget spent (${String(progress.actions)} action(s))`);
      } else this.deps.emit('TEST_GOAL_PROGRESS', `${goal.intent}: after "${observation.label}"`);
    }
  }

  private conclude(goal: TestGoal, status: TestGoal['status'], detail: string): void {
    if (!this.goals.transition(goal, status, detail)) return;
    this.running.delete(goal.id);
    const event: Partial<Record<TestGoal['status'], FunctionalEvent>> = {
      VERIFIED: 'TEST_GOAL_VERIFIED',
      FAILED: 'TEST_GOAL_FAILED',
      BLOCKED: 'TEST_GOAL_BLOCKED',
      INCONCLUSIVE: 'TEST_GOAL_INCONCLUSIVE',
    };
    const name = event[status];
    if (name) this.deps.emit(name, `${goal.intent}: ${detail}`);
  }

  /** L'état de chaque objectif suit la connaissance d'où il vient (une seule source de vérité). */
  private syncGoals(observation?: FunctionalActionObservation): void {
    const rules = new Map((this.deps.rules?.() ?? []).map((rule) => [rule.id, rule]));
    for (const goal of this.goals.all()) {
      if (goal.status === 'BLOCKED' || goal.status === 'VERIFIED' || goal.status === 'FAILED') continue;
      const running = goal.status === 'RUNNING';
      switch (goal.category) {
        case 'STATE_TRANSITION': {
          const transition = this.machines.transitions().find((entry) => entry.id === goal.sourceId);
          if (transition?.status === 'RUNTIME_CONFIRMED')
            this.conclude(goal, 'VERIFIED', transition.observations?.at(-1) ?? 'confirmed');
          else if (transition?.status === 'RUNTIME_CONTRADICTED')
            this.conclude(goal, 'FAILED', transition.observations?.at(-1) ?? 'contradicted');
          else if (running && observation && transition?.observations?.at(-1)?.startsWith('INCONCLUSIVE'))
            this.conclude(goal, 'INCONCLUSIVE', transition.observations.at(-1) ?? '');
          break;
        }
        case 'WORKFLOW': {
          const workflow = this.workflows.get(goal.sourceId);
          if (workflow?.status === 'VERIFIED')
            this.conclude(goal, 'VERIFIED', workflow.observations?.at(-1) ?? 'verified');
          else if (workflow?.status === 'FAILED')
            this.conclude(goal, 'FAILED', workflow.observations?.at(-1) ?? 'failed');
          else if (running && workflow?.status === 'INCONCLUSIVE')
            this.conclude(goal, 'INCONCLUSIVE', workflow.observations?.at(-1) ?? '');
          break;
        }
        case 'INVARIANT': {
          const invariant = this.invariants.all().find((entry) => entry.id === goal.sourceId);
          if (invariant?.status === 'RUNTIME_CONFIRMED')
            this.conclude(goal, 'VERIFIED', invariant.observations?.at(-1) ?? 'confirmed');
          else if (invariant?.status === 'RUNTIME_VIOLATED')
            this.conclude(goal, 'FAILED', invariant.observations?.at(-1) ?? 'violated');
          break;
        }
        case 'ERROR_PATH': {
          const path = this.errorPaths.all().find((entry) => entry.id === goal.sourceId);
          if (path?.status === 'RUNTIME_CONFIRMED')
            this.conclude(goal, 'VERIFIED', 'error chain observed up to the UI');
          break;
        }
        case 'CONTRACT': {
          const api = goal.target?.api ?? '';
          const checked = [...this.checkedOperations].some((call) =>
            apiMatches(api, call.split(' ')[0] ?? '', call.split(' ')[1] ?? ''),
          );
          if (!checked) break;
          const mismatches = this.contract.all().filter((entry) => entry.operation === api);
          if (mismatches.length > 0)
            this.conclude(
              goal,
              'FAILED',
              `CONTRACT_MISMATCH: ${mismatches.map((entry) => entry.kind).join(', ')}`,
            );
          else this.conclude(goal, 'VERIFIED', 'request body matches the contract');
          break;
        }
        case 'RULE':
        case 'PERMISSION': {
          const rule = rules.get(goal.sourceId);
          if (rule?.coverage === 'VERIFIED') this.conclude(goal, 'VERIFIED', 'rule verified at runtime');
          else if (rule?.coverage === 'CONTRADICTED')
            this.conclude(goal, 'FAILED', 'rule contradicted at runtime');
          else if (rule?.coverage === 'BLOCKED_BY_POLICY')
            this.conclude(goal, 'BLOCKED', rule.blockedReason ?? 'blocked by the SafetyPolicy');
          break;
        }
        default:
          break;
      }
      if (goal.status === 'CANDIDATE' && this.screen) {
        const plan = this.plan(goal);
        this.goals.reprice(goal, plan.cost, Math.max(...goal.evidence.map((entry) => entry.confidence), 0.5));
        this.goals.transition(goal, 'PLANNED');
      }
    }
  }

  // ------------------------------------------------------------------ rapport, persistance

  coverage(): FunctionalCoverage {
    const machines = this.machines.all();
    const transitions = machines.flatMap((machine) => machine.transitions);
    const invariants = this.invariants.all().filter((entry) => entry.scope !== 'API');
    const workflows = this.workflows.all();
    const effects = this.sideEffects.all();
    const rules = this.deps.rules?.() ?? [];
    const goals = Object.fromEntries(
      (['CANDIDATE', 'PLANNED', 'RUNNING', 'VERIFIED', 'FAILED', 'BLOCKED', 'INCONCLUSIVE'] as const).map(
        (status) => [status, this.goals.all().filter((goal) => goal.status === status).length],
      ),
    ) as FunctionalCoverage['goals'];
    const operations = (this.contractSource?.operations ?? []).filter(
      (operation) => operation.method !== 'GET',
    );
    return {
      rules: { total: rules.length, verified: rules.filter((rule) => rule.coverage === 'VERIFIED').length },
      states: {
        total: machines.reduce((sum, machine) => sum + machine.states.length, 0),
        observed: machines.reduce(
          (sum, machine) => sum + machine.states.filter((state) => state.observed).length,
          0,
        ),
      },
      transitions: {
        total: transitions.length,
        confirmed: transitions.filter((entry) => entry.status === 'RUNTIME_CONFIRMED').length,
        contradicted: transitions.filter((entry) => entry.status === 'RUNTIME_CONTRADICTED').length,
      },
      invariants: {
        total: invariants.length,
        confirmed: invariants.filter((entry) => entry.status === 'RUNTIME_CONFIRMED').length,
        violated: invariants.filter((entry) => entry.status === 'RUNTIME_VIOLATED').length,
      },
      workflows: {
        total: workflows.length,
        verified: workflows.filter((entry) => entry.status === 'VERIFIED').length,
        failed: workflows.filter((entry) => entry.status === 'FAILED').length,
      },
      sideEffects: {
        total: effects.length,
        confirmed: effects.filter((entry) => entry.status === 'CONFIRMED').length,
        missing: effects.filter((entry) => entry.status === 'MISSING').length,
      },
      errorPaths: {
        total: this.errorPaths.all().length,
        observed: this.errorPaths.all().filter((entry) => entry.status !== 'STATIC_DISCOVERED').length,
      },
      contract: {
        operations: operations.length,
        checked: operations.filter((operation) =>
          [...this.checkedOperations].some(
            (call) =>
              call.startsWith(`${operation.method} `) && operation.matcher.test(call.split(' ')[1] ?? ''),
          ),
        ).length,
        mismatches: this.contract.all().length,
      },
      goals,
    };
  }

  summary(): FunctionalSummary | undefined {
    if (!this.enabled) return undefined;
    this.syncGoals();
    return {
      machines: this.machines.all(),
      workflows: this.workflows.all(),
      invariants: this.invariants
        .all()
        .filter((entry) => entry.scope !== 'API')
        .slice(0, 100),
      sideEffects: [...this.sideEffects.all(), ...this.unexpected].slice(0, 150),
      errorPaths: this.errorPaths.all().slice(0, 100),
      contract: this.contract.all().slice(0, 100),
      goals: this.goals.all().map((goal) => {
        const history = this.deps.store?.recall(`GOAL:${goal.id}`);
        return {
          ...goal,
          ...(goal.status === 'CANDIDATE' || goal.status === 'PLANNED' ? { plan: this.plan(goal) } : {}),
          ...(history
            ? { history: `${history.status}${history.sameVersion ? '' : ' (earlier version, not proof)'}` }
            : {}),
        };
      }),
      coverage: this.coverage(),
      deferredGoals: this.goals.deferred,
    };
  }

  async persist(): Promise<void> {
    const store = this.deps.store;
    if (!store || !this.enabled) return;
    const entries = [
      ...this.machines.transitions().map((transition) => ({
        id: `TRANSITION:${transition.id}`,
        kind: 'TRANSITION' as const,
        status: transition.status,
      })),
      ...this.workflows.all().map((workflow) => ({
        id: `WORKFLOW:${workflow.id}`,
        kind: 'WORKFLOW' as const,
        status: workflow.status,
      })),
      ...this.invariants.all().map((invariant) => ({
        id: `INVARIANT:${invariant.id}`,
        kind: 'INVARIANT' as const,
        status: invariant.status,
      })),
      ...this.errorPaths
        .all()
        .map((path) => ({ id: `ERROR_PATH:${path.id}`, kind: 'ERROR_PATH' as const, status: path.status })),
      ...this.goals.all().map((goal) => ({
        id: `GOAL:${goal.id}`,
        kind: 'GOAL' as const,
        status: goal.status,
        ...(goal.status === 'VERIFIED' && goal.target?.route
          ? { route: goal.target.route, steps: goal.estimatedCost }
          : {}),
      })),
    ];
    await store.save(entries).catch(() => undefined);
  }
}

/** Ce que l'écran montre, réduit pour l'intelligence fonctionnelle (aucune valeur saisie). */
export function screenFactsOf(snapshot: UiSnapshot, route?: string): ScreenFacts {
  const control = (element: UiSnapshot['elements'][number]): string | undefined =>
    element.frameworkName ?? element.fieldName ?? element.elementId;
  const fields = snapshot.elements.filter(
    (element) => ['input', 'select', 'textarea'].includes(element.tag) || element.customSelect,
  );
  const selections: Record<string, string> = {};
  for (const element of fields) {
    const name = control(element);
    if (name && element.tag === 'select' && element.selectedValue) selections[name] = element.selectedValue;
  }
  return {
    url: snapshot.url,
    ...(route ? { route } : {}),
    text: [...snapshot.headings, snapshot.textExcerpt].join('\n'),
    buttons: snapshot.elements
      .filter(
        (element) =>
          element.visible && (element.tag === 'button' || element.role === 'button' || element.tag === 'a'),
      )
      .map((element) => ({ label: (element.name || element.text).trim(), enabled: !element.disabled }))
      .filter((button) => button.label.length > 0)
      .slice(0, 80),
    alerts: snapshot.signals?.alerts ?? [],
    invalidFields: fields
      .filter((element) => element.ariaInvalid === true || element.frameworkValid === false)
      .flatMap((element) => {
        const name = control(element);
        return name ? [name] : [];
      }),
    fields: fields.flatMap((element) => {
      const name = control(element);
      return name ? [name] : [];
    }),
    selections,
  };
}
