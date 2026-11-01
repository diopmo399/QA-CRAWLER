import type { Hypothesis, Incident } from '../../../sdk/core/incident-contracts.js';
import type { AgentOutcome, AgentRunContext, InvestigationAgent, InvestigationToolName } from '../agent.js';
import { dataSection } from '../prompts/evidence.js';
import { VERIFICATION_SYSTEM, VERIFICATION_TASK } from '../prompts/verification.js';
import {
  VERIFICATION_PLAN_JSON_SCHEMA,
  VerificationPlanSchema,
  verificationParamsProblems,
  type HypothesisProposals,
  type VerificationPlan,
} from '../schemas/analysis.js';
import { agentBounds } from './evidence-analysis.js';

/**
 * L'AGENT DE PLANIFICATION DES VÉRIFICATIONS : pour chaque hypothèse (existante ou proposée dans le run), des
 * `AiExperimentProposal` exécutables par le chemin ordinaire (`service.runExperiment`) : sorte parmi
 * EXPERIMENT_KINDS, paramètres réels de la sorte, ressources, permissions, risques, effets de bord, attendu,
 * confirmIf / refuteIf. Rien n'est lancé ici : une personne approuve, ou l'orchestrateur AI_AGENTIC exécute
 * seulement ce qui est sans effet de bord et déjà permis.
 */

export const VERIFICATION_TOOLS: readonly InvestigationToolName[] = [
  'get_evidence',
  'get_request',
  'find_symbol',
  'list_files',
];

type Candidate = Pick<Hypothesis, 'id' | 'title' | 'suspectedCause' | 'layer' | 'files'> & {
  origin: 'RULE' | 'AI';
  verifications: { kind: string; description: string }[];
};

/** Les hypothèses qu'un plan peut viser : celles de l'incident et celles proposées plus tôt dans le run. */
export function candidateHypotheses(ctx: Pick<AgentRunContext, 'incident' | 'previous'>): Candidate[] {
  const existing: Candidate[] = ctx.incident.investigation.hypotheses.map((item) => ({
    id: item.id,
    title: item.title,
    suspectedCause: item.suspectedCause,
    layer: item.layer,
    files: item.files,
    origin: item.origin ?? 'RULE',
    verifications: item.verifications.map(({ kind, description }) => ({ kind, description })),
  }));
  const proposed = (ctx.previous.HYPOTHESIS as Partial<HypothesisProposals> | undefined)?.hypotheses ?? [];
  for (const item of proposed) {
    if (typeof item.id !== 'string' || existing.some((other) => other.id === item.id)) continue;
    existing.push({
      id: item.id,
      title: item.title,
      suspectedCause: item.suspectedCause,
      layer: item.layer,
      files: [...new Set(item.locations.map((location) => location.file))],
      origin: 'AI',
      verifications: item.verificationHints.map(({ kind, description }) => ({ kind, description })),
    });
  }
  return existing;
}

/** Ce que le périmètre permet et ce qui existe pour paramétrer une vérification (données pour le modèle). */
export function scopeDigest(incident: Incident): Record<string, unknown> {
  const { scope, investigation } = incident;
  return {
    executionTarget: incident.execution.target,
    incidentScenario: incident.scenario,
    libraryScenarios: scope.scenarios,
    applications: scope.applications.map((app) => ({
      id: app.id,
      layer: app.layer,
      logFiles: app.logFiles ?? [],
      openshift: app.openshift !== undefined,
    })),
    permissions: scope.permissions,
    limits: { maxExperiments: scope.limits.maxExperiments, maxDurationMs: scope.limits.maxDurationMs },
    reproductions: investigation.reproductions.map((run) => ({
      id: run.id,
      scenario: run.scenario,
      reproduced: run.reproduced,
      failingRequests: run.requests
        .filter((request) => (request.status ?? 0) >= 400 || request.failure !== undefined)
        .map((request) => `${request.method} ${request.path}`)
        .slice(0, 10),
    })),
    experimentsDone: investigation.experiments.map((item) => ({
      id: item.id,
      kind: item.kind,
      hypothesisId: item.hypothesisId,
      status: item.status,
      outcome: item.outcome,
    })),
  };
}

/** Les raisons de rejet d'un plan : hypothèse inconnue, paramètres que l'exécuteur ne comprendrait pas. */
export function validatePlan(
  plan: VerificationPlan,
  candidates: readonly Candidate[],
  incident: Incident,
): string[] {
  const reasons: string[] = [];
  for (const item of plan.proposals) {
    if (!candidates.some((candidate) => candidate.id === item.hypothesisId))
      reasons.push(
        `unknown hypothesis "${item.hypothesisId}": use one of ${candidates.map((c) => c.id).join(', ')}`,
      );
    reasons.push(...verificationParamsProblems(item.kind, item.params, incident));
  }
  return [...new Set(reasons)];
}

export function createVerificationPlanningAgent(): InvestigationAgent<VerificationPlan> {
  return {
    name: 'VERIFICATION_PLANNING',
    applies(ctx) {
      return candidateHypotheses(ctx).length > 0;
    },
    async run(ctx): Promise<AgentOutcome<VerificationPlan>> {
      const candidates = candidateHypotheses(ctx);
      const packs = [ctx.packs.hypotheses(), ctx.packs.experiments()];
      const user = [
        ...packs.map((pack) => pack.text),
        dataSection('Hypotheses to verify (ids)', candidates),
        dataSection(
          'Scope: what is permitted, applications, scenarios, reproductions',
          scopeDigest(ctx.incident),
        ),
        VERIFICATION_TASK,
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');
      const result = await ctx.loop<VerificationPlan>({
        agent: 'VERIFICATION_PLANNING',
        system: VERIFICATION_SYSTEM,
        user,
        tools: VERIFICATION_TOOLS,
        schema: VerificationPlanSchema,
        outputSchema: VERIFICATION_PLAN_JSON_SCHEMA,
        ...agentBounds(ctx),
        validate: (output) => validatePlan(output, candidates, ctx.incident),
      });
      const limitations = [...new Set(packs.flatMap((pack) => pack.omitted))];
      if (result.output?.noUsefulVerification)
        limitations.push(`Aucune vérification utile : ${result.output.noUsefulVerification}`);
      return { agent: 'VERIFICATION_PLANNING', result, limitations };
    },
  };
}

export const verificationPlanningAgent = createVerificationPlanningAgent();
