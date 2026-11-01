import type { AiRef } from '../../../sdk/core/incident-ai-contracts.js';
import type { AgentOutcome, AgentRunContext, InvestigationAgent, InvestigationToolName } from '../agent.js';
import { refLookupOf, validateCitations } from '../merge.js';
import { EVIDENCE_SYSTEM, EVIDENCE_TASK, dataSection } from '../prompts/evidence.js';
import {
  EVIDENCE_ANALYSIS_JSON_SCHEMA,
  EvidenceAnalysisSchema,
  type EvidenceAnalysis,
} from '../schemas/analysis.js';

/**
 * L'AGENT D'ANALYSE DES PREUVES : premier symptôme observable, événements précédents, incohérences, preuves
 * manquantes, relations temporelles, pistes. Chaque constat cite des identifiants de preuves qui existent ;
 * la sortie est rejetée sinon (la boucle accorde un essai de correction).
 */

/** Les tours et appels d'outils d'un agent selon le mode (bornés ensuite par le budget du run). */
export function agentBounds(ctx: Pick<AgentRunContext, 'mode' | 'budget'>): {
  maxTurns: number;
  maxToolCalls: number;
} {
  const assisted = ctx.mode === 'AI_ASSISTED';
  return {
    maxTurns: Math.max(1, Math.min(assisted ? 2 : 6, ctx.budget.maxModelCalls)),
    maxToolCalls: Math.max(0, Math.min(assisted ? 6 : 16, ctx.budget.maxToolCalls)),
  };
}

export const EVIDENCE_TOOLS: readonly InvestigationToolName[] = [
  'get_incident_summary',
  'get_evidence',
  'get_request',
  'get_trace_graph',
];

/** Toutes les références citées par une analyse. */
export function evidenceRefs(output: EvidenceAnalysis): AiRef[] {
  return [
    ...output.firstSymptom.refs,
    ...output.precedingEvents.flatMap((item) => item.refs),
    ...output.inconsistencies.flatMap((item) => item.refs),
    ...output.temporalRelations.flatMap((item) => [item.from, item.to]),
    ...output.leads.flatMap((item) => item.refs),
  ];
}

export function createEvidenceAnalysisAgent(): InvestigationAgent<EvidenceAnalysis> {
  return {
    name: 'EVIDENCE_ANALYSIS',
    applies(ctx) {
      const { reproductions, experiments } = ctx.incident.investigation;
      return reproductions.length > 0 || experiments.some((experiment) => experiment.evidence.length > 0);
    },
    async run(ctx): Promise<AgentOutcome<EvidenceAnalysis>> {
      const packs = [
        ctx.packs.incident(),
        ctx.packs.reproduction(),
        ctx.packs.requests(),
        ctx.packs.experiments(),
      ];
      const packRefs = packs.flatMap((pack) => pack.refs);
      const user = [
        ...packs.map((pack) => pack.text),
        dataSection('Investigation plan (previous agent output)', ctx.previous.PLANNER),
        EVIDENCE_TASK,
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');
      const result = await ctx.loop<EvidenceAnalysis>({
        agent: 'EVIDENCE_ANALYSIS',
        system: EVIDENCE_SYSTEM,
        user,
        tools: EVIDENCE_TOOLS,
        schema: EvidenceAnalysisSchema,
        outputSchema: EVIDENCE_ANALYSIS_JSON_SCHEMA,
        ...agentBounds(ctx),
        validate: (output) => validateCitations(refLookupOf(ctx, packRefs), evidenceRefs(output)),
      });
      return {
        agent: 'EVIDENCE_ANALYSIS',
        result,
        limitations: [...new Set(packs.flatMap((pack) => pack.omitted))],
      };
    },
  };
}

export const evidenceAnalysisAgent = createEvidenceAnalysisAgent();
