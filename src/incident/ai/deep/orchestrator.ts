import type {
  AiBudget,
  AiExperimentProposal,
  AiRef,
  AiStopReason,
  DeepInvestigationBudget,
  EnvironmentCapabilities,
  Experiment,
  GeneratedExperiment,
  Hypothesis,
  HypothesisExploration,
  Incident,
  InvestigationDepth,
  InvestigationMemory,
  InvestigationStrategy,
} from '../../../sdk/core/incident-contracts.js';
import type { ScopePolicy } from '../../scope-policy.js';
import { INVESTIGATION_TOOL_NAMES } from '../agent.js';
import { createBudgetTracker, type BudgetTracker } from '../budget.js';
import { mergeHypotheses } from '../merge.js';
import {
  runAiInvestigation,
  type AiInvestigationInputs,
  type AiInvestigationOutcome,
} from '../orchestrator.js';
import { resolveContradictions } from './contradictions.js';
import { computeCoverage } from './coverage.js';
import { applyVerificationResult, buildExplorations } from './exploration.js';
import { generateExperiments, isRunnable, operationsOf } from './experiments.js';
import {
  addContradiction,
  addExperiment,
  computeRemaining,
  loadMemory,
  markStrategy,
  recordEvent,
  recordLimit,
  saveMemory,
  setCoverage,
  setExplorations,
  setResumePoint,
  setStatus,
  setUsage,
  type MemoryStore,
} from './memory.js';
import { shouldContinue, type DeepStopReason } from './stopping.js';
import {
  discoverStrategies,
  markStrategyRunning,
  nextStrategy,
  recordStrategyOutcome,
} from './strategies.js';

/**
 * L'ORCHESTRATEUR ADAPTATIF DE L'INVESTIGATION APPROFONDIE.
 *
 * 1. La mémoire de l'incident est chargée (ou créée) ; les stratégies sont découvertes et évaluées.
 * 2. La passe des agents (orchestrator.ts : plan, preuves, couches, inter-couches, hypothèses, plan de
 *    vérification, chasseur de contradictions, synthèse) tourne une fois ; ses résultats entrent dans la mémoire.
 * 3. DEEP + AI_AGENTIC seulement : la boucle adaptative choisit la stratégie au meilleur gain, génère ses
 *    expériences (opérations exactes, politique évaluée), lance celles qui n'exigent personne par le chemin
 *    ordinaire du service, enregistre l'effet sur les hypothèses, tranche les contradictions liées, et continue
 *    tant que la politique d'arrêt (stopping.ts) le dit : jamais parce qu'un score est haut.
 * 4. La couverture est calculée par dimension, les limites atteintes sont consignées avec les pistes restantes,
 *    la mémoire est sauvée (reprise possible). Les rôles des hypothèses viennent du validateur déterministe et des
 *    résultats de vérification ; aucun agent ne confirme une cause.
 *
 * Le budget n'est jamais augmenté ici : une prolongation accordée par une personne est déjà dans la mémoire.
 */
export interface DeepInvestigationInputs extends Omit<AiInvestigationInputs, 'budget' | 'depth'> {
  depth: InvestigationDepth;
  budget: DeepInvestigationBudget;
  store: MemoryStore;
  policy: ScopePolicy;
  capabilities?: EnvironmentCapabilities;
  /** Relit l'incident à jour après une vérification écrite par le service (absent : vue locale). */
  refresh?: () => Promise<Incident>;
  /** Vrai quand une personne a demandé la pause : la boucle s'arrête entre deux itérations, reprise possible. */
  isPaused?: () => boolean;
  /** Justifications d'une répétition d'expérience (clé : id d'hypothèse). */
  justify?: Readonly<Record<string, string>>;
  /** Le seuil de gain d'information (stopping.ts). */
  gainThreshold?: number;
  /** Expériences générées au plus par stratégie (défaut 3). */
  maxPerStrategy?: number;
  /** Reçoit la mémoire à chaque sauvegarde (l'outil `get_investigation_memory` lit la dernière). */
  onMemory?: (memory: InvestigationMemory) => void;
}

export interface DeepInvestigationOutcome extends AiInvestigationOutcome {
  memory: InvestigationMemory;
  /** Pourquoi la boucle adaptative s'est arrêtée (DEEP) ; absent hors DEEP. */
  depthStopReason?: DeepStopReason;
  /** Les expériences générées pendant ce run (celles qui attendent une personne comprises). */
  generated: GeneratedExperiment[];
}

const BUDGET_KEYS: readonly (keyof AiBudget)[] = [
  'maxIterations',
  'maxModelCalls',
  'maxToolCalls',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCost',
  'maxDurationMs',
  'maxFiles',
  'maxCommands',
  'maxExperiments',
];

export async function runDeepInvestigation(
  input: DeepInvestigationInputs,
): Promise<DeepInvestigationOutcome> {
  const session = new DeepSession(input);
  return session.run();
}

class DeepSession {
  memory!: InvestigationMemory;
  view: Incident;
  explorations: HypothesisExploration[] = [];
  generated: GeneratedExperiment[] = [];
  limitations: string[] = [];
  tracker!: BudgetTracker;
  readonly startedAt: string;

  constructor(readonly input: DeepInvestigationInputs) {
    this.view = structuredClone(input.incident);
    this.startedAt = input.now();
  }

  private cancelled(): boolean {
    return this.input.signal.aborted;
  }

  private paused(): boolean {
    return this.input.isPaused?.() ?? false;
  }

  async run(): Promise<DeepInvestigationOutcome> {
    const { input } = this;
    const loaded = await loadMemory(input.store, input.incident.id, {
      depth: input.depth,
      mode: input.mode,
      budget: input.budget,
      at: this.startedAt,
    });
    if (loaded.limitation) this.limitations.push(loaded.limitation);
    const resuming = !loaded.fresh && loaded.memory.resumePoint !== undefined;
    this.memory = this.prepareMemory(loaded.memory, resuming);
    this.tracker = createBudgetTracker(this.memory.budget);
    await this.save();

    // Les stratégies : découvertes pour cette profondeur, réconciliées avec celles déjà tentées.
    const strategies = discoverStrategies({
      incident: input.incident,
      depth: input.depth,
      mode: input.mode,
      capabilities: input.capabilities,
      scopePermissions: input.incident.scope.permissions,
      tools: INVESTIGATION_TOOL_NAMES,
      memory: this.memory,
      ...(input.justify ? { justify: input.justify } : {}),
    });
    for (const strategy of strategies) this.memory = markStrategy(this.memory, strategy, this.startedAt);
    await this.save();

    // La passe des agents.
    const outcome = await runAiInvestigation({
      ...input,
      budget: this.memory.budget,
      depth: input.depth,
      runId: input.runId ?? undefined,
    });
    this.absorb(outcome);
    await this.save();

    let depthStopReason: DeepStopReason | undefined;
    if (input.depth === 'DEEP' && input.mode === 'AI_AGENTIC') depthStopReason = await this.loop(outcome);
    else if (input.depth === 'DEEP')
      this.limitations.push(
        'La boucle adaptative DEEP exige le mode AI_AGENTIC : passe des agents seulement.',
      );

    this.finish(outcome, depthStopReason);
    await this.save();
    outcome.run.limitations.push(
      ...this.limitations.filter((text) => !outcome.run.limitations.includes(text)),
    );
    return {
      ...outcome,
      memory: this.memory,
      ...(depthStopReason ? { depthStopReason } : {}),
      generated: this.generated,
    };
  }

  /** La mémoire du run : profondeur et mode courants, budget au plus haut entre la configuration et les prolongations. */
  private prepareMemory(memory: InvestigationMemory, resuming: boolean): InvestigationMemory {
    const budget: DeepInvestigationBudget = {
      ...this.input.budget,
      extensions: [...memory.budget.extensions],
    };
    for (const key of BUDGET_KEYS)
      if (memory.budget.extensions.length > 0) budget[key] = Math.max(budget[key], memory.budget[key]);
    let next: InvestigationMemory = { ...memory, depth: this.input.depth, mode: this.input.mode, budget };
    next = setStatus(next, 'RUNNING', undefined, this.startedAt);
    next = recordEvent(next, {
      kind: resuming ? 'RESUME' : 'DECISION',
      at: this.startedAt,
      actor: this.input.actor,
      summary: resuming
        ? `Investigation ${this.input.depth} reprise (itération ${String(memory.resumePoint?.iteration ?? 1)})`
        : `Investigation ${this.input.depth} lancée en ${this.input.mode}`,
    });
    return next;
  }

  /** Ce que la passe des agents a produit entre dans la mémoire : hypothèses, constats, contradictions, propositions. */
  private absorb(outcome: AiInvestigationOutcome): void {
    const at = this.input.now();
    const { run } = outcome;
    this.view.investigation.hypotheses = mergeHypotheses(
      this.view.investigation.hypotheses,
      outcome.hypotheses,
    );
    for (const experiment of outcome.experiments)
      if (!this.view.investigation.experiments.some((item) => item.id === experiment.id))
        this.view.investigation.experiments.push(experiment);
    for (const hypothesis of outcome.hypotheses)
      this.memory = recordEvent(this.memory, {
        kind: 'HYPOTHESIS',
        at,
        agent: 'HYPOTHESIS',
        summary: `Hypothèse proposée (IA, à vérifier) : ${hypothesis.title}`,
        refs: [{ kind: 'hypothesis', id: hypothesis.id }],
        hypothesisId: hypothesis.id,
      });
    for (const finding of run.findings.slice(0, 30))
      this.memory = recordEvent(this.memory, {
        kind: 'FINDING',
        at,
        agent: finding.agent,
        summary: `${finding.title} (${finding.basis})`,
        refs: finding.refs,
        ...(finding.hypothesisId ? { hypothesisId: finding.hypothesisId } : {}),
      });
    for (const contradiction of outcome.contradictions)
      this.memory = addContradiction(this.memory, contradiction);
    for (const proposal of outcome.proposals) {
      const generated = this.toGenerated(proposal);
      this.memory = addExperiment(this.memory, generated, { at }).memory;
    }
    this.tracker = createBudgetTracker(this.memory.budget);
    this.seedUsage(run.usage);

    // Les stratégies portées par un agent : tenues par la passe des agents.
    for (const strategy of this.memory.strategies) {
      const agent = strategy.via.agent;
      if (!agent || strategy.via.experimentKind) continue;
      const step = [...run.steps].reverse().find((item) => item.agent === agent);
      if (!step) continue;
      const refs: AiRef[] = run.findings
        .filter((finding) => finding.agent === agent)
        .map((finding) => ({ kind: 'evidence', id: finding.id }));
      const status =
        step.status === 'DONE'
          ? 'COMPLETED'
          : step.status === 'FAILED'
            ? 'FAILED'
            : step.status === 'SKIPPED'
              ? 'SKIPPED'
              : undefined;
      if (!status) continue;
      const [updated] = recordStrategyOutcome([strategy], strategy.id, {
        status,
        at,
        refs: refs.filter((ref) => ref.id.length > 0),
        ...(step.error ? { reason: step.error } : step.summary ? { reason: step.summary } : {}),
      });
      if (updated) this.memory = markStrategy(this.memory, updated, at);
    }
    this.explorations = buildExplorations(this.view, this.memory, run);
    this.memory = setExplorations(this.memory, this.explorations, at);
  }

  private seedUsage(usage: AiInvestigationOutcome['run']['usage']): void {
    this.tracker.charge('iteration', usage.iterations);
    this.tracker.charge('modelCall', usage.modelCalls);
    this.tracker.charge('toolCall', usage.toolCalls);
    this.tracker.charge('inputTokens', usage.inputTokens);
    this.tracker.charge('outputTokens', usage.outputTokens);
    this.tracker.charge('cost', usage.estimatedCost);
    this.tracker.charge('file', usage.files);
    this.tracker.charge('experiment', usage.experiments);
  }

  /** La boucle adaptative : une stratégie par itération, tant que la politique d'arrêt le permet. */
  private async loop(outcome: AiInvestigationOutcome): Promise<DeepStopReason> {
    let iteration = this.memory.resumePoint?.iteration ?? 1;
    const confirmed = (): string[] =>
      this.view.investigation.hypotheses
        .filter((hypothesis) => hypothesis.status === 'CONFIRMED')
        .map((hypothesis) => hypothesis.id);
    for (;;) {
      const decision = shouldContinue({
        strategies: this.memory.strategies,
        contradictions: this.memory.contradictions,
        experiments: this.memory.experiments,
        confirmedHypothesisIds: confirmed(),
        budgetExceeded: this.tracker.exceeded(),
        cancelled: this.cancelled(),
        paused: this.paused(),
        ...(this.input.gainThreshold !== undefined ? { gainThreshold: this.input.gainThreshold } : {}),
        isRunnable,
      });
      if (!decision.continue) {
        this.limitations.push(`Boucle adaptative arrêtée : ${decision.detail}`);
        return decision.reason ?? 'GOALS_MET';
      }
      if (!this.tracker.allows('iteration')) {
        this.limit('maxIterations');
        return 'BUDGET_EXHAUSTED';
      }
      this.tracker.charge('iteration');
      const at = this.input.now();

      const strategy = nextStrategy(this.memory.strategies, this.explorations, this.memory.contradictions, {
        ...(this.input.gainThreshold !== undefined ? { gainThreshold: this.input.gainThreshold } : {}),
        executionModes: ['READ_ONLY', 'SANDBOX', 'APPROVAL_REQUIRED'],
      });
      const decisive = this.memory.experiments.filter(
        (experiment) =>
          isRunnable(experiment) &&
          this.memory.contradictions.some(
            (item) => item.status === 'OPEN' && item.proposalId === experiment.id,
          ),
      );
      if (!strategy && decisive.length === 0) {
        this.limitations.push('Boucle adaptative arrêtée : plus aucune stratégie disponible.');
        return 'STRATEGIES_EXHAUSTED';
      }
      if (strategy) {
        const [running] = markStrategyRunning([strategy], strategy.id, at);
        if (running) this.memory = markStrategy(this.memory, running, at);
        await this.carryOut(strategy, outcome, at);
      } else {
        for (const experiment of decisive) await this.runGenerated(experiment, undefined, at);
      }
      iteration += 1;
      this.memory = setResumePoint(this.memory, { iteration }, this.input.now());
      this.memory = setUsage(this.memory, this.tracker.usage, this.input.now());
      await this.save();
    }
  }

  /** Une stratégie : ses expériences générées, lancées quand rien n'exige une personne. */
  private async carryOut(
    strategy: InvestigationStrategy,
    outcome: AiInvestigationOutcome,
    at: string,
  ): Promise<void> {
    if (!strategy.via.experimentKind) {
      // Portée par un agent : la passe des agents est passée ; rien d'autre ne tourne ici.
      this.memory = markStrategy(
        this.memory,
        recordStrategyOutcome([strategy], strategy.id, {
          status: 'SKIPPED',
          at,
          reason: 'stratégie menée par un agent : la passe des agents est terminée pour ce run',
        })[0] ?? strategy,
        at,
      );
      return;
    }
    const generation = await generateExperiments({
      incident: this.view,
      policy: this.input.policy,
      explorations: this.explorations,
      strategies: this.memory.strategies,
      contradictions: this.memory.contradictions,
      strategy,
      proposals: outcome.proposals,
      ...(this.input.capabilities ? { capabilities: this.input.capabilities } : {}),
      memory: this.memory,
      ...(this.input.justify ? { justify: this.input.justify } : {}),
      now: at,
      ...(this.input.maxPerStrategy !== undefined ? { maxPerStrategy: this.input.maxPerStrategy } : {}),
    });
    this.limitations.push(...generation.skipped.map((text) => `Expérience non générée : ${text}`));
    const refs: AiRef[] = [];
    let ran = 0;
    let awaiting = 0;
    for (const experiment of generation.experiments) {
      const added = addExperiment(this.memory, experiment, { at });
      this.memory = added.memory;
      if (!added.accepted) continue;
      this.generated.push(experiment);
      refs.push({ kind: 'experiment', id: experiment.id });
      if (isRunnable(experiment)) {
        const done = await this.runGenerated(experiment, strategy, at);
        if (done) ran += 1;
      } else {
        awaiting += 1;
        this.memory = recordEvent(this.memory, {
          kind: 'PERMISSION',
          at,
          summary: `Approbation nécessaire pour ${experiment.id} (${experiment.kind}) : ${experiment.permissions.join(' ; ')}`,
          refs: [{ kind: 'experiment', id: experiment.id }],
          hypothesisId: experiment.hypothesisId,
          strategyId: strategy.id,
          experimentId: experiment.id,
        });
      }
    }
    const status =
      ran > 0
        ? 'COMPLETED'
        : awaiting > 0
          ? 'BLOCKED'
          : generation.experiments.length === 0
            ? 'SKIPPED'
            : 'FAILED';
    const reason =
      status === 'BLOCKED'
        ? `${String(awaiting)} expérience(s) en attente d’une approbation`
        : status === 'SKIPPED'
          ? (generation.skipped.find((text) => text.startsWith(strategy.id)) ?? 'rien à générer')
          : status === 'FAILED'
            ? 'aucune expérience n’a pu être lancée'
            : undefined;
    const [updated] = recordStrategyOutcome([strategy], strategy.id, {
      status,
      at: this.input.now(),
      refs,
      ...(reason ? { reason } : {}),
    });
    if (updated) this.memory = markStrategy(this.memory, updated, this.input.now());
  }

  /** Lance une expérience générée par le chemin ordinaire du service ; enregistre son effet. Rend vrai si elle a tourné. */
  private async runGenerated(
    experiment: GeneratedExperiment,
    strategy: InvestigationStrategy | undefined,
    at: string,
  ): Promise<boolean> {
    const run = this.input.runExperiment;
    if (!run) {
      this.limitations.push(`Expérience ${experiment.id} non lancée : aucun exécuteur de vérification.`);
      return false;
    }
    const room = this.view.scope.limits.maxExperiments - this.view.investigation.experiments.length;
    if (!this.tracker.allows('experiment') || room <= 0) {
      this.limit('maxExperiments');
      return false;
    }
    this.memory = addExperiment(this.memory, { ...experiment, status: 'PLANNED' }, { at }).memory;
    let result: Experiment;
    try {
      result = await run(experiment);
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error);
      this.memory = addExperiment(this.memory, { ...experiment, status: 'REFUSED', refusal }, { at }).memory;
      this.limitations.push(`Expérience ${experiment.id} non lancée : ${refusal}`);
      return false;
    }
    this.tracker.charge('experiment');
    if (this.input.refresh) this.view = structuredClone(await this.input.refresh());
    else {
      this.view.investigation.experiments.push(result);
      this.view.investigation.hypotheses = applyOutcome(this.view.investigation.hypotheses, result);
    }
    const effect =
      result.outcome === 'SUPPORTS' ? 'SUPPORTS' : result.outcome === 'REFUTES' ? 'CONTRADICTS' : 'NEUTRAL';
    const status = result.status === 'DONE' ? 'DONE' : result.status === 'REFUSED' ? 'REFUSED' : 'PLANNED';
    this.memory = addExperiment(
      this.memory,
      {
        ...experiment,
        status,
        experimentId: result.id,
        ...(result.status === 'REFUSED' ? { refusal: result.summary ?? 'refus du périmètre' } : {}),
        ...(result.status === 'DONE' ? { impact: [{ hypothesisId: experiment.hypothesisId, effect }] } : {}),
      },
      { at: this.input.now() },
    ).memory;
    if (result.status === 'DONE') {
      this.explorations = applyVerificationResult(
        this.explorations,
        result,
        this.view.investigation.hypotheses,
        this.view.investigation.diagnosis,
      );
      this.memory = setExplorations(this.memory, this.explorations, this.input.now());
      const before = this.memory.contradictions;
      const after = resolveContradictions(before, [result], [{ id: experiment.id, experimentId: result.id }]);
      after.forEach((contradiction, index) => {
        if (contradiction !== before[index]) this.memory = addContradiction(this.memory, contradiction);
      });
      this.memory = recordEvent(this.memory, {
        kind:
          effect === 'SUPPORTS' ? 'CONFIRMATION' : effect === 'CONTRADICTS' ? 'REFUTATION' : 'EXPERIMENT_RUN',
        at: this.input.now(),
        summary: `${experiment.kind} ${result.id} : ${result.outcome ?? 'sans résultat'}${result.summary ? ` — ${result.summary}` : ''}`,
        refs: [
          { kind: 'experiment', id: result.id },
          { kind: 'hypothesis', id: experiment.hypothesisId },
        ],
        hypothesisId: experiment.hypothesisId,
        ...(strategy ? { strategyId: strategy.id } : {}),
        experimentId: result.id,
      });
      return true;
    }
    this.limitations.push(
      `Expérience ${experiment.id} (${result.id}) : ${result.status}${result.summary ? ` — ${result.summary}` : ''}`,
    );
    return false;
  }

  private limit(key: keyof AiBudget): void {
    const current = this.memory.budget[key];
    this.memory = recordLimit(this.memory, {
      at: this.input.now(),
      limit: key,
      remaining: computeRemaining(this.memory),
      proposedExtension: { [key]: Math.max(1, Math.ceil(current / 2)) },
    });
    this.limitations.push(
      `Limite ${key} atteinte : ${String(this.memory.remaining.length)} piste(s) restante(s).`,
    );
  }

  private finish(outcome: AiInvestigationOutcome, depthStopReason: DeepStopReason | undefined): void {
    const at = this.input.now();
    this.memory = setCoverage(this.memory, computeCoverage(this.view, this.memory, outcome.run), at);
    this.memory = setUsage(this.memory, this.tracker.usage, at);
    const exceeded = this.tracker.exceeded();
    if (exceeded === 'BUDGET_EXHAUSTED' && !this.memory.limits.some((item) => item.at === at))
      this.limit(exhaustedKey(this.tracker));
    if (exceeded === 'TIMEOUT') this.limit('maxDurationMs');

    let status: InvestigationMemory['status'];
    let stop: InvestigationMemory['stopReason'];
    if (this.cancelled()) {
      status = 'CANCELLED';
      stop = 'CANCELLED';
    } else if (depthStopReason === 'PAUSED') {
      status = 'PAUSED';
      stop = 'PAUSED';
    } else if (exceeded !== undefined || outcome.run.status === 'PARTIAL') {
      status = 'PARTIAL';
      stop = exceeded ?? outcome.run.stopReason ?? depthStopReason;
    } else if (outcome.run.status === 'FAILED') {
      status = 'FAILED';
      stop = outcome.run.stopReason;
    } else {
      status = 'DONE';
      stop = depthStopReason ?? outcome.run.stopReason;
    }
    this.memory = setStatus(this.memory, status, stop, at);
    if (status !== 'PAUSED' && status !== 'PARTIAL') {
      const { resumePoint: _resumePoint, ...rest } = this.memory;
      this.memory = rest;
    }
    if (this.cancelled())
      this.memory = recordEvent(this.memory, {
        kind: 'CANCEL',
        at,
        actor: this.input.actor,
        summary: 'Investigation annulée : les résultats acquis sont conservés.',
      });
    else if (status === 'PAUSED')
      this.memory = recordEvent(this.memory, {
        kind: 'PAUSE',
        at,
        actor: this.input.actor,
        summary: `Investigation mise en pause (itération ${String(this.memory.resumePoint?.iteration ?? 1)}).`,
      });
  }

  private async save(): Promise<void> {
    try {
      this.memory = await saveMemory(this.input.store, this.memory);
      this.input.onMemory?.(this.memory);
    } catch (error) {
      const text = `Mémoire d’investigation non sauvée : ${error instanceof Error ? error.message : String(error)}`;
      if (!this.limitations.includes(text)) this.limitations.push(text);
    }
  }

  /** Une proposition d'agent vue comme expérience générée : opérations déclarées, politique non encore évaluée. */
  private toGenerated(proposal: AiExperimentProposal): GeneratedExperiment {
    return {
      ...proposal,
      requiredEvidence: [],
      prerequisites: [],
      operations: operationsOf(proposal.kind, proposal.verification.params, this.view),
      estimatedCost: 1,
      risk: proposal.sideEffects ? 'HIGH' : 'LOW',
    };
  }
}

function exhaustedKey(tracker: BudgetTracker): keyof AiBudget {
  switch (tracker.exhausted()) {
    case 'iteration':
      return 'maxIterations';
    case 'modelCall':
      return 'maxModelCalls';
    case 'toolCall':
      return 'maxToolCalls';
    case 'inputTokens':
      return 'maxInputTokens';
    case 'outputTokens':
      return 'maxOutputTokens';
    case 'cost':
      return 'maxCost';
    case 'file':
      return 'maxFiles';
    case 'command':
      return 'maxCommands';
    case 'experiment':
      return 'maxExperiments';
    case 'duration':
    case undefined:
      return 'maxDurationMs';
  }
}

/** Sans relecture du service : l'effet d'une vérification DONE sur les hypothèses, comme le moteur l'écrit. */
function applyOutcome(hypotheses: Hypothesis[], experiment: Experiment): Hypothesis[] {
  if (experiment.status !== 'DONE' || !experiment.hypothesisId || !experiment.outcome) return hypotheses;
  return hypotheses.map((hypothesis) =>
    hypothesis.id === experiment.hypothesisId
      ? {
          ...hypothesis,
          ...(experiment.outcome === 'SUPPORTS'
            ? {
                supporting: [
                  ...hypothesis.supporting,
                  { ref: experiment.id, fact: experiment.summary ?? 'soutient' },
                ],
              }
            : experiment.outcome === 'REFUTES'
              ? {
                  contradicting: [
                    ...hypothesis.contradicting,
                    { ref: experiment.id, fact: experiment.summary ?? 'réfute' },
                  ],
                }
              : {}),
        }
      : hypothesis,
  );
}

export type { AiStopReason };
