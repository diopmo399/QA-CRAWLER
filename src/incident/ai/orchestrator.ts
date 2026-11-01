import {
  AI_AGENTS,
  type AiAgentName,
  type AiBudget,
  type AiDataPolicy,
  type AiExperimentProposal,
  type AiFinding,
  type AiInvestigationMode,
  type AiInvestigationRun,
  type AiPlanStep,
  type AiRef,
  type AiScopeRequest,
  type AiSourceLocation,
  type AiStopReason,
  type AiSuggestedRelation,
  type AiContradiction,
  type InvestigationDepth,
} from '../../sdk/core/incident-ai-contracts.js';
import type { Experiment, GraphEdge, Hypothesis, Incident } from '../../sdk/core/incident-contracts.js';
import type {
  AgentLoop,
  AgentLoopResult,
  AgentOutcome,
  AgentRunContext,
  EvidencePack,
  InvestigationAgent,
  ToolRegistry,
} from './agent.js';
import { toPlanSteps, unplannedLayerAgents } from './agents/planner.js';
import { toAiSynthesis, type RunRefs } from './agents/synthesis.js';
import { createBudgetTracker, type BudgetTracker } from './budget.js';
import { createAgentLoop, describe } from './loop.js';
import {
  crossLayerFindings,
  evidenceFindings,
  resolveContradictions,
  toGraphRelations,
  toHypotheses,
  toProposals,
  type RefLookup,
} from './merge.js';
import type { InvestigationModelClient } from './model-client.js';
import { RefIndex } from './refs.js';
import {
  CrossLayerFindingsSchema,
  EvidenceAnalysisSchema,
  VerificationPlanSchema,
  type HypothesisProposals,
} from './schemas/analysis.js';
import { LayerFindingsSchema } from './schemas/layer.js';
import { PlannerOutputSchema, SynthesisSchema } from './schemas/plan.js';
import { createRunTrace, type RunTrace } from './trace.js';
import { convertContradictions } from './deep/contradictions.js';
import { ContradictionFindingsSchema } from './schemas/contradiction.js';

/**
 * L'ORCHESTRATEUR D'UN RUN IA : la séquence des agents, bornée par le budget, le délai et le signal.
 *
 * PLANNER → EVIDENCE_ANALYSIS → agents de couche (parallèle borné, un échec ne perd pas les autres) → CROSS_LAYER →
 * HYPOTHESIS → VERIFICATION_PLANNING → [AI_AGENTIC : itérations : lancement automatique des vérifications sans effet
 * de bord déjà permises par le périmètre, par le chemin ordinaire injecté `runExperiment`, puis révision du plan et
 * réévaluation des hypothèses] → SYNTHESIS. Les agents sont INJECTÉS (descriptions pures) ; leurs sorties sont
 * reconnues par leurs schémas et traduites en artefacts du contrat par `merge.ts`. Tout ce qui est produit avant un
 * arrêt (budget, délai, annulation, erreur) est conservé dans le run.
 */
export type ActiveMode = Exclude<AiInvestigationMode, 'DETERMINISTIC'>;

export type AutoRunExperiment = (proposal: AiExperimentProposal) => Promise<Experiment>;

export interface AiInvestigationInputs {
  incident: Incident;
  mode: ActiveMode;
  client: InvestigationModelClient;
  tools: ToolRegistry;
  packs: AgentRunContext['packs'];
  budget: AiBudget;
  dataPolicy: AiDataPolicy;
  signal: AbortSignal;
  actor: string;
  now: () => string;
  /** La profondeur demandée, conservée dans le run (la boucle adaptative DEEP est dans deep/orchestrator.ts). */
  depth?: InvestigationDepth;
  /** Les agents, dans n'importe quel ordre : la séquence est celle de `AI_AGENTS`. */
  agents: InvestigationAgent<unknown>[];
  onProgress?: (run: AiInvestigationRun) => void;
  /** AI_AGENTIC : lance une vérification proposée par le chemin ordinaire du service ; absent : rien n'est lancé. */
  runExperiment?: AutoRunExperiment;
  runId?: string;
  /** Délai d'un appel au modèle (défaut 60 s). */
  timeoutMs?: number;
  /** Plafond de tours par agent (défaut : 2 en AI_ASSISTED, 6 en AI_AGENTIC). */
  maxTurnsPerAgent?: number;
  /** Agents de couche en parallèle (défaut 3). */
  maxParallel?: number;
  /** L'index de références (refs.ts) ; absent : construit depuis l'incident, rebâti après les vérifications. */
  refs?: RefLookup;
  /** La boucle (tests) ; absent : `createAgentLoop` sur le client. */
  loop?: AgentLoop;
  /** Une proposition peut-elle être lancée sans personne ? (défaut : sans effet de bord et permise par le périmètre). */
  canAutoRun?: (proposal: AiExperimentProposal, incident: Incident) => boolean;
  /** Les demandes d'extension créées par les outils pendant ce run (le service les collecte). */
  collectScopeRequests?: () => readonly AiScopeRequest[];
}

export interface AiInvestigationOutcome {
  run: AiInvestigationRun;
  /** Les hypothèses d'origine IA (hyp-ai-n, PROPOSED), à fusionner par `mergeHypotheses`. */
  hypotheses: Hypothesis[];
  relations: AiSuggestedRelation[];
  /** Les arêtes INFERRED à écrire dans le graphe (relations dont les deux nœuds existent). */
  edges: GraphEdge[];
  proposals: AiExperimentProposal[];
  scopeRequests: AiScopeRequest[];
  /** Les vérifications lancées automatiquement (déjà écrites dans l'incident par le chemin ordinaire). */
  experiments: Experiment[];
  /** Les contradictions trouvées par le chasseur (OPEN ; questions ouvertes marquées), pour la mémoire approfondie. */
  contradictions: AiContradiction[];
  /** Les sorties validées des agents, par nom (pour les moteurs de l'investigation approfondie). */
  outputs: Partial<Record<AiAgentName, unknown>>;
}

/** Le contexte réellement donné aux agents : le contrat, l'index de références et les identifiants du run. */
export interface OrchestratorRunContext extends AgentRunContext {
  refs: RefLookup;
  runRefs: RunRefs;
}

export const DEFAULT_TURNS_PER_AGENT: Readonly<Record<ActiveMode, number>> = {
  AI_ASSISTED: 2,
  AI_AGENTIC: 6,
};
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PARALLEL = 3;
const SEQUENCE: readonly AiAgentName[] = AI_AGENTS.filter((agent) => agent !== 'ASSISTANT');
const LAYER_AGENTS: readonly AiAgentName[] = ['FRONTEND', 'BFF', 'BACKEND'];

type StepResult = 'ok' | 'failed' | 'skipped' | 'stopped';

export async function runAiInvestigation(input: AiInvestigationInputs): Promise<AiInvestigationOutcome> {
  const runId = input.runId ?? newRunId(input.now());
  const tracker = createBudgetTracker(input.budget);
  const trace = createRunTrace({
    id: runId,
    mode: input.mode,
    startedBy: input.actor,
    budget: input.budget,
    now: input.now,
    ...(input.client.id ? { provider: input.client.id } : {}),
    ...(input.client.model ? { model: input.client.model } : {}),
    ...(input.depth ? { depth: input.depth } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  const session = new RunSession(input, tracker, trace, runId);
  try {
    await session.run();
  } catch (error) {
    session.failure = `erreur inattendue : ${describe(error)}`;
  }
  return session.finish();
}

/** L'état d'un run en cours (un objet par run ; jamais partagé). */
class RunSession {
  readonly agents = new Map<AiAgentName, InvestigationAgent<unknown>>();
  readonly previous: Partial<Record<AiAgentName, unknown>> = {};
  readonly runRefs: { hypothesisIds: string[]; proposalIds: string[]; findingIds: string[] } = {
    hypothesisIds: [],
    proposalIds: [],
    findingIds: [],
  };
  readonly incident: Incident;
  readonly loop: AgentLoop;
  readonly maxTurns: number;
  refs: RefLookup;
  readonly ownRefs: boolean;
  hypotheses: Hypothesis[] = [];
  proposals: AiExperimentProposal[] = [];
  experiments: Experiment[] = [];
  contradictions: AiContradiction[] = [];
  skippedByPlan = new Set<AiAgentName>();
  stopReason: AiStopReason | undefined;
  failure: string | undefined;
  autoRunAttempts = 0;
  autoRunRefusals = 0;
  readonly statuses: AgentLoopResult<unknown>['status'][] = [];
  readonly failures: string[] = [];

  constructor(
    readonly input: AiInvestigationInputs,
    readonly tracker: BudgetTracker,
    readonly trace: RunTrace,
    readonly runId: string,
  ) {
    for (const agent of input.agents) this.agents.set(agent.name, agent);
    this.incident = structuredClone(input.incident);
    this.maxTurns = Math.max(1, input.maxTurnsPerAgent ?? DEFAULT_TURNS_PER_AGENT[input.mode]);
    const base =
      input.loop ??
      createAgentLoop({
        client: input.client,
        tools: input.tools,
        budget: tracker,
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        dataPolicy: input.dataPolicy,
        now: input.now,
      });
    const maxTurns = this.maxTurns;
    this.loop = (loopInput) =>
      base({ ...loopInput, maxTurns: Math.max(1, Math.min(loopInput.maxTurns, maxTurns)) });
    this.ownRefs = input.refs === undefined;
    this.refs = input.refs ?? new RefIndex(this.incident);
  }

  context(): OrchestratorRunContext {
    // Les hypothèses et propositions de CE run sont citables par les agents suivants (chasseur, synthèse).
    const own = this.runRefs;
    const base = this.refs;
    const refs: RefLookup = {
      has: (ref) =>
        base.has(ref) ||
        (ref.kind === 'hypothesis' && own.hypothesisIds.includes(ref.id)) ||
        (ref.kind === 'experiment' && own.proposalIds.includes(ref.id)),
      hasLocation: (location) => base.hasLocation(location),
    };
    return {
      mode: this.input.mode,
      incident: this.incident,
      tools: this.input.tools,
      loop: this.loop,
      budget: this.tracker.budget,
      packs: this.packs(),
      previous: this.previous,
      signal: this.input.signal,
      now: this.input.now,
      refs,
      runRefs: this.runRefs,
    };
  }

  /** Les paquets du run ; celui des vérifications porte en plus les résultats lancés pendant ce run. */
  /** Lu via une méthode : le contrôle de flux ne doit pas « prouver » que le signal reste inactif après un await. */
  private cancelled(): boolean {
    return this.input.signal.aborted;
  }

  private packs(): AgentRunContext['packs'] {
    const packs = this.input.packs;
    if (this.experiments.length === 0) return packs;
    const extra = this.experiments;
    return {
      ...packs,
      experiments: (): EvidencePack => {
        const pack = packs.experiments();
        const lines = extra.map(
          (experiment) =>
            `- ${experiment.id} (${experiment.kind}, ${experiment.status}${experiment.outcome ? `, ${experiment.outcome}` : ''}): ${experiment.summary ?? ''}; evidence: ${experiment.evidence.map((item) => item.id).join(', ') || 'none'}`,
        );
        return {
          text: `${pack.text}\n\nVerifications run during this investigation (data):\n${lines.join('\n')}`,
          refs: [
            ...pack.refs,
            ...extra.map((experiment): AiRef => ({ kind: 'experiment', id: experiment.id })),
            ...extra.flatMap((experiment) =>
              experiment.evidence.map((item): AiRef => ({ kind: 'evidence', id: item.id })),
            ),
          ],
          omitted: pack.omitted,
        };
      },
    };
  }

  async run(): Promise<void> {
    this.trace.setPlan(this.defaultPlan());
    this.tracker.charge('iteration');
    await this.step('PLANNER');
    await this.step('EVIDENCE_ANALYSIS');
    await this.layers();
    await this.step('CROSS_LAYER');
    await this.step('HYPOTHESIS');
    await this.step('VERIFICATION_PLANNING');
    await this.step('CONTRADICTION_HUNTER');
    if (this.input.mode === 'AI_AGENTIC') await this.iterate();
    await this.step('SYNTHESIS');
  }

  /** Le plan par défaut : la séquence, pour les agents fournis. */
  private defaultPlan(): AiPlanStep[] {
    return SEQUENCE.filter((name) => this.agents.has(name)).map((name, index) => ({
      id: `plan-${String(index + 1)}`,
      order: index + 1,
      title: TITLES[name],
      agent: name,
      status: 'PENDING',
      targets: [],
    }));
  }

  private async layers(): Promise<void> {
    const names = LAYER_AGENTS.filter((name) => this.agents.has(name));
    for (const name of LAYER_AGENTS.filter(
      (candidate) => this.skippedByPlan.has(candidate) && this.agents.has(candidate),
    ))
      this.trace.skipStep(name, 'SKIPPED', 'couche non retenue par le plan');
    const runnable = names.filter((name) => !this.skippedByPlan.has(name));
    const limit = Math.max(1, this.input.maxParallel ?? DEFAULT_PARALLEL);
    for (let at = 0; at < runnable.length; at += limit) {
      const batch = runnable.slice(at, at + limit);
      const settled = await Promise.allSettled(batch.map((name) => this.step(name)));
      settled.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          const name = batch[index];
          if (name) this.trace.finishStep(name, { status: 'FAILED', error: describe(outcome.reason) });
        }
      });
    }
  }

  /** AI_AGENTIC : vérifications sans effet de bord déjà permises, puis révision et réévaluation. */
  private async iterate(): Promise<void> {
    const run = this.input.runExperiment;
    if (!run) {
      this.trace.addLimitations(['Lancement automatique des vérifications indisponible dans ce contexte.']);
      return;
    }
    const canAutoRun = this.input.canAutoRun ?? defaultCanAutoRun;
    for (;;) {
      if (this.input.signal.aborted || this.tracker.exceeded() !== undefined) return;
      if (!this.tracker.allows('iteration')) {
        this.trace.addLimitations([`Itérations épuisées (${String(this.tracker.budget.maxIterations)}).`]);
        return;
      }
      const limit =
        this.incident.scope.limits.maxExperiments - this.incident.investigation.experiments.length;
      const room = Math.min(this.tracker.remaining('experiment'), Math.max(0, limit));
      const candidates = this.proposals
        .filter((proposal) => proposal.status === 'PROPOSED' && canAutoRun(proposal, this.incident))
        .slice(0, room);
      if (candidates.length === 0) {
        if (room <= 0 && this.proposals.some((proposal) => proposal.status === 'PROPOSED'))
          this.trace.addLimitations([
            'Budget des vérifications épuisé : les autres propositions attendent une personne.',
          ]);
        return;
      }
      this.tracker.charge('iteration');
      for (const candidate of candidates) {
        if (this.cancelled()) return;
        await this.autoRun(run, candidate);
      }
      await this.step('PLANNER');
      await this.step('HYPOTHESIS');
      await this.step('VERIFICATION_PLANNING');
    }
  }

  private async autoRun(run: AutoRunExperiment, proposal: AiExperimentProposal): Promise<void> {
    this.autoRunAttempts += 1;
    this.trace.updateProposal(proposal.id, { status: 'PLANNED' });
    this.setProposal(proposal.id, { status: 'PLANNED' });
    try {
      const experiment = await run(proposal);
      this.tracker.charge('experiment');
      this.trace.setUsage(this.tracker.usage);
      this.experiments.push(experiment);
      this.incident.investigation.experiments.push(experiment);
      if (this.ownRefs) this.refs = new RefIndex(this.incident, (this.refs as RefIndex).filesRead);
      const patch: Partial<AiExperimentProposal> =
        experiment.status === 'DONE'
          ? { status: 'DONE', experimentId: experiment.id }
          : experiment.status === 'REFUSED'
            ? {
                status: 'REFUSED',
                experimentId: experiment.id,
                refusal: experiment.summary ?? 'refus du périmètre',
              }
            : {
                status: 'PLANNED',
                experimentId: experiment.id,
                refusal: `${experiment.status}${experiment.summary ? ` : ${experiment.summary}` : ''}`,
              };
      if (experiment.status === 'REFUSED') {
        this.autoRunRefusals += 1;
        this.trace.addLimitations([
          `Vérification ${proposal.id} refusée : ${experiment.summary ?? 'refus du périmètre'}`,
        ]);
      }
      this.trace.updateProposal(proposal.id, patch);
      this.setProposal(proposal.id, patch);
    } catch (error) {
      const refusal = describe(error);
      this.autoRunRefusals += 1;
      this.trace.updateProposal(proposal.id, { status: 'REFUSED', refusal });
      this.setProposal(proposal.id, { status: 'REFUSED', refusal });
      this.trace.addLimitations([`Vérification ${proposal.id} non lancée : ${refusal}`]);
    }
  }

  private setProposal(id: string, patch: Partial<AiExperimentProposal>): void {
    this.proposals = this.proposals.map((proposal) =>
      proposal.id === id ? { ...proposal, ...patch } : proposal,
    );
  }

  /** Un agent de la séquence : sauté, arrêté avant (budget, annulation), ou exécuté et tracé. */
  private async step(name: AiAgentName): Promise<StepResult> {
    const agent = this.agents.get(name);
    if (!agent) return 'skipped';
    if (this.input.signal.aborted) {
      this.trace.skipStep(name, 'CANCELLED', 'annulé avant cet agent');
      this.stopReason ??= 'CANCELLED';
      return 'stopped';
    }
    const exhausted = this.tracker.exceeded();
    if (exhausted !== undefined) {
      this.stopReason ??= exhausted;
      this.trace.skipStep(
        name,
        'PENDING',
        exhausted === 'TIMEOUT' ? 'délai du run écoulé avant cet agent' : 'budget épuisé avant cet agent',
      );
      return 'stopped';
    }
    let applies: boolean;
    try {
      applies = agent.applies(this.context());
    } catch (error) {
      this.trace.finishStep(name, { status: 'FAILED', error: describe(error) });
      return 'failed';
    }
    if (!applies) {
      this.trace.skipStep(name, 'SKIPPED', 'rien à faire pour cet agent');
      return 'skipped';
    }
    this.trace.startStep(name);
    let outcome: AgentOutcome<unknown>;
    try {
      outcome = await agent.run(this.context());
    } catch (error) {
      this.trace.setUsage(this.tracker.usage);
      const text = describe(error);
      this.failures.push(text);
      this.statuses.push('FAILED');
      this.trace.finishStep(name, { status: 'FAILED', error: text });
      return 'failed';
    }
    const { result } = outcome;
    this.statuses.push(result.status);
    this.trace.addLimitations(outcome.limitations);
    this.trace.setUsage(this.tracker.usage);
    if (result.output !== undefined) this.previous[name] = result.output;
    const summary = result.output !== undefined ? this.collect(name, result.output) : undefined;
    if (result.status === 'DONE') {
      this.trace.finishStep(name, {
        status: 'DONE',
        toolCalls: result.toolCalls,
        usage: result.usage,
        ...(summary ? { summary } : {}),
      });
      return 'ok';
    }
    if (result.status === 'CANCELLED') {
      this.stopReason ??= 'CANCELLED';
      this.trace.finishStep(name, {
        status: 'CANCELLED',
        toolCalls: result.toolCalls,
        usage: result.usage,
        summary: 'annulé',
      });
      return 'stopped';
    }
    if (result.status === 'BUDGET' || result.status === 'TIMEOUT') {
      this.stopReason ??= result.status === 'TIMEOUT' ? 'TIMEOUT' : 'BUDGET_EXHAUSTED';
      this.trace.finishStep(name, {
        status: 'FAILED',
        toolCalls: result.toolCalls,
        usage: result.usage,
        error: result.reasons.join(' ; ') || result.status,
      });
      return 'stopped';
    }
    this.failures.push(...result.reasons);
    this.trace.finishStep(name, {
      status: 'FAILED',
      toolCalls: result.toolCalls,
      usage: result.usage,
      error: result.reasons.join(' ; ') || 'sortie rejetée',
    });
    return 'failed';
  }

  /** Une sortie reconnue par son schéma devient des artefacts du run ; rend un résumé court pour l'étape. */
  private collect(name: AiAgentName, output: unknown): string | undefined {
    switch (name) {
      case 'PLANNER': {
        const parsed = PlannerOutputSchema.safeParse(output);
        if (!parsed.success) return undefined;
        const steps = toPlanSteps(parsed.data);
        const covered = new Set(steps.map((step) => step.agent));
        const extra = this.defaultPlan().filter(
          (step) => !covered.has(step.agent) && !LAYER_AGENTS.includes(step.agent),
        );
        this.trace.setPlan([
          ...steps,
          ...extra.map((step, index) => ({
            ...step,
            id: `auto-${String(index + 1)}`,
            order: steps.length + index + 1,
          })),
        ]);
        this.trace.setAgentPlanStatus('PLANNER', 'RUNNING');
        for (const done of SEQUENCE.filter(
          (agent) => this.previous[agent] !== undefined && agent !== 'PLANNER',
        ))
          this.trace.setAgentPlanStatus(done, 'DONE');
        this.skippedByPlan = new Set(
          unplannedLayerAgents(parsed.data).filter((agent) => this.previous[agent] === undefined),
        );
        return `${String(parsed.data.goals.length)} objectif(s), ${String(steps.length)} étape(s)`;
      }
      case 'EVIDENCE_ANALYSIS': {
        const parsed = EvidenceAnalysisSchema.safeParse(output);
        if (!parsed.success) return undefined;
        const kept = this.addFindings(evidenceFindings(parsed.data));
        this.trace.addLimitations(parsed.data.missingEvidence.map((text) => `Preuve manquante : ${text}`));
        return `${String(kept.length)} constat(s) ; symptôme : ${parsed.data.firstSymptom.summary}`;
      }
      case 'FRONTEND':
      case 'BFF':
      case 'BACKEND': {
        const parsed = LayerFindingsSchema.safeParse(output);
        if (!parsed.success) return undefined;
        const kept = this.addFindings(
          parsed.data.findings.map((item, index) => ({
            id: `${name.toLowerCase()}-${String(index + 1)}`,
            agent: name,
            layer: item.layer,
            title: item.title,
            summary: item.summary,
            refs: item.refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
            locations: item.locations.map((location): AiSourceLocation => ({ ...location })),
            basis: item.basis,
            ...(this.hypothesisIdOf(item.hypothesisHint)
              ? { hypothesisId: this.hypothesisIdOf(item.hypothesisHint) }
              : {}),
          })),
        );
        this.trace.addLimitations(parsed.data.gaps.map((text) => `${name} : ${text}`));
        return `${String(kept.length)} constat(s)`;
      }
      case 'CROSS_LAYER': {
        const parsed = CrossLayerFindingsSchema.safeParse(output);
        if (!parsed.success) return undefined;
        const kept = this.addFindings(crossLayerFindings(parsed.data));
        this.trace.addRelations(parsed.data.relations);
        this.trace.addLimitations(parsed.data.gaps.map((text) => `CROSS_LAYER : ${text}`));
        return `${String(kept.length)} constat(s), ${String(parsed.data.relations.length)} relation(s) suggérée(s)`;
      }
      case 'HYPOTHESIS': {
        if (!isHypothesisProposals(output)) return undefined;
        const existing = this.input.incident.investigation.hypotheses;
        const { hypotheses, dropped } = toHypotheses(output, this.refs, this.runId, this.input.now(), {
          existing,
          incident: this.incident,
        });
        // Une réévaluation remplace la précédente : les identifiants des propositions reprises sont conservés par l'agent.
        this.hypotheses = hypotheses.filter(
          (hypothesis) => !existing.some((rule) => rule.id === hypothesis.id),
        );
        const ids = hypotheses.map((hypothesis) => hypothesis.id);
        this.runRefs.hypothesisIds = ids;
        this.trace.setHypothesisIds(ids);
        this.trace.addLimitations(dropped.map((text) => `Hypothèse écartée : ${text}`));
        this.addFindings(
          output.existing.map((assessment, index) => ({
            id: `hypothesis-assessment-${String(index + 1)}`,
            agent: 'HYPOTHESIS' as const,
            layer:
              existing.find((rule) => rule.id === assessment.hypothesisId)?.layer ?? ('UNKNOWN' as const),
            title: `${assessment.assessment} ${assessment.hypothesisId}`,
            summary: assessment.summary,
            refs: assessment.refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
            locations: [],
            basis: 'INFERRED' as const,
            hypothesisId: assessment.hypothesisId,
          })),
        );
        this.trace.addLimitations(output.gaps.map((text) => `HYPOTHESIS : ${text}`));
        return `${String(this.hypotheses.length)} hypothèse(s) proposée(s), ${String(output.existing.length)} évaluation(s)`;
      }
      case 'VERIFICATION_PLANNING': {
        const parsed = VerificationPlanSchema.safeParse(output);
        if (!parsed.success) return undefined;
        const known = [...this.input.incident.investigation.hypotheses, ...this.hypotheses];
        const { proposals, dropped } = toProposals(parsed.data, known, this.incident, this.runId);
        const fresh = proposals.filter(
          (proposal) => !this.proposals.some((existing) => existing.id === proposal.id),
        );
        this.proposals = [...this.proposals, ...fresh];
        this.runRefs.proposalIds = this.proposals.map((proposal) => proposal.id);
        this.trace.addProposals(fresh);
        this.trace.addLimitations(dropped.map((text) => `Vérification écartée : ${text}`));
        this.trace.addLimitations(parsed.data.gaps.map((text) => `VERIFICATION_PLANNING : ${text}`));
        return `${String(fresh.length)} vérification(s) proposée(s)`;
      }
      case 'SYNTHESIS': {
        const parsed = SynthesisSchema.safeParse(output);
        if (!parsed.success) return undefined;
        this.trace.setSynthesis(toAiSynthesis(parsed.data));
        return parsed.data.summary;
      }
      case 'CONTRADICTION_HUNTER': {
        const parsed = ContradictionFindingsSchema.safeParse(output);
        if (!parsed.success) return undefined;
        const runHypotheses = new Set(this.runRefs.hypothesisIds);
        const lookup = {
          has: (ref: AiRef): boolean =>
            this.refs.has(ref) || (ref.kind === 'hypothesis' && runHypotheses.has(ref.id)),
        };
        const { contradictions, dropped } = convertContradictions(
          parsed.data,
          lookup,
          'CONTRADICTION_HUNTER',
          this.input.now(),
          { existing: this.contradictions, incident: this.incident },
        );
        this.contradictions = [...this.contradictions, ...contradictions];
        this.trace.addLimitations(dropped.map((text) => `Contradiction écartée : ${text}`));
        const open = contradictions.filter((item) => item.openQuestion).length;
        return `${String(contradictions.length)} contradiction(s), dont ${String(open)} question(s) ouverte(s)`;
      }
      case 'ASSISTANT':
      case 'STRATEGY':
      case 'EXPERIMENT_GENERATION':
        return undefined;
    }
  }

  private addFindings(findings: readonly AiFinding[]): AiFinding[] {
    const kept = this.trace.addFindings(findings);
    this.runRefs.findingIds.push(...kept.map((finding) => finding.id));
    return kept;
  }

  private hypothesisIdOf(hint: string | undefined): string | undefined {
    if (!hint) return undefined;
    const known = [...this.input.incident.investigation.hypotheses, ...this.hypotheses];
    return known.find(
      (hypothesis) => hypothesis.id === hint || hypothesis.title.toLowerCase() === hint.toLowerCase(),
    )?.id;
  }

  finish(): AiInvestigationOutcome {
    const run = this.trace.run();
    const { limitations } = resolveContradictions(run.findings);
    this.trace.addLimitations(limitations);
    const { edges, skipped } = toGraphRelations(run.relations, this.incident.investigation.graph);
    this.trace.addLimitations(skipped.map((text) => `Relation non écrite : ${text}`));
    const scopeRequests = [...(this.input.collectScopeRequests?.() ?? [])];
    this.trace.addScopeRequests(scopeRequests);
    this.trace.setUsage(this.tracker.usage);

    const ran = this.statuses.length;
    const done = this.statuses.filter((status) => status === 'DONE').length;
    const providerTrouble = this.failures.some((reason) =>
      /provider error|timed out|unavailable/i.test(reason),
    );
    let status: Parameters<RunTrace['finish']>[0];
    let stopReason: AiStopReason;
    if (this.input.signal.aborted || this.stopReason === 'CANCELLED') {
      status = 'CANCELLED';
      stopReason = 'CANCELLED';
    } else if (this.failure !== undefined) {
      status = 'FAILED';
      stopReason = 'PROVIDER_ERROR';
    } else if (this.stopReason === 'BUDGET_EXHAUSTED' || this.stopReason === 'TIMEOUT') {
      status = 'PARTIAL';
      stopReason = this.stopReason;
    } else if (ran > 0 && done === 0) {
      status = 'FAILED';
      stopReason = providerTrouble ? 'PROVIDER_ERROR' : 'INSUFFICIENT_EVIDENCE';
    } else if (done < ran) {
      status = 'PARTIAL';
      stopReason = providerTrouble ? 'PROVIDER_ERROR' : 'INSUFFICIENT_EVIDENCE';
    } else if (ran === 0) {
      status = 'FAILED';
      stopReason = 'INSUFFICIENT_EVIDENCE';
      this.failure = 'aucun agent n’a pu tourner';
    } else {
      status = 'DONE';
      stopReason = 'GOALS_MET';
      if (this.input.mode === 'AI_AGENTIC' && this.proposals.length > 0 && this.autoRunAttempts === 0)
        stopReason = 'NO_USEFUL_VERIFICATION';
      else if (this.autoRunAttempts > 0 && this.autoRunRefusals === this.autoRunAttempts)
        stopReason = 'PERMISSION_DENIED';
    }
    const error =
      this.failure ?? (status === 'FAILED' ? this.failures.slice(0, 3).join(' ; ') || undefined : undefined);
    const final = this.trace.finish(status, stopReason, error);
    return {
      run: final,
      hypotheses: this.hypotheses,
      relations: final.relations,
      edges,
      proposals: this.proposals,
      scopeRequests,
      experiments: this.experiments,
      contradictions: this.contradictions,
      outputs: { ...this.previous },
    };
  }
}

const TITLES: Record<AiAgentName, string> = {
  PLANNER: 'Plan d’investigation',
  EVIDENCE_ANALYSIS: 'Analyse des preuves',
  FRONTEND: 'Couche Frontend',
  BFF: 'Couche BFF',
  BACKEND: 'Couche Backend',
  CROSS_LAYER: 'Comparaison inter-couches',
  HYPOTHESIS: 'Hypothèses',
  VERIFICATION_PLANNING: 'Plan de vérification',
  SYNTHESIS: 'Synthèse',
  ASSISTANT: 'Assistant',
  CONTRADICTION_HUNTER: 'Recherche de contradictions',
  STRATEGY: 'Stratégies',
  EXPERIMENT_GENERATION: 'Génération d’expériences',
};

/** Une proposition sans effet de bord dont la sorte est déjà permise par le périmètre. */
export function defaultCanAutoRun(proposal: AiExperimentProposal, incident: Incident): boolean {
  if (proposal.sideEffects) return false;
  const permissions = incident.scope.permissions;
  switch (proposal.kind) {
    case 'REPLAY':
    case 'COMPARE_WITH_PASSING':
      return permissions.navigate;
    case 'COMPARE_REQUESTS':
    case 'COMPARE_RESPONSES':
      return true;
    case 'UNIT_TEST':
      return permissions.runTests !== 'NONE';
    case 'INTEGRATION_TEST':
      return false;
    case 'INSPECT_LOGS':
      return permissions.readLogs || permissions.openshift === 'READ';
    case 'CHECK_VALIDATION':
      return permissions.readSources;
  }
}

function isHypothesisProposals(value: unknown): value is HypothesisProposals {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<HypothesisProposals>;
  return (
    Array.isArray(record.hypotheses) &&
    record.hypotheses.every(
      (item) => typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string',
    ) &&
    Array.isArray(record.existing) &&
    Array.isArray(record.gaps)
  );
}

export function newRunId(at: string): string {
  const stamp = Number.isNaN(Date.parse(at)) ? Date.now() : Date.parse(at);
  return `ai_${stamp.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
