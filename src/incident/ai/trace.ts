import {
  MAX_AI_FINDINGS,
  type AiAgentName,
  type AiAgentStatus,
  type AiAgentStep,
  type AiBudget,
  type AiExperimentProposal,
  type AiFinding,
  type AiInvestigationMode,
  type AiInvestigationRun,
  type InvestigationDepth,
  type AiPlanStep,
  type AiRunStatus,
  type AiScopeRequest,
  type AiStopReason,
  type AiSuggestedRelation,
  type AiSynthesis,
  type AiToolCall,
  type AiUsage,
} from '../../sdk/core/incident-ai-contracts.js';
import { redactText } from '../../security/redactor.js';
import { emptyUsage, normalizeBudget } from './budget.js';

/**
 * LA TRACE D'UN RUN IA : ce qui finit dans `Investigation.ai.runs[]` et ce que l'interface suit en direct.
 *
 * Bornée par construction : textes courts (résumés, erreurs, limites), nombre d'appels d'outils par étape, nombre
 * de constats (`MAX_AI_FINDINGS`), de propositions, de relations et de limites. Jamais une charge utile : un appel
 * d'outil n'est que nom, cible courte, décision et règle (`AiToolCall`) ; aucun prompt, aucune réponse brute,
 * aucune donnée lue n'y entre. Tout texte libre passe par `redactText` avant d'être conservé.
 */
export const TRACE_LIMITS = {
  summaryChars: 600,
  errorChars: 400,
  limitationChars: 300,
  targetChars: 200,
  maxLimitations: 60,
  maxToolCallsPerStep: 200,
  maxRelations: 80,
  maxProposals: 40,
  maxScopeRequests: 20,
  maxPlanSteps: 40,
} as const;

/** Les événements d'un run (journal `IncidentEvent.kind === 'AI'`, et progression). */
export const AI_INVESTIGATION_EVENTS = [
  'AI_RUN_STARTED',
  'AI_STEP_STARTED',
  'AI_STEP_FINISHED',
  'AI_EXPERIMENT_AUTO_RUN',
  'AI_RUN_FINISHED',
] as const;
export type AiInvestigationEvent = (typeof AI_INVESTIGATION_EVENTS)[number];

export interface RunTraceOptions {
  id: string;
  mode: Exclude<AiInvestigationMode, 'DETERMINISTIC'>;
  startedBy: string;
  budget: AiBudget;
  now: () => string;
  provider?: string;
  model?: string;
  depth?: InvestigationDepth;
  /** Reçoit une copie du run à chaque changement notable (progression en mémoire côté service). */
  onProgress?: (run: AiInvestigationRun) => void;
}

export interface StepOutcome {
  status: AiAgentStatus;
  summary?: string;
  error?: string;
  toolCalls?: readonly AiToolCall[];
  usage?: AiUsage;
}

export interface RunTrace {
  readonly id: string;
  /** Une copie profonde de l'état courant (jamais l'objet interne). */
  run(): AiInvestigationRun;
  setPlan(steps: readonly AiPlanStep[]): void;
  updatePlanStep(id: string, patch: Partial<Pick<AiPlanStep, 'status' | 'summary' | 'targets'>>): void;
  /** Le statut des étapes du plan confiées à cet agent. */
  setAgentPlanStatus(agent: AiAgentName, status: AiAgentStatus, summary?: string): void;
  startStep(agent: AiAgentName): void;
  finishStep(agent: AiAgentName, outcome: StepOutcome): void;
  /** Un agent qui n'a pas tourné (rien à faire, budget épuisé avant lui…). */
  skipStep(
    agent: AiAgentName,
    status: Extract<AiAgentStatus, 'SKIPPED' | 'CANCELLED' | 'PENDING'>,
    summary?: string,
  ): void;
  addFindings(findings: readonly AiFinding[]): AiFinding[];
  addRelations(relations: readonly AiSuggestedRelation[]): void;
  addProposals(proposals: readonly AiExperimentProposal[]): void;
  updateProposal(id: string, patch: Partial<AiExperimentProposal>): void;
  addScopeRequests(requests: readonly AiScopeRequest[]): void;
  setHypothesisIds(ids: readonly string[]): void;
  setSynthesis(synthesis: AiSynthesis | undefined): void;
  addLimitations(limitations: readonly string[]): void;
  setUsage(usage: AiUsage): void;
  finish(
    status: Exclude<AiRunStatus, 'RUNNING'>,
    stopReason?: AiStopReason,
    error?: string,
  ): AiInvestigationRun;
  /** Les étapes déjà vues (un agent peut tourner plusieurs fois : réévaluation). */
  stepsOf(agent: AiAgentName): AiAgentStep[];
}

export function createRunTrace(options: RunTraceOptions): RunTrace {
  const state: AiInvestigationRun = {
    id: options.id,
    mode: options.mode,
    status: 'RUNNING',
    startedAt: options.now(),
    startedBy: options.startedBy,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.depth ? { depth: options.depth } : {}),
    budget: normalizeBudget(options.budget),
    usage: emptyUsage(),
    plan: [],
    steps: [],
    findings: [],
    hypothesisIds: [],
    relations: [],
    proposals: [],
    scopeRequests: [],
    limitations: [],
  };
  let findingCounter = 0;
  const snapshot = (): AiInvestigationRun => structuredClone(state);
  const progress = (): void => {
    options.onProgress?.(snapshot());
  };
  const openStep = (agent: AiAgentName): AiAgentStep | undefined =>
    [...state.steps].reverse().find((step) => step.agent === agent && step.status === 'RUNNING');
  const addLimitations = (limitations: readonly string[]): void => {
    for (const limitation of limitations) {
      const text = short(limitation, TRACE_LIMITS.limitationChars);
      if (!text || state.limitations.includes(text)) continue;
      if (state.limitations.length >= TRACE_LIMITS.maxLimitations) return;
      state.limitations.push(text);
    }
  };

  return {
    id: options.id,
    run: snapshot,
    setPlan(steps) {
      state.plan = steps.slice(0, TRACE_LIMITS.maxPlanSteps).map((step) => ({
        ...step,
        title: short(step.title, TRACE_LIMITS.summaryChars),
        targets: step.targets.slice(0, 20).map((target) => short(target, TRACE_LIMITS.targetChars)),
        ...(step.summary ? { summary: short(step.summary, TRACE_LIMITS.summaryChars) } : {}),
      }));
      progress();
    },
    updatePlanStep(id, patch) {
      const step = state.plan.find((candidate) => candidate.id === id);
      if (!step) return;
      if (patch.status) step.status = patch.status;
      if (patch.summary !== undefined) step.summary = short(patch.summary, TRACE_LIMITS.summaryChars);
      if (patch.targets)
        step.targets = patch.targets.slice(0, 20).map((t) => short(t, TRACE_LIMITS.targetChars));
      progress();
    },
    setAgentPlanStatus(agent, status, summary) {
      let touched = false;
      for (const step of state.plan) {
        if (step.agent !== agent) continue;
        step.status = status;
        if (summary !== undefined) step.summary = short(summary, TRACE_LIMITS.summaryChars);
        touched = true;
      }
      if (touched) progress();
    },
    startStep(agent) {
      state.steps.push({
        agent,
        status: 'RUNNING',
        startedAt: options.now(),
        toolCalls: [],
        usage: emptyUsage(),
      });
      this.setAgentPlanStatus(agent, 'RUNNING');
      progress();
    },
    finishStep(agent, outcome) {
      const step = openStep(agent);
      const target: AiAgentStep = step ?? { agent, status: 'RUNNING', toolCalls: [], usage: emptyUsage() };
      if (!step) state.steps.push(target);
      target.status = outcome.status;
      target.finishedAt = options.now();
      if (outcome.summary) target.summary = short(outcome.summary, TRACE_LIMITS.summaryChars);
      if (outcome.error) target.error = short(outcome.error, TRACE_LIMITS.errorChars);
      if (outcome.toolCalls)
        target.toolCalls = outcome.toolCalls.slice(0, TRACE_LIMITS.maxToolCallsPerStep).map(toolCallOf);
      if (outcome.usage) target.usage = { ...outcome.usage };
      this.setAgentPlanStatus(agent, outcome.status, outcome.summary ?? outcome.error);
      progress();
    },
    skipStep(agent, status, summary) {
      const open = openStep(agent);
      if (open) {
        open.status = status;
        open.finishedAt = options.now();
        if (summary) open.summary = short(summary, TRACE_LIMITS.summaryChars);
      } else {
        state.steps.push({
          agent,
          status,
          toolCalls: [],
          usage: emptyUsage(),
          ...(summary ? { summary: short(summary, TRACE_LIMITS.summaryChars) } : {}),
        });
      }
      this.setAgentPlanStatus(agent, status, summary);
      progress();
    },
    addFindings(findings) {
      const kept: AiFinding[] = [];
      for (const finding of findings) {
        if (state.findings.length >= MAX_AI_FINDINGS) {
          addLimitations([`constats au-delà de ${String(MAX_AI_FINDINGS)} non conservés`]);
          break;
        }
        findingCounter += 1;
        const entry: AiFinding = {
          ...finding,
          id: finding.id || `finding-${String(findingCounter)}`,
          title: short(finding.title, TRACE_LIMITS.targetChars),
          summary: short(finding.summary, TRACE_LIMITS.summaryChars),
          refs: finding.refs.slice(0, 30),
          locations: finding.locations.slice(0, 20),
        };
        state.findings.push(entry);
        kept.push(entry);
      }
      progress();
      return kept;
    },
    addRelations(relations) {
      for (const relation of relations) {
        if (state.relations.length >= TRACE_LIMITS.maxRelations) break;
        if (state.relations.some((known) => known.from === relation.from && known.to === relation.to))
          continue;
        state.relations.push({ ...relation, reason: short(relation.reason, TRACE_LIMITS.summaryChars) });
      }
      progress();
    },
    addProposals(proposals) {
      for (const proposal of proposals) {
        if (state.proposals.length >= TRACE_LIMITS.maxProposals) break;
        if (state.proposals.some((known) => known.id === proposal.id)) continue;
        state.proposals.push({
          ...proposal,
          objective: short(proposal.objective, TRACE_LIMITS.summaryChars),
          expected: short(proposal.expected, TRACE_LIMITS.summaryChars),
          confirmIf: short(proposal.confirmIf, TRACE_LIMITS.summaryChars),
          refuteIf: short(proposal.refuteIf, TRACE_LIMITS.summaryChars),
          ...(proposal.refusal ? { refusal: short(proposal.refusal, TRACE_LIMITS.errorChars) } : {}),
        });
      }
      progress();
    },
    updateProposal(id, patch) {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) return;
      Object.assign(
        proposal,
        patch,
        patch.refusal ? { refusal: short(patch.refusal, TRACE_LIMITS.errorChars) } : {},
      );
      progress();
    },
    addScopeRequests(requests) {
      for (const request of requests) {
        if (state.scopeRequests.length >= TRACE_LIMITS.maxScopeRequests) break;
        if (state.scopeRequests.some((known) => known.id === request.id)) continue;
        state.scopeRequests.push({ ...request, reason: short(request.reason, TRACE_LIMITS.summaryChars) });
      }
      progress();
    },
    setHypothesisIds(ids) {
      state.hypothesisIds = [...new Set(ids)];
      progress();
    },
    setSynthesis(synthesis) {
      if (!synthesis) {
        delete state.synthesis;
      } else {
        state.synthesis = {
          summary: short(synthesis.summary, 2000),
          ranking: synthesis.ranking.slice(0, 30),
          missing: synthesis.missing.slice(0, 30).map((text) => short(text, TRACE_LIMITS.summaryChars)),
          decisive: synthesis.decisive.slice(0, 30),
        };
      }
      progress();
    },
    addLimitations(limitations) {
      addLimitations(limitations);
      progress();
    },
    setUsage(usage) {
      state.usage = { ...usage };
    },
    finish(status, stopReason, error) {
      state.status = status;
      state.finishedAt = options.now();
      if (stopReason) state.stopReason = stopReason;
      else delete state.stopReason;
      if (error) state.error = short(error, TRACE_LIMITS.errorChars);
      for (const step of state.steps)
        if (step.status === 'RUNNING') {
          step.status = status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
          step.finishedAt = state.finishedAt;
        }
      for (const step of state.plan)
        if (step.status === 'RUNNING') step.status = status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      progress();
      return snapshot();
    },
    stepsOf(agent) {
      return state.steps.filter((step) => step.agent === agent).map((step) => structuredClone(step));
    },
  };
}

/** Un appel d'outil tel que conservé : jamais l'argument complet, une cible courte. */
export function toolCallOf(call: AiToolCall): AiToolCall {
  return {
    at: call.at,
    name: call.name,
    target: short(call.target, TRACE_LIMITS.targetChars),
    allowed: call.allowed,
    ...(call.rule ? { rule: short(call.rule, 120) } : {}),
    ...(typeof call.durationMs === 'number' ? { durationMs: call.durationMs } : {}),
  };
}

/** Un texte libre conservé : masqué puis coupé. */
export function short(text: string, max: number): string {
  const clean = redactText(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}
